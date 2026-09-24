"""歌声转换端点（DDSP-SVC）。

两个入口对应两种用法：

* `POST /v1/svc/convert` —— 只做转换，输入应当是**干声**
  （已经是纯人声，或者用户已经用 `/v1/uvr/separate` 分好了）；
* `POST /v1/svc/cover` —— 翻唱向导，一首带伴奏的歌进去，三件套出来。

两者都提交任务并返回 job_id：一首 4 分钟的歌要跑几分钟，
同步等待会让前端卡住，而用户需要的是「进度 + 可以取消」。
`wait=true` 只对很短的片段有意义（例如试听前 20 秒），所以保留了。
"""

from __future__ import annotations

import shutil
import uuid
from pathlib import Path
from typing import Any, Dict, Optional

from fastapi import FastAPI, File, Form, UploadFile

from ..audio.io import AUDIO_SUFFIXES
from ..jobs import Job, JobKind
from ..svc import catalog
from ..svc.bootstrap import SvcError
from ..svc.cover import run_cover


def _svc_engine(ctx):
    return ctx.svc


def _resolve_source(ctx, upload: Optional[UploadFile], source: str) -> Path:
    if upload is not None and (upload.filename or ""):
        suffix = Path(upload.filename).suffix.lower()
        if suffix not in AUDIO_SUFFIXES:
            raise SvcError(
                "不支持的音频格式：%s" % upload.filename,
                hint="支持 %s。" % "、".join(sorted(AUDIO_SUFFIXES)),
                code="BAD_FORMAT",
            )
        target_dir = ctx.settings.uploads_dir / "svc"
        target_dir.mkdir(parents=True, exist_ok=True)
        target = target_dir / ("%s_%s" % (uuid.uuid4().hex[:8], Path(upload.filename).name))
        with target.open("wb") as handle:
            shutil.copyfileobj(upload.file, handle)
        return target
    if source.strip():
        path = Path(source.strip()).expanduser()
        if not path.is_file():
            raise SvcError("音频文件不存在：%s" % path, code="SOURCE_MISSING")
        return path
    raise SvcError("请上传音频或填写本机路径", code="MISSING_INPUT")


def make_svc_runner(ctx):
    """构造歌声转换任务的执行体（convert / cover 两种模式共用）。"""

    async def svc_runner(job: Job, cancel_event) -> Dict[str, Any]:
        import asyncio  # noqa: PLC0415

        request = job.request or {}
        mode = str(request.get("mode") or "cover")
        source = Path(request.get("source") or "")
        out_dir = ctx.settings.outputs_dir / "svc" / job.id
        out_dir.mkdir(parents=True, exist_ok=True)

        def progress(fraction: float, message: str) -> None:
            ctx.store.update(job, progress=round(float(fraction), 3), message=message)

        def log(message: str, level: str = "info") -> None:
            ctx.store.log(job, message, level)

        handle = ctx.engines.acquire("svc", reason="歌声转换：%s" % source.name)
        try:
            if cancel_event.is_set():
                return {"job_id": job.id, "cancelled": True}

            if mode == "convert":
                log("直接转换干声：%s" % source.name)
                target = out_dir / "converted.wav"
                info = await asyncio.to_thread(
                    _svc_engine(ctx).convert,
                    src=source,
                    out_path=target,
                    model_path=Path(request.get("model") or ""),
                    key=float(request.get("key", 0.0)),
                    spk_id=int(request.get("spk_id", 1)),
                    spk_mix=request.get("spk_mix"),
                    f0_method=str(request.get("f0_method") or ""),
                    quality=str(request.get("quality") or "standard"),
                    formant_shift=float(request.get("formant_shift", 0.0)),
                    threshold_db=float(request.get("threshold_db", -45.0)),
                    slice_segments=bool(request.get("slice_segments", True)),
                    progress=progress,
                )
                urls = {"output": "/files/svc/%s/%s" % (job.id, target.name)}
                log("转换完成")
                return {"job_id": job.id, "output": str(target), "urls": urls, "conversion": info}

            log("翻唱向导开始：%s" % source.name)
            result = await asyncio.to_thread(
                run_cover,
                settings=ctx.settings,
                uvr5=ctx.uvr5,
                engine=_svc_engine(ctx),
                home=ctx.gpt_home(),
                src=source,
                model_path=Path(request.get("model") or ""),
                out_dir=out_dir,
                separation=request.get("separation") or {},
                conversion=request,
                mix=request.get("mix") or {},
                progress=progress,
            )
            artifacts = result.get("artifacts") or {}
            urls = {
                name: "/files/svc/%s/%s" % (job.id, Path(path).name)
                for name, path in artifacts.items()
                if isinstance(path, str) and Path(path).is_file()
            }
            for stage in result.get("stages") or []:
                log("%s：%s" % (stage.get("label"), "命中缓存" if stage.get("cached") else "完成"))
            log("翻唱完成，用时 %.1fs" % result.get("elapsed_s", 0.0))
            return {"job_id": job.id, **result, "urls": urls}
        finally:
            handle.release()

    return svc_runner


def register(app: FastAPI, ctx) -> None:
    @app.get("/v1/svc/catalog", tags=["svc"])
    def svc_catalog() -> Any:
        """音色模型、音质档位、F0 方法。"""
        return {"ok": True, **catalog.to_public(ctx.settings)}

    @app.get("/v1/svc/pipeline", tags=["svc"])
    def svc_pipeline() -> Any:
        """当前已加载的模型与它的采样率/编码器信息。"""
        return {"ok": True, **_svc_engine(ctx).status()}

    @app.post("/v1/svc/models/load", tags=["svc"])
    def svc_load_model(path: str = Form(""), model_key: str = Form("")) -> Any:
        """热加载一个音色模型（切换音色不必重启服务）。"""
        target = path.strip()
        if not target and model_key.strip():
            match = next((m for m in catalog.list_models(ctx.settings) if m.get("id") == model_key.strip()), None)
            if match is None:
                raise SvcError("未找到模型：%s" % model_key, code="MODEL_MISSING")
            target = str(match.get("path") or "")
        if not target:
            raise SvcError("请提供模型路径或 model_id", code="MISSING_INPUT")
        engine = _svc_engine(ctx)
        handle = ctx.engines.acquire("svc", reason="加载歌声转换模型")
        try:
            status = engine.load(Path(target))
        finally:
            handle.release()
        return {"ok": True, **status}

    @app.post("/v1/svc/models/unload", tags=["svc"])
    def svc_unload_model() -> Any:
        """释放模型与显存。"""
        _svc_engine(ctx).unload()
        return {"ok": True, "message": "已释放歌声转换模型"}

    @app.post("/v1/svc/models/upload", tags=["svc"])
    async def svc_upload_model(
        model: UploadFile = File(...),
        config: UploadFile = File(None),
        name: str = Form(""),
    ) -> Any:
        """导入一个音色模型（.pt 与它的 config.yaml 一起）。"""
        label = (name.strip() or Path(model.filename or "model").stem).replace("/", "_")
        target_dir = ctx.settings.svc_dir / "models" / label
        target_dir.mkdir(parents=True, exist_ok=True)
        model_path = target_dir / Path(model.filename or "model.pt").name
        with model_path.open("wb") as handle:
            shutil.copyfileobj(model.file, handle)

        config_path = target_dir / "config.yaml"
        if config is not None and (config.filename or ""):
            with config_path.open("wb") as handle:
                shutil.copyfileobj(config.file, handle)

        return {
            "ok": True,
            "path": str(model_path),
            "has_config": config_path.is_file(),
            "message": ("已导入 %s" % label) + ("" if config_path.is_file() else "（缺少 config.yaml，无法加载）"),
        }

    @app.post("/v1/svc/convert", tags=["svc"])
    async def svc_convert(
        file: UploadFile = File(None),
        source: str = Form(""),
        model: str = Form(""),
        key: float = Form(0.0),
        spk_id: int = Form(1),
        f0_method: str = Form(""),
        quality: str = Form("standard"),
        formant_shift: float = Form(0.0),
        threshold_db: float = Form(-45.0),
        slice_segments: bool = Form(True),
        wait: bool = Form(False),
    ) -> Any:
        """只做转换（输入应为干声）。"""
        return await _submit(
            ctx,
            mode="convert",
            file=file,
            source=source,
            model=model,
            key=key,
            spk_id=spk_id,
            f0_method=f0_method,
            quality=quality,
            formant_shift=formant_shift,
            threshold_db=threshold_db,
            slice_segments=slice_segments,
            separation=None,
            mix=None,
            wait=wait,
        )

    @app.post("/v1/svc/cover", tags=["svc"])
    async def svc_cover(
        file: UploadFile = File(None),
        source: str = Form(""),
        model: str = Form(""),
        key: float = Form(0.0),
        spk_id: int = Form(1),
        f0_method: str = Form(""),
        quality: str = Form("standard"),
        formant_shift: float = Form(0.0),
        threshold_db: float = Form(-45.0),
        slice_segments: bool = Form(True),
        separation_preset: str = Form(""),
        separation_secondary: str = Form("none"),
        use_cache: bool = Form(True),
        vocal_gain_db: float = Form(0.0),
        instrumental_gain_db: float = Form(0.0),
        vocal_delay_ms: float = Form(0.0),
        wait: bool = Form(False),
    ) -> Any:
        """翻唱向导：分离 → 转换 → 混音，产出三件套。"""
        return await _submit(
            ctx,
            mode="cover",
            file=file,
            source=source,
            model=model,
            key=key,
            spk_id=spk_id,
            f0_method=f0_method,
            quality=quality,
            formant_shift=formant_shift,
            threshold_db=threshold_db,
            slice_segments=slice_segments,
            separation={
                "preset": separation_preset or ctx.settings.uvr_preset,
                "secondary": separation_secondary,
                "use_cache": use_cache,
            },
            mix={
                "vocal_gain_db": vocal_gain_db,
                "instrumental_gain_db": instrumental_gain_db,
                "vocal_delay_ms": vocal_delay_ms,
            },
            wait=wait,
        )


async def _submit(
    ctx,
    *,
    mode: str,
    file,
    source: str,
    model: str,
    key: float,
    spk_id: int,
    f0_method: str,
    quality: str,
    formant_shift: float,
    threshold_db: float,
    slice_segments: bool,
    separation: Optional[Dict[str, Any]],
    mix: Optional[Dict[str, Any]],
    wait: bool,
) -> Any:
    """两种模式共用的提交逻辑。"""
    src = _resolve_source(ctx, file, source)
    if not model.strip():
        raise SvcError("请先选择目标音色模型", hint="在音色列表里选一个，或先上传模型。", code="MODEL_REQUIRED")

    request: Dict[str, Any] = {
        "mode": mode,
        "source": str(src),
        "model": model.strip(),
        "key": key,
        "spk_id": spk_id,
        "f0_method": f0_method,
        "quality": quality,
        "formant_shift": formant_shift,
        "threshold_db": threshold_db,
        "slice_segments": slice_segments,
    }
    if separation is not None:
        request["separation"] = separation
    if mix is not None:
        request["mix"] = mix

    if wait:
        from ..svc.cover import run_cover  # noqa: PLC0415

        out_dir = ctx.settings.outputs_dir / "svc" / uuid.uuid4().hex[:12]
        if mode == "cover":
            handle = ctx.engines.acquire("svc", reason="翻唱（同步）")
            try:
                result = run_cover(
                    settings=ctx.settings,
                    uvr5=ctx.uvr5,
                    engine=ctx.svc,
                    home=ctx.gpt_home(),
                    src=src,
                    model_path=Path(model.strip()),
                    out_dir=out_dir,
                    separation=separation or {},
                    conversion=request,
                    mix=mix or {},
                )
            finally:
                handle.release()
            return {"ok": True, **result}

        handle = ctx.engines.acquire("svc", reason="转换（同步）")
        try:
            target = out_dir / "converted.wav"
            out_dir.mkdir(parents=True, exist_ok=True)
            info = ctx.svc.convert(
                src=src,
                out_path=target,
                model_path=Path(model.strip()),
                key=key,
                spk_id=spk_id,
                f0_method=f0_method,
                quality=quality,
                formant_shift=formant_shift,
                threshold_db=threshold_db,
                slice_segments=slice_segments,
            )
        finally:
            handle.release()
        return {"ok": True, "output": str(target), "artifacts": {"output": str(target)}, "conversion": info}

    job = ctx.store.create(
        JobKind.SVC_INFER,
        name=("翻唱：%s" % src.name) if mode == "cover" else ("歌声转换：%s" % src.name),
        request=request,
        owner="local",
    )
    ctx.scheduler.submit(job)
    return {
        "ok": True,
        "job_id": job.id,
        "message": "任务已入队，请轮询 /v1/jobs/%s" % job.id,
        "request": request,
    }

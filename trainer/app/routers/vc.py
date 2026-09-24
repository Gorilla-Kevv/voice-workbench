"""语音变声端点（RVC）。

能力分四组，与页面的四个区块一一对应：

* `/v1/vc/models` —— 模型库（音色 CRUD，含索引）
* `/v1/vc/convert` —— 变声推理
* `/v1/vc/merge`   —— 音色融合（零训练得到新音色）
* `/v1/vc/train`   —— 训练（全量微调 / LoRA 适配器）

推理与训练都走任务队列：变声是秒级但会独占显卡，训练是分钟~小时级，
两者都需要「进度 + 可取消」，同步等待会让前端失去响应。
"""

from __future__ import annotations

import shutil
import uuid
from pathlib import Path
from typing import Any, Dict, Optional

from fastapi import FastAPI, File, Form, UploadFile

from ..audio.io import AUDIO_SUFFIXES
from ..jobs import Job, JobKind
from ..vc import bootstrap, merge as merge_module, models as model_store, training
from ..vc.bootstrap import VcError
from ..vc.training import TrainRequest

#: F0 提取方法（与 RVC pipeline 支持项一致）
F0_METHODS = [
    {"key": "rmvpe", "label": "rmvpe", "hint": "默认，需要 assets/rmvpe/rmvpe.pt"},
    {"key": "pm", "label": "pm", "hint": "parselmouth，CPU 即可"},
    {"key": "harvest", "label": "harvest", "hint": "pyworld，更准但慢"},
    {"key": "crepe", "label": "crepe", "hint": "torchcrepe，质量好但慢"},
]


def _resolve_source(ctx, upload: Optional[UploadFile], source: str) -> Path:
    if upload is not None and (upload.filename or ""):
        suffix = Path(upload.filename).suffix.lower()
        if suffix not in AUDIO_SUFFIXES:
            raise VcError(
                "不支持的音频格式：%s" % upload.filename,
                hint="支持 %s。" % "、".join(sorted(AUDIO_SUFFIXES)),
                code="BAD_FORMAT",
            )
        target_dir = ctx.settings.uploads_dir / "vc"
        target_dir.mkdir(parents=True, exist_ok=True)
        target = target_dir / ("%s_%s" % (uuid.uuid4().hex[:8], Path(upload.filename).name))
        with target.open("wb") as handle:
            shutil.copyfileobj(upload.file, handle)
        return target
    if source.strip():
        path = Path(source.strip()).expanduser()
        if not path.is_file():
            raise VcError("音频文件不存在：%s" % path, code="SOURCE_MISSING")
        return path
    raise VcError("请上传音频或填写本机路径", code="MISSING_INPUT")


def make_vc_runner(ctx):
    """变声任务执行体。"""

    async def vc_runner(job: Job, cancel_event) -> Dict[str, Any]:
        import asyncio  # noqa: PLC0415

        request = job.request or {}
        source = Path(request.get("source") or "")
        out_dir = ctx.settings.outputs_dir / "vc" / job.id
        out_dir.mkdir(parents=True, exist_ok=True)
        target = out_dir / "converted.wav"

        def progress(fraction: float, message: str) -> None:
            ctx.store.update(job, progress=round(float(fraction), 3), message=message)

        handle = ctx.engines.acquire("rvc", reason="语音变声：%s" % source.name)
        try:
            if cancel_event.is_set():
                return {"job_id": job.id, "cancelled": True}
            info = await asyncio.to_thread(
                ctx.vc.convert,
                src=source,
                out_path=target,
                model_key=str(request.get("model") or ""),
                f0_up_key=int(request.get("f0_up_key", 0)),
                f0_method=str(request.get("f0_method") or "rmvpe"),
                index_rate=float(request.get("index_rate", 0.3)),
                filter_radius=int(request.get("filter_radius", 3)),
                resample_sr=int(request.get("resample_sr", 0)),
                rms_mix_rate=float(request.get("rms_mix_rate", 0.25)),
                protect=float(request.get("protect", 0.33)),
                progress=progress,
            )
            ctx.store.log(job, "变声完成：%s" % info.get("model"))
            return {
                "job_id": job.id,
                "output": str(target),
                "urls": {"output": "/files/vc/%s/%s" % (job.id, target.name)},
                **info,
            }
        finally:
            handle.release()

    return vc_runner


def make_vc_train_runner(ctx):
    """训练任务执行体。"""

    async def vc_train_runner(job: Job, cancel_event) -> Dict[str, Any]:
        import asyncio  # noqa: PLC0415

        request = TrainRequest(**(job.request or {}))

        def progress(fraction: float, message: str) -> None:
            ctx.store.update(job, progress=round(float(fraction), 3), message=message)

        def log(message: str) -> None:
            ctx.store.log(job, message)

        handle = ctx.engines.acquire("rvc_train", reason="RVC 训练：%s" % request.name)
        try:
            result = await asyncio.to_thread(
                training.run,
                ctx.settings,
                request,
                progress,
                log,
                lambda: cancel_event.is_set(),
            )
            return {"job_id": job.id, **result}
        finally:
            handle.release()

    return vc_train_runner


def register(app: FastAPI, ctx) -> None:
    @app.get("/v1/vc/catalog", tags=["vc"])
    def vc_catalog() -> Any:
        """模型库 + 可选参数。"""
        return {
            "ok": True,
            "models": model_store.list_models(ctx.settings),
            "f0_methods": F0_METHODS,
            "models_dir": str(bootstrap.models_dir(ctx.settings)),
            "engine": ctx.vc.status(),
        }

    @app.get("/v1/vc/pipeline", tags=["vc"])
    def vc_pipeline() -> Any:
        return {"ok": True, **ctx.vc.status()}

    @app.post("/v1/vc/models/load", tags=["vc"])
    def vc_load_model(model: str = Form("")) -> Any:
        """热加载一个音色（切换音色不必重启服务）。"""
        handle = ctx.engines.acquire("rvc", reason="加载变声模型")
        try:
            status = ctx.vc.load(model)
        finally:
            handle.release()
        return {"ok": True, **status}

    @app.post("/v1/vc/models/unload", tags=["vc"])
    def vc_unload_model() -> Any:
        ctx.vc.unload()
        return {"ok": True, "message": "已释放变声模型"}

    @app.post("/v1/vc/models/upload", tags=["vc"])
    async def vc_upload_model(
        weight: UploadFile = File(...),
        index: UploadFile = File(None),
        name: str = Form(""),
    ) -> Any:
        """导入一个音色（.pth，可选配套 .index）。"""
        label = (name.strip() or Path(weight.filename or "model").stem).replace("/", "_")
        if not label.endswith(".pth"):
            label = "%s.pth" % label
        target = bootstrap.models_dir(ctx.settings) / (label if label.endswith(".pth") else "%s.pth" % label)
        with target.open("wb") as handle:
            shutil.copyfileobj(weight.file, handle)

        index_path: Optional[Path] = None
        if index is not None and (index.filename or ""):
            index_path = target.with_suffix(".index")
            with index_path.open("wb") as handle:
                shutil.copyfileobj(index.file, handle)

        return {
            "ok": True,
            **model_store.describe(target),
            "message": "已导入 %s%s" % (target.stem, "（含检索索引）" if index_path else ""),
        }

    @app.delete("/v1/vc/models", tags=["vc"])
    def vc_delete_model(model: str = "") -> Any:
        return {"ok": True, **model_store.delete_model(ctx.settings, model)}

    @app.post("/v1/vc/convert", tags=["vc"])
    async def vc_convert(
        file: UploadFile = File(None),
        source: str = Form(""),
        model: str = Form(""),
        f0_up_key: int = Form(0),
        f0_method: str = Form("rmvpe"),
        index_rate: float = Form(0.3),
        filter_radius: int = Form(3),
        resample_sr: int = Form(0),
        rms_mix_rate: float = Form(0.25),
        protect: float = Form(0.33),
        wait: bool = Form(False),
    ) -> Any:
        """提交一次变声。`wait=true` 时同步等待（短音频用）。"""
        src = _resolve_source(ctx, file, source)
        if not model.strip():
            raise VcError("请先选择目标音色", code="MODEL_REQUIRED")

        request: Dict[str, Any] = {
            "source": str(src),
            "model": model.strip(),
            "f0_up_key": f0_up_key,
            "f0_method": f0_method,
            "index_rate": index_rate,
            "filter_radius": filter_radius,
            "resample_sr": resample_sr,
            "rms_mix_rate": rms_mix_rate,
            "protect": protect,
        }

        if wait:
            out_dir = ctx.settings.outputs_dir / "vc" / uuid.uuid4().hex[:12]
            out_dir.mkdir(parents=True, exist_ok=True)
            target = out_dir / "converted.wav"
            handle = ctx.engines.acquire("rvc", reason="语音变声（同步）")
            try:
                info = ctx.vc.convert(src=src, out_path=target, model_key=model.strip(), **{
                    k: v for k, v in request.items() if k not in {"source", "model"}
                })
            finally:
                handle.release()
            return {"ok": True, "output": str(target), **info}

        job = ctx.store.create(
            JobKind.VC_INFER,
            name="语音变声：%s" % src.name,
            request=request,
            owner="local",
        )
        ctx.scheduler.submit(job)
        return {"ok": True, "job_id": job.id, "message": "任务已入队，请轮询 /v1/jobs/%s" % job.id}

    @app.post("/v1/vc/merge", tags=["vc"])
    def vc_merge(payload: Any) -> Any:
        """多权重融合。`models` 至少两个，`weights` 会自动归一化。"""
        data = payload if isinstance(payload, dict) else {}
        names = list(data.get("models") or [])
        weights = [float(w) for w in (data.get("weights") or [])]
        if len(names) < 2:
            raise VcError("融合至少需要两个模型", code="BAD_REQUEST")
        if len(weights) != len(names):
            weights = [1.0] * len(names)

        paths = []
        for name in names:
            path = model_store.find_model(ctx.settings, name)
            if path is None:
                raise VcError("未找到模型：%s" % name, code="MODEL_MISSING")
            paths.append(path)
        result = merge_module.merge_models(ctx.settings, paths, weights, name=str(data.get("name") or ""))
        return {"ok": True, **result}

    @app.post("/v1/vc/train/plan", tags=["vc"])
    def vc_train_plan(payload: Any) -> Any:
        """只列出每一步会跑什么，不执行。"""
        data = payload if isinstance(payload, dict) else {}
        request = TrainRequest(**data)
        return {"ok": True, "stages": training.plan(ctx.settings, request), "request": request.to_dict()}

    @app.post("/v1/vc/train", tags=["vc"])
    def vc_train(payload: Any) -> Any:
        """提交训练任务。"""
        data = payload if isinstance(payload, dict) else {}
        request = TrainRequest(**data)
        if not request.corpus_dir:
            raise VcError("请先提供语料目录", hint="录音或收集 10~30 分钟干净干声后放到一个目录里。", code="MISSING_INPUT")
        job = ctx.store.create(
            JobKind.VC_TRAIN,
            name="变声训练：%s" % request.name,
            request=data,
            owner="local",
            priority=1,
        )
        ctx.scheduler.submit(job)
        return {"ok": True, "job_id": job.id, "message": "训练任务已入队，请轮询 /v1/jobs/%s" % job.id}

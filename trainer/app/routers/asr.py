"""ASR 端点（语音转文本）。

与页面上的两个使用场景一一对应，这也是本模块**唯一**要照顾的两件事：

1. **推理入口** `/v1/asr/transcribe` —— 单条、短音频、同步返回。
   「导入音色」对话框里的「一键智能转写（标注 ASR 模型）」点一下就是它：
   上传的参考音频 3~10 秒，用户期待的是点完就出字，所以这里不建任务。
2. **训练入口** `/v1/asr/train` —— 批量音频 → 逐字文本数据集（任务化）。
   它在命名上与 `/v1/vc/train`、`/v1/train` 对称：都是「把一批素材变成可训练的东西」。
   区别只在于 ASR 产出的是**数据**（文本 + 官方格式清单），不是模型权重 ——
   详见 `asr/training.py` 的模块文档。

任务归属：ASR 两个入口都登记在**推理池**（`JobKind.ASR_TRAIN` 虽然叫 train，
做的却是推理）。让数据集构建去占「训练」位会把显卡标记成「训练中」，
从而拒绝其它推理请求 —— 那是 GPT-SoVITS 微调才该有的语义。
"""

from __future__ import annotations

import asyncio
import shutil
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, File, Form, UploadFile

from ..asr import catalog, training
from ..asr.bootstrap import AsrError
from ..asr.training import DatasetRequest
from ..audio.io import AUDIO_SUFFIXES
from ..jobs import Job, JobKind


def _public(resolved: Dict[str, Any]) -> Dict[str, Any]:
    """去掉内部字段（`key` 是引擎用来判断「要不要重新加载」的元组，前端不需要）。"""
    return {name: value for name, value in resolved.items() if name != "key"}


def _request_from(data: Any) -> DatasetRequest:
    """把请求体转成 `DatasetRequest`，字段不认识时给出可读的 400。

    `DatasetRequest(**data)` 对多余字段会抛 `TypeError`，那是 500；
    而「前端还在用旧字段名」这种问题必须以 400 + 提示返回，否则用户只看到
    「服务端返回了无法解析的数据」—— 这是本地工具里最没用的那种错误。
    """
    payload = data if isinstance(data, dict) else {}
    try:
        return DatasetRequest(**payload)
    except TypeError as exc:
        raise AsrError(
            "请求参数有误：%s" % exc,
            hint="对照 /v1/asr/train/plan 的字段清单检查参数名。",
            code="BAD_REQUEST",
            status=400,
            retryable=False,
        ) from exc


def _resolve_source(ctx, upload: Optional[UploadFile], source: str) -> Path:
    """把「上传的文件」或「本机路径」解析成一个真实存在的音频文件。"""
    if upload is not None and (upload.filename or ""):
        suffix = Path(upload.filename).suffix.lower()
        if suffix not in AUDIO_SUFFIXES:
            raise AsrError(
                "不支持的音频格式：%s" % upload.filename,
                hint="支持 %s。" % "、".join(sorted(AUDIO_SUFFIXES)),
                code="BAD_FORMAT",
                status=400,
                retryable=False,
            )
        target_dir = ctx.settings.uploads_dir / "asr"
        target_dir.mkdir(parents=True, exist_ok=True)
        target = target_dir / ("%s_%s" % (uuid.uuid4().hex[:8], Path(upload.filename).name))
        with target.open("wb") as handle:
            shutil.copyfileobj(upload.file, handle)
        return target
    if source.strip():
        path = Path(source.strip()).expanduser()
        if not path.is_file():
            raise AsrError(
                "音频文件不存在：%s" % path,
                hint="确认路径，或改用文件上传。",
                code="SOURCE_MISSING",
                status=404,
                retryable=False,
            )
        return path
    raise AsrError(
        "请上传音频或填写本机路径",
        hint="参考音频用上传；已有素材可以直接填绝对路径。",
        code="MISSING_INPUT",
        status=400,
        retryable=False,
    )


def make_asr_train_runner(ctx):
    """训练入口（数据集构建）的任务执行体。"""

    async def asr_train_runner(job: Job, cancel_event) -> Dict[str, Any]:
        request = DatasetRequest(**(job.request or {}))

        def progress(fraction: float, message: str) -> None:
            ctx.store.update(job, progress=round(float(fraction), 3), message=message)

        def log(message: str) -> None:
            ctx.store.log(job, message)

        # 与其它板块一样走引擎注册表：ASR 也要吃显存，同卡互斥没有例外。
        handle = ctx.engines.acquire("asr", reason="ASR 数据集：%s" % request.name)
        try:
            result = await asyncio.to_thread(
                training.run,
                ctx.asr,
                request,
                progress,
                log,
                lambda: cancel_event.is_set(),
            )
            ctx.store.log(job, "数据集目录：%s" % result.get("dataset_dir", ""))
            return {"job_id": job.id, **result}
        finally:
            handle.release()

    return asr_train_runner


def register(app: FastAPI, ctx) -> None:
    @app.get("/v1/asr/catalog", tags=["asr"])
    def asr_catalog() -> Any:
        """能力清单 + 两条通道的体检结果 + 当前引擎状态。"""
        return {
            "ok": True,
            **catalog.describe(ctx.settings),
            "diagnostics": {
                **ctx.asr.diagnostics(),
                "datasets": training.list_datasets(ctx.settings),
            },
            "engine": ctx.asr.status(),
        }

    @app.get("/v1/asr/pipeline", tags=["asr"])
    def asr_pipeline() -> Any:
        return {"ok": True, **ctx.asr.status()}

    @app.post("/v1/asr/plan", tags=["asr"])
    def asr_plan(payload: Any) -> Any:
        """只算「会怎么跑」，不执行。前端用它把模型与通道回显给用户。"""
        data = payload if isinstance(payload, dict) else {}
        resolved = ctx.asr.resolve(
            backend=str(data.get("backend") or ""),
            size=str(data.get("size") or ""),
            language=str(data.get("language") or ""),
            precision=str(data.get("precision") or ""),
            model=str(data.get("model") or ""),
            channel=str(data.get("channel") or ""),
        )
        return {"ok": True, **_public(resolved)}

    @app.post("/v1/asr/models/load", tags=["asr"])
    def asr_load_model(payload: Any) -> Any:
        """加载（或热切换到）指定模型。常驻通道才有意义。"""
        data = payload if isinstance(payload, dict) else {}
        handle = ctx.engines.acquire("asr", reason="加载 ASR 模型")
        try:
            status = ctx.asr.load(
                backend=str(data.get("backend") or ""),
                size=str(data.get("size") or ""),
                language=str(data.get("language") or ""),
                precision=str(data.get("precision") or ""),
                model=str(data.get("model") or ""),
                channel=str(data.get("channel") or ""),
            )
        finally:
            handle.release()
        return {"ok": True, **status}

    @app.post("/v1/asr/models/unload", tags=["asr"])
    def asr_unload_model() -> Any:
        ctx.asr.unload()
        return {"ok": True, "message": "已释放 ASR 模型"}

    @app.post("/v1/asr/transcribe", tags=["asr"])
    async def asr_transcribe(
        file: UploadFile = File(None),
        source: str = Form(""),
        backend: str = Form(""),
        size: str = Form(""),
        language: str = Form(""),
        precision: str = Form(""),
        model: str = Form(""),
        channel: str = Form(""),
        use_cache: bool = Form(True),
    ) -> Any:
        """单条转写（同步）。

        「一键智能转写」走的就是这里：参考音频只有几秒，同步返回比建任务更省事，
        前端也不必为一个 3 秒的音频去轮询任务。
        """
        src = _resolve_source(ctx, file, source)
        handle = ctx.engines.acquire("asr", reason="语音转写：%s" % src.name)
        try:
            result = await asyncio.to_thread(
                ctx.asr.transcribe,
                src=src,
                backend=backend,
                size=size,
                language=language,
                precision=precision,
                model=model,
                channel=channel,
                use_cache=use_cache,
            )
        finally:
            handle.release()
        if not result.get("text"):
            return {
                "ok": True,
                **result,
                "warning": "未识别到文本：音频可能是纯静音、纯音乐，或语种与所选语言不符。",
            }
        return {"ok": True, **result}

    @app.post("/v1/asr/upload", tags=["asr"])
    async def asr_upload(files: List[UploadFile] = File(...)) -> Any:
        """批量上传音频，返回落盘路径（供训练入口引用）。"""
        target_dir = ctx.settings.uploads_dir / "asr" / uuid.uuid4().hex[:8]
        target_dir.mkdir(parents=True, exist_ok=True)
        saved: List[str] = []
        skipped: List[Dict[str, str]] = []
        for item in files:
            name = Path(item.filename or "clip").name
            if Path(name).suffix.lower() not in AUDIO_SUFFIXES:
                skipped.append({"name": name, "reason": "不支持的格式"})
                continue
            target = target_dir / name
            with target.open("wb") as handle:
                shutil.copyfileobj(item.file, handle)
            saved.append(str(target))
        return {"ok": True, "files": saved, "skipped": skipped, "dir": str(target_dir)}

    @app.post("/v1/asr/train/plan", tags=["asr"])
    def asr_train_plan(payload: Any) -> Any:
        """训练入口预检：会转写多少条、走哪条通道、产物落在哪。"""
        request = _request_from(payload)
        return {"ok": True, **training.plan(ctx.asr, request)}

    @app.post("/v1/asr/train", tags=["asr"])
    def asr_train(payload: Any) -> Any:
        """提交训练入口任务（批量音频 → 逐字文本数据集）。"""
        request = _request_from(payload)
        if not request.corpus_dir.strip() and not request.files:
            raise AsrError(
                "请提供语料目录或上传音频",
                hint="填一个本机目录（例如 D:\\素材\\语料），或先在页面上传音频。",
                code="MISSING_INPUT",
                status=400,
                retryable=False,
            )
        job = ctx.store.create(
            JobKind.ASR_TRAIN,
            name="ASR 数据集：%s" % request.name,
            request=request.to_dict(),
            owner="local",
        )
        ctx.scheduler.submit(job)
        return {"ok": True, "job_id": job.id, "message": "任务已入队，请轮询 /v1/jobs/%s" % job.id}

    @app.get("/v1/asr/datasets", tags=["asr"])
    def asr_datasets() -> Any:
        return {"ok": True, "datasets": training.list_datasets(ctx.settings)}

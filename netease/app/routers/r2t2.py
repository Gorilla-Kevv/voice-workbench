"""Confucius4-R2T2 端点（/v1/r2t2/*）。

两种转写模式共用一个端点：
- `stream=false`：等全部转完，JSON 一次性返回（离线精度）；
- `stream=true`：NDJSON 增量流——`{"type":"delta","text":...}` 一条条出，
  最后一条 `{"type":"result",...}` 是定稿。append-only 语义由上游保证：
  已经输出的文本不会被改写，这正是 R2T2 区别于滑窗伪流式的地方。
"""

from __future__ import annotations

import json
import time
import uuid
from pathlib import Path
from typing import Any, Iterator, Optional

from fastapi import APIRouter, File, Form, Request, UploadFile
from fastapi.responses import StreamingResponse

from ..errors import NeteaseError
from ..r2t2 import WorkerError
from ..tts_engine import check_vram

router = APIRouter(prefix="/v1/r2t2")


def _ctx(request: Request) -> Any:
    return request.app.state.ctx


@router.get("/pipeline")
def pipeline(request: Request) -> dict[str, Any]:
    ctx = _ctx(request)
    return {
        "ok": True,
        **ctx.asr.status(),
        "lock": ctx.lock.describe(),
        "recent_logs": ctx.asr.recent_logs(10),
    }


@router.post("/warmup")
def warmup(request: Request) -> dict[str, Any]:
    ctx = _ctx(request)
    preempted = ctx.lock.acquire("asr", preempt=True, wait_seconds=0)
    if preempted == "tts":
        ctx.tts.unload()
    try:
        status = ctx.asr.warmup()
    except WorkerError as error:
        raise NeteaseError(
            error.code,
            error.message,
            error.hint,
            status=503,
            retryable=True,
            details={"recent_logs": ctx.asr.recent_logs(30)},
        ) from error
    return {"ok": True, "preempted": preempted, "engine": status}


@router.post("/unload")
def unload(request: Request) -> dict[str, Any]:
    ctx = _ctx(request)
    status = ctx.asr.unload()
    ctx.lock.release("asr")
    return {"ok": True, "engine": status, "lock": ctx.lock.describe()}


@router.post("/transcribe")
def transcribe(
    request: Request,
    file: Optional[UploadFile] = File(None),
    ref_path: Optional[str] = Form(None),
    language: str = Form("auto"),
    return_timestamps: bool = Form(False),
    stream: bool = Form(False),
    chunk_ms: int = Form(160),
    preempt: bool = Form(True),
) -> Any:
    ctx = _ctx(request)
    audio_path = _save_upload(ctx, file, ref_path)

    if not ctx.asr.status()["model_loaded"]:
        preempted = ctx.lock.acquire("asr", preempt=preempt, wait_seconds=0)
        if preempted == "tts":
            ctx.tts.unload()
        # 显存检查只在冷启动路径做：worker 已就绪时它自己占着卡，检查没有意义
        check_vram()
        try:
            ctx.asr.warmup()
        except WorkerError as error:
            raise NeteaseError(error.code, error.message, error.hint, status=503, retryable=True) from error
        preempted_value: Optional[str] = preempted
    else:
        preempted_value = None

    if not stream:
        try:
            result = ctx.asr.transcribe(
                path=str(audio_path),
                language=language,
                return_timestamps=return_timestamps,
            )
        except WorkerError as error:
            raise NeteaseError(error.code, error.message, error.hint, status=503, retryable=True) from error
        return {
            "ok": True,
            "text": result.get("text", ""),
            "language": language,
            "elapsed_sec": result.get("elapsed_sec"),
            "timestamps": result.get("timestamps"),
            "stream": False,
            "preempted": preempted_value,
        }

    generator = _stream_events(ctx, audio_path, language, chunk_ms, preempted_value)
    return StreamingResponse(generator, media_type="application/x-ndjson")


def _stream_events(
    ctx: Any, audio_path: Path, language: str, chunk_ms: int, preempted: Optional[str]
) -> Iterator[str]:
    def line(payload: dict) -> str:
        return json.dumps(payload, ensure_ascii=False) + "\n"

    yield line({"type": "start", "language": language, "chunk_ms": chunk_ms, "preempted": preempted})
    try:
        for event in ctx.asr.stream(path=str(audio_path), language=language, chunk_ms=chunk_ms):
            kind = event.get("type")
            if kind == "stream_delta":
                yield line(
                    {
                        "type": "delta",
                        "text": event.get("text", ""),
                        "elapsed_sec": event.get("elapsed_sec"),
                    }
                )
            elif kind == "result":
                yield line(
                    {
                        "type": "result",
                        "ok": True,
                        "text": event.get("text", ""),
                        "language": language,
                        "elapsed_sec": event.get("elapsed_sec"),
                        "stream": True,
                        "preempted": preempted,
                    }
                )
                return
            elif kind == "error":
                yield line(
                    {
                        "type": "error",
                        "ok": False,
                        "error": {"code": "WORKER_ERROR", "message": str(event.get("message", "")), "retryable": True, "hint": str(event.get("hint", ""))},
                    }
                )
                return
    except WorkerError as error:
        yield line(
            {
                "type": "error",
                "ok": False,
                "error": {"code": error.code, "message": error.message, "retryable": True, "hint": error.hint},
            }
        )


def _save_upload(ctx: Any, file: Optional[UploadFile], ref_path: Optional[str]) -> Path:
    if file is not None and file.filename:
        suffix = Path(file.filename).suffix or ".wav"
        out_dir = ctx.settings.uploads_dir / "asr"
        out_dir.mkdir(parents=True, exist_ok=True)
        target = out_dir / f"asr-{int(time.time())}-{uuid.uuid4().hex[:8]}{suffix}"
        with target.open("wb") as sink:
            while chunk := file.file.read(1024 * 1024):
                sink.write(chunk)
        return target
    if ref_path:
        path = Path(ref_path)
        if not path.exists():
            raise NeteaseError(
                "AUDIO_MISSING",
                f"音频不存在：{ref_path}",
                "ref_path 必须是 netease 服务所在机器上的音频文件路径；请改用文件上传。",
            )
        return path
    raise NeteaseError(
        "AUDIO_REQUIRED",
        "缺少音频文件",
        "上传一段音频（wav/mp3/flac），或提供服务端可见的 ref_path。",
    )

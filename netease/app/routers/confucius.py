"""Confucius4-TTS 端点（/v1/confucius/*）。

合成请求是 multipart：文本 + 语种 + 参考音频（上传文件或服务端路径）。
响应是 JSON（audio_base64）—— 网关对它是透明字节流，前端拿 base64 解成 Blob 播放；
选 JSON 而不是裸 wav，是为了与既有 `localRequest` 客户端错误透传约定保持一致。
"""

from __future__ import annotations

import base64
import time
import uuid
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, File, Form, Request, UploadFile

from ..errors import NeteaseError
from ..models import TtsResult
from ..tts_engine import check_vram

router = APIRouter(prefix="/v1/confucius")


def _ctx(request: Request) -> Any:
    return request.app.state.ctx


@router.get("/pipeline")
def pipeline(request: Request) -> dict[str, Any]:
    ctx = _ctx(request)
    return {"ok": True, **ctx.tts.status(), "lock": ctx.lock.describe()}


@router.post("/warmup")
def warmup(request: Request) -> dict[str, Any]:
    ctx = _ctx(request)
    preempted = ctx.lock.acquire("tts", preempt=True, wait_seconds=0)
    if preempted == "asr":
        ctx.asr.unload()
    check_vram()
    try:
        status = ctx.tts.ensure_loaded()
    except NeteaseError:
        ctx.lock.release("tts")
        raise
    return {"ok": True, "preempted": preempted, "engine": status, "lock": ctx.lock.describe()}


@router.post("/unload")
def unload(request: Request) -> dict[str, Any]:
    ctx = _ctx(request)
    status = ctx.tts.unload()
    ctx.lock.release("tts")
    return {"ok": True, "engine": status, "lock": ctx.lock.describe()}


#: 速度 / 质量档位 → (num_beams, n_timesteps)。
#: 官方默认是 (3, 25) ——  beams=3 会让 T2S 自回归跑三条候选，代价约 3 倍；
#: 本机 8 GB 卡上这是「慢」的主因之一，所以默认给到 balanced。
QUALITY_PRESETS: dict[str, tuple[int, int]] = {
    "fast": (1, 10),
    "balanced": (1, 18),
    "quality": (3, 25),
}
DEFAULT_QUALITY = "balanced"

#: 给界面看的说明：说清「快在哪、牺牲什么」，不写「更快」这种空话
QUALITY_NOTES: dict[str, str] = {
    "fast": "贪心解码 + 10 步扩散：最快，长句偶有发音松散",
    "balanced": "贪心解码 + 18 步扩散：速度与质量的折中（默认）",
    "quality": "官方默认：3 束搜索 + 25 步扩散，最稳但约慢 2~3 倍",
}


@router.post("/tts", response_model=TtsResult)
def tts(
    request: Request,
    text: str = Form(...),
    lang: str = Form("zh"),
    file: Optional[UploadFile] = File(None),
    ref_path: Optional[str] = Form(None),
    preempt: bool = Form(True),
    quality: str = Form(DEFAULT_QUALITY),
    num_beams: Optional[int] = Form(None),
    n_timesteps: Optional[int] = Form(None),
) -> dict[str, Any]:
    ctx = _ctx(request)
    prompt_wav = _resolve_ref(ctx, file, ref_path)

    beams, steps = QUALITY_PRESETS.get(quality, QUALITY_PRESETS[DEFAULT_QUALITY])
    # 裸参数优先：给了就用调用方的，方便调参
    if num_beams is not None:
        beams = num_beams
    if n_timesteps is not None:
        steps = n_timesteps

    if not ctx.tts.loaded:
        preempted = ctx.lock.acquire("tts", preempt=preempt, wait_seconds=0)
        if preempted == "asr":
            ctx.asr.unload()
        check_vram()
        try:
            ctx.tts.ensure_loaded()
        except NeteaseError:
            ctx.lock.release("tts")
            raise
    else:
        preempted = None

    result = ctx.tts.generate(text=text, lang=lang, prompt_wav=prompt_wav, num_beams=beams, n_timesteps=steps)
    audio_bytes = Path(result["path"]).read_bytes()
    return {
        "ok": True,
        "audio_base64": base64.b64encode(audio_bytes).decode("ascii"),
        "sample_rate": result["sample_rate"],
        "duration_sec": result["duration_sec"],
        "elapsed_sec": result["elapsed_sec"],
        "path": result["path"],
        "language": lang,
        "preempted": preempted,
    }


def _resolve_ref(ctx: Any, file: Optional[UploadFile], ref_path: Optional[str]) -> Path:
    if file is not None and file.filename:
        suffix = Path(file.filename).suffix or ".wav"
        out_dir = ctx.settings.uploads_dir / "ref"
        out_dir.mkdir(parents=True, exist_ok=True)
        target = out_dir / f"ref-{int(time.time())}-{uuid.uuid4().hex[:8]}{suffix}"
        with target.open("wb") as sink:
            while chunk := file.file.read(1024 * 1024):
                sink.write(chunk)
        return target
    if ref_path:
        path = Path(ref_path)
        if not path.exists():
            raise NeteaseError(
                "REF_AUDIO_MISSING",
                f"参考音频不存在：{ref_path}",
                "ref_path 必须是 netease 服务所在机器上的音频文件路径；浏览器本地路径无效，请改用文件上传。",
            )
        return path
    raise NeteaseError(
        "REF_AUDIO_REQUIRED",
        "缺少参考音频",
        "Confucius4-TTS 是零样本克隆：需要 ≥3 秒参考音频（上传文件、从音色库选择，或给服务端路径）。",
    )

"""/health、/v1/netease/catalog 与引擎互斥端点。

设计要点：/health **永远 200**——「服务活着」与「模型可用」是两件事，
后者体现在 engines 的 installed/missing 里。前端探活据此区分
ready / incomplete（服务通但没装权重）/ offline（服务没起）。
"""

from __future__ import annotations

import sys
from typing import Any

from fastapi import APIRouter, Request

from ..engine import EngineBusy
from ..errors import NeteaseError
from ..hardware import probe, vram_mb
from ..models import CatalogResponse, HealthResponse
from ..tts_engine import TTS_LANGUAGES, REQUIRED_VRAM_MB
from .confucius import DEFAULT_QUALITY, QUALITY_NOTES, QUALITY_PRESETS

router = APIRouter()


def _engine_context(request: Request) -> Any:
    return request.app.state.ctx


@router.get("/health", response_model=HealthResponse)
def health(request: Request) -> dict[str, Any]:
    ctx = _engine_context(request)
    info = probe()
    vram = vram_mb()
    return {
        "ok": True,
        "service": "netease",
        "version": _version(),
        "python": sys.version.split()[0],
        "torch": info["torch"],
        "cuda": info["cuda"],
        "device": info["device"],
        "vram": vram,
        "engines": {
            "confucius_tts": {**ctx.tts.probe_install(), **ctx.tts.status()},
            "r2t2": {**ctx.asr.probe_install(), **ctx.asr.status()},
        },
        "engine_lock": ctx.lock.describe(),
        "configuration": {
            "tts_home": str(ctx.settings.tts_home),
            "tts_required_vram_mb": REQUIRED_VRAM_MB,
            "tts_precision": ctx.settings.precision,
            "r2t2_backend": ctx.settings.r2t2_backend,
            "r2t2_gpu_util": ctx.settings.r2t2_gpu_util,
            "r2t2_interpreter": ctx.settings.resolved_r2t2_python,
            "allow_cpu": ctx.settings.allow_cpu,
        },
    }


@router.get("/v1/netease/catalog", response_model=CatalogResponse)
def catalog(request: Request) -> dict[str, Any]:
    ctx = _engine_context(request)
    tts_install = ctx.tts.probe_install()
    asr_install = ctx.asr.probe_install()
    return {
        "ok": True,
        "tts": {
            "model": "Confucius4-TTS",
            "summary": "网易有道 1.3B 零样本 TTS：3 秒免参考文本克隆、跨语种无口音、情感迁移",
            "languages": TTS_LANGUAGES,
            "default_language": "zh",
            "ref_audio_note": "参考音频 ≥3 秒即可，无需逐字转写文本；支持从现有音色库直接选取",
            "required_vram_mb": REQUIRED_VRAM_MB,
            # 速度 / 质量档位：num_beams 管 T2S 自回归，n_timesteps 管 S2A 扩散步数
            "quality_presets": [
                {"id": key, "num_beams": value[0], "n_timesteps": value[1], "note": QUALITY_NOTES[key]}
                for key, value in QUALITY_PRESETS.items()
            ],
            "default_quality": DEFAULT_QUALITY,
            "install": tts_install,
        },
        "asr": {
            "model": "Confucius4-R2T2",
            "summary": "网易有道流式 ASR（Qwen3-ASR 基座）：append-only 真流式、流式精度≈离线",
            "languages": [
                {"code": "auto", "label": "自动检测"},
                {"code": "zh", "label": "中文"},
                {"code": "en", "label": "English"},
                {"code": "fr", "label": "Français"},
                {"code": "de", "label": "Deutsch"},
                {"code": "it", "label": "Italiano"},
                {"code": "ja", "label": "日本語"},
                {"code": "ko", "label": "한국어"},
                {"code": "pt", "label": "Português"},
                {"code": "ru", "label": "Русский"},
                {"code": "es", "label": "Español"},
                {"code": "ar", "label": "العربية"},
            ],
            "default_language": "auto",
            "chunk_ms_choices": [80, 160, 320, 640, 2000],
            "default_chunk_ms": 160,
            "stream_note": "流式输出为 append-only：已固定的文本不会被改写",
            "license_note": "R2T2 权重为网易自有许可（代码 Apache-2.0），商用前需单独确认",
            "install": asr_install,
        },
    }


@router.post("/v1/netease/engines/acquire")
def acquire(request: Request, payload: dict) -> dict[str, Any]:
    ctx = _engine_context(request)
    engine = str(payload.get("engine", ""))
    if engine not in {"tts", "asr"}:
        raise NeteaseError("BAD_REQUEST", "engine 必须是 tts 或 asr", "检查请求体。")
    preempt = bool(payload.get("preempt", True))
    wait_seconds = float(payload.get("wait_seconds", 0) or 0)
    try:
        preempted = ctx.lock.acquire(engine, preempt=preempt, wait_seconds=wait_seconds)
    except EngineBusy as busy:
        raise NeteaseError(
            "ENGINE_BUSY",
            str(busy),
            f"先到另一引擎页面点「卸载引擎」，或允许抢占（默认）。当前占用者：{busy.holder}",
            status=409,
            retryable=True,
        ) from busy
    return {"ok": True, "engine": engine, "preempted": preempted, "lock": ctx.lock.describe()}


@router.post("/v1/netease/engines/release")
def release(request: Request, payload: dict) -> dict[str, Any]:
    ctx = _engine_context(request)
    engine = str(payload.get("engine", ""))
    if engine not in {"tts", "asr"}:
        raise NeteaseError("BAD_REQUEST", "engine 必须是 tts 或 asr", "检查请求体。")
    released = ctx.lock.release(engine)
    return {"ok": True, "released": released, "lock": ctx.lock.describe()}


def _version() -> str:
    from .. import __version__  # noqa: PLC0415

    return __version__

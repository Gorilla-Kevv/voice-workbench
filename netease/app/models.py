"""Pydantic 契约：与前端 `app/src/types/netease.ts` 一一对应，改一边必改另一边。

错误契约不在本文件：见 `errors.py`（`{ok:false, error:{code,message,retryable,hint}}`）。
"""

from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel, Field


class EngineStatus(BaseModel):
    engine: str
    loaded: bool = False
    device: Optional[str] = None
    loaded_for_sec: Optional[float] = None


class HealthResponse(BaseModel):
    ok: bool = True
    service: str = "netease"
    version: str = ""
    python: str = ""
    torch: bool = False
    cuda: bool = False
    device: Optional[str] = None
    vram: Optional[dict[str, int]] = None
    engines: dict[str, Any] = Field(default_factory=dict)
    engine_lock: dict[str, Any] = Field(default_factory=dict)
    configuration: dict[str, Any] = Field(default_factory=dict)


class CatalogResponse(BaseModel):
    ok: bool = True
    tts: dict[str, Any]
    asr: dict[str, Any]


class EngineAcquireRequest(BaseModel):
    engine: str = Field(pattern="^(tts|asr)$")
    preempt: bool = True
    wait_seconds: float = 0.0


class TtsResult(BaseModel):
    ok: bool = True
    audio_base64: str
    sample_rate: int
    duration_sec: float
    elapsed_sec: float
    path: str
    language: str
    """被 TTS 抢占卸载的引擎名（未发生抢占为 null）"""
    preempted: Optional[str] = None


class TranscribeResult(BaseModel):
    ok: bool = True
    text: str
    language: str
    elapsed_sec: Optional[float] = None
    timestamps: Optional[list[dict[str, Any]]] = None
    stream: bool = False
    preempted: Optional[str] = None

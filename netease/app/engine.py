"""进程内引擎互斥：同一时刻只允许 TTS / ASR 一个引擎持显存。

与 `trainer/app/engine.py` 同一套语义，但只有一个进程可见 —— 跨运行时
（GPT-SoVITS、未来的 mtts）的显存协调本期不做，靠加载前的空闲显存检查 +
明确的 `VRAM_INSUFFICIENT` 报错兜底（8 GB 卡上同时常驻两个大模型本就不现实）。

互斥对象是「引擎是否已加载」，不是「单次请求」：模型加载后常驻，
后续合成/转写不再抢锁，直到显式 unload 或被另一个引擎抢占（preempt=True）。
"""

from __future__ import annotations

import threading
import time
from typing import Literal, Optional

EngineName = Literal["tts", "asr"]


class EngineBusy(Exception):
    """目标引擎被对方占用且未选择抢占。"""

    def __init__(self, holder: str, waited: float) -> None:
        super().__init__(f"引擎 {holder} 正在占用显卡（已等待 {waited:.0f}s）")
        self.holder = holder
        self.waited = waited


class EngineRegistry:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._holder: Optional[str] = None
        self._loaded_at: float = 0.0

    def is_free(self) -> bool:
        with self._lock:
            return self._holder is None

    def holder(self) -> Optional[str]:
        with self._lock:
            return self._holder

    def acquire(self, engine: str, *, preempt: bool = True, wait_seconds: float = 0.0) -> Optional[str]:
        """取得显卡使用权。

        返回被抢占的原持有引擎名（未发生抢占返回 None）；等待超时抛 EngineBusy。
        preempt=True 时直接卸载对方是刻意的默认：这是单用户本地工具，
        与其让用户先去另一个页面手动卸载，不如明确告知「已为你让位」。
        """
        deadline = time.monotonic() + max(0.0, wait_seconds)
        preempted: Optional[str] = None
        while True:
            with self._lock:
                if self._holder is None or self._holder == engine:
                    if self._holder is None:
                        self._holder = engine
                        self._loaded_at = time.monotonic()
                    return preempted
                holder = self._holder
            if preempt:
                with self._lock:
                    if self._holder == holder:
                        preempted = self._holder
                        self._holder = engine
                        self._loaded_at = time.monotonic()
                        return preempted
                continue
            if time.monotonic() >= deadline:
                raise EngineBusy(holder, wait_seconds)
            time.sleep(0.2)

    def release(self, engine: str) -> bool:
        with self._lock:
            if self._holder == engine:
                self._holder = None
                self._loaded_at = 0.0
                return True
            return False

    def describe(self) -> dict:
        with self._lock:
            if self._holder is None:
                return {"holder": None}
            return {
                "holder": self._holder,
                "loaded_for_sec": round(time.monotonic() - self._loaded_at, 1),
            }

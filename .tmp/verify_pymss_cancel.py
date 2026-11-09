"""验证 PyMSS 取消：1s 后 set cancel_event，bridge 应被进程树清理。"""

from __future__ import annotations

import sys
import threading
from dataclasses import replace
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "trainer"))

from app.audio.cache import ArtifactCache  # noqa: E402
from app.audio.pymss import PymssEngine  # noqa: E402
from app.audio.uvr5 import SeparationError  # noqa: E402
from app.config import Settings  # noqa: E402
from app.engine import EngineRegistry  # noqa: E402

settings = replace(Settings(), uvr_backend="pymss", pymss_device="cpu", vram_reserve_mb=0)
engine = PymssEngine(EngineRegistry(settings), ArtifactCache(settings.cache_dir), settings)
cancel = threading.Event()
timer = threading.Timer(1.0, cancel.set)
timer.start()
try:
    engine.separate(
        home=ROOT,
        src=ROOT / ".tmp" / "pymss_smoke" / "ref.wav",
        preset_key="vocal_fast",
        use_cache=False,
        out_dir=ROOT / ".tmp" / "pymss_cancel_test",
        cancel_event=cancel,
    )
    print("UNEXPECTED: completed")
except SeparationError as error:
    print("cancelled:", error.code, error.message)
finally:
    timer.cancel()

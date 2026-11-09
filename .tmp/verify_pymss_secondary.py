"""验证 PymssEngine 缓存命中与二级去混响（CPU）。"""

from __future__ import annotations

import sys
from dataclasses import replace
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "trainer"))

from app.audio.cache import ArtifactCache  # noqa: E402
from app.audio.pymss import PymssEngine  # noqa: E402
from app.config import Settings  # noqa: E402
from app.engine import EngineRegistry  # noqa: E402

settings = replace(Settings(), uvr_backend="pymss", pymss_device="cpu", vram_reserve_mb=0)
engine = PymssEngine(EngineRegistry(settings), ArtifactCache(settings.cache_dir), settings)
source = ROOT / ".tmp" / "pymss_smoke" / "ref.wav"

first = engine.separate(
    home=ROOT,
    src=source,
    preset_key="vocal_fast",
    secondary_key="none",
    use_cache=True,
    out_dir=ROOT / ".tmp" / "pymss_cache_test",
)
second = engine.separate(
    home=ROOT,
    src=source,
    preset_key="vocal_fast",
    secondary_key="none",
    use_cache=True,
    out_dir=ROOT / ".tmp" / "pymss_cache_test",
)
print("cache first cached=", first.cached, "second cached=", second.cached)
print("cache second elapsed_s=", second.elapsed_s)

secondary = engine.separate(
    home=ROOT,
    src=source,
    preset_key="vocal_fast",
    secondary_key="dereverb",
    use_cache=False,
    out_dir=ROOT / ".tmp" / "pymss_dereverb_test",
    progress=lambda fraction, message: print("dereverb progress:", round(fraction, 2), message),
)
print("dereverb result:", secondary.to_dict())
print("dereverb vocal exists:", bool(secondary.vocal and secondary.vocal.is_file()))

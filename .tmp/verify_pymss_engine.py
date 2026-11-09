"""离线验证 PymssEngine：catalog + 真 HP2 分离（CPU，不占 GPU）。"""

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
catalog = engine.catalog(ROOT)
print("backend:", catalog["backend"], "runtime_ready:", catalog["runtime_ready"], "models_ready:", catalog["models_ready"])
for preset in catalog["presets"]:
    if preset["key"] != "off":
        print("preset:", preset["key"], "model:", preset.get("pymss_model"), "available:", preset["available"])

result = engine.separate(
    home=ROOT,
    src=ROOT / ".tmp" / "pymss_smoke" / "ref.wav",
    preset_key="vocal_fast",
    secondary_key="none",
    agg=10,
    fmt="wav",
    out_dir=ROOT / ".tmp" / "pymss_engine_test",
    use_cache=False,
    progress=lambda fraction, message: print("progress:", round(fraction, 2), message),
)
print("result:", result.to_dict())
print("vocal exists:", bool(result.vocal and result.vocal.is_file()))
print("instrumental exists:", bool(result.instrumental and result.instrumental.is_file()))

# -*- coding: utf-8 -*-
"""SenseVoice HTTP 冒烟：/v1/asr/models/load → /v1/asr/transcribe → unload。"""
import shutil
import sys
from pathlib import Path

ROOT = Path(r"F:\schoolCompWorks\clone\ttstool")
sys.path.insert(0, str(ROOT / "trainer"))
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from fastapi.testclient import TestClient  # noqa: E402

from app.api import Context, create_app, register_runners  # noqa: E402
from app.config import Settings  # noqa: E402
from app.sovits import bootstrap as sovits_bootstrap  # noqa: E402

WORK = ROOT / "trainer" / ".tmp" / "sensevoice_http_probe"
if WORK.exists():
    shutil.rmtree(WORK, ignore_errors=True)
WORK.mkdir(parents=True, exist_ok=True)
MODEL_DIR = ROOT / "GPT-SoVITS-v2pro-20250604" / "tools" / "asr" / "models" / "SenseVoiceSmall"
inst = sovits_bootstrap.locate(str(ROOT / "GPT-SoVITS-v2pro-20250604"), auto_discover=False)
if inst is not None:
    sovits_bootstrap.install(inst)
settings = Settings(data_dir=WORK / "data", asr_device="cuda")
ctx = Context(settings)
register_runners(ctx)
app = create_app(ctx)

with TestClient(app) as client:
    load = client.post(
        "/v1/asr/models/load",
        json={"backend": "funasr", "language": "ja", "model": "iic/SenseVoiceSmall", "channel": "resident"},
    )
    print("LOAD", load.status_code, {k: (load.json().get(k)) for k in ("ok", "model", "channel", "device", "weights_ready", "runtime_ready", "funasr_source")})
    tr = client.post(
        "/v1/asr/transcribe",
        data={
            "source": str(MODEL_DIR / "example" / "ja.mp3"),
            "backend": "funasr",
            "language": "ja",
            "model": "iic/SenseVoiceSmall",
            "channel": "resident",
            "use_cache": "false",
        },
    )
    body = tr.json()
    print("TRANSCRIBE", tr.status_code, repr(body.get("text")), body.get("language"), body.get("model"), body.get("channel"))
    unload = client.post("/v1/asr/models/unload")
    print("UNLOAD", unload.status_code, unload.json())

shutil.rmtree(WORK, ignore_errors=True)

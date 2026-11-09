"""验证 UVR_BACKEND=pymss 的 HTTP 契约（TestClient，CPU，不占 GPU）。"""

from __future__ import annotations

import sys
from dataclasses import replace
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "trainer"))

from fastapi.testclient import TestClient  # noqa: E402

from app.api import Context, create_app  # noqa: E402
from app.config import Settings  # noqa: E402

settings = replace(
    Settings(),
    uvr_backend="pymss",
    pymss_device="cpu",
    vram_reserve_mb=0,
    warmup=False,
)
app = create_app(Context(settings))

with TestClient(app) as client:
    catalog = client.get("/v1/uvr/catalog")
    print("catalog:", catalog.status_code)
    body = catalog.json()
    print("backend:", body.get("backend"), "models_ready:", body.get("models_ready"))
    print("presets:", [(item["key"], item.get("pymss_model"), item["available"]) for item in body["presets"]])

    response = client.post(
        "/v1/uvr/separate",
        data={
            "source": str(ROOT / ".tmp" / "pymss_smoke" / "ref.wav"),
            "preset": "vocal_fast",
            "secondary": "none",
            "agg": "10",
            "format": "wav",
            "use_cache": "false",
            "wait": "true",
        },
    )
    print("separate:", response.status_code)
    payload = response.json()
    print("ok:", payload.get("ok"), "urls:", list((payload.get("urls") or {}).keys()))
    print("model:", payload.get("model"), "elapsed_s:", payload.get("elapsed_s"))
    for key, url in (payload.get("urls") or {}).items():
        print(key, url)

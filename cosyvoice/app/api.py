"""FastAPI 应用装配。

探活哲学与其它运行时一致：`/health` **永远 200**，「服务活着」与「模型可用」
是两件事（后者看 `weights.ready` 与 `loaded`）。
"""

from __future__ import annotations

import os
import sys
import threading
from typing import Any

from fastapi import Body, FastAPI, Request
from fastapi.responses import JSONResponse

from . import __version__, catalog, engine
from .config import REQUIRED_VRAM_MB, Settings, load_manifest
from .errors import CosyvoiceError
from .hardware import compute_capability, device_name, probe, vram_mb
from .inventory import group_report, resolve_weights_manifest_path, scan
from . import synth as synth_module


def create_app(settings: Settings) -> FastAPI:
    app = FastAPI(
        title="CosyVoice3 本地服务",
        version=__version__,
        description="Fun-CosyVoice3-0.5B：零样本克隆 + 跨语种 + 自然语言 instruct（方言/情感/语速）",
    )
    app.state.settings = settings

    @app.exception_handler(CosyvoiceError)
    async def _handle_error(_: Request, exc: CosyvoiceError) -> JSONResponse:
        return JSONResponse(status_code=exc.status, content=exc.to_body())

    @app.get("/health")
    def health() -> dict[str, Any]:
        info = probe()
        vram = vram_mb()
        inventory = scan(settings)
        capability = compute_capability()
        return {
            "ok": True,
            "service": "cosyvoice",
            "version": __version__,
            "python": sys.version.split()[0],
            "torch": info["torch"],
            "cuda": info["cuda"],
            "device": info["device"],
            "pid": os.getpid(),
            "vram": vram,
            "loaded": engine.is_loaded(),
            "weights": {
                "ready": inventory["inference_ready"],
                "groups": group_report(inventory),
                "missing": [item["target"] for item in inventory["missing"]],
                "truncated": [item["target"] for item in inventory["truncated"]],
                "missing_code": [item["target"] for item in inventory["missing_code"]],
            },
            "configuration": {
                **settings.as_dict(),
                "required_vram_mb": REQUIRED_VRAM_MB,
                "compute_capability": capability,
                "gpu_name": device_name(),
                "manifest_path": str(resolve_weights_manifest_path() or ""),
                "manifest_entries": len(load_manifest().get("entries") or []),
            },
            **engine.status(),
        }

    @app.get("/v1/catalog")
    def catalog_endpoint() -> dict[str, Any]:
        return catalog.build_catalog(settings)

    @app.post("/v1/warmup")
    def warmup(blocking: bool = True) -> dict[str, Any]:
        if engine.is_loaded():
            return {"ok": True, "loaded": True, "starting": False, "hint": "模型已在显存中"}
        engine.check_vram_admission(settings, loaded=False)
        if not blocking:
            thread = threading.Thread(target=_warmup_blocking, args=(settings,), daemon=True)
            thread.start()
            return {"ok": True, "loaded": False, "starting": True,
                    "hint": "正在后台加载，轮询 /health 的 loaded 字段"}
        engine.load(settings)
        return {"ok": True, "loaded": True, "starting": False}

    def _warmup_blocking(settings: Settings) -> None:
        try:
            engine.load(settings)
        except CosyvoiceError as error:
            print(f"[cosyvoice] 后台加载失败：{error.message}", flush=True)
        except Exception as error:  # pragma: no cover
            print(f"[cosyvoice] 后台加载异常：{type(error).__name__}: {error}", flush=True)

    @app.post("/v1/unload")
    def unload() -> dict[str, Any]:
        return {"ok": True, **engine.unload(settings)}

    @app.post("/v1/synth")
    def synth(payload: Any = Body(default=None)) -> dict[str, Any]:
        parsed = synth_module.parse_payload(payload)
        return synth_module.run_synthesis(settings, parsed)

    return app

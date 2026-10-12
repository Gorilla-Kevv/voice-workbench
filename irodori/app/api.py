"""FastAPI 应用装配。

30-1 只交付 `/health`（骨架跑通的最小闭环）；`/v1/catalog`、`/v1/warmup|unload|synth`
在 30-2 补，训练相关端点在 30-5 / 30-6 补。这样分段可验证：本段跑完就能回答
「服务活着吗 / 权重齐了吗 / 显存够不够」，而这三件事恰好是排障时最先要问的。
"""

from __future__ import annotations

import os
import sys
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from . import __version__, windecode
from .config import Settings, load_manifest, required_vram_mb
from .errors import IrodoriError
from .hardware import compute_capability, device_name, probe, vram_mb
from .inventory import group_report, resolve_weights_manifest_path, scan


def create_app(settings: Settings) -> FastAPI:
    # ★ 垫片要在**任何**可能 import torchaudio 的模块之前装好。
    # 这里刻意放在 create_app 的最前面（而不是 lifespan 里）：lifespan 在 uvicorn
    # 启动后才跑，而引擎模块可能在 import 期就去碰 torchaudio。
    windecode.install()

    app = FastAPI(
        title="Irodori-TTS 本地服务",
        version=__version__,
        description="日语特化 TTS：零样本克隆 + caption/emoji 风格控制 + Speaker Inversion 音色固化",
    )
    app.state.settings = settings

    @app.exception_handler(IrodoriError)
    async def _handle_irodori_error(_: Request, exc: IrodoriError) -> JSONResponse:
        return JSONResponse(status_code=exc.status, content=exc.to_body())

    @app.get("/health")
    def health() -> dict[str, Any]:
        """**永远 200**：服务活着与模型可用是两件事。

        前端探活据此区分 ready / incomplete（服务通但缺权重）/ offline（服务没起）——
        与 netease / indextts 同一套约定（见阶段 26 的两张状态卡）。
        """
        info = probe()
        vram = vram_mb()
        inventory = scan(settings)
        capability = compute_capability()

        return {
            "ok": True,
            "service": "irodori",
            "version": __version__,
            "python": sys.version.split()[0],
            "torch": info["torch"],
            "cuda": info["cuda"],
            "device": info["device"],
            # 自报 PID：网关据此确证端口归属（见 lib/processOwnership.ts 判据 ⓪）
            "pid": os.getpid(),
            "vram": vram,
            # 30-2 会变成「模型是否常驻显存」；本段恒 false，前端据此显示「未启动」
            "loaded": False,
            # 我们刻意不装 SilentCipher（水印耗时≈翻倍、显存 +0.9GB）。
            # 界面要如实显示「未加水印」，而不是让用户猜 —— 见 §1「不做」表。
            "watermark": False,
            "weights": {
                "ready": inventory["inference_ready"],
                "training_ready": inventory["training_ready"],
                "groups": group_report(inventory),
                "missing": [item["target"] for item in inventory["missing"]],
                "truncated": [item["target"] for item in inventory["truncated"]],
                "missing_code": [item["target"] for item in inventory["missing_code"]],
            },
            "windecode": windecode.status(),
            "configuration": {
                **settings.as_dict(),
                # 准入基准的**唯一事实源**在服务端（前端只留兜底常量）
                "required_vram_mb": required_vram_mb(settings.precision),
                "compute_capability": capability,
                "gpu_name": device_name(),
                # int4 走 torchao tinygemm，只在 cc ≥ 8.0 可用（换机可能失效 → 上层回落）
                "int4_supported": None if capability is None else (capability[0] >= 8),
                "manifest_path": str(resolve_weights_manifest_path() or ""),
                "manifest_entries": len(load_manifest().get("entries") or []),
            },
        }

    return app

"""FastAPI 应用装配。

30-1 交付 `/health`；30-2 补推理链路（`/v1/catalog`、`/v1/warmup|unload|synth`、`/v1/speakers`）；
30-5 补训练侧 S1+S2（`/v1/train/plan|upload|prepare|datasets` + `/v1/jobs`）；
S3 训练编排在 30-6。

探活哲学与 netease / indextts 一致：`/health` **永远 200**，「服务活着」与「模型可用」
是两件事（后者看 `weights.ready` 与 `loaded`）。
"""

from __future__ import annotations

import os
import sys
import threading
from typing import Any

from fastapi import Body, FastAPI, Request
from fastapi.responses import JSONResponse

from . import __version__, catalog, engine, windecode
from .config import Settings, load_manifest, required_vram_mb
from .errors import IrodoriError
from .hardware import compute_capability, device_name, probe, vram_mb
from .inventory import group_report, resolve_weights_manifest_path, scan
from .jobs import JobStore
from .routers import train as train_routes
from . import synth as synth_module


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
    # 任务表（30-5）：训练/整备都是长任务，走 JobStore 的轮询形态（对齐 trainer）
    app.state.jobs = JobStore(settings.jobs_dir)

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
            # 模型是否常驻显存（engine 维护；懒加载，未 warmup 前是 false）
            "loaded": engine.is_loaded(),
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

    # ------------------------------------------------------------------
    # 推理链路（30-2）
    # ------------------------------------------------------------------

    @app.get("/v1/catalog")
    def catalog_endpoint() -> dict[str, Any]:
        """emoji 表 / caption 预设 / 步数档位 / 语言与参考音频约束。

        全部常量从上游代码与配置推导，前端**不要自己抄一份**
        （坑 19 的延伸：真源在服务端）。
        """
        return catalog.build_catalog(settings)

    @app.post("/v1/warmup")
    def warmup(blocking: bool = True) -> dict[str, Any]:
        """把模型装进显存（实测 ~20s）。**已加载直接返回不拦**（坑 26 修法）。

        `?blocking=false`：后台线程加载，立刻返回 `{"starting": true}`，
        前端轮询 `/health` 的 `loaded` 看进度。
        """
        if engine.is_loaded():
            return {"ok": True, "loaded": True, "starting": False, "hint": "模型已在显存中"}
        engine.check_vram_admission(settings, loaded=False)

        if not blocking:
            thread = threading.Thread(target=_warmup_blocking, args=(settings,), daemon=True)
            thread.start()
            return {"ok": True, "loaded": False, "starting": True,
                    "hint": "正在后台加载（约 20s），轮询 /health 的 loaded 字段"}

        engine.load(settings)
        return {"ok": True, "loaded": True, "starting": False}

    def _warmup_blocking(settings: Settings) -> None:
        try:
            engine.load(settings)
        except IrodoriError as error:
            print(f"[irodori] 后台加载失败：{error.message}", flush=True)
        except Exception as error:  # pragma: no cover - 环境相关
            print(f"[irodori] 后台加载异常：{type(error).__name__}: {error}", flush=True)

    @app.post("/v1/unload")
    def unload() -> dict[str, Any]:
        """释放显存并回报归还量。未加载时幂等返回。"""
        return {"ok": True, **engine.unload(settings)}

    @app.post("/v1/synth")
    def synth(payload: Any = Body(default=None)) -> dict[str, Any]:
        """合成一条日语语音（JSON body，返回 base64 WAV）。

        请求字段见 `docs/IRODORI-INTEGRATION-PLAN.md` §4.1；服务端负责
        日语校验（NO_JA_ONLY）、切句（≤25 字/段）、参考音频解析与拼接，
        以及**长尾护栏**（段间降步 + 墙钟看门狗，见 `synth.py`）。
        响应里的 `retried` / `steps_requested` / `steps_used` 如实反映护栏是否介入；
        超时返回 504 `IRODORI_TIMEOUT`（`details.retry_suggestion` 给降步重试值）。

        （`Body(default=None)` 是坑 37：裸 `payload: Any` 会被当成必需的 query 参数）
        """
        parsed = synth_module.parse_payload(payload)
        # 校验顺序（校验 → 准入 → 互斥）收在 run_synthesis 里，见它的注释
        return synth_module.run_synthesis(settings, parsed)

    @app.get("/v1/speakers")
    def speakers() -> dict[str, Any]:
        """已固化的 speaker embedding 列表（30-6 训练产物，30-2 先把目录约定立起来）。"""
        speakers_dir = settings.data_dir / "speakers"
        items: list[dict[str, Any]] = []
        if speakers_dir.is_dir():
            for path in sorted(speakers_dir.glob("*.speaker.safetensors")):
                stat = path.stat()
                items.append({
                    "id": path.name.removesuffix(".speaker.safetensors"),
                    "path": str(path),
                    "size_bytes": stat.st_size,
                    "updated_at": stat.st_mtime,
                })
        return {"ok": True, "speakers": items, "count": len(items)}

    # ------------------------------------------------------------------
    # 训练侧（30-5：S1+S2；S3 在 30-6）
    # ------------------------------------------------------------------
    train_routes.register(app, settings, app.state.jobs)

    return app

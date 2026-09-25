"""新增板块的 HTTP 路由。

`api.py` 已经两千行量级，再往里塞两个板块会让它变成没人敢动的文件。
所以新端点一律写成 `APIRouter`，在这里统一挂载 —— 与现有 `_register_*` 系列
是同一套风格（每个函数只负责一块能力），只是换成了可组合的 router。

网关侧不需要任何改动：`server/routes/sovits.ts` 是 `/api/sovits/*` 全匹配透传，
新路径天然被覆盖。
"""

from __future__ import annotations

from fastapi import FastAPI

from . import asr, engines, svc, uvr, vc


def register(app: FastAPI, ctx) -> None:
    """挂载全部新路由。

    顺序无关，但保持「共用能力在前、板块在后」，便于阅读。
    """
    engines.register(app, ctx)
    uvr.register(app, ctx)
    asr.register(app, ctx)
    svc.register(app, ctx)
    vc.register(app, ctx)


__all__ = ["register", "asr", "engines", "svc", "uvr", "vc"]

"""路由组装：只做装配，不写业务 —— 业务在各引擎适配层里。

Context 是全服务的依赖容器（与 trainer 的 Context 同思路）：
路由函数通过 `request.app.state.ctx` 拿到它。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from . import __version__
from .config import Settings
from .engine import EngineRegistry
from .errors import NeteaseError
from .r2t2 import R2T2Manager
from .tts_engine import TtsPipeline
from .routers import confucius, netease, r2t2


@dataclass
class Context:
    settings: Settings
    lock: EngineRegistry = field(default_factory=EngineRegistry)
    tts: TtsPipeline = field(init=False)
    asr: R2T2Manager = field(init=False)

    def __post_init__(self) -> None:
        self.tts = TtsPipeline(self.settings)
        self.asr = R2T2Manager(self.settings)


def create_app(settings: Optional[Settings] = None) -> FastAPI:
    settings = settings or Settings.from_env()
    ctx = Context(settings=settings)

    app = FastAPI(title="NetEase 本地语音服务", version=__version__, lifespan=None)
    app.state.ctx = ctx

    # 本地工具，来源放开；网关（同源转发）是唯一预期调用方
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.exception_handler(NeteaseError)
    async def _netease_error(_: Request, error: NeteaseError) -> JSONResponse:
        return JSONResponse(status_code=error.status, content=error.to_body())

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_: Request, error: RequestValidationError) -> JSONResponse:
        body = NeteaseError(
            "BAD_REQUEST",
            f"请求参数不合法：{error.errors()[:1]}",
            "按接口文档检查字段；上传类接口用 multipart/form-data。",
        ).to_body()
        return JSONResponse(status_code=400, content=body)

    @app.exception_handler(Exception)
    async def _unexpected(_: Request, error: Exception) -> JSONResponse:
        body = NeteaseError(
            "INTERNAL_ERROR",
            f"{type(error).__name__}: {error}",
            "查看 netease 服务控制台输出；若是依赖/权重问题，npm run netease:check 会逐项报告。",
            status=500,
            retryable=True,
        ).to_body()
        return JSONResponse(status_code=500, content=body)

    app.include_router(netease.router)
    app.include_router(confucius.router)
    app.include_router(r2t2.router)

    @app.on_event("shutdown")
    def _shutdown() -> None:
        # 服务退出时把子进程 worker 一并收掉，不留孤儿 vLLM
        ctx.asr.shutdown()

    return app

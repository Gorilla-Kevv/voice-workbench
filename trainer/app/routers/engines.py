"""引擎状态与显存释放。

暴露 `/v1/engines` 是为了让界面能回答一个具体问题：**现在这张卡被谁占着**。
8GB 显存上四套模型互斥，用户点了「开始转换」却被告知「显存不足」时，
如果界面能显示「当前：DDSP-SVC 歌声转换，已占用 2 分 13 秒」，
他就知道该等一等或者手动释放，而不是反复重试。
"""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI

from ..engine import EngineRegistry


def register(app: FastAPI, ctx) -> None:
    registry: EngineRegistry = ctx.engines

    @app.get("/v1/engines", tags=["engines"])
    def list_engines() -> Any:
        """当前引擎占用情况与四个引擎的显存门槛。"""
        return {"ok": True, **registry.status()}

    @app.post("/v1/engines/unload", tags=["engines"])
    def unload_engines() -> Any:
        """释放全部引擎占用的显存。

        这是给「明明没在跑任务，显存却被占着」准备的出口：
        上一次任务被取消、或者进程里的模型没退干净时，用户不该只能重启服务。
        """
        active = registry.active
        registry.unload_all()
        return {
            "ok": True,
            "released": active,
            "message": ("已释放 %s 占用的显存" % active) if active else "当前没有引擎占用显存",
        }

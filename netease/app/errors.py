"""错误契约：与全项目一致的 `{ok:false, error:{code,message,retryable,hint}}`。

`hint` 是给**使用者**的下一步动作 —— 本服务的失败几乎全是「环境/配置」问题
（没装权重、显存不够、另一个引擎占着显卡），只报 message 用户无从下手。
"""

from __future__ import annotations

from typing import Any, Optional


class NeteaseError(Exception):
    """业务错误。路由里 raise，由 FastAPI 异常处理器转成统一 JSON。"""

    def __init__(
        self,
        code: str,
        message: str,
        hint: str,
        *,
        status: int = 400,
        retryable: bool = False,
        details: Optional[dict[str, Any]] = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.hint = hint
        self.status = status
        self.retryable = retryable
        self.details = details

    def to_body(self) -> dict[str, Any]:
        error: dict[str, Any] = {
            "code": self.code,
            "message": self.message,
            "retryable": self.retryable,
            "hint": self.hint,
        }
        if self.details:
            error["details"] = self.details
        return {"ok": False, "error": error}


def error_body(code: str, message: str, hint: str, *, status: int = 400, retryable: bool = False) -> dict[str, Any]:
    """不走异常的轻量构造（探活失败等一次性场景）。"""
    return NeteaseError(code, message, hint, status=status, retryable=retryable).to_body()

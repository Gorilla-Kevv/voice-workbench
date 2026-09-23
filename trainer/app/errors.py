"""统一错误体系。

设计目标：任何一个失败都必须回答三个问题——
**哪里坏了、用户该做什么、能不能重试**。
本地工具最常见的失败不是「接口 500」，而是「环境没装好」，
所以这里的错误默认都带一段可执行的修复建议。
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional


class SovitsError(Exception):
    """带修复建议的业务异常。"""

    code = "SOVITS_ERROR"
    http_status = 400
    retryable = False

    def __init__(
        self,
        message: str,
        hint: Optional[str] = None,
        code: Optional[str] = None,
        retryable: Optional[bool] = None,
        status: Optional[int] = None,
        details: Optional[Dict[str, Any]] = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.hint = hint
        if code:
            self.code = code
        if retryable is not None:
            self.retryable = retryable
        if status is not None:
            self.http_status = status
        self.details = details or {}

    def to_dict(self) -> Dict[str, Any]:
        body: Dict[str, Any] = {
            "code": self.code,
            "message": self.message,
            "retryable": self.retryable,
        }
        if self.hint:
            body["hint"] = self.hint
        if self.details:
            body["details"] = self.details
        return body


class EnvironmentError_(SovitsError):
    """运行环境未就绪（找不到整合包、缺 torch、缺权重）。"""

    code = "ENV_NOT_READY"
    http_status = 503


class NotReadyError(SovitsError):
    """服务可用但管线尚未加载完成。"""

    code = "PIPELINE_NOT_READY"
    http_status = 503
    retryable = True


class BadRequestError(SovitsError):
    code = "BAD_REQUEST"
    http_status = 400


class NotFoundError(SovitsError):
    code = "NOT_FOUND"
    http_status = 404


class BusyError(SovitsError):
    """并发受限或被取消。"""

    code = "BUSY"
    http_status = 429
    retryable = True


class SynthesisError(SovitsError):
    code = "SYNTHESIS_FAILED"
    http_status = 502
    retryable = True


def blockers_to_messages(blockers: List[str]) -> str:
    """把阻断项拼成一句人话，供 HTTP 响应直接展示。"""
    return "；".join(blockers)

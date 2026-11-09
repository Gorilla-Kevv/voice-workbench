"""错误契约：与全项目一致的 `{ok:false, error:{code,message,retryable,hint}}`。"""

from __future__ import annotations

from typing import Any, Optional


class CosyvoiceError(Exception):
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

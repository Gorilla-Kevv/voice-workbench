"""GPT-SoVITS v5 统一错误契约：{ok:false, error:{code,message,retryable,hint}}"""
from __future__ import annotations


class Gsv5Error(Exception):
    def __init__(self, code: str, message: str, hint: str = "", status: int = 500) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.hint = hint
        self.status = status

    def to_body(self) -> dict:
        return {
            "ok": False,
            "error": {
                "code": self.code,
                "message": self.message,
                "retryable": self.status >= 500,
                "hint": self.hint,
            },
        }

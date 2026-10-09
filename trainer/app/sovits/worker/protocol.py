"""worker 行协议：消息信封 + stdout 隔离。

协议沿用 `docs/NETEASE-INTEGRATION.md` §2.1 的模板：stdin/stdout 上的
JSON-lines，一行一个消息。选它而不是 HTTP/gRPC 的理由见
`docs/ENGINE-ISOLATION.md` §4.1 —— 零依赖、跨平台、日志天然分离、
生命周期由父子关系托管。

**必须踩一次才会想到的坑**：官方代码会往 stdout 打印东西。
`TTS.py` 里有 `print(f"first_package_delay: ...")`、
`print("%.3f\\t%.3f\\t%.3f\\t%.3f" % ...)`。这些会混进 JSON-lines 流里，
让父进程的 `json.loads` 逐行崩掉。

对策（`isolate_stdout()`）：worker 启动时把**原始 fd 1 复制一份**留作协议通道，
然后把 fd 1 整个替换成 fd 2（stderr）的副本。这样：

* 协议只走那条私有 fd，父进程读它；
* 官方所有 `print(...)` 落到 stderr，被父进程当日志收走，还能顺便帮我们捞异常堆栈
  （官方 `TTS.run()` 内部 `except Exception: traceback.print_exc()` 然后 yield
  兜底空音频 —— 真实堆栈只能从 stderr 拿）。
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any, Dict, Optional, TextIO, Type

#: 协议版本。父进程与 worker 不一致时直接拒绝，避免半懂不懂地跑。
PROTOCOL_VERSION = 1

#: 消息类型
KIND_REQUEST = "request"
KIND_RESPONSE = "response"
KIND_EVENT = "event"
KIND_NOTICE = "notice"

__all__ = [
    "PROTOCOL_VERSION",
    "KIND_REQUEST",
    "KIND_RESPONSE",
    "KIND_EVENT",
    "KIND_NOTICE",
    "ProtocolError",
    "encode",
    "decode",
    "request",
    "response",
    "failure",
    "event",
    "notice",
    "isolate_stdout",
    "get_stdout",
    "dump_error",
    "restore_error",
]


class ProtocolError(Exception):
    """协议级错误（版本不符、字段缺失、JSON 坏行）。"""

    def __init__(self, message: str, line: Optional[str] = None) -> None:
        super().__init__(message)
        self.message = message
        self.line = line


# --------------------------------------------------------------------------
# 信封
# --------------------------------------------------------------------------


def encode(message: Dict[str, Any]) -> bytes:
    """把一个消息编码成一行（含换行）。

    `ensure_ascii=True` 不是偷懒：Windows 上 worker 与父进程的编码环境
    可能不一致，中文直接内联进字节流会因为 codepage 而炸。全转义最省心。

    `separators=(",", ":")` 是必须的 —— 默认分隔符带空格，
    而 `json.loads` 对空白是宽容的，所以这纯粹是省字节。
    """
    body = {"v": PROTOCOL_VERSION, **message}
    return (json.dumps(body, ensure_ascii=True, separators=(",", ":")) + "\n").encode("ascii")


def decode(line: str) -> Dict[str, Any]:
    """解码一行。空行返回空 dict（调用方跳过）。"""
    text = line.strip()
    if not text:
        return {}
    try:
        message = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ProtocolError("不是合法的 JSON 行：%s" % exc, line=text) from exc
    if not isinstance(message, dict):
        raise ProtocolError("消息必须是一个 JSON 对象", line=text)
    version = message.get("v")
    if version != PROTOCOL_VERSION:
        raise ProtocolError(
            "协议版本不匹配：worker 期望 %d，收到 %r" % (PROTOCOL_VERSION, version), line=text
        )
    return message


def request(msg_id: str, method: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    return {"kind": KIND_REQUEST, "id": msg_id, "method": method, "params": params or {}}


def response(msg_id: str, result: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    return {"kind": KIND_RESPONSE, "id": msg_id, "ok": True, "result": result or {}}


def failure(msg_id: str, error: Dict[str, Any]) -> Dict[str, Any]:
    return {"kind": KIND_RESPONSE, "id": msg_id, "ok": False, "error": error}


def event(msg_id: str, name: str, data: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    return {"kind": KIND_EVENT, "id": msg_id, "event": name, "data": data or {}}


def notice(name: str, data: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    return {"kind": KIND_NOTICE, "notice": name, "data": data or {}}


# --------------------------------------------------------------------------
# stdout 隔离
# --------------------------------------------------------------------------

#: 保留的协议通道（原始 fd 1 的 dup）。`get_stdout()` 用它。
_channel: Optional[TextIO] = None


def isolate_stdout() -> TextIO:
    """把 fd 1 换成 stderr，返回原 stdout 作为协议通道。

    破坏性操作，**只能在 worker 进程里调用一次**，且必须在
    import 任何官方模块之前 —— 官方模块的 import 期就可能 print。

    实现要点：`os.dup(1)` 拿到原 fd 的副本，用它包一个独立文件对象；
    之后 `os.dup2(2, 1)` 把进程的 fd 1 指向 stderr。
    这样 `sys.stdout` 与 `sys.stderr` 都写 fd 1/2 → 都到 stderr，
    而协议走那个已经分叉出去的副本。
    """
    global _channel
    if _channel is not None:
        return _channel

    saved_fd = os.dup(1)
    os.dup2(2, 1)  # 从此 fd1 == fd2，所有 print 都进 stderr

    # 把 Python 层的 stdout 也换掉：它可能是带缓冲的 TextIOWrapper，
    # 只改 fd 的话缓冲区里的旧内容仍会写进协议通道。
    raw = os.fdopen(saved_fd, "wb", buffering=0)
    _channel = raw  # type: ignore[assignment]

    # 让 sys.stdout 指向真正的 stderr，保留 line_buffering 以免日志卡住
    sys.stdout = sys.stderr
    return _channel


def get_stdout() -> TextIO:
    """协议通道。未调用 `isolate_stdout()` 时回落 `sys.stdout`。"""
    if _channel is None:
        return sys.stdout
    return _channel


# --------------------------------------------------------------------------
# 错误序列化
# --------------------------------------------------------------------------


def dump_error(exc: BaseException) -> Dict[str, Any]:
    """把异常序列化成可跨进程传输的字典。

    优先用 `SovitsError.to_dict()` 的形状（`code`/`message`/`hint`/`retryable`），
    这样父进程原样还原后，`api.py::_register_errors` 的行为完全不变。

    **额外带上 `status`**：`to_dict()` 里没有 HTTP 状态码，而同一族异常
    （`SovitsError` 及其子类）的状态码差异很大 —— `SynthesisError` 是 502、
    `BusyError` 是 429、`EnvironmentError_` 是 503。只靠 `code` 反查会丢失它，
    于是「显存不足」在父进程变成 400、前端不再重试。多传一个 int 最省事。
    """
    dump = getattr(exc, "to_dict", None)
    if callable(dump):
        try:
            body = dict(dump())
            body.setdefault("retryable", bool(getattr(exc, "retryable", False)))
            status = getattr(exc, "http_status", None)
            if isinstance(status, int):
                body["status"] = status
            return body
        except Exception:  # noqa: BLE001 - 序列化失败不该再炸一次
            pass
    return {
        "code": "WORKER_ERROR",
        "message": "%s: %s" % (type(exc).__name__, exc),
        "retryable": False,
    }


#: 错误码 → 异常类名。父进程据此还原异常类型。
#:
#: 覆盖两层：
#: 1. `errors.py` 里类自带的默认 code（`SovitsError` 体系的六个）
#: 2. `sovits/pipeline.py::_as_synthesis_error()` 产出的细分 code
#:    —— 它们全是 `SynthesisError(code=...)`，语义上都属于「合成失败、可重试」，
#:    不还原成 `SynthesisError` 的话 `http_status` 会从 502 掉到 400。
_CODES: Dict[str, str] = {
    "SOVITS_ERROR": "SovitsError",
    "ENV_NOT_READY": "EnvironmentError_",
    "PIPELINE_NOT_READY": "NotReadyError",
    "PIPELINE_LOAD_FAILED": "EnvironmentError_",
    "BAD_REQUEST": "BadRequestError",
    "BAD_VERSION": "BadRequestError",
    "NOT_FOUND": "NotFoundError",
    "BUSY": "BusyError",
    "TRAINING_ACTIVE": "BusyError",
    "SYNTHESIS_FAILED": "SynthesisError",
    # _as_synthesis_error 的六个细分码
    "EMPTY_AUDIO": "SynthesisError",
    "REF_AUDIO_DURATION": "SynthesisError",
    "REF_AUDIO_MISSING": "SynthesisError",
    "CUDA_OOM": "SynthesisError",
    "PROMPT_TEXT_REQUIRED": "SynthesisError",
    "REPETITION": "SynthesisError",
}


def restore_error(body: Dict[str, Any]) -> BaseException:
    """把字典还原成异常实例。延迟 import 以免 protocol 依赖 errors。"""
    from ...errors import (  # noqa: PLC0415
        BadRequestError,
        BusyError,
        EnvironmentError_,
        NotFoundError,
        NotReadyError,
        SovitsError,
        SynthesisError,
    )

    table = {
        "SovitsError": SovitsError,
        "EnvironmentError_": EnvironmentError_,
        "NotReadyError": NotReadyError,
        "BadRequestError": BadRequestError,
        "NotFoundError": NotFoundError,
        "BusyError": BusyError,
        "SynthesisError": SynthesisError,
    }
    code = str(body.get("code") or "SOVITS_ERROR")
    cls: Type[SovitsError] = table.get(_CODES.get(code, ""), SovitsError)
    return cls(
        str(body.get("message") or "worker 报告了一个错误"),
        # hint 只在**非空**时传：`SovitsError.__init__` 的 `if hint:` 会把 None 当
        # 「没给」处理，于是类默认值生效 —— 对 `SynthesisError` 来说默认是
        # `"SYNTHESIS_FAILED"`（不是子类里的 `"__main__"`），语义就错了。
        hint=body.get("hint") or None,
        code=code,
        # retryable / status 同理：None 表示「沿用类默认值」，不能强塞 False/400。
        retryable=body.get("retryable"),
        status=body.get("status"),
        details=body.get("details"),
    )

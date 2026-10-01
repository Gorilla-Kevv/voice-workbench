"""R2T2 worker 的进程管理器：spawn 子进程 + JSON 行协议 + 流式事件分发。

进程模型：
- worker 懒加载：spawn 很轻（裸 Python），真正加载模型发生在第一条 load/transcribe 命令；
- stdout 是**纯协议流**（worker 已保证），stderr 直接继承到服务控制台（vLLM 日志在那里看）；
- 每个请求带 id，reader 线程按 id 分发；流式转写的 delta 走队列交给 FastAPI 的生成器。
"""

from __future__ import annotations

import json
import shlex
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Iterator, Optional

from .config import Settings

#: 单次转写/流式的最长等待。vLLM 冷启动 + 长音频都可能很慢，但不允许无限挂死。
REQUEST_TIMEOUT_SEC = 1800


class WorkerError(Exception):
    def __init__(self, code: str, message: str, hint: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.hint = hint


class R2T2Manager:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._proc: Optional[subprocess.Popen] = None
        self._lock = threading.Lock()
        self._pending: dict[str, threading.Event] = {}
        self._results: dict[str, dict] = {}
        self._stream_queues: dict[str, list] = {}
        self._ready = threading.Event()
        self._logs: list[str] = []
        self._last_error: str = ""
        self._reader: Optional[threading.Thread] = None

    # ------------------------------------------------------------------ 状态

    @property
    def alive(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    def status(self) -> dict[str, Any]:
        return {
            "engine": "asr",
            "worker_spawned": self.alive,
            "pid": self._proc.pid if self.alive and self._proc else None,
            "model_loaded": self._ready.is_set(),
            "model": self._settings.resolved_r2t2_model,
            "interpreter": self._settings.resolved_r2t2_python,
            "last_error": self._last_error or None,
        }

    def probe_install(self) -> dict[str, Any]:
        model = self._settings.resolved_r2t2_model
        is_local = Path(model).exists()
        missing: list[str] = []
        if not is_local and "/" in model:
            # HF repo id：无法离线验证，由 worker 加载时给出真实错误
            missing.append("模型未在本地找到（将按 HF repo id 在线加载，需提前下载或配置 HF_ENDPOINT）")
        elif not is_local:
            missing.append(f"模型目录不存在：{model}")
        return {
            "engine": "asr",
            "model": model,
            "model_local": is_local,
            "installed": not missing,
            "missing": missing,
            "interpreter": self._settings.resolved_r2t2_python,
        }

    # ------------------------------------------------------------------ 生命周期

    def _spawn(self) -> None:
        if self.alive:
            return
        python = self._settings.resolved_r2t2_python
        # 解释器允许写成整条命令行（`wsl.exe python`）：Windows 上装不了 vLLM（只有 Linux wheel），
        # R2T2 要跑只能进 WSL / Linux，此时 worker 脚本也得用对端路径，见 NETEASE_R2T2_WORKER。
        command = shlex.split(python, posix=False) if Path(python).is_absolute() else shlex.split(python)
        args = [
            *command,
            self._settings.resolved_r2t2_worker,
            "--model", self._settings.resolved_r2t2_model,
            "--backend", self._settings.r2t2_backend,
            "--gpu-util", str(self._settings.r2t2_gpu_util),
            "--max-model-len", str(self._settings.r2t2_max_model_len),
            "--max-new-tokens", str(self._settings.r2t2_max_new_tokens),
        ]
        try:
            self._proc = subprocess.Popen(  # noqa: S603 - 参数全部来自受信配置
                args,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=None,  # vLLM 日志直接进服务控制台
                text=True,
                encoding="utf-8",
                env={
                    **__import__("os").environ,
                    "PYTHONIOENCODING": "utf-8",
                    "PYTHONUNBUFFERED": "1",
                },
            )
        except FileNotFoundError as error:
            raise WorkerError(
                "WORKER_INTERPRETER_MISSING",
                f"找不到 R2T2 worker 解释器：{python}",
                "设置 NETEASE_R2T2_PYTHON 指向包含 r2t2 依赖的 python，或把服务整体跑在 netease venv 里；"
                "Windows 装不了 vLLM（只有 Linux wheel），要走 WSL2 时填 `wsl.exe python` 并配 "
                "NETEASE_R2T2_WORKER 指向 Linux 侧的 r2t2_worker.py（见 netease/README.md）。",
            ) from error
        self._reader = threading.Thread(target=self._read_loop, daemon=True, name="r2t2-reader")
        self._reader.start()

    def _read_loop(self) -> None:
        proc = self._proc
        assert proc is not None and proc.stdout is not None
        for line in proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                self._logs.append(line)
                continue
            kind = message.get("type", "")
            if kind == "log":
                self._logs.append(str(message.get("line", "")))
                self._logs = self._logs[-50:]
            elif kind == "ready":
                self._ready.set()
            elif kind == "stream_delta":
                queue = self._stream_queues.get(str(message.get("id", "")))
                if queue is not None:
                    queue.append(message)
            elif kind in {"result", "error", "pong", "bye"}:
                request_id = str(message.get("id", ""))
                event = self._pending.pop(request_id, None)
                if event is not None:
                    self._results[request_id] = message
                    event.set()
        # stdout 关闭 = worker 退出
        self._ready.clear()
        if self._last_error == "":
            code = proc.poll()
            self._last_error = f"worker 进程已退出（exit={code}）"

    def _send(self, payload: dict) -> None:
        if not self.alive or self._proc is None or self._proc.stdin is None:
            raise WorkerError("WORKER_NOT_RUNNING", "R2T2 worker 未在运行", "先调用 warmup 或直接发起转写（会自动拉起 worker）。")
        try:
            self._proc.stdin.write(json.dumps(payload, ensure_ascii=False) + "\n")
            self._proc.stdin.flush()
        except (OSError, ValueError) as error:
            raise WorkerError("WORKER_BROKEN_PIPE", f"worker 管道已断开：{error}", "调用 unload 后重试；若反复出现，查看服务控制台的 vLLM 日志。") from error

    def _request(self, payload: dict, timeout: float = REQUEST_TIMEOUT_SEC) -> dict:
        request_id = payload.setdefault("id", uuid.uuid4().hex[:12])
        self._spawn()
        event = threading.Event()
        self._pending[request_id] = event
        try:
            self._send(payload)
            if not event.wait(timeout):
                raise WorkerError(
                    "WORKER_TIMEOUT",
                    f"worker 在 {timeout}s 内未返回结果",
                    "长音频请分段转写；若 worker 已卡死，unload 后重试。",
                    )
            result = self._results.pop(request_id, {})
            if result.get("type") == "error":
                raise WorkerError(str(result.get("code", "WORKER_ERROR")), str(result.get("message", "")), str(result.get("hint", "")))
            return result
        finally:
            self._pending.pop(request_id, None)
            self._results.pop(request_id, None)

    # ------------------------------------------------------------------ 对外动作

    def warmup(self) -> dict[str, Any]:
        started = time.monotonic()
        self._request({"type": "load"})
        return {**self.status(), "warmup_sec": round(time.monotonic() - started, 1)}

    def transcribe(self, path: str, language: str, return_timestamps: bool) -> dict[str, Any]:
        result = self._request(
            {"type": "transcribe", "path": path, "language": language, "return_timestamps": return_timestamps}
        )
        result.pop("type", None)
        result.pop("id", None)
        return result

    def stream(self, path: str, language: str, chunk_ms: int) -> Iterator[dict]:
        """流式转写：返回增量事件生成器，最后一条是 type=result 的定稿。"""
        request_id = uuid.uuid4().hex[:12]
        self._spawn()
        queue: list = []
        self._stream_queues[request_id] = queue
        event = threading.Event()
        self._pending[request_id] = event
        try:
            self._send({"type": "stream_transcribe", "id": request_id, "path": path, "language": language, "chunk_ms": chunk_ms})
            deadline = time.monotonic() + REQUEST_TIMEOUT_SEC
            while True:
                while queue:
                    yield queue.pop(0)
                if event.is_set():
                    break
                if time.monotonic() > deadline:
                    raise WorkerError("WORKER_TIMEOUT", f"流式转写超过 {REQUEST_TIMEOUT_SEC}s 未完成", "长音频请分段。")
                time.sleep(0.05)
            result = self._results.pop(request_id, {})
            if result.get("type") == "error":
                raise WorkerError(str(result.get("code", "WORKER_ERROR")), str(result.get("message", "")), str(result.get("hint", "")))
            yield {"type": "result", **{k: v for k, v in result.items() if k not in {"type", "id"}}}
        finally:
            self._stream_queues.pop(request_id, None)
            self._pending.pop(request_id, None)
            self._results.pop(request_id, None)

    def unload(self) -> dict[str, Any]:
        self._ready.clear()
        if self.alive and self._proc is not None:
            try:
                self._send({"type": "shutdown", "id": "shutdown"})
            except WorkerError:
                pass
            try:
                self._proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self._proc.kill()
        self._proc = None
        return self.status()

    def shutdown(self) -> None:
        try:
            self.unload()
        except Exception:
            if self._proc is not None:
                self._proc.kill()

    def recent_logs(self, count: int = 20) -> list[str]:
        return self._logs[-count:]


def worker_error_to_body(error: WorkerError) -> dict:
    return {
        "ok": False,
        "error": {"code": error.code, "message": error.message, "retryable": error.code != "WORKER_INTERPRETER_MISSING", "hint": error.hint},
    }

# -*- coding: utf-8 -*-
"""SenseVoice 常驻 worker 客户端（阶段 44补2）。

为什么 SenseVoice 必须走独立进程：

* 整合包自带的 FunASR 1.0.27 只注册了旧的 `SenseVoice`（Whisper 架构），
  没有当前 `iic/SenseVoiceSmall` 快照需要的 `SenseVoiceSmall` 类；
* 新模型要求 FunASR 1.1+，而升级整合包会波及 GPT-SoVITS 的 ASR 训练/官方脚本。

所以 SenseVoice 跑在 `trainer/sensevoice-venv`（py3.12 + torch 2.7.1+cu128 +
funasr 1.3.30）里，主服务只负责拉起一个常驻子进程并走 JSON-lines 协议。
`gen` 请求返回与 FunASR 相同的 `[{"text": ...}]` 形状，`pipeline._funasr_generate`
不需要知道背后是进程还是对象。
"""

from __future__ import annotations

import collections
import json
import os
import queue
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional


class SenseVoiceWorkerError(RuntimeError):
    """worker 启动/推理失败。消息里带 stderr 尾部，便于排障。"""


class SenseVoiceWorker:
    """管理一个常驻 SenseVoice 子进程。"""

    is_sensevoice_worker = True

    def __init__(
        self,
        python: Path,
        script: Path,
        model_dir: Path,
        device: str = "auto",
        load_timeout: float = 180.0,
    ) -> None:
        self._proc = subprocess.Popen(
            [
                str(python),
                "-u",
                str(script),
                "--model",
                str(model_dir),
                "--device",
                device or "auto",
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            env={**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"},
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        self._queue: "queue.Queue[str]" = queue.Queue()
        self._stderr_lines: "collections.deque[str]" = collections.deque(maxlen=40)
        self._lock = threading.Lock()
        self._seq = 0
        self.device = ""
        threading.Thread(target=self._read_stdout, daemon=True).start()
        threading.Thread(target=self._read_stderr, daemon=True).start()
        ready = self._wait_for(None, load_timeout)
        if ready.get("type") != "ready":
            self.shutdown()
            raise SenseVoiceWorkerError("SenseVoice worker 未返回 ready：%s" % (ready,))
        self.device = str(ready.get("device") or "")
        self.model_class = str(ready.get("model_class") or "")

    # ---------- 管道 ----------

    def _read_stdout(self) -> None:
        assert self._proc.stdout is not None
        try:
            for line in self._proc.stdout:
                self._queue.put(line)
        finally:
            self._queue.put("")

    def _read_stderr(self) -> None:
        assert self._proc.stderr is not None
        try:
            for line in self._proc.stderr:
                text = line.rstrip()
                if text:
                    self._stderr_lines.append(text)
        except Exception:  # noqa: BLE001 - 读日志失败不影响主协议
            pass

    def _stderr_tail(self) -> str:
        return " | ".join(list(self._stderr_lines)[-8:])

    def _send(self, payload: Dict[str, Any]) -> None:
        if self._proc.poll() is not None:
            raise SenseVoiceWorkerError("SenseVoice worker 已退出：%s" % self._stderr_tail())
        assert self._proc.stdin is not None
        self._proc.stdin.write(json.dumps(payload, ensure_ascii=False) + "\n")
        self._proc.stdin.flush()

    def _wait_for(self, expected_id: Optional[int], timeout: float) -> Dict[str, Any]:
        deadline = time.time() + float(timeout)
        while True:
            remaining = deadline - time.time()
            if remaining <= 0:
                raise SenseVoiceWorkerError("等待 SenseVoice worker 超时；stderr：%s" % self._stderr_tail())
            try:
                raw = self._queue.get(timeout=min(0.5, remaining))
            except queue.Empty:
                if self._proc.poll() is not None:
                    raise SenseVoiceWorkerError(
                        "SenseVoice worker 异常退出（code=%s）；stderr：%s"
                        % (self._proc.returncode, self._stderr_tail())
                    )
                continue
            if not raw:
                raise SenseVoiceWorkerError("SenseVoice worker 已关闭输出；stderr：%s" % self._stderr_tail())
            try:
                message = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if message.get("type") == "error" or message.get("ok") is False:
                raise SenseVoiceWorkerError(str(message.get("error") or message))
            if expected_id is None:
                if message.get("type") == "ready":
                    return message
                continue
            try:
                if int(message.get("id", -1)) == int(expected_id):
                    return message
            except (TypeError, ValueError):
                continue

    # ---------- 对外 ----------

    def generate(self, input: str, language: str = "auto") -> List[Dict[str, Any]]:
        """生成一条转写；返回形状与 FunASR `model.generate()` 对齐。"""
        with self._lock:
            self._seq += 1
            request_id = self._seq
            self._send(
                {
                    "id": request_id,
                    "cmd": "generate",
                    "input": str(input),
                    "language": language or "auto",
                }
            )
            message = self._wait_for(request_id, timeout=600.0)
            return [{"text": str(message.get("text") or "")}]

    def ping(self) -> bool:
        with self._lock:
            self._seq += 1
            request_id = self._seq
            self._send({"id": request_id, "cmd": "ping"})
            message = self._wait_for(request_id, timeout=10.0)
            return bool(message.get("ok"))

    def shutdown(self) -> None:
        proc = self._proc
        if proc.poll() is not None:
            return
        try:
            with self._lock:
                self._send({"cmd": "shutdown"})
        except Exception:  # noqa: BLE001
            pass
        try:
            proc.wait(timeout=5)
            return
        except subprocess.TimeoutExpired:
            pass
        try:
            proc.terminate()
            proc.wait(timeout=5)
        except Exception:  # noqa: BLE001
            try:
                proc.kill()
            except Exception:  # noqa: BLE001
                pass

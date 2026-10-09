"""主进程侧：拉起 worker、心跳、重启、请求-响应配对。

这一层的核心难点是**把「发一条请求等一条响应」和「一边收事件一边等终态」**
两种情况都做成阻塞式 Python 调用，而且不能让调用方看见线程。

做法：一根后台读线程把 worker 的每一行按 `id` 分发到对应的「信箱」，
`call()` 往信箱里等 `response`，`open_stream()` 拿到一个可以在主线程里
逐条消费 `event` 的迭代器。

超时是**两层**的：

* 协议层（这里的 `timeout`）—— 必须大于业务锁等待上限（`SYNC_LOCK_WAIT_S=300`），
  否则会在 worker 还健康排队时被父进程误判超时。
* 业务层 —— 仍在 `sovits/pipeline.py` 的 `_infer_lock` 上，语义不变。

崩溃恢复：读线程遇到 EOF 就把所有在等的信箱唤醒并抛 `WorkerGone`，
`WorkerClient` 标记 `dead`，下一次 `call()` 会按退避策略尝试重启。
"""

from __future__ import annotations

import base64
import os
import queue
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Tuple

from . import protocol as proto

#: 单条请求的默认超时。比 `SYNC_LOCK_WAIT_S`（300 s）留出富余 ——
#: IPC 超时必须晚于业务锁超时，否则「排队中」会被误报成「worker 死了」。
DEFAULT_TIMEOUT_S = 330.0

#: 首次加载 4 个模型的冷启动上限（官方 40~90 s，给到 3 倍余量）
WARMUP_TIMEOUT_S = 300.0

#: 流式首块上限。首块慢说明模型加载或预处理卡住了，要早报错。
STREAM_FIRST_CHUNK_TIMEOUT_S = 120.0

#: 流式后续每块的上限。只要还在出块就不断续期。
STREAM_CHUNK_TIMEOUT_S = 30.0

#: 心跳间隔与僵死判定
HEARTBEAT_INTERVAL_S = 10.0
HEARTBEAT_TIMEOUT_S = 30.0

#: 退避重启
_RESTART_BACKOFF_S = (1.0, 2.0, 4.0, 8.0, 16.0, 32.0, 60.0)
_MAX_CONSECUTIVE_FAILURES = 5

#: 退避期内调用方最多愿意等多久。超过这个长度说明 worker 是真的病重，
#: 继续挂着 HTTP 请求没有意义，直接报错让前端展示「稍后重试」。
_WAIT_BACKOFF_MAX_S = 10.0


class WorkerGone(Exception):
    """worker 进程没了（崩溃、被杀、stderr 读到 EOF）。"""


class WorkerTimeout(Exception):
    """等响应超时。"""


@dataclass
class _Mailbox:
    """一个 in-flight 请求的收件箱。"""

    events: "queue.Queue[Optional[Dict[str, Any]]]" = field(default_factory=queue.Queue)
    response: Optional[Dict[str, Any]] = None
    done: threading.Event = field(default_factory=threading.Event)
    error: Optional[BaseException] = None


class WorkerClient:
    """worker 子进程的常驻管理者。线程安全。"""

    def __init__(
        self,
        home: Optional[Path] = None,
        python: Optional[str] = None,
        log: Optional[Any] = None,
    ) -> None:
        self._home = home
        self._python = python or os.environ.get("GPT_SOVITS_WORKER_PYTHON") or sys.executable
        self._log_sink = log
        self._lock = threading.RLock()

        self._proc: Optional[subprocess.Popen] = None
        self._reader: Optional[threading.Thread] = None
        self._heartbeat: Optional[threading.Thread] = None

        self._boxes: Dict[str, _Mailbox] = {}
        self._boxes_lock = threading.Lock()
        self._counter = 0
        self._counter_lock = threading.Lock()

        self._dead = True
        self._ready = threading.Event()
        self._hello: Optional[Dict[str, Any]] = None
        self._error: Optional[str] = None
        self._stderr_tail: List[str] = []
        self._stderr_lock = threading.Lock()

        self._failures = 0
        self._restart_at = 0.0
        self._stopping = False

    # ------------------------------------------------------------------
    # 生命周期
    # ------------------------------------------------------------------

    @property
    def alive(self) -> bool:
        with self._lock:
            return not self._dead and self._proc is not None and self._proc.poll() is None

    @property
    def hello(self) -> Optional[Dict[str, Any]]:
        return self._hello

    @property
    def error(self) -> Optional[str]:
        return self._error

    def ensure_started(self) -> None:
        """按需拉起。退避期内**等一小会儿**再重试，而不是立刻拒绝。

        退避的目的只是防止「反复崩溃 → 反复拉起」放大成 OOM，不是「拒绝对外服务」。
        用户在一次崩溃后马上重试是**正常行为**（前端按钮、重试逻辑都会这么做），
        这时候让他等 1~2 秒然后成功，远好过立刻甩一个 503 出去。
        只有退避期长到不合理的程度（`_WAIT_BACKOFF_MAX_S`）才放弃并报错。
        """
        while True:
            with self._lock:
                if self.alive:
                    return
                if self._stopping:
                    raise WorkerGone("worker 正在关停")
                wait = self._restart_at - time.monotonic()
                if wait <= 0:
                    if self._failures >= _MAX_CONSECUTIVE_FAILURES:
                        raise WorkerGone(
                            "worker 连续 %d 次启动失败，已停止自动重启" % self._failures
                        )
                    self._start()
                    return
                if wait > _WAIT_BACKOFF_MAX_S:
                    raise WorkerGone(
                        "worker 正处于重启退避期，已连续失败 %d 次，请稍后重试"
                        % self._failures
                    )
            # 退避期很短，等一下就好。锁必须放掉再睡，否则会把别的调用方一起堵住。
            time.sleep(min(wait, 0.25))

    def _start(self) -> None:
        self._dead = False
        self._ready.clear()
        self._hello = None
        self._error = None
        with self._stderr_lock:
            self._stderr_tail = []

        # 启动方式：**按文件路径**，不用 `-m app.sovits.worker`。
        #
        # 整合包自带的解释器是 embedded distribution（`runtime/python39._pth`），
        # 它完全忽略 `PYTHONPATH`，也不给 `-m` 提供 `sys.path[0]` —— 用 `-m`
        # 会以「No module named 'app'」死在我们的代码之前。
        # 按文件路径启动时 Python 会把该文件所在目录加进 sys.path，
        # 于是 `from .server import main` 永远能解析；项目根由入口自己补。
        entry = Path(__file__).resolve().parent / "__main__.py"
        cmd = [self._python, "-u", str(entry)]
        if self._home:
            cmd += ["--home", str(self._home)]

        env = os.environ.copy()
        env["PYTHONIOENCODING"] = "utf-8"
        env["PYTHONUNBUFFERED"] = "1"
        if self._home:
            env["GPT_SOVITS_HOME"] = str(self._home)
        # 双保险：对普通解释器（系统 Python）有效；embedded 解释器忽略它，
        # 那条路径由入口文件的 `_bootstrap_path()` 兜住。
        trainer_dir = str(Path(__file__).resolve().parent.parent.parent.parent)
        existing = env.get("PYTHONPATH")
        env["PYTHONPATH"] = trainer_dir + (os.pathsep + existing if existing else "")
        cwd = trainer_dir

        self._log("拉起 worker：%s（cwd=%s）" % (" ".join(cmd), cwd))
        try:
            self._proc = subprocess.Popen(
                cmd,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                cwd=cwd,
                env=env,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,  # 行缓冲：协议要求逐行可读
            )
        except OSError as exc:
            self._dead = True
            self._failures += 1
            self._error = "无法启动 worker 进程：%s: %s" % (type(exc).__name__, exc)
            raise WorkerGone(self._error) from exc

        self._reader = threading.Thread(target=self._read_loop, name="sovits-worker-read", daemon=True)
        self._reader.start()
        threading.Thread(target=self._stderr_loop, name="sovits-worker-log", daemon=True).start()

        if not self._ready.wait(timeout=WARMUP_TIMEOUT_S):
            self._error = "worker 启动超时（%s 秒内未收到 ready）" % int(WARMUP_TIMEOUT_S)
            self.terminate()
            self._failures += 1
            raise WorkerGone(self._error)

        if self._hello is None:
            # ready 之前就死了
            self._error = self._error or "worker 在就绪前退出"
            self._failures += 1
            raise WorkerGone(self._error)

        self._failures = 0
        self._restart_at = 0.0
        self._start_heartbeat()

    def terminate(self, graceful: bool = True, timeout: float = 5.0) -> None:
        """关停。先礼后兵：发 shutdown 等回应，超时就 kill。"""
        with self._lock:
            proc = self._proc
            if proc is None:
                return
            self._stopping = True
            try:
                if graceful and proc.poll() is None and proc.stdin is not None:
                    try:
                        proc.stdin.write(
                            proto.encode(proto.request("r-bye", "shutdown")).decode("utf-8")
                        )
                        proc.stdin.flush()
                    except (BrokenPipeError, ValueError, OSError):
                        pass
                    try:
                        proc.wait(timeout=timeout)
                    except subprocess.TimeoutExpired:
                        pass
            finally:
                if proc.poll() is None:
                    self._log("worker 未在期限内退出，强制终止")
                    proc.kill()
                for stream in (proc.stdin, proc.stdout, proc.stderr):
                    try:
                        if stream is not None:
                            stream.close()
                    except Exception:  # noqa: BLE001
                        pass
                self._proc = None
                self._dead = True
                self._stopping = False
                self._fail_all(WorkerGone("worker 已关停"))

    def reset(self) -> None:
        """清掉失败计数，允许再次自动拉起（用户显式点「重启」时用）。"""
        with self._lock:
            self._failures = 0
            self._restart_at = 0.0

    # ------------------------------------------------------------------
    # 后台线程
    # ------------------------------------------------------------------

    def _read_loop(self) -> None:
        proc = self._proc
        if proc is None or proc.stdout is None:
            return
        try:
            for raw in proc.stdout:
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    message = proto.decode(raw)
                except proto.ProtocolError as exc:
                    self._log("worker 发来坏行（已丢弃）：%s" % exc.message)
                    continue
                self._route(message)
        except Exception as exc:  # noqa: BLE001
            self._log("读线程异常：%s: %s" % (type(exc).__name__, exc))
        finally:
            self._on_gone()

    def _stderr_loop(self) -> None:
        """把 worker 的日志与异常堆栈（官方 `print` + traceback）转发到本进程日志。"""
        proc = self._proc
        if proc is None or proc.stderr is None:
            return
        try:
            for raw in proc.stderr:
                text = raw.rstrip()
                if not text:
                    continue
                with self._stderr_lock:
                    self._stderr_tail.append(text)
                    if len(self._stderr_tail) > 200:
                        self._stderr_tail = self._stderr_tail[-200:]
                self._log(text, prefix="[worker] ")
        except Exception:  # noqa: BLE001
            pass

    def _on_gone(self) -> None:
        self._dead = True
        code = None
        proc = self._proc
        if proc is not None:
            code = proc.poll()
        detail = "worker 进程已退出（exit=%s）" % code
        with self._stderr_lock:
            tail = self._stderr_tail[-8:]
        if tail:
            detail += "\n最后几行输出：\n" + "\n".join(tail)
        self._error = detail
        self._failures += 1
        if self._failures <= len(_RESTART_BACKOFF_S):
            backoff = _RESTART_BACKOFF_S[min(self._failures - 1, len(_RESTART_BACKOFF_S) - 1)]
        else:
            backoff = _RESTART_BACKOFF_S[-1]
        self._restart_at = time.monotonic() + backoff
        self._log(detail)
        self._fail_all(WorkerGone(detail))

    def _fail_all(self, exc: BaseException) -> None:
        with self._boxes_lock:
            boxes = list(self._boxes.values())
            self._boxes.clear()
        for box in boxes:
            box.error = exc
            box.done.set()
            try:
                box.events.put_nowait(None)  # 叫醒正在迭代的消费者
            except queue.Full:
                pass

    def _route(self, message: Dict[str, Any]) -> None:
        kind = message.get("kind")
        if kind == proto.KIND_NOTICE:
            if message.get("notice") == "ready":
                self._hello = message.get("data") or {}
                self._ready.set()
            return

        msg_id = str(message.get("id") or "")
        if not msg_id:
            return
        with self._boxes_lock:
            box = self._boxes.get(msg_id)
        if box is None:
            return

        if kind == proto.KIND_EVENT:
            box.events.put(message)
        elif kind == proto.KIND_RESPONSE:
            box.response = message
            box.done.set()
            box.events.put(None)  # 通知流式消费者收尾

    def _start_heartbeat(self) -> None:
        if self._heartbeat is not None and self._heartbeat.is_alive():
            return
        self._heartbeat = threading.Thread(target=self._heartbeat_loop, name="sovits-worker-ping", daemon=True)
        self._heartbeat.start()

    def _heartbeat_loop(self) -> None:
        """心跳只服务一个目的：**发现僵死**（进程还在但不再响应）。

        必须走 `_send_only` 而不是 `call()` —— 心跳跑在后台线程里，
        不能占用 `_lock`，否则会和正在进行的 `synthesize`（可能持锁 300 s）打架。
        """
        while not self._stopping:
            time.sleep(HEARTBEAT_INTERVAL_S)
            if self._dead or self._proc is None or self._proc.poll() is not None:
                return
            try:
                self._send_only(proto.request("r-ping", "ping"))
            except Exception:  # noqa: BLE001
                continue

    # ------------------------------------------------------------------
    # 请求-响应
    # ------------------------------------------------------------------

    def _next_id(self) -> str:
        with self._counter_lock:
            self._counter += 1
            return "r-%d" % self._counter

    def _send_only(self, message: Dict[str, Any]) -> None:
        proc = self._proc
        if proc is None or proc.stdin is None or proc.poll() is not None:
            raise WorkerGone(self._error or "worker 不可用")
        try:
            proc.stdin.write(proto.encode(message).decode("utf-8"))
            proc.stdin.flush()
        except (BrokenPipeError, ValueError, OSError) as exc:
            raise WorkerGone("向 worker 写入失败：%s: %s" % (type(exc).__name__, exc)) from exc

    def call(
        self,
        method: str,
        params: Optional[Dict[str, Any]] = None,
        timeout: float = DEFAULT_TIMEOUT_S,
    ) -> Dict[str, Any]:
        """发一条请求，等响应。失败时抛还原后的业务异常。"""
        self.ensure_started()
        msg_id = self._next_id()
        box = _Mailbox()
        with self._boxes_lock:
            self._boxes[msg_id] = box
        try:
            self._send_only(proto.request(msg_id, method, params))
            if not box.done.wait(timeout=timeout):
                raise WorkerTimeout("%s 等待 worker 响应超时（%.0f 秒）" % (method, timeout))
            if box.error is not None:
                raise box.error
            response = box.response or {}
            if not response.get("ok", False):
                raise proto.restore_error(response.get("error") or {})
            return response.get("result") or {}
        finally:
            with self._boxes_lock:
                self._boxes.pop(msg_id, None)

    def interrupt(self, timeout: float = 5.0) -> bool:
        """打断当前推理。走独立的 `interrupt` 方法名，worker 侧由专用读线程处理。"""
        if not self.alive:
            return False
        try:
            result = self.call("interrupt", {}, timeout=timeout)
            return bool(result.get("stopped"))
        except Exception:  # noqa: BLE001 - 打断失败不该把调用方带崩
            return False

    # ------------------------------------------------------------------
    # 流式
    # ------------------------------------------------------------------

    def open_stream(
        self,
        method: str,
        params: Optional[Dict[str, Any]] = None,
        first_timeout: float = STREAM_FIRST_CHUNK_TIMEOUT_S,
        chunk_timeout: float = STREAM_CHUNK_TIMEOUT_S,
    ) -> "StreamHandle":
        """发一条流式请求，返回可在主线程消费的句柄。

        不能直接用 `call()` —— 流式没有「总超时」这个概念（长文本可以跑很久），
        必须按块续期。所以这里把信箱直接交给调用方。
        """
        self.ensure_started()
        msg_id = self._next_id()
        box = _Mailbox()
        with self._boxes_lock:
            self._boxes[msg_id] = box
        try:
            self._send_only(proto.request(msg_id, method, params))
        except BaseException:
            with self._boxes_lock:
                self._boxes.pop(msg_id, None)
            raise
        return StreamHandle(self, msg_id, box, first_timeout, chunk_timeout)

    def _close_stream(self, msg_id: str) -> None:
        with self._boxes_lock:
            self._boxes.pop(msg_id, None)

    # ------------------------------------------------------------------

    def _log(self, text: str, prefix: str = "[sovits-worker] ") -> None:
        if self._log_sink is not None:
            try:
                self._log_sink(prefix + text)
                return
            except Exception:  # noqa: BLE001
                pass
        try:
            sys.stderr.write(prefix + text + "\n")
            sys.stderr.flush()
        except Exception:  # noqa: BLE001
            pass


class StreamHandle:
    """流式请求的消费句柄。

    实现 `__iter__` 而不是返回一个裸生成器，是为了让「客户端提前断开」
    能被可靠地感知（`close()` / 上下文管理器）—— 那时必须给 worker 发
    `interrupt`，否则它会白白跑完一整段长文本。
    """

    def __init__(
        self,
        client: WorkerClient,
        msg_id: str,
        box: _Mailbox,
        first_timeout: float,
        chunk_timeout: float,
    ) -> None:
        self._client = client
        self._msg_id = msg_id
        self._box = box
        self._first_timeout = first_timeout
        self._chunk_timeout = chunk_timeout
        self._closed = False
        self._result: Optional[Dict[str, Any]] = None

    def __iter__(self) -> Iterator[Tuple[int, Any]]:
        import numpy as np  # noqa: PLC0415

        timeout = self._first_timeout
        try:
            while True:
                try:
                    item = self._box.events.get(timeout=timeout)
                except queue.Empty:
                    if self._box.error is not None:
                        raise self._box.error
                    raise WorkerTimeout(
                        "等流式音频块超时（%.0f 秒）" % timeout
                    )
                # 每次都按「块」续期，只要还在出块就不断续
                timeout = self._chunk_timeout

                if item is None:
                    # 终态：可能是 response，也可能是 error
                    if self._box.error is not None:
                        raise self._box.error
                    response = self._box.response
                    if response is not None and not response.get("ok", False):
                        raise proto.restore_error(response.get("error") or {})
                    self._result = (response or {}).get("result") or {}
                    return
                if item.get("kind") != proto.KIND_EVENT:
                    continue
                data = item.get("data") or {}
                raw = base64.b64decode(data.get("audio") or "")
                audio = np.frombuffer(raw, dtype=np.int16)
                yield int(data.get("sample_rate") or 0), audio
        finally:
            self.close()

    def __enter__(self) -> "StreamHandle":
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        self.close()

    def close(self) -> None:
        """收尾。若流未自然结束，通知 worker 中断推理。"""
        if self._closed:
            return
        self._closed = True
        # 提前退出（客户端断开、生成器被 close）时，worker 那边还在跑 —— 必须叫停
        finished = self._box.done.is_set()
        self._client._close_stream(self._msg_id)
        if not finished:
            self._client.interrupt()

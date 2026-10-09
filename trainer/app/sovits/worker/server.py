"""worker 侧：请求循环、interrupt 读线程、官方管线持有者。

这个进程是官方 GPT-SoVITS 的**唯一**宿主。它 import 官方模块、挨下猴子补丁、
把 cwd 永久改成整合包根目录 —— 所有那些「进程级、不可恢复」的副作用都发生在这里，
而这里的进程随时可以被父进程丢弃重建。

与 `sovits/pipeline.py` 的关系：本模块 `_Holder` 承担**完全相同的职责**
（`_ensure` / `_build` / `_reconfigure` / `_infer_lock` / `_reject_if_training`），
只是不再碰 IPC。之所以不直接复用 `Pipeline` 类，是因为 `Pipeline` 里那些
「纯本地」的能力（`resolve_defaults` 扫权重目录、`configure` 记用户意图）
不该跨进程 —— 留在主进程更快也没有副作用。

线程模型：

    main thread     逐条处理 stdin 上的 request（除 interrupt 外，顺序执行）
    interrupt thread 只认 `{"method":"interrupt"}`，收到立刻调官方 pipeline.stop()

第二根线程是必需的：取消必须能**插进**正在进行的 synthesize/stream 里，
而单通道 JSON-lines 排队是做不到这件事的。
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Tuple

from . import protocol as proto
from .protocol import ProtocolError


class Holder:
    """官方 `TTS` 管线的持有者。与 `sovits.pipeline.Pipeline` 同构。"""

    def __init__(self) -> None:
        self._pipeline: Any = None
        self._config: Any = None
        self._build_lock = threading.RLock()
        # 单卡串行：所有推理走同一把锁
        self._infer_lock = threading.Lock()

        self._target_device: Optional[str] = None
        self._target_half: Optional[bool] = None
        self._target_version: str = "v2ProPlus"
        self._target_gpt: Optional[Path] = None
        self._target_sovits: Optional[Path] = None

        self._applied_gpt: Optional[str] = None
        self._applied_sovits: Optional[str] = None

        self.loaded = False
        self.loading = False
        self.device = "cpu"
        self.is_half = False
        self.version = self._target_version
        self.gpt: Optional[str] = None
        self.sovits: Optional[str] = None
        self.load_seconds = 0.0
        self.loaded_at = 0.0
        self.synth_count = 0
        self.total_audio_seconds = 0.0
        self.last_error: Optional[str] = None
        self.last_error_at = 0.0

    # ------------------------------------------------------------------
    # 状态
    # ------------------------------------------------------------------

    def snapshot(self) -> Dict[str, Any]:
        return {
            "loaded": self.loaded,
            "loading": self.loading,
            "device": self.device,
            "is_half": self.is_half,
            "version": self.version,
            "gpt": self.gpt,
            "sovits": self.sovits,
            "load_seconds": round(self.load_seconds, 2),
            "loaded_at": self.loaded_at,
            "synth_count": self.synth_count,
            "total_audio_seconds": round(self.total_audio_seconds, 2),
            "last_error": self.last_error,
            "last_error_at": self.last_error_at,
        }

    # ------------------------------------------------------------------
    # 配置意图
    # ------------------------------------------------------------------

    def configure(self, params: Dict[str, Any]) -> Dict[str, Any]:
        from .. import catalog  # noqa: PLC0415
        from ...errors import EnvironmentError_  # noqa: PLC0415

        with self._build_lock:
            version = params.get("version")
            gpt = params.get("gpt")
            sovits = params.get("sovits")
            if version:
                resolved = catalog.resolve_version(version)
                if resolved is None:
                    raise EnvironmentError_(
                        "未知模型版本：%s" % version,
                        hint="可选值：%s" % "、".join(catalog.VERSIONS),
                        code="BAD_VERSION",
                        status=400,
                    )
                self._target_version = resolved
                self.version = resolved
                # 版本变了，之前选定的权重不再适用
                if gpt is None and sovits is None:
                    self._target_gpt = None
                    self._target_sovits = None
            if "device" in params and params["device"] is not None:
                self._target_device = params["device"] or None
            if "is_half" in params and params["is_half"] is not None:
                self._target_half = bool(params["is_half"])
            if gpt is not None:
                self._target_gpt = self._absolute(gpt)
            if sovits is not None:
                self._target_sovits = self._absolute(sovits)
        return self.snapshot()

    def _absolute(self, raw: str) -> Path:
        from .. import bootstrap  # noqa: PLC0415

        path = Path(str(raw)).expanduser()
        if path.is_absolute():
            return path
        return (bootstrap.require().home / path).resolve()

    # ------------------------------------------------------------------
    # 设备/精度兜底（官方 config.py 的经验值）
    # ------------------------------------------------------------------

    def _resolve_device(self) -> Tuple[str, bool]:
        from .. import bootstrap  # noqa: PLC0415

        device = self._target_device
        if not device:
            device = str(bootstrap.device_defaults()["device"])
        if self._target_half is None:
            is_half = bool(bootstrap.device_defaults()["is_half"])
        else:
            is_half = bool(self._target_half)
        return device, is_half

    # ------------------------------------------------------------------
    # 加载
    # ------------------------------------------------------------------

    def _pair(self, version: str) -> Tuple[Path, Path]:
        """权重对：显式指定的优先，否则扫官方目录取最新产物，再否则用预训练底模。"""
        from .. import bootstrap, catalog  # noqa: PLC0415
        from ...errors import EnvironmentError_  # noqa: PLC0415

        installation = bootstrap.require()

        def newest(directory: Path, pattern: str) -> Optional[Path]:
            if not directory.is_dir():
                return None
            hits = [path for path in directory.rglob(pattern) if path.is_file()]
            return max(hits, key=lambda path: path.stat().st_mtime) if hits else None

        gpt = self._target_gpt
        if gpt is None:
            gpt = newest(installation.path(catalog.GPT_WEIGHT_DIRS[version]), "*.ckpt") or installation.path(
                catalog.PRETRAINED_GPT[version]
            )
        sovits = self._target_sovits
        if sovits is None:
            sovits = newest(
                installation.path(catalog.SOVITS_WEIGHT_DIRS[version]), "*.pth"
            ) or installation.path(catalog.PRETRAINED_SOVITS_G[version])

        if not gpt.is_file() or not sovits.is_file():
            missing: List[str] = []
            if not gpt.is_file():
                missing.append("GPT 权重：%s" % gpt)
            if not sovits.is_file():
                missing.append("SoVITS 权重：%s" % sovits)
            raise EnvironmentError_(
                "版本 %s 缺少可用的预训练权重" % version,
                hint=(
                    "缺失项：\n- "
                    + "\n- ".join(missing)
                    + "\n请参考官方整合包指引补齐 GPT_SoVITS/pretrained_models/ 后重试。"
                ),
                code="WEIGHTS_MISSING",
            )
        return gpt, sovits

    def ensure(self) -> Any:
        """把配置意图落到实际管线上，返回官方 `TTS` 实例。"""
        from .. import bootstrap  # noqa: PLC0415

        with self._build_lock:
            # 这一个调用就是全部泄漏的源头：官方 activation.py 在这里被 import
            official = bootstrap.official()
            if self._pipeline is None:
                self._build(official)
            else:
                self._reconfigure(official)
            return self._pipeline

    def _build(self, official: Any) -> None:
        from .. import bootstrap, catalog  # noqa: PLC0415
        from ...errors import EnvironmentError_  # noqa: PLC0415

        version = self._target_version
        gpt, sovits = self._pair(version)
        device, is_half = self._resolve_device()
        installation = bootstrap.require()

        self.loading = True
        started = time.monotonic()
        try:
            config = official.TTS_Config(
                {
                    "custom": {
                        "device": device,
                        "is_half": bool(is_half),
                        "version": version,
                        "t2s_weights_path": str(gpt),
                        "vits_weights_path": str(sovits),
                        "bert_base_path": str(installation.path(catalog.BERT_DIR)),
                        "cnhuhbert_base_path": str(installation.path(catalog.HUBERT_DIR)),
                    }
                }
            )
            pipeline = official.TTS(config)
        except Exception as exc:  # noqa: BLE001
            self.loading = False
            self._record(f"{type(exc).__name__}: {exc}")
            raise EnvironmentError_(
                "加载 GPT-SoVITS 推理管线失败",
                hint=(
                    "常见原因：预训练权重缺失、显存不足、torch/CUDA 版本不匹配。\n"
                    "原始错误：%s: %s" % (type(exc).__name__, exc)
                ),
                code="PIPELINE_LOAD_FAILED",
            ) from exc

        self._config = config
        self._pipeline = pipeline
        self._applied_gpt = str(gpt)
        self._applied_sovits = str(sovits)
        self.loaded = True
        self.loading = False
        self.load_seconds = time.monotonic() - started
        self.loaded_at = time.time()
        self.version = version
        self.device = device
        self.is_half = bool(is_half)
        self.gpt = gpt.name
        self.sovits = sovits.name
        self.last_error = None

    def _reconfigure(self, official: Any) -> None:
        version = self._target_version
        gpt, sovits = self._pair(version)
        device, is_half = self._resolve_device()

        try:
            import torch  # noqa: PLC0415

            want_device = torch.device(device)
        except Exception:  # noqa: BLE001
            want_device = device

        if str(getattr(self._config, "device", "")) != str(want_device):
            self._pipeline.set_device(want_device)
            self.device = str(want_device)

        if bool(getattr(self._config, "is_half", False)) != bool(is_half):
            self._pipeline.enable_half_precision(bool(is_half))
            self.is_half = bool(is_half)

        if self._applied_gpt != str(gpt):
            self._pipeline.init_t2s_weights(str(gpt))
            self._applied_gpt = str(gpt)
            self.gpt = gpt.name

        if self._applied_sovits != str(sovits):
            self._pipeline.init_vits_weights(str(sovits))
            self._applied_sovits = str(sovits)
            self.sovits = sovits.name

        self.version = version

    def unload(self, wait_for_inference: bool = True) -> Dict[str, Any]:
        from ..pipeline import SYNC_LOCK_WAIT_S  # noqa: PLC0415
        from ...errors import BusyError  # noqa: PLC0415

        if wait_for_inference and not self._infer_lock.acquire(timeout=SYNC_LOCK_WAIT_S):
            raise BusyError(
                "有合成任务长时间未结束，无法释放显存",
                hint="请稍后重试，或先用 /v1/pipeline/stop 中断当前推理。",
            )
        try:
            with self._build_lock:
                self._pipeline = None
                self._config = None
                self._applied_gpt = None
                self._applied_sovits = None
                self.loaded = False
                self.device = "cpu"
                self.loaded_at = 0.0
            try:
                import gc  # noqa: PLC0415

                import torch  # noqa: PLC0415

                gc.collect()
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except Exception:  # noqa: BLE001
                pass
        finally:
            if wait_for_inference:
                self._infer_lock.release()
        return self.snapshot()

    def stop(self) -> bool:
        pipeline = self._pipeline
        if pipeline is None:
            return False
        try:
            pipeline.stop()
            return True
        except Exception:  # noqa: BLE001
            return False

    # ------------------------------------------------------------------
    # 推理
    # ------------------------------------------------------------------

    def synthesize(self, inputs: Dict[str, Any]) -> Tuple[int, Any, float]:
        from ..pipeline import SYNC_LOCK_WAIT_S  # noqa: PLC0415
        from ..synth import as_synthesis_error, last_chunk  # noqa: PLC0415
        from ...errors import BusyError  # noqa: PLC0415

        pipeline = self.ensure()
        if not self._infer_lock.acquire(timeout=SYNC_LOCK_WAIT_S):
            raise BusyError(
                "有另一个合成任务正在占用显卡",
                hint="单卡串行是 GPT-SoVITS 的物理约束。请等待当前任务结束，或降低批量合成的规模。",
            )
        try:
            started = time.monotonic()
            try:
                sample_rate, audio = last_chunk(pipeline.run(inputs))
            except Exception as exc:  # noqa: BLE001
                self._record("%s: %s" % (type(exc).__name__, exc))
                raise as_synthesis_error(exc) from exc

            self.synth_count += 1
            if sample_rate:
                self.total_audio_seconds += len(audio) / float(sample_rate)
            self.last_error = None
            return sample_rate, audio, time.monotonic() - started
        finally:
            self._infer_lock.release()

    def stream(self, inputs: Dict[str, Any]) -> Iterator[Tuple[int, Any]]:
        """流式分块。持锁粒度是**整个生成器生命周期**（单卡必需）。

        等待上限刻意很短：流式的价值是「马上听到」，前面已有一条流在跑时
        正确做法是立刻说「忙」，而不是让用户等 5 分钟才听到第一声。
        """
        from ..pipeline import STREAM_LOCK_WAIT_S  # noqa: PLC0415
        from ..synth import as_synthesis_error  # noqa: PLC0415
        from ...errors import BusyError  # noqa: PLC0415

        pipeline = self.ensure()
        if not self._infer_lock.acquire(timeout=STREAM_LOCK_WAIT_S):
            raise BusyError(
                "已有另一条流式合成正在进行",
                hint="流式合成会独占显卡。请等它结束，或改用非流式的普通合成接口。",
            )
        completed = False
        try:
            for sample_rate, chunk in pipeline.run(inputs):
                yield sample_rate, chunk
            completed = True
        except Exception as exc:  # noqa: BLE001
            self._record("%s: %s" % (type(exc).__name__, exc))
            raise as_synthesis_error(exc) from exc
        finally:
            if completed:
                self.synth_count += 1
            self._infer_lock.release()

    # ------------------------------------------------------------------
    # 文本切分预览
    # ------------------------------------------------------------------

    def split_text(self, text: str, text_lang: str, method: str) -> Dict[str, Any]:
        """复用官方的切分实现。

        主进程原先靠 `pipeline._pipeline.text_preprocessor` 私有穿透拿到它 ——
        那在跨进程后不可行，所以在这边开一个有名字的口子。
        """
        from ...errors import BadRequestError  # noqa: PLC0415

        pipeline = self.ensure()
        preprocessor = getattr(pipeline, "text_preprocessor", None)
        if preprocessor is None:
            raise BadRequestError(
                "当前版本不支持文本切分预览",
                hint="换用另一个模型版本后重试。",
                code="SPLIT_UNSUPPORTED",
            )
        try:
            pieces = preprocessor.pre_seg_text(text, text_lang, method)
        except Exception as exc:  # noqa: BLE001
            raise BadRequestError(
                "文本切分失败：%s: %s" % (type(exc).__name__, exc),
                hint="请检查文本内容与切分方式是否匹配。",
            ) from exc
        return {"pieces": list(pieces)}

    # ------------------------------------------------------------------

    def _record(self, text: str) -> None:
        self.last_error = text
        self.last_error_at = time.time()


# --------------------------------------------------------------------------
# 请求循环
# --------------------------------------------------------------------------


class Worker:
    """stdin 收请求、stdout 回响应的单进程循环。"""

    def __init__(self, out: Any) -> None:
        self._out = out
        self._holder = Holder()
        self._write_lock = threading.Lock()
        self._interrupt_event = threading.Event()
        self._stop = False

    # ------------------------------------------------------------------
    # 输出
    # ------------------------------------------------------------------

    def _send(self, message: Dict[str, Any]) -> None:
        with self._write_lock:
            try:
                self._out.write(proto.encode(message))
                self._out.flush()
            except (BrokenPipeError, ValueError, OSError):
                # 父进程没了。直接退出，不必再挣扎。
                self._stop = True

    def _log(self, text: str) -> None:
        """日志走 stderr（`isolate_stdout()` 之后 fd1 已经指向它）。"""
        try:
            sys.stderr.write("[sovits-worker] %s\n" % text)
            sys.stderr.flush()
        except Exception:  # noqa: BLE001
            pass

    # ------------------------------------------------------------------
    # interrupt 通道
    # ------------------------------------------------------------------

    def _interrupt_loop(self, lines: Any) -> None:
        """专门收 `interrupt` 的读线程。

        为什么必须单开一根：取消要能插进正在跑的 `synthesize`/`stream` 里，
        而主线程那时正被占着。这条线程只认 interrupt 一种方法，
        其余消息（理论上不会有）直接丢掉。
        """
        for raw in lines:
            try:
                message = proto.decode(raw)
            except ProtocolError:
                continue
            if not message:
                continue
            if message.get("kind") == proto.KIND_REQUEST and message.get("method") == "interrupt":
                msg_id = str(message.get("id") or "")
                # 回报 `Holder.stop()` 的**真实**返回值 —— 不能硬编码 True。
                # 官方 `TTS.stop()` 只在有管线时才存在；没有管线时 `Holder.stop()`
                # 返回 False，这正是主进程 `/v1/pipeline/stop` 要转达给用户的语义
                # （「当前没有在跑的推理」）。
                stopped = False
                try:
                    stopped = self._holder.stop()
                    self._log("收到 interrupt，官方 stop() 返回 %s" % stopped)
                except Exception as exc:  # noqa: BLE001
                    self._log("interrupt 处理失败：%s" % exc)
                if msg_id:
                    self._send(proto.response(msg_id, {"stopped": bool(stopped)}))

    # ------------------------------------------------------------------
    # 主循环
    # ------------------------------------------------------------------

    def run(self) -> int:
        self._send(proto.notice("ready", self._hello()))
        self._log("worker 就绪，等待请求")

        # 主循环直接迭代 sys.stdin（不另起线程）：
        # 协议是「父进程发一条、worker 回一条」的严格配对，读一行处理一行最直观。
        for raw in sys.stdin:
            try:
                message = proto.decode(raw)
            except ProtocolError as exc:
                self._log("协议错误：%s" % exc.message)
                continue
            if not message:
                continue
            if message.get("kind") != proto.KIND_REQUEST:
                continue
            method = str(message.get("method") or "")
            msg_id = str(message.get("id") or "")
            if method == "interrupt":
                # 主循环此时不可能收到（interrupt 由读线程独占），兜个底
                self._send(proto.response(msg_id, {"stopped": bool(self._holder.stop())}))
                continue
            if method == "shutdown":
                self._send(proto.response(msg_id, {"bye": True}))
                self._log("收到 shutdown，退出")
                return 0
            self._dispatch(msg_id, method, message.get("params") or {})
            if self._stop:
                return 0

        self._log("stdin 关闭，退出")
        return 0

    def _dispatch(self, msg_id: str, method: str, params: Dict[str, Any]) -> None:
        started = time.monotonic()
        try:
            handler = getattr(self, "_m_" + method, None)
            if handler is None:
                raise ProtocolError("未知方法：%s" % method)
            handler(msg_id, params)
        except ProtocolError as exc:
            self._send(proto.failure(msg_id, {"code": "BAD_METHOD", "message": exc.message, "retryable": False}))
        except BaseException as exc:  # noqa: BLE001 - 任何异常都必须回一条 response
            self._log("%s 失败：%s: %s" % (method, type(exc).__name__, exc))
            self._send(proto.failure(msg_id, proto.dump_error(exc)))
        finally:
            self._log("%s 用时 %.2fs" % (method, time.monotonic() - started))

    # ------------------------------------------------------------------
    # 方法实现
    # ------------------------------------------------------------------

    def _hello(self) -> Dict[str, Any]:
        from .. import bootstrap  # noqa: PLC0415

        info: Dict[str, Any] = {
            "pid": os.getpid(),
            "protocol": proto.PROTOCOL_VERSION,
            "python": sys.executable,
            "cwd": os.getcwd(),
            "torch": None,
            "cuda_available": False,
            "gpu": None,
            # 诊断用：确认补丁确实在这个进程里生效（也正是它待会儿要负责打的东西）
            "mha_patched": None,
        }
        installation = bootstrap.current()
        info["home"] = str(installation.home) if installation else None
        try:
            import torch  # noqa: PLC0415

            info["torch"] = getattr(torch, "__version__", None)
            info["cuda_available"] = bool(torch.cuda.is_available())
            if info["cuda_available"]:
                info["gpu"] = torch.cuda.get_device_name(0)
        except Exception:  # noqa: BLE001
            pass
        try:
            import torch.nn.functional as F  # noqa: PLC0415

            module = getattr(F.multi_head_attention_forward, "__module__", "")
            info["mha_patched"] = module not in {"torch.nn.functional"}
        except Exception:  # noqa: BLE001
            pass
        return info

    def _m_hello(self, msg_id: str, params: Dict[str, Any]) -> None:
        if params:
            self._holder.configure(params)
        self._send(proto.response(msg_id, {"ack": True, "state": self._holder.snapshot()}))

    def _m_ping(self, msg_id: str, params: Dict[str, Any]) -> None:
        self._send(
            proto.response(
                msg_id,
                {"alive": True, "busy": self._holder.loading, "loaded": self._holder.loaded},
            )
        )

    def _m_status(self, msg_id: str, params: Dict[str, Any]) -> None:
        self._send(proto.response(msg_id, {"state": self._holder.snapshot()}))

    def _m_configure(self, msg_id: str, params: Dict[str, Any]) -> None:
        state = self._holder.configure(params)
        self._send(proto.response(msg_id, {"state": state}))

    def _m_warmup(self, msg_id: str, params: Dict[str, Any]) -> None:
        self._holder.ensure()
        self._send(proto.response(msg_id, {"state": self._holder.snapshot()}))

    def _m_unload(self, msg_id: str, params: Dict[str, Any]) -> None:
        wait = params.get("wait_for_inference", True)
        state = self._holder.unload(wait_for_inference=bool(wait))
        self._send(proto.response(msg_id, {"state": state}))

    def _m_stop(self, msg_id: str, params: Dict[str, Any]) -> None:
        self._send(proto.response(msg_id, {"stopped": self._holder.stop()}))

    def _m_synthesize(self, msg_id: str, params: Dict[str, Any]) -> None:
        import base64  # noqa: PLC0415

        inputs = params.get("inputs") or {}
        sample_rate, audio, elapsed = self._holder.synthesize(inputs)
        raw = audio.tobytes() if hasattr(audio, "tobytes") else bytes(audio)
        self._send(
            proto.response(
                msg_id,
                {
                    "sample_rate": int(sample_rate),
                    "samples": int(len(raw)) // 2,
                    "audio": base64.b64encode(raw).decode("ascii"),
                    "elapsed_s": round(elapsed, 3),
                },
            )
        )

    def _m_stream(self, msg_id: str, params: Dict[str, Any]) -> None:
        import base64  # noqa: PLC0415

        inputs = params.get("inputs") or {}
        index = 0
        sample_rate = 0
        for rate, chunk in self._holder.stream(inputs):
            sample_rate = int(rate or sample_rate)
            raw = chunk.tobytes() if hasattr(chunk, "tobytes") else bytes(chunk)
            self._send(
                proto.event(
                    msg_id,
                    "chunk",
                    {
                        "index": index,
                        "sample_rate": sample_rate,
                        "samples": int(len(raw)) // 2,
                        "audio": base64.b64encode(raw).decode("ascii"),
                        "first": index == 0,
                    },
                )
            )
            index += 1
        self._send(proto.response(msg_id, {"chunks": index, "sample_rate": sample_rate}))

    def _m_split_text(self, msg_id: str, params: Dict[str, Any]) -> None:
        result = self._holder.split_text(
            str(params.get("text") or ""),
            str(params.get("text_lang") or "zh"),
            str(params.get("method") or "cut5"),
        )
        self._send(proto.response(msg_id, result))


# --------------------------------------------------------------------------


def main(argv: Optional[List[str]] = None) -> int:
    """worker 入口。

    顺序**极其重要**：`isolate_stdout()` 必须在 import 任何官方模块之前，
    因为官方 import 期就会 print。`bootstrap.install()` 也必须在这之前 ——
    正是它触发 `os.chdir` 与 `sys.path` 注入。
    """
    args = list(sys.argv[1:] if argv is None else argv)

    home = None
    for index, item in enumerate(args):
        if item == "--home" and index + 1 < len(args):
            home = args[index + 1]
        elif item.startswith("--home="):
            home = item.split("=", 1)[1]

    # 1) 先把协议通道抢出来，再让官方代码随便 print
    out = proto.isolate_stdout()

    # 2) 现在才轮到项目模块与官方模块
    _ensure_project_on_path()

    from .. import bootstrap  # noqa: PLC0415

    try:
        installation = bootstrap.locate(explicit=home)
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write("[sovits-worker] 定位整合包失败：%s: %s\n" % (type(exc).__name__, exc))
        installation = None

    if installation is not None:
        try:
            # chdir=True 只在这里传：官方 TTS.py 用 `now_dir = os.getcwd()` 拼
            # 声码器路径，所以本进程的 cwd 必须是整合包根目录。
            # 主进程不传 —— 那个 chdir 不恢复，会永久改变它的相对路径口径。
            bootstrap.install(installation, chdir=True)
        except Exception as exc:  # noqa: BLE001
            sys.stderr.write("[sovits-worker] 安装整合包失败：%s: %s\n" % (type(exc).__name__, exc))

    worker = Worker(out)
    try:
        return worker.run()
    except KeyboardInterrupt:
        return 0
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write("[sovits-worker] 崩溃：%s: %s\n" % (type(exc).__name__, exc))
        import traceback  # noqa: PLC0415

        traceback.print_exc()
        return 1


def _ensure_project_on_path() -> None:
    """让 `import app.sovits...` 可用。

    worker 用 `-m app.sovits.worker` 启动时 `trainer/` 已在 sys.path 上；
    但直接 `python worker/__main__.py` 则不在。这里兜一下。
    """
    trainer_dir = Path(__file__).resolve().parent.parent.parent.parent
    if str(trainer_dir) not in sys.path:
        sys.path.insert(0, str(trainer_dir))

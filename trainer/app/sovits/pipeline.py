"""推理管线的**进程内代理**。

为什么要改成代理：官方 GPT-SoVITS 在 import 期做了两件**进程级、不可恢复**的事 ——

1. `GPT_SoVITS/AR/modules/activation.py` 执行
   `F.multi_head_attention_forward = multi_head_attention_forward_patched`，
   全局替换整个进程的 torch MHA。而补丁函数的 `__globals__` 里缺 `_in_projection`，
   RVC 的 fairseq `MultiheadAttention`（走 `use_separate_proj_weight=True`）一调就
   `NameError`。
2. `sovits/bootstrap.py::install()` 执行 `os.chdir(home)` 且**不恢复**。

唯一的根治办法是让它们只发生在一个可以随时丢弃的进程里。所以官方管线搬到了
`worker/server.py`，本模块变成它在主进程里的代理。

**设计约束：公开签名一个都不改。**
`api.py` / `routers/*` / `inference.py` / `batch.py` 的调用点全部零改动 ——
它们看到的还是同名同参同返回值的 `Pipeline`。

哪些方法走 IPC、哪些留本地，依据是「是否碰官方模块」：

| 留本地（纯文件系统 / 纯内存） | 走 IPC（碰官方管线） |
| --- | --- |
| `status` `configure` `resolve_defaults` | `warmup` `unload` `stop` |
| `current_pair` `set_training_active` | `synthesize` `stream` `split_text` |
| `version` `device` `is_half` | (`device`/`is_half` 的**兜底值**在 worker 侧算) |

`resolve_defaults` 特别值得一提：它只扫 `GPT_weights*/SoVITS_weights*/pretrained_models`
取最新产物，没有任何官方 import。留在主进程更快，也避免把「扫目录」这种
无副作用的活也塞进迟早要被丢弃的进程里。

完整设计论证见 `docs/ENGINE-ISOLATION.md`。
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Tuple

from ..errors import BusyError, EnvironmentError_, SynthesisError
from . import bootstrap, catalog
from .worker import client as worker_client

#: 等待「推理闸门」的上限。超过就给用户一个明确的「忙」提示，
#: 而不是让他对着一个永远转圈的进度条 —— 单卡串行是物理约束，
#: 但「排队中」和「卡死了」必须能被区分开。
SYNC_LOCK_WAIT_S = 300.0
STREAM_LOCK_WAIT_S = 5.0

# --------------------------------------------------------------------------


@dataclass
class WeightPair:
    """一次合成实际使用的权重组合。"""

    gpt: Path
    sovits: Path
    version: str
    gpt_source: str  # "trained" | "pretrained"
    sovits_source: str

    def to_dict(self) -> Dict[str, str]:
        return {
            "gpt": str(self.gpt),
            "sovits": str(self.sovits),
            "gpt_name": self.gpt.stem,
            "sovits_name": self.sovits.stem,
            "version": self.version,
            "gpt_source": self.gpt_source,
            "sovits_source": self.sovits_source,
        }


@dataclass
class PipelineState:
    """可序列化的管线状态，`/health` 与 `/v1/pipeline` 直接返回它。

    这是**主进程的镜像**：真值在 worker 侧，每次 RPC 回来后由 `_absorb()` 刷新。
    worker 没起来（或已崩溃）时，字段保持最后一帧 + `worker_alive=False`。
    """

    loaded: bool = False
    loading: bool = False
    device: str = "cpu"
    is_half: bool = False
    version: str = catalog.DEFAULT_VERSION
    gpt: Optional[str] = None
    sovits: Optional[str] = None
    load_seconds: float = 0.0
    loaded_at: float = 0.0
    synth_count: int = 0
    total_audio_seconds: float = 0.0
    last_error: Optional[str] = None
    last_error_at: float = 0.0
    warmup_error: Optional[str] = None

    #: worker 进程是否存活。新增字段（只追加，不动已有契约）
    worker_alive: bool = False
    #: worker 崩溃 / 启动失败时的可读原因
    worker_error: Optional[str] = None
    #: 最近一次心跳看到的 worker PID，排查「是不是被重启了」用
    worker_pid: Optional[int] = None

    def to_dict(self) -> Dict[str, Any]:
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
            "warmup_error": self.warmup_error,
            "worker_alive": self.worker_alive,
            "worker_error": self.worker_error,
            "worker_pid": self.worker_pid,
        }

    def mark_worker_lost(self, reason: Optional[str] = None) -> None:
        """worker 进程没了 —— 把它手里的东西从镜像里一并抹掉。

        **这是本文件最重要的一条不变式**：`loaded=True` 的唯一合法前提是
        「有一个活着的 worker 持有模型」。worker 一死，模型必然随之消失；
        镜像若还留着 `loaded=True`，`/health` 就会谎报「已就绪」，前端据此
        显示绿色状态，用户一点合成却立刻 503 —— 这就是设计文档 §4.8 里
        点名的「服务撒谎」失效模式。

        必须写成方法而不是散在各处手改字段：`status()`、`_raise_worker_gone()`、
        `unload()` 三处都要维持这条不变式，漏一处就退化成 bug。
        """
        self.loaded = False
        self.loading = False
        self.device = "cpu"
        self.loaded_at = 0.0
        self.gpt = None
        self.sovits = None
        self.worker_alive = False
        self.worker_pid = None
        if reason is not None:
            self.worker_error = reason


# --------------------------------------------------------------------------


class Pipeline:
    """官方推理管线的跨进程代理。对外契约与重构前的单进程版本完全一致。"""

    def __init__(self, data_dir: Path, home: Optional[Path] = None) -> None:
        self._data_dir = data_dir
        self._build_lock = threading.RLock()
        #: 本地串行闸门。
        #:
        #: worker 内部也有一把 `_infer_lock`，但那把是「同一张卡只能一条推理」的
        #: 物理约束；这一把的职责不同 —— 它保证**主进程不会同时发两条请求**，
        #: 免得两条请求在 worker 里排队、第二条白等 300 秒才拿到「忙」。
        self._infer_lock = threading.Lock()
        self.state = PipelineState()
        # 用户意图（可能与已加载状态不一致，由 worker 的 _ensure 收敛）
        self._target_device: Optional[str] = None
        self._target_half: Optional[bool] = None
        self._target_version: str = catalog.DEFAULT_VERSION
        self._target_gpt: Optional[Path] = None
        self._target_sovits: Optional[Path] = None
        #: 训练是否正在独占显卡（纯内存标志，不需要跨进程）
        self._training_active = False

        self._client = worker_client.WorkerClient(
            home=home or _resolve_home(),
            log=_default_log,
        )

    # ------------------------------------------------------------------
    # 训练与推理的显存互斥
    # ------------------------------------------------------------------

    @property
    def training_active(self) -> bool:
        return self._training_active

    def set_training_active(self, active: bool) -> None:
        """标记「训练正在进行」。

        训练脚本会自己加载一整套模型，与本服务常驻的推理管线在同一张卡上
        必然抢显存 —— 8GB 级别的消费级显卡几乎一定会 OOM。
        因此训练开始前释放推理管线，训练期间拒绝新的合成请求（并给出明确的等待提示），
        训练结束后由下一次合成按需重新加载。

        纯主进程标志：worker 那份模型已经被 `unload()` 掉了，
        worker 不需要知道「为什么」。
        """
        self._training_active = bool(active)

    def _reject_if_training(self) -> None:
        if not self._training_active:
            return
        raise BusyError(
            "训练正在占用显卡，暂时无法合成",
            hint=(
                "推理与训练共用一张显卡，同时运行会互相抢显存。\n"
                "请等训练结束后重试，或在「模型训练」页面取消当前任务。"
            ),
            code="TRAINING_ACTIVE",
        )

    # ------------------------------------------------------------------
    # 配置
    # ------------------------------------------------------------------

    @property
    def version(self) -> str:
        return self._target_version

    @property
    def device(self) -> str:
        """目标设备。

        兜底值（用户未显式设置时）**不回查 worker** —— 那会让一个属性访问
        变成一次 RPC，而它在 `/health` 里被高频读取。worker 起来后会通过
        `status()` 把真实设备同步进 `state.device`，那里才是权威值。
        """
        if self._target_device:
            return self._target_device
        return self.state.device or "cpu"

    @property
    def is_half(self) -> bool:
        if self._target_half is not None:
            return self._target_half
        return bool(self.state.is_half)

    def configure(
        self,
        version: Optional[str] = None,
        device: Optional[str] = None,
        is_half: Optional[bool] = None,
        gpt: Optional[str] = None,
        sovits: Optional[str] = None,
    ) -> Dict[str, Any]:
        """登记用户意图。真正的加载发生在下一次合成（或显式 warmup）。

        意图先记在本地，同时**顺手同步给 worker**（如果它还活着）。
        这样做的原因是 `configure` 是同步 HTTP 端点，用户点完「加载权重」
        期望立刻看到状态变化；等下一次合成才同步会让 `/v1/pipeline` 显示滞后。
        worker 不在时静默跳过 —— 意图已经记下了，`warmup` 会补上。
        """
        with self._build_lock:
            if version:
                # 大小写不敏感地归一化一次：前端 model id 是小写，版本名是混合大小写
                resolved = catalog.resolve_version(version)
                if resolved is None:
                    raise EnvironmentError_(
                        "未知模型版本：%s" % version,
                        hint="可选值：%s" % "、".join(catalog.VERSIONS),
                        code="BAD_VERSION",
                        status=400,
                    )
                self._target_version = resolved
                # 版本变了，之前选定的权重不再适用
                if gpt is None and sovits is None:
                    self._target_gpt = None
                    self._target_sovits = None
            if device is not None:
                self._target_device = device or None
            if is_half is not None:
                self._target_half = bool(is_half)
            if gpt is not None:
                self._target_gpt = self._absolute(gpt)
            if sovits is not None:
                self._target_sovits = self._absolute(sovits)

        status = self.status()
        self._push_intent()
        return status

    def _push_intent(self) -> None:
        """把当前意图推给 worker。失败只记日志 —— 它不是关键路径。"""
        if not self._client.alive:
            return
        try:
            result = self._client.call(
                "configure", self._intent_payload(), timeout=10.0
            )
            self._absorb(result.get("state"))
        except Exception as exc:  # noqa: BLE001
            _default_log("同步配置意图失败（下次 warmup 会重试）：%s: %s" % (type(exc).__name__, exc))

    def _intent_payload(self) -> Dict[str, Any]:
        return {
            "version": self._target_version,
            "device": self._target_device,
            "is_half": self._target_half,
            "gpt": str(self._target_gpt) if self._target_gpt else None,
            "sovits": str(self._target_sovits) if self._target_sovits else None,
        }

    def _absolute(self, raw: str) -> Path:
        path = Path(raw).expanduser()
        if path.is_absolute():
            return path
        installation = bootstrap.require()
        # 允许前端传「相对仓库根目录」的路径，与官方 API 的写法保持一致
        return (installation.home / path).resolve()

    # ------------------------------------------------------------------
    # 权重解析（纯文件系统，留主进程）
    # ------------------------------------------------------------------

    def resolve_defaults(self, version: Optional[str] = None) -> WeightPair:
        """为指定版本挑一对默认权重：优先最近训练的产物，否则用官方预训练权重。

        不碰官方模块，所以留在主进程。好处是：worker 崩了、或者还没起来时，
        `/v1/weights` 依然能正常回答「默认会选哪个」。
        """
        version = version or self._target_version
        installation = bootstrap.require()

        gpt_dir = installation.path(catalog.GPT_WEIGHT_DIRS[version])
        sovits_dir = installation.path(catalog.SOVITS_WEIGHT_DIRS[version])

        trained_gpt = _newest(gpt_dir, "*.ckpt")
        trained_sovits = _newest(sovits_dir, "*.pth")
        pretrained_gpt = installation.path(catalog.PRETRAINED_GPT[version])
        pretrained_sovits = installation.path(catalog.PRETRAINED_SOVITS_G[version])

        gpt = trained_gpt or pretrained_gpt
        sovits = trained_sovits or pretrained_sovits
        gpt_source = "trained" if trained_gpt else "pretrained"
        sovits_source = "trained" if trained_sovits else "pretrained"

        if not gpt.is_file() or not sovits.is_file():
            missing: List[str] = []
            if not gpt.is_file():
                missing.append(
                    "GPT 权重：%s（也可把训练产物放入 %s）"
                    % (catalog.PRETRAINED_GPT[version], catalog.GPT_WEIGHT_DIRS[version])
                )
            if not sovits.is_file():
                missing.append(
                    "SoVITS 权重：%s（也可把训练产物放入 %s）"
                    % (catalog.PRETRAINED_SOVITS_G[version], catalog.SOVITS_WEIGHT_DIRS[version])
                )
            raise EnvironmentError_(
                "版本 %s 缺少可用的预训练权重" % version,
                hint="缺失项：\n- " + "\n- ".join(missing)
                + "\n请参考官方整合包指引补齐 GPT_SoVITS/pretrained_models/ 后重试。",
                code="WEIGHTS_MISSING",
            )

        return WeightPair(
            gpt=gpt,
            sovits=sovits,
            version=version,
            gpt_source=gpt_source,
            sovits_source=sovits_source,
        )

    def current_pair(self, version: Optional[str] = None) -> WeightPair:
        """解析当前实际会用的权重组合。"""
        version = version or self._target_version
        pair = self.resolve_defaults(version)
        # 显式指定的权重覆盖默认选择
        if self._target_gpt is not None:
            pair.gpt = self._target_gpt
            pair.gpt_source = "explicit"
        if self._target_sovits is not None:
            pair.sovits = self._target_sovits
            pair.sovits_source = "explicit"
        return pair

    # ------------------------------------------------------------------
    # 生命周期
    # ------------------------------------------------------------------

    def status(self) -> Dict[str, Any]:
        # 顺序要紧：**先**刷新 worker 存活状态，**再**取 `to_dict()`。
        # 反过来的话（早期版本的写法）拿到的是一帧已经过期的快照 ——
        # worker 刚猝死时 `loaded` 还是 True，`/health` 照样谎报「已就绪」。
        #
        # 刷新走的是进程表（`poll()`），不是 RPC，代价可忽略，所以每次
        # `/health` 轮询都刷新是安全的。见 docs/ENGINE-ISOLATION.md §4.8。
        if self._client.alive:
            self.state.worker_alive = True
            # PID 会随崩溃重启而变，每次读一下最省事（hello 是内存里的快照）
            self.state.worker_pid = (self._client.hello or {}).get("pid")
        else:
            # worker 不在 = 它手里的模型也没了。这里**必须**把镜像打回未加载，
            # 否则 `/health` 与 `/v1/pipeline` 会一直谎报 `loaded=True`。
            # 注意不能只依赖 `_raise_worker_gone()`：那条路径只有在**主动发请求**
            # 时才走到；worker 是自己猝死（OOM 被 kill、官方代码崩）时，主进程
            # 只从读线程那里看到 EOF，没人会去纠正镜像。
            self.state.mark_worker_lost(self._client.error)

        payload = self.state.to_dict()
        payload["target_version"] = self._target_version
        payload["target_device"] = self.device
        payload["target_is_half"] = self.is_half
        payload["streaming_supported"] = catalog.supports_streaming(self._target_version)
        payload["languages"] = catalog.languages_for(self._target_version)
        # 训练独占显卡期间合成会被拒绝，前端据此提前提示而不是等报错
        payload["training_active"] = self._training_active
        return payload

    def refresh(self, timeout: float = 5.0) -> Dict[str, Any]:
        """主动拉一次 worker 真实状态并合并进镜像。"""
        if not self._client.alive:
            self.state.worker_alive = False
            self.state.worker_error = self._client.error
            return self.status()
        try:
            result = self._client.call("status", {}, timeout=timeout)
            self._absorb(result.get("state"))
        except Exception as exc:  # noqa: BLE001
            self.state.worker_error = "%s: %s" % (type(exc).__name__, exc)
        return self.status()

    def warmup(self, blocking: bool = False) -> None:
        """预热。非阻塞时在后台线程里加载，失败记录到状态而不是抛出。"""
        if blocking:
            self._warmup_blocking()
            return

        def _run() -> None:
            try:
                self._warmup_blocking()
            except Exception as exc:  # noqa: BLE001 - 预热失败不该影响服务可用性
                self.state.warmup_error = "%s: %s" % (type(exc).__name__, exc)

        threading.Thread(target=_run, name="sovits-warmup", daemon=True).start()

    def _warmup_blocking(self) -> None:
        self.state.loading = True
        try:
            result = self._client.call(
                "warmup",
                {"blocking": True},
                timeout=worker_client.WARMUP_TIMEOUT_S,
            )
        except worker_client.WorkerGone as exc:
            self.state.loading = False
            self.state.worker_alive = False
            self.state.worker_error = str(exc)
            raise EnvironmentError_(
                "推理 worker 进程不可用",
                hint=(
                    "worker 负责加载官方 GPT-SoVITS 管线（它是官方代码 import 期副作用的隔离容器）。\n"
                    "详情：%s" % exc
                ),
                code="WORKER_UNAVAILABLE",
                status=503,
            ) from exc
        except worker_client.WorkerTimeout as exc:
            self.state.loading = False
            raise EnvironmentError_(
                "推理 worker 响应超时",
                hint="模型加载可能仍在进行，稍后重试；若反复超时请查看服务端日志。\n详情：%s" % exc,
                code="WORKER_TIMEOUT",
                status=503,
            ) from exc
        self._absorb(result.get("state"))
        self.state.loading = False
        self.state.warmup_error = None

    def unload(self, wait_for_inference: bool = True) -> None:
        """释放管线。切换设备、排查显存问题，以及**训练开始前让出显卡**时使用。

        默认会先等正在进行的推理结束再释放 —— 否则刚释放完、旧推理还在跑，
        训练脚本会立刻撞上「显存被占」的假象，排查起来非常费劲。
        """
        if not self._client.alive:
            # worker 不在，显存本来就没被它占着
            self.state.mark_worker_lost(self._client.error)
            return
        try:
            result = self._client.call(
                "unload",
                {"wait_for_inference": bool(wait_for_inference)},
                # IPC 超时必须晚于 worker 内部的锁等待上限（300 s），
                # 否则会在 worker 还健康排队时被误判成超时。
                timeout=SYNC_LOCK_WAIT_S + 30.0,
            )
            self._absorb(result.get("state"))
        except worker_client.WorkerGone as exc:
            self.state.mark_worker_lost(str(exc))

    def stop(self) -> bool:
        """请求中断当前推理（官方 `stop_flag`）。

        走 worker 的 `interrupt` 方法 —— 它由 worker 侧的专用读线程处理，
        所以能**插进**正在跑的 `synthesize` / `stream` 里，不必排队。
        """
        if not self._client.alive:
            return False
        return self._client.interrupt()

    def shutdown(self) -> None:
        """服务关停时调用：优雅结束 worker 进程。"""
        try:
            self._client.terminate(graceful=True, timeout=5.0)
        except Exception:  # noqa: BLE001
            pass

    # ------------------------------------------------------------------
    # 推理
    # ------------------------------------------------------------------

    def synthesize(self, inputs: Dict[str, Any]) -> Tuple[int, Any]:
        """一次性拿到完整音频。返回 (采样率, int16 numpy 数组)。"""
        # 先拒绝，再谈加载模型 —— 否则「拒绝」本身就把显存吃掉了
        self._reject_if_training()
        if not self._infer_lock.acquire(timeout=SYNC_LOCK_WAIT_S):
            raise BusyError(
                "有另一个合成任务正在占用显卡",
                hint="单卡串行是 GPT-SoVITS 的物理约束。请等待当前任务结束，"
                "或降低批量合成的规模。",
            )
        try:
            started = time.monotonic()
            result = self._call_inference("synthesize", {"inputs": inputs})
            sample_rate, audio = _decode_audio(result)
            self.state.synth_count += 1
            if sample_rate:
                self.state.total_audio_seconds += len(audio) / float(sample_rate)
            self.state.last_error = None
            self._last_elapsed = time.monotonic() - started
            return sample_rate, audio
        finally:
            self._infer_lock.release()

    def stream(self, inputs: Dict[str, Any]) -> Iterator[Tuple[int, Any]]:
        """流式分块产出。调用方负责逐块写出。

        这里持锁的粒度是**整个生成器生命周期** —— 单卡下这是必要的，
        否则第二个请求会在第一个请求推理中途插进来抢显存。

        但等待时间刻意设得很短：流式合成的价值就是「马上听到」，
        如果前面已经有一条流在跑，正确做法是立刻告诉用户「忙」，
        而不是让他等 5 分钟再听到第一声。
        """
        self._reject_if_training()
        if not self._infer_lock.acquire(timeout=STREAM_LOCK_WAIT_S):
            raise BusyError(
                "已有另一条流式合成正在进行",
                hint="流式合成会独占显卡。请等它结束，或改用非流式的普通合成接口。",
            )
        started = time.monotonic()
        completed = False
        handle = None
        try:
            self._ensure_worker()
            try:
                handle = self._client.open_stream("stream", {"inputs": inputs})
                for sample_rate, chunk in handle:
                    yield sample_rate, chunk
                completed = True
            except worker_client.WorkerGone as exc:
                self._raise_worker_gone(exc)
        finally:
            if handle is not None:
                try:
                    handle.close()
                except Exception:  # noqa: BLE001
                    pass
            if completed:
                self.state.synth_count += 1
            self._last_elapsed = time.monotonic() - started
            self._infer_lock.release()

    def split_text(self, text: str, text_lang: str, method: str) -> Dict[str, Any]:
        """复用官方的切分实现（`preprocessor.pre_seg_text`）。

        这是重构时新开的**唯一**新方法：原先 `inference.py::split_text` 直接摸
        `pipeline._pipeline.text_preprocessor` —— 跨进程后那个私有属性不存在了。
        """
        if method not in catalog.TEXT_SPLIT_METHODS:
            from ..errors import BadRequestError  # noqa: PLC0415

            raise BadRequestError(
                "未知的文本切分方式：%s" % method,
                hint="可用值：%s" % "、".join(catalog.TEXT_SPLIT_METHODS),
            )
        self._ensure_worker()
        result = self._call_inference(
            "split_text",
            {"text": text, "text_lang": text_lang, "method": method},
            timeout=60.0,
        )
        return result

    # ------------------------------------------------------------------
    # 观测
    # ------------------------------------------------------------------

    _last_elapsed: float = 0.0

    @property
    def last_elapsed(self) -> float:
        return self._last_elapsed

    # ------------------------------------------------------------------
    # 内部
    # ------------------------------------------------------------------

    def _ensure_worker(self) -> None:
        """确保 worker 起来。失败时翻译成可读的业务异常（503）。"""
        if self._client.alive:
            # 即使已经活着也要刷新 PID：worker 崩溃重启后会换一个进程号，
            # 不刷新的话 `/health` 会一直显示那个已经死掉的 PID。
            self.state.worker_pid = (self._client.hello or {}).get("pid")
            return
        try:
            self._client.ensure_started()
            self.state.worker_alive = True
            self.state.worker_error = None
            hello = self._client.hello or {}
            self.state.worker_pid = hello.get("pid")
        except worker_client.WorkerGone as exc:
            self.state.worker_alive = False
            self.state.worker_error = str(exc)
            raise EnvironmentError_(
                "推理 worker 进程不可用",
                hint=(
                    "worker 负责承载官方 GPT-SoVITS 管线。"
                    "它启动失败通常意味着整合包缺失或 torch 环境不对。\n详情：%s" % exc
                ),
                code="WORKER_UNAVAILABLE",
                status=503,
            ) from exc

    def _call_inference(
        self,
        method: str,
        params: Dict[str, Any],
        timeout: Optional[float] = None,
    ) -> Dict[str, Any]:
        """发一条会碰官方管线的请求，并把两类基础设施故障翻译成业务异常。

        业务异常（`SovitsError` 家族）由 `client.call()` 直接抛出，
        这里不拦 —— 它的 `code` / `http_status` 已经是对外契约的一部分。
        """
        self._ensure_worker()
        try:
            result = self._client.call(
                method,
                params,
                timeout=timeout or (SYNC_LOCK_WAIT_S + 30.0),
            )
        except worker_client.WorkerGone as exc:
            self._raise_worker_gone(exc)
        except worker_client.WorkerTimeout as exc:
            raise SynthesisError(
                "推理超时，worker 未在期限内返回",
                hint="长文本可调小 batch_size 或改用更细的切分方式；也可以先中断再重试。\n详情：%s" % exc,
                code="WORKER_TIMEOUT",
                retryable=True,
            ) from exc
        self.state.worker_alive = True
        self.state.worker_error = None
        return result

    def _raise_worker_gone(self, exc: BaseException) -> None:
        # 进程没了 = 模型没了。镜像必须跟着改，否则 `/v1/pipeline` 会谎报「已加载」。
        # 与 `status()` 里那处走同一条不变式，避免两处各改一半。
        with self._build_lock:
            self.state.mark_worker_lost(str(exc))
        raise EnvironmentError_(
            "推理 worker 进程已退出",
            hint=(
                "worker 通常因显存不足或官方代码异常而退出，重启后会自动恢复。\n"
                "请重试；若反复出现，请查看服务端日志里 worker 的最后几行输出。\n"
                "详情：%s" % exc
            ),
            code="WORKER_GONE",
            status=503,
        ) from exc

    def _absorb(self, snapshot: Optional[Dict[str, Any]]) -> None:
        """把 worker 上报的状态合并进主进程镜像。"""
        if not snapshot:
            return
        with self._build_lock:
            self.state.loaded = bool(snapshot.get("loaded", self.state.loaded))
            self.state.loading = bool(snapshot.get("loading", False))
            self.state.device = str(snapshot.get("device") or self.state.device)
            self.state.is_half = bool(snapshot.get("is_half", self.state.is_half))
            version = snapshot.get("version")
            if version:
                self.state.version = str(version)
            self.state.gpt = snapshot.get("gpt")
            self.state.sovits = snapshot.get("sovits")
            self.state.load_seconds = float(snapshot.get("load_seconds") or 0.0)
            self.state.loaded_at = float(snapshot.get("loaded_at") or 0.0)
            # 计数以 worker 为准：那边才是真正跑推理的地方
            self.state.synth_count = int(snapshot.get("synth_count") or 0)
            self.state.total_audio_seconds = float(snapshot.get("total_audio_seconds") or 0.0)
            self.state.last_error = snapshot.get("last_error")
            self.state.last_error_at = float(snapshot.get("last_error_at") or 0.0)
        self.state.worker_alive = True


# --------------------------------------------------------------------------
# 工具函数
# --------------------------------------------------------------------------


def _resolve_home() -> Optional[Path]:
    """给 worker 一个整合包根目录提示。定位失败就返回 None，交给 worker 自己找。"""
    try:
        installation = bootstrap.current() or bootstrap.locate()
    except Exception:  # noqa: BLE001
        return None
    return installation.home if installation else None


def _default_log(text: str) -> None:
    import sys  # noqa: PLC0415

    try:
        sys.stderr.write("[sovits] %s\n" % text)
        sys.stderr.flush()
    except Exception:  # noqa: BLE001
        pass


def _decode_audio(result: Dict[str, Any]) -> Tuple[int, Any]:
    """把 worker 回传的 base64 int16 解回 numpy 数组。

    音频 dtype 恒为 `int16`（官方 `TTS.run()` 的所有 yield 路径都是它，
    含异常兜底那条），所以这里可以硬编码 dtype。
    """
    import base64  # noqa: PLC0415

    import numpy as np  # noqa: PLC0415

    raw = base64.b64decode(result.get("audio") or "")
    sample_rate = int(result.get("sample_rate") or 0)
    return sample_rate, np.frombuffer(raw, dtype=np.int16)


def _newest(directory: Path, pattern: str) -> Optional[Path]:
    if not directory.is_dir():
        return None
    hits = [path for path in directory.rglob(pattern) if path.is_file()]
    if not hits:
        return None
    return max(hits, key=lambda path: path.stat().st_mtime)


__all__ = ["Pipeline", "PipelineState", "WeightPair"]

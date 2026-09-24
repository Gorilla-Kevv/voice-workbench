"""推理管线单例。

为什么是单例：官方 `TTS.__init__` 会一次性加载 4 个模型
（GPT 语义模型、SoVITS 声学模型、RoBERTa、CNHuBERT，v3/v4 还有声码器），
冷启动约 40~90 秒、占用 2~4 GB 显存。若每次请求都重建，本地体验会退化成不可用。

因此这里维持**一条常驻管线**，并复用官方提供的三组热切换接口：

* `init_t2s_weights()` —— 换 GPT 权重
* `init_vits_weights()` —— 换 SoVITS 权重（同时更新版本号与 SV 模型）
* `set_device()` / `enable_half_precision()` —— 换设备与精度

并发模型：**单卡串行**。所有推理走同一把 `_infer_lock`，
避免两个请求同时抢显存导致 OOM —— 本地工具的正确性优先于吞吐。
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Tuple

from ..errors import BusyError, EnvironmentError_, SynthesisError
from . import bootstrap, catalog

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
    """可序列化的管线状态，`/health` 与 `/v1/pipeline` 直接返回它。"""

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
        }


# --------------------------------------------------------------------------


class Pipeline:
    """官方推理管线的常驻封装。"""

    def __init__(self, data_dir: Path) -> None:
        self._data_dir = data_dir
        self._pipeline: Any = None
        self._config: Any = None
        self._build_lock = threading.RLock()
        self._infer_lock = threading.Lock()
        self.state = PipelineState()
        # 用户意图（可能与已加载状态不一致，由 _ensure 收敛）
        self._target_device: Optional[str] = None
        self._target_half: Optional[bool] = None
        self._target_version: str = catalog.DEFAULT_VERSION
        self._target_gpt: Optional[Path] = None
        self._target_sovits: Optional[Path] = None
        # 记住「最近一次成功的权重加载」，供 _ensure 判断是否需要切换
        self._applied_gpt: Optional[str] = None
        self._applied_sovits: Optional[str] = None
        #: 训练是否正在独占显卡
        self._training_active = False

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
        if self._target_device:
            return self._target_device
        return str(bootstrap.device_defaults()["device"])

    @property
    def is_half(self) -> bool:
        if self._target_half is not None:
            return self._target_half
        return bool(bootstrap.device_defaults()["is_half"])

    def configure(
        self,
        version: Optional[str] = None,
        device: Optional[str] = None,
        is_half: Optional[bool] = None,
        gpt: Optional[str] = None,
        sovits: Optional[str] = None,
    ) -> Dict[str, Any]:
        """登记用户意图。真正的加载发生在下一次合成（或显式 warmup）。"""
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
        return self.status()

    def _absolute(self, raw: str) -> Path:
        path = Path(raw).expanduser()
        if path.is_absolute():
            return path
        installation = bootstrap.require()
        # 允许前端传「相对仓库根目录」的路径，与官方 API 的写法保持一致
        return (installation.home / path).resolve()

    # ------------------------------------------------------------------
    # 权重解析
    # ------------------------------------------------------------------

    def resolve_defaults(self, version: Optional[str] = None) -> WeightPair:
        """为指定版本挑一对默认权重：优先最近训练的产物，否则用官方预训练权重。"""
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

    def current_pair(self) -> WeightPair:
        """当前目标权重（未显式指定时按版本默认解析）。"""
        if self._target_gpt is not None and self._target_sovits is not None:
            return WeightPair(
                gpt=self._target_gpt,
                sovits=self._target_sovits,
                version=self._target_version,
                gpt_source="explicit",
                sovits_source="explicit",
            )
        pair = self.resolve_defaults(self._target_version)
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
        payload = self.state.to_dict()
        payload["target_version"] = self._target_version
        payload["target_device"] = self.device
        payload["target_is_half"] = self.is_half
        payload["streaming_supported"] = catalog.supports_streaming(self._target_version)
        payload["languages"] = catalog.languages_for(self._target_version)
        # 训练独占显卡期间合成会被拒绝，前端据此提前提示而不是等报错
        payload["training_active"] = self._training_active
        return payload

    def warmup(self, blocking: bool = False) -> None:
        """预热。非阻塞时在后台线程里加载，失败记录到状态而不是抛出。"""
        if blocking:
            self._ensure()
            return

        def _run() -> None:
            try:
                self._ensure()
            except Exception as exc:  # noqa: BLE001 - 预热失败不该影响服务可用性
                self.state.warmup_error = "%s: %s" % (type(exc).__name__, exc)

        threading.Thread(target=_run, name="sovits-warmup", daemon=True).start()

    def _ensure(self) -> Any:
        """把当前意图落到实际管线上。返回官方 `TTS` 实例。"""
        with self._build_lock:
            official = bootstrap.official()
            if self._pipeline is None:
                self._build(official)
            else:
                self._reconfigure(official)
            return self._pipeline

    def _build(self, official: Any) -> None:
        pair = self.current_pair()
        device = self.device
        is_half = self.is_half
        installation = bootstrap.require()

        self.state.loading = True
        started = time.monotonic()
        try:
            config = official.TTS_Config(
                {
                    "custom": {
                        "device": device,
                        "is_half": bool(is_half),
                        "version": pair.version,
                        "t2s_weights_path": str(pair.gpt),
                        "vits_weights_path": str(pair.sovits),
                        "bert_base_path": str(installation.path(catalog.BERT_DIR)),
                        "cnhuhbert_base_path": str(installation.path(catalog.HUBERT_DIR)),
                    }
                }
            )
            pipeline = official.TTS(config)
        except Exception as exc:  # noqa: BLE001
            self.state.loading = False
            self.state.last_error = "%s: %s" % (type(exc).__name__, exc)
            self.state.last_error_at = time.time()
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
        self._applied_gpt = str(pair.gpt)
        self._applied_sovits = str(pair.sovits)
        self.state.loaded = True
        self.state.loading = False
        self.state.load_seconds = time.monotonic() - started
        self.state.loaded_at = time.time()
        self.state.version = pair.version
        self.state.device = device
        self.state.is_half = bool(is_half)
        self.state.gpt = pair.gpt.name
        self.state.sovits = pair.sovits.name
        self.state.last_error = None

    def _reconfigure(self, official: Any) -> None:
        """已加载过管线时的增量调整：先设备/精度，再权重。"""
        device = self.device
        is_half = self.is_half
        pair = self.current_pair()

        try:
            import torch  # noqa: PLC0415

            want_device = torch.device(device)
        except Exception:  # noqa: BLE001
            want_device = device

        if str(getattr(self._config, "device", "")) != str(want_device):
            self._pipeline.set_device(want_device)
            self.state.device = str(want_device)

        if bool(getattr(self._config, "is_half", False)) != bool(is_half):
            self._pipeline.enable_half_precision(bool(is_half))
            self.state.is_half = bool(is_half)

        if self._applied_gpt != str(pair.gpt):
            self._pipeline.init_t2s_weights(str(pair.gpt))
            self._applied_gpt = str(pair.gpt)
            self.state.gpt = pair.gpt.name

        if self._applied_sovits != str(pair.sovits):
            self._pipeline.init_vits_weights(str(pair.sovits))
            self._applied_sovits = str(pair.sovits)
            self.state.sovits = pair.sovits.name

        self.state.version = pair.version

    def unload(self, wait_for_inference: bool = True) -> None:
        """释放管线。切换设备、排查显存问题，以及**训练开始前让出显卡**时使用。

        默认会先等正在进行的推理结束再释放 —— 否则刚释放完、旧推理还在跑，
        训练脚本会立刻撞上「显存被占」的假象，排查起来非常费劲。
        调用方若已确认没有推理在跑（例如服务关停），可以传 False 立即返回。
        """
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
                self.state.loaded = False
                self.state.device = "cpu"
                self.state.loaded_at = 0.0
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

    def stop(self) -> bool:
        """请求中断当前推理（官方 `stop_flag`）。"""
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

    def synthesize(self, inputs: Dict[str, Any]) -> Tuple[int, Any]:
        """一次性拿到完整音频。返回 (采样率, int16 numpy 数组)。"""
        # 先拒绝，再谈加载模型 —— 否则「拒绝」本身就把显存吃掉了
        self._reject_if_training()
        pipeline = self._ensure()
        if not self._infer_lock.acquire(timeout=SYNC_LOCK_WAIT_S):
            raise BusyError(
                "有另一个合成任务正在占用显卡",
                hint="单卡串行是 GPT-SoVITS 的物理约束。请等待当前任务结束，"
                "或降低批量合成的规模。",
            )
        try:
            started = time.monotonic()
            try:
                generator = pipeline.run(inputs)
                sample_rate, audio = _last_chunk(generator)
            except Exception as exc:  # noqa: BLE001
                self._record_error(exc)
                raise _as_synthesis_error(exc) from exc

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
        pipeline = self._ensure()
        if not self._infer_lock.acquire(timeout=STREAM_LOCK_WAIT_S):
            raise BusyError(
                "已有另一条流式合成正在进行",
                hint="流式合成会独占显卡。请等它结束，或改用非流式的普通合成接口。",
            )
        started = time.monotonic()
        completed = False
        try:
            for sample_rate, chunk in pipeline.run(inputs):
                yield sample_rate, chunk
            completed = True
        except Exception as exc:  # noqa: BLE001
            self._record_error(exc)
            raise _as_synthesis_error(exc) from exc
        finally:
            if completed:
                self.state.synth_count += 1
            self._last_elapsed = time.monotonic() - started
            self._infer_lock.release()

    # ------------------------------------------------------------------
    # 观测
    # ------------------------------------------------------------------

    _last_elapsed: float = 0.0

    @property
    def last_elapsed(self) -> float:
        return self._last_elapsed

    def _record_error(self, exc: Exception) -> None:
        self.state.last_error = "%s: %s" % (type(exc).__name__, exc)
        self.state.last_error_at = time.time()


# --------------------------------------------------------------------------
# 工具函数
# --------------------------------------------------------------------------


def _newest(directory: Path, pattern: str) -> Optional[Path]:
    if not directory.is_dir():
        return None
    hits = [path for path in directory.rglob(pattern) if path.is_file()]
    if not hits:
        return None
    return max(hits, key=lambda path: path.stat().st_mtime)


def _last_chunk(generator: Iterator[Tuple[int, Any]]) -> Tuple[int, Any]:
    """官方 `run()` 在多段场景下会 yield 多次，非流式调用应取最后一块完整音频。

    官方 `api_v2.py` 用的是 `next(tts_generator)`，但那在 `size` 较小时
    会丢掉后续片段。这里改为取最后一帧，语义等价且不会截断。
    """
    last: Optional[Tuple[int, Any]] = None
    for sample_rate, audio in generator:
        last = (sample_rate, audio)
    if last is None:
        raise SynthesisError(
            "推理未产出任何音频",
            hint="文本可能为空，或已被文本清洗阶段全部过滤。",
            code="EMPTY_AUDIO",
        )
    return last


def _as_synthesis_error(exc: Exception) -> SynthesisError:
    """把官方零散异常翻译成带修复建议的业务错误。"""
    text = "%s: %s" % (type(exc).__name__, exc)
    lower = text.lower()

    if "3~10秒" in text or "3~10" in text:
        return SynthesisError(
            "参考音频时长不在 3~10 秒范围内",
            hint="这是官方硬约束。请重新裁剪参考音频到 3~10 秒后重试。",
            code="REF_AUDIO_DURATION",
        )
    if "not exists" in lower or "no such file" in lower:
        return SynthesisError(
            "参考音频文件不存在",
            hint="音色库中的音频可能已被移动或删除，请重新上传。",
            code="REF_AUDIO_MISSING",
        )
    if "out of memory" in lower or "cuda error" in lower:
        return SynthesisError(
            "显存不足，推理中断",
            hint="可尝试：降低批大小（batch_size=1）、关闭并行推理、改用更小的版本（v2ProPlus → v2），或停止其它占用显卡的程序。",
            code="CUDA_OOM",
        )
    if "prompt_text cannot be empty" in lower:
        return SynthesisError(
            "当前模型要求提供参考音频的转写文本",
            hint="v3/v4 声码器模型不支持空参考文本，请在音色库中补全提示文本。",
            code="PROMPT_TEXT_REQUIRED",
        )
    if "repetition" in lower or "复读" in text:
        return SynthesisError(
            "模型出现复读（重复输出），已中断",
            hint="可调低 temperature 或提高 repetition_penalty，或改用更细的文本切分方式（cut4 / cut5）。",
            code="REPETITION",
        )
    return SynthesisError("推理失败：" + text, hint="完整堆栈见服务端控制台输出。", code="SYNTHESIS_FAILED")


__all__ = ["Pipeline", "PipelineState", "WeightPair"]

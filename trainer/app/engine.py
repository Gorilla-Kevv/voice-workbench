"""引擎注册表：同一张显卡上多个模型的互斥调度。

本机是 8GB 级别的消费级显卡（实测 RTX 4060 Laptop，8.6GB），而我们要在它上面跑
四套模型：GPT-SoVITS、RVC、DDSP-SVC，外加 UVR5 分离。任何两套同时常驻都必然 OOM ——
这不是保守估计，是现有 GPT-SoVITS 训练链路已经踩过的坑（`api.py` 里训练前会先
`pipeline.unload()`）。

因此这里的规则只有一条：**同一时刻只准一个引擎持有显存**。

- `acquire()` 是唯一的入口：它会先卸掉当前引擎，再让新引擎上场；
- 各引擎通过 `register_unloader()` 登记「怎么释放自己」，注册表不关心细节；
- 训练期间拒绝一切推理引擎（沿用现有语义：训练要独占显卡）；
- 显存准入沿用 `queue.free_vram_mb()`，宁可多等一会儿也不让任务跑到一半 OOM。

这样两个新板块（RVC / DDSP-SVC）与原有的 GPT-SoVITS 之间不需要互相知道对方的存在，
只需要都经过这里。
"""

from __future__ import annotations

import threading
import time
from typing import Callable, Dict, List, Optional

from .config import Settings
from .queue import AdmissionError, free_vram_mb

__all__ = ["EngineInfo", "EngineHandle", "EngineRegistry"]


class EngineInfo:
    """一个引擎的静态描述。"""

    def __init__(
        self,
        name: str,
        label: str,
        required_mb: int,
        description: str = "",
        training: bool = False,
    ) -> None:
        self.name = name
        self.label = label
        #: 派发前要求的最低可用显存；0 表示不做准入（例如纯 CPU 的环节）
        self.required_mb = required_mb
        self.description = description
        #: 训练类引擎上场期间，推理类引擎一律拒绝
        self.training = training

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "label": self.label,
            "required_mb": self.required_mb,
            "description": self.description,
            "training": self.training,
        }


#: 四个引擎的静态清单。
#:
#: `required_mb` 取的是「能跑起来」的量级，不是模型文件大小 —— 滑窗推理的激活值
#: 往往比权重本身还大（BS-RoFormer 尤其明显，按 2~4GB 预留）。宁可估高：
#: 估高的代价是提前拒绝并给出提示，估低的代价是任务跑到一半 OOM。
ENGINES: Dict[str, EngineInfo] = {
    "sovits": EngineInfo(
        "sovits", "GPT-SoVITS", 3072, "本地语音合成与训练（既有链路）", training=False
    ),
    "rvc": EngineInfo(
        "rvc", "RVC 语音变声", 2560, "语音变声：HuBERT 特征 + 检索索引增强", training=False
    ),
    "svc": EngineInfo(
        "svc", "DDSP-SVC 歌声转换", 3072, "歌声转换：DDSP 合成器 + Rectified Flow", training=False
    ),
    "uvr5": EngineInfo(
        "uvr5", "UVR5 音源分离", 4096, "人声/伴奏分离、去混响、去回声", training=False
    ),
    "asr": EngineInfo(
        "asr", "ASR 语音转文本", 2048, "语音转文本：FunASR / faster-whisper，含逐字打标", training=False
    ),
    "train": EngineInfo(
        "train", "模型训练", 6144, "训练独占显卡期间拒绝一切推理", training=True
    ),
}

#: 训练引擎的别名：不同板块的训练都归到同一个"显卡被训练占着"的状态
_TRAINING_ALIASES = {"sovits_train": "train", "rvc_train": "train", "svc_train": "train"}


def canonical(name: str) -> str:
    """把 `rvc_train` 之类的名字归一到注册的引擎名。"""
    return _TRAINING_ALIASES.get(name, name)


class EngineHandle:
    """一次引擎占用的句柄。推荐用 `with` 或显式 `release()`。"""

    def __init__(self, registry: "EngineRegistry", name: str, reason: str) -> None:
        self._registry = registry
        self.name = name
        self.reason = reason
        self.acquired_at = time.time()
        self.released = False

    def release(self) -> None:
        if not self.released:
            self._registry.release(self.name)
            self.released = True

    def __enter__(self) -> "EngineHandle":
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.release()

    def to_dict(self) -> dict:
        return {
            "engine": self.name,
            "reason": self.reason,
            "held_s": round(time.time() - self.acquired_at, 1),
        }


class EngineRegistry:
    """引擎互斥调度器。全局唯一，挂在 `api.Context` 上。"""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._lock = threading.RLock()
        self._active: Optional[str] = None
        self._reason: str = ""
        self._since: float = 0.0
        self._unloaders: Dict[str, Callable[[], None]] = {}
        self._training_engine: Optional[str] = None

    # ---------- 登记 ----------

    def register_unloader(self, name: str, unloader: Callable[[], None]) -> None:
        """登记某引擎的释放逻辑（卸载模型 + `torch.cuda.empty_cache()`）。"""
        with self._lock:
            self._unloaders[canonical(name)] = unloader

    # ---------- 占用 ----------

    def acquire(self, name: str, reason: str = "") -> EngineHandle:
        """独占获取引擎。被占用且无法让位时抛 `AdmissionError`。"""
        name = canonical(name)
        info = ENGINES.get(name)
        if info is None:
            raise AdmissionError("ENGINE_UNKNOWN", "未知引擎：%s" % name, retryable=False)

        with self._lock:
            if info.training:
                # 训练上场：先请走一切推理引擎
                self._release_active_locked(force=True)
                self._training_engine = name
            elif self._training_engine:
                raise AdmissionError(
                    "GPU_BUSY_TRAINING",
                    "训练正在占用显卡，无法启动%s。等训练结束或取消后重试。" % info.label,
                    retryable=True,
                    retry_after_s=20,
                )
            elif self._active and self._active != name:
                self._release_active_locked(force=True)

            self._check_vram_locked(info)

            self._active = name
            self._reason = reason
            self._since = time.time()
            return EngineHandle(self, name, reason)

    def _check_vram_locked(self, info: EngineInfo) -> None:
        """显存准入。未知剩余显存（返回 None）时放行，交由 torch 自己报错。"""
        if info.required_mb <= 0:
            return
        free = free_vram_mb()
        if free is None:
            return
        need = info.required_mb + self.settings.vram_reserve_mb
        if free < need:
            raise AdmissionError(
                "VRAM_INSUFFICIENT",
                "可用显存 %d MB 不足以加载%s（需要约 %d MB）。" % (free, info.label, need),
                retryable=True,
                retry_after_s=10,
            )

    def release(self, name: str) -> None:
        name = canonical(name)
        with self._lock:
            if self._active == name:
                self._release_active_locked()
            if self._training_engine == name:
                self._training_engine = None

    def _release_active_locked(self, force: bool = False) -> None:
        """释放当前引擎。训练锁住时不允许被顺带释放，除非 `force`。"""
        active = self._active
        if not active:
            return
        if self._training_engine and not force:
            return
        unloader = self._unloaders.get(active)
        if unloader is not None:
            try:
                unloader()
            except Exception:  # noqa: BLE001 - 卸载失败也要把状态清掉，否则永远占着
                pass
        self._active = None
        self._reason = ""
        self._since = 0.0

    def unload_all(self) -> None:
        """释放一切。用于服务关闭与「手动释放显存」按钮。"""
        with self._lock:
            self._release_active_locked(force=True)
            self._training_engine = None

    # ---------- 状态 ----------

    @property
    def active(self) -> Optional[str]:
        return self._active

    def status(self) -> dict:
        free = free_vram_mb()
        with self._lock:
            active = self._active
            return {
                "active": active,
                "active_label": ENGINES[active].label if active in ENGINES else None,
                "reason": self._reason,
                "held_s": round(time.time() - self._since, 1) if self._since else 0.0,
                "training": self._training_engine,
                "free_vram_mb": free,
                "reserve_mb": self.settings.vram_reserve_mb,
                "engines": [info.to_dict() for info in ENGINES.values()],
                "registered_unloaders": sorted(self._unloaders),
            }

    def snapshot(self) -> dict:
        """/health 用的精简版。"""
        status = self.status()
        return {
            "active": status["active"],
            "active_label": status["active_label"],
            "training": status["training"],
            "free_vram_mb": status["free_vram_mb"],
        }

    def describe_blockers(self) -> List[str]:
        """把「为什么现在用不了」说清楚，供 /health 的 hints 使用。"""
        with self._lock:
            if self._training_engine:
                return ["显卡正被训练任务占用，推理与分离请求会被拒绝，直到训练结束或取消"]
            return []

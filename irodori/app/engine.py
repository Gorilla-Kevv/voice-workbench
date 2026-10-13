"""Irodori 引擎：懒加载、显存准入、卸载、合成互斥。

与 `netease/app/tts_engine.py` 同一套生命周期哲学：
- **懒启动**：`/health` 只探测不加载，第一次 warmup / synth 才把模型装进显存（~20s）；
- **准入真源在服务端**：`required_vram_mb` 用 nvidia-smi 口径（WDDM 下 torch 看不见
  别的进程，坑 17）；**已加载就跳过准入** —— 它自己占的已经反映在 free_mb 里，
  再减一次就是「自己把自己检测成占用者」（坑 26/坑 24）；
- **不静默降级**：没有 CUDA 就明确报错（CPU 的 RTF 是几十倍，给了等于不可用）。

模型本体走上游的 `get_cached_runtime` / `clear_cached_runtime`（单实例缓存 +
热切换 + `unload()` 里 gc + empty_cache），本文件不重复造缓存。
上游代码零改动：`sys.path` 注入在这里做，垫片（windecode）在 create_app 最前面已装。
"""

from __future__ import annotations

import sys
import threading
import time
from typing import Any, Optional

from .config import Settings, required_vram_mb
from .errors import IrodoriError
from .hardware import resolve_device, vram_mb

#: 上游 runtime 的单例（None = 未加载）
_RUNTIME: Any = None
#: 当前加载用的 RuntimeKey（换权重/精度时会热切换）
_RUNTIME_KEY: Any = None
_STATE_LOCK = threading.RLock()
#: 合成互斥：同一时刻只允许一条 synth 在跑（上游 InferenceRuntime 内部也有
#: `_infer_lock`，但排队等待不如直接 409 告诉用户「训练/合成中」）
_BUSY_LOCK = threading.Lock()
#: 是否有「被放弃但仍在收尾」的合成线程（30-3 护栏的第二层命中后出现）。
#:
#: ⚠️ 背景：`sample_rf` 的采样循环没有任何回调 hook（上游只在整段采样结束后 log 一次），
#: Python 层**杀不掉**一个正在 CUDA 上跑的同步采样。所以墙钟超时只能「放弃」请求线程、
#: 让工作线程跑完自然退出。这期间合成权仍被它持有（不能放 —— 否则新请求会和它抢
#: 上游的 `_infer_lock`，把显存打爆）。这个标志只用于**把 409 的文案说清楚**，
#: 真正的互斥仍然是 `_BUSY_LOCK` 本身。
_RECOVERING = False
_RECOVERING_LOCK = threading.Lock()

loaded_at: Optional[float] = None
last_error: Optional[str] = None


def _ensure_upstream_on_path(settings: Settings) -> None:
    if str(settings.upstream_dir) not in sys.path:
        sys.path.insert(0, str(settings.upstream_dir))


def is_loaded() -> bool:
    return _RUNTIME is not None


def status() -> dict[str, Any]:
    return {
        "loaded": is_loaded(),
        "loaded_at": loaded_at,
        "last_error": last_error,
    }


def check_vram_admission(settings: Settings, *, loaded: bool, task: str = "infer") -> dict[str, Any]:
    """显存准入。返回当前显存读数；不足时抛 `VRAM_INSUFFICIENT`(503)。

    - `loaded=True`（模型已常驻）→ 直接放行，不算「空闲 − 需求」（坑 26）；
    - nvidia-smi 与 torch 读数差 >1GB 时，报错文案直接说「被其它进程占用」；
    - `task="prepare"`（数据整备）按 codec 档判 —— 它只加载 DACVAE，
      拿推理的 4.7GB 去卡它就纯属误伤（30-5）。
    """
    vram = vram_mb()
    if loaded or vram is None:
        return {"vram": vram, "required_mb": required_vram_mb(settings.precision, task)}
    required = required_vram_mb(settings.precision, task)
    free = vram["free_mb"]
    if free >= required:
        return {"vram": vram, "required_mb": required}

    torch_free = vram.get("torch_free_mb")
    occupied_by_others = (
        torch_free is not None and torch_free - free > 1024
    )
    if occupied_by_others:
        message = (
            f"显存不足：需要约 {required} MB，当前仅 {free} MB"
            f"（另有约 {torch_free - free} MB 被**其它进程**占用 —— 浏览器 / 模拟器 / 其它模型服务）"
        )
        hint = "先关闭占显存的程序，或在「设置 → 本地服务」里关掉其它模型服务；也可以在资源预估卡里点「只跑这一个模型」。"
    else:
        message = f"显存不足：需要约 {required} MB，当前仅 {free} MB"
        hint = "关闭占显存的程序后重试；或在资源预估卡里点「释放常驻显存」。"
    raise IrodoriError(
        "VRAM_INSUFFICIENT",
        message,
        hint,
        status=503,
        retryable=True,
        details={
            "free_mb": free,
            "required_mb": required,
            "torch_free_mb": torch_free,
            "total_mb": vram.get("total_mb"),
            "source": vram.get("source"),
        },
    )


def load(settings: Settings) -> tuple[Any, bool]:
    """把模型装进显存。返回 `(runtime, loaded_now)`；已加载直接返回不拦。

    这里刻意不做显存准入 —— 准入在路由层按「当前是否已加载」判定后调用，
    保证 warmup（明确要加载）与 synth（已加载就跳过检查）都能复用同一条规则。
    """
    global _RUNTIME, _RUNTIME_KEY, loaded_at, last_error

    with _STATE_LOCK:
        _ensure_upstream_on_path(settings)
        from irodori_tts.inference_runtime import (  # noqa: PLC0415 - lazy：venv 里才有
            RuntimeKey,
            get_cached_runtime,
        )

        device = resolve_device(settings.device, allow_cpu=settings.allow_cpu)
        key = RuntimeKey(
            checkpoint=str(settings.int4_model_file),
            model_device=device,
            model_precision=settings.precision,
            # DACVAECodec.load 认本地路径：存在即直用，不走 HF（上游 codec.py:70）
            codec_repo=str(settings.codec_weights),
            codec_device=device,
            codec_precision=settings.precision,
        )
        if _RUNTIME is not None and _RUNTIME_KEY == key:
            return _RUNTIME, False

        started = time.perf_counter()
        try:
            runtime, loaded_now = get_cached_runtime(key)
        except Exception as error:
            last_error = f"{type(error).__name__}: {error}"
            raise IrodoriError(
                "ENGINE_LOAD_FAILED",
                f"Irodori 模型加载失败：{last_error}",
                "先跑 npm run irodori:check 看权重与 CUDA 是否就绪；显存不足时先让出显存。",
                status=503,
                retryable=True,
            ) from error
        _RUNTIME = runtime
        _RUNTIME_KEY = key
        loaded_at = time.time()
        last_error = None
        if loaded_now:
            print(
                f"[irodori] 模型已加载（{time.perf_counter() - started:.1f}s，device={device}，"
                f"precision={settings.precision}）",
                flush=True,
            )
        return runtime, loaded_now


def unload(settings: Settings) -> dict[str, Any]:
    """释放显存，回报归还量（nvidia-smi 前后差，拿不到就是 null）。"""
    global _RUNTIME, _RUNTIME_KEY, loaded_at, last_error

    with _STATE_LOCK:
        if _RUNTIME is None:
            return {"loaded": False, "freed_mb": None, "vram": vram_mb()}
        before = vram_mb()
        from irodori_tts.inference_runtime import clear_cached_runtime  # noqa: PLC0415

        clear_cached_runtime()
        _RUNTIME = None
        _RUNTIME_KEY = None
        loaded_at = None
        after = vram_mb()
        freed = (
            after["free_mb"] - before["free_mb"]
            if before is not None and after is not None
            else None
        )
        print(f"[irodori] 模型已卸载（归还约 {freed} MB）", flush=True)
        return {"loaded": False, "freed_mb": freed, "vram": after, "before": before}


def try_acquire_busy() -> bool:
    """非阻塞拿到合成权。拿不到 = 有一条合成/训练正在跑 → 上层报 409。"""
    return _BUSY_LOCK.acquire(blocking=False)


def release_busy() -> None:
    """释放合成权。

    ⚠️ 调用方是**合成工作线程**（而不是请求线程）：墙钟超时时请求线程会先返回 504，
    合成权必须留到工作线程自然结束才放 —— 见 `_RECOVERING` 的注释。
    """
    if _BUSY_LOCK.locked():
        _BUSY_LOCK.release()


def is_recovering() -> bool:
    """是否有被放弃但仍未跑完的合成（用于把 409 文案说清楚）。"""
    with _RECOVERING_LOCK:
        return _RECOVERING


def mark_recovering() -> None:
    global _RECOVERING
    with _RECOVERING_LOCK:
        _RECOVERING = True


def clear_recovering() -> None:
    global _RECOVERING
    with _RECOVERING_LOCK:
        _RECOVERING = False

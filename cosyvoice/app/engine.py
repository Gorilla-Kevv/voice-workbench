"""CosyVoice3 引擎：懒加载、显存准入、卸载、合成互斥。

两个 Windows 专属补丁在 `load()` 里装（上游代码零改动）：

1. **`torch.load(map_location='cuda')` → `'cpu'`**：上游 `CosyVoice3Model.load()`
   直接往显存搬权重，WDDM 下大块分配容易碎片化 OOM（上游 issue #1936，
   8GB 与 16GB 卡都复现）。改成先落 CPU 再 `load_state_dict` 逐张量拷到显存，
   峰值仍然只有一份模型，但避免了「一次性大块 CUDA 分配」。
2. **ONNX provider 回落**：上游在 CUDA 可用时请求 `CUDAExecutionProvider`，
   而 Windows 装的是 CPU 版 onnxruntime（上游 requirements 也如此）。
   这里在构造前把不可用的 provider 过滤掉，避免加载直接失败。
"""

from __future__ import annotations

import gc
import os
import sys
import threading
import time
from contextlib import contextmanager
from typing import Any, Optional

from .config import Settings, REQUIRED_VRAM_MB
from .errors import CosyvoiceError
from .hardware import resolve_device, vram_mb

_MODEL: Any = None
_MODEL_KEY: Optional[tuple[str, str, bool]] = None
_STATE_LOCK = threading.RLock()
_BUSY_LOCK = threading.Lock()
loaded_at: Optional[float] = None
last_error: Optional[str] = None


def ensure_upstream_on_path(settings: Settings) -> None:
    """把上游源码与 Matcha-TTS 挂进 sys.path（幂等）。

    官方 `example.py` 用 `sys.path.append('third_party/Matcha-TTS')`；
    上游 `cosyvoice` 包与本运行时目录同名，所以必须插到 sys.path[0]。
    """
    for path in (settings.upstream_dir, settings.upstream_dir / "third_party" / "Matcha-TTS"):
        if str(path) not in sys.path:
            sys.path.insert(0, str(path))


@contextmanager
def _cpu_weight_loading():
    """把 torch.load 的 map_location 临时改成 CPU（见模块头补丁 1）。"""
    import torch  # noqa: PLC0415

    original = torch.load

    def cpu_load(*args: Any, **kwargs: Any) -> Any:
        kwargs["map_location"] = "cpu"
        # 上游所有 load 都已显式 weights_only=True；这里再兜一层默认值，
        # 避免任何漏写 kwargs 的调用把 torch.load 退化成可执行对象反序列化。
        kwargs.setdefault("weights_only", True)
        return original(*args, **kwargs)

    torch.load = cpu_load
    try:
        yield
    finally:
        torch.load = original


def _install_onnx_provider_fallback() -> None:
    """过滤不可用的 ONNX provider（见模块头补丁 2）。幂等。"""
    import onnxruntime as ort  # noqa: PLC0415

    if getattr(ort.InferenceSession, "_cosyvoice_patched", False):
        return
    available = set(ort.get_available_providers())
    original = ort.InferenceSession.__init__

    def patched(self: Any, path_or_bytes: Any, sess_options: Any = None,
                providers: Any = None, provider_options: Any = None, **kwargs: Any) -> None:
        requested = list(providers or [])
        usable = [item for item in requested if item in available]
        if not usable:
            usable = ["CPUExecutionProvider"] if "CPUExecutionProvider" in available else requested
        original(self, path_or_bytes, sess_options, usable, provider_options, **kwargs)

    patched._cosyvoice_patched = True  # type: ignore[attr-defined]
    ort.InferenceSession.__init__ = patched


def is_loaded() -> bool:
    return _MODEL is not None


def status() -> dict[str, Any]:
    return {
        "loaded": is_loaded(),
        "loaded_at": loaded_at,
        "last_error": last_error,
        "model_key": list(_MODEL_KEY) if _MODEL_KEY else None,
    }


def check_vram_admission(settings: Settings, *, loaded: bool) -> dict[str, Any]:
    """显存准入。已加载直接放行（坑 26：不能再减一次自己的占用）。"""
    vram = vram_mb()
    if loaded or vram is None:
        return {"vram": vram, "required_mb": REQUIRED_VRAM_MB}
    free = vram["free_mb"]
    if free >= REQUIRED_VRAM_MB:
        return {"vram": vram, "required_mb": REQUIRED_VRAM_MB}

    torch_free = vram.get("torch_free_mb")
    occupied_by_others = torch_free is not None and torch_free - free > 1024
    if occupied_by_others:
        message = (
            f"显存不足：需要约 {REQUIRED_VRAM_MB} MB，当前仅 {free} MB"
            f"（另有约 {torch_free - free} MB 被其它进程占用 —— 浏览器 / 模拟器 / 其它模型服务）"
        )
        hint = "先关闭占显存的程序，或在「设置 → 本地服务」里关掉其它模型服务。"
    else:
        message = f"显存不足：需要约 {REQUIRED_VRAM_MB} MB，当前仅 {free} MB"
        hint = "关闭占显存的程序后重试；或在资源预估卡里点「释放常驻显存」。"
    raise CosyvoiceError(
        "VRAM_INSUFFICIENT",
        message,
        hint,
        status=503,
        retryable=True,
        details={
            "free_mb": free,
            "required_mb": REQUIRED_VRAM_MB,
            "torch_free_mb": torch_free,
            "total_mb": vram.get("total_mb"),
            "source": vram.get("source"),
        },
    )


def load(settings: Settings) -> tuple[Any, bool]:
    """把模型装进显存。返回 `(model, loaded_now)`；已加载直接返回。"""
    global _MODEL, _MODEL_KEY, loaded_at, last_error

    with _STATE_LOCK:
        key = (str(settings.model_dir), settings.llm_file, settings.fp16)
        if _MODEL is not None and _MODEL_KEY == key:
            return _MODEL, False

        ensure_upstream_on_path(settings)
        device = resolve_device(settings.device, allow_cpu=settings.allow_cpu)
        fp16 = bool(settings.fp16 and device == "cuda")
        _install_onnx_provider_fallback()

        # llm 可选 rl 权重：上游只会读 llm.pt，这里在构造前把文件映射好
        if settings.llm_file != "llm.pt":
            target = settings.model_dir / "llm.pt"
            source = settings.model_dir / settings.llm_file
            if source.is_file() and not target.exists():
                # 硬链接而不是 symlink：Windows 非管理员/非开发者模式建不了符号链接
                os.link(source, target)

        started = time.perf_counter()
        try:
            from cosyvoice.cli.cosyvoice import AutoModel  # noqa: PLC0415

            with _cpu_weight_loading():
                model = AutoModel(model_dir=str(settings.model_dir), fp16=fp16)
        except Exception as error:
            last_error = f"{type(error).__name__}: {error}"
            raise CosyvoiceError(
                "ENGINE_LOAD_FAILED",
                f"CosyVoice3 模型加载失败：{last_error}",
                "先跑 npm run cosyvoice:check 看权重与 CUDA 是否就绪；显存不足时先让出显存。",
                status=503,
                retryable=True,
            ) from error

        _MODEL = model
        _MODEL_KEY = key
        loaded_at = time.time()
        last_error = None
        try:
            import torch  # noqa: PLC0415

            torch.cuda.empty_cache()
        except Exception:  # pragma: no cover
            pass
        print(
            f"[cosyvoice] 模型已加载（{time.perf_counter() - started:.1f}s，device={device}，fp16={fp16}）",
            flush=True,
        )
        return model, True


def unload(settings: Settings) -> dict[str, Any]:
    """释放显存，回报归还量（nvidia-smi 前后差）。"""
    global _MODEL, _MODEL_KEY, loaded_at
    _ = settings

    with _STATE_LOCK:
        if _MODEL is None:
            return {"loaded": False, "freed_mb": None, "vram": vram_mb()}
        before = vram_mb()
        _MODEL = None
        _MODEL_KEY = None
        loaded_at = None
        gc.collect()
        try:
            import torch  # noqa: PLC0415

            if torch.cuda.is_available():
                torch.cuda.empty_cache()
                torch.cuda.ipc_collect()
        except Exception:  # pragma: no cover
            pass
        after = vram_mb()
        freed = (
            after["free_mb"] - before["free_mb"]
            if before is not None and after is not None
            else None
        )
        print(f"[cosyvoice] 模型已卸载（归还约 {freed} MB）", flush=True)
        return {"loaded": False, "freed_mb": freed, "vram": after, "before": before}


def try_acquire_busy() -> bool:
    return _BUSY_LOCK.acquire(blocking=False)


def release_busy() -> None:
    if _BUSY_LOCK.locked():
        _BUSY_LOCK.release()

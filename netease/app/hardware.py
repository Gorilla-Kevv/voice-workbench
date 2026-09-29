"""硬件探测：torch / CUDA / 显存。

服务进程可能在**没有 torch 的解释器**里启动（用户还没建 venv 就手滑跑了），
所以这里绝不允许模块级 import torch —— 全部函数内 lazy import，
把「缺什么」变成 health 里的可读信息而不是启动崩溃。
"""

from __future__ import annotations

from typing import Optional

_STATE: dict = {"checked": False, "torch": False, "cuda": False, "error": "", "device": None}


def probe() -> dict:
    """探测当前解释器的 torch/CUDA 状态，结果缓存（进程内环境不会变）。"""
    if _STATE["checked"]:
        return dict(_STATE)
    try:
        import torch  # noqa: PLC0415

        _STATE["torch"] = True
        _STATE["cuda"] = bool(torch.cuda.is_available())
        if _STATE["cuda"]:
            _STATE["device"] = "cuda"
        elif torch.backends.mps.is_available():  # 兜底 Apple Silicon，本项目实机为 NVIDIA
            _STATE["device"] = "mps"
        else:
            _STATE["device"] = "cpu"
    except Exception as error:  # pragma: no cover - 环境相关
        _STATE["torch"] = False
        _STATE["error"] = f"{type(error).__name__}: {error}"
    _STATE["checked"] = True
    return dict(_STATE)


def vram_mb() -> Optional[dict[str, int]]:
    """当前显卡的总量/空闲显存（MB）。无 CUDA 时返回 None。"""
    info = probe()
    if not info["cuda"]:
        return None
    try:
        import torch  # noqa: PLC0415

        free, total = torch.cuda.mem_get_info(0)
        return {"free_mb": int(free // (1024 * 1024)), "total_mb": int(total // (1024 * 1024))}
    except Exception:
        return None


def resolve_device(preferred: str, *, allow_cpu: bool) -> str:
    """决定实际推理设备。CPU 只在显式允许时接受，理由见 config.allow_cpu。"""
    info = probe()
    if preferred in {"cuda", "auto"} and info["cuda"]:
        return "cuda"
    if preferred == "cpu":
        if allow_cpu or not info["torch"]:
            return "cpu"
    if info["cuda"]:
        return "cuda"
    raise RuntimeError(
        "当前解释器没有可用的 CUDA。"
        if info["torch"]
        else f"当前解释器未安装 torch：{info['error'] or '请先按 netease/README.md 建 venv'}"
    )

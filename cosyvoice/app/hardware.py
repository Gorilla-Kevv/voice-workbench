"""硬件探测：torch / CUDA / 显存。

全部函数内 lazy import torch —— 没建 venv 的解释器也能把「缺什么」变成
health 里的可读信息，而不是启动崩溃（与 irodori/netEase 同一取舍）。
"""

from __future__ import annotations

from typing import Optional

_STATE: dict = {"checked": False, "torch": False, "cuda": False, "error": "", "device": None}


def probe() -> dict:
    if _STATE["checked"]:
        return dict(_STATE)
    try:
        import torch  # noqa: PLC0415

        _STATE["torch"] = True
        _STATE["cuda"] = bool(torch.cuda.is_available())
        _STATE["device"] = "cuda" if _STATE["cuda"] else "cpu"
    except Exception as error:  # pragma: no cover - 环境相关
        _STATE["torch"] = False
        _STATE["error"] = f"{type(error).__name__}: {error}"
    _STATE["checked"] = True
    return dict(_STATE)


def device_name() -> Optional[str]:
    info = probe()
    if not info["cuda"]:
        return None
    try:
        import torch  # noqa: PLC0415

        return str(torch.cuda.get_device_name(0))
    except Exception:  # pragma: no cover
        return None


def compute_capability() -> Optional[list[int]]:
    info = probe()
    if not info["cuda"]:
        return None
    try:
        import torch  # noqa: PLC0415

        major, minor = torch.cuda.get_device_capability(0)
        return [int(major), int(minor)]
    except Exception:  # pragma: no cover
        return None


def _nvidia_smi_mb() -> Optional[tuple[int, int]]:
    try:
        import subprocess  # noqa: PLC0415

        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.free,memory.total", "--format=csv,noheader,nounits"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode != 0:
            return None
        first = result.stdout.strip().splitlines()[0]
        free, total = (int(float(part)) for part in first.split(",")[:2])
        return free, total
    except Exception:  # pragma: no cover
        return None


def vram_mb() -> Optional[dict[str, int]]:
    """当前显卡的总量/空闲显存（MB）。WDDM 下 `free_mb` 以 nvidia-smi 为准。"""
    info = probe()
    if not info["cuda"]:
        return None
    torch_free: Optional[int] = None
    total: Optional[int] = None
    try:
        import torch  # noqa: PLC0415

        free_bytes, total_bytes = torch.cuda.mem_get_info(0)
        torch_free = int(free_bytes // (1024 * 1024))
        total = int(total_bytes // (1024 * 1024))
    except Exception:  # pragma: no cover
        pass

    smi = _nvidia_smi_mb()
    if smi is None:
        if torch_free is None or total is None:
            return None
        return {"free_mb": torch_free, "total_mb": total, "torch_free_mb": torch_free, "source": "torch"}
    free, smi_total = smi
    return {
        "free_mb": free,
        "total_mb": total or smi_total,
        "torch_free_mb": torch_free if torch_free is not None else free,
        "source": "nvidia-smi",
    }


def resolve_device(preferred: str, *, allow_cpu: bool) -> str:
    info = probe()
    if preferred in {"cuda", "auto"} and info["cuda"]:
        return "cuda"
    if preferred == "cpu" and (allow_cpu or not info["torch"]):
        return "cpu"
    if info["cuda"]:
        return "cuda"
    raise RuntimeError(
        "当前解释器没有可用的 CUDA。"
        if info["torch"]
        else f"当前解释器未安装 torch：{info['error'] or '请先按 cosyvoice/README.md 建 venv'}"
    )

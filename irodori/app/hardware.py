"""硬件探测：torch / CUDA / 显存。

服务进程可能在**没有 torch 的解释器**里启动（用户还没建 venv 就手滑跑了），
所以这里绝不允许模块级 import torch —— 全部函数内 lazy import，
把「缺什么」变成 health 里的可读信息而不是启动崩溃。

与 `netease/app/hardware.py` 是同一份实现（两个服务同构）；刻意不抽公共包：
它们的 venv 互相隔离，抽出去反而要处理「谁提供这个包」的问题。
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


def compute_capability() -> Optional[list[int]]:
    """当前卡的 compute capability，如 [8, 9]。取不到返回 None。

    存在的理由：int4 权重走 torchao 的 tinygemm，**只在 cc ≥ 8.0 可用**。
    换到更老的卡上不该直接崩，而要由上层回落 int8/bf16 并说明原因
    （见 `docs/IRODORI-INTEGRATION-PLAN.md` §11 风险表第 2 条）。
    """
    info = probe()
    if not info["cuda"]:
        return None
    try:
        import torch  # noqa: PLC0415

        major, minor = torch.cuda.get_device_capability(0)
        return [int(major), int(minor)]
    except Exception:  # pragma: no cover - 环境相关
        return None


def device_name() -> Optional[str]:
    info = probe()
    if not info["cuda"]:
        return None
    try:
        import torch  # noqa: PLC0415

        return str(torch.cuda.get_device_name(0))
    except Exception:  # pragma: no cover - 环境相关
        return None


def _nvidia_smi_mb() -> Optional[tuple[int, int]]:
    """用 nvidia-smi 读物理空闲/总量（MB）。失败返回 None（没装驱动工具 / 解析异常）。

    为什么不用 `torch.cuda.mem_get_info` 当准数：实测同一时刻
    **torch 报 7099 MB 空闲、nvidia-smi 只报 2238 MB**（三次采样稳定，差值约 4.9 GB）。
    在 Windows WDDM 下 cudaMemGetInfo 看到的是「本进程的虚拟视图」，
    **看不见其它进程占的显存** —— 浏览器 / 安卓模拟器 / GPT-SoVITS 都不算进去。
    准入检查要判断的是「现在还装得下吗」，必须看进程外的真实占用，所以用 nvidia-smi。
    """
    try:
        import subprocess  # noqa: PLC0415

        result = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=memory.free,memory.total",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode != 0:
            return None
        first = result.stdout.strip().splitlines()[0]
        free, total = (int(float(part)) for part in first.split(",")[:2])
        return free, total
    except Exception:  # pragma: no cover - 环境相关
        return None


def vram_mb() -> Optional[dict[str, int]]:
    """当前显卡的总量/空闲显存（MB）。无 CUDA 时返回 None。

    `free_mb` 取 nvidia-smi（跨进程真实值），同时把 torch 的读数放在 `torch_free_mb`
    里做对照 —— 两个数字差很多时，说明显存被**别的进程**占着。
    """
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
    except Exception:  # pragma: no cover - 环境相关
        pass

    smi = _nvidia_smi_mb()
    if smi is None:
        if torch_free is None or total is None:
            return None
        return {
            "free_mb": torch_free,
            "total_mb": total,
            "torch_free_mb": torch_free,
            "source": "torch",
        }
    free, smi_total = smi
    return {
        "free_mb": free,
        "total_mb": total or smi_total,
        "torch_free_mb": torch_free if torch_free is not None else free,
        "source": "nvidia-smi",
    }


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
        else f"当前解释器未安装 torch：{info['error'] or '请先按 irodori/README.md 建 venv'}"
    )

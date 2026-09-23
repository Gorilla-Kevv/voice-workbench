"""运行环境探测。

两种探测方式，用途完全不同：

* `probe(executable)` —— **子进程**探测指定解释器。用在服务启动前：
  需要判断「当前解释器够不够用」，不够就换整合包自带的解释器重启自己。
  子进程的崩溃被隔离，探测失败只降级为「能力缺失」。
* `probe_current()` —— **进程内**探测自己。用在服务运行中：
  既然模型就在本进程里跑，直接问 torch 拿真实信息，比子进程准确得多，
  也没有额外开销。

两个函数都只依赖标准库 + 目标环境自身，绝不假设 torch 一定存在。
"""

from __future__ import annotations

import json
import platform
import shutil
import subprocess
import threading
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

PROBE_TIMEOUT_S = 120.0
_MARKER = "__PROBE__"

_PROBE_SCRIPT = r"""
import json, platform, sys, importlib

info = {
    "executable": sys.executable,
    "python_version": platform.python_version(),
    "torch_version": None,
    "cuda_version": None,
    "device_count": 0,
    "device_names": [],
    "vram_total_mb": None,
    "vram_free_mb": None,
    "libs": {},
    "torch_error": None,
}

try:
    import torch
    info["torch_version"] = torch.__version__
    info["cuda_version"] = getattr(torch.version, "cuda", None)
    if torch.cuda.is_available():
        info["device_count"] = torch.cuda.device_count()
        info["device_names"] = [torch.cuda.get_device_name(i) for i in range(torch.cuda.device_count())]
        free, total = torch.cuda.mem_get_info()
        info["vram_free_mb"] = round(free / 1024 / 1024)
        info["vram_total_mb"] = round(total / 1024 / 1024)
except Exception as exc:
    info["torch_error"] = "%s: %s" % (type(exc).__name__, exc)

for name in ("numpy", "librosa", "soundfile", "transformers", "peft", "torchaudio", "fastapi"):
    try:
        module = importlib.import_module(name)
        info["libs"][name] = getattr(module, "__version__", "unknown")
    except Exception:
        info["libs"][name] = None

print("__PROBE__" + json.dumps(info))
"""

#: 合成所需的库。缺任何一个都会在推理阶段以难懂的形式报错，因此提前列出。
REQUIRED_LIBS = ("numpy", "librosa", "soundfile", "transformers", "torchaudio")
#: 训练所需的库（ASR 用）
TRAIN_LIBS = ("peft",)


@dataclass
class RuntimeInfo:
    """一次探测的结果。全部字段都有安全默认值。"""

    executable: str = ""
    python_version: str = ""
    torch_version: Optional[str] = None
    cuda_version: Optional[str] = None
    device_count: int = 0
    device_names: List[str] = field(default_factory=list)
    vram_total_mb: Optional[int] = None
    vram_free_mb: Optional[int] = None
    libs: Dict[str, Optional[str]] = field(default_factory=dict)
    torch_error: Optional[str] = None
    probe_ok: bool = False
    probe_error: Optional[str] = None
    source: str = "subprocess"  # "subprocess" | "in-process"

    # ---------- 派生能力 ----------

    @property
    def has_torch(self) -> bool:
        return self.torch_version is not None

    @property
    def has_gpu(self) -> bool:
        return self.device_count > 0

    @property
    def device_label(self) -> str:
        if self.has_gpu:
            name = self.device_names[0] if self.device_names else "GPU"
            vram = " %dMB" % self.vram_total_mb if self.vram_total_mb else ""
            return "CUDA · %s%s" % (name, vram)
        if self.has_torch:
            return "CPU（torch 可用但未检测到 CUDA）"
        return "不可用（torch 未就绪）"

    @property
    def can_infer(self) -> bool:
        return self.has_torch and not self.missing_libs

    @property
    def missing_libs(self) -> List[str]:
        return [name for name in REQUIRED_LIBS if not self.libs.get(name)]

    @property
    def missing_train_libs(self) -> List[str]:
        return [name for name in TRAIN_LIBS if not self.libs.get(name)]

    def to_dict(self) -> Dict[str, Any]:
        return {
            "executable": self.executable,
            "python_version": self.python_version,
            "torch_version": self.torch_version,
            "cuda_version": self.cuda_version,
            "device_count": self.device_count,
            "device_names": self.device_names,
            "vram_total_mb": self.vram_total_mb,
            "vram_free_mb": self.vram_free_mb,
            "libs": dict(self.libs),
            "torch_error": self.torch_error,
            "probe_ok": self.probe_ok,
            "probe_error": self.probe_error,
            "source": self.source,
            "has_torch": self.has_torch,
            "has_gpu": self.has_gpu,
            "device_label": self.device_label,
            "can_infer": self.can_infer,
            "missing_libs": self.missing_libs,
            "missing_train_libs": self.missing_train_libs,
        }


# --------------------------------------------------------------------------
# 子进程探测（启动前，判断要不要换解释器）
# --------------------------------------------------------------------------


def _not_found(executable: str) -> RuntimeInfo:
    return RuntimeInfo(
        executable=executable,
        probe_ok=False,
        probe_error="解释器不存在或不可执行",
        source="subprocess",
    )


def probe(python_executable: str, timeout: float = PROBE_TIMEOUT_S) -> RuntimeInfo:
    """在指定解释器中执行探测脚本。任何异常都被降级处理。"""
    resolved = shutil.which(python_executable) or python_executable
    try:
        completed = subprocess.run(  # noqa: S603 - 解释器路径来自可信配置
            [resolved, "-c", _PROBE_SCRIPT],
            capture_output=True,
            text=True,
            timeout=timeout,
            encoding="utf-8",
            errors="replace",
        )
    except FileNotFoundError:
        return _not_found(python_executable)
    except subprocess.TimeoutExpired:
        return RuntimeInfo(
            executable=resolved,
            probe_ok=False,
            probe_error="探测超时（%.0fs）" % timeout,
            source="subprocess",
        )
    except Exception as exc:  # noqa: BLE001
        return RuntimeInfo(executable=resolved, probe_ok=False, probe_error=str(exc), source="subprocess")

    # 探测脚本可能打印其它输出（如 CUDA 初始化告警），只取带 marker 的那一行
    for line in (completed.stdout or "").splitlines():
        if line.startswith(_MARKER):
            try:
                payload = json.loads(line[len(_MARKER) :])
            except json.JSONDecodeError as exc:
                return RuntimeInfo(
                    executable=resolved,
                    probe_ok=False,
                    probe_error="结果解析失败：%s" % exc,
                    source="subprocess",
                )
            return RuntimeInfo(probe_ok=True, source="subprocess", **payload)

    stderr_tail = (completed.stderr or "").strip().splitlines()
    hint = stderr_tail[-1] if stderr_tail else "探测脚本无输出"
    return RuntimeInfo(
        executable=resolved,
        probe_ok=False,
        probe_error=hint[:400],
        source="subprocess",
    )


# --------------------------------------------------------------------------
# 进程内探测（运行中）
# --------------------------------------------------------------------------

_current: Optional[RuntimeInfo] = None
_current_lock = threading.Lock()


def probe_current(refresh: bool = False) -> RuntimeInfo:
    """探测当前进程自身。结果缓存，`refresh=True` 可强制重新探测。"""
    global _current
    with _current_lock:
        if _current is not None and not refresh:
            return _current
        _current = _probe_in_process()
        return _current


def _probe_in_process() -> RuntimeInfo:
    import importlib
    import sys

    info = RuntimeInfo(
        executable=sys.executable,
        python_version=platform.python_version(),
        probe_ok=True,
        source="in-process",
    )

    try:
        import torch  # noqa: PLC0415

        info.torch_version = getattr(torch, "__version__", "unknown")
        info.cuda_version = getattr(torch.version, "cuda", None)
        if torch.cuda.is_available():
            info.device_count = torch.cuda.device_count()
            info.device_names = [
                torch.cuda.get_device_name(index) for index in range(torch.cuda.device_count())
            ]
            try:
                free, total = torch.cuda.mem_get_info()
                info.vram_free_mb = int(free / 1024 / 1024)
                info.vram_total_mb = int(total / 1024 / 1024)
            except Exception:  # noqa: BLE001 - 部分驱动不支持 mem_get_info
                pass
    except Exception as exc:  # noqa: BLE001
        info.torch_error = "%s: %s" % (type(exc).__name__, exc)

    for name in ("numpy", "librosa", "soundfile", "transformers", "peft", "torchaudio", "fastapi"):
        try:
            module = importlib.import_module(name)
            info.libs[name] = getattr(module, "__version__", "unknown")
        except Exception:  # noqa: BLE001 - 库缺失是常态，不是错误
            info.libs[name] = None

    return info


def free_vram_mb() -> Optional[int]:
    """当前可用显存（MB）。未知时返回 None，调用方据此决定是否拦截。"""
    try:
        import torch  # noqa: PLC0415

        if not torch.cuda.is_available():
            return None
        free, _ = torch.cuda.mem_get_info()
        return int(free / 1024 / 1024)
    except Exception:  # noqa: BLE001
        return None


def host_python_version() -> str:
    return platform.python_version()

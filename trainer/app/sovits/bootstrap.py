"""GPT-SoVITS 安装定位与官方模块加载。

官方代码不是可 import 的库，而是一个「必须站在它自己的根目录下运行」的项目：

* `TTS.py` 里 `now_dir = os.getcwd()`，并用 `f"{now_dir}/GPT_SoVITS/pretrained_models/..."`
  拼接声码器路径 —— **cwd 必须是仓库根目录**；
* `from AR.models...`、`from sv import SV`、`from TTS_infer_pack...` 要求
  `GPT_SoVITS/` 在 `sys.path` 上；
* `from tools.i18n...` 要求仓库根目录在 `sys.path` 上。

因此本模块做三件事：**找目录 → 摆好路径 → 记录状态**，并且把「导入慢/导入失败」
都变成可读的状态而不是异常：

* 导入慢是正常的（首次 import 需加载 torch + transformers + peft，约 30~60 秒），
  所以这里只在真正需要时才导入，启动阶段不 import；
* 导入失败往往意味着环境不对，此时把原始异常原样保留，供 `/health` 展示。
"""

from __future__ import annotations

import os
import sys
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

from .. import discovery

# --------------------------------------------------------------------------
# 模块级状态（进程内唯一）
# --------------------------------------------------------------------------

_lock = threading.RLock()
_bootstrapped: Optional["Installation"] = None
_official: Optional["OfficialModules"] = None
_official_error: Optional[str] = None
_argv_guard = False


@dataclass
class Installation:
    """一次成功定位的结果。"""

    home: Path
    core_dir: Path
    layout: discovery.LayoutInfo
    python_executable: Optional[str] = None

    def path(self, relative: str) -> Path:
        """把相对仓库根目录的路径解析为绝对路径。"""
        return (self.home / relative).resolve()

    def exists(self, relative: str) -> bool:
        return self.path(relative).is_file()

    def to_dict(self) -> Dict[str, Any]:
        return {
            "home": str(self.home),
            "core_dir": str(self.core_dir),
            "python_executable": self.python_executable,
            "variant": self.layout.variant,
            "entries": {key: str(value) for key, value in self.layout.entries.items()},
            "missing": self.layout.missing,
            "can_infer": self.layout.can_infer,
            "can_train": self.layout.can_train,
            "gpt_weights": len(self.layout.gpt_weights),
            "sovits_weights": len(self.layout.sovits_weights),
        }


@dataclass
class OfficialModules:
    """官方模块句柄。字段名与官方符号一一对应，便于对照排查。"""

    TTS_Config: Any
    TTS: Any
    cut_method_names: List[str] = field(default_factory=list)
    #: 官方根目录的 `config` 模块，提供权威的设备/精度选择
    root_config: Any = None

    @property
    def cut_methods(self) -> List[str]:
        return list(self.cut_method_names)


def locate(explicit: Optional[str] = None, auto_discover: bool = True) -> Optional[Installation]:
    """定位 GPT-SoVITS 安装目录。`explicit` 优先，否则在常见位置浅层搜索。"""
    layout: Optional[discovery.LayoutInfo] = None
    if explicit:
        layout = discovery.inspect(Path(explicit).expanduser())
    if layout is None and auto_discover:
        layout = discovery.discover(None)
    if layout is None:
        return None
    return Installation(
        home=layout.home,
        core_dir=layout.core_dir,
        layout=layout,
        python_executable=layout.python_executable,
    )


def install(installation: Installation) -> Installation:
    """把安装目录登记为全局状态，并摆好 sys.path / cwd。幂等。"""
    global _bootstrapped
    with _lock:
        _bootstrapped = installation

        home = str(installation.home)
        core = str(installation.core_dir)
        # 顺序有讲究：官方脚本常常 `from text import ...`，
        # 而 `GPT_SoVITS/text` 才是正确的那个，因此它必须排在更前面。
        for entry in (home, core):
            if entry in sys.path:
                sys.path.remove(entry)
            sys.path.insert(0, entry)
        # 官方 prepare_datasets 脚本会用 `f"{now_dir}/GPT_SoVITS/..."`，
        # 而 `1-get-text.py` 还依赖 cwd 下的 `text/`，两者只能靠 cwd 同时满足。
        try:
            os.chdir(home)
        except OSError:
            pass
    return installation


def current() -> Optional[Installation]:
    return _bootstrapped


def require() -> Installation:
    if _bootstrapped is None:
        raise RuntimeError("尚未定位到 GPT-SoVITS 安装目录")
    return _bootstrapped


def _silence_argv() -> None:
    """官方 `TTS.py` 会在 import 期读取 `sys.argv[-1]` 判断界面语言。

    我们的服务有自己的命令行参数（如 `--port 9881`），虽不至于撞上语言名，
    但为了绝对确定性，导入官方模块期间把 argv 收敛到只留程序名。
    """
    global _argv_guard
    if _argv_guard:
        return
    _argv_guard = True


def official() -> OfficialModules:
    """加载官方模块。失败时抛出原始异常，由调用方转成可读状态。

    首次调用约耗时 30~60 秒（torch/transformers/peft 的导入成本），
    之后走缓存。
    """
    global _official, _official_error
    with _lock:
        if _official is not None:
            return _official
        installation = _bootstrapped
        if installation is None:
            raise RuntimeError("尚未定位到 GPT-SoVITS 安装目录，无法加载官方模块")

        saved_argv = list(sys.argv)
        _silence_argv()
        sys.argv = [saved_argv[0] if saved_argv else "trainer"]
        try:
            from GPT_SoVITS.TTS_infer_pack.TTS import TTS, TTS_Config  # type: ignore
            from GPT_SoVITS.TTS_infer_pack.text_segmentation_method import (  # type: ignore
                get_method_names,
            )

            root_config = _import_root_config(installation)
            modules = OfficialModules(
                TTS_Config=TTS_Config,
                TTS=TTS,
                cut_method_names=list(get_method_names()),
                root_config=root_config,
            )
        except Exception as exc:  # noqa: BLE001 - 需要把原始异常带给用户
            _official_error = "%s: %s" % (type(exc).__name__, exc)
            raise
        finally:
            sys.argv = saved_argv

        _official = modules
        _official_error = None
        return modules


def _import_root_config(installation: Installation) -> Any:
    """导入官方根目录的 `config.py`。

    它提供权威的设备选择逻辑（含 16 系显卡的 float32 特例）与 GPU 清单，
    比我们自己猜要可靠。若导入失败则返回 None，由上层退化为保守默认值。
    """
    try:
        import config as root_config  # type: ignore

        return root_config
    except Exception:  # noqa: BLE001 - 可选增强，失败不阻断
        return None


def official_error() -> Optional[str]:
    return _official_error


def is_loaded() -> bool:
    return _official is not None


def device_defaults() -> Dict[str, Any]:
    """返回官方推荐的 (device, is_half)。

    官方 `config.py` 会按显存、算力自动选择，并在 16 系显卡上强制 float32 —
    这是踩过坑的经验值，直接沿用比自造规则安全。
    """
    modules = _official
    root = getattr(modules, "root_config", None) if modules else None
    if root is not None:
        try:
            import torch  # noqa: PLC0415 - 只有走到这里才需要 torch

            available = bool(torch.cuda.is_available())
            device = str(getattr(root, "infer_device", "cpu"))
            is_half = bool(getattr(root, "is_half", False)) and available
            gpu_infos = list(getattr(root, "GPU_INFOS", []) or [])
            return {"device": device, "is_half": is_half, "gpu_infos": gpu_infos}
        except Exception:  # noqa: BLE001
            pass

    try:
        import torch  # noqa: PLC0415

        if torch.cuda.is_available():
            return {"device": "cuda:0", "is_half": True, "gpu_infos": [torch.cuda.get_device_name(0)]}
    except Exception:  # noqa: BLE001
        pass
    return {"device": "cpu", "is_half": False, "gpu_infos": []}


def to_dict() -> Dict[str, Any]:
    installation = _bootstrapped
    return {
        "home": str(installation.home) if installation else None,
        "found": installation is not None,
        "python_executable": installation.python_executable if installation else None,
        "modules_loaded": is_loaded(),
        "load_error": _official_error,
        "details": installation.to_dict() if installation else None,
    }

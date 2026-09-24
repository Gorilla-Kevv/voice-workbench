"""RVC 直连层：路径、环境变量与配置对象。

RVC（`vendor/rvc`，20240604 分支）对路径的要求比另两个上游更麻烦：

* `assets/hubert/hubert_base.pt` 是**硬编码**的相对路径
  （`infer/modules/vc/utils.py:24`），没有任何环境变量能改；
* `weight_root` / `index_root` / `rmvpe_root` 三个可以靠环境变量改，
  三个都得在 **import 之前**就设好；
* `configs/config.py` 的 `Config` 会在构造时 `parse_args()`，
  还会把 `configs/{v1,v2}/*.json` 复制到 `configs/inuse/` ——
  也就是往 vendor 目录里写文件。

对应的三条决策：

1. **推理期间临时 chdir 到 vendor 根目录**（`vendor_paths.working_directory`），
   用完还原。卸载时顺带清掉本次新进入 `sys.modules` 的顶层名。
2. 权重放 `vendor/rvc/assets/` —— 上游那里自己就 gitignore 了 `*`，
   放权重不会弄脏 submodule；模型库（我们自己管理的 .pth）另放在 `.data/vc/models`。
3. **不用上游的 `Config`**，改用一个鸭子类型的配置对象：
   `VC` 只用到 `device / is_half / x_pad / x_query / x_center / x_max` 六个字段，
   自己给既能避开 argparse，也不会往 vendor 里写 `configs/inuse/`。
"""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Optional

from .. import vendor_paths
from ..config import Settings

__all__ = [
    "vendor_root",
    "assets_dir",
    "models_dir",
    "ensure_ffmpeg",
    "prepare_env",
    "make_config",
    "import_vc",
    "VcError",
]


class VcError(Exception):
    """RVC 链路失败。消息可直接展示。"""

    def __init__(self, message: str, hint: str = "", code: str = "VC_FAILED") -> None:
        super().__init__(message)
        self.message = message
        self.hint = hint
        self.code = code


def vendor_root(settings: Settings) -> Path:
    root = Path(settings.rvc_dir)
    if not root.is_dir():
        raise VcError(
            "未找到 RVC 源码目录：%s" % root,
            hint="执行 git submodule update --init 拉取 vendor/rvc。",
            code="VENDOR_MISSING",
        )
    return root


def assets_dir(settings: Settings) -> Path:
    """RVC 的 `assets/`（hubert、rmvpe、预训练底模都在这下面）。"""
    return vendor_root(settings) / "assets"


def models_dir(settings: Settings) -> Path:
    """我们自己的模型库：`.pth` 与它对应的 `.index`。"""
    path = settings.vc_dir / "models"
    path.mkdir(parents=True, exist_ok=True)
    return path


def ensure_ffmpeg(settings: Settings) -> Optional[str]:
    """把 ffmpeg 放进 PATH —— RVC 读音频全靠它。

    `infer/lib/audio.py` 的 `load_audio()` 是起一个 `ffmpeg` 子进程来解码的
    （不是用 soundfile / librosa），系统里没有 ffmpeg 时每一次变声都会失败，
   而且报错藏在子进程里，很难定位。整合包自带 `runtime/ffmpeg.exe`，
   这里找到它并临时加进 PATH。
    """
    if shutil.which("ffmpeg"):
        return shutil.which("ffmpeg")

    candidates = []
    if settings.gpt_sovits_home:
        candidates.append(Path(settings.gpt_sovits_home) / "runtime")
    try:
        from ..sovits import bootstrap as sovits_bootstrap  # noqa: PLC0415

        installation = sovits_bootstrap.current()
        if installation is not None:
            candidates.append(installation.home / "runtime")
    except Exception:  # noqa: BLE001 - 拿不到整合包位置就只靠系统 PATH
        pass

    # 兜底：直接在项目同级找整合包（服务刚启动、整合包还没被定位时也能找到）
    try:
        from ..config import ROOT as _ROOT  # noqa: PLC0415

        for home in sorted(Path(_ROOT).parent.glob("GPT-SoVITS*")):
            candidates.append(home / "runtime")
    except Exception:  # noqa: BLE001
        pass

    for directory in candidates:
        for name in ("ffmpeg.exe", "ffmpeg"):
            executable = directory / name
            if executable.is_file():
                os.environ["PATH"] = "%s%s%s" % (str(directory), os.pathsep, os.environ.get("PATH", ""))
                return str(executable)
    return None


def prepare_env(settings: Settings) -> dict:
    """设置 RVC 认的三个环境变量，返回它们的值（便于排障时打印）。

    `index_root` 与 `weight_root` 指向同一个目录是有意的：
    `get_index_path_from_model()` 会在 `index_root` 下递归找 `.index`，
    并要求模型名（去扩展名）出现在索引路径里 ——
    把索引和模型放在一起，这个匹配天然成立。
    """
    root = vendor_root(settings)
    env = {
        "weight_root": str(models_dir(settings)),
        "index_root": str(models_dir(settings)),
        "rmvpe_root": str(assets_dir(settings) / "rmvpe"),
        "ffmpeg": ensure_ffmpeg(settings) or "",
    }
    os.environ.update(env)
    # RVC 的若干模块在 import 期就把 repo 根塞进 sys.path，这里保持一致
    entry = str(root)
    if entry not in sys.path:
        sys.path.insert(0, entry)
    env["vendor_root"] = entry
    return env


def make_config(device: Optional[str] = None, is_half: Optional[bool] = None) -> Any:
    """构造给 `VC` 用的配置对象（不用上游 `Config`，见模块文档）。"""
    try:
        import torch  # noqa: PLC0415

        cuda = torch.cuda.is_available()
        gpu_name = torch.cuda.get_device_name(0) if cuda else None
        gpu_mem = int(torch.cuda.get_device_properties(0).total_memory / 1024**3 + 0.4) if cuda else None
    except Exception:  # noqa: BLE001
        cuda, gpu_name, gpu_mem = False, None, None

    resolved_device = device or ("cuda:0" if cuda else "cpu")
    resolved_half = bool(cuda) if is_half is None else bool(is_half)
    # 老卡（16 系 / P40 / 10 系）在 fp16 下会出问题，官方也是强制 fp32
    if gpu_name and any(token in gpu_name for token in ("16", "P40", "P10", "1060", "1070", "1080")):
        if "V100" not in gpu_name.upper():
            resolved_half = False
    if gpu_mem is not None and gpu_mem <= 4:
        resolved_half = False

    if resolved_half:
        x_pad, x_query, x_center, x_max = 3, 10, 60, 65
    else:
        x_pad, x_query, x_center, x_max = 1, 6, 38, 41
    if gpu_mem is not None and gpu_mem <= 4:
        x_pad, x_query, x_center, x_max = 1, 5, 30, 32

    return SimpleNamespace(
        device=resolved_device,
        is_half=resolved_half,
        x_pad=x_pad,
        x_query=x_query,
        x_center=x_center,
        x_max=x_max,
        n_cpu=os.cpu_count() or 4,
        gpu_name=gpu_name,
        gpu_mem=gpu_mem,
        use_jit=False,
        dml=False,
    )


def import_vc(settings: Settings):
    """在临时上下文里导入 `VC` 类。"""
    root = vendor_root(settings)
    with vendor_paths.temporary_context(entries=[str(root)], cwd=str(root), argv=["rvc"]):
        from infer.modules.vc.modules import VC  # type: ignore  # noqa: PLC0415

        return VC

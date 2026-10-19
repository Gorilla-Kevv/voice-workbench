"""GPT-SoVITS v5 服务配置。

与 `indextts/app/config.py` 同构：环境变量 + 显式默认值，不做隐式推断。

v5 与老版 trainer :9881 的关系：**现阶段是并存**，而不是替换：
老版 py3.9 + torch 2.0 跑不动机 v5 的 py3.12 依赖树与 12 阶段流水线；
训练链路仍依赖老版，v5 现阶段**纯推理底模**（上游尚无 v5 训练配置）。
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

GSV5_DIR = Path(__file__).resolve().parent.parent
UPSTREAM_DIR = GSV5_DIR / "upstream"
VOICES_LIB_DIR = Path(os.environ.get("VOICES_LIB_DIR") or (GSV5_DIR.parent / "voicelib"))


def _env(name: str) -> str:
    return (os.environ.get(name) or "").strip()


VARIANTS = ("v5turbo", "v5dev")
DEFAULT_VARIANT = "v5turbo"
REQUIRED_VRAM_MB = {"v5turbo": 3072, "v5dev": 3584}


@dataclass
class Settings:
    port: int = 9885
    host: str = "127.0.0.1"
    upstream_dir: Path = UPSTREAM_DIR
    voices_lib_dir: Path = field(default_factory=lambda: VOICES_LIB_DIR)
    default_variant: str = DEFAULT_VARIANT
    device: str = "cuda"

    def __post_init__(self) -> None:
        if _env("GSV5_PORT"):
            self.port = int(_env("GSV5_PORT"))
        if _env("GSV5_HOST"):
            self.host = _env("GSV5_HOST")
        if _env("GSV5_DEVICE"):
            self.device = _env("GSV5_DEVICE")

    @property
    def pretrained_dir(self) -> Path:
        return self.upstream_dir / "GPT_SoVITS" / "pretrained_models"

    def variant_weights_path(self, variant: str) -> str:
        if variant not in VARIANTS:
            raise ValueError(f"未知 v5 变体：{variant}，可选：{'/'.join(VARIANTS)}")
        return f"GPT_SoVITS/pretrained_models/gsv-v5-pretrained/s2G{variant}.pth"

    def weights_ready(self) -> dict[str, bool]:
        root = self.pretrained_dir / "gsv-v5-pretrained"
        files = {
            "s2Gv5turbo.pth": root / "s2Gv5turbo.pth",
            "s2Gv5dev.pth": root / "s2Gv5dev.pth",
            "vocoder.pth": root / "vocoder.pth",
            "s1v3.ckpt": self.pretrained_dir / "s1v3.ckpt",
        }
        return {name: path.is_file() for name, path in files.items()}

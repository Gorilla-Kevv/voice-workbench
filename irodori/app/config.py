"""服务配置：全部来自环境变量，缺省值面向「开箱不启动模型」。

与 `netease/app/config.py` 同一风格：Settings 只承载数据与推导，
**绝不在模块级 import torch** —— 那样「没建 venv 就手滑跑起来」会直接崩在 import 上，
而不是给出一句「缺什么、去哪装」。重活留给各引擎的 lazy load。
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

#: irodori/ 目录（本文件向上两级）
IRODORI_DIR = Path(__file__).resolve().parent.parent
#: 项目根目录
PROJECT_DIR = IRODORI_DIR.parent
#: 权重与上游代码清单（唯一事实源，下载脚本也读它）
MANIFEST_PATH = IRODORI_DIR / "weights.manifest.json"

#: 各档的**净占**显存（MB）—— 准入检查的基准值，来自阶段 28 本机实测。
#:
#: ⚠️ 这是「净占」（加载后比加载前多占的量）。**引擎已加载时绝不能再算
#: 「空闲 − 这个值」**：它自己占的已经在 `free_mb` 里了，再减一次就是
#: 自己把自己检测成占用者（阶段 27补6 的坑 26）。已加载 → 直接判可跑。
REQUIRED_VRAM_MB: dict[str, int] = {
    #: int4-weight-only + --model-precision fp32，实测净占 ~4.6 GB
    "int4": 4700,
    #: bf16 基座（训练用），实测峰值 6131 MB
    "bf16": 6100,
    #: 只加载 DACVAE codec（数据整备 S2 用）。30-5 实测（RTX 4060 Laptop）：
    #:   codec 常驻净占 **483 MB**（nvidia-smi 口径，torch allocated 518 MB）；
    #:   编码峰值随片段长度涨：1s → 578 MB / 10s → 1111 MB / 30s → **2285 MB**
    #:   （torch 口径，不含 CUDA context）。取 2500 MB：撑得住 30s 的长片段，
    #:   又远低于推理档的 4700 MB（不该拿推理的门槛去卡一个只需要 codec 的任务）。
    "prepare": 2500,
}


def required_vram_mb(precision: str = "fp32", task: str = "infer") -> int:
    """准入基准（MB）。

    `task` 决定看哪一档：
    - `infer`：只按 int4 档报（`fp32` 与 `bf16` 在这套权重上差约 400MB，
      准入宁保守勿乐观 —— 差 400MB 卡住的代价远大于多等一会儿）；
    - `prepare`：数据整备只加载 codec，按 codec 档报（准备阶段把 TTS 模型卸载了，
      不该拿 4.7GB 去卡一个只需要 codec 的任务）。
    """
    _ = precision  # 保留参数：将来若换权重档要按精度分流
    if task == "prepare":
        return REQUIRED_VRAM_MB["prepare"]
    return REQUIRED_VRAM_MB["int4"]


def _env(name: str, default: str = "") -> str:
    value = os.environ.get(name)
    return value.strip() if value and value.strip() else default


@dataclass
class Settings:
    port: int = 9884
    host: str = "127.0.0.1"

    #: auto = 有 CUDA 用 CUDA，否则明确拒绝（不静默落 CPU）
    device: str = "auto"
    #: 只在显式设置 IRODORI_ALLOW_CPU=1 时才允许 CPU 推理：
    #: DiT 在 CPU 上 RTF 是几十倍，给了等于不可用，不如如实拒绝
    allow_cpu: bool = False

    #: 上游本体（官方代码零改动）。codec.py 会从 parents[2]/dacvae 回退找 dacvae，
    #: 所以 dacvae 必须与 Irodori-TTS 同级放在 upstream/ 下。
    upstream_dir: Path = field(default_factory=lambda: IRODORI_DIR / "upstream" / "Irodori-TTS")
    dacvae_dir: Path = field(default_factory=lambda: IRODORI_DIR / "upstream" / "dacvae")

    #: 权重根目录（gitignore）
    models_dir: Path = field(default_factory=lambda: IRODORI_DIR / "models")
    #: 推理档：int4-weight-only + fp32（阶段 28 实测最省显存且不比 bf16 慢）
    int4_dir: Path = field(default_factory=lambda: IRODORI_DIR / "models" / "irodori_v4.1_small_int4")
    #: 训练档：bf16 基座（量化检查点不能训练）
    bf16_dir: Path = field(default_factory=lambda: IRODORI_DIR / "models" / "irodori_bf16")
    #: DACVAE 编解码器权重
    codec_weights: Path = field(default_factory=lambda: IRODORI_DIR / "models" / "dacvae" / "weights.pth")

    #: 推理精度：fp32 是 int4 权重档的官方配套（bf16 在本机不快，只省 400MB）
    precision: str = "fp32"
    #: 采样步数默认档。用户 10.12 拍板：默认 20（RTF 0.246，F0 与时长和 40 步无差，且绕开长尾），
    #: 40 作为「最高质量」档保留。
    default_steps: int = 20
    #: 可选的步数档位（UI 下拉直接读它）
    step_presets: tuple[int, ...] = (20, 40)

    #: 采样设备侧超时（秒）—— 整条合成的墙钟预算（30-3 长尾护栏的最后兜底）。
    #: 长尾实测最坏 89s（40 步 + 某个坏 seed），180s 足够让「慢」的请求跑完，
    #: 同时保证真正卡死的请求不会把请求线程悬挂住。
    timeout_sec: float = 180.0
    #: 护栏降步档位（步）。采样撞上长尾时，剩余段落降到这个步数并换 seed。
    #: 依据：阶段 28 实测同一条命令 40 步 89.17s → 20 步 2.16s（评估文档 §6「采样长尾」）。
    downgrade_steps: int = 20
    #: 参考音频上限（秒）。官方建议 ~30s，120s 仍有收益但边际很小
    max_ref_seconds: float = 120.0

    # ---- 训练侧（30-5 起）----
    #: 训练步数档位。用户 10.12 拍板：先小档跑闭环，之后必须能升到 2000/3000。
    #: 「小档」取 400 步（方案给的区间是 300~500，以「能看出音色在收敛」为准），
    #: 30-6 用 bf16 基座实测收敛速度后回填真值 —— 在此之前它是**待验值**。
    smoke_steps: int = 400
    train_step_presets: tuple[int, ...] = (400, 1000, 2000, 3000)
    #: 自动 batch 探测的上限（方案 §6.4：实测 batch 8 = 2.2 s/步，再大没验过）
    max_train_batch: int = 8
    #: SI 训练实测速度（秒/步，batch 8 + 梯度检查点，4060 Laptop）—— 阶段 28 实测值，
    #: 只用于给用户算「大概要跑多久」，不是保证值。
    seconds_per_step: float = 2.2

    #: 任务/上传产物目录（gitignore）
    data_dir: Path = field(default_factory=lambda: IRODORI_DIR / ".data")
    uploads_dir: Path = field(default_factory=lambda: IRODORI_DIR / ".data" / "uploads")

    @classmethod
    def from_env(cls) -> "Settings":
        settings = cls(
            port=int(_env("IRODORI_PORT", "9884") or 9884),
            host=_env("IRODORI_HOST", "127.0.0.1") or "127.0.0.1",
            device=_env("IRODORI_DEVICE", "auto") or "auto",
            allow_cpu=_env("IRODORI_ALLOW_CPU") in {"1", "true", "yes", "on"},
            precision=_env("IRODORI_PRECISION", "fp32") or "fp32",
        )
        for key, env_name in (
            ("upstream_dir", "IRODORI_UPSTREAM"),
            ("dacvae_dir", "IRODORI_DACVAE"),
            ("models_dir", "IRODORI_MODELS"),
        ):
            raw = _env(env_name)
            if raw:
                setattr(settings, key, Path(raw).expanduser())
        try:
            settings.default_steps = int(_env("IRODORI_STEPS", "20") or 20)
        except ValueError:
            settings.default_steps = 20
        try:
            settings.timeout_sec = float(_env("IRODORI_TIMEOUT", "180") or 180)
        except ValueError:
            settings.timeout_sec = 180.0
        try:
            settings.downgrade_steps = int(_env("IRODORI_DOWNGRADE_STEPS", "20") or 20)
        except ValueError:
            settings.downgrade_steps = 20
        return settings

    # ------------------------------------------------------------------
    # 派生路径：跟着 models_dir 走，别各自算一遍
    # ------------------------------------------------------------------

    @property
    def jobs_dir(self) -> Path:
        """任务持久化目录（`<data_dir>/jobs`）。"""
        return self.data_dir / "jobs"

    @property
    def datasets_dir(self) -> Path:
        """整备好的数据集根目录（`<data_dir>/datasets/<id>/manifest.jsonl`）。"""
        return self.data_dir / "datasets"

    @property
    def int4_model_file(self) -> Path:
        return self.int4_dir / "model.safetensors"

    @property
    def bf16_model_file(self) -> Path:
        return self.bf16_dir / "model.safetensors"

    def target_path(self, relative: str) -> Path:
        """把清单里的 `target`（相对 irodori/ 的路径）解成绝对路径。"""
        return (IRODORI_DIR / relative).resolve()

    def as_dict(self) -> dict[str, Any]:
        return {
            "upstream_dir": str(self.upstream_dir),
            "dacvae_dir": str(self.dacvae_dir),
            "models_dir": str(self.models_dir),
            "int4_dir": str(self.int4_dir),
            "bf16_dir": str(self.bf16_dir),
            "codec_weights": str(self.codec_weights),
            "precision": self.precision,
            "default_steps": self.default_steps,
            "step_presets": list(self.step_presets),
            "timeout_sec": self.timeout_sec,
            "downgrade_steps": self.downgrade_steps,
            "max_ref_seconds": self.max_ref_seconds,
            "allow_cpu": self.allow_cpu,
            "device": self.device,
            "data_dir": str(self.data_dir),
            "uploads_dir": str(self.uploads_dir),
            "datasets_dir": str(self.datasets_dir),
            "jobs_dir": str(self.jobs_dir),
            "smoke_steps": self.smoke_steps,
            "train_step_presets": list(self.train_step_presets),
            "max_train_batch": self.max_train_batch,
            "seconds_per_step": self.seconds_per_step,
        }


def load_manifest(path: Optional[Path] = None) -> dict[str, Any]:
    """读权重/代码清单。文件缺失时返回空结构而不是抛异常 —— 探活要能照常回答。"""
    target = path or MANIFEST_PATH
    try:
        return json.loads(target.read_text(encoding="utf-8"))
    except Exception:
        return {"entries": [], "code": [], "totalBytes": {}}

"""CosyVoice3 服务配置。

与 `irodori/app/config.py` 同一风格：Settings 只承载数据与推导，
**绝不在模块级 import torch** —— 没建 venv 就手滑跑起来时，
要给出的是一句「缺什么、去哪装」，而不是崩在 import 上。

这里的模型是 **Fun-CosyVoice3-0.5B-2512**（Apache-2.0，24kHz，9 语言 + 18 中文方言）。
权重以本地目录为准；上游 `AutoModel` 只看目录里的 `cosyvoice3.yaml` 判断模型类型。
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

COSYVOICE_DIR = Path(__file__).resolve().parent.parent
PROJECT_DIR = COSYVOICE_DIR.parent
MANIFEST_PATH = COSYVOICE_DIR / "weights.manifest.json"

#: 推理档净占显存（MB）。阶段 48 真机冒烟后按实测校准：
#: 0.5B LLM + flow DiT + hift + ONNX 分词器，fp16 估计 2.5~3.5GB；
#: 先取 4096 作为保守准入值，宁可加载前拦下，也不要让模型溢出共享内存假死。
REQUIRED_VRAM_MB = 4096


def _env(name: str, default: str = "") -> str:
    value = os.environ.get(name)
    return value.strip() if value and value.strip() else default


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


@dataclass
class Settings:
    port: int = 9886
    host: str = "127.0.0.1"

    #: auto = 有 CUDA 用 CUDA，否则明确拒绝（CPU 的 RTF 约 2.5，等于不可用）
    device: str = "auto"
    allow_cpu: bool = False
    #: 官方支持 fp16；Windows 8GB 卡上这是把权重压进 3GB 级的关键
    fp16: bool = True

    upstream_dir: Path = field(default_factory=lambda: COSYVOICE_DIR / "upstream" / "CosyVoice")
    model_dir: Path = field(default_factory=lambda: COSYVOICE_DIR / "models" / "Fun-CosyVoice3-0.5B")
    data_dir: Path = field(default_factory=lambda: COSYVOICE_DIR / ".data")

    #: 24kHz（cosyvoice3.yaml 的 sample_rate，服务端真源）
    sample_rate: int = 24000
    min_ref_seconds: float = 1.0
    max_ref_seconds: float = 30.0
    max_text_length: int = 3000
    #: 合成墙钟上限（秒）。上游没有可中断的采样 hook，超时只能让调用方放弃，
    #: 这里只用于给出可读的超时错误，不负责杀 CUDA 线程。
    timeout_sec: float = 240.0

    #: 默认 llm 权重；官方另带 llm.rl.pt（CER 更低），可用 COSYVOICE_LLM_FILE 切换
    llm_file: str = "llm.pt"

    @classmethod
    def from_env(cls) -> "Settings":
        settings = cls(
            port=int(_env("COSYVOICE_PORT", "9886") or 9886),
            host=_env("COSYVOICE_HOST", "127.0.0.1") or "127.0.0.1",
            device=_env("COSYVOICE_DEVICE", "auto") or "auto",
            allow_cpu=_env_bool("COSYVOICE_ALLOW_CPU", False),
            fp16=_env_bool("COSYVOICE_FP16", True),
            llm_file=_env("COSYVOICE_LLM_FILE", "llm.pt") or "llm.pt",
        )
        for key, env_name in (
            ("upstream_dir", "COSYVOICE_UPSTREAM"),
            ("model_dir", "COSYVOICE_MODELS"),
            ("data_dir", "COSYVOICE_DATA"),
        ):
            raw = _env(env_name)
            if raw:
                setattr(settings, key, Path(raw).expanduser())
        for name, cast in (("min_ref_seconds", float), ("max_ref_seconds", float), ("timeout_sec", float)):
            raw = _env("COSYVOICE_" + name.upper())
            if not raw:
                continue
            try:
                setattr(settings, name, cast(raw))
            except ValueError:
                pass
        return settings

    @property
    def outputs_dir(self) -> Path:
        return self.data_dir / "outputs"

    @property
    def voicelib_dir(self) -> Path:
        root = os.environ.get("VOICES_LIB_DIR") or str(PROJECT_DIR / "voicelib")
        return Path(root)

    def target_path(self, relative: str) -> Path:
        return (COSYVOICE_DIR / relative).resolve()

    def as_dict(self) -> dict[str, Any]:
        return {
            "upstream_dir": str(self.upstream_dir),
            "model_dir": str(self.model_dir),
            "data_dir": str(self.data_dir),
            "sample_rate": self.sample_rate,
            "fp16": self.fp16,
            "llm_file": self.llm_file,
            "device": self.device,
            "allow_cpu": self.allow_cpu,
            "min_ref_seconds": self.min_ref_seconds,
            "max_ref_seconds": self.max_ref_seconds,
            "max_text_length": self.max_text_length,
            "timeout_sec": self.timeout_sec,
        }


def load_manifest(path: Optional[Path] = None) -> dict[str, Any]:
    target = path or MANIFEST_PATH
    try:
        return json.loads(target.read_text(encoding="utf-8"))
    except Exception:
        return {"entries": [], "code": [], "totalBytes": {}}

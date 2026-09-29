"""服务配置：全部来自环境变量，缺省值面向「开箱不启动模型」。

与 `trainer/app/config.py` 同一风格：Settings 只承载数据与推导，
不做任何 import torch 之类的重活 —— 那些留给各引擎的 lazy load。
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

#: netease/ 目录（本文件向上两级）
NETEASE_DIR = Path(__file__).resolve().parent.parent
#: 项目根目录
PROJECT_DIR = NETEASE_DIR.parent


def _env(name: str, default: str = "") -> str:
    value = os.environ.get(name)
    return value.strip() if value and value.strip() else default


@dataclass
class Settings:
    port: int = 9882
    host: str = "127.0.0.1"

    #: auto = 有 CUDA 用 CUDA，否则明确拒绝（不静默落 CPU）
    device: str = "auto"
    #: 仅在显式设置 NETEASE_ALLOW_CPU=1 时才允许 CPU 推理：
    #: 1.3B LLM 在 CPU 上 RTF 是几十倍，给了等于不可用，不如如实拒绝
    allow_cpu: bool = False

    #: Confucius4-TTS 仓库目录（含 config/inference_config.yaml 与 checkpoints/ 的分词器）
    #: 默认指向 `models-src/Confucius4-TTS`（按 netease/README.md 克隆的上游仓库）。
    #: ⚠️ 权重本体不在这里 —— 上游 `confuciustts` 用 hf_hub_download 只认 HF 缓存，
    #: 权重下载见 `scripts/download_netease_weights.py`。
    tts_home: Path = field(default_factory=lambda: NETEASE_DIR / "models-src" / "Confucius4-TTS")
    #: TTS 推理配置；留空则用 <tts_home>/config/inference_config.yaml
    tts_config: Path | None = None
    #: 推理精度：fp16（8 GB 卡的默认）/ fp32（更高保真，但 1.3B TTS 装不下）
    precision: str = "fp16"

    #: R2T2 模型：本地目录或 HF repo id（允许 repo id 是因为上游支持按名自动下载）
    r2t2_model: str = ""
    #: R2T2 worker 的解释器。默认与服务同解释器；TTS/R2T2 依赖冲突时可指向另一个 venv
    r2t2_python: str = ""
    #: vLLM gpu_memory_utilization：8 GB 卡上给 TTS 留余量，宁低勿满
    r2t2_gpu_util: float = 0.35
    r2t2_max_model_len: int = 16384
    r2t2_max_new_tokens: int = 4096
    #: R2T2 后端：vllm（上游推荐）。llama.cpp 形态差异大，不在本期支持范围
    r2t2_backend: str = "vllm"

    #: 任务产物目录（合成/转写输出落盘在这里，便于排障）
    data_dir: Path = field(default_factory=lambda: NETEASE_DIR / ".data")
    uploads_dir: Path = field(default_factory=lambda: NETEASE_DIR / ".data" / "uploads")

    @classmethod
    def from_env(cls) -> "Settings":
        settings = cls(
            port=int(_env("NETEASE_PORT", "9882") or 9882),
            host=_env("NETEASE_HOST", "127.0.0.1") or "127.0.0.1",
            device=_env("NETEASE_DEVICE", "auto") or "auto",
            allow_cpu=_env("NETEASE_ALLOW_CPU") in {"1", "true", "yes", "on"},
            r2t2_model=_env("NETEASE_R2T2_MODEL"),
            r2t2_python=_env("NETEASE_R2T2_PYTHON"),
            r2t2_backend=_env("NETEASE_R2T2_BACKEND", "vllm") or "vllm",
        )
        try:
            settings.r2t2_gpu_util = float(_env("NETEASE_R2T2_GPU_UTIL", "0.35") or 0.35)
        except ValueError:
            settings.r2t2_gpu_util = 0.35
        try:
            settings.r2t2_max_model_len = int(_env("NETEASE_R2T2_MAX_MODEL_LEN", "16384") or 16384)
        except ValueError:
            settings.r2t2_max_model_len = 16384
        try:
            settings.r2t2_max_new_tokens = int(_env("NETEASE_R2T2_MAX_NEW_TOKENS", "4096") or 4096)
        except ValueError:
            settings.r2t2_max_new_tokens = 4096

        settings.precision = (_env("NETEASE_TTS_PRECISION", "fp16") or "fp16").lower()
        if settings.precision not in {"fp16", "fp32"}:
            settings.precision = "fp16"
        home = _env("NETEASE_TTS_HOME")
        if home:
            settings.tts_home = Path(home)
        config = _env("NETEASE_TTS_CONFIG")
        settings.tts_config = Path(config) if config else None
        data = _env("NETEASE_DATA_DIR")
        if data:
            settings.data_dir = Path(data)
            settings.uploads_dir = Path(data) / "uploads"
        return settings

    @property
    def resolved_tts_config(self) -> Path:
        return self.tts_config if self.tts_config else self.tts_home / "config" / "inference_config.yaml"

    @property
    def resolved_r2t2_model(self) -> str:
        """R2T2 模型标识：优先本地目录，其次环境变量里的 HF repo id。"""
        if self.r2t2_model:
            return self.r2t2_model
        local = NETEASE_DIR / "models" / "Confucius4-R2T2"
        if local.exists():
            return str(local)
        return "netease-youdao/Confucius4-R2T2"

    @property
    def resolved_r2t2_python(self) -> str:
        return self.r2t2_python or "python"

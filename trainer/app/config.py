"""运行时配置。

本模块只依赖标准库，因此即使 torch / GPT-SoVITS 缺失，
服务依然能启动并返回可读的体检结果，而不是直接崩溃 —— 这是本地工具的基本礼貌。

配置全部来自环境变量（见 `trainer/.env.example`），
命令行参数在 `server.py` 里落到环境变量，保证全局只有一份配置。
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass, field, replace
from enum import Enum
from pathlib import Path
from typing import List, Optional

#: 项目内的 trainer/ 目录。模块导入期即解析为绝对路径，
#: 这样后面 chdir 到 GPT-SoVITS 根目录也不会影响数据目录的定位。
ROOT = Path(__file__).resolve().parents[1]


class DeployMode(str, Enum):
    """部署模式。

    本项目定位为**本地部署**，因此 `local` 是唯一需要认真维护的模式；
    `public` 保留用于局域网共享（例如工作室里几个人共用一台带显卡的机器），
    它只是额外打开了鉴权、配额与显存准入。
    """

    LOCAL = "local"
    PUBLIC = "public"


def _env_str(name: str, default: str = "") -> str:
    return (os.getenv(name) or default).strip()


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _env_float(name: str, default: float) -> float:
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _env_bool(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _env_list(name: str, default: List[str]) -> List[str]:
    raw = os.getenv(name)
    if not raw or not raw.strip():
        return default
    return [item.strip() for item in raw.split(",") if item.strip()]


def _env_quota(name: str, default: Optional[int]) -> Optional[int]:
    """读取配额。0 或负数表示不限制（返回 None）。"""
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return None if value <= 0 else value


def _resolve_mode() -> DeployMode:
    raw = _env_str("TTS_MODE", "local").lower()
    return DeployMode.PUBLIC if raw in {"public", "server", "shared", "lan"} else DeployMode.LOCAL


#: 本机常用开发端口，默认全部放行，省去本地调试时的跨域麻烦
LOCAL_ORIGINS = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:8787",
    "http://127.0.0.1:8787",
    "http://localhost:4173",
    "http://127.0.0.1:4173",
]

#: 允许上传的音频后缀（音色库 + 语料）
AUDIO_SUFFIXES = {".wav", ".mp3", ".flac", ".ogg", ".m4a", ".webm", ".aac", ".wma"}


@dataclass(frozen=True)
class Settings:
    mode: DeployMode = DeployMode.LOCAL

    # ---------- 网络 ----------
    host: str = "127.0.0.1"
    port: int = 9881

    # ---------- GPT-SoVITS 定位（留空则自动搜索） ----------
    gpt_sovits_home: Optional[Path] = None
    auto_discover: bool = True

    # ---------- 推理默认值 ----------
    default_version: str = "v2ProPlus"
    default_prompt_lang: str = "zh"
    #: "auto" 表示交给官方 `config.py` 按显存与算力决定
    device: str = "auto"
    #: None 表示跟随设备自动决定
    is_half: Optional[bool] = None
    #: 启动后在后台线程预加载模型，让第一个请求不必等 1 分钟
    warmup: bool = True
    #: 单次合成文本上限（字符），覆盖 catalog 的自保阈值
    max_text_length: int = 0

    # ---------- 资源调度 ----------
    max_infer_concurrency: int = 1
    max_train_concurrency: int = 1
    max_queue_size: int = 32
    vram_reserve_mb: int = 512
    infer_timeout_s: float = 600.0
    train_timeout_s: float = 72 * 3600.0
    #: 批量合成的条目上限
    max_batch_items: int = 200

    # ---------- 配额与鉴权（仅 public 模式生效） ----------
    daily_infer_quota: Optional[int] = None
    daily_train_quota: Optional[int] = None
    admin_token: str = ""

    # ---------- 跨域 ----------
    allow_origins: List[str] = field(default_factory=list)

    # ---------- 上游（vendor/）与权重 ----------
    #: 两个上游仓库的位置（git submodule）。留空则用默认值
    vendor_dir: Path = field(default_factory=lambda: ROOT.parent / "vendor")
    #: 预训练权重与训练产物的根目录（不进版本库，见 .gitignore）
    models_dir: Path = field(default_factory=lambda: ROOT.parent / "models")

    # ---------- UVR5 分离默认值 ----------
    #: 默认分离档位（见 audio/uvr5_catalog.py）
    uvr_preset: str = "vocal_fast"
    #: 默认导出格式。wav 兼容性最好，后续环节都要再读一遍
    uvr_format: str = "wav"
    #: 人声提取激进程度（0~20，仅 VR 架构生效）
    uvr_agg: int = 10
    #: 分离与特征的中间结果是否复用（换音色重跑时跳过，最省时的一环）
    uvr_cache_enabled: bool = True

    # ---------- ASR 语音转文本默认值 ----------
    #: 默认后端；留空表示自动（常驻通道优先，其次整合包里的官方脚本）
    asr_backend: str = ""
    #: 官方脚本的尺寸语义（tiny~large）；常驻通道另有模型标识，见 asr/catalog.py
    asr_size: str = "large"
    asr_language: str = "zh"
    asr_precision: str = "float32"
    #: 常驻通道的设备；"auto" 交给后端自己决定
    asr_device: str = "auto"
    #: 同一段音频 + 同一组参数只转写一次（音色库反复导入同一素材时最省时）
    asr_cache_enabled: bool = True

    # ---------- 存储 ----------
    data_dir: Path = field(default_factory=lambda: ROOT / ".data")
    #: 输出音频保留天数（0 表示不清理）
    output_retention_days: int = 30

    # ---------- 行为开关 ----------
    dry_run: bool = False
    verbose: bool = False
    skip_ready_check: bool = False

    # ---------- 派生目录 ----------

    @property
    def is_public(self) -> bool:
        return self.mode is DeployMode.PUBLIC

    @property
    def jobs_dir(self) -> Path:
        return self.data_dir / "jobs"

    @property
    def uploads_dir(self) -> Path:
        return self.data_dir / "uploads"

    @property
    def outputs_dir(self) -> Path:
        return self.data_dir / "outputs"

    @property
    def voices_dir(self) -> Path:
        return self.data_dir / "voices"

    @property
    def experiments_dir(self) -> Path:
        return self.data_dir / "experiments"

    # ---------- 新板块的派生目录 ----------

    @property
    def cache_dir(self) -> Path:
        """中间结果缓存：分离产物、F0 与内容特征。"""
        return self.data_dir / "cache"

    @property
    def vc_dir(self) -> Path:
        """语音变声（RVC）：模型库、LoRA 适配器、融合产物、实验。"""
        return self.data_dir / "vc"

    @property
    def svc_dir(self) -> Path:
        """歌声转换（DDSP-SVC）：音色模型、实验。"""
        return self.data_dir / "svc"

    @property
    def asr_dir(self) -> Path:
        """语音转文本（ASR）：数据集、转写工作区、脚本通道产物。"""
        return self.data_dir / "asr"

    @property
    def separation_dir(self) -> Path:
        """分离产物的默认落盘位置（未命中缓存时的独立任务）。"""
        return self.outputs_dir / "separation"

    @property
    def rvc_dir(self) -> Path:
        return self.vendor_dir / "rvc"

    @property
    def ddsp_dir(self) -> Path:
        return self.vendor_dir / "ddsp-svc"

    @property
    def pretrained_dir(self) -> Path:
        return self.models_dir / "pretrained"

    @property
    def checkpoints_dir(self) -> Path:
        return self.models_dir / "checkpoints"

    # ---------- 构造 ----------

    @classmethod
    def from_env(cls) -> "Settings":
        mode = _resolve_mode()

        if mode is DeployMode.PUBLIC:
            defaults = {
                "host": "0.0.0.0",
                "port": 9881,
                "max_infer_concurrency": 2,
                "max_train_concurrency": 1,
                "max_queue_size": 200,
                "daily_infer_quota": 500,
                "daily_train_quota": 10,
                "allow_origins": ["*"],
                "warmup": False,
            }
        else:
            defaults = {
                "host": "127.0.0.1",
                "port": 9881,
                "max_infer_concurrency": 1,
                "max_train_concurrency": 1,
                "max_queue_size": 32,
                "daily_infer_quota": None,
                "daily_train_quota": None,
                "allow_origins": list(LOCAL_ORIGINS),
                "warmup": True,
            }

        home = _env_str("GPT_SOVITS_HOME")
        data_dir = Path(_env_str("TTS_DATA_DIR", str(ROOT / ".data"))).expanduser()
        vendor_dir = Path(_env_str("VENDOR_DIR", str(ROOT.parent / "vendor"))).expanduser()
        models_dir = Path(_env_str("MODELS_DIR", str(ROOT.parent / "models"))).expanduser()

        raw_half = _env_str("TTS_IS_HALF").lower()
        is_half: Optional[bool] = None
        if raw_half in {"1", "true", "yes", "on"}:
            is_half = True
        elif raw_half in {"0", "false", "no", "off"}:
            is_half = False

        return cls(
            mode=mode,
            host=_env_str("HOST", defaults["host"]),
            port=_env_int("PORT", defaults["port"]),
            gpt_sovits_home=Path(home).expanduser() if home else None,
            auto_discover=_env_bool("TTS_AUTO_DISCOVER", True),
            default_version=_env_str("TTS_DEFAULT_VERSION", "v2ProPlus"),
            default_prompt_lang=_env_str("TTS_DEFAULT_PROMPT_LANG", "zh"),
            device=_env_str("TTS_DEVICE", "auto") or "auto",
            is_half=is_half,
            warmup=_env_bool("TTS_WARMUP", defaults["warmup"]),
            max_text_length=_env_int("MAX_TEXT_LENGTH", 0),
            max_infer_concurrency=_env_int("MAX_INFER_CONCURRENCY", defaults["max_infer_concurrency"]),
            max_train_concurrency=_env_int("MAX_TRAIN_CONCURRENCY", defaults["max_train_concurrency"]),
            max_queue_size=_env_int("MAX_QUEUE_SIZE", defaults["max_queue_size"]),
            vram_reserve_mb=_env_int("VRAM_RESERVE_MB", 512),
            infer_timeout_s=_env_float("INFER_TIMEOUT_S", 600.0),
            train_timeout_s=_env_float("TRAIN_TIMEOUT_S", 72 * 3600.0),
            max_batch_items=_env_int("MAX_BATCH_ITEMS", 200),
            daily_infer_quota=_env_quota("DAILY_INFER_QUOTA", defaults["daily_infer_quota"]),
            daily_train_quota=_env_quota("DAILY_TRAIN_QUOTA", defaults["daily_train_quota"]),
            admin_token=_env_str("ADMIN_TOKEN"),
            allow_origins=_env_list("ALLOW_ORIGINS", defaults["allow_origins"]),
            vendor_dir=vendor_dir,
            models_dir=models_dir,
            uvr_preset=_env_str("UVR_PRESET", "vocal_fast"),
            uvr_format=_env_str("UVR_FORMAT", "wav"),
            uvr_agg=_env_int("UVR_AGG", 10),
            uvr_cache_enabled=_env_bool("UVR_CACHE", True),
            asr_backend=_env_str("ASR_BACKEND"),
            asr_size=_env_str("ASR_SIZE", "large"),
            asr_language=_env_str("ASR_LANGUAGE", "zh"),
            asr_precision=_env_str("ASR_PRECISION", "float32"),
            asr_device=_env_str("ASR_DEVICE", "auto") or "auto",
            asr_cache_enabled=_env_bool("ASR_CACHE", True),
            data_dir=data_dir,
            output_retention_days=_env_int("OUTPUT_RETENTION_DAYS", 30),
            dry_run=_env_bool("TTS_DRY_RUN", False),
            verbose=_env_bool("TTS_VERBOSE", False),
            skip_ready_check=_env_bool("TTS_SKIP_READY_CHECK", False),
        )

    # ---------- 校验 ----------

    def warnings(self) -> List[str]:
        """配置层面的风险提示，随 `/health` 暴露给用户自查。"""
        tips: List[str] = []
        if self.skip_ready_check:
            tips.append("已旁路就绪校验（TTS_SKIP_READY_CHECK），失败信息可能不够直观")
        if self.is_public:
            if not self.admin_token:
                tips.append("public 模式未设置 ADMIN_TOKEN，训练类接口处于无鉴权状态")
            if "*" in self.allow_origins:
                tips.append("跨域白名单为 *，建议收敛为实际的访问来源")
        elif self.host not in {"127.0.0.1", "localhost", "::1"}:
            tips.append(
                "local 模式却监听了 %s，若非局域网共享用途请改回 127.0.0.1" % self.host
            )
        if self.device != "auto":
            tips.append("已手动指定设备 %s（TTS_DEVICE），自动选择逻辑被跳过" % self.device)
        return tips

    def effective_max_text_length(self) -> int:
        if self.max_text_length > 0:
            return self.max_text_length
        from .sovits import catalog  # 局部导入，避免配置模块依赖业务模块

        return catalog.MAX_TEXT_LENGTH

    def with_home(self, home: Path) -> "Settings":
        return replace(self, gpt_sovits_home=home)

    def ensure_dirs(self) -> None:
        for path in (
            self.data_dir,
            self.jobs_dir,
            self.uploads_dir,
            self.outputs_dir,
            self.voices_dir,
            self.experiments_dir,
            # 两个新板块：缓存、语音变声、歌声转换
            self.cache_dir,
            self.vc_dir,
            self.svc_dir,
            # 语音转文本：数据集与转写工作区
            self.asr_dir,
        ):
            path.mkdir(parents=True, exist_ok=True)

    # ---------- 运行环境自述 ----------

    def to_dict(self) -> dict:
        return {
            "mode": self.mode.value,
            "host": self.host,
            "port": self.port,
            "gpt_sovits_home": str(self.gpt_sovits_home) if self.gpt_sovits_home else None,
            "data_dir": str(self.data_dir),
            "vendor_dir": str(self.vendor_dir),
            "models_dir": str(self.models_dir),
            "rvc_dir": str(self.rvc_dir),
            "ddsp_dir": str(self.ddsp_dir),
            "uvr_preset": self.uvr_preset,
            "uvr_format": self.uvr_format,
            "uvr_agg": self.uvr_agg,
            "uvr_cache_enabled": self.uvr_cache_enabled,
            "asr_backend": self.asr_backend or "auto",
            "asr_size": self.asr_size,
            "asr_language": self.asr_language,
            "asr_precision": self.asr_precision,
            "asr_device": self.asr_device,
            "asr_cache_enabled": self.asr_cache_enabled,
            "asr_dir": str(self.asr_dir),
            "default_version": self.default_version,
            "default_prompt_lang": self.default_prompt_lang,
            "device": self.device,
            "is_half": self.is_half,
            "warmup": self.warmup,
            "max_text_length": self.effective_max_text_length(),
            "max_batch_items": self.max_batch_items,
            "infer_concurrency": self.max_infer_concurrency,
            "train_concurrency": self.max_train_concurrency,
            "allow_origins": list(self.allow_origins),
            "python": sys.version.split()[0],
            "executable": sys.executable,
        }

"""预训练权重清单与体检。

两个新板块各自需要一堆几百 MB 的预训练权重，而且**来源与落点都不一样**：

* RVC 把 `assets/hubert/hubert_base.pt`、`assets/rmvpe/rmvpe.pt` 写死成相对路径
  （环境变量只能改 `weight_root` / `index_root` / `rmvpe_root` 三个），
  所以它们必须落在 `vendor/rvc/assets/` 下 —— 那里上游自己就 gitignore 了 `*`，
  放权重不会弄脏 submodule；
* DDSP-SVC 的三处相对路径（`pretrain/rmvpe/model.pt`、`vocoder.ckpt`、
  `encoder_ckpt`）我们全部改成了绝对路径传参（见 `svc/bootstrap.py`），
  因此它们可以老老实实躺在 `models/pretrained/ddsp/` 里，受本仓库的 `models/` 忽略规则保护。

把这份清单集中在这里，是为了让「缺哪个权重、去哪下」成为 `/health` 能回答的问题，
而不是等用户点了开始才在日志里看到一个 FileNotFoundError。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional

from .config import Settings


@dataclass
class WeightSpec:
    """一个预训练权重的落点与来源。"""

    key: str
    engine: str
    #: 相对 `base` 的路径（含文件名）
    relative: str
    #: 主下载地址
    url: str = ""
    #: 备用镜像（下载失败时依次尝试）
    mirrors: List[str] = field(default_factory=list)
    #: 体积（MB），仅用于给下载量一个预期
    size_mb: float = 0.0
    description: str = ""
    #: 是否推理必需（False 表示只有训练或可选编码器需要）
    required: bool = True

    def to_dict(self) -> dict:
        return {
            "key": self.key,
            "engine": self.engine,
            "relative": self.relative,
            "url": self.url,
            "mirrors": list(self.mirrors),
            "size_mb": self.size_mb,
            "description": self.description,
            "required": self.required,
        }


#: RVC 的权重落在 vendor 内（上游硬编码相对路径，且该目录已被上游 gitignore）
RVC_BASE = "vendor"
#: DDSP-SVC 的权重落在仓库根的 models/ 下（本仓库 .gitignore 已忽略）
DDSP_BASE = "models"

_HF_RVC = "https://huggingface.co/lj1995/VoiceConversionWebUI/resolve/main/"
_HF_RVC_MIRROR = "https://hf-mirror.com/lj1995/VoiceConversionWebUI/resolve/main/"

WEIGHTS: List[WeightSpec] = [
    # ---------------- RVC（语音变声） ----------------
    WeightSpec(
        key="rvc_hubert",
        engine="rvc",
        relative="assets/hubert/hubert_base.pt",
        url=_HF_RVC + "hubert_base.pt",
        mirrors=[_HF_RVC_MIRROR + "hubert_base.pt"],
        size_mb=378.0,
        description="RVC 内容特征提取器（推理必需）",
    ),
    WeightSpec(
        key="rvc_rmvpe",
        engine="rvc",
        relative="assets/rmvpe/rmvpe.pt",
        url=_HF_RVC + "rmvpe.pt",
        mirrors=[_HF_RVC_MIRROR + "rmvpe.pt"],
        size_mb=58.0,
        description="RVC 默认 F0 提取器（rmvpe 方法需要）",
    ),
    # 注意：20240604 分支的 `configs/v2/` 只有 32k 与 48k（没有 40k），
    # 所以 v2 训练底模取 32k —— 体积更小、8GB 显卡上更稳。
    WeightSpec(
        key="rvc_pretrained_g",
        engine="rvc",
        relative="assets/pretrained_v2/f0G32k.pth",
        url=_HF_RVC + "pretrained_v2/f0G32k.pth",
        mirrors=[_HF_RVC_MIRROR + "pretrained_v2/f0G32k.pth"],
        size_mb=84.0,
        description="RVC v2 32k 生成器底模（仅训练需要）",
        required=False,
    ),
    WeightSpec(
        key="rvc_pretrained_d",
        engine="rvc",
        relative="assets/pretrained_v2/f0D32k.pth",
        url=_HF_RVC + "pretrained_v2/f0D32k.pth",
        mirrors=[_HF_RVC_MIRROR + "pretrained_v2/f0D32k.pth"],
        size_mb=54.0,
        description="RVC v2 32k 判别器底模（仅训练需要）",
        required=False,
    ),
    # ---------------- DDSP-SVC（歌声转换） ----------------
    WeightSpec(
        key="ddsp_contentvec",
        engine="svc",
        relative="ddsp/contentvec/pytorch_model.bin",
        url="https://huggingface.co/lengyue233/content-vec-best/resolve/main/pytorch_model.bin",
        mirrors=["https://hf-mirror.com/lengyue233/content-vec-best/resolve/main/pytorch_model.bin"],
        size_mb=300.0,
        description="DDSP-SVC 默认内容编码器（config 里 encoder=contentvec768l12*）",
    ),
    WeightSpec(
        key="ddsp_nsf_hifigan",
        engine="svc",
        relative="ddsp/nsf_hifigan/model",
        url=(
            "https://github.com/openvpi/vocoders/releases/download/"
            "pc-nsf-hifigan-44.1k-hop512-128bin-2025.02/pc_nsf_hifigan_44.1k_hop512_128bin_2025.02.zip"
        ),
        mirrors=[],
        size_mb=60.0,
        description="DDSP-SVC 声码器权重（zip 需解压，同目录还要有 config.json）",
    ),
    WeightSpec(
        key="ddsp_rmvpe",
        engine="svc",
        relative="ddsp/rmvpe/model.pt",
        url="https://github.com/yxlllc/RMVPE/releases/download/230917/rmvpe.zip",
        mirrors=[],
        size_mb=58.0,
        description="DDSP-SVC 默认 F0 提取器（zip 需解压）",
    ),
    WeightSpec(
        key="ddsp_hubertsoft",
        engine="svc",
        relative="ddsp/hubert/hubert-soft-0d54a1f4.pt",
        url="https://github.com/bshall/hubert/releases/download/v0.1/hubert-soft-0d54a1f4.pt",
        mirrors=[],
        size_mb=360.0,
        description="可选的轻量编码器（config 里 encoder=hubertsoft 时才需要）",
        required=False,
    ),
]


def base_dir(spec: WeightSpec, settings: Settings) -> Path:
    """权重的根目录。

    RVC 落在 `vendor/rvc/` 内（上游硬编码相对路径），DDSP-SVC 落在仓库根的
    `models/` 下（`relative` 里已经带了 `pretrained/ddsp/` 前缀，所以基目录是
    `models_dir` 而不是 `pretrained_dir`，否则会拼出 `models/pretrained/pretrained/`）。
    """
    if spec.engine == "rvc":
        return Path(settings.rvc_dir)
    return Path(settings.pretrained_dir)


def target_path(spec: WeightSpec, settings: Settings) -> Path:
    return base_dir(spec, settings) / spec.relative


def audit(settings: Settings, engine: Optional[str] = None) -> Dict[str, Any]:
    """体检：列出缺失与已就位的权重。

    返回结构按引擎分组，供 `/health` 与两个板块的页面直接使用。
    """
    result: Dict[str, Any] = {"engines": {}, "missing": [], "present": []}
    for spec in WEIGHTS:
        if engine and spec.engine != engine:
            continue
        path = target_path(spec, settings)
        exists = path.is_file()
        entry = spec.to_dict()
        entry["path"] = str(path)
        entry["exists"] = exists
        bucket = result["engines"].setdefault(spec.engine, {"present": [], "missing": []})
        bucket["present" if exists else "missing"].append(entry)
        (result["present"] if exists else result["missing"]).append(entry["key"])
    return result


def blockers(settings: Settings, engine: Optional[str] = None) -> List[str]:
    """把缺失的**必需**权重翻译成一句可执行的提示。

    只报 `required=True` 的：训练底模、可选编码器缺了只是少一项能力，
    不该把整个板块标成不可用。
    """
    report = audit(settings, engine)
    messages: List[str] = []
    for key in report["missing"]:
        spec = next((w for w in WEIGHTS if w.key == key), None)
        if spec is None or not spec.required:
            continue
        messages.append(
            "缺少%s：%s（%s），应放在 %s"
            % (spec.engine.upper(), spec.description, Path(spec.relative).name, target_path(spec, settings))
        )
    return messages

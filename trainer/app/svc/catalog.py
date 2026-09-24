"""DDSP-SVC 的能力清单：音色模型、音质档位、参数取值。

这里有一件必须说清的事：**6.x 分支已经没有「增强器」和「浅扩散」了**。
老版本 DDSP-SVC（4.x/5.x）界面上的 enhancer / shallow diffusion 开关，
在 6.x 里被 Rectified Flow 取代 —— 全仓检索 `enhancer|shallow_diffusion`
只命中注释与借来的网络代码，config.yaml 里也没有对应字段。

所以界面上不要照搬旧版的「增强器」下拉框。等价的旋钮是这些（都在 config.yaml 里）：

* `infer.infer_step` —— 采样步数，越大越精细也越慢（默认 50）；
* `infer.method` —— `euler` / `rk4`；
* `model.t_start` —— 从哪一步开始做 Rectified Flow；`>= 1.0` 等价于「只跑 DDSP」，
  速度最快、音色最"电"，恰好覆盖了老版"关掉后处理"的用法。

把它们打包成三档音质预设，比让用户自己填三个数字实用得多。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List

import yaml  # noqa: PLC0415

from ..config import Settings

#: 音质档位。t_start 为 None 表示沿用 config.yaml 的值
QUALITY_PRESETS: List[Dict[str, Any]] = [
    {
        "key": "fast",
        "label": "快速",
        "infer_step": 20,
        "method": "euler",
        "t_start": 0.7,
        "hint": "先出效果再决定要不要精修；一首 4 分钟的歌约 1 分钟",
    },
    {
        "key": "standard",
        "label": "标准",
        "infer_step": 50,
        "method": "euler",
        "t_start": None,
        "hint": "config.yaml 的默认配置，质量与速度的平衡点",
    },
    {
        "key": "quality",
        "label": "高质",
        "infer_step": 100,
        "method": "rk4",
        "t_start": None,
        "hint": "rk4 采样 + 更多步数，明显更慢，细节与气息更好",
    },
    {
        "key": "raw",
        "label": "纯 DDSP",
        "infer_step": 10,
        "method": "euler",
        "t_start": 1.0,
        "hint": "跳过 Rectified Flow（相当于老版关掉后处理），最快、音色偏电子",
    },
]

#: F0 提取方法。与 `ddsp/vocoder.py` 的 F0_Extractor 支持项一致
F0_METHODS: List[Dict[str, str]] = [
    {"key": "rmvpe", "label": "rmvpe", "hint": "默认；需要 pretrain/rmvpe/model.pt"},
    {"key": "crepe", "label": "crepe", "hint": "质量好但慢，需要 torchcrepe"},
    {"key": "fcpe", "label": "fcpe", "hint": "快的神经网络方案，需要 torchfcpe"},
    {"key": "parselmouth", "label": "parselmouth", "hint": "Praat 实现，CPU 即可"},
    {"key": "dio", "label": "dio", "hint": "pyworld，速度快"},
    {"key": "harvest", "label": "harvest", "hint": "pyworld，更准但慢"},
]

#: 音色模型（.pt + 同目录 config.yaml）的存放位置
MODEL_DIRS = ("models",)


def quality_preset(key: str) -> Dict[str, Any]:
    for item in QUALITY_PRESETS:
        if item["key"] == key:
            return item
    return QUALITY_PRESETS[1]


def model_dirs(settings: Settings) -> List[Path]:
    """音色模型的搜索目录：`.data/svc/models` 与 `models/checkpoints/ddsp`。"""
    return [
        settings.svc_dir / "models",
        settings.checkpoints_dir / "ddsp",
    ]


def describe_model(path: Path) -> Dict[str, Any]:
    """读取模型同目录的 config.yaml，抽出界面需要的字段。"""
    entry: Dict[str, Any] = {
        "id": path.stem,
        "name": path.stem,
        "path": str(path),
        "size_mb": round(path.stat().st_size / 1024 / 1024, 1),
        "has_config": False,
    }
    config = path.parent / "config.yaml"
    if config.is_file():
        entry["has_config"] = True
        try:
            with config.open("r", encoding="utf-8") as handle:
                args = yaml.safe_load(handle) or {}
            data = args.get("data") or {}
            entry.update(
                {
                    "sample_rate": data.get("sampling_rate"),
                    "encoder": data.get("encoder"),
                    "f0_extractor": data.get("f0_extractor"),
                    "n_spk": (args.get("model") or {}).get("n_spk", 1),
                    "block_size": data.get("block_size"),
                }
            )
            entry["name"] = path.parent.name if path.parent.name else path.stem
        except (OSError, ValueError, yaml.YAMLError) as exc:
            entry["config_error"] = str(exc)
    return entry


def list_models(settings: Settings) -> List[Dict[str, Any]]:
    """列出本机可用的歌声转换音色模型。

    没有 config.yaml 的模型也会被列出，但标成不可用并说明原因 ——
    让用户看见「为什么选不了」，比给一个点了才报错的下拉框好。
    """
    models: List[Dict[str, Any]] = []
    seen = set()
    for directory in model_dirs(settings):
        if not directory.is_dir():
            continue
        for path in sorted(directory.rglob("*.pt")):
            key = str(path.resolve())
            if key in seen:
                continue
            seen.add(key)
            entry = describe_model(path)
            entry["available"] = bool(entry.get("has_config"))
            if not entry["available"]:
                entry["hint"] = "缺少同目录的 config.yaml，无法加载"
            models.append(entry)
    return models


def to_public(settings: Settings) -> Dict[str, Any]:
    """给 `/v1/svc/catalog` 用。"""
    return {
        "quality_presets": QUALITY_PRESETS,
        "f0_methods": F0_METHODS,
        "models": list_models(settings),
        "model_dirs": [str(p) for p in model_dirs(settings)],
    }

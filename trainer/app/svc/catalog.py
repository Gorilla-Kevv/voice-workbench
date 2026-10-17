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
    """音色模型的搜索目录：规范根 `models/ddsp-svc` 优先，两个旧根保留为只读兼容。

    顺序遵循「逐根闭环」的查找约定（先精确后递归，命中即停）：
    规范根里的同名模型必须赢过旧根，否则收口后用户在新根放的模型永远选不中。
    """
    return [
        settings.svc_models_dir,
        settings.svc_dir / "models",
        settings.checkpoints_dir / "ddsp",
    ]


def describe_model(path: Path) -> Dict[str, Any]:
    """读取模型同目录的 config.yaml，抽出界面需要的字段。

    `id` 的取值有个坑：DDSP-SVC 官方导出的权重几乎都叫 `model.pt`，
    真正区分音色的是**所在目录名**（`<expdir>/model.pt`）。所以只要模型
    位于自己的子目录里，就用目录名当 id / name，否则同名模型会在下拉框里
    挤成一堆 `model`、`model`、`model`。落回文件名是为了照顾
    「一堆 .pt 平铺在 models/ 下」这种非标准摆法。
    """
    in_own_dir = path.parent != path.parent.parent and path.parent.name
    label = path.parent.name if in_own_dir else path.stem
    entry: Dict[str, Any] = {
        "id": label,
        "name": label,
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
        except (OSError, ValueError, yaml.YAMLError) as exc:
            entry["config_error"] = str(exc)
    return entry


def find_model(settings: Settings, key: str) -> Path | None:
    """按 id / 名称 / 路径找一个音色模型。

    先当路径处理（前端可能直接传 `catalog` 里原样带回来的 `path`），
    再退回按 id 匹配 —— 与 `/v1/svc/models/load` 的解析口径保持一致。
    """
    wanted = (key or "").strip()
    if not wanted:
        return None
    # 路径形态：盘符 / UNC / 已存在的文件
    if _looks_like_path(wanted):
        candidate = Path(wanted)
        if candidate.is_file() and candidate.suffix.lower() == ".pt":
            return candidate
    for entry in list_models(settings):
        if entry.get("id") == wanted or entry.get("name") == wanted:
            path = entry.get("path")
            if path and Path(path).is_file():
                return Path(path)
    return None


def _looks_like_path(value: str) -> bool:
    if len(value) > 1 and value[1] == ":":
        return True
    return value.startswith("\\\\") or "/" in value or "\\" in value


def delete_model(settings: Settings, key: str) -> Dict[str, Any]:
    """删除一个音色模型（.pt 与同目录 config.yaml 一起）。

    config.yaml 与 .pt 是一个整体（没有它模型不可加载），所以必须一起删，
    否则会留下一堆「看得见、选不了」的幽灵条目。只删我们管辖的两个目录内的
    文件 —— 直接传外部路径进来时拒绝，避免把用户别处的模型误删。
    """
    path = find_model(settings, key)
    if path is None:
        return {"ok": False, "message": "未找到模型：%s" % key}

    resolved = path.resolve()
    allowed = False
    for directory in model_dirs(settings):
        if not directory.is_dir():
            continue
        try:
            resolved.relative_to(directory.resolve())
            allowed = True
            break
        except ValueError:
            continue
    if not allowed:
        return {"ok": False, "message": "该模型不在音色库目录内，未删除：%s" % resolved}

    removed = [str(resolved)]
    config = resolved.parent / "config.yaml"
    if config.is_file():
        config.unlink()
        removed.append(str(config))
    resolved.unlink()
    return {"ok": True, "removed": removed, "message": "已删除 %s" % resolved.stem}


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

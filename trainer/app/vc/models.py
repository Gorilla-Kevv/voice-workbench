"""RVC 模型库：`.pth` 音色模型与它的检索索引。

RVC 的一个音色 = 一个 `.pth` 权重 + 一个可选的 `.index`（faiss 检索索引）。
索引不是必需的，但有了它能明显提升音色相似度；官方要求索引文件名里
**包含模型名**（`get_index_path_from_model` 的匹配条件），我们直接把它们放在
同一个目录下天然满足。

模型文件本身不带多少可读信息，所以这里会 `torch.load` 出 config 段，
把采样率、是否带 f0、版本、说话人数读出来 —— 界面要显示这些，
用户才知道「这个模型是 40k 还是 32k」「有没有 F0」。
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from ..config import Settings
from .bootstrap import models_dir

__all__ = ["list_models", "describe", "find_model", "index_path_for", "delete_model"]


def _read_meta(path: Path) -> Dict[str, Any]:
    """从 ckpt 里读出模型结构与训练信息（只读配置段，不碰权重）。"""
    meta: Dict[str, Any] = {
        "id": path.stem,
        "name": path.stem,
        "path": str(path),
        "size_mb": round(path.stat().st_size / 1024 / 1024, 1),
        "modified_at": int(path.stat().st_mtime),
    }
    try:
        import torch  # noqa: PLC0415

        ckpt = torch.load(str(path), map_location="cpu")
    except Exception as exc:  # noqa: BLE001 - 读不出元数据也要能列出来
        meta["meta_error"] = str(exc)
        return meta

    config = ckpt.get("config") or []
    weight = ckpt.get("weight") or {}
    if isinstance(config, list) and config:
        meta["sample_rate"] = config[-1]
        meta["version"] = ckpt.get("version", "v1")
        meta["f0"] = bool(ckpt.get("f0", 1))
        if len(config) > 3:
            meta["n_spk"] = config[-3]
    emb = weight.get("emb_g.weight") if isinstance(weight, dict) else None
    if emb is not None and hasattr(emb, "shape"):
        meta["n_spk"] = int(emb.shape[0])
    meta["info"] = ckpt.get("info") or ""
    del ckpt
    return meta


def index_path_for(path: Path) -> Optional[Path]:
    """找到与模型配套的 `.index`（与官方匹配规则一致：路径里含模型名，且非 trained_）。"""
    stem = Path(path).stem
    directory = Path(path).parent
    for candidate in sorted(directory.glob("*.index")):
        if "trained" in candidate.name:
            continue
        if stem in candidate.name:
            return candidate
    return None


def describe(path: Path) -> Dict[str, Any]:
    """单个模型的完整信息（含索引是否存在）。"""
    meta = _read_meta(Path(path))
    index = index_path_for(Path(path))
    meta["has_index"] = index is not None
    meta["index"] = str(index) if index else None
    meta["index_mb"] = round(index.stat().st_size / 1024 / 1024, 1) if index else 0.0
    return meta


def list_models(settings: Settings) -> List[Dict[str, Any]]:
    """列出模型库里的全部音色。"""
    directory = models_dir(settings)
    models = [describe(path) for path in sorted(directory.glob("*.pth"))]
    models.sort(key=lambda item: -(item.get("modified_at") or 0))
    return models


def find_model(settings: Settings, key: str) -> Optional[Path]:
    """按 id 或文件名定位模型。"""
    directory = models_dir(settings)
    direct = directory / key
    if direct.is_file():
        return direct
    if not key.endswith(".pth"):
        direct = directory / ("%s.pth" % key)
        if direct.is_file():
            return direct
    for path in sorted(directory.glob("*.pth")):
        if path.stem == key:
            return path
    return None


def delete_model(settings: Settings, key: str) -> Dict[str, Any]:
    """删除一个音色（权重 + 索引）。

    索引与权重同名同目录，一起删掉，避免出现「孤儿索引」——
    它不会报错，只会在下次加载时静默地被匹配上。
    """
    path = find_model(settings, key)
    if path is None:
        return {"ok": False, "message": "未找到模型：%s" % key}
    removed = [str(path)]
    index = index_path_for(path)
    if index:
        index.unlink(missing_ok=True)
        removed.append(str(index))
    path.unlink(missing_ok=True)
    return {"ok": True, "removed": removed, "message": "已删除 %s" % path.stem}

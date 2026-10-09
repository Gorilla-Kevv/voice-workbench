"""RVC 模型库：`.pth` 音色模型与它的检索索引。

RVC 的一个音色 = 一个 `.pth` 权重 + 一个可选的 `.index`（faiss 检索索引）。
索引不是必需的，但有了它能明显提升音色相似度；官方要求索引文件名里
**包含模型名**（`get_index_path_from_model` 的匹配条件），我们直接把它们放在
同一个目录下天然满足。

模型文件本身不带多少可读信息，所以这里会 `torch.load` 出 config 段，
把采样率、是否带 f0、版本、说话人数读出来 —— 界面要显示这些，
用户才知道「这个模型是 40k 还是 32k」「有没有 F0」。

## P0 起的两个变化

1. **多根 + 递归扫描**。改前只扫 `trainer/.data/vc/models/` 的**一层** `*.pth`，
   于是用户按「角色组」建的嵌套目录（`models/RVC语音模型/MYGO全员/<角色>/`）
   **从未被看到过**。现在按 `Settings.rvc_model_search_dirs` 逐根递归（深度 ≤2），
   扁平放与建子目录放都能识别。
2. **索引配对改成「同目录 + 同 basename」优先**。改前靠「索引路径里含模型名」，
   在嵌套目录下会误配（`MYGO全员/乐奈/` 下的两个模型可能互相抢索引）。
   保留子串匹配作为兜底，因为官方 `get_index_path_from_model()` 就是这么找的。
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from ..config import Settings
from .bootstrap import models_dir, models_dirs

__all__ = [
    "list_models",
    "describe",
    "find_model",
    "index_path_for",
    "delete_model",
    "rename_model",
    "search_roots",
]

#: 每个搜索根的递归深度上限。够覆盖「扁平放」与「一模型一目录」；
#: 用户的 `models/RVC语音模型/<组>/<角色>/` 是 2 层，所以取 2。
_MAX_DEPTH = 2

#: `_read_meta` 的缓存：`torch.load` 一个 50MB 的 ckpt 不便宜，
#: 而列表面板会反复调用。按 (路径, mtime, size) 缓存，文件一变自然失效。
_META_CACHE: Dict[Tuple[str, float, int], Dict[str, Any]] = {}


def search_roots(settings: Settings) -> List[Path]:
    """所有存在的搜索根（去重 + 只保留目录）。"""
    roots: List[Path] = []
    for candidate in models_dirs(settings):
        if candidate.is_dir() and candidate not in roots:
            roots.append(candidate)
    return roots


def _walk_pth(root: Path, depth: int = 0) -> List[Path]:
    """在 root 下递归找 `*.pth`（深度受限）。"""
    found: List[Path] = []
    if depth > _MAX_DEPTH:
        return found
    try:
        entries = sorted(root.iterdir())
    except OSError:
        return found
    for entry in entries:
        if entry.is_file() and entry.suffix.lower() == ".pth":
            found.append(entry)
        elif entry.is_dir() and not entry.name.startswith("."):
            found.extend(_walk_pth(entry, depth + 1))
    return found


def _read_meta(path: Path) -> Dict[str, Any]:
    """从 ckpt 里读出模型结构与训练信息（只读配置段，不碰权重）。"""
    try:
        stat = path.stat()
    except OSError:
        stat = None
    cache_key = (str(path), stat.st_mtime if stat else 0.0, stat.st_size if stat else 0)
    cached = _META_CACHE.get(cache_key)
    if cached is not None:
        return dict(cached)

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
        _META_CACHE[cache_key] = dict(meta)
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
    _META_CACHE[cache_key] = dict(meta)
    return meta


def index_path_for(path: Path) -> Optional[Path]:
    """找到与模型配套的 `.index`。

    两轮匹配，**精确优先**：
      1. 同目录 + 同 basename（`lenai.pth` ↔ `lenai.index`）—— 我们自己的约定，
         也是嵌套目录下唯一不会误配的方式；
      2. 同目录 + 文件名含模型名（官方 `get_index_path_from_model` 的规则）——
         兜底覆盖 `added_IVF256_lenai.index` 这类命名。

    两轮都排除含 `trained` 的文件（训练中间产物，不是检索索引）。
    """
    path = Path(path)
    stem = path.stem
    directory = path.parent

    candidates = [item for item in sorted(directory.glob("*.index")) if "trained" not in item.name]

    for candidate in candidates:
        if candidate.stem == stem:
            return candidate
    for candidate in candidates:
        if stem in candidate.name:
            return candidate
    return None



def describe(path: Path) -> Dict[str, Any]:
    """单个模型的完整信息（含索引是否存在、所在搜索根）。"""
    path = Path(path)
    meta = _read_meta(path)
    index = index_path_for(path)
    meta["has_index"] = index is not None
    meta["index"] = str(index) if index else None
    meta["index_mb"] = round(index.stat().st_size / 1024 / 1024, 1) if index else 0.0
    # 相对某个搜索根的目录（`/` 分隔，跨平台一致），前端用它展示「在哪个组里」
    meta["rel_dir"] = str(path.parent)
    meta["is_flat"] = True
    return meta


def list_models(settings: Settings) -> List[Dict[str, Any]]:
    """列出**所有搜索根**下的全部音色（递归，深度受限）。

    去重按绝对路径：同一个模型不会因为同时命中两个根而出现两次
    （例如用户把 `models/rvc` 软链到旧目录时）。
    """
    seen: set[str] = set()
    models: List[Dict[str, Any]] = []
    for root in search_roots(settings):
        for path in _walk_pth(root):
            key = str(path.resolve())
            if key in seen:
                continue
            seen.add(key)
            item = describe(path)
            # 标注它落在哪个根下、是否已在规范位置 —— 界面据此提示「建议迁移」
            item["root"] = str(root)
            item["in_canonical_root"] = root == models_dir(settings)
            models.append(item)
    models.sort(key=lambda item: -(item.get("modified_at") or 0))
    return models


def find_model(settings: Settings, key: str) -> Optional[Path]:
    """按 id / 文件名 / 相对路径定位模型（跨全部搜索根）。

    接受三种形态：绝对路径、相对某个根的路径、纯文件名或 stem。

    **必须逐根「先精确后递归」地找完，再换下一根** —— 不能先把所有根的
    相对路径试一遍再统一递归：那样低优先级根里的扁平文件会抢先命中，
    用户在新根（或嵌套目录）里放的同名模型永远选不中。
    （实测踩过：`models/RVC语音模型/MYGO全员/乐奈/lenai.pth` 输给了
     `.data/vc/models/lenai.pth`。）
    """
    if not key:
        return None

    direct = Path(key)
    if direct.is_absolute() and direct.is_file():
        return direct

    name = key if key.lower().endswith(".pth") else "%s.pth" % key

    for root in search_roots(settings):
        # 1) 该根下的相对路径（`MYGO全员/乐奈/lenai` 或带 `.pth`）
        candidate = root / name
        if candidate.is_file():
            return candidate
        # 2) 该根下的递归匹配（纯文件名 / stem）
        for path in _walk_pth(root):
            if path.name == name or path.stem == key:
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


def rename_model(settings: Settings, key: str, new_name: str) -> Dict[str, Any]:
    """重命名一个音色（权重 + 配套索引一起改）。

    索引必须跟着改名：官方 `get_index_path_from_model()` 靠「索引文件名里含模型名」
    来配对，只改 `.pth` 会让索引当场失配（不报错，只是静默用不上，听感悄悄变差）。

    新名称走 `training.sanitize_name()` 规范化 —— 用户可能输入 `我的音色 v2`（带空格，
    没问题）或 `a/b`（Windows 下非法），统一处理后才落盘。
    """
    from .training import sanitize_name  # noqa: PLC0415 - 放函数内避免循环导入

    path = find_model(settings, key)
    if path is None:
        return {"ok": False, "message": "未找到模型：%s" % key}

    clean = sanitize_name(new_name, fallback=path.stem)
    if clean == path.stem:
        return {"ok": True, "renamed": [], "name": clean, "message": "名称未变化"}

    target = path.with_name("%s.pth" % clean)
    if target.exists():
        return {"ok": False, "message": "已存在同名音色：%s" % clean}

    index = index_path_for(path)
    renamed: List[str] = []
    path.rename(target)
    renamed.append(str(target))
    if index is not None:
        # 保留原索引名的后缀风格（有的叫 a.index，有的叫 added_IVF256_a.index）
        index_target = index.with_name(index.name.replace(path.stem, clean, 1))
        index.rename(index_target)
        renamed.append(str(index_target))
    return {"ok": True, "renamed": renamed, "name": clean, "path": str(target), "message": "已重命名为 %s" % clean}


"""中间结果缓存。

歌声转换的完整链路里，「UVR5 分离」和「F0 / 内容特征提取」两项占了绝大部分耗时，
而它们与「用哪个音色」无关 —— 同一首歌换五个音色翻唱，分离与特征只需要做一次。

缓存键 = 音频内容指纹 + 阶段 + 规范化参数。这样：

* 换音色、换转调 → 命中（只重跑转换与混音）；
* 换分离模型、换 agg → 不命中（本来就该重跑）；
* 文件改名、复制一份 → 仍命中（指纹不含文件名与 mtime）。

产物放在 `trainer/.data/cache/<stage>/<key>/`，带一份 `meta.json` 说明它是什么、
由什么参数产生 —— 缓存最怕的是「不知道这份东西是哪来的」，宁可多写一个文件。
"""

from __future__ import annotations

import json
import shutil
import time
from pathlib import Path
from typing import Any, Dict, Mapping, Optional

from .io import fingerprint

__all__ = ["cache_key", "ArtifactCache"]


def cache_key(src: Path, stage: str, params: Optional[Mapping[str, Any]] = None) -> str:
    """计算缓存键。参数先规范化（按键排序 + 全部转字符串）再参与哈希。"""
    payload = {
        "src": fingerprint(Path(src)),
        "stage": stage,
        "params": {str(k): str(v) for k, v in sorted((params or {}).items())},
    }
    import hashlib  # noqa: PLC0415

    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode("utf-8")).hexdigest()[:32]


class ArtifactCache:
    """按阶段组织的文件级缓存。"""

    def __init__(self, root: Path) -> None:
        self.root = Path(root)

    # ---------- 查询 ----------

    def dir_for(self, key: str, stage: str) -> Path:
        return self.root / stage / key[:2] / key

    def find(self, key: str, stage: str) -> Optional[Dict[str, Any]]:
        """命中返回 meta（含绝对路径）；缺失或产物不全返回 None。

        「产物不全」当没命中：上一次跑到一半被取消，目录里会留下半个结果，
        照着 meta 去读就会拿到一个不存在的路径。
        """
        entry = self.dir_for(key, stage)
        meta_path = entry / "meta.json"
        if not meta_path.is_file():
            return None
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        for name, relative in (meta.get("files") or {}).items():
            if not (entry / relative).is_file():
                return None
        meta["_dir"] = str(entry)
        meta["files"] = {name: str(entry / relative) for name, relative in (meta.get("files") or {}).items()}
        return meta

    # ---------- 写入 ----------

    def store(
        self,
        key: str,
        stage: str,
        files: Mapping[str, Path],
        params: Optional[Mapping[str, Any]] = None,
        note: str = "",
    ) -> Dict[str, Any]:
        """把一组产物收进缓存。`files` 是 逻辑名 → 源文件路径。"""
        entry = self.dir_for(key, stage)
        entry.mkdir(parents=True, exist_ok=True)

        stored: Dict[str, str] = {}
        for name, source in files.items():
            source = Path(source)
            if not source.is_file():
                continue
            target = entry / ("%s%s" % (name, source.suffix))
            if source.resolve() != target.resolve():
                shutil.copy2(str(source), str(target))
            stored[name] = target.name

        meta = {
            "key": key,
            "stage": stage,
            "params": {str(k): str(v) for k, v in sorted((params or {}).items())},
            "files": stored,
            "note": note,
            "created_at": int(time.time()),
        }
        (entry / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
        meta["_dir"] = str(entry)
        meta["files"] = {name: str(entry / relative) for name, relative in stored.items()}
        return meta

    # ---------- 维护 ----------

    def clear(self, stage: Optional[str] = None) -> int:
        """清理缓存，返回删除的条目数。`stage` 为空表示全清。"""
        target = self.root if stage is None else self.root / stage
        if not target.is_dir():
            return 0
        removed = 0
        for meta_path in target.glob("**/meta.json"):
            entry = meta_path.parent
            shutil.rmtree(entry, ignore_errors=True)
            removed += 1
        return removed

    def stats(self) -> Dict[str, Any]:
        """给 `/v1/uvr/cache` 用的统计：每个阶段多少条、多大。"""
        result: Dict[str, Any] = {"root": str(self.root), "stages": {}, "total": 0, "bytes": 0}
        if not self.root.is_dir():
            return result
        for stage_dir in sorted(p for p in self.root.iterdir() if p.is_dir()):
            count = 0
            size = 0
            for meta_path in stage_dir.glob("**/meta.json"):
                count += 1
                size += sum(f.stat().st_size for f in meta_path.parent.glob("*") if f.is_file())
            result["stages"][stage_dir.name] = {"count": count, "bytes": size}
            result["total"] += count
            result["bytes"] += size
        return result

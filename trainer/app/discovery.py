"""GPT-SoVITS 安装位置发现与权重盘点。

对齐官方仓库 https://github.com/RVC-Boss/GPT-SoVITS 的结构约定。
为兼容「源码克隆」与「Windows 整合包」两种发行方式，采用「多候选 + 打分」
而不是硬编码单一路径：

* 源码仓库：`<home>/GPT_SoVITS/inference_webui.py`
* 整合包  ：`<home>/runtime/python.exe` + `<home>/GPT_SoVITS/...`
* 扁平布局：`<home>/inference_webui.py`

本模块只依赖标准库，不 import torch —— 即使环境残缺，
服务也要能启动并把「缺什么」讲清楚。
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from .sovits.catalog import (
    GPT_WEIGHT_DIRS,
    PREPARE_SCRIPTS,
    SOVITS_WEIGHT_DIRS,
    TEXT_SPLIT_METHODS,
    VERSIONS,
)

# --------------------------------------------------------------------------
# 布局约定
# --------------------------------------------------------------------------

#: 关键入口脚本的候选文件名。键名是语义标签，值是该语义下的候选文件。
STEP_LAYOUT: Dict[str, Tuple[str, ...]] = {
    "infer": ("inference_webui.py", "inference_webui_fast.py", "inference_cli.py"),
    "api": ("api_v2.py", "api.py"),
    "train_s1": ("s1_train.py",),
    "train_s2": ("s2_train.py", "s2_train_v3.py", "s2_train_v3_lora.py", "s2_train_v4.py"),
    "webui": ("webui.py",),
}

#: 子路径 → 语义标签。用于定位「GPT_SoVITS/」这一层。
CORE_CANDIDATES: Tuple[str, ...] = ("GPT_SoVITS", ".")

#: 数据预处理脚本（相对根目录）
PREPARE_STEP_LAYOUT: Dict[str, Tuple[str, ...]] = {
    key: (value,) for key, value in PREPARE_SCRIPTS.items()
}

#: 训练期需要的工具脚本
TOOL_STEP_LAYOUT: Dict[str, Tuple[str, ...]] = {
    "slice": ("tools/slice_audio.py",),
    "denoise": ("tools/cmd-denoise.py",),
    "asr_funasr": ("tools/asr/funasr_asr.py",),
    "asr_fasterwhisper": ("tools/asr/fasterwhisper_asr.py",),
    "uvr5": ("tools/uvr5/webui.py",),
    "subfix": ("tools/subfix_webui.py",),
}

#: 整合包常见的自带解释器位置（优先使用，它才是装了 torch 的那个）
RUNTIME_CANDIDATES: Tuple[str, ...] = (
    "runtime/python.exe",
    "runtime/python",
    "runtime/bin/python3",
    "runtime/bin/python",
    "venv/Scripts/python.exe",
    "venv/bin/python",
    ".venv/Scripts/python.exe",
    ".venv/bin/python",
)

#: 打分权重：推理与 SoVITS 训练脚本是最强的「这是一个完整安装」信号
_STEP_WEIGHTS: Dict[str, int] = {
    "infer": 3,
    "train_s2": 3,
    "train_s1": 2,
    "api": 1,
    "webui": 1,
}


@dataclass
class WeightEntry:
    """一个可加载的权重文件。"""

    path: Path
    version: str
    kind: str  # "gpt" | "sovits"
    name: str
    size_mb: float
    mtime: float
    trained: bool  # 是否为用户训练产物（位于 *_weights* 目录）

    def to_dict(self) -> Dict[str, Any]:
        return {
            "path": str(self.path),
            "relative": self.path.name,
            "version": self.version,
            "kind": self.kind,
            "name": self.name,
            "size_mb": round(self.size_mb, 1),
            "mtime": self.mtime,
            "trained": self.trained,
        }


@dataclass
class LayoutInfo:
    """一次布局发现的结果。"""

    home: Path
    core_dir: Path
    entries: Dict[str, Path] = field(default_factory=dict)
    tools: Dict[str, Path] = field(default_factory=dict)
    python_executable: Optional[str] = None
    gpt_weights: List[Path] = field(default_factory=list)
    sovits_weights: List[Path] = field(default_factory=list)
    pretrained: List[Path] = field(default_factory=list)
    variant: str = "unknown"
    score: int = 0

    # ---------- 派生能力 ----------

    @property
    def found(self) -> bool:
        return bool(self.entries)

    @property
    def can_infer(self) -> bool:
        return "infer" in self.entries

    @property
    def can_train(self) -> bool:
        return "train_s1" in self.entries and "train_s2" in self.entries

    @property
    def can_prepare(self) -> bool:
        return all(key in self.entries for key in PREPARE_STEP_LAYOUT)

    @property
    def missing(self) -> List[str]:
        return [key for key in STEP_LAYOUT if key not in self.entries]

    def weights_by_version(self) -> List[WeightEntry]:
        """把磁盘上的权重整理成带版本标签的条目，最近的排在前面。"""
        result: List[WeightEntry] = []
        for version in VERSIONS:
            gpt_dir = self.home / GPT_WEIGHT_DIRS[version]
            sovits_dir = self.home / SOVITS_WEIGHT_DIRS[version]
            result.extend(_scan_dir(gpt_dir, "gpt", version))
            result.extend(_scan_dir(sovits_dir, "sovits", version))
        result.sort(key=lambda item: item.mtime, reverse=True)
        return result

    def to_dict(self) -> Dict[str, Any]:
        return {
            "home": str(self.home),
            "core_dir": str(self.core_dir),
            "found": self.found,
            "entries": {key: str(path) for key, path in self.entries.items()},
            "tools": {key: str(path) for key, path in self.tools.items()},
            "python_executable": self.python_executable,
            "variant": self.variant,
            "can_infer": self.can_infer,
            "can_train": self.can_train,
            "can_prepare": self.can_prepare,
            "missing": self.missing,
            "gpt_weights": [str(path) for path in self.gpt_weights],
            "sovits_weights": [str(path) for path in self.sovits_weights],
            "pretrained_count": len(self.pretrained),
            "supported_versions": list(VERSIONS),
            "text_split_methods": list(TEXT_SPLIT_METHODS),
        }


# --------------------------------------------------------------------------
# 扫描
# --------------------------------------------------------------------------


def _scan_dir(base: Path, kind: str, version: str) -> List[WeightEntry]:
    """扫描单个权重目录。目录不存在是常态（还没训练过），不是错误。"""
    if not base.is_dir():
        return []
    pattern = "*.ckpt" if kind == "gpt" else "*.pth"
    found: List[WeightEntry] = []
    for path in base.rglob(pattern):
        try:
            stat = path.stat()
        except OSError:
            continue
        found.append(
            WeightEntry(
                path=path,
                version=version,
                kind=kind,
                name=path.stem,
                size_mb=stat.st_size / 1024 / 1024,
                mtime=stat.st_mtime,
                trained=True,
            )
        )
    return found


def _first_existing(base: Path, names: Tuple[str, ...]) -> Optional[Path]:
    for name in names:
        candidate = base / name
        if candidate.is_file():
            return candidate
    return None


def _find_bundled_python(home: Path) -> Optional[str]:
    """定位整合包自带的解释器。存在则优先使用，避免用户环境缺依赖。"""
    for rel in RUNTIME_CANDIDATES:
        candidate = home / rel
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    return None


def _guess_variant(core: Path) -> str:
    """依据权重目录与脚本名猜测版本分支，仅用于展示，不参与强校验。"""
    parent = core.parent
    # 从新到旧，取最先命中的
    for version in ("v2ProPlus", "v2Pro", "v4", "v3", "v2"):
        if any(
            (parent / naming).is_dir() for naming in (GPT_WEIGHT_DIRS[version], SOVITS_WEIGHT_DIRS[version])
        ):
            return version
    return "unknown"


def _is_plausible(entries: Dict[str, Path]) -> bool:
    """判定这批命中是否足以认定为一个真实的 GPT-SoVITS 安装。

    采用「强信号」原则：要么有推理入口，要么训练脚本成对出现。
    仅命中 `api.py` / `webui.py` 这类通用文件名不足以采信 ——
    否则本项目自身的 `trainer/app/` 也可能被误判为安装根目录。
    """
    if "infer" in entries:
        return True
    return "train_s1" in entries and "train_s2" in entries


def inspect(home: Path) -> Optional[LayoutInfo]:
    """检查给定路径是否为可用的 GPT-SoVITS 安装。返回 None 表示不是。"""
    home = home.expanduser()
    if not home.is_dir():
        return None

    best: Optional[LayoutInfo] = None
    for sub in CORE_CANDIDATES:
        core = (home / sub).resolve() if sub != "." else home.resolve()
        if not core.is_dir():
            continue

        entries: Dict[str, Path] = {}
        for key, names in STEP_LAYOUT.items():
            hit = _first_existing(core, names)
            if hit is not None:
                entries[key] = hit
        if not _is_plausible(entries):
            continue

        score = sum(_STEP_WEIGHTS.get(key, 0) for key in entries)
        info = LayoutInfo(
            home=home.resolve(),
            core_dir=core,
            entries=dict(entries),
            python_executable=_find_bundled_python(home),
            variant=_guess_variant(core),
            score=score,
        )

        # 数据预处理脚本相对「根目录」，不在 core 里
        for key, names in PREPARE_STEP_LAYOUT.items():
            hit = _first_existing(info.home, names)
            if hit is not None:
                info.entries[key] = hit
        for key, names in TOOL_STEP_LAYOUT.items():
            hit = _first_existing(info.home, names)
            if hit is not None:
                info.tools[key] = hit

        if best is None or info.score > best.score:
            best = info

    if best is None:
        return None

    best.gpt_weights = _collect_weights(best.home, tuple(GPT_WEIGHT_DIRS.values()), ("*.ckpt",))
    best.sovits_weights = _collect_weights(best.home, tuple(SOVITS_WEIGHT_DIRS.values()), ("*.pth",))
    best.pretrained = sorted(
        path
        for path in (best.core_dir / "pretrained_models").rglob("*")
        if path.suffix in {".ckpt", ".pth"}
    )[:40]
    return best


def _collect_weights(home: Path, dirs: Tuple[str, ...], patterns: Tuple[str, ...]) -> List[Path]:
    found: List[Path] = []
    for folder in dirs:
        base = home / folder
        if not base.is_dir():
            continue
        for pattern in patterns:
            found.extend(base.rglob(pattern))
    # 按修改时间倒序：最近训练的模型最可能被选中
    return sorted(found, key=lambda path: path.stat().st_mtime, reverse=True)[:60]


def default_search_roots() -> List[Path]:
    """默认的搜索起点：项目目录优先，其次用户目录与常见整合包位置。"""
    roots = [Path.cwd(), Path(__file__).resolve().parents[2]]
    env_root = os.getenv("GPT_SOVITS_SEARCH_ROOT")
    if env_root:
        roots.insert(0, Path(env_root).expanduser())
    home = Path.home()
    roots.extend([home, home / "Downloads", home / "Desktop", home / "Documents"])
    if sys.platform == "win32":
        # Windows 整合包常被解压到各个盘根目录
        for drive in ("C:/", "D:/", "E:/", "F:/"):
            if Path(drive).is_dir():
                roots.append(Path(drive))

    seen: set = set()
    unique: List[Path] = []
    for root in roots:
        try:
            resolved = root.resolve()
        except OSError:
            continue
        if resolved not in seen:
            seen.add(resolved)
            unique.append(resolved)
    return unique


def discover(explicit: Optional[str] = None, max_depth: int = 2) -> Optional[LayoutInfo]:
    """1) 优先使用显式路径；2) 否则在常见位置做有限深度搜索。"""
    if explicit:
        hit = inspect(Path(explicit))
        if hit is not None:
            return hit

    for root in default_search_roots():
        if not root.is_dir():
            continue
        try:
            direct = inspect(root)
        except OSError:
            continue
        if direct is not None:
            return direct
        if max_depth <= 0:
            continue
        for child in _iter_dirs_depth(root, max_depth):
            try:
                hit = inspect(child)
            except OSError:
                continue
            if hit is not None:
                return hit
    return None


def _iter_dirs_depth(root: Path, max_depth: int):
    """广度优先遍历目录，跳过体积大且无意义的目录。"""
    skip = {
        "node_modules",
        ".git",
        "venv",
        ".venv",
        "__pycache__",
        "runtime",
        ".idea",
        "dist",
        "dist_noref",
        ".data",
    }
    level = [root]
    for _ in range(max_depth):
        next_level: List[Path] = []
        for current in level:
            try:
                children = [child for child in current.iterdir() if child.is_dir()]
            except (OSError, PermissionError):
                continue
            for child in children:
                if child.name in skip:
                    continue
                yield child
                next_level.append(child)
        level = next_level

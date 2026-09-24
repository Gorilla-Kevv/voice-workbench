"""vendor/ 上游仓库的兼容性预检。

做三件事，全部只读、无副作用：

1. **语法兼容**：用当前解释器（GPT-SoVITS 整合包的 Python 3.9）编译上游全部
   `.py`，把 3.10+ 才有的语法（`match` 语句等）挑出来 —— 这类文件在 3.9 下
   根本无法 import，是「能不能直接复用上游」的第一道门槛；
2. **顶层模块名盘点**：列出各上游占用的顶层模块名，用于发现跨仓库撞车
   （例如 RVC 与 GPT-SoVITS 都有 `tools/`），这决定了直连层必须做隔离；
3. **依赖盘点**：比对上游 requirements 与当前环境已安装的包。

用法::

    python scripts/preflight_vendors.py           # 全部检查
    python scripts/preflight_vendors.py --syntax  # 只做语法检查
"""

from __future__ import annotations

import argparse
import ast
import os
import sys
from pathlib import Path
from typing import Dict, List, Set, Tuple

ROOT = Path(__file__).resolve().parents[1]

#: 上游仓库在本项目中的位置与展示名
VENDORS: List[Tuple[str, str]] = [
    ("vendor/rvc", "RVC"),
    ("vendor/ddsp-svc", "DDSP-SVC"),
]

#: 预检时跳过的目录
SKIP_DIRS = {".git", "__pycache__", "venv", ".venv", "node_modules", "build", "dist"}


def iter_python_files(base: Path):
    """遍历上游目录下的全部 `.py`（跳过 VCS 与缓存目录）。"""
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS)
        for name in sorted(filenames):
            if name.endswith(".py"):
                yield Path(dirpath) / name


def check_syntax(base: Path, label: str) -> Tuple[int, List[str]]:
    """编译全部 `.py`，返回 (文件数, 失败清单)。"""
    total = 0
    failures: List[str] = []
    source = str(base)
    for path in iter_python_files(base):
        total += 1
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError) as exc:
            failures.append(f"读取失败: {exc.__class__.__name__} :: {path.relative_to(source)}")
            continue
        try:
            compile(text, str(path), "exec")
        except SyntaxError as exc:
            failures.append(f"{exc.msg} (line {exc.lineno}) :: {path.relative_to(source)}")
    return total, failures


def top_level_modules(base: Path) -> Set[str]:
    """上游会在 sys.path 上占用的顶层模块名（顶层 `.py` 与带 `__init__.py` 的包）。"""
    names: Set[str] = set()
    for entry in sorted(base.iterdir()):
        if entry.name in SKIP_DIRS:
            continue
        if entry.is_file() and entry.suffix == ".py":
            names.add(entry.stem)
        elif entry.is_dir() and (entry / "__init__.py").exists():
            names.add(entry.name)
    return names


def parse_requirements(base: Path) -> Dict[str, str]:
    """解析上游 requirements（只认 `name==x` / `name>=x` / `name` 三种写法）。"""
    mapping: Dict[str, str] = {}
    for candidate in ("requirements.txt", "requirements_win.txt", "requirements-all.txt"):
        path = base / candidate
        if not path.exists():
            continue
        for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or line.startswith("-"):
                continue
            for sep in ("==", ">=", "<=", "~=", ">", "<"):
                if sep in line:
                    name, _, spec = line.partition(sep)
                    mapping[name.strip().lower()] = sep + spec.strip()
                    break
            else:
                mapping[line.lower()] = ""
    return mapping


def installed_versions() -> Dict[str, str]:
    """当前环境已安装的包版本（用 importlib.metadata，避免依赖 pip 输出格式）。"""
    try:
        from importlib import metadata
    except ImportError:  # pragma: no cover - Python 3.7 及以下
        return {}
    result: Dict[str, str] = {}
    for dist in metadata.distributions():
        name = (dist.metadata["Name"] or "").strip().lower()
        if name:
            result[name] = dist.version or ""
    return result


#: 标准库白名单：判定「第三方 import」时要排除这些名字
STDLIB_HINT = set(getattr(sys, "stdlib_module_names", ())) | {
    "os",
    "sys",
    "math",
    "time",
    "json",
    "typing",
    "collections",
    "pathlib",
    "dataclasses",
    "threading",
    "subprocess",
    "shutil",
    "glob",
    "traceback",
    "inspect",
    "importlib",
    "argparse",
    "random",
    "re",
    "csv",
    "itertools",
    "functools",
    "warnings",
    "logging",
    "contextlib",
    "abc",
    "enum",
    "copy",
    "statistics",
    "unicodedata",
}


def third_party_imports(base: Path) -> Dict[str, int]:
    """统计上游代码里**无法在当前环境解析**的顶层 import 名。

    只统计顶层名（`import x` / `from x import y` 里的 `x`），
    因为上游内部的相对模块（如 `infer.modules`）不属于「环境依赖」。
    """
    import importlib.util

    misses: Dict[str, int] = {}
    for path in iter_python_files(base):
        try:
            tree = ast.parse(path.read_text(encoding="utf-8", errors="replace"), str(path))
        except (SyntaxError, ValueError, OSError):
            continue
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                names = [alias.name.split(".")[0] for alias in node.names]
            elif isinstance(node, ast.ImportFrom):
                if node.level or not node.module:  # 相对导入跳过
                    continue
                names = [node.module.split(".")[0]]
            else:
                continue
            for name in names:
                if not name or name in STDLIB_HINT:
                    continue
                if importlib.util.find_spec(name) is not None:
                    continue
                # 上游自身目录（如 infer/、tools/）在没有加入 sys.path 时也找不到，
                # 这类「内部模块」由调用方按目录名过滤
                misses[name] = misses.get(name, 0) + 1
    return misses


def main() -> int:
    parser = argparse.ArgumentParser(description="vendor/ 上游兼容性预检")
    parser.add_argument("--syntax", action="store_true", help="只做语法兼容检查")
    parser.add_argument("--imports", action="store_true", help="只做第三方 import 可解析性扫描")
    args = parser.parse_args()

    print(f"解释器: {sys.version.split()[0]}  ({sys.executable})")

    # ---------- 语法兼容 ----------
    print("\n[1/3] 语法兼容（用当前解释器编译上游全部 .py）")
    syntax_ok = True
    for rel, label in VENDORS:
        base = ROOT / rel
        if not base.exists():
            print(f"  {label:<10} 未找到 {rel}（请先 git submodule update --init）")
            syntax_ok = False
            continue
        total, failures = check_syntax(base, label)
        if failures:
            syntax_ok = False
            print(f"  {label:<10} {total} 个文件，{len(failures)} 个无法在 {sys.version.split()[0]} 下编译：")
            for item in failures[:15]:
                print(f"              - {item}")
            if len(failures) > 15:
                print(f"              ... 另有 {len(failures) - 15} 个")
        else:
            print(f"  {label:<10} {total} 个文件全部通过")

    if args.syntax:
        return 0 if syntax_ok else 1

    # ---------- 第三方 import 可解析性 ----------
    print("\n[4/4] 第三方 import 可解析性（上游代码实际会 import 什么）")
    for rel, label in VENDORS:
        base = ROOT / rel
        if not base.exists():
            continue
        internal = {d.name for d in base.iterdir() if d.is_dir() and d.name not in SKIP_DIRS}
        misses = {k: v for k, v in third_party_imports(base).items() if k not in internal}
        if not misses:
            print(f"  {label:<10} 全部可解析")
            continue
        print(f"  {label:<10} 缺失 {len(misses)} 个（括号内为引用文件数）：")
        for name, count in sorted(misses.items(), key=lambda kv: -kv[1]):
            print(f"              - {name} ({count})")

    if args.imports:
        return 0

    # ---------- 顶层模块名 ----------
    print("\n[2/3] 顶层模块名占用（跨仓库撞车会污染 sys.modules）")
    owned: Dict[str, Set[str]] = {}
    for rel, label in VENDORS:
        base = ROOT / rel
        if not base.exists():
            continue
        names = top_level_modules(base)
        owned[label] = names
        print(f"  {label:<10} {', '.join(sorted(names))}")

    print("  撞车情况：", end="")
    all_names: Dict[str, List[str]] = {}
    for label, names in owned.items():
        for name in names:
            all_names.setdefault(name, []).append(label)
    clashes = {k: v for k, v in all_names.items() if len(v) > 1}
    if clashes:
        print()
        for name, owners in sorted(clashes.items()):
            print(f"              - `{name}` 同时属于 {' / '.join(owners)}")
    else:
        print(" 无")

    # GPT-SoVITS 整合包也占着一批顶层名，一并列出便于人工比对
    print("\n[3/3] 依赖盘点")
    installed = installed_versions()
    for rel, label in VENDORS:
        base = ROOT / rel
        if not base.exists():
            continue
        reqs = parse_requirements(base)
        if not reqs:
            print(f"  {label:<10} 未提供 requirements.txt（依赖需从代码推断）")
            continue
        missing = [n for n in reqs if n not in installed]
        print(f"  {label:<10} 声明 {len(reqs)} 个依赖，缺失 {len(missing)} 个")
        for name in sorted(missing):
            print(f"              - {name}{reqs[name]}")
        pinned_wrong = [
            (n, s, installed[n])
            for n, s in sorted(reqs.items())
            if n in installed and s.startswith("==") and s[2:].strip() != installed[n]
        ]
        for name, spec, actual in pinned_wrong:
            print(f"              ~ {name} 要求 {spec}，当前 {actual}（版本漂移，需实测）")

    print("\n结论见 docs/VC-SVC-FEASIBILITY.md")
    return 0 if syntax_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())

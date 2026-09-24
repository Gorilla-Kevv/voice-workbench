"""上游（vendor/）代码的路径隔离。

三个上游都是「必须站在自己的根目录里运行」的脚本式项目，各有各的路径依赖：

* GPT-SoVITS：`TTS.py` 用 `os.getcwd()` 拼声码器路径，要求 cwd 是仓库根；
* RVC：`infer/modules/vc/utils.py` 硬编码 `assets/hubert/hubert_base.pt`，
  只有 `weight_root` / `index_root` / `rmvpe_root` 三个路径能用环境变量改；
* DDSP-SVC：`ddsp/vocoder.py` 里 `pretrain/rmvpe/model.pt`、
  以及 config 里的 `vocoder.ckpt` 都是相对路径。

如果像现有 `sovits/bootstrap.py` 那样永久 `os.chdir()`，三个上游会互相破坏：
后加载的那个必然踩到前一个留下的 cwd。所以这里把它们统一成**临时的**上下文：
只在导入与权重加载期间接管 `sys.path` 与 cwd，用完立刻还原。

另外两个必须处理的细节：

1. **别往 vendor 里写 `__pycache__`**。submodule 里出现未跟踪文件会让 `git status`
   永远脏，而 `git clean` 又会误删。导入期间统一关掉字节码写入。
2. **`sys.modules` 污染**。三个上游都往 `sys.modules` 塞顶层模块
   （`infer`、`configs`、`ddsp`、`reflow`、`nsf_hifigan`…），同一进程里切换引擎时
   旧模块会残留并遮蔽新模块。`ModuleScope` 记录本次新进入的名字，切换时摘掉。
"""

from __future__ import annotations

import contextlib
import os
import sys
from pathlib import Path
from typing import Dict, Iterator, List, Optional, Sequence, Set

__all__ = [
    "sys_path_context",
    "working_directory",
    "argv_context",
    "temporary_context",
    "ModuleScope",
    "import_module",
]


@contextlib.contextmanager
def sys_path_context(entries: Sequence[str]) -> Iterator[None]:
    """临时把若干目录放到 `sys.path` 最前面，退出即还原（可嵌套、可重入）。

    放在最前面是刻意的：上游目录里可能存在与第三方同名的模块
    （例如 RVC 与 GPT-SoVITS 都有 `tools/`），官方自己的语义优先。
    """
    saved = list(sys.path)
    for entry in reversed([str(Path(e)) for e in entries]):
        if entry in sys.path:
            sys.path.remove(entry)
        sys.path.insert(0, entry)
    try:
        yield
    finally:
        sys.path[:] = saved


@contextlib.contextmanager
def working_directory(path: Optional[str]) -> Iterator[None]:
    """临时切换 cwd。传 None 表示不动。"""
    if not path:
        yield
        return
    saved = os.getcwd()
    os.chdir(path)
    try:
        yield
    finally:
        os.chdir(saved)


@contextlib.contextmanager
def argv_context(argv: Optional[Sequence[str]]) -> Iterator[None]:
    """临时替换 `sys.argv`。

    上游有不少模块在 **import 期** 就 `parse_args()`（RVC 的 `configs/config.py`、
    `train.py`、`preprocess.py` 都是），宿主服务自己的命令行参数会让它们直接退出。
    导入前把 argv 收敛掉，导出后还原。
    """
    if argv is None:
        yield
        return
    saved = list(sys.argv)
    sys.argv = list(argv)
    try:
        yield
    finally:
        sys.argv = saved


@contextlib.contextmanager
def _no_bytecode() -> Iterator[None]:
    """导入期间不写 `__pycache__`，保持 vendor submodule 的工作区干净。"""
    saved = sys.dont_write_bytecode
    sys.dont_write_bytecode = True
    try:
        yield
    finally:
        sys.dont_write_bytecode = saved


@contextlib.contextmanager
def temporary_context(
    entries: Sequence[str] = (),
    cwd: Optional[str] = None,
    argv: Optional[Sequence[str]] = None,
) -> Iterator[None]:
    """一次性接管 `sys.path` + cwd + `sys.argv`，退出全部还原。"""
    with _no_bytecode(), sys_path_context(entries), working_directory(cwd), argv_context(argv):
        yield


class ModuleScope:
    """记录「本次加载新进入 `sys.modules` 的顶层模块名」，并在需要时摘除。

    用法::

        scope = ModuleScope()
        with temporary_context([vendor_root]):
            import 上游模块
        scope.snapshot()          # 记录此刻新增的顶层名
        ...
        scope.purge()            # 卸载引擎时摘掉它们

    只处理**顶层**名（`infer`、`ddsp`、…），不碰 `torch` / `numpy` 这类基础库：
    它们在服务启动时就已加载，不会出现在增量里；即便误删，代价也是灾难性的。
    """

    def __init__(self) -> None:
        self._baseline: Set[str] = set(sys.modules)
        self._added: Set[str] = set()

    def snapshot(self) -> List[str]:
        """记录当前相比基线新增的顶层模块名，返回本次新增清单。"""
        fresh = {name.split(".")[0] for name in sys.modules} - {
            name.split(".")[0] for name in self._baseline
        }
        self._added |= fresh
        return sorted(fresh)

    @property
    def added(self) -> List[str]:
        return sorted(self._added)

    def purge(self, keep: Sequence[str] = ()) -> List[str]:
        """从 `sys.modules` 摘掉本作用域引入的模块，返回被摘掉的名字。

        `keep` 用于保留少数「卸载后仍需可用」的模块（例如只依赖其纯函数工具）。
        """
        protected = set(keep)
        removed: List[str] = []
        for name in list(self._added):
            if name in protected:
                continue
            for key in [k for k in sys.modules if k == name or k.startswith(name + ".")]:
                sys.modules.pop(key, None)
                removed.append(key)
        self._added -= {name.split(".")[0] for name in removed}
        return removed

    def reset(self) -> None:
        """重新以当前 `sys.modules` 为基线（引擎加载完成后调用）。"""
        self._baseline = set(sys.modules)
        self._added = set()


def import_module(name: str, entries: Sequence[str] = (), cwd: Optional[str] = None, argv: Optional[Sequence[str]] = None):
    """在临时上下文里导入一个上游模块。

    等价于 `with temporary_context(...): return importlib.import_module(name)`，
    抽出来是因为每个直连层都要写一遍，漏掉 `argv` 或 `cwd` 中的任何一个
    都会在「上游升级后」才暴露成难以定位的导入失败。
    """
    import importlib  # noqa: PLC0415 - 只有真正导入上游时才需要

    with temporary_context(entries=entries, cwd=cwd, argv=argv):
        return importlib.import_module(name)


def describe(entries: Sequence[str], cwd: Optional[str]) -> Dict[str, object]:
    """给 `/health` 用的自述信息，便于排障时确认隔离是否生效。"""
    return {
        "sys_path_entries": [str(e) for e in entries],
        "cwd": cwd,
        "dont_write_bytecode": sys.dont_write_bytecode,
    }

"""worker 进程入口（**必须用文件路径直接启动**，不能用 `-m`）。

    python -u <这个文件> --home <整合包根目录>

为什么不能用 `python -m app.sovits.worker`：

整合包自带的解释器是 **embedded distribution**，它的 `runtime/python39._pth`
只列了 `python39.zip` 和 `.`，这会让 Python：

1. **完全忽略 `PYTHONPATH` 环境变量；**
2. 不把 `sys.path[0]` 设成脚本目录（`-m` 依赖这一点）。

于是 `-m app.sovits.worker` 会以「No module named 'app'」直接退出 ——
而且是在我们的代码跑起来之前，连报错都传不出来。

按文件路径启动则可靠得多：Python 会把**这个文件所在目录**加入 `sys.path`，
所以 `from .server import main` 在任何解释器上都能解析。
之后 `_bootstrap_path()` 再把项目根补上，让 worker 内部能 `import app.xxx`。
"""

from __future__ import annotations

import sys
from pathlib import Path


def _bootstrap_path() -> None:
    """把 `trainer/` 加进 sys.path，让 `import app.xxx` 可用。

    本文件在 `<项目>/trainer/app/sovits/worker/__main__.py`，
    所以往上四层就是 `trainer/`。

    必须在 import 之前做完 —— 包括 `from .server import main` 之前的
    任何 `app.*` 引用（当前没有，但把这个函数放最前面能防住以后加错）。
    """
    trainer_dir = Path(__file__).resolve().parent.parent.parent.parent
    if str(trainer_dir) not in sys.path:
        sys.path.insert(0, str(trainer_dir))


_bootstrap_path()

# 相对 import 只有在「按包路径启动」时才成立 —— 按文件路径启动时
# `__package__` 为空，相对 import 会直接 ImportError。
# 所以这里用绝对 import，并靠上面的 sys.path 注入兜住。
from app.sovits.worker.server import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())

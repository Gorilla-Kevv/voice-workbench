"""ASR 板块：语音转文本（音频 → 逐字文本）。

这个包是**唯一**对外提供「语音转文本」能力的地方，职责边界只有一句话：
**把一段音频变成它的逐字文本，以及把一批音频变成一份带文本的数据集。**

板块之外只有三处知道它的存在（都在装配层，不在业务层）：

* `engine.py` 的 `ENGINES` 里多一个 `asr` 引擎 —— 让 ASR 与其它模型
  抢同一张显卡时由引擎注册表统一仲裁；
* `routers/asr.py` 暴露 `/v1/asr/*`；
* `api.py` 的 `Context` 造一个 `AsrEngine`，并注册两个任务执行体。

反过来，ASR 板块**不依赖**任何其它板块的业务代码，只借用两个共享内核：
`audio/io.py`（音频归一与探测）、`audio/cache.py`（转写结果缓存），
再加上 `sovits/catalog.ASR_BACKENDS` 这一份官方能力清单（单一事实来源）。

文件分工：

* `catalog.py` —— 能力清单与场景预设（纯常量，无副作用）；
* `bootstrap.py` —— 安装定位、官方脚本查找、两条通道的可用性探测；
* `pipeline.py` —— `AsrEngine`：模型常驻、单条转写、卸载与状态；
* `training.py` —— 训练入口：批量音频 → 逐字文本数据集（含官方格式清单）。
"""

from . import bootstrap, catalog
from .bootstrap import AsrError
from .pipeline import AsrEngine

__all__ = ["AsrEngine", "AsrError", "bootstrap", "catalog"]

"""歌声转换板块（DDSP-SVC）。

与「语音变声」（RVC）的分工：

| 维度 | 歌声转换（本模块） | 语音变声（vc/） |
| --- | --- | --- |
| 输入 | 歌曲（整首或已分离的人声） | 说话 / 配音干声 |
| 音高 | **显式建模**：F0 曲线参与合成，支持转调与共振峰偏移 | 只做整体变调 |
| 生成器 | DDSP 合成器 + Rectified Flow 后处理 | VITS 系 + 声码器 |
| 检索增强 | 无 | faiss index（RVC 专有） |
| 产物 | 新人声 / 伴奏 / 混音三件套 | 单条变声音频 |

重合的部分（读音频、切分、UVR5 分离、混音、缓存、显存调度）都在 `audio/` 与
`engine.py` 里，这里只保留 DDSP-SVC 专有的编排。
"""

from __future__ import annotations

from .pipeline import SvcEngine

__all__ = ["SvcEngine", "bootstrap", "catalog", "cover"]

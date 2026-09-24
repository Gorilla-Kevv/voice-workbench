"""语音变声板块（RVC）。

与「歌声转换」（svc/）的分工：

| 维度 | 语音变声（本模块） | 歌声转换（svc/） |
| --- | --- | --- |
| 输入 | 说话 / 配音 / 朗读的干声 | 歌曲（整首或已分离人声） |
| 音高 | 只做整体变调（transpose） | 显式 F0 建模，支持转调与共振峰偏移 |
| 生成器 | VITS 系 SynthesizerTrn + 声码器 | DDSP 合成器 + Rectified Flow |
| 检索增强 | faiss index（RVC 专有，不共享） | 无 |
| 音色获取 | 全量微调 / **LoRA 适配器** / 权重融合 | 官方每音色一个 model.pt |

针对「换一个音色就要重新训一个模型」这条局限，本模块提供两条缓解路径：
`lora.py`（底模共享 + 低秩适配器热切换）与 `merge.py`（多权重插值，零训练）。
"""

from __future__ import annotations

from .pipeline import VcEngine

__all__ = ["VcEngine", "bootstrap", "lora", "merge", "models", "training"]

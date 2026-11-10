# -*- coding: utf-8 -*-
"""SenseVoice 文本清洗：剥掉 `rich_transcription_postprocess()` 渲染出来的非文本标记。

为什么要有这一层：上游 `rich_transcription_postprocess()` 会把富文本标签**渲染成 emoji** ——
情绪 6 个（😊 😔 😡 😰 🤢 😮）和事件 6 个（🎼 👏 😀 😭 🤧 😷）。
这些标记进了转写文本就会污染下游：音色库的参考文本、字幕、以及「智能转写」填进输入框的内容
（实测中文轻语输出会带 😔，见 docs/ASR.md §8.5）。

2026-11-09 使用者拍板：**一律过滤**。两个集合在下面分开列出 —— 若将来想让字幕保留
事件标记（BGM / 掌声 / 咳嗽），只把 `EVENT_MARKERS` 清空即可，情绪标记仍然会剥掉。

注意：`use_itn=False` 的「逐字文本」约定不变；这里只删 emoji，不补标点、不改字。
"""

from __future__ import annotations

import re

#: 情绪标记（对应 funasr `postprocess_utils.emo_set`：HAPPY / SAD / ANGRY / FEARFUL / DISGUSTED / SURPRISED）
EMOTION_MARKERS = (
    "\U0001F60A",  # 😊 HAPPY
    "\U0001F614",  # 😔 SAD
    "\U0001F621",  # 😡 ANGRY
    "\U0001F630",  # 😰 FEARFUL
    "\U0001F922",  # 🤢 DISGUSTED
    "\U0001F62E",  # 😮 SURPRISED
)

#: 事件标记（对应 funasr `postprocess_utils.event_set`：BGM / Applause / Laughter / Cry / Sneeze / Cough）
EVENT_MARKERS = (
    "\U0001F3BC",  # 🎼 BGM
    "\U0001F44F",  # 👏 Applause
    "\U0001F600",  # 😀 Laughter
    "\U0001F62D",  # 😭 Cry
    "\U0001F927",  # 🤧 Sneeze
    "\U0001F637",  # 😷 Cough
)

#: 上游会在 emoji 两侧做「去空格」处理，删掉 emoji 后可能留下连续空格，统一收拢
_MULTI_SPACE = re.compile(r"[ \t]{2,}")


def strip_markers(text: str) -> str:
    """删掉情绪/事件 emoji 并收拢多余空格；空输入原样返回空串。"""
    if not text:
        return ""
    cleaned = text
    for marker in EMOTION_MARKERS + EVENT_MARKERS:
        cleaned = cleaned.replace(marker, "")
    return _MULTI_SPACE.sub(" ", cleaned).strip()

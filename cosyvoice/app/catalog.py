"""Catalog：语言 / 方言 / 模式 / 控制面。

全部常量以官方模型卡与 `cosyvoice3.yaml` 为准，前端**不要自己抄一份**
（与 Irodori 的 catalog 同一原则：真源在服务端）。
"""

from __future__ import annotations

from typing import Any

from .config import REQUIRED_VRAM_MB, Settings


LANGUAGES = [
    {"code": "zh", "label": "中文"},
    {"code": "en", "label": "英语"},
    {"code": "ja", "label": "日语"},
    {"code": "ko", "label": "韩语"},
    {"code": "de", "label": "德语"},
    {"code": "es", "label": "西班牙语"},
    {"code": "fr", "label": "法语"},
    {"code": "it", "label": "意大利语"},
    {"code": "ru", "label": "俄语"},
]

#: 官方模型卡明确列名的 11 种；总量是 18+（其余用自然语言 instruct 描述即可）。
DIALECTS = [
    {"code": "yue", "label": "粤语 / 广东话"},
    {"code": "minnan", "label": "闽南语"},
    {"code": "sichuan", "label": "四川话"},
    {"code": "dongbei", "label": "东北话"},
    {"code": "shanxi", "label": "山西话"},
    {"code": "shaanxi", "label": "陕西话"},
    {"code": "shanghai", "label": "上海话"},
    {"code": "tianjin", "label": "天津话"},
    {"code": "shandong", "label": "山东话"},
    {"code": "ningxia", "label": "宁夏话"},
    {"code": "gansu", "label": "甘肃话"},
]

MODES = [
    {
        "id": "zero_shot",
        "label": "零样本克隆",
        "requires_prompt_text": True,
        "requires_instruct_text": False,
        "note": "参考音频 + 逐字转写；音色与参考音最接近，跨语种请用 cross_lingual。",
    },
    {
        "id": "cross_lingual",
        "label": "跨语种克隆",
        "requires_prompt_text": False,
        "requires_instruct_text": False,
        "note": "只用参考音频，不需要转写；文本前可加 <|zh|>/<|en|> 等语言标签。",
    },
    {
        "id": "instruct2",
        "label": "自然语言指令",
        "requires_prompt_text": True,
        "requires_instruct_text": True,
        "note": "用一句话控制方言/情感/语速/音量，例如「用四川话说这句话<|endofprompt|>」。",
    },
]

INSTRUCT_EXAMPLES = [
    "用四川话说这句话<|endofprompt|>",
    "用开心的语气说这句话<|endofprompt|>",
    "用粤语说这句话<|endofprompt|>",
    "语速快一点<|endofprompt|>",
    "用悄悄话的音量说<|endofprompt|>",
]


def build_catalog(settings: Settings) -> dict[str, Any]:
    return {
        "ok": True,
        "service": "cosyvoice",
        "model": "Fun-CosyVoice3-0.5B-2512",
        "license": "Apache-2.0",
        "sample_rate": settings.sample_rate,
        "languages": LANGUAGES,
        "dialects": {
            "items": DIALECTS,
            "named": len(DIALECTS),
            "note": "官方口径 18+；模型卡明确列名 11 种，其余可用自然语言 instruct 描述。",
        },
        "modes": MODES,
        "controls": {
            "speed": {"min": 0.5, "max": 2.0, "default": 1.0},
            "instruct_examples": INSTRUCT_EXAMPLES,
            "inline_tags": ["[laughter]", "[breath]", "<strong>", "</strong>"],
            "note": "情感控制优先级（B站盲测）：带情绪参考音 > 文字指令 > 台词插标签。",
        },
        "limits": {
            "min_ref_seconds": settings.min_ref_seconds,
            "max_ref_seconds": settings.max_ref_seconds,
            "max_text_length": settings.max_text_length,
        },
        "required_vram_mb": REQUIRED_VRAM_MB,
        "fp16": settings.fp16,
        "note": "24kHz 输出；若与 32/48kHz 产物混剪需重采样。11kHz 以上嘶声可在后处理低通。",
    }

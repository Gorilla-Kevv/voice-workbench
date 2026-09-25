"""ASR 板块的能力清单与场景预设。

两个刻意的取舍：

1. **后端清单不在这里重新写一遍。** 「有哪些尺寸 / 语言 / 精度」的唯一事实来源是
   GPT-SoVITS 官方的 `tools/asr/config.py`，本项目把它收在
   `sovits/catalog.ASR_BACKENDS`（训练流水线的 ASR 阶段读的就是它）。
   ASR 板块直接引用它，于是「训练里能选的尺寸，独立转写里选不了」这种漂移不可能发生。

2. **场景预设代替参数堆砌。** 「一键智能转写」（3~10 秒参考音频 → 逐字文本）与
   「整场录音转写」的参数取向完全不同。让用户在 tiny / large、float16 / int8 之间做选择
   是本末倒置，所以把常见意图固化成预设；高级参数仍然全部对外开放，不隐藏。

本模块只额外补充官方清单里没有的两样东西：预设，以及**常驻通道的模型标识**
（直连 `funasr` / `faster_whisper` 时用的 model id）—— 后者是本板块唯一与上游
模型命名耦合的位置，上游改名只需改这里。
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

from ..sovits import catalog as sovits_catalog

__all__ = [
    "BACKENDS",
    "DEFAULTS",
    "LANGUAGE_LABELS",
    "PRESETS",
    "RESIDENT_MODELS",
    "RESIDENT_MODULES",
    "backend_meta",
    "defaults",
    "describe",
    "language_label",
    "normalize",
    "preset",
    "resident_channel_module",
    "resident_models",
]

#: 后端清单：直接引用 GPT-SoVITS 侧的同一份常量（见模块文档）。
#: 结构：`{id: {script, label, sizes, languages, precisions, precision_effective, needs_gpu}}`
BACKENDS: Dict[str, Dict[str, Any]] = sovits_catalog.ASR_BACKENDS

#: 语种的展示文案。`auto` 只对 faster-whisper 有意义（FunASR 不分语种，必须指定）。
LANGUAGE_LABELS: Dict[str, str] = {
    "zh": "中文",
    "en": "英语",
    "ja": "日语",
    "ko": "韩语",
    "yue": "粤语",
    "auto": "自动识别",
}

#: 常驻通道的模型标识。
#:
#: 直连 `funasr` / `faster_whisper` 时用这些标识加载模型，而**不是**官方脚本的参数
#: （脚本参数是 size/language/precision 那套批处理语义，两者不是一回事）。
#: 用官方别名而不是长路径，是为了让模型缓存与上游文档对得上。
RESIDENT_MODELS: Dict[str, List[Dict[str, Any]]] = {
    "funasr": [
        {
            "key": "paraformer-zh",
            "id": "paraformer-zh",
            "label": "Paraformer-zh（中文逐字 + 标点）",
            "languages": ["zh"],
            "hint": (
                "中文短音频的首选：整合包里已下载这套权重（Paraformer + VAD + 标点）时直接复用，"
                "否则按官方别名联网拉取。中文精度明显强于 Whisper。"
            ),
        },
        {
            "key": "sensevoice-small",
            "id": "iic/SenseVoiceSmall",
            "label": "SenseVoice-Small（中英日韩粤，最省显存）",
            "languages": ["zh", "en", "ja", "ko", "yue"],
            "hint": "CPU 上也够快，适合只想给参考音频打一次底稿。",
        },
    ],
    # faster-whisper 的模型标识与 Whisper 尺寸同名，由 `resident_models()` 从尺寸派生
    "fasterwhisper": [],
}

#: 场景预设。前端「一键智能转写」直接取 `reference`，用户也可以手动改。
PRESETS: List[Dict[str, Any]] = [
    {
        "key": "reference",
        "label": "参考音频（3~10 秒，逐字）",
        "backend": "funasr",
        "size": "large",
        "language": "zh",
        "precision": "float32",
        "hint": "参考文本会被直接学进音色，优先保证逐字准确；语种请显式指定，不要用自动识别。",
    },
    {
        "key": "balanced",
        "label": "日常转写（速度与准确均衡）",
        "backend": "funasr",
        "size": "medium",
        "language": "zh",
        "precision": "float32",
        "hint": "中文素材用 FunASR 明显强于 Whisper；语种明确时不要选自动识别。",
    },
    {
        "key": "multilingual",
        "label": "多语种 / 语种不确定",
        "backend": "fasterwhisper",
        "size": "large-v3",
        "language": "auto",
        "precision": "float16",
        "hint": "faster-whisper 覆盖语种最广；没有显卡时把精度改成 int8 更省内存。",
    },
]

#: 兜底默认值（当请求什么都没给、预设也不适用时用）。
DEFAULTS: Dict[str, str] = {
    "backend": "funasr",
    "size": "large",
    "language": "zh",
    "precision": "float32",
}

#: 常驻通道需要 import 的 Python 包。
RESIDENT_MODULES: Dict[str, str] = {
    "funasr": "funasr",
    "fasterwhisper": "faster_whisper",
}


def backend_meta(backend: str) -> Dict[str, Any]:
    """取某个后端的元信息。未知后端抛 `KeyError` 前先做一次友好检查。"""
    if backend not in BACKENDS:
        raise ValueError("未知的 ASR 后端：%s（可选：%s）" % (backend, "、".join(BACKENDS)))
    return BACKENDS[backend]


def resident_channel_module(backend: str) -> Optional[str]:
    """返回常驻通道需要的模块名；该后端没有常驻通道时返回 `None`。"""
    return RESIDENT_MODULES.get(backend)


def resident_models(backend: str) -> List[Dict[str, Any]]:
    """某个后端在常驻通道下可选的模型标识列表。"""
    if backend == "fasterwhisper":
        meta = BACKENDS.get("fasterwhisper") or {}
        return [
            {
                "key": str(size),
                "id": str(size),
                "label": "Whisper %s" % size,
                "languages": list(meta.get("languages") or []),
                "hint": "模型标识与 Whisper 官方尺寸同名，首次使用会下载权重。",
            }
            for size in meta.get("sizes") or []
        ]
    return [dict(item) for item in RESIDENT_MODELS.get(backend, [])]


def defaults(settings: Any = None) -> Dict[str, str]:
    """默认参数：先看配置（`.env`），再回落到内置默认值。"""
    result = dict(DEFAULTS)
    if settings is None:
        return result
    if getattr(settings, "asr_backend", ""):
        result["backend"] = str(settings.asr_backend)
    if getattr(settings, "asr_size", ""):
        result["size"] = str(settings.asr_size)
    if getattr(settings, "asr_language", ""):
        result["language"] = str(settings.asr_language)
    if getattr(settings, "asr_precision", ""):
        result["precision"] = str(settings.asr_precision)
    return result


def preset(key: str) -> Optional[Dict[str, Any]]:
    for item in PRESETS:
        if item["key"] == key:
            return dict(item)
    return None


def normalize(
    backend: str = "",
    size: str = "",
    language: str = "",
    precision: str = "",
    settings: Any = None,
) -> Tuple[str, str, str, str, List[str]]:
    """把一组参数收敛到「该后端确实支持」的取值上。

    返回 `(backend, size, language, precision, notes)`。`notes` 里是每一处被纠正的
    原因 —— 前端会把它显示出来，而不是静默替换：用户以为自己用了 large，
    实际跑的是 medium，这种误会比报错更糟。
    """
    notes: List[str] = []
    base = defaults(settings)

    chosen = (backend or base["backend"]).strip()
    if chosen not in BACKENDS:
        notes.append("不认识的后端 %s，已回落到 %s" % (chosen or "（空）", base["backend"]))
        chosen = base["backend"]
    meta = BACKENDS[chosen]

    sizes = [str(item) for item in meta.get("sizes") or []]
    languages = [str(item) for item in meta.get("languages") or []]
    precisions = [str(item) for item in meta.get("precisions") or []]

    resolved_size = (size or base["size"]).strip()
    if sizes and resolved_size not in sizes:
        fallback = base["size"] if base["size"] in sizes else sizes[-1]
        notes.append("%s 不支持尺寸 %s，已改用 %s" % (chosen, resolved_size or "（空）", fallback))
        resolved_size = fallback

    resolved_language = (language or base["language"]).strip()
    if languages and resolved_language not in languages:
        fallback = base["language"] if base["language"] in languages else languages[0]
        notes.append("%s 不支持语种 %s，已改用 %s" % (chosen, resolved_language or "（空）", fallback))
        resolved_language = fallback

    #: 精度不必额外提示「官方脚本里 -p 尚未接入」—— 那是后端的静态事实，
    #: 由 `/v1/asr/catalog` 的 `precision_effective` 表达，前端在参数区常驻显示即可。
    #: 这里只记录**用户这次给的值被换掉了**这种需要立刻知道的事。
    resolved_precision = (precision or base["precision"]).strip()
    if precisions and resolved_precision not in precisions:
        fallback = base["precision"] if base["precision"] in precisions else precisions[0]
        notes.append("%s 不支持精度 %s，已改用 %s" % (chosen, resolved_precision or "（空）", fallback))
        resolved_precision = fallback

    return chosen, resolved_size, resolved_language, resolved_precision, notes


def language_label(language: str) -> str:
    return LANGUAGE_LABELS.get(language, language)


def describe(settings: Any = None) -> Dict[str, Any]:
    """给 `/v1/asr/catalog` 的完整清单（不含运行期探测结果，探测在 bootstrap 里）。"""
    return {
        "backends": [
            {
                "id": key,
                "label": meta.get("label", key),
                "sizes": list(meta.get("sizes") or []),
                "languages": list(meta.get("languages") or []),
                "precisions": list(meta.get("precisions") or []),
                "precision_effective": bool(meta.get("precision_effective", True)),
                "needs_gpu": bool(meta.get("needs_gpu")),
                "resident_modules": RESIDENT_MODULES.get(key, ""),
                "resident_models": resident_models(key),
            }
            for key, meta in BACKENDS.items()
        ],
        "presets": [dict(item) for item in PRESETS],
        "language_labels": dict(LANGUAGE_LABELS),
        "defaults": defaults(settings),
    }

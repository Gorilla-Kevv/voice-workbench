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
    "REQUIRED_VRAM_MB",
    "RESIDENT_MODELS",
    "RESIDENT_MODULES",
    "backend_meta",
    "defaults",
    "describe",
    "language_label",
    "normalize",
    "preset",
    "required_vram_mb",
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

#: ASR 引擎的显存准入：按「模型标识 × 尺寸 × 精度」参数化（坑 24/72 同族补票，阶段 42）。
#:
#: 引擎注册表（`app/engine.py` ENGINES）里 `asr` 的静态 2048 是按「板块默认配置 =
#: Paraformer-large fp32」定的一次性取值。板块的请求可以带任意组合，一个数必然两头
#: 失真：**small 级被 2048 误拦（实际 <1 GB），large-v3 被 2048 误放（实际 3.5~5 GB，
#: 跑一半 OOM 或溢出共享内存假死——坑 78）**。现在调用方经 `resolve()` 解析出真实
#: 组合后取本表，`acquire("asr", ..., required_mb=...)` 按参数设门；
#: `ENGINES["asr"].required_mb` 保留为「参数未解析时的兜底 = 默认配置档」。
#:
#: **宁估高不估低**（估高只是提前拒绝，估低是中途炸，与坑 19 同旨）。下表是**量级估算**：
#: 权重体积（CT2 ≈ 2 字节/参数，fp16 减半、int8 再减半）+ 约 1 倍余量给激活值与特征
#: 提取；SenseVoice「最省显存」（上游定位，见 RESIDENT_MODELS hint）、turbo 解码器减半
#: 是已知锚点。真机 nvidia-smi 画像后可回填校准（同坑 26 的做法）。
#: 注：funasr 的 `precision_effective=False`（fp16 请求实际仍是 fp32 画像），
#: 所以 funasr 档不按精度分。
REQUIRED_VRAM_MB: Dict[str, Dict[str, int]] = {
    # ---- FunASR 常驻 ----
    "paraformer-zh": {"default": 2048},        # 权重「两三百 MB」×(模型+VAD+标点)，fp32 常驻 ~1.5-2 GB（bootstrap.py:136 注释量级）
    "iic/SenseVoiceSmall": {"default": 1536},  # 多语种 small 底座 + fp32，比 paraformer 轻，余量给足
    "speech_UniASR_yue": {"default": 2048},    # 粤语 paraformer 同量级
    # ---- faster-whisper（CT2）----
    # tiny/base/small 一档：small 权重 ~0.5 GB（fp16），这正是「旧 2048 一刀切误拦」的主角，
    # 修桩的本意就是让它按真实量级放行。
    "whisper-small": {"float32": 2560, "int8": 1024, "default": 1536},
    "whisper-medium": {"float32": 4096, "int8": 2048, "default": 2560},   # 769M：fp16 ~1.5 GB + 激活；fp32 翻倍
    "whisper-large": {"float32": 8192, "int8": 3584, "default": 4608},      # 1.5B：fp16 ~3 GB + 激活；fp32 在 8 GB 卡上等于拒绝
    "whisper-large-v3-turbo": {"float32": 6144, "int8": 2560, "default": 3072},  # turbo 编码器 large + 解码器减半
}
#: 2026-10-24 本机实测画像（RTX 4060 8GB，3 秒音频，nvidia-smi used 相对基线增量；
#: 基线约 1.8~2.0GB）：FunASR Paraformer-zh(local)+VAD+Punc +1213 / 峰值 +1257；
#: whisper-small int8 +260；large-v3-turbo fp16 +1568/+1808、int8 +800/+1072、
#: fp32 +3212/+3646。门槛保持「宁估高」不因实测下调；条件与 R2T2 口径见 docs/ASR.md §3.2。

#: 尺寸/标识 → 权重档（官方脚本把 large 归一 large-v3，常驻通道同款归一，
#: 见 pipeline._default_model_id）
_SIZE_TIERS: Dict[str, str] = {
    "tiny": "whisper-small",
    "base": "whisper-small",
    "small": "whisper-small",
    "medium": "whisper-medium",
    "medium.en": "whisper-medium",
    "large": "whisper-large",
    "large-v2": "whisper-large",
    "large-v3": "whisper-large",
    "large-v3-turbo": "whisper-large-v3-turbo",
}

#: 后端默认权重档（model 与 size 都解析不出来时的兜底）
_BACKEND_TIER_DEFAULT: Dict[str, str] = {
    "funasr": "paraformer-zh",
    "fasterwhisper": "whisper-medium",
}


def required_vram_mb(
    backend: str,
    size: str = "",
    precision: str = "",
    model: str = "",
) -> Optional[int]:
    """「这组参数要多少显存」；解析不出具体模型时返回 None（引擎走静态兜底档）。

    解析顺序与 `AsrPipeline.resolve()` 对齐：先看常驻模型标识（paraformer /
    SenseVoice / whisper 尺寸名），再看尺寸，最后按后端默认档。
    **调用方应传 resolve() 之后的值**——resolve 里还有「中文/粤语改用 FunASR」这类
    换后端的决定，门槛必须跟着换后的参数算，否则会拦错对象。
    """
    model_key = (model or "").strip()
    size_key = (size or "").strip()
    precision_key = (precision or "").strip()

    tier: Optional[str] = None
    if model_key:
        if model_key in REQUIRED_VRAM_MB:
            tier = model_key
        elif model_key == "sensevoice-small":
            tier = "iic/SenseVoiceSmall"
        elif "UniASR" in model_key or "yue" in model_key.lower():
            tier = "speech_UniASR_yue"
        elif model_key.startswith("whisper-"):
            tier = model_key if model_key in REQUIRED_VRAM_MB else _SIZE_TIERS.get(
                model_key.replace("whisper-", "", 1), "whisper-large"
            )
        elif model_key in _SIZE_TIERS:
            tier = _SIZE_TIERS[model_key]
    if tier is None and size_key:
        tier = _SIZE_TIERS.get(size_key)
    if tier is None:
        tier = _BACKEND_TIER_DEFAULT.get((backend or "").strip())
    if tier is None:
        return None

    entry = REQUIRED_VRAM_MB.get(tier) or {}
    value = entry.get(precision_key) if precision_key else None
    if value is None:
        value = entry.get("default")
    return int(value) if value else None

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
        # 准入门槛的按参数表（阶段 42，坑 19：真源在服务端，前端只读不抄）
        "required_vram_mb": {
            "table": {tier: dict(values) for tier, values in REQUIRED_VRAM_MB.items()},
            "size_tiers": dict(_SIZE_TIERS),
            "note": (
                "显存准入按「模型×尺寸×精度」参数化：请求经 resolve() 解析出真实组合后取本表，"
                "传给引擎 acquire(required_mb=...)。数值是**量级估算**（宁估高不估低），真机 "
                "nvidia-smi 画像后回填校准；参数解析不出时回落到引擎注册表的静态档 2048。"
            ),
        },
    }

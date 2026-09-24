"""官方能力清单。

**本文件是唯一允许出现「硬编码官方常量」的地方**，其余模块一律从这里取值，
这样官方仓库升级时只需改一处。所有内容都能在官方源码里找到出处：

| 常量 | 出处 |
| --- | --- |
| `VERSIONS` / `VERSION_LANGUAGES` | `GPT_SoVITS/TTS_infer_pack/TTS.py::TTS_Config` |
| `TEXT_SPLIT_METHODS` | `GPT_SoVITS/TTS_infer_pack/text_segmentation_method.py` |
| `WEIGHT_DIRS` / `PRETRAINED_*` | `config.py`（仓库根目录） |
| `S2_CONFIG_TEMPLATE` / `S1_CONFIG_TEMPLATE` | `webui.py::open1Ba / open1Bb` |
| `PREPARE_SCRIPTS` | `webui.py::open1a / open1b / open1c / open1abc` |
| `SLICE_DEFAULTS` | `webui.py`（切分页默认值） |

字节级细节（如音频参数范围）也在此集中声明，避免散落在各处。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# --------------------------------------------------------------------------
# 模型版本
# --------------------------------------------------------------------------

VERSIONS: Tuple[str, ...] = ("v1", "v2", "v2Pro", "v2ProPlus", "v3", "v4")

DEFAULT_VERSION = "v2ProPlus"

VERSION_NOTES: Dict[str, str] = {
    "v1": "初版，仅中英日，兼容老权重",
    "v2": "多语种（中英日韩粤），社区权重最多",
    "v2Pro": "v2 增强：加入说话人向量 SV，相似度更高",
    "v2ProPlus": "v2Pro 增强版，官方当前主推",
    "v3": "新声码器（BigVGAN），音质更好，不支持流式",
    "v4": "v3 基础上的改进声码器，采样率 48k",
}

# 各版本支持的推理/训练语种。v1 只有三个语种，其余为多语种。
V1_LANGUAGES: Tuple[str, ...] = ("auto", "en", "zh", "ja", "all_zh", "all_ja")
V2_LANGUAGES: Tuple[str, ...] = (
    "auto",
    "auto_yue",
    "en",
    "zh",
    "ja",
    "yue",
    "ko",
    "all_zh",
    "all_ja",
    "all_yue",
    "all_ko",
)

#: `text_lang` / `prompt_lang` 的取值语义（对齐官方注释）
LANGUAGE_NOTES: Dict[str, str] = {
    "auto": "自动切分语种，按句判定（推荐）",
    "auto_yue": "自动切分，粤语按粤语处理",
    "zh": "中文为主，中英混合",
    "en": "英文",
    "ja": "日文为主，日英混合",
    "yue": "粤语为主，粤英混合",
    "ko": "韩语为主，韩英混合",
    "all_zh": "整段按中文识别",
    "all_ja": "整段按日文识别",
    "all_yue": "整段按粤语识别",
    "all_ko": "整段按韩语识别",
}

#: 前端展示用的精简语言（合并 all_* 变体）
LANGUAGE_PRESETS: List[Dict[str, Any]] = [
    {"code": "zh", "label": "中文", "flag": "zh"},
    {"code": "en", "label": "English", "flag": "en"},
    {"code": "ja", "label": "日本語", "flag": "ja"},
    {"code": "ko", "label": "한국어", "flag": "ko"},
    {"code": "yue", "label": "粤语", "flag": "yue"},
    {"code": "auto", "label": "自动识别", "flag": "auto"},
]

#: 训练语料 `list` 文件里允许的语种代码（官方 1-get-text.py 的映射表的键）
TRAIN_LANGUAGES: Tuple[str, ...] = ("zh", "en", "ja", "ko", "yue")


def languages_for(version: str) -> List[str]:
    """返回指定版本支持的推理语言。"""
    return list(V1_LANGUAGES if version == "v1" else V2_LANGUAGES)


def resolve_version(name: str) -> Optional[str]:
    """大小写不敏感地把版本名解析成规范写法。

    为什么需要：版本名是混合大小写（`v2ProPlus`），而前端 model id 是小写
    （`gpt-sovits-v2proplus`）。只做 `in VERSIONS` 校验的话，用户会看到
    「未知模型版本：v2proplus」—— 对着一堆看起来一模一样的选项发懵。
    解析不出来返回 None，由调用方决定报什么错。
    """
    lowered = (name or "").strip().lower()
    return next((item for item in VERSIONS if item.lower() == lowered), None)


def is_supported_language(code: str, version: str = DEFAULT_VERSION) -> bool:
    """判断语种代码是否被指定版本接受。

    存在的原因是**外部传入的值必须被校验**：音色库曾经直接存下
    `prompt_lang` 的字面量 `"undefined"`（前端把未填的字段塞进 FormData 时会这样），
    之后每次合成都报「不支持合成语种 undefined」。写入端与读取端都要用它兜底。
    """
    return (code or "").strip().lower() in languages_for(version)


def supports_streaming(version: str) -> bool:
    """v3/v4 使用声码器（`use_vocoder`），官方明确不支持流式推理。"""
    return version not in {"v3", "v4"}


# --------------------------------------------------------------------------
# 文本切分方式
# --------------------------------------------------------------------------

#: 取值与官方 `text_segmentation_method.py::get_method_names()` 一致
TEXT_SPLIT_METHODS: Tuple[str, ...] = ("cut0", "cut1", "cut2", "cut3", "cut4", "cut5")

TEXT_SPLIT_NOTES: Dict[str, str] = {
    "cut0": "不切分：整段一次性送模型，长文本容易漏字或复读",
    "cut1": "按换行切分：你自己控制断句，最稳定",
    "cut2": "按标点 + 换行切分",
    "cut3": "按英文句点等强标点切分",
    "cut4": "按中文句号、问号、感叹号等强标点切分（短文本推荐）",
    "cut5": "按逗号级标点切分 + 长度约束（长文本推荐，默认）",
}

#: 前端「切分方式」下拉的推荐顺序：默认 cut5 在首位
SPLIT_METHOD_ORDER: Tuple[str, ...] = ("cut5", "cut4", "cut3", "cut2", "cut1", "cut0")


# --------------------------------------------------------------------------
# 权重目录与预训练权重（对齐根目录 config.py）
# --------------------------------------------------------------------------

GPT_WEIGHT_DIRS: Dict[str, str] = {
    "v1": "GPT_weights",
    "v2": "GPT_weights_v2",
    "v3": "GPT_weights_v3",
    "v4": "GPT_weights_v4",
    "v2Pro": "GPT_weights_v2Pro",
    "v2ProPlus": "GPT_weights_v2ProPlus",
}

SOVITS_WEIGHT_DIRS: Dict[str, str] = {
    "v1": "SoVITS_weights",
    "v2": "SoVITS_weights_v2",
    "v3": "SoVITS_weights_v3",
    "v4": "SoVITS_weights_v4",
    "v2Pro": "SoVITS_weights_v2Pro",
    "v2ProPlus": "SoVITS_weights_v2ProPlus",
}

#: 推理/训练用的预训练权重（相对 GPT-SoVITS 根目录）
PRETRAINED_GPT: Dict[str, str] = {
    "v1": "GPT_SoVITS/pretrained_models/s1bert25hz-2kh-longer-epoch=68e-step=50232.ckpt",
    "v2": "GPT_SoVITS/pretrained_models/gsv-v2final-pretrained/s1bert25hz-5kh-longer-epoch=12-step=369668.ckpt",
    "v3": "GPT_SoVITS/pretrained_models/s1v3.ckpt",
    "v4": "GPT_SoVITS/pretrained_models/s1v3.ckpt",
    "v2Pro": "GPT_SoVITS/pretrained_models/s1v3.ckpt",
    "v2ProPlus": "GPT_SoVITS/pretrained_models/s1v3.ckpt",
}

PRETRAINED_SOVITS_G: Dict[str, str] = {
    "v1": "GPT_SoVITS/pretrained_models/s2G488k.pth",
    "v2": "GPT_SoVITS/pretrained_models/gsv-v2final-pretrained/s2G2333k.pth",
    "v3": "GPT_SoVITS/pretrained_models/s2Gv3.pth",
    "v4": "GPT_SoVITS/pretrained_models/gsv-v4-pretrained/s2Gv4.pth",
    "v2Pro": "GPT_SoVITS/pretrained_models/v2Pro/s2Gv2Pro.pth",
    "v2ProPlus": "GPT_SoVITS/pretrained_models/v2Pro/s2Gv2ProPlus.pth",
}

#: SoVITS 判别器权重。v3/v4 走 LoRA 训练（`s2_train_v3_lora.py`），
#: 官方该脚本只读取 `pretrained_s2G`，判别器路径不参与训练，故留空。
PRETRAINED_SOVITS_D: Dict[str, str] = {
    "v1": "GPT_SoVITS/pretrained_models/s2D488k.pth",
    "v2": "GPT_SoVITS/pretrained_models/gsv-v2final-pretrained/s2D2333k.pth",
    "v3": "",
    "v4": "",
    "v2Pro": "GPT_SoVITS/pretrained_models/v2Pro/s2Dv2Pro.pth",
    "v2ProPlus": "GPT_SoVITS/pretrained_models/v2Pro/s2Dv2ProPlus.pth",
}

#: v3/v4 训练用 LoRA 脚本，其余版本用全量微调脚本
def s2_train_script(version: str) -> str:
    return S2_TRAIN_LORA_SCRIPT if version in {"v3", "v4"} else S2_TRAIN_SCRIPT

BERT_DIR = "GPT_SoVITS/pretrained_models/chinese-roberta-wwm-ext-large"
HUBERT_DIR = "GPT_SoVITS/pretrained_models/chinese-hubert-base"
SV_PRETRAINED = "GPT_SoVITS/pretrained_models/sv/pretrained_eres2netv2w24s4ep4.ckpt"
#: 官方 BigVGAN（v3 声码器）在整合包内以 HF 缓存目录形式分发
BIGVGAN_DIR = "GPT_SoVITS/pretrained_models/models--nvidia--bigvgan_v2_24khz_100band_256x"

#: 训练配置模板
S1_CONFIG_TEMPLATE = {"v1": "GPT_SoVITS/configs/s1longer.yaml"}
S1_CONFIG_TEMPLATE_DEFAULT = "GPT_SoVITS/configs/s1longer-v2.yaml"


def s2_config_template(version: str) -> str:
    """v2Pro / v2ProPlus 使用专属模板，其余用通用模板。"""
    if version in {"v2Pro", "v2ProPlus"}:
        return "GPT_SoVITS/configs/s2%s.json" % version
    return "GPT_SoVITS/configs/s2.json"


def s1_config_template(version: str) -> str:
    return S1_CONFIG_TEMPLATE.get(version, S1_CONFIG_TEMPLATE_DEFAULT)


#: 训练脚本入口（相对根目录），对齐 webui.py
S1_TRAIN_SCRIPT = "GPT_SoVITS/s1_train.py"
S2_TRAIN_SCRIPT = "GPT_SoVITS/s2_train.py"
S2_TRAIN_LORA_SCRIPT = "GPT_SoVITS/s2_train_v3_lora.py"

#: 数据预处理脚本（相对根目录），全部通过环境变量驱动，无命令行参数
PREPARE_SCRIPTS: Dict[str, str] = {
    "text": "GPT_SoVITS/prepare_datasets/1-get-text.py",
    "hubert": "GPT_SoVITS/prepare_datasets/2-get-hubert-wav32k.py",
    "sv": "GPT_SoVITS/prepare_datasets/2-get-sv.py",
    "semantic": "GPT_SoVITS/prepare_datasets/3-get-semantic.py",
}

#: 训练数据集的产物文件名（相对实验目录），对齐 webui.py 的拼接逻辑
DATASET_FILES: Dict[str, str] = {
    "phoneme": "2-name2text.txt",
    "semantic": "6-name2semantic.tsv",
}

#: 实验根目录（对齐官方 config.py 的 exp_root）
EXPERIMENT_ROOT = "logs"

# --------------------------------------------------------------------------
# 音频预处理默认参数（对齐 webui.py 切分页默认值）
# --------------------------------------------------------------------------

SLICE_DEFAULTS: Dict[str, float] = {
    # 静音阈值，越小越敏感
    "threshold": -34.0,
    # 片段最短时长（毫秒）
    "min_length": 4000.0,
    # 静音处最小间隔（毫秒）
    "min_interval": 300.0,
    # 相邻静音点之间的最短距离（毫秒）
    "hop_size": 10.0,
    # 单段最长保留静音（毫秒）
    "max_sil_kept": 500.0,
    # 峰值归一化上限
    "max": 0.9,
    # 音量归一化系数
    "alpha": 0.25,
    # 默认并行分片数
    "n_parts": 1,
}

# precisions 取自官方 `tools/asr/config.py::asr_dict`，不是猜的：
#   FunASR 只给了 float32（且该脚本的 -p 参数官方注明「还没接入」，实际不生效）；
#   faster-whisper 才真正把它传给 WhisperModel(compute_type=...)。
ASR_BACKENDS: Dict[str, Dict[str, Any]] = {
    "funasr": {
        "script": "tools/asr/funasr_asr.py",
        "label": "FunASR（中文/粤语最佳，含标点）",
        "sizes": ["tiny", "base", "small", "medium", "large"],
        "languages": ["zh", "en", "ja", "ko", "yue"],
        "precisions": ["float32"],
        "precision_effective": False,
        "needs_gpu": True,
    },
    "fasterwhisper": {
        "script": "tools/asr/fasterwhisper_asr.py",
        "label": "faster-whisper（多语种，速度快）",
        "sizes": ["tiny", "base", "small", "medium", "large-v2", "large-v3"],
        "languages": ["zh", "en", "ja", "ko", "yue", "auto"],
        "precisions": ["float32", "float16", "int8"],
        "precision_effective": True,
        "needs_gpu": True,
    },
}

DENOISE_SCRIPT = "tools/cmd-denoise.py"
SLICE_SCRIPT = "tools/slice_audio.py"

# --------------------------------------------------------------------------
# UVR5 人声/伴奏分离 & 去混响 & 去延迟
# --------------------------------------------------------------------------
#
# 官方只提供了 Gradio 版本（tools/uvr5/webui.py），无法集成进流水线。
# 但它的算法本体（tools/uvr5/vr.py、mdxnet.py、bsroformer.py）是可以
# 直接调用的 —— 我们自己在 trainer/tools/uvr_cli.py 里做一层薄封装，
# 不改动官方任何文件。

UVR5_DIR = "tools/uvr5"
UVR5_WEIGHTS_DIR = "tools/uvr5/uvr5_weights"

#: 各模型的用途说明（取自官方 webui.py 的界面文案）
UVR5_MODEL_NOTES: Dict[str, str] = {
    "HP2_all_vocals": "保留人声：不带和声的素材选它，对主人声的保留比 HP5 好",
    "HP5_only_main_vocal": "仅保留主人声：带和声时选它，但会削弱主人声",
    "VR-DeEchoNormal": "去延迟（Normal）",
    "VR-DeEchoAggressive": "去延迟（Aggressive）—— 比 Normal 更彻底",
    "VR-DeEchoDeReverb": "去延迟 + 去混响，耗时约为另外两个 DeEcho 的 2 倍",
    "onnx_dereverb_By_FoxJoy": "MDX-Net 去混响：双通道混响的最佳选择，不能去除单通道混响",
}

#: 模型名 → 推理类别。决定用哪个官方类来加载（与 webui.py 的分派逻辑一致）
UVR5_MODEL_KINDS = {
    "AudioPre": "保留人声 / 仅保留主人声（VR 架构）",
    "AudioPreDeEcho": "去延迟 / 去混响（VR 架构，vocal 与 ins 是反的）",
    "Roformer_Loader": "BS-RoFormer（需要同名的 .yaml 配置文件）",
    "MDXNetDereverb": "MDX-Net 去混响（onnx）",
}

#: 导出格式（官方 webui.py 的 Radio 选项）
UVR5_FORMATS: Tuple[str, ...] = ("wav", "flac", "mp3", "m4a")


def classify_uvr_model(name: str) -> str:
    """按模型名判断用哪个官方类加载（与 webui.py 的 if/elif 保持一致）。"""
    if name == "onnx_dereverb_By_FoxJoy":
        return "MDXNetDereverb"
    if "roformer" in name.lower():
        return "Roformer_Loader"
    return "AudioPreDeEcho" if "DeEcho" in name else "AudioPre"


def list_uvr_models(home: Path) -> List[Dict[str, Any]]:
    """扫描整合包里**实际存在**的 UVR5 模型。

    只列磁盘上有的：官方整合包里就没有 HP3，而 BS-RoFormer 缺 .yaml 时
    也只能标注成不可用 —— 让用户看到「为什么这个模型选不了」，
    比给一个下拉框、点了才报错要好。
    """
    root = home / Path(UVR5_WEIGHTS_DIR)
    if not root.is_dir():
        return []

    models: List[Dict[str, Any]] = []
    for entry in sorted(root.iterdir()):
        if entry.is_dir():
            if "onnx" not in entry.name:
                continue
            name, weight = entry.name, entry / "vocals.onnx"
        else:
            suffix = entry.suffix.lower()
            if suffix not in {".pth", ".ckpt"}:
                continue
            name, weight = entry.stem, entry
        if not weight.is_file():
            continue

        kind = classify_uvr_model(name)
        config = root / ("%s.yaml" % name)
        missing_config = kind == "Roformer_Loader" and not config.is_file()
        models.append(
            {
                "id": name,
                "kind": kind,
                "label": name,
                "note": UVR5_MODEL_NOTES.get(name, ""),
                "size_mb": round(weight.stat().st_size / 1024 / 1024, 1),
                #: 去混响/去延迟类只产出「人声」，伴奏分离才有双输出
                "dual_output": kind in {"AudioPre"},
                "available": not missing_config,
                "missing_config": missing_config,
            }
        )
    return models

# --------------------------------------------------------------------------
# 合成默认参数（对齐官方 api_v2.py 的 TTS_Request 默认值）
# --------------------------------------------------------------------------

DEFAULT_SYNTH_PARAMS: Dict[str, Any] = {
    "text_split_method": "cut5",
    "top_k": 15,
    "top_p": 1.0,
    "temperature": 1.0,
    "repetition_penalty": 1.35,
    "batch_size": 1,
    "batch_threshold": 0.75,
    "split_bucket": True,
    "speed_factor": 1.0,
    "fragment_interval": 0.3,
    "seed": -1,
    "parallel_infer": True,
    "sample_steps": 32,
    "super_sampling": False,
    "streaming_mode": False,
    "overlap_length": 2,
    "min_chunk_length": 16,
}

#: 参考音频的合法时长区间（秒），官方 `_set_prompt_semantic` 的硬约束
REF_AUDIO_MIN_SEC = 3.0
REF_AUDIO_MAX_SEC = 10.0

#: 单次合成文本长度上限（字符）。官方无硬限制，这里是本地服务的自保阈值。
MAX_TEXT_LENGTH = 20000

#: 批量合成的条目数上限
MAX_BATCH_ITEMS = 500


def to_public_catalog() -> Dict[str, Any]:
    """打包给前端的完整能力清单。"""
    return {
        "versions": [
            {"id": version, "label": version, "note": VERSION_NOTES.get(version, "")}
            for version in VERSIONS
        ],
        "default_version": DEFAULT_VERSION,
        "languages": LANGUAGE_PRESETS,
        "language_notes": LANGUAGE_NOTES,
        "text_split_methods": [
            {"id": name, "label": name, "note": TEXT_SPLIT_NOTES.get(name, "")}
            for name in SPLIT_METHOD_ORDER
        ],
        "train_languages": list(TRAIN_LANGUAGES),
        "asr_backends": [
            {"id": key, **value} for key, value in ASR_BACKENDS.items()
        ],
        "slice_defaults": dict(SLICE_DEFAULTS),
        "synth_defaults": dict(DEFAULT_SYNTH_PARAMS),
        "ref_audio": {
            "min_sec": REF_AUDIO_MIN_SEC,
            "max_sec": REF_AUDIO_MAX_SEC,
            "note": "官方硬约束：参考音频需为 3~10 秒、单人、无明显底噪",
        },
        "limits": {
            "max_text_length": MAX_TEXT_LENGTH,
            "max_batch_items": MAX_BATCH_ITEMS,
        },
    }

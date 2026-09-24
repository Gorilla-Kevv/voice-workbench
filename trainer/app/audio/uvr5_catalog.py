"""UVR5 模型清单与预置档位。

UVR5 的模型名（`HP2_all_vocals`、`VR-DeReverb`、`model_bs_roformer_ep_317_sdr_12.9755`…）
对使用者毫无意义，但选错模型的代价很大：把带和声的歌按 HP5 处理会削掉主人声，
用错架构（VR 的权重喂给 RoFormer 类）会直接加载失败。

所以这里做两件事：

1. **把模型名翻译成场景档位**（快速 / 仅主唱 / 高保真 / 去混响 / 去回声），
   界面只暴露档位，模型名作为实现细节留在后端；
2. **集中一份分类逻辑**，修掉官方 webui 里那个流传很广的坑：`VR-DeReverb`
   不含子串 `DeEcho`，按 `"DeEcho" in name` 分派会被当成普通 VR 模型，加载必失败。

常量集中在这里，`audio/uvr5.py` 与 API 层都从这取，避免两处各写一份而慢慢漂移。
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

#: 推理类别（对应官方三个脚本里的类）
KIND_VR = "AudioPre"
KIND_DEECHO = "AudioPreDeEcho"
KIND_ROFORMER = "Roformer_Loader"
KIND_MDX = "MDXNetDereverb"

#: 类别 → 读法说明（界面上会显示）
KIND_LABELS: Dict[str, str] = {
    KIND_VR: "人声/伴奏分离（VR 架构）",
    KIND_DEECHO: "去回声 / 去混响（VR 架构）",
    KIND_ROFORMER: "高保真分离（BS-RoFormer）",
    KIND_MDX: "去混响（MDX-Net，onnx）",
}


def classify(model_name: str) -> str:
    """按模型名判断用官方哪个类加载。

    与 `tools/uvr5/webui.py` 的分派保持一致，但补上了 DeReverb：
    官方判据是 `"DeEcho" not in model_name`，而 `VR-DeReverb` 里没有 `DeEcho` 子串，
    于是会被错误地交给 `AudioPre`（4band_v2 + CascadedASPPNet），加载时炸在 state_dict。
    """
    if model_name == "onnx_dereverb_By_FoxJoy":
        return KIND_MDX
    if "roformer" in model_name.lower():
        return KIND_ROFORMER
    if "DeEcho" in model_name or "DeReverb" in model_name:
        return KIND_DEECHO
    return KIND_VR


def is_separator(model_name: str) -> bool:
    """这个模型是「分轨」还是「净化」。净化类（去混响/去回声）只产人声，不产伴奏。"""
    return classify(model_name) in {KIND_VR, KIND_ROFORMER}


#: 预置档位。界面只暴露 `key`，其余是实现细节。
#: `vram_mb` 用于准入提示：BS-RoFormer 滑窗推理很吃显存，8GB 卡上要提前说清。
SEPARATION_PRESETS: List[Dict[str, Any]] = [
    {
        "key": "off",
        "label": "不分离",
        "model": "",
        "kind": "",
        "agg": 10,
        "vram_mb": 0,
        "hint": "源音频本身就是纯人声时选它，省掉整段分离时间",
    },
    {
        "key": "vocal_fast",
        "label": "快速分离",
        "model": "HP2_all_vocals",
        "kind": KIND_VR,
        "agg": 10,
        "vram_mb": 2048,
        "hint": "通用档：保留全部人声（含和声），速度快、显存占用低",
    },
    {
        "key": "vocal_main",
        "label": "仅保留主唱",
        "model": "HP5_only_main_vocal",
        "kind": KIND_VR,
        "agg": 10,
        "vram_mb": 2048,
        "hint": "带和声的歌选它；代价是主人声会被略微削弱",
    },
    {
        "key": "vocal_hifi",
        "label": "高保真分离",
        "model": "model_bs_roformer_ep_317_sdr_12.9755",
        "kind": KIND_ROFORMER,
        "agg": 10,
        "vram_mb": 4096,
        "hint": "质量最好，显存与耗时都明显更高；8GB 显卡请先关掉其它模型",
    },
]

#: 二级处理（在分离之后，对**人声**再做一次净化）
SECONDARY_PRESETS: List[Dict[str, Any]] = [
    {"key": "none", "label": "不做", "model": "", "kind": "", "hint": ""},
    {
        "key": "dereverb",
        "label": "去混响",
        "model": "VR-DeEchoDeReverb",
        "kind": KIND_DEECHO,
        "hint": "录音棚之外的素材（现场、房间录音）建议开；耗时约为纯去回声的 2 倍",
    },
    {
        "key": "deecho_normal",
        "label": "去回声（常规）",
        "model": "VR-DeEchoNormal",
        "kind": KIND_DEECHO,
        "hint": "轻微回声/延迟",
    },
    {
        "key": "deecho_aggressive",
        "label": "去回声（强力）",
        "model": "VR-DeEchoAggressive",
        "kind": KIND_DEECHO,
        "hint": "回声明显时用；可能吃掉一点人声细节",
    },
]

#: 导出格式。默认 wav：后续环节（变声/混音）都要重新读取，
#: flac 省空间但多一次解码，mp3/m4a 还会依赖 ffmpeg 可执行文件。
OUTPUT_FORMATS = ("wav", "flac", "mp3", "m4a")
DEFAULT_FORMAT = "wav"


def preset(key: str, table: Optional[List[Dict[str, Any]]] = None) -> Optional[Dict[str, Any]]:
    """按 key 取档位。未知 key 返回 None，由调用方决定是报错还是回退默认。"""
    for item in table or SEPARATION_PRESETS:
        if item["key"] == key:
            return item
    return None


def secondary_preset(key: str) -> Optional[Dict[str, Any]]:
    return preset(key, SECONDARY_PRESETS)


def to_public() -> Dict[str, Any]:
    """给 `/v1/uvr/catalog` 用的完整清单。"""
    return {
        "presets": SEPARATION_PRESETS,
        "secondary": SECONDARY_PRESETS,
        "formats": list(OUTPUT_FORMATS),
        "default_format": DEFAULT_FORMAT,
        "kinds": KIND_LABELS,
    }

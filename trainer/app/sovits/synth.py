"""统一请求 → 官方 `TTS.run(inputs)` 的翻译层。

前端只提交一套「合成意图」，本模块负责把它翻译成官方 API 需要的字段，
并在翻译过程中做**能在发车前做完的所有校验**：

* 语种是否被当前版本支持（v1 只有中英日，韩语/粤语要 v2 起）；
* 参考音频是否可用、提示文本是否缺失；
* 数值参数是否落在官方可解释的范围内（越界会静默产出劣质音频，比报错更糟）。

校验失败一律抛 `BadRequestError`，并把「怎么改」写进 hint。
"""

from __future__ import annotations

import io
import time
import wave
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from ..errors import BadRequestError, EnvironmentError_
from . import catalog
from .voices import Voice, VoiceLibrary


@dataclass
class Reference:
    """一次合成实际使用的参考音频组合。"""

    audio_path: str
    prompt_text: str
    prompt_lang: str
    aux_paths: List[str] = field(default_factory=list)
    voice_id: Optional[str] = None
    voice_name: Optional[str] = None
    label: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "audio_path": self.audio_path,
            "prompt_text": self.prompt_text,
            "prompt_lang": self.prompt_lang,
            "aux_paths": list(self.aux_paths),
            "voice_id": self.voice_id,
            "voice_name": self.voice_name,
            "label": self.label,
        }


# --------------------------------------------------------------------------
# 参考音频解析
# --------------------------------------------------------------------------


def resolve_reference(
    payload: Dict[str, Any],
    library: VoiceLibrary,
    version: str,
    default_lang: str = "zh",
) -> Reference:
    """决定用哪个音色唱。

    解析顺序：
    1. `voice` 命中音色库 → 直接用（最常用）
    2. `voice` 是一个存在的文件路径 → 当外部音色用
    3. 显式给了 `ref_audio_path` → 用它，搭配 `prompt_text` / `prompt_lang`
    4. 都没有 → 报错并说明「GPT-SoVITS 必须有参考音频」
    """
    voice_token = (payload.get("voice") or "").strip()
    ref_audio_path = (payload.get("ref_audio_path") or "").strip()
    prompt_text = (payload.get("prompt_text") or payload.get("ref_text") or "").strip()
    prompt_lang = (payload.get("prompt_lang") or default_lang or "zh").strip()

    aux_paths: List[str] = []
    for raw in payload.get("aux_ref_audio_paths") or []:
        candidate = str(raw).strip()
        if not candidate:
            continue
        path = _resolve_path(candidate, library)
        if path.is_file():
            aux_paths.append(str(path))
        else:
            raise BadRequestError(
                "辅助参考音频不存在：%s" % candidate,
                hint="多参考融合时需要每一段音频都真实存在。",
            )

    record: Optional[Voice] = library.resolve(voice_token) if voice_token else None
    if record is not None:
        if not record.is_usable():
            raise BadRequestError(
                "音色「%s」的音频文件已丢失" % record.name,
                hint="该文件可能被移动或删除，请在音色库中重新上传。",
            )
        return Reference(
            audio_path=record.audio_path,
            # 显式传入的 prompt_text 优先于库里存的，便于临时微调
            prompt_text=prompt_text or record.prompt_text,
            prompt_lang=prompt_lang or record.prompt_lang,
            aux_paths=aux_paths,
            voice_id=record.id,
            voice_name=record.name,
            label=record.name,
        )

    if ref_audio_path:
        path = _resolve_path(ref_audio_path, library)
        if not path.is_file():
            raise BadRequestError(
                "参考音频不存在：%s" % ref_audio_path,
                hint="请检查路径，或在音色库中先导入该音色。",
            )
        return Reference(
            audio_path=str(path),
            prompt_text=prompt_text,
            prompt_lang=prompt_lang,
            aux_paths=aux_paths,
            label=prompt_text[:16] or path.stem,
        )

    if voice_token:
        # 既不是音色 ID 也不是文件路径 —— 这是最常见的误用，要说清楚
        candidate = _resolve_path(voice_token, library)
        if candidate.is_file():
            return Reference(
                audio_path=str(candidate),
                prompt_text=prompt_text,
                prompt_lang=prompt_lang,
                aux_paths=aux_paths,
                label=candidate.stem,
            )
        raise BadRequestError(
            "音色「%s」在音色库中不存在，也不是一个有效的音频路径" % voice_token,
            hint="GPT-SoVITS 没有内置音色：请先到「音色库」导入一段 3~10 秒的参考音频。",
            code="VOICE_NOT_FOUND",
        )

    raise BadRequestError(
        "缺少参考音频",
        hint=(
            "GPT-SoVITS 属于零样本/少样本克隆模型，必须提供参考音频与它的转写文本。\n"
            "请到「音色库」导入一段 3~10 秒、单人、无背景音的干净音频。"
        ),
        code="REF_AUDIO_REQUIRED",
    )


def _resolve_path(raw: str, library: VoiceLibrary) -> Path:
    path = Path(raw).expanduser()
    if path.is_absolute():
        return path
    # 相对路径先按 GPT-SoVITS 根目录解释（官方约定），失败再按数据目录
    from . import bootstrap

    installation = bootstrap.current()
    if installation is not None:
        candidate = (installation.home / path).resolve()
        if candidate.exists():
            return candidate
    return (library.data_dir / path).resolve()


# --------------------------------------------------------------------------
# 参数归一化
# --------------------------------------------------------------------------


def _clamp(value: Any, low: float, high: float, fallback: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    if number != number:  # NaN
        return fallback
    return max(low, min(high, number))


def _int(value: Any, fallback: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return fallback


def _bool(value: Any, fallback: bool) -> bool:
    if value is None:
        return fallback
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def normalize_params(payload: Dict[str, Any], version: str) -> Dict[str, Any]:
    """把前端传来的自由字典收敛成官方可解释的参数集合。"""
    defaults = catalog.DEFAULT_SYNTH_PARAMS

    split_method = str(payload.get("text_split_method") or defaults["text_split_method"])
    if split_method not in catalog.TEXT_SPLIT_METHODS:
        raise BadRequestError(
            "未知的文本切分方式：%s" % split_method,
            hint="可用值：%s" % "、".join(catalog.TEXT_SPLIT_METHODS),
        )

    streaming = _bool(payload.get("streaming_mode"), bool(defaults["streaming_mode"]))
    if streaming and not catalog.supports_streaming(version):
        raise BadRequestError(
            "版本 %s 不支持流式推理" % version,
            hint="官方说明：v3/v4 使用声码器，流式模式不可用。可改用 v2ProPlus，或关闭流式。",
        )

    batch_size = _int(payload.get("batch_size"), int(defaults["batch_size"]))
    batch_size = max(1, min(32, batch_size))

    seed = payload.get("seed", defaults["seed"])
    seed = -1 if seed in ("", None) else _int(seed, -1)

    return {
        "text_split_method": split_method,
        "top_k": max(1, min(100, _int(payload.get("top_k"), int(defaults["top_k"])))),
        "top_p": _clamp(payload.get("top_p"), 0.01, 1.0, float(defaults["top_p"])),
        "temperature": _clamp(payload.get("temperature"), 0.01, 2.0, float(defaults["temperature"])),
        "repetition_penalty": _clamp(
            payload.get("repetition_penalty"), 1.0, 3.0, float(defaults["repetition_penalty"])
        ),
        "batch_size": batch_size,
        "batch_threshold": _clamp(
            payload.get("batch_threshold"), 0.0, 1.0, float(defaults["batch_threshold"])
        ),
        "split_bucket": _bool(payload.get("split_bucket"), bool(defaults["split_bucket"])),
        "speed_factor": _clamp(payload.get("speed_factor"), 0.5, 2.0, float(defaults["speed_factor"])),
        "fragment_interval": _clamp(
            payload.get("fragment_interval"), 0.0, 1.0, float(defaults["fragment_interval"])
        ),
        "seed": seed,
        "parallel_infer": _bool(payload.get("parallel_infer"), bool(defaults["parallel_infer"])),
        "sample_steps": max(1, min(64, _int(payload.get("sample_steps"), int(defaults["sample_steps"])))),
        "super_sampling": _bool(payload.get("super_sampling"), bool(defaults["super_sampling"])),
        "streaming_mode": streaming,
        "overlap_length": max(0, min(64, _int(payload.get("overlap_length"), int(defaults["overlap_length"])))),
        "min_chunk_length": max(
            1, min(256, _int(payload.get("min_chunk_length"), int(defaults["min_chunk_length"])))
        ),
    }


def normalize_text(payload: Dict[str, Any], version: str) -> Tuple[str, str]:
    """返回 (清洗后的文本, text_lang)。"""
    text = payload.get("text") or ""
    if not isinstance(text, str):
        raise BadRequestError("text 必须是字符串")
    text = text.strip()
    if not text:
        raise BadRequestError("待合成文本不能为空")
    if len(text) > catalog.MAX_TEXT_LENGTH:
        raise BadRequestError(
            "文本长度 %d 超过上限 %d" % (len(text), catalog.MAX_TEXT_LENGTH),
            hint="超长文本请使用批量合成，或先自行切分成多条。",
        )

    text_lang = str(payload.get("text_lang") or payload.get("language") or "zh").strip() or "zh"
    supported = catalog.languages_for(version)
    if text_lang not in supported:
        raise BadRequestError(
            "版本 %s 不支持合成语种 %s" % (version, text_lang),
            hint=(
                "该版本支持的取值：%s\n"
                "其中韩语（ko）与粤语（yue）需要 v2 及以上版本。"
                % "、".join(supported)
            ),
            code="UNSUPPORTED_LANGUAGE",
        )
    return text, text_lang


def build_inputs(
    payload: Dict[str, Any],
    library: VoiceLibrary,
    version: str,
) -> Dict[str, Any]:
    """组装官方 `TTS.run()` 的输入字典。"""
    mode = str(payload.get("mode") or "preset").strip().lower()
    if mode == "design":
        raise BadRequestError(
            "GPT-SoVITS 不支持「用文字描述生成音色」",
            hint=(
                "它只能复制已有音色：请改用「声音克隆」上传参考音频，"
                "或在开关面板切换到 MiMo 音色设计模型。"
            ),
            code="MODE_UNSUPPORTED",
        )
    if mode not in {"preset", "clone"}:
        raise BadRequestError("未知的合成模式：%s" % mode, hint="可用值：preset、clone")

    text, text_lang = normalize_text(payload, version)
    reference = resolve_reference(payload, library, version)
    params = normalize_params(payload, version)

    prompt_lang = reference.prompt_lang or "zh"
    supported = catalog.languages_for(version)
    if prompt_lang not in supported:
        raise BadRequestError(
            "版本 %s 不支持参考音频语种 %s" % (version, prompt_lang),
            hint="该版本支持的取值：%s" % "、".join(supported),
            code="UNSUPPORTED_LANGUAGE",
        )

    inputs: Dict[str, Any] = {
        "text": text,
        "text_lang": text_lang,
        "ref_audio_path": reference.audio_path,
        "aux_ref_audio_paths": reference.aux_paths,
        "prompt_text": reference.prompt_text,
        "prompt_lang": prompt_lang,
    }
    inputs.update(params)
    return {
        "mode": mode,
        "text": text,
        "text_lang": text_lang,
        "inputs": inputs,
        "reference": reference,
        "params": params,
    }


# --------------------------------------------------------------------------
# 音频编码
# --------------------------------------------------------------------------


def to_wav_bytes(sample_rate: int, audio: Any) -> bytes:
    """把官方返回的 int16 数组编码为 WAV 字节。"""
    if sample_rate is None or sample_rate <= 0:
        raise EnvironmentError_("推理返回了非法采样率：%r" % sample_rate, code="BAD_SAMPLE_RATE")

    try:
        import soundfile  # noqa: PLC0415

        buffer = io.BytesIO()
        soundfile.write(buffer, audio, int(sample_rate), format="WAV")
        return buffer.getvalue()
    except ImportError:
        pass

    # 退化路径：标准库 wave。官方返回的是 int16，可直接写。
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(int(sample_rate))
        handle.writeframes(audio.tobytes() if hasattr(audio, "tobytes") else bytes(audio))
    return buffer.getvalue()


def audio_duration_s(sample_rate: int, audio: Any) -> float:
    if not sample_rate:
        return 0.0
    length = len(audio)
    return round(length / float(sample_rate), 3)


def wav_file_duration_s(path: Path) -> float:
    """从 WAV 头读时长，避免为了一个数字去解码整个文件。"""
    try:
        with wave.open(str(path), "rb") as handle:
            frames = handle.getnframes()
            rate = handle.getframerate()
            if rate:
                return round(frames / float(rate), 3)
    except Exception:  # noqa: BLE001
        pass
    return 0.0


def timestamp() -> float:
    return time.time()

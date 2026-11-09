"""合成链路：请求校验 → 参考音频解析 → 显存准入 → 互斥 → 推理 → 落盘。

与 Irodori 的取舍一致：
- **参考音频只认路径**（`ref_path`）或音色库 id（`ref_voice` → 读共享 `voicelib/voices.json`）；
- 合成并发一律 409，不排队（8GB 卡排队第二条也是显存抖动）；
- 响应返回 base64 WAV + 服务端落盘路径 + 实测 RTF。
"""

from __future__ import annotations

import base64
import io
import json
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

from .config import PROJECT_DIR, Settings
from .errors import CosyvoiceError
from . import engine
from .hardware import vram_mb


LANGUAGE_CODES = {"zh", "en", "ja", "ko", "de", "es", "fr", "it", "ru"}
MODES = {"zero_shot", "cross_lingual", "instruct2"}


@dataclass
class SynthPayload:
    text: str
    mode: str = "zero_shot"
    prompt_text: str = ""
    instruct_text: str = ""
    ref_path: Optional[str] = None
    ref_voice: Optional[str] = None
    language: Optional[str] = None
    speed: float = 1.0


def _as_str(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def parse_payload(body: Any) -> SynthPayload:
    if not isinstance(body, dict):
        raise CosyvoiceError("BAD_REQUEST", "请求体必须是 JSON 对象", "用 JSON body，字段见 /v1/catalog。")

    text = _as_str(body.get("text"))
    if not text:
        raise CosyvoiceError("BAD_REQUEST", "text 不能为空", "传入要合成的文本。")

    mode = _as_str(body.get("mode")) or "zero_shot"
    if mode not in MODES:
        raise CosyvoiceError(
            "BAD_REQUEST",
            f"不支持的 mode：{mode!r}",
            "mode ∈ zero_shot / cross_lingual / instruct2；见 /v1/catalog 的 modes。",
        )

    try:
        speed = float(body.get("speed") or 1.0)
    except (TypeError, ValueError) as error:
        raise CosyvoiceError("BAD_REQUEST", f"speed 必须是数字：{body.get('speed')!r}", "取值 0.5~2.0。") from error
    if not 0.5 <= speed <= 2.0:
        raise CosyvoiceError("BAD_REQUEST", f"speed 超出范围：{speed}", "取值 0.5~2.0。")

    language = _as_str(body.get("language")) or None
    if language and language not in LANGUAGE_CODES:
        raise CosyvoiceError(
            "BAD_REQUEST",
            f"不支持的语言：{language!r}",
            f"可选：{', '.join(sorted(LANGUAGE_CODES))}；见 /v1/catalog。",
        )

    return SynthPayload(
        text=text,
        mode=mode,
        prompt_text=_as_str(body.get("prompt_text")),
        instruct_text=_as_str(body.get("instruct_text")),
        ref_path=_as_str(body.get("ref_path")) or None,
        ref_voice=_as_str(body.get("ref_voice")) or None,
        language=language,
        speed=speed,
    )


def _check_ref_file(path: Path, label: str, settings: Settings) -> float:
    if not path.is_file():
        raise CosyvoiceError(
            "REF_NOT_FOUND",
            f"{label}不存在：{path}",
            "确认路径正确；从音色库选音色可避免手写路径。",
        )
    try:
        import soundfile as sf  # noqa: PLC0415
    except ImportError as error:  # pragma: no cover
        raise CosyvoiceError("ENV_BROKEN", "soundfile 不可用，无法读取参考音频", "重装 venv：pip install soundfile。") from error
    try:
        info = sf.info(str(path))
    except Exception as error:
        raise CosyvoiceError("REF_UNREADABLE", f"{label}读不出来：{error}", "换成 wav/flac 等常见格式。") from error
    if info.duration < settings.min_ref_seconds:
        raise CosyvoiceError(
            "REF_TOO_SHORT",
            f"{label}只有 {info.duration:.1f}s（下限 {settings.min_ref_seconds:.0f}s）",
            "参考太短克隆不出音色；官方建议 3~10 秒。",
        )
    if info.duration > settings.max_ref_seconds:
        raise CosyvoiceError(
            "REF_TOO_LONG",
            f"{label}有 {info.duration:.1f}s（上限 {settings.max_ref_seconds:.0f}s）",
            "截取 3~10 秒最稳；过长会拖慢首条推理。",
        )
    return float(info.duration)


def _resolve_voice(settings: Settings, voice_id: str) -> dict[str, Any]:
    index = settings.voicelib_dir / "voices.json"
    try:
        records = json.loads(index.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise CosyvoiceError(
            "VOICE_NOT_FOUND",
            f"音色库不存在或为空：{index}",
            "先在「音色库」页导入音色，或改用 ref_path 直接给磁盘路径。",
        ) from error
    except (json.JSONDecodeError, OSError) as error:
        raise CosyvoiceError("VOICE_LIB_BROKEN", f"音色库读不出来：{error}", "检查 voicelib/voices.json。") from error
    if not isinstance(records, list):
        raise CosyvoiceError("VOICE_LIB_BROKEN", "音色库格式不对（应为数组）", "检查 voicelib/voices.json。")

    for record in records:
        if not (isinstance(record, dict) and record.get("id") == voice_id):
            continue
        name = str(record.get("name") or voice_id)
        path = str(record.get("audio_path") or "")
        if not path:
            clips = record.get("ref_clips")
            if isinstance(clips, list) and clips and isinstance(clips[0], dict):
                path = str(clips[0].get("path") or "")
        if not path:
            break
        return {"voice_id": voice_id, "voice_name": name, "path": Path(path), "ref_source": "voicelib"}

    raise CosyvoiceError(
        "VOICE_NOT_FOUND",
        f"音色库中没有 id 为 {voice_id!r} 的音色（共 {len(records)} 条）",
        "到「音色库」页核对音色 id；或改用 ref_path 直接给磁盘路径。",
    )


def resolve_reference(settings: Settings, payload: SynthPayload) -> dict[str, Any]:
    if payload.ref_voice:
        resolved = _resolve_voice(settings, payload.ref_voice)
        _check_ref_file(resolved["path"], f"音色 {resolved['voice_name']} 的参考音频", settings)
        return resolved

    if payload.ref_path:
        raw = Path(payload.ref_path)
        path = raw if raw.is_absolute() else (PROJECT_DIR / raw)
        _check_ref_file(path, "参考音频", settings)
        return {"voice_id": None, "voice_name": None, "path": path, "ref_source": "ref_path"}

    raise CosyvoiceError(
        "REF_REQUIRED",
        "必须提供参考音频：ref_path 或 ref_voice 二选一",
        "用音色库选音色，或给本机 wav 路径。",
    )


def _language_prefix(text: str, language: Optional[str]) -> str:
    if not language:
        return text
    if text.lstrip().startswith("<|"):
        return text
    return f"<|{language}|>{text}"


def _run_inference(settings: Settings, payload: SynthPayload, ref_path: str) -> Any:
    import torch  # noqa: PLC0415

    model, _ = engine.load(settings)
    text = payload.text
    if payload.mode == "cross_lingual":
        text = _language_prefix(text, payload.language)

    with torch.inference_mode():
        if payload.mode == "zero_shot":
            generator = model.inference_zero_shot(
                text, payload.prompt_text, ref_path, stream=False, speed=payload.speed
            )
        elif payload.mode == "cross_lingual":
            generator = model.inference_cross_lingual(
                text, ref_path, stream=False, speed=payload.speed
            )
        else:
            instruct = payload.instruct_text.strip()
            if not instruct.endswith("<|endofprompt|>"):
                instruct = f"{instruct}<|endofprompt|>"
            generator = model.inference_instruct2(
                text, instruct, ref_path, stream=False, speed=payload.speed
            )
        chunks = [item["tts_speech"] for item in generator]
    if not chunks:
        raise CosyvoiceError("SYNTH_EMPTY", "模型没有返回音频", "换一段文本/参考音重试；若持续为空请查看服务日志。")
    return torch.cat(chunks, dim=1) if len(chunks) > 1 else chunks[0]


def run_synthesis(settings: Settings, payload: SynthPayload) -> dict[str, Any]:
    if len(payload.text) > settings.max_text_length:
        raise CosyvoiceError(
            "TEXT_TOO_LONG",
            f"文本 {len(payload.text)} 字，超过上限 {settings.max_text_length}",
            "拆成多段合成；CosyVoice 会在服务端按句切分，但超长会显著拉长单请求。",
        )
    if payload.mode in {"zero_shot", "instruct2"} and not payload.prompt_text:
        raise CosyvoiceError(
            "PROMPT_TEXT_REQUIRED",
            f"{payload.mode} 模式必须提供参考音频的逐字转写 prompt_text",
            "用「音色库」里的转写，或改用 cross_lingual（不需要转写）。",
        )
    if payload.mode == "instruct2" and not payload.instruct_text:
        raise CosyvoiceError("INSTRUCT_REQUIRED", "instruct2 模式必须提供 instruct_text", "例如「用四川话说这句话」。")

    reference = resolve_reference(settings, payload)
    loaded = engine.is_loaded()
    admission = engine.check_vram_admission(settings, loaded=loaded)

    if not engine.try_acquire_busy():
        raise CosyvoiceError(
            "BUSY",
            "CosyVoice3 正在合成另一条请求",
            "8GB 卡不排队：等上一条完成后再试。",
            status=409,
            retryable=True,
        )

    started = time.perf_counter()
    try:
        speech = _run_inference(settings, payload, str(reference["path"]))
        import numpy as np  # noqa: PLC0415
        import soundfile as sf  # noqa: PLC0415

        audio = speech.squeeze(0).float().cpu().numpy()
        if audio.ndim != 1:
            audio = audio.reshape(-1)
        audio = np.clip(audio, -1.0, 1.0)

        settings.outputs_dir.mkdir(parents=True, exist_ok=True)
        wav_path = settings.outputs_dir / f"{uuid.uuid4().hex}.wav"
        sf.write(str(wav_path), audio, settings.sample_rate, subtype="PCM_16")

        buffer = io.BytesIO()
        sf.write(buffer, audio, settings.sample_rate, format="WAV", subtype="PCM_16")
        elapsed = time.perf_counter() - started
        duration = len(audio) / settings.sample_rate

        return {
            "ok": True,
            "audio_base64": base64.b64encode(buffer.getvalue()).decode("ascii"),
            "sample_rate": settings.sample_rate,
            "duration_sec": round(duration, 3),
            "elapsed_sec": round(elapsed, 3),
            "rtf": round(elapsed / duration, 4) if duration > 0 else None,
            "wav_path": str(wav_path),
            "mode": payload.mode,
            "text": payload.text,
            "voice_id": reference.get("voice_id"),
            "voice_name": reference.get("voice_name"),
            "ref_source": reference.get("ref_source"),
            "speed": payload.speed,
            "language": payload.language,
            "instruct_text": payload.instruct_text or None,
            "loaded": engine.is_loaded(),
            "vram": admission.get("vram") or vram_mb(),
        }
    except CosyvoiceError:
        raise
    except Exception as error:
        raise CosyvoiceError(
            "SYNTH_FAILED",
            f"合成失败：{type(error).__name__}: {error}",
            "先看服务日志；显存不足时先释放其它模型，权重/依赖问题跑 npm run cosyvoice:check。",
            status=500,
            retryable=True,
        ) from error
    finally:
        engine.release_busy()

"""GPT-SoVITS v5 的 API：/health /v1/catalog /v1/warmup /v1/unload /v1/synth。

与 indextts 同哲学：`/health` 永远 200，“活着”与“模型可用”是两件事，
由接口里的 `loaded` 与 `weights` 如实呈现；错误一律 `{ok:false, error:{code,message,retryable,hint}}`。
"""

from __future__ import annotations

import base64
import io
import time
import wave
from pathlib import Path

from fastapi import Body, FastAPI, Request
from fastapi.responses import JSONResponse

from .config import DEFAULT_VARIANT, REQUIRED_VRAM_MB, Settings, VARIANTS
from .errors import Gsv5Error
from .gsv5_engine import Gsv5Engine
from .voices import resolve_voice

SETTINGS: Settings | None = None
ENGINE: Gsv5Engine | None = None


def _wave_bytes(sample_rate: int, pcm: bytes) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(pcm)
    return buf.getvalue()


def create_app(settings: Settings) -> FastAPI:
    global SETTINGS, ENGINE
    SETTINGS = settings
    ENGINE = Gsv5Engine(settings)

    app = FastAPI(title="GPT-SoVITS v5 API", version="1.0.0")

    @app.exception_handler(Gsv5Error)
    async def gsv5_error_handler(_request: Request, exc: Gsv5Error):
        return JSONResponse(status_code=exc.status, content=exc.to_body())

    @app.get("/health")
    async def health():
        status = ENGINE.status()
        return {
            "ok": True,
            "service": "gsv5",
            "loaded": status["loaded"],
            "engine": status,
            "weights": SETTINGS.weights_ready(),
            "variants": list(VARIANTS),
            "default_variant": SETTINGS.default_variant,
        }

    @app.get("/v1/catalog")
    async def catalog():
        variants_info = [
            {
                "id": v,
                "label": f"GPT-SoVITS {v} ({'极速 4 步' if v == 'v5turbo' else '高质 32 步'})",
                "default_sample_steps": 4 if v == "v5turbo" else 32,
                "required_vram_mb": REQUIRED_VRAM_MB.get(v, 3072),
            }
            for v in VARIANTS
        ]
        return {
            "ok": True,
            "variants": variants_info,
            "default_variant": SETTINGS.default_variant,
            "languages": ["zh", "en", "ja", "all_zh", "all_ja"],
            "note": "v5 是 GPT-SoVITS 官方第五代推理底模。turbo 适合实时对话，dev 适合高质量输出。",
        }

    @app.post("/v1/warmup")
    async def warmup(payload: dict = Body(default={})):
        variant = payload.get("variant") or SETTINGS.default_variant
        res = ENGINE.load(variant)
        return {"ok": True, **res}

    @app.post("/v1/unload")
    async def unload():
        res = ENGINE.unload()
        return {"ok": True, **res}

    @app.post("/v1/synth")
    async def synth(payload: dict = Body(...)):
        variant = payload.get("variant") or ENGINE.loaded_variant or SETTINGS.default_variant
        if not ENGINE.loaded_variant:
            ENGINE.load(variant)

        ref_voice = payload.get("ref_voice")
        ref_audio_path = payload.get("ref_audio_path")
        prompt_text = payload.get("prompt_text") or ""
        prompt_lang = payload.get("prompt_lang") or "zh"

        if ref_voice:
            voice_data = resolve_voice(SETTINGS.voices_lib_dir, ref_voice)
            ref_audio_path = voice_data["audio_path"]
            if not prompt_text:
                prompt_text = voice_data.get("prompt_text") or ""
            if not payload.get("prompt_lang"):
                prompt_lang = voice_data.get("prompt_lang") or "zh"

        if not ref_audio_path:
            raise Gsv5Error("REF_REQUIRED", "必须提供参考音频（ref_voice 或 ref_audio_path）", status=400)

        started = time.time()
        chunks = ENGINE.synthesize(
            {
                **payload,
                "variant": variant,
                "ref_audio_path": ref_audio_path,
                "prompt_text": prompt_text,
                "prompt_lang": prompt_lang,
            }
        )

        sample_rate = chunks[0][0] if chunks else 32000
        pcm = b"".join(c[1] for c in chunks)
        total_bytes = sum(c[2] for c in chunks)
        duration_sec = total_bytes / 2 / sample_rate
        wav = _wave_bytes(sample_rate, pcm)
        elapsed = time.time() - started

        return {
            "ok": True,
            "audio_base64": base64.b64encode(wav).decode("ascii"),
            "sample_rate": sample_rate,
            "duration_sec": round(duration_sec, 2),
            "elapsed_sec": round(elapsed, 2),
            "rtf": round(elapsed / max(duration_sec, 0.01), 3),
            "variant": variant,
            "engine": ENGINE.status(),
        }

    @app.post("/v1/voices/probe")
    async def voices_probe(ids: list[str] = Body(default=[])):
        result = {}
        for voice_id in ids:
            try:
                voice = resolve_voice(SETTINGS.voices_lib_dir, voice_id)
                result[voice_id] = {"found": True, "has_prompt_text": bool(voice.get("prompt_text"))}
            except Gsv5Error:
                result[voice_id] = {"found": False}
        return {"ok": True, "voices": result}

    return app

"""IndexTTS 服务路由与 FastAPI 装配。

端点与 `netease/app/routers/confucius.py` 保持同构，网关侧零学习成本：
- `GET  /health`            永远 200，可用性在 `engine.loaded` 里
- `GET  /v1/pipeline`       引擎状态
- `POST /v1/warmup`         预加载（显存检查在先）
- `POST /v1/unload`         卸载归还显存
- `POST /v1/synth`          multipart 合成，返回 base64 音频
"""

from __future__ import annotations

import base64
import json
import os
import time
import uuid
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI, File, Form, Request, UploadFile

from .config import Settings
from .errors import IndexTtsError
from .hardware import vram_mb
from .indextts_engine import IndexTtsPipeline

MAX_SEGMENTS = 20
DEFAULT_GAP_MS = 120


def error_body(error: IndexTtsError) -> dict:
    return error.to_body()


def create_app(settings: Settings) -> FastAPI:
    app = FastAPI(title='IndexTTS local service', version='0.1.0')
    engine = IndexTtsPipeline(settings)
    app.state.engine = engine
    app.state.settings = settings

    @app.exception_handler(IndexTtsError)
    async def _handle(request: Request, error: IndexTtsError):  # noqa: ANN202
        from fastapi.responses import JSONResponse  # noqa: PLC0415

        return JSONResponse(status_code=error.status, content=error.to_body())

    @app.get('/health')
    def health() -> dict[str, Any]:
        return {
            'ok': True,
            'service': 'indextts',
            'version': '0.1.0',
            'cuda': __import__('torch').cuda.is_available() if _torch_ok() else False,
            # 自报 PID：网关据此确证端口归属（见 lib/processOwnership.ts 判据 ⓪）
            'pid': os.getpid(),
            'vram': vram_mb(),
            'engine': engine.status(),
        }

    @app.get('/v1/pipeline')
    def pipeline() -> dict[str, Any]:
        return {'ok': True, **engine.status()}

    @app.get('/v1/catalog')
    def catalog() -> dict[str, Any]:
        # 门槛/取值范围的唯一事实源在服务端（前端只留兜底常量，与坑 19 同一哲学）
        return {
            'ok': True,
            'languages': ['ZH', 'EN', 'JA', 'AR', 'ES'],
            'duration_factor': {'min': 0.5, 'max': 2.0, 'default': 1.0},
            'emo_dimensions': ['喜', '怒', '哀', '惧', '厌恶', '低落', '惊喜', '平静'],
            'emo_alpha': {'min': 0.0, 'max': 1.0, 'default': 0.65},
            'emo_text_control': False,  # 需 use_qwen_emo 额外加载 0.6B 模型，显存吃紧，暂不接
            'segment_synthesis': {
                'max_segments': MAX_SEGMENTS,
                'gap_ms': {'min': 0, 'max': 1000, 'default': DEFAULT_GAP_MS},
            },
            'required_vram_mb': IndexTtsPipeline.REQUIRED_VRAM_MB,
        }

    @app.post('/v1/warmup')
    def warmup() -> dict[str, Any]:
        _guard_vram(engine)
        return {'ok': True, 'engine': engine.ensure_loaded()}

    @app.post('/v1/unload')
    def unload() -> dict[str, Any]:
        return {'ok': True, 'engine': engine.unload()}

    @app.post('/v1/synth')
    def synth(
        request: Request,
        text: str = Form(...),
        lang: str = Form('ZH'),
        file: Optional[UploadFile] = File(None),
        ref_path: Optional[str] = Form(None),
        duration_factor: float = Form(1.0),
        emo_vector: Optional[str] = Form(None),
        emo_alpha: float = Form(0.65),
        emo_file: Optional[UploadFile] = File(None),
    ) -> dict[str, Any]:
        settings = request.app.state.settings
        prompt_wav = _resolve_ref(settings, file, ref_path)
        emo_values = _parse_emo_vector(emo_vector)
        emo_audio = _resolve_ref(settings, emo_file, None) if emo_file is not None and emo_file.filename else None
        _guard_vram(engine)
        result = engine.generate(
            text=text,
            lang=lang,
            prompt_wav=prompt_wav,
            duration_factor=float(duration_factor),
            emo_vector=emo_values,
            emo_alpha=float(emo_alpha),
            emo_audio=emo_audio,
        )
        audio_bytes = Path(result['path']).read_bytes()
        return {
            'ok': True,
            'audio_base64': base64.b64encode(audio_bytes).decode('ascii'),
            'sample_rate': result['sample_rate'],
            'duration_sec': result['duration_sec'],
            'elapsed_sec': result['elapsed_sec'],
            'path': result['path'],
            'language': lang,
        }

    @app.post('/v1/synth/segments')
    def synth_segments(
        request: Request,
        segments: str = Form(...),
        lang: str = Form('ZH'),
        file: Optional[UploadFile] = File(None),
        ref_path: Optional[str] = Form(None),
        duration_factor: float = Form(1.0),
        gap_ms: int = Form(DEFAULT_GAP_MS),
    ) -> dict[str, Any]:
        """分段合成：每段可带独立 8 维情感向量/强度，服务端拼接成一条音频。

        参考音频/音色与语言是全局的；只有「文案 + 情感」按段变化。
        这样「前半段平静、后半段激动」不需要用户手动切文件再拼。
        """
        settings = request.app.state.settings
        prompt_wav = _resolve_ref(settings, file, ref_path)
        parsed = _parse_segments(segments)
        _guard_vram(engine)
        started = time.monotonic()
        results: list[dict[str, Any]] = []
        for segment in parsed:
            results.append(
                engine.generate(
                    text=segment['text'],
                    lang=lang,
                    prompt_wav=prompt_wav,
                    duration_factor=float(duration_factor),
                    emo_vector=segment['emo_vector'],
                    emo_alpha=segment['emo_alpha'],
                )
            )

        out_dir = settings.uploads_dir / 'indextts'
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = out_dir / f'segments-{time.strftime("%Y%m%d-%H%M%S")}-{uuid.uuid4().hex[:8]}.wav'
        sample_rate, duration = _concat_wavs([item['path'] for item in results], out_path, gap_ms)
        audio_bytes = out_path.read_bytes()
        return {
            'ok': True,
            'audio_base64': base64.b64encode(audio_bytes).decode('ascii'),
            'sample_rate': sample_rate,
            'duration_sec': duration,
            'elapsed_sec': round(time.monotonic() - started, 2),
            'path': str(out_path),
            'language': lang,
            'segments': [
                {
                    'index': index,
                    'text': segment['text'],
                    'duration_sec': results[index]['duration_sec'],
                    'elapsed_sec': results[index]['elapsed_sec'],
                    'emo_vector': segment['emo_vector'],
                    'emo_alpha': segment['emo_alpha'],
                }
                for index, segment in enumerate(parsed)
            ],
        }

    return app


def _torch_ok() -> bool:
    try:
        import torch  # noqa: PLC0415

        return True
    except Exception:  # noqa: BLE001
        return False


def _parse_emo_vector(raw: Optional[str]) -> Optional[list[float]]:
    """情感向量以 JSON 数组字符串随 multipart 传入（8 个 0~1 的数）。"""
    if raw is None or not raw.strip():
        return None
    import json  # noqa: PLC0415

    try:
        parsed = json.loads(raw)
    except ValueError as error:
        raise IndexTtsError('BAD_EMO_VECTOR', f'情感向量不是合法 JSON：{error}', '传 8 个 0~1 数字的 JSON 数组。') from error
    if not isinstance(parsed, list):
        raise IndexTtsError('BAD_EMO_VECTOR', '情感向量必须是 JSON 数组', '传 8 个 0~1 数字的 JSON 数组。')
    return [float(v) for v in parsed]


def _parse_segments(raw: str) -> list[dict[str, Any]]:
    """解析前端传来的分段 JSON：[{text, emo_vector?, emo_alpha?}, ...]。"""
    if not raw or not raw.strip():
        raise IndexTtsError('EMPTY_SEGMENTS', '分段列表为空', '至少给一段文本。')
    try:
        parsed = json.loads(raw)
    except ValueError as error:
        raise IndexTtsError(
            'BAD_SEGMENTS',
            f'分段不是合法 JSON：{error}',
            '传 [{"text":"...","emo_vector":[...],"emo_alpha":0.65}]。',
        ) from error
    if not isinstance(parsed, list) or not parsed:
        raise IndexTtsError('BAD_SEGMENTS', '分段必须是数组', '至少给一段文本。')
    if len(parsed) > MAX_SEGMENTS:
        raise IndexTtsError(
            'SEGMENTS_TOO_MANY',
            f'分段数 {len(parsed)} 超过上限 {MAX_SEGMENTS}',
            '拆成多批，或减少分段数量。',
        )

    segments: list[dict[str, Any]] = []
    for index, item in enumerate(parsed):
        number = index + 1
        if not isinstance(item, dict):
            raise IndexTtsError('BAD_SEGMENTS', f'第 {number} 段不是对象', '每段用 {"text":"...", ...}。')
        text = str(item.get('text') or '').strip()
        if not text:
            raise IndexTtsError('EMPTY_SEGMENT_TEXT', f'第 {number} 段文本为空', '删除空段或补上文本。')
        vector = item.get('emo_vector')
        if vector is not None:
            if (
                not isinstance(vector, list)
                or len(vector) != 8
                or any(not isinstance(value, (int, float)) for value in vector)
            ):
                raise IndexTtsError(
                    'BAD_EMO_VECTOR',
                    f'第 {number} 段情感向量必须是 8 个数字',
                    '按目录里的维度顺序传 8 个 0~1 的浮点数。',
                )
            vector = [max(0.0, min(1.0, float(value))) for value in vector]
        alpha = item.get('emo_alpha', 0.65)
        try:
            alpha = max(0.0, min(1.0, float(alpha)))
        except (TypeError, ValueError) as error:
            raise IndexTtsError('BAD_EMO_ALPHA', f'第 {number} 段情感强度不是数字', '传 0~1 的浮点数。') from error
        segments.append({'text': text, 'emo_vector': vector, 'emo_alpha': alpha})
    return segments


def _concat_wavs(paths: list[str], out_path: Path, gap_ms: int) -> tuple[int, float]:
    """把多段 wav 拼成一条；段间留 gap_ms 静音，段首尾加 5ms 淡入淡出避免爆音。"""
    import numpy as np  # noqa: PLC0415
    import soundfile as sf  # noqa: PLC0415

    arrays: list[Any] = []
    sample_rate: Optional[int] = None
    for path in paths:
        audio, rate = sf.read(path, dtype='float32', always_2d=True)
        mono = np.asarray(audio).mean(axis=1).reshape(-1)
        if sample_rate is None:
            sample_rate = int(rate)
        elif int(rate) != sample_rate:
            raise IndexTtsError(
                'SAMPLE_RATE_MISMATCH',
                f'分段采样率不一致：{rate} Hz vs {sample_rate} Hz',
                '这是服务端异常；请把完整日志提供给开发者。',
            )
        fade = int(sample_rate * 0.005)
        if fade > 0 and len(mono) > fade * 2:
            mono = mono.copy()
            mono[:fade] *= np.linspace(0.0, 1.0, fade, dtype=np.float32)
            mono[-fade:] *= np.linspace(1.0, 0.0, fade, dtype=np.float32)
        arrays.append(mono)

    if sample_rate is None:
        raise IndexTtsError('EMPTY_SEGMENTS', '没有可拼接的音频', '至少给一段文本。')

    gap = np.zeros(int(sample_rate * max(0, min(1000, int(gap_ms))) / 1000), dtype=np.float32)
    chunks: list[Any] = []
    for index, array in enumerate(arrays):
        if index > 0 and gap.size:
            chunks.append(gap)
        chunks.append(array)
    final = np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.float32)
    sf.write(str(out_path), final, sample_rate, subtype='PCM_16')
    return sample_rate, float(len(final) / sample_rate)


def _resolve_ref(settings: Settings, file: Optional[UploadFile], ref_path: Optional[str]) -> Path:
    if file is not None and file.filename:
        out_dir = settings.uploads_dir / 'ref'
        out_dir.mkdir(parents=True, exist_ok=True)
        target = out_dir / f'ref-{int(time.time())}-{uuid.uuid4().hex[:8]}{Path(file.filename).suffix or ".wav"}'
        with target.open('wb') as sink:
            while chunk := file.file.read(1024 * 1024):
                sink.write(chunk)
        return target
    if ref_path:
        path = Path(ref_path)
        if not path.exists():
            raise IndexTtsError('REF_AUDIO_MISSING', f'参考音频不存在：{ref_path}', '改用文件上传，或给本机有效路径。')
        return path
    raise IndexTtsError('REF_AUDIO_REQUIRED', '缺少参考音频', '上传一段 ≥3 秒的参考音频。')


def _guard_vram(engine: Optional[IndexTtsPipeline] = None) -> None:
    """显存准入：nvidia-smi 口径，门槛取 `IndexTtsPipeline.REQUIRED_VRAM_MB`（阶段 26 实测净占 ~5.27 GB）。

    模型已常驻时跳过 —— 这时「空闲不足」是本服务自己占的，拦住的恰恰是唯一的出路。
    """
    if engine is not None and engine.status()['loaded']:
        return
    from .indextts_engine import IndexTtsPipeline  # noqa: PLC0415

    REQUIRED_VRAM_MB = IndexTtsPipeline.REQUIRED_VRAM_MB

    info = vram_mb()
    if info is None:
        return
    if info['free_mb'] < REQUIRED_VRAM_MB:
        torch_free = info.get('torch_free_mb')
        hint = '先关闭其它常驻模型，或到设置页关闭不需要的服务。'
        if isinstance(torch_free, int) and torch_free - info['free_mb'] > 1024:
            hint = (
                f'当前有约 {torch_free - info["free_mb"]} MB 显存被**其它进程**占用（不是本服务），'
                '先关掉占显存的程序（浏览器硬件加速 / 安卓模拟器 / 游戏 / GPT-SoVITS）再重试。'
            )
        raise IndexTtsError(
            'VRAM_INSUFFICIENT',
            f'空闲显存不足：需要约 {REQUIRED_VRAM_MB} MB，当前仅 {info["free_mb"]} MB / 共 {info["total_mb"]} MB',
            hint,
            status=503,
        )

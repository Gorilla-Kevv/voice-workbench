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
import time
import uuid
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI, File, Form, Request, UploadFile

from .config import Settings
from .errors import IndexTtsError
from .hardware import vram_mb
from .indextts_engine import IndexTtsPipeline


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
            'vram': vram_mb(),
            'engine': engine.status(),
        }

    @app.get('/v1/pipeline')
    def pipeline() -> dict[str, Any]:
        return {'ok': True, **engine.status()}

    @app.post('/v1/warmup')
    def warmup() -> dict[str, Any]:
        _guard_vram()
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
    ) -> dict[str, Any]:
        prompt_wav = _resolve_ref(request.app.state.settings, file, ref_path)
        _guard_vram()
        result = engine.generate(
            text=text,
            lang=lang,
            prompt_wav=prompt_wav,
            duration_factor=float(duration_factor),
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

    return app


def _torch_ok() -> bool:
    try:
        import torch  # noqa: PLC0415

        return True
    except Exception:  # noqa: BLE001
        return False


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


def _guard_vram() -> None:
    """显存准入：nvidia-smi 口径，门槛 3 GB（IndexTTS-2.5 BF16 的估计值，实测后校准）。"""
    from .indextts_engine import REQUIRED_VRAM_MB  # noqa: PLC0415

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

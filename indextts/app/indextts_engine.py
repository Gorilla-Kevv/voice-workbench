"""IndexTTS-2.5 引擎适配层。

接入面刻意收窄：上游 API 变化只改这一个文件（与 `netease/app/tts_engine.py` 同一策略）。
"""

from __future__ import annotations

import threading
import time
import uuid
from pathlib import Path
from typing import Any, Optional

import numpy as np

from .config import Settings
from .errors import IndexTtsError


class IndexTtsPipeline:
    """模型常驻 + 单线程顺序执行（与 trainer / netease 同一哲学）。"""

    #: 显存准入门槛（MB）。IndexTTS-2.5 0.8B BF16 估约 2~3 GB，先按 3 GB 拦，实测后校准
    REQUIRED_VRAM_MB = 3072

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._model: Optional[Any] = None
        self._loaded_at = 0.0
        self._device = ''
        self._lock = threading.Lock()

    # ------------------------------------------------------------------ 状态

    def status(self) -> dict[str, Any]:
        loaded = self._model is not None
        return {
            'engine': 'indextts',
            'loaded': loaded,
            'device': self._device or None,
            'loaded_for_sec': round(time.monotonic() - self._loaded_at, 1) if loaded else None,
        }

    def unload(self) -> dict[str, Any]:
        model = self._model
        self._model = None
        self._loaded_at = 0.0
        if model is not None:
            try:
                import torch  # noqa: PLC0415

                del model
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except Exception:  # noqa: BLE001
                pass
        return self.status()

    # ------------------------------------------------------------------ 加载

    def ensure_loaded(self) -> dict[str, Any]:
        if self._model is not None:
            return self.status()
        cfg = self._settings
        if not cfg.cfg_path.exists():
            raise IndexTtsError(
                'MODEL_MISSING',
                f'权重不完整：找不到 {cfg.cfg_path}',
                '先按 docs/INDEX-TTS-INTEGRATION.md 阶段 1 下载 IndexTTS-2.5 权重。',
            )
        started = time.monotonic()
        with self._lock:
            if self._model is not None:
                return self.status()
            try:
                from indextts.infer_v2_5 import IndexTTS2  # noqa: PLC0415

                import torch  # noqa: PLC0415

                self._device = 'cuda' if torch.cuda.is_available() else 'cpu'
                if self._device != 'cuda' and not cfg.allow_cpu:
                    raise IndexTtsError('NO_CUDA', '当前解释器没有可用的 CUDA。', '按文档建好 uv 环境后重试。')
                self._model = IndexTTS2(
                    cfg_path=str(cfg.cfg_path),
                    model_dir=str(cfg.model_dir),
                    use_bf16=cfg.use_bf16 and self._device == 'cuda',
                    use_cuda_kernel=cfg.use_cuda_kernel,
                    use_deepspeed=False,
                    use_cuda=self._device == 'cuda',
                )
            except IndexTtsError:
                raise
            except Exception as error:
                raise IndexTtsError(
                    'LOAD_FAILED',
                    f'模型加载失败：{type(error).__name__}: {error}',
                    '权重不完整或依赖缺失时，重跑 docs/INDEX-TTS-INTEGRATION.md 阶段 1。',
                ) from error
            self._loaded_at = time.monotonic()
        return self.status()

    # ------------------------------------------------------------------ 推理

    def generate(
        self,
        text: str,
        lang: str,
        prompt_wav: Path,
        duration_factor: float = 1.0,
    ) -> dict[str, Any]:
        if not text.strip():
            raise IndexTtsError('EMPTY_TEXT', '合成文本为空', '请输入要合成的文本。')
        if not prompt_wav.exists():
            raise IndexTtsError('REF_AUDIO_MISSING', f'参考音频不存在：{prompt_wav}', '上传一段 ≥3 秒的参考音频。')

        self.ensure_loaded()
        started = time.monotonic()
        with self._lock:
            try:
                import soundfile as sf  # noqa: PLC0415

                out_dir = self._settings.uploads_dir / 'indextts'
                out_dir.mkdir(parents=True, exist_ok=True)
                out_path = out_dir / f'{time.strftime("%Y%m%d-%H%M%S")}-{uuid.uuid4().hex[:8]}.wav'
                # 上游 infer() 自己写文件；duration_factor 是官方语速控制（0.5~2.0）
                self._model.infer(
                    spk_audio_prompt=str(prompt_wav),
                    text=text,
                    lang=lang,
                    output_path=str(out_path),
                    duration_factor=max(0.5, min(2.0, duration_factor)),
                    verbose=False,
                )
                audio, sample_rate = sf.read(str(out_path), dtype='float32', always_2d=True)
                mono = np.asarray(audio).mean(axis=1).reshape(-1)
                duration = float(len(mono) / sample_rate) if sample_rate else 0.0
            except IndexTtsError:
                raise
            except Exception as error:
                raise IndexTtsError(
                    'SYNTH_FAILED',
                    f'合成失败：{type(error).__name__}: {error}',
                    '常见原因：显存不足、参考音频过短（≥3 秒）或格式不支持。',
                ) from error
        return {
            'path': str(out_path),
            'sample_rate': int(sample_rate),
            'duration_sec': duration,
            'elapsed_sec': round(time.monotonic() - started, 2),
        }

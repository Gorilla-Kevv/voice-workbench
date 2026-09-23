import { Router } from 'express';
import { AppError } from '../lib/errors.js';
import { PRESET_VOICES } from '../services/mimo.js';
import { parseAudioSample } from '../services/audio.js';
import { config } from '../config/index.js';

export const voiceRouter = Router();

/** GET /api/voices/presets - 官方预置音色列表（mimo-v2.5-tts 专用） */
voiceRouter.get('/presets', (_req, res) => {
  res.json({ ok: true, data: PRESET_VOICES });
});

/**
 * POST /api/voices/sample
 * 上传音频样本前的本地校验：格式、体积、可解析性。
 * 返回规范化后的 data URI，供后续 clone 模式直接复用。
 */
voiceRouter.post('/sample', (req, res, next) => {
  try {
    const { audio } = req.body as { audio?: string };
    if (!audio) {
      throw new AppError(400, 'SAMPLE_REQUIRED', '请上传用于克隆的音频样本');
    }
    const sample = parseAudioSample(audio);
    res.json({
      ok: true,
      data: {
        mimeType: sample.mimeType,
        bytes: sample.bytes,
        maxBytes: config.maxSampleBytes,
        /** 仅回传长度与格式摘要，避免大体积 data URI 在网络中二次往返 */
        preview: sample.dataUri.slice(0, 64),
      },
    });
  } catch (error) {
    next(error);
  }
});

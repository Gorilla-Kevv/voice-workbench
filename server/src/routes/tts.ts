import { Router } from 'express';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { TTS_MODELS, synthesize, type TtsMode } from '../services/mimo.js';
import { synthLimiter } from '../middleware/rateLimit.js';

export const ttsRouter = Router();

const VALID_MODES: TtsMode[] = ['preset', 'design', 'clone'];

interface SynthesizeBody {
  mode?: string;
  text?: string;
  instruction?: string;
  voice?: string;
  format?: string;
  optimizeTextPreview?: boolean;
  autoSegment?: boolean;
  apiKey?: string;
  baseUrl?: string;
}

/**
 * POST /api/tts/synthesize
 * 三种模式统一入口：
 *  - preset  通用语音合成（mimo-v2.5-tts）
 *  - design  音色设计（mimo-v2.5-tts-voicedesign）
 *  - clone   声音克隆（mimo-v2.5-tts-voiceclone）
 */
ttsRouter.post('/synthesize', synthLimiter, async (req, res, next) => {
  try {
    const body = req.body as SynthesizeBody;
    const mode = body.mode as TtsMode | undefined;

    if (!mode || !VALID_MODES.includes(mode)) {
      throw new AppError(400, 'INVALID_REQUEST', `mode 必须为 ${VALID_MODES.join(' / ')} 之一`);
    }

    const format = body.format === 'pcm16' ? 'pcm16' : 'wav';

    const result = await synthesize(
      {
        mode,
        text: body.text ?? '',
        instruction: body.instruction,
        voice: body.voice,
        format,
        optimizeTextPreview: body.optimizeTextPreview,
        apiKey: body.apiKey,
        baseUrl: body.baseUrl,
      },
      { autoSegment: body.autoSegment !== false },
    );

    logger.info('合成接口返回', {
      mode,
      model: result.model,
      segments: result.segments.length,
      bytes: result.bytes,
      durationSec: result.durationSec,
    });

    res.json({
      ok: true,
      data: {
        // 逐段返回，前端据此堆叠展示、单独下载或打包导出
        segments: result.segments.map((segment) => ({
          index: segment.index,
          audio: segment.audioBase64,
          bytes: segment.bytes,
          durationSec: segment.durationSec,
          text: segment.text,
        })),
        mimeType: result.mimeType,
        format: result.format,
        model: result.model,
        bytes: result.bytes,
        durationSec: result.durationSec,
        segmented: result.segmented,
        segmentCount: result.segments.length,
        mode,
        text: body.text ?? '',
      },
    });
  } catch (error) {
    next(error);
  }
});

/** GET /api/tts/models - 暴露三种模型标识，便于前端展示与排查 */
ttsRouter.get('/models', (_req, res) => {
  res.json({
    ok: true,
    data: [
      { mode: 'preset', model: TTS_MODELS.preset, label: '通用语音合成', features: ['预置音色', '音频标签', '唱歌模式', '低延迟流式'] },
      { mode: 'design', model: TTS_MODELS.design, label: '音色设计', features: ['自然语言描述生成音色', '文本智能润色'] },
      { mode: 'clone', model: TTS_MODELS.clone, label: '声音克隆', features: ['上传 mp3/wav 样本', '10MB 以内', '零样本复刻'] },
    ],
  });
});

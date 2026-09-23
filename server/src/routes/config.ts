import { Router } from 'express';
import { AppError } from '../lib/errors.js';
import { verifyApiKey } from '../services/mimo.js';
import { config } from '../config/index.js';

export const configRouter = Router();

/** GET /api/config - 客户端启动时读取的运行时配置 */
configRouter.get('/', (_req, res) => {
  res.json({
    ok: true,
    data: {
      hasServerKey: Boolean(config.mimoApiKey),
      baseUrl: config.mimoBaseUrl,
      maxTextLength: config.maxTextLength,
      maxSampleBytes: config.maxSampleBytes,
      synthsPerMinute: config.rateLimit.synthMax,
    },
  });
});

/**
 * POST /api/config/verify
 * 使用指定（或服务端）API Key 发起一次最小合成请求，验证可用性。
 */
configRouter.post('/verify', async (req, res, next) => {
  try {
    const { apiKey, baseUrl } = req.body as { apiKey?: string; baseUrl?: string };
    const key = apiKey?.trim() || config.mimoApiKey;

    if (!key) {
      throw new AppError(401, 'MISSING_API_KEY', '请先填写 API Key 再验证');
    }

    const result = await verifyApiKey(key, baseUrl);
    if (result.ok) {
      res.json({
        ok: true,
        data: { valid: true, message: result.message, usingServerKey: !apiKey?.trim() },
      });
      return;
    }

    res.status(400).json({
      ok: false,
      error: { code: 'UNAUTHORIZED', message: result.message, retryable: false },
    });
  } catch (error) {
    next(error);
  }
});

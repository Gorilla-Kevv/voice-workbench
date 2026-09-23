import { Router } from 'express';
import { config } from '../config/index.js';
import { generalLimiter } from '../middleware/rateLimit.js';
import { logger } from '../lib/logger.js';
import { configRouter } from './config.js';
import { sovitsSummary } from './sovits.js';
import { ttsRouter } from './tts.js';
import { voiceRouter } from './voice.js';

export const apiRouter = Router();

/**
 * 网关级健康检查。
 *
 * 除了 MiMo 的密钥状态，这里还汇总 GPT-SoVITS 本地服务的情况 ——
 * 前端只需要一次请求就能决定「该显示哪些能力、该提示什么」。
 */
apiRouter.get('/health', (_req, res) => {
  res.json({
    ok: true,
    data: {
      status: 'healthy',
      env: config.env,
      time: new Date().toISOString(),
      hasServerKey: Boolean(config.mimoApiKey),
      baseUrl: config.mimoBaseUrl,
      limits: {
        maxTextLength: config.maxTextLength,
        maxSampleBytes: config.maxSampleBytes,
        synthsPerMinute: config.rateLimit.synthMax,
      },
      /** GPT-SoVITS 本地服务状态（未启动时 reachable=false，前端据此提示） */
      sovits: sovitsSummary(),
      providers: {
        mimo: { available: true, requiresKey: !config.mimoApiKey },
        'gpt-sovits': { available: sovitsSummary().reachable },
      },
    },
  });
});

// 合成接口内部再叠加一层更严格的 synthLimiter
apiRouter.use('/tts', generalLimiter, ttsRouter);
apiRouter.use('/voices', generalLimiter, voiceRouter);
apiRouter.use('/config', generalLimiter, configRouter);

logger.debug('API 路由已注册', { prefixes: ['/health', '/tts', '/voices', '/config', '/sovits'] });

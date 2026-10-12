import { totalmem, freemem } from 'node:os';
import { Router } from 'express';
import { config } from '../config/index.js';
import { generalLimiter } from '../middleware/rateLimit.js';
import { logger } from '../lib/logger.js';
import { configRouter } from './config.js';
import { resourcesRouter } from './resources.js';
import { preloadRouter } from './preload.js';
import { indexttsSummary } from './indextts.js';
import { irodoriSummary } from './irodori.js';
import { neteaseSummary } from './netease.js';
import { sovitsSummary } from './sovits.js';
import { ttsRouter } from './tts.js';
import { voiceRouter } from './voice.js';

export const apiRouter = Router();

/**
 * 网关级健康检查。
 *
 * 除了 MiMo 的密钥状态，这里还汇总 GPT-SoVITS 本地服务的情况 ——
 * 前端只需要一次请求就能决定「该显示哪些能力、该提示什么」。
 * netease 是异步探测（带缓存的 TCP 探活），直接 await，health 本身仍是毫秒级。
 */
/**
 * 宿主机内存读数。
 *
 * 显存两个数仓各自报（GPT-SoVITS 的 `/v1/engines`、netease 的 `/health`），
 * 但**内存只有网关看得到全貌** —— 三个进程都跑在同一台机器上，
 * 前端要判断「跑这个任务够不够」缺不了它，所以在这里补上。
 */
function hostMemory() {
  const total = totalmem();
  const free = freemem();
  return {
    ram_total_mb: Math.round(total / 1024 / 1024),
    ram_free_mb: Math.round(free / 1024 / 1024),
    ram_used_mb: Math.round((total - free) / 1024 / 1024),
  };
}

apiRouter.get('/health', async (_req, res) => {
  res.json({
    ok: true,
    data: {
      status: 'healthy',
      env: config.env,
      time: new Date().toISOString(),
      hasServerKey: Boolean(config.mimoApiKey),
      /** 宿主机内存：给前端的「资源预估」用（显存在各自服务里报） */
      host: hostMemory(),
      baseUrl: config.mimoBaseUrl,
      limits: {
        maxTextLength: config.maxTextLength,
        maxSampleBytes: config.maxSampleBytes,
        synthsPerMinute: config.rateLimit.synthMax,
      },
      /** GPT-SoVITS 本地服务状态（未启动时 reachable=false，前端据此提示） */
      sovits: sovitsSummary(),
      /** 网易模块（opt-in，未启动是常态） */
      netease: await neteaseSummary(),
      /** IndexTTS（按需启动，未启动是常态） */
      indextts: await indexttsSummary(),
      /** Irodori（按需启动的日语模块，未启动是常态） */
      irodori: await irodoriSummary(),
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
/** 资源仲裁：把本系统内的资源集中给单一模型（只作用于自有服务） */
apiRouter.use('/resources', generalLimiter, resourcesRouter);
/** 启动预加载：选一个模型提前装进显存 */
apiRouter.use('/preload', generalLimiter, preloadRouter);

logger.debug('API 路由已注册', { prefixes: ['/health', '/tts', '/voices', '/config', '/sovits', '/netease'] });

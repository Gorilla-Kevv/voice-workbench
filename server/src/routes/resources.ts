import { Router } from 'express';

import { logger } from '../lib/logger.js';
import { resourceArbiter, type FocusEngine } from '../services/arbiter.js';

/**
 * 资源仲裁接口（`/api/resources/*`）。
 *
 * 契约刻意做得很窄：
 * - `POST /focus` —— 「把资源集中给这个引擎」，返回被卸载了谁、没卸掉谁；
 * - `POST /release` —— 「全停」，本系统内不留任何常驻模型；
 * - `GET /focus` —— 当前谁在持有资源、还剩多久。
 *
 * 全部动作只作用于本项目自己的两个服务（见 services/arbiter.ts 的开头），
 * 不对外界进程做任何事。
 */
export const resourcesRouter = Router();

const ENGINES: FocusEngine[] = ['netease-tts', 'netease-asr', 'sovits', 'training', 'rvc', 'svc', 'uvr5', 'asr'];

resourcesRouter.post('/focus', async (req, res) => {
  const engine = String(req.body?.engine ?? '') as FocusEngine;
  if (!ENGINES.includes(engine)) {
    res.status(400).json({
      ok: false,
      error: { code: 'BAD_ENGINE', message: `未知引擎：${engine}`, retryable: false, hint: `可选：${ENGINES.join(' / ')}` },
    });
    return;
  }
  const holdSeconds = Number(req.body?.holdSeconds ?? 600);

  try {
    const report = await resourceArbiter.focus(engine, Number.isFinite(holdSeconds) ? holdSeconds : 600);
    res.json({
      ok: true,
      ...report,
      hint:
        report.released.length > 0
          ? `已把资源集中给 ${engine}（卸载了 ${report.released.length} 处常驻模型）`
          : report.targetReachable
            ? `资源已在 ${engine} 上，无需让位`
            : `${engine} 所在的服务当前没在运行`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('资源仲裁失败', { engine, message });
    res.status(500).json({
      ok: false,
      error: { code: 'ARBITER_FAILED', message, retryable: true, hint: '检查两个自有服务是否在回环地址上。' },
    });
  }
});

resourcesRouter.post('/release', async (_req, res) => {
  try {
    const report = await resourceArbiter.releaseAll();
    res.json({
      ok: true,
      ...report,
      hint: report.released.length > 0 ? '已停掉本系统内全部常驻模型' : '本系统内没有常驻模型',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ ok: false, error: { code: 'ARBITER_FAILED', message, retryable: true } });
  }
});

resourcesRouter.get('/focus', (_req, res) => {
  res.json({ ok: true, ...resourceArbiter.status() });
});

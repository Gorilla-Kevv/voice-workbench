import { Router } from 'express';

import { logger } from '../lib/logger.js';
import { preloadService, type PreloadModel } from '../services/preload.js';

/**
 * 启动预加载接口（`/api/preload/*`）。
 *
 * 用户裁决：IndexTTS 与网易谁当主力由**使用测试**决定，不做预设；
 * 所以这里提供「选一个预加载」的能力，并把每个模型的显存代价摆清楚。
 */
export const preloadRouter = Router();

const MODELS: (PreloadModel | 'ask')[] = ['netease-tts', 'sovits', 'none', 'ask'];

/** 可选模型 + 各自显存需求 + 当前显存（界面据此给数字） */
preloadRouter.get('/catalog', async (_req, res) => {
  try {
    const catalog = await preloadService.catalog();
    res.json({ ok: true, ...catalog, preference: preloadService.preference().model });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ ok: false, error: { code: 'PRELOAD_CATALOG_FAILED', message, retryable: true } });
  }
});

preloadRouter.get('/', (_req, res) => {
  res.json({
    ok: true,
    preference: preloadService.preference().model,
    last: preloadService.status(),
  });
});

/** 记住选择（'ask' = 每次启动都问） */
preloadRouter.put('/preference', (req, res) => {
  const model = String(req.body?.model ?? '') as PreloadModel | 'ask';
  if (!MODELS.includes(model)) {
    res.status(400).json({
      ok: false,
      error: { code: 'BAD_MODEL', message: `未知选项：${model}`, retryable: false, hint: `可选：${MODELS.join(' / ')}` },
    });
    return;
  }
  const preference = preloadService.setPreference(model);
  res.json({ ok: true, model: preference.model });
});

/** 立刻预加载某个模型（会先让另一套让出显存） */
preloadRouter.post('/', async (req, res) => {
  const model = String(req.body?.model ?? '') as PreloadModel | 'ask';
  if (!MODELS.includes(model) || model === 'ask') {
    res.status(400).json({
      ok: false,
      error: { code: 'BAD_MODEL', message: `未知选项：${model}`, retryable: false, hint: '可选：netease-tts / sovits / none' },
    });
    return;
  }
  try {
    const report = await preloadService.preload(model as PreloadModel);
    res.json(report);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('预加载接口失败', { model, message });
    res.status(500).json({ ok: false, error: { code: 'PRELOAD_FAILED', message, retryable: true } });
  }
});

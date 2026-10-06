import express, { type Request, type Response } from 'express';
import { Router } from 'express';

import { logger } from '../lib/logger.js';
import type { RuntimeSupervisor } from '../services/runtime.js';

/**
 * 运行时服务的启停接口（`/api/<id>/service`）—— 与 `/api/sovits/service` 同形：
 * GET 读状态，POST {enabled} 切换。必须挂在对应服务的透明代理**之前**，
 * 否则会被代理的通配规则吃掉。
 */
export function createRuntimeServiceRouter(supervisor: RuntimeSupervisor, label: string) {
  const router = Router();

  router.get('/', (_req: Request, res: Response) => {
    res.json({ ok: true, ...supervisor.status() });
  });

  router.post('/', express.json(), async (req: Request, res: Response) => {
    const enabled = req.body?.enabled === true;
    try {
      const result = await supervisor.setEnabled(enabled);
      const status = supervisor.status();
      let hint: string;
      if (enabled) {
        hint = result.reachable
          ? `${label} 服务已启动`
          : `${label} 启动中或未能就绪：${status.lastError ?? '首次启动可能要数十秒，稍后刷新状态'}`;
      } else if (result.stopped) {
        hint = `${label} 服务已关闭，显存已归还`;
      } else {
        hint = result.releasedVram
          ? `已卸载 ${label} 的常驻模型；该实例由外部终端启动（非网关托管），进程请在对应终端用 Ctrl+C 关闭`
          : `${label} 由外部终端启动（非网关托管），网关无法直接关闭该进程 —— 请在对应终端用 Ctrl+C 关闭`;
      }
      res.json({ ok: true, enabled: result.enabled, reachable: result.reachable, hint });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`切换 ${label} 服务失败`, { enabled, message });
      res.status(500).json({
        ok: false,
        error: { code: 'SERVICE_TOGGLE_FAILED', message, retryable: true, hint: '查看网关控制台的 [netease]/[indextts] 日志行定位。' },
      });
    }
  });

  return router;
}

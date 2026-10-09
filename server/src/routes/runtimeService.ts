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

  /**
   * 读状态时**先探一次活**再返回。
   *
   * 原来直接吐 `supervisor.status()`，而里面的 `reachable` 只在 supervisor 自己
   * 的启动/关停流程里更新过 —— 网关起来后从没探过就是初始的 false。
   * 于是出现「端口上明明有进程在跑（`npm run dev` 的 concurrently 或终端手动起的），
   * 接口却报 reachable=false」—— 界面据此把「未托管进程」的提示也吞掉了
   * （2026-10 用户反馈侧栏与设置页打架时连带发现）。
   * 探活是 1.5 秒超时的一次 GET，对状态接口来说代价可以接受。
   */
  router.get('/', async (_req: Request, res: Response) => {
    await supervisor.probe();
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
        // stopped=true 表示端口已空（进程树按端口反查 + 归属校验后杀干净）
        hint = `${label} 服务已关闭，显存已归还`;
      } else if (status.shutdownNote) {
        // 杀了但没干净 / 端口被别人的程序占着 —— 把真实原因给出来，别让用户猜
        hint = status.shutdownNote;
      } else {
        hint = `${label} 未能关闭：${status.lastError ?? '原因未知，请查看网关控制台日志'}`;
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

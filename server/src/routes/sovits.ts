/**
 * GPT-SoVITS 本地服务反向代理（`/api/sovits/*`）。
 *
 * 为什么不把 Python 服务的端口直接暴露给浏览器：
 *
 * - **同源**：前端只需要知道一个地址，省掉第二套 CORS 配置与「服务地址填错」类故障；
 * - **可观测**：代理层知道 Python 服务是否起来、为什么没起来，能把这些信息
 *   变成一条可读的错误，而不是浏览器的 `ERR_CONNECTION_REFUSED`；
 * - **透明**：不解析、不改写请求体，JSON、multipart 上传、NDJSON 流式
 *   都原样透传 —— 上游契约变了这里不用跟着改。
 *
 * 实现上用 `node:http` 而不是 `fetch`：需要处理原始字节流（大文件上传、
 * 无缓冲的流式响应）时，`http.request` + `pipe` 是最不需要操心的方案。
 */

import http from 'node:http';
import type { Request, Response } from 'express';
import express, { Router } from 'express';

import { config } from '../config/index.js';
import { logger } from '../lib/logger.js';
import { sovitsSupervisor } from '../services/sovits.js';

export const sovitsProxyRouter = Router();

/**
 * GPT-SoVITS 服务自身的启停（挂载在 `/api/sovits/service`，必须排在代理之前）。
 * 单独一个 Router 是为了能在这条路由上单独开 `express.json()` ——
 * 代理那条必须挂在全局 `express.json()` 之前（否则 multipart / 流式会被消费掉）。
 */
export const sovitsServiceRouter = Router();

/** 逐跳首部（RFC 7230）不能透传，否则会破坏连接管理 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function filterHeaders(headers: http.IncomingHttpHeaders, host: string): http.OutgoingHttpHeaders {
  const result: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (HOP_BY_HOP.has(key.toLowerCase())) continue;
    result[key] = value;
  }
  result.host = host;
  return result;
}

function unavailable(res: Response, detail: string): void {
  const status = sovitsSupervisor.status();
  res.status(503).json({
    ok: false,
    error: {
      code: 'SOVITS_UNAVAILABLE',
      message: `GPT-SoVITS 本地服务不可用：${detail}`,
      retryable: true,
      hint: status.installed
        ? '请确认 trainer/server.py 能正常启动；下方日志是 Python 侧的最后几行输出。'
        : '未在项目目录下找到 GPT-SoVITS 整合包。请解压到项目同级目录，或设置 GPT_SOVITS_HOME 环境变量。',
      details: {
        baseUrl: status.baseUrl,
        installed: status.installed,
        lastError: status.lastError,
        python: status.python,
        logs: sovitsSupervisor.recentLogs(20),
      },
    },
  });
}

sovitsProxyRouter.use((req: Request, res: Response) => {
  if (sovitsSupervisor.status().reachable) {
    forward(req, res);
    return;
  }

  // 首次请求可能正好撞上「服务还在冷启动」。ensureStarted 是幂等的：
  // 它要么复用已就绪的外部实例，要么等待自己拉起的那个完成，要么给出原因。
  void sovitsSupervisor
    .ensureStarted()
    .then(() => {
      if (sovitsSupervisor.status().reachable) {
        forward(req, res);
        return;
      }
      unavailable(
        res,
        sovitsSupervisor.status().lastError ?? '尚未启动完成或进程已退出',
      );
    })
    .catch((error: Error) => {
      unavailable(res, error.message);
    });
});

function forward(req: Request, res: Response): void {
  let target: URL;
  try {
    target = new URL(config.sovits.baseUrl);
  } catch {
    unavailable(res, `服务地址不合法：${config.sovits.baseUrl}`);
    return;
  }

  // 挂载点已被 Express 剥离，req.url 就是 Python 侧的路径（含查询串）
  const path = req.url && req.url !== '' ? req.url : '/';

  const proxyReq = http.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      method: req.method,
      path,
      headers: filterHeaders(req.headers, target.host),
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, filterHeaders(proxyRes.headers, target.host));
      proxyRes.pipe(res);
    },
  );

  proxyReq.on('error', (error: Error) => {
    logger.warn('GPT-SoVITS 代理失败', { path, message: error.message });
    if (res.headersSent) {
      res.end();
      return;
    }
    unavailable(res, error.message);
  });

  // 客户端提前断开时，别让上游继续跑（尤其是长达数分钟的合成请求）
  res.on('close', () => {
    if (!res.writableEnded) proxyReq.destroy();
  });

  req.pipe(proxyReq);
}

/** 供 `/api/health` 汇总展示，避免前端再打一次请求 */
export function sovitsSummary(): Record<string, unknown> {
  const status = sovitsSupervisor.status();
  return {
    baseUrl: status.baseUrl,
    reachable: status.reachable,
    managed: status.managed,
    installed: status.installed,
    home: status.home,
    python: status.python,
    lastError: status.lastError,
    /** 用户是否在设置里启用了它（默认关闭，显存留给网易主服务） */
    enabled: sovitsSupervisor.isEnabled(),
  };
}

/**
 * GPT-SoVITS 服务的启停（`POST /api/sovits/service`）。
 *
 * 存在的理由很具体：8 GB 显存装不下两套常驻模型。报错里让用户「先关掉 GPT-SoVITS」
 * 却没有任何入口可以关，等于给了个做不到的建议。现在开关在设置页，
 * 显存预警卡里也有一键关闭，关完显存立刻还回来。
 */
sovitsServiceRouter.post('/', express.json(), async (req: Request, res: Response) => {
  const enabled = req.body?.enabled === true;
  try {
    const result = await sovitsSupervisor.setEnabled(enabled);
    res.json({
      ok: true,
      enabled: result.enabled,
      reachable: result.reachable,
      hint: buildToggleHint(result),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('切换 GPT-SoVITS 服务失败', { enabled, message });
    res.status(500).json({
      ok: false,
      error: { code: 'SOVITS_SERVICE_TOGGLE_FAILED', message, retryable: true, hint: '稍后重试，或手动运行 npm run dev:sovits。' },
    });
  }
});

/**
 * 关停结果的文案必须区分「我们拉起的」和「外部启动的」。
 *
 * 后一种情况网关杀不掉进程（它归 `npm run dev:sovits` / `start.bat` 那个终端管），
 * 只卸掉了常驻引擎。若统一说「已关闭」，用户看到侧栏还是「已连接」会以为功能坏了 ——
 * 不如直接告诉他去关哪个终端。
 */
function buildToggleHint(result: { enabled: boolean; reachable: boolean; stopped?: boolean; releasedVram?: boolean }): string {
  if (result.enabled) {
    return result.reachable
      ? 'GPT-SoVITS 本地服务已启动'
      : '正在启动（首次要 import torch，约数十秒），稍后会自动就绪';
  }
  if (result.stopped) {
    return '已关闭 GPT-SoVITS 本地服务，显存已归还；需要训练 / 批量 / 变声 / 翻唱时再到设置里开启';
  }
  return result.reachable
    ? '已停用（设置项已关闭），但当前这个 GPT-SoVITS 是**外部启动**的，网关杀不掉它 —— 显存只卸掉了常驻引擎。要彻底关掉，请停掉运行 npm run dev:sovits 或 start.bat 的那个终端。'
    : '已关闭 GPT-SoVITS 本地服务；需要训练 / 批量 / 变声 / 翻唱时再到设置里开启';
}

sovitsServiceRouter.get('/', async (_req: Request, res: Response) => {
  // 这里现探一次：设置页要显示的就是「此刻」的状态，用缓存值会滞后半分钟
  const reachable = await sovitsSupervisor.probe();
  const status = sovitsSupervisor.status();
  res.json({
    ok: true,
    enabled: sovitsSupervisor.isEnabled(),
    reachable,
    managed: status.managed,
    pid: status.pid,
  });
});

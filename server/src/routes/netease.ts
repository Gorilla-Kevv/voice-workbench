/**
 * 网易模块本地服务（netease/，:9882）反向代理（`/api/netease/*`）。
 *
 * 与 `sovits.ts` 同一套透明转发思路（node:http + pipe，不解析请求体），
 * 但**没有 supervisor**：netease 是 opt-in 模块，生命周期归 `npm run dev:netease`，
 * 网关不做拉起、不做等待 —— 探不到就返回结构化 503，
 * hint 明确指向启动命令，前端据此把状态卡显示为「未启动（可选模块）」。
 *
 * 挂载点同样必须在 `express.json()` **之前**：NDJSON 流式转写与 multipart
 * 音频上传都不能被 body-parser 消费（见 index.ts 内注释）。
 */

import http from 'node:http';
import type { Request, Response } from 'express';
import { Router } from 'express';

import { config } from '../config/index.js';
import { logger } from '../lib/logger.js';

export const neteaseProxyRouter = Router();

/** 逐跳首部（RFC 7230）不能透传 */
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
  res.status(503).json({
    ok: false,
    error: {
      code: 'NETEASE_UNAVAILABLE',
      message: `网易模块本地服务不可用：${detail}`,
      retryable: true,
      hint: '网易模块是可选模块，默认不随主程序启动。运行 npm run dev:netease 启动它（首次使用先看 netease/README.md）。',
      details: {
        baseUrl: config.netease.baseUrl,
      },
    },
  });
}

neteaseProxyRouter.use((req: Request, res: Response) => {
  forward(req, res);
});

function forward(req: Request, res: Response): void {
  let target: URL;
  try {
    target = new URL(config.netease.baseUrl);
  } catch {
    unavailable(res, `服务地址不合法：${config.netease.baseUrl}`);
    return;
  }

  // 挂载点已被 Express 剥离，req.url 就是 Python 侧的路径（含查询串）
  const path = req.url && req.url !== '' ? req.url : '/';
  const timeoutMs = config.netease.proxyTimeoutMs;

  const proxyReq = http.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      method: req.method,
      path,
      headers: filterHeaders(req.headers, target.host),
      // 0 交给 http 模块默认（无超时）；>0 才启用
      ...(timeoutMs > 0 ? { timeout: timeoutMs } : {}),
    },
    (proxyRes) => {
      markReachable();
      res.writeHead(proxyRes.statusCode ?? 502, filterHeaders(proxyRes.headers, target.host));
      proxyRes.pipe(res);
    },
  );

  proxyReq.on('error', (error: Error) => {
    markUnreachable(error.message);
    logger.warn('网易模块代理失败', { path, message: error.message });
    if (res.headersSent) {
      res.end();
      return;
    }
    unavailable(res, error.message);
  });

  res.on('close', () => {
    if (!res.writableEnded) proxyReq.destroy();
  });

  req.pipe(proxyReq);
}

// ---------------------------------------------------------------- 探活缓存
// 供 `/api/health` 汇总。无状态转发已经能验证可达性（每次成功/失败都会更新缓存），
// 但 health 本身不想为它发请求，所以这里用 5 秒缓存 + TCP 探测兜底。

let cached = { reachable: false, checkedAt: 0, lastError: '' as string };

function markReachable(): void {
  cached = { reachable: true, checkedAt: Date.now(), lastError: '' };
}

function markUnreachable(message: string): void {
  cached = { reachable: false, checkedAt: Date.now(), lastError: message };
}

function probeReachable(): Promise<boolean> {
  return new Promise((resolve) => {
    const target = new URL(config.netease.baseUrl);
    const req = http.request(
      { hostname: target.hostname, port: target.port || 80, path: '/health', method: 'GET', timeout: 800 },
      (res) => {
        res.resume();
        resolve(Boolean(res.statusCode && res.statusCode < 500));
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
    req.end();
  });
}

/** 供 `/api/health` 汇总展示；带 5 秒缓存，避免 health 轮询打爆探测 */
export async function neteaseSummary(): Promise<Record<string, unknown>> {
  const fresh = Date.now() - cached.checkedAt < 5_000;
  if (!fresh) {
    const reachable = await probeReachable();
    if (reachable) markReachable();
    else markUnreachable(cached.lastError || '探活无响应');
  }
  return {
    baseUrl: config.netease.baseUrl,
    reachable: cached.reachable,
    /** opt-in 模块：未启动是常态而不是故障，前端据此显示「未启动（可选模块）」 */
    optional: true,
    lastError: cached.lastError || undefined,
  };
}

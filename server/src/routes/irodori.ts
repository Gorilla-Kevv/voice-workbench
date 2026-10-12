/**
 * Irodori-TTS 本地服务（irodori/，第四个 Python 运行时，:9884）反向代理（`/api/irodori/*`）。
 *
 * 与 `indextts.ts` 同一套透明转发思路（node:http + pipe，不解析请求体），
 * 同样**没有 supervisor**：生命周期归 `npm run dev:irodori` 或设置页开关，
 * 网关只做探活与透明转发，探不到就返回带「如何启动」提示的结构化 503。
 *
 * 挂载点必须在 `express.json()` **之前**（坑 20；虽然当前端点都是 JSON，
 * 保持与其它三条代理同一挂载顺序，避免新端点踩 multipart 被 body-parser 消费的老错）。
 */

import http from 'node:http';
import type { Request, Response } from 'express';
import { Router } from 'express';

import { config } from '../config/index.js';
import { logger } from '../lib/logger.js';
import { irodoriSupervisor } from '../services/runtime.js';

export const irodoriProxyRouter = Router();

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
      code: 'IRODORI_UNAVAILABLE',
      message: `Irodori-TTS 本地服务不可用：${detail}`,
      retryable: true,
      hint: 'Irodori 是按需启动的日语模块。在设置页打开开关，或运行 npm run dev:irodori（环境搭建见 docs/IRODORI-INTEGRATION-PLAN.md 与 irodori/README.md）。',
      details: {
        baseUrl: config.irodori.baseUrl,
      },
    },
  });
}

irodoriProxyRouter.use((req: Request, res: Response) => {
  forward(req, res);
});

function forward(req: Request, res: Response): void {
  let target: URL;
  try {
    target = new URL(config.irodori.baseUrl);
  } catch {
    unavailable(res, `服务地址不合法：${config.irodori.baseUrl}`);
    return;
  }

  // 挂载点已被 Express 剥离，req.url 就是 Python 侧的路径（含查询串）
  const path = req.url && req.url !== '' ? req.url : '/';
  // 刻意宽于服务端的 IRODORI_TIMEOUT（180s）：长尾命中时让**服务端那个更有信息量的
  // 504**（含「降步重试」提示）先到前端，而不是网关一句「上游无响应」
  const timeoutMs = config.irodori.proxyTimeoutMs;

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
    logger.warn('Irodori 代理失败', { path, message: error.message });
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
// 供 `/api/health` 汇总（与 indextts.ts 同一模式：5 秒缓存 + TCP 探测兜底）。

let cached = { reachable: false, checkedAt: 0, lastError: '' as string };

function markReachable(): void {
  cached = { reachable: true, checkedAt: Date.now(), lastError: '' };
}

function markUnreachable(message: string): void {
  cached = { reachable: false, checkedAt: Date.now(), lastError: message };
}

function probeReachable(): Promise<boolean> {
  return new Promise((resolve) => {
    const target = new URL(config.irodori.baseUrl);
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
export async function irodoriSummary(): Promise<Record<string, unknown>> {
  const fresh = Date.now() - cached.checkedAt < 5_000;
  if (!fresh) {
    const reachable = await probeReachable();
    if (reachable) markReachable();
    else markUnreachable(cached.lastError || '探活无响应');
  }
  return {
    baseUrl: config.irodori.baseUrl,
    reachable: cached.reachable,
    /** 按需模块：未启动是常态而不是故障 */
    optional: true,
    /** 设置页开关状态（网关现已托管其生命周期） */
    enabled: irodoriSupervisor.isEnabled(),
    lastError: cached.lastError || undefined,
  };
}

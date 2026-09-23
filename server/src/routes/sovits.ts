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
import { Router } from 'express';

import { config } from '../config/index.js';
import { logger } from '../lib/logger.js';
import { sovitsSupervisor } from '../services/sovits.js';

export const sovitsProxyRouter = Router();

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
  };
}

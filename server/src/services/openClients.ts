import http from 'node:http';
import { URL } from 'node:url';

import { logger } from '../lib/logger.js';

/**
 * 对外能力网关的上游客户端（阶段 43）。
 *
 * 为什么不用 global fetch：undici 自带 headersTimeout（默认 ~300s，HANDOFF 坑 77 的
 * 同族陷阱）—— 本地引擎的同步合成可以跑到 5~15 分钟（trainer 锁等待 330s、R2T2 worker
 * 预算 1800s），fetch 会在首字节前被 undici 掐死，而 AbortSignal 只能管总时长管不了
 * 「首字节」。node:http 的 socket 超时自己配，语义干净。
 *
 * 错误约定（与全仓 `{ok:false,error:{code,message,retryable,hint,details}}` 对齐）：
 * - 上游返回 4xx/5xx 且 body 是结构化错误 → **原样透传**（状态码与 hint 都是服务端
 *   语义，网关不翻译 —— 引擎忙 409、显存不足 503 这些差异是能力清单文档的一部分）；
 * - 上游 body 不是结构化错误 → 包一层 `OPEN_UPSTREAM_ERROR`；
 * - 连不上 / 超时 → 抛 `RuntimeUnreachableError`，由路由层转 503 `OPEN_RUNTIME_UNREACHABLE`。
 */

export class RuntimeUnreachableError extends Error {
  readonly runtime: string;
  readonly reason: string;

  constructor(runtime: string, reason: string) {
    super(`运行时 ${runtime} 不可达：${reason}`);
    this.name = 'RuntimeUnreachableError';
    this.runtime = runtime;
    this.reason = reason;
  }
}

export interface UpstreamErrorBody {
  ok: false;
  error: { code: string; message: string; retryable?: boolean; hint?: string; details?: unknown };
}

export type UpstreamResult =
  | { ok: true; status: number; data: Record<string, unknown> }
  | { ok: false; status: number; body: UpstreamErrorBody };

const DEFAULT_TIMEOUT_MS = 900_000; // 15 min：覆盖 trainer 同步锁等待 330s 与常见长合成

function isStructuredErrorBody(parsed: unknown): parsed is UpstreamErrorBody {
  if (typeof parsed !== 'object' || parsed === null) return false;
  const candidate = parsed as { ok?: unknown; error?: unknown };
  if (candidate.ok !== false) return false;
  const error = candidate.error as { code?: unknown; message?: unknown } | undefined;
  return typeof error?.code === 'string' && typeof error?.message === 'string';
}

/** multipart 文本字段拼装（façade 不传文件字节，全部字段都是短文本） */
function buildMultipartBody(fields: Record<string, string>): { body: Buffer; contentType: string } {
  const boundary = `----open-gateway-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        'utf8',
      ),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

export interface UpstreamRequest {
  method?: 'GET' | 'POST';
  path: string;
  /** JSON body（style=json 的端点） */
  json?: Record<string, unknown>;
  /** 文本表单字段（style=form 的端点，转 multipart） */
  formFields?: Record<string, string>;
  timeoutMs?: number;
}

/** 向某个回环运行时发一次请求，收集完整 JSON 响应。 */
export function requestUpstream(
  baseUrl: string,
  runtime: string,
  request: UpstreamRequest,
): Promise<UpstreamResult> {
  const method = request.method ?? 'POST';
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let payload: Buffer | undefined;
  let contentType = 'application/json';
  if (request.json !== undefined) {
    payload = Buffer.from(JSON.stringify(request.json), 'utf8');
  } else if (request.formFields !== undefined) {
    const built = buildMultipartBody(request.formFields);
    payload = built.body;
    contentType = built.contentType;
  }

  return new Promise<UpstreamResult>((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(request.path, baseUrl);
    } catch (error) {
      reject(new RuntimeUnreachableError(runtime, `地址不合法：${baseUrl}${request.path}`));
      return;
    }

    const req = http.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method,
        headers: {
          ...(payload ? { 'Content-Type': contentType, 'Content-Length': payload.length } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown = null;
          try {
            parsed = raw ? JSON.parse(raw) : null;
          } catch {
            parsed = null;
          }

          if (res.statusCode === undefined) {
            reject(new RuntimeUnreachableError(runtime, '响应缺少状态码'));
            return;
          }
          const status = res.statusCode;

          if (isStructuredErrorBody(parsed)) {
            resolve({ ok: false, status, body: parsed });
            return;
          }
          if (status >= 400) {
            const snippet = raw.slice(0, 200);
            resolve({
              ok: false,
              status,
              body: {
                ok: false,
                error: {
                  code: 'OPEN_UPSTREAM_ERROR',
                  message: `上游 ${runtime} 返回 HTTP ${status}（非结构化错误体）`,
                  retryable: status >= 500,
                  hint: `直连该运行时的原生端点排查响应形态；原始响应片段：${snippet}`,
                  details: snippet,
                },
              },
            });
            return;
          }
          if (!parsed || typeof parsed !== 'object') {
            resolve({
              ok: false,
              status,
              body: {
                ok: false,
                error: {
                  code: 'OPEN_UPSTREAM_ERROR',
                  message: `上游 ${runtime} 响应不是 JSON 对象`,
                  retryable: false,
                  details: raw.slice(0, 200),
                },
              },
            });
            return;
          }
          resolve({ ok: true, status, data: parsed as Record<string, unknown> });
        });
        res.on('error', (error) => reject(new RuntimeUnreachableError(runtime, error.message)));
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`上游 ${runtime} 在 ${Math.round(timeoutMs / 1000)}s 内未响应`));
    });
    req.on('error', (error) => {
      const message = error.message || String(error);
      if (/ECONNREFUSED|ECONNRESET|socket hang up|EHOSTUNREACH|未响应/i.test(message)) {
        reject(new RuntimeUnreachableError(runtime, message));
        return;
      }
      // 超时是「服务活着但太慢」：503 + retryable，hint 说清可以加大 timeout_ms
      reject(new Error(`OPEN_UPSTREAM_TIMEOUT: ${message}`));
    });

    if (payload) req.write(payload);
    req.end();
  }).catch((error: unknown) => {
    if (error instanceof RuntimeUnreachableError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('OPEN_UPSTREAM_TIMEOUT:')) {
      logger.warn('能力网关上游超时', { runtime, message });
      throw new RuntimeUnreachableError(runtime, `${message.replace('OPEN_UPSTREAM_TIMEOUT: ', '')}（可加大 timeout_ms 重试）`);
    }
    throw error;
  });
}

/** 回环下载上游产物（trainer /v1/tts 的 audio_url 是它自己的静态挂载）。 */
export function downloadUpstream(baseUrl: string, path: string, runtime: string): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(path, baseUrl);
    } catch {
      reject(new RuntimeUnreachableError(runtime, `产物地址不合法：${path}`));
      return;
    }
    const req = http.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new RuntimeUnreachableError(runtime, `产物下载失败：HTTP ${res.statusCode} ${path}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', (error) => reject(new RuntimeUnreachableError(runtime, error.message)));
    });
    req.setTimeout(120_000, () => req.destroy(new Error('产物下载超时（120s）')));
    req.on('error', (error) => reject(new RuntimeUnreachableError(runtime, error.message)));
  });
}

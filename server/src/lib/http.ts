import { AppError, fromUpstreamStatus } from './errors.js';
import { logger } from './logger.js';

export interface FetchOptions {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
  /** 单次请求超时（毫秒） */
  timeoutMs: number;
  /** 失败重试次数（仅 429 / 5xx / 网络错误会重试） */
  retries?: number;
  /** 上游标识，用于日志 */
  label?: string;
}

/** 429 / 5xx / 网络抖动 这类可安全重试的状态 */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 指数退避 + 抖动，尊重 Retry-After */
function backoffDelay(attempt: number, retryAfterHeader: string | null): number {
  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.min(seconds * 1000, 30_000);
    }
  }
  const base = 800 * 2 ** attempt;
  const jitter = Math.random() * 400;
  return Math.min(base + jitter, 15_000);
}

export interface FetchResult<T> {
  ok: true;
  status: number;
  data: T;
}

/**
 * 带超时与指数退避重试的 JSON 请求封装。
 * 失败时抛出携带中文提示的 AppError。
 */
export async function postJson<T>(options: FetchOptions): Promise<T> {
  const { url, headers = {}, body, timeoutMs, retries = 0, label = 'upstream', method = 'POST' } = options;
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();

    try {
      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);

      const elapsed = Date.now() - startedAt;
      const text = await response.text();

      if (!response.ok) {
        logger.warn(`${label} 返回非 2xx`, {
          status: response.status,
          elapsed,
          attempt,
          body: text.slice(0, 600),
        });

        if (isRetryableStatus(response.status) && attempt < retries) {
          const delay = backoffDelay(attempt, response.headers.get('retry-after'));
          await sleep(delay);
          continue;
        }

        throw fromUpstreamStatus(response.status, extractUpstreamMessage(text), text.slice(0, 1000));
      }

      if (logger) {
        logger.debug(`${label} 请求成功`, { status: response.status, elapsed, attempt });
      }

      try {
        return JSON.parse(text) as T;
      } catch {
        throw new AppError(502, 'UPSTREAM_ERROR', '无法解析 MiMo 返回的数据，请稍后重试', {
          details: text.slice(0, 500),
        });
      }
    } catch (error) {
      clearTimeout(timer);
      lastError = error;

      if (error instanceof AppError) throw error;

      const isAbort = error instanceof Error && error.name === 'AbortError';
      const message = isAbort
        ? '请求 MiMo 接口超时，请缩短文本长度或稍后重试'
        : '无法连接 MiMo 接口，请检查网络或 Base URL 配置';

      logger.warn(`${label} 请求异常`, {
        attempt,
        isAbort,
        error: error instanceof Error ? error.message : String(error),
      });

      if (attempt < retries) {
        await sleep(backoffDelay(attempt, null));
        continue;
      }

      throw new AppError(isAbort ? 504 : 502, isAbort ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNAVAILABLE', message, {
        retryable: true,
        details: error instanceof Error ? error.message : String(error),
      });
    }
  }

  throw lastError instanceof AppError
    ? lastError
    : new AppError(502, 'UPSTREAM_ERROR', '调用 MiMo 接口失败，请稍后重试', { retryable: true });
}

/** 从上游错误响应中提取可读信息 */
function extractUpstreamMessage(text: string): string | undefined {
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as {
      error?: { message?: string } | string;
      message?: string;
      msg?: string;
    };
    if (typeof parsed.error === 'string') return parsed.error;
    return parsed.error?.message ?? parsed.message ?? parsed.msg;
  } catch {
    return text.slice(0, 200);
  }
}

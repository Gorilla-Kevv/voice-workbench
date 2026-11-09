/**
 * CosyVoice3 客户端（cosyvoice/，第六个 Python 运行时）。
 *
 * 默认经同源网关 `/api/cosyvoice/*` 透传到本地服务（:9886）；
 * 服务端的 `error.hint` 一路带到 UI。合成不设客户端超时：
 * 服务端的准入/互斥/错误信息比一个干巴巴的 AbortError 有用。
 */

import { RequestError } from '@/lib/errors';
import type {
  CosyvoiceCatalog,
  CosyvoiceHealth,
  CosyvoiceSynthPayload,
  CosyvoiceSynthResult,
} from '@/types';

export const DEFAULT_COSYVOICE_BASE = '/api/cosyvoice';

export function normalizeCosyvoiceBase(raw: string | undefined | null): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return DEFAULT_COSYVOICE_BASE;
  return trimmed.replace(/\/+$/, '');
}

interface RequestOptions extends RequestInit {
  timeoutMs?: number;
}

async function cosyvoiceRequest<T>(path: string, options: RequestOptions = {}, baseUrl?: string): Promise<T> {
  const base = normalizeCosyvoiceBase(baseUrl);
  const { timeoutMs = 30_000, ...init } = options;
  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;

  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        ...(init.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
        ...(init.headers ?? {}),
      },
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new RequestError(504, {
        code: 'COSYVOICE_CLIENT_TIMEOUT',
        message: '等待 CosyVoice3 服务响应超时。',
        retryable: true,
        hint: '合成不设客户端超时；这里超时通常意味着服务没起来或网关没通。',
      });
    }
    throw new RequestError(0, {
      code: 'COSYVOICE_UNREACHABLE',
      message: '无法连接到 CosyVoice3 服务（:9886）。它是按需启动的模块，默认不随主程序启动。',
      retryable: true,
      hint: '在「设置 → 本地服务」里打开 CosyVoice3，或运行 npm run dev:cosyvoice。',
    });
  } finally {
    if (timer) clearTimeout(timer);
  }

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const maybe = payload as
      | { error?: { code: string; message: string; retryable?: boolean; hint?: string; details?: unknown } }
      | null;
    throw new RequestError(
      response.status,
      maybe?.error ?? {
        code: `HTTP_${response.status}`,
        message: text?.slice(0, 300) || `CosyVoice3 服务返回 ${response.status}`,
        retryable: response.status >= 500,
      },
    );
  }

  return payload as T;
}

export const cosyvoiceApi = {
  health: (baseUrl?: string): Promise<CosyvoiceHealth> =>
    cosyvoiceRequest('/health', { method: 'GET', timeoutMs: 15_000 }, baseUrl),

  catalog: (baseUrl?: string): Promise<CosyvoiceCatalog> =>
    cosyvoiceRequest('/v1/catalog', { method: 'GET', timeoutMs: 20_000 }, baseUrl),

  warmup: (baseUrl?: string): Promise<{ ok: boolean; loaded: boolean; starting: boolean }> =>
    cosyvoiceRequest('/v1/warmup', { method: 'POST', timeoutMs: 0 }, baseUrl),

  unload: (baseUrl?: string): Promise<{ ok: boolean; loaded: boolean; freed_mb: number | null }> =>
    cosyvoiceRequest('/v1/unload', { method: 'POST', timeoutMs: 60_000 }, baseUrl),

  synthesize: (payload: CosyvoiceSynthPayload, baseUrl?: string): Promise<CosyvoiceSynthResult> =>
    cosyvoiceRequest('/v1/synth', { method: 'POST', body: JSON.stringify(payload), timeoutMs: 0 }, baseUrl),
};

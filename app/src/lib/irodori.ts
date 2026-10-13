/**
 * Irodori-TTS 客户端（irodori/，第四个 Python 运行时）。
 *
 * 与 `indextts.ts` 同一套约定：默认经同源网关 `/api/irodori/*` 透传到本地服务（:9884）；
 * 服务端的 `error.hint` 一路带到 UI。
 *
 * 超时语义（与其它本地服务不同，这里刻意「让服务端先说话」）：
 * 合成用 `timeoutMs: 0`（客户端不设超时）—— 服务端自己有一条 180s 的墙钟护栏，
 * 超时会返回带 `retry_suggestion` 的 504 `IRODORI_TIMEOUT`，信息量比客户端
 * 一个干巴巴的 AbortError 大得多（网关 `proxyTimeoutMs` 240s 也刻意宽于它）。
 */

import { RequestError } from '@/lib/errors';
import type {
  IrodoriCatalog,
  IrodoriHealth,
  IrodoriSpeaker,
  IrodoriSynthPayload,
  IrodoriSynthResult,
  IrodoriTimeoutDetails,
} from '@/types';

/** 经 Node 网关的默认入口 */
export const DEFAULT_IRODORI_BASE = '/api/irodori';

/**
 * 护栏参数的**兜底**常量：真源在服务端 `/v1/catalog` 的 `guard` 字段。
 * 只在 catalog 还没拿到时用（例如页面首屏渲染按钮文案）。
 */
export const IRODORI_FALLBACK_TIMEOUT_SEC = 180;
export const IRODORI_FALLBACK_DOWNGRADE_STEPS = 20;

export function normalizeIrodoriBase(raw: string | undefined | null): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return DEFAULT_IRODORI_BASE;
  return trimmed.replace(/\/+$/, '');
}

interface IrodoriRequestOptions extends RequestInit {
  /** 超时毫秒；0 表示不超时（合成走服务端护栏） */
  timeoutMs?: number;
}

async function irodoriRequest<T>(path: string, options: IrodoriRequestOptions = {}, baseUrl?: string): Promise<T> {
  const base = normalizeIrodoriBase(baseUrl);
  const url = `${base}${path}`;
  const { timeoutMs = 30_000, ...init } = options;

  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;

  let response: Response;
  try {
    response = await fetch(url, {
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
        code: 'IRODORI_CLIENT_TIMEOUT',
        message: '等待 Irodori 服务响应超时。',
        retryable: true,
        hint: '服务端自己的护栏是 180s；这里超时通常意味着服务没起来或网关没通。',
      });
    }
    throw new RequestError(0, {
      code: 'IRODORI_UNREACHABLE',
      message: '无法连接到 Irodori 服务（:9884）。它是按需启动的模块，默认不随主程序启动。',
      retryable: true,
      hint: '在「设置 → 本地服务」里打开 Irodori-TTS，或运行 npm run dev:irodori。',
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
    const body = maybe?.error ?? {
      code: `HTTP_${response.status}`,
      message: text?.slice(0, 300) || `Irodori 服务返回 ${response.status}`,
      retryable: response.status >= 500,
    };
    throw new RequestError(response.status, body);
  }

  return payload as T;
}

/** 是不是「撞上采样长尾」的那条 504（决定要不要显示「重试（降步）」按钮） */
export function isIrodoriTimeout(error: unknown): boolean {
  return error instanceof RequestError && error.code === 'IRODORI_TIMEOUT';
}

/**
 * 从 504 的 details 里取服务端建议的降步值。
 *
 * 刻意**不**在前端写死 20：服务端可能按机器/权重换档，前端照它说的发就行。
 * 拿不到时退到兜底常量，并且是「更低」而不是「更高」—— 降步是绕开长尾的手段。
 */
export function irodoriRetrySuggestion(error: unknown): number {
  if (error instanceof RequestError) {
    const details = error.details as Partial<IrodoriTimeoutDetails> | undefined;
    const suggested = details?.retry_suggestion?.num_steps;
    if (typeof suggested === 'number' && suggested > 0) return suggested;
  }
  return IRODORI_FALLBACK_DOWNGRADE_STEPS;
}

/** 把原 payload 改成「按服务端建议降步」的版本（供一键重试用） */
export function withLowerSteps(payload: IrodoriSynthPayload, steps: number): IrodoriSynthPayload {
  return { ...payload, num_steps: steps };
}

export const irodoriApi = {
  health: (baseUrl?: string): Promise<IrodoriHealth> =>
    irodoriRequest('/health', { method: 'GET', timeoutMs: 15_000 }, baseUrl),

  catalog: (baseUrl?: string): Promise<IrodoriCatalog> =>
    irodoriRequest('/v1/catalog', { method: 'GET', timeoutMs: 20_000 }, baseUrl),

  /** 已固化的 speaker embedding（30-6 训练产物） */
  speakers: (baseUrl?: string): Promise<{ ok: boolean; speakers: IrodoriSpeaker[]; count: number }> =>
    irodoriRequest('/v1/speakers', { method: 'GET', timeoutMs: 15_000 }, baseUrl),

  /** 把模型装进显存（实测约 20~30s）。已加载时服务端直接返回，不会重复加载 */
  warmup: (baseUrl?: string): Promise<{ ok: boolean; loaded: boolean; starting: boolean }> =>
    irodoriRequest('/v1/warmup', { method: 'POST', timeoutMs: 0 }, baseUrl),

  unload: (baseUrl?: string): Promise<{ ok: boolean; loaded: boolean; freed_mb: number | null }> =>
    irodoriRequest('/v1/unload', { method: 'POST', timeoutMs: 60_000 }, baseUrl),

  /**
   * 合成一条日语语音。
   *
   * `timeoutMs: 0` 是刻意的：服务端有 180s 墙钟护栏 + 段间自动降步，
   * 让它的 504（带 `retry_suggestion`）先到前端，比客户端 abort 有用得多。
   */
  synthesize: (payload: IrodoriSynthPayload, baseUrl?: string): Promise<IrodoriSynthResult> =>
    irodoriRequest('/v1/synth', { method: 'POST', body: JSON.stringify(payload), timeoutMs: 0 }, baseUrl),
};

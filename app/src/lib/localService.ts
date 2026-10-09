import { RequestError } from '@/lib/errors';

/**
 * GPT-SoVITS 本地服务的启停（`/api/sovits/service`）。
 *
 * 存在的理由很具体：8 GB 显存装不下两套常驻模型。报错里让用户
 * 「先关掉 GPT-SoVITS 释放显存」，却没有地方可以关 —— 这个建议等于做不到。
 *
 * 默认**停用**（服务端同此默认）：显存留给网易主服务，
 * 只有用户明确要用训练 / 批量 / 变声 / 翻唱时，才到设置里开。
 */

export interface LocalServiceState {
  enabled: boolean;
  reachable: boolean;
  managed?: boolean;
  pid?: number | null;
}

export interface LocalServiceToggleResult {
  ok: boolean;
  enabled: boolean;
  reachable: boolean;
  hint: string;
}

async function serviceRequest<T>(
  path: string,
  options: { method: 'GET' | 'POST'; body?: string; timeoutMs: number },
): Promise<T> {
  const controller = new AbortController();
  const timer = options.timeoutMs > 0 ? setTimeout(() => controller.abort(), options.timeoutMs) : null;

  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method,
      body: options.body,
      signal: controller.signal,
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new RequestError(504, {
        code: 'SERVICE_TOGGLE_TIMEOUT',
        message: '切换 GPT-SoVITS 服务超时（开启时首次要 import torch，数十秒属正常）。',
        retryable: true,
      });
    }
    throw new RequestError(0, { code: 'GATEWAY_UNREACHABLE', message: '无法连接到本地网关。', retryable: true });
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
    const maybe = payload as { error?: { code: string; message: string; retryable?: boolean; hint?: string } } | null;
    throw new RequestError(
      response.status,
      maybe?.error ?? {
        code: `HTTP_${response.status}`,
        message: text?.slice(0, 300) || `网关返回 ${response.status}`,
        retryable: response.status >= 500,
      },
    );
  }

  return payload as T;
}

export const localServiceApi = {
  state: (): Promise<LocalServiceState> =>
    serviceRequest<LocalServiceState>('/api/sovits/service', { method: 'GET', timeoutMs: 15_000 }),

  /** 开启 / 关闭。开启后首次要 import torch，数十秒才就绪，所以不设超时。 */
  toggle: (enabled: boolean): Promise<LocalServiceToggleResult> =>
    serviceRequest<LocalServiceToggleResult>('/api/sovits/service', {
      method: 'POST',
      body: JSON.stringify({ enabled }),
      timeoutMs: enabled ? 0 : 60_000,
    }),
};

/**
 * 网易（:9882）与 IndexTTS（:9883）的启停（`/api/<id>/service`）。
 * 与 GPT-SoVITS 同一套开关语义：网关托管自己拉起的实例；
 * 外部终端起的实例关不掉，但会把常驻模型卸掉归还显存，并在 hint 里说清楚。
 */
export interface RuntimeServiceState {
  baseUrl: string;
  reachable: boolean;
  managed: boolean;
  starting: boolean;
  enabled: boolean;
  pid: number | null;
  lastError: string | null;
}

export const runtimeServiceApi = {
  state: (id: 'netease' | 'indextts'): Promise<RuntimeServiceState> =>
    serviceRequest<RuntimeServiceState>(`/api/${id}/service`, { method: 'GET', timeoutMs: 15_000 }),

  toggle: (id: 'netease' | 'indextts', enabled: boolean): Promise<LocalServiceToggleResult> =>
    serviceRequest<LocalServiceToggleResult>(`/api/${id}/service`, {
      method: 'POST',
      body: JSON.stringify({ enabled }),
      // 开启要等 import torch（数十秒），不设超时；关闭是先卸模型再杀进程，给 90 秒
      timeoutMs: enabled ? 0 : 90_000,
    }),
};

/**
 * 通知「本地服务的 enabled 状态变了」 ——
 * App 根组件里的侧栏探活 effect 订阅这个事件，收到后立即重读 supervisor。
 * 否则用户点了设置页的开关，要等下一轮 30s/10s 定时器才能看到侧栏翻转，体验不好。
 *
 * 三个开关（GPT-SoVITS / 网易 / IndexTTS）共用同一个事件名 —— 探活里都会重读自己的 supervisor。
 */
export const SERVICE_ENABLED_CHANGED_EVENT = 'service-enabled-changed';

export function notifyServiceEnabledChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(SERVICE_ENABLED_CHANGED_EVENT));
}

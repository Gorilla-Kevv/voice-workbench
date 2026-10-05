import { RequestError } from '@/lib/errors';

/**
 * 启动预加载（`/api/preload/*`）。
 *
 * 用途：开网页时选一个模型提前装进显存。网易与 IndexTTS 谁当主力**由使用测试决定**，
 * 所以界面不预设，只把每个模型的显存代价摆出来让用户挑 —— 显存是有限的，
 * 选谁就等于把这块资源给谁（另一套会被让出）。
 */

export type PreloadModel = 'netease-tts' | 'sovits' | 'none';
export type PreloadPreference = PreloadModel | 'ask';

export interface PreloadModelInfo {
  id: PreloadModel;
  label: string;
  vram_mb: number;
  /** 当前显存装不装得下（读不到时为 null） */
  fits: boolean | null;
}

export interface PreloadCatalog {
  ok: boolean;
  vram: { free_mb: number | null; total_mb: number | null; source: string };
  models: PreloadModelInfo[];
  preference: PreloadPreference;
}

export interface PreloadReport {
  model: PreloadModel;
  ok: boolean;
  released: string[];
  vram_free_mb: number | null;
  message: string;
}

async function preloadRequest<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch {
    throw new RequestError(0, { code: 'GATEWAY_UNREACHABLE', message: '无法连接到本地网关。', retryable: true });
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
      maybe?.error ?? { code: `HTTP_${response.status}`, message: text?.slice(0, 200) || `网关返回 ${response.status}`, retryable: true },
    );
  }
  return payload as T;
}

export const preloadApi = {
  catalog: (): Promise<PreloadCatalog> => preloadRequest<PreloadCatalog>('/api/preload/catalog', { method: 'GET' }),

  /** 记住选择（'ask' = 每次启动问我） */
  savePreference: (model: PreloadPreference): Promise<{ ok: boolean; model: PreloadPreference }> =>
    preloadRequest('/api/preload/preference', { method: 'PUT', body: JSON.stringify({ model }) }),

  /** 立刻预加载；可能耗时数十秒（首次要 import torch） */
  run: (model: PreloadModel): Promise<PreloadReport> =>
    preloadRequest<PreloadReport>('/api/preload', { method: 'POST', body: JSON.stringify({ model }) }),
};

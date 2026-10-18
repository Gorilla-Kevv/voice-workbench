import { RequestError } from '@/lib/errors';
import type { Gsv5Catalog, Gsv5Health, Gsv5SynthPayload, Gsv5SynthResult } from '@/types/gsv5';

/**
 * GPT-SoVITS v5 客户端（`/api/gsv5/*`，经网关透传到 :9885）。
 *
 * 与 `lib/irodori.ts` 同构：错误一律转成带 hint 的结构化 RequestError（坑 21）。
 */

async function gsv5Request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new RequestError(0, {
      code: 'GSV5_UNREACHABLE',
      message: '无法连接 GPT-SoVITS v5 服务。',
      retryable: true,
      hint: '在设置页打开「GPT-SoVITS v5」开关，或 npm run dev:gsv5 手动启动。',
    });
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
        message: text.slice(0, 200) || `GPT-SoVITS v5 返回 ${response.status}`,
        retryable: response.status >= 500,
      },
    );
  }
  return payload as T;
}

export const gsv5Api = {
  health: (): Promise<Gsv5Health> => gsv5Request<Gsv5Health>('/api/gsv5/health', { method: 'GET' }),

  catalog: (): Promise<Gsv5Catalog> => gsv5Request<Gsv5Catalog>('/api/gsv5/v1/catalog', { method: 'GET' }),

  warmup: (variant: string): Promise<{ ok: boolean; reused?: boolean; load_sec?: number }> =>
    gsv5Request('/api/gsv5/v1/warmup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ variant }),
    }),

  unload: (): Promise<{ ok: boolean }> =>
    gsv5Request('/api/gsv5/v1/unload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),

  synthesize: (payload: Gsv5SynthPayload): Promise<Gsv5SynthResult> =>
    gsv5Request<Gsv5SynthResult>('/api/gsv5/v1/synth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
};

/** base64 WAV → 可播放地址 */
export function gsv5Base64ToUrl(audioBase64: string): string {
  const bytes = Uint8Array.from(atob(audioBase64), (char) => char.charCodeAt(0));
  return URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
}

/**
 * IndexTTS（indextts/，第三个 Python 运行时）客户端。
 *
 * 与 `netease.ts` 同一套约定：默认经同源网关 `/api/indextts/*` 透传到本地服务（:9883）；
 * 服务端的 `error.hint` 一路带到 UI。
 *
 * 超时语义：合成/预热用 `timeoutMs: 0`（不超时）—— 首次要加载模型（实测约 4 分钟，
 * 大头是辅助模型的网络探测）；health / catalog 用有限超时。
 */

import { RequestError } from '@/lib/errors';
import type {
  IndexttsCatalog,
  IndexttsEngineStatus,
  IndexttsHealth,
  IndexttsSynthResult,
} from '@/types';

/** 经 Node 网关的默认入口 */
export const DEFAULT_INDEXTTS_BASE = '/api/indextts';

export function normalizeIndexttsBase(raw: string | undefined | null): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return DEFAULT_INDEXTTS_BASE;
  return trimmed.replace(/\/+$/, '');
}

interface IndexttsRequestOptions extends RequestInit {
  /** 超时毫秒；0 表示不超时（推理类长任务） */
  timeoutMs?: number;
}

async function indexttsRequest<T>(path: string, options: IndexttsRequestOptions = {}, baseUrl?: string): Promise<T> {
  const base = normalizeIndexttsBase(baseUrl);
  const url = `${base}${path}`;
  const { timeoutMs = 120_000, ...init } = options;

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
        code: 'INDEXTTS_TIMEOUT',
        message: 'IndexTTS 服务响应超时。首次请求可能正在加载模型（几分钟内属正常），请稍后重试。',
        retryable: true,
      });
    }
    throw new RequestError(0, {
      code: 'INDEXTTS_UNREACHABLE',
      message: '无法连接到 IndexTTS 服务。它是按需启动的模块，默认不随主程序启动。',
      retryable: true,
      hint: '运行 npm run dev:indextts 启动；环境搭建见 docs/INDEX-TTS-INTEGRATION.md。',
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
    const maybe = payload as { error?: { code: string; message: string; retryable?: boolean; hint?: string } } | null;
    const body = maybe?.error ?? {
      code: `HTTP_${response.status}`,
      message: text?.slice(0, 300) || `IndexTTS 服务返回 ${response.status}`,
      retryable: response.status >= 500,
    };
    throw new RequestError(response.status, body);
  }

  return payload as T;
}

function appendForm(form: FormData, values: Record<string, string | number | boolean | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    form.append(key, String(value));
  }
}

export interface IndexttsSynthPayload {
  text: string;
  /** ZH / EN / JA / AR / ES */
  lang: string;
  /** 参考音频：上传文件 或 服务端路径，二选一 */
  file?: File | null;
  refPath?: string;
  /** 语速倍率（官方「时长系数」）：0.5=快 … 1.0=不变 … 2.0=慢 */
  durationFactor?: number;
  /** 8 维情感向量（喜/怒/哀/惧/厌恶/低落/惊喜/平静），不传则跟随参考音频 */
  emoVector?: number[] | null;
  /** 情感参考音频（与向量二选一，服务端优先级由上游决定） */
  emoFile?: File | null;
  /** 情感参考音频的强度（0~1，默认 0.65） */
  emoAlpha?: number;
}

export const indexttsApi = {
  health: (baseUrl?: string): Promise<IndexttsHealth> =>
    indexttsRequest('/health', { method: 'GET', timeoutMs: 15_000 }, baseUrl),

  catalog: (baseUrl?: string): Promise<IndexttsCatalog> =>
    indexttsRequest('/v1/catalog', { method: 'GET', timeoutMs: 20_000 }, baseUrl),

  pipeline: (baseUrl?: string): Promise<{ ok: boolean } & IndexttsEngineStatus> =>
    indexttsRequest('/v1/pipeline', { method: 'GET', timeoutMs: 20_000 }, baseUrl),

  warmup: (baseUrl?: string): Promise<{ ok: boolean; engine: IndexttsEngineStatus }> =>
    indexttsRequest('/v1/warmup', { method: 'POST', timeoutMs: 0 }, baseUrl),

  unload: (baseUrl?: string): Promise<{ ok: boolean; engine: IndexttsEngineStatus }> =>
    indexttsRequest('/v1/unload', { method: 'POST', timeoutMs: 60_000 }, baseUrl),

  /** 单条零样本合成。file 与 refPath 至少给一个 */
  synthesize: (payload: IndexttsSynthPayload, baseUrl?: string): Promise<IndexttsSynthResult> => {
    const form = new FormData();
    if (payload.file) form.append('file', payload.file, payload.file.name);
    if (payload.emoFile) form.append('emo_file', payload.emoFile, payload.emoFile.name);
    appendForm(form, {
      text: payload.text,
      lang: payload.lang,
      ref_path: payload.refPath,
      duration_factor: payload.durationFactor,
      emo_vector: payload.emoVector && payload.emoVector.length ? JSON.stringify(payload.emoVector) : undefined,
      emo_alpha: payload.emoAlpha,
    });
    return indexttsRequest('/v1/synth', { method: 'POST', body: form, timeoutMs: 0 }, baseUrl);
  },
};

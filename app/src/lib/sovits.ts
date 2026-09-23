/**
 * GPT-SoVITS 本地服务客户端。
 *
 * 默认经同源的 Node 网关访问（`/api/sovits/*`）—— 这样前端只需要知道一个地址，
 * 也不需要第二套 CORS 配置。如果你把 Python 服务跑在别的机器/端口上，
 * 在设置里填一个完整地址即可，本模块会自动切换。
 *
 * 错误处理原则：本地服务的失败几乎都是「环境/配置」问题而不是「网络」问题，
 * 因此这里把服务端返回的 `hint` 一直带到 UI，而不是折叠成一句「请求失败」。
 */

import { RequestError } from '@/lib/errors';
import type {
  SovitsBatchRequest,
  SovitsBatchResponse,
  SovitsCatalog,
  SovitsErrorBody,
  SovitsHealth,
  SovitsJob,
  SovitsSplitResponse,
  SovitsTTSRequest,
  SovitsTTSResponse,
  SovitsTrainPayload,
  SovitsTrainPlan,
  SovitsVoice,
  SovitsVoiceDraft,
  SovitsWeightList,
} from '@/types';

/** 经 Node 网关的默认入口 */
export const DEFAULT_SOVITS_BASE = '/api/sovits';
/** 直接访问 Python 服务时的默认地址（用于给出填写示例） */
export const DIRECT_SOVITS_BASE = 'http://127.0.0.1:9881';
export const SOVITS_URL_STORAGE_KEY = 'mimo-voice:sovits-url';

/** 归一化地址：去掉结尾斜杠，空值回落为网关入口 */
export function normalizeBaseUrl(raw: string | undefined | null): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return DEFAULT_SOVITS_BASE;
  return trimmed.replace(/\/+$/, '');
}

export function readBaseUrl(): string {
  try {
    return normalizeBaseUrl(localStorage.getItem(SOVITS_URL_STORAGE_KEY));
  } catch {
    return DEFAULT_SOVITS_BASE;
  }
}

export function writeBaseUrl(url: string): void {
  try {
    localStorage.setItem(SOVITS_URL_STORAGE_KEY, normalizeBaseUrl(url));
  } catch {
    // 隐私模式下忽略
  }
}

/**
 * 把服务返回的「服务内相对路径」转成浏览器可直接使用的地址。
 *
 * 走网关时必须补上 `/api/sovits` 前缀，否则 `/files/xxx.wav` 会打到 Node 上
 * 并 404 —— 这是接入后最容易踩的一个坑。
 */
export function resolveAudioUrl(path: string | null | undefined, baseUrl?: string): string | null {
  if (!path) return null;
  if (/^(https?:|blob:|data:)/i.test(path)) return path;
  const base = normalizeBaseUrl(baseUrl ?? readBaseUrl());
  if (base.startsWith('http')) return `${base}${path.startsWith('/') ? '' : '/'}${path}`;
  return `${base}${path.startsWith('/') ? '' : '/'}${path}`;
}

// --------------------------------------------------------------------------
// 请求封装
// --------------------------------------------------------------------------

interface RequestOptions extends RequestInit {
  /** 超时毫秒；0 表示不超时（模型加载、训练等长任务） */
  timeoutMs?: number;
}

async function request<T>(path: string, options: RequestOptions = {}, baseUrl?: string): Promise<T> {
  const base = normalizeBaseUrl(baseUrl ?? readBaseUrl());
  const url = `${base}${path}`;
  const { timeoutMs = 180_000, ...init } = options;

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
        code: 'SOVITS_TIMEOUT',
        message: '本地服务响应超时。首次合成需要加载模型（约 30~90 秒），请稍后重试或到设置页查看服务状态。',
        retryable: true,
      });
    }
    throw new RequestError(0, {
      code: 'SOVITS_UNREACHABLE',
      message: `无法连接到 GPT-SoVITS 本地服务（${base}）。请确认服务已启动，或在设置页修正服务地址。`,
      retryable: true,
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
    const maybe = payload as { error?: SovitsErrorBody; detail?: SovitsErrorBody } | null;
    const body: SovitsErrorBody = maybe?.error ??
      maybe?.detail ?? {
        code: `HTTP_${response.status}`,
        message: text?.slice(0, 300) || `本地服务返回 ${response.status}`,
        retryable: response.status >= 500,
      };
    throw new RequestError(response.status, body);
  }

  return payload as T;
}

// --------------------------------------------------------------------------
// 元信息
// --------------------------------------------------------------------------

export const sovitsApi = {
  health: (baseUrl?: string): Promise<SovitsHealth> =>
    request<SovitsHealth>('/health', { method: 'GET', timeoutMs: 20_000 }, baseUrl),

  catalog: (baseUrl?: string): Promise<{ ok: boolean; catalog: SovitsCatalog }> =>
    request('/v1/catalog', { method: 'GET', timeoutMs: 20_000 }, baseUrl),

  // ------------------------------------------------------------------
  // 管线与权重
  // ------------------------------------------------------------------

  pipeline: (baseUrl?: string) => request<{ ok: boolean; pipeline: SovitsHealth['pipeline'] }>(
    '/v1/pipeline',
    { method: 'GET', timeoutMs: 20_000 },
    baseUrl,
  ),

  warmup: (baseUrl?: string) =>
    request<{ ok: boolean; message: string }>(
      '/v1/pipeline/warmup?blocking=false',
      { method: 'POST' },
      baseUrl,
    ),

  unload: (baseUrl?: string) =>
    request<{ ok: boolean; message: string }>('/v1/pipeline/unload', { method: 'POST' }, baseUrl),

  stop: (baseUrl?: string) =>
    request<{ ok: boolean; message: string }>('/v1/pipeline/stop', { method: 'POST' }, baseUrl),

  weights: (version?: string, baseUrl?: string): Promise<SovitsWeightList> =>
    request<SovitsWeightList>(
      `/v1/weights${version ? `?version=${encodeURIComponent(version)}` : ''}`,
      { method: 'GET', timeoutMs: 30_000 },
      baseUrl,
    ),

  loadWeights: (
    payload: {
      version?: string;
      gpt?: string;
      sovits?: string;
      device?: string;
      is_half?: boolean;
      eager?: boolean;
    },
    baseUrl?: string,
  ) =>
    request<{ ok: boolean; pipeline: SovitsHealth['pipeline'] }>(
      '/v1/weights/load',
      { method: 'POST', body: JSON.stringify({ eager: true, ...payload }), timeoutMs: 0 },
      baseUrl,
    ),

  // ------------------------------------------------------------------
  // 音色库
  // ------------------------------------------------------------------

  listVoices: (baseUrl?: string) =>
    request<{ ok: boolean; voices: SovitsVoice[]; total: number }>(
      '/v1/voices',
      { method: 'GET', timeoutMs: 30_000 },
      baseUrl,
    ),

  createVoice: (draft: SovitsVoiceDraft, file: File, baseUrl?: string) => {
    const form = new FormData();
    form.append('name', draft.name);
    form.append('prompt_text', draft.prompt_text);
    form.append('prompt_lang', draft.prompt_lang);
    form.append('note', draft.note ?? '');
    form.append('tags', (draft.tags ?? []).join(','));
    form.append('audio', file, file.name);
    return request<{ ok: boolean; voice: SovitsVoice }>(
      '/v1/voices',
      { method: 'POST', body: form, timeoutMs: 120_000 },
      baseUrl,
    );
  },

  /** 引用磁盘上已有的音频（不复制文件） */
  createVoiceFromPath: (
    draft: SovitsVoiceDraft & { audio_path: string },
    baseUrl?: string,
  ) =>
    request<{ ok: boolean; voice: SovitsVoice }>(
      '/v1/voices/source',
      {
        method: 'POST',
        body: JSON.stringify({
          name: draft.name,
          prompt_text: draft.prompt_text,
          prompt_lang: draft.prompt_lang,
          note: draft.note ?? '',
          tags: (draft.tags ?? []).join(','),
          audio_path: draft.audio_path,
        }),
        timeoutMs: 60_000,
      },
      baseUrl,
    ),

  updateVoice: (
    id: string,
    patch: Partial<Omit<SovitsVoice, 'id' | 'warnings' | 'exists'>>,
    baseUrl?: string,
  ) =>
    request<{ ok: boolean; voice: SovitsVoice }>(
      `/v1/voices/${id}`,
      { method: 'PATCH', body: JSON.stringify(patch), timeoutMs: 60_000 },
      baseUrl,
    ),

  replaceVoiceAudio: (id: string, file: File, baseUrl?: string) => {
    const form = new FormData();
    form.append('audio', file, file.name);
    return request<{ ok: boolean; voice: SovitsVoice }>(
      `/v1/voices/${id}/audio`,
      { method: 'POST', body: form, timeoutMs: 120_000 },
      baseUrl,
    );
  },

  deleteVoice: (id: string, baseUrl?: string) =>
    request<{ ok: boolean; message: string }>(
      `/v1/voices/${id}`,
      { method: 'DELETE', timeoutMs: 30_000 },
      baseUrl,
    ),

  // ------------------------------------------------------------------
  // 合成
  // ------------------------------------------------------------------

  synthesize: (payload: SovitsTTSRequest, baseUrl?: string): Promise<SovitsTTSResponse> =>
    request<SovitsTTSResponse>(
      '/v1/tts',
      { method: 'POST', body: JSON.stringify(payload), timeoutMs: 0 },
      baseUrl,
    ),

  splitText: (
    payload: { text: string; text_lang?: string; text_split_method?: string },
    baseUrl?: string,
  ): Promise<SovitsSplitResponse> =>
    request<SovitsSplitResponse>(
      '/v1/text/split',
      { method: 'POST', body: JSON.stringify(payload), timeoutMs: 120_000 },
      baseUrl,
    ),

  batch: (payload: SovitsBatchRequest, baseUrl?: string): Promise<SovitsBatchResponse> =>
    request<SovitsBatchResponse>(
      '/v1/tts/batch',
      { method: 'POST', body: JSON.stringify(payload), timeoutMs: 0 },
      baseUrl,
    ),

  batchPlan: (
    payload: SovitsBatchRequest,
    baseUrl?: string,
  ): Promise<{ ok: boolean; total: number; items: { index: number; key: string | null; text: string }[] }> =>
    request(
      '/v1/tts/batch/plan',
      { method: 'POST', body: JSON.stringify(payload), timeoutMs: 60_000 },
      baseUrl,
    ),

  // ------------------------------------------------------------------
  // 训练
  // ------------------------------------------------------------------

  planTrain: (payload: SovitsTrainPayload, baseUrl?: string): Promise<SovitsTrainPlan> =>
    request<SovitsTrainPlan>(
      '/v1/train/plan',
      { method: 'POST', body: JSON.stringify(payload), timeoutMs: 120_000 },
      baseUrl,
    ),

  createTrain: (
    payload: SovitsTrainPayload,
    baseUrl?: string,
  ): Promise<{ ok: boolean; job_id: string; state: string; stages: SovitsJob['stages']; message: string }> =>
    request('/v1/train', { method: 'POST', body: JSON.stringify(payload), timeoutMs: 120_000 }, baseUrl),

  listTrainJobs: (baseUrl?: string) =>
    request<{ ok: boolean; jobs: SovitsJob[]; total: number }>(
      '/v1/train?limit=20',
      { method: 'GET', timeoutMs: 30_000 },
      baseUrl,
    ),

  getJob: (jobId: string, baseUrl?: string): Promise<{ ok: boolean; job: SovitsJob }> =>
    request(`/v1/jobs/${jobId}`, { method: 'GET', timeoutMs: 30_000 }, baseUrl),

  cancelJob: (jobId: string, baseUrl?: string) =>
    request<{ ok: boolean; message: string }>(
      `/v1/jobs/${jobId}/cancel`,
      { method: 'POST', body: JSON.stringify({ reason: '用户取消' }), timeoutMs: 30_000 },
      baseUrl,
    ),

  uploadCorpus: (files: File[], baseUrl?: string) => {
    const form = new FormData();
    for (const file of files) form.append('files', file, file.name);
    return request<{ ok: boolean; dir: string; files: string[]; rejected: string[]; message: string }>(
      '/v1/train/upload',
      { method: 'POST', body: form, timeoutMs: 0 },
      baseUrl,
    );
  },
};

// --------------------------------------------------------------------------
// 流式合成
// --------------------------------------------------------------------------

export type SovitsStreamEvent =
  | { type: 'start'; text: string; version: string }
  | { type: 'meta'; sample_rate: number }
  | { type: 'chunk'; index: number; sample_rate: number; audio: string; samples: number }
  | { type: 'done'; audio_url: string | null; sample_rate: number; duration_s: number; elapsed_ms: number }
  | { type: 'error'; error: SovitsErrorBody };

/**
 * 流式合成。逐条产出服务端事件，调用方可以边收边播。
 *
 * 用 `ReadableStream` 手写行解析而不是 `EventSource`：后者只支持 GET，
 * 而合成请求需要一个 JSON 请求体。
 */
export async function* streamSynthesize(
  payload: SovitsTTSRequest,
  baseUrl?: string,
  signal?: AbortSignal,
): AsyncGenerator<SovitsStreamEvent> {
  const base = normalizeBaseUrl(baseUrl ?? readBaseUrl());
  const response = await fetch(`${base}/v1/tts/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, params: { ...payload.params, streaming_mode: true } }),
    signal,
  });

  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => '');
    throw new RequestError(response.status, {
      code: `HTTP_${response.status}`,
      message: text.slice(0, 300) || `流式合成失败（${response.status}）`,
      retryable: true,
    });
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) {
          try {
            yield JSON.parse(line) as SovitsStreamEvent;
          } catch {
            // 半行或非 JSON：忽略，不影响后续事件
          }
        }
        newlineIndex = buffer.indexOf('\n');
      }
    }
    const tail = buffer.trim();
    if (tail) {
      try {
        yield JSON.parse(tail) as SovitsStreamEvent;
      } catch {
        // 忽略
      }
    }
  } finally {
    reader.releaseLock();
  }
}

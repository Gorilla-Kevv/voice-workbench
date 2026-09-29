/**
 * 网易模块（Confucius4-TTS + Confucius4-R2T2）客户端。
 *
 * 与 `asr.ts` / `vc.ts` 同一套约定：默认经同源网关 `/api/netease/*` 透传到
 * 本地 netease 服务（:9882，第二个 Python 运行时）；服务端的 `error.hint`
 * 一路带到 UI。不走 `localRequest` 是因为后者读的是 GPT-SoVITS 的服务地址
 * （localStorage 里的 sovits-url）—— 网易是独立服务，地址语义不同。
 *
 * 超时语义与 asr.ts 一致：
 *  - 合成/转写用 `timeoutMs: 0`（不超时）：首次要加载模型，几十秒是正常的；
 *  - catalog / pipeline 用有限超时：只读常量与状态，慢就是出问题了。
 */

import { RequestError } from '@/lib/errors';
import type {
  NeteaseCatalog,
  NeteaseEngineStatus,
  NeteaseHealth,
  NeteaseStreamEvent,
  NeteaseStreamProgress,
  NeteaseTranscribeResult,
  NeteaseTtsResult,
} from '@/types';

/** 经 Node 网关的默认入口 */
export const DEFAULT_NETEASE_BASE = '/api/netease';
/** 直接访问 netease 服务时的默认地址（用于报错文案） */
export const DIRECT_NETEASE_BASE = 'http://127.0.0.1:9882';

export function normalizeNeteaseBase(raw: string | undefined | null): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return DEFAULT_NETEASE_BASE;
  return trimmed.replace(/\/+$/, '');
}

interface NeteaseRequestOptions extends RequestInit {
  /** 超时毫秒；0 表示不超时（推理类长任务） */
  timeoutMs?: number;
}

async function neteaseRequest<T>(path: string, options: NeteaseRequestOptions = {}, baseUrl?: string): Promise<T> {
  const base = normalizeNeteaseBase(baseUrl);
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
        code: 'NETEASE_TIMEOUT',
        message: '网易模块服务响应超时。首次请求可能正在加载模型（几十秒属正常），请稍后重试。',
        retryable: true,
      });
    }
    throw new RequestError(0, {
      code: 'NETEASE_UNREACHABLE',
      message: '无法连接到网易模块服务。它是可选模块，默认不随主程序启动。',
      retryable: true,
      hint: '运行 npm run dev:netease 启动；首次使用先看 netease/README.md。',
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
      message: text?.slice(0, 300) || `网易模块服务返回 ${response.status}`,
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

// ---------------------------------------------------------------- 合成参数

export interface NeteaseTtsPayload {
  text: string;
  /** 合成目标语种（14 选 1）；参考音频语种与此无关 */
  lang: string;
  /** 参考音频：三选一 —— 上传文件 / 服务端路径 / 服务端已缓存的音色 */
  file?: File | null;
  refPath?: string;
  preempt?: boolean;
}

export interface NeteaseTranscribePayload {
  file?: File | null;
  refPath?: string;
  /** auto / zh / en / ... */
  language: string;
  returnTimestamps?: boolean;
  stream?: boolean;
  chunkMs?: number;
  preempt?: boolean;
}

export const neteaseApi = {
  health: (baseUrl?: string): Promise<NeteaseHealth> =>
    neteaseRequest('/health', { method: 'GET', timeoutMs: 15_000 }, baseUrl),

  catalog: (baseUrl?: string): Promise<NeteaseCatalog> =>
    neteaseRequest('/v1/netease/catalog', { method: 'GET', timeoutMs: 20_000 }, baseUrl),

  // ---------------------------------------------------- TTS 引擎管理

  ttsPipeline: (baseUrl?: string): Promise<NeteaseEngineStatus> =>
    neteaseRequest('/v1/confucius/pipeline', { method: 'GET', timeoutMs: 20_000 }, baseUrl),

  ttsWarmup: (baseUrl?: string): Promise<{ ok: boolean; preempted: string | null; engine: NeteaseEngineStatus }> =>
    neteaseRequest('/v1/confucius/warmup', { method: 'POST', timeoutMs: 0 }, baseUrl),

  ttsUnload: (baseUrl?: string): Promise<{ ok: boolean; engine: NeteaseEngineStatus }> =>
    neteaseRequest('/v1/confucius/unload', { method: 'POST', timeoutMs: 60_000 }, baseUrl),

  /** 单条零样本合成。file 与 refPath 至少给一个 */
  synthesize: (payload: NeteaseTtsPayload, baseUrl?: string): Promise<NeteaseTtsResult> => {
    const form = new FormData();
    if (payload.file) form.append('file', payload.file, payload.file.name);
    appendForm(form, {
      text: payload.text,
      lang: payload.lang,
      ref_path: payload.refPath,
      preempt: payload.preempt ?? true,
    });
    return neteaseRequest('/v1/confucius/tts', { method: 'POST', body: form, timeoutMs: 0 }, baseUrl);
  },

  // ---------------------------------------------------- ASR 引擎管理

  asrPipeline: (baseUrl?: string): Promise<NeteaseEngineStatus & { recent_logs?: string[] }> =>
    neteaseRequest('/v1/r2t2/pipeline', { method: 'GET', timeoutMs: 20_000 }, baseUrl),

  asrWarmup: (baseUrl?: string): Promise<{ ok: boolean; preempted: string | null }> =>
    neteaseRequest('/v1/r2t2/warmup', { method: 'POST', timeoutMs: 0 }, baseUrl),

  asrUnload: (baseUrl?: string): Promise<{ ok: boolean; engine: NeteaseEngineStatus }> =>
    neteaseRequest('/v1/r2t2/unload', { method: 'POST', timeoutMs: 60_000 }, baseUrl),

  /** 离线转写（等全部完成一次性返回） */
  transcribe: (payload: NeteaseTranscribePayload, baseUrl?: string): Promise<NeteaseTranscribeResult> => {
    const form = new FormData();
    if (payload.file) form.append('file', payload.file, payload.file.name);
    appendForm(form, {
      ref_path: payload.refPath,
      language: payload.language,
      return_timestamps: payload.returnTimestamps ?? false,
      stream: false,
      preempt: payload.preempt ?? true,
    });
    return neteaseRequest('/v1/r2t2/transcribe', { method: 'POST', body: form, timeoutMs: 0 }, baseUrl);
  },

  /**
   * 流式转写：NDJSON 逐行解析，每个 delta 都回调一次。
   *
   * 返回中止函数（AbortController）—— 用户取消时把 fetch 与 reader 一起掐断。
   * 服务端 append-only 语义由上游保证，前端每收到 delta 就**整体替换**文本，
   * 不需要自己做任何合并。
   */
  transcribeStream: (
    payload: NeteaseTranscribePayload,
    onEvent: (event: NeteaseStreamEvent, progress: NeteaseStreamProgress) => void,
    baseUrl?: string,
  ): { promise: Promise<NeteaseStreamProgress | null>; abort: () => void } => {
    const controller = new AbortController();
    const form = new FormData();
    if (payload.file) form.append('file', payload.file, payload.file.name);
    appendForm(form, {
      ref_path: payload.refPath,
      language: payload.language,
      return_timestamps: payload.returnTimestamps ?? false,
      stream: true,
      chunk_ms: payload.chunkMs ?? 160,
      preempt: payload.preempt ?? true,
    });

    const progress: NeteaseStreamProgress = { text: '', finalized: false, elapsedSec: null };

    const promise = (async (): Promise<NeteaseStreamProgress | null> => {
      let response: Response;
      try {
        response = await fetch(`${normalizeNeteaseBase(baseUrl)}/v1/r2t2/transcribe`, {
          method: 'POST',
          body: form,
          signal: controller.signal,
        });
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') return null;
        throw new RequestError(0, {
          code: 'NETEASE_UNREACHABLE',
          message: '无法连接到网易模块服务（流式转写）。',
          retryable: true,
          hint: '运行 npm run dev:netease 启动。',
        });
      }

      if (!response.ok || !response.body) {
        const text = await response.text().catch(() => '');
        let body: { error?: { code: string; message: string; hint?: string } } | null = null;
        try {
          body = JSON.parse(text);
        } catch {
          /* 非 JSON 错误体 */
        }
        throw new RequestError(response.status, body?.error ?? {
          code: `HTTP_${response.status}`,
          message: text.slice(0, 300) || `流式转写请求失败（${response.status}）`,
          retryable: response.status >= 500,
        });
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let final: NeteaseStreamProgress | null = null;

      const handleLine = (line: string): NeteaseStreamProgress | null => {
        const trimmed = line.trim();
        if (!trimmed) return null;
        let event: NeteaseStreamEvent;
        try {
          event = JSON.parse(trimmed) as NeteaseStreamEvent;
        } catch {
          return null; // 半行 / 心跳噪声直接丢弃
        }
        if (event.type === 'delta') {
          progress.text = event.text;
          progress.elapsedSec = event.elapsed_sec ?? progress.elapsedSec;
        } else if (event.type === 'result') {
          progress.text = event.text || progress.text;
          progress.finalized = true;
          progress.elapsedSec = event.elapsed_sec ?? progress.elapsedSec;
          final = { ...progress };
        } else if (event.type === 'error') {
          throw new RequestError(500, event.error);
        }
        onEvent(event, { ...progress });
        return event.type === 'result' ? final : null;
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index: number;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          const result = handleLine(line);
          if (result) return result;
        }
      }
      // 兜底：流关闭但没等到 result（服务端异常终止）
      if (buffer.trim()) {
        const result = handleLine(buffer);
        if (result) return result;
      }
      return progress.finalized ? { ...progress } : progress;
    })();

    return { promise, abort: () => controller.abort() };
  },
};

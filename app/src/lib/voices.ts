/**
 * 音色库客户端（网关原生接口 `/api/voicelib/*`）。
 *
 * 以前音色库住在 GPT-SoVITS 服务（trainer :9881）里，而它默认停用 ——
 * 结果 IndexTTS / 网易页选一段参考音频，都得先把整个 GPT-SoVITS 拉起来。
 * 现在数据在仓库根 `voicelib/`，由常驻的网关直接供：任何模型都能选音色，
 * 与 GPT-SoVITS 是否在线完全无关。
 *
 * 记录形状沿用 `SovitsVoice`（trainer `Voice.to_dict()` 的契约），前端类型不用另立一份。
 */
import { RequestError } from '@/lib/errors';
import type { SovitsVoice, SovitsVoiceDraft } from '@/types';

export const VOICELIB_BASE = '/api/voicelib';

interface VoicelistResponse {
  ok: boolean;
  voices: SovitsVoice[];
  total: number;
}

interface VoiceResponse {
  ok: boolean;
  voice: SovitsVoice;
}

async function request<T>(path: string, init: RequestInit = {}, timeoutMs = 120_000): Promise<T> {
  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
  let response: Response;
  try {
    response = await fetch(`${VOICELIB_BASE}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        ...(init.body instanceof Blob ? {} : { 'Content-Type': 'application/json' }),
        ...(init.headers ?? {}),
      },
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new RequestError(504, { code: 'VOICELIB_TIMEOUT', message: '音色库请求超时', retryable: true });
    }
    throw new RequestError(0, {
      code: 'VOICELIB_UNREACHABLE',
      message: '无法连接网关的音色库接口',
      retryable: true,
      hint: '确认网关在跑（npm run dev 或 start.bat）。音色库由网关直接提供，不需要任何模型服务。',
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  const envelope = body as { ok?: boolean; error?: { code?: string; message?: string; retryable?: boolean; hint?: string } } | null;
  if (!response.ok || !envelope?.ok) {
    throw new RequestError(response.status, {
      code: envelope?.error?.code ?? 'VOICELIB_FAILED',
      message: envelope?.error?.message || `音色库请求失败（HTTP ${response.status}）`,
      retryable: envelope?.error?.retryable ?? response.status >= 500,
      hint: envelope?.error?.hint,
    });
  }
  return envelope as T;
}

/**
 * 浏览器解码音频拿时长与采样率。
 *
 * Node 侧没有 soundfile / ffprobe，而 GPT-SoVITS 的 3~10 秒警告依赖时长 ——
 * 上传方（浏览器）恰好是唯一知道这两个数的地方，登记时顺手带上。
 * 解码失败返回 null：只是少一个提示数字，不拦保存。
 */
export async function probeAudioFile(file: File): Promise<{ duration_s: number; sample_rate: number } | null> {
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    const ctx = new Ctor();
    const decoded = await ctx.decodeAudioData(await file.arrayBuffer());
    void ctx.close();
    return { duration_s: decoded.duration, sample_rate: decoded.sampleRate };
  } catch {
    return null;
  }
}

function metaParams(meta: {
  name: string;
  prompt_text?: string;
  prompt_lang?: string;
  note?: string;
  tags?: string[];
  filename?: string;
  duration_s?: number | null;
  sample_rate?: number | null;
}): string {
  const params = new URLSearchParams();
  params.set('name', meta.name);
  params.set('prompt_text', meta.prompt_text ?? '');
  params.set('prompt_lang', meta.prompt_lang || 'zh');
  params.set('note', meta.note ?? '');
  params.set('tags', (meta.tags ?? []).join(','));
  if (meta.filename) params.set('filename', meta.filename);
  if (meta.duration_s != null) params.set('duration_s', String(meta.duration_s));
  if (meta.sample_rate != null) params.set('sample_rate', String(meta.sample_rate));
  return params.toString();
}

export const voiceApi = {
  listVoices: () => request<VoicelistResponse>('/'),

  /** 参考音频的可访问地址（磁盘路径不能当 URL 用——坑 21 同款约束） */
  voiceAudioUrl: (id: string) => `${VOICELIB_BASE}/${encodeURIComponent(id)}/audio`,

  createVoice: async (draft: SovitsVoiceDraft, file: File) => {
    const probe = await probeAudioFile(file);
    return request<VoiceResponse>(`/?${metaParams({ ...draft, filename: file.name, ...probe })}`, {
      method: 'POST',
      body: file,
    });
  },

  /** 引用磁盘上已有的音频（不复制文件） */
  createVoiceFromPath: (draft: SovitsVoiceDraft & { audio_path: string }) =>
    request<VoiceResponse>('/source', {
      method: 'POST',
      body: JSON.stringify({
        name: draft.name,
        prompt_text: draft.prompt_text,
        prompt_lang: draft.prompt_lang,
        note: draft.note ?? '',
        tags: (draft.tags ?? []).join(','),
        audio_path: draft.audio_path,
      }),
    }),

  updateVoice: (id: string, patch: Partial<Omit<SovitsVoice, 'id' | 'warnings' | 'exists'>>) =>
    request<VoiceResponse>(`/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),

  replaceVoiceAudio: async (id: string, file: File) => {
    const probe = await probeAudioFile(file);
    return request<VoiceResponse>(
      `/${encodeURIComponent(id)}/audio?${metaParams({ name: '', filename: file.name, ...probe })}`,
      { method: 'POST', body: file },
    );
  },

  deleteVoice: (id: string) =>
    request<{ ok: boolean; message: string }>(`/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};

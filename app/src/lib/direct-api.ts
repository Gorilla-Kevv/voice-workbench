/**
 * 浏览器直连模式：跳过自建后端，直接请求 MiMo 官方接口。
 *
 * 适用前提（已实测确认）：
 *   MiMo API 返回 Access-Control-Allow-Origin: * 且允许 api-key / authorization 头，
 *   因此可以在浏览器中直接调用，无需服务端代理。
 *
 * 本文件是 server/src/services/mimo.ts 的浏览器移植版，保留了：
 *   参数校验、消息组装、长文本分段、多段 WAV 拼接、错误码映射与重试。
 * 差异：站点级限流改为客户端节流（BYOK 模式下额度本就属于用户自己）。
 */

import { FALLBACK_PRESET_VOICES } from './constants';
import { RequestError } from './errors';
import type {
  ApiErrorBody,
  AudioSegment,
  HealthInfo,
  PresetVoice,
  SynthesizePayload,
  SynthesizeResponse,
} from '@/types';

const MODELS = {
  preset: 'mimo-v2.5-tts',
  design: 'mimo-v2.5-tts-voicedesign',
  clone: 'mimo-v2.5-tts-voiceclone',
} as const;

/** 官方预置音色 ID 白名单 */
const PRESET_VOICE_IDS = new Set(FALLBACK_PRESET_VOICES.map((voice) => voice.id));

const MAX_TEXT_LENGTH = 3000;
const MAX_SAMPLE_BYTES = 10 * 1024 * 1024;
const SEGMENT_THRESHOLD = 600;
const SEGMENT_TARGET = 320;
const MAX_SEGMENTS = 12;
const REQUEST_TIMEOUT_MS = 120_000;
const RETRIES = 2;

/** 上游状态码 → 用户可读提示 */
const STATUS_MAP: Record<number, { code: string; message: string; retryable: boolean }> = {
  400: { code: 'INVALID_REQUEST', message: '请求参数有误，请检查文本内容、音色或音频样本格式', retryable: false },
  401: { code: 'UNAUTHORIZED', message: 'API Key 无效或已过期，请到「设置」中更换密钥', retryable: false },
  403: { code: 'FORBIDDEN', message: '没有访问该模型的权限，请确认账号已开通对应服务', retryable: false },
  404: { code: 'NOT_FOUND', message: '接口地址或模型不存在，请确认模型名称与 Base URL', retryable: false },
  413: { code: 'PAYLOAD_TOO_LARGE', message: '音频样本或请求体过大，请压缩后重试（样本需小于 10MB）', retryable: false },
  422: { code: 'INVALID_REQUEST', message: '参数校验未通过，请检查文本与音色描述是否符合要求', retryable: false },
  429: { code: 'RATE_LIMITED', message: '调用过于频繁，已触发官方限流，请等待几秒后重试', retryable: true },
  500: { code: 'UPSTREAM_ERROR', message: 'MiMo 服务端出现异常，请稍后重试', retryable: true },
  502: { code: 'UPSTREAM_UNAVAILABLE', message: '上游网关异常，请稍后重试', retryable: true },
  503: { code: 'UPSTREAM_UNAVAILABLE', message: 'MiMo 服务暂时不可用，请稍后重试', retryable: true },
  504: { code: 'UPSTREAM_TIMEOUT', message: '上游服务响应超时，请稍后重试或缩短文本长度', retryable: true },
};

export const DIRECT_BASE_URL = 'https://api.xiaomimimo.com/v1';

function resolveBaseUrl(baseUrl?: string): string {
  return (baseUrl?.trim() || import.meta.env.VITE_MIMO_BASE_URL?.trim() || DIRECT_BASE_URL).replace(/\/+$/, '');
}

function throwApiError(status: number, rawMessage?: string): never {
  const mapped = STATUS_MAP[status];
  const body: ApiErrorBody = mapped
    ? { code: mapped.code, message: mapped.message, retryable: mapped.retryable }
    : status >= 500
      ? { code: 'UPSTREAM_ERROR', message: 'MiMo 服务端异常，请稍后重试', retryable: true }
      : { code: 'UPSTREAM_ERROR', message: rawMessage ? `调用失败：${rawMessage}` : '调用 MiMo 接口失败，请稍后重试', retryable: false };
  throw new RequestError(status, body);
}

/** 从上游错误响应中提取可读信息 */
function extractUpstreamMessage(text: string): string | undefined {
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } | string; message?: string; msg?: string };
    if (typeof parsed.error === 'string') return parsed.error;
    return parsed.error?.message ?? parsed.message ?? parsed.msg;
  } catch {
    return text.slice(0, 200);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function backoffDelay(attempt: number, retryAfter: string | null): number {
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 30_000);
  return Math.min(800 * 2 ** attempt + Math.random() * 400, 15_000);
}

interface ChatResponse {
  choices?: Array<{ message?: { audio?: { data?: string } | null; content?: string | null } }>;
  usage?: unknown;
  error?: { message?: string } | string;
}

/** 发起一次带超时与指数退避重试的请求 */
async function postJson<T>(url: string, body: unknown, apiKey: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // 官方 curl 示例使用 api-key；同时附带 Bearer 兼容标准 OpenAI 链路
          'api-key': apiKey,
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      window.clearTimeout(timer);

      const text = await response.text();
      if (!response.ok) {
        const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        if (retryable && attempt < RETRIES) {
          await sleep(backoffDelay(attempt, response.headers.get('retry-after')));
          continue;
        }
        throwApiError(response.status, extractUpstreamMessage(text));
      }

      try {
        return JSON.parse(text) as T;
      } catch {
        throw new RequestError(502, { code: 'BAD_RESPONSE', message: '无法解析 MiMo 返回的数据', retryable: true });
      }
    } catch (error) {
      window.clearTimeout(timer);
      lastError = error;
      if (error instanceof RequestError) throw error;

      const aborted = error instanceof Error && error.name === 'AbortError';
      if (attempt < RETRIES) {
        await sleep(backoffDelay(attempt, null));
        continue;
      }
      throw new RequestError(aborted ? 504 : 0, {
        code: aborted ? 'CLIENT_TIMEOUT' : 'NETWORK_ERROR',
        message: aborted
          ? '请求超时。语音合成耗时较长，若文本较长请开启「长文本自动分段」后重试'
          : '无法访问 MiMo 接口（可能是网络或跨域限制），请检查网络连接',
        retryable: true,
      });
    }
  }

  throw lastError instanceof RequestError
    ? lastError
    : new RequestError(502, { code: 'UPSTREAM_ERROR', message: '调用 MiMo 接口失败，请稍后重试', retryable: true });
}

/** 构造 messages：目标文本必须在 assistant，风格/音色描述在 user */
function buildMessages(payload: SynthesizePayload, text: string) {
  const instruction = payload.instruction?.trim() ?? '';
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  if (payload.mode === 'design') {
    if (!instruction) {
      throw new RequestError(400, {
        code: 'VOICE_DESCRIPTION_REQUIRED',
        message: '音色设计需要填写音色描述，例如「温柔知性的年轻女声，语速舒缓」',
        retryable: false,
      });
    }
    messages.push({ role: 'user', content: instruction });
  } else if (instruction) {
    messages.push({ role: 'user', content: instruction });
  }

  messages.push({ role: 'assistant', content: text });
  return messages;
}

/** 构造顶层的 audio 参数 */
function buildAudio(payload: SynthesizePayload, format: 'wav' | 'pcm16') {
  const audio: Record<string, unknown> = { format };

  if (payload.mode === 'preset') {
    const voice = payload.voice?.trim();
    if (!voice) {
      throw new RequestError(400, { code: 'VOICE_REQUIRED', message: '请选择一个预置音色', retryable: false });
    }
    if (!PRESET_VOICE_IDS.has(voice)) {
      throw new RequestError(400, { code: 'VOICE_REQUIRED', message: `预置音色「${voice}」不存在，请重新选择`, retryable: false });
    }
    audio.voice = voice;
  } else if (payload.mode === 'clone') {
    if (!payload.voice) {
      throw new RequestError(400, { code: 'SAMPLE_REQUIRED', message: '请先上传用于克隆的音频样本', retryable: false });
    }
    audio.voice = normalizeSample(payload.voice).dataUri;
  } else {
    audio.optimize_text_preview = payload.optimizeTextPreview ?? true;
  }

  return audio;
}

/** 校验并规范化克隆样本，返回标准 data URI */
export function normalizeSample(input: string): { dataUri: string; mimeType: string; bytes: number } {
  const value = input?.trim();
  if (!value) {
    throw new RequestError(400, { code: 'SAMPLE_REQUIRED', message: '请上传用于克隆的音频样本', retryable: false });
  }

  const match = /^data:([^;,]+);base64,(.+)$/s.exec(value);
  const mimeRaw = match?.[1]?.toLowerCase() ?? '';
  const base64 = (match?.[2] ?? value).replace(/\s/g, '');

  if (!base64) {
    throw new RequestError(400, { code: 'SAMPLE_REQUIRED', message: '音频样本内容为空，请重新上传', retryable: false });
  }

  const supported: Record<string, string> = { 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/wave': 'wav', 'audio/x-wav': 'wav' };
  if (mimeRaw && !(mimeRaw in supported)) {
    throw new RequestError(400, {
      code: 'SAMPLE_FORMAT_UNSUPPORTED',
      message: '音频样本仅支持 mp3 与 wav 格式',
      retryable: false,
    });
  }

  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  const bytes = Math.floor((base64.length * 3) / 4) - padding;

  if (bytes > MAX_SAMPLE_BYTES) {
    throw new RequestError(413, {
      code: 'SAMPLE_TOO_LARGE',
      message: `音频样本约 ${(bytes / 1024 / 1024).toFixed(1)}MB，超出 10MB 限制，请压缩或裁剪后重试`,
      retryable: false,
    });
  }
  if (bytes < 1024) {
    throw new RequestError(400, {
      code: 'SAMPLE_REQUIRED',
      message: '音频样本过短，建议上传 5～30 秒的清晰人声',
      retryable: false,
    });
  }

  return { dataUri: `data:${mimeRaw || 'audio/mpeg'};base64,${base64}`, mimeType: mimeRaw || 'audio/mpeg', bytes };
}

/** 按标点把长文本切成语义完整的片段 */
export function splitText(text: string, target = SEGMENT_TARGET): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= target) return [normalized];

  const sentences = normalized.match(/[^。！？!?.;；\n]+[。！？!?.;；\n]*/g) ?? [normalized];
  const chunks: string[] = [];
  let buffer = '';

  for (const sentence of sentences) {
    if ((buffer + sentence).length > target && buffer) {
      chunks.push(buffer.trim());
      buffer = '';
    }
    if (sentence.length > target) {
      for (let i = 0; i < sentence.length; i += target) {
        const piece = sentence.slice(i, i + target).trim();
        if (piece) chunks.push(piece);
      }
      continue;
    }
    buffer += sentence;
  }
  if (buffer.trim()) chunks.push(buffer.trim());
  return chunks.filter(Boolean);
}

/** 把首段的 (唱歌) / (风格) 标签继承到后续分段，避免风格丢失 */
function inheritAudioTags(fullText: string, chunk: string, index: number): string {
  if (index === 0) return chunk;
  const match = /^\s*[（(\[]([^）)\]]{1,60})[）)\]]/.exec(fullText);
  return match ? `(${match[1]})${chunk}` : chunk;
}

/** 为裸 PCM 数据补写 WAV 头（24kHz / 单声道 / 16bit） */
export function wrapWavBytes(pcm: Uint8Array, sampleRate = 24_000): Uint8Array {
  const output = new Uint8Array(44 + pcm.length);
  const view = new DataView(output.buffer);
  const writeString = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, pcm.length, true);
  output.set(pcm, 44);

  return output;
}

/** Uint8Array → base64（分块拼接，避免超长参数导致栈溢出） */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** 直连模式的合成入口 */
export async function synthesizeDirect(
  payload: SynthesizePayload,
  apiKey: string,
  baseUrl?: string,
): Promise<SynthesizeResponse> {
  if (!apiKey?.trim()) {
    throw new RequestError(401, {
      code: 'MISSING_API_KEY',
      message: '尚未配置 MiMo API Key，请在「设置」中填写你的密钥',
      retryable: false,
    });
  }

  const text = (payload.text ?? '').replace(/\r\n/g, '\n').trim();
  if (!text) {
    throw new RequestError(400, { code: 'TEXT_EMPTY', message: '请输入要合成的文本', retryable: false });
  }
  if (text.length > MAX_TEXT_LENGTH) {
    throw new RequestError(400, {
      code: 'TEXT_TOO_LONG',
      message: `文本长度 ${text.length} 字，超出单次上限 ${MAX_TEXT_LENGTH} 字`,
      retryable: false,
    });
  }

  const format = payload.format === 'pcm16' ? 'pcm16' : 'wav';
  const model = MODELS[payload.mode];
  const url = `${resolveBaseUrl(baseUrl)}/chat/completions`;
  const autoSegment = payload.autoSegment !== false;
  const chunks = autoSegment && text.length > SEGMENT_THRESHOLD ? splitText(text) : [text];

  if (chunks.length > MAX_SEGMENTS) {
    throw new RequestError(400, {
      code: 'TEXT_TOO_LONG',
      message: `文本将拆分为 ${chunks.length} 段，超过上限 ${MAX_SEGMENTS} 段，请缩短文本`,
      retryable: false,
    });
  }

  // 逐段合成，逐段返回，由前端决定堆叠展示、单独下载或打包导出
  const segments: AudioSegment[] = [];

  // 串行合成，避免并发触发官方限流
  for (let index = 0; index < chunks.length; index += 1) {
    const chunkText = chunks.length === 1 ? chunks[index] : inheritAudioTags(text, chunks[index], index);
    const response = await postJson<ChatResponse>(
      url,
      {
        model,
        messages: buildMessages(payload, chunkText),
        audio: buildAudio(payload, format),
        stream: false,
      },
      apiKey.trim(),
    );

    if (response.error) {
      const message = typeof response.error === 'string' ? response.error : response.error.message;
      throw new RequestError(502, {
        code: 'UPSTREAM_ERROR',
        message: message ? `MiMo 返回错误：${message}` : 'MiMo 返回了错误响应',
        retryable: true,
      });
    }

    const audioBase64 = response.choices?.[0]?.message?.audio?.data;
    if (!audioBase64) {
      throw new RequestError(502, {
        code: 'NO_AUDIO_IN_RESPONSE',
        message: 'MiMo 未返回音频数据，请稍后重试或调整文本内容',
        retryable: true,
      });
    }

    // pcm16 裸流补上 WAV 头，保证每段都能独立播放与下载
    const bytes = base64ToBytes(audioBase64);
    const finalBytes = format === 'pcm16' ? wrapWavBytes(bytes) : bytes;
    const headerBytes = finalBytes.length > 44 ? 44 : 0;

    segments.push({
      index,
      audio: bytesToBase64(finalBytes),
      bytes: finalBytes.length,
      durationSec: Number(((finalBytes.length - headerBytes) / 48_000).toFixed(1)),
      text: chunks[index],
    });
  }

  const totalBytes = segments.reduce((sum, segment) => sum + segment.bytes, 0);
  const totalDuration = Number(segments.reduce((sum, segment) => sum + segment.durationSec, 0).toFixed(1));

  return {
    segments,
    mimeType: 'audio/wav',
    format: 'wav',
    model,
    bytes: totalBytes,
    durationSec: totalDuration,
    segmented: segments.length > 1,
    segmentCount: segments.length,
    mode: payload.mode,
    text,
  };
}

/** 直连模式下的站点信息（无后端，静态构造） */
export function directHealth(): HealthInfo {
  return {
    status: 'healthy',
    env: 'static-direct',
    time: new Date().toISOString(),
    hasServerKey: false,
    baseUrl: resolveBaseUrl(),
    limits: { maxTextLength: MAX_TEXT_LENGTH, maxSampleBytes: MAX_SAMPLE_BYTES, synthsPerMinute: 0 },
  };
}

export function directPresets(): PresetVoice[] {
  return FALLBACK_PRESET_VOICES;
}

/** 直连模式下校验 API Key：发一次极短合成请求 */
export async function verifyKeyDirect(apiKey: string, baseUrl?: string): Promise<{ valid: boolean; message: string }> {
  try {
    const response = await postJson<ChatResponse>(
      `${resolveBaseUrl(baseUrl)}/chat/completions`,
      {
        model: MODELS.preset,
        messages: [{ role: 'assistant', content: '你好' }],
        audio: { format: 'wav', voice: 'mimo_default' },
        stream: false,
      },
      apiKey.trim(),
    );
    const ok = Boolean(response.choices?.[0]?.message?.audio?.data);
    return {
      valid: ok,
      message: ok ? 'API Key 校验通过，语音合成服务可用' : 'Key 可用，但未返回音频数据，请稍后重试',
    };
  } catch (error) {
    return { valid: false, message: error instanceof Error ? error.message : '校验失败' };
  }
}

/** 直连模式下本地校验样本（无服务端往返） */
export function validateSampleDirect(audio: string) {
  const sample = normalizeSample(audio);
  return { mimeType: sample.mimeType, bytes: sample.bytes, maxBytes: MAX_SAMPLE_BYTES, preview: sample.dataUri.slice(0, 64) };
}

import { config } from '../config/index.js';
import { AppError } from '../lib/errors.js';
import { postJson } from '../lib/http.js';
import { logger } from '../lib/logger.js';
import { base64Bytes, estimateDuration, parseAudioSample, pcm16ToWav } from './audio.js';

/**
 * MiMo-V2.5-TTS 系列模型。
 * 官方文档：https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/audio/speech-synthesis-v2.5
 */
export const TTS_MODELS = {
  /** 通用语音合成：使用预置精品音色，支持唱歌模式与低延迟流式 */
  preset: 'mimo-v2.5-tts',
  /** 音色设计：用自然语言描述定制音色，user 消息必填 */
  design: 'mimo-v2.5-tts-voicedesign',
  /** 声音克隆：基于音频样本复刻音色 */
  clone: 'mimo-v2.5-tts-voiceclone',
} as const;

export type TtsMode = keyof typeof TTS_MODELS;

/** 官方预置音色列表（仅 mimo-v2.5-tts 可用） */
export interface PresetVoice {
  id: string;
  label: string;
  language: '中文' | '英文' | '自适应';
  gender: '女声' | '男声' | '自适应';
  description: string;
}

export const PRESET_VOICES: PresetVoice[] = [
  { id: 'mimo_default', label: 'MiMo 默认', language: '自适应', gender: '自适应', description: '按部署集群自动选择默认音色（中国集群为「冰糖」）' },
  { id: '冰糖', label: '冰糖', language: '中文', gender: '女声', description: '清甜自然的女声，适合通用播报与对话' },
  { id: '茉莉', label: '茉莉', language: '中文', gender: '女声', description: '温柔知性的女声，适合叙述与讲解' },
  { id: '苏打', label: '苏打', language: '中文', gender: '男声', description: '清爽年轻化的男声，适合资讯播报' },
  { id: '白桦', label: '白桦', language: '中文', gender: '男声', description: '沉稳厚重的男声，适合纪录片与广告' },
  { id: 'Mia', label: 'Mia', language: '英文', gender: '女声', description: 'English female voice, bright and friendly' },
  { id: 'Chloe', label: 'Chloe', language: '英文', gender: '女声', description: 'English female voice, warm and expressive' },
  { id: 'Milo', label: 'Milo', language: '英文', gender: '男声', description: 'English male voice, clear and steady' },
  { id: 'Dean', label: 'Dean', language: '英文', gender: '男声', description: 'English male voice, deep and calm' },
];

export const PRESET_VOICE_IDS = new Set(PRESET_VOICES.map((v) => v.id));

export interface SynthesizeParams {
  mode: TtsMode;
  /** 待合成文本，写入 assistant 消息 */
  text: string;
  /** 风格指令，写入 user 消息（design 模式下为音色描述） */
  instruction?: string;
  /** 预置音色 ID（preset）或克隆样本 data URI（clone） */
  voice?: string;
  /** wav 返回完整波形；pcm16 返回 24kHz PCM16LE 裸流 */
  format?: 'wav' | 'pcm16';
  /** 仅 voicedesign：对播报文本做智能润色 */
  optimizeTextPreview?: boolean;
  /** 覆盖 API Key，未传则使用服务端配置 */
  apiKey?: string;
  /** 覆盖 Base URL，未传则使用服务端配置 */
  baseUrl?: string;
}

/** 单段合成结果 */
export interface SynthesizeSegment {
  /** 段序号，从 0 开始 */
  index: number;
  /** base64 音频（不含 data URI 前缀） */
  audioBase64: string;
  bytes: number;
  durationSec: number;
  /** 该段对应的文本，便于前端逐段展示与定位 */
  text: string;
}

export interface SynthesizeResult {
  /**
   * 分段音频数组。单段文本时长度为 1；长文本自动分段时逐段返回，
   * 由前端决定是逐段展示、单独下载，还是打包导出。
   */
  segments: SynthesizeSegment[];
  mimeType: string;
  format: 'wav' | 'pcm16';
  model: string;
  /** 所有分段合计字节数 */
  bytes: number;
  /** 所有分段合计时长（秒） */
  durationSec: number;
  /** 是否由长文本分段而来 */
  segmented: boolean;
  usage?: unknown;
}

/** MiMo Chat Completions 响应中与音频相关的字段 */
interface MimoChatResponse {
  choices?: Array<{
    message?: {
      audio?: { data?: string; format?: string } | null;
      content?: string | null;
    };
    finish_reason?: string;
  }>;
  usage?: unknown;
  error?: { message?: string; code?: string } | string;
  message?: string;
}

/** 单次请求允许的最大字符数，超出则自动分段 */
const SEGMENT_THRESHOLD = 600;
/** 分段后每段目标长度 */
const SEGMENT_TARGET = 320;
const MAX_SEGMENTS = 12;

/** 解析 API Key：优先使用请求传入的（BYOK），否则回落到服务端配置 */
export function resolveApiKey(userKey?: string): string {
  const key = userKey?.trim() || config.mimoApiKey;
  if (!key) {
    throw new AppError(
      401,
      'MISSING_API_KEY',
      '尚未配置 MiMo API Key，请在「设置」中填写你自己的密钥，或由站点管理员配置服务端密钥',
    );
  }
  return key;
}

export function resolveBaseUrl(userBaseUrl?: string): string {
  return (userBaseUrl?.trim() || config.mimoBaseUrl).replace(/\/+$/, '');
}

/** 规范化合成文本：补全音频标签所需的括号并校验长度 */
function normalizeText(text: string): string {
  const value = (text ?? '').replace(/\r\n/g, '\n').trim();
  if (!value) {
    throw new AppError(400, 'TEXT_EMPTY', '请输入要合成的文本');
  }
  if (value.length > config.maxTextLength) {
    throw new AppError(
      400,
      'TEXT_TOO_LONG',
      `文本长度 ${value.length} 字，超出单次上限 ${config.maxTextLength} 字，请缩短或关闭「长文本自动分段」`,
    );
  }
  return value;
}

/**
 * 构造 messages 数组。
 * 官方约定：待合成文本必须位于 assistant 消息；风格指令 / 音色描述位于 user 消息。
 */
function buildMessages(params: SynthesizeParams, text: string): Array<{ role: 'user' | 'assistant'; content: string }> {
  const instruction = params.instruction?.trim() ?? '';
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  if (params.mode === 'design') {
    if (!instruction) {
      throw new AppError(400, 'VOICE_DESCRIPTION_REQUIRED', '音色设计需要填写音色描述，例如「温柔知性的年轻女声，语速舒缓」');
    }
    // voicedesign 模式下 user 消息必填，内容即音色描述
    messages.push({ role: 'user', content: instruction });
  } else if (instruction) {
    // user 消息为可选：仅用于调整语气 / 风格，其内容不会出现在合成语音中
    messages.push({ role: 'user', content: instruction });
  }

  messages.push({ role: 'assistant', content: text });
  return messages;
}

/** 按模式校验必填参数，避免无效请求浪费上游额度 */
function validateModeParams(params: SynthesizeParams): void {
  if (params.mode === 'design') {
    if (!params.instruction?.trim()) {
      throw new AppError(400, 'VOICE_DESCRIPTION_REQUIRED', '音色设计需要填写音色描述，例如「温柔知性的年轻女声，语速舒缓」');
    }
    return;
  }
  if (params.mode === 'preset') {
    const voice = params.voice?.trim();
    if (!voice) {
      throw new AppError(400, 'VOICE_REQUIRED', '请选择一个预置音色');
    }
    if (!PRESET_VOICE_IDS.has(voice)) {
      throw new AppError(400, 'VOICE_REQUIRED', `预置音色「${voice}」不存在，请重新选择`);
    }
    return;
  }
  if (!params.voice) {
    throw new AppError(400, 'SAMPLE_REQUIRED', '请先上传用于克隆的音频样本');
  }
  // 提前校验样本格式与体积，避免大体积请求被上游拒绝
  parseAudioSample(params.voice);
}

/** 构造 audio 参数对象 */
function buildAudio(params: SynthesizeParams): Record<string, unknown> {
  const format = params.format ?? 'wav';
  const audio: Record<string, unknown> = { format };

  if (params.mode === 'preset') {
    const voice = params.voice?.trim();
    if (!voice) {
      throw new AppError(400, 'VOICE_REQUIRED', '请选择一个预置音色');
    }
    if (!PRESET_VOICE_IDS.has(voice)) {
      throw new AppError(400, 'VOICE_REQUIRED', `预置音色「${voice}」不存在，请重新选择`);
    }
    audio.voice = voice;
  } else if (params.mode === 'clone') {
    if (!params.voice) {
      throw new AppError(400, 'SAMPLE_REQUIRED', '请先上传用于克隆的音频样本');
    }
    // 官方要求 voice 为 data:{MIME_TYPE};base64,{BASE64_AUDIO}
    audio.voice = parseAudioSample(params.voice).dataUri;
  } else {
    // voicedesign 不传 voice，改用 optimize_text_preview 控制是否润色播报文本
    audio.optimize_text_preview = params.optimizeTextPreview ?? true;
  }

  return audio;
}

/** 调用一次 Chat Completions 并抽取 base64 音频 */
async function requestOnce(
  params: SynthesizeParams,
  text: string,
  apiKey: string,
  baseUrl: string,
): Promise<{ audioBase64: string; usage: unknown }> {
  const model = TTS_MODELS[params.mode];
  const payload = {
    model,
    messages: buildMessages(params, text),
    audio: buildAudio(params),
    stream: false,
  };

  const data = await postJson<MimoChatResponse>({
    url: `${baseUrl}/chat/completions`,
    method: 'POST',
    headers: {
      // 官方 curl 示例使用 api-key 头；同时附带 Bearer 以兼容标准 OpenAI SDK 链路
      'api-key': apiKey,
      Authorization: `Bearer ${apiKey}`,
    },
    body: payload,
    timeoutMs: config.upstreamTimeoutMs,
    retries: config.upstreamRetries,
    label: `mimo/${model}`,
  });

  if (data.error) {
    const message = typeof data.error === 'string' ? data.error : data.error.message;
    throw new AppError(502, 'UPSTREAM_ERROR', message ? `MiMo 返回错误：${message}` : 'MiMo 返回了错误响应', {
      retryable: true,
      details: data.error,
    });
  }

  const audioBase64 = data.choices?.[0]?.message?.audio?.data;
  if (!audioBase64) {
    const preview = (data.choices?.[0]?.message?.content ?? '').slice(0, 200);
    throw new AppError(502, 'NO_AUDIO_IN_RESPONSE', 'MiMo 未返回音频数据，请稍后重试或调整文本内容', {
      retryable: true,
      details: preview || data,
    });
  }

  return { audioBase64, usage: data.usage };
}

/**
 * 按标点把长文本切成若干语义完整的片段，避免超出单次推理能力。
 */
export function splitText(text: string, target = SEGMENT_TARGET): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= target) return [normalized];

  const sentences = normalized.match(/[^。！？!?\.;；\n]+[。！？!?\.;；\n]*/g) ?? [normalized];
  const chunks: string[] = [];
  let buffer = '';

  for (const sentence of sentences) {
    if ((buffer + sentence).length > target && buffer) {
      chunks.push(buffer.trim());
      buffer = '';
    }
    // 单句本身就超长时，按硬长度切分
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

export interface SynthesizeOptions {
  /** 是否对超长文本自动分段合成 */
  autoSegment?: boolean;
}

/**
 * 统一合成入口：按模式选择模型，必要时分段合成，返回可直接播放的音频。
 */
export async function synthesize(
  params: SynthesizeParams,
  options: SynthesizeOptions = {},
): Promise<SynthesizeResult> {
  const format = params.format ?? 'wav';
  const model = TTS_MODELS[params.mode];
  const startedAt = Date.now();

  // 先做参数校验，再检查密钥，让用户优先看到输入问题
  const rawText = normalizeText(params.text);
  validateModeParams(params);

  const apiKey = resolveApiKey(params.apiKey);
  const baseUrl = resolveBaseUrl(params.baseUrl);

  // 保持音频标签 (风格) / (唱歌) 仅作用于首段，避免重复触发
  const chunks =
    options.autoSegment !== false && rawText.length > SEGMENT_THRESHOLD ? splitText(rawText) : [rawText];

  if (chunks.length > MAX_SEGMENTS) {
    throw new AppError(
      400,
      'TEXT_TOO_LONG',
      `文本将拆分为 ${chunks.length} 段，超过上限 ${MAX_SEGMENTS} 段（约 ${MAX_SEGMENTS * SEGMENT_TARGET} 字），请缩短文本`,
    );
  }

  logger.info('开始合成', { mode: params.mode, model, chars: rawText.length, segments: chunks.length, format });

  // 串行合成，避免并发触发官方限流。
  // 每段独立成文件返回，由前端决定逐段展示、单独下载还是打包导出。
  const segments: SynthesizeSegment[] = [];
  let usage: unknown;

  for (let index = 0; index < chunks.length; index += 1) {
    const chunkText = chunks.length === 1 ? chunks[index] : inheritAudioTags(rawText, chunks[index], index);
    const { audioBase64, usage: chunkUsage } = await requestOnce(params, chunkText, apiKey, baseUrl);

    // pcm16 裸流补上 WAV 头，保证每段都能独立播放与下载
    const raw = Buffer.from(audioBase64, 'base64');
    const buffer: Buffer = format === 'pcm16' ? (pcm16ToWav(raw) as Buffer) : raw;
    // 标准 WAV 头部为 44 字节，计算时长时需扣除
    const headerBytes = buffer.length > 44 ? 44 : 0;

    segments.push({
      index,
      audioBase64: buffer.toString('base64'),
      bytes: buffer.length,
      durationSec: estimateDuration(buffer.length - headerBytes, 'wav'),
      text: chunks[index],
    });
    usage = chunkUsage ?? usage;
  }

  const totalBytes = segments.reduce((sum, segment) => sum + segment.bytes, 0);
  const totalDuration = Number(segments.reduce((sum, segment) => sum + segment.durationSec, 0).toFixed(1));

  const elapsed = Date.now() - startedAt;
  logger.info('合成完成', { model, segments: segments.length, bytes: totalBytes, elapsed });

  return {
    segments,
    mimeType: 'audio/wav',
    format,
    model,
    bytes: totalBytes,
    durationSec: totalDuration,
    segmented: segments.length > 1,
    usage,
  };
}

/** 把首段的音频标签（如 (唱歌) 或 (开心 兴奋)）继承到后续分段开头 */
function inheritAudioTags(fullText: string, chunk: string, index: number): string {
  if (index === 0) return chunk;
  const match = /^\s*[（(\[]([^）)\]]{1,60})[）)\]]/.exec(fullText);
  return match ? `(${match[1]})${chunk}` : chunk;
}

/** 为拼接后的裸 PCM 数据重新写入标准 WAV 头 */
function wrapWav(pcm: Buffer): Buffer {
  return pcm16ToWav(pcm) as Buffer;
}

/** 校验 API Key 是否可用：发送一次极短文本的最小合成请求 */
export async function verifyApiKey(apiKey: string, baseUrl?: string): Promise<{ ok: boolean; message: string }> {
  const url = resolveBaseUrl(baseUrl);
  try {
    await postJson<MimoChatResponse>({
      url: `${url}/chat/completions`,
      method: 'POST',
      headers: { 'api-key': apiKey, Authorization: `Bearer ${apiKey}` },
      body: {
        model: TTS_MODELS.preset,
        messages: [{ role: 'assistant', content: '你好' }],
        audio: { format: 'wav', voice: 'mimo_default' },
        stream: false,
      },
      timeoutMs: 45_000,
      retries: 0,
      label: 'mimo/verify-key',
    });
    return { ok: true, message: 'API Key 校验通过，语音合成服务可用' };
  } catch (error) {
    if (error instanceof AppError) {
      return { ok: false, message: error.message };
    }
    return { ok: false, message: '无法验证 API Key，请检查网络连接' };
  }
}

/** 供路由层复用的样本摘要信息 */
export function describeSample(dataUri: string) {
  const sample = parseAudioSample(dataUri);
  return {
    mimeType: sample.mimeType,
    bytes: sample.bytes,
    base64Bytes: base64Bytes(sample.dataUri.split(',')[1] ?? ''),
  };
}

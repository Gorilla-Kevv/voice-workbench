import { config } from '../config/index.js';
import { AppError } from '../lib/errors.js';

/** 支持的音频 MIME 类型与对应扩展名 */
export const SAMPLE_MIME_TYPES: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/wave': 'wav',
  'audio/x-wav': 'wav',
};

export interface ParsedSample {
  /** 规范化后的 data URI，可直接作为 MiMo 的 audio.voice 传入 */
  dataUri: string;
  mimeType: string;
  bytes: number;
}

/**
 * 校验并解析前端上传的音频样本。
 * 官方限制：mp3 / wav，Base64 后不超过 10MB。
 */
export function parseAudioSample(input: string): ParsedSample {
  const value = input?.trim();
  if (!value) {
    throw new AppError(400, 'SAMPLE_REQUIRED', '请上传用于克隆的音频样本');
  }

  const match = /^data:([^;,]+);base64,(.+)$/s.exec(value);
  const mimeRaw = match?.[1]?.toLowerCase() ?? '';
  const payload = (match?.[2] ?? value).replace(/\s/g, '');

  if (!payload) {
    throw new AppError(400, 'SAMPLE_REQUIRED', '音频样本内容为空，请重新上传');
  }

  const normalizedMime = mimeRaw in SAMPLE_MIME_TYPES ? mimeRaw : '';
  if (mimeRaw && !normalizedMime) {
    throw new AppError(400, 'SAMPLE_FORMAT_UNSUPPORTED', '音频样本仅支持 mp3 与 wav 格式');
  }

  const bytes = base64Bytes(payload);
  if (bytes > config.maxSampleBytes) {
    const mb = (bytes / 1024 / 1024).toFixed(1);
    throw new AppError(413, 'SAMPLE_TOO_LARGE', `音频样本约 ${mb}MB，超出 10MB 限制，请压缩或裁剪后重试`);
  }
  if (bytes < 1024) {
    throw new AppError(400, 'SAMPLE_REQUIRED', '音频样本过短，建议上传 5～30 秒的清晰人声');
  }

  const mimeType = normalizedMime || sniffMime(payload) || 'audio/mpeg';
  return {
    dataUri: `data:${mimeType};base64,${payload}`,
    mimeType,
    bytes,
  };
}

/** 依据 magic bytes 推断格式，兼容仅上传裸 base64 的场景 */
function sniffMime(base64: string): string | undefined {
  try {
    const head = Buffer.from(base64.slice(0, 16), 'base64');
    if (head.length >= 12 && head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WAVE') {
      return 'audio/wav';
    }
    if (head.length >= 3 && head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) return 'audio/mpeg';
    if (head.length >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0) return 'audio/mpeg';
    return undefined;
  } catch {
    return undefined;
  }
}

/** 计算 base64 字符串解码后的字节数（不实际解码，避免内存放大） */
export function base64Bytes(base64: string): number {
  const len = base64.length;
  if (len === 0) return 0;
  let padding = 0;
  if (base64.endsWith('==')) padding = 2;
  else if (base64.endsWith('=')) padding = 1;
  return Math.floor((len * 3) / 4) - padding;
}

/**
 * 把流式返回的 PCM16LE 裸数据封装为标准 WAV，便于前端直接播放与下载。
 */
export function pcm16ToWav(pcm: Buffer, sampleRate = 24_000, channels = 1): Buffer {
  const header = Buffer.alloc(44);
  const dataLength = pcm.length;
  const byteRate = sampleRate * channels * 2;
  const blockAlign = channels * 2;

  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataLength, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataLength, 40);

  return Buffer.concat([header, pcm]);
}

/** 估算音频时长（秒），用于历史记录展示 */
export function estimateDuration(bytes: number, format: string, sampleRate = 24_000): number {
  if (format === 'mp3') {
    // 128kbps 粗略估算
    return Number(((bytes * 8) / 128_000).toFixed(1));
  }
  return Number((bytes / (sampleRate * 2)).toFixed(1));
}

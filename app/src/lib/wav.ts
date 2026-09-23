/**
 * 浏览器录音与音频文件统一转码为 24kHz 单声道 WAV。
 * MiMo 声音克隆仅接受 mp3 / wav，且样本需小于 10MB，因此统一降采样以压缩体积。
 */

const TARGET_SAMPLE_RATE = 24_000;

/** 线性插值降采样 */
function downsample(buffer: Float32Array, sourceRate: number, targetRate: number): Float32Array {
  if (targetRate >= sourceRate) return buffer;
  const ratio = sourceRate / targetRate;
  const length = Math.floor(buffer.length / ratio);
  const result = new Float32Array(length);

  for (let i = 0; i < length; i += 1) {
    const position = i * ratio;
    const index = Math.floor(position);
    const fraction = position - index;
    const next = index + 1 < buffer.length ? buffer[index + 1] : buffer[index];
    result[i] = buffer[index] * (1 - fraction) + next * fraction;
  }
  return result;
}

/** 多声道混合为单声道 */
function toMono(channel: AudioBuffer): Float32Array {
  const { numberOfChannels, length } = channel;
  if (numberOfChannels === 1) return channel.getChannelData(0);

  const mixed = new Float32Array(length);
  for (let c = 0; c < numberOfChannels; c += 1) {
    const data = channel.getChannelData(c);
    for (let i = 0; i < length; i += 1) {
      mixed[i] += data[i] / numberOfChannels;
    }
  }
  return mixed;
}

/** Float32 PCM 编码为 16bit PCM WAV Blob */
export function encodeWav(samples: Float32Array, sampleRate = TARGET_SAMPLE_RATE): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  const writeString = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
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
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }

  return new Blob([view], { type: 'audio/wav' });
}

/** 把任意浏览器可解码的音频 Blob 转为 24kHz 单声道 WAV */
export async function convertToWav(blob: Blob): Promise<Blob> {
  const AudioCtor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtor) throw new Error('当前浏览器不支持音频处理，请改用 Chrome / Edge');

  const context = new AudioCtor();
  try {
    const arrayBuffer = await blob.arrayBuffer();
    const decoded = await context.decodeAudioData(arrayBuffer.slice(0));
    const mono = toMono(decoded);
    const resampled = downsample(mono, decoded.sampleRate, TARGET_SAMPLE_RATE);
    return encodeWav(resampled, TARGET_SAMPLE_RATE);
  } finally {
    void context.close().catch(() => undefined);
  }
}

/**
 * 峰值归一化，把音量提升到合理区间。
 * 浏览器录制的样本常偏小，归一化后克隆效果更稳定。
 */
export function normalizePeak(samples: Float32Array, targetPeak = 0.9, maxGain = 6): Float32Array {
  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const value = Math.abs(samples[i]);
    if (value > peak) peak = value;
  }
  if (peak === 0 || peak >= targetPeak) return samples;

  const gain = Math.min(targetPeak / peak, maxGain);
  const result = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    result[i] = Math.max(-1, Math.min(1, samples[i] * gain));
  }
  return result;
}

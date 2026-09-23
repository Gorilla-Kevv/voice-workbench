/** base64 字符串转 Blob，用于生成可播放的音频对象 */
export function base64ToBlob(base64: string, mimeType = 'audio/wav'): Blob {
  const binary = atob(base64);
  const length = binary.length;
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
}

/** File / Blob 转 data URI，用于上传克隆样本 */
export function blobToDataUri(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('读取音频文件失败，请重试'));
    reader.readAsDataURL(blob);
  });
}

/** 触发浏览器下载 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  // 延迟释放，避免部分浏览器下载被中断
  setTimeout(() => URL.revokeObjectURL(url), 2_000);
}

/** 秒数格式化为 m:ss */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

/** 字节数格式化 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 相对时间展示 */
export function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diff < minute) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`;
  return new Date(timestamp).toLocaleDateString('zh-CN');
}

/** 生成带时间戳的文件名前缀，如 mimo-preset-2026-09-22-10-30-00 */
function buildFilePrefix(text: string, mode: string): string {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const snippet = text.replace(/[\\/:*?"<>|\s]+/g, '').slice(0, 16) || 'audio';
  return `mimo-${mode}-${stamp}-${snippet}`;
}

/** 依据音频标签与样式生成音频文件名 */
export function buildAudioFilename(text: string, mode: string): string {
  return `${buildFilePrefix(text, mode)}.wav`;
}

/** 生成打包导出的 zip 文件名 */
export function buildZipFilename(text: string, mode: string): string {
  return `${buildFilePrefix(text, mode)}.zip`;
}

/**
 * 生成分段文件名，如 `01-第一段内容.wav`。
 * 序号按总段数补零，保证解压后仍按顺序排列。
 */
export function buildSegmentFilename(index: number, text: string, total: number): string {
  const seq = String(index + 1).padStart(String(total).length, '0');
  const snippet = text.replace(/[\\/:*?"<>|\s()[\]（）【】]+/g, '').slice(0, 24) || 'segment';
  return `${seq}-${snippet}.wav`;
}

/** 缓存元素与音频节点图的映射，避免重复 createMediaElementSource 抛错 */
const sourceCache = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>();
const contextCache = new WeakMap<HTMLMediaElement, AudioContext>();

/**
 * 为 <audio> 元素接入 Web Audio 增益链，缓解部分音频音量偏小的问题。
 * 浏览器不支持时静默降级为原生播放。
 */
export function ensureGainGraph(element: HTMLMediaElement, gainValue: number): GainNode | null {
  try {
    const AudioCtor =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtor) return null;

    let context = contextCache.get(element);
    if (!context) {
      context = new AudioCtor();
      contextCache.set(element, context);
    }

    let source = sourceCache.get(element);
    if (!source) {
      source = context.createMediaElementSource(element);
      const gain = context.createGain();
      gain.gain.value = gainValue;
      source.connect(gain);
      gain.connect(context.destination);
      return gain;
    }
    return null;
  } catch {
    return null;
  }
}

/** 恢复被浏览器自动挂起的音频上下文 */
export async function resumeAudioContext(element: HTMLMediaElement): Promise<void> {
  const context = contextCache.get(element);
  if (context?.state === 'suspended') {
    await context.resume().catch(() => undefined);
  }
}

/** 全局播放仲裁：同一时刻只允许一个音频播放 */
let activePlayback: { id: string; pause: () => void } | null = null;

export function claimPlayback(id: string, pause: () => void): void {
  if (activePlayback && activePlayback.id !== id) {
    activePlayback.pause();
  }
  activePlayback = { id, pause };
}

export function releasePlayback(id: string): void {
  if (activePlayback?.id === id) activePlayback = null;
}

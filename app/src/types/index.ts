/**
 * 应用级类型。
 *
 * 两套模型共用同一套 UI 契约：
 *  - MiMo（云端）：三种模式 preset / design / clone；
 *  - GPT-SoVITS（本地）：preset / clone，外加批量合成与训练。
 *
 * GPT-SoVITS 的专有契约在 `./sovits`，此处只做聚合。
 */

/** 语音变声板块（RVC）的契约类型 */
export * from './vc';

/** 歌声转换板块（DDSP-SVC）的契约类型 */
export * from './svc';

/** 语音转文本板块（ASR）的契约类型 */
export * from './asr';

/** 三种 MiMo 语音模型对应的功能模式 */
export type TtsMode = 'preset' | 'design' | 'clone';

/** 左侧导航项 */
export type NavKey =
  | 'synthesis'
  | 'batch'
  | 'design'
  | 'clone'
  | 'voices'
  | 'history'
  | 'training'
  | 'settings'
  /** 语音变声（RVC） */
  | 'rvc'
  /** 歌声转换（DDSP-SVC） */
  | 'svc'
  /** 语音转文本（ASR） */
  | 'asr';

/**
 * 本地模型服务的连接状态。
 *
 * 刻意区分「正在连接」与「未连接」：Python 服务冷启动要先 `import torch`
 * 再加载模型（30~90 秒），如果只用一个布尔值，这段时间会被误报成故障 ——
 * 而它其实只是还没起来。
 */
export type SovitsLinkState = 'checking' | 'ready' | 'offline';

/** GPT-SoVITS 本地服务的契约类型 */
export * from './sovits';

export type AudioFormat = 'wav' | 'pcm16';

/** 官方预置音色（仅 mimo-v2.5-tts 可用） */
export interface PresetVoice {
  id: string;
  label: string;
  language: string;
  gender: string;
  description: string;
}

/** 合成请求参数 */
export interface SynthesizePayload {
  mode: TtsMode;
  text: string;
  instruction?: string;
  /** preset 传音色 ID；clone 传样本 data URI */
  voice?: string;
  format?: AudioFormat;
  optimizeTextPreview?: boolean;
  autoSegment?: boolean;
  apiKey?: string;
  baseUrl?: string;
}

/** 合成接口返回的单段音频 */
export interface AudioSegment {
  /** 段序号，从 0 开始 */
  index: number;
  /** base64 音频（不含 data URI 前缀） */
  audio: string;
  bytes: number;
  durationSec: number;
  /** 该段对应文本 */
  text: string;
}

/** 合成接口返回 */
export interface SynthesizeResponse {
  /** 分段音频数组；单段文本时长度为 1，长文本按语义切分后逐段返回 */
  segments: AudioSegment[];
  mimeType: string;
  format: AudioFormat;
  model: string;
  /** 所有分段合计字节数 */
  bytes: number;
  /** 所有分段合计时长（秒） */
  durationSec: number;
  segmented: boolean;
  segmentCount: number;
  mode: TtsMode;
  /** 完整文本 */
  text: string;
}

/** 供渲染、播放与导出使用的分段（附 Blob 与临时播放地址） */
export interface RenderedSegment extends AudioSegment {
  blob: Blob;
  url: string;
}

/** 合成结果（含运行时音频对象） */
export interface SynthesisResult {
  id: string;
  mode: TtsMode;
  text: string;
  instruction?: string;
  /** 音色设计模式下的描述文本，便于复现 */
  voiceDescription?: string;
  /** 用于历史记录的展示名，如「冰糖 · 喜悦」 */
  voiceLabel: string;
  model: string;
  format: AudioFormat;
  bytes: number;
  durationSec: number;
  segmented: boolean;
  /** 分段数量，等价于 segments.length，便于直接展示 */
  segmentCount: number;
  createdAt: number;
  /** 逐段音频，按 index 升序 */
  segments: RenderedSegment[];
}

/** 历史记录元数据（音频以 Blob 存于 IndexedDB） */
export interface HistoryRecord {
  id: string;
  mode: TtsMode;
  text: string;
  instruction?: string;
  voiceLabel: string;
  model: string;
  format: AudioFormat;
  bytes: number;
  durationSec: number;
  /** 分段数量 */
  segmentCount: number;
  createdAt: number;
  /** 音色设计模式下保存描述，便于复现 */
  voiceDescription?: string;
}

/** 语音克隆样本 */
export interface VoiceSample {
  /** 规范化后的 data URI */
  dataUri: string;
  mimeType: string;
  bytes: number;
  /** 样本来源：文件上传或麦克风录制 */
  source: 'upload' | 'record';
  name: string;
  /** 运行时预览用 object URL */
  url: string;
}

/** 接口错误体 */
export interface ApiErrorBody {
  code: string;
  message: string;
  retryable?: boolean;
  retryAfterSec?: number;
  /** 本地服务给出的「下一步该做什么」 */
  hint?: string;
  details?: unknown;
}

export type ApiResponse<T> = { ok: true; data: T } | { ok: false; error: ApiErrorBody };

/** 网关汇总的 GPT-SoVITS 状态（由 Node 侧 `/api/health` 返回） */
export interface GatewaySovitsStatus {
  baseUrl: string;
  reachable: boolean;
  managed: boolean;
  installed: boolean;
  home: string | null;
  python: string | null;
  lastError: string | null;
}

/** 站点健康信息 */
export interface HealthInfo {
  status: string;
  env: string;
  time: string;
  hasServerKey: boolean;
  baseUrl: string;
  limits: {
    maxTextLength: number;
    maxSampleBytes: number;
    synthsPerMinute: number;
  };
  /** GPT-SoVITS 本地服务状态 */
  sovits?: GatewaySovitsStatus;
  providers?: {
    mimo: { available: boolean; requiresKey: boolean };
    'gpt-sovits': { available: boolean };
  };
}

/** 本地设置 */
export interface AppSettings {
  /** 当前使用的 Provider id，默认 mimo */
  providerId: string;
  /** Provider 自定义字段，如自托管服务地址 */
  providerFields: Record<string, Record<string, string>>;
  /** 用户自带的 API Key（BYOK），为空则使用服务端密钥 */
  apiKey: string;
  /** 自定义接口地址，为空则使用站点默认 */
  baseUrl: string;
  /** 长文本自动分段合成 */
  autoSegment: boolean;
  /** 音色设计模式下润色播报文本 */
  optimizeTextPreview: boolean;
  /** 生成后自动播放 */
  autoPlay: boolean;
  /** 播放增益（倍率），缓解部分音频音量偏小 */
  playbackGain: number;
  /** 历史记录容量上限 */
  historyLimit: number;
  /** 批量合成：文件名模板 */
  batchFilenameTemplate: string;
  /** 批量合成：是否打包为 ZIP */
  batchMakeZip: boolean;
}

/**
 * ASR 语音转文本板块的契约类型。
 *
 * 与 `trainer/app/asr/` 一一对应，改后端时对照修改：
 *  - `asr/catalog.py`  → AsrCatalog / AsrBackendInfo / AsrResidentModel / AsrPreset
 *  - `asr/pipeline.py` → AsrResolved / AsrTranscribeResult / AsrPipelineStatus
 *  - `asr/training.py` → AsrDatasetRequest / AsrDatasetPlan / AsrDatasetSummary
 *  - `asr/bootstrap.py`→ AsrDiagnostics（两条通道的体检结果）
 *
 * 「两条通道」是本板块唯一需要前端理解的概念：
 * `resident` 表示模型常驻在服务进程里（单条秒级），
 * `script` 表示每次按需起官方脚本（慢一些，但只要有整合包就一定能跑）。
 * 所以 `channel` 与 `reason` 会一路带到界面上 —— 用户有权知道
 * 自己这一条到底是走的哪条路，而不是看日志猜。
 */

/** 转写通道 */
export type AsrChannel = 'resident' | 'script';

/** 常驻通道下可选的一个模型标识 */
export interface AsrResidentModel {
  key: string;
  id: string;
  label: string;
  languages: string[];
  hint: string;
}

/** 一个 ASR 后端（FunASR / faster-whisper）的能力 */
export interface AsrBackendInfo {
  id: string;
  label: string;
  /** 官方脚本的尺寸语义：tiny ~ large */
  sizes: string[];
  languages: string[];
  precisions: string[];
  /** 官方标注 -p「尚未接入」的后端，精度改了也不生效 */
  precision_effective: boolean;
  needs_gpu: boolean;
  resident_modules: string;
  resident_models: AsrResidentModel[];
}

/** 场景预设：一键转写用 reference */
export interface AsrPreset {
  key: string;
  label: string;
  backend: string;
  size: string;
  language: string;
  precision: string;
  hint: string;
}

/** 一条通道的可用性 */
export interface AsrChannelSupport {
  available: boolean;
  module: string;
  error: string;
}

/** 单个后端的两条通道体检 */
export interface AsrBackendDiagnostic {
  id: string;
  channel: AsrChannel | 'none';
  resident: AsrChannelSupport;
  script: { available: boolean; path: string; error: string };
}

/** `GET /v1/asr/catalog` 的响应 */
export interface AsrCatalog {
  ok: boolean;
  backends: AsrBackendInfo[];
  presets: AsrPreset[];
  language_labels: Record<string, string>;
  defaults: { backend: string; size: string; language: string; precision: string };
  diagnostics: AsrDiagnostics;
  engine: AsrPipelineStatus;
}

export interface AsrDiagnostics {
  /** GPT-SoVITS 整合包位置（脚本通道靠它） */
  installation: string | null;
  /** 产物根目录 */
  session_dir: string;
  backends: AsrBackendDiagnostic[];
  datasets: AsrDatasetSummary[];
}

export interface AsrCacheStats {
  count: number;
  bytes: number;
}

/** `GET /v1/asr/pipeline` 与引擎状态 */
export interface AsrPipelineStatus {
  ok?: boolean;
  /** 常驻通道是否持有模型；脚本通道恒为 false（每次按需起进程） */
  loaded: boolean;
  backend: string | null;
  size: string | null;
  language: string | null;
  precision: string | null;
  model: string | null;
  channel: AsrChannel | null;
  reason: string;
  device: string | null;
  held_s: number;
  cache: AsrCacheStats;
  session_dir: string;
  message?: string;
}

/** 参数归一后的「实际会怎么跑」 */
export interface AsrResolved {
  backend: string;
  size: string;
  language: string;
  precision: string;
  model: string;
  channel: AsrChannel;
  reason: string;
  /** 被纠正过的参数说明，界面要显示出来 */
  notes: string[];
}

export interface AsrSegment {
  start: number;
  end: number;
  text: string;
}

/** `POST /v1/asr/transcribe` 的响应 */
export interface AsrTranscribeResult extends AsrResolved {
  ok: boolean;
  text: string;
  segments: AsrSegment[];
  /** 音频时长（秒） */
  duration: number;
  /** 本次耗时（秒） */
  elapsed_s: number;
  cached: boolean;
  source: string;
  cache_key: string;
  /** 未识别到文本时的提示（不是错误，但用户需要知道） */
  warning?: string;
}

export interface AsrTranscribePayload {
  file?: File;
  /** 本机路径；与 file 二选一 */
  source?: string;
  backend?: string;
  size?: string;
  language?: string;
  precision?: string;
  model?: string;
  channel?: string;
  use_cache?: boolean;
}

/** 训练入口（数据集构建）的请求 */
export interface AsrDatasetRequest {
  name: string;
  corpus_dir?: string;
  files?: string[];
  recursive?: boolean;
  speaker?: string;
  backend?: string;
  size?: string;
  language?: string;
  precision?: string;
  channel?: string;
  min_duration?: number;
  max_duration?: number;
  skip_existing?: boolean;
  use_cache?: boolean;
  keep_empty?: boolean;
  limit?: number;
}

export interface AsrDatasetStage {
  key: string;
  label: string;
  detail: string;
  command: string;
}

/** `POST /v1/asr/train/plan` 的响应 */
export interface AsrDatasetPlan {
  ok: boolean;
  dataset_dir: string;
  request: Record<string, unknown>;
  engine: AsrResolved;
  stages: AsrDatasetStage[];
  totals: { found: number; accepted: number; rejected: number; truncated: number };
  rejected_samples: string[];
  error: string;
}

/** 数据集里的一条记录（任务结果的一部分） */
export interface AsrDatasetItem {
  index: number;
  audio: string;
  speaker: string;
  language: string;
  text: string;
  text_path: string;
  ok: boolean;
  error: string;
  /** 空文本时的说明。它不是错误 —— 纯静音、纯音乐、语种不符都会得到空串 */
  note?: string;
  hint?: string;
  cached: boolean;
  channel: string;
  elapsed_s: number;
}

/** `GET /v1/asr/datasets` 里的一项 */
export interface AsrDatasetSummary {
  name: string;
  dir: string;
  exists: boolean;
  created_at?: number;
  total?: number;
  succeeded?: number;
  empty?: number;
  failed?: number;
  backend?: string;
  model?: string;
  channel?: string;
  /** 官方格式清单路径，可直接喂给训练流水线 */
  list?: string;
  csv?: string;
}

export interface AsrDatasetSubmitResponse {
  ok: boolean;
  job_id: string;
  message: string;
}

export interface AsrUploadResponse {
  ok: boolean;
  files: string[];
  skipped: { name: string; reason: string }[];
  dir: string;
}

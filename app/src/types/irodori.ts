/**
 * Irodori-TTS 客户端契约（irodori/，第四个 Python 运行时）。
 *
 * 与 `irodori/app/api.py` 的返回一一对应 —— 改一边必改另一边
 * （与网易 / IndexTTS 契约同一规矩）。
 *
 * 注意「服务端是真源」的三处：
 * - 步数档位、emoji 表、caption 预设 → 一律读 `/v1/catalog`，前端不抄常量；
 * - 显存准入基准 `required_vram_mb` → 读 `/health.configuration`，前端只留兜底；
 * - 护栏参数 `timeout_sec` / `downgrade_steps` → 读 catalog 的 `guard`，
 *   「重试（降步）」按钮要按服务端给的值发请求，别写死 20。
 */

export interface IrodoriVram {
  free_mb: number | null;
  total_mb: number | null;
  torch_free_mb?: number | null;
  /** nvidia-smi 或 torch 口径（服务端优先 nvidia-smi） */
  source?: string;
}

export interface IrodoriWeights {
  /** 推理档权重是否齐备（缺了服务能起但合成会失败） */
  ready: boolean;
  /** 训练档（bf16 基座）是否齐备，30-5/30-6 才用得上 */
  training_ready: boolean;
  groups: Record<string, unknown>;
  missing: string[];
  truncated: string[];
  missing_code: string[];
}

export interface IrodoriWindecode {
  /** Windows 音频解码垫片是否已装（未装则 torchaudio.load 会 ImportError） */
  installed: boolean;
  patched: string[];
}

export interface IrodoriConfiguration {
  upstream_dir: string;
  models_dir: string;
  precision: string;
  default_steps: number;
  step_presets: number[];
  /** 整条合成的墙钟预算（秒），30-3 长尾护栏的第二层 */
  timeout_sec: number;
  /** 护栏降步档位：撞长尾时剩余段落降到这个步数 */
  downgrade_steps: number;
  max_ref_seconds: number;
  device: string;
  allow_cpu: boolean;
  data_dir: string;
  /** 显存准入基准（MB），服务端真源 */
  required_vram_mb: number;
  compute_capability: [number, number] | null;
  gpu_name: string | null;
  /** int4 走 torchao tinygemm，cc ≥ 8.0 才可用 */
  int4_supported: boolean | null;
  manifest_path: string;
  manifest_entries: number;
}

export interface IrodoriHealth {
  ok: boolean;
  service: string;
  version: string;
  python: string;
  torch: string | null;
  cuda: boolean;
  device: string | null;
  /** 服务自身进程号（网关用它确证端口归属） */
  pid: number;
  vram: IrodoriVram;
  /** 模型是否常驻显存（懒加载，warmup 前是 false） */
  loaded: boolean;
  /** 我们刻意不装 SilentCipher：界面要如实显示「未加水印」 */
  watermark: boolean;
  weights: IrodoriWeights;
  windecode: IrodoriWindecode;
  configuration: IrodoriConfiguration;
}

export interface IrodoriEmojiItem {
  emoji: string;
  /** 官方日文释义的短标签（可能为空） */
  label: string;
  description: string;
}

export interface IrodoriStepPreset {
  value: number;
  label: string;
  note: string;
}

export interface IrodoriCatalog {
  ok: boolean;
  service: string;
  language: { supported: string[]; note: string };
  emoji: { items: IrodoriEmojiItem[]; count: number; note: string };
  caption: {
    max_chars: number;
    note: string;
    presets: Array<{ id: string; text: string }>;
  };
  steps: {
    default: number;
    presets: IrodoriStepPreset[];
    range: [number, number];
    schedules: Array<{ value: string; label: string }>;
  };
  duration_scale: { min: number; max: number; default: number; note: string };
  reference: { max_ref_seconds: number; min_ref_seconds: number; note: string };
  seed: { note: string };
  /** 30-3 长尾护栏参数（真源在服务端） */
  guard: {
    timeout_sec: number;
    downgrade_steps: number;
    note: string;
  };
  watermark: boolean;
}

export interface IrodoriSpeaker {
  id: string;
  path: string;
  size_bytes: number;
  updated_at: number;
}

export interface IrodoriSynthPayload {
  text: string;
  /** 只描述情绪/环境/语域，不要描述音色 */
  caption?: string;
  num_steps?: number;
  schedule?: 'linear' | 'sway';
  seed?: number;
  duration_scale?: number;
  /** 音色库 id（三选一） */
  ref_voice?: string;
  /** 磁盘路径（三选一） */
  ref_path?: string;
  /** 固化音色 id（三选一，与参考音频互斥） */
  speaker_id?: string;
}

export interface IrodoriSynthResult {
  ok: boolean;
  audio_base64: string;
  sample_rate: number;
  duration_sec: number;
  elapsed_sec: number;
  rtf: number | null;
  used_seed: number;
  /** 请求要的步数 */
  steps_requested: number;
  /** 实际用的步数（被护栏降过就小于 requested） */
  steps_used: number;
  /** 护栏是否介入过（撞长尾 → 剩余段落降步 + 换 seed） */
  retried: boolean;
  /** 从第几段开始降步（null = 没降） */
  downgraded_at_segment: number | null;
  timeout_sec: number;
  segments: number;
  voice_id: string | null;
  voice_name: string | null;
  speaker_id: string | null;
  caption: string | null;
  schedule: string;
  duration_scale: number;
}

// ---------------------------------------------------------------------------
// 训练侧契约（30-5 数据整备 / 30-6 SI 训练）
//
// 与 `irodori/app/routers/train.py`、`irodori/app/jobs.py` 一一对应。
// 规矩同合成侧：**服务端是真源** —— 步数档位、batch 推荐、emoji 表都从
// `/v1/catalog` 与 `/v1/train/plan` 读，前端不抄常量。
// ---------------------------------------------------------------------------

export type IrodoriPlanState = 'ready' | 'blocked' | 'todo';

export interface IrodoriTrainPlanStep {
  key: 's1' | 's2' | 's3';
  label: string;
  state: IrodoriPlanState;
  detail: string;
}

export interface IrodoriDataItem {
  path: string;
  text: string;
  caption?: string | null;
  duration_s?: number | null;
}

export interface IrodoriTrainPlanData {
  count: number;
  scanned: number;
  total_seconds: number;
  missing_text: Array<{ path: string; reason: string }>;
  /** 最多回显 20 条，够看一眼「认对了没有」 */
  items: IrodoriDataItem[];
}

/** `/v1/train/plan` 回显的训练段参数（batch 推荐是真算出来的，不要前端自己估） */
export interface IrodoriTrainingSection {
  smoke_steps: number;
  max_batch: number;
  seconds_per_step: number;
  batch: {
    batch: number;
    source: string;
    note?: string;
    auto?: boolean;
    max?: number;
    estimated_net_mb?: number | null;
  };
  s3_ready: boolean;
  auto_batch?: {
    probe_batch: number;
    probe_steps: number;
    headroom: number;
    note: string;
  };
  train_max_hours?: number;
}

export interface IrodoriTrainPlan {
  ok: boolean;
  service: string;
  steps: IrodoriTrainPlanStep[];
  data: IrodoriTrainPlanData;
  warnings: string[];
  ready_to_prepare: boolean;
  training: IrodoriTrainingSection;
}

/** `/v1/train/datasets` 的条目（meta.json 读不出来时只有 dataset_id + written） */
export interface IrodoriDataset {
  dataset_id: string;
  manifest_path: string;
  written?: number;
  total_seconds?: number;
  created_at?: number;
  latent_dim?: number;
  sample_rate?: number;
}

export interface IrodoriJobStage {
  key: string;
  label: string;
  /** queued / running / succeeded / failed / cancelled */
  state: string;
  detail: string | null;
  started_at: number | null;
  finished_at: number | null;
}

export interface IrodoriJobLog {
  ts: number;
  level: 'info' | 'warn' | 'error';
  text: string;
}

export type IrodoriJobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface IrodoriJob {
  id: string;
  kind: 'prepare' | 'train' | string;
  name: string;
  state: IrodoriJobState;
  progress: number;
  message: string;
  error: string | null;
  stages: IrodoriJobStage[];
  /** 服务端只保留最近 400 行 */
  logs: IrodoriJobLog[];
  artifacts: Record<string, unknown>;
  request: Record<string, unknown>;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  elapsed_ms?: number;
}

/** `/v1/train` 成功后的产物（artifacts 里我们真正要读的三块） */
export interface IrodoriTrainSpeaker {
  speaker_id: string;
  path: string;
  size_bytes: number;
  embedding_shape: number[] | null;
  steps: number;
  batch: number;
  dataset_id: string;
  last_loss: number | null;
  elapsed_sec: number;
}

export interface IrodoriTrainArtifacts {
  dataset_id?: string;
  steps?: number;
  batch?: { batch: number; source: string; note?: string } | number;
  speaker?: IrodoriTrainSpeaker;
  checkpoints?: { final_path: string | null; periodic: Array<{ step: number; path: string }> };
  registered?: { voice_id: string; voice_name: string; speaker_embeds_count: number } | null;
  hint?: string;
}

export interface IrodoriUploadResult {
  ok: boolean;
  dataset_id: string;
  saved: Array<{ name: string; size: number; kind: string }>;
  skipped: Array<{ name: string; reason: string }>;
  directory?: string;
}

/**
 * `/v1/train/plan` 的请求体。
 *
 * 三个来源**互斥**（SI 训练必须是同一个说话人，给多个服务端会报 `TRAIN_MULTI_SOURCE`），
 * 所以这里刻意写成三个可选字段 + 注释，而不是「三选一的联合类型」——
 * 后者在 UI 里反而不好表达「清空其中一个」。
 */
export interface IrodoriTrainPlanPayload {
  /** 音色库音色（优先取长参考 ref_clips，为空回落到主音频 + prompt_text） */
  voice_id?: string;
  /** 已上传目录的 dataset_id（配同名 .txt 或 metadata.jsonl） */
  dataset_id?: string;
  /** 显式列表（绝对路径 + 转写） */
  items?: Array<{ path: string; text: string; caption?: string }>;
  /** 训练产物登记时用的说话人名（默认取音色名） */
  speaker_id?: string;
  /** 统一给这批样本加一句风格描述 */
  caption?: string;
  steps?: number;
}

/** `POST /v1/train` 的请求体：dataset_id 必填，其余交给服务端默认值 */
export interface IrodoriTrainPayload {
  dataset_id: string;
  /** 步数；不给用服务端的 smoke_steps */
  steps?: number;
  /** 给具体值 = 跳过自动 batch 探测（显存紧张时手动降档用） */
  batch?: number;
  name?: string;
  /** 产物文件名（默认 `<dataset_id>-<steps>`） */
  speaker_id?: string;
  /** 训练完登记到音色库的哪条音色；不填则只落到 /v1/speakers */
  voice_id?: string;
  seed?: number;
  save_every?: number;
}

export interface IrodoriAutoBatchResult {
  ok: boolean;
  probed: boolean;
  batch: {
    batch: number;
    source: string;
    note: string;
    peak_used_mb?: number | null;
    free_mb?: number | null;
    estimated_net_mb?: number | null;
  };
}

/** `IRODORI_TIMEOUT`(504) 的 `error.details` 形状 */
export interface IrodoriTimeoutDetails {
  timeout_sec: number;
  steps: number | null;
  segments_done: number;
  segments_total: number;
  downgraded: boolean;
  /** 给「重试（降步）」按钮用：按服务端建议的步数重发 */
  retry_suggestion: { num_steps: number };
}

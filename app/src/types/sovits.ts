/**
 * GPT-SoVITS 本地服务的契约类型。
 *
 * 与 `trainer/app/models.py`、`trainer/app/sovits/catalog.py` 一一对应。
 * 服务端新增字段一律向后兼容，因此这里对「额外字段」保持宽容
 * （很多对象带 `[key: string]: unknown` 索引签名），避免服务端升级后
 * 前端因为类型收窄而崩掉。
 */

// --------------------------------------------------------------------------
// 基础
// --------------------------------------------------------------------------

export type SovitsMode = 'preset' | 'clone' | 'design';

export type SovitsJobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface SovitsErrorBody {
  code: string;
  message: string;
  retryable?: boolean;
  /** 服务端给出的「下一步该做什么」 */
  hint?: string;
  retry_after_s?: number;
  details?: unknown;
  [key: string]: unknown;
}

// --------------------------------------------------------------------------
// 能力清单
// --------------------------------------------------------------------------

export interface SovitsCatalogEntry {
  id: string;
  label: string;
  note?: string;
}

export interface SovitsAsrBackend {
  id: string;
  label: string;
  script: string;
  sizes: string[];
  languages: string[];
  /**
   * 该后端允许的精度取值。
   * 取自官方 `tools/asr/config.py::asr_dict` —— FunASR 只有 float32，
   * faster-whisper 才有 float16 / int8。
   */
  precisions: string[];
  /** 该脚本的 -p 参数是否真的生效（FunASR 官方注明「还没接入」） */
  precision_effective: boolean;
  needs_gpu: boolean;
}

export interface SovitsSliceDefaults {
  threshold: number;
  min_length: number;
  min_interval: number;
  hop_size: number;
  max_sil_kept: number;
  max: number;
  alpha: number;
  n_parts: number;
}

/** 合成参数默认值，与官方 `api_v2.py` 的 `TTS_Request` 对齐 */
export interface SovitsSynthDefaults {
  text_split_method: string;
  top_k: number;
  top_p: number;
  temperature: number;
  repetition_penalty: number;
  batch_size: number;
  batch_threshold: number;
  split_bucket: boolean;
  speed_factor: number;
  fragment_interval: number;
  seed: number;
  parallel_infer: boolean;
  sample_steps: number;
  super_sampling: boolean;
  streaming_mode: boolean;
  overlap_length: number;
  min_chunk_length: number;
}

export interface SovitsCatalog {
  versions: SovitsCatalogEntry[];
  default_version: string;
  languages: SovitsCatalogEntry[];
  language_notes: Record<string, string>;
  text_split_methods: SovitsCatalogEntry[];
  train_languages: string[];
  asr_backends: SovitsAsrBackend[];
  slice_defaults: SovitsSliceDefaults;
  synth_defaults: SovitsSynthDefaults;
  ref_audio: { min_sec: number; max_sec: number; note: string };
  limits: { max_text_length: number; max_batch_items: number };
}

// --------------------------------------------------------------------------
// 健康与运行环境
// --------------------------------------------------------------------------

export interface SovitsRuntime {
  executable: string;
  python_version: string;
  torch_version: string | null;
  cuda_version: string | null;
  device_count: number;
  device_names: string[];
  device_label: string;
  vram_total_mb: number | null;
  vram_free_mb: number | null;
  libs: Record<string, string | null>;
  missing_libs: string[];
  missing_train_libs: string[];
  has_torch: boolean;
  has_gpu: boolean;
  can_infer: boolean;
  torch_error: string | null;
  probe_ok: boolean;
  probe_error: string | null;
  source: string;
}

export interface SovitsLayout {
  home: string;
  core_dir: string;
  found: boolean;
  entries: Record<string, string>;
  tools: Record<string, string>;
  python_executable: string | null;
  variant: string;
  can_infer: boolean;
  can_train: boolean;
  can_prepare: boolean;
  missing: string[];
  supported_versions: string[];
  text_split_methods: string[];
  pretrained_count: number;
}

export interface SovitsEnvironment {
  home: string | null;
  found: boolean;
  python_executable: string | null;
  modules_loaded: boolean;
  load_error: string | null;
  details: SovitsLayout | null;
}

export interface SovitsPipeline {
  loaded: boolean;
  loading: boolean;
  device: string;
  is_half: boolean;
  version: string;
  gpt: string | null;
  sovits: string | null;
  load_seconds: number;
  loaded_at: number;
  synth_count: number;
  total_audio_seconds: number;
  last_error: string | null;
  last_error_at: number;
  warmup_error: string | null;
  target_version: string;
  target_device: string;
  target_is_half: boolean;
  streaming_supported: boolean;
  languages: string[];
  /** 训练是否正在独占显卡（期间合成会被拒绝并给出等待提示） */
  training_active: boolean;
}

export interface SovitsPool {
  concurrency: number;
  running: number;
  queued: number;
  max_queue: number;
  ready: boolean;
}

export interface SovitsHealth {
  ok: boolean;
  schema_version: string;
  version: string;
  mode: string;
  uptime_s: number;
  ready: boolean;
  settings: Record<string, unknown>;
  environment: SovitsEnvironment;
  runtime: SovitsRuntime;
  pipeline: SovitsPipeline;
  scheduler: { mode?: string; infer: SovitsPool; train: SovitsPool; vram_free_mb: number | null };
  capabilities: {
    inference: boolean;
    training: boolean;
    batch: boolean;
    streaming: boolean;
    voice_library: boolean;
    text_split_preview: boolean;
    dry_run: boolean;
  };
  voices: { total: number; usable: number };
  blockers: string[];
  warnings: string[];
  hints: string[];
}

// --------------------------------------------------------------------------
// 音色库
// --------------------------------------------------------------------------

export interface SovitsVoice {
  id: string;
  name: string;
  audio_path: string;
  prompt_text: string;
  prompt_lang: string;
  note: string;
  tags: string[];
  /** managed：由本服务托管文件；external：引用磁盘上已有文件 */
  origin: 'managed' | 'external' | string;
  duration_s: number | null;
  sample_rate: number | null;
  size_bytes: number;
  created_at: number;
  updated_at: number;
  exists: boolean;
  /** 会导致合成失败的前置问题（缺文本、时长越界、文件丢失…） */
  warnings: string[];
}

export interface SovitsVoiceDraft {
  name: string;
  prompt_text: string;
  prompt_lang: string;
  note?: string;
  tags?: string[];
}

// --------------------------------------------------------------------------
// 权重
// --------------------------------------------------------------------------

export interface SovitsWeight {
  path: string;
  relative: string;
  version: string;
  kind: 'gpt' | 'sovits' | string;
  name: string;
  size_mb: number;
  mtime: number;
  trained: boolean;
}

export interface SovitsWeightList {
  ok: boolean;
  version: string;
  gpt: SovitsWeight[];
  sovits: SovitsWeight[];
  active: { gpt: string | null; sovits: string | null; loaded: boolean; device: string; is_half: boolean };
  default: {
    gpt: string;
    sovits: string;
    gpt_name: string;
    sovits_name: string;
    version: string;
    gpt_source: string;
    sovits_source: string;
  } | null;
  pretrained: { gpt: string | null; sovits: string | null; available: boolean };
  warning?: string;
}

// --------------------------------------------------------------------------
// 合成
// --------------------------------------------------------------------------

export interface SovitsTTSRequest {
  mode?: SovitsMode;
  text: string;
  voice?: string;
  ref_audio_path?: string;
  prompt_text?: string;
  prompt_lang?: string;
  text_lang?: string;
  aux_ref_audio_paths?: string[];
  version?: string;
  gpt?: string;
  sovits?: string;
  device?: string;
  is_half?: boolean;
  inline_base64?: boolean;
  params?: Partial<SovitsSynthDefaults> & Record<string, unknown>;
  [key: string]: unknown;
}

export interface SovitsTTSResponse {
  ok: boolean;
  audio_url: string | null;
  audio?: string;
  mime_type: string;
  bytes: number;
  duration_s: number;
  sample_rate: number;
  text: string;
  text_lang: string;
  mode: string;
  version: string;
  gpt_model: string | null;
  sovits_model: string | null;
  voice_id: string | null;
  voice_name: string | null;
  elapsed_ms: number;
  warning?: string | null;
}

export interface SovitsBatchItem {
  text: string;
  key?: string;
  voice?: string;
  text_lang?: string;
  prompt_text?: string;
  params?: Record<string, unknown>;
}

export interface SovitsBatchRequest {
  items?: SovitsBatchItem[];
  /** 整段文本：按非空行切分为条目 */
  text?: string;
  voice?: string;
  ref_audio_path?: string;
  prompt_text?: string;
  prompt_lang?: string;
  text_lang?: string;
  aux_ref_audio_paths?: string[];
  version?: string;
  gpt?: string;
  sovits?: string;
  device?: string;
  is_half?: boolean;
  params?: Record<string, unknown>;
  filename_template?: string;
  make_zip?: boolean;
  continue_on_error?: boolean;
  wait?: boolean;
}

export interface SovitsBatchItemResult {
  index: number;
  key: string | null;
  text: string;
  ok: boolean;
  filename: string | null;
  audio_url: string | null;
  bytes: number;
  duration_s: number;
  elapsed_ms: number;
  error: string | null;
  hint: string | null;
}

export interface SovitsBatchResponse {
  ok: boolean;
  job_id?: string;
  state: string;
  total?: number;
  succeeded?: number;
  failed?: number;
  cancelled?: boolean;
  total_duration_s?: number;
  elapsed_ms?: number;
  results?: SovitsBatchItemResult[];
  zip_url?: string | null;
  manifest_url?: string | null;
  message?: string;
}

export interface SovitsSplitSegment {
  index: number;
  text: string;
  chars: number;
}

export interface SovitsSplitResponse {
  ok: boolean;
  segments: SovitsSplitSegment[];
  total: number;
  chars: number;
}

// --------------------------------------------------------------------------
// 任务
// --------------------------------------------------------------------------

export interface SovitsJobStage {
  key: string;
  label: string;
  state: SovitsJobState;
  detail: string;
  started_at: number | null;
  finished_at: number | null;
}

export interface SovitsLogLine {
  ts: number;
  level: string;
  text: string;
}

export interface SovitsJob {
  id: string;
  /** 本地服务的四种任务：推理 / 训练 / 分离，以及两个新板块的变声与翻唱 */
  kind: 'infer' | 'train' | 'separate' | 'vc_infer' | 'vc_train' | 'svc_infer' | 'svc_train';
  name: string;
  state: SovitsJobState;
  progress: number;
  message: string;
  error: string | null;
  stages: SovitsJobStage[];
  artifacts: Record<string, unknown>;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  elapsed_ms: number;
  waiting_ms: number;
  logs?: SovitsLogLine[];
  log_count?: number;
}

// --------------------------------------------------------------------------
// 训练
// --------------------------------------------------------------------------

/** UVR5 模型（人声/伴奏分离、去混响、去延迟） */
export interface SovitsUvrModel {
  id: string;
  kind: 'AudioPre' | 'AudioPreDeEcho' | 'Roformer_Loader' | 'MDXNetDereverb';
  label: string;
  note: string;
  size_mb: number;
  /** 是否同时产出伴奏轨道（只有 VR 分离模型才有双输出） */
  dual_output: boolean;
  available: boolean;
  missing_config: boolean;
}

export interface SovitsUvrModelList {
  ok: boolean;
  models: SovitsUvrModel[];
  total: number;
  formats: string[];
  kinds: Record<string, string>;
}

/** 标注校对的一条 */
export interface SovitsAnnotationItem {
  index: number;
  audio_path: string;
  audio_url: string;
  speaker: string;
  language: string;
  text: string;
  exists: boolean;
}

export interface SovitsAnnotationList {
  ok: boolean;
  job_id: string;
  list_file: string;
  items: SovitsAnnotationItem[];
  total: number;
  missing_audio: number;
}

export interface SovitsTrainPayload {
  name: string;
  source_audio_dir?: string;
  list_file?: string;
  text_lang: 'zh' | 'en' | 'ja' | 'ko' | 'yue';
  version: string;
  speaker: string;
  gpu_ids: string;

  run_uvr: boolean;
  run_denoise: boolean;
  run_slice: boolean;
  run_asr: boolean;
  run_format: boolean;
  run_s1: boolean;
  run_s2: boolean;

  slice: SovitsSliceDefaults;
  asr_backend: 'funasr' | 'fasterwhisper';
  asr_model_size: string;
  asr_language: string;
  asr_precision: 'float16' | 'float32' | 'int8';

  // ---------- UVR5 人声/伴奏分离 ----------
  uvr_model: string;
  uvr_agg: number;
  uvr_format: 'wav' | 'flac' | 'mp3' | 'm4a';
  uvr_keep_vocal: boolean;
  uvr_keep_ins: boolean;

  // ---------- 预训练权重（留空用官方自带） ----------
  pretrained_gpt_path?: string;
  pretrained_sovits_path?: string;
  pretrained_sovits_d_path?: string;

  epochs_s1: number;
  batch_size_s1: number;
  save_every_epoch_s1: number;
  if_dpo: boolean;

  epochs_s2: number;
  batch_size_s2: number;
  save_every_epoch_s2: number;
  text_low_lr_rate: number;
  if_grad_ckpt: boolean;
  lora_rank: number;

  if_save_every_weights: boolean;
  if_save_latest: boolean;
  dry_run: boolean;
  plan_only?: boolean;
}

export interface SovitsTrainPlanStep {
  stage: string;
  label: string;
  phase: 'corpus' | 'dataset' | 'train' | string;
  note: string;
  env: Record<string, string>;
  commands: string[];
}

export interface SovitsTrainPlan {
  ok: boolean;
  context: Record<string, unknown>;
  skipped: string[];
  steps: SovitsTrainPlanStep[];
}

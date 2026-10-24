/**
 * 歌声转换（DDSP-SVC）板块的契约类型，与 `trainer/app/routers/svc.py` 一一对应。
 */

/** 音色模型（.pt + 同目录 config.yaml） */
export interface SvcModel {
  id: string;
  name: string;
  path: string;
  size_mb: number;
  has_config: boolean;
  available: boolean;
  hint?: string;
  config_error?: string;
  sample_rate?: number | null;
  encoder?: string | null;
  f0_extractor?: string | null;
  n_spk?: number | null;
  block_size?: number | null;
}

/** 音质档位（Rectified Flow 的步数 / 采样器组合） */
export interface SvcQualityPreset {
  key: 'fast' | 'standard' | 'quality' | 'raw';
  label: string;
  infer_step: number;
  method: string;
  t_start: number | null;
  hint: string;
}

export interface SvcF0Method {
  key: string;
  label: string;
  hint: string;
}

export interface SvcCatalog {
  ok: boolean;
  quality_presets: SvcQualityPreset[];
  f0_methods: SvcF0Method[];
  models: SvcModel[];
  model_dirs: string[];
}

export interface SvcPipelineStatus {
  loaded: boolean;
  model: string | null;
  name?: string | null;
  sample_rate?: number | null;
  encoder?: string | null;
  f0_extractor?: string | null;
  n_spk?: number | null;
  infer_step?: number | null;
  method?: string | null;
  held_s?: number;
}

/** 翻唱产物：新人声 / 伴奏 / 混音 三件套（+ 同步模式下可能只有 output） */
export interface SvcArtifacts {
  vocal?: string;
  instrumental?: string;
  mix?: string;
  output?: string;
}

export interface SvcCoverStage {
  key: string;
  label: string;
  cached?: boolean;
  elapsed_s?: number;
  model?: string | null;
  segments?: number | null;
  outputs?: string[];
}

/** 分离结果的通用结构（/v1/uvr/separate 与 cover 共用） */
export interface UvrSeparationResult {
  vocal: string | null;
  instrumental: string | null;
  model: string | null;
  secondary?: string | null;
  agg?: number;
  cached: boolean;
  elapsed_s: number;
  meta?: { cache_key?: string };
}

export interface SvcCoverPayload {
  file?: File;
  source?: string;
  model: string;
  key?: number;
  spk_id?: number;
  f0_method?: string;
  quality?: SvcQualityPreset['key'];
  formant_shift?: number;
  threshold_db?: number;
  slice_segments?: boolean;
  separation?: {
    preset?: string;
    secondary?: string;
    agg?: number;
    use_cache?: boolean;
  };
  mix?: {
    vocal_gain_db?: number;
    instrumental_gain_db?: number;
    vocal_delay_ms?: number;
    fade_ms?: number;
  };
  wait?: boolean;
}

export interface SvcCoverAsyncResponse {
  ok: boolean;
  job_id: string;
  message: string;
  request: SvcCoverPayload;
}

export interface SvcCoverSyncResponse {
  ok: boolean;
  artifacts: SvcArtifacts;
  stages: SvcCoverStage[];
  elapsed_s: number;
  separation: UvrSeparationResult;
}

export interface SvcConvertPayload {
  file?: File;
  source?: string;
  model: string;
  key?: number;
  spk_id?: number;
  f0_method?: string;
  quality?: SvcQualityPreset['key'];
  formant_shift?: number;
  threshold_db?: number;
  slice_segments?: boolean;
  wait?: boolean;
}

export interface SvcModelUploadResponse {
  ok: boolean;
  path: string;
  has_config: boolean;
  message: string;
}

// --------------------------------------------------------------------------
// 训练（阶段 44）
// --------------------------------------------------------------------------

export interface SvcTrainPayload {
  name: string;
  corpus_dir: string;
  epochs?: number;
  batch_size?: number;
  /** 训练片段时长（秒），必须小于最短音频 */
  duration?: number;
  f0_method?: string;
  amp_dtype?: 'fp16' | 'fp32' | 'bf16' | string;
  device?: 'auto' | 'cuda' | 'cpu' | string;
  workers?: number;
  keep_workdir?: boolean;
}

export interface SvcTrainStage {
  key: string;
  label: string;
  command: string;
}

export interface SvcTrainInvalidFile {
  path: string;
  reason: string;
}

export interface SvcTrainPreflight {
  ok: boolean;
  /** 阻塞项：跑下去必然失败 */
  issues: string[];
  /** 非阻塞：能跑但结果打折 */
  warnings: string[];
  device: string;
  corpus: {
    dir: string;
    files: number;
    total_s: number;
    shortest_s: number;
    longest_s: number;
    train_count: number;
    val_count: number;
    extensions: string[];
    invalid: SvcTrainInvalidFile[];
  };
  config: {
    path: string;
    template: string;
    duration_s: number;
    sample_rate: number;
    amp_dtype: string;
    f0_method: string;
  };
  steps: {
    batches_per_epoch: number;
    total: number;
    epochs: number;
    batch_size: number;
    interval_val: number;
    interval_force_save: number;
    workers: number;
  };
  pretrained: {
    rmvpe: string | null;
    contentvec: string;
    vocoder: string;
    missing: string[];
  };
  output: {
    workdir: string;
    model_dir: string;
  };
  vram: {
    required_mb: number;
    free_mb: number | null;
    ok: boolean;
  };
}

export interface SvcTrainPlanResponse {
  ok: boolean;
  stages: SvcTrainStage[];
  request: SvcTrainPayload;
  preflight: SvcTrainPreflight;
}

export interface SvcTrainSubmitResponse {
  ok: boolean;
  job_id: string;
  message: string;
}

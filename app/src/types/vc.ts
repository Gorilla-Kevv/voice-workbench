/**
 * 语音变声（RVC）板块的契约类型，与 `trainer/app/routers/vc.py` 一一对应。
 */

/** 模型库里的一个音色（.pth + 可选 .index） */
export interface VcModel {
  id: string;
  name: string;
  path: string;
  size_mb: number;
  modified_at: number;
  sample_rate?: number;
  version?: string;
  f0?: boolean;
  n_spk?: number;
  info?: string;
  has_index: boolean;
  index: string | null;
  index_mb: number;
  meta_error?: string;
}

/** F0 提取方法 */
export interface VcF0Method {
  key: string;
  label: string;
  hint: string;
}

export interface VcCatalog {
  ok: boolean;
  models: VcModel[];
  f0_methods: VcF0Method[];
  models_dir: string;
  engine: VcPipelineStatus;
}

export interface VcPipelineStatus {
  loaded: boolean;
  model: string | null;
  name?: string | null;
  sample_rate?: number | null;
  version?: string | null;
  f0?: boolean | null;
  has_index?: boolean | null;
  device?: string | null;
  is_half?: boolean | null;
  held_s?: number;
}

export interface VcConvertPayload {
  /** 上传的音频文件；与 source 二选一 */
  file?: File;
  source?: string;
  model: string;
  f0_up_key?: number;
  f0_method?: string;
  index_rate?: number;
  filter_radius?: number;
  resample_sr?: number;
  rms_mix_rate?: number;
  protect?: number;
  /** true 时同步等待（只适合很短的音频） */
  wait?: boolean;
}

export interface VcConvertAsyncResponse {
  ok: boolean;
  job_id: string;
  message: string;
}

export interface VcConvertSyncResponse {
  ok: boolean;
  output: string;
  sample_rate: number;
  duration: number;
  model: string;
  used_index?: boolean;
}

export interface VcMergePayload {
  /** 模型文件名列表，至少 2 个 */
  models: string[];
  /** 与 models 一一对应的权重（内部自动归一化） */
  weights: number[];
  name?: string;
}

export interface VcMergeResponse {
  ok: boolean;
  path: string;
  name: string;
  size_mb: number;
  ratios: Record<string, number>;
  sources: string[];
}

export interface VcTrainPayload {
  name: string;
  corpus_dir: string;
  sample_rate?: string;
  version?: string;
  f0?: boolean;
  f0_method?: string;
  mode: 'full' | 'lora';
  base_model?: string;
  epochs?: number;
  save_every?: number;
  batch_size?: number;
  build_index?: boolean;
  rank?: number;
  alpha?: number;
  learning_rate?: number;
  keep_workdir?: boolean;
}

export interface VcTrainStage {
  key: string;
  label: string;
  command: string;
}

export interface VcTrainPlanResponse {
  ok: boolean;
  stages: VcTrainStage[];
  request: VcTrainPayload;
}

export interface VcTrainSubmitResponse {
  ok: boolean;
  job_id: string;
  message: string;
}

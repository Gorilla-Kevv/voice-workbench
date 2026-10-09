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

/**
 * 一次训练产出的一件产物。
 *
 * 后端 `training.run()` 直接把「本机绝对路径 + 体积 + 类型」组织好返回，
 * 前端只负责渲染与持久化 —— 不在前端拼路径，是因为服务端的目录布局
 * （`.data/vc/models`、模型自带索引）属于后端契约，前端不该重复一份。
 */
export interface VcTrainArtifact {
  key: 'model' | 'adapter' | 'index' | string;
  label: string;
  /** 本机绝对路径（给用户复制/定位） */
  path: string;
  size_mb: number;
  kind: string;
}

/** 一条训练记录（前端持久化用；来源是 /v1/jobs 的 vc_train 任务） */
export interface VcTrainRecord {
  jobId: string;
  name: string;
  /** 训练模式与关键参数，用于列表副标题 */
  mode: string;
  createdAt: number;
  finishedAt: number | null;
  state: string;
  artifacts: VcTrainArtifact[];
}

/**
 * 一条**运行**记录（变声 / 翻唱）。
 *
 * 与训练记录同源（都来自 `/v1/jobs`），但产物结构不同：
 * 运行任务是「输入 → 若干音频输出」，所以每条记录带一个 `tracks` 数组。
 * 每轨同时给 `url`（浏览器可直接播放的 Web 路径）与 `path`（本机绝对路径，
 * 供用户在资源管理器里定位）—— 两者都给，是因为用户既要能听、也要能找到文件。
 */
export interface VcRunTrack {
  /** 产物逻辑名：`output` / `vocal` / `instrumental` / `mix` */
  key: string;
  /** 中文显示名 */
  label: string;
  /** 浏览器可取的 Web 路径；缺失时该轨无法内联播放 */
  url: string | null;
  /** 本机绝对路径 */
  path: string | null;
}

export interface VcRunRecord {
  jobId: string;
  /** 任务显示名（如「语音变声：xxx.mp3」） */
  name: string;
  /** 运行时用的音色名 */
  model: string;
  createdAt: number;
  finishedAt: number | null;
  state: string;
  /** 音频时长或跑批耗时（秒），取服务端给得上的那个 */
  duration: number;
  /**
   * 本次运行的全部产物。变声是 1 条（`output`），
   * 翻唱是 1~3 条（`vocal` / `instrumental` / `mix`）。
   */
  tracks: VcRunTrack[];
}

/** F0 提取方法 */
export interface VcF0Method {
  key: string;
  label: string;
  hint: string;
}export interface VcCatalog {
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
  /** 服务端本地绝对路径（排障用；**不要**直接当音频 src，浏览器取不到） */
  output: string;
  /** 浏览器可取的 Web 路径，形如 `{ output: '/files/vc/<token>/converted.wav' }` */
  urls?: Record<string, string>;
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

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

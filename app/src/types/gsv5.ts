/** GPT-SoVITS v5 模块（gsv5/，第五个 Python 运行时；新一代推理底模 v5dev/v5turbo） */

/** v5 的两个变体（上游 `module/models_v5.py::V5_VERSIONS`） */
export type Gsv5Variant = 'v5turbo' | 'v5dev';

export interface Gsv5VariantInfo {
  id: Gsv5Variant;
  label: string;
  default_sample_steps: number;
  required_vram_mb: number;
}

export interface Gsv5Catalog {
  ok: boolean;
  variants: Gsv5VariantInfo[];
  default_variant: Gsv5Variant;
  languages: string[];
  note: string;
}

export interface Gsv5Health {
  ok: boolean;
  service: 'gsv5';
  loaded: boolean;
  engine: {
    loaded: boolean;
    variant: Gsv5Variant | null;
    required_vram_mb: number | null;
    vram_free_mb: number | null;
  };
  weights: Record<string, boolean>;
  variants: Gsv5Variant[];
  default_variant: Gsv5Variant;
}

export interface Gsv5SynthPayload {
  text: string;
  text_lang?: string;
  /** 参考三选一之二（与 irodori 同思路）：音色库 id */
  ref_voice?: string;
  /** 参考三选一之二：本地路径 */
  ref_audio_path?: string;
  prompt_text?: string;
  prompt_lang?: string;
  variant?: Gsv5Variant;
  /** 不传用变体默认（turbo 4 / dev 32） */
  sample_steps?: number;
  speed_factor?: number;
  seed?: number;
}

export interface Gsv5SynthResult {
  ok: boolean;
  audio_base64: string;
  sample_rate: number;
  duration_sec: number;
  elapsed_sec: number;
  rtf: number;
  variant: Gsv5Variant;
  engine: Gsv5Health['engine'];
}

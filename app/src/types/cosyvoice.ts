/**
 * CosyVoice3 客户端契约（cosyvoice/，第六个 Python 运行时）。
 *
 * 与 `cosyvoice/app/api.py` 的返回一一对应；语言/方言/模式/控制面
 * 一律读 `/v1/catalog`，显存门槛读 `/health.configuration`，前端不抄常量。
 */

export interface CosyvoiceVram {
  free_mb: number | null;
  total_mb: number | null;
  torch_free_mb?: number | null;
  source?: string;
}

export interface CosyvoiceWeights {
  ready: boolean;
  groups: Array<{ name: string; label: string; ready: boolean; have_mb: number; need_mb: number }>;
  missing: string[];
  truncated: string[];
  missing_code: string[];
}

export interface CosyvoiceConfiguration {
  upstream_dir: string;
  model_dir: string;
  data_dir: string;
  sample_rate: number;
  fp16: boolean;
  llm_file: string;
  device: string;
  allow_cpu: boolean;
  min_ref_seconds: number;
  max_ref_seconds: number;
  max_text_length: number;
  timeout_sec: number;
  required_vram_mb: number;
  compute_capability: [number, number] | null;
  gpu_name: string | null;
  manifest_path: string;
  manifest_entries: number;
}

export interface CosyvoiceHealth {
  ok: boolean;
  service: string;
  version: string;
  python: string;
  torch: string | null;
  cuda: boolean;
  device: string | null;
  pid: number;
  vram: CosyvoiceVram | null;
  loaded: boolean;
  loaded_at: number | null;
  last_error: string | null;
  model_key: Array<string | boolean> | null;
  weights: CosyvoiceWeights;
  configuration: CosyvoiceConfiguration;
}

export interface CosyvoiceLanguage {
  code: string;
  label: string;
}

export interface CosyvoiceDialect {
  code: string;
  label: string;
}

export interface CosyvoiceMode {
  id: 'zero_shot' | 'cross_lingual' | 'instruct2';
  label: string;
  requires_prompt_text: boolean;
  requires_instruct_text: boolean;
  note: string;
}

export interface CosyvoiceCatalog {
  ok: boolean;
  service: string;
  model: string;
  license: string;
  sample_rate: number;
  languages: CosyvoiceLanguage[];
  dialects: { items: CosyvoiceDialect[]; named: number; note: string };
  modes: CosyvoiceMode[];
  controls: {
    speed: { min: number; max: number; default: number };
    instruct_examples: string[];
    inline_tags: string[];
    note: string;
  };
  limits: { min_ref_seconds: number; max_ref_seconds: number; max_text_length: number };
  required_vram_mb: number;
  fp16: boolean;
  note: string;
}

export interface CosyvoiceSynthPayload {
  text: string;
  mode?: 'zero_shot' | 'cross_lingual' | 'instruct2';
  prompt_text?: string;
  instruct_text?: string;
  ref_path?: string;
  ref_voice?: string;
  language?: string;
  speed?: number;
}

export interface CosyvoiceSynthResult {
  ok: boolean;
  audio_base64: string;
  sample_rate: number;
  duration_sec: number;
  elapsed_sec: number;
  rtf: number | null;
  wav_path: string;
  mode: string;
  text: string;
  voice_id: string | null;
  voice_name: string | null;
  ref_source: string | null;
  speed: number;
  language: string | null;
  instruct_text: string | null;
  loaded: boolean;
  vram: CosyvoiceVram | null;
}

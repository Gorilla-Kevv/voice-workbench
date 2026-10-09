/**
 * IndexTTS 客户端契约。
 *
 * 与 `indextts/app/api.py` 的返回一一对应 —— 改一边必改另一边（与网易契约同一规矩）。
 */

export interface IndexttsVram {
  free_mb: number | null;
  total_mb: number | null;
  torch_free_mb?: number | null;
  source?: string;
}

export interface IndexttsEngineStatus {
  engine: 'indextts';
  loaded: boolean;
  device: string | null;
  loaded_for_sec: number | null;
}

export interface IndexttsHealth {
  ok: boolean;
  service: string;
  version: string;
  cuda: boolean;
  /** 服务自身进程号（网关用它确证端口归属） */
  pid?: number | null;
  vram: IndexttsVram;
  engine: IndexttsEngineStatus;
}

export interface IndexttsCatalog {
  ok: boolean;
  languages: string[];
  duration_factor: { min: number; max: number; default: number };
  /** 8 维情感向量的维度名（顺序即向量顺序） */
  emo_dimensions: string[];
  emo_alpha: { min: number; max: number; default: number };
  /** 文本描述控制情感（需额外 0.6B 模型，暂不接） */
  emo_text_control: boolean;
  required_vram_mb: number;
}

export interface IndexttsSynthResult {
  ok: boolean;
  audio_base64: string;
  sample_rate: number;
  duration_sec: number;
  elapsed_sec: number;
  path: string;
  language: string;
}

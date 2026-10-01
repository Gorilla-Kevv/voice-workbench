/**
 * 网易模块（Confucius4-TTS + Confucius4-R2T2）的契约类型。
 *
 * 与 `netease/app/` 一一对应，改后端时对照修改：
 *  - `app/models.py`          → NeteaseHealth / NeteaseCatalog / NeteaseTtsResult / NeteaseTranscribeResult
 *  - `app/routers/netease.py` → engines 里的安装状态结构
 *  - `app/routers/r2t2.py`    → 流式事件（NDJSON）
 *
 * 「安装状态」是本模块前端需要理解的核心概念：服务活着（health 200）
 * 不代表模型可用 —— 权重没下载时页面要显示「待补齐」而不是报错。
 * （权重落在 HF 缓存与 netease/models/：TTS 侧实测约 5.4 GB，不是早期文档估的 54 GB）
 */

/** 服务端统一错误体（与本地服务同一契约，复用 sovits 的类型定义） */
import type { SovitsErrorBody } from './sovits';

export type NeteaseErrorBody = SovitsErrorBody;

export interface NeteaseLanguage {
  code: string;
  label: string;
}

/** TTS 引擎（Confucius4-TTS）的安装 + 运行状态（/health 的 engines.confucius_tts） */
export interface NeteaseTtsEngineInfo {
  installed: boolean;
  missing: string[];
  home: string;
  config_path: string;
  package: { importable: boolean; missing?: string[] };
  /** 已就位的权重清单（HF 缓存项 + 本地目录项） */
  weights_cached: string[];
  /** 缺权重时给出的下载命令（不缺则为空串） */
  download_hint: string;
  loaded: boolean;
  device: string | null;
  loaded_for_sec: number | null;
}

/** ASR 引擎（Confucius4-R2T2）的安装 + 运行状态（/health 的 engines.r2t2） */
export interface NeteaseAsrEngineInfo {
  installed: boolean;
  missing: string[];
  model: string;
  model_local: boolean;
  interpreter: string;
  worker_spawned: boolean;
  pid: number | null;
  model_loaded: boolean;
  last_error: string | null;
}

export interface NeteaseHealth {
  ok: boolean;
  service: string;
  version: string;
  python: string;
  torch: boolean;
  cuda: boolean;
  device: string | null;
  /**
   * 显存读数。`free_mb` 取 nvidia-smi（跨进程真实值），
   * `torch_free_mb` 是本进程视图 —— 两者差很多说明显存被**别的程序**占着（见 HANDOFF 坑 17）。
   */
  vram: {
    free_mb: number;
    total_mb: number;
    torch_free_mb?: number;
    source?: 'nvidia-smi' | 'torch';
  } | null;
  engines: {
    confucius_tts: NeteaseTtsEngineInfo;
    r2t2: NeteaseAsrEngineInfo;
  };
  engine_lock: { holder: string | null; loaded_for_sec?: number };
  configuration: {
    tts_home: string;
    tts_required_vram_mb: number;
    r2t2_backend: string;
    r2t2_gpu_util: number;
    r2t2_interpreter: string;
    allow_cpu: boolean;
  };
}

export interface NeteaseCatalog {
  ok: boolean;
  tts: {
    model: string;
    summary: string;
    languages: NeteaseLanguage[];
    default_language: string;
    ref_audio_note: string;
    required_vram_mb: number;
    install: NeteaseTtsEngineInfo;
  };
  asr: {
    model: string;
    summary: string;
    languages: NeteaseLanguage[];
    default_language: string;
    chunk_ms_choices: number[];
    default_chunk_ms: number;
    stream_note: string;
    license_note: string;
    install: NeteaseAsrEngineInfo;
  };
}

/** 合成结果（audio_base64 是完整 wav，前端解成 Blob 播放/下载） */
export interface NeteaseTtsResult {
  ok: boolean;
  audio_base64: string;
  sample_rate: number;
  duration_sec: number;
  elapsed_sec: number;
  path: string;
  language: string;
  /** 为腾显存被卸载的另一引擎（tts/asr），未发生抢占为 null */
  preempted: string | null;
}

export interface NeteaseTimestamp {
  text: string;
  start: number | null;
  end: number | null;
}

/** 离线转写结果 */
export interface NeteaseTranscribeResult {
  ok: boolean;
  text: string;
  language: string;
  elapsed_sec?: number | null;
  timestamps?: NeteaseTimestamp[] | null;
  stream: boolean;
  preempted?: string | null;
}

/** 流式转写的 NDJSON 事件（append-only：已收到的文本不会被改写） */
export type NeteaseStreamEvent =
  | { type: 'start'; language: string; chunk_ms: number; preempted: string | null }
  | { type: 'delta'; text: string; elapsed_sec?: number | null }
  | { type: 'result'; ok: boolean; text: string; elapsed_sec?: number | null }
  | { type: 'error'; ok: false; error: NeteaseErrorBody };

export interface NeteaseEngineStatus {
  ok: boolean;
  engine: string;
  loaded: boolean;
  device: string | null;
  loaded_for_sec: number | null;
  lock: { holder: string | null; loaded_for_sec?: number };
}

/** 流式转写进行中的展示状态 */
export interface NeteaseStreamProgress {
  /** 已收到的完整文本（append-only，直接整体展示） */
  text: string;
  /** 是否已出定稿 */
  finalized: boolean;
  elapsedSec: number | null;
}

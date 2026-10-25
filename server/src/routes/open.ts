import fs from 'node:fs';

import { Router } from 'express';

import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { synthLimiter } from '../middleware/rateLimit.js';
import { resourceArbiter } from '../services/arbiter.js';
import {
  CAPABILITIES,
  capabilityAvailability,
  findCapability,
  toOpenAiModel,
  type CapabilityKind,
  type CapabilitySpec,
  type ResidentModelStatus,
} from '../services/capabilityCatalog.js';
import { synthesize, PRESET_VOICE_IDS } from '../services/mimo.js';
import { downloadUpstream, requestUpstream, RuntimeUnreachableError } from '../services/openClients.js';
import { getVoiceAudioPath, getVoice } from '../services/voiceLibrary.js';
import { baseUrlOf } from '../services/serviceCatalog.js';
import { config } from '../config/index.js';
import { gsv5Summary } from './gsv5.js';
import { indexttsSummary } from './indextts.js';
import { irodoriSummary } from './irodori.js';
import { neteaseSummary } from './netease.js';
import { sovitsSummary } from './sovits.js';

/**
 * 对外能力网关（阶段 43）：`/api/open/*` 统一调用 + `/api/capabilities` 能力发现。
 *
 * 设计边界（见 docs/OPEN-API.md）：
 * - **纯加法**：现有 14 个页面走各自透传代理，本文件不碰它们；这里只是把
 *   「OpenAI 风格的 {model, text, voice_id}」翻译成各运行时自己的请求形态；
 * - 全部端点只收 **JSON**（音频以 voice_id / 服务端路径引用），因此挂在
 *   express.json 之后的 apiRouter 里也不违反坑 20 的挂载顺序铁律；
 * - 上游错误**原样透传**（引擎忙 409 / 显存不足 503 的语义差异是文档的一部分）；
 *   网关只补「运行时不可达」这一层（OPEN_RUNTIME_UNREACHABLE 503）；
 * - 撞显存默认不让位 —— `focus: true` 时才先跑仲裁器（副作用可见，调用方自己决定）。
 */

export const openRouter = Router();

type Params = Record<string, unknown>;

function pstr(params: Params, key: string): string | undefined {
  const value = params[key];
  if (value === undefined || value === null || value === '') return undefined;
  return String(value);
}

function pnum(params: Params, key: string): number | undefined {
  const value = params[key];
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** 按 extra_params 白名单挑出调用方参数，防手滑把任意键透传进上游 */
function pickParams(spec: CapabilitySpec, raw: unknown): Params {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AppError(400, 'INVALID_REQUEST', 'params 必须是对象');
  }
  const source = raw as Params;
  const picked: Params = {};
  for (const key of spec.extra_params) {
    if (source[key] !== undefined) picked[key] = source[key];
  }
  return picked;
}

function requireText(body: Params): string {
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) {
    throw new AppError(400, 'TEXT_EMPTY', 'text 不能为空');
  }
  return text;
}

function requireCapability(model: unknown): CapabilitySpec {
  const spec = findCapability(typeof model === 'string' ? model : '');
  if (!spec) {
    throw new AppError(
      400,
      'INVALID_REQUEST',
      `未知模型：${String(model ?? '（空）')}。GET /api/open/v1/models 查看可用清单`,
      { details: { supported: CAPABILITIES.map((item) => item.id) } },
    );
  }
  return spec;
}

function clampTimeout(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 900_000;
  return Math.min(Math.max(parsed, 10_000), 1_800_000);
}

/** 把调用方的 voice_id / ref_path 折算成「路径 + 自带 prompt」；两者都没有就报缺参考 */
function resolveReference(
  spec: CapabilitySpec,
  body: Params,
): { path: string; voiceId?: string; promptText?: string; promptLang?: string } {
  const voiceId = typeof body.voice_id === 'string' && body.voice_id.trim() ? body.voice_id.trim() : undefined;
  const rawPath = typeof body.ref_path === 'string' && body.ref_path.trim() ? body.ref_path.trim() : undefined;

  if (voiceId) {
    // 网关侧解析音色库：拿绝对路径 + 该音色自带的参考文本（gsv5 等引擎需要）
    const view = getVoice(voiceId);
    const path = getVoiceAudioPath(voiceId);
    return {
      path,
      voiceId,
      promptText: typeof view.prompt_text === 'string' ? view.prompt_text : undefined,
      promptLang: typeof view.prompt_lang === 'string' ? view.prompt_lang : undefined,
    };
  }
  if (rawPath) {
    return { path: rawPath };
  }
  if (spec.ref.voice_id_param === null && spec.ref.path_param === null) {
    // 无参考概念的能力（不应走到这里，防御）
    return { path: '' };
  }
  throw new AppError(
    400,
    'INVALID_REQUEST',
    `缺少参考音频：${spec.id} 需要 voice_id（音色库）或 ref_path（服务端绝对路径）二者之一`,
    {
      hint: `voice_id 来自 GET /api/voicelib/；本机文件直接给 ref_path（例如 F:\\audio\\ref.wav）。${spec.hint}`,
    },
  );
}

interface AudioBytes {
  buffer: Buffer;
  sampleRate: number | null;
  durationSec: number | null;
  elapsedSec: number | null;
}

/** 从各引擎的合成响应里取音频字节：base64 字段优先，trainer 回退 audio_url 下载 */
async function audioBytesFrom(data: Record<string, unknown>, spec: CapabilitySpec): Promise<AudioBytes> {
  const base64 = typeof data.audio_base64 === 'string' && data.audio_base64
    ? data.audio_base64
    : typeof data.audio === 'string' && data.audio
      ? data.audio
      : null;
  const audioUrl = typeof data.audio_url === 'string' ? data.audio_url : null;
  if (!base64 && !audioUrl) {
    throw new AppError(502, 'UPSTREAM_ERROR', `上游 ${spec.runtime} 未返回音频字段`, {
      details: { keys: Object.keys(data) },
    });
  }
  const buffer = base64
    ? Buffer.from(base64, 'base64')
    : await downloadUpstream(baseUrlOf('sovits'), audioUrl as string, spec.runtime);
  return {
    buffer,
    sampleRate: typeof data.sample_rate === 'number' ? data.sample_rate : null,
    durationSec: typeof data.duration_sec === 'number' ? data.duration_sec : typeof data.duration_s === 'number' ? data.duration_s : null,
    elapsedSec: typeof data.elapsed_sec === 'number' ? data.elapsed_sec : typeof data.elapsed_ms === 'number' ? data.elapsed_ms / 1000 : null,
  };
}

function sendJson(res: import('express').Response, payload: Record<string, unknown>): void {
  res.json({ ok: true, ...payload });
}

/**
 * 渲染失败响应。返回 true 表示已写响应；false = 交还给 next(error)
 * （Express 4 不会捕获 async handler 的 throw，必须显式 next）。
 */
function handleFailure(res: import('express').Response, error: unknown): boolean {
  if (error instanceof RuntimeUnreachableError) {
    res.status(503).json({
      ok: false,
      error: {
        code: 'OPEN_RUNTIME_UNREACHABLE',
        message: error.message,
        retryable: true,
        hint: `到设置页确认 ${error.runtime} 服务已开启（GET /api/capabilities 可看实时状态）；若服务在跑，检查 baseUrl 配置。原因：${error.reason}`,
      },
    });
    return true;
  }
  if (error instanceof AppError) {
    res.status(error.status).json({
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        ...(error.hint ? { hint: error.hint } : {}),
        details: error.details,
      },
    });
    return true;
  }
  // 域错误（VoiceLibraryError / ModelRegistryError 等）：带 status+code 的按原语义渲染，
  // 不退化为 500 —— voice_id 不存在就该是 404 VOICE_NOT_FOUND
  const maybe = error as { status?: unknown; code?: unknown; message?: unknown; hint?: unknown; retryable?: unknown };
  if (typeof maybe.status === 'number' && typeof maybe.code === 'string') {
    res.status(maybe.status).json({
      ok: false,
      error: {
        code: maybe.code,
        message: String(maybe.message ?? ''),
        retryable: maybe.retryable === true,
        ...(typeof maybe.hint === 'string' && maybe.hint ? { hint: maybe.hint } : {}),
      },
    });
    return true;
  }
  return false;
}

// ------------------------------------------------------------------ speech

/** 五个本地 TTS + 云端 MiMo 的分发。返回统一 AudioBytes + 上游元信息。 */
async function dispatchSpeech(
  spec: CapabilitySpec,
  body: Params,
  params: Params,
  text: string,
  reference: { path: string; voiceId?: string; promptText?: string; promptLang?: string },
  timeoutMs: number,
): Promise<{ bytes: AudioBytes; meta: Record<string, unknown> }> {
  const lang = pstr(params, 'lang') ?? pstr(body, 'lang');

  if (spec.id === 'mimo') {
    const mode = pstr(params, 'mode');
    const voice = pstr(params, 'voice') ?? (typeof body.voice_id === 'string' ? body.voice_id.trim() : undefined);
    const resolvedMode = mode ?? (voice ? (PRESET_VOICE_IDS.has(voice) ? 'preset' : 'clone') : 'design');
    const result = await synthesize(
      {
        mode: resolvedMode as 'preset' | 'design' | 'clone',
        text,
        instruction: pstr(params, 'instruction'),
        voice,
        format: 'wav',
      },
      { autoSegment: params.auto_segment !== false },
    );
    const first = result.segments[0];
    if (!first) {
      throw new AppError(502, 'NO_AUDIO_IN_RESPONSE', 'MiMo 未返回音频');
    }
    return {
      bytes: {
        buffer: Buffer.from(first.audioBase64, 'base64'),
        sampleRate: null,
        durationSec: result.durationSec,
        elapsedSec: null,
      },
      meta: {
        segmented: result.segmented,
        segment_count: result.segments.length,
        /** 多段时其余段在这里（wav 不能直接拼接） */
        extra_segments_base64: result.segments.slice(1).map((segment) => segment.audioBase64),
        model: result.model,
      },
    };
  }

  const base = baseUrlOf(spec.runtime as 'sovits' | 'netease' | 'indextts' | 'irodori' | 'gsv5');

  if (spec.runtime === 'sovits') {
    const payload: Record<string, unknown> = {
      text,
      inline_base64: true,
      text_lang: pstr(params, 'text_lang') ?? lang ?? 'zh',
      prompt_text: pstr(params, 'prompt_text') ?? reference.promptText,
      prompt_lang: pstr(params, 'prompt_lang') ?? reference.promptLang,
    };
    if (reference.voiceId) payload.voice = reference.voiceId;
    else payload.ref_audio_path = reference.path;
    for (const key of ['version', 'gpt', 'sovits'] as const) {
      const value = pstr(params, key);
      if (value) payload[key] = value;
    }
    if (params.params && typeof params.params === 'object') payload.params = params.params;
    const result = await requestUpstream(base, spec.runtime, { path: spec.upstream.path, json: payload, timeoutMs });
    if (!result.ok) return { bytes: null as unknown as AudioBytes, meta: { __failure: result } };
    return { bytes: await audioBytesFrom(result.data, spec), meta: { upstream_status: result.status } };
  }

  if (spec.runtime === 'netease') {
    const formFields: Record<string, string> = {
      text,
      lang: lang ?? 'zh',
      ref_path: reference.path,
      quality: pstr(params, 'quality') ?? 'balanced',
    };
    const beams = pnum(params, 'num_beams');
    const steps = pnum(params, 'n_timesteps');
    if (beams !== undefined) formFields.num_beams = String(beams);
    if (steps !== undefined) formFields.n_timesteps = String(steps);
    const result = await requestUpstream(base, spec.runtime, { path: spec.upstream.path, formFields, timeoutMs });
    if (!result.ok) return { bytes: null as unknown as AudioBytes, meta: { __failure: result } };
    return { bytes: await audioBytesFrom(result.data, spec), meta: { upstream_status: result.status, language: result.data.language } };
  }

  if (spec.runtime === 'indextts') {
    const emoVector = params.emo_vector;
    const formFields: Record<string, string> = {
      text,
      lang: (lang ?? 'ZH').toUpperCase(),
      ref_path: reference.path,
      duration_factor: String(pnum(params, 'duration_factor') ?? 1.0),
      emo_alpha: String(pnum(params, 'emo_alpha') ?? 0.65),
    };
    if (Array.isArray(emoVector)) formFields.emo_vector = JSON.stringify(emoVector);
    const result = await requestUpstream(base, spec.runtime, { path: spec.upstream.path, formFields, timeoutMs });
    if (!result.ok) return { bytes: null as unknown as AudioBytes, meta: { __failure: result } };
    return { bytes: await audioBytesFrom(result.data, spec), meta: { upstream_status: result.status } };
  }

  if (spec.runtime === 'irodori') {
    const payload: Record<string, unknown> = { text };
    if (reference.voiceId) payload.ref_voice = reference.voiceId;
    else payload.ref_path = reference.path;
    const speakerId = pstr(params, 'speaker_id');
    if (speakerId) payload.speaker_id = speakerId;
    const caption = pstr(params, 'caption');
    if (caption) payload.caption = caption;
    const numSteps = pnum(params, 'num_steps');
    if (numSteps !== undefined) payload.num_steps = numSteps;
    const schedule = pstr(params, 'schedule');
    if (schedule) payload.schedule = schedule;
    const seed = pnum(params, 'seed');
    if (seed !== undefined) payload.seed = seed;
    const durationScale = pnum(params, 'duration_scale');
    if (durationScale !== undefined) payload.duration_scale = durationScale;
    const result = await requestUpstream(base, spec.runtime, { path: spec.upstream.path, json: payload, timeoutMs });
    if (!result.ok) return { bytes: null as unknown as AudioBytes, meta: { __failure: result } };
    return { bytes: await audioBytesFrom(result.data, spec), meta: { upstream_status: result.status, ...pickDefined(result.data, ['ref_source', 'steps_used', 'retried', 'used_seed']) } };
  }

  // gsv5
  const payload: Record<string, unknown> = {
    text,
    text_lang: pstr(params, 'text_lang') ?? lang ?? 'zh',
    variant: pstr(params, 'variant') ?? 'v5turbo',
    speed_factor: pnum(params, 'speed_factor') ?? 1.0,
    seed: pnum(params, 'seed') ?? -1,
  };
  if (reference.voiceId) payload.ref_voice = reference.voiceId;
  else {
    payload.ref_audio_path = reference.path;
    payload.prompt_text = pstr(params, 'prompt_text') ?? '';
    payload.prompt_lang = pstr(params, 'prompt_lang') ?? 'zh';
  }
  const sampleSteps = pnum(params, 'sample_steps');
  if (sampleSteps !== undefined) payload.sample_steps = sampleSteps;
  const result = await requestUpstream(base, spec.runtime, { path: spec.upstream.path, json: payload, timeoutMs });
  if (!result.ok) return { bytes: null as unknown as AudioBytes, meta: { __failure: result } };
  return { bytes: await audioBytesFrom(result.data, spec), meta: { upstream_status: result.status, variant: result.data.variant } };
}

function pickDefined(data: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (data[key] !== undefined) out[key] = data[key];
  }
  return out;
}

openRouter.post('/v1/audio/speech', synthLimiter, async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as Params;
    const spec = requireCapability(body.model);
    if (spec.kind !== 'tts') {
      throw new AppError(400, 'INVALID_REQUEST', `${spec.id} 不是合成能力（kind=${spec.kind}），请用对应端点`);
    }
    const text = requireText(body);
    const params = pickParams(spec, body.params);
    const format = body.format === 'json' ? 'json' : 'wav';
    const timeoutMs = clampTimeout(body.timeout_ms);

    let arbiterNote: Record<string, unknown> | undefined;
    if (body.focus === true && spec.arbiter_engine) {
      const report = await resourceArbiter.focus(spec.arbiter_engine, 3600);
      arbiterNote = { engine: report.engine, released: report.released, failed: report.failed };
      logger.info('能力网关：外部调用前已仲裁让位', { capability: spec.id, released: report.released.length });
    }

    // mimo 的 preset 模式不需要参考音频；其余 TTS 必须给 voice_id 或 ref_path
    const reference = spec.id === 'mimo'
      ? { path: '', voiceId: typeof body.voice_id === 'string' ? body.voice_id.trim() : undefined }
      : resolveReference(spec, body);

    const { bytes, meta } = await dispatchSpeech(spec, body, params, text, reference, timeoutMs);
    if (meta.__failure) {
      const failure = meta.__failure as { status: number; body: unknown };
      res.status(failure.status).json(failure.body);
      return;
    }
    if (arbiterNote) meta.arbiter = arbiterNote;

    if (format === 'json') {
      sendJson(res, {
        model: spec.id,
        runtime: spec.runtime,
        audio_base64: bytes.buffer.toString('base64'),
        content_type: 'audio/wav',
        sample_rate: bytes.sampleRate,
        duration_sec: bytes.durationSec,
        elapsed_sec: bytes.elapsedSec,
        ...meta,
      });
      return;
    }
    res
      .status(200)
      .type('audio/wav')
      .set('X-Open-Capability', spec.id);
    if (bytes.sampleRate) res.set('X-Open-Sample-Rate', String(bytes.sampleRate));
    res.send(bytes.buffer);
  } catch (error) {
    if (!handleFailure(res, error)) next(error);
  }
});

// ------------------------------------------------------------------ transcriptions

openRouter.post('/v1/audio/transcriptions', synthLimiter, async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as Params;
    const spec = requireCapability(body.model);
    if (spec.kind !== 'asr') {
      throw new AppError(400, 'INVALID_REQUEST', `${spec.id} 不是转写能力（kind=${spec.kind}）`);
    }
    const params = pickParams(spec, body.params);
    const audioPath = typeof body.audio_path === 'string' && body.audio_path.trim()
      ? body.audio_path.trim()
      : typeof body.voice_id === 'string' && body.voice_id.trim()
        ? getVoiceAudioPath(body.voice_id.trim())
        : '';
    if (!audioPath) {
      throw new AppError(400, 'INVALID_REQUEST', '缺少待转写音频：audio_path（服务端绝对路径）或 voice_id（音色库）', {
        hint: '外部文件请先经 POST /api/voicelib/ 入库成音色，或放到本机后传绝对路径。',
      });
    }
    const timeoutMs = clampTimeout(body.timeout_ms);
    const language = typeof body.language === 'string' ? body.language : '';

    let result;
    if (spec.runtime === 'sovits') {
      const formFields: Record<string, string> = {
        source: audioPath,
        backend: pstr(params, 'backend') ?? spec.fixed_params.backend ?? '',
        size: pstr(params, 'size') ?? spec.fixed_params.size ?? '',
        precision: pstr(params, 'precision') ?? spec.fixed_params.precision ?? '',
        model: pstr(params, 'model') ?? spec.fixed_params.model ?? '',
        language,
        use_cache: params.use_cache === false ? 'false' : 'true',
      };
      result = await requestUpstream(baseUrlOf('sovits'), 'sovits', {
        path: spec.upstream.path,
        formFields,
        timeoutMs,
      });
    } else {
      // r2t2-offline
      const formFields: Record<string, string> = {
        ref_path: audioPath,
        language: language || 'auto',
        stream: 'false',
        return_timestamps: body.return_timestamps === true ? 'true' : 'false',
      };
      result = await requestUpstream(baseUrlOf('netease'), 'netease', {
        path: spec.upstream.path,
        formFields,
        timeoutMs,
      });
    }

    if (!result.ok) {
      res.status(result.status).json(result.body);
      return;
    }
    const data = result.data;
    sendJson(res, {
      model: spec.id,
      runtime: spec.runtime,
      text: typeof data.text === 'string' ? data.text : '',
      language: data.language ?? language,
      elapsed_sec: data.elapsed_sec ?? null,
      segments: data.segments ?? null,
      timestamps: data.timestamps ?? null,
      warning: data.warning ?? null,
    });
  } catch (error) {
    if (!handleFailure(res, error)) next(error);
  }
});

// ------------------------------------------------------------------ 转换类（RVC / DDSP / UVR5）

interface ConvertOutcome {
  data: Record<string, unknown>;
  outputFile: string | null;
}

/** 把 params 里的数字/字符串/布尔安全落进 form 字段 */
function putField(form: Record<string, string>, params: Params, key: string, fallback?: string | number | boolean): void {
  const value = params[key] ?? fallback;
  if (value !== undefined && value !== null && value !== '') form[key] = String(value);
}

async function dispatchConvert(
  spec: CapabilitySpec,
  params: Params,
  audioPath: string,
  timeoutMs: number,
): Promise<ConvertOutcome> {
  const formFields: Record<string, string> = { source: audioPath, wait: 'true' };

  if (spec.kind === 'vc') {
    // ⚠️ 目标模型只认 params.model（body.model 是能力 id，别混）——RVC 值 = 引擎 key（主权重茎）
    const model = pstr(params, 'model');
    if (!model) {
      throw new AppError(400, 'INVALID_REQUEST', '缺少 params.model：RVC 变声模型的引擎 key（GET /api/models?category=rvc 查清单）');
    }
    formFields.model = model;
    putField(formFields, params, 'f0_up_key', 0);
    putField(formFields, params, 'f0_method', 'rmvpe');
    putField(formFields, params, 'index_rate', 0.3);
    putField(formFields, params, 'filter_radius', 3);
    putField(formFields, params, 'resample_sr', 0);
    putField(formFields, params, 'rms_mix_rate', 0.25);
    putField(formFields, params, 'protect', 0.33);
  } else if (spec.kind === 'svc') {
    const model = pstr(params, 'model');
    if (!model) {
      throw new AppError(400, 'INVALID_REQUEST', '缺少 params.model：DDSP-SVC 的 .pt 主权重绝对路径（GET /api/models?category=ddsp-svc 查清单）');
    }
    formFields.model = model;
    putField(formFields, params, 'key', 0.0);
    putField(formFields, params, 'spk_id', 1);
    putField(formFields, params, 'f0_method', '');
    putField(formFields, params, 'quality', 'standard');
    putField(formFields, params, 'formant_shift', 0);
    putField(formFields, params, 'threshold_db', -45);
    putField(formFields, params, 'slice_segments', true);
  } else {
    // uvr5-separate：没有目标模型概念
    putField(formFields, params, 'preset', 'vocal_fast');
    putField(formFields, params, 'secondary', 'none');
    putField(formFields, params, 'agg', 10);
    putField(formFields, params, 'format', 'wav');
    putField(formFields, params, 'use_cache', true);
  }

  const result = await requestUpstream(baseUrlOf('sovits'), 'sovits', { path: spec.upstream.path, formFields, timeoutMs });
  if (!result.ok) {
    return { data: { __failure: result.body, __status: result.status }, outputFile: null };
  }
  const data = result.data;
  const outputFile =
    (typeof data.output === 'string' && data.output) ||
    (data.paths && typeof (data.paths as Params).vocal === 'string' ? (data.paths as Params).vocal as string : null);
  return { data, outputFile };
}

function registerConvertEndpoint(path: string, kinds: CapabilityKind[], label: string): void {
  openRouter.post(path, synthLimiter, async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as Params;
      const spec = requireCapability(body.model);
      if (!kinds.includes(spec.kind)) {
        throw new AppError(400, 'INVALID_REQUEST', `${spec.id}（kind=${spec.kind}）不适用于 ${label}`);
      }
      const params = pickParams(spec, body.params);
      const audioPath = typeof body.audio_path === 'string' && body.audio_path.trim()
        ? body.audio_path.trim()
        : typeof body.voice_id === 'string' && body.voice_id.trim()
          ? getVoiceAudioPath(body.voice_id.trim())
          : '';
      if (!audioPath) {
        throw new AppError(400, 'INVALID_REQUEST', '缺少待处理音频：audio_path（服务端绝对路径）或 voice_id（音色库）');
      }
      const timeoutMs = clampTimeout(body.timeout_ms);
      const { data, outputFile } = await dispatchConvert(spec, params, audioPath, timeoutMs);
      if (data.__failure) {
        res.status(Number(data.__status)).json(data.__failure);
        return;
      }
      const format = body.format === 'audio' ? 'audio' : 'meta';
      if (format === 'audio') {
        if (!outputFile || !fs.existsSync(outputFile)) {
          throw new AppError(502, 'UPSTREAM_ERROR', `上游未产出可回传的音频文件（output=${outputFile ?? 'null'}）`);
        }
        res.status(200).type('audio/wav').set('X-Open-Capability', spec.id).send(fs.readFileSync(outputFile));
        return;
      }
      sendJson(res, { model: spec.id, runtime: spec.runtime, output_file: outputFile, result: data });
    } catch (error) {
      if (!handleFailure(res, error)) next(error);
    }
  });
}

registerConvertEndpoint('/v1/audio/convert', ['vc'], '语音转换');
registerConvertEndpoint('/v1/audio/singing-convert', ['svc'], '歌声转换');
registerConvertEndpoint('/v1/audio/separate', ['separation'], '音源分离');

// ------------------------------------------------------------------ 能力发现

interface RuntimeStatus {
  reachable: boolean;
  enabled: boolean | null;
  loadedByKind: { [K in CapabilityKind]?: boolean | null };
  vram: { free_mb: number | null; total_mb: number | null };
  /** 各能力项的服务端显存门槛（坑 19：数值全部来自服务端字段） */
  vramRequired: { [K in CapabilityKind]?: number | null };
  /** ASR 常驻模型的权重就绪与参数化门槛（trainer /v1/asr/catalog） */
  asrModels?: Record<string, ResidentModelStatus>;
}

const STATUS_CACHE_MS = 5_000;
let statusCache: { at: number; value: Record<string, RuntimeStatus> } | null = null;

function capabilityFallbackVram(spec: CapabilitySpec, status: RuntimeStatus): number | null {
  return spec.kind in status.vramRequired ? status.vramRequired[spec.kind] ?? null : null;
}

async function fetchHealth(baseUrl: string, runtime: string): Promise<Record<string, unknown> | null> {
  try {
    const result = await requestUpstream(baseUrl, runtime, { method: 'GET', path: '/health', timeoutMs: 5_000 });
    return result.ok ? result.data : null;
  } catch {
    return null;
  }
}

async function collectRuntimeStatus(): Promise<Record<string, RuntimeStatus>> {
  if (statusCache && Date.now() - statusCache.at < STATUS_CACHE_MS) return statusCache.value;

  const [sovits, netease, indextts, irodori, gsv5] = await Promise.all([
    Promise.resolve(sovitsSummary()),
    neteaseSummary(),
    indexttsSummary(),
    irodoriSummary(),
    gsv5Summary(),
  ]);
  const [sovitsEngines, asrCatalog, neteaseHealth, indexttsHealth, indexttsCatalog, irodoriHealth, gsv5Health, gsv5Catalog] =
    await Promise.all([
      requestUpstream(baseUrlOf('sovits'), 'sovits', { method: 'GET', path: '/v1/engines', timeoutMs: 5_000 }).catch(() => null),
      requestUpstream(baseUrlOf('sovits'), 'sovits', { method: 'GET', path: '/v1/asr/readiness', timeoutMs: 5_000 }).catch(() => null),
      fetchHealth(baseUrlOf('netease'), 'netease'),
      fetchHealth(baseUrlOf('indextts'), 'indextts'),
      requestUpstream(baseUrlOf('indextts'), 'indextts', { method: 'GET', path: '/v1/catalog', timeoutMs: 5_000 }).catch(() => null),
      fetchHealth(baseUrlOf('irodori'), 'irodori'),
      fetchHealth(baseUrlOf('gsv5'), 'gsv5'),
      requestUpstream(baseUrlOf('gsv5'), 'gsv5', { method: 'GET', path: '/v1/catalog', timeoutMs: 5_000 }).catch(() => null),
    ]);

  const pickNum = (value: unknown): number | null => (typeof value === 'number' ? value : null);

  // sovits：active 引擎名 → 能力 kind；required_mb 表
  const sovitsEnginesData = sovitsEngines && sovitsEngines.ok ? (sovitsEngines.data as Params) : null;
  const sovitsActive = sovitsEnginesData ? String(sovitsEnginesData.active ?? '') : '';
  const sovitsRequired: Record<string, number> = {};
  if (sovitsEnginesData) {
    for (const engine of (sovitsEnginesData.engines as Params[] | undefined) ?? []) {
      const name = String(engine.name ?? '');
      const mb = pickNum(engine.required_mb);
      if (name && mb != null) sovitsRequired[name] = mb;
    }
  }
  const asrModels =
    asrCatalog && asrCatalog.ok
      ? ((asrCatalog.data as Params).resident_model_status as Record<string, ResidentModelStatus> | undefined) ?? {}
      : {};
  const neteaseLoaded = neteaseHealth
    ? Boolean((neteaseHealth.engines as Params | undefined)?.confucius_tts
        ? ((neteaseHealth.engines as Params).confucius_tts as Params).loaded === true
        : false)
    : null;
  const r2t2Loaded = neteaseHealth
    ? Boolean(((neteaseHealth.engines as Params | undefined)?.r2t2 as Params | undefined)?.model_loaded === true)
    : null;
  const gsv5Variants =
    gsv5Catalog && gsv5Catalog.ok ? ((gsv5Catalog.data as Params).variants as Params[] | undefined) ?? [] : [];

  const value: Record<string, RuntimeStatus> = {
    sovits: {
      reachable: Boolean((sovits as Params).reachable),
      enabled: typeof (sovits as Params).enabled === 'boolean' ? (sovits.enabled as boolean) : null,
      loadedByKind: {
        tts: sovitsActive === 'sovits' || null,
        asr: sovitsActive === 'asr' || null,
        vc: sovitsActive === 'rvc' || null,
        svc: sovitsActive === 'svc' || null,
        separation: sovitsActive === 'uvr5' || null,
      },
      vram: {
        free_mb: pickNum(sovitsEnginesData?.free_vram_mb),
        total_mb: null,
      },
      vramRequired: {
        tts: sovitsRequired.sovits ?? null,
        asr: sovitsRequired.asr ?? null,
        vc: sovitsRequired.rvc ?? null,
        svc: sovitsRequired.svc ?? null,
        separation: sovitsRequired.uvr5 ?? null,
      },
      asrModels,
    },
    netease: {
      reachable: Boolean((netease as Params).reachable),
      enabled: typeof (netease as Params).enabled === 'boolean' ? (netease.enabled as boolean) : null,
      loadedByKind: { tts: neteaseLoaded ?? undefined, asr: r2t2Loaded ?? undefined },
      vram: {
        free_mb: neteaseHealth ? pickNum((neteaseHealth.vram as Params | undefined)?.free_mb) : null,
        total_mb: neteaseHealth ? pickNum((neteaseHealth.vram as Params | undefined)?.total_mb) : null,
      },
      vramRequired: {
        tts: neteaseHealth ? pickNum(((neteaseHealth.configuration as Params | undefined)?.tts_required_vram_mb)) : null,
        asr: null,
      },
    },
    indextts: {
      reachable: Boolean((indextts as Params).reachable),
      enabled: typeof (indextts as Params).enabled === 'boolean' ? (indextts.enabled as boolean) : null,
      loadedByKind: {
        tts: indexttsHealth ? Boolean(((indexttsHealth.engine as Params | undefined)?.loaded) === true) : null,
      },
      vram: {
        free_mb: indexttsHealth ? pickNum((indexttsHealth.vram as Params | undefined)?.free_mb) : null,
        total_mb: indexttsHealth ? pickNum((indexttsHealth.vram as Params | undefined)?.total_mb) : null,
      },
      vramRequired: {
        tts: indexttsCatalog && indexttsCatalog.ok ? pickNum((indexttsCatalog.data as Params).required_vram_mb) : null,
      },
    },
    irodori: {
      reachable: Boolean((irodori as Params).reachable),
      enabled: typeof (irodori as Params).enabled === 'boolean' ? (irodori.enabled as boolean) : null,
      loadedByKind: {
        tts: irodoriHealth ? irodoriHealth.loaded === true : null,
      },
      vram: {
        free_mb: irodoriHealth ? pickNum((irodoriHealth.vram as Params | undefined)?.free_mb) : null,
        total_mb: irodoriHealth ? pickNum((irodoriHealth.vram as Params | undefined)?.total_mb) : null,
      },
      vramRequired: {
        tts: irodoriHealth ? pickNum(((irodoriHealth.configuration as Params | undefined)?.required_vram_mb)) : null,
      },
    },
    gsv5: {
      reachable: Boolean((gsv5 as Params).reachable),
      enabled: typeof (gsv5 as Params).enabled === 'boolean' ? (gsv5.enabled as boolean) : null,
      loadedByKind: {
        tts: gsv5Health ? gsv5Health.loaded === true : null,
      },
      vram: { free_mb: null, total_mb: null },
      vramRequired: {
        tts: gsv5Variants.length
          ? pickNum(gsv5Variants.find((variant) => variant.id === 'v5turbo')?.required_vram_mb) ?? null
          : null,
      },
    },
    mimo: {
      reachable: true,
      enabled: Boolean(config.mimoApiKey),
      loadedByKind: {},
      vram: { free_mb: null, total_mb: null },
      vramRequired: {},
    },
  };

  statusCache = { at: Date.now(), value };
  return value;
}

/** GET /api/capabilities：能力发现（挂载在 /api 下，见 routes/index.ts） */
export async function capabilitiesHandler(_req: import('express').Request, res: import('express').Response): Promise<void> {
  const status = await collectRuntimeStatus();
  const capabilities = CAPABILITIES.map((spec) => {
    const runtimeStatus = status[spec.runtime];
    const loaded =
      spec.kind in runtimeStatus.loadedByKind ? runtimeStatus.loadedByKind[spec.kind] : null;
    const availability = capabilityAvailability(
      spec,
      runtimeStatus.reachable,
      runtimeStatus.asrModels,
      capabilityFallbackVram(spec, runtimeStatus),
      spec.runtime === 'mimo' ? Boolean(config.mimoApiKey) : undefined,
    );
    return {
      id: spec.id,
      label: spec.label,
      kind: spec.kind,
      runtime: spec.runtime,
      aliases: spec.aliases,
      reference: spec.ref,
      audio_input_param: spec.audio_input_param,
      fixed_params: spec.fixed_params,
      extra_params: spec.extra_params,
      endpoint: `POST /api/open/${spec.kind === 'tts' ? 'v1/audio/speech' : spec.kind === 'asr' ? 'v1/audio/transcriptions' : spec.kind === 'vc' ? 'v1/audio/convert' : spec.kind === 'svc' ? 'v1/audio/singing-convert' : 'v1/audio/separate'}`,
      available: availability.available,
      loaded: loaded ?? null,
      weights_ready: availability.weights_ready,
      weights_source: availability.weights_source,
      runtime_ready: availability.runtime_ready,
      vram_required_mb: availability.vram_required_mb,
      vram_source: spec.vram_source,
      hint: spec.hint,
    };
  });
  sendJson(res, {
    generated_at: new Date().toISOString(),
    vram_free_mb:
      status.netease.vram.free_mb ?? status.indextts.vram.free_mb ?? status.irodori.vram.free_mb ?? status.sovits.vram.free_mb ?? null,
    capabilities,
  });
}

openRouter.get('/v1/models', async (_req, res, next) => {
  try {
    const status = await collectRuntimeStatus();
    const data = CAPABILITIES.map((spec) => {
      const runtimeStatus = status[spec.runtime];
      const availability = capabilityAvailability(
        spec,
        runtimeStatus.reachable,
        runtimeStatus.asrModels,
        capabilityFallbackVram(spec, runtimeStatus),
        spec.runtime === 'mimo' ? Boolean(config.mimoApiKey) : undefined,
      );
      return toOpenAiModel(spec, availability.available);
    });
    sendJson(res, { object: 'list', data });
  } catch (error) {
    next(error);
  }
});

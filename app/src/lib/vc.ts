/**
 * 语音变声（RVC）与歌声转换（DDSP-SVC）两个板块的客户端。
 *
 * 与 `sovits.ts` 相同的约定：默认经同源网关 `/api/sovits/*` 透传到 Python 服务；
 * 服务内相对路径（如 `/files/vc/<job>/x.wav`）用 `resolveAudioUrl` 补全成可用地址。
 */

import { appendForm, localRequest } from '@/lib/local';
import { resolveAudioUrl } from '@/lib/sovits';
import type {
  SvcCatalog,
  SvcConvertPayload,
  SvcCoverAsyncResponse,
  SvcCoverPayload,
  SvcCoverSyncResponse,
  SvcModelUploadResponse,
  SvcPipelineStatus,
  VcCatalog,
  VcConvertAsyncResponse,
  VcConvertPayload,
  VcConvertSyncResponse,
  VcMergePayload,
  VcMergeResponse,
  VcPipelineStatus,
  VcTrainPayload,
  VcTrainPlanResponse,
  VcTrainSubmitResponse,
} from '@/types';

// --------------------------------------------------------------------------
// 语音变声（RVC）
// --------------------------------------------------------------------------

export const vcApi = {
  catalog: (baseUrl?: string): Promise<VcCatalog> =>
    localRequest('/v1/vc/catalog', { method: 'GET', timeoutMs: 30_000 }, baseUrl),

  loadModel: (model: string, baseUrl?: string): Promise<VcPipelineStatus & { ok: boolean }> => {
    const form = new FormData();
    appendForm(form, { model });
    return localRequest('/v1/vc/models/load', { method: 'POST', body: form, timeoutMs: 0 }, baseUrl);
  },

  unloadModel: (baseUrl?: string) =>
    localRequest<{ ok: boolean; message: string }>('/v1/vc/models/unload', { method: 'POST' }, baseUrl),

  uploadModel: (weight: File, index: File | null, name: string, baseUrl?: string) => {
    const form = new FormData();
    form.append('weight', weight, weight.name);
    if (index) form.append('index', index, index.name);
    form.append('name', name);
    return localRequest<{ ok: boolean; id: string; has_index: boolean; message: string }>(
      '/v1/vc/models/upload',
      { method: 'POST', body: form, timeoutMs: 0 },
      baseUrl,
    );
  },

  deleteModel: (model: string, baseUrl?: string) =>
    localRequest<{ ok: boolean; message: string }>(
      `/v1/vc/models?model=${encodeURIComponent(model)}`,
      { method: 'DELETE' },
      baseUrl,
    ),

  convert: (payload: VcConvertPayload, baseUrl?: string): Promise<VcConvertAsyncResponse | VcConvertSyncResponse> => {
    const form = new FormData();
    if (payload.file) form.append('file', payload.file, payload.file.name);
    appendForm(form, {
      source: payload.source,
      model: payload.model,
      f0_up_key: payload.f0_up_key ?? 0,
      f0_method: payload.f0_method ?? 'rmvpe',
      index_rate: payload.index_rate ?? 0.3,
      filter_radius: payload.filter_radius ?? 3,
      resample_sr: payload.resample_sr ?? 0,
      rms_mix_rate: payload.rms_mix_rate ?? 0.25,
      protect: payload.protect ?? 0.33,
      wait: payload.wait ?? false,
    });
    return localRequest('/v1/vc/convert', { method: 'POST', body: form, timeoutMs: 0 }, baseUrl);
  },

  merge: (payload: VcMergePayload, baseUrl?: string): Promise<VcMergeResponse> =>
    localRequest('/v1/vc/merge', { method: 'POST', body: JSON.stringify(payload), timeoutMs: 0 }, baseUrl),

  trainPlan: (payload: VcTrainPayload, baseUrl?: string): Promise<VcTrainPlanResponse> =>
    localRequest('/v1/vc/train/plan', { method: 'POST', body: JSON.stringify(payload), timeoutMs: 60_000 }, baseUrl),

  train: (payload: VcTrainPayload, baseUrl?: string): Promise<VcTrainSubmitResponse> =>
    localRequest('/v1/vc/train', { method: 'POST', body: JSON.stringify(payload), timeoutMs: 0 }, baseUrl),
};

// --------------------------------------------------------------------------
// 歌声转换（DDSP-SVC）
// --------------------------------------------------------------------------

export const svcApi = {
  catalog: (baseUrl?: string): Promise<SvcCatalog> =>
    localRequest('/v1/svc/catalog', { method: 'GET', timeoutMs: 30_000 }, baseUrl),

  pipeline: (baseUrl?: string): Promise<SvcPipelineStatus & { ok: boolean }> =>
    localRequest('/v1/svc/pipeline', { method: 'GET', timeoutMs: 20_000 }, baseUrl),

  loadModel: (path: string, modelKey?: string, baseUrl?: string): Promise<SvcPipelineStatus & { ok: boolean }> => {
    const form = new FormData();
    appendForm(form, { path, model_key: modelKey ?? '' });
    return localRequest('/v1/svc/models/load', { method: 'POST', body: form, timeoutMs: 0 }, baseUrl);
  },

  uploadModel: (model: File, config: File | null, name: string, baseUrl?: string): Promise<SvcModelUploadResponse> => {
    const form = new FormData();
    form.append('model', model, model.name);
    if (config) form.append('config', config, config.name);
    form.append('name', name);
    return localRequest('/v1/svc/models/upload', { method: 'POST', body: form, timeoutMs: 0 }, baseUrl);
  },

  cover: (payload: SvcCoverPayload, baseUrl?: string): Promise<SvcCoverAsyncResponse | SvcCoverSyncResponse> => {
    const form = new FormData();
    if (payload.file) form.append('file', payload.file, payload.file.name);
    const separation = payload.separation ?? {};
    const mix = payload.mix ?? {};
    appendForm(form, {
      source: payload.source,
      model: payload.model,
      key: payload.key ?? 0,
      spk_id: payload.spk_id ?? 1,
      f0_method: payload.f0_method ?? '',
      quality: payload.quality ?? 'standard',
      formant_shift: payload.formant_shift ?? 0,
      threshold_db: payload.threshold_db ?? -45,
      slice_segments: payload.slice_segments ?? true,
      separation_preset: separation.preset ?? '',
      separation_secondary: separation.secondary ?? 'none',
      use_cache: separation.use_cache ?? true,
      vocal_gain_db: mix.vocal_gain_db ?? 0,
      instrumental_gain_db: mix.instrumental_gain_db ?? 0,
      vocal_delay_ms: mix.vocal_delay_ms ?? 0,
      wait: payload.wait ?? false,
    });
    return localRequest('/v1/svc/cover', { method: 'POST', body: form, timeoutMs: 0 }, baseUrl);
  },

  convert: (payload: SvcConvertPayload, baseUrl?: string) => {
    const form = new FormData();
    if (payload.file) form.append('file', payload.file, payload.file.name);
    appendForm(form, {
      source: payload.source,
      model: payload.model,
      key: payload.key ?? 0,
      spk_id: payload.spk_id ?? 1,
      f0_method: payload.f0_method ?? '',
      quality: payload.quality ?? 'standard',
      formant_shift: payload.formant_shift ?? 0,
      threshold_db: payload.threshold_db ?? -45,
      slice_segments: payload.slice_segments ?? true,
      wait: payload.wait ?? false,
    });
    return localRequest('/v1/svc/convert', { method: 'POST', body: form, timeoutMs: 0 }, baseUrl);
  },
};

// --------------------------------------------------------------------------
// UVR5 分离（两个板块共用的能力）
// --------------------------------------------------------------------------

export interface UvrSeparatePayload {
  file?: File;
  source?: string;
  preset?: string;
  secondary?: string;
  agg?: number;
  use_cache?: boolean;
  wait?: boolean;
}

export interface UvrSeparateResponse {
  ok: boolean;
  vocal: string | null;
  instrumental: string | null;
  model: string | null;
  secondary?: string | null;
  cached: boolean;
  elapsed_s: number;
  /** 服务内相对 URL（经 resolveAudioUrl 补全后可直接播放） */
  urls?: Record<string, string>;
}

export const uvrApi = {
  separate: (payload: UvrSeparatePayload, baseUrl?: string): Promise<UvrSeparateResponse> => {
    const form = new FormData();
    if (payload.file) form.append('file', payload.file, payload.file.name);
    appendForm(form, {
      source: payload.source,
      preset: payload.preset ?? 'vocal_fast',
      secondary: payload.secondary ?? 'none',
      agg: payload.agg ?? 10,
      use_cache: payload.use_cache ?? true,
      wait: payload.wait ?? true,
    });
    return localRequest('/v1/uvr/separate', { method: 'POST', body: form, timeoutMs: 0 }, baseUrl);
  },
};

export { resolveAudioUrl };

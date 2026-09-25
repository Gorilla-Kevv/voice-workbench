/**
 * ASR 语音转文本板块的客户端。
 *
 * 与 `vc.ts` / `svc.ts` 同一套约定：默认经同源网关 `/api/sovits/*` 透传到本地服务，
 * 服务端的 `error.hint` 一路带到 UI。这里不重复实现请求封装，
 * 只用 `localRequest` / `appendForm`。
 *
 * 两处刻意的超时设置：
 *  - `transcribe` / `upload` 用 `timeoutMs: 0`（不超时）。首次转写要加载模型，
 *    或按需起一次官方脚本，几十秒是正常的；用默认 30 秒会把正常等待误报成超时。
 *  - `plan` / `catalog` 用有限超时。它们只读常量与查文件，慢就是出问题了。
 */

import { appendForm, localRequest } from '@/lib/local';
import type {
  AsrCatalog,
  AsrDatasetPlan,
  AsrDatasetRequest,
  AsrDatasetSubmitResponse,
  AsrDatasetSummary,
  AsrPipelineStatus,
  AsrResolved,
  AsrTranscribePayload,
  AsrTranscribeResult,
  AsrUploadResponse,
} from '@/types';

/** 一组 ASR 参数（后端 / 尺寸 / 语种 / 精度 / 模型 / 通道） */
export type AsrParams = Partial<
  Pick<AsrResolved, 'backend' | 'size' | 'language' | 'precision' | 'model'> & { channel: string }
>;

export const asrApi = {
  catalog: (baseUrl?: string): Promise<AsrCatalog> =>
    localRequest('/v1/asr/catalog', { method: 'GET', timeoutMs: 30_000 }, baseUrl),

  pipeline: (baseUrl?: string): Promise<AsrPipelineStatus & { ok: boolean }> =>
    localRequest('/v1/asr/pipeline', { method: 'GET', timeoutMs: 20_000 }, baseUrl),

  /** 只算「会怎么跑」，不执行。界面用它在按钮下方回显通道与模型 */
  plan: (payload: AsrParams, baseUrl?: string): Promise<AsrResolved & { ok: boolean }> =>
    localRequest('/v1/asr/plan', { method: 'POST', body: JSON.stringify(payload), timeoutMs: 30_000 }, baseUrl),

  loadModel: (payload: AsrParams, baseUrl?: string): Promise<AsrPipelineStatus & { ok: boolean }> =>
    localRequest(
      '/v1/asr/models/load',
      { method: 'POST', body: JSON.stringify(payload), timeoutMs: 0 },
      baseUrl,
    ),

  unloadModel: (baseUrl?: string): Promise<{ ok: boolean; message: string }> =>
    localRequest('/v1/asr/models/unload', { method: 'POST', timeoutMs: 20_000 }, baseUrl),

  /** 单条转写。音色库里的「一键智能转写」走的就是它 */
  transcribe: (payload: AsrTranscribePayload, baseUrl?: string): Promise<AsrTranscribeResult> => {
    const form = new FormData();
    if (payload.file) form.append('file', payload.file, payload.file.name);
    appendForm(form, {
      source: payload.source,
      backend: payload.backend,
      size: payload.size,
      language: payload.language,
      precision: payload.precision,
      model: payload.model,
      channel: payload.channel,
      use_cache: payload.use_cache ?? true,
    });
    return localRequest('/v1/asr/transcribe', { method: 'POST', body: form, timeoutMs: 0 }, baseUrl);
  },

  /** 批量上传音频，返回落盘路径（供训练入口引用，不上传音频本体） */
  upload: (files: File[], baseUrl?: string): Promise<AsrUploadResponse> => {
    const form = new FormData();
    for (const file of files) form.append('files', file, file.name);
    return localRequest('/v1/asr/upload', { method: 'POST', body: form, timeoutMs: 0 }, baseUrl);
  },

  trainPlan: (payload: AsrDatasetRequest, baseUrl?: string): Promise<AsrDatasetPlan> =>
    localRequest(
      '/v1/asr/train/plan',
      { method: 'POST', body: JSON.stringify(payload), timeoutMs: 60_000 },
      baseUrl,
    ),

  train: (payload: AsrDatasetRequest, baseUrl?: string): Promise<AsrDatasetSubmitResponse> =>
    localRequest('/v1/asr/train', { method: 'POST', body: JSON.stringify(payload), timeoutMs: 0 }, baseUrl),

  datasets: (baseUrl?: string): Promise<{ ok: boolean; datasets: AsrDatasetSummary[] }> =>
    localRequest('/v1/asr/datasets', { method: 'GET', timeoutMs: 20_000 }, baseUrl),
};

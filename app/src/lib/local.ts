/**
 * 本地模型服务（:9881）的轻量请求封装，供语音变声 / 歌声转换客户端共用。
 *
 * 与 `sovits.ts` 的 `request` 同一套约定：默认走同源网关 `/api/sovits`，
 * 服务端的 `error.hint`（「下一步该做什么」）一路带到 UI。
 * 单独抽出来而不是让两个板块各自复制一份，是因为契约细节
 * （超时语义、错误折叠、FormData 处理）只要分叉一次就会漂移。
 */

import { RequestError } from '@/lib/errors';
import { normalizeBaseUrl, readBaseUrl } from '@/lib/sovits';
import type { SovitsErrorBody, SovitsJob } from '@/types';

interface LocalRequestOptions extends RequestInit {
  /** 超时毫秒；0 表示不超时（推理、训练等长任务） */
  timeoutMs?: number;
}

export async function localRequest<T>(path: string, options: LocalRequestOptions = {}, baseUrl?: string): Promise<T> {
  const base = normalizeBaseUrl(baseUrl ?? readBaseUrl());
  const url = `${base}${path}`;
  const { timeoutMs = 120_000, ...init } = options;

  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;

  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        ...(init.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
        ...(init.headers ?? {}),
      },
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new RequestError(504, {
        code: 'LOCAL_TIMEOUT',
        message: '本地服务响应超时。首次请求可能正在加载模型，请稍后重试。',
        retryable: true,
      });
    }
    throw new RequestError(0, {
      code: 'LOCAL_UNREACHABLE',
      message: `无法连接到本地模型服务（${base}）。请确认服务已启动。`,
      retryable: true,
    });
  } finally {
    if (timer) clearTimeout(timer);
  }

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const maybe = payload as { error?: SovitsErrorBody; detail?: SovitsErrorBody } | null;
    const body: SovitsErrorBody =
      maybe?.error ??
      maybe?.detail ?? {
        code: `HTTP_${response.status}`,
        message: text?.slice(0, 300) || `本地服务返回 ${response.status}`,
        retryable: response.status >= 500,
      };
    throw new RequestError(response.status, body);
  }

  return payload as T;
}

/** 轮询任务详情（共用：变声、训练、分离、翻唱都走同一个 /v1/jobs） */
export function fetchJob(jobId: string, baseUrl?: string): Promise<{ ok: boolean; job: SovitsJob }> {
  return localRequest(`/v1/jobs/${jobId}`, { method: 'GET', timeoutMs: 20_000 }, baseUrl);
}

export function cancelJob(jobId: string, baseUrl?: string): Promise<{ ok: boolean; message: string }> {
  return localRequest(
    `/v1/jobs/${jobId}/cancel`,
    { method: 'POST', body: JSON.stringify({ reason: '用户取消' }), timeoutMs: 20_000 },
    baseUrl,
  );
}

/** 多段选择器常用的 multipart 组装 */
export function appendForm(form: FormData, values: Record<string, string | number | boolean | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    form.append(key, String(value));
  }
}

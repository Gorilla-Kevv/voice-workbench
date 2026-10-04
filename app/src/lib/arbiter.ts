import { RequestError } from '@/lib/errors';

/**
 * 资源仲裁（`/api/resources/*`）。
 *
 * 用途：**开跑之前**告诉网关「这次要用哪个引擎」，
 * 网关会把本系统内**另一个**服务上的常驻模型全部卸载，把显存整块让出来。
 *
 * 边界（与服务端一致）：只作用于本项目自己拉起的两个服务
 * （GPT-SoVITS :9881 / 网易 :9882），不触碰电脑上其它任何进程。
 * 别的程序占的显存，仲裁管不了 —— 那部分由资源预估卡提示用户自己关。
 */

export type FocusEngine = 'netease-tts' | 'netease-asr' | 'sovits' | 'training' | 'rvc' | 'svc' | 'uvr5' | 'asr';

export interface FocusReport {
  ok: boolean;
  engine: FocusEngine;
  service: 'sovits' | 'netease';
  released: string[];
  failed: { target: string; reason: string }[];
  targetReachable: boolean;
  hint: string;
}

export interface FocusStatus {
  ok: boolean;
  engine: FocusEngine | null;
  service: 'sovits' | 'netease' | null;
  remainSec: number;
}

async function arbiterRequest<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch {
    throw new RequestError(0, { code: 'GATEWAY_UNREACHABLE', message: '无法连接到本地网关。', retryable: true });
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
    const maybe = payload as { error?: { code: string; message: string; retryable?: boolean; hint?: string } } | null;
    throw new RequestError(
      response.status,
      maybe?.error ?? { code: `HTTP_${response.status}`, message: text?.slice(0, 200) || `网关返回 ${response.status}`, retryable: true },
    );
  }
  return payload as T;
}

export const arbiterApi = {
  /** 把资源集中给某个引擎（默认持有 10 分钟，期间会周期复检另一端） */
  focus: (engine: FocusEngine, holdSeconds = 600): Promise<FocusReport> =>
    arbiterRequest<FocusReport>('/api/resources/focus', {
      method: 'POST',
      body: JSON.stringify({ engine, holdSeconds }),
    }),

  /** 全停：本系统内不留任何常驻模型 */
  releaseAll: (): Promise<FocusReport> =>
    arbiterRequest<FocusReport>('/api/resources/release', { method: 'POST', body: '{}' }),

  status: (): Promise<FocusStatus> => arbiterRequest<FocusStatus>('/api/resources/focus', { method: 'GET' }),
};

/**
 * 在开跑前仲裁一次。
 *
 * 设计上**不因为仲裁失败就阻断任务**：仲裁是「尽力而为」的优化，
 * 真正的准入判断由各服务自己的显存检查负责。所以这里吞掉错误 ——
 * 但会把失败透给调用方，由调用方决定是否提示用户。
 */
export async function focusBeforeRun(engine: FocusEngine): Promise<FocusReport | null> {
  try {
    return await arbiterApi.focus(engine);
  } catch {
    return null;
  }
}

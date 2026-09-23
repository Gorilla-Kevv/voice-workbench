import {
  directHealth,
  directPresets,
  synthesizeDirect,
  validateSampleDirect,
  verifyKeyDirect,
} from './direct-api';
import { RequestError } from './errors';
import type {
  ApiResponse,
  HealthInfo,
  PresetVoice,
  SynthesizePayload,
  SynthesizeResponse,
} from '@/types';

export { RequestError };

/**
 * 接口模式：
 *  - proxy ：经自建后端代理（默认，含站点级限流与服务端密钥支持）
 *  - direct：浏览器直连 MiMo（纯静态部署时使用，无需后端）
 *
 * 通过构建时环境变量 VITE_API_MODE=direct 切换。
 */
export type ApiMode = 'proxy' | 'direct';

export const API_MODE: ApiMode = import.meta.env.VITE_API_MODE === 'direct' ? 'direct' : 'proxy';
export const IS_DIRECT = API_MODE === 'direct';

/** 统一请求封装：解析后端 { ok, data | error } 结构 */
async function request<T>(path: string, init: RequestInit = {}, timeoutMs = 180_000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(path, {
      ...init,
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    });

    const text = await response.text();
    let parsed: ApiResponse<T> | null = null;
    try {
      parsed = text ? (JSON.parse(text) as ApiResponse<T>) : null;
    } catch {
      throw new RequestError(response.status, {
        code: 'BAD_RESPONSE',
        message: '服务端返回了无法解析的数据，请稍后重试',
        retryable: true,
      });
    }

    if (!parsed) {
      throw new RequestError(response.status, { code: 'EMPTY_RESPONSE', message: '服务端未返回数据', retryable: true });
    }

    if (!parsed.ok) {
      throw new RequestError(response.status, parsed.error);
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof RequestError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new RequestError(504, {
        code: 'CLIENT_TIMEOUT',
        message: '请求超时。语音合成耗时较长，若文本较长请开启「长文本自动分段」后重试',
        retryable: true,
      });
    }
    throw new RequestError(0, {
      code: 'NETWORK_ERROR',
      message: '网络请求失败，请检查网络连接或服务是否正常',
      retryable: true,
    });
  } finally {
    clearTimeout(timer);
  }
}

export const api = {
  /** 站点健康信息与限额 */
  health: (): Promise<HealthInfo> =>
    IS_DIRECT ? Promise.resolve(directHealth()) : request<HealthInfo>('/api/health', { method: 'GET' }, 15_000),

  /** 官方预置音色列表 */
  presets: (): Promise<PresetVoice[]> =>
    IS_DIRECT ? Promise.resolve(directPresets()) : request<PresetVoice[]>('/api/voices/presets', { method: 'GET' }, 15_000),

  /** 校验音频样本格式与体积 */
  validateSample: (audio: string) =>
    IS_DIRECT
      ? Promise.resolve(validateSampleDirect(audio))
      : request<{ mimeType: string; bytes: number; maxBytes: number; preview: string }>(
          '/api/voices/sample',
          { method: 'POST', body: JSON.stringify({ audio }) },
          60_000,
        ),

  /** 校验 API Key 是否可用 */
  verifyKey: async (apiKey?: string, baseUrl?: string): Promise<{ valid: boolean; message: string; usingServerKey: boolean }> => {
    if (IS_DIRECT) {
      const result = await verifyKeyDirect(apiKey ?? '', baseUrl);
      return { ...result, usingServerKey: false };
    }
    return request<{ valid: boolean; message: string; usingServerKey: boolean }>(
      '/api/config/verify',
      { method: 'POST', body: JSON.stringify({ apiKey, baseUrl }) },
      60_000,
    );
  },

  /** 语音合成（三种模式统一入口） */
  synthesize: (payload: SynthesizePayload): Promise<SynthesizeResponse> => {
    if (IS_DIRECT) {
      return synthesizeDirect(payload, payload.apiKey ?? '', payload.baseUrl);
    }
    return request<SynthesizeResponse>('/api/tts/synthesize', { method: 'POST', body: JSON.stringify(payload) });
  },
};

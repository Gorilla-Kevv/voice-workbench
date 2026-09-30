import { useCallback, useRef, useState } from 'react';
import { RequestError } from '@/lib/api';
import { getProvider } from '@/lib/providers/registry';
import { base64ToBlob } from '@/lib/audio';
import type { RenderedSegment, SynthesisResult, SynthesizePayload } from '@/types';

interface ResultMeta {
  /** 历史记录中展示的音色名称 */
  voiceLabel: string;
  instruction?: string;
  voiceDescription?: string;
  /** 使用的 Provider id，缺省为 mimo */
  providerId?: string;
  /** Provider 自定义字段 */
  providerFields?: Record<string, string>;
  /** 覆盖设置中的密钥与地址 */
  apiKey?: string;
  baseUrl?: string;
}

interface UseSynthesisOptions {
  onSuccess?: (result: SynthesisResult) => void;
}

export interface SubmissionState {
  loading: boolean;
  error: RequestError | null;
  /** 已等待秒数，用于长耗时提示 */
  elapsed: number;
}

/**
 * 合成请求的统一状态管理：负责调用接口、组装 Blob 与错误分类，
 * 并把可重试的错误原样暴露给 UI。
 */
export type SynthesisController = ReturnType<typeof useSynthesis>;

export function useSynthesis(options: UseSynthesisOptions = {}) {
  const [state, setState] = useState<SubmissionState>({ loading: false, error: null, elapsed: 0 });
  // 多条结果并存：新结果进栈，旧的留在列表里可回看（不再被下一条冲掉）
  const [results, setResults] = useState<SynthesisResult[]>([]);
  const timerRef = useRef<number | null>(null);
  const lastPayloadRef = useRef<{ payload: SynthesizePayload; meta: ResultMeta } | null>(null);
  // 用 ref 持有回调，避免调用方每次渲染重建对象导致 run 频繁重建
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const stopTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const run = useCallback(
    async (payload: SynthesizePayload, meta: ResultMeta): Promise<SynthesisResult | null> => {
      lastPayloadRef.current = { payload, meta };
      stopTimer();
      setState({ loading: true, error: null, elapsed: 0 });
      timerRef.current = window.setInterval(() => {
        setState((prev) => (prev.loading ? { ...prev, elapsed: prev.elapsed + 1 } : prev));
      }, 1_000);

      try {
        // 统一经 Provider 层分发：默认走 MiMo 既有链路，其余 Provider 各自适配
        const provider = getProvider(meta.providerId);
        const modelId =
          provider.models.find((item) => item.mode === payload.mode)?.id ?? provider.defaultModel;
        const response = await provider.synthesize(
          {
            mode: payload.mode,
            model: modelId,
            text: payload.text,
            instruction: payload.instruction,
            voice: payload.voice,
            optimizeTextPreview: payload.optimizeTextPreview,
            autoSegment: payload.autoSegment,
          },
          {
            apiKey: meta.apiKey ?? payload.apiKey ?? '',
            baseUrl: meta.baseUrl ?? payload.baseUrl,
            fields: meta.providerFields,
          },
        );
        // 每段独立生成 Blob 与播放地址，便于逐段试听、单独下载与打包导出
        const segments: RenderedSegment[] = response.segments.map((segment) => {
          const blob = base64ToBlob(segment.audio, response.mimeType || 'audio/wav');
          return { ...segment, blob, url: URL.createObjectURL(blob) };
        });

        const synthesisResult: SynthesisResult = {
          id: createId(),
          mode: response.mode,
          text: response.text,
          instruction: meta.instruction,
          voiceDescription: meta.voiceDescription,
          voiceLabel: meta.voiceLabel,
          model: response.model,
          format: response.format,
          bytes: response.bytes,
          durationSec: response.durationSec,
          segmented: response.segmented,
          segmentCount: response.segmentCount,
          createdAt: Date.now(),
          segments,
        };

        // 入栈而不是替换：旧结果保留，只有用户显式删除或超出上限时才释放它的 Blob 地址
        setResults((prev) => {
          const next = [synthesisResult, ...prev];
          next.slice(MAX_RESULTS).forEach((old) => releaseResult(old));
          return next.slice(0, MAX_RESULTS);
        });
        setState({ loading: false, error: null, elapsed: 0 });
        optionsRef.current.onSuccess?.(synthesisResult);
        return synthesisResult;
      } catch (error) {
        const requestError =
          error instanceof RequestError
            ? error
            : new RequestError(0, {
                code: 'UNKNOWN',
                message: error instanceof Error ? error.message : '合成失败，请稍后重试',
                retryable: true,
              });
        setState({ loading: false, error: requestError, elapsed: 0 });
        return null;
      } finally {
        stopTimer();
      }
    },
    [stopTimer],
  );

  /** 使用上次参数重新发起请求，用于错误重试 */
  const retry = useCallback(async () => {
    const last = lastPayloadRef.current;
    if (!last) return null;
    return run(last.payload, last.meta);
  }, [run]);

  const clearError = useCallback(() => setState((prev) => ({ ...prev, error: null })), []);

  /** 删除单条结果（会释放它的临时播放地址） */
  const removeResult = useCallback((id: string) => {
    setResults((prev) => {
      const target = prev.find((item) => item.id === id);
      if (target) releaseResult(target);
      return prev.filter((item) => item.id !== id);
    });
  }, []);

  const clearResults = useCallback(() => {
    setResults((prev) => {
      prev.forEach(releaseResult);
      return [];
    });
  }, []);

  return {
    ...state,
    results,
    /** 最新一条，兼容只关心「当前结果」的调用方 */
    result: results[0] ?? null,
    run,
    retry,
    clearError,
    removeResult,
    clearResults,
  };
}

/** 一个页面里最多保留多少条结果（超出丢最旧的） */
const MAX_RESULTS = 12;

/** 释放某条结果占用的临时播放地址 */
function releaseResult(result: SynthesisResult): void {
  result.segments.forEach((segment) => URL.revokeObjectURL(segment.url));
}

/** 生成本地唯一 ID */
export function createId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

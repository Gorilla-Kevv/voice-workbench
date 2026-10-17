import { useCallback, useMemo, useRef, useState } from 'react';
import { RequestError } from '@/lib/api';
import { getProvider } from '@/lib/providers/registry';
import { base64ToBlob } from '@/lib/audio';
import type { RenderedSegment, SynthesisResult, SynthesizePayload } from '@/types';
import { createId, useResultStack } from '@/hooks/useResultStack';

// 重新导出：老的调用方一直从这儿拿 createId（hooks/useResultStack 是真正的定义处）
export { createId };

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
  /*
   * 结果走全站统一的结果栈底座（useResultStack）：
   * - 模块级缓存让「切到别的页面再切回来」结果仍在 —— App.tsx 按导航键条件渲染，纯 state 会被整页卸载清掉；
   * - 结果里全是 Blob 播放地址，刷新后必然失效，所以**不传 serialize**、不做 sessionStorage 持久化
   *   （坑 18：Blob 类结果配 serialize 是必坑项）；刷新后的回看由 IndexedDB 历史记录承担；
   * - 淘汰 / 删除时由 onEvict 释放播放地址，行为与旧实现等价，只是把账交给底座管。
   */
  const resultStack = useResultStack<SynthesisResult>({ storageKey: 'synthesis-results', onEvict: releaseResult });
  // push/remove/clear 都是底座内部 useCallback 的稳定引用，解构出来既好用也让 deps 静态可读
  const { push: pushResult, entries: stackEntries, remove: removeStackEntry, clear: clearStack } = resultStack;
  const results = useMemo(() => stackEntries.map((entry) => entry.item), [stackEntries]);
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
        pushResult(synthesisResult);
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
    [stopTimer, pushResult],
  );

  /** 使用上次参数重新发起请求，用于错误重试 */
  const retry = useCallback(async () => {
    const last = lastPayloadRef.current;
    if (!last) return null;
    return run(last.payload, last.meta);
  }, [run]);

  const clearError = useCallback(() => setState((prev) => ({ ...prev, error: null })), []);

  /**
   * 删除单条结果。对外仍按 SynthesisResult.id 寻址（ResultPanel 等调用方只认识它），
   * 在这里翻译成结果栈的 entry id。
   */
  const removeResult = useCallback(
    (id: string) => {
      const entry = stackEntries.find((item) => item.item.id === id);
      if (entry) removeStackEntry(entry.id);
    },
    [stackEntries, removeStackEntry],
  );

  return {
    ...state,
    results,
    /** 最新一条，兼容只关心「当前结果」的调用方 */
    result: results[0] ?? null,
    run,
    retry,
    clearError,
    removeResult,
    clearResults: clearStack,
  };
}

/** 释放某条结果占用的临时播放地址 */
function releaseResult(result: SynthesisResult): void {
  result.segments.forEach((segment) => URL.revokeObjectURL(segment.url));
}

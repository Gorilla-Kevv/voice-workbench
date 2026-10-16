import { useCallback, useEffect, useState } from 'react';
import { irodoriApi } from '@/lib/irodori';
import type { IrodoriJob } from '@/types';

/** 终态：到了就停轮询（与服务端 `JobState` 一致） */
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

/** 把秒说成人话：ETA 是给用户看的，别让他自己换算 */
export function formatEta(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  if (minutes > 0) return `${minutes} 分 ${secs} 秒`;
  return `${secs} 秒`;
}

export interface UseIrodoriJobResult {
  job: IrodoriJob | null;
  /** 查询任务本身失败（不是任务失败）时的提示 */
  error: string | null;
  cancel: () => Promise<void>;
  cancelling: boolean;
  /** 按「已用时间 / 已完成的比例」外推的剩余时间文案；拿不准就是 null */
  etaText: string | null;
  running: boolean;
}

/**
 * 轮询 Irodori 的 JobStore（整备 / 训练两条任务共用）。
 *
 * 为什么不停在 1.5s：训练一步通常 0.5~2s，1.5s 一拍既不漏进度也不至于刷屏；
 * 而**终态立即停** —— 用户看的是「跑完没」，不是「再刷一遍日志」。
 *
 * ETA 是本地外推的（服务端没有这条字段）：`已用时间 × (1 - 进度) / 进度`。
 * 它是估算不是承诺，所以 UI 里写成「预计还需」而不是倒计时。
 */
export function useIrodoriJob(jobId: string | null, pollMs = 1500): UseIrodoriJobResult {
  const [job, setJob] = useState<IrodoriJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!jobId) {
      setJob(null);
      setError(null);
      return;
    }
    let stopped = false;
    let timer: number | undefined;

    const poll = async () => {
      try {
        const { job: next } = await irodoriApi.job(jobId);
        if (stopped) return;
        setJob(next);
        setError(null);
        if (TERMINAL.has(next.state)) return; // 终态：停
      } catch (cause) {
        if (!stopped) setError(cause instanceof Error ? cause.message : String(cause));
      }
      timer = window.setTimeout(poll, pollMs);
    };

    void poll();
    // ETA 每秒重算一次（进度没变也要走时间）
    const clock = window.setInterval(() => setTick((value) => value + 1), 1000);
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
      window.clearInterval(clock);
    };
  }, [jobId, pollMs]);

  const cancel = useCallback(async () => {
    if (!jobId) return;
    setCancelling(true);
    try {
      const { job: next } = await irodoriApi.cancelJob(jobId);
      setJob(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCancelling(false);
    }
  }, [jobId]);

  const running = job !== null && !TERMINAL.has(job.state);
  let etaText: string | null = null;
  if (running && job && job.progress > 0.02 && job.started_at) {
    const elapsedSec = (Date.now() - job.started_at) / 1000;
    const remaining = (elapsedSec * (1 - job.progress)) / job.progress;
    // 前 10% 的外推极不稳定（模型还在加载），不给用户一个会乱跳的数字
    if (job.progress > 0.1) etaText = formatEta(remaining);
  }
  void tick;

  return { job, error, cancel, cancelling, etaText, running };
}

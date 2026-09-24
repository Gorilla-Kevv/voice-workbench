import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Loader2, OctagonAlert, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { cancelJob, fetchJob } from '@/lib/local';
import type { SovitsJob } from '@/types';

interface JobPanelProps {
  /** 要跟踪的任务号；null 表示当前没有任务 */
  jobId: string | null;
  /** 任务完成时的回调（携带终态任务，含 artifacts） */
  onComplete?: (job: SovitsJob) => void;
  /** 强调色类名，用于进度条与图标（如 text-indigo-500） */
  accent?: string;
  /** 展示的标题 */
  title?: string;
}

const TERMINAL_STATES = new Set(['succeeded', 'failed', 'cancelled']);

/**
 * 通用任务面板：轮询 `/v1/jobs/{id}`，展示进度、阶段消息与日志，支持取消。
 *
 * 变声、训练、分离、翻唱四种任务共用 —— 它们的差异只在产物渲染上，
 * 而「进度 + 日志 + 取消」这三件事完全一样，抽成一个组件避免四份拷贝。
 */
export function JobPanel({ jobId, onComplete, accent = 'text-indigo-500', title = '任务进度' }: JobPanelProps) {
  const [job, setJob] = useState<SovitsJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const completedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!jobId) {
      setJob(null);
      setError(null);
      return;
    }
    let cancelled = false;
    let timer: number | undefined;

    const poll = async () => {
      try {
        const { job: next } = await fetchJob(jobId);
        if (cancelled) return;
        setJob(next);
        setError(null);
        if (TERMINAL_STATES.has(next.state)) {
          if (completedRef.current !== next.id && next.state === 'succeeded') {
            completedRef.current = next.id;
            onComplete?.(next);
          }
          return; // 终态：停止轮询
        }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
      timer = window.setTimeout(poll, 1500);
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
    // onComplete 变化不应重启轮询，用 ref 语义规避；jobId 才是驱动源
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  if (!jobId) return null;

  const running = job !== null && !TERMINAL_STATES.has(job.state);
  const failed = job?.state === 'failed';
  const succeeded = job?.state === 'succeeded';

  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {succeeded ? (
            <CheckCircle2 className="size-4 shrink-0 text-emerald-500" />
          ) : failed ? (
            <OctagonAlert className="size-4 shrink-0 text-destructive" />
          ) : (
            <Loader2 className={`size-4 shrink-0 animate-spin ${accent}`} />
          )}
          <p className="truncate text-sm font-medium">
            {job?.name ?? title}
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {running ? `${Math.round((job?.progress ?? 0) * 100)}%` : job?.state === 'succeeded' ? '完成' : job?.state === 'failed' ? '失败' : job?.state === 'cancelled' ? '已取消' : '排队中'}
            </span>
          </p>
        </div>
        {running ? (
          <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs" onClick={() => void cancelJob(jobId)}>
            <X className="size-3" /> 取消
          </Button>
        ) : null}
      </div>

      <Progress value={(job?.progress ?? 0) * 100} className="mt-3 h-1.5" />

      {job?.message ? <p className="mt-2 truncate text-xs text-muted-foreground">{job.message}</p> : null}
      {failed && job?.error ? <p className="mt-2 text-xs text-destructive">{job.error}</p> : null}
      {error ? <p className="mt-2 text-xs text-amber-600">状态查询失败：{error}</p> : null}

      {job?.logs && job.logs.length > 0 ? (
        <div className="scrollbar-thin mt-3 max-h-28 overflow-y-auto rounded-lg bg-muted/60 p-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
          {job.logs.slice(-40).map((line, index) => (
            <p key={`${line.ts}-${index}`} className="truncate">
              {line.text}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

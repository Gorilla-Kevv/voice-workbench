import { useEffect, useRef } from 'react';
import { CheckCircle2, Loader2, OctagonAlert, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { useIrodoriJob } from '@/hooks/useIrodoriJob';
import type { IrodoriJob } from '@/types';
import { cn } from '@/lib/utils';

interface IrodoriJobPanelProps {
  /** 要跟踪的任务号；null = 当前没有任务 */
  jobId: string | null;
  /** 任务到达终态时的回调（携带终态任务，含 artifacts） */
  onComplete?: (job: IrodoriJob) => void;
  /** 强调色类名 */
  accent?: string;
  title?: string;
  /** 日志区最大高度 */
  logMaxHeight?: string;
}

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

const STATE_TEXT: Record<string, string> = {
  queued: '排队中',
  running: '进行中',
  succeeded: '完成',
  failed: '失败',
  cancelled: '已取消',
};

/**
 * Irodori 的任务面板：轮询 `/v1/jobs/{id}`，显示阶段、进度、ETA 与日志，可取消。
 *
 * 为什么没复用 `JobPanel`（那个走 GPT-SoVITS 的 `/v1/jobs`）：**两个 JobStore 在
 * 不同的服务里**，字段只到「同名同形」为止 —— 训练这边的 `stages` 是四个业务阶段
 * （plan / train / save / register），而变声那边没有。硬塞进同一个组件，
 * 就得往 SovitsJob 上挂一堆可选字段，两边都变脏。真正共用的「轮询」抽成了
 * `useIrodoriJob` hook —— 那部分确实是同一个问题，不该写两遍。
 */
export function IrodoriJobPanel({
  jobId,
  onComplete,
  accent = 'text-violet-500',
  title = '任务进度',
  logMaxHeight = '10rem',
}: IrodoriJobPanelProps) {
  const { job, error, cancel, cancelling, etaText, running } = useIrodoriJob(jobId);
  const firedRef = useRef<string | null>(null);

  // 终态只回调一次：父级通常要读 artifacts 去刷新音色列表，
  // 重复回调会让它在任务结束后还在反复刷新。
  useEffect(() => {
    if (!job || !TERMINAL.has(job.state)) return;
    if (firedRef.current === job.id) return;
    firedRef.current = job.id;
    onComplete?.(job);
  }, [job, onComplete]);

  if (!jobId) return null;

  const succeeded = job?.state === 'succeeded';
  const failed = job?.state === 'failed';

  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {succeeded ? (
            <CheckCircle2 className="size-4 shrink-0 text-emerald-500" />
          ) : failed ? (
            <OctagonAlert className="size-4 shrink-0 text-destructive" />
          ) : (
            <Loader2 className={cn('size-4 shrink-0 animate-spin', accent)} />
          )}
          <p className="truncate text-sm font-medium">
            {job?.name ?? title}
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {job ? (STATE_TEXT[job.state] ?? job.state) : '连接中'}
              {job && !TERMINAL.has(job.state) ? ` · ${Math.round((job.progress ?? 0) * 100)}%` : ''}
            </span>
          </p>
        </div>
        {running ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-xs"
            disabled={cancelling}
            onClick={() => void cancel()}
          >
            <X className="size-3" />
            {cancelling ? '取消中…' : '取消'}
          </Button>
        ) : null}
      </div>

      <Progress value={(job?.progress ?? 0) * 100} className="mt-3 h-1.5" />

      {/* 四个业务阶段：训练是几十分钟级的任务，用户最想知道的是「现在到哪一步了」 */}
      {job && job.stages.length > 0 ? (
        <ol className="mt-3 space-y-1">
          {job.stages.map((stage) => (
            <li key={stage.key} className="flex items-start gap-2 text-xs">
              <span
                className={cn(
                  'mt-[3px] size-2 shrink-0 rounded-full',
                  stage.state === 'succeeded'
                    ? 'bg-emerald-500'
                    : stage.state === 'failed'
                      ? 'bg-destructive'
                      : stage.state === 'running'
                        ? 'bg-violet-500'
                        : 'bg-muted-foreground/40',
                )}
              />
              <span className="min-w-0 flex-1">
                <span className="font-medium">{stage.label}</span>
                {stage.detail ? (
                  <span className="ml-2 text-muted-foreground">{stage.detail}</span>
                ) : null}
              </span>
            </li>
          ))}
        </ol>
      ) : null}

      {job?.message ? <p className="mt-2 text-xs text-muted-foreground">{job.message}</p> : null}
      {etaText ? <p className="mt-1 text-xs text-muted-foreground">预计还需 {etaText}</p> : null}
      {failed && job?.error ? <p className="mt-2 text-xs text-destructive">{job.error}</p> : null}
      {error ? <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">状态查询失败：{error}</p> : null}

      {job?.logs && job.logs.length > 0 ? (
        <div
          className="scrollbar-thin mt-3 overflow-y-auto rounded-lg bg-muted/60 p-2 font-mono text-[11px] leading-relaxed text-muted-foreground"
          style={{ maxHeight: logMaxHeight }}
        >
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

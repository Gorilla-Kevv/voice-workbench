import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Gauge, HardDrive, Loader2, RefreshCw, Sparkles } from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  RESOURCE_TASK_LABEL,
  estimateTask,
  fetchResourceSnapshot,
  releaseVram,
  type ResourceSnapshot,
  type ResourceTask,
} from '@/lib/resources';

/**
 * 资源预估卡：跑之前把「这一发要吃多少、还剩多少」摆在明面上。
 *
 * 三条设计约束：
 * 1. **先给数字再给结论** —— 用户要的是「训练要 6 GB，你现在只有 2 GB」，
 *    而不是一句「资源可能不足」；
 * 2. **建议必须能动手** —— 「释放显存」是真能点的按钮，「降低配置」给具体参数，
 *    不给「请优化配置」这种废话；
 * 3. **拿不到数据就说不知道**（unknown），不编一个乐观结论骗人。
 */

function gb(mb: number | null | undefined): string {
  if (mb == null) return '未知';
  return `${(mb / 1024).toFixed(1)} GB`;
}

interface ResourceBudgetProps {
  task: ResourceTask;
  /** 网易引擎是否已加载（决定「释放显存」按钮要不要卸它） */
  neteaseTtsLoaded?: boolean;
  neteaseAsrLoaded?: boolean;
  className?: string;
}

export function ResourceBudget({
  task,
  neteaseTtsLoaded = false,
  neteaseAsrLoaded = false,
  className,
}: ResourceBudgetProps) {
  const [snapshot, setSnapshot] = useState<ResourceSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = await fetchResourceSnapshot();
      if (mounted.current) setSnapshot(next);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const estimate = useMemo(
    () => (snapshot ? estimateTask(task, snapshot) : null),
    [snapshot, task],
  );

  const handleRelease = useCallback(async () => {
    setReleasing(true);
    try {
      const done = await releaseVram({ neteaseTtsLoaded, neteaseAsrLoaded });
      if (done.length > 0) {
        toast.success('已释放显存', { description: done.join(' · ') });
      } else {
        toast.info('没有可释放的常驻引擎', { description: '显存多半是被别的程序占着（浏览器 / 模拟器）。' });
      }
      await refresh();
    } finally {
      setReleasing(false);
    }
  }, [neteaseAsrLoaded, neteaseTtsLoaded, refresh]);

  if (!snapshot && loading) {
    return (
      <div className={cn('flex items-center gap-2 rounded-lg border p-3 text-xs text-muted-foreground', className)}>
        <Loader2 className="size-3.5 animate-spin" />
        正在评估资源占用…
      </div>
    );
  }

  if (!estimate) return null;

  const tone =
    estimate.verdict === 'insufficient'
      ? 'border-destructive/40 bg-destructive/5 text-destructive'
      : estimate.verdict === 'tight'
        ? 'border-amber-500/40 bg-amber-500/5 text-amber-700 dark:text-amber-400'
        : 'border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400';

  const Icon =
    estimate.verdict === 'insufficient' ? AlertTriangle : estimate.verdict === 'tight' ? Gauge : CheckCircle2;

  return (
    <div className={cn('space-y-2 rounded-lg border p-3 text-xs', className)}>
      {/* 第一行：账本。数字先出来，结论后出来 */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <span className="flex items-center gap-1.5 font-medium">
          <Sparkles className="size-3.5" />
          {RESOURCE_TASK_LABEL[task]}资源预估
        </span>
        <span className="flex items-center gap-1 text-muted-foreground">
          <Gauge className="size-3.5" />
          <span className="font-mono">显存
            需要 {gb(estimate.vram_need_mb)} · 空闲 {gb(estimate.vram_free_mb)}
            {snapshot?.vram_total_mb ? ` / 共 ${gb(snapshot.vram_total_mb)}` : ''}
          </span>
        </span>
        <span className="flex items-center gap-1 text-muted-foreground">
          <HardDrive className="size-3.5" />
          <span className="font-mono">
            内存约 {gb(estimate.ram_need_mb)} · 空闲 {gb(estimate.ram_free_mb)}
          </span>
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto h-6 px-1.5 text-[11px]"
          onClick={() => void refresh()}
          disabled={loading}
        >
          {loading ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
          重新评估
        </Button>
      </div>

      {/* 第二行：结论 */}
      <div className={cn('flex items-start gap-2 rounded-md border px-2 py-1.5', tone)}>
        <Icon className="mt-0.5 size-3.5 shrink-0" />
        <div className="min-w-0">
          {estimate.verdict === 'insufficient' ? (
            <p className="font-medium">
              显存不足：还差约 {gb(estimate.gap_mb)}，直接跑大概率中途 OOM
            </p>
          ) : estimate.verdict === 'tight' ? (
            <p className="font-medium">勉强够用：余量不到 1 GB，跑长任务可能被挤到很慢或失败</p>
          ) : estimate.verdict === 'unknown' ? (
            <p className="font-medium">拿不到显存读数（服务没起？），无法判断够不够</p>
          ) : (
            <p className="font-medium">资源充足，可以直接跑</p>
          )}

          {snapshot?.vram_source === 'nvidia-smi' && snapshot.vram_free_mb != null && snapshot.vram_total_mb ? (
            <p className="mt-0.5 opacity-80">
              读数来自 nvidia-smi（含其它进程占用）
              {snapshot.active_engine ? ` · 当前本地引擎：${snapshot.active_engine}` : ''}
            </p>
          ) : null}
        </div>
      </div>

      {/* 第三行：能动手的建议 */}
      {estimate.verdict !== 'ok' ? (
        <div className="space-y-1.5">
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => void handleRelease()} disabled={releasing}>
              {releasing ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
              释放常驻显存
            </Button>
            {estimate.suggestions.map((item) => (
              <Badge key={item.kind} variant="secondary" className="h-7 px-2 text-[11px] font-normal">
                {item.label}
              </Badge>
            ))}
          </div>
          <ul className="space-y-1 text-[11px] text-muted-foreground">
            {estimate.suggestions.map((item) => (
              <li key={item.kind}>
                <span className="font-medium text-foreground">{item.label}：</span>
                {item.detail}
              </li>
            ))}
            <li>
              <span className="font-medium text-foreground">释放资源：</span>
              点上面的按钮卸掉网易 / 本地常驻引擎；显存还被别的程序占着的话，
              关掉浏览器硬件加速、安卓模拟器或游戏。
            </li>
          </ul>
        </div>
      ) : null}
    </div>
  );
}

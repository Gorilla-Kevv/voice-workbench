import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Loader2, MonitorDot, RefreshCw, ShieldAlert, XCircle } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { fetchGpuProcesses, killGpuProcess, type GpuProcessGroup } from '@/lib/resources';
import { cn } from '@/lib/utils';

/**
 * 显存占用监控小窗（阶段 26补9）。
 *
 * 存在的理由：8 GB 卡上常年挂着 30+ 个 GPU 进程（模拟器 / 浏览器 / 桌面美化…），
 * 报错只说「显存不足」时用户根本不知道该关谁。这里把 nvidia-smi 的进程表摊开，
 * **大户高亮排序**，并允许右键停掉选中的进程。
 *
 * 两条诚实约束：
 * 1. Windows WDDM 下每进程显存读数经常拿不到 —— 拿不到就显示「未知」，绝不编数；
 * 2. 停止走网关护栏接口：pid 必须在最近一次 nvidia-smi 快照里，系统关键进程一律拒绝。
 */

const HEAVY_MB = 1024;
const MID_MB = 300;

function memLabel(mb: number | null): string {
  if (mb == null) return '未知';
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb} MB`;
}

export function GpuMonitorWindow({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [groups, setGroups] = useState<GpuProcessGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyPid, setBusyPid] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setGroups(await fetchGpuProcesses());
      setNotice(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  const stop = useCallback(
    async (pids: number[], label: string) => {
      const scope = pids.length > 1 ? `${label} 的全部 ${pids.length} 个实例` : `${label}（pid ${pids[0]}）`;
      if (!window.confirm(`确定停止 ${scope} 吗？未保存的内容会一起丢掉。`)) return;
      setBusyPid(pids[0]);
      const results: string[] = [];
      for (const pid of pids) {
        try {
          const result = await killGpuProcess(pid);
          results.push(result.hint ? `${result.message} · ${result.hint}` : result.message);
        } catch (error) {
          results.push((error as Error).message.split('\n')[0]);
        }
      }
      setBusyPid(null);
      setNotice(results.join('；'));
      await refresh();
    },
    [refresh],
  );

  const totalMem = groups.reduce((sum, group) => sum + (group.mem_mb ?? 0), 0);
  const totalInstances = groups.reduce((sum, group) => sum + group.count, 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <MonitorDot className="size-4 text-violet-600 dark:text-violet-400" />
            显存占用监控
          </DialogTitle>
          <DialogDescription>
            读数来自 nvidia-smi（10 秒缓存）。<strong>右键一行</strong>可停止该进程；
            本项目自己的 python 服务进程在列属正常，停掉它们只会让对应模型下线。
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <p>
            {groups.length} 类程序 · {totalInstances} 个进程
            {totalMem > 0 ? ` · 可读显存合计 ${memLabel(totalMem)}` : ''}
          </p>
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => void refresh()} disabled={loading}>
            {loading ? <Loader2 className="mr-1.5 size-3 animate-spin" /> : <RefreshCw className="mr-1.5 size-3" />}
            刷新
          </Button>
        </div>

        {notice ? (
          <p className="flex items-start gap-1.5 rounded-md border bg-muted/40 px-2 py-1.5 text-[11px]">
            <AlertTriangle className="mt-0.5 size-3 shrink-0 text-amber-600 dark:text-amber-400" />
            <span className="min-w-0 break-words">{notice}</span>
          </p>
        ) : null}

        {groups.length === 0 && !loading ? (
          <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            没读到 GPU 进程（nvidia-smi 不可用，或当前没有程序挂在 GPU 上）。
          </p>
        ) : (
          <div className="scrollbar-thin max-h-[46vh] space-y-1 overflow-y-auto pr-1">
            {groups.map((group) => {
              const heavy = (group.mem_mb ?? 0) >= HEAVY_MB;
              const mid = !heavy && (group.mem_mb ?? 0) >= MID_MB;
              const share = totalMem > 0 && group.mem_mb != null ? Math.min(100, (group.mem_mb / totalMem) * 100) : null;
              return (
                <ContextMenu key={group.name}>
                  <ContextMenuTrigger asChild>
                    <div
                      className={cn(
                        'rounded-md border px-2.5 py-2 text-xs transition select-none',
                        heavy
                          ? 'border-destructive/40 bg-destructive/5'
                          : mid
                            ? 'border-amber-500/40 bg-amber-500/5'
                            : 'bg-muted/20 hover:bg-muted/50',
                        busyPid != null && group.pids.includes(busyPid) && 'opacity-60',
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate font-mono font-medium">{group.name}</span>
                        {group.count > 1 ? (
                          <Badge variant="secondary" className="h-4 shrink-0 px-1.5 font-mono text-[10px]">
                            ×{group.count}
                          </Badge>
                        ) : null}
                        {heavy ? (
                          <Badge className="h-4 shrink-0 bg-destructive/15 px-1.5 text-[10px] font-normal text-destructive">
                            <XCircle className="mr-1 size-2.5" />
                            显存大户
                          </Badge>
                        ) : mid ? (
                          <Badge className="h-4 shrink-0 bg-amber-500/15 px-1.5 text-[10px] font-normal text-amber-700 dark:text-amber-400">
                            占用不小
                          </Badge>
                        ) : null}
                        <span className="w-20 shrink-0 text-right font-mono tabular-nums">
                          {memLabel(group.mem_mb)}
                        </span>
                      </div>
                      {share != null ? (
                        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted">
                          <div
                            className={cn('h-full rounded-full', heavy ? 'bg-destructive/70' : mid ? 'bg-amber-500/70' : 'bg-violet-500/60')}
                            style={{ width: `${Math.max(share, 2)}%` }}
                          />
                        </div>
                      ) : null}
                      <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground">
                        pid: {group.pids.join(', ')}
                        {group.mem_mb == null ? ' · WDDM 读不到该程序的显存数（只报谁在与实例数）' : ''}
                      </p>
                    </div>
                  </ContextMenuTrigger>
                  <ContextMenuContent className="w-64">
                    <ContextMenuLabel className="font-mono text-[11px]">{group.name}</ContextMenuLabel>
                    <ContextMenuSeparator />
                    {group.pids.map((pid) => (
                      <ContextMenuItem
                        key={pid}
                        className="text-xs text-destructive focus:text-destructive"
                        onSelect={() => void stop([pid], group.name)}
                      >
                        <ShieldAlert className="mr-1.5 size-3.5" />
                        停止进程 pid {pid}
                        {busyPid === pid ? '（执行中…）' : ''}
                      </ContextMenuItem>
                    ))}
                    {group.pids.length > 1 ? (
                      <ContextMenuItem
                        className="text-xs text-destructive focus:text-destructive"
                        onSelect={() => void stop(group.pids, group.name)}
                      >
                        <XCircle className="mr-1.5 size-3.5" />
                        停止全部 {group.pids.length} 个实例
                      </ContextMenuItem>
                    ) : null}
                  </ContextMenuContent>
                </ContextMenu>
              );
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

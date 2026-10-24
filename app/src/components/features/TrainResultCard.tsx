import { useState } from 'react';
import { FolderOpen, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { VcTrainArtifact, VcTrainRecord } from '@/types';

/**
 * 训练结果面板（RVC / DDSP-SVC 共用）。
 *
 * 这解决的是用户 2026-10 报的问题：「训练的结果在网站重启之后就没了」。
 * 真相是**产物一直在磁盘上、任务记录也一直在**（服务端写 `trainer/.data/jobs/`），
 * 但前端此前只在训练 Tab 的局部 state 里记着 `jobId`，组件一卸载就断了线索。
 * 现在挂载时就去服务端把训练历史拉回来 —— 刷新、重启浏览器、甚至重启服务，
 * 记录都还在。数据由 `useTrainHistory` 提供，本组件只负责渲染。
 */

interface TrainResultCardProps {
  records: VcTrainRecord[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
  title?: string;
  description?: string;
  emptyHint?: string;
  accentText?: string;
  /** 提供时，model 产物显示「改名」按钮（RVC 用；DDSP-SVC 暂不支持） */
  onRename?: (artifact: VcTrainArtifact) => void;
}

/** 产物类型 → 图标与配色 */
const ARTIFACT_STYLE: Record<string, { label: string; className: string }> = {
  model: { label: '模型', className: 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400' },
  adapter: { label: 'LoRA', className: 'bg-violet-500/10 text-violet-600 dark:text-violet-400' },
  index: { label: '索引', className: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' },
  config: { label: '配置', className: 'bg-amber-500/10 text-amber-600 dark:text-amber-400' },
};

export function TrainResultCard({
  records,
  loading,
  error,
  refresh,
  title = '训练结果',
  description = '历次训练产出的模型 / 适配器 / 索引。记录来自本地服务（重启后仍在），点路径文字可复制。',
  emptyHint = '还没有训练记录。上面跑一次训练，产物会自动出现在这里。',
  accentText = 'text-indigo-500 dark:text-indigo-400',
  onRename,
}: TrainResultCardProps) {
  const [copied, setCopied] = useState<string | null>(null);

  const copyPath = async (path: string) => {
    try {
      await navigator.clipboard.writeText(path);
      setCopied(path);
      window.setTimeout(() => setCopied((prev) => (prev === path ? null : prev)), 1500);
    } catch {
      toast.error('复制失败', { description: '浏览器拒绝了剪贴板访问，请手动选中路径复制。' });
    }
  };

  const total = records.reduce((sum, record) => sum + record.artifacts.length, 0);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <FolderOpen className={`size-4 ${accentText}`} /> {title}
            </CardTitle>
            <CardDescription>{description}</CardDescription>
          </div>
          <Button variant="ghost" size="sm" className="h-7 shrink-0 text-xs text-muted-foreground" onClick={refresh}>
            刷新
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {error ? <p className="text-xs text-destructive">读取训练记录失败：{error}</p> : null}
        {loading && records.length === 0 ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" /> 正在读取训练记录…
          </p>
        ) : records.length === 0 ? (
          <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">{emptyHint}</p>
        ) : (
          <div className="space-y-2">
            <p className="text-[11px] text-muted-foreground">
              共 {records.length} 次训练 · {total} 件产物
            </p>
            {records.map((record) => (
              <div key={record.jobId} className="rounded-lg border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-sm font-medium">{record.name}</span>
                  <Badge variant="outline" className="shrink-0 text-[11px]">{record.mode}</Badge>
                  <Badge
                    variant="outline"
                    className={cn(
                      'shrink-0 text-[11px]',
                      record.state === 'succeeded'
                        ? 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400'
                        : record.state === 'failed'
                          ? 'border-destructive/40 text-destructive'
                          : 'text-muted-foreground',
                    )}
                  >
                    {record.state === 'succeeded' ? '成功' : record.state === 'failed' ? '失败' : record.state === 'cancelled' ? '已取消' : record.state}
                  </Badge>
                  <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                    {formatTime(record.createdAt)}
                  </span>
                </div>

                {record.state === 'failed' && record.error ? (
                  <p className="mt-2 whitespace-pre-wrap rounded bg-destructive/5 p-2 text-[11px] text-destructive">
                    {record.error}
                  </p>
                ) : null}

                {record.artifacts.length === 0 ? (
                  <p className="mt-2 text-xs text-muted-foreground">这次训练没有产出可展示的产物。</p>
                ) : (
                  <ul className="mt-2 space-y-1.5">
                    {record.artifacts.map((artifact) => {
                      const style = ARTIFACT_STYLE[artifact.kind] ?? { label: '产物', className: 'bg-muted text-muted-foreground' };
                      return (
                        <li key={artifact.path} className="flex items-start gap-2">
                          <span className={cn('mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium', style.className)}>
                            {style.label}
                          </span>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-xs font-medium">{artifact.label}</p>
                            <button
                              type="button"
                              className="block w-full truncate text-left font-mono text-[11px] text-muted-foreground transition hover:text-foreground"
                              title="点击复制完整路径"
                              onClick={() => void copyPath(artifact.path)}
                            >
                              {artifact.path}
                            </button>
                          </div>
                          <span className="shrink-0 text-[11px] text-muted-foreground">
                            {copied === artifact.path ? '已复制' : `${artifact.size_mb}MB`}
                          </span>
                          {onRename && artifact.kind === 'model' ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-6 shrink-0 px-2 text-[11px]"
                              onClick={() => onRename(artifact)}
                            >
                              改名
                            </Button>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** 训练记录的时间戳（毫秒）→ 本地时间简写 */
function formatTime(ms: number): string {
  if (!ms) return '—';
  const date = new Date(ms);
  return `${date.getMonth() + 1}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

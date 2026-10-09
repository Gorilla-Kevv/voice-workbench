import { useState } from 'react';
import { AlertTriangle, Check, Copy, Loader2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { notifyVcRunChanged, type VcRunKind, useVcRunHistory } from '@/hooks/useVcRunHistory';
import { cn } from '@/lib/utils';

/**
 * 运行产物面板 —— 变声页与翻唱页共用。
 *
 * 解决的是同一个问题：用户 2026-10 明确要求「**训练和运行**之后的产物都要在
 * 网站全部显示，同时也给出本地路径」。训练侧已有 `TrainResultCard`，
 * 运行侧原本只有页面里的 `useResultStack` —— 那个走 sessionStorage，
 * 关掉浏览器标签就没了，也看不到历史上跑过的结果。
 *
 * 真相是产物与任务元信息一直都在服务端（`.data/outputs/` + `.data/jobs/`），
 * 缺的只是「读回来」。所以这里统一以 `/v1/jobs?kind=` 为准：
 *   * `vc_infer` —— 语音变声，每次 1 条产物；
 *   * `svc_infer` —— 歌声转换/翻唱，每次 1~3 条产物（新人声 / 伴奏 / 混音）。
 *
 * 每条产物同时给**内联播放器**（`url`，浏览器直接放）与**本机路径**
 * （`path`，点击复制，拿去资源管理器里定位）—— 这正是用户要的「也给出本地路径」。
 */

/** 各板块的标题与强调色参数（沿用页面各自的配色） */
interface RunResultCardProps {
  kind: VcRunKind;
  title: string;
  description: string;
  /** 图标元素，由调用方传入以免本组件依赖具体图标库用法 */
  icon: React.ReactNode;
  /** 强调色类名，如 `text-indigo-500 dark:text-indigo-400` */
  accentText: string;
  /** 空态提示里的一句话，如「上面跑一次变声」 */
  emptyHint: string;
}

/** 时间戳（毫秒）→ 本地时间简写 */
function formatTime(ms: number): string {
  if (!ms) return '—';
  const date = new Date(ms);
  return `${date.getMonth() + 1}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** 任务状态 → 中文与配色 */
function stateView(state: string): { label: string; className: string } {
  if (state === 'succeeded') return { label: '成功', className: 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400' };
  if (state === 'failed') return { label: '失败', className: 'border-destructive/40 text-destructive' };
  if (state === 'cancelled') return { label: '已取消', className: 'text-muted-foreground' };
  if (state === 'running') return { label: '进行中', className: 'border-sky-500/40 text-sky-600 dark:text-sky-400' };
  return { label: '排队中', className: 'text-muted-foreground' };
}

export function RunResultCard({
  kind,
  title,
  description,
  icon,
  accentText,
  emptyHint,
}: RunResultCardProps) {
  const { records, loading, error, refresh } = useVcRunHistory(kind);
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

  const playable = records.filter(
    (record) => record.state === 'succeeded' && record.tracks.some((track) => track.url),
  ).length;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <span className={accentText}>{icon}</span> {title}
            </CardTitle>
            <CardDescription>{description}</CardDescription>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 shrink-0 text-xs text-muted-foreground"
            onClick={() => {
              refresh();
              // 顺手广播一次：万一别的面板也订阅了，一起刷新
              notifyVcRunChanged();
            }}
          >
            <RefreshCw className="size-3" /> 刷新
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {error ? (
          <p className="flex items-center gap-1.5 text-xs text-destructive">
            <AlertTriangle className="size-3" /> 读取运行记录失败：{error}
          </p>
        ) : null}
        {loading && records.length === 0 ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" /> 正在读取运行记录…
          </p>
        ) : records.length === 0 ? (
          <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
            还没有运行记录。{emptyHint}，产物会自动出现在这里。
          </p>
        ) : (
          <div className="space-y-2">
            <p className="text-[11px] text-muted-foreground">
              共 {records.length} 次 · 其中 {playable} 条可回听 · 记录来自本地服务，重启后仍在
            </p>
            {records.map((record) => {
              const view = stateView(record.state);
              return (
                <div key={record.jobId} className="rounded-lg border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium">{record.name}</span>
                    {record.model ? (
                      <Badge variant="outline" className="shrink-0 text-[11px]">
                        {record.model}
                      </Badge>
                    ) : null}
                    <Badge variant="outline" className={cn('shrink-0 text-[11px]', view.className)}>
                      {view.label}
                    </Badge>
                    {record.duration > 0 ? (
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {record.duration.toFixed(1)}s
                      </span>
                    ) : null}
                    <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                      {formatTime(record.createdAt)}
                    </span>
                  </div>

                  {record.state === 'succeeded' && record.tracks.length > 0 ? (
                    <div className="mt-2 space-y-2">
                      {record.tracks.map((track) => (
                        <div key={track.key} className="rounded-md bg-muted/40 p-2">
                          <p className="mb-1 text-[11px] font-medium text-muted-foreground">{track.label}</p>
                          {track.url ? (
                            <audio className="h-8 w-full" controls preload="none" src={track.url} />
                          ) : (
                            <p className="text-[11px] text-muted-foreground">该产物没有可播放的 Web 地址。</p>
                          )}
                          {track.path ? (
                            <button
                              type="button"
                              className="mt-1 block w-full truncate text-left font-mono text-[11px] text-muted-foreground transition hover:text-foreground"
                              title="点击复制完整路径"
                              onClick={() => void copyPath(track.path as string)}
                            >
                              {copied === track.path ? (
                                <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                                  <Check className="size-3" /> 已复制
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1">
                                  <Copy className="size-3 shrink-0" /> {track.path}
                                </span>
                              )}
                            </button>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ) : record.state === 'succeeded' ? (
                    <p className="mt-2 text-xs text-muted-foreground">这次运行没有产出音频文件。</p>
                  ) : record.state === 'failed' ? (
                    <p className="mt-2 text-xs text-destructive">
                      任务失败。可在「任务」面板里查看完整日志定位原因。
                    </p>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

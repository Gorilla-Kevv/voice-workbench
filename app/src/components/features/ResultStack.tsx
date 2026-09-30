import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, History, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

export interface ResultStackEntry {
  id: string;
  createdAt: number;
  /** 列表头的主标题（例如音色名、文件名） */
  title: string;
  /** 列表头的副信息（时长 / 体积 / 语种等） */
  subtitle?: string;
  /** 折叠态也保留的一句摘要，方便不展开就能认出是哪一条 */
  summary?: string;
  /** 展开后的完整结果（由各页面自己渲染） */
  content: ReactNode;
}

interface ResultStackProps {
  entries: ResultStackEntry[];
  /** 单条删除；不传就不显示删除按钮（例如结果不允许单独丢弃的场景） */
  onRemove?: (id: string) => void;
  onClear?: () => void;
  /** 列表为空时显示的内容 */
  empty?: ReactNode;
  /** 滚动区最大高度，默认 30rem */
  maxHeight?: string;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
}

/**
 * 多条结果的列表壳：最新一条默认展开，其余折叠但随时可展开回看，
 * 每条独立播放 / 下载 / 复制 / 删除 —— 新结果**追加**，不再覆盖旧结果。
 *
 * 折叠而不是全展开是有意的：页面高度有限，全展开会把旧结果顶到看不见的地方，
 * 用户真正想看的是刚出来的那条，旧结果留个入口就够了。
 */
export function ResultStack({ entries, onRemove, onClear, empty, maxHeight = '30rem' }: ResultStackProps) {
  // 默认只展开最新一条；用户手动展开/收起的记录在 overrides 里，之后按记录走。
  // 用「覆盖表」而不是 effect 同步 openIds：避免渲染后再 setState 造成的二次渲染。
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [confirmClear, setConfirmClear] = useState(false);
  const newestId = entries[0]?.id;

  const isOpen = (id: string) => overrides[id] ?? id === newestId;

  const toggle = (id: string) => {
    setOverrides((prev) => ({ ...prev, [id]: !isOpen(id) }));
  };

  if (entries.length === 0) return <>{empty ?? null}</>;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 px-0.5">
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <History className="size-3.5" />
          本次结果 {entries.length} 条
        </span>
        {onClear && entries.length > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-6 px-2 text-[11px] text-muted-foreground hover:text-destructive"
            onClick={() => {
              if (confirmClear) {
                onClear();
                setConfirmClear(false);
                setOverrides({});
              } else {
                setConfirmClear(true);
                window.setTimeout(() => setConfirmClear(false), 3000);
              }
            }}
          >
            <Trash2 className="size-3" />
            {confirmClear ? `确认清空 ${entries.length} 条？` : '清空'}
          </Button>
        ) : null}
      </div>

      <div className="space-y-2 overflow-y-auto pr-0.5" style={{ maxHeight }}>
        {entries.map((entry, index) => {
          const open = isOpen(entry.id);
          return (
            <div
              key={entry.id}
              className={`rounded-lg border ${index === 0 ? 'border-violet-500/40 bg-violet-500/[0.03]' : 'bg-muted/30'}`}
            >
              <div className="flex items-center gap-1.5 px-2 py-1.5">
                <button
                  type="button"
                  onClick={() => toggle(entry.id)}
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                  aria-expanded={open}
                >
                  {open ? (
                    <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <span className="shrink-0 rounded bg-muted px-1 text-[10px] tabular-nums text-muted-foreground">
                    {entries.length - index}
                  </span>
                  <span className="min-w-0 truncate text-xs font-medium">{entry.title}</span>
                  {entry.subtitle ? (
                    <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{entry.subtitle}</span>
                  ) : null}
                </button>
                <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                  {formatTime(entry.createdAt)}
                </span>
                {onRemove ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6 shrink-0 text-muted-foreground hover:text-destructive"
                    title="删除这条结果"
                    onClick={() => onRemove(entry.id)}
                  >
                    <Trash2 className="size-3" />
                  </Button>
                ) : null}
              </div>

              {!open && entry.summary ? (
                <p className="truncate px-2 pb-1.5 text-[11px] text-muted-foreground">{entry.summary}</p>
              ) : null}

              {open ? <div className="border-t px-2 py-2">{entry.content}</div> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

import { useMemo, useState } from 'react';
import { ArrowRight, Check, CircleDashed, CircleCheck, MapPin, RotateCcw, Route } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useIsMobile } from '@/hooks/use-mobile';
import { useGuideProgress } from '@/hooks/useGuideProgress';
import { guidesForPage, type Guide } from '@/lib/guides';
import { cn } from '@/lib/utils';
import type { NavKey } from '@/types';

/**
 * 右侧贴边的操作指引。
 *
 * 交互沿用原来的「贴边展开」：默认收成一条竖条，鼠标移到窗口最右侧展开（触屏改点击）。
 * 内容整个重做过 —— 旧版只有「一句目标 + tips」，看不出先后和落点；现在每一步都有：
 *
 * - **圆形状态标识**：未完成是空心虚线圈，已完成是实心圈 + 勾（与任务清单同一套视觉语言）；
 * - **具体怎么操作**：逐条写清点什么、填什么、怎么判断做对了；
 * - **页面职责**：`prev` 说清上一步（可能在别的页面）应留下什么，`next` 说清下一步去哪；
 *   带「去这一页」按钮直接跳过去，跨页流程不用自己找入口；
 * - **进度 + 复习**：顶部 x/N，旁边「重新开始」可清空进度照着再走一遍。
 */
export function FlowGuide({ page, onNavigate }: { page: NavKey; onNavigate?: (key: NavKey) => void }) {
  const [open, setOpen] = useState(false);
  const isMobile = useIsMobile();
  const { primary, others } = useMemo(() => guidesForPage(page), [page]);
  // 用户手动选过的指引（只由点击写入，不用 effect 同步 state —— 那会多渲染一轮）
  const [pickedId, setPickedId] = useState<string | null>(null);
  const all = useMemo(() => [...primary, ...others], [primary, others]);

  // 选中逻辑：本页相关的指引优先；用户选过的若不属于本页，等本页没有相关指引时再尊重它
  const picked = pickedId ? all.find((item) => item.id === pickedId) : undefined;
  const guide = (picked && primary.includes(picked) ? picked : undefined) ?? primary[0] ?? picked ?? others[0];

  if (!guide) return null;

  const panel = (
    <div
      className={cn(
        'overflow-hidden rounded-l-xl border border-r-0 bg-background/85 shadow-lg shadow-black/10 transition-[width] duration-200',
        'backdrop-blur-md supports-[backdrop-filter]:bg-background/60 dark:border-white/15',
        open ? 'w-[min(24rem,calc(100vw-3rem))]' : 'w-9',
      )}
      onMouseLeave={() => {
        if (!isMobile) setOpen(false);
      }}
    >
      {open ? (
        <GuidePanel
          guide={guide}
          page={page}
          onNavigate={(key) => {
            onNavigate?.(key);
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
          alternatives={all.filter((item) => item.id !== guide.id)}
          onSelectGuide={setPickedId}
        />
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="展开操作指引"
          title="操作指引"
          className="flex h-56 w-full flex-col items-center justify-center gap-2 text-muted-foreground transition-colors hover:text-foreground"
        >
          <MapPin className="size-4 shrink-0" />
          <span className="text-[11px] tracking-widest [writing-mode:vertical-rl]">操作指引</span>
        </button>
      )}
    </div>
  );

  return (
    // 外层 pointer-events-none：避免这条透明感应带挡住页面右侧原本可点的元素
    <div className="pointer-events-none fixed right-0 top-1/2 z-40 -translate-y-1/2">
      <div className="pointer-events-auto flex items-center">
        {!isMobile ? (
          <div aria-hidden onMouseEnter={() => setOpen(true)} className="h-56 w-4" />
        ) : null}
        {panel}
      </div>
    </div>
  );
}

function GuidePanel({
  guide,
  page,
  onNavigate,
  onClose,
  alternatives,
  onSelectGuide,
}: {
  guide: Guide;
  page: NavKey;
  onNavigate: (key: NavKey) => void;
  onClose: () => void;
  alternatives: Guide[];
  onSelectGuide: (id: string) => void;
}) {
  const { isDone, toggle, reset, completed, total } = useGuideProgress(guide);
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <div className="max-h-[74vh] overflow-y-auto p-4">
      <div className="mb-3 flex items-center gap-2">
        <Route className="size-4 shrink-0 text-violet-600 dark:text-violet-400" />
        <p className="text-sm font-medium">{guide.title}</p>
        <button
          type="button"
          onClick={onClose}
          aria-label="收起操作指引"
          className="ml-auto rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <span className="block px-1 text-xs">收起</span>
        </button>
      </div>

      {/* 进度 + 复习 */}
      <div className="mb-3 space-y-2 rounded-lg border bg-card/60 p-2.5">
        <div className="flex items-center gap-2">
          <Badge variant="secondary" className="h-5 px-1.5 font-mono text-[10px]">
            {completed}/{total} 步
          </Badge>
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
            <div
              className={cn('h-full rounded-full transition-all', percent === 100 ? 'bg-emerald-500' : 'bg-violet-600')}
              style={{ width: `${percent}%` }}
            />
          </div>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-1.5 text-[11px]"
            onClick={reset}
            title="清空这份指引的进度，照着再走一遍（复习）"
          >
            <RotateCcw className="size-3" />
            重新开始
          </Button>
        </div>
        <p className="text-[11px] leading-snug text-muted-foreground">{guide.summary}</p>
      </div>

      {/* 步骤清单 */}
      <div className="space-y-2">
        {guide.steps.map((step) => {
          const done = isDone(step.id);
          const here = step.page === page;
          return (
            <div
              key={step.id}
              className={cn(
                'rounded-lg border bg-card/60 p-2.5 transition',
                done && 'border-emerald-500/40 bg-emerald-500/5',
              )}
            >
              <div className="flex items-start gap-2">
                {/* 圆形状态标识：未完成 = 空心虚线圈，已完成 = 实心圈 + 勾 */}
                <button
                  type="button"
                  onClick={() => toggle(step.id)}
                  aria-pressed={done}
                  aria-label={done ? `把「${step.title}」标为未完成` : `把「${step.title}」标为已完成`}
                  title={done ? '点一下可标回未完成' : '做完了就点这个圈打勾'}
                  className={cn(
                    'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border transition',
                    done
                      ? 'border-emerald-500 bg-emerald-500 text-white'
                      : 'border-dashed border-muted-foreground/60 text-muted-foreground hover:border-violet-500 hover:text-violet-600',
                  )}
                >
                  {done ? <Check className="size-3" /> : <CircleDashed className="size-3" />}
                </button>

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs font-medium leading-snug">{step.title}</span>
                    {here ? (
                      <Badge variant="secondary" className="h-4 px-1 text-[10px] font-normal">
                        本页
                      </Badge>
                    ) : (
                      <button
                        type="button"
                        onClick={() => onNavigate(step.page)}
                        className="inline-flex items-center gap-0.5 rounded bg-violet-600/10 px-1 text-[10px] text-violet-700 hover:bg-violet-600/20 dark:text-violet-300"
                        title="跳到这一步所在的页面"
                      >
                        去这一页
                        <ArrowRight className="size-2.5" />
                      </button>
                    )}
                  </div>

                  {/* 具体怎么操作 */}
                  <ol className="mt-1.5 space-y-1">
                    {step.how.map((line, lineIndex) => (
                      <li key={lineIndex} className="flex gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
                        <span className="mt-1.5 size-1 shrink-0 rounded-full bg-muted-foreground/50" />
                        <span>{line}</span>
                      </li>
                    ))}
                  </ol>

                  {/* 页面职责：上一页留下什么 / 下一页去哪 */}
                  {step.prev ? (
                    <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">
                      <span className="text-foreground">上一步：</span>
                      {step.prev}
                    </p>
                  ) : null}
                  {step.next ? (
                    <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
                      <span className="text-foreground">下一步：</span>
                      {step.next}
                    </p>
                  ) : null}
                  {step.optional ? (
                    <p className="mt-1 text-[11px] leading-snug text-amber-600 dark:text-amber-400">
                      可跳过：{step.optional}
                    </p>
                  ) : null}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {alternatives.length > 0 ? (
        <div className="mt-3 space-y-1.5 border-t pt-3">
          <p className="text-[11px] text-muted-foreground">其它指引</p>
          <div className="flex flex-wrap gap-1.5">
            {alternatives.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelectGuide(item.id)}
                className="rounded-md border px-2 py-1 text-[11px] hover:bg-muted"
              >
                {item.title}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <p className="mt-3 flex items-start gap-1.5 text-[10px] leading-relaxed text-muted-foreground">
        <CircleCheck className="mt-0.5 size-3 shrink-0" />
        做不到的步骤可以点圆圈手动打勾；想复习就点「重新开始」。
      </p>
    </div>
  );
}

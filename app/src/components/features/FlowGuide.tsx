import { useMemo, useState } from 'react';
import { ChevronLeft, MapPin, Route } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { useIsMobile } from '@/hooks/use-mobile';
import { stepsForPage } from '@/lib/flowGuide';
import { cn } from '@/lib/utils';

/**
 * 官方推荐流程的悬浮指引。
 *
 * 贴在窗口右边缘：默认收成一条竖条（不占地方），鼠标移到窗口最右侧就展开成
 * 完整的步骤清单。之所以做成「贴边展开」而不是常驻面板，是因为训练页本身
 * 表单已经很密，再固定占一块横向空间会挤压内容。
 *
 * 触屏没有「悬浮」，所以移动端改成点击这条竖条来开合。
 *
 * 内容来自 GPT-SoVITS 开发者给出的标准流程（lib/flowGuide），
 * 保留了具体的判断和数值，因为这些正是新手最容易卡住的地方。
 */
export function FlowGuide({ page }: { page: 'training' | 'synthesis' }) {
  const [open, setOpen] = useState(false);
  const isMobile = useIsMobile();
  const steps = useMemo(() => stepsForPage(page), [page]);

  const panel = (
    <div
      // 收起时只露出一条，展开时给足宽度；窄屏上保证右侧留出 3rem 不至于顶到边
      className={cn(
        'overflow-hidden rounded-l-xl border border-r-0 bg-background/85 shadow-lg shadow-black/10 transition-[width] duration-200',
        'backdrop-blur-md supports-[backdrop-filter]:bg-background/60 dark:border-white/15',
        open ? 'w-[min(22rem,calc(100vw-3rem))]' : 'w-9',
      )}
      onMouseLeave={() => {
        if (!isMobile) setOpen(false);
      }}
    >
      {open ? (
        <div className="max-h-[72vh] overflow-y-auto p-4">
          <div className="mb-3 flex items-center gap-2">
            <Route className="size-4 shrink-0 text-violet-600 dark:text-violet-400" />
            <p className="text-sm font-medium">官方推荐流程</p>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="收起流程指引"
              className="ml-auto rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <ChevronLeft className="size-3.5" />
            </button>
          </div>

          <div className="space-y-3">
            {steps.map((step) => (
              <div key={step.id} className="rounded-lg border bg-card/60 p-3">
                <div className="flex items-baseline gap-2">
                  <Badge
                    variant={step.optional ? 'secondary' : 'default'}
                    className={cn(
                      'h-5 shrink-0 px-1.5 text-[10px]',
                      !step.optional && 'bg-violet-600 hover:bg-violet-600',
                    )}
                  >
                    第 {step.index} 步
                  </Badge>
                  <p className="text-xs leading-relaxed">{step.goal}</p>
                </div>

                {step.optional ? (
                  <p className="mt-2 text-[11px] leading-snug text-amber-600 dark:text-amber-400">
                    {step.optional}
                  </p>
                ) : null}

                <ul className="mt-2 space-y-1">
                  {step.tips.map((tip) => (
                    <li
                      key={tip}
                      className="flex gap-1.5 text-[11px] leading-relaxed text-muted-foreground"
                    >
                      <span className="mt-1.5 size-1 shrink-0 rounded-full bg-muted-foreground/50" />
                      <span>{tip}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          <p className="mt-3 text-[10px] leading-relaxed text-muted-foreground">
            以上为 GPT-SoVITS 开发者给出的推荐流程；界面里的参数名可能与官方 WebUI 不同，含义一致。
          </p>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="展开官方流程指引"
          className="flex h-56 w-full flex-col items-center justify-center gap-2 text-muted-foreground transition-colors hover:text-foreground"
        >
          <MapPin className="size-4 shrink-0" />
          <span className="[writing-mode:vertical-rl] text-[11px] tracking-widest">
            官方流程
          </span>
        </button>
      )}
    </div>
  );

  return (
    // 外层 pointer-events-none：避免这条透明感应带挡住页面右侧原本可点的元素
    <div className="pointer-events-none fixed right-0 top-1/2 z-40 -translate-y-1/2">
      <div className="pointer-events-auto flex items-center">
        {/* 感应带：鼠标移到窗口最右侧即展开（仅桌面需要，触屏没有悬浮） */}
        {!isMobile ? (
          <div aria-hidden onMouseEnter={() => setOpen(true)} className="h-56 w-4" />
        ) : null}
        {panel}
      </div>
    </div>
  );
}

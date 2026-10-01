import { GitFork } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * 「这个能力是从哪个项目来的」说明条。
 *
 * 变声 / 翻唱 / 转写这三块都是**接进来的上游项目**，不是本项目自研。
 * 来源不写清楚会有两个实际后果：
 * 1. 用户踩到坑时不知道该去哪个项目找答案，只会在本仓库里白翻；
 * 2. 分不清「RVC 变声」和「DDSP-SVC 翻唱」是两个模型 —— 以为只是两个按钮。
 *
 * 所以每个板块页面顶部都放一条，写清：上游项目名、本地位置、本项目做了什么。
 */
export function SourceNote({
  project,
  location,
  upstream,
  className,
}: {
  /** 上游项目名（要一眼能认出的那个） */
  project: string;
  /** 在本仓库 / 整合包里的位置 */
  location: string;
  /** 本项目在这一层做了什么（一句话） */
  upstream?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground',
        className,
      )}
    >
      <GitFork className="mt-0.5 size-3.5 shrink-0" />
      <p className="min-w-0">
        <span className="font-medium text-foreground">能力来源：{project}</span>
        <span className="mx-1">·</span>
        上游项目位于 <code className="font-mono">{location}</code>
        {upstream ? (
          <>
            <span className="mx-1">·</span>
            {upstream}
          </>
        ) : null}
      </p>
    </div>
  );
}

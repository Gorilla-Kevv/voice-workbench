import { ExternalLink, LibraryBig } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { RESOURCE_HUB, RESOURCE_HUB_UPDATED, type HubLink } from '@/lib/resourceHub';
import { cn } from '@/lib/utils';

/**
 * 「资源库」展开面板（阶段 26补9）。
 *
 * 顶栏「资源库」按钮点开的是它（下拉展开栏），音色库页右侧三分之一内嵌的也是它——
 * 一处数据（lib/resourceHub.ts），两处渲染。内容支持滚动浏览，
 * 每条带「已核实 / 未核实」标记：网盘链接出自 B站简介与评论区，失效是常态，不冒充可靠。
 */

function LinkRow({ link }: { link: HubLink }) {
  return (
    <a
      href={link.url}
      target="_blank"
      rel="noopener noreferrer"
      className="block rounded-md border border-transparent px-2 py-1.5 transition hover:border-violet-400/50 hover:bg-violet-500/5"
      title={`${link.note ?? ''}\n${link.url}`}
    >
      <p className="flex items-center gap-1.5 text-xs font-medium">
        <ExternalLink className="size-3 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate">{link.label}</span>
        <Badge
          variant="secondary"
          className={cn(
            'ml-auto h-4 shrink-0 px-1.5 text-[9px] font-normal',
            link.verified ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400' : 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
          )}
        >
          {link.verified ? '已核实' : '未核实'}
        </Badge>
      </p>
      {link.note ? <p className="mt-0.5 line-clamp-2 pl-[18px] text-[10px] leading-snug text-muted-foreground">{link.note}</p> : null}
      {link.tags && link.tags.length > 0 ? (
        <p className="mt-1 flex flex-wrap gap-1 pl-[18px]">
          {link.tags.map((tag) => (
            <span key={tag} className="rounded bg-muted px-1 py-px text-[9px] text-muted-foreground">
              {tag}
            </span>
          ))}
        </p>
      ) : null}
    </a>
  );
}

/** 分类列表本体：下拉面板与内嵌卡共用；滚动容器由调用方给（max-h + overflow-y-auto） */
export function ResourceHubList({ className }: { className?: string }) {
  return (
    <div className={cn('space-y-3', className)}>
      {RESOURCE_HUB.map((category) => (
        <section key={category.title} className="space-y-1">
          <p className="text-[11px] font-semibold tracking-wide text-violet-700 dark:text-violet-300">{category.title}</p>
          {category.desc ? <p className="text-[10px] leading-snug text-muted-foreground">{category.desc}</p> : null}
          <div className="space-y-0.5">
            {category.links.map((link) => (
              <LinkRow key={link.url} link={link} />
            ))}
          </div>
        </section>
      ))}
      <p className="border-t pt-2 text-[10px] text-muted-foreground">
        调研快照 {RESOURCE_HUB_UPDATED} · 外部链接一律新窗口打开 · 网盘与第三方模型许可各异，商用前逐条自查
      </p>
    </div>
  );
}

/** 顶栏入口：点「资源库」→ 下拉展开栏（可滚动浏览全部资源分类） */
export function ResourceHubMenu({ className }: { className?: string }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'inline-flex h-7 items-center gap-1.5 rounded-lg border bg-muted/40 px-2.5 text-[11px] text-muted-foreground transition hover:border-violet-400 hover:bg-violet-500/5 hover:text-violet-700 dark:hover:text-violet-300',
            className,
          )}
          title="展开资源库：音色模型 / 数据集 / B站教程（点击展开，可滚动浏览）"
        >
          <LibraryBig className="size-3 shrink-0" />
          <span className="hidden sm:inline">资源库</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[380px] p-0">
        <div className="border-b px-3 py-2">
          <p className="text-xs font-medium">资源库 · 音色模型与数据集</p>
          <p className="text-[10px] text-muted-foreground">训练没数据、变声没模型，先来这里找</p>
        </div>
        <div className="scrollbar-thin max-h-[65vh] overflow-y-auto p-2">
          <ResourceHubList />
        </div>
      </PopoverContent>
    </Popover>
  );
}

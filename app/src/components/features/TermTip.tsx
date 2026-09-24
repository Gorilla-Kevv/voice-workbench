import type { ReactNode } from 'react';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useIsMobile } from '@/hooks/use-mobile';
import { lookupTerm } from '@/lib/glossary';
import { cn } from '@/lib/utils';

interface TermTipProps {
  /** 术语，需与术语表（lib/glossary）里的键名一致 */
  term: string;
  /** 界面上显示的文字，缺省就用术语本身 */
  children?: ReactNode;
  className?: string;
}

/**
 * 专有名词的解释提示。
 *
 * 交互按设备分流，这是这个组件存在的唯一理由：
 *
 * - **桌面**：鼠标悬浮（也支持键盘聚焦），符合「看一眼就知道」的预期；
 * - **触屏**：改成交点一下弹出 —— Radix 的 Tooltip 在触摸设备上体验不可靠
 *   （悬浮在触屏上根本不存在），所以这里换成 Popover。
 *
 * 没收录的术语直接原样渲染，不加虚线、不弹空框：宁可少一条解释，
 * 也不要给用户一个点开什么都没有的提示。
 */
export function TermTip({ term, children, className }: TermTipProps) {
  const entry = lookupTerm(term);
  const isMobile = useIsMobile();

  const label = children ?? term;
  if (!entry) return <>{label}</>;

  const trigger = (
    <span
      // tabIndex 让键盘用户也能聚焦到术语上看到解释
      tabIndex={0}
      className={cn(
        'cursor-help rounded-[2px] border-b border-dotted border-muted-foreground outline-none',
        'focus-visible:border-solid focus-visible:ring-1 focus-visible:ring-ring/60',
        className,
      )}
    >
      {label}
    </span>
  );

  const body = (
    <div className="space-y-1 text-xs leading-relaxed">
      <p className="font-medium">{entry.term}</p>
      <p className="opacity-90">{entry.definition}</p>
      {entry.impact ? <p className="opacity-75">{entry.impact}</p> : null}
    </div>
  );

  if (isMobile) {
    return (
      <Popover>
        <PopoverTrigger asChild>{trigger}</PopoverTrigger>
        <PopoverContent className="w-72">{body}</PopoverContent>
      </Popover>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{trigger}</TooltipTrigger>
      <TooltipContent className="max-w-xs">{body}</TooltipContent>
    </Tooltip>
  );
}

import type { ReactNode } from 'react';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useIsMobile } from '@/hooks/use-mobile';
import { lookupTerm } from '@/lib/glossary';
import { cn } from '@/lib/utils';

/**
 * 毛玻璃（glassmorphism）外观。
 *
 * 四层叠加，缺一不像玻璃：
 *
 * 1. **半透明底色** —— 让后方内容隐约透出，但不能透到干扰阅读；
 * 2. **高斯模糊** —— 把透出来的内容柔化成背景纹理，这是「毛」的来源；
 * 3. **亮色细描边** —— 玻璃边缘的折射感，同时划清浮层与背景的界限；
 * 4. **柔和投影** —— 把浮层从页面里「抬」起来，避免糊在内容上。
 *
 * 两个必须处理的现实问题：
 *
 * - **浏览器不支持 backdrop-filter 时**：模糊失效，只剩半透明 —— 文字会直接压在页面内容上，
 *   对比度不可控。因此用 `supports-[backdrop-filter]:` 在这类浏览器上把底色调实
 *   （可读性优先于质感）。
 *
 * - **深浅主题**：底色走 CSS 变量（`bg-background`），亮/暗自动跟随；
 *   描边用白色半透明，两种主题下都能描出玻璃边缘，暗色下再减弱一点，避免边缘发灰。
 */
const GLASS_SURFACE = cn(
  // 底色：默认偏实（降级安全），支持模糊时更透
  'bg-background/85 supports-[backdrop-filter]:bg-background/60',
  // 高斯模糊 + 轻微增饱和，让透出的色彩不至于发灰
  'backdrop-blur-md backdrop-saturate-150',
  // 玻璃边缘与投影
  'border border-white/25 shadow-lg shadow-black/10',
  'dark:border-white/15',
);

/**
 * 浮层宽度。
 *
 * 用 `min()` 而不是固定 rem：窄屏（手机竖屏）上 20rem 会顶到屏幕外，
 * 这里保证两侧各留 1rem 安全边距，尺寸自适应。
 */
const SURFACE_WIDTH = 'max-w-[min(20rem,calc(100vw-2rem))]';

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

  /**
   * 正文。
   *
   * 刻意不用 opacity 调层次 —— 半透明背景上的半透明文字会双重削弱对比度，
   * 在毛玻璃上尤其明显。改用主题色：正文用 foreground，次要信息用 muted-foreground，
   * 这两个变量在亮/暗主题下都保证过对比度。
   */
  const body = (
    <div className="space-y-1 text-xs leading-relaxed text-foreground">
      <p className="font-medium">{entry.term}</p>
      <p className="text-foreground/90">{entry.definition}</p>
      {entry.impact ? <p className="text-muted-foreground">{entry.impact}</p> : null}
    </div>
  );

  if (isMobile) {
    return (
      <Popover>
        <PopoverTrigger asChild>{trigger}</PopoverTrigger>
        <PopoverContent
          align="start"
          // 触屏上没有精确的指针位置，贴着术语左对齐更自然；内边距也比默认小一点
          className={cn(GLASS_SURFACE, SURFACE_WIDTH, 'w-auto p-3')}
        >
          {body}
        </PopoverContent>
      </Popover>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{trigger}</TooltipTrigger>
      <TooltipContent
        className={cn(
          GLASS_SURFACE,
          SURFACE_WIDTH,
          // 箭头在毛玻璃上会是实色一块，反而破坏质感 —— 直接去掉
          '[&>svg]:hidden',
        )}
      >
        {body}
      </TooltipContent>
    </Tooltip>
  );
}

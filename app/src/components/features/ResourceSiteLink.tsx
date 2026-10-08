import { ExternalLink } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * 「AI Hobbyist 资源库」入口（https://res.acgnai.top/）。
 *
 * 这个站提供角色语音**数据集**与 TTS / SVC 的**开源模型** ——
 * 正好补上本工具链「训练没数据、变声没模型」的两头。
 * 用户 2026-10 裁决：**常驻在每个页面右上角**（挂在 AppShell 顶栏），
 * 不再散落到训练 / 变声 / 翻唱各页 —— 一处入口，处处可达。
 *
 * 外部链接一律新窗口打开，`rel="noopener noreferrer"` 防止反向 tabnabbing。
 */
export function ResourceSiteLink({ className }: { className?: string }) {
  return (
    <a
      href="https://res.acgnai.top/"
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-lg border bg-muted/40 px-2.5 text-[11px] text-muted-foreground transition hover:border-violet-400 hover:bg-violet-500/5 hover:text-violet-700 dark:hover:text-violet-300',
        className,
      )}
      title="缺素材或缺模型？在新窗口打开 AI Hobbyist 资源库（角色语音数据集 / TTS·SVC 开源模型）"
    >
      <ExternalLink className="size-3 shrink-0" />
      <span className="hidden sm:inline">资源库</span>
    </a>
  );
}

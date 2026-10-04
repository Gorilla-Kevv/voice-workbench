import { ExternalLink } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * 「AI Hobbyist 资源库」入口（https://res.acgnai.top/）。
 *
 * 这个站提供角色语音**数据集**与 TTS / SVC 的**开源模型** ——
 * 正好补上本工具链「训练没数据、变声没模型」的两头。
 * 放在训练页（要数据集）与变声 / 翻唱页（要 .pth 模型）三处。
 *
 * 外部链接一律新窗口打开，`rel="noopener noreferrer"` 防止反向 tabnabbing。
 */
export function ResourceSiteLink({
  label = '缺素材或缺模型？去 AI Hobbyist 资源库（角色语音数据集 / TTS·SVC 开源模型）',
  className,
}: {
  label?: string;
  className?: string;
}) {
  return (
    <a
      href="https://res.acgnai.top/"
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        'inline-flex items-center gap-1.5 rounded-lg border bg-muted/40 px-2.5 py-1.5 text-[11px] text-muted-foreground transition hover:border-violet-400 hover:bg-violet-500/5 hover:text-violet-700 dark:hover:text-violet-300',
        className,
      )}
      title="在新窗口打开 AI Hobbyist 资源库"
    >
      <ExternalLink className="size-3 shrink-0" />
      <span>{label}</span>
    </a>
  );
}

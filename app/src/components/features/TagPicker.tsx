import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

interface TagPickerProps {
  groups: { group: string; tags: string[] }[];
  /** 已选中的标签 */
  selected: string[];
  onToggle: (tag: string) => void;
  /** 是否为互斥单选（风格标签适用） */
  single?: boolean;
  description?: string;
}

/**
 * 标签选择器。
 * 风格标签写在文本开头，形如 (开心 兴奋)；
 * 音频标签以 [标签] 形式插入正文。
 */
export function TagPicker({ groups, selected, onToggle, single = false, description }: TagPickerProps) {
  return (
    <div className="space-y-3">
      {description ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <p className="cursor-help text-xs text-muted-foreground underline decoration-dotted underline-offset-4">
              {description}
            </p>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-xs">
            {single
              ? '整体风格标签会写在文本最开头，如 (开心 兴奋)待合成文本，多个标签用空格分隔'
              : '音频标签以 [标签] 形式插入文本中任意位置，用于控制停顿、语气与情绪细节'}
          </TooltipContent>
        </Tooltip>
      ) : null}

      <div className="space-y-2">
        {groups.map((group) => (
          <div key={group.group} className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 w-16 shrink-0 text-xs text-muted-foreground">{group.group}</span>
            {group.tags.map((tag) => {
              const active = selected.includes(tag);
              return (
                <Button
                  key={tag}
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => onToggle(tag)}
                  className={cn(
                    'h-6 rounded-full px-2.5 text-xs font-normal transition',
                    active
                      ? 'border-violet-500 bg-violet-500/10 text-violet-700 hover:bg-violet-500/15 dark:text-violet-300'
                      : 'hover:border-violet-300',
                  )}
                >
                  {single ? `(${tag})` : `[${tag}]`}
                </Button>
              );
            })}
          </div>
        ))}
      </div>

      {selected.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5 rounded-lg bg-muted/60 p-2">
          <span className="text-xs text-muted-foreground">已选：</span>
          {selected.map((tag) => (
            <Badge key={tag} variant="secondary" className="gap-1 text-xs font-normal">
              {single ? `(${tag})` : `[${tag}]`}
            </Badge>
          ))}
        </div>
      ) : null}
    </div>
  );
}

import { KeyRound, ArrowRight } from 'lucide-react';

import mascot from '@/assets/brand/grk-mascot.png';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface KeyGateProps {
  /** 站点是否已配置服务端密钥 */
  hasServerKey: boolean;
  /** 用户是否已填写自带密钥 */
  hasUserKey: boolean;
  onGoSettings: () => void;
  className?: string;
}

/**
 * BYOK 模式下的首次使用引导。
 * 当站点与用户都没有可用密钥时，合成请求必然失败，提前明确告知比让用户撞错误更友好。
 */
export function KeyGate({ hasServerKey, hasUserKey, onGoSettings, className }: KeyGateProps) {
  if (hasServerKey || hasUserKey) return null;

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-3 rounded-xl border border-amber-300/70 bg-amber-50 p-3.5 dark:border-amber-500/30 dark:bg-amber-500/10',
        className,
      )}
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-amber-500/15 text-amber-600 dark:text-amber-400">
        <KeyRound className="size-4.5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-amber-900 dark:text-amber-200">开始前请先配置 MiMo API Key</p>
        <p className="mt-0.5 text-xs text-amber-800/80 dark:text-amber-300/80">
          本站点采用「用户自带密钥」模式，密钥仅保存在你的浏览器本地，不会上传到服务器。前往 MiMo 开放平台免费创建。
        </p>
      </div>
      {/* 立绘插画：小屏隐藏，避免挤掉文字与按钮 */}
      <img
        src={mascot}
        alt=""
        aria-hidden="true"
        draggable={false}
        className="hidden h-16 w-auto shrink-0 select-none drop-shadow-sm sm:block lg:h-20"
      />
      <Button
        size="sm"
        onClick={onGoSettings}
        className="shrink-0 bg-amber-600 text-white hover:bg-amber-700 dark:bg-amber-500 dark:hover:bg-amber-600"
      >
        前往设置
        <ArrowRight className="size-3.5" />
      </Button>
    </div>
  );
}

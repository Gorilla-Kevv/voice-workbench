import { useEffect, useState } from 'react';
import { AlertTriangle, Loader2, Power } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { localServiceApi, type LocalServiceState } from '@/lib/localService';
import { cn } from '@/lib/utils';

/**
 * 「本页需要 GPT-SoVITS，但它现在停着」的提示。
 *
 * 背景：GPT-SoVITS 改成**默认停用**（显存留给网易主服务）之后，
 * 训练 / 批量 / 变声 / 翻唱 / 音色库这些页面会直接失败，
 * 而通用报错只说「本地服务不可用」，用户不知道该去哪开、甚至不知道有这个开关。
 *
 * 所以这里给出两个动作：**直接开启**（不用离开本页）与**去设置**（想改别的配置）。
 * 服务已启用时不渲染 —— 正常状态下不该有任何噪音。
 */
export function SovitsServiceNotice({
  onGoSettings,
  className,
}: {
  onGoSettings?: () => void;
  className?: string;
}) {
  const [state, setState] = useState<LocalServiceState | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    localServiceApi
      .state()
      .then((next) => {
        if (!cancelled) setState(next);
      })
      .catch(() => {
        if (!cancelled) setState(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 读不到状态或已启用：不打扰用户（宁可漏提示，也不误报）
  if (!state || state.enabled || state.reachable) return null;

  const start = async () => {
    setStarting(true);
    try {
      await localServiceApi.toggle(true);
      setState(await localServiceApi.state());
    } finally {
      setStarting(false);
    }
  };

  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-amber-700 dark:text-amber-400',
        className,
      )}
    >
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0 space-y-1.5">
        <p className="font-medium">本页需要 GPT-SoVITS 本地服务，它当前是停用的</p>
        <p className="opacity-90">
          出于显存考虑，这个服务<strong>默认关闭</strong>（把显存留给网易主服务）。
          开启后首次要 import torch，数十秒才就绪 —— 之后训练 / 批量 / 变声 / 翻唱才能用。
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => void start()} disabled={starting}>
            {starting ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : <Power className="mr-1.5 size-3.5" />}
            直接开启
          </Button>
          {onGoSettings ? (
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={onGoSettings}>
              去设置页
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

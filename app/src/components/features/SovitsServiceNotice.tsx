import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Loader2, Power } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { localServiceApi, notifyServiceEnabledChanged, type LocalServiceState } from '@/lib/localService';
import { cn } from '@/lib/utils';

/**
 * 冷启动要多久：本地实测 Python 侧 import torch + 建管线约 40~70 秒。
 * 进度条按这个量级推进 —— 刻意只推到 95% 就停，不做「100% 却还没好」的假精确。
 */
const EXPECTED_START_SEC = 45;

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
  /** 启动已耗秒数（进度条与文案都用它） */
  const [elapsed, setElapsed] = useState(0);
  const timers = useRef<{ tick: number | null; poll: number | null }>({ tick: null, poll: null });

  const clearTimers = () => {
    if (timers.current.tick !== null) window.clearInterval(timers.current.tick);
    if (timers.current.poll !== null) window.clearInterval(timers.current.poll);
    timers.current = { tick: null, poll: null };
  };

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

  useEffect(() => clearTimers, []);

  // 读不到状态、服务已就绪、或本来就启用着（且不是本页正在启动）：不打扰用户。
  // `starting` 这个条件不能省 —— 开启请求一落地，服务端的 enabled 就翻成 true，
  // 而进程还要数十秒才起来；只看 enabled 会让这张卡在 3 秒内自己消失，
  // 用户点完「直接开启」就再没有任何进度可看（阶段 21 的反馈等于白做）。
  if (!state || state.reachable || (state.enabled && !starting)) return null;

  /**
   * 开启并给出进度反馈。
   *
   * 为什么要这一堆计时器：`toggle(true)` 会等到服务真正就绪才返回（数十秒），
   * 期间界面若只有一个转圈，用户会以为卡死。所以一边走秒表推进进度条，
   * 一边每 3 秒探一次真实状态 —— 探到就绪就提前收尾，不等 toggle 自己回来。
   */
  const start = async () => {
    setStarting(true);
    setElapsed(0);
    const startedAt = Date.now();
    clearTimers();

    timers.current.tick = window.setInterval(() => {
      setElapsed(Math.round((Date.now() - startedAt) / 1000));
    }, 1_000);
    timers.current.poll = window.setInterval(() => {
      void localServiceApi
        .state()
        .then((next) => {
          if (next.reachable) {
            setState(next);
            clearTimers();
            setStarting(false);
          }
        })
        .catch(() => undefined);
    }, 3_000);

    try {
      await localServiceApi.toggle(true);
      notifyServiceEnabledChanged();
      setState(await localServiceApi.state());
    } catch {
      // 失败也把状态刷新一次：可能是地址不对 / 整合包缺失，交给页面上的通用报错
      setState(await localServiceApi.state().catch(() => null));
    } finally {
      clearTimers();
      setStarting(false);
    }
  };

  const percent = Math.min(95, Math.round((elapsed / EXPECTED_START_SEC) * 100));

  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-amber-700 dark:text-amber-400',
        className,
      )}
    >
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0 space-y-1.5">
        <p className="font-medium">
          {starting
            ? '正在启动 GPT-SoVITS 本地服务'
            : '本页需要 GPT-SoVITS 本地服务，它当前是停用的'}
        </p>
        <p className="opacity-90">
          出于显存考虑，这个服务<strong>默认关闭</strong>（把显存留给网易主服务）。
          开启后首次要 import torch，数十秒才就绪 —— 之后训练 / 批量 / 变声 / 翻唱才能用。
        </p>
        {starting ? (
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              <Loader2 className="size-3.5 shrink-0 animate-spin" />
              <span>
                启动中，约需数十秒（首次要 import torch）· 已等待 {elapsed} 秒
              </span>
            </div>
            <Progress value={percent} className="h-1.5" />
            <p className="opacity-80">到点会自动继续，不用守在这儿；也可以先切去别的页面。</p>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => void start()}>
              <Power className="mr-1.5 size-3.5" />
              直接开启
            </Button>
            {onGoSettings ? (
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={onGoSettings}>
                去设置页
              </Button>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

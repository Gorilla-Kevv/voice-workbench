import { useEffect, useState } from 'react';
import { Check, Loader2, Sparkles } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { preloadApi, type PreloadCatalog, type PreloadModel } from '@/lib/preload';

/**
 * 启动时的「预加载哪个模型」选择。
 *
 * 为什么要有它：网易与 IndexTTS 谁当主力还没定（要由使用测试判断），
 * 而**显存一次只够装一个**。与其替用户决定，不如开网页时把账本摆出来：
 * 每个模型要多少显存、现在还剩多少、选了谁另一套就得让位。
 *
 * 只在偏好为 `ask`（默认）时弹；选了「记住」之后写回服务端偏好，下次启动时自动加载。
 */
export function StartupPreloadDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (next: boolean) => void }) {
  const [catalog, setCatalog] = useState<PreloadCatalog | null>(null);
  const [picked, setPicked] = useState<PreloadModel | null>(null);
  const [remember, setRemember] = useState(true);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    preloadApi
      .catalog()
      .then((next) => {
        if (cancelled) return;
        setCatalog(next);
        // 默认选中第一个「装得下」的，而不是无脑选第一个
        const firstFits = next.models.find((item) => item.fits !== false);
        setPicked((current) => current ?? (firstFits?.id as PreloadModel | undefined) ?? null);
      })
      .catch(() => setCatalog(null));
    return () => {
      cancelled = true;
    };
  }, [open]);

  const free = catalog?.vram.free_mb;

  const confirm = async () => {
    if (!picked) return;
    setRunning(true);
    try {
      await preloadApi.savePreference(remember ? picked : 'ask');
      const report = await preloadApi.run(picked);
      if (report.ok) {
        toast.success('模型已预加载', { description: report.message });
      } else {
        toast.warning('预加载未完成', { description: report.message });
      }
      onOpenChange(false);
    } catch (error) {
      const requestError = error as Error;
      toast.error('预加载失败', { description: requestError.message });
    } finally {
      setRunning(false);
    }
  };

  const skip = async () => {
    try {
      await preloadApi.savePreference('none');
    } catch {
      // 记不住也不影响本次跳过
    }
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-4 text-violet-600 dark:text-violet-400" />
            启动时预加载哪个模型？
          </DialogTitle>
          <DialogDescription>
            显存一次只够常驻一个模型。选谁，谁就先占住这块资源，另一套会被让出；
            之后随时可以在设置页改。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            当前空闲显存：
            <span className="font-mono">{free == null ? '读取不到' : `${(free / 1024).toFixed(1)} GB`}</span>
            {catalog?.vram.total_mb ? (
              <span className="font-mono"> / 共 {(catalog.vram.total_mb / 1024).toFixed(1)} GB</span>
            ) : null}
          </p>

          {catalog?.models.map((item) => {
            const selected = picked === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setPicked(item.id)}
                className={cn(
                  'flex w-full items-start gap-2 rounded-lg border p-3 text-left transition',
                  selected ? 'border-violet-500 bg-violet-500/5' : 'hover:bg-muted/50',
                )}
              >
                <span
                  className={cn(
                    'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border',
                    selected ? 'border-violet-600 bg-violet-600 text-white' : 'border-muted-foreground/50',
                  )}
                >
                  {selected ? <Check className="size-2.5" /> : null}
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{item.label}</span>
                  <span className="block text-xs text-muted-foreground">
                    需要显存约 {(item.vram_mb / 1024).toFixed(1)} GB
                    {item.fits === false ? (
                      <span className="ml-1 text-amber-600 dark:text-amber-400">· 当前显存不够，会加载失败</span>
                    ) : null}
                  </span>
                </span>
              </button>
            );
          })}

          {catalog === null ? <p className="py-4 text-center text-xs text-muted-foreground">正在读取显存…</p> : null}
        </div>

        <div className="flex items-center gap-2">
          <Checkbox id="preload-remember" checked={remember} onCheckedChange={(value) => setRemember(value === true)} />
          <Label htmlFor="preload-remember" className="text-xs font-normal">
            记住这次选择，以后开机自动加载（不选则每次都问我）
          </Label>
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => void skip()} disabled={running}>
            暂不加载
          </Button>
          <Button size="sm" onClick={() => void confirm()} disabled={running || !picked}>
            {running ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
            {running ? '加载中（首次约数十秒）' : '开始加载'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

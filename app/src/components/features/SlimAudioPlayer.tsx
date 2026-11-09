import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { Download, Pause, Play, Volume2, VolumeX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { claimPlayback, formatDuration, releasePlayback, resumeAudioContext } from '@/lib/audio';
import { cn } from '@/lib/utils';

interface SlimAudioPlayerProps {
  src: string;
  className?: string;
  autoPlay?: boolean;
  preload?: 'none' | 'metadata' | 'auto';
  /** 窄容器：隐藏音量滑杆 */
  compact?: boolean;
  /** 页面已有独立下载入口时隐藏下载按钮 */
  hideDownload?: boolean;
  downloadName?: string;
  /** 由外部持有 audio 元素（ABPlayer 跨轨续播用） */
  audioRef?: RefObject<HTMLAudioElement | null>;
  onDurationChange?: (duration: number) => void;
}

/**
 * 细长播放条：播放 / 细进度条 / 时间 / 音量 / 下载。
 *
 * 原生 <audio controls> 在窄容器里进度条极短，长音频几乎没法拖动；
 * 这里用整行宽度的细进度条替代，拖动与键盘（←/→ 5 秒）都可定位。
 */
export function SlimAudioPlayer({
  src,
  className,
  autoPlay = false,
  preload = 'metadata',
  compact = false,
  hideDownload = false,
  downloadName,
  audioRef,
  onDurationChange,
}: SlimAudioPlayerProps) {
  const innerRef = useRef<HTMLAudioElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const playerId = useId();
  const playbackIdRef = useRef(`slim-${playerId}`);

  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [dragging, setDragging] = useState(false);

  const assignRef = useCallback(
    (element: HTMLAudioElement | null) => {
      innerRef.current = element;
      if (audioRef) audioRef.current = element;
    },
    [audioRef],
  );

  const pause = useCallback(() => {
    innerRef.current?.pause();
  }, []);

  useEffect(() => () => releasePlayback(playbackIdRef.current), []);

  const toggle = useCallback(async () => {
    const audio = innerRef.current;
    if (!audio) return;
    if (!audio.paused) {
      audio.pause();
      return;
    }
    claimPlayback(playbackIdRef.current, pause);
    await resumeAudioContext(audio);
    await audio.play().catch(() => setPlaying(false));
  }, [pause]);

  useEffect(() => {
    if (!autoPlay || !src) return;
    const timer = window.setTimeout(() => {
      void toggle();
    }, 120);
    return () => window.clearTimeout(timer);
  }, [autoPlay, src, toggle]);

  const seekFromEvent = useCallback(
    (clientX: number) => {
      const track = trackRef.current;
      const audio = innerRef.current;
      if (!track || !audio || !duration) return;
      const rect = track.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      audio.currentTime = ratio * duration;
      setCurrent(audio.currentTime);
    },
    [duration],
  );

  useEffect(() => {
    if (!dragging) return;
    const move = (event: PointerEvent) => seekFromEvent(event.clientX);
    const up = () => setDragging(false);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [dragging, seekFromEvent]);

  const progress = duration > 0 ? Math.min(100, (current / duration) * 100) : 0;

  // 部分 WAV 的 duration 先报 Infinity，等 durationchange 才是真实值
  const applyDuration = (element: HTMLAudioElement) => {
    const value = element.duration;
    if (!Number.isFinite(value) || value <= 0) return;
    setDuration(value);
    onDurationChange?.(value);
  };

  return (
    <div
      className={cn(
        'flex w-full min-w-0 items-center gap-1.5 rounded-lg border bg-background/60 px-2 py-1',
        className,
      )}
    >
      <audio
        ref={assignRef}
        src={src}
        preload={preload}
        muted={muted}
        onLoadStart={() => {
          setPlaying(false);
          setCurrent(0);
          setDuration(0);
        }}
        onPlay={() => {
          claimPlayback(playbackIdRef.current, pause);
          setPlaying(true);
        }}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setCurrent(0);
          if (innerRef.current) innerRef.current.currentTime = 0;
        }}
        onTimeUpdate={(event) => {
          if (!dragging) setCurrent(event.currentTarget.currentTime);
        }}
        onLoadedMetadata={(event) => applyDuration(event.currentTarget)}
        onDurationChange={(event) => applyDuration(event.currentTarget)}
        onVolumeChange={(event) => {
          setMuted(event.currentTarget.muted || event.currentTarget.volume === 0);
          setVolume(event.currentTarget.volume);
        }}
      />

      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7 shrink-0 rounded-full text-violet-600 hover:bg-violet-500/10 hover:text-violet-600 dark:text-violet-400"
        onClick={() => void toggle()}
        aria-label={playing ? '暂停' : '播放'}
      >
        {playing ? <Pause className="size-3.5 fill-current" /> : <Play className="size-3.5 fill-current pl-0.5" />}
      </Button>

      <span className="w-9 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
        {formatDuration(current)}
      </span>

      <div
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-label="播放进度"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(current)}
        aria-valuetext={`${formatDuration(current)} / ${formatDuration(duration)}`}
        title="拖动调整播放进度"
        className="group relative flex h-6 min-w-0 flex-1 cursor-pointer touch-none items-center"
        onPointerDown={(event) => {
          try {
            event.currentTarget.setPointerCapture?.(event.pointerId);
          } catch {
            // 合成事件或指针已释放时捕获会抛错，不影响拖动逻辑
          }
          setDragging(true);
          seekFromEvent(event.clientX);
        }}
        onPointerUp={(event) => {
          try {
            event.currentTarget.releasePointerCapture?.(event.pointerId);
          } catch {
            // 未捕获过该指针时忽略
          }
          setDragging(false);
        }}
        onKeyDown={(event) => {
          const audio = innerRef.current;
          if (!audio) return;
          if (event.key === 'ArrowRight') {
            event.preventDefault();
            audio.currentTime = Math.min(duration, audio.currentTime + 5);
          } else if (event.key === 'ArrowLeft') {
            event.preventDefault();
            audio.currentTime = Math.max(0, audio.currentTime - 5);
          } else if (event.key === 'Home') {
            event.preventDefault();
            audio.currentTime = 0;
          } else if (event.key === 'End') {
            event.preventDefault();
            audio.currentTime = duration;
          }
        }}
      >
        <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-gradient-to-r from-violet-600 to-indigo-500"
            style={{ width: `${progress}%` }}
          />
        </div>
        <span
          className={cn(
            'pointer-events-none absolute top-1/2 size-2.5 -translate-y-1/2 rounded-full bg-violet-600 shadow-sm transition-opacity',
            dragging ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
          )}
          style={{ left: `calc(${progress}% - 5px)` }}
        />
      </div>

      <span className="w-9 shrink-0 text-[11px] tabular-nums text-muted-foreground">
        {formatDuration(duration)}
      </span>

      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7 shrink-0 text-muted-foreground"
        onClick={() => {
          const audio = innerRef.current;
          if (!audio) return;
          const next = !(audio.muted || audio.volume === 0);
          audio.muted = next;
          if (!next && audio.volume === 0) audio.volume = 0.8;
          setMuted(next);
        }}
        aria-label={muted ? '取消静音' : '静音'}
      >
        {muted ? <VolumeX className="size-3.5" /> : <Volume2 className="size-3.5" />}
      </Button>

      {!compact ? (
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={muted ? 0 : volume}
          onChange={(event) => {
            const audio = innerRef.current;
            const value = Number(event.target.value);
            if (!audio) return;
            audio.muted = value === 0;
            audio.volume = value;
            setVolume(value);
            setMuted(value === 0);
          }}
          className="hidden h-1 w-14 shrink-0 cursor-pointer accent-violet-600 sm:block"
          aria-label="音量"
        />
      ) : null}

      {!hideDownload ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 shrink-0 text-muted-foreground"
          asChild
        >
          <a href={src} download={downloadName} aria-label="下载音频" title="下载音频">
            <Download className="size-3.5" />
          </a>
        </Button>
      ) : null}
    </div>
  );
}

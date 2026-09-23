import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, Pause, Play, RotateCcw, Volume2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { claimPlayback, ensureGainGraph, formatDuration, releasePlayback, resumeAudioContext } from '@/lib/audio';
import { cn } from '@/lib/utils';

interface AudioPlayerProps {
  src: string;
  /** 播放增益倍率，缓解部分音频音量偏小 */
  gain?: number;
  /** 自动播放（仅在用户本次操作产生音频时使用） */
  autoPlay?: boolean;
  onDownload?: () => void;
  className?: string;
  compact?: boolean;
}

/** 带波形进度条的音频播放器，支持增益调节与全局单曲播放仲裁 */
export function AudioPlayer({ src, gain = 1, autoPlay = false, onDownload, className, compact = false }: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const playbackIdRef = useRef(`player-${Math.random().toString(36).slice(2, 9)}`);

  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [localGain, setLocalGain] = useState(gain);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    setLocalGain(gain);
    if (gainNodeRef.current) gainNodeRef.current.gain.value = gain;
  }, [gain]);

  useEffect(() => {
    setPlaying(false);
    setCurrent(0);
    setDuration(0);
  }, [src]);

  const pause = useCallback(() => {
    audioRef.current?.pause();
  }, []);

  const toggle = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio) return;

    if (audio.paused) {
      claimPlayback(playbackIdRef.current, pause);
      if (!gainNodeRef.current) {
        gainNodeRef.current = ensureGainGraph(audio, localGain);
      }
      await resumeAudioContext(audio);
      if (gainNodeRef.current) gainNodeRef.current.gain.value = localGain;
      await audio.play().catch(() => setPlaying(false));
    } else {
      audio.pause();
    }
  }, [localGain, pause]);

  // 自动播放：仅在浏览器允许时生效，失败则保持静默
  useEffect(() => {
    if (!autoPlay || !src) return;
    const timer = window.setTimeout(() => {
      void toggle();
    }, 120);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPlay, src]);

  useEffect(() => () => releasePlayback(playbackIdRef.current), []);

  const seekFromEvent = useCallback(
    (clientX: number) => {
      const track = trackRef.current;
      const audio = audioRef.current;
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

  const progress = duration > 0 ? (current / duration) * 100 : 0;
  const bars = compact ? 32 : 56;

  return (
    <div className={cn('rounded-xl border bg-card p-4 shadow-xs', className)}>
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setCurrent(0);
        }}
        onTimeUpdate={(event) => {
          if (!dragging) setCurrent(event.currentTarget.currentTime);
        }}
        onLoadedMetadata={(event) => setDuration(event.currentTarget.duration || 0)}
      />

      <div className="flex items-center gap-4">
        <Button
          size="icon"
          onClick={() => void toggle()}
          className={cn(
            'size-12 shrink-0 rounded-full bg-gradient-to-br from-violet-600 to-indigo-500 shadow-lg shadow-violet-500/25 transition hover:brightness-110',
          )}
          aria-label={playing ? '暂停' : '播放'}
        >
          {playing ? <Pause className="size-5 fill-current" /> : <Play className="size-5 fill-current pl-0.5" />}
        </Button>

        <div className="min-w-0 flex-1">
          {/* 波形装饰 + 可点击进度条 */}
          <div
            ref={trackRef}
            role="slider"
            tabIndex={0}
            aria-label="播放进度"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress)}
            className="group flex h-10 cursor-pointer items-center gap-[3px]"
            onPointerDown={(event) => {
              setDragging(true);
              seekFromEvent(event.clientX);
            }}
            onKeyDown={(event) => {
              const audio = audioRef.current;
              if (!audio) return;
              if (event.key === 'ArrowRight') audio.currentTime = Math.min(duration, audio.currentTime + 2);
              if (event.key === 'ArrowLeft') audio.currentTime = Math.max(0, audio.currentTime - 2);
            }}
          >
            {Array.from({ length: bars }).map((_, index) => {
              const barRatio = (index / (bars - 1)) * 100;
              const filled = barRatio <= progress;
              // 伪随机但稳定的高度分布，形成自然波形
              const height = 28 + Math.abs(Math.sin(index * 1.7) * 52) + (index % 3) * 6;
              return (
                <span
                  key={index}
                  style={{ height: `${Math.min(100, height)}%` }}
                  className={cn(
                    'flex-1 rounded-full transition-colors',
                    filled ? 'bg-gradient-to-t from-violet-600 to-cyan-400' : 'bg-muted',
                    playing && filled && 'wave-bar',
                  )}
                />
              );
            })}
          </div>

          <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground tabular-nums">
            <span>{formatDuration(current)}</span>
            <span>{formatDuration(duration)}</span>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <Button variant="ghost" size="icon" onClick={() => {
            const audio = audioRef.current;
            if (audio) {
              audio.currentTime = 0;
              setCurrent(0);
            }
          }} aria-label="回到开头">
            <RotateCcw className="size-4" />
          </Button>
          {onDownload ? (
            <Button variant="ghost" size="icon" onClick={onDownload} aria-label="下载音频">
              <Download className="size-4" />
            </Button>
          ) : null}
        </div>
      </div>

      <div className="mt-3 flex items-center gap-3 border-t pt-3">
        <Volume2 className="size-4 shrink-0 text-muted-foreground" />
        <Slider
          value={[localGain]}
          min={0.5}
          max={4}
          step={0.1}
          onValueChange={([value]) => {
            setLocalGain(value);
            if (gainNodeRef.current) gainNodeRef.current.gain.value = value;
          }}
          className="max-w-[200px]"
        />
        <span className="text-xs text-muted-foreground tabular-nums">{localGain.toFixed(1)}x 增益</span>
      </div>
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

export interface ABTrack {
  label: string;
  /** 可直接播放的 URL（经 resolveAudioUrl 补全） */
  url: string;
  hint?: string;
}

interface ABPlayerProps {
  tracks: ABTrack[];
  /** 强调色（选中态），默认 indigo */
  accentClass?: string;
}

/**
 * A/B 对比播放器：多个音轨共享同一个 <audio>，切换即换源不断播。
 *
 * 用单 audio 元素而不是每轨一个播放器，是为了「同一位置无缝对比」——
 * 切换时保留 currentTime，用户能听到同一瞬间的两种处理效果。
 */
export function ABPlayer({ tracks, accentClass = 'bg-indigo-600 text-white' }: ABPlayerProps) {
  const [requested, setRequested] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const timeRef = useRef(0);

  // 音轨列表变短时（比如重新提交任务后产物变化）把选中项收敛到有效范围，
  // 用派生值而不是 effect 里 setState —— 后者会触发级联渲染
  const active = Math.min(requested, Math.max(tracks.length - 1, 0));

  const switchTo = (index: number) => {
    if (index === active) return;
    const audio = audioRef.current;
    timeRef.current = audio?.currentTime ?? 0;
    setRequested(index);
  };

  useEffect(() => {
    const audio = audioRef.current;
    if (audio && timeRef.current > 0) {
      audio.currentTime = timeRef.current;
      void audio.play().catch(() => undefined);
    }
  }, [active]);

  if (tracks.length === 0) return null;
  const current = tracks[active];

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {tracks.map((track, index) => (
          <button
            key={track.url + track.label}
            type="button"
            onClick={() => switchTo(index)}
            className={cn(
              'rounded-full px-3 py-1 text-xs transition active:scale-95',
              index === active
                ? accentClass
                : 'border bg-background text-muted-foreground hover:bg-muted',
            )}
          >
            {track.label}
          </button>
        ))}
      </div>
      <audio
        ref={audioRef}
        key={current.url}
        src={current.url}
        controls
        preload="metadata"
        className="w-full"
      />
      {current.hint ? <p className="text-xs text-muted-foreground">{current.hint}</p> : null}
    </div>
  );
}

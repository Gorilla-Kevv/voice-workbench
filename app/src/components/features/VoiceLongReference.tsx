import { useRef, useState } from 'react';
import { AlertTriangle, Headphones, Loader2, Plus, Trash2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { TermTip } from '@/components/features/TermTip';
import { voiceApi } from '@/lib/voices';
import { cn } from '@/lib/utils';
import type { SovitsVoice } from '@/types';

/**
 * 音色行展开里的「日语长参考」区（阶段 30-4）。
 *
 * 为什么单独成组件：这是**唯一一个属于 Irodori 的音色库字段** —— GPT-SoVITS 只读
 * `audio_path`（且硬性要求 3~10 秒），而 Irodori 要的是「多段短句拼起来的长参考」。
 * 两块 UI 的关注点完全不同，混在一个组件里会让「改哪个字段影响哪个引擎」变得难读。
 *
 * 三条照实测写的事实（不许夸大，见方案 §7 前端文案红线）：
 * 1. 官方建议合计 ~30 秒 —— 不是硬门槛，但收益到此基本饱和；
 * 2. 片段要**多段短句**，不要一条长录音（停顿与语气漂移会污染音色）；
 * 3. 转写只在 Speaker Inversion 训练时要用；零样本推理不需要。
 */

/** 可选引擎标签（真源在后端只是一个自由字符串数组，这里给常用值做快捷按钮） */
const ENGINE_TAG_PRESETS: Array<{ value: string; label: string }> = [
  { value: 'irodori', label: 'Irodori（日语）' },
  { value: 'gsv', label: 'GPT-SoVITS' },
  { value: 'netease', label: '网易 Confucius' },
  { value: 'indextts', label: 'IndexTTS' },
];

/** 与后端 `LONG_REF_MAX_SEC` / `LONG_REF_SWEET_SPOT_SEC` 对齐（只用于文案提示，服务端才是真源） */
const TOTAL_MAX_SEC = 120;
const TOTAL_SUGGESTED_SEC = 30;

export interface VoiceLongReferenceProps {
  voice: SovitsVoice;
  /** 任何写操作成功后调用（父组件重新拉列表） */
  onChanged: () => void;
}

export function VoiceLongReference({ voice, onChanged }: VoiceLongReferenceProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draftText, setDraftText] = useState<Record<number, string>>({});
  const fileRef = useRef<HTMLInputElement>(null);

  const clips = voice.ref_clips ?? [];
  const totalSec = voice.ref_clips_total_sec;
  const tags = voice.engine_tags ?? [];

  async function run(action: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await action();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleFiles(files: FileList | null): Promise<void> {
    if (!files || files.length === 0) return;
    // 逐个上传（服务端按「一次一片」设计；并发上传只会互相覆盖 updated_at）
    for (const file of Array.from(files)) {
      await run(() => voiceApi.addRefClip(voice.id, file));
    }
    if (fileRef.current) fileRef.current.value = '';
  }

  async function toggleTag(value: string): Promise<void> {
    const next = tags.includes(value) ? tags.filter((tag) => tag !== value) : [...tags, value];
    await run(() => voiceApi.updateVoice(voice.id, { engine_tags: next }));
  }

  return (
    <div className="space-y-3 rounded-md border border-violet-500/25 bg-violet-500/5 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label className="flex items-center gap-1.5 text-xs">
          <Headphones className="size-3.5 text-violet-600 dark:text-violet-400" />
          日语长参考（Irodori 用）
          <TermTip term="参考音频">?</TermTip>
        </Label>
        <span
          className={cn(
            'text-[11px]',
            totalSec > TOTAL_MAX_SEC
              ? 'text-destructive'
              : totalSec >= TOTAL_SUGGESTED_SEC
                ? 'text-emerald-600 dark:text-emerald-400'
                : 'text-muted-foreground',
          )}
        >
          合计 {totalSec.toFixed(0)} 秒 · {clips.length} 片
          {totalSec === 0 ? '（官方建议 ~30 秒）' : totalSec < TOTAL_SUGGESTED_SEC ? '（官方建议 ~30 秒）' : ''}
        </span>
      </div>

      <p className="text-[11px] text-muted-foreground">
        Irodori 要的是「多段短句拼接」的长参考，而不是一条长录音 —— 停顿与语气漂移会污染音色。
        GPT-SoVITS 不使用这里的片段（它只读上方那条 3~10 秒的主音频）。
      </p>

      {clips.length > 0 ? (
        <ul className="space-y-1.5">
          {clips.map((clip, index) => (
            <li key={`${clip.path}-${index}`} className="space-y-1.5 rounded border border-border/60 bg-background/60 p-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="secondary" className="shrink-0 text-[10px]">
                  #{index + 1}
                </Badge>
                <span className="text-[11px] text-muted-foreground">
                  {clip.dur_s != null ? `${clip.dur_s.toFixed(1)} 秒` : '时长未知'}
                  {clip.sample_rate ? ` · ${clip.sample_rate} Hz` : ''}
                </span>
                <div className="ml-auto flex items-center gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-[11px] text-destructive hover:text-destructive"
                    disabled={busy}
                    onClick={() => void run(() => voiceApi.removeRefClip(voice.id, index))}
                  >
                    <Trash2 className="size-3" />
                    删除
                  </Button>
                </div>
              </div>
              <audio controls preload="none" className="h-7 w-full" src={voiceApi.refClipAudioUrl(voice.id, index)} />
              <div className="flex items-center gap-1.5">
                <Input
                  className="h-7 text-[11px]"
                  placeholder="这一片的转写（训练要用；零样本推理不需要）"
                  value={draftText[index] ?? clip.text ?? ''}
                  onChange={(event) => setDraftText((prev) => ({ ...prev, [index]: event.target.value }))}
                />
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 shrink-0 px-2 text-[11px]"
                  disabled={busy || (draftText[index] ?? clip.text ?? '') === (clip.text ?? '')}
                  onClick={() =>
                    void run(() => voiceApi.updateRefClip(voice.id, index, draftText[index] ?? ''))
                  }
                >
                  保存
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded border border-dashed border-border/60 p-2 text-center text-[11px] text-muted-foreground">
          还没有长参考片段。上传几段 3~15 秒的日语短句，合计 ~30 秒即可。
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={fileRef}
          type="file"
          accept="audio/*"
          multiple
          className="hidden"
          onChange={(event) => void handleFiles(event.target.files)}
        />
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-[11px]"
          disabled={busy || totalSec >= TOTAL_MAX_SEC}
          onClick={() => fileRef.current?.click()}
        >
          {busy ? <Loader2 className="size-3 animate-spin" /> : <Plus className="size-3" />}
          添加片段（可多选）
        </Button>
        {totalSec >= TOTAL_MAX_SEC ? (
          <span className="text-[11px] text-destructive">已达 {TOTAL_MAX_SEC} 秒上限，请先删掉一些</span>
        ) : null}
      </div>

      <div className="space-y-1.5 border-t border-border/60 pt-2">
        <Label className="text-[11px]">适用引擎（标注用，不影响合成行为）</Label>
        <div className="flex flex-wrap gap-1.5">
          {ENGINE_TAG_PRESETS.map((preset) => {
            const active = tags.includes(preset.value);
            return (
              <Button
                key={preset.value}
                size="sm"
                variant={active ? 'default' : 'outline'}
                className="h-6 px-2 text-[10px]"
                disabled={busy}
                onClick={() => void toggleTag(preset.value)}
              >
                {preset.label}
              </Button>
            );
          })}
        </div>
        <p className="text-[10px] text-muted-foreground">
          留空 = 未标注（所有引擎都能选到）。GPT-SoVITS 选音色时只校验主音频时长，与这里的标签无关。
        </p>
      </div>

      {voice.ref_clips_missing_text > 0 ? (
        <p className="flex items-start gap-1.5 text-[11px] text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" />
          {voice.ref_clips_missing_text} 个片段缺转写 —— 零样本克隆不受影响，但 Speaker Inversion 训练需要它。
        </p>
      ) : null}

      {error ? (
        <p className="rounded bg-destructive/10 p-2 text-[11px] text-destructive">{error}</p>
      ) : null}
    </div>
  );
}

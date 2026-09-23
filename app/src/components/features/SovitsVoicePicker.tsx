import { useEffect, useState } from 'react';
import { AlertTriangle, Loader2, RefreshCw, Waves } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { sovitsApi } from '@/lib/sovits';
import { cn } from '@/lib/utils';
import type { SovitsCatalog, SovitsVoice } from '@/types';

export interface SovitsSelection {
  voiceId: string;
  version: string;
  textLang: string;
  splitMethod: string;
  promptLang: string;
}

interface SovitsVoicePickerProps {
  value: SovitsSelection;
  onChange: (next: SovitsSelection) => void;
}

/**
 * GPT-SoVITS 的音色选择器。
 *
 * 与 MiMo 的 `VoicePicker` 形态相似但语义完全不同：这里列的是**你导入的参考音频**，
 * 而不是官方预置音色。默认把音色库拉一遍并自动选中第一个可用音色，
 * 让「切到本地模型就能直接试」成立。
 */
export function SovitsVoicePicker({ value, onChange }: SovitsVoicePickerProps) {
  const [voices, setVoices] = useState<SovitsVoice[]>([]);
  const [catalog, setCatalog] = useState<SovitsCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const [voiceResult, catalogResult] = await Promise.all([
        sovitsApi.listVoices(),
        sovitsApi.catalog().catch(() => null),
      ]);
      setVoices(voiceResult.voices);
      if (catalogResult) setCatalog(catalogResult.catalog);
      setError(null);
      if (!value.voiceId && voiceResult.voices.length > 0) {
        onChange({ ...value, voiceId: voiceResult.voices[0].id });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '无法读取音色库');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // 只在首次挂载时拉取；用户点「刷新」时手动重新拉
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selected = voices.find((voice) => voice.id === value.voiceId);

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs">
        <p className="flex items-center gap-1.5 font-medium text-destructive">
          <AlertTriangle className="size-3.5" />
          GPT-SoVITS 本地服务不可用
        </p>
        <p className="mt-1 text-muted-foreground">{error}</p>
        <Button size="sm" variant="outline" className="mt-2" onClick={() => void load()}>
          <RefreshCw className="mr-1.5 size-3" />
          重试
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="flex items-center gap-1.5">
            <Waves className="size-3.5" />
            本地音色
          </Label>
          <Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={cn('size-3', loading && 'animate-spin')} />
          </Button>
        </div>
        <Select
          value={value.voiceId}
          onValueChange={(next) => {
            const voice = voices.find((item) => item.id === next);
            onChange({ ...value, voiceId: next, promptLang: voice?.prompt_lang ?? value.promptLang });
          }}
          disabled={loading || voices.length === 0}
        >
          <SelectTrigger>
            <SelectValue
              placeholder={loading ? '正在读取音色库…' : voices.length === 0 ? '音色库为空' : '选择音色'}
            />
          </SelectTrigger>
          <SelectContent>
            {voices.map((voice) => (
              <SelectItem key={voice.id} value={voice.id}>
                <span className="flex items-center gap-2">
                  {voice.name}
                  <span className="text-xs text-muted-foreground">
                    {voice.duration_s ? `${voice.duration_s.toFixed(1)}s` : '时长未知'}
                  </span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {loading ? (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />
            正在读取本地音色库…
          </p>
        ) : voices.length === 0 ? (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            音色库为空。GPT-SoVITS 没有内置音色，请先到「音色库」导入一段 3~10 秒的参考音频。
          </p>
        ) : selected?.warnings.length ? (
          <p className="text-xs text-amber-600 dark:text-amber-400">{selected.warnings[0]}</p>
        ) : null}
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-2">
          <Label className="text-xs">模型版本</Label>
          <Select value={value.version} onValueChange={(next) => onChange({ ...value, version: next })}>
            <SelectTrigger className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(catalog?.versions ?? [{ id: 'v2ProPlus', label: 'v2ProPlus' }]).map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label className="text-xs">文本语种</Label>
          <Select value={value.textLang} onValueChange={(next) => onChange({ ...value, textLang: next })}>
            <SelectTrigger className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(catalog?.languages ?? [{ id: 'zh', label: '中文' }]).map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label className="text-xs">切分方式</Label>
          <Select value={value.splitMethod} onValueChange={(next) => onChange({ ...value, splitMethod: next })}>
            <SelectTrigger className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(catalog?.text_split_methods ?? [{ id: 'cut5', label: 'cut5' }]).map((item) => (
                <SelectItem key={item.id} value={item.id} title={item.note}>
                  {item.id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        <Badge variant="secondary" className="h-5 text-[10px] font-normal">
          零样本 5 秒起
        </Badge>
        <Badge variant="secondary" className="h-5 text-[10px] font-normal">
          少样本微调 1 分钟起
        </Badge>
        <Badge variant="secondary" className="h-5 text-[10px] font-normal">
          支持中英日韩粤跨语言
        </Badge>
        <Badge variant="secondary" className="h-5 text-[10px] font-normal">
          数据不出本机
        </Badge>
      </div>
    </div>
  );
}

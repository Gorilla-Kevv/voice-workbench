import { useState } from 'react';
import { Check, Mic2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { LANGUAGE_FILTERS } from '@/lib/constants';
import { cn } from '@/lib/utils';
import type { PresetVoice } from '@/types';

interface VoicePickerProps {
  voices: PresetVoice[];
  value: string;
  onChange: (voiceId: string) => void;
}

type LanguageFilter = 'all' | '中文' | '英文';

/** 官方预置音色选择器，支持按语言族筛选 */
export function VoicePicker({ voices, value, onChange }: VoicePickerProps) {
  const [language, setLanguage] = useState<LanguageFilter>('all');

  // 「自适应」（MiMo 默认）在任一语言筛选下都保留，避免默认音色被筛掉
  const filtered =
    language === 'all' ? voices : voices.filter((voice) => voice.language === language || voice.language === '自适应');

  const active = LANGUAGE_FILTERS.find((item) => item.id === language);

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {LANGUAGE_FILTERS.map((item) => {
          const selected = language === item.id;
          return (
            <Button
              key={item.id}
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setLanguage(item.id)}
              className={cn(
                'h-7 rounded-full px-3 text-xs font-normal transition',
                selected
                  ? 'border-violet-500 bg-violet-500/10 text-violet-700 dark:text-violet-300'
                  : 'hover:border-violet-300',
              )}
            >
              {item.label}
            </Button>
          );
        })}
        {active ? <span className="text-[11px] text-muted-foreground">{active.hint}</span> : null}
      </div>

      <div role="radiogroup" aria-label="预置音色选择" className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {filtered.map((voice) => {
          const selected = value === voice.id;
          return (
            <button
              key={voice.id}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(voice.id)}
              className={cn(
                'group relative flex flex-col gap-1 rounded-xl border p-3 text-left transition',
                selected
                  ? 'border-violet-500 bg-violet-500/5 shadow-sm ring-1 ring-violet-500/30'
                  : 'hover:border-violet-300 hover:bg-muted/60',
              )}
            >
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    'flex size-7 items-center justify-center rounded-lg text-xs font-semibold',
                    selected ? 'bg-violet-600 text-white' : 'bg-muted text-muted-foreground',
                  )}
                >
                  <Mic2 className="size-3.5" />
                </span>
                <span className="text-sm font-medium">{voice.label}</span>
                {selected ? <Check className="ml-auto size-4 text-violet-600" /> : null}
              </div>
              <p className="line-clamp-2 text-xs text-muted-foreground">{voice.description}</p>
              <div className="mt-0.5 flex gap-1">
                <Badge variant="secondary" className="h-5 px-1.5 text-[10px] font-normal">
                  {voice.language}
                </Badge>
                <Badge variant="secondary" className="h-5 px-1.5 text-[10px] font-normal">
                  {voice.gender}
                </Badge>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

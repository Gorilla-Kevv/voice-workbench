import { useMemo, useState } from 'react';
import { Languages, Lightbulb, Loader2, Palette, Sparkles, Wand2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import { ResultPanel } from '@/components/features/ResultPanel';
import { DESIGN_LANGUAGE_PRESETS, DESIGN_PRESETS, DESIGN_TIPS } from '@/lib/constants';
import { cn } from '@/lib/utils';
import type { SynthesisController } from '@/hooks/useSynthesis';
import type { AppSettings } from '@/types';

interface VoiceDesignPageProps {
  settings: AppSettings;
  controller: SynthesisController;
  maxTextLength: number;
}

/** 音色设计：用自然语言描述生成全新音色（mimo-v2.5-tts-voicedesign） */
export function VoiceDesignPage({ settings, controller, maxTextLength }: VoiceDesignPageProps) {
  const [description, setDescription] = useState(DESIGN_PRESETS[0].description);
  const [text, setText] = useState('夜色渐深，窗外的风轻轻拂过树叶。愿你今夜有个好梦，明天醒来依旧是晴朗的一天。');
  const [optimize, setOptimize] = useState(settings.optimizeTextPreview);

  const descriptionHint = useMemo(() => {
    const length = description.trim().length;
    if (length === 0) return { tone: 'text-muted-foreground', message: '请填写音色描述，这是该模式的必填项' };
    if (length < 20) return { tone: 'text-amber-600', message: '描述偏短，补充音色质感与语速会更精确' };
    if (length > 300) return { tone: 'text-amber-600', message: '描述偏长，官方建议控制在 1～4 句话' };
    return { tone: 'text-emerald-600', message: '描述长度合适' };
  }, [description]);

  const handleSubmit = () => {
    if (!description.trim() || !text.trim()) return;
    void controller.run(
      {
        mode: 'design',
        text,
        instruction: description.trim(),
        format: 'wav',
        optimizeTextPreview: optimize,
        autoSegment: settings.autoSegment,
        apiKey: settings.apiKey || undefined,
        baseUrl: settings.baseUrl || undefined,
      },
      {
        voiceLabel: description.trim().slice(0, 12) + (description.trim().length > 12 ? '…' : ''),
        voiceDescription: description.trim(),
        providerId: settings.providerId,
        providerFields: settings.providerFields[settings.providerId],
        apiKey: settings.apiKey || undefined,
        baseUrl: settings.baseUrl || undefined,
      },
    );
  };

  return (
    <div className="grid gap-5 lg:grid-cols-5">
      <div className="space-y-5 lg:col-span-3">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Palette className="size-4 text-violet-600 dark:text-violet-400" />
              音色描述
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-1.5">
              {DESIGN_PRESETS.map((preset) => (
                <Button
                  key={preset.name}
                  type="button"
                  size="sm"
                  variant="outline"
                  className={cn(
                    'h-7 rounded-full px-3 text-xs font-normal',
                    description === preset.description
                      ? 'border-violet-500 bg-violet-500/10 text-violet-700 dark:text-violet-300'
                      : 'hover:border-violet-300',
                  )}
                  onClick={() => setDescription(preset.description)}
                >
                  {preset.name}
                </Button>
              ))}
            </div>

            {/* 外语与口音：官方预置音色仅中英两族，此处为实验性路径 */}
            <div className="space-y-2 rounded-lg border border-dashed bg-muted/40 p-3">
              <p className="flex items-center gap-1.5 text-xs font-medium">
                <Languages className="size-3.5 text-violet-500" />
                外语与口音（实验性）
              </p>
              <div className="flex flex-wrap gap-1.5">
                {DESIGN_LANGUAGE_PRESETS.map((preset) => (
                  <Button
                    key={preset.name}
                    type="button"
                    size="sm"
                    variant="outline"
                    title={preset.note}
                    className={cn(
                      'h-7 rounded-full px-3 text-xs font-normal',
                      description === preset.description
                        ? 'border-violet-500 bg-violet-500/10 text-violet-700 dark:text-violet-300'
                        : 'hover:border-violet-300',
                    )}
                    onClick={() => setDescription(preset.description)}
                  >
                    {preset.name}
                  </Button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                预置音色官方仅开放中文与 English 两族。描述外语口音时使用英文通常更精确；
                日语、韩语等语种官方暂未开放，需自行验证效果。
              </p>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="description">描述文本（必填）</Label>
                <span className={cn('text-xs', descriptionHint.tone)}>{descriptionHint.message}</span>
              </div>
              <Textarea
                id="description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                rows={4}
                placeholder="例如：年轻女性，音色温柔清亮，语速舒缓，带着安抚与陪伴的亲切感"
                className="resize-y leading-relaxed"
              />
            </div>

            <div className="rounded-lg border border-dashed bg-muted/40 p-3">
              <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium">
                <Lightbulb className="size-3.5 text-amber-500" />
                官方撰写要点
              </p>
              <ul className="space-y-1">
                {DESIGN_TIPS.map((tip) => (
                  <li key={tip} className="flex gap-1.5 text-xs text-muted-foreground">
                    <span className="text-violet-500">·</span>
                    {tip}
                  </li>
                ))}
              </ul>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Wand2 className="size-4 text-violet-600 dark:text-violet-400" />
              试听文本
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="design-text">合成内容</Label>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {text.length} / {maxTextLength}
                </span>
              </div>
              <Textarea
                id="design-text"
                value={text}
                onChange={(event) => setText(event.target.value)}
                rows={5}
                placeholder="输入用于试听的文本，内容气质应与音色描述相匹配"
                className="resize-y leading-relaxed"
              />
              <p className="text-xs text-muted-foreground">
                官方提示：合成文本要与音色贴合，温柔治愈系女声搭配晚安独白远比体育解说自然
              </p>
            </div>

            <Separator />

            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label htmlFor="optimize" className="cursor-pointer text-sm">
                  智能润色播报文本
                </Label>
                <p className="text-xs text-muted-foreground">
                  开启后由模型对文本做口语化润色，更贴合生成音色的表达习惯
                </p>
              </div>
              <Switch id="optimize" checked={optimize} onCheckedChange={setOptimize} />
            </div>

            <Button
              onClick={handleSubmit}
              disabled={controller.loading || !description.trim() || !text.trim()}
              className="w-full bg-gradient-to-r from-violet-600 to-indigo-500 text-white shadow-lg shadow-violet-500/20 hover:brightness-110"
              size="lg"
            >
              {controller.loading ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
              {controller.loading ? `正在生成音色，已等待 ${controller.elapsed} 秒` : '生成音色并试听'}
            </Button>

            <div className="flex flex-wrap gap-1.5">
              <Badge variant="secondary" className="text-[11px] font-normal">
                模型：mimo-v2.5-tts-voicedesign
              </Badge>
              <Badge variant="secondary" className="text-[11px] font-normal">
                无需音频样本
              </Badge>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="lg:col-span-2">
        <ResultPanel
          result={controller.result}
          loading={controller.loading}
          elapsed={controller.elapsed}
          error={controller.error}
          settings={settings}
          onRetry={() => void controller.retry()}
          onDismissError={controller.clearError}
          emptyHint="填写音色描述与试听文本后点击生成，新音色会在这里试听"
        />
      </div>
    </div>
  );
}

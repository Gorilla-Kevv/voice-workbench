import { useState } from 'react';
import { Loader2, Mic2, ShieldCheck, Sparkles, Wand2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import { SamplePicker } from '@/components/features/SamplePicker';
import { ResultPanel } from '@/components/features/ResultPanel';
import type { SynthesisController } from '@/hooks/useSynthesis';
import type { AppSettings, VoiceSample } from '@/types';

interface VoiceClonePageProps {
  settings: AppSettings;
  controller: SynthesisController;
  maxTextLength: number;
}

/** 声音克隆：上传或录制样本复刻音色（mimo-v2.5-tts-voiceclone） */
export function VoiceClonePage({ settings, controller, maxTextLength }: VoiceClonePageProps) {
  const [sample, setSample] = useState<VoiceSample | null>(null);
  const [text, setText] = useState('这是一段使用克隆音色合成的示例语音，可以在历史记录中随时回听。');
  const [instruction, setInstruction] = useState('');

  const handleSubmit = () => {
    if (!sample || !text.trim()) return;
    void controller.run(
      {
        mode: 'clone',
        text,
        instruction: instruction.trim() || undefined,
        voice: sample.dataUri,
        format: 'wav',
        autoSegment: settings.autoSegment,
        apiKey: settings.apiKey || undefined,
        baseUrl: settings.baseUrl || undefined,
      },
      {
        voiceLabel: `克隆·${sample.name.replace(/\.[^.]+$/, '').slice(0, 10)}`,
        instruction: instruction.trim() || undefined,
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
              <Mic2 className="size-4 text-violet-600 dark:text-violet-400" />
              提供音色样本
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <SamplePicker
              value={sample}
              onChange={setSample}
              onError={(message) => toast.error(message, { description: '请调整音频后重新上传' })}
            />

            <div className="flex items-start gap-2 rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">
              <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-emerald-600" />
              <p>
                样本仅在本次请求中转发给 MiMo 接口用于音色复刻，不会保存到服务器。请确保你拥有所克隆声音的合法授权，
                不要用于伪造他人身份或任何违法用途。
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Wand2 className="size-4 text-violet-600 dark:text-violet-400" />
              克隆合成内容
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="clone-text">目标文本</Label>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {text.length} / {maxTextLength}
                </span>
              </div>
              <Textarea
                id="clone-text"
                value={text}
                onChange={(event) => setText(event.target.value)}
                rows={5}
                placeholder="输入需要以克隆音色朗读的文本"
                className="resize-y leading-relaxed"
              />
            </div>

            <Separator />

            <div className="space-y-2">
              <Label htmlFor="clone-instruction">语气指令（可选）</Label>
              <Textarea
                id="clone-instruction"
                value={instruction}
                onChange={(event) => setInstruction(event.target.value)}
                rows={2}
                placeholder="例如：用沉稳平静的语气缓缓道来，语速稍慢"
                className="resize-y text-sm"
              />
            </div>

            <Button
              onClick={handleSubmit}
              disabled={controller.loading || !sample || !text.trim()}
              className="w-full bg-gradient-to-r from-violet-600 to-indigo-500 text-white shadow-lg shadow-violet-500/20 hover:brightness-110"
              size="lg"
            >
              {controller.loading ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
              {controller.loading ? `正在克隆音色，已等待 ${controller.elapsed} 秒` : '使用克隆音色合成'}
            </Button>
            {!sample ? <p className="text-center text-xs text-muted-foreground">请先上传或录制一段音频样本</p> : null}

            <div className="flex flex-wrap gap-1.5">
              <Badge variant="secondary" className="text-[11px] font-normal">
                模型：mimo-v2.5-tts-voiceclone
              </Badge>
              <Badge variant="secondary" className="text-[11px] font-normal">
                零样本复刻
              </Badge>
              <Badge variant="secondary" className="text-[11px] font-normal">
                样本 ≤ 10MB
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
          emptyHint="提供音色样本与文本后点击合成，克隆效果会在这里试听"
        />
      </div>
    </div>
  );
}

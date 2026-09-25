import { useCallback, useMemo, useRef, useState } from 'react';
import { AudioLines, Info, Languages, Loader2, Music, Sparkles, TriangleAlert, Wand2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { TermTip } from '@/components/features/TermTip';
import { FlowGuide } from '@/components/features/FlowGuide';
import { Separator } from '@/components/ui/separator';
import { TagPicker } from '@/components/features/TagPicker';
import { VoicePicker } from '@/components/features/VoicePicker';
import { SovitsVoicePicker, type SovitsSelection } from '@/components/features/SovitsVoicePicker';
import { ResultPanel } from '@/components/features/ResultPanel';
import { AUDIO_TAGS, DIALECT_PRESETS, STYLE_TAGS } from '@/lib/constants';
import { cn } from '@/lib/utils';
import type { SynthesisController } from '@/hooks/useSynthesis';
import type { AppSettings, PresetVoice } from '@/types';

interface SynthesisPageProps {
  presets: PresetVoice[];
  settings: AppSettings;
  controller: SynthesisController;
  maxTextLength: number;
}

/**
 * 通用语音合成。
 *
 * 同一套界面服务两条链路：
 *  - **MiMo（云端）**：预置音色 + 风格标签 + 音频标签 + 唱歌模式，这些都是 MiMo 独有的提示词能力；
 *  - **GPT-SoVITS（本地）**：音色来自你导入的参考音频，参数是采样与切分，标签类能力不适用（会被当成正文读出来）。
 *
 * 因此这里按 Provider 切换整块输入区，而不是把两套控件混在一起 ——
 * 混在一起会让用户以为标签对本地模型也生效。
 */
export function SynthesisPage({ presets, settings, controller, maxTextLength }: SynthesisPageProps) {
  const isSovits = settings.providerId === 'gpt-sovits';

  const [voiceId, setVoiceId] = useState(presets[0]?.id ?? 'mimo_default');
  const [styles, setStyles] = useState<string[]>([]);
  const [singing, setSinging] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [body, setBody] = useState('你好，欢迎使用 MiMo 语音合成服务。这里可以把任意文字变成自然流畅的语音。');
  const [sovits, setSovits] = useState<SovitsSelection>({
    voiceId: '',
    version: 'v2ProPlus',
    textLang: 'zh',
    splitMethod: 'cut5',
    promptLang: 'zh',
  });
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const prefix = useMemo(() => {
    const parts: string[] = [];
    if (singing) parts.push('(唱歌)');
    if (styles.length > 0) parts.push(`(${styles.join(' ')})`);
    return parts.join('');
  }, [singing, styles]);

  const finalText = prefix ? `${prefix} ${body}` : body;
  const voice = presets.find((item) => item.id === voiceId);

  /** 粗略判断正文主要语言，用于提示音色与文本是否匹配 */
  const textLanguage = useMemo<'中文' | '英文' | null>(() => {
    const chinese = (body.match(/[\u4e00-\u9fa5]/g) ?? []).length;
    const latin = (body.match(/[a-zA-Z]/g) ?? []).length;
    if (chinese === 0 && latin === 0) return null;
    return chinese >= latin ? '中文' : '英文';
  }, [body]);

  const voiceLanguage = voice?.language;
  const langMismatch =
    textLanguage !== null && voiceLanguage !== undefined && voiceLanguage !== '自适应' && textLanguage !== voiceLanguage;

  /** 在光标位置插入音频标签 */
  const insertTag = useCallback((tag: string) => {
    const snippet = `[${tag}]`;
    const textarea = textareaRef.current;
    if (!textarea) {
      setBody((prev) => prev + snippet);
      return;
    }
    const start = textarea.selectionStart ?? body.length;
    const end = textarea.selectionEnd ?? start;
    const next = body.slice(0, start) + snippet + body.slice(end);
    setBody(next);
    requestAnimationFrame(() => {
      textarea.focus();
      const cursor = start + snippet.length;
      textarea.setSelectionRange(cursor, cursor);
    });
  }, [body]);

  const toggleStyle = useCallback((tag: string) => {
    setStyles((prev) => (prev.includes(tag) ? prev.filter((item) => item !== tag) : [...prev, tag]));
  }, []);

  /** 方言之间互斥：选中新方言时移除其它方言，保留情绪与语调类风格标签 */
  const toggleDialect = useCallback((tag: string) => {
    setStyles((prev) => {
      if (prev.includes(tag)) return prev.filter((item) => item !== tag);
      const dialectTags = DIALECT_PRESETS.map((item) => item.tag);
      return [...prev.filter((item) => !dialectTags.includes(item)), tag];
    });
  }, []);

  const handleSubmit = () => {
    if (!finalText.trim()) return;

    if (isSovits) {
      // 本地模型：把页面上的选择叠加到 Provider 字段上，
      // 这样「默认音色」既可以在设置页固化，也可以在这里临时改。
      void controller.run(
        {
          mode: 'preset',
          text: finalText,
          voice: sovits.voiceId || undefined,
          format: 'wav',
          autoSegment: settings.autoSegment,
        },
        {
          voiceLabel: sovits.voiceId ? '本地音色' : '未选择音色',
          providerId: settings.providerId,
          providerFields: {
            ...(settings.providerFields['gpt-sovits'] ?? {}),
            voice: sovits.voiceId,
            version: sovits.version,
            prompt_lang: sovits.promptLang,
            text_lang: sovits.textLang,
            text_split_method: sovits.splitMethod,
          },
        },
      );
      return;
    }

    void controller.run(
      {
        mode: 'preset',
        text: finalText,
        instruction: instruction.trim() || undefined,
        voice: voiceId,
        format: 'wav',
        autoSegment: settings.autoSegment,
        apiKey: settings.apiKey || undefined,
        baseUrl: settings.baseUrl || undefined,
      },
      {
        voiceLabel: voice?.label ?? voiceId,
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
              <AudioLines className="size-4 text-violet-600 dark:text-violet-400" />
              选择预置音色
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {isSovits ? (
              <SovitsVoicePicker value={sovits} onChange={setSovits} />
            ) : (
              <VoicePicker voices={presets} value={voiceId} onChange={setVoiceId} />
            )}

            {!isSovits ? (
              <>
                <Separator />

                {/* 方言与地域腔调：以整体风格标签的形式写入文本开头 */}
                <div className="space-y-2.5">
                  <div className="flex items-center gap-2">
                    <Languages className="size-4 text-muted-foreground" />
                    <Label className="text-sm">
                <TermTip term="方言">方言与地域腔调</TermTip>
              </Label>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {DIALECT_PRESETS.map((item) => {
                      const active = styles.includes(item.tag);
                      return (
                        <Button
                          key={item.tag}
                          type="button"
                          size="sm"
                          variant="outline"
                          title={`${item.desc}｜示例：${item.sample}`}
                          onClick={() => toggleDialect(item.tag)}
                          className={cn(
                            'h-7 rounded-full px-3 text-xs font-normal',
                            active
                              ? 'border-violet-500 bg-violet-500/10 text-violet-700 dark:text-violet-300'
                              : 'hover:border-violet-300',
                          )}
                        >
                          ({item.tag})
                        </Button>
                      );
                    })}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    点击即以整体风格标签写入文本开头，形如{' '}
                    <code className="rounded bg-muted px-1">(粤语)正文</code>；
                    方言之间互斥，可与情绪类风格标签叠加。粤语等方言建议直接使用对应书面用字。
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    官方当前开放中文（普通话及上述方言）与 English 两族音色。其它语种未正式开放，若需外语语感，
                    可到「音色设计」页通过描述语言与口音做实验性尝试。
                  </p>

                  {/* 文本语言与音色语言不一致时温和提示：跨语言合成往往口音不自然 */}
                  {langMismatch ? (
                    <p className="flex items-start gap-1.5 rounded-lg bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-300">
                      <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                      <span>
                        文本以「{textLanguage}」为主，而所选音色为「{voiceLanguage}」。
                        跨语言合成可能出现口音不自然，建议改用对应语言的音色。
                      </span>
                    </p>
                  ) : null}
                </div>

                <Separator />

                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Music className="size-4 text-muted-foreground" />
                      <Label htmlFor="singing" className="cursor-pointer text-sm">
                        唱歌模式
                      </Label>
                    </div>
                    <Switch id="singing" checked={singing} onCheckedChange={setSinging} />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    开启后将在文本最开头添加 <code className="rounded bg-muted px-1">(唱歌)</code> 标记，由
                    mimo-v2.5-tts 以歌唱方式演绎歌词，仅该模型支持。建议歌词使用中文，并避免与强风格标签叠加。
                  </p>
                </div>
              </>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Wand2 className="size-4 text-violet-600 dark:text-violet-400" />
              编辑播报文本
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {!isSovits ? (
              <>
                <div className="space-y-2">
                  <Label>
                <TermTip term="风格标签">整体风格标签</TermTip>
              </Label>
                  <TagPicker
                    groups={STYLE_TAGS}
                    selected={styles}
                    onToggle={toggleStyle}
                    single
                    description="点击标签追加到文本开头的 (风格) 标记中，可多选，空格分隔"
                  />
                </div>

                <Separator />
              </>
            ) : null}

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="body">目标文本</Label>
                <span
                  className={cn(
                    'text-xs tabular-nums',
                    finalText.length > maxTextLength ? 'text-destructive' : 'text-muted-foreground',
                  )}
                >
                  {finalText.length} / {maxTextLength}
                </span>
              </div>
              <Textarea
                id="body"
                ref={textareaRef}
                value={body}
                onChange={(event) => setBody(event.target.value)}
                rows={6}
                placeholder="在此输入需要合成的文本…"
                className="resize-y font-normal leading-relaxed"
              />
              {!isSovits ? (
                <div className="rounded-lg border border-dashed bg-muted/40 p-2.5">
                  <p className="mb-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Info className="size-3.5" />
                    细粒度音频标签：点击插入到光标位置，控制停顿、语气与情绪细节
                  </p>
                  <div className="max-h-32 overflow-y-auto scrollbar-thin">
                    <TagPicker groups={AUDIO_TAGS} selected={[]} onToggle={insertTag} />
                  </div>
                </div>
              ) : (
                <p className="rounded-lg border border-dashed bg-muted/40 p-2.5 text-xs text-muted-foreground">
                  本地模型按文本字面合成，不支持音频/风格标签。需要控制停顿与情绪时，
                  可以改用更细的切分方式（cut4 / cut5），或把停顿写成逗号与句号。
                </p>
              )}
            </div>

            <Separator />

            {!isSovits ? (
              <div className="space-y-2">
                <Label htmlFor="instruction">语气指令（可选）</Label>
                <Textarea
                  id="instruction"
                  value={instruction}
                  onChange={(event) => setInstruction(event.target.value)}
                  rows={2}
                  placeholder="例如：用轻快上扬的语调播报，语速稍快，声音明亮有活力"
                  className="resize-y text-sm"
                />
                <p className="text-xs text-muted-foreground">
                  该内容作为 user 消息发送，用于调整语气与风格，不会出现在合成语音中
                </p>
              </div>
            ) : null}

            <div className="rounded-lg bg-muted/50 p-3">
              <p className="mb-1 text-xs font-medium text-muted-foreground">最终发送文本预览</p>
              <p className="max-h-24 overflow-y-auto scrollbar-thin font-mono text-xs leading-relaxed">{finalText}</p>
            </div>

            <Button
              onClick={handleSubmit}
              disabled={controller.loading || !finalText.trim()}
              className="w-full bg-gradient-to-r from-violet-600 to-indigo-500 text-white shadow-lg shadow-violet-500/20 hover:brightness-110"
              size="lg"
            >
              {controller.loading ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
              {controller.loading ? `正在合成，已等待 ${controller.elapsed} 秒` : '开始合成语音'}
            </Button>
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
          emptyHint="选择音色并输入文本后点击「开始合成语音」，结果会在这里出现"
        />
      </div>

      {/* 官方推荐流程（推理与合成设置两步）：贴在右边缘，鼠标移过去即展开 */}
      <FlowGuide page="synthesis" />
    </div>
  );
}

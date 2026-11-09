import { useCallback, useEffect, useMemo, useState } from 'react';
import { AudioLines, Download, Flame, Languages, Loader2, Play, Sparkles } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { ErrorAlert } from '@/components/features/ErrorAlert';
import { RequestError } from '@/lib/errors';
import { cosyvoiceApi } from '@/lib/cosyvoice';
import { voiceApi } from '@/lib/voices';
import { cn } from '@/lib/utils';
import type {
  CosyvoiceCatalog,
  CosyvoiceHealth,
  CosyvoiceSynthPayload,
  CosyvoiceSynthResult,
  SovitsVoice,
} from '@/types';

type Mode = 'zero_shot' | 'cross_lingual' | 'instruct2';
type RefSource = 'voice' | 'path';

function base64ToUrl(base64: string): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
}

function gb(mb: number | null | undefined): string {
  if (mb == null) return '—';
  return `${(mb / 1024).toFixed(1)} GB`;
}

/**
 * CosyVoice3 页面（第六个 Python 运行时，:9886 经网关透传）。
 *
 * 差异点：9 语言 + 18 中文方言 + 自然语言 instruct。页面把「方言」做成
 * 可点击的快捷指令（写进 instruct_text），而不是让用户背标签。
 */
export function CosyvoiceTtsPage() {
  const [catalog, setCatalog] = useState<CosyvoiceCatalog | null>(null);
  const [health, setHealth] = useState<CosyvoiceHealth | null>(null);
  const [voices, setVoices] = useState<SovitsVoice[]>([]);

  const [mode, setMode] = useState<Mode>('zero_shot');
  const [text, setText] = useState('你好，我是 CosyVoice 3，今天想用四川话和你聊两句。');
  const [promptText, setPromptText] = useState('');
  const [instructText, setInstructText] = useState('用四川话说这句话<|endofprompt|>');
  const [language, setLanguage] = useState('zh');
  const [speed, setSpeed] = useState(1.0);

  const [refSource, setRefSource] = useState<RefSource>('voice');
  const [voiceId, setVoiceId] = useState('');
  const [refPath, setRefPath] = useState('');

  const [loading, setLoading] = useState(false);
  const [warming, setWarming] = useState(false);
  const [error, setError] = useState<RequestError | null>(null);
  const [result, setResult] = useState<CosyvoiceSynthResult | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);

  const refreshHealth = useCallback(async () => {
    const next = await cosyvoiceApi.health().catch(() => null);
    if (next) setHealth(next);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [catalogResult, healthResult, voiceResult] = await Promise.all([
        cosyvoiceApi.catalog().catch(() => null),
        cosyvoiceApi.health().catch(() => null),
        voiceApi.listVoices().catch(() => null),
      ]);
      if (cancelled) return;
      if (catalogResult) {
        setCatalog(catalogResult);
        setSpeed(catalogResult.controls.speed.default);
      }
      if (healthResult) setHealth(healthResult);
      if (voiceResult) {
        const list = voiceResult.voices ?? [];
        setVoices(list);
        if (list.length > 0) setVoiceId(list[0].id);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return () => {
      if (audioUrl) URL.revokeObjectURL(audioUrl);
    };
  }, [audioUrl]);

  const selectedVoice = useMemo(
    () => voices.find((voice) => voice.id === voiceId) ?? null,
    [voices, voiceId],
  );

  // 选音色时把它自带的转写带进 prompt_text；用户仍可手改
  useEffect(() => {
    if (selectedVoice?.prompt_text) setPromptText(selectedVoice.prompt_text);
  }, [selectedVoice]);

  const speedRange = catalog?.controls.speed ?? { min: 0.5, max: 2.0, default: 1.0 };
  const modeMeta = catalog?.modes.find((item) => item.id === mode) ?? null;
  const needsPrompt = modeMeta?.requires_prompt_text ?? mode !== 'cross_lingual';
  const needsInstruct = modeMeta?.requires_instruct_text ?? mode === 'instruct2';

  const warmup = async () => {
    setWarming(true);
    setError(null);
    try {
      await cosyvoiceApi.warmup();
      toast.success('CosyVoice3 已加载进显存');
      await refreshHealth();
    } catch (cause) {
      setError(cause instanceof RequestError ? cause : new RequestError(0, {
        code: 'WARMUP_FAILED',
        message: cause instanceof Error ? cause.message : String(cause),
        retryable: true,
      }));
    } finally {
      setWarming(false);
    }
  };

  const unload = async () => {
    try {
      const report = await cosyvoiceApi.unload();
      toast.success(report.freed_mb == null ? '已释放模型' : `已释放模型，归还约 ${report.freed_mb} MB`);
      await refreshHealth();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const submit = async () => {
    setError(null);
    if (!text.trim()) {
      toast.warning('先写要合成的文本');
      return;
    }
    if (refSource === 'voice' && !voiceId) {
      toast.warning('先在音色库选一个参考音色');
      return;
    }
    if (refSource === 'path' && !refPath.trim()) {
      toast.warning('先填参考音频的本机路径');
      return;
    }
    if (needsPrompt && !promptText.trim()) {
      toast.warning('这个模式需要参考音频的逐字转写（prompt_text）');
      return;
    }
    if (needsInstruct && !instructText.trim()) {
      toast.warning('instruct2 模式需要一句指令，例如「用四川话说这句话」');
      return;
    }

    const payload: CosyvoiceSynthPayload = {
      text: text.trim(),
      mode,
      speed,
      ...(refSource === 'voice' ? { ref_voice: voiceId } : { ref_path: refPath.trim() }),
      ...(needsPrompt ? { prompt_text: promptText.trim() } : {}),
      ...(needsInstruct ? { instruct_text: instructText.trim() } : {}),
      ...(mode === 'cross_lingual' ? { language } : {}),
    };

    setLoading(true);
    const startedAt = Date.now();
    try {
      const next = await cosyvoiceApi.synthesize(payload);
      setResult(next);
      setAudioUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return base64ToUrl(next.audio_base64);
      });
      toast.success('合成完成', {
        description: `${next.duration_sec.toFixed(2)}s · RTF ${next.rtf ?? '—'} · 总耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
      });
      await refreshHealth();
    } catch (cause) {
      setError(cause instanceof RequestError ? cause : new RequestError(0, {
        code: 'SYNTH_FAILED',
        message: cause instanceof Error ? cause.message : String(cause),
        retryable: true,
      }));
    } finally {
      setLoading(false);
    }
  };

  const insertDialect = (label: string) => {
    setInstructText(`用${label}说这句话<|endofprompt|>`);
    if (mode !== 'instruct2') setMode('instruct2');
  };

  const ready = health?.weights.ready === true;
  const loaded = health?.loaded === true;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 pb-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <AudioLines className="size-4 text-primary" />
              CosyVoice3 · 方言 / 多语种
            </CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              Fun-CosyVoice3-0.5B · 24kHz · 9 语言 + 18 中文方言 · Apache-2.0
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className={cn('rounded-full border px-2 py-0.5', ready ? 'border-emerald-500/40 text-emerald-600' : 'border-amber-500/40 text-amber-600')}>
              {ready ? '权重就绪' : '权重待补齐'}
            </span>
            <span className={cn('rounded-full border px-2 py-0.5', loaded ? 'border-primary/40 text-primary' : 'border-muted-foreground/30 text-muted-foreground')}>
              {loaded ? '模型已常驻' : '模型未加载'}
            </span>
            <span className="text-muted-foreground">
              空闲 {gb(health?.vram?.free_mb)} / 准入 {gb(health?.configuration.required_vram_mb)}
            </span>
            <Button size="sm" variant="secondary" className="h-7" disabled={warming || !ready} onClick={() => void warmup()}>
              {warming ? <Loader2 className="size-3.5 animate-spin" /> : <Flame className="size-3.5" />}
              加载模型
            </Button>
            <Button size="sm" variant="ghost" className="h-7" disabled={!loaded} onClick={() => void unload()}>
              释放模型
            </Button>
          </div>
        </CardHeader>
        {!ready ? (
          <CardContent className="pt-0 text-xs text-amber-600 dark:text-amber-400">
            环境或权重未齐：先跑 <code className="mx-1 rounded bg-muted px-1">npm run cosyvoice:check</code>
            体检，再 <code className="mx-1 rounded bg-muted px-1">npm run cosyvoice:weights</code> 下载权重。
            {health?.weights.missing?.length ? ` 缺：${health.weights.missing.join('、')}` : null}
          </CardContent>
        ) : null}
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">参考音频</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Tabs value={refSource} onValueChange={(value) => setRefSource(value as RefSource)}>
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="voice">音色库</TabsTrigger>
                <TabsTrigger value="path">本机路径</TabsTrigger>
              </TabsList>
            </Tabs>
            {refSource === 'voice' ? (
              <div className="space-y-1.5">
                <Label htmlFor="cosyvoice-voice">音色</Label>
                <Select value={voiceId} onValueChange={setVoiceId}>
                  <SelectTrigger id="cosyvoice-voice" className="h-9">
                    <SelectValue placeholder={voices.length ? '选择音色' : '音色库为空'} />
                  </SelectTrigger>
                  <SelectContent>
                    {voices.map((voice) => (
                      <SelectItem key={voice.id} value={voice.id}>
                        {voice.name} · {voice.prompt_lang || '未知'} · {voice.duration_s ? `${voice.duration_s.toFixed(1)}s` : '—'}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selectedVoice?.warnings?.length ? (
                  <p className="text-[11px] text-amber-600 dark:text-amber-400">{selectedVoice.warnings.join('；')}</p>
                ) : null}
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label htmlFor="cosyvoice-ref">参考音频路径</Label>
                <input
                  id="cosyvoice-ref"
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  placeholder="例如 voicelib/voices/xxx.wav"
                  value={refPath}
                  onChange={(event) => setRefPath(event.target.value)}
                />
                <p className="text-[11px] text-muted-foreground">参考音 1~30 秒，官方建议 3~10 秒。</p>
              </div>
            )}
            {needsPrompt ? (
              <div className="space-y-1.5">
                <Label htmlFor="cosyvoice-prompt">参考音频逐字转写（prompt_text）</Label>
                <Textarea
                  id="cosyvoice-prompt"
                  className="min-h-[72px]"
                  placeholder="参考音频里说的每一个字；零样本克隆与 instruct 模式必填"
                  value={promptText}
                  onChange={(event) => setPromptText(event.target.value)}
                />
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">模式与控制</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Tabs value={mode} onValueChange={(value) => setMode(value as Mode)}>
              <TabsList className="grid w-full grid-cols-3">
                {(catalog?.modes ?? [
                  { id: 'zero_shot', label: '零样本克隆' },
                  { id: 'cross_lingual', label: '跨语种' },
                  { id: 'instruct2', label: '自然语言指令' },
                ]).map((item) => (
                  <TabsTrigger key={item.id} value={item.id}>{item.label}</TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            <p className="text-[11px] text-muted-foreground">{modeMeta?.note}</p>

            {mode === 'cross_lingual' ? (
              <div className="space-y-1.5">
                <Label htmlFor="cosyvoice-lang">目标语言</Label>
                <Select value={language} onValueChange={setLanguage}>
                  <SelectTrigger id="cosyvoice-lang" className="h-9"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {(catalog?.languages ?? [{ code: 'zh', label: '中文' }]).map((item) => (
                      <SelectItem key={item.code} value={item.code}>{item.label}（&lt;|{item.code}|&gt;）</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}

            {needsInstruct ? (
              <div className="space-y-1.5">
                <Label htmlFor="cosyvoice-instruct">自然语言指令</Label>
                <Textarea
                  id="cosyvoice-instruct"
                  className="min-h-[64px]"
                  placeholder="用四川话说这句话<|endofprompt|>"
                  value={instructText}
                  onChange={(event) => setInstructText(event.target.value)}
                />
                <div className="flex flex-wrap gap-1.5">
                  {(catalog?.dialects.items ?? []).map((item) => (
                    <button
                      key={item.code}
                      type="button"
                      className="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground hover:border-primary/50 hover:text-foreground"
                      onClick={() => insertDialect(item.label)}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {(catalog?.controls.instruct_examples ?? []).map((example) => (
                    <button
                      key={example}
                      type="button"
                      className="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground hover:border-primary/50 hover:text-foreground"
                      onClick={() => setInstructText(example)}
                    >
                      {example.replace('<|endofprompt|>', '')}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label>语速</Label>
                <span className="text-xs tabular-nums text-muted-foreground">{speed.toFixed(2)}×</span>
              </div>
              <Slider
                value={[speed]}
                min={speedRange.min}
                max={speedRange.max}
                step={0.05}
                onValueChange={([value]) => setSpeed(value)}
              />
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">要合成的文本</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea
            className="min-h-[120px]"
            value={text}
            maxLength={catalog?.limits.max_text_length ?? 3000}
            onChange={(event) => setText(event.target.value)}
            placeholder="输入要合成的文本；方言/情感优先用带情绪的参考音，其次用 instruct，最后才是台词插标签"
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[11px] text-muted-foreground">
              {text.length} / {catalog?.limits.max_text_length ?? 3000} 字 · 参考音 {catalog?.limits.min_ref_seconds ?? 1}~{catalog?.limits.max_ref_seconds ?? 30}s
            </p>
            <Button disabled={loading || !ready} onClick={() => void submit()}>
              {loading ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
              {loading ? '合成中…' : '开始合成'}
            </Button>
          </div>
          <ErrorAlert error={error} onDismiss={() => setError(null)} onRetry={() => void submit()} />
        </CardContent>
      </Card>

      {result && audioUrl ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Play className="size-4" />
              合成结果
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <audio controls src={audioUrl} className="w-full" />
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span>时长 {result.duration_sec.toFixed(2)}s</span>
              <span>RTF {result.rtf ?? '—'}</span>
              <span>采样率 {result.sample_rate} Hz</span>
              <span>模式 {result.mode}</span>
              <span>语速 {result.speed.toFixed(2)}×</span>
              {result.voice_name ? <span>音色 {result.voice_name}</span> : null}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <a
                className="inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-xs hover:bg-muted"
                href={audioUrl}
                download={`cosyvoice-${Date.now()}.wav`}
              >
                <Download className="size-3.5" />
                下载 WAV
              </a>
              <code className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">{result.wav_path}</code>
              <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                <Languages className="size-3.5" />
                {result.language ?? '自动'}
              </span>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

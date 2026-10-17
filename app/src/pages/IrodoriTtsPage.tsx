import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AudioLines,
  Dices,
  Download,
  Flame,
  Loader2,
  Play,
  Sparkles,
  Waves,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { TermTip } from '@/components/features/TermTip';
import { Slider } from '@/components/ui/slider';
import { ResourceBudget } from '@/components/features/ResourceBudget';
import { ErrorAlert } from '@/components/features/ErrorAlert';
import { ResultStack, type ResultStackEntry } from '@/components/features/ResultStack';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { useResultStack } from '@/hooks/useResultStack';
import { RequestError } from '@/lib/errors';
import { focusBeforeRun } from '@/lib/arbiter';
import { irodoriApi, isIrodoriTimeout, irodoriRetrySuggestion, withLowerSteps } from '@/lib/irodori';
import { notifyServiceEnabledChanged, runtimeServiceApi } from '@/lib/localService';
import { voiceApi } from '@/lib/voices';
import { cn } from '@/lib/utils';
import type {
  IrodoriCatalog,
  IrodoriHealth,
  IrodoriSpeaker,
  IrodoriSynthPayload,
  IrodoriSynthResult,
} from '@/types';
import type { SovitsVoice } from '@/types';

/**
 * 参考音色的三种来源（与服务端 `synth.resolve_reference` 的三选一一致）。
 *
 * 30-6 之后多了 `speaker`：它是 SI 训练固化下来的 embedding，
 * **不用再给参考音频** —— 一次训练，之后每次合成都直接复用。
 */
type RefSource = 'speaker' | 'voice' | 'path';

interface SynthItem {
  result: IrodoriSynthResult;
  audioUrl: string;
  text: string;
  refLabel: string;
}

/** base64 wav → 可播放 / 可下载的 Blob URL */
function base64ToUrl(base64: string): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
}

/**
 * Irodori-TTS 日语合成页（第四个 Python 运行时，:9884 经网关透传）。
 *
 * 与网易 / IndexTTS 页的差异化价值是**日语 + emoji 风格控制 + 音色固化**：
 * emoji 是官方训练时就带在文本里的风格标记（😊/😡/🥳…），caption 只描述
 * 情绪/环境/语域（不能描述音色，否则会被音色描述污染）。
 *
 * 「服务端是真源」贯穿全页：步数档、emoji 表、caption 预设、护栏参数全部来自
 * `/v1/catalog`，前端不抄常量 —— 服务端换档，界面跟着变，不需要改前端。
 */
export function IrodoriTtsPage() {
  const [catalog, setCatalog] = useState<IrodoriCatalog | null>(null);
  const [health, setHealth] = useState<IrodoriHealth | null>(null);
  const [speakers, setSpeakers] = useState<IrodoriSpeaker[]>([]);
  const [voices, setVoices] = useState<SovitsVoice[]>([]);

  const [text, setText] = useState('これは日本語の音声合成のテストです。今日はいい天気ですね。');
  const [caption, setCaption] = useState('');
  const [schedule, setSchedule] = useState<'linear' | 'sway'>('linear');
  const [steps, setSteps] = useState<number | null>(null);
  const [durationScale, setDurationScale] = useState<number | null>(null);
  const [seed, setSeed] = useState<number | null>(null);

  const [refSource, setRefSource] = useState<RefSource>('speaker');
  const [speakerId, setSpeakerId] = useState('');
  const [voiceId, setVoiceId] = useState('');
  const [refPath, setRefPath] = useState('');

  const [loading, setLoading] = useState(false);
  const [warming, setWarming] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<RequestError | null>(null);
  /** 撞上采样长尾的那次请求，留着给「重试（降步）」用 */
  const [timedOutPayload, setTimedOutPayload] = useState<IrodoriSynthPayload | null>(null);

  const results = useResultStack<SynthItem>({
    limit: 12,
    // 音频是 Blob 地址，刷新后必然失效 → 只在同一次会话内跨页面保留（坑 18）
    storageKey: 'irodori-results',
    onEvict: (item) => URL.revokeObjectURL(item.audioUrl),
  });

  const refreshSpeakers = useCallback(async () => {
    try {
      const response = await irodoriApi.speakers();
      setSpeakers(response.speakers ?? []);
    } catch {
      // 服务没起时不要弹错：状态卡里已经说明了
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [catalogResult, healthResult, voiceResult] = await Promise.all([
        irodoriApi.catalog().catch(() => null),
        irodoriApi.health().catch(() => null),
        voiceApi.listVoices().catch(() => null),
      ]);
      if (cancelled) return;
      if (catalogResult) setCatalog(catalogResult);
      if (healthResult) setHealth(healthResult);
      if (voiceResult) setVoices(voiceResult.voices ?? []);
      await refreshSpeakers();
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshSpeakers]);

  const effectiveSteps = steps ?? catalog?.steps.default ?? 40;
  const effectiveDuration = durationScale ?? catalog?.duration_scale.default ?? 1.0;
  const durationRange = useMemo(
    () => ({
      min: catalog?.duration_scale.min ?? 0.8,
      max: catalog?.duration_scale.max ?? 1.2,
      step: 0.05,
    }),
    [catalog],
  );

  const selectedVoice = voices.find((voice) => voice.id === voiceId) ?? null;

  const refLabel =
    refSource === 'speaker'
      ? speakerId
        ? `固化音色 · ${speakerId}`
        : '未选固化音色'
      : refSource === 'voice'
        ? selectedVoice
          ? `音色库 · ${selectedVoice.name}`
          : '未选音色'
        : refPath
          ? refPath.split(/[\\/]/).pop() || refPath
          : '未填路径';

  /** 服务没起时的快捷开启：走网关托管（与设置页同一后端），不用离开本页 */
  const startService = async () => {
    setStarting(true);
    setError(null);
    try {
      const result = await runtimeServiceApi.toggle('irodori', true);
      notifyServiceEnabledChanged();
      if (!result.reachable) {
        throw new RequestError(503, {
          code: 'IRODORI_START_FAILED',
          message: 'Irodori 服务启动后仍不可达。',
          retryable: true,
          hint: '跑 npm run irodori:check 看缺什么（权重 / venv / 端口）。',
        });
      }
      setHealth(await irodoriApi.health().catch(() => null));
      toast.success('Irodori 服务已启动', { description: '首次加载模型约需 20~30 秒。' });
    } catch (requestError) {
      const normalized =
        requestError instanceof RequestError
          ? requestError
          : new RequestError(0, {
              code: 'IRODORI_START_FAILED',
              message: (requestError as Error)?.message || '启动失败',
              retryable: true,
              hint: '手动启动：npm run dev:irodori。',
            });
      setError(normalized);
    } finally {
      setStarting(false);
    }
  };

  const buildPayload = (overrideSteps?: number): IrodoriSynthPayload => {
    const payload: IrodoriSynthPayload = {
      text,
      num_steps: overrideSteps ?? effectiveSteps,
      schedule,
      duration_scale: effectiveDuration,
    };
    if (caption.trim()) payload.caption = caption.trim();
    if (seed !== null) payload.seed = seed;
    // 三选一：给了固化音色就不需要参考音频（也确实互斥）
    if (refSource === 'speaker' && speakerId) payload.speaker_id = speakerId;
    if (refSource === 'voice' && voiceId) payload.ref_voice = voiceId;
    if (refSource === 'path' && refPath.trim()) payload.ref_path = refPath.trim();
    return payload;
  };

  /**
   * 发一次合成请求。
   *
   * 两种入口：① 正常合成（按当前表单构造 payload）；② 「重试（降步）」——
   * 用的是**上次撞长尾的那份 payload** 加上服务端建议的步数，而不是当前表单
   * （用户可能在失败后改过文本/参数，重试就该重试失败的那一次，别偷偷换成新参数）。
   */
  const synth = (override?: IrodoriSynthPayload) => {
    setError(null);
    setLoading(true);
    void (async () => {
      try {
        // 开跑前把本系统内其它服务的常驻模型让出去（仲裁失败不阻塞，准入由服务端把关）
        void focusBeforeRun('irodori-tts', 3600);
        const payload = override ?? buildPayload();
        const response = await irodoriApi.synthesize(payload);
        setTimedOutPayload(null);
        results.push({
          result: response,
          audioUrl: base64ToUrl(response.audio_base64),
          text,
          refLabel,
        });
        toast.success('合成完成', {
          description: `${response.duration_sec.toFixed(1)} 秒 · ${response.elapsed_sec.toFixed(1)} 秒生成 · ${response.steps_used} 步`,
        });
      } catch (rawError) {
        // 一律转成带 hint 的结构化错误再展示（坑 21：别静默吞掉普通 Error）
        const requestError =
          rawError instanceof RequestError
            ? rawError
            : new RequestError(0, {
                code: 'SYNTH_FAILED',
                message: (rawError as Error)?.message || '合成请求未能发出',
                retryable: true,
                hint: '确认网关与 Irodori 服务在跑（npm run dev + npm run dev:irodori）。',
              });
        setError(requestError);
        // 撞长尾时把原请求留下，好让「重试（降步）」按服务端建议的步数重发
        if (isIrodoriTimeout(requestError)) setTimedOutPayload(buildPayload());
        toast.error('合成失败', { description: requestError.fullMessage });
      } finally {
        setLoading(false);
        void irodoriApi.health().then(setHealth).catch(() => null);
      }
    })();
  };

  const warmup = async () => {
    setWarming(true);
    try {
      // 载入显存前先让另一端把常驻模型卸掉（同 IndexTTS 页的 handleWarmup）
      await focusBeforeRun('irodori-tts', 3600);
      await irodoriApi.warmup();
      setHealth(await irodoriApi.health());
      toast.success('模型已载入显存', { description: '之后的合成不再重复加载。' });
    } catch (requestError) {
      setError(
        requestError instanceof RequestError
          ? requestError
          : new RequestError(0, { code: 'WARMUP_FAILED', message: '预热失败', retryable: true }),
      );
    } finally {
      setWarming(false);
    }
  };

  const unload = async () => {
    try {
      await irodoriApi.unload();
      setHealth(await irodoriApi.health());
      toast.success('已释放显存');
    } catch (requestError) {
      toast.error('释放失败', {
        description: requestError instanceof Error ? requestError.message : String(requestError),
      });
    }
  };

  const entries: ResultStackEntry[] = results.entries.map((entry) => ({
    id: entry.id,
    createdAt: entry.createdAt,
    title: entry.item.refLabel,
    subtitle: `${entry.item.result.duration_sec.toFixed(1)} 秒 · ${entry.item.result.steps_used} 步`,
    summary: entry.item.text,
    content: (
      <div className="space-y-3 pt-1">
        <audio controls src={entry.item.audioUrl} className="w-full" autoPlay={false} />
        <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
          <div className="rounded-lg bg-muted/50 p-2.5">
            <p className="opacity-70">时长</p>
            <p className="mt-0.5 font-medium text-foreground">
              {entry.item.result.duration_sec.toFixed(1)} 秒
            </p>
          </div>
          <div className="rounded-lg bg-muted/50 p-2.5">
            <p className="opacity-70">生成耗时</p>
            <p className="mt-0.5 font-medium text-foreground">
              {entry.item.result.elapsed_sec.toFixed(1)} 秒
            </p>
          </div>
          <div className="rounded-lg bg-muted/50 p-2.5">
            <p className="opacity-70">步数（要的 / 实际）</p>
            <p className="mt-0.5 font-medium text-foreground">
              {entry.item.result.steps_requested} / {entry.item.result.steps_used}
            </p>
          </div>
          <div className="rounded-lg bg-muted/50 p-2.5">
            <p className="opacity-70">采样率</p>
            <p className="mt-0.5 font-medium text-foreground">{entry.item.result.sample_rate} Hz</p>
          </div>
        </div>
        {/* 护栏介入过就说出来：用户听到的是「自动降过步」的版本，不该以为自己设的步数生效了 */}
        {entry.item.result.retried ? (
          <p className="rounded-lg bg-amber-500/10 p-2.5 text-[11px] text-amber-700 dark:text-amber-300">
            撞上采样长尾：服务端从第 {entry.item.result.downgraded_at_segment ?? '?'} 段起自动降步并换了
            seed（{entry.item.result.steps_used} 步 / seed {entry.item.result.used_seed}）。
          </p>
        ) : null}
        <p className="line-clamp-3 rounded-lg bg-muted/50 p-2.5 font-mono text-[11px] leading-relaxed text-muted-foreground">
          {entry.item.text}
        </p>
        <a href={entry.item.audioUrl} download={`irodori-${entry.createdAt}.wav`} className="block">
          <Button variant="outline" className="w-full">
            <Download className="size-4" />
            下载 WAV
          </Button>
        </a>
      </div>
    ),
  }));

  const emojiItems = catalog?.emoji.items ?? [];
  const stepPresets = catalog?.steps.presets ?? [];
  const schedules = catalog?.steps.schedules ?? [
    { value: 'linear', label: 'linear' },
    { value: 'sway', label: 'sway' },
  ];

  return (
    <div className="grid gap-5 lg:grid-cols-5">
      <div className="space-y-5 lg:col-span-3">
        <ResourceBudget task="irodori-tts" irodoriLoaded={health?.loaded ?? false} />

        <ErrorAlert
          error={error}
          onDismiss={() => setError(null)}
          onRetry={
            timedOutPayload
              ? () => synth(withLowerSteps(timedOutPayload, irodoriRetrySuggestion(error)))
              : error?.code === 'IRODORI_UNREACHABLE'
                ? () => void startService()
                : undefined
          }
        />

        {/* 引擎状态：常驻与否 + 手动预热 / 卸载 */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Flame className="size-4 text-violet-600 dark:text-violet-400" />
              引擎状态
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {health ? (
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span
                  className={cn(
                    'rounded-full px-2 py-0.5',
                    health.weights.ready
                      ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                      : 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
                  )}
                >
                  {health.weights.ready ? '权重就绪' : '权重缺失'}
                </span>
                <span
                  className={cn(
                    'rounded-full px-2 py-0.5',
                    health.loaded ? 'bg-violet-500/10 text-violet-700 dark:text-violet-300' : 'bg-muted text-muted-foreground',
                  )}
                >
                  {health.loaded ? '模型常驻' : '未加载'}
                </span>
                {health.weights.training_ready ? (
                  <span className="rounded-full bg-muted px-2 py-0.5">训练档基座已就位</span>
                ) : null}
                {!health.watermark ? (
                  <span className="rounded-full bg-muted px-2 py-0.5">未加水印</span>
                ) : null}
                <span className="ml-auto flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs"
                    disabled={warming || health.loaded}
                    onClick={() => void warmup()}
                  >
                    {warming ? <Loader2 className="size-3 animate-spin" /> : null}
                    预热
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    disabled={!health.loaded}
                    onClick={() => void unload()}
                  >
                    释放显存
                  </Button>
                </span>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span>Irodori 服务未启动（按需模块，默认不随主程序拉起）。</span>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  disabled={starting}
                  onClick={() => void startService()}
                >
                  {starting ? <Loader2 className="size-3 animate-spin" /> : null}
                  启动 Irodori
                </Button>
              </div>
            )}
            {health && !health.weights.ready ? (
              <p className="text-xs text-amber-700 dark:text-amber-300">
                权重缺失：跑 <code className="mx-1 rounded bg-muted px-1">npm run irodori:weights</code>
                下载（约 4GB；训练还要 <code className="mx-1 rounded bg-muted px-1">-- --training</code>）。
              </p>
            ) : null}
          </CardContent>
        </Card>

        {/* 文本与风格 */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <AudioLines className="size-4 text-violet-600 dark:text-violet-400" />
              日语文本与风格
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>文本（日语）</Label>
                <span className="text-[11px] tabular-nums text-muted-foreground">{text.length} 字</span>
              </div>
              <Textarea
                value={text}
                onChange={(event) => setText(event.target.value)}
                rows={4}
                placeholder="今日の会議は午後三時に変更になりました。"
                className="resize-y"
              />
            </div>

            {/* emoji：官方训练时就带在文本里的风格标记，点一下追加到末尾 */}
            {emojiItems.length > 0 ? (
              <div className="space-y-2">
                <Label className="flex items-center gap-1.5">
                  <Sparkles className="size-3.5" />
                  <TermTip term="emoji 风格标记">emoji 风格标记</TermTip>
                </Label>
                <div className="flex flex-wrap gap-1.5">
                  {emojiItems.map((item) => (
                    <button
                      key={item.emoji}
                      type="button"
                      title={item.description || item.label || item.emoji}
                      onClick={() => setText((prev) => `${prev}${item.emoji}`)}
                      className="rounded-lg border px-2 py-1 text-base leading-none transition-colors hover:bg-accent"
                    >
                      {item.emoji}
                    </button>
                  ))}
                </div>
                <p className="text-[11px] text-muted-foreground">{catalog?.emoji.note}</p>
              </div>
            ) : null}

            <div className="space-y-2">
              <Label><TermTip term="caption">caption</TermTip>（只描述情绪 / 环境 / 语域，不要描述音色）</Label>
              <div className="flex gap-2">
                <Select
                  value={caption}
                  onValueChange={(value) => setCaption(value === '__none__' ? '' : value)}
                >
                  <SelectTrigger className="h-9">
                    <SelectValue placeholder="不使用 caption" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">不使用 caption</SelectItem>
                    {(catalog?.caption.presets ?? []).map((preset) => (
                      <SelectItem key={preset.id} value={preset.text}>
                        {preset.text}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Textarea
                value={caption}
                onChange={(event) => setCaption(event.target.value)}
                rows={2}
                maxLength={catalog?.caption.max_chars ?? 200}
                placeholder="落ち着いた、近い距離感の女性話者"
                className="resize-y text-xs"
              />
              <p className="text-[11px] text-muted-foreground">{catalog?.caption.note}</p>
            </div>
          </CardContent>
        </Card>

        {/* 采样参数 */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">采样参数</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label><TermTip term="采样步数">步数</TermTip></Label>
                <Select value={String(effectiveSteps)} onValueChange={(value) => setSteps(Number(value))}>
                  <SelectTrigger className="h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {stepPresets.length > 0 ? (
                      stepPresets.map((preset) => (
                        <SelectItem key={preset.value} value={String(preset.value)}>
                          {preset.label}
                          {preset.note ? ` · ${preset.note}` : ''}
                        </SelectItem>
                      ))
                    ) : (
                      <SelectItem value={String(effectiveSteps)}>{effectiveSteps}</SelectItem>
                    )}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label><TermTip term="采样调度">采样调度</TermTip></Label>
                <Select value={schedule} onValueChange={(value) => setSchedule(value as 'linear' | 'sway')}>
                  <SelectTrigger className="h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {schedules.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label><TermTip term="时长系数">时长系数</TermTip></Label>
                <span className="text-[11px] tabular-nums text-muted-foreground">
                  {effectiveDuration.toFixed(2)}
                </span>
              </div>
              <Slider
                value={[effectiveDuration]}
                min={durationRange.min}
                max={durationRange.max}
                step={durationRange.step}
                onValueChange={([value]) => setDurationScale(value)}
              />
              <p className="text-[11px] text-muted-foreground">{catalog?.duration_scale.note}</p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-xs"
                onClick={() => setSeed(Math.floor(Math.random() * 2 ** 31))}
              >
                <Dices className="size-3.5" />
                换一个 seed
              </Button>
              {seed !== null ? (
                <>
                  <span className="text-[11px] tabular-nums text-muted-foreground">{seed}</span>
                  <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => setSeed(null)}>
                    不指定
                  </Button>
                </>
              ) : (
                <span className="text-[11px] text-muted-foreground">{catalog?.seed.note}</span>
              )}
            </div>

            <Button
              className="w-full"
              disabled={loading || text.trim().length === 0}
              onClick={() => synth()}
            >
              {loading ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
              {loading ? '合成中…' : '合成'}
            </Button>
            {timedOutPayload ? (
              <p className="text-[11px] text-amber-700 dark:text-amber-300">
                上次撞上采样长尾（服务端 {catalog?.guard.timeout_sec ?? 180}s 护栏）。
                点上方错误条的「重试」会按服务端建议的 {irodoriRetrySuggestion(error)} 步重发。
              </p>
            ) : null}
          </CardContent>
        </Card>
      </div>

      <div className="space-y-5 lg:col-span-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Waves className="size-4 text-violet-600 dark:text-violet-400" />
              参考音色
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Tabs value={refSource} onValueChange={(value) => setRefSource(value as RefSource)}>
              <TabsList className="grid w-full grid-cols-3">
                <TabsTrigger value="speaker">固化音色</TabsTrigger>
                <TabsTrigger value="voice">音色库</TabsTrigger>
                <TabsTrigger value="path">本地路径</TabsTrigger>
              </TabsList>
            </Tabs>

            {refSource === 'speaker' ? (
              speakers.length > 0 ? (
                <Select value={speakerId} onValueChange={setSpeakerId}>
                  <SelectTrigger className="h-9">
                    <SelectValue placeholder="选择已固化的音色" />
                  </SelectTrigger>
                  <SelectContent>
                    {speakers.map((speaker) => (
                      <SelectItem key={speaker.id} value={speaker.id}>
                        {speaker.id}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <p className="text-xs text-muted-foreground">
                  还没有<TermTip term="固化音色">固化音色</TermTip>：到「日语 · 音色固化训练」页跑一次
                  {' '}<TermTip term="Speaker Inversion">SI 训练</TermTip> 即可（训完这里会自动出现）。
                </p>
              )
            ) : null}

            {refSource === 'voice' ? (
              <Select value={voiceId} onValueChange={setVoiceId}>
                <SelectTrigger className="h-9">
                  <SelectValue placeholder="选择音色库音色" />
                </SelectTrigger>
                <SelectContent>
                  {voices.map((voice) => (
                    <SelectItem key={voice.id} value={voice.id}>
                      {voice.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}

            {refSource === 'path' ? (
              <Textarea
                value={refPath}
                onChange={(event) => setRefPath(event.target.value)}
                rows={2}
                placeholder="F:\\audio\\ref.wav"
                className="resize-none font-mono text-xs"
              />
            ) : null}

            <p className="text-[11px] text-muted-foreground">
              当前：{refLabel}。{catalog?.reference.note}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">结果</CardTitle>
          </CardHeader>
          <CardContent>
            <ResultStack
              entries={entries}
              onRemove={results.remove}
              onClear={results.clear}
              empty={<p className="py-6 text-center text-xs text-muted-foreground">还没有合成结果。</p>}
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

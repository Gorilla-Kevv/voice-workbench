import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, AudioLines, Download, Eraser, Flame, Loader2, Mic2, RefreshCw, Sparkles, Waves } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { ResourceBudget } from '@/components/features/ResourceBudget';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { ResultStack, type ResultStackEntry } from '@/components/features/ResultStack';
import { useResultStack } from '@/hooks/useResultStack';
import { RequestError } from '@/lib/errors';
import { indexttsApi } from '@/lib/indextts';
import { runtimeServiceApi } from '@/lib/localService';
import { voiceApi } from '@/lib/voices';
import { cn } from '@/lib/utils';
import { dropHighlight, useFileDrop } from '@/hooks/useFileDrop';
import { focusBeforeRun } from '@/lib/arbiter';
import type { IndexttsCatalog, IndexttsEngineStatus, IndexttsSynthResult } from '@/types';
import type { SovitsVoice } from '@/types';

/** 参考音频来源：本机上传，或复用音色库里已有的音色（音色库由网关托管，跨模型通用） */
type RefSource = 'upload' | 'voice';

/** 情感控制方式：跟随参考音频（不传参数）/ 8 维向量 / 情感参考音频 */
type EmoMode = 'follow' | 'vector' | 'audio';

interface TtsResultItem {
  result: IndexttsSynthResult;
  audioUrl: string;
  text: string;
  refLabel: string;
}

/** base64 wav → 可播放/可下载的 Blob URL */
function base64ToUrl(base64: string, mime = 'audio/wav'): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}

const ZERO_VEC = [0, 0, 0, 0, 0, 0, 0, 0];

/**
 * IndexTTS-2.5 本地合成（第三个 Python 运行时，:9883 经网关透传）。
 *
 * 与网易页的差异化价值是**精细可控**：情感向量（8 维）、情感参考音频、
 * 语速倍率（官方「时长系数」）。语种只有 5 种，跨语种弱于网易 —— 定位是补充，不是替代。
 */
export function IndexttsTtsPage() {
  const [catalog, setCatalog] = useState<IndexttsCatalog | null>(null);
  const [engine, setEngine] = useState<IndexttsEngineStatus | null>(null);
  const [text, setText] = useState('这是 IndexTTS 的本地零样本合成：三秒参考音频，支持情感向量与语速控制。');
  const [lang, setLang] = useState('ZH');
  const [durationFactor, setDurationFactor] = useState(1.0);
  const [emoMode, setEmoMode] = useState<EmoMode>('follow');
  const [emoVector, setEmoVector] = useState<number[]>(ZERO_VEC);
  const [emoFile, setEmoFile] = useState<File | null>(null);
  const [emoAlpha, setEmoAlpha] = useState(0.65);
  const [refSource, setRefSource] = useState<RefSource>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [voices, setVoices] = useState<SovitsVoice[]>([]);
  const [voicesLoading, setVoicesLoading] = useState(false);
  const [voicesFailed, setVoicesFailed] = useState(false);
  const [voiceId, setVoiceId] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<RequestError | null>(null);
  const [warming, setWarming] = useState(false);

  const results = useResultStack<TtsResultItem>({
    limit: 12,
    // 音频是 Blob 地址，刷新后必然失效 → 只在同一次会话内跨页面保留（坑 18）
    storageKey: 'indextts-results',
    onEvict: (item) => URL.revokeObjectURL(item.audioUrl),
  });

  const timerRef = useRef<number | null>(null);
  const refAudioInputRef = useRef<HTMLInputElement>(null);
  const emoAudioInputRef = useRef<HTMLInputElement>(null);

  const stopTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const [catalogResult, pipeline] = await Promise.all([
          indexttsApi.catalog(),
          indexttsApi.pipeline().catch(() => null),
        ]);
        setCatalog(catalogResult);
        setEngine(pipeline);
      } catch (requestError) {
        // 服务没起：页面保持可用，状态卡里给出原因
        if (requestError instanceof RequestError) setError(requestError);
      }
    })();
    return () => stopTimer();
  }, [stopTimer]);

  /** 服务没起时的快捷开启：走网关托管（与设置页开关同一后端），不用离开本页 */
  const [serviceStarting, setServiceStarting] = useState(false);
  const startService = () => {
    setServiceStarting(true);
    setError(null);
    void (async () => {
      try {
        const result = await runtimeServiceApi.toggle('indextts', true);
        if (!result.reachable) {
          throw new RequestError(503, {
            code: 'INDEXTTS_START_FAILED',
            message: '服务已启用但暂未就绪',
            retryable: true,
            hint: result.hint,
          });
        }
        toast.success('IndexTTS 服务已启动', { description: '首次预热约需几分钟（含辅助模型探测）' });
        const [catalogResult, pipeline] = await Promise.all([
          indexttsApi.catalog(),
          indexttsApi.pipeline().catch(() => null),
        ]);
        setCatalog(catalogResult);
        setEngine(pipeline);
      } catch (rawError) {
        const requestError =
          rawError instanceof RequestError
            ? rawError
            : new RequestError(0, {
                code: 'INDEXTTS_START_FAILED',
                message: (rawError as Error)?.message || '启动请求未能发出',
                retryable: true,
                hint: '确认网关在跑（npm run dev），或到设置页用开关启动。',
              });
        setError(requestError);
        toast.error('启动 IndexTTS 服务失败', { description: requestError.fullMessage });
      } finally {
        setServiceStarting(false);
      }
    })();
  };

  const loadVoices = useCallback(() => {
    setVoicesLoading(true);
    setVoicesFailed(false);
    voiceApi
      .listVoices()
      .then((response) => setVoices(response.voices.filter((voice) => voice.exists)))
      .catch(() => setVoicesFailed(true))
      .finally(() => setVoicesLoading(false));
  }, []);

  // 与网易页同规矩：依赖里不放 voicesLoading，失败后不自动重试（坑 6 / 阶段 23）
  useEffect(() => {
    if (refSource !== 'voice' || voices.length > 0 || voicesLoading || voicesFailed) return;
    loadVoices();
  }, [refSource, voices.length, voicesLoading, voicesFailed, loadVoices]);

  const selectedVoice = useMemo(() => voices.find((voice) => voice.id === voiceId) ?? null, [voices, voiceId]);

  // 试听 Blob 地址：换文件或卸载时回收（坑 18 第三条）
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  const refDrop = useFileDrop({
    accept: 'audio/*',
    inputRef: refAudioInputRef,
    onFiles: (files) => {
      const first = files[0];
      if (!first) return;
      setFile(first);
      setPreviewUrl(URL.createObjectURL(first));
    },
  });
  const emoDrop = useFileDrop({
    accept: 'audio/*',
    inputRef: emoAudioInputRef,
    onFiles: (files) => { if (files[0]) setEmoFile(files[0]); },
  });

  const refreshEngine = useCallback(() => {
    indexttsApi.pipeline().then(setEngine).catch(() => undefined);
  }, []);

  const handleWarmup = () => {
    setWarming(true);
    setError(null);
    void (async () => {
      try {
        await focusBeforeRun('indextts-tts', 3600);
        await indexttsApi.warmup();
        toast.success('IndexTTS 已常驻显存');
      } catch (rawError) {
        const requestError =
          rawError instanceof RequestError
            ? rawError
            : new RequestError(0, { code: 'WARMUP_FAILED', message: (rawError as Error)?.message || '预热失败', retryable: true });
        setError(requestError);
        toast.error('预热失败', { description: requestError.fullMessage });
      } finally {
        setWarming(false);
        refreshEngine();
      }
    })();
  };

  const handleUnload = () => {
    void (async () => {
      try {
        await indexttsApi.unload();
        toast.success('已卸载 IndexTTS，显存归还');
      } catch {
        toast.error('卸载失败（服务可能没在跑）');
      } finally {
        refreshEngine();
      }
    })();
  };

  const emoVectorActive = emoMode === 'vector' && emoVector.some((v) => v > 0);

  const handleSynthesize = () => {
    if (!text.trim()) return;
    if (refSource === 'upload' && !file) {
      toast.error('请先上传参考音频');
      return;
    }
    if (refSource === 'voice' && !selectedVoice) {
      toast.error('请先从音色库选择一条音色');
      return;
    }
    if (emoMode === 'audio' && !emoFile) {
      toast.error('情感参考音频还没选');
      return;
    }

    const run = async () => {
      setLoading(true);
      setElapsed(0);
      stopTimer();
      timerRef.current = window.setInterval(() => setElapsed((value) => value + 1), 1000);
      setError(null);
      try {
        let upload: File | null = refSource === 'upload' ? file : null;
        if (refSource === 'voice' && selectedVoice) {
          // 磁盘路径不能当 URL 用（坑 21），只有网关的试听接口可访问
          const url = voiceApi.voiceAudioUrl(selectedVoice.id);
          const blob = await fetch(url).then((response) => {
            if (!response.ok) throw new RequestError(response.status, {
              code: 'REF_AUDIO_FETCH_FAILED',
              message: `参考音频取回失败（HTTP ${response.status}）`,
              retryable: true,
              hint: `音色「${selectedVoice.name}」登记的音频可能已不在本机；可改用「上传音频」。`,
            });
            return response.blob();
          });
          upload = new File([blob], `${selectedVoice.name}.wav`, { type: blob.type || 'audio/wav' });
        }
        const response = await indexttsApi.synthesize({
          text,
          lang,
          file: upload,
          durationFactor,
          emoVector: emoVectorActive ? emoVector : null,
          emoFile: emoMode === 'audio' ? emoFile : null,
          emoAlpha: emoMode === 'audio' ? emoAlpha : undefined,
        });
        results.push({
          // 入栈另开快照地址（坑 18）：预览地址会被下次选文件回收
          result: response,
          audioUrl: base64ToUrl(response.audio_base64),
          text,
          refLabel: upload ? upload.name : '未命名参考音频',
        });
        toast.success('合成完成', {
          description: `${response.duration_sec.toFixed(1)} 秒 · ${response.elapsed_sec.toFixed(1)} 秒生成 · ${response.sample_rate} Hz`,
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
                hint: '确认网关与 IndexTTS 服务在跑（npm run dev + npm run dev:indextts），再重试。',
              });
        setError(requestError);
        toast.error('合成失败', { description: requestError.fullMessage });
      } finally {
        stopTimer();
        setLoading(false);
        refreshEngine();
      }
    };
    void run();
  };

  const ttsEntries: ResultStackEntry[] = results.entries.map((entry) => ({
    id: entry.id,
    createdAt: entry.createdAt,
    title: entry.item.refLabel,
    subtitle: `${entry.item.result.duration_sec.toFixed(1)} 秒 · ${entry.item.result.language}`,
    summary: entry.item.text,
    content: (
      <div className="space-y-3 pt-1">
        <audio controls src={entry.item.audioUrl} className="w-full" autoPlay={false} />
        <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
          <div className="rounded-lg bg-muted/50 p-2.5">
            <p className="opacity-70">时长</p>
            <p className="mt-0.5 font-medium text-foreground">{entry.item.result.duration_sec.toFixed(1)} 秒</p>
          </div>
          <div className="rounded-lg bg-muted/50 p-2.5">
            <p className="opacity-70">生成耗时</p>
            <p className="mt-0.5 font-medium text-foreground">{entry.item.result.elapsed_sec.toFixed(1)} 秒</p>
          </div>
          <div className="rounded-lg bg-muted/50 p-2.5">
            <p className="opacity-70">采样率</p>
            <p className="mt-0.5 font-medium text-foreground">{entry.item.result.sample_rate} Hz</p>
          </div>
          <div className="rounded-lg bg-muted/50 p-2.5">
            <p className="opacity-70">语种</p>
            <p className="mt-0.5 font-medium text-foreground">{entry.item.result.language}</p>
          </div>
        </div>
        <p className="rounded-lg bg-muted/50 p-2.5 font-mono text-[11px] leading-relaxed text-muted-foreground line-clamp-3">
          {entry.item.text}
        </p>
        <a href={entry.item.audioUrl} download={`indextts-${entry.createdAt}.wav`} className="block">
          <Button variant="outline" className="w-full">
            <Download className="size-4" />
            下载 WAV
          </Button>
        </a>
      </div>
    ),
  }));

  const emoDims = catalog?.emo_dimensions ?? ['喜', '怒', '哀', '惧', '厌恶', '低落', '惊喜', '平静'];

  return (
    <div className="grid gap-5 lg:grid-cols-5">
      <div className="space-y-5 lg:col-span-3">
        <ResourceBudget task="indextts-tts" indexttsLoaded={engine?.loaded ?? false} />

        {/* 引擎状态：常驻与否 + 手动预热/卸载入口 */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Flame className="size-4 text-violet-600 dark:text-violet-400" />
              引擎状态
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {engine ? (
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <span className={cn('rounded-full px-2.5 py-0.5 text-xs font-medium', engine.loaded ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' : 'bg-amber-500/15 text-amber-600 dark:text-amber-400')}>
                  {engine.loaded ? `已常驻（${engine.device}）` : '未加载'}
                </span>
                {engine.loaded && engine.loaded_for_sec != null ? (
                  <span className="text-xs text-muted-foreground">常驻 {Math.round(engine.loaded_for_sec / 60)} 分钟</span>
                ) : null}
                <span className="text-xs text-muted-foreground">首次加载约 4 分钟（含辅助模型探测）</span>
                <div className="ml-auto flex gap-2">
                  <Button size="sm" variant="outline" onClick={handleWarmup} disabled={warming || loading || engine.loaded}>
                    {warming ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 size-3.5" />}
                    {engine.loaded ? '已预热' : '预热'}
                  </Button>
                  <Button size="sm" variant="outline" onClick={handleUnload} disabled={!engine.loaded || loading}>
                    <Eraser className="mr-1.5 size-3.5" />
                    卸载
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  连不上 IndexTTS 服务。它是按需启动的模块，点下面的按钮由网关直接拉起
                  （首次 import torch 约需数十秒），或手动运行{' '}
                  <code className="rounded bg-muted px-1.5 py-0.5 text-xs">npm run dev:indextts</code>。
                </p>
                <Button size="sm" variant="outline" onClick={startService} disabled={serviceStarting || loading}>
                  {serviceStarting ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 size-3.5" />}
                  {serviceStarting ? '正在启动服务（约需数十秒）…' : '启动服务'}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Mic2 className="size-4 text-violet-600 dark:text-violet-400" />
              参考音频（3 秒以上即可，无需转写文本）
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Tabs value={refSource} onValueChange={(value) => setRefSource(value as RefSource)}>
              <TabsList className="w-full">
                <TabsTrigger value="upload" className="flex-1">上传音频</TabsTrigger>
                <TabsTrigger value="voice" className="flex-1">从音色库选择</TabsTrigger>
              </TabsList>
            </Tabs>

            {refSource === 'upload' ? (
              <div className="space-y-2">
                <input
                  ref={refAudioInputRef}
                  id="indextts-file"
                  type="file"
                  accept="audio/*"
                  className="sr-only"
                  onChange={(event) => {
                    const first = Array.from(event.target.files ?? [])[0];
                    if (first) {
                      setFile(first);
                      setPreviewUrl(URL.createObjectURL(first));
                    }
                  }}
                />
                <Label
                  htmlFor="indextts-file"
                  {...refDrop.rootProps}
                  className={cn(
                    'flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed p-6 text-sm text-muted-foreground transition hover:border-violet-400 hover:bg-violet-500/5',
                    dropHighlight(refDrop.dragging),
                  )}
                >
                  <Waves className="size-4" />
                  {file
                    ? `${file.name}（${(file.size / 1024 / 1024).toFixed(2)} MB）`
                    : refDrop.dragging
                      ? '松手即可作为参考音频'
                      : '点击选择，或把音频拖到这里（3 秒以上）'}
                </Label>
                {previewUrl ? <audio controls src={previewUrl} className="w-full" /> : null}
              </div>
            ) : (
              <div className="space-y-2">
                <Select value={voiceId} onValueChange={setVoiceId}>
                  <SelectTrigger className="w-full">
                    <SelectValue
                      placeholder={
                        voicesLoading
                          ? '正在加载音色库…'
                          : voicesFailed
                            ? '音色库未能加载'
                            : voices.length === 0
                              ? '音色库暂无可用音色'
                              : '选择一条音色'
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {voices.map((voice) => (
                      <SelectItem key={voice.id} value={voice.id}>
                        {voice.name}
                        {voice.duration_s ? ` · ${voice.duration_s.toFixed(1)}s` : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {voicesFailed ? (
                  <div className="space-y-2">
                    <p className="text-xs text-muted-foreground">
                      音色库由本机网关直接提供（与 GPT-SoVITS 服务无关），加载失败时请确认网关在跑。
                    </p>
                    <Button size="sm" variant="outline" onClick={loadVoices} disabled={voicesLoading}>
                      <RefreshCw className="mr-1.5 size-3.5" />
                      重新加载
                    </Button>
                  </div>
                ) : null}
                {selectedVoice ? (
                  <div className="flex items-start gap-2 rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">
                    <Sparkles className="mt-0.5 size-3.5 shrink-0 text-violet-500" />
                    <p>仅借用该音色的<strong>参考音频</strong>；转写文本不参与合成（IndexTTS 是零样本克隆）。</p>
                  </div>
                ) : null}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <AudioLines className="size-4 text-violet-600 dark:text-violet-400" />
              合成内容
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="indextts-lang">语种（5 种）</Label>
                <Select value={lang} onValueChange={setLang}>
                  <SelectTrigger id="indextts-lang" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(catalog?.languages ?? ['ZH', 'EN', 'JA', 'AR', 'ES']).map((item) => (
                      <SelectItem key={item} value={item}>
                        {item}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>时长系数（语速）：{durationFactor.toFixed(2)}（小 = 快，大 = 慢）</Label>
                <Slider
                  value={[durationFactor]}
                  onValueChange={([value]) => setDurationFactor(value ?? 1)}
                  min={catalog?.duration_factor.min ?? 0.5}
                  max={catalog?.duration_factor.max ?? 2.0}
                  step={0.01}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="indextts-text">目标文本</Label>
              <Textarea
                id="indextts-text"
                value={text}
                onChange={(event) => setText(event.target.value)}
                rows={5}
                placeholder="输入需要合成的文本；支持拼音注音（如「银行 de 行」用 duan1 声调数字）"
                className="resize-y leading-relaxed"
              />
            </div>

            {/* 情感控制：IndexTTS 的独有价值，网易那条链路没有对等能力 */}
            <div className="space-y-3 rounded-lg border p-3">
              <div className="space-y-2">
                <Label>情感控制</Label>
                <Select value={emoMode} onValueChange={(value) => setEmoMode(value as EmoMode)}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="follow">跟随参考音频（默认）</SelectItem>
                    <SelectItem value="vector">8 维情感向量</SelectItem>
                    <SelectItem value="audio">情感参考音频</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {emoMode === 'vector' ? (
                <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
                  {emoDims.map((dim, index) => (
                    <div key={dim} className="space-y-1">
                      <Label className="flex justify-between text-xs">
                        <span>{dim}</span>
                        <span className="tabular-nums text-muted-foreground">{emoVector[index]?.toFixed(2) ?? '0.00'}</span>
                      </Label>
                      <Slider
                        value={[emoVector[index] ?? 0]}
                        onValueChange={([value]) =>
                          setEmoVector((prev) => prev.map((v, i) => (i === index ? value ?? 0 : v)))
                        }
                        min={0}
                        max={1}
                        step={0.05}
                      />
                    </div>
                  ))}
                  <p className="text-[11px] text-muted-foreground sm:col-span-2">全 0 时等同「跟随参考音频」。多维可同时给，上游会归一。</p>
                </div>
              ) : null}

              {emoMode === 'audio' ? (
                <div className="space-y-2">
                  <input
                    ref={emoAudioInputRef}
                    id="indextts-emo-file"
                    type="file"
                    accept="audio/*"
                    className="sr-only"
                    onChange={(event) => {
                      const first = Array.from(event.target.files ?? [])[0];
                      if (first) setEmoFile(first);
                    }}
                  />
                  <Label
                    htmlFor="indextts-emo-file"
                    {...emoDrop.rootProps}
                    className={cn(
                      'flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed p-4 text-xs text-muted-foreground transition hover:border-violet-400 hover:bg-violet-500/5',
                      dropHighlight(emoDrop.dragging),
                    )}
                  >
                    <Waves className="size-4" />
                    {emoFile ? `${emoFile.name}（${(emoFile.size / 1024 / 1024).toFixed(2)} MB）` : '点击选择或拖入一段带情绪的参考音频'}
                  </Label>
                  <div className="space-y-1">
                    <Label className="text-xs">情感强度（emo_alpha）：{emoAlpha.toFixed(2)}</Label>
                    <Slider
                      value={[emoAlpha]}
                      onValueChange={([value]) => setEmoAlpha(value ?? 0.65)}
                      min={0}
                      max={1}
                      step={0.05}
                    />
                  </div>
                </div>
              ) : null}
            </div>

            <Button
              onClick={handleSynthesize}
              disabled={loading || !text.trim() || (refSource === 'upload' ? !file : !selectedVoice) || (emoMode === 'audio' && !emoFile)}
              className="w-full bg-gradient-to-r from-violet-600 to-indigo-500 text-white shadow-lg shadow-violet-500/20 hover:brightness-110"
            >
              {loading ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Sparkles className="mr-2 size-4" />}
              {loading ? `正在合成（已等待 ${elapsed} 秒）…` : '开始合成'}
            </Button>
            {loading && elapsed > 60 ? (
              <p className="text-center text-xs text-muted-foreground">
                本机实测稳态约 15~60 秒/条（显存吃紧时会更久）；首次加载模型另需约 4 分钟。
              </p>
            ) : null}

            {error ? (
              <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
                <div className="min-w-0 space-y-1 text-sm">
                  <p className="font-medium text-destructive">{error.message}</p>
                  {error.hint ? <p className="text-xs text-muted-foreground">{error.hint}</p> : null}
                  {error.code === 'INDEXTTS_UNREACHABLE' ? (
                    <p className="text-xs text-muted-foreground">
                      启动命令：<code className="rounded bg-muted px-1.5 py-0.5">npm run dev:indextts</code>（环境搭建见 docs/INDEX-TTS-INTEGRATION.md）
                    </p>
                  ) : null}
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>

      <div className="space-y-5 lg:col-span-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Download className="size-4 text-violet-600 dark:text-violet-400" />
              合成结果
            </CardTitle>
          </CardHeader>
          <CardContent>
            {ttsEntries.length > 0 ? (
              <ResultStack entries={ttsEntries} onRemove={results.remove} onClear={results.clear} />
            ) : (
              <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
                合成成功后，结果按时间倒序排在这里；同一会话内切页面不丢。
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

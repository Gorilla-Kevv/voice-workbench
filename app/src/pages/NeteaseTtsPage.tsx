import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, AudioLines, Download, Eraser, Flame, Loader2, Mic2, RefreshCw, Sparkles, Waves } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { ResourceBudget } from '@/components/features/ResourceBudget';
import { markGuideEvent } from '@/hooks/useGuideProgress';
import { focusBeforeRun } from '@/lib/arbiter';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { TermTip } from '@/components/features/TermTip';
import { ResultStack, type ResultStackEntry } from '@/components/features/ResultStack';
import { useResultStack } from '@/hooks/useResultStack';
import { RequestError } from '@/lib/errors';
import { neteaseApi } from '@/lib/netease';
import { voiceApi } from '@/lib/voices';
import { cn } from '@/lib/utils';
import { dropHighlight, useFileDrop } from '@/hooks/useFileDrop';
import type { NeteaseCatalog, NeteaseEngineStatus, NeteaseTtsResult } from '@/types';
import type { SovitsVoice } from '@/types';

/** 参考音频来源：本机上传，或复用 GPT-SoVITS 音色库里已有的音色 */
type RefSource = 'upload' | 'voice';

/** 一条合成结果：音频 Blob 地址 + 当时的参数，够独立回听与下载 */
interface TtsResultItem {
  result: NeteaseTtsResult;
  audioUrl: string;
  /** 合成文本，用于列表摘要与下载文件名 */
  text: string;
  /** 参考音频来源名（文件名或音色名） */
  refLabel: string;
}

/** base64 wav → 可播放/可下载的 Blob URL */
function base64ToUrl(base64: string, mime = 'audio/wav'): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}

/**
 * 网易语音合成（Confucius4-TTS）。
 *
 * 与 MiMo 克隆页最大的差别只有一条：**不需要参考音频的逐字转写文本**。
 * 也因此现有音色库里的每条音色都能直接拿来用 —— 只取它的参考音频，
 * 转写文本不参与合成（页面里明确标注，避免「文本也要跟着改」的误解）。
 */
export function NeteaseTtsPage({ onFallback }: { onFallback?: () => void } = {}) {
  const [catalog, setCatalog] = useState<NeteaseCatalog['tts'] | null>(null);
  const [engine, setEngine] = useState<NeteaseEngineStatus | null>(null);
  const [text, setText] = useState('这是网易 Confucius4-TTS 的零样本克隆合成：只需三秒参考音频，无需逐字转写文本。');
  const [lang, setLang] = useState('zh');
  /** 速度 / 质量档位：优先用服务端 catalog 给的，拿不到再退回 'balanced' */
  const [quality, setQuality] = useState('balanced');
  const [refSource, setRefSource] = useState<RefSource>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [voices, setVoices] = useState<SovitsVoice[]>([]);
  const [voicesLoading, setVoicesLoading] = useState(false);
  /** 上一次拉取失败（服务停着 / 网络问题）；失败后不再自动重试，只给手动入口 */
  const [voicesFailed, setVoicesFailed] = useState(false);
  const [voiceId, setVoiceId] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<RequestError | null>(null);
  const [warming, setWarming] = useState(false);
  // 多条结果并存：每条独立保留音频与文本，可展开回听旧的（不再被下一次合成冲掉）
  const results = useResultStack<TtsResultItem>({
    limit: 12,
    // 音频是 Blob 地址，刷新后必然失效，所以只做「同一次会话内跨页面保留」
    storageKey: 'netease-tts-results',
    // 只有淘汰 / 手动删除时才回收 Blob 地址，否则列表里旧的那条会突然不能播
    onEvict: (item) => URL.revokeObjectURL(item.audioUrl),
  });
  // 「已等待 N 秒」计时器：跟 useSynthesis 同一模式 —— 挂在 ref 上，
  // 由提交动作启动/清理，而不是用 effect 监听 loading（会触发级联渲染告警）
  const timerRef = useRef<number | null>(null);
  const refAudioInputRef = useRef<HTMLInputElement>(null);

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
          neteaseApi.catalog(),
          neteaseApi.ttsPipeline().catch(() => null),
        ]);
        setCatalog(catalogResult.tts);
        if (catalogResult.tts.default_quality) setQuality(catalogResult.tts.default_quality);
        setEngine(pipeline);
      } catch (requestError) {
        // 服务没起 / 装到一半：页面保持可用，状态卡里给出原因（探活轮询由侧栏负责）
        if (requestError instanceof RequestError) setError(requestError);
      }
    })();
  }, []);

  // 切到「从音色库选择」时按需拉一次音色列表（网关托管的共享音色库，与 GPT-SoVITS 服务无关）
  const loadVoices = useCallback(() => {
    setVoicesLoading(true);
    setVoicesFailed(false);
    voiceApi
      .listVoices()
      .then((response) => setVoices(response.voices.filter((voice) => voice.exists)))
      .catch(() => setVoicesFailed(true))
      .finally(() => setVoicesLoading(false));
  }, []);

  // 依赖里不能再放 voicesLoading：服务停着时「失败 → loading 归 false → effect 重跑」
  // 会转成无限重试，请求和报错 toast 一起刷屏（实测每 1~2 秒一发 503）。
  useEffect(() => {
    if (refSource !== 'voice' || voices.length > 0 || voicesLoading || voicesFailed) return;
    loadVoices();
  }, [refSource, voices.length, voicesLoading, voicesFailed, loadVoices]);

  const install = catalog?.install;
  const installMissing = install && !install.installed;

  const selectedVoice = useMemo(() => voices.find((voice) => voice.id === voiceId) ?? null, [voices, voiceId]);

  // 试听用的 Blob 地址：换文件或卸载页面时回收，不能每渲染一次开一个（那样旧的永远留在内存里）
  const previewUrl = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => {
    if (!previewUrl) return undefined;
    return () => URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  const pickRefAudio = useCallback((files: File[]) => {
    const next = files[0] ?? null;
    setFile(next);
    // 指引里「准备参考音频」这一步就此自动打勾
    if (next) markGuideEvent('netease:ref-ready');
  }, []);

  // 参考音频支持直接拖进来（从桌面拖一个文件夹也一样，只取里面的音频）
  const { dragging: refDragging, rootProps: refDropProps } = useFileDrop({
    onFiles: pickRefAudio,
    accept: 'audio/*,.wav,.mp3,.flac,.ogg,.m4a,.webm,.aac',
    inputRef: refAudioInputRef,
  });

  const refreshEngine = useCallback(() => {
    neteaseApi
      .ttsPipeline()
      .then(setEngine)
      .catch(() => setEngine(null));
  }, []);

  const handleWarmup = () => {
    setWarming(true);
    // 预热前先把 GPT-SoVITS 那边的常驻模型卸掉，显存整块留给主服务
    void focusBeforeRun('netease-tts');
    neteaseApi
      .ttsWarmup()
      .then((response) => {
        if (response.preempted) toast.info(`已卸载另一引擎（${response.preempted}）为 TTS 让位`);
        toast.success('TTS 引擎已就绪');
        refreshEngine();
      })
      .catch((requestError: unknown) => {
        if (requestError instanceof RequestError) {
          toast.error('预热失败', { description: requestError.fullMessage });
          setError(requestError);
        }
      })
      .finally(() => setWarming(false));
  };

  const handleUnload = () => {
    neteaseApi
      .ttsUnload()
      .then(() => {
        toast.success('TTS 引擎已卸载，显存已归还');
        refreshEngine();
      })
      .catch((requestError: unknown) => {
        if (requestError instanceof RequestError) toast.error('卸载失败', { description: requestError.fullMessage });
      });
  };

  const handleSynthesize = () => {
    const refFile = refSource === 'upload' ? file : null;
    if (!text.trim()) return;
    if (refSource === 'upload' && !refFile) {
      toast.error('请先上传参考音频');
      return;
    }
    if (refSource === 'voice' && !selectedVoice) {
      toast.error('请先从音色库选择一条音色');
      return;
    }

    const run = async () => {
      setLoading(true);
      setElapsed(0);
      stopTimer();
      timerRef.current = window.setInterval(() => setElapsed((value) => value + 1), 1000);
      setError(null);
      try {
        let upload: File | null = refFile;
        if (refSource === 'voice' && selectedVoice) {
          // 音色库音色 → 取它的参考音频（网关音色库接口），转写文本不参与合成。
          // audio_path 是服务端磁盘路径，不能当 URL 用；可访问的是试听那条接口。
          const url = voiceApi.voiceAudioUrl(selectedVoice.id);
          const blob = await fetch(url).then((response) => {
            if (!response.ok) throw new RequestError(response.status, {
              code: 'REF_AUDIO_FETCH_FAILED',
              message: `参考音频取回失败（HTTP ${response.status}）`,
              retryable: true,
              hint: `音色「${selectedVoice.name}」登记的音频可能已不在本机；可改用「上传音频」，或到音色库页重新登记这条。`,
            });
            return response.blob();
          });
          upload = new File([blob], `${selectedVoice.name}.wav`, { type: blob.type || 'audio/wav' });
        }
        const response = await neteaseApi.synthesize({
          text,
          lang,
          file: upload,
          quality,
        });
        results.push({
          result: response,
          audioUrl: base64ToUrl(response.audio_base64),
          text,
          refLabel: upload ? upload.name : '未命名参考音频',
        });
        // 指引里「合成并回听」这一步自动打勾
        markGuideEvent('netease:first-synth');
        if (response.preempted) {
          toast.info(`已卸载 ${response.preempted} 引擎为本次合成让位`, { description: '回对应页面重新预热即可恢复。' });
        }
        toast.success('合成完成', {
          description: `${response.duration_sec.toFixed(1)} 秒 · ${(response.elapsed_sec).toFixed(1)} 秒生成 · ${response.sample_rate} Hz`,
        });
      } catch (rawError) {
        // 非 RequestError（网络层直接抛错等）也要报出来：以前只认 RequestError，
        // 失败时界面既不弹 toast 也不显示错误卡，按钮闪一下就回到原样
        const requestError =
          rawError instanceof RequestError
            ? rawError
            : new RequestError(0, {
                code: 'SYNTH_FAILED',
                message: (rawError as Error)?.message || '合成请求未能发出',
                retryable: true,
                hint: '确认网关与网易模块服务在跑（npm run dev），再重试。',
              });
        setError(requestError);
        toast.error('合成失败', { description: requestError.fullMessage });
      } finally {
        stopTimer();
        setLoading(false);
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
        <a href={entry.item.audioUrl} download={`confucius4-tts-${entry.createdAt}.wav`} className="block">
          <Button variant="outline" className="w-full">
            <Download className="size-4" />
            下载 WAV
          </Button>
        </a>
      </div>
    ),
  }));

  return (
    <div className="grid gap-5 lg:grid-cols-5">
      <div className="space-y-5 lg:col-span-3">
        {/* 跑之前先看代价：这一发要 4.9 GB 显存，够不够当场说清 */}
        <ResourceBudget task="netease-tts" neteaseTtsLoaded={engine?.loaded ?? false} />

        {/* 引擎状态：安装未就位时这里承担「该做什么」的引导 */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Flame className="size-4 text-violet-600 dark:text-violet-400" />
              引擎状态
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {installMissing ? (
              <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-amber-700 dark:text-amber-400">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                <div className="space-y-1">
                  <p className="font-medium">权重或依赖未就绪</p>
                  <ul className="list-inside list-disc space-y-0.5 opacity-90">
                    {(install?.missing ?? []).slice(0, 3).map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                  <p className="opacity-90">
                    {install?.download_hint
                      ? `补齐权重：${install.download_hint}`
                      : '按 netease/README.md 下载权重并建 venv'}
                    ，然后运行 npm run netease:check 验证（TTS 侧权重实测约 5.4 GB）。
                  </p>
                  {onFallback ? (
                    <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onFallback}>
                      先用 GPT-SoVITS 批量合成
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={engine?.loaded ? 'default' : 'secondary'} className="text-[11px] font-normal">
                {engine?.loaded ? `已加载 · ${engine.device ?? ''}` : '未加载'}
              </Badge>
              {engine?.loaded_for_sec != null ? (
                <Badge variant="secondary" className="text-[11px] font-normal">
                  常驻 {Math.round(engine.loaded_for_sec)}s
                </Badge>
              ) : null}
              <div className="ml-auto flex gap-2">
                <Button size="sm" variant="outline" onClick={handleWarmup} disabled={warming || Boolean(installMissing)}>
                  {warming ? <Loader2 className="size-3.5 animate-spin" /> : <Flame className="size-3.5" />}
                  预热引擎
                </Button>
                <Button size="sm" variant="ghost" onClick={handleUnload} disabled={!engine?.loaded}>
                  <Eraser className="size-3.5" />
                  卸载引擎
                </Button>
                <Button size="sm" variant="ghost" onClick={refreshEngine} aria-label="刷新状态">
                  <RefreshCw className="size-3.5" />
                </Button>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              与 ASR 引擎共用显存，同一时刻只驻留一个；预热另一个引擎会自动卸载当前引擎。
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Mic2 className="size-4 text-violet-600 dark:text-violet-400" />
              参考音频
              <span className="ml-1 text-xs font-normal text-muted-foreground">
                <TermTip term="零样本克隆" />
                ：≥3 秒即可，无需逐字转写文本
              </span>
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
                  id="netease-tts-file"
                  type="file"
                  accept="audio/*"
                  className="sr-only"
                  onChange={(event) => pickRefAudio(Array.from(event.target.files ?? []))}
                />
                <Label
                  htmlFor="netease-tts-file"
                  {...refDropProps}
                  className={cn(
                    'flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed p-6 text-sm text-muted-foreground transition hover:border-violet-400 hover:bg-violet-500/5',
                    dropHighlight(refDragging),
                  )}
                >
                  <Waves className="size-4" />
                  {file
                    ? `${file.name}（${(file.size / 1024 / 1024).toFixed(2)} MB）`
                    : refDragging
                      ? '松手即可作为参考音频'
                      : '点击选择，或把音频 / 音频文件夹拖到这里（3 秒以上）'}
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
                        {voice.prompt_lang ? ` · ${voice.prompt_lang}` : ''}
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
                    <p>
                      仅借用该音色的<strong>参考音频</strong>；音色库里的逐字转写文本不参与网易合成
                      （Confucius4-TTS 是<TermTip term="零样本克隆" />，不需要文本）。
                      合成语种由下方「合成语种」决定，可与参考音频语种不同（跨语种合成）。
                    </p>
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
            <div className="space-y-2">
              <Label htmlFor="netease-tts-lang">合成语种（14 种；跨语种无口音）</Label>
              <Select value={lang} onValueChange={setLang}>
                <SelectTrigger id="netease-tts-lang" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(catalog?.languages ?? [{ code: 'zh', label: '中文' }]).map((item) => (
                    <SelectItem key={item.code} value={item.code}>
                      {item.label}（{item.code}）
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="netease-tts-text">目标文本</Label>
              <Textarea
                id="netease-tts-text"
                value={text}
                onChange={(event) => setText(event.target.value)}
                rows={5}
                placeholder="输入需要合成的文本，可用任意受支持语种"
                className="resize-y leading-relaxed"
              />
            </div>

            <Button
              onClick={handleSynthesize}
              disabled={loading || !text.trim() || Boolean(installMissing) || (refSource === 'upload' ? !file : !selectedVoice)}
              className="w-full bg-gradient-to-r from-violet-600 to-indigo-500 text-white shadow-lg shadow-violet-500/20 hover:brightness-110"
              size="lg"
            >
              {loading ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
              {loading ? `正在合成，已等待 ${elapsed} 秒（首次需加载模型）` : '开始合成'}
            </Button>

            <div className="flex flex-wrap gap-1.5">
              <Badge variant="secondary" className="text-[11px] font-normal">Confucius4-TTS · 1.3B</Badge>
              <Badge variant="secondary" className="text-[11px] font-normal">免参考文本</Badge>
              <Badge variant="secondary" className="text-[11px] font-normal">情感迁移</Badge>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="space-y-5 lg:col-span-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <AudioLines className="size-4 text-violet-600 dark:text-violet-400" />
              合成结果
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {error ? (
              <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-destructive" />
                <div className="min-w-0">
                  <p className="font-medium text-destructive">{error.message}</p>
                  {error.hint ? <p className="mt-1 opacity-80">{error.hint}</p> : null}
                  {/* 主服务不可用时**不静默降级**：明确告诉用户还有谁可用、怎么切过去 */}
                  {onFallback ? (
                    <Button size="sm" variant="outline" className="mt-2 h-7 text-xs" onClick={onFallback}>
                      改用 GPT-SoVITS 批量合成
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : null}

            {results.entries.length > 0 ? (
              <ResultStack
                entries={ttsEntries}
                onRemove={results.remove}
                onClear={results.clear}
                empty={null}
              />
            ) : (
              <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
                {loading ? (
                  <span className="inline-flex items-center gap-2">
                    <Loader2 className="size-4 animate-spin" />
                    合成中…（首次合成需先加载模型）
                  </span>
                ) : (
                  '选择参考音频并输入文本后，合成结果会在这里播放与下载'
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">与现有模型的关系</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-xs text-muted-foreground">
            <p>· 中文日常合成仍推荐 GPT-SoVITS（更快）；不想部署任何东西用 MiMo 云端。</p>
            <p>· 德 / 法 / 西 / 泰等 14 语种、跨语种无口音、免转写克隆、情感迁移 —— 这些是网易模块的价值。</p>
            <p>· 模型权重与推理全部在本机执行，音频不出本机。</p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Captions, Copy, Download, Eraser, Flame, Loader2, RefreshCw, Square, Zap } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { TermTip } from '@/components/features/TermTip';
import { ResultStack, type ResultStackEntry } from '@/components/features/ResultStack';
import { useResultStack } from '@/hooks/useResultStack';
import { dropHighlight, useFileDrop } from '@/hooks/useFileDrop';
import { cn } from '@/lib/utils';
import { RequestError } from '@/lib/errors';
import { neteaseApi } from '@/lib/netease';
import type { NeteaseAsrEngineInfo, NeteaseCatalog, NeteaseEngineStatus, NeteaseStreamEvent, NeteaseTranscribeResult } from '@/types';

/** 转写模式：快速（离线一次性） / 流式（append-only 逐字出） */
type TranscribeMode = 'fast' | 'stream';

/** 一条转写结果：文本 + 当时的文件名与模式，够独立回看与导出 */
interface AsrResultItem {
  result: NeteaseTranscribeResult;
  fileName: string;
  mode: TranscribeMode;
}

/**
 * 网易语音转文本（Confucius4-R2T2）。
 *
 * 两种模式的差别要在界面上说清楚：
 * - 快速：等全部转完一次性给结果，精度与流式一致；
 * - 流式：真流式（append-only）—— 已输出的文本不会被改写，
 *   这与现有 faster-whisper 的滑窗伪流式（会回头改字）是本质区别。
 */
export function NeteaseAsrPage({ onFallback }: { onFallback?: () => void } = {}) {
  const [catalog, setCatalog] = useState<NeteaseCatalog['asr'] | null>(null);
  const [engine, setEngine] = useState<NeteaseEngineStatus | null>(null);
  const [install, setInstall] = useState<NeteaseAsrEngineInfo | null>(null);

  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<TranscribeMode>('fast');
  const [language, setLanguage] = useState('auto');
  const [chunkMs, setChunkMs] = useState(160);
  const [withTimestamps, setWithTimestamps] = useState(false);

  const [loading, setLoading] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<RequestError | null>(null);
  const [streamText, setStreamText] = useState('');
  // 多条结果并存：每次转写都留下一条，可展开回看 / 复制 / 导出旧的
  const results = useResultStack<AsrResultItem>({
    limit: 12,
    // 文本结果是可 JSON 化的，刷新页面后也能回看
    storageKey: 'netease-asr-results',
    serialize: (item) => item,
    deserialize: (raw) => (raw && typeof raw === 'object' ? (raw as AsrResultItem) : null),
  });
  const [warming, setWarming] = useState(false);
  const abortRef = useRef<(() => void) | null>(null);
  // 「已等待 N 秒」计时器：与 useSynthesis 同模式（ref 持有，提交动作启停）
  const timerRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
          neteaseApi.asrPipeline().catch(() => null),
        ]);
        setCatalog(catalogResult.asr);
        setInstall(catalogResult.asr.install);
        setEngine(pipeline);
      } catch {
        // 探活由侧栏轮询负责；这里保持页面可用即可
      }
    })();
  }, []);

  const refreshEngine = useCallback(() => {
    neteaseApi
      .asrPipeline()
      .then(setEngine)
      .catch(() => setEngine(null));
  }, []);

  const handleWarmup = () => {
    setWarming(true);
    neteaseApi
      .asrWarmup()
      .then((response) => {
        if (response.preempted) toast.info(`已卸载另一引擎（${response.preempted}）为 ASR 让位`);
        toast.success('ASR 引擎已就绪', { description: 'vLLM 引擎常驻后台，后续转写秒级响应。' });
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
      .asrUnload()
      .then(() => {
        toast.success('ASR 引擎已卸载，显存已归还');
        refreshEngine();
      })
      .catch((requestError: unknown) => {
        if (requestError instanceof RequestError) toast.error('卸载失败', { description: requestError.fullMessage });
      });
  };

  const finishCommon = useCallback(() => {
    stopTimer();
    setLoading(false);
    abortRef.current = null;
  }, [stopTimer]);

  const pickAudio = useCallback((files: File[]) => {
    setFile(files[0] ?? null);
    setStreamText('');
    setError(null);
  }, []);

  // 试听用的地址要跟着换文件回收，不能每渲染一次开一个
  const previewUrl = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => {
    if (!previewUrl) return undefined;
    return () => URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  // 音频支持直接拖进来（拖文件夹则取里面的音频）
  const { dragging, rootProps: dropProps } = useFileDrop({
    onFiles: pickAudio,
    accept: 'audio/*,.wav,.mp3,.flac,.ogg,.m4a,.webm,.aac',
    inputRef: fileInputRef,
  });

  const handleTranscribe = () => {
    if (!file) {
      toast.error('请先选择音频文件');
      return;
    }
    setLoading(true);
    setElapsed(0);
    stopTimer();
    timerRef.current = window.setInterval(() => setElapsed((value) => value + 1), 1000);
    setError(null);
    setStreamText('');

    if (mode === 'fast') {
      neteaseApi
        .transcribe({ file, language, returnTimestamps: withTimestamps, stream: false })
        .then((response) => {
          results.push({ result: response, fileName: file.name, mode });
          toast.success('转写完成', { description: `${response.text.length} 字 · ${response.elapsed_sec?.toFixed(1) ?? '?'} 秒` });
        })
        .catch((requestError: unknown) => {
          if (requestError instanceof RequestError) {
            setError(requestError);
            toast.error('转写失败', { description: requestError.fullMessage });
          }
        })
        .finally(finishCommon);
      return;
    }

    // 流式：NDJSON 逐行增量。onEvent 里整体替换文本（append-only 由服务端保证）
    const { promise, abort } = neteaseApi.transcribeStream(
      { file, language, chunkMs, stream: true },
      (event: NeteaseStreamEvent) => {
        if (event.type === 'delta') setStreamText(event.text);
        if (event.type === 'result') {
          setStreamText(event.text);
          results.push({
            result: {
              ok: true,
              text: event.text,
              language,
              elapsed_sec: event.elapsed_sec ?? null,
              stream: true,
            },
            fileName: file.name,
            mode,
          });
        }
      },
    );
    abortRef.current = abort;
    void promise
      .then((final) => {
        if (final === null) {
          toast.info('已取消流式转写');
        } else {
          toast.success('流式转写完成', { description: `${final.text.length} 字 · ${final.elapsedSec?.toFixed(1) ?? '?'} 秒` });
        }
      })
      .catch((requestError: unknown) => {
        if (requestError instanceof RequestError) {
          setError(requestError);
          toast.error('流式转写失败', { description: requestError.fullMessage });
        }
      })
      .finally(finishCommon);
  };

  const handleCancel = () => {
    abortRef.current?.();
    finishCommon();
  };

  const copyText = (text: string) => {
    if (!text) return;
    void navigator.clipboard
      .writeText(text)
      .then(() => toast.success('已复制到剪贴板'))
      .catch(() => toast.error('复制失败'));
  };

  const downloadText = (text: string, stamp: number) => {
    if (!text) return;
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `r2t2-${stamp}.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const installMissing = install && !install.installed;
  /** 流式进行中的实时文本（未定稿，不入栈） */
  const liveText = loading && mode === 'stream' ? streamText : '';

  const asrEntries: ResultStackEntry[] = results.entries.map((entry) => ({
    id: entry.id,
    createdAt: entry.createdAt,
    title: entry.item.fileName,
    subtitle: `${entry.item.mode === 'stream' ? '流式' : '快速'} · ${entry.item.result.text.length} 字`,
    summary: entry.item.result.text,
    content: (
      <div className="space-y-2 pt-1">
        <div className="max-h-72 overflow-y-auto rounded-lg bg-muted/50 p-3 text-sm leading-relaxed whitespace-pre-wrap">
          {entry.item.result.text}
        </div>
        {entry.item.result.elapsed_sec != null ? (
          <p className="text-xs text-muted-foreground">
            耗时 {entry.item.result.elapsed_sec.toFixed(1)} 秒 · {entry.item.result.text.length} 字
          </p>
        ) : null}
        {entry.item.result.timestamps && entry.item.result.timestamps.length > 0 ? (
          <div className="max-h-52 space-y-1 overflow-y-auto rounded-lg border p-2 text-xs">
            {entry.item.result.timestamps.map((stamp, index) => (
              <div key={`${stamp.start}-${index}`} className="flex gap-2">
                <span className="shrink-0 font-mono text-muted-foreground">
                  {stamp.start != null ? `${stamp.start.toFixed(2)}s` : '—'}
                  {stamp.end != null ? ` → ${stamp.end.toFixed(2)}s` : ''}
                </span>
                <span>{stamp.text}</span>
              </div>
            ))}
          </div>
        ) : null}
        <div className="flex gap-2">
          <Button variant="outline" size="sm" className="flex-1" onClick={() => copyText(entry.item.result.text)}>
            <Copy className="size-3.5" />
            复制
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="flex-1"
            onClick={() => downloadText(entry.item.result.text, entry.createdAt)}
          >
            <Download className="size-3.5" />
            下载 TXT
          </Button>
        </div>
      </div>
    ),
  }));

  return (
    <div className="grid gap-5 lg:grid-cols-5">
      <div className="space-y-5 lg:col-span-3">
        {/* 开发中的说明放在最上面：与其让用户点半天撞见报错，不如先把状态说清楚 */}
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <div className="space-y-1">
            <p className="flex flex-wrap items-center gap-1.5 font-medium">
              该模块仍在开发中 · 当前系统暂不可用
              <Badge variant="secondary" className="h-5 px-1.5 text-[10px] font-normal">
                WIP
              </Badge>
            </p>
            <p className="opacity-90">
              Confucius4-R2T2 依赖 vLLM，而 PyPI 上的 vLLM <strong>只有 Linux 发行包</strong>，
              r2t2 自带的 llama.cpp 后端也只有 <code className="font-mono">.so</code> 与
              <code className="font-mono">cpython-312-x86_64-linux-gnu</code> 产物 ——
              Windows 上装不了，所以这一页现在跑不起来（预热与转写按钮会保持禁用）。
            </p>
            <p className="opacity-90">
              落地路径已经勘察过：WSL2 可行（本机 WSL 2.7.14 已就位、驱动 572.61 支持 GPU 直通），
              方案与代价记在 <code className="font-mono">netease/README.md</code>。
              权衡后<strong>暂不实施</strong>（约 10~15 GB 磁盘 + 需管理员权限），本页保持开发中的状态。
            </p>
            <p className="opacity-90">
              现在要转写，请用「语音转文本」页：FunASR / faster-whisper 两条通道在本机都可用，
              离线转写与造训练数据集都能做（区别是它没有 append-only 真流式）。
            </p>
            {onFallback ? (
              <Button size="sm" variant="outline" className="mt-1 h-7 text-xs" onClick={onFallback}>
                去用语音转文本
              </Button>
            ) : null}
          </div>
        </div>

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
                  <p className="font-medium">模型或依赖未就绪</p>
                  <ul className="list-inside list-disc space-y-0.5 opacity-90">
                    {(install?.missing ?? []).slice(0, 3).map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                  <p className="opacity-90">按 netease/README.md 下载权重并安装 r2t2 + vllm，然后 npm run netease:check 验证。</p>
                </div>
              </div>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={engine?.loaded ? 'default' : 'secondary'} className="text-[11px] font-normal">
                {engine?.loaded ? '已加载 · vLLM 常驻' : '未加载'}
              </Badge>
              {catalog ? (
                <Badge variant="secondary" className="text-[11px] font-normal">{catalog.model}</Badge>
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
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Captions className="size-4 text-violet-600 dark:text-violet-400" />
              选择音频
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <input
              ref={fileInputRef}
              id="netease-asr-file"
              type="file"
              accept="audio/*"
              className="sr-only"
              onChange={(event) => pickAudio(Array.from(event.target.files ?? []))}
            />
            <Label
              htmlFor="netease-asr-file"
              {...dropProps}
              className={cn(
                'flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed p-6 text-sm text-muted-foreground transition hover:border-violet-400 hover:bg-violet-500/5',
                dropHighlight(dragging),
              )}
            >
              <Captions className="size-4" />
              {file
                ? `${file.name}（${(file.size / 1024 / 1024).toFixed(2)} MB）`
                : dragging
                  ? '松手即可开始转写'
                  : '点击选择，或把音频 / 音频文件夹拖到这里（wav / mp3 / flac）'}
            </Label>
            {previewUrl ? <audio controls src={previewUrl} className="w-full" /> : null}

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="netease-asr-lang">语种</Label>
                <Select value={language} onValueChange={setLanguage}>
                  <SelectTrigger id="netease-asr-lang" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(catalog?.languages ?? [{ code: 'auto', label: '自动检测' }]).map((item) => (
                      <SelectItem key={item.code} value={item.code}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {mode === 'stream' ? (
                <div className="space-y-2">
                  <Label htmlFor="netease-asr-chunk">
                    解码块（<TermTip term="流式合成" />的节奏，越小越快）
                  </Label>
                  <Select value={String(chunkMs)} onValueChange={(value) => setChunkMs(Number(value))}>
                    <SelectTrigger id="netease-asr-chunk" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(catalog?.chunk_ms_choices ?? [80, 160, 320, 640, 2000]).map((value) => (
                        <SelectItem key={value} value={String(value)}>
                          {value} ms{value >= 1000 ? `（${value / 1000}s）` : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : (
                <div className="flex items-end pb-2">
                  <div className="flex items-center gap-2">
                    <Checkbox id="netease-asr-ts" checked={withTimestamps} onCheckedChange={(checked) => setWithTimestamps(checked === true)} />
                    <Label htmlFor="netease-asr-ts" className="text-sm font-normal">输出时间戳</Label>
                  </div>
                </div>
              )}
            </div>

            <Tabs value={mode} onValueChange={(value) => setMode(value as TranscribeMode)}>
              <TabsList className="w-full">
                <TabsTrigger value="fast" className="flex-1">快速转写</TabsTrigger>
                <TabsTrigger value="stream" className="flex-1">流式转写</TabsTrigger>
              </TabsList>
            </Tabs>
            <p className="text-xs text-muted-foreground">
              {mode === 'stream'
                ? '流式模式逐块出字：已输出的文本不会被改写（append-only 真流式），适合打字幕 / 实时听写。'
                : '快速模式等全部转完一次性返回，适合整段音频的后处理。两种模式精度一致。'}
            </p>

            {loading ? (
              <Button variant="outline" onClick={handleCancel} className="w-full">
                <Square className="size-4" />
                取消（已等待 {elapsed} 秒）
              </Button>
            ) : (
              <Button
                onClick={handleTranscribe}
                disabled={!file || Boolean(installMissing)}
                className="w-full bg-gradient-to-r from-violet-600 to-indigo-500 text-white shadow-lg shadow-violet-500/20 hover:brightness-110"
                size="lg"
              >
                <Zap className="size-4" />
                {mode === 'stream' ? '开始流式转写' : '开始快速转写'}
              </Button>
            )}
            <p className="text-[11px] text-muted-foreground">
              权重为网易自有许可（代码 Apache-2.0），商用前请自行确认；音频仅在本机处理。
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="space-y-5 lg:col-span-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Captions className="size-4 text-violet-600 dark:text-violet-400" />
              转写结果
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {error ? (
              <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-destructive" />
                <div>
                  <p className="font-medium text-destructive">{error.message}</p>
                  {error.hint ? <p className="mt-1 opacity-80">{error.hint}</p> : null}
                </div>
              </div>
            ) : null}

            {results.entries.length > 0 ? (
              <ResultStack entries={asrEntries} onRemove={results.remove} onClear={results.clear} empty={null} />
            ) : null}

            {liveText ? (
              <div className="space-y-2">
                <div className="max-h-72 overflow-y-auto rounded-lg bg-muted/50 p-3 text-sm leading-relaxed whitespace-pre-wrap">
                  {liveText}
                  <span className="ml-0.5 inline-block h-4 w-0.5 animate-pulse bg-violet-500 align-middle" />
                </div>
                <p className="text-[11px] text-muted-foreground">流式输出中（append-only，已出部分不会被改写）</p>
              </div>
            ) : null}

            {results.entries.length === 0 && !liveText ? (
              <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
                {loading ? (
                  <span className="inline-flex items-center gap-2">
                    <Loader2 className="size-4 animate-spin" />
                    {mode === 'stream' ? '等待第一个字…（首次需启动 vLLM 引擎）' : '转写中…（首次需启动 vLLM 引擎）'}
                  </span>
                ) : (
                  '选择音频后开始转写，文本会出现在这里'
                )}
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">与现有 ASR 的关系</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-xs text-muted-foreground">
            <p>· 离线批量转写造训练数据集仍推荐现有 ASR 板块（FunASR / faster-whisper，轻量且已接入训练入口）。</p>
            <p>· 实时听写、打字幕、对延迟敏感的场景用本页 —— R2T2 的流式是 append-only 的，不会回头改字。</p>
            <p>· 引擎基于 vLLM，显存开销较大；与网易 TTS 引擎互斥，切换时自动让位。</p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

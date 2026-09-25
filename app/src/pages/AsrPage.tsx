import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Captions,
  ClipboardCopy,
  FileAudio,
  FolderOpen,
  Info,
  Loader2,
  RefreshCw,
  Sparkles,
  Upload,
  X,
} from 'lucide-react';
import { toast } from 'sonner';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { TermTip } from '@/components/features/TermTip';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import { JobPanel } from '@/components/features/JobPanel';
import { asrApi } from '@/lib/asr';
import { formatBytes } from '@/lib/audio';
import { RequestError } from '@/lib/errors';
import type {
  AsrCatalog,
  AsrDatasetPlan,
  AsrDatasetRequest,
  AsrDatasetSummary,
  AsrTranscribeResult,
} from '@/types';

/**
 * 语音转文本（ASR）。
 *
 * 页面上是两个使用场景，也是这一整个板块存在的理由：
 *
 * 1. **单条转写** —— 「这段音频说了什么」。音色库导入音色时要填逐字转写文本，
 *    而让人一边听一边打字既慢又容易错字，错字会被模型直接学进去；
 * 2. **训练入口** —— 「把一批音频变成带标注的数据集」。产出逐字文本 +
 *    官方格式清单（`路径|说话人|语种|文本`），可以直接喂给 GPT-SoVITS / RVC 的训练。
 *
 * 页面上刻意把「通道」与「模型」显示出来（而不是藏进日志）：
 * 服务端有两条通道，常驻模型快、官方脚本可复现，用户有权知道自己这次走的是哪条。
 */
export function AsrPage() {
  const [catalog, setCatalog] = useState<AsrCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // ---- 转写参数（单条与批量共用一套） ----
  const [presetKey, setPresetKey] = useState('reference');
  const [backend, setBackend] = useState('');
  const [size, setSize] = useState('');
  const [language, setLanguage] = useState('');
  const [precision, setPrecision] = useState('');
  const [channelPref, setChannelPref] = useState('');

  // ---- 单条转写 ----
  const [file, setFile] = useState<File | null>(null);
  const [source, setSource] = useState('');
  const [transcript, setTranscript] = useState<AsrTranscribeResult | null>(null);
  const [transcribing, setTranscribing] = useState(false);

  // ---- 训练入口 ----
  const [dsName, setDsName] = useState('asr-dataset');
  const [corpusDir, setCorpusDir] = useState('');
  const [uploaded, setUploaded] = useState<string[]>([]);
  const [speaker, setSpeaker] = useState('speaker0');
  const [minDuration, setMinDuration] = useState(0.5);
  const [maxDuration, setMaxDuration] = useState(60);
  const [limit, setLimit] = useState(500);
  const [submitting, setSubmitting] = useState(false);
  const [plan, setPlan] = useState<AsrDatasetPlan | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [datasets, setDatasets] = useState<AsrDatasetSummary[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await asrApi.catalog();
      setCatalog(result);
      setDatasets(result.diagnostics?.datasets ?? []);
      setError(null);
    } catch (err) {
      setError((err as RequestError).fullMessage);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 清单就绪后按「场景预设」铺一次参数。只跑一次（依赖 catalog 的引用），
  // 否则用户改完参数会被重新拉回预设值 —— 那是最令人恼火的一类「自动」。
  useEffect(() => {
    if (!catalog) return;
    const preset = catalog.presets.find((item) => item.key === presetKey) ?? catalog.presets[0];
    const target = preset ?? { ...catalog.defaults, key: '', label: '', hint: '' };
    setBackend(target.backend);
    setSize(target.size);
    setLanguage(target.language);
    setPrecision(target.precision);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog]);

  const backends = useMemo(() => catalog?.backends ?? [], [catalog]);
  const active = useMemo(() => backends.find((item) => item.id === backend) ?? null, [backends, backend]);
  const languageLabels = catalog?.language_labels ?? {};
  const activePreset = catalog?.presets.find((item) => item.key === presetKey) ?? null;

  /** 应用预设：一次把四个参数铺好，避免用户面对 tiny/large 的取舍 */
  const applyPreset = useCallback(
    (key: string) => {
      const preset = catalog?.presets.find((item) => item.key === key);
      if (!preset) return;
      setPresetKey(key);
      setBackend(preset.backend);
      setSize(preset.size);
      setLanguage(preset.language);
      setPrecision(preset.precision);
    },
    [catalog],
  );

  /** 换后端时把尺寸 / 语种 / 精度收敛到新后端支持的范围 */
  const handleBackendChange = useCallback(
    (next: string) => {
      setBackend(next);
      const info = backends.find((item) => item.id === next);
      if (!info) return;
      setSize((prev) => (info.sizes.includes(prev) ? prev : (info.sizes[info.sizes.length - 1] ?? '')));
      setLanguage((prev) => (info.languages.includes(prev) ? prev : (info.languages[0] ?? '')));
      setPrecision((prev) => (info.precisions.includes(prev) ? prev : (info.precisions[0] ?? '')));
    },
    [backends],
  );

  // ---------------- 单条转写 ----------------

  const handleTranscribe = useCallback(async () => {
    if (!file && !source.trim()) {
      toast.warning('请选择音频文件，或填写一个本机路径');
      return;
    }
    setTranscribing(true);
    try {
      const result = await asrApi.transcribe({
        file: file ?? undefined,
        source: file ? undefined : source.trim(),
        backend,
        size,
        language,
        precision,
        channel: channelPref,
      });
      setTranscript(result);
      if (result.warning) {
        toast.warning('未识别到文本', { description: result.warning });
      } else {
        toast.success('转写完成', {
          description: `${result.text.length} 字 · ${result.elapsed_s} 秒${result.cached ? ' · 命中缓存' : ''}`,
        });
      }
    } catch (err) {
      toast.error('转写失败', { description: (err as RequestError).fullMessage });
    } finally {
      setTranscribing(false);
    }
  }, [file, source, backend, size, language, precision, channelPref]);

  const handleCopy = useCallback(async () => {
    if (!transcript?.text) return;
    try {
      await navigator.clipboard.writeText(transcript.text);
      toast.success('已复制到剪贴板');
    } catch {
      toast.error('复制失败', { description: '浏览器拒绝了剪贴板访问，请手动选中复制。' });
    }
  }, [transcript]);

  // ---------------- 训练入口 ----------------

  const buildDatasetRequest = useCallback(
    (): AsrDatasetRequest => ({
      name: dsName.trim() || 'asr-dataset',
      corpus_dir: corpusDir.trim(),
      files: uploaded,
      recursive: true,
      speaker: speaker.trim() || 'speaker0',
      backend,
      size,
      language,
      precision,
      channel: channelPref,
      min_duration: minDuration,
      max_duration: maxDuration,
      skip_existing: true,
      use_cache: true,
      keep_empty: false,
      limit,
    }),
    [
      dsName,
      corpusDir,
      uploaded,
      speaker,
      backend,
      size,
      language,
      precision,
      channelPref,
      minDuration,
      maxDuration,
      limit,
    ],
  );

  const handleUpload = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setSubmitting(true);
    try {
      const result = await asrApi.upload(Array.from(files));
      setUploaded((prev) => [...prev, ...result.files]);
      const skipped = result.skipped.length ? `，跳过 ${result.skipped.length} 个` : '';
      toast.success(`已上传 ${result.files.length} 个音频${skipped}`);
    } catch (err) {
      toast.error('上传失败', { description: (err as RequestError).fullMessage });
    } finally {
      setSubmitting(false);
    }
  }, []);

  const handlePlan = useCallback(async () => {
    setSubmitting(true);
    try {
      const result = await asrApi.trainPlan(buildDatasetRequest());
      setPlan(result);
      if (result.error) {
        toast.warning('预检发现问题', { description: result.error });
      } else {
        toast.success('预检通过', {
          description: `待转写 ${result.totals.accepted} 条（通道：${result.engine.channel}）`,
        });
      }
    } catch (err) {
      toast.error('预检失败', { description: (err as RequestError).fullMessage });
    } finally {
      setSubmitting(false);
    }
  }, [buildDatasetRequest]);

  const handleSubmit = useCallback(async () => {
    setSubmitting(true);
    try {
      const result = await asrApi.train(buildDatasetRequest());
      setJobId(result.job_id);
      toast.success('任务已入队', { description: '转写进度在下方实时更新' });
    } catch (err) {
      toast.error('提交失败', { description: (err as RequestError).fullMessage });
    } finally {
      setSubmitting(false);
    }
  }, [buildDatasetRequest]);

  const handleJobComplete = useCallback(async () => {
    toast.success('数据集已生成', { description: '可在下方列表中查看清单路径' });
    try {
      const result = await asrApi.datasets();
      setDatasets(result.datasets);
    } catch {
      // 列表刷新失败不影响任务结果本身
    }
  }, []);

  // ---------------- 渲染 ----------------

  const channels = useMemo(() => {
    if (!catalog) return [];
    return catalog.diagnostics.backends.map((item) => ({
      ...item,
      label: catalog.backends.find((b) => b.id === item.id)?.label ?? item.id,
    }));
  }, [catalog]);

  return (
    <div className="space-y-5">
      {/* ---------------- 引擎状态 ---------------- */}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Captions className="size-4" />
              语音转文本
            </CardTitle>
            <CardDescription>
              {catalog
                ? catalog.engine.loaded
                  ? `模型常驻中：${catalog.engine.backend} / ${catalog.engine.model}`
                  : '模型未常驻：单条转写会按需加载（常驻通道）或按需起官方脚本（脚本通道）'
                : '正在读取 ASR 能力清单…'}
            </CardDescription>
          </div>
          <Button size="sm" variant="outline" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={loading ? 'size-3.5 animate-spin' : 'size-3.5'} />
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {error ? (
            <Alert variant="destructive">
              <Info className="size-4" />
              <AlertTitle>读不到 ASR 能力清单</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          <div className="grid gap-2 sm:grid-cols-2">
            {channels.map((item) => (
              <div key={item.id} className="rounded-lg border p-3 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{item.label}</span>
                  <Badge variant={item.channel === 'none' ? 'destructive' : 'secondary'} className="h-5 px-1.5 text-[10px]">
                    {item.channel === 'resident' ? '常驻可用' : item.channel === 'script' ? '脚本可用' : '不可用'}
                  </Badge>
                </div>
                <p className="mt-1.5 text-muted-foreground">
                  {item.channel === 'resident'
                    ? `依赖 ${item.resident.module} 已安装，模型常驻，单条秒级`
                    : item.channel === 'script'
                      ? item.script.path
                        ? `走整合包脚本：${item.script.path}`
                        : `脚本通道可用（${item.script.error || '按需起子进程'}）`
                      : `常驻通道：${item.resident.error || '不可用'}；脚本通道：${item.script.error || '不可用'}`}
                </p>
              </div>
            ))}
          </div>

          {catalog && catalog.diagnostics.installation === null ? (
            <Alert>
              <Info className="size-4" />
              <AlertTitle>未定位到 GPT-SoVITS 整合包</AlertTitle>
              <AlertDescription>
                脚本通道不可用。设 <code className="font-mono">GPT_SOVITS_HOME</code> 指向整合包根目录，
                或在服务所在解释器里装 <code className="font-mono">funasr</code> /{' '}
                <code className="font-mono">faster-whisper</code> 走常驻通道。
              </AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
      </Card>

      {/* ---------------- 参数（单条与批量共用） ---------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">转写参数</CardTitle>
          <CardDescription>
            先用场景预设铺好参数；要调参再往下改。语种明确时不要用「自动识别」——猜错会整段崩。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-2">
            <Label>
                    <TermTip term="场景预设" />
                  </Label>
            <div className="flex flex-wrap gap-2">
              {(catalog?.presets ?? []).map((item) => (
                <Button
                  key={item.key}
                  size="sm"
                  variant={presetKey === item.key ? 'default' : 'outline'}
                  onClick={() => applyPreset(item.key)}
                >
                  {item.label}
                </Button>
              ))}
            </div>
            {activePreset ? <p className="text-[11px] text-muted-foreground">{activePreset.hint}</p> : null}
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-1.5">
              <Label>
                    <TermTip term="ASR">后端</TermTip>
                  </Label>
              <Select value={backend} onValueChange={handleBackendChange}>
                <SelectTrigger>
                  <SelectValue placeholder="选择后端" />
                </SelectTrigger>
                <SelectContent>
                  {backends.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>
                    <TermTip term="模型规模">模型尺寸</TermTip>
                  </Label>
              <Select value={size} onValueChange={setSize}>
                <SelectTrigger>
                  <SelectValue placeholder="尺寸" />
                </SelectTrigger>
                <SelectContent>
                  {(active?.sizes ?? []).map((item) => (
                    <SelectItem key={item} value={item}>
                      {item}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>
                    <TermTip term="语料语种">语种</TermTip>
                  </Label>
              <Select value={language} onValueChange={setLanguage}>
                <SelectTrigger>
                  <SelectValue placeholder="语种" />
                </SelectTrigger>
                <SelectContent>
                  {(active?.languages ?? []).map((item) => (
                    <SelectItem key={item} value={item}>
                      {languageLabels[item] ?? item}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>
                    <TermTip term="精度" />
                  </Label>
              <Select value={precision} onValueChange={setPrecision}>
                <SelectTrigger>
                  <SelectValue placeholder="精度" />
                </SelectTrigger>
                <SelectContent>
                  {(active?.precisions ?? []).map((item) => (
                    <SelectItem key={item} value={item}>
                      {item}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {active?.precision_effective === false ? (
            <p className="text-[11px] text-amber-600 dark:text-amber-400">
              {active.label} 的官方脚本对 <code className="font-mono">-p</code> 标注「尚未接入」，这一项不影响结果。
            </p>
          ) : null}

          <div className="space-y-1.5 sm:max-w-xs">
            <Label>
                    <TermTip term="优先通道" />
                  </Label>
            <Select value={channelPref || 'auto'} onValueChange={(value) => setChannelPref(value === 'auto' ? '' : value)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">自动（常驻优先，不可用则降级脚本）</SelectItem>
                <SelectItem value="resident">强制常驻模型（快）</SelectItem>
                <SelectItem value="script">强制官方脚本（可复现）</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* ---------------- 单条转写 ---------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="size-4" />
            单条转写
          </CardTitle>
          <CardDescription>
            与音色库「一键智能转写」同一条链路：上传参考音频，直接得到逐字文本。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="asr-file">上传音频</Label>
              <Input
                id="asr-file"
                type="file"
                accept="audio/*,.wav,.mp3,.flac,.ogg,.m4a,.webm,.aac,.wma"
                onChange={(event) => {
                  const next = event.target.files?.[0] ?? null;
                  setFile(next);
                  if (next) setSource('');
                  event.target.value = '';
                }}
              />
              {file ? (
                <p className="text-[11px] text-muted-foreground">
                  {file.name} · {formatBytes(file.size)}
                </p>
              ) : null}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="asr-source" className="flex items-center gap-1.5">
                <FolderOpen className="size-3.5" />
                或引用磁盘上已有的文件
              </Label>
              <Input
                id="asr-source"
                value={source}
                onChange={(event) => {
                  setSource(event.target.value);
                  if (event.target.value) setFile(null);
                }}
                placeholder="例如 D:\\素材\\参考音频.wav"
                disabled={Boolean(file)}
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => void handleTranscribe()} disabled={transcribing}>
              {transcribing ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : <Captions className="mr-1.5 size-4" />}
              开始转写
            </Button>
            {transcript ? (
              <Button variant="outline" onClick={() => void handleCopy()}>
                <ClipboardCopy className="mr-1.5 size-4" />
                复制文本
              </Button>
            ) : null}
          </div>

          {transcript ? (
            <>
              <Separator />
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                  <Badge variant="secondary" className="h-5 px-1.5 font-mono text-[10px]">
                    {transcript.channel === 'resident' ? '常驻模型' : '官方脚本'}
                  </Badge>
                  <span>{transcript.backend}</span>
                  <span>·</span>
                  <span>{transcript.size}</span>
                  <span>·</span>
                  <span>{languageLabels[transcript.language] ?? transcript.language}</span>
                  <span>·</span>
                  <span>{transcript.elapsed_s} 秒</span>
                  {transcript.cached ? <span>· 命中缓存</span> : null}
                  {transcript.text ? <span>· {transcript.text.length} 字</span> : null}
                </div>
                {transcript.reason ? <p className="text-[11px] text-amber-600 dark:text-amber-400">{transcript.reason}</p> : null}
                {transcript.notes.map((note) => (
                  <p key={note} className="text-[11px] text-amber-600 dark:text-amber-400">
                    {note}
                  </p>
                ))}
                <Textarea value={transcript.text} readOnly className="min-h-[96px]" />
                {transcript.warning ? <p className="text-[11px] text-amber-600">{transcript.warning}</p> : null}
              </div>
            </>
          ) : null}
        </CardContent>
      </Card>

      {/* ---------------- 训练入口 ---------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <FileAudio className="size-4" />
            训练入口：批量音频 → 数据集
          </CardTitle>
          <CardDescription>
            逐条转写并导出逐字文本 + 官方格式清单（路径|说话人|语种|文本），可直接喂给 GPT-SoVITS / RVC 的训练。
            这是「训练任务」，会占满显卡，因此走任务队列而不是同步等待。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="asr-ds-name">
                    <TermTip term="数据集">数据集名称</TermTip>
                  </Label>
              <Input id="asr-ds-name" value={dsName} onChange={(event) => setDsName(event.target.value)} placeholder="例如 播报语料-2026" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="asr-ds-dir">
                    <TermTip term="语料目录">语料目录（本机路径）</TermTip>
                  </Label>
              <Input
                id="asr-ds-dir"
                value={corpusDir}
                onChange={(event) => setCorpusDir(event.target.value)}
                placeholder="例如 D:\\素材\\语料（子目录会一并扫描）"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="asr-ds-files">或上传音频（可选，与目录二选一）</Label>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" asChild>
                <label htmlFor="asr-ds-files" className="cursor-pointer">
                  <Upload className="mr-1.5 size-3.5" />
                  选择文件
                </label>
              </Button>
              <input
                id="asr-ds-files"
                type="file"
                multiple
                accept="audio/*,.wav,.mp3,.flac,.ogg,.m4a,.webm,.aac,.wma"
                className="hidden"
                onChange={(event) => void handleUpload(event.target.files)}
              />
              <span className="text-xs text-muted-foreground">
                已上传 {uploaded.length} 个{uploaded.length > 0 ? '（落盘在服务的数据目录里）' : ''}
              </span>
              {uploaded.length > 0 ? (
                <Button size="sm" variant="ghost" onClick={() => setUploaded([])}>
                  <X className="mr-1 size-3.5" />
                  清空
                </Button>
              ) : null}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-4">
            <div className="space-y-1.5">
              <Label htmlFor="asr-ds-speaker">说话人名</Label>
              <Input id="asr-ds-speaker" value={speaker} onChange={(event) => setSpeaker(event.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="asr-ds-min">最短时长（秒）</Label>
              <Input
                id="asr-ds-min"
                type="number"
                step="0.1"
                value={minDuration}
                onChange={(event) => setMinDuration(Number(event.target.value) || 0)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="asr-ds-max">最长时长（秒）</Label>
              <Input
                id="asr-ds-max"
                type="number"
                step="1"
                value={maxDuration}
                onChange={(event) => setMaxDuration(Number(event.target.value) || 0)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="asr-ds-limit">单次上限（条）</Label>
              <Input
                id="asr-ds-limit"
                type="number"
                step="10"
                value={limit}
                onChange={(event) => setLimit(Number(event.target.value) || 0)}
              />
            </div>
          </div>

          <p className="text-[11px] text-muted-foreground">
            时长之外的音频会被跳过：太短的通常是爆音或静音，太长的整段朗读会让 ASR 在静音段编出文本。
          </p>

          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={() => void handlePlan()} disabled={submitting}>
              {submitting ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : null}
              预检计划
            </Button>
            <Button onClick={() => void handleSubmit()} disabled={submitting}>
              {submitting ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : null}
              开始转写并导出数据集
            </Button>
          </div>

          {plan ? (
            <div className="space-y-2 rounded-lg border p-3">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <Badge variant="secondary" className="h-5 px-1.5 font-mono text-[10px]">
                  {plan.engine.channel === 'resident' ? '常驻模型' : '官方脚本'}
                </Badge>
                <span className="font-mono text-[11px]">{plan.engine.model}</span>
                <span className="text-muted-foreground">
                  待转写 {plan.totals.accepted} 条 / 找到 {plan.totals.found} 条 / 时长过滤{' '}
                  {plan.totals.rejected} 条
                  {plan.totals.truncated > 0 ? ` · 超出上限 ${plan.totals.truncated} 条` : ''}
                </span>
              </div>
              <p className="break-all text-[11px] text-muted-foreground">产物目录：{plan.dataset_dir}</p>
              {plan.error ? <p className="text-[11px] text-destructive">{plan.error}</p> : null}
              <div className="space-y-1">
                {plan.stages.map((stage) => (
                  <div key={stage.key} className="text-[11px] text-muted-foreground">
                    <span className="font-medium text-foreground">{stage.label}</span>
                    <span className="ml-1">{stage.detail}</span>
                    {stage.command ? <p className="break-all font-mono opacity-80">{stage.command}</p> : null}
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <JobPanel jobId={jobId} onComplete={() => void handleJobComplete()} accent="text-indigo-500" title="ASR 数据集任务" />
        </CardContent>
      </Card>

      {/* ---------------- 已有数据集 ---------------- */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="text-base">已生成的数据集</CardTitle>
            <CardDescription>清单可直接在「模型训练」里作为列表文件使用，也可以逐条校对。</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          {datasets.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">还没有数据集</p>
          ) : (
            <div className="space-y-2">
              {datasets.map((item) => (
                <div key={item.dir} className="rounded-lg border p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-medium">{item.name}</span>
                    <span className="text-[11px] text-muted-foreground">
                      {item.total ?? 0} 条 · 成功 {item.succeeded ?? 0} · 空文本 {item.empty ?? 0} · 失败{' '}
                      {item.failed ?? 0}
                    </span>
                  </div>
                  <p className="mt-1 break-all text-[11px] text-muted-foreground">{item.dir}</p>
                  {item.list ? (
                    <p className="mt-0.5 break-all font-mono text-[11px] text-muted-foreground">{item.list}</p>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

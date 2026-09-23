import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  CircleDashed,
  Cpu,
  FlaskConical,
  FolderUp,
  Loader2,
  Play,
  RefreshCw,
  Server,
  Square,
  TriangleAlert,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { RequestError } from '@/lib/errors';
import { sovitsApi } from '@/lib/sovits';
import { cn } from '@/lib/utils';
import type { SovitsCatalog, SovitsHealth, SovitsJob, SovitsTrainPayload, SovitsTrainPlan } from '@/types';

/** 训练流水线的阶段中文名（与服务端 `training.STAGES` 对齐） */
const STAGE_LABELS: Record<string, string> = {
  import: '语料导入',
  denoise: '语音降噪',
  slice: '音频切分',
  asr: '语音转文本',
  list: '生成训练清单',
  text: '文本与 BERT 特征',
  hubert: 'HuBERT 特征',
  sv: '说话人向量',
  semantic: '语义 Token',
  s1: 'GPT 训练',
  s2: 'SoVITS 训练',
};

const POLL_INTERVAL_MS = 2_000;

/**
 * 模型训练页。
 *
 * GPT-SoVITS 的官方 WebUI 把训练拆成两页十几个按钮，新手极容易在
 * 「切分之后文本丢了」「不切分就得自己准备 .lab」这类环节卡住。
 * 本页把它收敛成一条**有明确前置校验的流水线**：
 *
 * ```
 * 语料导入 → 降噪 → 切分 → 识别 → 清单 → 格式化 → GPT → SoVITS
 * ```
 *
 * 三个让这件事变可靠的设计：
 *
 * - **预检（plan）**：先让服务端把每一步的命令拼出来给你看，参数错了当场就报；
 * - **阶段开关**：想只重跑某一段（例如只重新标注）就把其它关掉，不必从头再来；
 * - **成果回填**：训练产出的权重路径直接展示出来，可以立刻拿去合成试听。
 */
export function TrainingPage() {
  const [health, setHealth] = useState<SovitsHealth | null>(null);
  const [catalog, setCatalog] = useState<SovitsCatalog | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // 表单
  const [name, setName] = useState('');
  const [sourceDir, setSourceDir] = useState('');
  const [textLang, setTextLang] = useState<'zh' | 'en' | 'ja' | 'ko' | 'yue'>('zh');
  const [version, setVersion] = useState('v2ProPlus');
  const [speaker, setSpeaker] = useState('default');
  const [gpuIds, setGpuIds] = useState('0');

  const [runDenoise, setRunDenoise] = useState(false);
  const [runSlice, setRunSlice] = useState(false);
  const [runAsr, setRunAsr] = useState(false);
  const [runFormat, setRunFormat] = useState(true);
  const [runS1, setRunS1] = useState(true);
  const [runS2, setRunS2] = useState(true);

  const [asrBackend, setAsrBackend] = useState<'funasr' | 'fasterwhisper'>('funasr');
  const [asrSize, setAsrSize] = useState('large');
  const [asrLanguage, setAsrLanguage] = useState('zh');

  const [epochsS1, setEpochsS1] = useState(15);
  const [batchS1, setBatchS1] = useState(6);
  const [epochsS2, setEpochsS2] = useState(8);
  const [batchS2, setBatchS2] = useState(6);
  const [loraRank, setLoraRank] = useState(32);

  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [plan, setPlan] = useState<SovitsTrainPlan | null>(null);
  const [job, setJob] = useState<SovitsJob | null>(null);
  const [history, setHistory] = useState<SovitsJob[]>([]);
  /** 历史任务就地展开：同一时刻只展开一条，详情按 id 缓存 */
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);
  const [jobDetails, setJobDetails] = useState<Record<string, SovitsJob>>({});
  const [loadingDetailId, setLoadingDetailId] = useState<string | null>(null);

  const fileRef = useRef<HTMLInputElement | null>(null);
  const pollRef = useRef<number | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => () => stopPolling(), [stopPolling]);

  // ------------------------------------------------------------------
  // 初始化
  // ------------------------------------------------------------------

  const loadHistory = useCallback(async () => {
    try {
      const result = await sovitsApi.listTrainJobs();
      setHistory(result.jobs);
    } catch {
      // 历史任务拿不到不影响主流程
    }
  }, []);

  /**
   * 展开 / 收起一条历史任务。
   *
   * 详情**就地展开在列表条目内部**（再点一次即收起），不再覆写页面顶部的
   * 「训练进度」卡片 —— 那张卡只负责展示本次提交的任务，两者位置与状态互不干扰。
   */
  const toggleHistoryJob = useCallback(
    async (id: string) => {
      const willExpand = expandedJobId !== id;
      setExpandedJobId(willExpand ? id : null);
      if (!willExpand || jobDetails[id]) return;
      setLoadingDetailId(id);
      try {
        const { job: full } = await sovitsApi.getJob(id);
        setJobDetails((prev) => ({ ...prev, [id]: full }));
      } catch (error) {
        toast.error('读取任务详情失败', { description: (error as RequestError).fullMessage });
        setExpandedJobId((prev) => (prev === id ? null : prev));
      } finally {
        setLoadingDetailId((prev) => (prev === id ? null : prev));
      }
    },
    [expandedJobId, jobDetails],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const [healthResult, catalogResult] = await Promise.all([
          sovitsApi.health(),
          sovitsApi.catalog(),
        ]);
        if (cancelled) return;
        setHealth(healthResult);
        setCatalog(catalogResult.catalog);
        setVersion(catalogResult.catalog.default_version);
        setConnectionError(null);
        await loadHistory();
      } catch (error) {
        if (cancelled) return;
        setConnectionError((error as RequestError).fullMessage);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadHistory]);

  // FunASR 只支持中文与粤语，其余语种必须换 faster-whisper
  useEffect(() => {
    if (asrBackend === 'funasr' && !['zh', 'yue'].includes(textLang)) {
      setAsrBackend('fasterwhisper');
    }
    setAsrLanguage(textLang);
  }, [textLang, asrBackend]);

  // ------------------------------------------------------------------
  // 语料
  // ------------------------------------------------------------------

  const handleUpload = useCallback(async (files: FileList) => {
    if (files.length === 0) return;
    setUploading(true);
    try {
      const result = await sovitsApi.uploadCorpus(Array.from(files));
      setSourceDir(result.dir);
      toast.success('语料已上传', {
        description: `${result.files.length} 个文件${
          result.rejected.length ? `，${result.rejected.length} 个被拒绝` : ''
        }`,
      });
    } catch (error) {
      toast.error('上传失败', { description: (error as RequestError).fullMessage });
    } finally {
      setUploading(false);
    }
  }, []);

  // ------------------------------------------------------------------
  // 预检与提交
  // ------------------------------------------------------------------

  const buildPayload = useCallback(
    (planOnly: boolean): SovitsTrainPayload => ({
      name: name.trim(),
      source_audio_dir: sourceDir.trim() || undefined,
      text_lang: textLang,
      version,
      speaker: speaker.trim() || 'default',
      gpu_ids: gpuIds.trim() || '0',
      run_denoise: runDenoise,
      run_slice: runSlice,
      run_asr: runAsr,
      run_format: runFormat,
      run_s1: runS1,
      run_s2: runS2,
      slice: catalog?.slice_defaults ?? {
        threshold: -34,
        min_length: 4000,
        min_interval: 300,
        hop_size: 10,
        max_sil_kept: 500,
        max: 0.9,
        alpha: 0.25,
        n_parts: 1,
      },
      asr_backend: asrBackend,
      asr_model_size: asrSize,
      asr_language: asrLanguage,
      asr_precision: 'float16',
      epochs_s1: epochsS1,
      batch_size_s1: batchS1,
      save_every_epoch_s1: Math.max(1, Math.floor(epochsS1 / 3)),
      if_dpo: false,
      epochs_s2: epochsS2,
      batch_size_s2: batchS2,
      save_every_epoch_s2: Math.max(1, Math.floor(epochsS2 / 2)),
      text_low_lr_rate: 0.4,
      if_grad_ckpt: false,
      lora_rank: loraRank,
      if_save_every_weights: true,
      if_save_latest: true,
      dry_run: false,
      plan_only: planOnly,
    }),
    [
      name,
      sourceDir,
      textLang,
      version,
      speaker,
      gpuIds,
      runDenoise,
      runSlice,
      runAsr,
      runFormat,
      runS1,
      runS2,
      catalog,
      asrBackend,
      asrSize,
      asrLanguage,
      epochsS1,
      batchS1,
      epochsS2,
      batchS2,
      loraRank,
    ],
  );

  const validate = useCallback(() => {
    if (!name.trim()) {
      toast.warning('请填写实验名称', { description: '它同时会作为输出目录名与权重文件名' });
      return false;
    }
    if (!sourceDir.trim()) {
      toast.warning('请先上传语料，或填写服务器上的语料目录');
      return false;
    }
    return true;
  }, [name, sourceDir]);

  const handlePlan = useCallback(async () => {
    if (!validate()) return;
    setSubmitting(true);
    try {
      const result = await sovitsApi.planTrain({ ...buildPayload(true), plan_only: false });
      setPlan(result);
      toast.success('预检通过', { description: `将执行 ${result.steps.length} 个阶段` });
    } catch (error) {
      setPlan(null);
      toast.error('预检未通过', { description: (error as RequestError).fullMessage });
    } finally {
      setSubmitting(false);
    }
  }, [validate, buildPayload]);

  const handleStart = useCallback(async () => {
    if (!validate()) return;
    setSubmitting(true);
    setJob(null);
    try {
      const created = await sovitsApi.createTrain(buildPayload(false));
      toast.success('训练任务已入队', {
        description: '训练可能持续数分钟到数小时，可以随时回来看进度',
      });

      stopPolling();
      pollRef.current = window.setInterval(() => {
        void (async () => {
          try {
            const { job: current } = await sovitsApi.getJob(created.job_id);
            setJob(current);
            if (['succeeded', 'failed', 'cancelled'].includes(current.state)) {
              stopPolling();
              setSubmitting(false);
              void loadHistory();
              if (current.state === 'succeeded') {
                toast.success('训练完成', { description: '训练产物已写入 GPT_weights / SoVITS_weights' });
              } else if (current.state === 'failed') {
                toast.error('训练失败', { description: current.error ?? '详见任务日志' });
              }
            }
          } catch {
            stopPolling();
            setSubmitting(false);
            toast.error('轮询训练状态失败');
          }
        })();
      }, POLL_INTERVAL_MS);
    } catch (error) {
      toast.error('提交失败', { description: (error as RequestError).message });
      setSubmitting(false);
    }
  }, [validate, buildPayload, stopPolling, loadHistory]);

  const handleCancel = useCallback(async () => {
    if (!job?.id) return;
    try {
      await sovitsApi.cancelJob(job.id);
      toast.info('已请求取消');
    } catch (error) {
      toast.error('取消失败', { description: (error as RequestError).fullMessage });
    }
  }, [job?.id]);

  const running = job?.state === 'running' || job?.state === 'queued';
  const asrBackends = catalog?.asr_backends ?? [];
  const currentBackend = asrBackends.find((item) => item.id === asrBackend);
  /** 模型版本选项：折叠态只显示名称，详细说明留给展开后的下拉列表 */
  const versionOptions = catalog?.versions ?? [{ id: 'v2ProPlus', label: 'v2ProPlus' }];
  const versionLabel = versionOptions.find((item) => item.id === version)?.label ?? version;

  if (connectionError) {
    return (
      <Alert variant="destructive">
        <Server className="size-4" />
        <AlertTitle>GPT-SoVITS 本地服务不可用</AlertTitle>
        <AlertDescription className="space-y-2">
          <p>{connectionError}</p>
          <p className="text-xs opacity-90">
            训练需要本机有 GPU 与完整环境。请确认已执行 `npm run dev`，或单独运行
            scripts/start.ps1 / start.sh。
          </p>
          <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
            <RefreshCw className="mr-1.5 size-3.5" />
            重新加载
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-5">
      {health && !health.capabilities.training ? (
        <Alert variant="destructive">
          <TriangleAlert className="size-4" />
          <AlertTitle>训练能力尚未就绪</AlertTitle>
          <AlertDescription>
            <ul className="mt-1 space-y-0.5">
              {health.blockers.map((item) => (
                <li key={item}>· {item}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <FlaskConical className="size-4" />
            语料与实验
          </CardTitle>
          <CardDescription>
            官方建议：零样本克隆 5 秒即可，微调则至少 1 分钟有效语音；音频要单人、无背景音乐、无混响
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="train-name">实验名称</Label>
              <Input
                id="train-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="例如：my-voice-v1（英文数字下划线）"
                spellCheck={false}
              />
              <p className="text-[11px] text-muted-foreground">
                同时用作输出目录名与权重文件名，训练完成后按这个名字查找产物
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="train-dir">语料目录</Label>
              <div className="flex gap-2">
                <Input
                  id="train-dir"
                  value={sourceDir}
                  onChange={(event) => setSourceDir(event.target.value)}
                  placeholder="D:\\素材\\我的声音  或上传后自动填入"
                  spellCheck={false}
                  className="font-mono text-sm"
                />
                <input
                  ref={fileRef}
                  type="file"
                  multiple
                  accept="audio/*,.wav,.mp3,.flac,.ogg,.m4a,.webm,.aac,.wma"
                  className="hidden"
                  onChange={(event) => {
                    if (event.target.files) void handleUpload(event.target.files);
                    event.target.value = '';
                  }}
                />
                <Button
                  variant="outline"
                  onClick={() => fileRef.current?.click()}
                  disabled={uploading}
                  className="shrink-0"
                >
                  {uploading ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <>
                      <FolderUp className="mr-1.5 size-3.5" />
                      上传
                    </>
                  )}
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground">
                目录里放原始音频；若开启切分则必须同时开启语音识别（切分会丢掉原文本）
              </p>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="min-w-0 space-y-2">
              <Label>语料语种</Label>
              <Select
                value={textLang}
                onValueChange={(value) => setTextLang(value as typeof textLang)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(catalog?.train_languages ?? ['zh', 'en', 'ja', 'ko', 'yue']).map((item) => (
                    <SelectItem key={item} value={item}>
                      {item}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="min-w-0 space-y-2">
              <Label>模型版本</Label>
              <Select value={version} onValueChange={setVersion}>
                <SelectTrigger>
                  <SelectValue>{versionLabel}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {versionOptions.map((item) => (
                    <SelectItem key={item.id} value={item.id} title={item.note}>
                      {item.label}
                      {item.note ? <span className="text-muted-foreground"> · {item.note}</span> : null}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="min-w-0 space-y-2">
              <Label htmlFor="train-speaker">说话人名</Label>
              <Input
                id="train-speaker"
                value={speaker}
                onChange={(event) => setSpeaker(event.target.value)}
                placeholder="default"
                spellCheck={false}
                className="font-mono text-sm"
              />
            </div>

            <div className="min-w-0 space-y-2">
              <Label htmlFor="train-gpu">GPU 编号</Label>
              <Input
                id="train-gpu"
                value={gpuIds}
                onChange={(event) => setGpuIds(event.target.value)}
                placeholder="0 或 0-1"
                spellCheck={false}
                className="font-mono text-sm"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ---------------- 流水线开关 ---------------- */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">流水线</CardTitle>
          <CardDescription>
            想只重跑某一段（例如只重新标注）时，把其它阶段关掉即可，不必从头再来
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {(
              [
                ['import', '语料导入', true],
                ['denoise', '降噪', runDenoise],
                ['slice', '切分', runSlice],
                ['asr', '语音识别', runAsr],
                ['list', '清单', !runAsr],
                ['text', '文本特征', runFormat],
                ['hubert', 'HuBERT', runFormat],
                ['sv', '说话人向量', runFormat && ['v2Pro', 'v2ProPlus'].includes(version)],
                ['semantic', '语义 Token', runFormat],
                ['s1', 'GPT 训练', runS1],
                ['s2', 'SoVITS 训练', runS2],
              ] as [string, string, boolean][]
            ).map(([key, label, enabled]) => (
              <Badge
                key={key}
                variant={enabled ? 'default' : 'secondary'}
                className={cn('h-6 px-2 text-[11px] font-normal', !enabled && 'text-muted-foreground line-through')}
              >
                {label}
              </Badge>
            ))}
          </div>

          <Separator />

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <StageToggle
              label="语音降噪"
              hint="去除底噪与轻微混响（tools/cmd-denoise.py）"
              checked={runDenoise}
              onChange={setRunDenoise}
            />
            <StageToggle
              label="音频切分"
              hint="按静音切成 5~15 秒片段；开启后必须同时开启语音识别"
              checked={runSlice}
              onChange={setRunSlice}
            />
            <StageToggle
              label="语音转文本"
              hint="FunASR / faster-whisper 自动生成标注与训练清单"
              checked={runAsr}
              onChange={setRunAsr}
            />
            <StageToggle
              label="格式化训练集"
              hint="文本特征、HuBERT、说话人向量、语义 Token 四步"
              checked={runFormat}
              onChange={setRunFormat}
            />
            <StageToggle
              label="GPT（语义）训练"
              hint="s1_train.py，决定断句与韵律"
              checked={runS1}
              onChange={setRunS1}
            />
            <StageToggle
              label="SoVITS（声学）训练"
              hint="s2_train.py，决定音色相似度"
              checked={runS2}
              onChange={setRunS2}
            />
          </div>

          {runAsr ? (
            <>
              <Separator />
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="min-w-0 space-y-2">
                  <Label>识别后端</Label>
                  <Select
                    value={asrBackend}
                    onValueChange={(value) => setAsrBackend(value as typeof asrBackend)}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {asrBackends.map((item) => (
                        <SelectItem key={item.id} value={item.id}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-[11px] text-muted-foreground">
                    FunASR 仅支持中文与粤语；其它语种会自动切到 faster-whisper
                  </p>
                </div>
                <div className="min-w-0 space-y-2">
                  <Label>模型规模</Label>
                  <Select value={asrSize} onValueChange={setAsrSize}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(currentBackend?.sizes ?? ['large']).map((item) => (
                        <SelectItem key={item} value={item}>
                          {item}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="min-w-0 space-y-2">
                  <Label>识别语种</Label>
                  <Select value={asrLanguage} onValueChange={setAsrLanguage}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(currentBackend?.languages ?? ['zh']).map((item) => (
                        <SelectItem key={item} value={item}>
                          {item}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </>
          ) : null}
        </CardContent>
      </Card>

      {/* ---------------- 训练超参 ---------------- */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">训练超参</CardTitle>
          <CardDescription>
            小语料（1~5 分钟）建议 epoch 适当调大、batch 调小；显存不足时把 batch 降到 1 或开启梯度检查点
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <NumberField label="GPT epoch" value={epochsS1} onChange={setEpochsS1} min={1} max={1000} />
          <NumberField label="GPT batch" value={batchS1} onChange={setBatchS1} min={1} max={64} />
          <NumberField label="SoVITS epoch" value={epochsS2} onChange={setEpochsS2} min={1} max={1000} />
          <NumberField label="SoVITS batch" value={batchS2} onChange={setBatchS2} min={1} max={64} />
          <NumberField
            label="LoRA rank（v3/v4）"
            value={loraRank}
            onChange={setLoraRank}
            min={1}
            max={256}
            hint="仅 v3/v4 走 LoRA 训练时生效"
          />
        </CardContent>
      </Card>

      {/* ---------------- 操作 ---------------- */}
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => void handleStart()} disabled={submitting || loading}>
          {submitting && running ? (
            <Loader2 className="mr-1.5 size-4 animate-spin" />
          ) : (
            <Play className="mr-1.5 size-4" />
          )}
          开始训练
        </Button>
        <Button variant="outline" onClick={() => void handlePlan()} disabled={submitting}>
          预检计划
        </Button>
        {running ? (
          <Button variant="ghost" onClick={() => void handleCancel()}>
            <Square className="mr-1.5 size-3.5" />
            取消训练
          </Button>
        ) : null}
        <Button variant="ghost" size="sm" className="ml-auto" onClick={() => void loadHistory()}>
          <RefreshCw className="size-3.5" />
        </Button>
      </div>

      {/* ---------------- 预检结果 ---------------- */}
      {plan ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">预检结果 · {plan.steps.length} 个阶段</CardTitle>
            {plan.skipped.length > 0 ? (
              <CardDescription>{plan.skipped.join(' · ')}</CardDescription>
            ) : null}
          </CardHeader>
          <CardContent className="space-y-2">
            {plan.steps.map((step) => (
              <div key={step.stage} className="rounded-lg border p-3">
                <div className="flex items-center gap-2">
                  <Badge variant="secondary" className="h-5 font-mono text-[10px]">
                    {step.phase}
                  </Badge>
                  <span className="text-sm font-medium">{step.label}</span>
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">{step.note}</p>
                {step.commands.length > 0 ? (
                  <pre className="scrollbar-thin mt-2 overflow-x-auto rounded bg-muted/60 p-2 text-[10px] leading-relaxed">
                    {step.commands.join('\n')}
                  </pre>
                ) : (
                  <p className="mt-2 text-[11px] italic text-muted-foreground">由服务内联完成</p>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      {/* ---------------- 训练进度 ---------------- */}
      {job ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              {running ? (
                <Loader2 className="size-4 animate-spin" />
              ) : job.state === 'succeeded' ? (
                <CheckCircle2 className="size-4 text-emerald-500" />
              ) : (
                <XCircle className="size-4 text-destructive" />
              )}
              训练进度
              <Badge variant="outline" className="ml-auto font-mono text-[11px]">
                {job.state}
              </Badge>
            </CardTitle>
            <CardDescription>{job.message || '等待调度'}</CardDescription>
          </CardHeader>
          <CardContent>
            <JobDetail job={job} />
          </CardContent>
        </Card>
      ) : null}

      {/* ---------------- 历史任务 ---------------- */}
      {history.length > 0 ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">历史任务</CardTitle>
            <CardDescription>
              点击任意一条就地展开阶段状态与日志，再点一次（或点「收起详情」）即可收起
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {history.map((item) => {
              const expanded = expandedJobId === item.id;
              // 正在跑的那条直接复用实时状态，其余用展开时拉取的快照
              const detail = job?.id === item.id ? job : jobDetails[item.id];
              return (
                <div
                  key={item.id}
                  className={cn(
                    'overflow-hidden rounded-lg border transition',
                    expanded ? 'bg-muted/30' : 'hover:bg-muted/50',
                  )}
                >
                  <button
                    type="button"
                    aria-expanded={expanded}
                    onClick={() => void toggleHistoryJob(item.id)}
                    className="flex w-full items-center gap-3 p-3 text-left text-sm"
                  >
                    <Badge
                      variant={item.state === 'succeeded' ? 'default' : 'secondary'}
                      className={cn('h-5 text-[10px]', item.state === 'succeeded' && 'bg-emerald-600')}
                    >
                      {item.state}
                    </Badge>
                    <span className="min-w-0 flex-1 truncate font-medium">{item.name || item.id}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {(item.elapsed_ms / 1000).toFixed(0)}s
                    </span>
                    {loadingDetailId === item.id ? (
                      <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
                    ) : (
                      <ChevronDown
                        className={cn(
                          'size-4 shrink-0 text-muted-foreground transition-transform',
                          expanded && 'rotate-180',
                        )}
                      />
                    )}
                  </button>

                  {expanded ? (
                    <div className="space-y-4 border-t px-3 py-3">
                      {detail ? (
                        <>
                          {detail.message ? (
                            <p className="text-xs text-muted-foreground">{detail.message}</p>
                          ) : null}
                          <JobDetail job={detail} />
                        </>
                      ) : (
                        <p className="flex items-center gap-2 text-xs text-muted-foreground">
                          <Loader2 className="size-3.5 animate-spin" />
                          正在读取阶段状态与日志…
                        </p>
                      )}
                      <div className="flex justify-end">
                        <Button size="sm" variant="ghost" onClick={() => setExpandedJobId(null)}>
                          收起详情
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </CardContent>
        </Card>
      ) : null}

      {loading ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          正在读取本地环境…
        </p>
      ) : (
        health?.runtime.has_gpu && (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Cpu className="size-3.5" />
            {health.runtime.device_label} · 训练期间会独占显卡，建议先不要同时做批量合成
          </p>
        )
      )}
    </div>
  );
}

function StageToggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border p-3">
      <div className="min-w-0">
        <Label className="cursor-pointer text-sm">{label}</Label>
        <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{hint}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} className="mt-0.5 shrink-0" />
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  hint,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  hint?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      <Input
        type="number"
        className="h-9"
        value={value}
        min={min}
        max={max}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (Number.isFinite(next)) onChange(Math.min(max, Math.max(min, next)));
        }}
      />
      {hint ? <p className="text-[11px] leading-snug text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/**
 * 单次任务的阶段状态、产物与日志。
 *
 * 「训练进度」卡片与「历史任务」的展开区共用这一份渲染逻辑，
 * 避免两处字段各改各的；日志折叠状态由组件自己持有，
 * 所以「训练进度」的日志开关不会影响历史任务里展开的那几条。
 */
function JobDetail({ job }: { job: SovitsJob }) {
  const [showLogs, setShowLogs] = useState(false);
  const stages = job.stages ?? [];
  const artifacts = (job.artifacts ?? {}) as Record<string, string | undefined>;

  return (
    <div className="space-y-4">
      <Progress value={Math.round(job.progress * 100)} />

      <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
        <span>进度 {Math.round(job.progress * 100)}%</span>
        <span>已耗时 {(job.elapsed_ms / 1000).toFixed(0)}s</span>
        <span>排队 {(job.waiting_ms / 1000).toFixed(0)}s</span>
      </div>

      {stages.length > 0 ? (
        <div className="space-y-1.5">
          {stages.map((stage) => (
            <div key={stage.key} className="flex items-center gap-2 text-xs">
              {stage.state === 'succeeded' ? (
                <CheckCircle2 className="size-3.5 shrink-0 text-emerald-500" />
              ) : stage.state === 'running' ? (
                <Loader2 className="size-3.5 shrink-0 animate-spin text-violet-500" />
              ) : stage.state === 'failed' ? (
                <XCircle className="size-3.5 shrink-0 text-destructive" />
              ) : (
                <CircleDashed className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className={cn(stage.state !== 'queued' && 'font-medium')}>
                {STAGE_LABELS[stage.key] ?? stage.label}
              </span>
              {stage.detail ? (
                <span className="truncate text-muted-foreground">{stage.detail}</span>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {artifacts.gpt_model || artifacts.sovits_model ? (
        <div className="space-y-1 rounded-lg bg-emerald-500/5 p-3 text-xs text-emerald-700 dark:text-emerald-400">
          <p className="font-medium">训练产物已就绪，可以切过去试听：</p>
          {artifacts.gpt_model ? (
            <p className="truncate font-mono">{artifacts.gpt_model}</p>
          ) : null}
          {artifacts.sovits_model ? (
            <p className="truncate font-mono">{artifacts.sovits_model}</p>
          ) : null}
          <p className="opacity-90">
            到「设置 → GPT-SoVITS 本地服务」把默认版本切到对应版本后，合成页会自动使用最新权重。
          </p>
        </div>
      ) : null}

      {job.logs?.length ? (
        <>
          <Button size="sm" variant="ghost" onClick={() => setShowLogs((prev) => !prev)}>
            {showLogs ? '收起日志' : `查看日志（${job.log_count ?? job.logs.length} 行）`}
          </Button>
          {showLogs ? (
            <pre className="scrollbar-thin max-h-80 overflow-auto rounded-md bg-muted/50 p-3 text-[11px] leading-relaxed">
              {job.logs.slice(-120).map((line) => `[${line.level}] ${line.text}`).join('\n')}
            </pre>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

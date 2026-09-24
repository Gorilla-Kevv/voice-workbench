import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  CircleDashed,
  Cpu,
  FileSpreadsheet,
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
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { TermTip } from '@/components/features/TermTip';
import { RequestError } from '@/lib/errors';
import { resolveAudioUrl, sovitsApi } from '@/lib/sovits';
import { cn } from '@/lib/utils';
import type {
  SovitsAnnotationItem,
  SovitsCatalog,
  SovitsHealth,
  SovitsJob,
  SovitsSliceDefaults,
  SovitsTrainPayload,
  SovitsTrainPlan,
  SovitsUvrModel,
} from '@/types';

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

/** 数值滑块：标签 + 当前值 + 滑块。切分参数这类「有明确取值范围」的数值都用它。 */
function ParamSlider({
  label,
  hint,
  term,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  hint?: string;
  /** 术语表里的键名；给了就给标题加悬浮解释 */
  term?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (next: number) => void;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <Label className="text-xs">{term ? <TermTip term={term}>{label}</TermTip> : label}</Label>
        <span className="font-mono text-xs tabular-nums text-muted-foreground">{value}</span>
      </div>
      <Slider value={[value]} min={min} max={max} step={step} onValueChange={([next]) => onChange(next)} />
      {hint ? <p className="text-[11px] leading-snug text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/**
 * 跨页面切换保留的会话状态。
 *
 * 与批量合成页同样的原因：App 按导航键**条件渲染**（切走即卸载），
 * 组件 state 随之消失。训练尤其不能丢 —— 一次训练动辄几十分钟到几小时，
 * 切去别处看一眼再回来，进度和日志全没了，只剩「不知道跑到哪了」。
 *
 * 这里只存元数据（表单、阶段开关、任务快照）；任务本身在服务端继续跑，
 * 回到页面时按 job 状态接着轮询即可。
 */
interface TrainSession {
  name: string;
  sourceDir: string;
  textLang: 'zh' | 'en' | 'ja' | 'ko' | 'yue';
  version: string;
  speaker: string;
  gpuIds: string;
  runDenoise: boolean;
  runSlice: boolean;
  runAsr: boolean;
  runFormat: boolean;
  runS1: boolean;
  runS2: boolean;
  asrBackend: 'funasr' | 'fasterwhisper';
  asrSize: string;
  asrLanguage: string;
  asrPrecision: 'float16' | 'float32' | 'int8';
  epochsS1: number;
  batchS1: number;
  epochsS2: number;
  batchS2: number;
  loraRank: number;

  // ---------- UVR5 人声/伴奏分离 ----------
  runUvr: boolean;
  uvrModel: string;
  uvrAgg: number;
  uvrFormat: string;
  uvrKeepVocal: boolean;
  uvrKeepIns: boolean;

  // ---------- 切分参数（官方 WebUI 的 8 个滑块） ----------
  slice: SovitsSliceDefaults;

  // ---------- 预训练权重（留空用整合包自带） ----------
  pretrainedGpt: string;
  pretrainedSovits: string;
  pretrainedSovitsD: string;

  plan: SovitsTrainPlan | null;
  job: SovitsJob | null;
  history: SovitsJob[];
  expandedJobId: string | null;
  jobDetails: Record<string, SovitsJob>;
  /**
   * 校对后产出的清单路径。非空时训练直接用它，并自动关掉 ASR ——
   * 否则下一轮又会被 ASR 重新写一遍，校对白做。
   */
  listFileOverride: string;
}

const INITIAL_SESSION: TrainSession = {
  name: '',
  sourceDir: '',
  textLang: 'zh',
  version: 'v2ProPlus',
  speaker: 'default',
  gpuIds: '0',
  runDenoise: false,
  runSlice: false,
  runAsr: false,
  runFormat: true,
  runS1: true,
  runS2: true,
  asrBackend: 'funasr',
  asrSize: 'large',
  asrLanguage: 'zh',
  asrPrecision: 'float16',
  epochsS1: 15,
  batchS1: 6,
  epochsS2: 8,
  batchS2: 6,
  loraRank: 32,

  runUvr: false,
  uvrModel: '',
  uvrAgg: 10,
  uvrFormat: 'flac',
  uvrKeepVocal: true,
  uvrKeepIns: false,

  // 先放官方默认值，页面加载后会用 /v1/catalog 的真实默认值覆盖一次
  slice: {
    threshold: -34,
    min_length: 4000,
    min_interval: 300,
    hop_size: 10,
    max_sil_kept: 500,
    max: 0.9,
    alpha: 0.25,
    n_parts: 1,
  },

  pretrainedGpt: '',
  pretrainedSovits: '',
  pretrainedSovitsD: '',

  plan: null,
  job: null,
  history: [],
  expandedJobId: null,
  jobDetails: {},
  listFileOverride: '',
};

const STORAGE_KEY = 'mimo-voice:train-session';

function loadSession(): TrainSession {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...INITIAL_SESSION };
    // 与默认值合并：旧版本存的数据可能缺字段，直接展开会让后续读到 undefined
    return { ...INITIAL_SESSION, ...(JSON.parse(raw) as Partial<TrainSession>) };
  } catch {
    return { ...INITIAL_SESSION };
  }
}

let saveTimer: number | undefined;

function saveSession(session: TrainSession): void {
  // 防抖：改表单时逐字符序列化整份会话会明显卡顿
  if (saveTimer !== undefined) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      // jobDetails 是历史任务的详情（含完整日志），体积不可控。
      // 不进持久化：刷新后重新拉取即可，别把配额浪费在缓存上。
      const slim: Partial<TrainSession> = { ...session };
      delete slim.jobDetails;
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(slim));
    } catch {
      // 隐私模式或配额不足时忽略：会话保留退化成「仅当前浏览器会话内」
    }
  }, 400);
}

function clearSession(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // 同上
  }
}

/** 模块作用域：组件卸载后依然存在 */
let retained: TrainSession = loadSession();

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

  // 初值一律取自 retained：切页回来时恢复成离开时的样子。
  // health / catalog / uploading / loading 等每次重新探测，不进保留区。
  const [name, setName] = useState(retained.name);
  const [sourceDir, setSourceDir] = useState(retained.sourceDir);
  const [textLang, setTextLang] = useState<'zh' | 'en' | 'ja' | 'ko' | 'yue'>(retained.textLang);
  const [version, setVersion] = useState(retained.version);
  const [speaker, setSpeaker] = useState(retained.speaker);
  const [gpuIds, setGpuIds] = useState(retained.gpuIds);

  const [runDenoise, setRunDenoise] = useState(retained.runDenoise);
  const [runSlice, setRunSlice] = useState(retained.runSlice);
  const [runAsr, setRunAsr] = useState(retained.runAsr);
  const [runFormat, setRunFormat] = useState(retained.runFormat);
  const [runS1, setRunS1] = useState(retained.runS1);
  const [runS2, setRunS2] = useState(retained.runS2);

  const [asrBackend, setAsrBackend] = useState<'funasr' | 'fasterwhisper'>(retained.asrBackend);
  const [asrSize, setAsrSize] = useState(retained.asrSize);
  const [asrLanguage, setAsrLanguage] = useState(retained.asrLanguage);
  const [asrPrecision, setAsrPrecision] = useState(retained.asrPrecision);

  /**
   * 当前后端允许的精度。
   *
   * 必须按后端钳制：官方 `tools/asr/config.py::asr_dict` 里 FunASR 只给了
   * float32，而 faster-whisper 才是 float16 / int8。
   * 不钳制就会把脚本不接受的值传下去。
   */
  const precisions = useMemo(
    () => catalog?.asr_backends?.find((item) => item.id === asrBackend)?.precisions ?? ['float16'],
    [catalog, asrBackend],
  );
  useEffect(() => {
    if (precisions.length > 0 && !precisions.includes(asrPrecision)) {
      setAsrPrecision((precisions.includes('float16') ? 'float16' : precisions[0]) as
        | 'float16'
        | 'float32'
        | 'int8');
    }
  }, [precisions, asrPrecision]);

  const [epochsS1, setEpochsS1] = useState(retained.epochsS1);
  const [batchS1, setBatchS1] = useState(retained.batchS1);
  const [epochsS2, setEpochsS2] = useState(retained.epochsS2);
  const [batchS2, setBatchS2] = useState(retained.batchS2);
  const [loraRank, setLoraRank] = useState(retained.loraRank);

  // ---------- UVR5 人声/伴奏分离 ----------
  const [runUvr, setRunUvr] = useState(retained.runUvr);
  const [uvrModel, setUvrModel] = useState(retained.uvrModel);
  const [uvrAgg, setUvrAgg] = useState(retained.uvrAgg);
  const [uvrFormat, setUvrFormat] = useState<'wav' | 'flac' | 'mp3' | 'm4a'>(
    (retained.uvrFormat as 'wav' | 'flac' | 'mp3' | 'm4a') || 'flac',
  );
  const [uvrKeepVocal, setUvrKeepVocal] = useState(retained.uvrKeepVocal);
  const [uvrKeepIns, setUvrKeepIns] = useState(retained.uvrKeepIns);
  /** 本机实际可用的模型（每次进入页面重新扫描，不进保留区） */
  const [uvrModels, setUvrModels] = useState<SovitsUvrModel[]>([]);
  const selectedUvr = uvrModels.find((item) => item.id === uvrModel) ?? null;

  // ---------- 切分参数：官方 WebUI 的 8 个滑块 ----------
  // 初值取自保留区；默认值本身与后端 catalog.SLICE_DEFAULTS 同源（都来自官方 WebUI），
  // 所以不需要再用服务端返回值覆盖一遍 —— 否则会把用户改过的参数冲掉。
  const [slice, setSlice] = useState<SovitsSliceDefaults>(retained.slice);
  const patchSlice = useCallback((part: Partial<SovitsSliceDefaults>) => {
    setSlice((prev) => ({ ...prev, ...part }));
  }, []);

  // ---------- 预训练权重覆盖（留空即用整合包自带的官方权重） ----------
  const [pretrainedGpt, setPretrainedGpt] = useState(retained.pretrainedGpt);
  const [pretrainedSovits, setPretrainedSovits] = useState(retained.pretrainedSovits);
  const [pretrainedSovitsD, setPretrainedSovitsD] = useState(retained.pretrainedSovitsD);

  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [plan, setPlan] = useState<SovitsTrainPlan | null>(retained.plan);
  const [job, setJob] = useState<SovitsJob | null>(retained.job);
  const [history, setHistory] = useState<SovitsJob[]>(retained.history);
  /** 历史任务就地展开：同一时刻只展开一条，详情按 id 缓存 */
  const [expandedJobId, setExpandedJobId] = useState<string | null>(retained.expandedJobId);
  const [jobDetails, setJobDetails] = useState<Record<string, SovitsJob>>(retained.jobDetails);
  /** 校对后要用于训练的清单（非空时训练直接用它并自动关闭 ASR） */
  const [listFileOverride, setListFileOverride] = useState(retained.listFileOverride);
  const [loadingDetailId, setLoadingDetailId] = useState<string | null>(null);

  const fileRef = useRef<HTMLInputElement | null>(null);
  const pollRef = useRef<number | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  // 把会话持续写回模块作用域。
  //
  // App 切页时本组件会被卸载，组件 state 随之消失；让 retained 始终等于当前 state，
  // 于是卸载前最后一次写入就是最新的，回来时直接用它做初值。
  useEffect(() => {
    retained = {
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
      asrBackend,
      asrSize,
      asrLanguage,
      asrPrecision,
      epochsS1,
      batchS1,
      epochsS2,
      batchS2,
      loraRank,
      runUvr,
      uvrModel,
      uvrAgg,
      uvrFormat,
      uvrKeepVocal,
      uvrKeepIns,
      slice,
      pretrainedGpt,
      pretrainedSovits,
      pretrainedSovitsD,
      plan,
      job,
      history,
      expandedJobId,
      jobDetails,
      listFileOverride,
    };
    saveSession(retained);
  }, [
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
    asrBackend,
    asrSize,
    asrLanguage,
    asrPrecision,
    epochsS1,
    batchS1,
    epochsS2,
    batchS2,
    loraRank,
    runUvr,
    uvrModel,
    uvrAgg,
    uvrFormat,
    uvrKeepVocal,
    uvrKeepIns,
    slice,
    pretrainedGpt,
    pretrainedSovits,
    pretrainedSovitsD,
    plan,
    job,
    history,
    expandedJobId,
    jobDetails,
    listFileOverride,
  ]);

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
        // 只在还没有值的时候采用服务端默认版本：
        // 直接 set 会在每次回到本页时把用户选好的版本重置掉。
        setVersion((prev) => prev || catalogResult.catalog.default_version);
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

  // UVR5 模型清单。只列磁盘上真实存在的 —— 整合包自带的模型并不固定，
  // 写死常量只会给用户一个点下去才报错的下拉框。
  useEffect(() => {
    void (async () => {
      try {
        const result = await sovitsApi.listUvrModels();
        const models = result.models ?? [];
        setUvrModels(models);
        // 用户之前选过且仍然存在就保留，否则回落到第一个可用模型
        setUvrModel((prev) =>
          prev && models.some((item) => item.id === prev)
            ? prev
            : (models.find((item) => item.available)?.id ?? ''),
        );
      } catch {
        // 拿不到就不显示这一块，不影响正常训练
        setUvrModels([]);
      }
    })();
  }, []);

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
      // 校对过的清单优先；否则走 ASR
      list_file: listFileOverride.trim() || undefined,
      text_lang: textLang,
      version,
      speaker: speaker.trim() || 'default',
      gpu_ids: gpuIds.trim() || '0',
      run_uvr: runUvr,
      run_denoise: runDenoise,
      run_slice: runSlice,
      run_asr: runAsr,
      run_format: runFormat,
      run_s1: runS1,
      run_s2: runS2,
      // 切分参数直接取界面上的 8 个滑块，不再固定用官方默认值
      slice,
      asr_backend: asrBackend,
      asr_model_size: asrSize,
      asr_language: asrLanguage,
      asr_precision: asrPrecision,

      // ---------- UVR5 ----------
      uvr_model: uvrModel,
      uvr_agg: uvrAgg,
      uvr_format: uvrFormat,
      uvr_keep_vocal: uvrKeepVocal,
      uvr_keep_ins: uvrKeepIns,

      // ---------- 预训练权重：留空即用整合包自带的官方权重 ----------
      pretrained_gpt_path: pretrainedGpt.trim() || undefined,
      pretrained_sovits_path: pretrainedSovits.trim() || undefined,
      pretrained_sovits_d_path: pretrainedSovitsD.trim() || undefined,
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
      listFileOverride,
      runUvr,
      runDenoise,
      runSlice,
      runAsr,
      runFormat,
      runS1,
      runS2,
      slice,
      asrBackend,
      asrSize,
      asrLanguage,
      asrPrecision,
      uvrModel,
      uvrAgg,
      uvrFormat,
      uvrKeepVocal,
      uvrKeepIns,
      pretrainedGpt,
      pretrainedSovits,
      pretrainedSovitsD,
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

  /** 跟踪某个训练任务直到终态。抽出来是为了「离开页面再回来」时能接着跟。 */
  const startPolling = useCallback(
    (jobId: string) => {
      stopPolling();
      setSubmitting(true);
      pollRef.current = window.setInterval(() => {
        void (async () => {
          try {
            const { job: current } = await sovitsApi.getJob(jobId);
            setJob(current);
            if (['succeeded', 'failed', 'cancelled'].includes(current.state)) {
              stopPolling();
              setSubmitting(false);
              void loadHistory();
              if (current.state === 'succeeded') {
                toast.success('训练完成', {
                  description: '训练产物已写入 GPT_weights / SoVITS_weights',
                });
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
    },
    [stopPolling, loadHistory],
  );

  // 回到本页时，若上次的训练还在服务端跑，接着轮询。
  // 训练动辄几十分钟，少了这一步界面会永远停在「训练中」，看着像卡死。
  useEffect(() => {
    const pending = retained.job;
    if (pending && (pending.state === 'running' || pending.state === 'queued')) {
      startPolling(pending.id);
    }
  }, [startPolling]);

  const handleStart = useCallback(async () => {
    if (!validate()) return;
    setSubmitting(true);
    setJob(null);
    try {
      const created = await sovitsApi.createTrain(buildPayload(false));
      toast.success('训练任务已入队', {
        description: '训练可能持续数分钟到数小时，可以随时回来看进度',
      });
      startPolling(created.job_id);
    } catch (error) {
      toast.error('提交失败', { description: (error as RequestError).message });
      setSubmitting(false);
    }
  }, [validate, buildPayload, startPolling]);

  /**
   * 丢弃本次任务与预检结果，但保留表单参数。
   *
   * 结果现在会跨页面、跨刷新保留，所以「清空」必须显式存在 ——
   * 否则上一次训练的进度会一直挂在页面上，重新提交时容易看错阶段。
   */
  const handleClearJob = useCallback(() => {
    stopPolling();
    setJob(null);
    setPlan(null);
    setSubmitting(false);
    // 持久化也要清掉，否则刷新浏览器后旧记录又回来了
    clearSession();
    toast.info('已清空本次训练记录', { description: '表单参数保留，可以直接重新提交' });
  }, [stopPolling]);

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
              <Label htmlFor="train-name">
                <TermTip term="实验名称" />
              </Label>
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
              <Label htmlFor="train-dir">
                <TermTip term="语料目录" />
              </Label>
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
              <Label>
                <TermTip term="语料语种" />
              </Label>
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
              <Label>
                <TermTip term="模型版本" />
              </Label>
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
              <Label htmlFor="train-speaker">
                <TermTip term="说话人">说话人名</TermTip>
              </Label>
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
              <Label htmlFor="train-gpu">
                <TermTip term="GPU 编号" />
              </Label>
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

          {/* ---------------- UVR5 人声分离 / 去混响 / 去延迟 ---------------- */}
          <Separator />
          <div className="space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <Label htmlFor="train-uvr" className="cursor-pointer text-sm">
                  人声分离 / 去混响（UVR5）
                </Label>
                <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
                  素材里有伴奏、混响或延迟时先开这一道。官方只给了 Gradio 版，
                  这里用我们自己的非交互封装调官方算法本体，用法与官方 WebUI 一致
                </p>
              </div>
              <Switch
                id="train-uvr"
                checked={runUvr}
                onCheckedChange={setRunUvr}
                className="mt-0.5 shrink-0"
              />
            </div>

            {runUvr ? (
              uvrModels.length === 0 ? (
                <p className="rounded-lg border border-dashed bg-muted/40 p-3 text-xs text-muted-foreground">
                  本机没有可用的 UVR5 模型。请确认整合包的 <span className="font-mono">tools/uvr5/uvr5_weights</span> 里有
                  .pth / .ckpt / onnx 权重。
                </p>
              ) : (
                <>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="min-w-0 space-y-2">
                      <Label>
                        <TermTip term="UVR5">模型</TermTip>
                      </Label>
                      <Select value={uvrModel} onValueChange={setUvrModel}>
                        <SelectTrigger>
                          <SelectValue placeholder="选择模型" />
                        </SelectTrigger>
                        <SelectContent>
                          {uvrModels.map((item) => (
                            <SelectItem key={item.id} value={item.id} disabled={!item.available}>
                              <span className="flex items-center gap-2">
                                {item.label}
                                <span className="text-xs text-muted-foreground">{item.size_mb}MB</span>
                                {item.missing_config ? (
                                  <span className="text-xs text-amber-600">缺配置</span>
                                ) : null}
                              </span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {selectedUvr?.note ? (
                        <p className="text-[11px] leading-snug text-muted-foreground">{selectedUvr.note}</p>
                      ) : null}
                      {selectedUvr?.missing_config ? (
                        <p className="text-[11px] text-amber-600 dark:text-amber-400">
                          该模型缺少同名 .yaml 配置文件，需要补齐才能加载
                        </p>
                      ) : null}
                    </div>

                    <div className="min-w-0 space-y-3">
                      <ParamSlider
                        term="激进程度"
                        label="人声提取激进程度"
                        value={uvrAgg}
                        min={0}
                        max={20}
                        step={1}
                        onChange={setUvrAgg}
                        hint="仅 HP2 / HP5 / DeEcho 这类 VR 模型生效"
                      />
                      <div className="space-y-2">
                        <Label>导出格式</Label>
                        <Select
                          value={uvrFormat}
                          onValueChange={(value) => setUvrFormat(value as typeof uvrFormat)}
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {['wav', 'flac', 'mp3', 'm4a'].map((item) => (
                              <SelectItem key={item} value={item}>
                                {item}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-4">
                    <div className="flex items-center gap-2">
                      <Switch id="uvr-vocal" checked={uvrKeepVocal} onCheckedChange={setUvrKeepVocal} />
                      <Label htmlFor="uvr-vocal" className="cursor-pointer text-xs">
                        保留人声（训练语料需要它）
                      </Label>
                    </div>
                    {selectedUvr?.dual_output ? (
                      <div className="flex items-center gap-2">
                        <Switch id="uvr-ins" checked={uvrKeepIns} onCheckedChange={setUvrKeepIns} />
                        <Label htmlFor="uvr-ins" className="cursor-pointer text-xs">
                          同时保留伴奏
                        </Label>
                      </div>
                    ) : (
                      <p className="text-[11px] text-muted-foreground">
                        去混响 / 去延迟模型只产出人声，没有伴奏轨道
                      </p>
                    )}
                  </div>
                </>
              )
            ) : null}
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
              term="语音降噪"
              label="语音降噪"
              hint="去除底噪与轻微混响（tools/cmd-denoise.py）"
              checked={runDenoise}
              onChange={setRunDenoise}
            />
            <StageToggle
              term="音频切分"
              label="音频切分"
              hint="按静音切成 5~15 秒片段；开启后必须同时开启语音识别"
              checked={runSlice}
              onChange={setRunSlice}
            />
            <StageToggle
              term="语音转文本"
              label="语音转文本"
              hint="FunASR / faster-whisper 自动生成标注与训练清单"
              checked={runAsr}
              onChange={setRunAsr}
            />
            <StageToggle
              term="格式化训练集"
              label="格式化训练集"
              hint="文本特征、HuBERT、说话人向量、语义 Token 四步"
              checked={runFormat}
              onChange={setRunFormat}
            />
            <StageToggle
              term="GPT（语义）训练"
              label="GPT（语义）训练"
              hint="s1_train.py，决定断句与韵律"
              checked={runS1}
              onChange={setRunS1}
            />
            <StageToggle
              term="SoVITS（声学）训练"
              label="SoVITS（声学）训练"
              hint="s2_train.py，决定音色相似度"
              checked={runS2}
              onChange={setRunS2}
            />
          </div>

          {runAsr ? (
            <>
              <Separator />
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div className="min-w-0 space-y-2">
                  <Label>
                    <TermTip term="ASR">识别后端</TermTip>
                  </Label>
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
                <div className="min-w-0 space-y-2">
                  <Label>
                    <TermTip term="精度" />
                  </Label>
                  <Select
                    value={asrPrecision}
                    onValueChange={(value) => setAsrPrecision(value as typeof asrPrecision)}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {precisions.map((item) => (
                        <SelectItem key={item} value={item}>
                          {item}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-[11px] text-muted-foreground">
                    {currentBackend?.precision_effective === false
                      ? '该后端官方注明精度参数还没接入，选择不会生效'
                      : '显存紧张时改 float16，要求精度时用 float32'}
                  </p>
                </div>
              </div>
            </>
          ) : null}

          {/* ---------------- 切分参数（对齐官方 WebUI 的 8 个滑块） ---------------- */}
          {runSlice ? (
            <>
              <Separator />
              <div className="space-y-3">
                <div>
                  <p className="text-sm font-medium">音频切分参数</p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    默认值取自官方 WebUI，绝大多数情况不用改。切成太碎或太长的片段时再调这里
                  </p>
                </div>
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  <ParamSlider
                    term="静音阈值"
                    label="threshold 静音阈值"
                    value={slice.threshold}
                    min={-60}
                    max={0}
                    step={1}
                    onChange={(next) => patchSlice({ threshold: next })}
                    hint="音量低于它才算静音"
                  />
                  <ParamSlider
                    term="最小长度"
                    label="min_length 最小长度"
                    value={slice.min_length}
                    min={500}
                    max={20000}
                    step={100}
                    onChange={(next) => patchSlice({ min_length: next })}
                    hint="单位毫秒，太短的段会并入后一段"
                  />
                  <ParamSlider
                    term="最短间隔"
                    label="min_interval 最短间隔"
                    value={slice.min_interval}
                    min={0}
                    max={2000}
                    step={10}
                    onChange={(next) => patchSlice({ min_interval: next })}
                  />
                  <ParamSlider
                    term="音量曲线精度"
                    label="hop_size 音量曲线精度"
                    value={slice.hop_size}
                    min={1}
                    max={50}
                    step={1}
                    onChange={(next) => patchSlice({ hop_size: next })}
                    hint="越小越精细，但计算量越大"
                  />
                  <ParamSlider
                    term="静音保留"
                    label="max_sil_kept 静音保留"
                    value={slice.max_sil_kept}
                    min={0}
                    max={3000}
                    step={10}
                    onChange={(next) => patchSlice({ max_sil_kept: next })}
                    hint="切完后每段首尾最多留多长静音"
                  />
                  <ParamSlider
                    term="归一化峰值"
                    label="max 归一化峰值"
                    value={slice.max}
                    min={0.5}
                    max={1}
                    step={0.01}
                    onChange={(next) => patchSlice({ max: next })}
                  />
                  <ParamSlider
                    term="归一化混合"
                    label="alpha 归一化混合"
                    value={slice.alpha}
                    min={0}
                    max={1}
                    step={0.01}
                    onChange={(next) => patchSlice({ alpha: next })}
                    hint="1 = 完全按峰值归一化，0 = 保持原音量"
                  />
                  <ParamSlider
                    term="切片进程数"
                    label="n_parts 切片进程数"
                    value={slice.n_parts}
                    min={1}
                    max={8}
                    step={1}
                    onChange={(next) => patchSlice({ n_parts: next })}
                    hint="官方默认 4；本地串行跑时保持 1 就不会和推理抢资源"
                  />
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
          <NumberField term="epoch" label="GPT epoch" value={epochsS1} onChange={setEpochsS1} min={1} max={1000} />
          <NumberField term="batch" label="GPT batch" value={batchS1} onChange={setBatchS1} min={1} max={64} />
          <NumberField term="epoch" label="SoVITS epoch" value={epochsS2} onChange={setEpochsS2} min={1} max={1000} />
          <NumberField term="batch" label="SoVITS batch" value={batchS2} onChange={setBatchS2} min={1} max={64} />
          <NumberField
            term="LoRA rank"
            label="LoRA rank（v3/v4）"
            value={loraRank}
            onChange={setLoraRank}
            min={1}
            max={256}
            hint="仅 v3/v4 走 LoRA 训练时生效"
          />

          {/* 预训练权重覆盖：对应官方 WebUI「预训练模型路径」那一栏。
              留空即用整合包自带的官方权重，路径不存在会在「预检计划」时就报错，不让它拖到训练中。 */}
          <div className="col-span-full space-y-2">
            <Separator />
            <p className="text-sm font-medium">预训练权重（可选）</p>
            <p className="text-[11px] text-muted-foreground">
              留空即使用整合包自带的官方权重。想基于自己训过的权重继续练，或换社区权重时填这里的绝对路径
            </p>
            <div className="grid gap-3 lg:grid-cols-3">
              <div className="space-y-1.5">
                <Label className="text-xs">
                  <TermTip term="预训练权重">GPT 权重</TermTip>
                </Label>
                <Input
                  value={pretrainedGpt}
                  onChange={(event) => setPretrainedGpt(event.target.value)}
                  placeholder="留空用官方权重"
                  spellCheck={false}
                  className="h-9 font-mono text-xs"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">
                  <TermTip term="预训练权重">SoVITS 权重</TermTip>
                </Label>
                <Input
                  value={pretrainedSovits}
                  onChange={(event) => setPretrainedSovits(event.target.value)}
                  placeholder="留空用官方权重"
                  spellCheck={false}
                  className="h-9 font-mono text-xs"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">
                  <TermTip term="判别器">SoVITS 判别器（可选）</TermTip>
                </Label>
                <Input
                  value={pretrainedSovitsD}
                  onChange={(event) => setPretrainedSovitsD(event.target.value)}
                  placeholder="留空用官方默认"
                  spellCheck={false}
                  className="h-9 font-mono text-xs"
                />
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ---------------- 操作 ---------------- */}
      <div className="flex flex-wrap items-center gap-3">
        {/* 也要挡住 running：切页回来时 submitting 已重置为 false，
            但任务可能还在跑，不挡就会再起一个训练任务去抢同一张显卡 */}
        <Button onClick={() => void handleStart()} disabled={submitting || loading || running}>
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
        {/* 任务与预检结果会跨页面、跨刷新保留，所以要给清空的入口 */}
        {job || plan ? (
          <Button variant="ghost" onClick={handleClearJob} disabled={running}>
            <XCircle className="mr-1.5 size-3.5" />
            清空
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

      {/* ---------------- 标注校对 ---------------- */}
      {/* ASR 的错字会被直接学进模型，表现为某些字读音怪异且事后极难定位。
          官方用 tools/subfix_webui.py（Gradio）做校对，集成不进来，所以界面自己承担。 */}
      {job?.artifacts?.list_file ? (
        <AnnotationPanel
          jobId={job.id}
          listFile={String(job.artifacts.list_file)}
          onApplied={() => {
            setListFileOverride(String(job.artifacts?.list_file ?? ''));
            setRunAsr(false);
            toast.success('已切到校对后的清单', {
              description: '下一轮训练会直接用它，并自动关闭「语音转文本」，避免又被 ASR 覆盖',
            });
          }}
        />
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
  term,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  /** 术语表里的键名；给了就给标题加悬浮解释 */
  term?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border p-3">
      <div className="min-w-0">
        <Label className="cursor-pointer text-sm">
          {term ? <TermTip term={term}>{label}</TermTip> : label}
        </Label>
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
  term,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  hint?: string;
  /** 术语表里的键名；给了就给标题加悬浮解释 */
  term?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{term ? <TermTip term={term}>{label}</TermTip> : label}</Label>
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
 * 日志展开状态，按任务 id 分别记忆。
 *
 * 放在模块作用域而不是组件 state：切页会卸载组件，回来时日志又收起来了，
 * 而训练过程中反复看日志是很常见的动作。
 *
 * 按 id 分开存是为了守住这里原本的设计 —— 「训练进度」的日志开关
 * 不能影响历史任务里展开的那几条。
 */
/**
 * 标注校对面板：ASR 结果的逐条试听与改写。
 *
 * 为什么必须有：**ASR 的错字会被直接学进模型** —— 表现为某些字读音怪异，
 * 而且事后极难定位是转写错了还是模型学歪了。官方用 `tools/subfix_webui.py`
 * （Gradio）做这件事，集成不进来，所以界面自己承担：左边播音频，右边改文本，
 * 改完写回清单，下一轮训练直接用它并关掉 ASR。
 */
function AnnotationPanel({
  jobId,
  listFile,
  onApplied,
}: {
  jobId: string;
  listFile: string;
  onApplied: () => void;
}) {
  const [items, setItems] = useState<SovitsAnnotationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  /** 只存改动过的条目：全量回传既浪费，也容易互相覆盖 */
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [skipped, setSkipped] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await sovitsApi.listAnnotations(jobId);
      setItems(result.items ?? []);
      setDrafts({});
      setSkipped(new Set());
      setCursor(0);
    } catch (err) {
      setError((err as RequestError).fullMessage);
    } finally {
      setLoading(false);
    }
  }, [jobId]);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = items.filter((item) => !skipped.has(item.index));
  const current = visible.length > 0 ? visible[Math.min(cursor, visible.length - 1)] : null;
  const textOf = (item: SovitsAnnotationItem) => drafts[item.index] ?? item.text;
  const dirtyCount = Object.keys(drafts).length;

  const toggleSkip = (index: number) => {
    setSkipped((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const save = useCallback(async () => {
    if (Object.keys(drafts).length === 0 && skipped.size === 0) {
      toast.info('还没有任何改动');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        items: [
          ...Object.entries(drafts).map(([index, text]) => ({
            index: Number(index),
            text,
            skip: skipped.has(Number(index)),
          })),
          // 只标记丢弃、没改文本的也要传上去，否则服务端不知道
          ...Array.from(skipped)
            .filter((index) => !(index in drafts))
            .map((index) => ({ index, text: items[index]?.text ?? '', skip: true })),
        ],
      };
      const result = await sovitsApi.saveAnnotations(jobId, payload);
      toast.success('标注已保存', {
        description: result.message || `已保存 ${result.total} 条`,
      });
      setDrafts({});
      setSkipped(new Set());
      setCursor(0);
      await load();
    } catch (err) {
      toast.error('保存失败', { description: (err as RequestError).fullMessage });
    } finally {
      setSaving(false);
    }
  }, [drafts, skipped, items, jobId, load]);

  if (error) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">标注校对</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-destructive">{error}</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <FileSpreadsheet className="size-4" />
          标注校对
          <Badge variant="secondary" className="ml-auto h-5 text-[10px] font-normal">
            {visible.length} / {items.length} 条
          </Badge>
        </CardTitle>
        <CardDescription>
          ASR 的错字会被直接学进模型。逐条听一遍、改掉错字，再点「用这份清单训练」
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            正在读取清单…
          </p>
        ) : current === null ? (
          <p className="text-xs text-muted-foreground">清单里没有可校对的条目。</p>
        ) : (
          <>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="font-mono">
                #{String(visible.indexOf(current) + 1).padStart(3, '0')}
              </span>
              <span className="truncate font-mono">{current.audio_path.split(/[\\/]/).pop()}</span>
              {!current.exists ? (
                <Badge variant="destructive" className="h-5 text-[10px]">
                  音频缺失
                </Badge>
              ) : null}
            </div>

            {current.exists ? (
              <audio
                key={current.audio_url}
                controls
                src={resolveAudioUrl(current.audio_url) ?? current.audio_url}
                className="w-full"
                preload="metadata"
              />
            ) : (
              <p className="rounded-lg border border-dashed bg-muted/40 p-3 text-xs text-muted-foreground">
                找不到这条的音频文件，建议直接标记为「丢弃」。
              </p>
            )}

            <Textarea
              value={textOf(current)}
              onChange={(event) =>
                setDrafts((prev) => ({ ...prev, [current.index]: event.target.value }))
              }
              rows={3}
              placeholder="与音频内容逐字一致的转写文本"
              className="resize-y text-sm"
            />

            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setCursor((prev) => Math.max(0, prev - 1))}
                disabled={cursor <= 0}
              >
                上一条
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setCursor((prev) => Math.min(visible.length - 1, prev + 1))}
                disabled={cursor >= visible.length - 1}
              >
                下一条
              </Button>
              <Button
                size="sm"
                variant={skipped.has(current.index) ? 'default' : 'ghost'}
                onClick={() => toggleSkip(current.index)}
                className="ml-auto"
              >
                <XCircle className="mr-1.5 size-3.5" />
                {skipped.has(current.index) ? '已标记丢弃' : '丢弃这条'}
              </Button>
            </div>
          </>
        )}

        <Separator />

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => void save()} disabled={saving || loading}>
            {saving ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : <CheckCircle2 className="mr-1.5 size-3.5" />}
            保存标注{dirtyCount > 0 ? `（${dirtyCount} 处改动）` : ''}
          </Button>
          <Button size="sm" variant="outline" onClick={onApplied} disabled={loading}>
            用这份清单训练
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void load()} disabled={loading}>
            <RefreshCw className="mr-1.5 size-3.5" />
            重新读取
          </Button>
          <p className="w-full text-[11px] text-muted-foreground">
            清单：{listFile}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

const logOpenById = new Map<string, boolean>();

/**
 * 单次任务的阶段状态、产物与日志。
 *
 * 「训练进度」卡片与「历史任务」的展开区共用这一份渲染逻辑，
 * 避免两处字段各改各的。
 */
function JobDetail({ job }: { job: SovitsJob }) {
  const [showLogs, setShowLogs] = useState(() => logOpenById.get(job.id) ?? false);
  const toggleLogs = useCallback(() => {
    setShowLogs((prev) => {
      const next = !prev;
      logOpenById.set(job.id, next);
      return next;
    });
  }, [job.id]);
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
          <Button size="sm" variant="ghost" onClick={toggleLogs}>
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

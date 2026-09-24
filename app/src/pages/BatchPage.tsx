import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileAudio,
  FileSpreadsheet,
  Loader2,
  Package,
  Play,
  RefreshCw,
  Server,
  Square,
  Upload,
  Wand2,
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
import { Textarea } from '@/components/ui/textarea';
import { TermTip } from '@/components/features/TermTip';
import { formatBytes, formatDuration } from '@/lib/audio';
import { RequestError } from '@/lib/errors';
import { SOVITS_PARAM_SPECS } from '@/lib/constants';
import { resolveAudioUrl, sovitsApi } from '@/lib/sovits';
import { cn } from '@/lib/utils';
import type { AppSettings, SovitsBatchItemResult, SovitsJob, SovitsJobState, SovitsVoice } from '@/types';

interface BatchPageProps {
  settings: AppSettings;
}

interface BatchRow {
  index: number;
  key: string | null;
  text: string;
  ok: boolean;
  filename: string | null;
  audioUrl: string | null;
  bytes: number;
  durationSec: number;
  elapsedMs: number;
  error: string | null;
  hint: string | null;
}

const POLL_INTERVAL_MS = 1_200;

/**
 * 跨页面切换保留的会话状态。
 *
 * App 按导航键**条件渲染**页面（切到别的页面时 `BatchPage` 会被卸载），
 * 所以这些状态不能只活在组件里 —— 否则用户跑完几十条、切去「音色库」
 * 确认一下参考音频，回来发现结果全没了，只能重跑一遍。
 *
 * 刻意只存元数据（文本、参数、结果清单），不碰音频二进制：
 * 音频仍在服务端的 `trainer/.data/outputs/`，URL 一直有效。
 */
interface BatchSession {
  text: string;
  voiceId: string;
  filenameTemplate: string;
  makeZip: boolean;
  continueOnError: boolean;
  splitMethod: string;
  textLang: string;
  speed: number;
  temperature: number;
  repetitionPenalty: number;
  showAdvanced: boolean;
  rows: BatchRow[];
  expanded: boolean;
  job: SovitsJob | null;
  voices: SovitsVoice[];
}

const INITIAL_SESSION: BatchSession = {
  text: '',
  voiceId: '',
  filenameTemplate: '{index:03d}-{key}',
  makeZip: true,
  continueOnError: true,
  splitMethod: 'cut5',
  textLang: '',
  speed: 1,
  temperature: 1,
  repetitionPenalty: 1.35,
  showAdvanced: false,
  rows: [],
  expanded: false,
  job: null,
  voices: [],
};

const STORAGE_KEY = 'mimo-voice:batch-session';

function loadSession(): BatchSession {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...INITIAL_SESSION };
    // 与默认值合并：旧版本存的数据可能缺字段，直接展开会让后续读到 undefined
    return { ...INITIAL_SESSION, ...(JSON.parse(raw) as Partial<BatchSession>) };
  } catch {
    return { ...INITIAL_SESSION };
  }
}

let saveTimer: number | undefined;

function saveSession(session: BatchSession): void {
  // 防抖：结果清单可能有几百条，每次输入都序列化一遍会明显卡顿。
  // 停止输入 400ms 后写一次就够了 —— 崩溃/刷新最多丢最后几百毫秒的输入。
  if (saveTimer !== undefined) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
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
let retained: BatchSession = loadSession();

/**
 * 批量合成页。
 *
 * 官方 WebUI 只能「粘贴一段 → 生成 → 下载 → 再粘贴下一段」，做有声书或素材库时
 * 这个循环会被放大成灾难。本页把它压缩成一次操作：**一份文本清单进，一批音频出**。
 *
 * 几个刻意的设计：
 *
 * - 先「解析清单」再「开始生成」：让用户在花 10 分钟跑 200 条之前，
 *   先确认条数与内容对不对；
 * - 走任务系统（`wait:false` + 轮询）：因此可以中途取消，也能看到逐条日志；
 * - 提供「试听首条」：音色选错是最常见的返工原因，先花 5 秒验证一下；
 * - 结果里区分「成功 / 失败」，失败条目保留原因与修复建议，而不是整批作废。
 */
/**
 * 界面可选的合成语种。
 *
 * 官方还有 `all_zh` 之类的「整句不切分」变体，这里只暴露常用取值 ——
 * 需要精细控制时可以在设置页填完整取值。
 */
const LANGUAGES: { id: string; label: string }[] = [
  { id: 'auto', label: '自动识别' },
  { id: 'zh', label: '中文' },
  { id: 'en', label: 'English' },
  { id: 'ja', label: '日本語' },
  { id: 'ko', label: '한국어' },
  { id: 'yue', label: '粤语' },
];
const LANG_IDS = LANGUAGES.map((item) => item.id);

/** 兜底语种：用户没选、音色语种又不可用时用它 */
const FALLBACK_LANG = 'zh';

export function BatchPage({ settings }: BatchPageProps) {
  // 初值一律取自 retained：切页回来时恢复成离开时的样子
  const [voices, setVoices] = useState<SovitsVoice[]>(retained.voices);
  const [loadingVoices, setLoadingVoices] = useState(true);
  const [connectionError, setConnectionError] = useState<string | null>(null);

  const [text, setText] = useState(retained.text);
  const [voiceId, setVoiceId] = useState(retained.voiceId);
  const [filenameTemplate, setFilenameTemplate] = useState(
    retained.filenameTemplate || settings.batchFilenameTemplate,
  );
  const [makeZip, setMakeZip] = useState(retained.makeZip);
  const [continueOnError, setContinueOnError] = useState(retained.continueOnError);
  const [splitMethod, setSplitMethod] = useState(retained.splitMethod);
  /** 空串表示「跟随音色语种」 */
  const [textLang, setTextLang] = useState(retained.textLang);
  const [speed, setSpeed] = useState(retained.speed);
  const [temperature, setTemperature] = useState(retained.temperature);
  const [repetitionPenalty, setRepetitionPenalty] = useState(retained.repetitionPenalty);
  const [showAdvanced, setShowAdvanced] = useState(retained.showAdvanced);

  const [rows, setRows] = useState<BatchRow[]>(retained.rows);
  const [expanded, setExpanded] = useState(retained.expanded);
  const [job, setJob] = useState<SovitsJob | null>(retained.job);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const pollRef = useRef<number | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // ------------------------------------------------------------------
  // 音色库
  // ------------------------------------------------------------------

  const loadVoices = useCallback(async () => {
    setLoadingVoices(true);
    try {
      const result = await sovitsApi.listVoices();
      setVoices(result.voices);
      setConnectionError(null);
      setVoiceId((prev) => prev || result.voices[0]?.id || '');
    } catch (error) {
      const requestError = error as RequestError;
      setConnectionError(requestError.fullMessage);
    } finally {
      setLoadingVoices(false);
    }
  }, []);

  useEffect(() => {
    void loadVoices();
  }, [loadVoices]);

  // 把会话持续写回模块作用域。
  //
  // App 切页时本组件会被卸载，组件 state 随之消失；这里让 retained 始终等于
  // 当前 state，于是卸载前最后一次写入就已经是最新的，回来时直接用它做初值。
  useEffect(() => {
    retained = {
      text,
      voiceId,
      filenameTemplate,
      makeZip,
      continueOnError,
      splitMethod,
      textLang,
      speed,
      temperature,
      repetitionPenalty,
      showAdvanced,
      rows,
      expanded,
      job,
      voices,
    };
    saveSession(retained);
  }, [
    text,
    voiceId,
    filenameTemplate,
    makeZip,
    continueOnError,
    splitMethod,
    textLang,
    speed,
    temperature,
    repetitionPenalty,
    showAdvanced,
    rows,
    expanded,
    job,
    voices,
  ]);

  // 清理轮询定时器，避免离开页面后仍在打请求
  useEffect(
    () => () => {
      if (pollRef.current !== null) window.clearInterval(pollRef.current);
    },
    [],
  );

  // 生成过程中的「已等待 N 秒」提示：本地推理是黑盒，能看见时间在走很重要
  useEffect(() => {
    if (!busy) return;
    setElapsed(0);
    const timer = window.setInterval(() => setElapsed((prev) => prev + 1), 1_000);
    return () => window.clearInterval(timer);
  }, [busy]);

  const lines = useMemo(
    () => text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
    [text],
  );

  const selectedVoice = voices.find((voice) => voice.id === voiceId) ?? null;

  /**
   * 实际使用的合成语种：用户选择 → 音色语种（需合法）→ zh。
   *
   * 这里刻意校验音色的语种而不是直接拿来用：历史数据里存在字面量
   * `"undefined"`（前端曾把未填的字段塞进 FormData），
   * 直接透传会让每次合成都报「不支持合成语种 undefined」。
   */
  const effectiveLang = useMemo(() => {
    if (textLang && LANG_IDS.includes(textLang)) return textLang;
    const voiceLang = selectedVoice?.prompt_lang ?? '';
    if (LANG_IDS.includes(voiceLang)) return voiceLang;
    return FALLBACK_LANG;
  }, [textLang, selectedVoice]);

  /** 参考音频语种同理：脏值宁可留空让服务端兜底，也不要透传 */
  const safePromptLang = LANG_IDS.includes(selectedVoice?.prompt_lang ?? '')
    ? selectedVoice?.prompt_lang
    : undefined;

  // ------------------------------------------------------------------
  // 文本导入
  // ------------------------------------------------------------------

  const handleImport = useCallback(
    async (file: File) => {
      try {
        const content = await file.text();
        // CSV 只取第一列有内容的部分，避免把表头与其它列一起当成正文
        const isCsv = /\.(csv|tsv)$/i.test(file.name);
        const imported = isCsv
          ? content
              .split(/\r?\n/)
              .slice(1)
              .map((line) => line.split(/[,\t]/)[0]?.trim() ?? '')
              .filter(Boolean)
          : content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        if (imported.length === 0) {
          toast.warning('这个文件里没有可用的文本');
          return;
        }
        setText((prev) => (prev.trim() ? `${prev.trim()}\n${imported.join('\n')}` : imported.join('\n')));
        toast.success('已导入文本', { description: `${imported.length} 条` });
      } catch {
        toast.error('读取文件失败');
      }
    },
    [],
  );

  // ------------------------------------------------------------------
  // 解析清单（只做校验，不合成）
  // ------------------------------------------------------------------

  const buildPayload = useCallback(
    (onlyFirstLine = false) => {
      const content = onlyFirstLine ? lines.slice(0, 1).join('\n') : lines.join('\n');
      return {
        text: content,
        voice: voiceId || undefined,
        text_lang: effectiveLang,
        prompt_lang: safePromptLang,
        filename_template: filenameTemplate || '{index:03d}',
        make_zip: makeZip,
        continue_on_error: continueOnError,
        params: {
          text_split_method: splitMethod,
          speed_factor: speed,
          temperature,
          repetition_penalty: repetitionPenalty,
        },
      };
    },
    [
      lines,
      voiceId,
      effectiveLang,
      safePromptLang,
      filenameTemplate,
      makeZip,
      continueOnError,
      splitMethod,
      speed,
      temperature,
      repetitionPenalty,
    ],
  );

  const handlePlan = useCallback(async () => {
    if (lines.length === 0) {
      toast.warning('请先输入要合成的文本');
      return;
    }
    try {
      const plan = await sovitsApi.batchPlan(buildPayload());
      toast.success('清单解析完成', {
        description: `共 ${plan.total} 条，首条：${plan.items[0]?.text?.slice(0, 24) ?? ''}…`,
      });
    } catch (error) {
      const requestError = error as RequestError;
      toast.error('解析失败', { description: requestError.fullMessage });
    }
  }, [lines.length, buildPayload]);

  // ------------------------------------------------------------------
  // 试听首条
  // ------------------------------------------------------------------

  const handlePreviewOne = useCallback(async () => {
    if (lines.length === 0) {
      toast.warning('请先输入要合成的文本');
      return;
    }
    setBusy(true);
    try {
      const result = await sovitsApi.batch({
        ...buildPayload(true),
        make_zip: false,
        wait: true,
      });
      const first = result.results?.[0];
      if (first?.ok && first.audio_url) {
        const audio = new Audio(resolveAudioUrl(first.audio_url) ?? '');
        await audio.play();
        toast.success('首条试听中', {
          description: `${first.duration_s.toFixed(1)} 秒 · 若音色不合适，先换音色再跑整批`,
        });
      } else {
        toast.error('试听失败', {
          description: first?.error
            ? `${first.error}${first.hint ? `\n${first.hint}` : ''}`
            : '服务未返回音频',
        });
      }
    } catch (error) {
      const requestError = error as RequestError;
      toast.error('试听失败', { description: requestError.fullMessage });
    } finally {
      setBusy(false);
    }
  }, [lines.length, buildPayload]);

  // ------------------------------------------------------------------
  // 批量生成
  // ------------------------------------------------------------------

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const finishFromJob = useCallback((finished: SovitsJob) => {
    const artifacts = finished.artifacts ?? {};
    const results = (artifacts.results as SovitsBatchItemResult[] | undefined) ?? [];
    setRows(
      results.map((item) => ({
        index: item.index,
        key: item.key,
        text: item.text,
        ok: item.ok,
        filename: item.filename,
        // 服务端给的是服务内相对路径（/files/...），这里补成浏览器可用的地址
        audioUrl: resolveAudioUrl(item.audio_url),
        bytes: item.bytes,
        durationSec: item.duration_s,
        elapsedMs: item.elapsed_ms,
        error: item.error,
        hint: item.hint,
      })),
    );
    if (finished.state === 'succeeded') {
      const succeeded = (artifacts.succeeded as number | undefined) ?? 0;
      const failed = (artifacts.failed as number | undefined) ?? 0;
      toast.success('批量合成完成', {
        description: `成功 ${succeeded} 条${failed ? ` · 失败 ${failed} 条` : ''}`,
      });
    } else if (finished.state === 'cancelled') {
      toast.warning('任务已取消', { description: '已生成的音频仍然可以下载' });
    } else {
      toast.error('批量合成失败', { description: finished.error ?? '未知原因' });
    }
  }, []);

  /** 跟踪某个任务直到终态。抽出来是为了「离开页面再回来」时能接着跟。 */
  const startPolling = useCallback(
    (jobId: string) => {
      stopPolling();
      setBusy(true);
      pollRef.current = window.setInterval(() => {
        void (async () => {
          try {
            const { job: current } = await sovitsApi.getJob(jobId);
            setJob(current);
            if (['succeeded', 'failed', 'cancelled'].includes(current.state)) {
              stopPolling();
              setBusy(false);
              // 终态时重新拉一次完整数据（含逐条结果与日志）
              const full = await sovitsApi.getJob(jobId);
              finishFromJob(full.job);
            }
          } catch {
            stopPolling();
            setBusy(false);
            toast.error('轮询任务状态失败，请到「任务」中查看结果');
          }
        })();
      }, POLL_INTERVAL_MS);
    },
    [stopPolling, finishFromJob],
  );

  // 回到本页时，若上次的任务还在服务端跑，接着轮询。
  // 少了这一步，界面会永远停在「进行中」，用户会以为卡死。
  useEffect(() => {
    const pending = retained.job;
    if (pending && (pending.state === 'running' || pending.state === 'queued')) {
      startPolling(pending.id);
    }
  }, [startPolling]);

  const handleStart = useCallback(async () => {
    if (lines.length === 0) {
      toast.warning('请先输入要合成的文本');
      return;
    }
    if (!voiceId) {
      toast.warning('请先选择音色', {
        description: 'GPT-SoVITS 没有内置音色，需要先在「音色库」导入参考音频',
      });
      return;
    }

    setBusy(true);
    setRows([]);
    setJob(null);
    try {
      const created = await sovitsApi.batch({ ...buildPayload(), wait: false });
      const jobId = created.job_id;
      if (!jobId) {
        toast.error('服务未返回任务编号');
        setBusy(false);
        return;
      }
      toast.info('已提交批量任务', { description: `${lines.length} 条文本正在串行合成` });
      startPolling(jobId);
    } catch (error) {
      const requestError = error as RequestError;
      toast.error('提交失败', {
        description: requestError.fullMessage,
      });
      setBusy(false);
    }
  }, [lines.length, voiceId, buildPayload, startPolling]);

  /**
   * 丢弃本次结果，但保留文本清单与参数。
   *
   * 结果现在会跨页面、跨刷新保留，所以「清空」必须显式存在 ——
   * 否则上一次的几十条会一直挂在页面上，用户想重跑时反而分不清哪批是新的。
   */
  const handleClearResults = useCallback(() => {
    stopPolling();
    setRows([]);
    setJob(null);
    setBusy(false);
    // 持久化也要清掉，否则刷新浏览器后旧结果又回来了，「清空」等于没生效
    clearSession();
    toast.info('已清空本次结果', { description: '文本清单与参数保留，可以直接重新生成' });
  }, [stopPolling]);

  const handleCancel = useCallback(async () => {
    if (!job?.id) return;
    try {
      await sovitsApi.cancelJob(job.id);
      toast.info('已请求取消，正在等待当前条结束');
    } catch (error) {
      toast.error('取消失败', { description: (error as RequestError).fullMessage });
    }
  }, [job?.id]);

  // ------------------------------------------------------------------
  // 下载
  // ------------------------------------------------------------------

  const downloadFrom = useCallback((url: string, filename?: string) => {
    const href = resolveAudioUrl(url) ?? url;
    if (!filename) {
      window.open(href, '_blank');
      return;
    }
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  }, []);

  const stats = useMemo(() => {
    const succeeded = rows.filter((row) => row.ok);
    const failed = rows.filter((row) => !row.ok);
    const duration = succeeded.reduce((sum, row) => sum + row.durationSec, 0);
    return { succeeded, failed, duration };
  }, [rows]);

  const zipUrl = typeof job?.artifacts?.zip_url === 'string' ? (job.artifacts.zip_url as string) : null;
  const manifestUrl =
    typeof job?.artifacts?.manifest_url === 'string' ? (job.artifacts.manifest_url as string) : null;

  // ------------------------------------------------------------------
  // 渲染
  // ------------------------------------------------------------------

  if (connectionError) {
    return (
      <Alert variant="destructive">
        <Server className="size-4" />
        <AlertTitle>GPT-SoVITS 本地服务不可用</AlertTitle>
        <AlertDescription className="space-y-2">
          <p>{connectionError}</p>
          <p className="text-xs opacity-90">
            本地服务由项目内置的 Python 进程提供（默认 http://127.0.0.1:9881）。请确认已执行
            `npm run dev`（会自动拉起），或单独运行 scripts/start.ps1 / start.sh。
          </p>
          <Button size="sm" variant="outline" onClick={() => void loadVoices()}>
            <RefreshCw className="mr-1.5 size-3.5" />
            重新检测
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-5">
      {/* ---------------- 音色与文本 ---------------- */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <FileAudio className="size-4" />
            文本清单
          </CardTitle>
          <CardDescription>
            每行一条，空行自动忽略。也可以在「音色库」批量整理好素材后，直接把台词表粘贴进来。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="batch-text">待合成文本</Label>
                <Badge variant="secondary" className="font-mono text-[11px]">
                  {lines.length} 条 · {text.length} 字
                </Badge>
              </div>
              <Textarea
                id="batch-text"
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder={'第一句台词\n第二句台词\n第三句台词\n…'}
                className="min-h-[220px] resize-y font-mono text-sm leading-relaxed"
              />
              <div className="flex flex-wrap items-center gap-2">
                <input
                  ref={fileRef}
                  type="file"
                  accept=".txt,.csv,.tsv,text/plain,text/csv"
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void handleImport(file);
                    event.target.value = '';
                  }}
                />
                <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()}>
                  <Upload className="mr-1.5 size-3.5" />
                  导入 txt / csv
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setText('')} disabled={!text}>
                  清空
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void handlePlan()} disabled={lines.length === 0}>
                  <Wand2 className="mr-1.5 size-3.5" />
                  解析清单
                </Button>
              </div>
            </div>

            <div className="space-y-4">
              <div className="space-y-2">
                <Label>
                  <TermTip term="参考音色" />
                </Label>
                <Select value={voiceId} onValueChange={setVoiceId} disabled={loadingVoices}>
                  <SelectTrigger>
                    <SelectValue placeholder={loadingVoices ? '正在加载音色库…' : '请选择音色'} />
                  </SelectTrigger>
                  <SelectContent>
                    {voices.map((voice) => (
                      <SelectItem key={voice.id} value={voice.id}>
                        <span className="flex items-center gap-2">
                          {voice.name}
                          {voice.duration_s ? (
                            <span className="text-xs text-muted-foreground">{voice.duration_s.toFixed(1)}s</span>
                          ) : null}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {voices.length === 0 && !loadingVoices ? (
                  <p className="text-xs text-amber-600 dark:text-amber-400">
                    音色库为空。GPT-SoVITS 没有内置音色，请先到「音色库」导入一段 3~10 秒的参考音频。
                  </p>
                ) : null}
                {selectedVoice?.warnings?.length ? (
                  <p className="text-xs text-amber-600 dark:text-amber-400">
                    {selectedVoice.warnings[0]}
                  </p>
                ) : null}
              </div>

              <div className="space-y-2">
                <Label>
                  <TermTip term="合成语种" />
                </Label>
                <Select
                  value={textLang || 'follow'}
                  onValueChange={(value) => setTextLang(value === 'follow' ? '' : value)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="follow">跟随音色（{effectiveLang}）</SelectItem>
                    {LANGUAGES.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-muted-foreground">
                  默认跟随音色的语种；改成别的可以做跨语言合成 —— 例如用中文音色去读日语文本。
                </p>
              </div>

              <Separator />

              <div className="space-y-2">
                <Label>
                <TermTip term="文件名模板" />
              </Label>
                <Input
                  value={filenameTemplate}
                  onChange={(event) => setFilenameTemplate(event.target.value)}
                  placeholder="{index:03d}-{key}"
                />
                <p className="text-[11px] text-muted-foreground">
                  可用变量：{'{index}'}（序号）、{'{key}'}（条目 key）、{'{text}'}（文本前 20 字）
                </p>
              </div>

              <div className="flex items-center justify-between">
                <Label htmlFor="batch-zip" className="cursor-pointer text-sm">
                  打包为 ZIP
                </Label>
                <Switch id="batch-zip" checked={makeZip} onCheckedChange={setMakeZip} />
              </div>
              <div className="flex items-center justify-between">
                <Label htmlFor="batch-continue" className="cursor-pointer text-sm">
                  单条失败时继续
                </Label>
                <Switch id="batch-continue" checked={continueOnError} onCheckedChange={setContinueOnError} />
              </div>
            </div>
          </div>

          <Separator />

          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => void handleStart()} disabled={busy || lines.length === 0 || !voiceId}>
              {busy ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : <Play className="mr-1.5 size-4" />}
              {busy ? `合成中… 已等待 ${elapsed}s` : `开始批量合成（${lines.length} 条）`}
            </Button>
            <Button variant="outline" onClick={() => void handlePreviewOne()} disabled={busy || lines.length === 0 || !voiceId}>
              试听首条
            </Button>
            {busy ? (
              <Button variant="ghost" onClick={() => void handleCancel()}>
                <Square className="mr-1.5 size-3.5" />
                取消
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto"
              onClick={() => setShowAdvanced((prev) => !prev)}
            >
              {showAdvanced ? '收起高级参数' : '高级参数'}
            </Button>
          </div>

          {showAdvanced ? (
            <div className="grid gap-4 rounded-lg border bg-muted/30 p-4 sm:grid-cols-2 lg:grid-cols-4">
              <div className="space-y-1.5">
                <Label className="text-xs">
                      <TermTip term="切分方式">文本切分方式</TermTip>
                    </Label>
                <Select value={splitMethod} onValueChange={setSplitMethod}>
                  <SelectTrigger className="h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cut5">cut5 · 逗号级（长文本推荐）</SelectItem>
                    <SelectItem value="cut4">cut4 · 强标点</SelectItem>
                    <SelectItem value="cut3">cut3 · 英文句点</SelectItem>
                    <SelectItem value="cut2">cut2 · 标点 + 换行</SelectItem>
                    <SelectItem value="cut1">cut1 · 仅换行</SelectItem>
                    <SelectItem value="cut0">cut0 · 不切分</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {SOVITS_PARAM_SPECS.filter((spec) =>
                ['speed_factor', 'temperature', 'repetition_penalty'].includes(spec.key),
              ).map((spec) => {
                const value =
                  spec.key === 'speed_factor' ? speed : spec.key === 'temperature' ? temperature : repetitionPenalty;
                const setter =
                  spec.key === 'speed_factor' ? setSpeed : spec.key === 'temperature' ? setTemperature : setRepetitionPenalty;
                return (
                  <div key={spec.key} className="space-y-1.5">
                    <Label className="text-xs" title={spec.hint}>
                      {spec.label}
                    </Label>
                    <Input
                      type="number"
                      className="h-9"
                      value={value}
                      min={spec.min}
                      max={spec.max}
                      step={spec.step}
                      onChange={(event) => {
                        const next = Number(event.target.value);
                        if (Number.isFinite(next)) setter(next);
                      }}
                    />
                    <p className="text-[11px] leading-snug text-muted-foreground">{spec.hint}</p>
                  </div>
                );
              })}
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* ---------------- 进度 ---------------- */}
      {job ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              {job.state === 'running' || job.state === 'queued' ? (
                <Loader2 className="size-4 animate-spin" />
              ) : job.state === 'succeeded' ? (
                <CheckCircle2 className="size-4 text-emerald-500" />
              ) : (
                <XCircle className="size-4 text-destructive" />
              )}
              任务进度
              <Badge variant="outline" className="ml-auto font-mono text-[11px]">
                {stateLabel(job.state)}
              </Badge>
            </CardTitle>
            <CardDescription>{job.message || '等待调度'}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Progress value={Math.round(job.progress * 100)} />
            <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
              <span>进度 {Math.round(job.progress * 100)}%</span>
              <span>已耗时 {(job.elapsed_ms / 1000).toFixed(1)}s</span>
              {job.logs?.length ? <span>日志 {job.log_count ?? job.logs.length} 行</span> : null}
            </div>
            {expanded && job.logs?.length ? (
              <pre className="scrollbar-thin max-h-64 overflow-auto rounded-md bg-muted/50 p-3 text-[11px] leading-relaxed">
                {job.logs.slice(-60).map((line) => `[${line.level}] ${line.text}`).join('\n')}
              </pre>
            ) : null}
            {job.logs?.length ? (
              <Button size="sm" variant="ghost" onClick={() => setExpanded((prev) => !prev)}>
                {expanded ? '收起日志' : '查看日志'}
              </Button>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {/* ---------------- 结果 ---------------- */}
      {rows.length > 0 ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <FileSpreadsheet className="size-4" />
              合成结果
            </CardTitle>
            <CardDescription>
              成功 {stats.succeeded.length} 条 · 失败 {stats.failed.length} 条 · 总时长{' '}
              {formatDuration(stats.duration)}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-2">
              {zipUrl ? (
                <Button size="sm" onClick={() => downloadFrom(zipUrl)}>
                  <Package className="mr-1.5 size-3.5" />
                  下载 ZIP（含音频 + 清单）
                </Button>
              ) : null}
              {manifestUrl ? (
                <Button size="sm" variant="outline" onClick={() => downloadFrom(manifestUrl)}>
                  <Download className="mr-1.5 size-3.5" />
                  JSON 清单
                </Button>
              ) : null}
              {/* 结果会跨页面与刷新保留，所以必须给出清空的入口，
                  否则上一次的几十条会一直挂在页面上 */}
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto"
                onClick={handleClearResults}
                disabled={busy}
              >
                <XCircle className="mr-1.5 size-3.5" />
                清空结果
              </Button>
            </div>

            <div className="space-y-2">
              {rows.map((row) => (
                <div
                  key={`${row.index}-${row.filename ?? 'failed'}`}
                  className={cn(
                    'flex flex-wrap items-center gap-3 rounded-lg border p-3 text-sm',
                    row.ok ? 'bg-card' : 'border-destructive/40 bg-destructive/5',
                  )}
                >
                  <span className="w-10 shrink-0 font-mono text-xs text-muted-foreground">
                    #{String(row.index + 1).padStart(3, '0')}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate">{row.text}</p>
                    {row.ok ? (
                      <p className="mt-0.5 text-[11px] text-muted-foreground">
                        {row.filename} · {formatDuration(row.durationSec)} · {formatBytes(row.bytes)}
                      </p>
                    ) : (
                      <p className="mt-0.5 text-[11px] text-destructive">
                        {row.error}
                        {row.hint ? <span className="ml-1 opacity-80">（{row.hint}）</span> : null}
                      </p>
                    )}
                  </div>
                  {row.ok && row.audioUrl ? (
                    <div className="flex items-center gap-2">
                      <audio controls preload="none" src={row.audioUrl} className="h-8 max-w-[220px]" />
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => downloadFrom(row.audioUrl as string, row.filename ?? undefined)}
                      >
                        <Download className="size-3.5" />
                      </Button>
                    </div>
                  ) : (
                    <AlertTriangle className="size-4 text-destructive" />
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function stateLabel(state: SovitsJobState): string {
  switch (state) {
    case 'queued':
      return '排队中';
    case 'running':
      return '执行中';
    case 'succeeded':
      return '已完成';
    case 'cancelled':
      return '已取消';
    default:
      return '失败';
  }
}

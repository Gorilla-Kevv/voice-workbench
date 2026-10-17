import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  CheckCircle2,
  Database,
  FlaskConical,
  Loader2,
  Sparkles,
  Upload,
  Waves,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { ErrorAlert } from '@/components/features/ErrorAlert';
import { ResourceBudget } from '@/components/features/ResourceBudget';
import { IrodoriJobPanel } from '@/components/features/IrodoriJobPanel';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { RequestError } from '@/lib/errors';
import { focusBeforeRun } from '@/lib/arbiter';
import { irodoriApi } from '@/lib/irodori';
import { voiceApi } from '@/lib/voices';
import { cn } from '@/lib/utils';
import type {
  IrodoriDataset,
  IrodoriJob,
  IrodoriTrainArtifacts,
  IrodoriTrainPlan,
  IrodoriTrainPlanPayload,
} from '@/types';
import type { SovitsVoice } from '@/types';

/** 语料来源：音色库（长参考）/ 上传目录 / 已整备好的数据集 */
type DataSource = 'voice' | 'upload' | 'dataset';

const STEP_STATE_TEXT: Record<string, string> = {
  ready: '可开始',
  blocked: '被挡住',
  todo: '待办',
};

/**
 * Irodori 音色固化训练（SI）：三步向导 —— 数据 → 整备（S1+S2）→ 训练（S3）。
 *
 * 为什么是「向导」而不是一张大表单：这三步的**前置关系是真的** ——
 * 没整备好就没有数据集，没有数据集就训不了。把它们平铺在一屏里，
 * 用户会先看到一堆不可用的按钮，然后不知道该先点哪个。
 *
 * ⚠️ 训练独占显卡：跑起来之后合成请求一律 409（服务端 busy 锁），
 * 这是刻意的 —— 8GB 卡上「边训边合成」只会两边都崩。
 */
export function IrodoriTrainingPage({ onGoSynth }: { onGoSynth?: () => void }) {
  const [source, setSource] = useState<DataSource>('dataset');
  const [voices, setVoices] = useState<SovitsVoice[]>([]);
  const [voiceId, setVoiceId] = useState('');
  const [datasets, setDatasets] = useState<IrodoriDataset[]>([]);
  const [datasetId, setDatasetId] = useState('');
  const [uploadId, setUploadId] = useState('');
  const [files, setFiles] = useState<File[]>([]);

  const [plan, setPlan] = useState<IrodoriTrainPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [uploading, setUploading] = useState(false);

  const [prepareJobId, setPrepareJobId] = useState<string | null>(null);
  const [trainJobId, setTrainJobId] = useState<string | null>(null);
  const [trainedSpeaker, setTrainedSpeaker] = useState<string | null>(null);

  const [steps, setSteps] = useState<number | null>(null);
  const [batchMode, setBatchMode] = useState<'auto' | 'manual'>('auto');
  const [batch, setBatch] = useState(2);

  const [error, setError] = useState<RequestError | null>(null);

  const refreshDatasets = useCallback(async () => {
    try {
      const response = await irodoriApi.datasets();
      setDatasets(response.datasets ?? []);
    } catch {
      // 服务没起时列表为空即可，状态由 plan 的错误条说明
    }
  }, []);

  useEffect(() => {
    void refreshDatasets();
    void (async () => {
      const result = await voiceApi.listVoices().catch(() => null);
      if (result) setVoices(result.voices ?? []);
    })();
  }, [refreshDatasets]);

  const effectiveSteps = steps ?? plan?.training.smoke_steps ?? 400;

  /** 当前来源对应的 plan 请求体（三选一，服务端会拒绝多来源） */
  const planPayload = useMemo<IrodoriTrainPlanPayload>(() => {
    if (source === 'voice') return { voice_id: voiceId };
    if (source === 'upload') return { dataset_id: uploadId };
    return { dataset_id: datasetId };
  }, [source, voiceId, uploadId, datasetId]);

  const normalize = (raw: unknown): RequestError =>
    raw instanceof RequestError
      ? raw
      : new RequestError(0, {
          code: 'REQUEST_FAILED',
          message: (raw as Error)?.message || '请求失败',
          retryable: true,
          hint: '确认 Irodori 服务已启动（设置 → 本地服务，或 npm run dev:irodori）。',
        });

  const runPlan = useCallback(async () => {
    setPlanning(true);
    setError(null);
    try {
      setPlan(await irodoriApi.trainPlan(planPayload));
    } catch (rawError) {
      setError(normalize(rawError));
    } finally {
      setPlanning(false);
    }
  }, [planPayload]);

  // 来源切换后自动体检一次：用户换了数据就该立刻看到「认对了没有」
  useEffect(() => {
    const usable =
      (source === 'voice' && voiceId) || (source === 'upload' && uploadId) || (source === 'dataset' && datasetId);
    if (!usable) {
      setPlan(null);
      return;
    }
    void runPlan();
  }, [source, voiceId, uploadId, datasetId, runPlan]);

  const upload = async () => {
    if (files.length === 0) {
      setError(
        new RequestError(400, {
          code: 'NO_FILES',
          message: '还没选文件',
          retryable: false,
          hint: '选一批日语短句 wav，配同名 .txt 写转写（也可以整包 zip）。',
        }),
      );
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const result = await irodoriApi.trainUpload(files, uploadId);
      setUploadId(result.dataset_id);
      toast.success(`已上传 ${result.saved.length} 个文件`, {
        description: `dataset_id=${result.dataset_id}；转写用同名 .txt 或 metadata.jsonl。`,
      });
      setPlan(await irodoriApi.trainPlan({ dataset_id: result.dataset_id }));
      void refreshDatasets();
    } catch (rawError) {
      setError(normalize(rawError));
    } finally {
      setUploading(false);
    }
  };

  const startPrepare = async () => {
    setError(null);
    setTrainedSpeaker(null);
    try {
      // 整备要编 latent，先让本系统内其它服务的常驻模型让位（irodori 自己的推理模型由服务端入队前卸载）
      void focusBeforeRun('irodori-tts', 3600);
      const response = await irodoriApi.trainPrepare(planPayload);
      setPrepareJobId(response.job.id);
      toast.info('数据整备已入队', { description: '它会先卸载常驻模型，再把音频编成 latent。' });
    } catch (rawError) {
      setError(normalize(rawError));
    }
  };

  const onPrepareDone = useCallback(
    (job: IrodoriJob) => {
      if (job.state !== 'succeeded') return;
      void refreshDatasets();
      const artifacts = job.artifacts as { dataset_id?: string };
      if (artifacts?.dataset_id) {
        setDatasetId(artifacts.dataset_id);
        setSource('dataset');
      }
      toast.success('数据整备完成', { description: job.message || `dataset_id=${artifacts?.dataset_id ?? ''}` });
    },
    [refreshDatasets],
  );

  const startTrain = async () => {
    if (!datasetId) {
      setError(
        new RequestError(400, {
          code: 'NO_DATASET',
          message: '先选一个已整备好的数据集',
          retryable: false,
          hint: '上面「已整备的数据集」里挑一个；没有就先跑整备。',
        }),
      );
      return;
    }
    setError(null);
    setTrainedSpeaker(null);
    try {
      // 训练是小时级长任务，仲裁持有期给 6 小时（对齐 GPT-SoVITS 训练页），过期前任务早已收尾
      void focusBeforeRun('irodori-training', 6 * 3600);
      const response = await irodoriApi.train({
        dataset_id: datasetId,
        steps: effectiveSteps,
        // auto = 交给服务端探测（真跑两步量显存）；manual = 用户手动降档
        ...(batchMode === 'manual' ? { batch } : {}),
      });
      setTrainJobId(response.job.id);
      toast.info('训练已入队', {
        description: `${effectiveSteps} 步 · ${batchMode === 'manual' ? `batch ${batch}` : '自动 batch'}；期间合成会返回 409。`,
      });
    } catch (rawError) {
      setError(normalize(rawError));
    }
  };

  const onTrainDone = useCallback((job: IrodoriJob) => {
    if (job.state !== 'succeeded') return;
    const artifacts = job.artifacts as IrodoriTrainArtifacts;
    const speaker = artifacts?.speaker?.speaker_id;
    if (speaker) {
      setTrainedSpeaker(speaker);
      toast.success('音色固化完成', {
        description: `speaker_id=${speaker}；到「日语 · 合成」页选它即可，不用再给参考音频。`,
      });
    }
    void irodoriApi.datasets().then((response) => setDatasets(response.datasets ?? [])).catch(() => null);
  }, []);

  const training = plan?.training;

  return (
    <div className="grid gap-5 lg:grid-cols-5">
      <div className="space-y-5 lg:col-span-3">
        <ResourceBudget task="irodori-training" irodoriLoaded={false} />

        <ErrorAlert error={error} onDismiss={() => setError(null)} />

        {/* 第一步：数据 */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Database className="size-4 text-violet-600 dark:text-violet-400" />
              第一步 · 语料（同一个说话人，≥10 条短句更稳）
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Tabs value={source} onValueChange={(value) => setSource(value as DataSource)}>
              <TabsList className="grid w-full grid-cols-3">
                <TabsTrigger value="dataset">已整备数据集</TabsTrigger>
                <TabsTrigger value="upload">上传语料</TabsTrigger>
                <TabsTrigger value="voice">音色库长参考</TabsTrigger>
              </TabsList>
            </Tabs>

            {source === 'dataset' ? (
              datasets.length > 0 ? (
                <Select value={datasetId} onValueChange={setDatasetId}>
                  <SelectTrigger className="h-9">
                    <SelectValue placeholder="选择数据集" />
                  </SelectTrigger>
                  <SelectContent>
                    {datasets.map((item) => (
                      <SelectItem key={item.dataset_id} value={item.dataset_id}>
                        {item.dataset_id}
                        {item.written ? ` · ${item.written} 条` : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <p className="text-xs text-muted-foreground">还没有整备好的数据集：先上传语料再整备。</p>
              )
            ) : null}

            {source === 'voice' ? (
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

            {source === 'upload' ? (
              <div className="space-y-3">
                <div className="space-y-2">
                  <Label>dataset_id（留空自动生成）</Label>
                  <input
                    value={uploadId}
                    onChange={(event) => setUploadId(event.target.value)}
                    placeholder="my-ja-corpus"
                    className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                  />
                </div>
                <div className="space-y-2">
                  <Label>音频（可含 .zip；转写用同名 .txt 或 metadata.jsonl）</Label>
                  <input
                    type="file"
                    multiple
                    accept=".wav,.mp3,.flac,.ogg,.m4a,.zip,.txt,.jsonl,.json"
                    onChange={(event) => setFiles(Array.from(event.target.files ?? []))}
                    className="w-full text-xs file:mr-2 file:rounded-md file:border file:px-2 file:py-1 file:text-xs"
                  />
                  {files.length > 0 ? (
                    <p className="text-[11px] text-muted-foreground">已选 {files.length} 个文件</p>
                  ) : null}
                </div>
                <Button variant="outline" className="w-full" disabled={uploading} onClick={() => void upload()}>
                  {uploading ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
                  上传语料
                </Button>
              </div>
            ) : null}

            <Button variant="ghost" size="sm" className="h-7 text-xs" disabled={planning} onClick={() => void runPlan()}>
              {planning ? <Loader2 className="size-3 animate-spin" /> : null}
              重新体检
            </Button>

            {/* 计划：只体检不执行，数据问题在这里就暴露，不用等排队 */}
            {plan ? (
              <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
                <ol className="space-y-1.5">
                  {plan.steps.map((step) => (
                    <li key={step.key} className="flex items-start gap-2 text-xs">
                      <span
                        className={cn(
                          'mt-[3px] size-2 shrink-0 rounded-full',
                          step.state === 'ready' ? 'bg-emerald-500' : 'bg-amber-500',
                        )}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="font-medium">
                          {step.label}
                          <span className="ml-2 font-normal text-muted-foreground">
                            {STEP_STATE_TEXT[step.state] ?? step.state}
                          </span>
                        </span>
                        <span className="block text-muted-foreground">{step.detail}</span>
                      </span>
                    </li>
                  ))}
                </ol>
                {plan.warnings.length > 0 ? (
                  <ul className="space-y-1 text-[11px] text-amber-700 dark:text-amber-300">
                    {plan.warnings.map((tip) => (
                      <li key={tip}>· {tip}</li>
                    ))}
                  </ul>
                ) : null}
                <Button
                  className="w-full"
                  disabled={!plan.ready_to_prepare || prepareJobId !== null}
                  onClick={() => void startPrepare()}
                >
                  <ArrowRight className="size-4" />
                  第二步 · 开始整备（{plan.data.count} 条 / {plan.data.total_seconds.toFixed(1)}s）
                </Button>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">选好来源后会自动体检（不跑任何编码，只是看一眼）。</p>
            )}

            <IrodoriJobPanel
              jobId={prepareJobId}
              onComplete={onPrepareDone}
              title="数据整备"
              accent="text-violet-500"
            />
          </CardContent>
        </Card>

        {/* 第三步：训练 */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <FlaskConical className="size-4 text-violet-600 dark:text-violet-400" />
              第三步 · Speaker Inversion 训练
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>步数（冒烟小档 {training?.smoke_steps ?? 400} 步）</Label>
                <Select value={String(effectiveSteps)} onValueChange={(value) => setSteps(Number(value))}>
                  <SelectTrigger className="h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(training?.smoke_steps ? [training.smoke_steps, 1000, 2000, 3000] : [400, 1000, 2000, 3000]).map(
                      (value) => (
                        <SelectItem key={value} value={String(value)}>
                          {value} 步
                        </SelectItem>
                      ),
                    )}
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-muted-foreground">
                  服务端实测约 {training?.seconds_per_step ?? 2.2} s/步（估时偏保守），
                  实际进度看下面的任务面板。
                </p>
              </div>

              <div className="space-y-2">
                <Label>batch</Label>
                <Tabs value={batchMode} onValueChange={(value) => setBatchMode(value as 'auto' | 'manual')}>
                  <TabsList className="grid w-full grid-cols-2">
                    <TabsTrigger value="auto">自动探测</TabsTrigger>
                    <TabsTrigger value="manual">手动指定</TabsTrigger>
                  </TabsList>
                </Tabs>
                {batchMode === 'manual' ? (
                  <Select value={String(batch)} onValueChange={(value) => setBatch(Number(value))}>
                    <SelectTrigger className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {[1, 2, 4, 6, 8]
                        .filter((value) => value <= (training?.max_batch ?? 8))
                        .map((value) => (
                          <SelectItem key={value} value={String(value)}>
                            batch {value}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <p className="text-[11px] text-muted-foreground">
                    开训前真跑两步量显存再定（现在估 {training?.batch.batch ?? '—'}，
                    来源 {training?.batch.source ?? '—'}）。显存紧张时改「手动指定」降档。
                  </p>
                )}
              </div>
            </div>

            <Button className="w-full" disabled={!datasetId || trainJobId !== null} onClick={() => void startTrain()}>
              <Sparkles className="size-4" />
              开始训练（{effectiveSteps} 步）
            </Button>

            {!datasetId ? (
              <p className="text-[11px] text-muted-foreground">先在第一步选一个已整备好的数据集。</p>
            ) : null}

            <IrodoriJobPanel jobId={trainJobId} onComplete={onTrainDone} title="SI 训练" accent="text-violet-500" />

            {trainedSpeaker ? (
              <div className="space-y-2 rounded-lg border border-emerald-500/40 bg-emerald-500/[0.04] p-3">
                <p className="flex items-center gap-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-300">
                  <CheckCircle2 className="size-4" />
                  固化音色：{trainedSpeaker}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  到「日语 · 合成」页的「参考音色」里选「固化音色 → {trainedSpeaker}」即可，
                  不用再给参考音频。
                </p>
                {onGoSynth ? (
                  <Button variant="outline" size="sm" className="h-7 text-xs" onClick={onGoSynth}>
                    <Waves className="size-3.5" />
                    去合成页试试
                  </Button>
                ) : null}
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>

      <div className="space-y-5 lg:col-span-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">已整备的数据集</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {datasets.length === 0 ? (
              <p className="py-4 text-center text-xs text-muted-foreground">还没有数据集。</p>
            ) : (
              <ul className="space-y-1.5">
                {datasets.map((item) => (
                  <li key={item.dataset_id}>
                    <button
                      type="button"
                      onClick={() => {
                        setSource('dataset');
                        setDatasetId(item.dataset_id);
                      }}
                      className={cn(
                        'w-full rounded-lg border px-2.5 py-2 text-left text-xs transition-colors hover:bg-accent',
                        datasetId === item.dataset_id ? 'border-violet-500/50 bg-violet-500/[0.04]' : '',
                      )}
                    >
                      <span className="font-medium">{item.dataset_id}</span>
                      <span className="ml-2 text-muted-foreground">
                        {item.written ?? '?'} 条
                        {item.total_seconds ? ` · ${item.total_seconds.toFixed(1)}s` : ''}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => void refreshDatasets()}>
              刷新列表
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">这一步要注意什么</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-[11px] leading-relaxed text-muted-foreground">
            <p>
              · SI 训练只学音色：语料必须是同一个说话人，转写要与音频逐字对应
              （官方建议 ≥10 条短句，条数太少会把韵律一起固化进去）。
            </p>
            <p>· 训练独占显卡：期间合成请求会返回 409，等它跑完再合成。</p>
            <p>
              · 产物落在服务端的 speakers 目录（{`<data_dir>/speakers/<speaker_id>.speaker.safetensors`}），
              给了 voice_id 会顺带登记进音色库的 speaker_embeds。
            </p>
            <p>· 8GB 卡上桌面占太多显存时会直接 503 —— 先把浏览器硬件加速 / 模拟器之类关掉再跑。</p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

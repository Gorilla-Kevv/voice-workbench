import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Music2, Scissors, Upload, Waves } from 'lucide-react';
import { toast } from 'sonner';
import { RequestError } from '@/lib/errors';
import { ABPlayer } from '@/components/features/ABPlayer';
import { JobPanel } from '@/components/features/JobPanel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { TermTip } from '@/components/features/TermTip';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { ResourceBudget } from '@/components/features/ResourceBudget';
import { SourceNote } from '@/components/features/SourceNote';
import { SovitsServiceNotice } from '@/components/features/SovitsServiceNotice';
import { focusBeforeRun } from '@/lib/arbiter';
import { ResultStack, type ResultStackEntry } from '@/components/features/ResultStack';
import { RunResultCard } from '@/components/features/RunResultCard';
import { useResultStack } from '@/hooks/useResultStack';
import { notifyVcRunChanged } from '@/hooks/useVcRunHistory';
import { dropHighlight, applyFilesToInput, useFileDrop } from '@/hooks/useFileDrop';
import { cn } from '@/lib/utils';
import { pickArtifactUrl, svcApi, uvrApi } from '@/lib/vc';
import type { SovitsJob, SvcCatalog, SvcModel, SvcPipelineStatus } from '@/types';

/** 一次翻唱的产物组合：多轨 + 当时的歌名与音色，够独立回听 */
interface CoverResultItem {
  tracks: { label: string; url: string }[];
  songName: string;
  model: string;
}

/** 一次分离的结果 */
interface SeparateResultItem {
  vocal: string | null;
  instrumental: string | null;
  cached: boolean;
  elapsed_s: number;
  fileName: string;
}

/** 板块强调色：玫瑰。与语音变声页的靛蓝互为区分 */
const ACCENT_TEXT = 'text-rose-500 dark:text-rose-400';
const ACCENT_SOLID = 'bg-rose-600 text-white hover:bg-rose-600/90 active:scale-[0.98]';

/**
 * 歌声转换页（DDSP-SVC）。
 *
 * 主路径是「翻唱向导」：一首带伴奏的歌进去，新人声 / 伴奏 / 混音三件套出来；
 * UVR5 分离内嵌在向导第一步，且结果按内容指纹缓存 —— 同一首歌换音色重跑时
 * 直接跳过分分离（实测 30 秒 → 0.04 秒），这是整条链路最省时的一环。
 * 「只做分离」与「直接转换」是给进阶用户的旁路，参数与向导共用同一套契约。
 */
export function SingingConversionPage({ onGoSettings }: { onGoSettings?: () => void } = {}) {
  const [catalog, setCatalog] = useState<SvcCatalog | null>(null);
  const [pipeline, setPipeline] = useState<(SvcPipelineStatus & { ok: boolean }) | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    svcApi
      .catalog()
      .then(setCatalog)
      .catch((error: Error) => setLoadError(error.message));
    // 音色库里要标出「当前音色」，所以顺带取一次引擎状态；
    // 这一路失败不该把整页打成错误态，静默即可。
    svcApi.pipeline().then(setPipeline).catch(() => setPipeline(null));
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 目录拉取失败**不替换整页**（与 RVC 页同一修法，2026-10 反馈）：
  // 页面结构保持常驻，错误以横幅出现在页内，重试入口在引擎状态条的「刷新」。
  return (
    <div className="space-y-5">
      <SourceNote
        project="DDSP-SVC（歌声转换）+ UVR5（音源分离）"
        location="vendor/ddsp-svc · 整合包 tools/uvr5"
        upstream="翻唱的歌声转换走 DDSP-SVC，第一步的人声 / 伴奏分离走整合包自带的 UVR5 —— 两个上游项目各管一段，本项目只串流程"
      />
      {loadError ? (
        <Card className="border-amber-500/40 bg-amber-500/5">
          <CardHeader>
            <CardTitle className="text-amber-700 dark:text-amber-400">模型目录暂未取到</CardTitle>
            <CardDescription>{loadError}</CardDescription>
            <Button size="sm" variant="outline" className="mt-2 h-7 w-fit text-xs" onClick={() => void refresh()}>
              重试
            </Button>
          </CardHeader>
        </Card>
      ) : null}
      <SovitsServiceNotice onGoSettings={onGoSettings} />
      <div className="flex items-center gap-2">
        <EngineBadge catalog={catalog} />
      </div>
      {/* 音色库放在向导之前：没有音色就没法翻唱，先让用户把「料」备齐 */}
      <SvcModelLibrary catalog={catalog} pipeline={pipeline} onChanged={refresh} />
      <CoverWizard catalog={catalog} onChanged={refresh} />
      {/* 运行产物面板与变声页共用同一个组件：用户要求「训练**和运行**之后的产物
          都要在网站全部显示，同时给出本地路径」。翻唱一次产 1~3 轨，
          所以这里按 track 逐条渲染，不会只显示混音而漏掉新人声与伴奏。 */}
      <RunResultCard
        kind="svc_infer"
        title="翻唱结果"
        description="历次翻唱产出的新人声 / 伴奏 / 混音。记录来自本地服务（重启后仍在），可逐轨回听，点路径文字可复制。"
        icon={<Music2 className="size-4" />}
        accentText={ACCENT_TEXT}
        emptyHint="上面跑一次翻唱"
      />
      <SeparateOnlyCard />
    </div>
  );
}

function EngineBadge({ catalog }: { catalog: SvcCatalog | null }) {
  const models = (catalog?.models ?? []).filter((item) => item.available);
  return (
    <>
      <Badge variant="secondary" className="gap-1.5 font-mono text-[11px]">
        <Music2 className={`size-3 ${ACCENT_TEXT}`} />
        可用音色 {models.length}
        {catalog?.models.some((item) => !item.available) ? `（另有 ${catalog.models.length - models.length} 个缺 config.yaml）` : ''}
      </Badge>
      <Badge variant="outline" className="text-[11px] text-muted-foreground">
        UVR5 分离已就绪，产物按内容指纹缓存复用
      </Badge>
    </>
  );
}

/**
 * 音色模型库（DDSP-SVC）。
 *
 * 与 RVC 页的 `ModelLibrary` 是同一套交互契约，但**多一个必填的 config.yaml** ——
 * DDSP-SVC 的 .pt 是纯权重，采样率 / 编码器 / F0 提取器全在同目录的 config.yaml 里，
 * 少一个都加载不了。所以这个组件接受 `.pt + .yaml/.yml` 成对导入，且拖拽时
 * 两个文件要一起给（只给 .pt 会明确提示还缺配置，而不是静默失败）。
 */
function SvcModelLibrary({
  catalog,
  pipeline,
  onChanged,
}: {
  catalog: SvcCatalog | null;
  pipeline: (SvcPipelineStatus & { ok: boolean }) | null;
  onChanged: () => void;
}) {
  const modelRef = useRef<HTMLInputElement | null>(null);
  const configRef = useRef<HTMLInputElement | null>(null);
  const [pending, setPending] = useState(false);
  const models = catalog?.models ?? [];
  const loadedPath = pipeline?.loaded ? pipeline.model : null;

  const load = async (model: SvcModel) => {
    try {
      await svcApi.loadModel(model.path, model.id);
      toast.success(`已加载 ${model.name}`, {
        description: `${model.sample_rate ?? '?'}Hz · ${model.encoder ?? '未知编码器'}`,
      });
      onChanged();
    } catch (err) {
      toast.error('加载失败', { description: (err as RequestError).fullMessage });
    }
  };

  const upload = async () => {
    const weight = modelRef.current?.files?.[0];
    if (!weight) return;
    const config = configRef.current?.files?.[0] ?? null;
    if (!config) {
      // 后端也会拦，但在这里拦一下能给出更具体的指引
      toast.warning('还需要一个 config.yaml', {
        description: 'DDSP-SVC 的 .pt 权重必须配同目录的 config.yaml 才能加载，请把它一起选上。',
      });
      return;
    }
    setPending(true);
    try {
      const name = weight.name.replace(/\.pt$/i, '');
      const result = await svcApi.uploadModel(weight, config, name);
      if (!result.has_config) {
        toast.warning(result.message);
        return;
      }
      toast.success(result.message);
      // 导入即热加载，省掉「导入完还要再点一次加载」的往返
      await load({ id: name, name, path: result.path, size_mb: 0, has_config: true, available: true });
    } catch (err) {
      toast.error('音色导入失败', { description: (err as RequestError).fullMessage });
    } finally {
      setPending(false);
      if (modelRef.current) modelRef.current.value = '';
      if (configRef.current) configRef.current.value = '';
      // 上传后目录已变，无论成功失败都刷新一次列表（成功要看到新条目，失败要看到真实状态）
      onChanged();
    }
  };

  const remove = async (model: SvcModel) => {
    try {
      await svcApi.deleteModel(model.id);
      toast.success(`已删除 ${model.name}`);
      onChanged();
    } catch (err) {
      toast.error('删除失败', { description: (err as RequestError).fullMessage });
    }
  };

  // 卡片整块可拖：.pt 是主体，配套 config.yaml 一起给。只拖来 .pt 时给明确提示。
  const { dragging, rootProps } = useFileDrop({
    accept: '.pt,.yaml,.yml',
    multiple: true,
    disabled: pending,
    onFiles: (files) => {
      const weight = files.find((item) => /\.pt$/i.test(item.name));
      const config = files.find((item) => /\.ya?ml$/i.test(item.name));
      if (weight && config) {
        if (modelRef.current) applyFilesToInput(modelRef.current, [weight]);
        if (configRef.current) applyFilesToInput(configRef.current, [config]);
        void upload();
      } else if (weight) {
        if (modelRef.current) applyFilesToInput(modelRef.current, [weight]);
        toast.warning('还缺一个 config.yaml', {
          description: '把模型同目录的 config.yaml 也拖进来，才能一起导入并加载。',
        });
      } else if (config) {
        if (configRef.current) applyFilesToInput(configRef.current, [config]);
        toast.info('已拿到 config.yaml', { description: '再把配套的 .pt 拖进来就会一起导入。' });
      }
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Waves className={`size-4 ${ACCENT_TEXT}`} /> 音色模型库
        </CardTitle>
        <CardDescription>
          一个音色 = 一个 .pt + 同目录的 config.yaml（采样率 / 编码器 / F0 提取器都在里面）。
          放在 {catalog?.model_dirs?.[0] ?? '.data/svc/models'}，或直接把两个文件拖进来导入。
        </CardDescription>
      </CardHeader>
      <CardContent className={cn('space-y-3 rounded-lg transition', dropHighlight(dragging))} {...rootProps}>
        {models.length === 0 ? (
          <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
            还没有音色。把一个 .pt 与它的 config.yaml 一起拖进来，或点下面的「导入 .pt + config.yaml」。
          </p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {models.map((model) => (
              <SvcModelCard
                key={model.id}
                model={model}
                loaded={loadedPath === model.path}
                onLoad={() => void load(model)}
                onRemove={() => void remove(model)}
              />
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 border-t pt-3">
          {/* .yaml 之外也接受 .yml —— DDSP-SVC 上下游两种写法都有 */}
          <input ref={modelRef} type="file" accept=".pt" className="hidden" onChange={() => void upload()} />
          <input ref={configRef} type="file" accept=".yaml,.yml" className="hidden" onChange={() => void upload()} />
          <Button variant="outline" size="sm" className="gap-1.5 text-xs" disabled={pending} onClick={() => modelRef.current?.click()}>
            {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />} 导入 .pt + config.yaml
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-xs text-muted-foreground"
            disabled={pending}
            onClick={() => configRef.current?.click()}
          >
            只补 config.yaml
          </Button>
          {catalog?.model_dirs?.length ? (
            <span className="ml-auto truncate font-mono text-[11px] text-muted-foreground" title={catalog.model_dirs.join('\n')}>
              {catalog.model_dirs.length} 个搜索目录
            </span>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

function SvcModelCard({
  model,
  loaded,
  onLoad,
  onRemove,
}: {
  model: SvcModel;
  loaded: boolean;
  onLoad: () => void;
  onRemove: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const runLoad = async () => {
    setLoading(true);
    try {
      onLoad();
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className={cn(
        'group flex items-center justify-between gap-2 rounded-lg border p-3 transition hover:-translate-y-0.5 hover:shadow-md',
        loaded ? 'border-rose-400/60 bg-rose-500/5' : '',
      )}
    >
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">
          {model.name}
          {loaded ? <span className="ml-1.5 text-[11px] text-rose-500 dark:text-rose-400">· 当前音色</span> : null}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {model.available
            ? `${model.sample_rate ?? '?'}Hz · ${model.encoder ?? '?'} · F0 ${model.f0_extractor ?? '?'} · ${model.size_mb}MB`
            : (model.hint ?? '缺少同目录的 config.yaml，无法加载')}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          size="sm"
          variant={loaded ? 'outline' : 'default'}
          className={cn('h-7 text-xs', !loaded && 'bg-rose-600 text-white hover:bg-rose-600/90')}
          disabled={loading || !model.available || loaded}
          onClick={() => void runLoad()}
        >
          {loading ? <Loader2 className="size-3 animate-spin" /> : loaded ? '已加载' : '热加载'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-xs text-muted-foreground"
          onClick={onRemove}
        >
          删除
        </Button>
      </div>
    </div>
  );
}

interface CoverState {
  file: File | null;
  model: string;
  separation: string;
  secondary: string;
  key: number;
  f0Method: string;
  quality: string;
  vocalGain: number;
  instrumentalGain: number;
  delayMs: number;
}

function CoverWizard({ catalog, onChanged }: { catalog: SvcCatalog | null; onChanged: () => void }) {
  const [state, setState] = useState<CoverState>({
    file: null,
    model: '',
    separation: 'vocal_fast',
    secondary: 'none',
    key: 0,
    f0Method: '',
    quality: 'standard',
    vocalGain: 0,
    instrumentalGain: -3,
    delayMs: 0,
  });
  const [sliceSegments, setSliceSegments] = useState(true);
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 多条结果并存：每次翻唱留一套产物，换音色重跑不会把上一次冲掉
  const covers = useResultStack<CoverResultItem>({
    limit: 12,
    storageKey: 'svc-cover-results',
    serialize: (item) => item,
    deserialize: (raw) => (raw && typeof raw === 'object' ? (raw as CoverResultItem) : null),
  });
  /** 本次提交的歌名与音色：任务回调里也要用它 */
  const pendingRef = useRef<{ songName: string; model: string } | null>(null);

  const patch = (changes: Partial<CoverState>) => setState((prev) => ({ ...prev, ...changes }));

  const sourceUrl = useMemo(() => (state.file ? URL.createObjectURL(state.file) : null), [state.file]);

  // 拖一整段伴奏进来比点按钮快得多，所以这里也收拖拽
  const songInputRef = useRef<HTMLInputElement>(null);
  const { dragging: songDragging, rootProps: songDropProps } = useFileDrop({
    onFiles: (files) => patch({ file: files[0] ?? null }),
    accept: 'audio/*,.wav,.mp3,.flac,.ogg,.m4a,.aac',
    inputRef: songInputRef,
  });

  const submit = async () => {
    if (!state.file || !state.model) {
      setError('请先选择歌曲与目标音色');
      return;
    }
    setBusy(true);
    setError(null);
    // 开跑前先把另一端的常驻模型卸掉（翻唱含分离，最吃显存）
    void focusBeforeRun('svc');
    pendingRef.current = { songName: state.file.name, model: state.model };
    try {
      const result = await svcApi.cover({
        file: state.file,
        model: state.model,
        key: state.key,
        // 「跟随模型」哨兵值映射回空串（后端按 config.yaml 的 f0_extractor 处理）
        f0_method: state.f0Method === 'auto' ? '' : state.f0Method,
        quality: state.quality as 'fast' | 'standard' | 'quality' | 'raw',
        slice_segments: sliceSegments,
        separation: { preset: state.separation, secondary: state.secondary, use_cache: true },
        mix: {
          vocal_gain_db: state.vocalGain,
          instrumental_gain_db: state.instrumentalGain,
          vocal_delay_ms: state.delayMs,
        },
      });
      if ('job_id' in result) setJobId(result.job_id);
      else pushCover(collectArtifacts({ ...(result.artifacts ?? {}) }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const pushCover = (tracks: { label: string; url: string }[]) => {
    if (tracks.length === 0) return;
    covers.push({
      tracks,
      songName: pendingRef.current?.songName ?? '未命名歌曲',
      model: pendingRef.current?.model ?? '',
    });
  };

  const onJobDone = (job: SovitsJob) => {
    const produced = (job.artifacts as { artifacts?: Record<string, string>; urls?: Record<string, string> } | null) ?? {};
    pushCover(collectArtifacts(produced.artifacts ?? produced.urls ?? {}));
    notifyVcRunChanged();
    onChanged();
  };

  const coverEntries: ResultStackEntry[] = covers.entries.map((entry) => ({
    id: entry.id,
    createdAt: entry.createdAt,
    title: `${entry.item.songName} → ${entry.item.model || '默认音色'}`,
    subtitle: `${entry.item.tracks.length} 轨`,
    summary: entry.item.tracks.map((track) => track.label).join(' / '),
    content: (
      <div className="rounded-xl border p-3">
        <p className="mb-2 text-xs font-medium text-muted-foreground">产物（点击标签切换试听）</p>
        <ABPlayer
          accentClass={ACCENT_SOLID}
          tracks={entry.item.tracks.map((track) => ({ label: track.label, url: track.url }))}
        />
      </div>
    ),
  }));

  const qualities = catalog?.quality_presets ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Music2 className={`size-4 ${ACCENT_TEXT}`} /> 翻唱向导
        </CardTitle>
        <CardDescription>
          一键完成「人声分离 → 歌声转换 → 混音」，产出新人声 / 伴奏 / 混音三件套。同一首歌换音色重跑时，分离结果自动复用。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* 翻唱第一步就是分离（UVR5 门槛 4 GB），先把显存账摆出来 */}
        <ResourceBudget task="uvr5" />
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-2" {...songDropProps}>
            <Label htmlFor="svc-song">歌曲（可拖文件进来）</Label>
            <input
              ref={songInputRef}
              id="svc-song"
              type="file"
              accept="audio/*"
              onChange={(event) => patch({ file: event.target.files?.[0] ?? null })}
              className={cn(
                'w-full cursor-pointer rounded-lg border bg-background px-3 py-2 text-xs file:mr-3 file:rounded-md file:border-0 file:bg-muted file:px-2 file:py-1 file:text-xs',
                dropHighlight(songDragging),
              )}
            />
            {sourceUrl ? <audio src={sourceUrl} controls preload="metadata" className="mt-1 w-full" /> : null}

            <div className="space-y-1.5 pt-2">
              <Label>
                  <TermTip term="人声分离" />
                </Label>
              <Select value={state.separation} onValueChange={(v) => patch({ separation: v })}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="off">跳过（输入已是干声）</SelectItem>
                  <SelectItem value="vocal_fast">快速 · HP2（保留人声）</SelectItem>
                  <SelectItem value="vocal_main">主唱 · HP5（削弱和声）</SelectItem>
                  <SelectItem value="vocal_hifi">高保真 · BS-RoFormer</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>
                  <TermTip term="二级处理" />
                </Label>
              <Select value={state.secondary} onValueChange={(v) => patch({ secondary: v })}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">无</SelectItem>
                  <SelectItem value="deecho_normal">去回声（温和）</SelectItem>
                  <SelectItem value="deecho_aggressive">去回声（强力）</SelectItem>
                  <SelectItem value="dereverb">去混响</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <p className="text-xs font-medium">
                  <TermTip term="长音频自动切分" />
                </p>
                <p className="text-[11px] text-muted-foreground">按静音分段推理，避免 8GB 显存峰值溢出</p>
              </div>
              <Switch checked={sliceSegments} onCheckedChange={setSliceSegments} />
            </div>
          </div>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>
                  <TermTip term="目标音色" />
                </Label>
              <Select value={state.model} onValueChange={(v) => patch({ model: v })}>
                <SelectTrigger className="w-full"><SelectValue placeholder="选择一个 .pt 音色" /></SelectTrigger>
                <SelectContent>
                  {(catalog?.models ?? []).map((item) => (
                    <SelectItem key={item.id} value={item.id} disabled={!item.available}>
                      {item.name}
                      {!item.available ? '（缺 config.yaml）' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>
                  <TermTip term="音质" />
                </Label>
                <Select value={state.quality} onValueChange={(v) => patch({ quality: v })}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {qualities.map((preset) => (
                      <SelectItem key={preset.key} value={preset.key}>{preset.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>
                  <TermTip term="F0 方法" />
                </Label>
                <Select value={state.f0Method} onValueChange={(v) => patch({ f0Method: v })}>
                  <SelectTrigger className="w-full"><SelectValue placeholder="跟随模型" /></SelectTrigger>
                  <SelectContent>
                    {/* Radix 禁止空字符串 value：空值留给「清空选择显示占位符」。
                        「跟随模型」用 auto 哨兵值，提交时再映射回空串 */}
                    <SelectItem value="auto">跟随模型</SelectItem>
                    {(catalog?.f0_methods ?? []).map((method) => (
                      <SelectItem key={method.key} value={method.key}>{method.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>转调 {state.key > 0 ? `+${state.key}` : state.key} 半音</Label>
              <Slider value={[state.key]} min={-12} max={12} step={1} onValueChange={(v) => patch({ key: v[0] })} />
            </div>
            <div className="space-y-1.5">
              <Label>混音：人声 {state.vocalGain > 0 ? '+' : ''}{state.vocalGain}dB / 伴奏 {state.instrumentalGain}dB</Label>
              <div className="grid grid-cols-2 gap-3">
                <Slider value={[state.vocalGain]} min={-10} max={10} step={0.5} onValueChange={(v) => patch({ vocalGain: v[0] })} />
                <Slider value={[state.instrumentalGain]} min={-20} max={10} step={0.5} onValueChange={(v) => patch({ instrumentalGain: v[0] })} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>人声延迟补偿 {state.delayMs}ms</Label>
              <Slider value={[state.delayMs]} min={-500} max={500} step={10} onValueChange={(v) => patch({ delayMs: v[0] })} />
            </div>
          </div>
        </div>

        {error ? <p className="text-xs text-destructive">{error}</p> : null}

        <Button className={ACCENT_SOLID} disabled={busy || !state.file || !state.model} onClick={() => void submit()}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : null} 一键开始翻唱
        </Button>

        <JobPanel jobId={jobId} onComplete={onJobDone} accent={ACCENT_TEXT} title="翻唱任务" />

        {covers.entries.length > 0 ? (
          <ResultStack entries={coverEntries} onRemove={covers.remove} onClear={covers.clear} empty={null} />
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * 把任务产物整理成可播放的轨道列表。
 *
 * `raw` 是 `artifacts.artifacts` 与 `artifacts.urls` 合并后的对象；这里改成
 * 逐键调 `pickArtifactUrl`，而不是 `resolveAudioUrl(raw[key]) ?? raw[key]` ——
 * 后者在拿到服务端绝对路径（`F:\...`）时会把无效地址**原样透传**出去，
 * 产生一个必然 404 的音频源（播放器显示灰色禁用）。`pickArtifactUrl`
 * 会拦住盘符路径并优先用 `urls` 里的 Web 路径。
 */
function collectArtifacts(raw: Record<string, string>): { label: string; url: string }[] {
  const labels: Array<[string, string]> = [
    ['vocal', '新人声'],
    ['instrumental', '伴奏'],
    ['mix', '混音'],
    ['output', '转换结果'],
  ];
  const result: { label: string; url: string }[] = [];
  for (const [key, label] of labels) {
    if (!raw[key]) continue;
    const url = pickArtifactUrl({ [key]: raw[key] });
    if (url) result.push({ label, url });
  }
  return result;
}

/**
 * 把单个产物路径转成 ABPlayer 的轨道数组；地址不可用时返回**空数组**。
 *
 * 不要写成 `[{ label, url: resolveAudioUrl(x) ?? '' }]` —— 空字符串 src 会让
 * `<audio>` 处于无源状态，控件变成灰色不可点，看起来像「功能坏了」。
 * 宁可少一条轨道，也不给一个假装能播的播放器。
 */
function toTrack(label: string, path: string | undefined | null): { label: string; url: string }[] {
  const url = pickArtifactUrl(path ? { output: path } : null);
  return url ? [{ label, url }] : [];
}

/** 独立分离卡片：只要人声 / 伴奏，产物进缓存，翻唱向导可直接复用 */
function SeparateOnlyCard() {
  const [file, setFile] = useState<File | null>(null);
  const [preset, setPreset] = useState('vocal_fast');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const separateInputRef = useRef<HTMLInputElement>(null);
  const { dragging: separateDragging, rootProps: separateDropProps } = useFileDrop({
    onFiles: (files) => setFile(files[0] ?? null),
    accept: 'audio/*,.wav,.mp3,.flac,.ogg,.m4a,.aac',
    disabled: busy,
    inputRef: separateInputRef,
  });
  // 多条结果并存：每次分离留一条，旧的还能回去听
  const results = useResultStack<SeparateResultItem>({
    limit: 12,
    storageKey: 'uvr-separate-results',
    serialize: (item) => item,
    deserialize: (raw) => (raw && typeof raw === 'object' ? (raw as SeparateResultItem) : null),
  });

  const submit = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    void focusBeforeRun('uvr5');
    try {
      const payload = await uvrApi.separate({ file, preset, wait: true });
      if (!payload.ok) throw new Error('分离失败');
      results.push({
        vocal: payload.urls?.vocal ?? payload.vocal,
        instrumental: payload.urls?.instrumental ?? payload.instrumental,
        cached: payload.cached,
        elapsed_s: payload.elapsed_s ?? 0,
        fileName: file.name,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Scissors className={`size-4 ${ACCENT_TEXT}`} /> 只做分离
        </CardTitle>
        <CardDescription>先听人声与伴奏，确认满意后再进向导转换 —— 分离结果会进入缓存，向导直接复用。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-end gap-3" {...separateDropProps}>
          <input
            ref={separateInputRef}
            type="file"
            accept="audio/*"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            className={cn(
              'w-full max-w-sm cursor-pointer rounded-lg border bg-background px-3 py-2 text-xs file:mr-3 file:rounded-md file:border-0 file:bg-muted file:px-2 file:py-1 file:text-xs',
              dropHighlight(separateDragging),
            )}
          />
          <div className="w-56">
            <Select value={preset} onValueChange={setPreset}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="vocal_fast">快速 · HP2</SelectItem>
                <SelectItem value="vocal_main">主唱 · HP5</SelectItem>
                <SelectItem value="vocal_hifi">高保真 · RoFormer</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button size="sm" className={`h-9 text-xs ${ACCENT_SOLID}`} disabled={busy || !file} onClick={() => void submit()}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : null} 开始分离
          </Button>
        </div>
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        {results.entries.length > 0 ? (
          <ResultStack
            entries={results.entries.map((entry) => ({
              id: entry.id,
              createdAt: entry.createdAt,
              title: entry.item.fileName,
              subtitle: entry.item.cached ? '命中缓存' : `${entry.item.elapsed_s.toFixed(1)}s`,
              summary: '人声 / 伴奏',
              content: (
                <div className="rounded-xl border p-3">
                  <p className="mb-2 text-xs text-muted-foreground">
                    {entry.item.cached ? '命中缓存' : `本次耗时 ${entry.item.elapsed_s.toFixed(1)}s`} ·
                    下次换音色重跑可跳过这一步
                  </p>
                  <ABPlayer
                    accentClass={ACCENT_SOLID}
                    tracks={[
                      // 逐条过 `pickArtifactUrl`：不可用的地址（比如服务端绝对路径）
                      // 返回 null 直接不展示该轨，而不是塞一个空 `url` 进去 ——
                      // 空 src 会让 `<audio>` 处于无源状态，控件渲染成灰色禁用。
                      ...toTrack('人声', entry.item.vocal),
                      ...toTrack('伴奏', entry.item.instrumental),
                    ]}
                  />
                </div>
              ),
            }))}
            onRemove={results.remove}
            onClear={results.clear}
            empty={null}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}

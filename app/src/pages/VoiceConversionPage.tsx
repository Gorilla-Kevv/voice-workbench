import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FolderOpen, Loader2, Upload, Waves } from 'lucide-react';
import { toast } from 'sonner';
import { RequestError } from '@/lib/errors';
import { dropHighlight, applyFilesToInput, useFileDrop } from '@/hooks/useFileDrop';
import { cn } from '@/lib/utils';
import { ABPlayer } from '@/components/features/ABPlayer';
import { JobPanel } from '@/components/features/JobPanel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { TermTip } from '@/components/features/TermTip';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ResourceBudget } from '@/components/features/ResourceBudget';
import { SourceNote } from '@/components/features/SourceNote';
import { SovitsServiceNotice } from '@/components/features/SovitsServiceNotice';
import { focusBeforeRun } from '@/lib/arbiter';
import { ResultStack, type ResultStackEntry } from '@/components/features/ResultStack';
import { RunResultCard } from '@/components/features/RunResultCard';
import { useResultStack } from '@/hooks/useResultStack';
import { useVcTrainHistory } from '@/hooks/useVcTrainHistory';
import { notifyVcRunChanged } from '@/hooks/useVcRunHistory';
import { pickArtifactUrl, vcApi } from '@/lib/vc';
import type { SovitsJob, VcCatalog, VcModel, VcTrainArtifact } from '@/types';

/** 一条变声结果：输出（服务端地址）+ 当时的源音频快照，够独立回听 A·B 对比 */
interface VcResultItem {
  outputUrl: string;
  /** 源音频的独立快照地址（预览用的那条会被回收，这里必须自己持有一份） */
  sourceUrl: string | null;
  fileName: string;
  model: string;
}

/** 板块强调色：靛蓝。所有交互态统一走这两个类，避免散落的十六进制 */
const ACCENT_TEXT = 'text-indigo-500 dark:text-indigo-400';
const ACCENT_SOLID = 'bg-indigo-600 text-white hover:bg-indigo-600/90 active:scale-[0.98]';

/**
 * 语音变声页（RVC）。
 *
 * 三件事：挑音色 → 变声 → 工坊（融合 / LoRA）。
 * 与歌声转换页刻意保持结构对称但能力不同：这里没有分离与混音，
 * 多出来的是检索索引与音色工坊。
 */
export function VoiceConversionPage({ onGoSettings }: { onGoSettings?: () => void } = {}) {
  const [catalog, setCatalog] = useState<VcCatalog | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  /** 拉取目录（模型库 + 引擎状态）。不在 effect 里同步 setState：先落微任务 */
  const refresh = useCallback(() => {
    return vcApi
      .catalog()
      .then((data) => {
        setCatalog(data);
        setLoadError(null);
      })
      .catch((error: Error) => setLoadError(error.message));
  }, []);

  useEffect(() => {
    // 微任务里再发请求：避免在 effect 体内同步 setState 触发级联渲染
    void Promise.resolve().then(refresh);
  }, [refresh]);

  // 目录拉取失败**不替换整页**：页面结构保持常驻，错误以横幅形式出现在页内（带重试）。
  // 之前的整页替换在「服务冷启动几十秒」的场景下表现为：先渲染一遍完整页面，
  // 请求超时后再整个换成一张报错卡 —— 用户以为页面挂了（2026-10 反馈）。
  // 服务启停状态由 SovitsServiceNotice 常驻提示。
  return (
    <div className="space-y-5">
      <SourceNote
        project="RVC（Retrieval-based Voice Conversion）"
        location="vendor/rvc"
        upstream="本项目只做流程封装与本地服务调用，不改动上游代码"
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
      <EngineBadge catalog={catalog} onRefresh={refresh} accent={ACCENT_TEXT} />
      <ModelLibrary catalog={catalog} onChanged={refresh} accent={ACCENT_SOLID} />
      <ConvertCard catalog={catalog} accentText={ACCENT_TEXT} accentSolid={ACCENT_SOLID} onChanged={refresh} />
      <RunResultCard
        kind="vc_infer"
        title="变声结果"
        description="历次变声产出的音频。记录来自本地服务（重启后仍在），可直接回听，点路径文字可复制。"
        icon={<Waves className="size-4" />}
        accentText={ACCENT_TEXT}
        emptyHint="上面跑一次变声"
      />
      <WorkshopCard catalog={catalog} accentSolid={ACCENT_SOLID} onChanged={refresh} />
      <TrainResultCard onChanged={refresh} />
    </div>
  );
}

function EngineBadge({ catalog, onRefresh, accent }: { catalog: VcCatalog | null; onRefresh: () => void; accent: string }) {
  const engine = catalog?.engine;
  return (
    <div className="flex items-center gap-2">
      {engine?.loaded ? (
        <Badge variant="secondary" className="gap-1.5 font-mono text-[11px]">
          <span className={`size-1.5 rounded-full bg-current ${accent}`} />
          已加载 {engine.name} · {engine.sample_rate}Hz · {engine.device}
        </Badge>
      ) : (
        <Badge variant="outline" className="gap-1.5 text-[11px] text-muted-foreground">
          <Loader2 className="size-3 animate-spin" />
          未加载音色（选择模型后自动加载）
        </Badge>
      )}
      <Button variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground" onClick={onRefresh}>
        刷新
      </Button>
    </div>
  );
}

function ModelLibrary({ catalog, onChanged, accent }: { catalog: VcCatalog | null; onChanged: () => void; accent: string }) {
  const weightRef = useRef<HTMLInputElement | null>(null);
  const indexRef = useRef<HTMLInputElement | null>(null);
  const [pending, setPending] = useState(false);
  const models = catalog?.models ?? [];

  const upload = async () => {
    const weight = weightRef.current?.files?.[0];
    if (!weight) return;
    const index = indexRef.current?.files?.[0] ?? null;
    setPending(true);
    try {
      await vcApi.uploadModel(weight, index, weight.name.replace(/\.pth$/i, ''));
      onChanged();
    } catch (err) {
      // 没有这一条，拖错文件（或网络失败）时只有按钮闪一下，用户不知道发生了什么
      toast.error('音色导入失败', { description: (err as RequestError).fullMessage });
    } finally {
      setPending(false);
      if (weightRef.current) weightRef.current.value = '';
      if (indexRef.current) indexRef.current.value = '';
    }
  };

  // 音色模型支持整卡拖入：.pth 是主体，配套的 .index 可以一起拖、也可以后补
  const { dragging: libraryDragging, rootProps: libraryDropProps } = useFileDrop({
    accept: '.pth,.index',
    multiple: true,
    disabled: pending,
    onFiles: (files) => {
      const weight = files.find((item) => /\.pth$/i.test(item.name));
      const index = files.find((item) => /\.index$/i.test(item.name));
      if (weight && weightRef.current) {
        applyFilesToInput(weightRef.current, [weight]);
        if (index && indexRef.current) applyFilesToInput(indexRef.current, [index]);
        void upload();
      } else if (index && indexRef.current) {
        applyFilesToInput(indexRef.current, [index]);
        toast.info('已拿到配套 .index', { description: '再拖入同名 .pth 就会一起导入。' });
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
          一个音色 = 一个 .pth（可选配套 .index 检索索引）。放在 {catalog?.models_dir ?? '.data/vc/models'} 或直接导入。
        </CardDescription>
      </CardHeader>
      <CardContent
        className={cn('space-y-3 rounded-lg transition', dropHighlight(libraryDragging))}
        {...libraryDropProps}
      >
        {models.length === 0 ? (
          <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
            还没有音色。导入一个 .pth，或先用「音色工坊」训练一个。
          </p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {models.map((model) => (
              <ModelCard key={model.id} model={model} accent={accent} onChanged={onChanged} />
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 border-t pt-3">
          <input ref={weightRef} type="file" accept=".pth" className="hidden" onChange={() => void upload()} />
          <input ref={indexRef} type="file" accept=".index" className="hidden" onChange={() => void upload()} />
          <Button variant="outline" size="sm" className="gap-1.5 text-xs" disabled={pending} onClick={() => weightRef.current?.click()}>
            {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />} 导入 .pth
          </Button>
          <Button variant="ghost" size="sm" className="text-xs text-muted-foreground" disabled={pending} onClick={() => indexRef.current?.click()}>
            配套 .index
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function ModelCard({ model, accent, onChanged }: { model: VcModel; accent: string; onChanged: () => void }) {
  const [loading, setLoading] = useState(false);
  const load = async () => {
    setLoading(true);
    try {
      await vcApi.loadModel(model.id);
      onChanged();
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="group flex items-center justify-between gap-2 rounded-lg border p-3 transition hover:-translate-y-0.5 hover:shadow-md">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{model.name}</p>
        <p className="truncate text-xs text-muted-foreground">
          {model.sample_rate ?? '?'}Hz · {model.version ?? 'v?'} {model.f0 ? '· 带F0' : ''} · {model.size_mb}MB
          {model.has_index ? ' · 含索引' : ''}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button size="sm" className={`h-7 text-xs ${accent}`} disabled={loading} onClick={() => void load()}>
          {loading ? <Loader2 className="size-3 animate-spin" /> : '热加载'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-xs text-muted-foreground"
          onClick={() => {
            const next = window.prompt('新的音色名称（会同时重命名配套索引）', model.name);
            if (next === null || !next.trim() || next.trim() === model.name) return;
            void vcApi
              .renameModel(model.id, next.trim())
              .then(() => onChanged())
              .catch((cause: RequestError) => toast.error('重命名失败', { description: cause.fullMessage }));
          }}
        >
          改名
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-xs text-muted-foreground"
          onClick={() => {
            void vcApi.deleteModel(model.id).then(onChanged);
          }}
        >
          删除
        </Button>
      </div>
    </div>
  );
}

function ConvertCard({
  catalog,
  accentText,
  accentSolid,
  onChanged,
}: {
  catalog: VcCatalog | null;
  accentText: string;
  accentSolid: string;
  onChanged: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);
  // 干声支持直接拖进来
  const { dragging: audioDragging, rootProps: audioDropProps } = useFileDrop({
    onFiles: (files) => setFile(files[0] ?? null),
    accept: 'audio/*,.wav,.mp3,.flac,.ogg,.m4a,.aac,.webm',
    inputRef: audioInputRef,
  });
  const [model, setModel] = useState('');
  const [keyShift, setKeyShift] = useState(0);
  const [f0Method, setF0Method] = useState('rmvpe');
  const [indexRate, setIndexRate] = useState(0.3);
  const [protect, setProtect] = useState(0.33);
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // 多条结果并存：每次变声留一条（含当次源音频快照），旧的随时可回去对比
  const results = useResultStack<VcResultItem>({
    limit: 12,
    storageKey: 'vc-results',
    onEvict: (item) => {
      if (item.sourceUrl) URL.revokeObjectURL(item.sourceUrl);
    },
  });
  /** 本次提交的源音频快照：同步路径与任务回调都要用它 */
  const pendingRef = useRef<{ sourceUrl: string | null; fileName: string; model: string } | null>(null);

  const f0Methods = catalog?.f0_methods ?? [];
  const sourceUrl = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);

  useEffect(() => () => {
    if (sourceUrl) URL.revokeObjectURL(sourceUrl);
  }, [sourceUrl]);

  const submit = async () => {
    if (!file || !model) {
      setError('请先选择音频与目标音色');
      return;
    }
    setSubmitting(true);
    setError(null);
    // 开跑前先把本系统内其它常驻模型（网易 TTS / 转写）卸掉，显存整块让给 RVC
    void focusBeforeRun('rvc');
    // 源音频另开一个地址快照：预览用的那条会随下次选文件被回收，
    // 列表里旧结果要能一直回放，不能跟着失效
    pendingRef.current = {
      sourceUrl: URL.createObjectURL(file),
      fileName: file.name,
      model,
    };
    try {
      const result = await vcApi.convert({
        file,
        model,
        f0_up_key: keyShift,
        f0_method: f0Method,
        index_rate: indexRate,
        protect,
      });
      if ('job_id' in result) setJobId(result.job_id);
      else pushResult(pickArtifactUrl(result as unknown as Record<string, unknown>));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  };

  const pushResult = (outputUrl: string | null) => {
    const pending = pendingRef.current;
    if (!outputUrl || !pending) return;
    results.push({
      outputUrl,
      sourceUrl: pending.sourceUrl,
      fileName: pending.fileName,
      model: pending.model,
    });
  };

  const onJobDone = (job: SovitsJob) => {
    // 产物里 `output` 是服务端绝对路径、`urls.output` 才是 Web 路径。
    // 取错会拼出 `/api/sovits/F:/...` → 404 → 播放器灰色禁用（用户看到的现象）。
    // 统一走 `pickArtifactUrl` 收口这个判断，别在各页面手写。
    pushResult(pickArtifactUrl(job.artifacts as Record<string, unknown> | null));
    onChanged();
    // 通知「变声结果」面板立刻把这条新记录读回来
    notifyVcRunChanged();
  };

  const vcEntries: ResultStackEntry[] = results.entries.map((entry) => ({
    id: entry.id,
    createdAt: entry.createdAt,
    title: `${entry.item.fileName} → ${entry.item.model}`,
    subtitle: '变声完成',
    summary: entry.item.fileName,
    content: entry.item.sourceUrl ? (
      <div className="rounded-xl border p-3">
        <p className="mb-2 text-xs font-medium text-muted-foreground">原声 / 变声 A·B 对比</p>
        <ABPlayer
          accentClass={accentSolid}
          tracks={[
            { label: '原声', url: entry.item.sourceUrl },
            { label: '变声后', url: entry.item.outputUrl },
          ]}
        />
      </div>
    ) : (
      <audio src={entry.item.outputUrl} controls className="w-full" />
    ),
  }));

  return (
    <Card>
      <CardHeader>
        {/* 变声要 2.5 GB 显存门槛，先摆数字 */}
        <ResourceBudget task="rvc" className="mb-3" />
        <CardTitle className="text-base">开始变声</CardTitle>
        <CardDescription>上传一段说话 / 配音干声（建议 ≤5 分钟），保留内容与语气，只替换音色。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-2" {...audioDropProps}>
            <Label htmlFor="vc-audio">
                  <TermTip term="源音频" />（可拖文件进来）
                </Label>
            <input
              ref={audioInputRef}
              id="vc-audio"
              type="file"
              accept="audio/*"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              className={cn(
                'w-full cursor-pointer rounded-lg border bg-background px-3 py-2 text-xs file:mr-3 file:rounded-md file:border-0 file:bg-muted file:px-2 file:py-1 file:text-xs',
                dropHighlight(audioDragging),
              )}
            />
            {sourceUrl ? (
              <audio src={sourceUrl} controls preload="metadata" className="mt-1 w-full" />
            ) : null}
          </div>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>
                  <TermTip term="目标音色" />
                </Label>
              <Select value={model} onValueChange={setModel}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="选择一个 .pth 音色" />
                </SelectTrigger>
                <SelectContent>
                  {(catalog?.models ?? []).map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.name}
                      {item.has_index ? '（含索引）' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>
                  <TermTip term="F0 方法" />
                </Label>
                <Select value={f0Method} onValueChange={setF0Method}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {f0Methods.map((method) => (
                      <SelectItem key={method.key} value={method.key}>{method.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>
                  <TermTip term="变调">变调（半音）</TermTip>
                </Label>
                <div className="flex items-center gap-2 pt-1">
                  <Slider value={[keyShift]} min={-12} max={12} step={1} onValueChange={(v) => setKeyShift(v[0])} />
                  <span className={`w-8 text-right font-mono text-xs ${accentText}`}>{keyShift > 0 ? `+${keyShift}` : keyShift}</span>
                </div>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>检索特征占比 {Math.round(indexRate * 100)}%</Label>
              <Slider value={[indexRate]} min={0} max={1} step={0.05} onValueChange={(v) => setIndexRate(v[0])} />
            </div>
            <div className="space-y-1.5">
              <Label>清辅音保护 {protect.toFixed(2)}</Label>
              <Slider value={[protect]} min={0} max={0.5} step={0.01} onValueChange={(v) => setProtect(v[0])} />
            </div>
          </div>
        </div>

        {error ? <p className="text-xs text-destructive">{error}</p> : null}

        <div className="flex items-center gap-2">
          <Button className={accentSolid} disabled={submitting || !file || !model} onClick={() => void submit()}>
            {submitting ? <Loader2 className="size-4 animate-spin" /> : null} 开始变声
          </Button>
        </div>

        <JobPanel jobId={jobId} onComplete={onJobDone} accent={accentText} title="变声任务" />

        {results.entries.length > 0 ? (
          <ResultStack entries={vcEntries} onRemove={results.remove} onClear={results.clear} empty={null} />
        ) : null}
      </CardContent>
    </Card>
  );
}

function WorkshopCard({ catalog, accentSolid, onChanged }: { catalog: VcCatalog | null; accentSolid: string; onChanged: () => void }) {
  const modelNames = (catalog?.models ?? []).map((item) => item.id);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">音色工坊</CardTitle>
        <CardDescription>两条缓解「换音色就要重训」的路径：零训练的权重融合，或只训一个小适配器的 LoRA 微调。</CardDescription>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="merge">
          <TabsList>
            <TabsTrigger value="merge">
                <TermTip term="音色融合" />
              </TabsTrigger>
            <TabsTrigger value="lora">LoRA 微调</TabsTrigger>
          </TabsList>
          <TabsContent value="merge" className="pt-4">
            <MergeTab models={modelNames} accentSolid={accentSolid} onChanged={onChanged} />
          </TabsContent>
          <TabsContent value="lora" className="pt-4">
            <LoraTab models={modelNames} accentSolid={accentSolid} onTrained={onChanged} />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

function MergeTab({ models, accentSolid, onChanged }: { models: string[]; accentSolid: string; onChanged: () => void }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [weights, setWeights] = useState<number[]>([0.5, 0.5]);
  const [name, setName] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const toggle = (value: string) => {
    setPicked((prev) => {
      if (prev.includes(value)) return prev.filter((item) => item !== value);
      const next = [...prev, value];
      setWeights(Array.from({ length: next.length }, () => 1 / next.length));
      return next;
    });
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const merged = await vcApi.merge({ models: picked, weights, name: name || undefined });
      setResult(merged.name);
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {models.map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => toggle(item)}
            className={`rounded-full px-3 py-1 text-xs transition active:scale-95 ${
              picked.includes(item) ? accentSolid : 'border bg-background text-muted-foreground hover:bg-muted'
            }`}
          >
            {item}
          </button>
        ))}
      </div>
      {picked.map((item, index) => (
        <div key={item} className="flex items-center gap-3">
          <span className="w-28 shrink-0 truncate text-xs text-muted-foreground">{item}</span>
          <Slider
            value={[weights[index] ?? 0.5]}
            min={0}
            max={1}
            step={0.05}
            onValueChange={(v) =>
              setWeights((prev) => {
                const next = [...prev];
                next[index] = v[0];
                return next;
              })
            }
          />
          <span className="w-10 text-right font-mono text-xs">{Math.round((weights[index] ?? 0) * 100)}%</span>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="新音色名称（可选）" className="h-8 w-52 text-xs" />
        <Button size="sm" className={`h-8 text-xs ${accentSolid}`} disabled={busy || picked.length < 2} onClick={() => void submit()}>
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : null} 融合生成
        </Button>
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {result ? <p className="text-xs text-emerald-600">已生成新音色「{result}」，可在模型库中查看并热加载。</p> : null}
    </div>
  );
}

function LoraTab({
  models,
  accentSolid,
  onTrained,
}: {
  models: string[];
  accentSolid: string;
  onTrained: () => void;
}) {
  const [name, setName] = useState('my-voice');
  const [corpusDir, setCorpusDir] = useState('');
  const [base, setBase] = useState('');
  const [epochs, setEpochs] = useState(20);
  const [rank, setRank] = useState(8);
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await vcApi.train({
        name,
        corpus_dir: corpusDir,
        mode: 'lora',
        base_model: base,
        epochs,
        rank,
        build_index: true,
      });
      setJobId(result.job_id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="lora-name">音色名</Label>
          <Input id="lora-name" value={name} onChange={(e) => setName(e.target.value)} className="h-8 text-xs" />
        </div>
        <div className="space-y-1.5">
          <Label>
                  <TermTip term="底模">底模（.pth，训练一次后所有音色共用）</TermTip>
                </Label>
          <Select value={base} onValueChange={setBase}>
            <SelectTrigger className="w-full"><SelectValue placeholder="选择底模" /></SelectTrigger>
            <SelectContent>
              {models.map((item) => (
                <SelectItem key={item} value={item}>{item}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="lora-corpus">语料目录（本机路径，10~30 分钟干净干声）</Label>
          <Input
            id="lora-corpus"
            value={corpusDir}
            onChange={(e) => setCorpusDir(e.target.value)}
            placeholder="F:\\datasets\\my-voice"
            className="h-8 font-mono text-xs"
          />
        </div>
        <div className="space-y-1.5">
          <Label>训练轮数 {epochs}</Label>
          <Slider value={[epochs]} min={5} max={80} step={5} onValueChange={(v) => setEpochs(v[0])} />
        </div>
        <div className="space-y-1.5">
          <Label>LoRA rank {rank}</Label>
          <Slider value={[rank]} min={4} max={32} step={4} onValueChange={(v) => setRank(v[0])} />
        </div>
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <div className="flex items-center gap-2">
        <Button size="sm" className={`h-8 text-xs ${accentSolid}`} disabled={busy || !corpusDir || !base} onClick={() => void submit()}>
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : null} 开始 LoRA 微调
        </Button>
        <p className="text-xs text-muted-foreground">只训练约 4% 的参数，产物是几 MB 的适配器，可随时热切换。</p>
      </div>
      <JobPanel
        jobId={jobId}
        onComplete={onTrained}
        accent={accentSolid.replace('bg-indigo-600', 'text-indigo-500').replace(' text-white', '')}
        title="训练任务"
      />
    </div>
  );
}

/** 产物类型 → 图标与配色 */
const ARTIFACT_STYLE: Record<string, { label: string; className: string }> = {
  model: { label: '模型', className: 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400' },
  adapter: { label: 'LoRA', className: 'bg-violet-500/10 text-violet-600 dark:text-violet-400' },
  index: { label: '索引', className: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' },
};

/**
 * 训练结果面板。
 *
 * 这解决的是用户 2026-10 报的问题：「训练的结果在网站重启之后就没了」。
 * 真相是**产物一直在磁盘上、任务记录也一直在**（服务端写 `trainer/.data/jobs/`），
 * 但前端此前只在 `LoraTab` 的局部 state 里记着 `jobId`，组件一卸载就断了线索。
 * 现在改成挂载时就去服务端把 `vc_train` 历史拉回来 —— 刷新、重启浏览器、
 * 甚至重启服务，记录都还在。
 */
function TrainResultCard({ onChanged }: { onChanged: () => void }) {
  const { records, loading, error, refresh } = useVcTrainHistory();
  const [copied, setCopied] = useState<string | null>(null);

  const copyPath = async (path: string) => {
    try {
      await navigator.clipboard.writeText(path);
      setCopied(path);
      window.setTimeout(() => setCopied((prev) => (prev === path ? null : prev)), 1500);
    } catch {
      toast.error('复制失败', { description: '浏览器拒绝了剪贴板访问，请手动选中路径复制。' });
    }
  };

  const total = records.reduce((sum, record) => sum + record.artifacts.length, 0);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <FolderOpen className={`size-4 ${ACCENT_TEXT}`} /> 训练结果
            </CardTitle>
            <CardDescription>
              历次训练产出的模型 / 适配器 / 索引。记录来自本地服务（重启后仍在），点路径文字可复制。
            </CardDescription>
          </div>
          <Button variant="ghost" size="sm" className="h-7 shrink-0 text-xs text-muted-foreground" onClick={refresh}>
            刷新
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {error ? <p className="text-xs text-destructive">读取训练记录失败：{error}</p> : null}
        {loading && records.length === 0 ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" /> 正在读取训练记录…
          </p>
        ) : records.length === 0 ? (
          <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
            还没有训练记录。上面跑一次 LoRA 微调，产物会自动出现在这里。
          </p>
        ) : (
          <div className="space-y-2">
            <p className="text-[11px] text-muted-foreground">
              共 {records.length} 次训练 · {total} 件产物
            </p>
            {records.map((record) => (
              <div key={record.jobId} className="rounded-lg border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-sm font-medium">{record.name}</span>
                  <Badge variant="outline" className="shrink-0 text-[11px]">{record.mode}</Badge>
                  <Badge
                    variant="outline"
                    className={cn(
                      'shrink-0 text-[11px]',
                      record.state === 'succeeded'
                        ? 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400'
                        : record.state === 'failed'
                          ? 'border-destructive/40 text-destructive'
                          : 'text-muted-foreground',
                    )}
                  >
                    {record.state === 'succeeded' ? '成功' : record.state === 'failed' ? '失败' : record.state === 'cancelled' ? '已取消' : record.state}
                  </Badge>
                  <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                    {formatTime(record.createdAt)}
                  </span>
                </div>

                {record.artifacts.length === 0 ? (
                  <p className="mt-2 text-xs text-muted-foreground">这次训练没有产出可展示的产物。</p>
                ) : (
                  <ul className="mt-2 space-y-1.5">
                    {record.artifacts.map((artifact) => {
                      const style = ARTIFACT_STYLE[artifact.kind] ?? { label: '产物', className: 'bg-muted text-muted-foreground' };
                      return (
                        <li key={artifact.path} className="flex items-start gap-2">
                          <span className={cn('mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium', style.className)}>
                            {style.label}
                          </span>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-xs font-medium">{artifact.label}</p>
                            <button
                              type="button"
                              className="block w-full truncate text-left font-mono text-[11px] text-muted-foreground transition hover:text-foreground"
                              title="点击复制完整路径"
                              onClick={() => void copyPath(artifact.path)}
                            >
                              {artifact.path}
                            </button>
                          </div>
                          <span className="shrink-0 text-[11px] text-muted-foreground">
                            {copied === artifact.path ? '已复制' : `${artifact.size_mb}MB`}
                          </span>
                          {artifact.kind === 'model' ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-6 shrink-0 px-2 text-[11px]"
                              onClick={() => void renameArtifact(artifact, onChanged)}
                            >
                              改名
                            </Button>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** 训练记录的时间戳（毫秒）→ 本地时间简写 */
function formatTime(ms: number): string {
  if (!ms) return '—';
  const date = new Date(ms);
  return `${date.getMonth() + 1}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/**
 * 给一个训练产出的模型改名。用 `window.prompt` 是刻意选择：
 * 改名是一次低频、单字段的操作，为它引一整套弹窗组件不划算；
 * 原生 prompt 在桌面端行为稳定，且天然带默认值。
 */
async function renameArtifact(artifact: VcTrainArtifact, onChanged: () => void): Promise<void> {
  const current = artifact.path.split(/[\\/]/).pop()?.replace(/\.pth$/i, '') ?? '';
  const next = window.prompt('新的音色名称（会同时重命名配套索引）', current);
  if (next === null) return;
  const trimmed = next.trim();
  if (!trimmed || trimmed === current) return;
  try {
    const result = await vcApi.renameModel(current, trimmed);
    toast.success(result.message ?? '已重命名');
    onChanged();
  } catch (cause) {
    toast.error('重命名失败', { description: (cause as RequestError).fullMessage });
  }
}

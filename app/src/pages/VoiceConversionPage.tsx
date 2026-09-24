import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Upload, Waves } from 'lucide-react';
import { ABPlayer } from '@/components/features/ABPlayer';
import { JobPanel } from '@/components/features/JobPanel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { resolveAudioUrl, vcApi } from '@/lib/vc';
import type { SovitsJob, VcCatalog, VcModel } from '@/types';

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
export function VoiceConversionPage() {
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

  if (loadError) {
    return (
      <Card className="border-amber-500/40 bg-amber-500/5">
        <CardHeader>
          <CardTitle className="text-amber-700 dark:text-amber-400">本地服务未就绪</CardTitle>
          <CardDescription>{loadError}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      <EngineBadge catalog={catalog} onRefresh={refresh} accent={ACCENT_TEXT} />
      <ModelLibrary catalog={catalog} onChanged={refresh} accent={ACCENT_SOLID} />
      <ConvertCard catalog={catalog} accentText={ACCENT_TEXT} accentSolid={ACCENT_SOLID} onChanged={refresh} />
      <WorkshopCard catalog={catalog} accentSolid={ACCENT_SOLID} onChanged={refresh} />
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
    } finally {
      setPending(false);
      if (weightRef.current) weightRef.current.value = '';
      if (indexRef.current) indexRef.current.value = '';
    }
  };

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
      <CardContent className="space-y-3">
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
  const [model, setModel] = useState('');
  const [keyShift, setKeyShift] = useState(0);
  const [f0Method, setF0Method] = useState('rmvpe');
  const [indexRate, setIndexRate] = useState(0.3);
  const [protect, setProtect] = useState(0.33);
  const [jobId, setJobId] = useState<string | null>(null);
  const [outputUrl, setOutputUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

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
      else setOutputUrl(resolveAudioUrl(result.output));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  };

  const onJobDone = (job: SovitsJob) => {
    const output = (job.artifacts as { output?: string } | null)?.output;
    if (output) setOutputUrl(resolveAudioUrl(output));
    onChanged();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">开始变声</CardTitle>
        <CardDescription>上传一段说话 / 配音干声（建议 ≤5 分钟），保留内容与语气，只替换音色。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="vc-audio">源音频</Label>
            <input
              id="vc-audio"
              type="file"
              accept="audio/*"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              className="w-full cursor-pointer rounded-lg border bg-background px-3 py-2 text-xs file:mr-3 file:rounded-md file:border-0 file:bg-muted file:px-2 file:py-1 file:text-xs"
            />
            {sourceUrl ? (
              <audio src={sourceUrl} controls preload="metadata" className="mt-1 w-full" />
            ) : null}
          </div>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>目标音色</Label>
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
                <Label>F0 方法</Label>
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
                <Label>变调（半音）</Label>
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

        {outputUrl && sourceUrl ? (
          <div className="rounded-xl border p-3">
            <p className="mb-2 text-xs font-medium text-muted-foreground">原声 / 变声 A·B 对比</p>
            <ABPlayer
              accentClass={accentSolid}
              tracks={[
                { label: '原声', url: sourceUrl },
                { label: '变声后', url: outputUrl },
              ]}
            />
          </div>
        ) : outputUrl ? (
          <audio src={outputUrl} controls className="w-full" />
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
            <TabsTrigger value="merge">音色融合</TabsTrigger>
            <TabsTrigger value="lora">LoRA 微调</TabsTrigger>
          </TabsList>
          <TabsContent value="merge" className="pt-4">
            <MergeTab models={modelNames} accentSolid={accentSolid} onChanged={onChanged} />
          </TabsContent>
          <TabsContent value="lora" className="pt-4">
            <LoraTab models={modelNames} accentSolid={accentSolid} />
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

function LoraTab({ models, accentSolid }: { models: string[]; accentSolid: string }) {
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
          <Label>底模（.pth，训练一次后所有音色共用）</Label>
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
      <JobPanel jobId={jobId} accent={accentSolid.replace('bg-indigo-600', 'text-indigo-500').replace(' text-white', '')} title="训练任务" />
    </div>
  );
}

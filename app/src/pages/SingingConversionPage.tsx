import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Music2, Scissors } from 'lucide-react';
import { ABPlayer } from '@/components/features/ABPlayer';
import { JobPanel } from '@/components/features/JobPanel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { resolveAudioUrl, svcApi, uvrApi } from '@/lib/vc';
import type { SovitsJob, SvcCatalog } from '@/types';

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
export function SingingConversionPage() {
  const [catalog, setCatalog] = useState<SvcCatalog | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    svcApi
      .catalog()
      .then(setCatalog)
      .catch((error: Error) => setLoadError(error.message));
  }, []);

  useEffect(() => {
    void refresh();
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
      <div className="flex items-center gap-2">
        <EngineBadge catalog={catalog} />
      </div>
      <CoverWizard catalog={catalog} onChanged={refresh} />
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
  const [artifacts, setArtifacts] = useState<{ label: string; url: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const patch = (changes: Partial<CoverState>) => setState((prev) => ({ ...prev, ...changes }));

  const sourceUrl = useMemo(() => (state.file ? URL.createObjectURL(state.file) : null), [state.file]);

  const submit = async () => {
    if (!state.file || !state.model) {
      setError('请先选择歌曲与目标音色');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await svcApi.cover({
        file: state.file,
        model: state.model,
        key: state.key,
        f0_method: state.f0Method,
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
      else setArtifacts(collectArtifacts({ ...(result.artifacts ?? {}) }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const onJobDone = (job: SovitsJob) => {
    const produced = (job.artifacts as { artifacts?: Record<string, string>; urls?: Record<string, string> } | null) ?? {};
    setArtifacts(collectArtifacts(produced.artifacts ?? produced.urls ?? {}));
    onChanged();
  };

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
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="svc-song">歌曲</Label>
            <input
              id="svc-song"
              type="file"
              accept="audio/*"
              onChange={(event) => patch({ file: event.target.files?.[0] ?? null })}
              className="w-full cursor-pointer rounded-lg border bg-background px-3 py-2 text-xs file:mr-3 file:rounded-md file:border-0 file:bg-muted file:px-2 file:py-1 file:text-xs"
            />
            {sourceUrl ? <audio src={sourceUrl} controls preload="metadata" className="mt-1 w-full" /> : null}

            <div className="space-y-1.5 pt-2">
              <Label>人声分离</Label>
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
              <Label>二级处理</Label>
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
                <p className="text-xs font-medium">长音频自动切分</p>
                <p className="text-[11px] text-muted-foreground">按静音分段推理，避免 8GB 显存峰值溢出</p>
              </div>
              <Switch checked={sliceSegments} onCheckedChange={setSliceSegments} />
            </div>
          </div>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>目标音色</Label>
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
                <Label>音质</Label>
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
                <Label>F0 方法</Label>
                <Select value={state.f0Method} onValueChange={(v) => patch({ f0Method: v })}>
                  <SelectTrigger className="w-full"><SelectValue placeholder="跟随模型" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">跟随模型</SelectItem>
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

        {artifacts.length > 0 ? (
          <div className="rounded-xl border p-3">
            <p className="mb-2 text-xs font-medium text-muted-foreground">产物（点击标签切换试听）</p>
            <ABPlayer accentClass={ACCENT_SOLID} tracks={artifacts.map((item) => ({ label: item.label, url: item.url }))} />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function collectArtifacts(raw: Record<string, string>): { label: string; url: string }[] {
  const labels: Array<[string, string]> = [
    ['vocal', '新人声'],
    ['instrumental', '伴奏'],
    ['mix', '混音'],
    ['output', '转换结果'],
  ];
  return labels
    .filter(([key]) => raw[key])
    .map(([key, label]) => ({ label, url: resolveAudioUrl(raw[key]) ?? raw[key] }));
}

/** 独立分离卡片：只要人声 / 伴奏，产物进缓存，翻唱向导可直接复用 */
function SeparateOnlyCard() {
  const [file, setFile] = useState<File | null>(null);
  const [preset, setPreset] = useState('vocal_fast');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ vocal: string | null; instrumental: string | null; cached: boolean; elapsed_s: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const payload = await uvrApi.separate({ file, preset, wait: true });
      if (!payload.ok) throw new Error('分离失败');
      setResult({
        vocal: payload.urls?.vocal ?? payload.vocal,
        instrumental: payload.urls?.instrumental ?? payload.instrumental,
        cached: payload.cached,
        elapsed_s: payload.elapsed_s ?? 0,
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
        <div className="flex flex-wrap items-end gap-3">
          <input
            type="file"
            accept="audio/*"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            className="w-full max-w-sm cursor-pointer rounded-lg border bg-background px-3 py-2 text-xs file:mr-3 file:rounded-md file:border-0 file:bg-muted file:px-2 file:py-1 file:text-xs"
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
        {result ? (
          <div className="rounded-xl border p-3">
            <p className="mb-2 text-xs text-muted-foreground">
              {result.cached ? '命中缓存' : `本次耗时 ${result.elapsed_s.toFixed(1)}s`} · 下次换音色重跑可跳过这一步
            </p>
            <ABPlayer
              accentClass={ACCENT_SOLID}
              tracks={[
                ...(result.vocal ? [{ label: '人声', url: resolveAudioUrl(result.vocal) ?? '' }] : []),
                ...(result.instrumental ? [{ label: '伴奏', url: resolveAudioUrl(result.instrumental) ?? '' }] : []),
              ]}
            />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

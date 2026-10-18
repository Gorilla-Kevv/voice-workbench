import { useCallback, useEffect, useState } from 'react';
import { Flame, Loader2, Play, Waves } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { ErrorAlert } from '@/components/features/ErrorAlert';
import { ResourceBudget } from '@/components/features/ResourceBudget';
import { ResultStack, type ResultStackEntry } from '@/components/features/ResultStack';
import { focusBeforeRun } from '@/lib/arbiter';
import { RequestError } from '@/lib/errors';
import { gsv5Api, gsv5Base64ToUrl } from '@/lib/gsv5';
import { notifyServiceEnabledChanged, runtimeServiceApi } from '@/lib/localService';
import { useResultStack } from '@/hooks/useResultStack';
import type { Gsv5Catalog, Gsv5Health, Gsv5Variant } from '@/types/gsv5';

interface Gsv5ResultItem {
  variant: Gsv5Variant;
  audioUrl: string;
  text: string;
  durationSec: number;
  elapsedSec: number;
  rtf: number;
  createdAt: number;
}

/**
 * GPT-SoVITS v5 合成页（gsv5/，:9885，第五运行时）。
 *
 * v5 现阶段是纯推理底模（上游无 v5 训练配置）：参考音频必需（v3/v4/v2Pro 同款零样本链路），
 * 变体 turbo=4 步 / dev=32 步。训练仍走「音色微调训练」页（整合包 v2ProPlus）。
 */
export function Gsv5Page() {
  const [health, setHealth] = useState<Gsv5Health | null>(null);
  const [catalog, setCatalog] = useState<Gsv5Catalog | null>(null);
  const [serviceState, setServiceState] = useState<boolean | null>(null);
  const [starting, setStarting] = useState(false);
  const [warming, setWarming] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<RequestError | null>(null);

  const [text, setText] = useState('GPT-SoVITS 第五代本地合成：免微调、音色相似度更高、高频伪影更少。');
  const [variant, setVariant] = useState<Gsv5Variant>('v5turbo');
  const [refSource, setRefSource] = useState<'voice' | 'path'>('voice');
  const [voiceId, setVoiceId] = useState('');
  const [refPath, setRefPath] = useState('');
  const [promptText, setPromptText] = useState('');
  const [promptLang, setPromptLang] = useState('zh');
  const [speedFactor, setSpeedFactor] = useState(1.0);

  const results = useResultStack<Gsv5ResultItem>({ storageKey: 'gsv5-results' });

  const refresh = useCallback(() => {
    void gsv5Api.health().then(setHealth).catch(() => setHealth(null));
    void gsv5Api.catalog().then(setCatalog).catch(() => null);
  }, []);

  useEffect(() => {
    refresh();
    runtimeServiceApi
      .state('gsv5')
      .then((state) => setServiceState(state.enabled))
      .catch(() => setServiceState(null));
  }, [refresh]);

  const startService = async () => {
    setStarting(true);
    try {
      const result = await runtimeServiceApi.toggle('gsv5', true);
      toast.success('GPT-SoVITS v5 服务已启动', { description: result.hint });
      notifyServiceEnabledChanged();
      setServiceState(true);
      refresh();
    } catch (requestError) {
      toast.error('启动失败', { description: (requestError as RequestError).fullMessage });
    } finally {
      setStarting(false);
    }
  };

  const warmup = async () => {
    setWarming(true);
    setError(null);
    try {
      // 载入显存前先让本系统内其它服务的常驻模型让位（30-8 同款姿势）
      await focusBeforeRun('gpt-sovits-v5', 3600);
      await gsv5Api.warmup(variant);
      refresh();
      toast.success(`已载入 ${variant} 显存`);
    } catch (requestError) {
      const e = requestError instanceof RequestError ? requestError : new RequestError(0, { code: 'WARMUP_FAILED', message: '预热失败', retryable: true });
      setError(e);
      toast.error('预热失败', { description: e.fullMessage });
    } finally {
      setWarming(false);
    }
  };

  const synth = () => {
    if (!text.trim()) {
      setError(new RequestError(400, { code: 'MISSING_INPUT', message: '文本不能为空', retryable: false, hint: '填入要合成的文本。' }));
      return;
    }
    if (refSource === 'voice' && !voiceId) {
      setError(new RequestError(400, { code: 'REF_REQUIRED', message: '先选一个音色库音色', retryable: false, hint: 'v5 零样本克隆必须有参考音频。' }));
      return;
    }
    if (refSource === 'path' && !refPath.trim()) {
      setError(new RequestError(400, { code: 'REF_REQUIRED', message: '先填参考音频本地路径', retryable: false, hint: 'v5 零样本克隆必须有参考音频。' }));
      return;
    }
    setError(null);
    setLoading(true);
    void (async () => {
      try {
        void focusBeforeRun('gpt-sovits-v5', 3600);
        const response = await gsv5Api.synthesize({
          text,
          text_lang: 'zh',
          variant,
          ...(refSource === 'voice' ? { ref_voice: voiceId } : { ref_audio_path: refPath.trim() }),
          ...(promptText.trim() ? { prompt_text: promptText.trim() } : {}),
          prompt_lang: promptLang,
          speed_factor: speedFactor,
        });
        results.push({
          variant: response.variant,
          audioUrl: gsv5Base64ToUrl(response.audio_base64),
          text,
          durationSec: response.duration_sec,
          elapsedSec: response.elapsed_sec,
          rtf: response.rtf,
          createdAt: Date.now(),
        });
        toast.success('合成完成', {
          description: `${response.duration_sec.toFixed(1)} 秒音频 · ${response.elapsed_sec.toFixed(1)} 秒生成 · RTF ${response.rtf}`,
        });
      } catch (rawError) {
        const requestError =
          rawError instanceof RequestError
            ? rawError
            : new RequestError(0, { code: 'SYNTH_FAILED', message: (rawError as Error)?.message || '合成请求未能发出', retryable: true });
        setError(requestError);
        toast.error('合成失败', { description: requestError.fullMessage });
      } finally {
        setLoading(false);
        refresh();
      }
    })();
  };

  const entries: ResultStackEntry[] = results.entries.map((entry) => ({
    id: entry.id,
    createdAt: entry.createdAt,
    title: `${entry.item.variant}`,
    subtitle: `${entry.item.durationSec.toFixed(1)}s · RTF ${entry.item.rtf}`,
    summary: entry.item.text.slice(0, 60),
    content: (
      <div className="space-y-2">
        <audio controls src={entry.item.audioUrl} className="w-full" />
        <p className="text-[11px] text-muted-foreground">{entry.item.text}</p>
        <a
          href={entry.item.audioUrl}
          download={`gsv5-${entry.item.variant}-${new Date(entry.createdAt).toISOString().slice(0, 19).replaceAll(':', '-')}.wav`}
          className="text-xs text-violet-600 underline-offset-2 hover:underline dark:text-violet-400"
        >
          下载 WAV
        </a>
      </div>
    ),
  }));

  const weightsReady = health ? Object.values(health.weights).every(Boolean) : false;

  return (
    <div className="grid gap-4 lg:grid-cols-5">
      <div className="space-y-4 lg:col-span-3">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">GPT-SoVITS v5（gsv5 · :9885）</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {health ? (
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span>
                  变体 {health.engine.variant ?? '未加载'} · 显存门槛 {health.engine.required_vram_mb ?? '—'} MB · 空闲{' '}
                  {health.engine.vram_free_mb ?? '—'} MB
                </span>
                <Button variant="outline" size="sm" className="h-7 text-xs" disabled={warming || !weightsReady} onClick={() => void warmup()}>
                  {warming ? <Loader2 className="size-3 animate-spin" /> : <Flame className="size-3" />}
                  载入显存
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  disabled={!health.engine.loaded}
                  onClick={() => void gsv5Api.unload().then(refresh).then(() => toast.success('已释放显存')).catch(() => null)}
                >
                  释放显存
                </Button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span>GPT-SoVITS v5 服务未启动（第五运行时，默认不随主程序拉起）。</span>
                <Button variant="outline" size="sm" className="h-7 text-xs" disabled={starting || serviceState === false} onClick={() => void startService()}>
                  {starting ? <Loader2 className="size-3 animate-spin" /> : null}
                  {serviceState === false ? '先在设置页开启服务' : '启动 v5 服务'}
                </Button>
              </div>
            )}
            {health && !weightsReady ? (
              <p className="text-xs text-amber-700 dark:text-amber-300">
                v5 权重不齐：需要 <code className="mx-1 rounded bg-muted px-1">gsv5/upstream/GPT_SoVITS/pretrained_models/gsv-v5-pretrained/</code>
                三件套与 s1v3.ckpt（见 PROGRESS 阶段 36）。
              </p>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">合成内容</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>变体</Label>
                <Select value={variant} onValueChange={(value) => setVariant(value as Gsv5Variant)}>
                  <SelectTrigger className="h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(catalog?.variants ?? []).map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>语速</Label>
                  <span className="text-[11px] tabular-nums text-muted-foreground">{speedFactor.toFixed(2)}</span>
                </div>
                <Slider value={[speedFactor]} min={0.5} max={2} step={0.05} onValueChange={([value]) => setSpeedFactor(value ?? 1)} />
              </div>
            </div>

            <div className="space-y-2">
              <Label>文本（切分交给服务端）</Label>
              <Textarea value={text} onChange={(event) => setText(event.target.value)} rows={4} />
            </div>

            <Tabs value={refSource} onValueChange={(value) => setRefSource(value as 'voice' | 'path')}>
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="voice">音色库</TabsTrigger>
                <TabsTrigger value="path">本地路径</TabsTrigger>
              </TabsList>
            </Tabs>
            {refSource === 'voice' ? (
              <div className="space-y-2">
                <Label>音色库音色（参考音频必需，v3 系零样本链路）</Label>
                <VoiceSelect value={voiceId} onChange={setVoiceId} />
              </div>
            ) : (
              <div className="space-y-2">
                <Label>参考音频本地路径</Label>
                <Input value={refPath} onChange={(event) => setRefPath(event.target.value)} placeholder="F:\...\ref.wav" />
              </div>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>参考音频转写（逐字，可选但强烈建议）</Label>
                <Input value={promptText} onChange={(event) => setPromptText(event.target.value)} placeholder="参考音频里说的话" />
              </div>
              <div className="space-y-2">
                <Label>参考语种</Label>
                <Select value={promptLang} onValueChange={setPromptLang}>
                  <SelectTrigger className="h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(catalog?.languages ?? ['zh']).map((lang) => (
                      <SelectItem key={lang} value={lang}>
                        {lang}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <Button className="w-full" disabled={loading || !health} onClick={synth}>
              {loading ? <Loader2 className="mr-1 size-4 animate-spin" /> : <Play className="mr-1 size-4" />}
              开始合成（{variant}）
            </Button>
            {error ? <ErrorAlert error={error} onDismiss={() => setError(null)} /> : null}
          </CardContent>
        </Card>
      </div>

      <div className="space-y-4 lg:col-span-2">
        <ResourceBudget task="gpt-sovits-v5" />
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Waves className="size-4 text-violet-600 dark:text-violet-400" />
              结果
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ResultStack
              entries={entries}
              onRemove={results.remove}
              onClear={results.clear}
              empty={<p className="text-xs text-muted-foreground">合成结果会堆叠在这里；切页再回来不丢。</p>}
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/** 音色库下拉（ref_voice）：直接走网关共享库 */
function VoiceSelect({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [voices, setVoices] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    void fetch('/api/voicelib/')
      .then((response) => response.json())
      .then((data: { voices?: { id: string; name: string }[] }) => setVoices(data.voices ?? []))
      .catch(() => setVoices([]));
  }, []);
  return (
    <Select value={value || undefined} onValueChange={onChange}>
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
  );
}

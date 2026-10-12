import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Cpu, Info, Loader2, RefreshCw, Waves } from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { TermTip } from '@/components/features/TermTip';
import { sovitsApi } from '@/lib/sovits';
import { voiceApi } from '@/lib/voices';
import { cn } from '@/lib/utils';
import type { SovitsCatalog, SovitsVoice, SovitsWeightList } from '@/types';

/** 权重来源：零样本走官方底模，微调走自己训出来的那对权重。 */
export type SovitsWeightMode = 'zero-shot' | 'finetuned';

export interface SovitsSelection {
  voiceId: string;
  version: string;
  textLang: string;
  splitMethod: string;
  promptLang: string;
  /** 用官方底模（零样本）还是自训权重（微调） */
  weightMode: SovitsWeightMode;
  /** 自训 GPT 权重绝对路径（仅 weightMode === 'finetuned' 时随请求下发） */
  gpt?: string;
  /** 自训 SoVITS 权重绝对路径（同上） */
  sovits?: string;
}

interface SovitsVoicePickerProps {
  value: SovitsSelection;
  onChange: (next: SovitsSelection) => void;
}

/**
 * GPT-SoVITS 的音色选择器。
 *
 * 与 MiMo 的 `VoicePicker` 形态相似但语义完全不同：这里列的是**你导入的参考音频**，
 * 而不是官方预置音色。默认把音色库拉一遍并自动选中第一个可用音色，
 * 让「切到本地模型就能直接试」成立。
 */
export function SovitsVoicePicker({ value, onChange }: SovitsVoicePickerProps) {
  const [voices, setVoices] = useState<SovitsVoice[]>([]);
  const [catalog, setCatalog] = useState<SovitsCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 自训权重（微调模式用）
  const [weights, setWeights] = useState<SovitsWeightList | null>(null);
  const [weightsLoading, setWeightsLoading] = useState(false);
  const [weightsError, setWeightsError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [voiceResult, catalogResult] = await Promise.all([
        voiceApi.listVoices(),
        sovitsApi.catalog().catch(() => null),
      ]);
      setVoices(voiceResult.voices);
      if (catalogResult) setCatalog(catalogResult.catalog);
      setError(null);
      if (!value.voiceId && voiceResult.voices.length > 0) {
        onChange({ ...value, voiceId: voiceResult.voices[0].id });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '无法读取音色库');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // 只在首次挂载时拉取；用户点「刷新」时手动重新拉
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * 拉自训权重清单（`/v1/weights`）。
   *
   * 只在「微调」模式下才需要 —— 零样本走官方底模，拉回来也是白拉。
   * 换版本要重拉：该端点是**按版本过滤**的。
   */
  const loadWeights = useCallback(async () => {
    setWeightsLoading(true);
    try {
      const result = await sovitsApi.weights(value.version);
      setWeights(result);
      setWeightsError(null);
      // 给一对合理默认值：优先带 `trained` 的（自己训出来的），其次列表第一个。
      // 注意两处 patch 要合成**一次** onChange —— 分两次会拿同一个旧 value 互相覆盖。
      const patch: Partial<SovitsSelection> = {};
      const firstGpt = result.gpt.find((item) => item.trained) ?? result.gpt[0];
      const firstSovits = result.sovits.find((item) => item.trained) ?? result.sovits[0];
      if (!value.gpt && firstGpt) patch.gpt = firstGpt.path;
      if (!value.sovits && firstSovits) patch.sovits = firstSovits.path;
      if (Object.keys(patch).length > 0) onChange({ ...value, ...patch });
    } catch (err) {
      setWeights(null);
      setWeightsError(err instanceof Error ? err.message : '无法读取权重清单');
    } finally {
      setWeightsLoading(false);
    }
  }, [value, onChange]);

  useEffect(() => {
    if (value.weightMode !== 'finetuned') return;
    void loadWeights();
    // 只在切到微调模式 / 换版本时重拉：onChange 每次都换新引用，进了依赖就是死循环
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.weightMode, value.version]);

  /** 把选中的那对权重热加载进显存 —— 等价于官方 WebUI 的「加载模型」按钮。 */
  const applyWeights = async () => {
    if (!value.gpt || !value.sovits) return;
    setApplying(true);
    try {
      await sovitsApi.loadWeights({ version: value.version, gpt: value.gpt, sovits: value.sovits });
      toast.success('权重已加载到显存', { description: '接下来这条合成会用这对权重。' });
      void loadWeights();
    } catch (err) {
      toast.error('加载失败', { description: err instanceof Error ? err.message : String(err) });
    } finally {
      setApplying(false);
    }
  };

  const selected = voices.find((voice) => voice.id === value.voiceId);

  /**
   * 「参考音频语种」与「合成文本语种」是两个独立的参数（官方强调的易混淆点）：
   * 前者跟随音色库里的标注（本页不可改），后者才是这个下拉。两者允许不同 ——
   * 那正是官方支持的跨语言合成。
   */
  const langLabel = (id: string) => catalog?.languages.find((item) => item.id === id)?.label ?? id;
  const crossLingual = Boolean(selected) && value.promptLang !== value.textLang;

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs">
        <p className="flex items-center gap-1.5 font-medium text-destructive">
          <AlertTriangle className="size-3.5" />
          音色库读取失败
        </p>
        <p className="mt-1 text-muted-foreground">{error}</p>
        <Button size="sm" variant="outline" className="mt-2" onClick={() => void load()}>
          <RefreshCw className="mr-1.5 size-3" />
          重试
        </Button>
      </div>
    );
  }

  const activeGpt = weights?.active.gpt ?? null;
  const activeSovits = weights?.active.sovits ?? null;
  const selectedGpt = weights?.gpt.find((item) => item.path === value.gpt);
  const selectedSovits = weights?.sovits.find((item) => item.path === value.sovits);
  /** 选中的这对权重是否**已经**在显存里 —— 决定「加载到显存」按钮要不要高亮 */
  const weightsActive =
    Boolean(activeGpt && activeSovits) && activeGpt === value.gpt && activeSovits === value.sovits;

  return (
    <div className="space-y-3">
      {/*
        权重来源：这是「零样本 vs 微调」的分叉点。
        注意它**不是**「参考音频 / 权重」二选一 —— 参考音频在两种模式下都必需
        （`synth.py::resolve_reference()` 拿不到参考音频就直接报错），
        这里选的只是「用官方底模，还是用自己训的那对权重」。
      */}
      <Tabs
        value={value.weightMode}
        onValueChange={(next) => onChange({ ...value, weightMode: next as SovitsWeightMode })}
      >
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="zero-shot">零样本（官方底模）</TabsTrigger>
          <TabsTrigger value="finetuned">微调模型（自训权重）</TabsTrigger>
        </TabsList>

        <TabsContent value="zero-shot" className="pt-3">
          <p className="text-[11px] leading-snug text-muted-foreground">
            用官方底模 + 一段 3~10 秒参考音频直接合成，<strong>不需要训练</strong>。
            音色像不像主要取决于参考音频的干净程度与时长。
          </p>
        </TabsContent>

        <TabsContent value="finetuned" className="space-y-2 pt-3">
          <div className="flex items-center justify-between">
            <Label className="flex items-center gap-1.5 text-xs">
              <Cpu className="size-3.5" />
              GPT + SoVITS 权重（一对）
            </Label>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2"
              onClick={() => void loadWeights()}
              disabled={weightsLoading}
            >
              <RefreshCw className={cn('size-3', weightsLoading && 'animate-spin')} />
            </Button>
          </div>

          {weightsError ? (
            <p className="text-xs text-destructive">权重清单读取失败：{weightsError}</p>
          ) : null}

          <div className="grid gap-2 sm:grid-cols-2">
            <Select
              value={value.gpt ?? ''}
              onValueChange={(next) => onChange({ ...value, gpt: next })}
              disabled={weightsLoading || !weights?.gpt.length}
            >
              <SelectTrigger className="h-9">
                <SelectValue placeholder={weightsLoading ? '读取中…' : '选择 GPT 权重'} />
              </SelectTrigger>
              <SelectContent>
                {(weights?.gpt ?? []).map((item) => (
                  <SelectItem key={item.path} value={item.path}>
                    <span className="flex items-center gap-2">
                      {item.name}
                      {item.trained ? (
                        <Badge variant="secondary" className="h-4 text-[10px] font-normal">
                          自训
                        </Badge>
                      ) : null}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={value.sovits ?? ''}
              onValueChange={(next) => onChange({ ...value, sovits: next })}
              disabled={weightsLoading || !weights?.sovits.length}
            >
              <SelectTrigger className="h-9">
                <SelectValue placeholder={weightsLoading ? '读取中…' : '选择 SoVITS 权重'} />
              </SelectTrigger>
              <SelectContent>
                {(weights?.sovits ?? []).map((item) => (
                  <SelectItem key={item.path} value={item.path}>
                    <span className="flex items-center gap-2">
                      {item.name}
                      {item.trained ? (
                        <Badge variant="secondary" className="h-4 text-[10px] font-normal">
                          自训
                        </Badge>
                      ) : null}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {!weightsLoading && weights && weights.gpt.length === 0 && weights.sovits.length === 0 ? (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              这个版本下没有任何权重。到「音色微调训练」页跑一次训练，产物会自动出现在这里。
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant={weightsActive ? 'outline' : 'default'}
              className="h-7 text-xs"
              disabled={applying || !value.gpt || !value.sovits}
              onClick={() => void applyWeights()}
            >
              {applying ? <Loader2 className="mr-1.5 size-3 animate-spin" /> : null}
              {weightsActive ? '已加载（重新加载）' : '加载到显存'}
            </Button>
            {weightsActive ? (
              <span className="text-[11px] text-muted-foreground">
                显存中：{selectedGpt?.name ?? '?'} + {selectedSovits?.name ?? '?'}
              </span>
            ) : activeGpt && activeSovits ? (
              <span className="text-[11px] text-muted-foreground">
                当前显存里是另一对权重 —— 不点「加载到显存」的话，合成用的还是它。
              </span>
            ) : null}
          </div>

          <p className="text-[11px] leading-snug text-muted-foreground">
            微调模型<strong>同样需要</strong>一段该说话人的参考音频作为提示 —— 下面的参考音频照常选。
            训练产物若不在本页版本下（比如训的是 v2 而这里选了 v2ProPlus），列表里不会出现。
          </p>
        </TabsContent>
      </Tabs>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="flex items-center gap-1.5">
            <Waves className="size-3.5" />
            参考音频
            <span className="text-[11px] font-normal text-muted-foreground">（两种模式都要选）</span>
          </Label>
          <Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={cn('size-3', loading && 'animate-spin')} />
          </Button>
        </div>
        <Select
          value={value.voiceId}
          onValueChange={(next) => {
            const voice = voices.find((item) => item.id === next);
            onChange({ ...value, voiceId: next, promptLang: voice?.prompt_lang ?? value.promptLang });
          }}
          disabled={loading || voices.length === 0}
        >
          <SelectTrigger>
            <SelectValue
              placeholder={loading ? '正在读取音色库…' : voices.length === 0 ? '音色库为空' : '选择音色'}
            />
          </SelectTrigger>
          <SelectContent>
            {voices.map((voice) => (
              <SelectItem key={voice.id} value={voice.id}>
                <span className="flex items-center gap-2">
                  {voice.name}
                  <span className="text-xs text-muted-foreground">
                    {voice.duration_s ? `${voice.duration_s.toFixed(1)}s` : '时长未知'}
                  </span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {loading ? (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />
            正在读取本地音色库…
          </p>
        ) : voices.length === 0 ? (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            音色库为空。GPT-SoVITS 没有内置音色，请先到「音色库」导入一段 3~10 秒的参考音频。
          </p>
        ) : selected?.warnings.length ? (
          <p className="text-xs text-amber-600 dark:text-amber-400">{selected.warnings[0]}</p>
        ) : null}
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-2">
          <Label className="text-xs">模型版本</Label>
          <Select value={value.version} onValueChange={(next) => onChange({ ...value, version: next })}>
            <SelectTrigger className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(catalog?.versions ?? [{ id: 'v2ProPlus', label: 'v2ProPlus' }]).map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label className="text-xs">
            <TermTip term="文本语种">合成文本语种</TermTip>
          </Label>
          <Select value={value.textLang} onValueChange={(next) => onChange({ ...value, textLang: next })}>
            <SelectTrigger className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(catalog?.languages ?? [{ id: 'zh', label: '中文' }]).map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label className="text-xs">切分方式</Label>
          <Select value={value.splitMethod} onValueChange={(next) => onChange({ ...value, splitMethod: next })}>
            <SelectTrigger className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(catalog?.text_split_methods ?? [{ id: 'cut5', label: 'cut5' }]).map((item) => (
                <SelectItem key={item.id} value={item.id} title={item.note}>
                  {item.id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <p className="text-[11px] leading-snug text-muted-foreground">
        「合成文本语种」是要合成的文本的语种；参考音频的语种跟随音色库里的标注 ——
        两者是两个独立的参数，可以不同（跨语言合成）
      </p>
      {crossLingual ? (
        <p className="flex items-start gap-1.5 rounded-lg bg-sky-500/10 p-2 text-xs text-sky-700 dark:text-sky-300">
          <Info className="mt-0.5 size-3.5 shrink-0" />
          <span>
            当前参考音频语种为「{langLabel(value.promptLang)}」，合成文本语种为「{langLabel(value.textLang)}」
            —— 这属于跨语言合成，可以正常使用。若出现怪异发音，优先核对这两处是否选对。
          </span>
        </p>
      ) : null}

      <div className="flex flex-wrap gap-1.5">
        <Badge variant="secondary" className="h-5 text-[10px] font-normal">
          零样本 5 秒起
        </Badge>
        <Badge variant="secondary" className="h-5 text-[10px] font-normal">
          少样本微调 1 分钟起
        </Badge>
        <Badge variant="secondary" className="h-5 text-[10px] font-normal">
          支持中英日韩粤跨语言
        </Badge>
        <Badge variant="secondary" className="h-5 text-[10px] font-normal">
          数据不出本机
        </Badge>
      </div>
    </div>
  );
}

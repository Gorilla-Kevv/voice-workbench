import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Cpu, Loader2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { sovitsApi } from '@/lib/sovits';
import { cn } from '@/lib/utils';
import type { SovitsCatalog, SovitsWeightList } from '@/types';

/** 权重来源：零样本走官方底模，微调走权重文件（可只选一侧）。 */
export type SovitsWeightMode = 'zero-shot' | 'finetuned';

export interface SovitsWeightSelection {
  version: string;
  weightMode: SovitsWeightMode;
  /** GPT 权重绝对路径；不填 = 同版本预训练 GPT 底模 */
  gpt?: string;
  /** SoVITS 权重绝对路径；不填 = 同版本预训练 SoVITS 底模 */
  sovits?: string;
}

interface SovitsWeightPickerProps {
  value: SovitsWeightSelection;
  onChange: (next: SovitsWeightSelection) => void;
}

const PRETRAINED = '__pretrained__';
const FALLBACK_VERSIONS = ['v2ProPlus', 'v2Pro', 'v2', 'v4', 'v3', 'v1'];

const baseName = (path?: string | null) => (path ? path.split(/[\\/]/).pop() ?? path : '');
const sameWeight = (a?: string | null, b?: string | null) =>
  Boolean(a && b) && (a === b || baseName(a) === baseName(b));

/**
 * GPT-SoVITS 权重选择器（批量合成页用）。
 *
 * 与参考音频选择分离：参考音频决定「谁在说」，这里的权重决定「用哪套音色模型」。
 * 允许只选一侧 —— 纯 .pth 下载模型是常见形态，另一侧显式落到同版本预训练底模；
 * WDDM 下 `active` 只报文件名，所以「是否已加载」按 basename 比对。
 */
export function SovitsWeightPicker({ value, onChange }: SovitsWeightPickerProps) {
  const [catalog, setCatalog] = useState<SovitsCatalog | null>(null);
  const [weights, setWeights] = useState<SovitsWeightList | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    void sovitsApi
      .catalog()
      .then((result) => setCatalog(result.catalog))
      .catch(() => setCatalog(null));
  }, []);

  const loadWeights = useCallback(async () => {
    setLoading(true);
    try {
      const result = await sovitsApi.weights(value.version);
      setWeights(result);
      setError(null);
    } catch (err) {
      setWeights(null);
      setError(err instanceof Error ? err.message : '无法读取权重清单');
    } finally {
      setLoading(false);
    }
  }, [value.version]);

  useEffect(() => {
    if (value.weightMode !== 'finetuned') return;
    void loadWeights();
  }, [value.weightMode, loadWeights]);

  const applyWeights = async () => {
    if (!value.gpt && !value.sovits) return;
    setApplying(true);
    try {
      await sovitsApi.loadWeights({
        version: value.version,
        gpt: value.gpt,
        sovits: value.sovits,
      });
      toast.success('权重已加载到显存', {
        description: value.gpt && value.sovits ? '接下来用这对权重合成。' : '缺的一侧已自动使用同版本预训练底模。',
      });
      void loadWeights();
    } catch (err) {
      toast.error('加载失败', { description: err instanceof Error ? err.message : String(err) });
    } finally {
      setApplying(false);
    }
  };

  const versions =
    catalog && catalog.versions.length > 0
      ? catalog.versions
      : FALLBACK_VERSIONS.map((id) => ({ id, label: id }));
  const activeGpt = weights?.active.gpt ?? null;
  const activeSovits = weights?.active.sovits ?? null;
  const wantGpt = value.gpt ?? weights?.pretrained.gpt ?? null;
  const wantSovits = value.sovits ?? weights?.pretrained.sovits ?? null;
  const weightsActive = sameWeight(activeGpt, wantGpt) && sameWeight(activeSovits, wantSovits);
  const bothListsEmpty = Boolean(weights) && weights!.gpt.length === 0 && weights!.sovits.length === 0;

  return (
    <div className="space-y-3">
      <Tabs
        value={value.weightMode}
        onValueChange={(next) => onChange({ ...value, weightMode: next as SovitsWeightMode })}
      >
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="zero-shot">零样本（不指定权重）</TabsTrigger>
          <TabsTrigger value="finetuned">微调权重（可只选一侧）</TabsTrigger>
        </TabsList>

        <TabsContent value="zero-shot" className="pt-3">
          <p className="text-[11px] leading-snug text-muted-foreground">
            不指定权重文件，服务端按默认规则选（官方底模；若整合包的权重目录里已有训练产物，
            会优先用最新的一对）。<strong>参考音频仍然是必需的</strong>，音色像不像主要取决于它。
          </p>
        </TabsContent>

        <TabsContent value="finetuned" className="space-y-3 pt-3">
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-40 flex-1 space-y-1.5">
              <Label className="text-xs">模型版本</Label>
              <Select
                value={value.version}
                onValueChange={(next) =>
                  onChange({ ...value, version: next, gpt: undefined, sovits: undefined })
                }
              >
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {versions.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.label || item.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              size="sm"
              variant="ghost"
              className="h-9 px-2"
              onClick={() => void loadWeights()}
              disabled={loading}
            >
              <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
            </Button>
          </div>

          {weights?.pretrained ? (
            <p className="text-[11px] leading-snug text-muted-foreground">
              官方底模：{baseName(weights.pretrained.gpt)}（GPT）+ {baseName(weights.pretrained.sovits)}（SoVITS）。
              切版本会同时切换这两者；
              <code className="mx-1 rounded bg-muted px-1">s1v3.ckpt</code>
              是 GPT 底模的版本号，v2Pro / v2ProPlus 官方都用它，不是 SoVITS v3。
            </p>
          ) : null}

          {error ? <p className="text-xs text-destructive">权重清单读取失败：{error}</p> : null}

          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="flex items-center gap-1.5 text-xs">
                <Cpu className="size-3.5" />
                GPT 权重（韵律 / 底模）
              </Label>
              <Select
                value={value.gpt ?? PRETRAINED}
                onValueChange={(next) =>
                  onChange({ ...value, gpt: next === PRETRAINED ? undefined : next })
                }
                disabled={loading || !weights}
              >
                <SelectTrigger className="h-9">
                  <SelectValue placeholder={loading ? '读取中…' : '预训练底模（自动）'} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={PRETRAINED}>预训练底模（自动）</SelectItem>
                  {(weights?.gpt ?? []).map((item) => (
                    <SelectItem key={item.path} value={item.path}>
                      <span className="flex items-center gap-2">
                        {item.name}
                        {item.trained ? (
                          <Badge variant="secondary" className="h-4 text-[10px] font-normal">
                            自训
                          </Badge>
                        ) : item.origin === 'library' ? (
                          <Badge variant="outline" className="h-4 text-[10px] font-normal">
                            模型库
                          </Badge>
                        ) : null}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="flex items-center gap-1.5 text-xs">
                <Cpu className="size-3.5" />
                SoVITS 权重（音色）
              </Label>
              <Select
                value={value.sovits ?? PRETRAINED}
                onValueChange={(next) =>
                  onChange({ ...value, sovits: next === PRETRAINED ? undefined : next })
                }
                disabled={loading || !weights}
              >
                <SelectTrigger className="h-9">
                  <SelectValue placeholder={loading ? '读取中…' : '预训练底模（自动）'} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={PRETRAINED}>预训练底模（自动）</SelectItem>
                  {(weights?.sovits ?? []).map((item) => (
                    <SelectItem key={item.path} value={item.path}>
                      <span className="flex items-center gap-2">
                        {item.name}
                        {item.trained ? (
                          <Badge variant="secondary" className="h-4 text-[10px] font-normal">
                            自训
                          </Badge>
                        ) : item.origin === 'library' ? (
                          <Badge variant="outline" className="h-4 text-[10px] font-normal">
                            模型库
                          </Badge>
                        ) : null}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {!loading && bothListsEmpty ? (
            <p className="flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              这个版本下没有权重文件。可以把下载的 .pth 放进音色库 GPT-SoVITS 分类，
              或到「音色微调训练」页跑一次训练。
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant={weightsActive ? 'outline' : 'default'}
              className="h-7 text-xs"
              disabled={applying || (!value.gpt && !value.sovits)}
              onClick={() => void applyWeights()}
            >
              {applying ? <Loader2 className="mr-1.5 size-3 animate-spin" /> : null}
              {weightsActive
                ? value.gpt || value.sovits
                  ? '已加载（重新加载）'
                  : '当前使用预训练底模'
                : '加载到显存'}
            </Button>
            {weightsActive ? (
              <span className="text-[11px] text-muted-foreground">
                显存中：{baseName(activeGpt) || '?'} + {baseName(activeSovits) || '?'}
              </span>
            ) : activeGpt && activeSovits ? (
              <span className="text-[11px] text-muted-foreground">
                显存里是另一套权重 —— 不点「加载到显存」的话，合成用的还是它。
              </span>
            ) : null}
          </div>

          <p className="text-[11px] leading-snug text-muted-foreground">
            只选 SoVITS（常见的下载 `.pth` 模型）时，GPT 自动用同版本预训练底模；
            只选 GPT 时同理。模型库里的权重带「模型库」标记，训练产物带「自训」标记。
            版本必须与权重匹配（v3/v4 与 v2 系不能混用）。
          </p>
        </TabsContent>
      </Tabs>
    </div>
  );
}

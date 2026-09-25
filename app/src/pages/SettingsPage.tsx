import { useCallback, useEffect, useState } from 'react';
import {
  CheckCircle2,
  Cpu,
  Eye,
  EyeOff,
  ExternalLink,
  Gauge,
  HardDrive,
  KeyRound,
  Loader2,
  Layers,
  RotateCcw,
  Save,
  Server,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { TermTip } from '@/components/features/TermTip';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';
import { DEFAULT_SETTINGS, MODE_META } from '@/lib/constants';
import { PROVIDERS, getProvider, languageLabel, resolveLanguages } from '@/lib/providers/registry';
import { SELFHOSTED_PRESETS } from '@/lib/providers/selfhosted';
import {
  DEFAULT_SOVITS_BASE,
  DIRECT_SOVITS_BASE,
  normalizeBaseUrl,
  readBaseUrl,
  sovitsApi,
  writeBaseUrl,
} from '@/lib/sovits';
import { cn } from '@/lib/utils';
import { formatBytes } from '@/lib/audio';
import type { AppSettings, HealthInfo, SovitsHealth, SovitsWeightList } from '@/types';

interface SettingsPageProps {
  settings: AppSettings;
  update: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
  reset: () => void;
  health: HealthInfo | null;
  /** 密钥配置变化后通知外层刷新状态 */
  onKeyChange: () => void;
}

/** 设置页：两套链路的服务地址、密钥、合成偏好与运行环境 */
export function SettingsPage({ settings, update, reset, health, onKeyChange }: SettingsPageProps) {
  const [showKey, setShowKey] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<{ ok: boolean; message: string } | null>(null);
  /** 草稿态：输入后不立即落盘，点击「保存」且校验通过后才写入浏览器本地 */
  const [draftKey, setDraftKey] = useState(settings.apiKey);
  const [draftBaseUrl, setDraftBaseUrl] = useState(settings.baseUrl);

  const hasServerKey = health?.hasServerKey ?? false;

  // 外部改动设置（恢复默认、清除密钥）时同步草稿，避免显示与已存值不一致。
  // 注意：此处不能重置 verifyResult —— 保存成功会同时更新 settings，
  // 若在此清空提示，用户刚看到的「配置成功」会被立刻抹掉。
  useEffect(() => {
    setDraftKey(settings.apiKey);
    setDraftBaseUrl(settings.baseUrl);
  }, [settings.apiKey, settings.baseUrl]);

  /** 密钥脱敏展示，避免完整密钥长时间停留在屏幕上 */
  const maskKey = (key: string) => (key.length <= 6 ? '••••••' : `${key.slice(0, 6)}••••`);

  /** 草稿与已保存值是否存在差异 */
  const dirty = draftKey.trim() !== settings.apiKey || draftBaseUrl.trim() !== settings.baseUrl;

  /** 写入浏览器本地并给出提示 */
  const persist = (options: { verified: boolean; message: string }) => {
    update('apiKey', draftKey.trim());
    update('baseUrl', draftBaseUrl.trim());
    setVerifyResult({ ok: options.verified, message: options.message });
    onKeyChange();
    if (options.verified) {
      toast.success('配置成功', { description: 'API Key 已保存并通过校验，现在可以开始合成语音' });
    } else {
      toast.warning('已保存，但未通过校验', { description: options.message });
    }
  };

  /**
   * 保存配置：先向 MiMo 发起一次极短文本的合成请求做校验，
   * 校验通过才写入本地，避免把无效密钥保存下来。
   */
  const handleSave = async () => {
    setVerifying(true);
    setVerifyResult(null);
    try {
      const result = await api.verifyKey(draftKey.trim() || undefined, draftBaseUrl.trim() || undefined);
      persist({ verified: true, message: result.message });
    } catch (error) {
      const message = error instanceof Error ? error.message : '校验失败';
      setVerifyResult({ ok: false, message });
      toast.error('配置未保存', { description: `${message}，请检查后重试` });
    } finally {
      setVerifying(false);
    }
  };

  /** 校验不通过时的兜底出口：允许忽略校验强制保存（应对临时网络故障等） */
  const handleForceSave = () => {
    persist({ verified: false, message: verifyResult?.message ?? '未通过校验' });
  };

  const handleReset = () => {
    if (!window.confirm('确定要恢复默认设置吗？已填写的 API Key 会被清除。')) return;
    reset();
    setVerifyResult(null);
    onKeyChange();
    toast.success('已恢复默认设置');
  };

  const provider = getProvider(settings.providerId);
  const providerLanguages = resolveLanguages(provider, settings.providerFields[provider.id]);

  /** 更新当前 Provider 的自定义字段 */
  const updateField = (key: string, value: string) => {
    update('providerFields', {
      ...settings.providerFields,
      [provider.id]: { ...(settings.providerFields[provider.id] ?? {}), [key]: value },
    });
  };

  // ------------------------------------------------------------------
  // GPT-SoVITS 本地服务
  // ------------------------------------------------------------------

  const sovitsFields = settings.providerFields['gpt-sovits'] ?? {};
  const [sovitsUrl, setSovitsUrl] = useState(() => readBaseUrl());
  const [probing, setProbing] = useState(false);
  const [sovitsHealth, setSovitsHealth] = useState<SovitsHealth | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [weights, setWeights] = useState<SovitsWeightList | null>(null);

  const probeSovits = useCallback(
    async (url: string) => {
      setProbing(true);
      setProbeError(null);
      try {
        const result = await sovitsApi.health(normalizeBaseUrl(url));
        setSovitsHealth(result);
        try {
          setWeights(await sovitsApi.weights(undefined, normalizeBaseUrl(url)));
        } catch {
          setWeights(null);
        }
      } catch (error) {
        setSovitsHealth(null);
        setWeights(null);
        const message = error instanceof Error ? error.message : '连接失败';
        setProbeError(message);
      } finally {
        setProbing(false);
      }
    },
    [],
  );

  useEffect(() => {
    void probeSovits(readBaseUrl());
  }, [probeSovits]);

  const saveSovitsUrl = () => {
    writeBaseUrl(sovitsUrl);
    toast.success('服务地址已保存', { description: normalizeBaseUrl(sovitsUrl) });
    void probeSovits(sovitsUrl);
  };

  const updateSovitsField = (key: string, value: string) => {
    update('providerFields', {
      ...settings.providerFields,
      'gpt-sovits': { ...sovitsFields, [key]: value },
    });
  };

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Layers className="size-4 text-violet-600 dark:text-violet-400" />
            语音模型与语言
          </CardTitle>
          <CardDescription>
            默认使用小米 MiMo（云端、免部署）。需要日语/韩语、专属音色微调或数据不出本机时，
            切换到 GPT-SoVITS（本地）
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2 sm:grid-cols-2">
            {PROVIDERS.map((item) => {
              const selected = item.id === provider.id;
              const languages = resolveLanguages(item, settings.providerFields[item.id]);
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => update('providerId', item.id)}
                  className={cn(
                    'flex flex-col gap-1.5 rounded-xl border p-3 text-left transition',
                    selected
                      ? 'border-violet-500 bg-violet-500/5 shadow-sm ring-1 ring-violet-500/30'
                      : 'hover:border-violet-300 hover:bg-muted/60',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{item.name}</span>
                    {selected ? <Badge className="ml-auto h-5 text-[10px]">当前</Badge> : null}
                  </div>
                  <p className="text-xs text-muted-foreground">{item.summary}</p>
                  <div className="flex flex-wrap gap-1">
                    {(languages.length > 0 ? languages : ['—']).slice(0, 8).map((code) => (
                      <Badge key={code} variant="secondary" className="h-5 px-1.5 text-[10px] font-normal">
                        {code === '—' ? '未声明' : languageLabel(code)}
                      </Badge>
                    ))}
                  </div>
                </button>
              );
            })}
          </div>

          {/* 自托管模型的快捷预设：点击即填入模型名与语言范围 */}
          {provider.id === 'selfhosted' ? (
            <div className="space-y-2 rounded-lg border border-dashed bg-muted/40 p-3">
              <p className="text-xs font-medium">常用开源模型（点击填入模型名与语言范围）</p>
              <div className="flex flex-wrap gap-1.5">
                {SELFHOSTED_PRESETS.map((preset) => (
                  <Button
                    key={preset.id}
                    type="button"
                    size="sm"
                    variant="outline"
                    title={preset.note}
                    className="h-7 rounded-full px-3 text-xs font-normal"
                    onClick={() => {
                      updateField('model', preset.id);
                      updateField('languages', preset.languages.join(', '));
                    }}
                  >
                    {preset.label}
                  </Button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                这些模型需自行部署推理服务并开放 CORS，接入契约见
                <code className="mx-1 rounded bg-muted px-1">docs/TRAINING.md</code>
              </p>
            </div>
          ) : null}

          {/* Provider 自定义字段（如自托管服务地址） */}
          {provider.fields?.map((field) => (
            <div key={field.key} className="space-y-2">
              <Label htmlFor={`field-${field.key}`}>
                {field.label}
                {field.required ? <span className="ml-1 text-destructive">*</span> : null}
              </Label>
              <Input
                id={`field-${field.key}`}
                value={settings.providerFields[provider.id]?.[field.key] ?? ''}
                onChange={(event) => updateField(field.key, event.target.value)}
                placeholder={field.placeholder}
                spellCheck={false}
                className="font-mono text-sm"
              />
              {field.hint ? <p className="text-xs text-muted-foreground">{field.hint}</p> : null}
            </div>
          ))}

          {provider.notes?.length ? (
            <div className="space-y-1 rounded-lg bg-muted/50 p-3">
              {provider.notes.map((note) => (
                <p key={note} className="flex gap-1.5 text-xs text-muted-foreground">
                  <span className="text-violet-500">·</span>
                  {note}
                </p>
              ))}
            </div>
          ) : null}

          <p className="text-xs text-muted-foreground">
            当前模型：<span className="font-medium">{provider.name}</span>
            {providerLanguages.length > 0
              ? ` · 支持 ${providerLanguages.map(languageLabel).join('、')}`
              : ' · 语言范围取决于你的服务配置'}
          </p>
        </CardContent>
      </Card>

      {/* ---------------- GPT-SoVITS 本地服务 ---------------- */}
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <HardDrive className="size-4 text-violet-600 dark:text-violet-400" />
            GPT-SoVITS 本地服务
            <Badge
              variant={sovitsHealth?.ok ? 'default' : 'secondary'}
              className={cn(
                'ml-1 h-5 text-[10px]',
                sovitsHealth?.ok && 'bg-emerald-600 hover:bg-emerald-600',
              )}
            >
              {sovitsHealth?.ok ? '已连接' : probing ? '连接中…' : '未连接'}
            </Badge>
          </CardTitle>
          <CardDescription>
            推理与训练全部在本机执行，音频与语料不会离开这台机器。服务由项目内置的 Python 进程提供。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="sovits-url">服务地址</Label>
              <div className="flex gap-2">
                <Input
                  id="sovits-url"
                  value={sovitsUrl}
                  onChange={(event) => setSovitsUrl(event.target.value)}
                  placeholder={DEFAULT_SOVITS_BASE}
                  spellCheck={false}
                  className="font-mono text-sm"
                />
                <Button size="sm" variant="outline" onClick={saveSovitsUrl} disabled={probing}>
                  {probing ? <Loader2 className="size-3.5 animate-spin" /> : '保存'}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void probeSovits(sovitsUrl)} disabled={probing}>
                  <RotateCcw className="size-3.5" />
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                默认 <span className="font-mono">{DEFAULT_SOVITS_BASE}</span> 表示经本项目网关转发；
                若直接连 Python 服务，填 <span className="font-mono">{DIRECT_SOVITS_BASE}</span>
              </p>
              {probeError ? (
                <p className="text-xs text-amber-600 dark:text-amber-400">{probeError}</p>
              ) : null}
            </div>

            <div className="space-y-2 rounded-lg bg-muted/50 p-3 text-xs">
              <div className="flex justify-between">
                <span className="text-muted-foreground">运行设备</span>
                <span className="font-medium">
                  {sovitsHealth?.runtime.device_label ?? (probing ? '读取中…' : '未连接')}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Python / torch</span>
                <span className="font-mono">
                  {sovitsHealth
                    ? `${sovitsHealth.runtime.python_version} / ${sovitsHealth.runtime.torch_version ?? '未安装'}`
                    : '-'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">模型状态</span>
                <span className="font-medium">
                  {sovitsHealth?.pipeline.loaded
                    ? `已加载 · ${sovitsHealth.pipeline.version}`
                    : sovitsHealth
                      ? '未加载（首次合成时自动加载）'
                      : '-'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">音色库</span>
                <span className="tabular-nums">
                  {sovitsHealth ? `${sovitsHealth.voices.total} 个（可用 ${sovitsHealth.voices.usable}）` : '-'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">已发现安装</span>
                <span className="max-w-[60%] truncate font-mono" title={sovitsHealth?.environment.home ?? ''}>
                  {sovitsHealth?.environment.home ?? '-'}
                </span>
              </div>
            </div>
          </div>

          {sovitsHealth && sovitsHealth.blockers.length > 0 ? (
            <Alert variant="destructive">
              <TriangleAlert className="size-4" />
              <AlertTitle>本地服务尚未就绪</AlertTitle>
              <AlertDescription>
                <ul className="mt-1 space-y-0.5">
                  {sovitsHealth.blockers.map((item) => (
                    <li key={item}>· {item}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          ) : null}

          {weights ? (
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">
                推理权重（当前版本 {weights.version}）
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="rounded-lg border p-3 text-xs">
                  <p className="flex items-center gap-1.5 font-medium">
                    <Cpu className="size-3.5" />
                    GPT（语义模型）
                  </p>
                  <p className="mt-1 truncate font-mono text-muted-foreground">
                    {weights.active.gpt ?? weights.default?.gpt_name ?? '未指定'}
                  </p>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    已训练权重 {weights.gpt.length} 个
                  </p>
                </div>
                <div className="rounded-lg border p-3 text-xs">
                  <p className="flex items-center gap-1.5 font-medium">
                    <Cpu className="size-3.5" />
                    SoVITS（声学模型）
                  </p>
                  <p className="mt-1 truncate font-mono text-muted-foreground">
                    {weights.active.sovits ?? weights.default?.sovits_name ?? '未指定'}
                  </p>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    已训练权重 {weights.sovits.length} 个
                  </p>
                </div>
              </div>
              <p className="text-[11px] text-muted-foreground">
                没有已训练权重时会自动使用官方预训练底模，可直接做零样本克隆
              </p>
            </div>
          ) : null}

          <Separator />

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {[
              {
                key: 'version',
                label: '默认模型版本',
                placeholder: 'v2ProPlus',
                hint: 'v2 系列支持流式；v3/v4 音质更好但不支持流式',
                options: ['v2ProPlus', 'v2Pro', 'v2', 'v1', 'v3', 'v4'],
              },
            ].map((field) => (
              <div key={field.key} className="space-y-2">
                <Label>{field.label}</Label>
                <Select
                  value={sovitsFields[field.key] ?? 'v2ProPlus'}
                  onValueChange={(value) => updateSovitsField(field.key, value)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {field.options.map((option) => (
                      <SelectItem key={option} value={option}>
                        {option}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-muted-foreground">{field.hint}</p>
              </div>
            ))}

            <div className="space-y-2">
              <Label htmlFor="sovits-default-voice">
                  <TermTip term="默认音色 ID" />
                </Label>
              <Input
                id="sovits-default-voice"
                value={sovitsFields.voice ?? ''}
                onChange={(event) => updateSovitsField('voice', event.target.value)}
                placeholder="在「音色库」中复制音色 id"
                spellCheck={false}
                className="font-mono text-sm"
              />
              <p className="text-[11px] text-muted-foreground">
                留空时合成页需要手动选择音色
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="sovits-prompt-lang">
                  <TermTip term="参考音频语种" />
                </Label>
              <Input
                id="sovits-prompt-lang"
                value={sovitsFields.prompt_lang ?? ''}
                onChange={(event) => updateSovitsField('prompt_lang', event.target.value)}
                placeholder="zh"
                spellCheck={false}
                className="font-mono text-sm"
              />
              <p className="text-[11px] text-muted-foreground">zh / en / ja / ko / yue</p>
            </div>
          </div>

          <Separator />

          <div className="space-y-3">
            <p className="text-xs font-medium text-muted-foreground">批量合成默认值</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="batch-template">
                  <TermTip term="文件名模板" />
                </Label>
                <Input
                  id="batch-template"
                  value={settings.batchFilenameTemplate}
                  onChange={(event) => update('batchFilenameTemplate', event.target.value)}
                  placeholder="{index:03d}-{key}"
                  spellCheck={false}
                  className="font-mono text-sm"
                />
              </div>
              <div className="flex items-center justify-between rounded-lg border p-3">
                <div>
                  <Label htmlFor="batch-zip-default" className="cursor-pointer text-sm">
                    默认打包为 ZIP
                  </Label>
                  <p className="text-[11px] text-muted-foreground">同时附带 JSON 与 CSV 清单</p>
                </div>
                <Switch
                  id="batch-zip-default"
                  checked={settings.batchMakeZip}
                  onCheckedChange={(checked) => update('batchMakeZip', checked)}
                />
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <KeyRound className="size-4 text-violet-600 dark:text-violet-400" />
            API 密钥配置
          </CardTitle>
          <CardDescription>
            密钥仅保存在你的浏览器本地（localStorage），不会上传到任何服务器，也不使用 cookie。
            填写后点击「保存」，校验通过即配置成功
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert variant={hasServerKey ? 'default' : 'destructive'}>
            {hasServerKey ? <ShieldCheck className="size-4" /> : <TriangleAlert className="size-4" />}
            <AlertTitle>{hasServerKey ? '站点已配置公用密钥' : '站点未配置公用密钥'}</AlertTitle>
            <AlertDescription>
              {hasServerKey
                ? '不填写下方密钥时，将使用站点管理员配置的公用密钥（受站点限流保护）。填写自己的密钥可获得更高额度与独立配额。'
                : '当前必须由你自行提供 MiMo API Key 才能使用合成功能，请前往 MiMo 开放平台控制台创建。'}
            </AlertDescription>
          </Alert>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="api-key">
                  <TermTip term="API Key">MiMo API Key</TermTip>
                </Label>
              {dirty ? (
                <span className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
                  <span className="size-1.5 rounded-full bg-amber-500" />
                  有未保存的修改
                </span>
              ) : null}
            </div>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Input
                  id="api-key"
                  type={showKey ? 'text' : 'password'}
                  value={draftKey}
                  onChange={(event) => {
                    setDraftKey(event.target.value);
                    setVerifyResult(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !verifying) void handleSave();
                  }}
                  placeholder={hasServerKey ? '留空则使用站点公用密钥' : 'sk-xxxxxxxxxxxxxxxx'}
                  autoComplete="off"
                  spellCheck={false}
                  className="pr-10 font-mono text-sm"
                />
                <button
                  type="button"
                  onClick={() => setShowKey((prev) => !prev)}
                  aria-label={showKey ? '隐藏密钥' : '显示密钥'}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground transition hover:bg-muted"
                >
                  {showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
              <Button onClick={() => void handleSave()} disabled={verifying}>
                {verifying ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                {verifying ? '校验中' : '保存'}
              </Button>
            </div>

            {verifyResult?.ok ? (
              <p className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="size-3.5" />
                配置成功 · {verifyResult.message}
              </p>
            ) : null}

            {verifyResult && !verifyResult.ok ? (
              <div className="space-y-1.5 rounded-lg border border-destructive/30 bg-destructive/5 p-2.5">
                <p className="flex items-start gap-1.5 text-xs text-destructive">
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                  <span>{verifyResult.message}</span>
                </p>
                <p className="text-xs text-muted-foreground">
                  {draftKey.trim() || hasServerKey
                    ? '当前配置未保存。你可以修正后重新保存，或忽略校验直接保存。'
                    : '请先填写 API Key，然后重新点击「保存」。'}
                </p>
                {draftKey.trim() || hasServerKey ? (
                  <Button variant="outline" size="sm" className="h-7 text-xs" onClick={handleForceSave}>
                    忽略校验，仍然保存
                  </Button>
                ) : null}
              </div>
            ) : null}

            {!verifyResult && settings.apiKey ? (
              <p className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="size-3.5" />
                已保存密钥 {maskKey(settings.apiKey)}
                {dirty ? '，当前有未保存的修改' : '，修改后点击「保存」可重新校验'}
              </p>
            ) : null}

            {!verifyResult && !settings.apiKey ? (
              <p className="text-xs text-muted-foreground">
                点击「保存」会先校验密钥（发起一次极短文本的合成请求，消耗少量额度），
                <span className="font-medium">校验通过后才会写入浏览器本地</span>
              </p>
            ) : null}
            <a
              href="https://platform.xiaomimimo.com/console/api-keys"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs text-violet-600 hover:underline dark:text-violet-400"
            >
              前往 MiMo 开放平台获取密钥
              <ExternalLink className="size-3" />
            </a>
          </div>

          <Separator />

          <div className="space-y-2">
            <Label htmlFor="base-url">接口地址（可选）</Label>
            <Input
              id="base-url"
              value={draftBaseUrl}
              onChange={(event) => {
                setDraftBaseUrl(event.target.value);
                setVerifyResult(null);
              }}
              placeholder={health?.baseUrl ?? 'https://api.xiaomimimo.com/v1'}
              spellCheck={false}
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">
              留空则使用站点默认地址，与上方密钥一并保存。Token Plan 用户可填写专属地址，例如
              https://token-plan-cn.xiaomimimo.com/v1
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Gauge className="size-4 text-violet-600 dark:text-violet-400" />
            合成偏好
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label htmlFor="auto-segment" className="cursor-pointer text-sm">
                长文本自动分段
              </Label>
              <p className="text-xs text-muted-foreground">
                文本较长时按语义切分并逐段合成后拼接，规避单次推理长度限制
              </p>
            </div>
            <Switch
              id="auto-segment"
              checked={settings.autoSegment}
              onCheckedChange={(checked) => update('autoSegment', checked)}
            />
          </div>

          <Separator />

          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label htmlFor="optimize-default" className="cursor-pointer text-sm">
                音色设计默认润色文本
              </Label>
              <p className="text-xs text-muted-foreground">作为音色设计页「智能润色播报文本」的初始值</p>
            </div>
            <Switch
              id="optimize-default"
              checked={settings.optimizeTextPreview}
              onCheckedChange={(checked) => update('optimizeTextPreview', checked)}
            />
          </div>

          <Separator />

          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label htmlFor="auto-play" className="cursor-pointer text-sm">
                生成后自动播放
              </Label>
              <p className="text-xs text-muted-foreground">合成完成后立即播放，便于快速试听</p>
            </div>
            <Switch id="auto-play" checked={settings.autoPlay} onCheckedChange={(checked) => update('autoPlay', checked)} />
          </div>

          <Separator />

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-sm">
                <TermTip term="播放增益" />
              </Label>
              <span className="text-xs tabular-nums text-muted-foreground">{settings.playbackGain.toFixed(1)}x</span>
            </div>
            <Slider
              value={[settings.playbackGain]}
              min={0.5}
              max={4}
              step={0.1}
              onValueChange={([value]) => update('playbackGain', Number(value.toFixed(1)))}
            />
            <p className="text-xs text-muted-foreground">部分生成音频音量偏小，可适当提高增益（仅影响试听，不改变下载文件）</p>
          </div>

          <Separator />

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-sm">历史记录保留条数</Label>
              <span className="text-xs tabular-nums text-muted-foreground">{settings.historyLimit} 条</span>
            </div>
            <Slider
              value={[settings.historyLimit]}
              min={10}
              max={200}
              step={10}
              onValueChange={([value]) => update('historyLimit', value)}
            />
            <p className="text-xs text-muted-foreground">超出上限时自动删除最早的记录，音频存于浏览器 IndexedDB</p>
          </div>

          <Separator />

          <Button variant="outline" className="w-full" onClick={handleReset}>
            <RotateCcw className="size-4" />
            恢复默认设置
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Server className="size-4 text-violet-600 dark:text-violet-400" />
            站点与模型信息
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2 rounded-lg bg-muted/50 p-3 text-xs">
            <div className="flex justify-between">
              <span className="text-muted-foreground">服务状态</span>
              <span className="flex items-center gap-1.5 font-medium text-emerald-600">
                <span className="size-1.5 rounded-full bg-emerald-500" />
                {health?.status === 'healthy' ? '运行中' : '未知'}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">运行环境</span>
              <span className="font-mono">{health?.env ?? '-'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">接口地址</span>
              <span className="max-w-[60%] truncate font-mono">{health?.baseUrl ?? '- '}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">单次文本上限</span>
              <span className="tabular-nums">{health ? `${health.limits.maxTextLength} 字` : '-'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">样本体积上限</span>
              <span className="tabular-nums">{health ? formatBytes(health.limits.maxSampleBytes) : '-'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">站点限流</span>
              <span className="tabular-nums">
                {health ? `${health.limits.synthsPerMinute} 次 / 分钟` : '-'}
              </span>
            </div>
          </div>

          <Separator />

          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">已接入模型</p>
            {Object.entries(MODE_META).map(([mode, meta]) => (
              <div key={mode} className="flex items-start gap-2 rounded-lg border p-2.5">
                <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-violet-500/10 text-[10px] font-semibold text-violet-600">
                  TTS
                </span>
                <div className="min-w-0">
                  <p className="font-mono text-xs">{meta.model}</p>
                  <p className="text-[11px] text-muted-foreground">{meta.description}</p>
                </div>
                {meta.streaming ? (
                  <Badge variant="secondary" className="ml-auto h-5 shrink-0 text-[10px] font-normal">
                    支持流式
                  </Badge>
                ) : null}
              </div>
            ))}
          </div>

          <p className="text-[11px] leading-relaxed text-muted-foreground">
            默认值来自官方文档
            <a
              href="https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/audio/speech-synthesis-v2.5"
              target="_blank"
              rel="noreferrer"
              className="ml-1 text-violet-600 hover:underline dark:text-violet-400"
            >
              语音合成 v2.5 使用指南
            </a>
            。语音合成当前限时免费，具体以 MiMo 平台计费说明为准。
          </p>

          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={() => {
              update('apiKey', DEFAULT_SETTINGS.apiKey);
              update('baseUrl', DEFAULT_SETTINGS.baseUrl);
              setVerifyResult(null);
              onKeyChange();
              toast.success('已清除本地密钥与接口地址');
            }}
            disabled={!settings.apiKey && !settings.baseUrl}
          >
            仅清除本地密钥与接口地址
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Cpu,
  Eye,
  EyeOff,
  ExternalLink,
  Gauge,
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
import { Progress } from '@/components/ui/progress';
import { TermTip } from '@/components/features/TermTip';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';
import { RequestError } from '@/lib/errors';
import {
  localServiceApi,
  notifyServiceEnabledChanged,
  runtimeServiceApi,
  type LocalServiceState,
  type RuntimeServiceState,
} from '@/lib/localService';
import { preloadApi, type PreloadCatalog, type PreloadPreference } from '@/lib/preload';
import { DEFAULT_SETTINGS } from '@/lib/constants';
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
  /** 侧栏状态卡带来的锚点：preload / service-netease / service-indextts / service-sovits / cloud */
  focusSection?: string | null;
  /** 锚点消费完毕（避免重复滚动） */
  onFocusHandled?: () => void;
}

/** 设置页：两套链路的服务地址、密钥、合成偏好与运行环境 */
export function SettingsPage({ settings, update, reset, health, onKeyChange, focusSection, onFocusHandled }: SettingsPageProps) {
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

  // ------------------------------------------------------------------
  // GPT-SoVITS 服务的启停（默认关闭以释放显存）
  // ------------------------------------------------------------------

  const [serviceState, setServiceState] = useState<LocalServiceState | null>(null);
  const [toggling, setToggling] = useState(false);
  /** 是否正在**开启**（开启要走数十秒冷启动，关闭不用等） */
  const [pendingEnable, setPendingEnable] = useState(false);
  const [toggleElapsed, setToggleElapsed] = useState(0);

  // ------------------------------------------------------------------
  // 启动预加载偏好
  // ------------------------------------------------------------------

  const [preloadCatalog, setPreloadCatalog] = useState<PreloadCatalog | null>(null);
  const [preloadPreference, setPreloadPreference] = useState<PreloadPreference | null>(null);
  const [preloadSaving, setPreloadSaving] = useState(false);

  const refreshPreload = useCallback(() => {
    preloadApi
      .catalog()
      .then((next) => {
        setPreloadCatalog(next);
        setPreloadPreference(next.preference);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    refreshPreload();
  }, [refreshPreload]);

  const applyPreloadPreference = async (model: PreloadPreference) => {
    setPreloadSaving(true);
    try {
      await preloadApi.savePreference(model);
      setPreloadPreference(model);
      toast.success('已保存启动预加载设置', {
        description: model === 'ask' ? '以后开机都会问你要加载哪个模型' : `以后开机自动加载：${model}`,
      });
    } catch (error) {
      const requestError = error as RequestError;
      toast.error('保存失败', { description: requestError.fullMessage ?? requestError.message });
    } finally {
      setPreloadSaving(false);
    }
  };

  const refreshServiceState = useCallback(() => {
    localServiceApi
      .state()
      .then(setServiceState)
      .catch(() => setServiceState(null));
  }, []);

  useEffect(() => {
    refreshServiceState();
  }, [refreshServiceState]);

  // ------------------------------------------------------------------
  // 网易 / IndexTTS 的连接开关（网关托管：开 = 拉起，关 = 卸模型 + 收掉自己拉起的进程）
  // ------------------------------------------------------------------

  const [runtimeStates, setRuntimeStates] = useState<{
    netease: RuntimeServiceState | null;
    indextts: RuntimeServiceState | null;
  }>({ netease: null, indextts: null });
  const [runtimeToggling, setRuntimeToggling] = useState<'netease' | 'indextts' | null>(null);
  /** GPT-SoVITS 高级配置（推理权重 / 默认值 / 批量）在行内是否展开 */
  const [sovitsAdvanced, setSovitsAdvanced] = useState(false);

  const refreshRuntimeStates = useCallback(() => {
    runtimeServiceApi
      .state('netease')
      .then((next) => setRuntimeStates((prev) => ({ ...prev, netease: next })))
      .catch(() => undefined);
    runtimeServiceApi
      .state('indextts')
      .then((next) => setRuntimeStates((prev) => ({ ...prev, indextts: next })))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    refreshRuntimeStates();
    // 服务也可能被外部终端起停，30 秒复查一次，状态不骗人
    const timer = window.setInterval(refreshRuntimeStates, 30_000);
    return () => window.clearInterval(timer);
  }, [refreshRuntimeStates]);

  // ------------------------------------------------------------------
  // 侧栏状态卡锚点：滚到对应区块并短暂高亮
  // ------------------------------------------------------------------

  const [flashId, setFlashId] = useState<string | null>(null);
  const focusDoneRef = useRef(onFocusHandled);
  focusDoneRef.current = onFocusHandled;

  useEffect(() => {
    if (!focusSection) return;
    const elId = `settings-${focusSection}`;
    // 刚从别的页切过来时 DOM 还没挂上，延迟一拍再滚
    const timer = window.setTimeout(() => {
      document.getElementById(elId)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setFlashId(elId);
      window.setTimeout(() => setFlashId(null), 2600);
      focusDoneRef.current?.();
    }, 120);
    return () => window.clearTimeout(timer);
  }, [focusSection]);

  /** 给被锚点命中的区块加一圈临时高亮 */
  const flashRing = (id: string) => (flashId === id ? 'ring-2 ring-violet-500/70 transition-shadow' : '');

  const toggleRuntimeService = async (id: 'netease' | 'indextts', enabled: boolean) => {
    setRuntimeToggling(id);
    try {
      const result = await runtimeServiceApi.toggle(id, enabled);
      toast.success(result.enabled ? '已启用服务' : '已关闭服务', { description: result.hint });
      notifyServiceEnabledChanged();
      refreshRuntimeStates();
      if (id === 'netease') void probeSovits(readBaseUrl());
    } catch (requestError) {
      const error = requestError as RequestError;
      toast.error('切换失败', { description: error.fullMessage ?? error.message });
    } finally {
      setRuntimeToggling(null);
      refreshRuntimeStates();
    }
  };

  const toggleService = async (enabled: boolean) => {
    setToggling(true);
    setPendingEnable(enabled);
    setToggleElapsed(0);
    const startedAt = Date.now();
    const ticker = window.setInterval(() => setToggleElapsed(Math.round((Date.now() - startedAt) / 1000)), 1_000);
    try {
      const result = await localServiceApi.toggle(enabled);
      toast.success(enabled ? '已启用 GPT-SoVITS 本地服务' : '已关闭 GPT-SoVITS 本地服务', {
        description: result.hint,
      });
      notifyServiceEnabledChanged();
      refreshServiceState();
      void probeSovits(sovitsUrl);
    } catch (requestError) {
      const error = requestError as RequestError;
      toast.error('切换失败', { description: error.fullMessage ?? error.message });
    } finally {
      window.clearInterval(ticker);
      setToggling(false);
      setPendingEnable(false);
    }
  };

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
      {/* ============ ① 模型与显存：开机先装谁 ============ */}
      <Card id="settings-preload" className={cn('lg:col-span-2', flashRing('settings-preload'))}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Cpu className="size-4 text-violet-600 dark:text-violet-400" />
            模型与显存
          </CardTitle>
          <CardDescription>
            本机 8 GB 显存一次只够常驻一个模型。选一个，开机就把它先装进显存，其余的会自动让位；
            之后在对应页面直接用它，不需要再手动加载。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>
              当前空闲显存：
              <span className="font-medium text-foreground tabular-nums">
                {preloadCatalog?.vram.free_mb != null ? `${(preloadCatalog.vram.free_mb / 1024).toFixed(1)} GB` : '未知'}
              </span>
              {preloadCatalog?.vram.total_mb != null ? ` / 共 ${(preloadCatalog.vram.total_mb / 1024).toFixed(1)} GB` : ''}
            </span>
            {preloadCatalog?.vram.source ? <span>读数来源：{preloadCatalog.vram.source}</span> : null}
          </div>

          <div className="grid gap-2 sm:grid-cols-3">
            {(preloadCatalog?.models ?? []).map((item) => {
              const selected = preloadPreference === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  disabled={preloadSaving}
                  onClick={() => void applyPreloadPreference(item.id)}
                  className={cn(
                    'flex flex-col gap-1 rounded-xl border p-3 text-left transition',
                    selected
                      ? 'border-violet-500 bg-violet-500/5 shadow-sm ring-1 ring-violet-500/30'
                      : 'hover:border-violet-300 hover:bg-muted/60',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{item.label}</span>
                    {selected ? <Badge className="ml-auto h-5 text-[10px]">开机加载</Badge> : null}
                  </div>
                  <p className="text-xs text-muted-foreground tabular-nums">
                    显存代价约 {(item.vram_mb / 1024).toFixed(1)} GB
                    {item.fits === false ? ' · 当前空闲不够，开机会让位后再试' : ''}
                  </p>
                </button>
              );
            })}
            <button
              type="button"
              disabled={preloadSaving}
              onClick={() => void applyPreloadPreference('ask')}
              className={cn(
                'flex flex-col gap-1 rounded-xl border p-3 text-left transition',
                preloadPreference === 'ask'
                  ? 'border-violet-500 bg-violet-500/5 shadow-sm ring-1 ring-violet-500/30'
                  : 'hover:border-violet-300 hover:bg-muted/60',
              )}
            >
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">每次问我</span>
                {preloadPreference === 'ask' ? <Badge className="ml-auto h-5 text-[10px]">当前</Badge> : null}
              </div>
              <p className="text-xs text-muted-foreground">开机弹窗选一个（刚装好环境、还在比较时用）</p>
            </button>
            <button
              type="button"
              disabled={preloadSaving}
              onClick={() => void applyPreloadPreference('none')}
              className={cn(
                'flex flex-col gap-1 rounded-xl border p-3 text-left transition',
                preloadPreference === 'none'
                  ? 'border-violet-500 bg-violet-500/5 shadow-sm ring-1 ring-violet-500/30'
                  : 'hover:border-violet-300 hover:bg-muted/60',
              )}
            >
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">不预加载</span>
                {preloadPreference === 'none' ? <Badge className="ml-auto h-5 text-[10px]">当前</Badge> : null}
              </div>
              <p className="text-xs text-muted-foreground">开机什么都不装，进页面点「预热」再加载</p>
            </button>
          </div>
        </CardContent>
      </Card>

      {/* ============ ② 本地服务：三个 Python 运行时一屏看全，都有开关 ============ */}
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Server className="size-4 text-violet-600 dark:text-violet-400" />
            本地服务
          </CardTitle>
          <CardDescription>
            本项目的三个本地模型服务，各有一个连接开关。注意区分两层占用：
            <strong>服务进程</strong>本身约占几百 MB 显存（torch 上下文），<strong>模型常驻</strong>（数 GB）
            要进页面点「预热」或开机预加载才会发生。不用的服务关掉，进程和显存一起归还。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* 网易 Confucius4-TTS */}
          <div id="settings-service-netease" className={cn('flex flex-wrap items-start gap-x-4 gap-y-2 rounded-lg border p-3', flashRing('settings-service-netease'))}>
            <div className="min-w-0 flex-1 space-y-1">
              <p className="text-sm font-medium">
                网易 Confucius4-TTS
                <span className="ml-2 font-mono text-[11px] text-muted-foreground">:9882</span>
              </p>
              <p className="text-xs text-muted-foreground">
                主服务（免转写克隆 / 14 语种）。默认随 <code className="rounded bg-muted px-1">npm run dev</code> 启动；
                这里的开关由网关托管：开 = 拉起进程，关 = 卸掉常驻模型并收掉进程。
              </p>
              {/* 「开关关着但端口上还有进程」要说清楚：多半是 npm run dev 的 concurrently 或
                  终端手动起的，网关没托管它。用户看到侧栏与这里不一致往往就是这个态。 */}
              {runtimeStates.netease && !runtimeStates.netease.enabled && runtimeStates.netease.reachable ? (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  检测到未托管的进程仍在 :9882 上运行（多由 <code className="rounded bg-muted px-1">npm run dev</code>
                  或终端手动启动）。打开右侧开关可由网关接管；关闭开关则会把它收掉并归还显存。
                </p>
              ) : null}
              {runtimeStates.netease && !runtimeStates.netease.reachable && runtimeStates.netease.lastError ? (
                <p className="text-xs text-amber-600 dark:text-amber-400">{runtimeStates.netease.lastError}</p>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-3 pt-1">
              <Badge
                variant={runtimeStates.netease?.enabled && runtimeStates.netease?.reachable ? 'default' : 'secondary'}
                className={cn(
                  'h-6 text-[11px]',
                  runtimeStates.netease?.enabled && runtimeStates.netease?.reachable && 'bg-emerald-600 hover:bg-emerald-600',
                )}
              >
                {runtimeStates.netease?.starting
                  ? '启动中…'
                  : runtimeStates.netease?.enabled && runtimeStates.netease?.reachable
                    ? '运行中'
                    : runtimeStates.netease?.enabled
                      ? '未就绪'
                      : '未启动'}
              </Badge>
              <Switch
                aria-label="启用网易模块服务"
                checked={runtimeStates.netease?.enabled ?? false}
                disabled={runtimeToggling === 'netease' || runtimeStates.netease == null}
                onCheckedChange={(checked) => void toggleRuntimeService('netease', checked === true)}
              />
            </div>
          </div>

          {/* IndexTTS-2.5 */}
          <div id="settings-service-indextts" className={cn('flex flex-wrap items-start gap-x-4 gap-y-2 rounded-lg border p-3', flashRing('settings-service-indextts'))}>
            <div className="min-w-0 flex-1 space-y-1">
              <p className="text-sm font-medium">
                IndexTTS-2.5
                <span className="ml-2 font-mono text-[11px] text-muted-foreground">:9883</span>
              </p>
              <p className="text-xs text-muted-foreground">
                情感可控（8 维向量 / 语速倍率 / 5 语种）。默认<strong>关闭</strong>按需启动；
                环境体检：<code className="mx-1 rounded bg-muted px-1">npm run indextts:check</code>
              </p>
              {runtimeStates.indextts && !runtimeStates.indextts.enabled && runtimeStates.indextts.reachable ? (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  检测到未托管的进程仍在 :9883 上运行（多为终端手动启动）。打开右侧开关可由网关接管；
                  关闭开关则会把它收掉并归还显存。
                </p>
              ) : null}
              {runtimeStates.indextts && !runtimeStates.indextts.reachable && runtimeStates.indextts.lastError ? (
                <p className="text-xs text-amber-600 dark:text-amber-400">{runtimeStates.indextts.lastError}</p>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-3 pt-1">
              <Badge
                variant={runtimeStates.indextts?.enabled && runtimeStates.indextts?.reachable ? 'default' : 'secondary'}
                className={cn(
                  'h-6 text-[11px]',
                  runtimeStates.indextts?.enabled &&
                    runtimeStates.indextts?.reachable &&
                    'bg-emerald-600 hover:bg-emerald-600',
                )}
              >
                {runtimeStates.indextts?.starting
                  ? '启动中…'
                  : runtimeStates.indextts?.enabled && runtimeStates.indextts?.reachable
                    ? '运行中'
                    : runtimeStates.indextts?.enabled
                      ? '未就绪'
                      : '未启动'}
              </Badge>
              <Switch
                aria-label="启用 IndexTTS 服务"
                checked={runtimeStates.indextts?.enabled ?? false}
                disabled={runtimeToggling === 'indextts' || runtimeStates.indextts == null}
                onCheckedChange={(checked) => void toggleRuntimeService('indextts', checked === true)}
              />
            </div>
          </div>

          {/* GPT-SoVITS：配置项最多的一条，高级设置收进行内展开 */}
          <div id="settings-service-sovits" className={cn('rounded-lg border', flashRing('settings-service-sovits'))}>
            <div className="flex flex-wrap items-start gap-x-4 gap-y-2 p-3">
              <div className="min-w-0 flex-1 space-y-1">
                <p className="text-sm font-medium">
                  GPT-SoVITS
                  <span className="ml-2 font-mono text-[11px] text-muted-foreground">:9881</span>
                </p>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  训练 / 批量合成 / 语音变声 / 歌声转换都跑在这条链路。默认<strong>关闭</strong>，
                  显存留给主服务；关掉后显存立刻归还。
                </p>
                <p className="text-xs text-muted-foreground">
                  当前状态：
                  {serviceState
                    ? serviceState.enabled
                      ? serviceState.reachable
                        ? '已启用并在运行'
                        : '已启用，启动中（首次要 import torch，数十秒）'
                      : '已停用（默认）'
                    : '读取中…'}
                </p>
                {/* 开启是数十秒的冷启动，只让开关转圈会让人以为卡住 */}
                {toggling && pendingEnable ? (
                  <div className="space-y-1">
                    <p className="text-xs text-amber-600 dark:text-amber-400">
                      启动中，约需数十秒（首次要 import torch）· 已等待 {toggleElapsed} 秒
                    </p>
                    <Progress value={Math.min(95, Math.round((toggleElapsed / 45) * 100))} className="h-1.5" />
                  </div>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-3 pt-1">
                <Badge
                  variant={sovitsHealth?.ok ? 'default' : 'secondary'}
                  className={cn('h-6 text-[11px]', sovitsHealth?.ok && 'bg-emerald-600 hover:bg-emerald-600')}
                >
                  {sovitsHealth?.ok ? '已连接' : probing ? '连接中…' : '未连接'}
                </Badge>
                <Switch
                  id="sovits-enabled"
                  aria-label="启用 GPT-SoVITS 本地服务"
                  checked={serviceState?.enabled ?? false}
                  disabled={toggling || serviceState == null}
                  onCheckedChange={(checked) => void toggleService(checked === true)}
                />
              </div>
            </div>
            <button
              type="button"
              onClick={() => setSovitsAdvanced((prev) => !prev)}
              aria-expanded={sovitsAdvanced}
              className="flex w-full items-center gap-1 border-t px-3 py-2 text-left text-xs text-muted-foreground transition hover:bg-muted/50 hover:text-foreground"
            >
              {sovitsAdvanced ? <ChevronDown className="size-3 shrink-0" /> : <ChevronRight className="size-3 shrink-0" />}
              高级配置（服务地址 · 运行时信息 · 推理权重 · 合成与批量默认值）
            </button>
            {sovitsAdvanced ? (
              <div className="space-y-4 border-t p-3">
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
            <WeightsPanel
              weights={weights}
              baseUrl={normalizeBaseUrl(sovitsUrl)}
              onChanged={() => void probeSovits(sovitsUrl)}
            />
          ) : null}

          <Separator />

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-2">
              <Label>默认模型版本</Label>
              <Select
                value={sovitsFields.version ?? 'v2ProPlus'}
                onValueChange={(value) => updateSovitsField('version', value)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {['v2ProPlus', 'v2Pro', 'v2', 'v1', 'v3', 'v4'].map((option) => (
                    <SelectItem key={option} value={option}>
                      {option}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">v2 系列支持流式；v3/v4 音质更好但不支持流式</p>
            </div>

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
              </div>
            ) : null}
          </div>
        </CardContent>
      </Card>

      {/* ============ ③ 云端合成（MiMo）：页面后端 + 密钥 ============ */}
      <Card id="settings-cloud" className={cn('lg:col-span-2', flashRing('settings-cloud'))}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Layers className="size-4 text-violet-600 dark:text-violet-400" />
            云端合成 · MiMo 与接口密钥
          </CardTitle>
          <CardDescription>
            侧栏「MiMo 云端」组（通用合成 / 音色设计 / 声音克隆）三个页面的后端与密钥。
            本地模型（网易 / IndexTTS / GPT-SoVITS）不经过这里，也不依赖密钥。
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

          {/* 按所选后端条件渲染配置区：选谁才露谁的设置，不叠三层 */}
          {provider.id === 'gpt-sovits' ? (
            <div className="rounded-lg border border-dashed bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground">
              这个后端<strong>不需要密钥</strong>。它的服务地址、默认音色、模型版本与批量默认值
              统一在上方「本地服务 → GPT-SoVITS · 高级配置」里维护 —— 那里把服务打开，云端三页就能直接用它。
            </div>
          ) : (
            <>
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
            </>
          )}

          {/* 密钥与接口地址只在选了 MiMo 云端后出现 */}
          {provider.id === 'mimo' ? (
            <>
              <Separator />

              <Alert variant={hasServerKey ? 'default' : 'destructive'}>
            {hasServerKey ? <ShieldCheck className="size-4" /> : <TriangleAlert className="size-4" />}
            <AlertTitle>{hasServerKey ? '站点已配置公用密钥' : '站点未配置公用密钥'}</AlertTitle>
            <AlertDescription>
              {hasServerKey
                ? '不填写下方密钥时，将使用站点管理员配置的公用密钥（受站点限流保护）。填写自己的密钥可获得更高额度与独立配额。'
                : '当前必须由你自行提供 MiMo API Key 才能使用云端合成功能，请前往 MiMo 开放平台控制台创建。'}
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
            </>
          ) : null}
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
            {[
              { name: '网易 Confucius4-TTS', kind: '本地 · 主服务', note: '免转写零样本克隆 · 14 语种（netease/ :9882）' },
              { name: 'IndexTTS-2.5', kind: '本地 · 情感可控', note: '8 维情感向量 / 语速倍率 · 5 语种（indextts/ :9883）' },
              { name: 'GPT-SoVITS v2ProPlus', kind: '本地 · 训练链路', note: '推理 / 微调训练 / 批量合成 / 音色库（:9881，默认停用）' },
              { name: 'RVC · DDSP-SVC · ASR', kind: '本地 · 语音工具', note: '变声 / 歌声翻唱 / 语音转文本（与 GPT-SoVITS 同一服务）' },
              { name: 'MiMo', kind: '云端 API', note: '通用合成 / 音色设计 / 声音克隆，需要 API Key' },
            ].map((item) => (
              <div key={item.name} className="flex items-start gap-2 rounded-lg border p-2.5">
                <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-violet-500/10 text-[9px] font-semibold text-violet-600">
                  {item.kind.includes('云端') ? 'API' : 'GPU'}
                </span>
                <div className="min-w-0">
                  <p className="text-xs font-medium">{item.name} <span className="font-normal text-muted-foreground">· {item.kind}</span></p>
                  <p className="text-[11px] text-muted-foreground">{item.note}</p>
                </div>
              </div>
            ))}
          </div>

          <p className="text-[11px] leading-relaxed text-muted-foreground">
            云端 MiMo 的参数默认值来自官方文档
            <a
              href="https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/audio/speech-synthesis-v2.5"
              target="_blank"
              rel="noreferrer"
              className="ml-1 text-violet-600 hover:underline dark:text-violet-400"
            >
              语音合成 v2.5 使用指南
            </a>
            （限时免费，以平台计费说明为准）；本地模型的门槛与能力以各服务接口实测返回为准。
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

/**
 * 推理权重选择面板。
 *
 * 管线默认「自动使用最新的训练产物」，但用户既看不到当前用的是哪对权重，
 * 也无法换成别的 —— 训完多个 epoch 权重（`_e8_s320.pth` 这类）后必踩的坑。
 * 这里把 GPT / SoVITS 两组权重做成下拉：训练产物按时间从新到旧排列，
 * 并保留官方底模作为零样本克隆的退路。
 */
function WeightsPanel({
  weights,
  baseUrl,
  onChanged,
}: {
  weights: SovitsWeightList;
  baseUrl: string;
  /** 加载成功后通知外层重新探测，刷新「当前生效」状态 */
  onChanged: () => void;
}) {
  // 只在版本变化时重置回默认值：加载后外层会重新探测，
  // 若无条件重置，用户刚选好的权重会被探测结果冲掉
  const [gpt, setGpt] = useState(weights.default?.gpt ?? '');
  const [sovits, setSovits] = useState(weights.default?.sovits ?? '');
  const [appliedVersion, setAppliedVersion] = useState(weights.version);
  const [applying, setApplying] = useState(false);

  if (weights.version !== appliedVersion) {
    setAppliedVersion(weights.version);
    setGpt(weights.default?.gpt ?? '');
    setSovits(weights.default?.sovits ?? '');
  }

  const gptOptions = [
    ...weights.gpt.map((item) => ({
      value: item.path,
      label: `${item.name} · ${item.size_mb}MB`,
      trained: true,
    })),
    ...(weights.pretrained.gpt
      ? [{ value: weights.pretrained.gpt, label: '官方预训练底模 · 零样本克隆', trained: false }]
      : []),
  ];
  const sovitsOptions = [
    ...weights.sovits.map((item) => ({
      value: item.path,
      label: `${item.name} · ${item.size_mb}MB`,
      trained: true,
    })),
    ...(weights.pretrained.sovits
      ? [{ value: weights.pretrained.sovits, label: '官方预训练底模 · 零样本克隆', trained: false }]
      : []),
  ];

  const handleApply = async () => {
    setApplying(true);
    try {
      await sovitsApi.loadWeights(
        {
          version: weights.version,
          gpt: gpt || undefined,
          sovits: sovits || undefined,
          eager: true,
        },
        baseUrl,
      );
      toast.success('权重已加载', { description: '合成页会立即使用这对权重' });
      onChanged();
    } catch (error) {
      toast.error('权重加载失败', { description: (error as Error).message });
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-medium text-muted-foreground">推理权重（版本 {weights.version}）</p>
        <Badge variant="outline" className="h-5 text-[10px] font-normal">
          {weights.active.loaded ? '模型已加载' : '未加载（首次合成时自动加载）'}
        </Badge>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <div className="space-y-1.5 rounded-lg border p-3">
          <Label className="flex items-center gap-1.5 text-xs font-medium">
            <Cpu className="size-3.5" />
            GPT（语义模型）
          </Label>
          <Select value={gpt} onValueChange={setGpt}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue placeholder={gptOptions.length ? '选择权重' : '没有可用权重'} />
            </SelectTrigger>
            <SelectContent>
              {gptOptions.map((option) => (
                <SelectItem key={option.value} value={option.value} className="text-xs">
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[11px] leading-snug text-muted-foreground">
            训练产物 {weights.gpt.length} 个 · 文件名里 e = 轮数、s = 步数，一般选 e 最大的
          </p>
        </div>

        <div className="space-y-1.5 rounded-lg border p-3">
          <Label className="flex items-center gap-1.5 text-xs font-medium">
            <Cpu className="size-3.5" />
            SoVITS（声学模型）
          </Label>
          <Select value={sovits} onValueChange={setSovits}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue placeholder={sovitsOptions.length ? '选择权重' : '没有可用权重'} />
            </SelectTrigger>
            <SelectContent>
              {sovitsOptions.map((option) => (
                <SelectItem key={option.value} value={option.value} className="text-xs">
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[11px] leading-snug text-muted-foreground">
            训练产物 {weights.sovits.length} 个 · 必须与 GPT 权重来自同一版本、同一次实验
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Button size="sm" onClick={() => void handleApply()} disabled={applying}>
          {applying ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : <CheckCircle2 className="mr-1.5 size-3.5" />}
          加载所选权重
        </Button>
        <p className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
          当前生效：{weights.active.gpt ?? '未指定'} ＋ {weights.active.sovits ?? '未指定'}
        </p>
      </div>
      <p className="text-[11px] text-muted-foreground">
        没有训练产物时默认用官方底模（零样本克隆）。这里选择的是推理用的权重；
        想基于某个权重继续训练，请在训练页的「预训练权重」里填它的路径
      </p>
    </div>
  );
}

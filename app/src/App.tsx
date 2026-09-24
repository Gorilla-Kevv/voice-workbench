import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast, Toaster } from 'sonner';
import { AppShell } from '@/components/layout/AppShell';
import { KeyGate } from '@/components/features/KeyGate';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useHistory } from '@/hooks/useHistory';
import { useSettings } from '@/hooks/useSettings';
import { useSynthesis } from '@/hooks/useSynthesis';
import { useTheme } from '@/hooks/useTheme';
import { api } from '@/lib/api';
import { FALLBACK_PRESET_VOICES, MODE_META } from '@/lib/constants';
import type { RequestError } from '@/lib/errors';
import { getProvider } from '@/lib/providers/registry';
import { sovitsApi } from '@/lib/sovits';
import { BatchPage } from '@/pages/BatchPage';
import { HistoryPage } from '@/pages/HistoryPage';
import { SettingsPage } from '@/pages/SettingsPage';
import { TrainingPage } from '@/pages/TrainingPage';
import { SynthesisPage } from '@/pages/SynthesisPage';
import { VoiceClonePage } from '@/pages/VoiceClonePage';
import { VoiceDesignPage } from '@/pages/VoiceDesignPage';
import { VoiceLibraryPage } from '@/pages/VoiceLibraryPage';
import type {
  HealthInfo,
  HistoryRecord,
  NavKey,
  PresetVoice,
  SovitsLinkState,
  SynthesisResult,
  TtsMode,
} from '@/types';

/** 各导航页的标题信息 */
const PAGE_META: Record<NavKey, { title: string; description: string }> = {
  synthesis: {
    title: '通用语音合成',
    description: '使用 MiMo 官方预置音色把文字转为自然语音，支持风格标签与唱歌模式',
  },
  batch: {
    title: '批量合成',
    description: '用一份文本清单一次生成一批音频（本地 GPT-SoVITS），支持打包导出',
  },
  design: {
    title: '音色设计',
    description: '用自然语言描述你想要的音色，无需样本即可生成全新声音（MiMo 专属）',
  },
  clone: {
    title: '声音克隆',
    description: '上传或录制一段音频样本，零样本复刻目标音色（MiMo 云端）',
  },
  voices: {
    title: '音色库',
    description: '管理本地 GPT-SoVITS 的参考音频与提示文本，这是本地合成的音色来源',
  },
  history: { title: '历史记录', description: '所有合成结果保存在浏览器本地，可随时回听、下载与清理' },
  training: {
    title: '模型训练',
    description: '用本地 GPU 跑 GPT-SoVITS 全流程：降噪、切分、标注、GPT 与 SoVITS 微调',
  },
  settings: { title: '设置', description: '配置两套模型的服务地址、密钥与合成偏好' },
};

/** 不依赖云端密钥的页面（走本地服务或纯客户端） */
const LOCAL_PAGES: NavKey[] = ['voices', 'batch', 'training', 'settings', 'history'];

/**
 * 导航键 → MiMo 模型模式。
 *
 * 导航键（`NavKey`）与模型模式（`TtsMode`）是两套语义，名字也不完全对应：
 * 导航叫 `synthesis`，模型模式叫 `preset`。这里刻意写成显式映射，
 * 而不是用 `as` 把 `active` 硬转成 `TtsMode` ——
 * 后者会让类型检查失效：`MODE_META['synthesis']` 其实是 `undefined`，
 * 取值时抛 `TypeError`，React 卸载整棵树，用户看到的就是纯白页面。
 */
const NAV_TO_MODE: Partial<Record<NavKey, TtsMode>> = {
  synthesis: 'preset',
  design: 'design',
  clone: 'clone',
};

/**
 * 本地服务的探测节奏。
 *
 * 前 90 秒每 3 秒重试一次：这段正是 `import torch` + 加载模型的窗口，
 * 用户此时打开页面几乎必然探不到，密集重试能让状态在服务就绪后立刻变绿。
 * 之后降到每 30 秒 —— 既不会永久卡在「未连接」，请求量也可以忽略，
 * 服务晚几分钟起来同样能自动恢复，不需要用户刷新页面。
 */
const SOVITS_FAST_RETRY_MS = 3_000;
const SOVITS_FAST_WINDOW_MS = 90_000;
const SOVITS_SLOW_RETRY_MS = 30_000;

/**
 * 就绪后的复查间隔。
 *
 * 不做「就绪即停」：本地服务确实会中途死掉（显存不足、被手动关闭、
 * 训练把它挤掉），只探一次的话界面会一直显示「已就绪」，
 * 用户直到合成失败才知道出事了。一分钟一次环回请求，代价可以忽略。
 */
const SOVITS_READY_POLL_MS = 60_000;

/** 合成结果转为历史记录元数据（音频单独以 Blob 存储） */
function toRecord(result: SynthesisResult): HistoryRecord {
  return {
    id: result.id,
    mode: result.mode,
    text: result.text,
    instruction: result.instruction,
    voiceLabel: result.voiceLabel,
    voiceDescription: result.voiceDescription,
    model: result.model,
    format: result.format,
    bytes: result.bytes,
    durationSec: result.durationSec,
    segmentCount: result.segmentCount,
    createdAt: result.createdAt,
  };
}

function App() {
  const { settings, update, reset } = useSettings();
  const { theme, toggle: toggleTheme } = useTheme();
  const [active, setActive] = useState<NavKey>('synthesis');
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [presets, setPresets] = useState<PresetVoice[]>(FALLBACK_PRESET_VOICES);
  const [sovitsState, setSovitsState] = useState<SovitsLinkState>('checking');

  const history = useHistory(settings.historyLimit);
  const { add: addHistory, records, loading, remove, clear, loadAudio } = history;

  /** 合成成功后写入历史记录 */
  const handleSuccess = useCallback(
    async (result: SynthesisResult) => {
      try {
        // 逐段保存，历史记录中可完整回放与再次导出
        await addHistory(
          toRecord(result),
          result.segments.map((segment) => segment.blob),
        );
      } catch {
        toast.warning('结果已生成，但本地记录保存失败');
        return;
      }
      toast.success('语音合成完成', {
        description: `${result.voiceLabel} · ${result.segmentCount} 段 · ${result.durationSec.toFixed(1)} 秒 · 已保存到历史记录`,
      });
    },
    [addHistory],
  );

  const presetController = useSynthesis({ onSuccess: handleSuccess });
  const designController = useSynthesis({ onSuccess: handleSuccess });
  const cloneController = useSynthesis({ onSuccess: handleSuccess });

  // 拉取站点信息与预置音色（云端链路，一次即可）
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [healthResult, presetResult] = await Promise.allSettled([api.health(), api.presets()]);
      if (cancelled) return;
      if (healthResult.status === 'fulfilled') setHealth(healthResult.value);
      if (presetResult.status === 'fulfilled' && presetResult.value.length > 0) {
        setPresets(presetResult.value);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 本地服务状态：**轮询**而不是只探一次。
  //
  // 之前只探一次，于是「打开页面时服务还在冷启动」会把状态永久钉在「未连接」，
  // 服务随后就绪也不会恢复，用户只能手动刷新 —— 而冷启动恰恰要几十秒，
  // 这个窗口几乎必然被撞上。
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const startedAt = Date.now();

    const probe = async () => {
      let healthy = false;
      try {
        const result = await sovitsApi.health();
        if (cancelled) return;
        // 环境就绪即视为可用；权重缺失之类的阻断项由各页面自己提示
        healthy = result.ok;
      } catch {
        // 连不上就是「还没起来」，与「起来了但没就绪」在这里无需区分
      }
      if (cancelled) return;

      if (healthy) {
        setSovitsState('ready');
        timer = window.setTimeout(probe, SOVITS_READY_POLL_MS);
        return;
      }

      // 计时从页面挂载算起：页面已经开了很久才失联，直接判离线，
      // 不必再审一遍「是不是还在冷启动」。
      if (Date.now() - startedAt >= SOVITS_FAST_WINDOW_MS) {
        setSovitsState('offline');
        timer = window.setTimeout(probe, SOVITS_SLOW_RETRY_MS);
        return;
      }
      setSovitsState('checking');
      timer = window.setTimeout(probe, SOVITS_FAST_RETRY_MS);
    };

    void probe();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, []);

  // 合成失败时给出全局提示，避免用户切到后台时错过错误。
  //
  // 依赖必须写**具体的 error** 而不是整个 controller：controller 每次渲染都是
  // 新对象（useSynthesis 返回的是展开字面量），而「已等待 N 秒」的计时器每秒
  // 都 setState 一次 —— 用整个对象做依赖，这个 toast 就会每秒弹一次，
  // 直到下一次合成。error 是 state 里独立的引用，只在失败与清除时变化，
  // 所以天然只弹一次；ref 再兜一层，防同一实例被重复 setState。
  const announcedErrorRef = useRef<RequestError | null>(null);
  useEffect(() => {
    const error = presetController.error ?? designController.error ?? cloneController.error;
    if (!error || error === announcedErrorRef.current) return;
    announcedErrorRef.current = error;
    toast.error('合成失败', { description: error.fullMessage });
  }, [presetController.error, designController.error, cloneController.error]);

  const header = useMemo(() => {
    const meta = PAGE_META[active];
    const provider = getProvider(settings.providerId);
    const mode = NAV_TO_MODE[active];
    const model = mode
      ? settings.providerId === 'mimo'
        ? MODE_META[mode].model
        : `${provider.name} · ${provider.defaultModel}`
      : active === 'history'
        ? 'IndexedDB 本地存储'
        : active === 'training'
          ? '本地 GPU 训练'
          : active === 'batch' || active === 'voices'
            ? '本地 GPT-SoVITS'
            : '客户端配置';
    return { ...meta, model };
  }, [active, settings.providerId]);

  const maxTextLength = health?.limits.maxTextLength ?? 3000;

  return (
    <TooltipProvider delayDuration={200}>
      <AppShell
        active={active}
        onNavigate={setActive}
        hasServerKey={health?.hasServerKey ?? false}
        hasUserKey={Boolean(settings.apiKey.trim())}
        theme={theme}
        onToggleTheme={toggleTheme}
        header={header}
        sovitsState={sovitsState}
      >
        {/* BYOK 模式下，未配置密钥时提前引导；本地服务页面不依赖云端密钥 */}
        {!LOCAL_PAGES.includes(active) ? (
          <KeyGate
            hasServerKey={health?.hasServerKey ?? false}
            hasUserKey={Boolean(settings.apiKey.trim())}
            onGoSettings={() => setActive('settings')}
          />
        ) : null}

        {active === 'synthesis' ? (
          <SynthesisPage
            presets={presets}
            settings={settings}
            controller={presetController}
            maxTextLength={maxTextLength}
          />
        ) : null}
        {active === 'batch' ? <BatchPage settings={settings} /> : null}
        {active === 'design' ? (
          <VoiceDesignPage settings={settings} controller={designController} maxTextLength={maxTextLength} />
        ) : null}
        {active === 'clone' ? (
          <VoiceClonePage settings={settings} controller={cloneController} maxTextLength={maxTextLength} />
        ) : null}
        {active === 'voices' ? <VoiceLibraryPage /> : null}
        {active === 'history' ? (
          <HistoryPage
            records={records}
            loading={loading}
            settings={settings}
            onRemove={remove}
            onClear={clear}
            onLoadAudio={loadAudio}
          />
        ) : null}
        {active === 'training' ? <TrainingPage /> : null}

        {active === 'settings' ? (
          <SettingsPage
            settings={settings}
            update={update}
            reset={reset}
            health={health}
            onKeyChange={() => undefined}
          />
        ) : null}
      </AppShell>

      <Toaster position="top-center" richColors closeButton />
    </TooltipProvider>
  );
}

export default App;

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StartupPreloadDialog } from '@/components/features/StartupPreloadDialog';
import { preloadApi } from '@/lib/preload';
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
import { neteaseApi } from '@/lib/netease';
import { indexttsApi } from '@/lib/indextts';
import { irodoriApi } from '@/lib/irodori';
import { sovitsApi } from '@/lib/sovits';
import { localServiceApi, runtimeServiceApi } from '@/lib/localService';
import { AsrPage } from '@/pages/AsrPage';
import { BatchPage } from '@/pages/BatchPage';
import { IndexttsTtsPage } from '@/pages/IndexttsTtsPage';
import { IrodoriTtsPage } from '@/pages/IrodoriTtsPage';
import { IrodoriTrainingPage } from '@/pages/IrodoriTrainingPage';
import { NeteaseAsrPage } from '@/pages/NeteaseAsrPage';
import { NeteaseTtsPage } from '@/pages/NeteaseTtsPage';
import { OutputsPage } from '@/pages/OutputsPage';
import { SettingsPage } from '@/pages/SettingsPage';
import { SingingConversionPage } from '@/pages/SingingConversionPage';
import { TrainingPage } from '@/pages/TrainingPage';
import { SynthesisPage } from '@/pages/SynthesisPage';
import { VoiceClonePage } from '@/pages/VoiceClonePage';
import { VoiceConversionPage } from '@/pages/VoiceConversionPage';
import { VoiceDesignPage } from '@/pages/VoiceDesignPage';
import { VoiceLibraryPage } from '@/pages/VoiceLibraryPage';
import type {
  HealthInfo,
  HistoryRecord,
  ModuleState,
  ModuleStates,
  NavKey,
  PresetVoice,
  SovitsLinkState,
  SynthesisResult,
  TtsMode,
} from '@/types';

/**
 * 新板块（语音变声 / 歌声转换）的侧栏状态。
 *
 * 与 `SovitsLinkState` 的差别在「incomplete」这一态：本地服务本身是通的，
 * 但板块缺源码（vendor）或缺预训练权重 —— 这不是故障，提示该跑什么命令即可。
 */

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
    title: '音色库管理',
    description: '跨模型共享的参考音频与提示文本：网易 / IndexTTS / GPT-SoVITS 都从这里取音色（voicelib/，网关托管）',
  },
  history: {
    title: '产出记录',
    description:
      '三源合并：服务端任务（推理 / 训练，全引擎）+ 本地模型文件 + 云端合成记录，可回听、复制本机路径与清理',
  },
  training: {
    title: '音色微调训练',
    description: '用本地 GPU 跑 GPT-SoVITS 全流程：降噪、切分、标注、GPT 与 SoVITS 微调',
  },
  rvc: {
    title: '语音变声',
    description: 'RVC · 说话与配音的音色替换，支持检索索引、权重融合与 LoRA 微调',
  },
  svc: {
    title: '歌声转换',
    description: 'DDSP-SVC · 歌曲翻唱与歌声变声，联动 UVR5 分离，产出人声 / 伴奏 / 混音三件套',
  },
  asr: {
    title: '语音转文本',
    description: 'ASR · 单条音频立刻出逐字文本，也可把一批音频转成带标注的训练数据集',
  },
  'netease-tts': {
    title: '网易 · 零样本合成',
    description: 'Confucius4-TTS · 3 秒免参考文本克隆，14 语种跨语种无口音，支持情感迁移',
  },
  'netease-asr': {
    title: '网易 · 流式转写',
    description: 'Confucius4-R2T2 · append-only 真流式识别（开发中：Windows 上依赖 vLLM，暂不可用）',
  },
  'indextts-tts': {
    title: 'IndexTTS · 零样本合成',
    description: 'IndexTTS-2.5 · 3 秒参考音频克隆，8 维情感向量与语速倍率精细可控（5 语种）',
  },
  'irodori-tts': {
    title: 'Irodori · 日语合成',
    description: 'Irodori-TTS · 日语特化：emoji 风格标记 + caption 风格描述 + 固化音色直接复用',
  },
  'irodori-training': {
    title: 'Irodori · 音色固化训练',
    description: 'Speaker Inversion · 用同一个人的日语短句训出音色 embedding，之后合成不用再给参考音频',
  },
  settings: { title: '设置', description: '配置两套模型的服务地址、密钥与合成偏好' },
};

/** 不依赖云端密钥的页面（走本地服务或纯客户端） */
const LOCAL_PAGES: NavKey[] = [
  'voices', 'batch', 'training', 'settings', 'history', 'rvc', 'svc', 'asr',
  'netease-tts', 'netease-asr', 'indextts-tts',
  // Irodori 是第四个本地运行时（:9884），同样不依赖云端密钥
  'irodori-tts', 'irodori-training',
];

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
  // 网易是主服务，落地页就是它（免转写克隆 + 14 语种）。
  // 它不可用时**不静默降级**：页面会明确报错并给出切到 GPT-SoVITS 的入口（见 NeteaseTtsPage）。
  const [active, setActive] = useState<NavKey>('netease-tts');
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [presets, setPresets] = useState<PresetVoice[]>(FALLBACK_PRESET_VOICES);
  const [sovitsState, setSovitsState] = useState<SovitsLinkState>('checking');
  // 任何「本地服务 enabled 切换」都通过 service-enabled-changed 事件通知下面两个探活 effect。
  // 不直接写死 state —— 仅 bump，让下面的 effect 在 deps 里捕获这个值后立即重跑探活。
  const [serviceChangedTick, setServiceChangedTick] = useState(0);
  // 各板块的侧栏状态：与 GPT-SoVITS 同一次探活里顺带得出，不再单独轮询
  const [moduleStates, setModuleStates] = useState<ModuleStates>({
    rvc: 'checking',
    svc: 'checking',
    asr: 'checking',
    // 网易模块是独立服务（opt-in），有自己的一轮探活
    neteaseTts: 'checking',
    neteaseAsr: 'checking',
    // IndexTTS 同样是独立服务（按需启动），探活单独一轮
    indexttsTts: 'checking',
    // Irodori 是第四个独立服务（按需启动，:9884），探活同样单独一轮
    irodoriTts: 'checking',
  });

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
      // netease 两态由独立的探活循环维护，这里只占位（false 路径同样要给全字段）
      let nextModules: ModuleStates = {
        rvc: 'offline', svc: 'offline', asr: 'offline',
        neteaseTts: 'offline', neteaseAsr: 'offline', indexttsTts: 'offline', irodoriTts: 'offline',
      };
      try {
        // 1. 先问 supervisor：用户到底要不要这个服务（这里三块卡 rvc/svc/asr 共享）
        const supervisor = await localServiceApi.state();
        if (cancelled) return;
        if (!supervisor.enabled) {
          // 用户在设置里关了 GPT-SoVITS —— trainer 关停会有短暂的过程，
          // 但设置开关是用户意图的最终源。即便 trainer 还活着（race 或外部实例），
          // 也不能让侧栏继续报「已就绪」。
          setSovitsState('offline');
          nextModules = { ...nextModules, rvc: 'offline', svc: 'offline', asr: 'offline' };
        } else {
          // 2. supervisor 同意 → 探真实健康
          const result = await sovitsApi.health();
          if (cancelled) return;
          healthy = result.ok;
          if (healthy) {
            // 各板块的判定来自同一次 /health：vendor 与必需权重都齐才算就绪。
            // ASR 的语义稍有不同：它没有权重清单，两条通道（常驻依赖 / 整合包脚本）
            // 至少一条可用即算就绪。
            const caps = result.capabilities;
            nextModules = {
              rvc: caps?.voice_conversion ? 'ready' : 'incomplete',
              svc: caps?.singing_conversion ? 'ready' : 'incomplete',
              asr: caps?.speech_recognition ? 'ready' : 'incomplete',
              // 保留网易 / IndexTTS / Irodori 各自探活循环的结果，不要被这轮覆盖
              neteaseTts: 'checking',
              neteaseAsr: 'checking',
              indexttsTts: 'checking',
              irodoriTts: 'checking',
            };
          }
        }
      } catch {
        // 连不上就是「还没起来」，与「起来了但没就绪」在这里无需区分
      }
      if (cancelled) return;
      // rvc/svc/asr 用本轮结果整体替换；网易、IndexTTS、Irodori 归它们自己的探活循环管，这里原样保留
      setModuleStates((prev) => ({
        ...nextModules,
        neteaseTts: prev.neteaseTts,
        neteaseAsr: prev.neteaseAsr,
        indexttsTts: prev.indexttsTts,
        irodoriTts: prev.irodoriTts,
      }));

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
    // GPT-SoVITS 探活的依赖：服务变更广播进来时立即重探
  }, [serviceChangedTick]);

  // 网易模块的探活：独立服务（opt-in，:9882），不随 GPT-SoVITS 的探活走。
  // 节奏策略沿用同一套常数；「offline」在这里是常态而非故障 —— 侧栏文案会说明
  // 它是可选模块，运行 npm run dev:netease 即可启动。
  //
  // 「用户开关」优先于「端口有人接」：supervisor 的 `enabled=false` 才是用户的真实意图，
  // 否则端口上残留一个外部实例（手动起的、关停漏掉的）侧栏就会误报"已就绪"，
  // 与设置页的「未启动」产生矛盾（2026-10 用户实测：左侧卡是绿的、设置开关是灰的）。
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const startedAt = Date.now();

    const probe = async () => {
      let nextTts: ModuleState = 'offline';
      let nextAsr: ModuleState = 'offline';
      let allReady = false;
      try {
        // 1. 先问 supervisor：用户到底要不要这个服务
        const supervisor = await runtimeServiceApi.state('netease');
        if (cancelled) return;
        if (supervisor.enabled) {
          // 2. supervisor 同意 → 探真实健康
          const health = await neteaseApi.health();
          if (cancelled) return;
          nextTts =
            health.engines.confucius_tts.installed && health.engines.confucius_tts.package.importable
              ? 'ready'
              : 'incomplete';
          nextAsr = health.engines.r2t2.installed ? 'ready' : 'incomplete';
          allReady = nextTts === 'ready' && nextAsr === 'ready';
        } else {
          // enabled=false：用户在设置里关了。即便端口上还有外部实例残留，
          // 也不能让侧栏骗人。下次设置 toggle 会通过 service-enabled-changed 事件立刻通知这里重探。
          nextTts = 'offline';
          nextAsr = 'offline';
        }
      } catch {
        // 服务没启动或 supervisor 也够不到：保持 offline
      }
      if (cancelled) return;
      setModuleStates((prev) => ({ ...prev, neteaseTts: nextTts, neteaseAsr: nextAsr }));

      if (allReady) {
        // 就绪后降频复查：服务可能中途死掉（显存被挤、被手动关），只探一次会假绿
        timer = window.setTimeout(probe, SOVITS_READY_POLL_MS);
        return;
      }
      const wait = Date.now() - startedAt < SOVITS_FAST_WINDOW_MS ? SOVITS_FAST_RETRY_MS : SOVITS_SLOW_RETRY_MS;
      timer = window.setTimeout(probe, wait);
    };

    void probe();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
    // 网易探活的依赖：服务变更广播进来时立即重探（细节见下方的 broadcast 监听）
  }, [serviceChangedTick]);

  // IndexTTS 的探活：第三个独立运行时（按需启动，:9883），策略与网易一轮相同。
  // 「offline」是常态（它不随 dev 自动起），侧栏文案会说明怎么启动。
  // 同样的修复：以 supervisor 的 `enabled` 为主，端口可达次之
  // —— 否则外部实例残留会让侧栏误报"已就绪"。
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const startedAt = Date.now();

    const probe = async () => {
      let nextState: ModuleState = 'offline';
      try {
        const supervisor = await runtimeServiceApi.state('indextts');
        if (cancelled) return;
        if (supervisor.enabled) {
          const indexttsHealth = await indexttsApi.health();
          if (cancelled) return;
          // 服务活着但没 CUDA：环境装错了，「待补齐」指向体检命令
          nextState = indexttsHealth.cuda ? 'ready' : 'incomplete';
        }
        // else: enabled=false，与设置页保持一致显示 offline
      } catch {
        // supervisor 也拿不到：保持 offline
      }
      if (cancelled) return;
      setModuleStates((prev) => ({ ...prev, indexttsTts: nextState }));

      if (nextState === 'ready') {
        timer = window.setTimeout(probe, SOVITS_READY_POLL_MS);
        return;
      }
      const wait = Date.now() - startedAt < SOVITS_FAST_WINDOW_MS ? SOVITS_FAST_RETRY_MS : SOVITS_SLOW_RETRY_MS;
      timer = window.setTimeout(probe, wait);
    };

    void probe();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
    // IndexTTS 探活的依赖：服务变更广播进来时立即重探（见下方的 broadcast 监听）
  }, [serviceChangedTick]);

  // Irodori 的探活：第四个独立运行时（按需启动，:9884），策略与上面两个相同。
  // 「incomplete」在这里是**真信号**：服务活着但没 CUDA（环境装错）或训练档基座没下，
  // 侧栏文案分别指向 irodori:check 与 irodori:weights -- --training。
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const startedAt = Date.now();

    const probe = async () => {
      let nextState: ModuleState = 'offline';
      try {
        const supervisor = await runtimeServiceApi.state('irodori');
        if (cancelled) return;
        if (supervisor.enabled) {
          const irodoriHealth = await irodoriApi.health();
          if (cancelled) return;
          nextState = irodoriHealth.cuda && irodoriHealth.weights.ready ? 'ready' : 'incomplete';
        }
      } catch {
        // supervisor 也拿不到：保持 offline
      }
      if (cancelled) return;
      setModuleStates((prev) => ({ ...prev, irodoriTts: nextState }));

      if (nextState === 'ready') {
        timer = window.setTimeout(probe, SOVITS_READY_POLL_MS);
        return;
      }
      const wait = Date.now() - startedAt < SOVITS_FAST_WINDOW_MS ? SOVITS_FAST_RETRY_MS : SOVITS_SLOW_RETRY_MS;
      timer = window.setTimeout(probe, wait);
    };

    void probe();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [serviceChangedTick]);

  // 设置页 toggle 任何本地服务（GPT-SoVITS / 网易 / IndexTTS / Irodori）→ 广播 service-enabled-changed。
  // 上面两个探活 effect 都通过 serviceChangedTick 订阅，看到值变了立刻重启、不必等定时器窗。
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = (): void => setServiceChangedTick((tick) => tick + 1);
    window.addEventListener('service-enabled-changed', handler as EventListener);
    return () => window.removeEventListener('service-enabled-changed', handler as EventListener);
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
        ? '/v1/jobs + /api/models + IndexedDB'
        : active === 'training'
          ? '本地 GPU 训练'
          : active === 'batch' || active === 'voices'
            ? '本地 GPT-SoVITS'
        : active === 'rvc'
          ? '本地 RVC · vendor/rvc'
          : active === 'svc'
            ? '本地 DDSP-SVC · vendor/ddsp-svc'
            : active === 'asr'
              ? '本地 ASR · FunASR / faster-whisper'
              : active === 'netease-tts'
                ? 'Confucius4-TTS · netease 本地'
                : active === 'netease-asr'
                  ? 'Confucius4-R2T2 · netease 本地'
                  : active === 'indextts-tts'
                    ? 'IndexTTS-2.5 · indextts 本地'
                    : active === 'irodori-tts'
                      ? 'Irodori-TTS · irodori 本地'
                      : active === 'irodori-training'
                        ? 'Irodori SI 训练 · irodori 本地'
                        : '客户端配置';
    return { ...meta, model };
  }, [active, settings.providerId]);

  const maxTextLength = health?.limits.maxTextLength ?? 3000;

  /** 依赖 GPT-SoVITS 的页面用它把用户送到设置页开服务 */
  const goSettings = useCallback(() => setActive('settings'), []);

  // 侧栏状态卡点击 → 设置页对应锚点（滚动 + 高亮）。
  // 用 state 传而不是 hash 路由：设置页是条件渲染，挂载时读一次即可。
  const [settingsSection, setSettingsSection] = useState<string | null>(null);
  const goSettingsSection = useCallback((section: string) => {
    // 已在设置页时 setActive 不触发重挂载，靠 section 变化自己滚；
    // 不在设置页时先切页，SettingsPage 挂载后再消费这个锚点
    setSettingsSection(section);
    setActive('settings');
  }, []);

  // 启动预加载：偏好为 'ask' 时弹选择框（谁当主力由使用测试定，不预设）；
  // 若是具体模型，网关启动时已经自己加载了，这里不打扰用户。
  const [preloadAsking, setPreloadAsking] = useState(false);
  useEffect(() => {
    let cancelled = false;
    preloadApi
      .catalog()
      .then((next) => {
        if (!cancelled && next.preference === 'ask') setPreloadAsking(true);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

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
        moduleStates={moduleStates}
        onOpenSettingsSection={goSettingsSection}
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
        {active === 'batch' ? <BatchPage settings={settings} onGoSettings={goSettings} /> : null}
        {active === 'design' ? (
          <VoiceDesignPage settings={settings} controller={designController} maxTextLength={maxTextLength} />
        ) : null}
        {active === 'clone' ? (
          <VoiceClonePage settings={settings} controller={cloneController} maxTextLength={maxTextLength} />
        ) : null}
        {active === 'voices' ? <VoiceLibraryPage /> : null}
        {active === 'history' ? (
          <OutputsPage
            cloudRecords={records}
            cloudLoading={loading}
            settings={settings}
            onRemove={remove}
            onClear={clear}
            onLoadAudio={loadAudio}
            onGoSettings={goSettings}
          />
        ) : null}
        {active === 'training' ? <TrainingPage onGoSettings={goSettings} /> : null}
        {active === 'rvc' ? <VoiceConversionPage onGoSettings={goSettings} /> : null}
        {active === 'svc' ? <SingingConversionPage onGoSettings={goSettings} /> : null}
        {active === 'asr' ? <AsrPage /> : null}
        {active === 'netease-tts' ? (
          <NeteaseTtsPage onFallback={() => setActive('batch')} />
        ) : null}
        {active === 'netease-asr' ? <NeteaseAsrPage onFallback={() => setActive('asr')} /> : null}
        {active === 'indextts-tts' ? <IndexttsTtsPage /> : null}
        {active === 'irodori-tts' ? <IrodoriTtsPage /> : null}
        {active === 'irodori-training' ? (
          <IrodoriTrainingPage onGoSynth={() => setActive('irodori-tts')} />
        ) : null}

        {active === 'settings' ? (
          <SettingsPage
            settings={settings}
            update={update}
            reset={reset}
            health={health}
            onKeyChange={() => undefined}
            focusSection={settingsSection}
            onFocusHandled={() => setSettingsSection(null)}
          />
        ) : null}
      </AppShell>

      {/* 启动时选一个模型预加载（显存一次只够常驻一个） */}
      <StartupPreloadDialog open={preloadAsking} onOpenChange={setPreloadAsking} />

      <Toaster position="top-center" richColors closeButton />
    </TooltipProvider>
  );
}

export default App;

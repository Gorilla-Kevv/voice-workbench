import type { ReactNode } from 'react';
import {
  AudioLines,
  Captions,
  Disc3,
  FlaskConical,
  History,
  KeyRound,
  ListMusic,
  Loader2,
  Mic2,
  MicVocal,
  Moon,
  Palette,
  Server,
  ShieldAlert,
  ShieldCheck,
  Sun,
  Waves,
} from 'lucide-react';
import brandAvatar from '@/assets/brand/grk-avatar.png';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { ModuleStates, NavKey, SovitsLinkState } from '@/types';

interface AppShellProps {
  active: NavKey;
  onNavigate: (key: NavKey) => void;
  /** 站点是否已配置服务端密钥（仅 MiMo 需要） */
  hasServerKey: boolean;
  /** 用户是否已填写自己的密钥 */
  hasUserKey: boolean;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  children: ReactNode;
  header: { title: string; description: string; model: string };
  /** GPT-SoVITS 本地服务的连接状态 */
  sovitsState?: SovitsLinkState;
  /** 两个新板块（语音变声 / 歌声转换）的就绪状态，与 GPT-SoVITS 同一次探活得出 */
  moduleStates?: ModuleStates;
}

/**
 * 三种连接状态的侧栏文案。
 *
 * 「正在连接」这一态是必需的：本地服务冷启动要几十秒，
 * 期间把它显示成「未连接」会把正常的启动过程误报成故障。
 */
const SOVITS_STATUS_TEXT: Record<SovitsLinkState, { title: string; hint: string }> = {
  checking: {
    title: 'GPT-SoVITS 本地 · 正在连接',
    hint: '本地服务正在启动，首次加载模型约 30~90 秒',
  },
  ready: {
    title: 'GPT-SoVITS 本地 · 已就绪',
    hint: '推理与训练全部在本机执行',
  },
  offline: {
    title: 'GPT-SoVITS 本地 · 未连接',
    hint: '请先启动本地服务（运行 start.bat），界面会自动重连',
  },
};

/**
 * 两个新板块的侧栏文案。
 *
 * 「incomplete」是它们特有的态：服务是通的，但板块缺源码或缺预训练权重。
 * 与 GPT-SoVITS 的三态文案刻意保持同一句式，用户不需要重新学习一套提示语。
 */
const MODULE_STATUS_TEXT: Record<
  'rvc' | 'svc' | 'asr',
  { label: string; states: Record<ModuleStates['rvc'], { title: string; hint: string }> }
> = {
  rvc: {
    label: 'RVC 变声',
    states: {
      checking: { title: '语音变声 · 正在连接', hint: '与本地服务同源，冷启动期间不可用' },
      ready: { title: '语音变声 · 已就绪', hint: 'RVC 引擎待命，模型常驻由引擎调度' },
      incomplete: { title: '语音变声 · 待补齐', hint: '缺源码或缺权重：git submodule update --init 后运行 scripts/download_models.py' },
      offline: { title: '语音变声 · 未连接', hint: '本地服务未启动（运行 start.bat），界面会自动重连' },
    },
  },
  svc: {
    label: 'DDSP-SVC 转换',
    states: {
      checking: { title: '歌声转换 · 正在连接', hint: '与本地服务同源，冷启动期间不可用' },
      ready: { title: '歌声转换 · 已就绪', hint: 'DDSP-SVC 引擎待命，UVR5 分离随整合包可用' },
      incomplete: { title: '歌声转换 · 待补齐', hint: '缺源码或缺权重：git submodule update --init 后运行 scripts/download_models.py --engine svc' },
      offline: { title: '歌声转换 · 未连接', hint: '本地服务未启动（运行 start.bat），界面会自动重连' },
    },
  },
  asr: {
    label: 'ASR 转写',
    states: {
      checking: { title: '语音转文本 · 正在连接', hint: '与本地服务同源，冷启动期间不可用' },
      ready: { title: '语音转文本 · 已就绪', hint: '常驻模型或整合包脚本至少一条通道可用' },
      incomplete: { title: '语音转文本 · 待补齐', hint: '两条通道都不可用：装 funasr / faster-whisper，或确认整合包里有 tools/asr/ 脚本' },
      offline: { title: '语音转文本 · 未连接', hint: '本地服务未启动（运行 start.bat），界面会自动重连' },
    },
  },
};

/** 导航按「用哪个模型」分组，避免用户在两条链路之间迷路 */
const NAV_GROUPS: { title: string; items: { key: NavKey; label: string; icon: typeof Waves; hint: string }[] }[] = [
  {
    title: 'MiMo 云端',
    items: [
      { key: 'synthesis', label: '通用合成', icon: AudioLines, hint: '官方预置音色' },
      { key: 'design', label: '音色设计', icon: Palette, hint: '文字描述生成音色' },
      { key: 'clone', label: '声音克隆', icon: Mic2, hint: '上传样本即复刻' },
    ],
  },
  {
    title: 'GPT-SoVITS 本地',
    items: [
      { key: 'voices', label: '音色库', icon: Waves, hint: '参考音频与提示文本' },
      { key: 'batch', label: '批量合成', icon: ListMusic, hint: '一份清单生成一批音频' },
      { key: 'training', label: '模型训练', icon: FlaskConical, hint: '切分 / 标注 / 微调' },
    ],
  },
  {
    // 两个新板块各占一个独立入口，但共用同一组「本地引擎」——
    // 分组名体现它们是并列的能力（变声 / 翻唱），而不是一条链路的子页面
    title: 'AI 变声',
    items: [
      { key: 'rvc', label: '语音变声', icon: MicVocal, hint: 'RVC · 说话配音换音色' },
      { key: 'svc', label: '歌声转换', icon: Disc3, hint: 'DDSP-SVC · 翻唱与歌声' },
    ],
  },
  {
    // 语音转文本是独立引擎（FunASR / faster-whisper），与变声、转换不是同一条链路，
    // 所以单独成组。它在产品上有两个身份：音色库的「打底稿」工具，
    // 以及「把一批音频变成带标注的数据集」的训练入口。
    title: '语音与文本',
    items: [{ key: 'asr', label: '语音转文本', icon: Captions, hint: 'ASR · 音频转逐字文本与训练数据集' }],
  },
  {
    title: '本机',
    items: [
      { key: 'history', label: '历史记录', icon: History, hint: 'IndexedDB 本地存储' },
      { key: 'settings', label: '设置', icon: KeyRound, hint: '服务地址与偏好' },
    ],
  },
];

/**
 * 侧栏状态卡片：三态配色（就绪绿 / 待补齐琥珀 / 未连接灰），文案由调用方给。
 *
 * 「待补齐」用琥珀而不是灰是有意的 —— 它是用户可以自己解决的事（跑两条命令），
 * 不是「服务没起来」这种只能等的故障，视觉上要引导用户去看提示。
 */
function LinkCard({ state, title, hint }: { state: ModuleStates['rvc']; title: string; hint: string }) {
  const ready = state === 'ready';
  const incomplete = state === 'incomplete';
  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-lg border p-2.5 text-xs',
        ready
          ? 'bg-emerald-500/5 text-emerald-700 dark:text-emerald-400'
          : incomplete
            ? 'bg-amber-500/5 text-amber-700 dark:text-amber-400'
            : 'bg-muted/50 text-muted-foreground',
      )}
    >
      {state === 'checking' ? (
        <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin" />
      ) : (
        <Server className="mt-0.5 size-3.5 shrink-0" />
      )}
      <div>
        <p className="font-medium">{title}</p>
        <p className="mt-0.5 opacity-80">{hint}</p>
      </div>
    </div>
  );
}

/** 应用外壳：左侧导航 + 顶部标题栏 + 内容区 */
export function AppShell({
  active,
  onNavigate,
  hasServerKey,
  hasUserKey,
  theme,
  onToggleTheme,
  children,
  header,
  sovitsState = 'offline',
  moduleStates = { rvc: 'checking', svc: 'checking', asr: 'checking' },
}: AppShellProps) {
  const keyReady = hasServerKey || hasUserKey;
  const sovits = SOVITS_STATUS_TEXT[sovitsState];

  return (
    <div className="flex min-h-screen flex-col lg:flex-row">
      {/* 侧边导航 */}
      <aside className="sticky top-0 z-30 shrink-0 border-b bg-sidebar lg:flex lg:h-screen lg:w-64 lg:flex-col lg:border-b-0 lg:border-r">
        <div className="flex h-16 items-center gap-2.5 px-4 lg:h-20 lg:px-5">
          <span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-muted shadow-lg shadow-violet-500/20 ring-1 ring-border/60">
            <img
              src={brandAvatar}
              alt=""
              aria-hidden="true"
              draggable={false}
              className="size-full select-none object-cover"
            />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold leading-tight">GRK语音工作台</p>
            <p className="truncate text-[11px] text-muted-foreground">MiMo 云端 + GPT-SoVITS 本地</p>
          </div>
        </div>

        <nav className="scrollbar-thin flex gap-1 overflow-x-auto px-3 pb-3 lg:flex-1 lg:flex-col lg:overflow-y-auto lg:px-3 lg:pb-3">
          {NAV_GROUPS.map((group) => (
            <div key={group.title} className="flex gap-1 lg:block">
              <p className="hidden px-3 pb-1 pt-3 text-[10px] font-medium uppercase tracking-wider text-muted-foreground lg:block">
                {group.title}
              </p>
              {group.items.map((item) => {
                const Icon = item.icon;
                const selected = active === item.key;
                return (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => onNavigate(item.key)}
                    title={item.hint}
                    aria-current={selected ? 'page' : undefined}
                    className={cn(
                      'flex shrink-0 items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition lg:w-full',
                      selected
                        ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground shadow-xs'
                        : 'text-sidebar-foreground hover:bg-sidebar-accent/60',
                    )}
                  >
                    <Icon className={cn('size-4 shrink-0', selected && 'text-violet-600 dark:text-violet-400')} />
                    <span>{item.label}</span>
                    {selected ? (
                      <span className="ml-auto hidden text-[10px] text-muted-foreground lg:inline">●</span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        {/* 两套链路的状态：一条云端、一条本地，各自独立 */}
        <div className="hidden px-4 pb-5 lg:block">
          <div className="space-y-2">
            <div
              className={cn(
                'flex items-start gap-2 rounded-lg border p-2.5 text-xs',
                keyReady
                  ? 'bg-emerald-500/5 text-emerald-700 dark:text-emerald-400'
                  : 'bg-amber-500/5 text-amber-700 dark:text-amber-400',
              )}
            >
              {keyReady ? (
                <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
              ) : (
                <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
              )}
              <div>
                <p className="font-medium">MiMo 云端{keyReady ? '已就绪' : '待配置'}</p>
                <p className="mt-0.5 opacity-80">
                  {hasUserKey ? '使用你的个人密钥' : hasServerKey ? '使用站点公用密钥' : '请到设置页填写密钥'}
                </p>
              </div>
            </div>

            <LinkCard state={sovitsState} title={sovits.title} hint={sovits.hint} />

            {/* 各板块：与 GPT-SoVITS 同一份探活数据，同一套卡片样式 */}
            {(['rvc', 'svc', 'asr'] as const).map((key) => {
              const module = MODULE_STATUS_TEXT[key];
              const state = module.states[moduleStates[key]];
              return <LinkCard key={key} state={moduleStates[key]} title={state.title} hint={state.hint} />;
            })}
          </div>
        </div>
      </aside>

      {/* 主内容区 */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex flex-wrap items-center gap-3 border-b bg-background/85 px-4 py-3 backdrop-blur lg:px-8 lg:py-5">
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-lg font-semibold tracking-tight lg:text-xl">{header.title}</h1>
            <p className="truncate text-xs text-muted-foreground lg:text-sm">{header.description}</p>
          </div>
          <div className="flex items-center gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge variant="secondary" className="h-7 gap-1.5 px-2.5 font-mono text-[11px] font-normal">
                  <span className="size-1.5 rounded-full bg-emerald-500" />
                  {header.model}
                </Badge>
              </TooltipTrigger>
              <TooltipContent side="bottom">当前页面使用的模型</TooltipContent>
            </Tooltip>
            <Button variant="ghost" size="icon" onClick={onToggleTheme} aria-label="切换主题">
              {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
            </Button>
          </div>
        </header>

        <main className="scrollbar-thin flex-1 overflow-y-auto px-4 py-5 lg:px-8 lg:py-6">
          <div className="mx-auto w-full max-w-6xl space-y-5 pb-16">{children}</div>
        </main>
      </div>
    </div>
  );
}

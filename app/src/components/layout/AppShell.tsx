import { useState, type ReactNode } from 'react';
import {
  AudioLines,
  Captions,
  ChevronDown,
  ChevronRight,
  Disc3,
  FlaskConical,
  History,
  KeyRound,
  Landmark,
  ListMusic,
  Loader2,
  Mic2,
  MicVocal,
  Moon,
  Palette,
  Server,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Subtitles,
  Sun,
  Waves,
} from 'lucide-react';
import brandAvatar from '@/assets/brand/grk-avatar.png';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { FlowGuide } from '@/components/features/FlowGuide';
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
  keyof ModuleStates,
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
  neteaseTts: {
    label: '网易 TTS',
    states: {
      checking: { title: '网易合成 · 正在连接', hint: 'netease 服务探测中，稍候自动恢复' },
      ready: { title: '网易合成 · 已就绪', hint: 'Confucius4-TTS 权重就绪，推理全在本机' },
      incomplete: { title: '网易合成 · 待补齐', hint: '缺权重或缺依赖：按 netease/README.md 下载权重并建 venv（npm run netease:check 体检）' },
      offline: { title: '网易合成 · 未启动', hint: '主服务未起来：先跑 npm run netease:check 体检，再 npm run dev:netease 单独启动' },
    },
  },
  neteaseAsr: {
    label: '网易转写',
    states: {
      checking: { title: '网易转写 · 正在连接', hint: 'netease 服务探测中，稍候自动恢复' },
      ready: { title: '网易转写 · 已就绪', hint: 'Confucius4-R2T2 模型就位，首次转写自动拉起引擎' },
      incomplete: { title: '网易转写 · 待补齐', hint: '缺权重或缺依赖：按 netease/README.md 下载 R2T2 权重并安装 r2t2 + vllm' },
      offline: { title: '网易转写 · 未启动', hint: '主服务未起来：运行 npm run dev:netease（Windows 上 R2T2 还需 WSL2，见 netease/README.md）' },
    },
  },
  indexttsTts: {
    label: 'IndexTTS',
    states: {
      checking: { title: 'IndexTTS · 正在连接', hint: 'indextts 服务探测中，稍候自动恢复' },
      ready: { title: 'IndexTTS · 已就绪', hint: 'IndexTTS-2.5 权重就绪，推理全在本机（情感向量 / 语速可控）' },
      incomplete: { title: 'IndexTTS · 待补齐', hint: 'CUDA 不可用或权重缺失：跑 npm run indextts:check 体检' },
      offline: { title: 'IndexTTS · 未启动', hint: '按需模块：npm run dev:indextts 启动（环境见 docs/INDEX-TTS-INTEGRATION.md）' },
    },
  },
};

/** 导航按「用哪个模型」分组，避免用户在两条链路之间迷路 */
const NAV_GROUPS: { title: string; items: { key: NavKey; label: string; icon: typeof Waves; hint: string }[] }[] = [
  {
    // 网易是**主服务**：免转写克隆 + 14 语种，日常合成从它进。
    // 分组排在第一位不是装饰 —— 导航按「用哪个模型」排，主服务就该在最上面。
    title: '网易 Confucius4 · 主服务',
    items: [
      { key: 'netease-tts', label: '零样本合成', icon: Landmark, hint: 'Confucius4-TTS · 免转写克隆 / 14 语种' },
      { key: 'netease-asr', label: '流式转写', icon: Subtitles, hint: 'Confucius4-R2T2 · append-only 真流式（开发中）' },
    ],
  },
  {
    // IndexTTS 是**补充**定位（5 语种，跨语种弱于网易）；独有价值是情感向量 / 语速这类精细可控。
    // 主力归属由使用测试决定（用户 2026-10 裁决），所以组名不下「主/辅」的定论，只标能力差异。
    title: 'IndexTTS · 情感可控',
    items: [
      { key: 'indextts-tts', label: '零样本合成', icon: SlidersHorizontal, hint: 'IndexTTS-2.5 · 8 维情感向量 / 语速倍率 / 5 语种' },
    ],
  },
  {
    title: 'MiMo 云端',
    items: [
      { key: 'synthesis', label: '通用合成', icon: AudioLines, hint: '官方预置音色' },
      { key: 'design', label: '音色设计', icon: Palette, hint: '文字描述生成音色' },
      { key: 'clone', label: '声音克隆', icon: Mic2, hint: '上传样本即复刻' },
    ],
  },
  {
    title: 'GPT-SoVITS · 辅助',
    items: [
      { key: 'voices', label: '音色库', icon: Waves, hint: '参考音频与提示文本' },
      { key: 'batch', label: '批量合成', icon: ListMusic, hint: '一份清单生成一批音频' },
      { key: 'training', label: '模型训练', icon: FlaskConical, hint: '切分 / 标注 / 微调' },
    ],
  },
  {
    // 语音变声与歌声转换是**两个不同的上游项目**（RVC / DDSP-SVC），
    // 以前挤在「AI 变声」一组里，用户分不清点进去用的是什么模型。
    // 现在各自成组，组名直接写模型名 —— 导航按「用哪个模型」分，模型名必须在**看得见**的地方
    // （hint 只出现在 hover 提示里，不算数）。
    title: 'RVC 变声',
    items: [{ key: 'rvc', label: '语音变声', icon: MicVocal, hint: 'RVC 项目 · 说话 / 配音换音色' }],
  },
  {
    title: 'DDSP-SVC 歌声',
    items: [{ key: 'svc', label: '歌声翻唱', icon: Disc3, hint: 'DDSP-SVC 项目 · 翻唱与歌声转换（含 UVR5 分离）' }],
  },
  {
    // 语音转文本是第三条独立链路（FunASR / faster-whisper），与上面两个不是同一套模型。
    // 它在产品上有两个身份：音色库的「打底稿」工具，以及「把一批音频变成带标注的数据集」的训练入口。
    title: 'ASR 语音转文本',
    items: [{ key: 'asr', label: '转写与数据集', icon: Captions, hint: 'FunASR / faster-whisper · 逐字文本与训练数据集' }],
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
/** 侧栏状态卡的统一数据形状（MiMo 云端与本地各引擎走同一套渲染） */
interface StatusCard {
  id: string;
  state: ModuleStates['rvc'];
  title: string;
  hint: string;
  icon: 'shield' | 'server';
}

function LinkCard({ state, title, hint, icon = 'server' }: Omit<StatusCard, 'id'>) {
  const ready = state === 'ready';
  const incomplete = state === 'incomplete';
  const Icon = icon === 'shield' ? (ready ? ShieldCheck : ShieldAlert) : state === 'checking' ? Loader2 : Server;
  return (
    <div
      className={cn(
        'flex items-start gap-1.5 rounded-md border px-2 py-1.5 text-[11px] leading-snug',
        ready
          ? 'bg-emerald-500/5 text-emerald-700 dark:text-emerald-400'
          : incomplete
            ? 'bg-amber-500/5 text-amber-700 dark:text-amber-400'
            : 'bg-muted/50 text-muted-foreground',
      )}
    >
      <Icon className={cn('mt-[1px] size-3 shrink-0', state === 'checking' && 'animate-spin')} />
      <div className="min-w-0">
        <p className="truncate font-medium">{title}</p>
        <p className="opacity-80">{hint}</p>
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
  moduleStates = { rvc: 'checking', svc: 'checking', asr: 'checking', neteaseTts: 'checking', neteaseAsr: 'checking', indexttsTts: 'checking' },
}: AppShellProps) {
  const keyReady = hasServerKey || hasUserKey;
  const sovits = SOVITS_STATUS_TEXT[sovitsState];

  // 排列顺序即优先级：网易（主服务）在前，GPT-SoVITS 与其它本地引擎居中，云端放最后
  const statusCards: StatusCard[] = [
    ...(['neteaseTts', 'neteaseAsr'] as const).map((key) => {
      const module = MODULE_STATUS_TEXT[key];
      const state = moduleStates[key];
      return { id: key, state, title: module.states[state].title, hint: module.states[state].hint, icon: 'server' } as const;
    }),
    { id: 'sovits', state: sovitsState, title: sovits.title, hint: sovits.hint, icon: 'server' },
    ...(['rvc', 'svc', 'asr', 'indexttsTts'] as const).map((key) => {
      const module = MODULE_STATUS_TEXT[key];
      const state = moduleStates[key];
      return { id: key, state, title: module.states[state].title, hint: module.states[state].hint, icon: 'server' } as const;
    }),
    {
      id: 'mimo',
      state: keyReady ? 'ready' : 'incomplete',
      title: `MiMo 云端${keyReady ? '已就绪' : '待配置'}`,
      hint: hasUserKey ? '使用你的个人密钥' : hasServerKey ? '使用站点公用密钥' : '请到设置页填写密钥',
      icon: 'shield',
    },
  ];
  // 展开/折叠**只由用户手动控制**（点标题行）：不随探活进度或加载成败自动切换 ——
  // 之前的「探活期间强制全列、就绪后自动收起」会让页面在用户眼皮底下自己变，体验很差。
  // 折叠时只剩标题行，「N 项待处理」计数照常显示，信息不丢。
  const pendingCards = statusCards.filter((card) => card.state !== 'ready');
  const [showAllStatuses, setShowAllStatuses] = useState(false);
  const visibleCards = showAllStatuses ? statusCards : [];

  return (
    <div
      className="flex min-h-screen flex-col lg:flex-row"
      onDragOver={(event) => {
        // 落在上传区之外的误拖，浏览器默认会把整个 SPA 导航走（当前表单状态全没）。
        // 上传区的处理器先 preventDefault，冒泡到这里时已置位，所以只管兜住剩下的。
        if (!event.defaultPrevented) event.preventDefault();
      }}
      onDrop={(event) => {
        if (!event.defaultPrevented) event.preventDefault();
      }}
    >
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
            <p className="truncate text-[11px] text-muted-foreground">网易主服务 · GPT-SoVITS 辅助</p>
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

        {/* 两套链路的状态：一条云端、一条本地，各自独立。
            展开/折叠完全由用户点标题行控制，不随加载进度自动变化。 */}
        <div className="hidden px-4 pb-4 lg:block">
          <div className="space-y-1.5">
            <button
              type="button"
              onClick={() => setShowAllStatuses((prev) => !prev)}
              aria-expanded={showAllStatuses}
              title={showAllStatuses ? '收起状态列表' : '展开全部状态'}
              className="flex w-full items-center gap-1 rounded-md px-1 py-0.5 text-[11px] text-muted-foreground transition hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
            >
              {showAllStatuses ? <ChevronDown className="size-3 shrink-0" /> : <ChevronRight className="size-3 shrink-0" />}
              <span>{showAllStatuses ? '全部状态' : '状态'}</span>
              {pendingCards.length > 0 ? (
                <span className="ml-auto text-amber-600 dark:text-amber-400">{pendingCards.length} 项待处理</span>
              ) : (
                <span className="ml-auto">全部就绪</span>
              )}
            </button>

            {visibleCards.map((card) => (
              <LinkCard key={card.id} state={card.state} title={card.title} hint={card.hint} icon={card.icon} />
            ))}
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

      {/* 操作指引：贴在右边缘，鼠标移过去即展开。放在外壳里而不是各页面里 ——
          它要能「跳到下一步所在的页面」，只有外壳拿得到导航能力。 */}
      <FlowGuide page={active} onNavigate={onNavigate} />
    </div>
  );
}

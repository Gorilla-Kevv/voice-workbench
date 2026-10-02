/**
 * 操作指引（结构化）。
 *
 * 与旧版 `flowGuide.ts` 的差别：旧版只有「一句话目标 + 一堆 tips」，
 * 看不出**先做什么、在哪做、做完去哪**。这里每一步都强制写三件事：
 *
 * 1. `how` —— 具体怎么操作（点哪个按钮、填什么、判据是什么）；
 * 2. `page` —— 这一步在哪个页面做（跨页流程据此标注页面职责）；
 * 3. `prev` / `next` —— 上一步应留下什么、下一步该跳转到哪。
 *
 * `autoKey` 是给「自动打勾」用的信号名：页面在关键动作里调 `markGuideEvent(key)`，
 * 这一步就会自己变成已完成，不需要用户手动点（详见 hooks/useGuideProgress）。
 */

import type { NavKey } from '@/types';

export interface GuideStep {
  id: string;
  /** 这一步要达成的目标（一句） */
  title: string;
  /** 具体操作步骤：点什么、填什么、怎么判断做对了 */
  how: string[];
  /** 这一步属于哪个页面 */
  page: NavKey;
  /** 上一步（可能在别的页面）应当完成到什么程度 */
  prev?: string;
  /** 下一步去哪个页面、做什么 */
  next?: string;
  /** 什么情况可以跳过 */
  optional?: string;
  /** 自动完成的信号键 */
  autoKey?: string;
}

export interface Guide {
  id: string;
  title: string;
  summary: string;
  /** 该指引涉及的页面（当前页不在其中时不会默认选中它） */
  pages: NavKey[];
  steps: GuideStep[];
}

export const GUIDES: Guide[] = [
  {
    id: 'netease-first',
    title: '网易合成 · 首次跑通',
    summary: '主服务的第一条合成：预热引擎 → 给参考音频 → 出声。',
    pages: ['netease-tts'],
    steps: [
      {
        id: 'warmup',
        title: '把 TTS 引擎预热起来',
        page: 'netease-tts',
        how: [
          '打开「网易 · 零样本合成」页，先看顶部的资源预估卡：显存需要约 4.9 GB，不够就先关掉占显存的程序。',
          '点引擎状态卡里的「预热引擎」，首次加载约 60~70 秒。',
          '看到「已加载 · cuda」的绿色标记即算完成；模型会常驻，之后不用再预热。',
        ],
        next: '仍在本页：下一步选参考音频。',
      },
      {
        id: 'ref-audio',
        title: '准备一段 ≥3 秒的参考音频',
        page: 'netease-tts',
        how: [
          '上传一段干声（wav / mp3 / flac 均可），或切到「从音色库选择」直接复用已有音色的参考音频。',
          '不需要填逐字转写文本 —— 这是网易模块与 GPT-SoVITS 最大的区别。',
          '选好后下方会出现播放器，点一下确认能出声。',
        ],
        prev: '引擎已预热（上一步）。',
        next: '仍在本页：下一步写要合成的文本。',
        autoKey: 'netease:ref-ready',
      },
      {
        id: 'text',
        title: '写文本、选语种',
        page: 'netease-tts',
        how: [
          '在「合成内容」里填要说的话，长文本建议拆成几段分批合成。',
          '语种下拉里选 14 种之一；中文默认 zh，跨语种无口音是它的强项（可用英文试一次对比）。',
        ],
        prev: '参考音频已选好。',
        next: '仍在本页：下一步开始合成。',
      },
      {
        id: 'synthesize',
        title: '合成并回听',
        page: 'netease-tts',
        how: [
          '点「开始合成」，第一条会比较慢（算子预热，可能几分钟），之后稳态 RTF 约 2.0~2.5。',
          '结果会留在「合成结果」列表里 —— 每条独立保留，新的不会覆盖旧的。',
          '点结果卡展开可播放 / 下载 WAV；音色不像就换一段参考音频重来。',
        ],
        prev: '文本与语种已填好。',
        next: '想批量出音频就去「GPT-SoVITS · 辅助 → 批量合成」（更快）；想跨语种就回本页换语种再合成。',
        autoKey: 'netease:first-synth',
      },
    ],
  },
  {
    id: 'gpt-sovits-training',
    title: 'GPT-SoVITS · 从素材到可用音色',
    summary: '跨 4 个页面协作的完整训练链：每步都标了「上一页留下什么、本页做什么、下一页去哪」。',
    pages: ['training', 'voices', 'batch', 'asr'],
    steps: [
      {
        id: 'corpus',
        title: '准备语料：单人、干净、无 BGM',
        page: 'training',
        how: [
          '在「语料与实验」里填实验名，选素材目录（或直接上传音频）。',
          '判据：单人说话、无背景音乐、无混响；零样本克隆 5 秒即可，微调至少 1 分钟有效语音。',
          '素材带 BGM 才需要下一步的分离，干净录音可直接跳到切分。',
        ],
        next: '仍在本页：下一步做分离（或直接切分）。',
      },
      {
        id: 'uvr',
        title: '人声分离（可选）',
        page: 'training',
        how: [
          '带 BGM 或明显噪声时才做；优先选 HP2（无和声）或 HP5（有和声）。',
          '注意：BS-RoFormer 在本机缺同名 .yaml，暂时不可用（补齐配置后会自动出现在列表里）。',
          '分离后产物里会有「人声」和「other」两份，切分前把 other 那份删掉。',
        ],
        prev: '素材已上传 / 目录已选好。',
        next: '仍在本页：下一步切分。',
        optional: '干净录音可整步跳过。',
      },
      {
        id: 'slice',
        title: '切分成 5~15 秒小段',
        page: 'training',
        how: [
          '输入路径填分离输出目录（没做分离就填原始素材目录）。',
          '参数保持默认；若切出来全部偏长，把 min_interval 的 300 改成 100 或 200。',
          '切完看结果面板：按时长降序，手动删掉或再切超过约 15 秒的超长条。',
        ],
        prev: '素材（或分离后的人声）已就位。',
        next: '下一步去「ASR 语音转文本」页做听写，或在本页继续（本页内置了同一条通道）。',
      },
      {
        id: 'asr',
        title: 'ASR 听写出逐字文本',
        page: 'asr',
        how: [
          '在「ASR 语音转文本」页上传切好的音频，选通道：常驻模型快，官方脚本可复现。',
          '中文 / 粤语用 FunASR，其它语种用 faster-whisper。',
          '产出 .list 清单，格式是「音频路径|说话人|语种|文本」。',
        ],
        prev: '上一步（训练页）已切好 5~15 秒小段。',
        next: '回「GPT-SoVITS · 辅助 → 模型训练」继续校对与训练。',
      },
      {
        id: 'proofread',
        title: '校对文本（可选但很值）',
        page: 'training',
        how: [
          '左边改文本、右边听音频逐条核对，改掉识别错字。',
          '错字会被模型原样学进去 —— 合成结果里某个字读音怪，回这里改对应条目最有效。',
        ],
        prev: '上一步（ASR 页）已产出 .list 清单。',
        next: '仍在本页：下一步开始训练。',
        optional: '官方认为耗时且收益有限，可跳过。',
      },
      {
        id: 'train',
        title: '训练：先 SoVITS（s2）后 GPT（s1）',
        page: 'training',
        how: [
          '顺序是官方顺序 s2 → s1，界面已按此排列，不要手动颠倒。',
          '开跑前看资源预估卡：训练门槛 6 GB 显存，不够先释放或降 batch size。',
          '走任务队列，可在「任务」里看日志与进度。',
        ],
        prev: '清单已校对（或已决定跳过校对）。',
        next: '下一步去「音色库」加载刚训好的权重。',
      },
      {
        id: 'load-weights',
        title: '在音色库加载新权重',
        page: 'voices',
        how: [
          '到「音色库 → 权重」选择刚训练出的 GPT / SoVITS 权重并加载。',
          '加载成功后再建一条音色，把参考音频与提示文本填上。',
        ],
        prev: '上一步（训练页）训练已完成并产出权重。',
        next: '下一步去「批量合成」验收效果。',
      },
      {
        id: 'verify',
        title: '批量合成验收',
        page: 'batch',
        how: [
          '把要验收的台词粘成一张清单（每行一条），先「解析清单」确认条数。',
          '建议先「试听首条」——音色选错是最常见的返工原因。',
          '结果按批次保留，可逐条下载或打包 ZIP。',
        ],
        prev: '上一步（音色库）已加载权重并建好音色。',
        next: '回到「历史记录」可回听；不满意就回训练页调参重训。',
      },
    ],
  },
  {
    id: 'first-run',
    title: '新手总览 · 五步跑通全站',
    summary: '第一次用：先出声，再建自己的音色，最后批量验收。',
    pages: ['settings', 'synthesis', 'voices', 'netease-tts', 'history'],
    steps: [
      {
        id: 'key',
        title: '配置云端密钥（或确认走本地）',
        page: 'settings',
        how: [
          '要用 MiMo 云端音色就去「设置」填密钥；只走本地模型可以跳过这一步。',
          '侧栏状态卡会显示「MiMo 云端 已就绪 / 待配置」，以此为准。',
        ],
        next: '下一步去「网易 · 零样本合成」（主服务，免转写克隆）。',
        optional: '只用本地模型可跳过。',
      },
      {
        id: 'first-sound',
        title: '用主服务出第一条声音',
        page: 'netease-tts',
        how: [
          '打开「网易 Confucius4 · 主服务 → 零样本合成」，按该页指引跑通第一条。',
          '只需要 3 秒参考音频，不用写逐字文本。',
        ],
        prev: '（可选）密钥已配置。',
        next: '下一步去「音色库」建立自己的音色。',
      },
      {
        id: 'voice',
        title: '在音色库建一条音色',
        page: 'voices',
        how: [
          '上传参考音频并填提示文本（GPT-SoVITS 这条路需要逐字文本）。',
          '想省事就先去「ASR 语音转文本」把文本听写出来，再粘回来。',
        ],
        prev: '已能用主服务出声。',
        next: '下一步去「通用合成 / 批量合成」用这条音色合成。',
      },
      {
        id: 'synth',
        title: '用自己的音色合成',
        page: 'synthesis',
        how: [
          '在「通用合成」选本地 GPT-SoVITS，挑刚建的音色，输入文本合成。',
          '多条台词就用「批量合成」一次跑完。',
        ],
        prev: '音色库里已有可用音色。',
        next: '下一步去「历史记录」回听与下载。',
      },
      {
        id: 'history',
        title: '回听与导出',
        page: 'history',
        how: ['在「历史记录」里回听、下载之前合成的结果（本地 IndexedDB 存储）。'],
        prev: '已经合成过至少一条。',
        next: '想长期保留自己的音色，就进「模型训练」跑一遍完整训练链（见 GPT-SoVITS 指引）。',
      },
    ],
  },
];

/** 当前页相关的指引：命中 page 的排前面，其余作为「其它指引」仍可选 */
export function guidesForPage(page: NavKey): { primary: Guide[]; others: Guide[] } {
  const primary = GUIDES.filter((guide) => guide.pages.includes(page));
  const others = GUIDES.filter((guide) => !guide.pages.includes(page));
  return { primary, others };
}

export function findGuide(id: string): Guide | undefined {
  return GUIDES.find((guide) => guide.id === id);
}

/** 步骤在本页的序号（用于「跳到第 N 步」之类的提示） */
export function stepIndex(guide: Guide, stepId: string): number {
  return guide.steps.findIndex((step) => step.id === stepId);
}

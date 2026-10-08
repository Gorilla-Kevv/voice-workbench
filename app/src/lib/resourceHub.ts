/**
 * 「资源库」面板的数据（阶段 26补9）。
 *
 * 来源：2026-10-08 的调研（WebSearch + 逐条核实 + B站 API 抓简介/评论）。
 * 每条带 verified 标记：✔ = 当时直连验证过存在；⚠ = 仅搜索/简介/评论区出现，
 * 未逐一验证可用性 —— 网盘链接尤其容易失效，如实标注，不冒充可靠。
 *
 * 展示在两处：顶栏「资源库」下拉面板 + 音色库页右侧三分之一内嵌卡。
 */
export interface HubLink {
  label: string;
  url: string;
  note?: string;
  /** true = 核实过存在；false = 未核实（评论区/简介/搜索结果） */
  verified: boolean;
  /** 额外角标：付费门槛 / 需申请 / 需梯子 等 */
  tags?: string[];
}

export interface HubCategory {
  title: string;
  desc?: string;
  links: HubLink[];
}

export const RESOURCE_HUB_UPDATED = '2026-10-08';

export const RESOURCE_HUB: HubCategory[] = [
  {
    title: '资源站 · 模型与数据集下载',
    desc: '角色语音数据集 + 训练好的 TTS/SVC 音色模型，开箱即用',
    links: [
      {
        label: 'AI Hobbyist 资源库',
        url: 'https://res.acgnai.top/',
        note: '本站原入口：星穹铁道 / 原神 / 鸣潮角色语音数据集与开源模型',
        verified: true,
      },
      {
        label: 'AI-Hobbyist · GitHub 组织',
        url: 'https://github.com/AI-Hobbyist',
        note: 'res.acgnai.top 的官方源码侧，数据集 + 训练好的模型，免登录直下',
        verified: true,
      },
      {
        label: 'kbiao.net（RVC 聚合站）',
        url: 'https://www.kbiao.net/',
        note: 'RVC 模型 / 变声器 / GPT-SoVITS 整合包；部分资源要会员，许可不明',
        verified: true,
        tags: ['部分付费'],
      },
      {
        label: 'B站合集 · RVC 模型网盘自取',
        url: 'https://www.bilibili.com/list/ml3311879512',
        note: '免费 RVC 音色网盘合集（百度网盘 / 夸克），链接在视频简介内',
        verified: false,
      },
    ],
  },
  {
    title: '现成模型权重 · HuggingFace / GitHub',
    desc: '按声线分区的 VC/SVS 权重与话题索引',
    links: [
      {
        label: 'ARIRIGI/SpeechModels',
        url: 'https://huggingface.co/ARIRIGI/SpeechModels',
        note: 'HF 上按声线分区的 VC/SVS 权重推理库，十余区块，MIT；可走 hf-mirror.com 免梯子',
        verified: true,
      },
      {
        label: 'GitHub 话题 · so-vits-svc',
        url: 'https://github.com/topics/so-vits-svc',
        note: 'so-vits-svc 生态索引（找模型/工具从这里顺藤摸瓜）',
        verified: true,
      },
      {
        label: 'awesome-voice-agents',
        url: 'https://github.com/yzfly/awesome-voice-agents',
        note: '语音 Agent / TTS / 克隆项目清单（索引性质，非模型库）',
        verified: true,
      },
    ],
  },
  {
    title: '训练语料 · 多说话人数据集',
    desc: '喂给「音色微调训练」的原料；许可与规模已标注',
    links: [
      {
        label: 'AISHELL-3（OpenSLR 93）',
        url: 'https://www.openslr.org/93/',
        note: '中文 218 人 / 85 小时，Apache-2.0，境内中欧镜像直下 —— 训练首选',
        verified: true,
      },
      {
        label: 'THCHS-30（OpenSLR 18）',
        url: 'https://www.openslr.org/18/',
        note: '清华单说话人 12 小时为主，Apache-2.0；适合预训练而非多音色',
        verified: true,
      },
      {
        label: 'Emilia-Dataset',
        url: 'https://huggingface.co/datasets/emilianotes/Emilia-Dataset',
        note: '10 万+ 小时多语种（含大量中文），体量最大',
        verified: true,
        tags: ['需 HF 账号申请', '仅限研究'],
      },
      {
        label: 'Common Voice 中文',
        url: 'https://commonvoice.mozilla.org/zh/datasets',
        note: 'CC0 免登录；页面需 JS，境内访问或需梯子',
        verified: true,
      },
      {
        label: 'KANTTS 公开数据（ModelScope）',
        url: 'https://modelscope.cn/datasets/speech_tts/speech_kantts_opendata',
        note: '中文多说话人，MIT；实测仅 379 条 / 0.5h，适合试水',
        verified: true,
      },
      {
        label: 'WenetSpeech4TTS',
        url: 'https://arxiv.org/html/2406.05763v1',
        note: '12,800 小时中文 TTS 语料；此处是论文页，正式下载入口见论文内链接（HF / 魔搭同步）',
        verified: false,
      },
    ],
  },
  {
    title: 'B站教程与模型配布',
    desc: '导入教程 + UP 主自训模型；网盘链出自简介/评论区，均未经复核，失效属常态',
    links: [
      {
        label: '洛天依声线 GPT-SoVITS 模型 · 导入教程',
        url: 'https://www.bilibili.com/video/BV1fBr9BnExH',
        note: 'UP：只想干饭的麦克斯韦妖。模型发布地址在置顶评论：https://b23.tv/zzkGCPB（禁止商用）',
        verified: false,
        tags: ['评论区网盘'],
      },
      {
        label: '瓦瓦同款 RVC 变声 · 模型免费放',
        url: 'https://www.bilibili.com/video/BV1QvCZBdEFd',
        note: 'UP：找单车的老男孩。简介网盘：https://pan.quark.cn/s/a695a787e37e 、https://pan.quark.cn/s/601c80e2b7fa',
        verified: false,
        tags: ['简介网盘'],
      },
      {
        label: 'Mortis RVC 模型配布（实时变声）',
        url: 'https://www.bilibili.com/video/BV1Kbedz6Eo6',
        note: 'UP：傲娇墨提斯。简介网盘：https://pan.baidu.com/s/1Jber9FOPdvYiKN-9b_fZkw?pwd=muzi',
        verified: false,
        tags: ['简介网盘'],
      },
      {
        label: 'RVC 变声器保姆级教程（专栏）',
        url: 'https://www.bilibili.com/read/cv40121911/',
        note: '专栏教程，附整合包与素材指引',
        verified: false,
      },
    ],
  },
  {
    title: '查证说明（避免踩坑）',
    desc: '调研时找过但没能证实的条目，列出来防止二次上当',
    links: [
      {
        label: '「AI-Voice-Archive」仓库',
        url: 'https://github.com/search?q=AI-Voice-Archive',
        note: '多个清单文章提到，但未找到同名可靠仓库；遇到声称是它的下载页请多留个心眼',
        verified: false,
      },
      {
        label: 'DiDiSpeech / CSARC',
        url: 'https://arxiv.org/abs/2105.02025',
        note: '未找到可靠官方直链，二手列表不可信；DiDiSpeech 论文页可作线索',
        verified: false,
      },
    ],
  },
];

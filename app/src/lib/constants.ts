import type { AppSettings, PresetVoice, TtsMode } from '@/types';

/** 官方预置音色兜底列表，实际以 /api/voices/presets 为准 */
export const FALLBACK_PRESET_VOICES: PresetVoice[] = [
  { id: 'mimo_default', label: 'MiMo 默认', language: '自适应', gender: '自适应', description: '按部署集群自动选择默认音色' },
  { id: '冰糖', label: '冰糖', language: '中文', gender: '女声', description: '清甜自然，适合通用播报' },
  { id: '茉莉', label: '茉莉', language: '中文', gender: '女声', description: '温柔知性，适合叙述讲解' },
  { id: '苏打', label: '苏打', language: '中文', gender: '男声', description: '清爽年轻，适合资讯播报' },
  { id: '白桦', label: '白桦', language: '中文', gender: '男声', description: '沉稳厚重，适合纪录片' },
  { id: 'Mia', label: 'Mia', language: '英文', gender: '女声', description: 'Bright and friendly' },
  { id: 'Chloe', label: 'Chloe', language: '英文', gender: '女声', description: 'Warm and expressive' },
  { id: 'Milo', label: 'Milo', language: '英文', gender: '男声', description: 'Clear and steady' },
  { id: 'Dean', label: 'Dean', language: '英文', gender: '男声', description: 'Deep and calm' },
];

/** 模型元信息，用于界面标注 */
export const MODE_META: Record<
  TtsMode,
  { model: string; label: string; short: string; description: string; streaming: boolean }
> = {
  preset: {
    model: 'mimo-v2.5-tts',
    label: '通用语音合成',
    short: '预置音色',
    description: '使用官方精品预置音色，支持音频标签、情绪风格与唱歌模式',
    streaming: true,
  },
  design: {
    model: 'mimo-v2.5-tts-voicedesign',
    label: '音色设计',
    short: '描述生成',
    description: '用自然语言描述音色特征，无需样本即可生成全新声音',
    streaming: false,
  },
  clone: {
    model: 'mimo-v2.5-tts-voiceclone',
    label: '声音克隆',
    short: '样本复刻',
    description: '上传 mp3/wav 音频样本，零样本复刻目标音色',
    streaming: false,
  },
};

/**
 * 语言筛选器。
 * 依据官方文档（2026-07-15 更新）：预置音色目前仅覆盖中文与英文两族，
 * 因此这里不做超出官方能力的语种声明。
 */
export const LANGUAGE_FILTERS: { id: 'all' | '中文' | '英文'; label: string; hint: string }[] = [
  { id: 'all', label: '全部', hint: '9 个官方预置音色' },
  { id: '中文', label: '中文', hint: '冰糖 · 茉莉 · 苏打 · 白桦' },
  { id: '英文', label: 'English', hint: 'Mia · Chloe · Milo · Dean' },
];

/** 官方开放的语言能力说明，用于在界面上如实标注边界 */
export const LANGUAGE_CAPABILITY = {
  supported: ['中文（普通话）', '中文方言：东北话 / 四川话 / 河南话 / 粤语', '地域腔调：台湾腔', 'English'],
  experimental: ['音色设计支持描述外语口音（官方示例含俄罗斯口音），可作为实验性尝试'],
  unsupported: ['日语、韩语等其它语种官方暂未开放，强行合成效果无法保证'],
} as const;

/**
 * 方言与地域腔调快捷入口。
 * 这些标签会作为整体风格标签写入文本开头，形如 (粤语)正文。
 */
export const DIALECT_PRESETS: { tag: string; desc: string; sample: string }[] = [
  { tag: '东北话', desc: '东北官话，幽默直爽', sample: '哎呀妈呀，这天儿也忒冷了吧！' },
  { tag: '四川话', desc: '西南官话，麻辣鲜香', sample: '这个火锅味道巴适得板！' },
  { tag: '河南话', desc: '中原官话，朴实亲切', sample: '恁咋恁能咧，真中！' },
  { tag: '粤语', desc: '广府话，需注意用字', sample: '呢个真係好正啊！' },
  { tag: '台湾腔', desc: '柔和语调，尾音上扬', sample: '这个真的超好吃的啦！' },
];

/** 整体风格标签，写在目标文本开头，形如 (开心 兴奋) */
export const STYLE_TAGS: { group: string; tags: string[] }[] = [
  { group: '基础情绪', tags: ['开心', '悲伤', '愤怒', '恐惧', '惊讶', '兴奋', '委屈', '平静', '冷漠'] },
  { group: '复合情绪', tags: ['怅然', '欣慰', '无奈', '愧疚', '释然', '嫉妒', '厌倦', '忐忑', '动情'] },
  { group: '整体语调', tags: ['温柔', '高冷', '活泼', '严肃', '慵懒', '俏皮', '深沉', '干练', '凌厉'] },
  { group: '音色定位', tags: ['磁性', '醇厚', '清亮', '空灵', '稚嫩', '苍老', '甜美', '沙哑', '醇雅'] },
  { group: '人设腔调', tags: ['夹子音', '御姐音', '正太音', '大叔音', '台湾腔'] },
  { group: '方言', tags: ['东北话', '四川话', '河南话', '粤语'] },
  { group: '角色与唱歌', tags: ['孙悟空', '林黛玉', '唱歌'] },
];

/** 细粒度音频标签，可插入文本任意位置 */
export const AUDIO_TAGS: { group: string; tags: string[] }[] = [
  { group: '语速节奏', tags: ['吸气', '深呼吸', '叹气', '长叹一口气', '喘息', '屏息'] },
  { group: '情绪状态', tags: ['紧张', '害怕', '激动', '疲惫', '委屈', '撒娇', '心虚', '震惊', '不耐烦'] },
  { group: '语音特征', tags: ['颤抖', '变调', '破音', '鼻音', '气声', '沙哑'] },
  { group: '哭笑表达', tags: ['笑', '轻笑', '大笑', '冷笑', '抽泣', '呜咽', '哽咽', '嚎啕大哭'] },
];

/** 音色设计常用维度，点击可快速拼装描述 */
export const DESIGN_PRESETS: { name: string; description: string }[] = [
  {
    name: '温柔治愈女声',
    description: '年轻女性，音色温柔清亮，语速舒缓，带着安抚与陪伴的亲切感，适合深夜电台与睡前故事',
  },
  {
    name: '沉稳磁性男声',
    description: '中年男性，音色低沉醇厚带磁性，语速平稳克制，语气专业可信，适合纪录片旁白与商业播报',
  },
  {
    name: '活泼少女音',
    description: '十几岁少女，音色甜美明亮，语速偏快，情绪轻快上扬，适合短视频解说与二次元内容',
  },
  {
    name: '新闻播报腔',
    description: '成年男性，音色标准清晰，语速均匀有力，吐字饱满，语调客观中立，适合新闻资讯播报',
  },
  {
    name: '沧桑老者',
    description: '年迈男性，音色苍老略带沙哑与颗粒感，语速缓慢，语气淡然悠远，适合回忆叙事与历史讲述',
  },
  {
    name: '清冷御姐音',
    description: '青年女性，音色清冷空灵，语调从容疏离，语速中速偏缓，气场强大，适合角色配音',
  },
];

/**
 * 多语言 / 外语口音的音色设计模板。
 * 官方口径下，预置音色只有中英两族；若需要其它语种语感，
 * 只能通过 voicedesign 在描述中指定「语言 + 口音 + 说话习惯」来实验性生成。
 * 描述支持中英文，英文在描述外语口音时通常更精确。
 */
export const DESIGN_LANGUAGE_PRESETS: { name: string; description: string; note: string }[] = [
  {
    name: '英式播音男声',
    description: 'British male news narrator, refined Received Pronunciation accent, warm baritone, measured and authoritative pace',
    note: '标准英音，适合新闻与纪录片',
  },
  {
    name: '美式日常女声',
    description: 'American young female, clear General American accent, bright and friendly, natural conversational pace',
    note: '通用美音，适合播客与短视频',
  },
  {
    name: '俄罗斯口音英语',
    description: 'Heavy Russian accent, gruff middle-aged male, blunt and matter-of-fact',
    note: '官方文档示例，验证口音描述可行',
  },
  {
    name: '法语口音英语',
    description: 'French accent, soft-spoken middle-aged woman, gentle melodic intonation, slightly slower pace',
    note: '柔和的法式语调',
  },
  {
    name: '日语语感女声',
    description: 'Japanese female voice, gentle and polite tone, clear articulation, moderate pace, reads Japanese text naturally',
    note: '实验性：官方未正式开放日语，效果需自行验证',
  },
];

/** 音色设计提示词撰写要点（来自官方文档） */
export const DESIGN_TIPS: string[] = [
  '覆盖 性别与年龄 / 音色质感 / 情绪语气 / 语速节奏 四个核心维度',
  '1～4 句话即可，无需写成长文',
  '避免相互冲突的特征，例如「稚嫩童声 + CEO 气场」',
  '避免混响、回声、EQ、压缩等后期处理词汇',
  '避免「普通的」「正常的」这类模糊描述',
  '合成文本要贴合音色气质，温柔女声配晚安独白更自然',
];

export const DEFAULT_SETTINGS: AppSettings = {
  /** 默认保持小米 MiMo，既有行为不变 */
  providerId: 'mimo',
  providerFields: {},
  apiKey: '',
  baseUrl: '',
  autoSegment: true,
  optimizeTextPreview: true,
  autoPlay: true,
  playbackGain: 1.6,
  historyLimit: 60,
  batchFilenameTemplate: '{index:03d}-{key}',
  batchMakeZip: true,
};

/** 设置项持久化键名 */
export const STORAGE_KEYS = {
  settings: 'mimo-voice:settings',
  favorites: 'mimo-voice:favorites',
  /** GPT-SoVITS 本地服务地址（留空=经同源网关 /api/sovits） */
  sovitsUrl: 'mimo-voice:sovits-url',
} as const;

/**
 * GPT-SoVITS 合成参数的可调项与推荐范围。
 *
 * 这些范围与官方 `api_v2.py` 的语义一致，越界不会报错但会静默产出劣质音频，
 * 所以界面必须给出边界提示，而不是让用户自由输入。
 */
export interface SovitsParamSpec {
  key: string;
  label: string;
  hint: string;
  min: number;
  max: number;
  step: number;
  /** 官方默认值，取自 trainer/app/sovits/catalog.py */
  fallback: number;
}

export const SOVITS_PARAM_SPECS: SovitsParamSpec[] = [
  {
    key: 'top_k',
    label: 'top_k',
    hint: '采样候选数。调低更稳、调高更活；15 为官方默认',
    min: 1,
    max: 100,
    step: 1,
    fallback: 15,
  },
  {
    key: 'top_p',
    label: 'top_p',
    hint: '核采样阈值。1.0 表示不启用',
    min: 0.05,
    max: 1,
    step: 0.05,
    fallback: 1,
  },
  {
    key: 'temperature',
    label: 'temperature',
    hint: '情感起伏。越高越丰富，也越容易出现复读',
    min: 0.1,
    max: 2,
    step: 0.05,
    fallback: 1,
  },
  {
    key: 'repetition_penalty',
    label: 'repetition_penalty',
    hint: '复读惩罚。出现重复字词时调高它',
    min: 1,
    max: 2.5,
    step: 0.05,
    fallback: 1.35,
  },
  {
    key: 'speed_factor',
    label: '语速倍率',
    hint: '0.5~2.0；非 1.0 时会自动关闭分桶处理，略微变慢',
    min: 0.5,
    max: 2,
    step: 0.05,
    fallback: 1,
  },
  {
    key: 'batch_size',
    label: '批大小',
    hint: '一次并行推理的句子数。显存不足时调小到 1',
    min: 1,
    max: 32,
    step: 1,
    fallback: 1,
  },
  {
    key: 'fragment_interval',
    label: '句间停顿（秒）',
    hint: '每个切分片段之间的静音长度',
    min: 0,
    max: 1,
    step: 0.05,
    fallback: 0.3,
  },
  {
    key: 'sample_steps',
    label: '采样步数',
    hint: '仅 v3 / v4 生效；越小越快，越大越细',
    min: 4,
    max: 64,
    step: 1,
    fallback: 32,
  },
];

export const MAX_SAMPLE_BYTES = 10 * 1024 * 1024;
export const ACCEPTED_SAMPLE_TYPES = ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/wave', 'audio/x-wav'];

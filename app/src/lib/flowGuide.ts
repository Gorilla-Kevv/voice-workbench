/**
 * GPT-SoVITS 官方推荐的处理流程。
 *
 * 来源：GPT-SoVITS 开发者给出的标准流程（「四、处理音频素材」「五、训练与推理」）。
 * 之所以固化成数据而不是写在文档里，是为了让界面能直接引用它 —— 用户不必在
 * 「看文档」和「操作」之间来回切。
 *
 * 每条 tips 都尽量保留官方原话的判断和数值（例如「300 改成 100 或 200」
 * 「只建议 V2 Pro / V2 Pro Plus」），因为这些具体数字正是新手最容易卡住的地方。
 */

export interface FlowStep {
  id: string;
  /** 这一步要做什么（一句） */
  goal: string;
  /** 官方做法、判断依据与常见坑 */
  tips: string[];
  /** 什么情况下可以跳过 */
  optional?: string;
  /** 这一步属于哪个页面 */
  page: 'training' | 'synthesis';
}

export interface FlowPhase {
  id: string;
  title: string;
  /** 该阶段的步骤（序号在渲染时按全局顺序生成） */
  steps: FlowStep[];
}

export const FLOW_PHASES: FlowPhase[] = [
  {
    id: 'corpus',
    title: '处理音频素材（核心四步）',
    steps: [
      {
        id: 'uvr',
        goal: '把人声从伴奏里剥离出来，得到干净的干声。',
        optional: '只有素材带 BGM 或明显噪声时才需要；干净录音可跳过。',
        page: 'training',
        tips: [
          '官方推荐选 BS-RoFormer 模型，分离效果最干净。',
          '注意：本机整合包里的 BS-RoFormer 缺少同名的 .yaml 配置文件，暂时无法加载 —— 先用 HP2（无和声）或 HP5（有和声）。补齐 .yaml 后它会自动出现在模型列表里。',
          '若人声仍有明显混响，可再用 ONNX 去混响模型处理一次 —— 但速度很慢。',
          '输出会有人声和 other（背景音）两份；切分前记得把 other 那份删掉，只留人声。',
        ],
      },
      {
        id: 'slice',
        goal: '按静音把长录音切成 5~15 秒的小段，便于逐条学习和对齐文本。',
        page: 'training',
        tips: [
          '输入路径：做过人声分离就填它的输出文件夹，没做就填原始素材路径。',
          '参数保持默认即可，不要随手调。',
          '若切出来的片段**全部偏长**，说明语句间隔太短 —— 把 min_interval 的 300 改成 100 或 200。',
          '输出后按「时长从大到小」排序，删除或手动切掉超过约 15 秒的超长条。',
        ],
      },
      {
        id: 'asr',
        goal: '自动听写每段音频的内容，产出训练用的 .list 清单。',
        page: 'training',
        tips: [
          '输入输出文件夹已默认填好，不用改。',
          '中文和粤语用达摩 ASR（FunASR）；其他所有语种都用 Faster Whisper。',
          '产出的 .list 每行格式为：音频路径 | 文件夹名 | 语种 | 标注文本。',
        ],
      },
      {
        id: 'proofread',
        goal: '逐条核对转写文本与音频是否一致，改掉识别错字。',
        optional: '官方认为这一步非常耗时、收益有限，可以跳过。',
        page: 'training',
        tips: [
          '操作方式是左边改文本、右边听音频核对。',
          '如果发现合成结果里某些字读音怪异，回来校对对应条目是最有效的排查手段 —— 错字会被模型原样学进去。',
        ],
      },
    ],
  },
  {
    id: 'train',
    title: '训练与推理',
    steps: [
      {
        id: 'format',
        goal: '把「音频 + 文本」预处理成模型能直接读取的特征。',
        page: 'training',
        tips: [
          '先设置模型名，再选模型版本。',
          '官方只建议 V2 Pro / V2 Pro Plus，其余版本不推荐。',
          '然后点「开始确认 + 一键三连」（对应本项目的「格式化训练集」）。',
        ],
      },
      {
        id: 'finetune',
        goal: '在官方预训练权重的基础上，用你的素材微调出专属音色。',
        page: 'training',
        tips: [
          '参数全部保持默认即可 —— 已按显存自动调整过。',
          '官方建议的训练顺序是：先等 SoVITS 训练完成，再开 GPT 训练。',
          'DPO 是实验性选项，建议不要开 —— 开发者实测有副作用。',
        ],
      },
      {
        id: 'infer',
        goal: '选择训练产出的权重文件，准备合成。',
        page: 'synthesis',
        tips: [
          '推理前刷新模型路径下拉，选择训练产物。',
          '权重文件名里 E = 训练轮数（一般选最大的那个），S = 步数。',
          '「变体推理」能提速约一倍，但更吃显卡；显卡弱则没有收益。V3 / V4 版本没有这个选项。',
        ],
      },
      {
        id: 'synth',
        goal: '配好参考音频与文本，生成语音。',
        page: 'synthesis',
        tips: [
          '主参考音频选一段 3~10 秒的切分音频，官方推荐 5 秒左右。',
          '辅参考音频作用不大，可以不填。',
          '参考音频对应的标注文本，去 .list 里找到那一行复制过来。',
          '注意：这里选的语种是**参考音频**的语种，不是你要合成的文本的语种 —— 两者可以不同（跨语言合成）。',
          '其余参数保持默认即可。',
        ],
      },
    ],
  },
];

/** 展开成一维步骤列表，带全局序号（界面上显示的「第 N 步」就是它） */
export interface NumberedStep extends FlowStep {
  index: number;
  phaseId: string;
}

export function flattenFlow(): NumberedStep[] {
  const result: NumberedStep[] = [];
  let index = 0;
  for (const phase of FLOW_PHASES) {
    for (const step of phase.steps) {
      index += 1;
      result.push({ ...step, index, phaseId: phase.id });
    }
  }
  return result;
}

/** 取某个页面相关的步骤（训练页看前六步，合成页看后两步） */
export function stepsForPage(page: 'training' | 'synthesis'): NumberedStep[] {
  return flattenFlow().filter((step) => step.page === page);
}

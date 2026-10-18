/* knowledge-atlas/js/data.js — AI 声音知识图谱核心数据源
 * 对应项目：voice-workbench (ttstool) · AI声音知识库
 * 包含 TTS、ASR、RVC 声音克隆、AI 翻唱、音频工程与排障指南。
 */

const SECTIONS = [
  {
    "id": "basics",
    "title": "入门基础",
    "en": "Audio & Speech Basics",
    "icon": "🎙️",
    "color": "#38ef7d",
    "summary": "掌握数字音频核心要素、梅尔频谱、声码器与经典语音合成工作链路。",
    "sections": [
      {
        "heading": "数字音频基础：采样率、位深与声道",
        "meta": {
          "status": "classic",
          "note": "音频处理基本常识"
        },
        "paragraphs": [
          "音频本质是连续声波经采样与量化得到的离散数字信号。<b>采样率（Sample Rate）</b>决定了能够还原的最高频率（根据奈奎斯特定理，最高频为采样率的一半）：常见语音识别（ASR）使用 16kHz；普通 TTS 常用 24kHz / 32kHz；专业高保真音乐与歌声克隆必须使用 <b>44.1kHz 或 48kHz</b>。",
          "<b>位深（Bit Depth）</b>决定了音频的动态范围：16-bit 具备 96dB 动态范围，是绝大多数语音模型输入的标准；24-bit/32-bit float 则用于母带录音与防止削波（Clipping）。在模型训练与推理中，音频一律转为单声道（Mono）以消除立体声相位抵消误差。"
        ],
        "table": {
          "title": "常用采样率规格速查",
          "head": [
            "采样率",
            "常见应用场景",
            "典型代表模型"
          ],
          "rows": [
            [
              "16,000 Hz (16k)",
              "语音识别 (ASR)、声纹比对",
              "Whisper, FunASR, SenseVoice"
            ],
            [
              "24,000 Hz (24k)",
              "轻量/早期快速 TTS",
              "ChatTTS, MeloTTS, Edge-TTS"
            ],
            [
              "32,000 Hz (32k)",
              "平衡型零样本语音合成",
              "GPT-SoVITS v1, CosyVoice 1"
            ],
            [
              "44,100 / 48,000 Hz (48k)",
              "高保真 AI 翻唱与专业歌声克隆",
              "RVC v2, So-VITS-SVC 4.0/5.0, GPT-SoVITS v2/v3"
            ]
          ]
        }
      },
      {
        "heading": "从文本到波形：现代 TTS 的三段式核心链路",
        "paragraphs": [
          "现代主流语音合成并非一步到位，而是经历『文本处理 → 声学特征预测 → 声码器波形还原』三段式结构：",
          "<b>① 文本前端（Text Frontend / G2P）</b>：将原始汉字/英文转为音素（Phoneme），处理多音字（如『还钱』vs『还有』）、数字缩写（如『2026年』读作『二零二六年』）及标点停顿。",
          "<b>② 声学模型（Acoustic Model）</b>：输入音素序列与提示音频特征（Prompt），预测对应的中层声学表征（通常是 80 维梅尔频谱 Mel-Spectrogram，或离散语音 Token）。现代模型（如 GPT-SoVITS、CosyVoice）采用自回归或流匹配机制完成这一步。",
          "<b>③ 声码器（Vocoder）</b>：将梅尔频谱还原为人类耳朵听到的时域声波（Waveform）。经典声码器包括 HiFi-GAN、BigVGAN、Vocos 等，决定了最终声音的空气感与清晰度。"
        ],
        "callout": {
          "type": "key",
          "title": "声音合成核心公式",
          "text": "文本 (Text) → G2P音素 (Phonemes) + 提示音频 (Prompt) → [声学模型] → 梅尔频谱 (Mel) / 离散Token → [声码器 Vocoder] → 实际听到的音频 (Waveform)"
        }
      }
    ]
  },
  {
    "id": "principles",
    "title": "技术原理",
    "en": "Deep Architecture & Acoustics",
    "icon": "🧠",
    "color": "#11998e",
    "summary": "解析自回归、Flow Matching、VITS、扩散机制与零样本声音克隆底层本质。",
    "sections": [
      {
        "heading": "自回归（AR）vs 非自回归（NAR / Flow Matching）",
        "meta": {
          "status": "active",
          "note": "2025-2026 核心架构路线演进"
        },
        "paragraphs": [
          "<b>自回归模型（Auto-Regressive, AR）</b>：像 LLM 写文本一样，逐个 Token 预测后续语音片段。代表作 <b>GPT-SoVITS</b>：第一阶段用类 GPT 的 Transformer 自回归预测目标音素的离散语义 Token。优势是上下文语调拟合度极高、情感起伏自然、语气丰富；缺点是存在『复读、吞字、幻觉』概率，且推理速度随长度线性增长。",
          "<b>非自回归流匹配（Flow Matching, FM）</b>：2024–2026 年新一代模型（<b>CosyVoice、F5-TTS</b>）的主流架构。直接通过常微分方程（ODE）建模从高斯噪声到目标梅尔频谱的连续变换。优势是推理稳定、永不复读、零显式音素对齐、并行速度极快（RTF < 0.15）。"
        ]
      },
      {
        "heading": "零样本声音克隆（Zero-Shot Cloning）底层原理",
        "paragraphs": [
          "所谓『零样本（Zero-Shot）』指无需对目标说话人进行梯度更新或训练模型，仅需输入一段 3~10 秒参考音频即可复刻音色与语调。",
          "<b>实现机制</b>：① <b>说话人编码器（Speaker Encoder）</b>提取出代表音色特征的固定维度向量（Speaker Embedding / d-vector），注入解码器；② <b>提示音频上下文拼接（In-Context Learning）</b>：在自回归或流匹配的前缀输入参考音频的声学特征，让模型根据上下文自然延续该音色的说话特征。"
        ]
      }
    ]
  },
  {
    "id": "tts-models",
    "title": "主流 TTS 模型",
    "en": "Mainstream TTS Models",
    "icon": "🗣️",
    "color": "#00c6ff",
    "summary": "主流开源与本地语音生成引擎选型、特性横评与实战调优。",
    "sections": [
      {
        "heading": "GPT-SoVITS（花儿不哭 · 经典开源王者）",
        "meta": {
          "status": "active",
          "note": "v1/v2/v2pro 演进，二次元与中文配音首选"
        },
        "paragraphs": [
          "GPT-SoVITS 由开源开发者 RVC-Boss（花儿不哭）开源，是中文社区影响力最大、落地最广泛的零样本及微调 TTS 框架：",
          "<b>架构特点</b>：双阶段体系——① <b>SoVITS（声学与变分自编码器）</b>：基于 VITS 架构的高保真波形生成器，具备 48kHz 采样率与精细音色还原；② <b>GPT（前缀自回归）</b>：学习语音语义 Token 的上下文概率分布，仅需 5 秒音频即可克隆音色与语调。",
          "<b>微调支持</b>：除了 5 秒零样本克隆，还支持用 1~10 分钟目标人声音频进行 <b>微调（Fine-Tuning）</b>，微调后在咬字准确度、长句稳定性和相似度上大幅碾压纯零样本方案。"
        ],
        "table": {
          "title": "GPT-SoVITS 关键版本与配置推荐",
          "head": [
            "版本",
            "采样率",
            "适用场景",
            "推荐参数"
          ],
          "rows": [
            [
              "v1 原始版",
              "32kHz",
              "轻量设备、快速体验",
              "Top-K: 5, Top-P: 0.8, Temp: 1.0"
            ],
            [
              "v2 官方演进",
              "48kHz",
              "高保真配音、细节饱满",
              "Top-K: 10, Top-P: 0.85, Temp: 0.8"
            ],
            [
              "v2pro / 社区魔改",
              "48kHz / 多语种",
              "游戏角色配音、跨语种克隆",
              "微调步数: SoVITS 8~12 epoch, GPT 15 epoch"
            ]
          ]
        }
      },
      {
        "heading": "CosyVoice / CosyVoice 2（阿里通义实验室）",
        "meta": {
          "status": "active",
          "note": "多模态多语种高自然度 Flow Matching 代表"
        },
        "paragraphs": [
          "CosyVoice 是阿里于 2024–2025 年开源的语音大模型体系，采用流匹配（Flow Matching）与多条件注入：",
          "<b>核心优势</b>：① 极强的情绪与韵律控制（支持在文本中插入 `<laughter>`、`<sigh>` 等富文本控制符）；② 卓越的多语言与跨语种能力（中、英、日、粤、韩），支持中文参考音频说纯正流利英语；③ 零样本复刻稳定性极佳，彻底消除了自回归模型的重复与吞字问题。"
        ]
      },
      {
        "heading": "F5-TTS / E2-TTS（极简非自回归秒级克隆）",
        "paragraphs": [
          "F5-TTS（Fair Forward Flow Matching）提出了一种无需音素持续时间预测、无需复杂对齐的纯数据驱动流匹配架构：",
          "直接在梅尔频谱空间做 Fill-in-the-Blank（补全任务），推理速度极快，代码简洁易读，已成为轻量级本地快速部署的热门新星。"
        ]
      },
      {
        "heading": "ChatTTS（对话流拟真人发音人）",
        "meta": {
          "status": "classic",
          "note": "首创高拟真语气词与口语停顿"
        },
        "paragraphs": [
          "ChatTTS 专为对话场景设计：在每句发音中自动生成微妙的吸气、清嗓、轻笑与口语化停顿，听感非常接近真实人类在日常交谈或播客中的状态。适合有声书、对话机器人与长音频伴读。"
        ]
      },
      {
        "heading": "IndexTTS 与 Irodori（二次元与游戏领域特化引擎）",
        "paragraphs": [
          "针对动漫游戏、二次元角色高表现力特化调优的开源引擎。在尖叫、哭腔、傲娇、病娇等极端语气下具备比通用商业大模型更好的稳定度与张力。"
        ]
      }
    ]
  },
  {
    "id": "vc-rvc",
    "title": "声音克隆与变声 RVC",
    "en": "Voice Conversion (RVC & SVC)",
    "icon": "🔄",
    "color": "#f857a6",
    "summary": "音色转换、实时低延迟变声、特征检索与防音色泄露核心指南。",
    "sections": [
      {
        "heading": "RVC（Retrieval-based Voice Conversion v2）技术解密",
        "meta": {
          "status": "active",
          "note": "全球最流行的音色转换与实时变声架构"
        },
        "paragraphs": [
          "RVC v2 是当前综合音质、训练门槛与实时性最均衡的音色转换框架：",
          "<b>特征检索机制（Feature Retrieval）</b>：这是 RVC 相比上一代 So-VITS 的最大杀手锏。模型在训练时对目标说话人所有音频的 HuBERT 特征建立聚类索引（`.index` 文件）。在推理时，通过近似最近邻搜索（Faiss）用目标真实说话人特征替换源音频特征，<b>从根源上防止音色泄露（Source Timbre Leakage）</b>。",
          "<b>音高算法（F0 Extractor）选型</b>：① <b>RMVPE</b>（当前综合性能最强、绝不破音、GPU消耗低）；② <b>Harvest</b>（低音准确但慢）；③ <b>Crepe</b>（高音极稳但显存消耗大）；④ <b>PM / Dio</b>（极速纯CPU算法，仅用于超低配置实时变声）。"
        ],
        "table": {
          "title": "RVC 关键调参指南",
          "head": [
            "参数项",
            "推荐范围",
            "作用说明与避坑"
          ],
          "rows": [
            [
              "检索特征比 (Index Rate)",
              "0.6 ~ 0.8",
              "太高会带入训练集杂音，太低源说话人音色会泄露"
            ],
            [
              "保护清辅音和呼吸声 (Protect)",
              "0.33 ~ 0.5",
              "防止气音被当成杂音抹除，过高会有电音"
            ],
            [
              "变调 (Pitch Shift)",
              "男变女 +12，女变男 -12",
              "按八度调节，半音微调用于歌声对齐"
            ],
            [
              "F0 算法",
              "RMVPE (默认首选)",
              "兼具抗噪、高低音跨度与极低显存"
            ]
          ]
        }
      },
      {
        "heading": "So-VITS-SVC 4.0 / 5.0（歌声克隆的先驱与重器）",
        "paragraphs": [
          "专为歌声设计的 SVC 体系。相比 RVC，So-VITS-SVC 在极高音、颤音和复杂的声乐技巧还原上更细腻，但训练成本较高（通常需要 1~2 小时精选干音与更长 epoch），且对伴奏残留极为敏感。"
        ]
      }
    ]
  },
  {
    "id": "singing",
    "title": "歌声合成与 AI 翻唱",
    "en": "Singing Voice Synthesis (SVS)",
    "icon": "🎵",
    "color": "#ff5858",
    "summary": "AI 翻唱工业管线：人声分离、音高修正、音色转换与后期混音。",
    "sections": [
      {
        "heading": "AI 翻唱工业级标准管线（四步工作流）",
        "paragraphs": [
          "制作一首高品质 AI 翻唱歌声的标准工业流程：",
          "<b>① 人声伴奏分离（UVR5）</b>：使用 Ultimate Vocal Remover v5 将原始歌曲彻底分离为『伴奏 Track』与『纯净人声 Track』。推荐使用 MDX-Net 或 Demucs 算法，伴奏残留越少，AI 克隆越干净。",
          "<b>② 人声音高提取与修音（Melodyne / RMVPE）</b>：原曲人声中的转音、颤音由算法提取为 F0 曲线。若原唱有跑调，可在宿主（DAW）中预先微修。",
          "<b>③ 音色转换（RVC / SVC 推理）</b>：将人声 Track 传入 RVC 模型，加载目标音色模型与 `.index` 文件，开启变调对齐，导出目标人声波形。",
          "<b>④ 后期混音与母带处理</b>：在宿主（Cubase / FL Studio / Logic）中挂载 EQ（切除 80Hz 以下低频隆隆声）、压缩（控制动态）、降噪、混响（Reverb）与伴奏立体声融合。"
        ]
      },
      {
        "heading": "UVR5（人声伴奏分离神级工具）模型选型",
        "table": {
          "title": "UVR5 核心分离模型速查",
          "head": [
            "模型名",
            "架构体系",
            "特长与最佳应用"
          ],
          "rows": [
            [
              "MDX-Net Voc FT",
              "MDX 频域网络",
              "人声与伴奏分离最干净，人声几乎无损"
            ],
            [
              "UVR-MDX-NET Main",
              "MDX 经典",
              "处理混响较重的民谣与流行乐"
            ],
            [
              "Demucs v4 (htdemucs)",
              "Facebook 4轨分离",
              "一键拆分人声、鼓点、贝斯、其他乐器"
            ],
            [
              "VR-Arch (5_HP-Karaoke)",
              "传统 VR 架构",
              "专门剥离伴奏中的微弱和声与卡拉OK伴唱"
            ]
          ]
        }
      }
    ]
  },
  {
    "id": "dataset",
    "title": "数据工程与预处理",
    "en": "Audio Dataset Engineering",
    "icon": "✂️",
    "color": "#f7b733",
    "summary": "从零制作高品质声音训练集的切片、降噪、响度对齐与自动标注标准。",
    "sections": [
      {
        "heading": "黄金数据集法则：垃圾进，垃圾出（Garbage In, Garbage Out）",
        "paragraphs": [
          "声音模型的最终上限 100% 由数据集品质决定，任何算法调优都救不回劣质音频。合格训练干音的三大铁律：",
          "<b>① 绝对无混响（Dry Vocal）</b>：严禁使用带大混响、回声（Echo）或浴室效果的声音；",
          "<b>② 绝对无伴奏与环境底噪</b>：键盘声、空调声、杂音会被模型全部当成音色本身学进去；",
          "<b>③ 发音人状态纯粹</b>：语速、情绪和距离麦克风的近讲效应保持相对一致。"
        ]
      },
      {
        "heading": "切片门限与响度规范",
        "paragraphs": [
          "<b>音频切片（Slice）黄金区间</b>：单段音频切片长度必须保持在 <b>3 ~ 10 秒</b>。太短（<2秒）没有足够的声学上下文；太长（>15秒）容易导致模型显存 OOM 或注意力失焦。",
          "<b>静音检测门限</b>：推荐阈值 `-38dB ~ -42dB`，最小静音保留 300ms ~ 500ms。",
          "<b>响度对齐（Loudness Normalization）</b>：统一使用 BS.1770-4 算法，将整体切片响度规整至 <b>-16 LUFS ~ -20 LUFS</b>，峰值控制在 -1.0 dBFS 防止削波。"
        ]
      }
    ]
  },
  {
    "id": "troubleshooting",
    "title": "常见问题与调优速查",
    "en": "Troubleshooting & Optimization",
    "icon": "🛠️",
    "color": "#fc4a1a",
    "summary": "破音、电音、吞字复读、音色漂移、显存 OOM 故障排查与速查表。",
    "sections": [
      {
        "heading": "TTS 与克隆高频踩坑全景排障",
        "paragraphs": [
          "<b>① 吞字、漏字或无限复读</b>：这是自回归（GPT-SoVITS）最典型的注意力漂移。解决办法：① 降低 Temperature（从 1.0 降至 0.7~0.8）；② 调小 Top-P（0.7~0.8）；③ 检查参考音频音素标注是否精准；④ 将过长句子用标点切为多段合成。",
          "<b>② 变声后电音感过重或嘶哑</b>：① 检索特征比（Index Rate）开太高（降至 0.6~0.7）；② F0 音高算法换成 RMVPE；③ 检查目标干音是否本身带降噪残留的金属电音；④ 调小 Protect 参数至 0.33。",
          "<b>③ 音色不像目标人（音色泄露）</b>：① 确保伴随推理提供了对应的 `.index` 索引文件；② 提高 Index Rate 至 0.8；③ 如果男女跨度大，调整变调（男变女 +12，女变男 -12）。",
          "<b>④ 显存爆满（CUDA Out of Memory）</b>：① 调小切片长度；② 启用半精度 fp16；③ 推理批大小（batch size）设为 1。"
        ]
      }
    ]
  }
];

const GLOSSARY = [
  {
    "term": "Zero-Shot (零样本)",
    "cat": "概念",
    "def": "无需对模型权重进行任何梯度更新或微调，仅提供几秒参考音频即刻复刻音色的能力。"
  },
  {
    "term": "Mel-Spectrogram (梅尔频谱)",
    "cat": "声学",
    "def": "模拟人耳非线性听觉感知特性的时频图表示，是声学模型与声码器交互的核心中层特征。"
  },
  {
    "term": "Vocoder (声码器)",
    "cat": "架构",
    "def": "将中层梅尔频谱或特征表征还原为高保真时间域波形（声波）的神经网络组件（如 HiFi-GAN）。"
  },
  {
    "term": "F0 / Pitch (基频与音高)",
    "cat": "声学",
    "def": "声带振动的基频频率，决定了声音听觉上的高低音调；在歌声克隆与情绪表达中至关重要。"
  },
  {
    "term": "RMVPE",
    "cat": "算法",
    "def": "深度神经网络驱动的高精度抗噪人声基频提取算法，在复杂音频和背景微噪下音高提取极稳。"
  },
  {
    "term": "Flow Matching (流匹配)",
    "cat": "架构",
    "def": "新一代非自回归生成架构，基于常微分方程 ODE 建模噪声到语音的连续演化，推理快且无复读幻觉。"
  },
  {
    "term": "LUFS (响度单位)",
    "cat": "工程",
    "def": "针对人耳感知加权的标准化响度衡量单位；语音数据集通常标准化至 -16 到 -20 LUFS。"
  },
  {
    "term": "RTF (实时率)",
    "cat": "指标",
    "def": "Real-Time Factor，合成音频耗时与音频实际播放时长的比值。RTF < 1.0 即代表可实现实时合成。"
  },
  {
    "term": "Index Rate (特征检索比)",
    "cat": "调优",
    "def": "RVC 中控制从目标人声特征库聚类检索相似特征的融合比例，用于消除源说话人音色泄露。"
  },
  {
    "term": "G2P (字素转音素)",
    "cat": "前端",
    "def": "Grapheme-to-Phoneme，将自然语言字符转换为国际音标或特定拼音音素序列的前端处理模块。"
  }
];

const RESOURCES = [
  {
    "name": "GPT-SoVITS",
    "cat": "TTS",
    "url": "https://github.com/RVC-Boss/GPT-SoVITS",
    "desc": "强大的少样本/零样本语音克隆与TTS引擎，支持中英日跨语种"
  },
  {
    "name": "CosyVoice",
    "cat": "TTS",
    "url": "https://github.com/FunAudioLLM/CosyVoice",
    "desc": "阿里通义多模态自然语言控制流匹配语音生成大模型"
  },
  {
    "name": "F5-TTS",
    "cat": "TTS",
    "url": "https://github.com/SWivid/F5-TTS",
    "desc": "极简无音素对齐的非自回归流匹配快速克隆引擎"
  },
  {
    "name": "ChatTTS",
    "cat": "TTS",
    "url": "https://github.com/2noise/ChatTTS",
    "desc": "突破性拟真对话流发音人，支持笑声、叹气与语气词控制"
  },
  {
    "name": "Retrieval-based Voice Conversion (RVC)",
    "cat": "VC",
    "url": "https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI",
    "desc": "全球最流行的低延迟音色转换与实时变声框架"
  },
  {
    "name": "Ultimate Vocal Remover (UVR5)",
    "cat": "Audio",
    "url": "https://github.com/Anjok07/ultimatevocalremovergui",
    "desc": "最强人声伴奏混响分离工具，基于 MDX-Net 与 Demucs"
  },
  {
    "name": "SenseVoice",
    "cat": "ASR",
    "url": "https://github.com/FunAudioLLM/SenseVoice",
    "desc": "阿里开源极速多语言富文本语音识别，自带情绪与事件检测"
  },
  {
    "name": "DiffSinger",
    "cat": "SVS",
    "url": "https://github.com/openvpi/DiffSinger",
    "desc": "专业级基于扩散机制的高保真歌声合成引擎"
  }
];

const RESOURCE_MAP = [
  { blockIdx: 0, resName: "GPT-SoVITS" },
  { blockIdx: 1, resName: "CosyVoice" },
  { blockIdx: 2, resName: "F5-TTS" },
  { blockIdx: 3, resName: "ChatTTS" },
  { blockIdx: 0, resName: "Retrieval-based Voice Conversion (RVC)" },
  { blockIdx: 1, resName: "Ultimate Vocal Remover (UVR5)" },
  { blockIdx: 0, resName: "SenseVoice" },
  { blockIdx: 0, resName: "DiffSinger" }
];

if (typeof window !== "undefined") {
  window.VOICE_KNOWLEDGE_DATA = { SECTIONS, GLOSSARY, RESOURCES, RESOURCE_MAP };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { SECTIONS, GLOSSARY, RESOURCES, RESOURCE_MAP };
}

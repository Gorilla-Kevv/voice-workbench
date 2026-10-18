# AI 声音知识图谱 · 主流 TTS 模型（Mainstream TTS Models）

主流开源与本地语音生成引擎选型、特性横评与实战调优。

### GPT-SoVITS（花儿不哭 · 经典开源王者）

> 状态：现役主流 ｜ v1→v2→v2ProPlus 主力训练档，v5dev/v5turbo 新一代推理底模（2026-10 上游 main）

GPT-SoVITS 由开源开发者 RVC-Boss（花儿不哭）开源，是中文社区影响力最大、落地最广泛的零样本及微调 TTS 框架：

**架构特点**：双阶段体系——① **SoVITS（声学与变分自编码器）**：基于 VITS 架构的高保真波形生成器，具备 48kHz 采样率与精细音色还原；② **GPT（前缀自回归）**：学习语音语义 Token 的上下文概率分布，仅需 5 秒音频即可克隆音色与语调。

**微调支持**：除了 5 秒零样本克隆，还支持用 1~10 分钟目标人声音频进行 **微调（Fine-Tuning）**，微调后在咬字准确度、长句稳定性和相似度上大幅碾压纯零样本方案。

**版本演进与本地化结论（v5 情报截至 2026-10-18 上游 main 实查）**

| 版本 | 采样率 | 定位与本项目结论 |
|---|---|---|
| v1 原始版 | 32kHz | 轻量起步；Top-K 5 / Top-P 0.8 |
| v2 官方演进 | 48kHz | 高保真配音主力；跨语种 5 语种互通 |
| v3 / v4 | 24k→48k | v3 引入流匹配声码（32 采样步），v4 修高频金属音并降步提速 |
| v2Pro / v2ProPlus | 48kHz | voice-workbench 主力训练档：官方硬规则 40k 必配 v1 配置；底模缺失时按官方做法不带 -pg/-pd（从零训）；训练顺序 s2→s1 |
| v5dev / v5turbo | 48kHz | 上游 main 双变体：turbo 默认 4 步（官方 4060Ti RTF 0.028）、dev 32 步 + cfg_rate 1.30；免 SoVITS 微调显著提升相似度、新 vocoder 减高频伪影；纯推理底模（上游无 v5 训练配置）；依赖 py3.12 + torch2.7.1（Windows 有 flash-attn wheel），整合包 py3.9 无法承载 |

> 【本项目实测】v5 已以独立运行时接入（gsv5/，:9885，py3.12+torch2.7.1+cu128）：双变体 CPU 试金石通过（turbo RTF 2.49 / dev 19.2），GPU RTF 待显存窗口实测。Windows/WDDM 大坑：显存不足时 torch 溢出共享内存，GPU 100% 却长期不出结果——显存不够就等窗口或显式 CPU 模式，别硬跑。

### CosyVoice / CosyVoice 2（阿里通义实验室）

> 状态：现役主流 ｜ 多模态多语种高自然度 Flow Matching 代表

CosyVoice 是阿里于 2024–2025 年开源的语音大模型体系，采用流匹配（Flow Matching）与多条件注入：

**核心优势**：① 极强的情绪与韵律控制（支持在文本中插入 ``、`` 等富文本控制符）；② 卓越的多语言与跨语种能力（中、英、日、粤、韩），支持中文参考音频说纯正流利英语；③ 零样本复刻稳定性极佳，彻底消除了自回归模型的重复与吞字问题。

### F5-TTS / E2-TTS（极简非自回归秒级克隆）

F5-TTS（Fair Forward Flow Matching）提出了一种无需音素持续时间预测、无需复杂对齐的纯数据驱动流匹配架构：

直接在梅尔频谱空间做 Fill-in-the-Blank（补全任务），推理速度极快，代码简洁易读，已成为轻量级本地快速部署的热门新星。

### ChatTTS（对话流拟真人发音人）

> 状态：经典架构 ｜ 首创高拟真语气词与口语停顿

ChatTTS 专为对话场景设计：在每句发音中自动生成微妙的吸气、清嗓、轻笑与口语化停顿，听感非常接近真实人类在日常交谈或播客中的状态。适合有声书、对话机器人与长音频伴读。

### Fish Audio / Drama 3（多角色长文本旗舰，显存门槛天花板）

> 状态：现役主流 ｜ 39 AI, INC.（fishaudio）；开源边界与命名坑极多，2026-10-19 HF API 实查

**Drama 3**：35B 总参 / 每 token 激活 3B 的 MoE 主干 + Codebook-MTP 解码器（10 codebook 因果解码）；多角色一条文本最多 16 个说话人标签（<|speaker:0..15|>）；长文本自动分块流式；25+ 语种；官方口径 **48GB 显存（FP8）且禁 CPU/MPS**——8GB 卡差三个量级，正确用法是走 fish.audio API 或 SGLang-Omni/vLLM-Omni 部署到 48GB 卡。

**开源边界（命名坑）**：可下载的只有 drama-3（38.63 GiB）、drama-3-int4（22.25，非官方量化）、S2-Pro（10.24，官方支持 CPU 路径）、s1-mini（3.36）、fish-speech-1.5（1.19）；产品端宣传的 **S2.1 Pro / S1 4B 是闭源仅 API**——HF 官方 org 11 个仓库逐个核过，别把发布稿当开源。

**许可三档**：Drama 3 / S2-Pro = Fish Audio Research License（研究免费、商用另授权）；s1-mini / 1.x = CC-BY-NC-SA-4.0（非商业）；代码库 = Community License（年收入低于 50 万美元方可商用）——「开源」不等于「可商用」。模型卡另含声音克隆合规条款（未经本人同意不得模仿可识别真人声音）。

**两个工程坑**：① codec.pth 与 S2-Pro 耦合——checkpoint 缺它会回落到 s2-pro 的声码器，部署时两包常要一起下；② 官方服务形态只有 SGLang-Omni / vLLM-Omni / 自带 api_server+WebUI，ComfyUI 节点全是社区移植（最高星 300），其中「8GB 可跑」的方案是专家常驻系统内存的换血 hack，32GB 内存正卡下沿且 RTF 约 4.6，别当官方能力引用。

### ChatTTS（对话流拟真人发音人）

> 状态：经典架构 ｜ 首创高拟真语气词与口语停顿

ChatTTS 专为对话场景设计：在每句发音中自动生成微妙的吸气、清嗓、轻笑与口语化停顿，听感非常接近真实人类在日常交谈或播客中的状态。适合有声书、对话机器人与长音频伴读。

### Confucius4-TTS / Confucius4-R2T2（网易有道的双引擎）

> 状态：现役主流 ｜ voice-workbench 主服务：免转写克隆 + 15 语种

**Confucius4-TTS**（1.3B，Apache-2.0）：零样本克隆且**免参考文本**——别的引擎要参考音频配逐字转写，它只吃音频；14/15 语种跨语种合成无口音，支持情感迁移。实测常驻显存约 4.9GB（fp16 分档后准入 5120MB），稳态 RTF 2.0~2.5。

**Confucius4-R2T2**（Qwen3-ASR 基座）：append-only 真流式转写，延迟 200~600ms。Windows 可用性结论（踩坑实测）：流式被源码写死 vLLM-only（Linux/容器），但**离线转写走 transformers 后端原生可行**（qwen-asr 纯 Python wheel 可装）；流式需 WSL2/Docker。显存槛约 5.5/6.5GB、MAX_INFERENCE_BATCH_SIZE=1 防 KV cache 爆。

### IndexTTS-2.5（情感向量精细可控）

> 状态：现役主流 ｜ 补充定位：8 维情感向量 / 拼音注音 / 语速倍率

0.8B / BF16，5 语种，独有价值是**8 维情感向量**（全 0 等同跟随参考音频，多维可叠加由服务端归一）、拼音注音与语速倍率——通用引擎没有的精细控制面。

实测画像：官方口径 2~3GB 严重偏小，**实际常驻约 5.3GB**（w2v-bert、BigVGAN、QwenEmotion、codec 全算上）；暖态 RTF 约 2.2 但对显存竞争极敏感（被挤时 5~14）。权重全在本地时首跑仍要数分钟——上游对辅助模型做网络探测超时后才回退本地。

### Irodori-TTS（日语特化 + emoji 风格控制 + Speaker Inversion 音色固化）

> 状态：现役主流 ｜ 日语 only；emoji 风格是官方训练期特性

日语特化推理引擎：emoji 白名单 56 个 + caption 自然语言描述双通道风格控制（官方训练时就带 emoji 标记，caption 实测能把 F0 拉开 1.77 倍）；int4 + 4 步 sway 实测 RTF 0.121，小显存卡上最快的引擎之一。

**两条实测红线**：① emoji 对男声参考基本无效（官方 issue #9 复现，F0 锁死 ±2Hz），只能承诺节奏与插入音类风格；② Windows 依赖链三坑——torchaudio 在 torch2.9 起委托 torchcodec（cu128 无 Windows wheel，静默 0 产出），需 soundfile 垫片且要在每个入口装。

**Speaker Inversion（SI）音色固化**：从同一个人 10 条以上带转写短句蒸馏 speaker embedding（产物仅几十 KB），合成免参考音频；工程三守卫——manifest 非空硬断言（部分失败=全失败）、产物读回校验、torch allocator 显存显式归还。上游 tarball 锁定（见 docs/IRODORI-TTS-EVALUATION.md）。

### IndexTTS 与 Irodori（二次元与游戏领域特化引擎）

针对动漫游戏、二次元角色高表现力特化调优的开源引擎。在尖叫、哭腔、傲娇、病娇等极端语气下具备比通用商业大模型更好的稳定度与张力。


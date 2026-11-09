# 日语流式 ASR + Qwen2.5-7B 实时翻译：工作汇报与交接

- 日期：2026-10-26
- 范围：日语耳语/ASMR 实时转写，后续接 Qwen2.5-7B 翻译；中文不是目标
- 素材：`D:\Media\asmr\全年龄\RJ01241346`（7 章 MP3，共 2.9 小时；`台本テキスト.txt` 为 7 个场景的日语台本）
- 状态：**ASR 方案已验证；实时性只到“有停顿的会话级”，连续高密度语音还不达标；Qwen 翻译尚未接入**
- 本轮**没有修改生产代码**，实验脚本、模型和结果都在 `.tmp/ja_bench/`；本文是交接给负责 Qwen 板块 agent 的入口

---

## 0. 先给结论（TL;DR）

1. **日语流式模型选 `Moonshine small-streaming-ja`**，不是 SenseVoice，也不是 `tiny`。`base-ja`/`tiny-ja` 是离线模型，不能用于流式。
2. **推荐运行配置**：
   ```text
   Moonshine small-streaming-ja
   CPU / ONNX
   update_interval = 1.0
   vad_threshold = 0.3
   ```
3. **精度**：
   - 8 段挑选样本：CER 4.4%~5.4%（**偏乐观**，不能代表整章）；
   - 场景 1 按台本句边界（oracle）整章：CER **15.44%**（394/2552 字），有效长句（≥3 秒）**11.93%**；
   - 场景 1 外部 VAD 清洗 + 句子级流式整章：CER **15.02%**（388/2583 字），与 oracle 同量级，但 speech-only RTF **1.373**，session RTF **0.755**；
   - SenseVoice 离线整章（60 秒分块）：CER **10.1%**，更准但不是流式。
4. **实时性**：
   - ASR 在 CPU 上 **GPU 占用 0**，Qwen 可以完整用 GPU；
   - 60 秒连续流 RTF 0.30；短句 per-segment RTF 0.63~0.68；
   - 但整章 **speech-only RTF 1.37 > 1**，连续说话会落后；session 平均 0.755，因为有停顿；
   - **17 分钟连续整章流未跑完**（12 分钟后手动终止，RSS 1.1GB）；不能整章直接灌。
5. **已排除的路线**：UVR5 HP2、频谱减噪、片段级语音/非语音分类器都没把 BGM/SE 清到可实时；不要再在这条过滤路上加码。
6. **下一步决策**：
   - **务实路线**：接受“离线/有停顿的实时草稿”，把 Qwen 翻译接上；当前 CER 15.02% 可作为草稿；
   - **连续高密度实时**：另立项目，做帧级 VAD/ASR 微调，或换更强 GPU/更彻底的人声分离；不是继续调阈值。

---

## 1. 素材与真值

### 1.1 素材结构

```
D:\Media\asmr\全年龄\RJ01241346\
├── mp3/
│   ├── 01.2人で縁側、波と風鈴の音.mp3
│   ├── 02.スイカかき氷作り.mp3
│   ├── 03.海で一緒にプカプカ.mp3
│   ├── 04.お風呂で全部洗ってあげる.mp3
│   ├── 05.海辺、七輪で晩ご飯.mp3
│   ├── 06.夜、波の音、添い寝.mp3
│   └── 07.縁側で朝日を一緒に.mp3
└── 台本テキスト.txt
```

台本是**真日语**，7 个 `■■■シーンN■■■` 与 7 章一一对应。只取 `【凛】` / `【叔母】` 的口播行；剔除 `【主人公】`、`ＳＥ：`、舞台指示和括号里的表演提示。

### 1.2 时间戳怎么来的

台本没有时间戳，所以不是直接拿字幕当真值：

1. 用 SenseVoice `output_timestamp=True` 得到字符级时间；
2. 把台本字符序列用 `SequenceMatcher` 对齐到 ASR 字符序列；
3. 每场景对齐率 **92.8%~96.0%**，据此给台本行赋 start/end；
4. 场景 1 共 127 行口播；其中 119 行可运行，8 行是 `すぅはぁ`/`ん`/`っしょっ` 等气声或语气词（无时间戳或 <0.15 秒）。

对齐产物：`.tmp/ja_bench/align_scene1.json` ~ `align_scene7.json`。

**重要限制**：真值来自台本 + 时间戳对齐，不是逐句人耳校验；个别行有 ±0.2~0.5 秒误差。正式验收前应抽 30~60 分钟人工复核。

---

## 2. 模型与配置结论

Moonshine 的日语模型实际只有：

| 模型 | 是否流式 | 说明 |
| --- | --- | --- |
| `tiny-streaming-ja` | 是 | 约 26MB 级，CPU 很快，但精度明显低 |
| `small-streaming-ja` | 是 | 默认推荐；CPU 可跑 |
| `base-ja` / `tiny-ja` | **否** | 离线，不能拿来做流式 |

运行环境：

- 独立 `.tmp/moonshine-venv`（Python 3.12 + `moonshine-voice` 0.1.5）；
- 模型权重在 `C:\Users\kevin\AppData\Local\moonshine_voice\...`；
- 16k 单声道 WAV；CPU/ONNX；GPU 占用 0；
- 许可：**Moonshine Community License，非商业**；分发/商用前必须确认。

### 2.1 为什么 `update_interval=1.0`

- `0.5` 秒：partial 更快，但最终 CER 反而升到 7.1%（8 段），不建议；
- `1.0` 秒：8 段 CER 4.41%~5.42%，RTF 0.63~0.68，推荐；
- `2.0` 秒：8 段 CER 4.07%，RTF 0.596，但 partial 更新慢到 2 秒；外部 VAD 整章用 u2.0 未跑完，无结论。

### 2.2 为什么 `vad_threshold=0.3`

默认 VAD 在长静音后会把第一句轻声漏掉；`0.3` 后 60 秒连续流的 8 行完整。这个参数对 ASMR/轻声非常关键。

### 2.3 不要用 keyterm

`keyterm_boost=2.0` + 热词（お兄ちゃん/匂い/かき氷/髪の毛/絡まり等）在 8 段上把 CER 从 4.41% 抬到 5.08%，暂不启用。

---

## 3. 实测结果

### 3.1 8 段挑选样本（用于快速比较，不是最终口径）

| 模型 / 配置 | CER（micro） | RTF（8 段） | 备注 |
| --- | --- | --- | --- |
| **small-streaming-ja**，u=1.0，vad=0.3 | **5.42%**（复跑 4.41%） | 0.676（复跑 0.628） | 推荐 |
| small，u=2.0，vad=0.3 | 4.07% | 0.596 | 2 秒更新 |
| small，u=1.0，默认 VAD | 7.46% | 0.744 | 长静音漏首句 |
| small，u=0.5，vad=0.3 | 7.12% | 0.857 | 更新太频繁反而差 |
| tiny-streaming-ja，u=1.0，vad=0.3 | 12.88% | 0.243 | 快，但精度低 |
| SenseVoice-Small 离线（GPU） | 5.42% | 0.015（GPU） | 非流式，样本对照 |

**这些 4.4%~5.4% 是挑选过的 6~9 秒句子级片段，不能当成整章精度。**

### 3.2 场景 1 整章：oracle 句边界

| 口径 | CER | 编辑/字数 |
| --- | --- | --- |
| 全部可运行口播行 | **15.44%** | 394 / 2552 |
| 把 8 个气声/语气词也算漏识 | 16.45% | 425 / 2583 |
| ≥3 秒有效句子 | **11.93%** | 248 / 2079 |
| ≥3 秒且 ≥8 字 | **11.75%** | 243 / 2068 |

行级：中位数 11.54%；23/119 行全对，53/119 行 ≤10%，79/119 行 ≤20%；3 行输出为空。短促语气词/呼吸声是拉高总 CER 的主要原因。

耗时：441.9 秒处理 532.7 秒纯语音（RTF 0.83）；按整章 1045.8 秒计 0.42。GPU 0；CPU 约 20 线程。

### 3.3 场景 1 整章：外部 VAD 清洗 + 句子级流式（当前最佳可部署结果）

清洗：**FSMN-VAD → 合并 ≤0.6s 间隙 → 丢弃 <0.5s 碎片 → 超过 8s 在低能量点切分**。完全不使用台本时间戳。

| 指标 | 结果 |
| --- | --- |
| VAD 原始段 → 清洗后 | 208 → **162** |
| 语音时长 | 574.3s |
| 整章 CER（2,583 字） | **15.02%**（388 编辑） |
| 输出字数 / 空段 | 2,584 / 3 |
| 总耗时 | 788.3s |
| speech-only RTF | **1.373** |
| session RTF（含 BGM/停顿 1,045.8s） | **0.755** |
| VAD 质量 | 6 行漏检；37 行被切成多段；42 段没有台本行（BGM/SE/气声） |

判断：

- 精度与 oracle 15.44% 同量级（差 0.4 个百分点，属于切分/样本方差）；VAD 清洗没有明显牺牲精度；
- 但 BGM/SE 误检仍在（开头会多出「ありがとうありがとういらっしゃい」这类文本）；
- **speech-only RTF >1**：连续说话会落后；**session RTF <1**：ASMR 有停顿，平均能追上；
- 这是目前最接近可部署的方案，但只适合**离线/有停顿的实时草稿**，不适合连续高密度语音。

### 3.4 连续流 / 长跑

- 60 秒连续流：small u=1.0/vad=0.3，wall 17.9~19.7s，RTF 0.30~0.33，8 行；
- 17.4 分钟整章连续流：12 分钟后未结束，RSS 从 292MB 涨到约 1.1GB，手动终止；
- 把段合并到 117、u=2.0 的整章尝试：跑到 60/117、约 10 分钟仍未结束，手动终止；
- 结论：**不能整章直接灌**；按句/按窗口独立起流才可控。

### 3.5 已排除的 BGM/SE 清洗路线

| 尝试 | 结果 | 判断 |
| --- | --- | --- |
| UVR5 HP2 人声分离（300s） | 分离 76.3s（0.25×实时）；同 24 行 CER **29.51% vs 原始 31.48%**；VAD 51 段 / 29 段无台本行（原始 44 / 23） | CER 略好，但 VAD 更碎、成本高，不划算 |
| 频谱减噪 α=0.8/1.2（300s） | FSMN 46 段 / 26~28 无台本行；Silero 42~46 段 / 21~24 无台本行 | 没有稳定改善 |
| 片段级语音/非语音分类器（场景 2~7 训练、场景 1 测试） | RF AUC **0.874**；场景 1 只有 7 个负样本；阈值 0.5 时语音召回 0.85（丢 15% 语音） | 负样本太少，不能安全过滤 |

**不要再继续调 UVR5/频谱/片段分类器；收益很小，且 UVR5 破坏实时性。**

---

## 4. 当前建议（给产品/工程）

### 路线 A：先做“离线/有停顿的实时草稿”（推荐先落地）

- 输入：日语 ASMR 音频；
- 外部 VAD（FSMN 清洗）→ 每句独立起 Moonshine small 流；
- 只把 final line 交给 Qwen2.5-7B 翻译；
- 预期：整章 CER 15.02%；有停顿的会话 session RTF 0.755；ASR GPU 0；
- 局限：连续高密度语音会落后；BGM/SE 误检会带来额外文本。

### 路线 B：连续高密度实时（另立项目）

- 不要继续调 VAD 阈值/过滤器；
- 需要：帧级 VAD/ASR 微调、或更强 GPU、或更彻底的人声分离；
- 这是模型/训练级投入，不是当前脚本调参。

---

## 5. 给 Qwen2.5-7B 负责 agent 的接入计划

> 本节是交接重点。**只接翻译，不改 ASR 路由、不做 ASR 文本后处理、不用 27B/云端。**

### 5.1 目标

把 Moonshine 的**已完成 final line** 翻成简体中文，输出实时字幕；partial ASR 不翻译或只显示原文。

### 5.2 硬约束

- 翻译模型：**只允许 Qwen2.5-7B-abliterated**（沿用项目现有 `llm.ps1 translate` / llama-server 配置；端点以现有服务为准）；不要用 27B、不要云 API。
- ASR 在 CPU，Qwen 在 GPU；8GB 卡，Qwen 建议 Q4 量化、2k 上下文、batch=1。
- 不启动测试服务前先看 `nvidia-smi`，并征得用户同意；用完立即停/卸载。
- 不做 ASR 文本纠错/重写；翻译只做“日语→简体中文”。
- 不改变现有 ASR 端点与页面行为；新增翻译链路应是加法的。

### 5.3 数据契约（建议）

ASR final segment：

```json
{
  "segment_id": "scene1-0042",
  "start": 123.45,
  "end": 130.20,
  "text": "お兄ちゃんの匂いってほんと不思議。",
  "language": "ja",
  "is_final": true,
  "revision": 1
}
```

翻译请求：

```json
{
  "segment_id": "scene1-0042",
  "text": "...",
  "target_language": "zh-CN",
  "prev_context": ["上一句 final 原文或译文"],
  "glossary": {"お兄ちゃん": "哥哥", "凛": "凛"},
  "max_tokens": 256,
  "temperature": 0.2
}
```

响应：

```json
{
  "segment_id": "scene1-0042",
  "translation": "...",
  "model": "qwen2.5-7b-abliterated",
  "latency_ms": 840,
  "finish_reason": "stop"
}
```

建议翻译接口支持 SSE/流式 token，但**只对 final segment 发起**；partial 不进入队列。

### 5.4 流式管线

```text
音频
  → 外部 VAD（FSMN 清洗，目标 4~8 秒一句）
  → Moonshine small-streaming-ja（CPU，u=1.0，vad=0.3）
  → final line（带 start/end）
  → 有界翻译队列（只放 final；同 segment_id 新 revision 覆盖旧任务）
  → Qwen2.5-7B（GPU）
  → 字幕合并（ASR 时间轴 + 中文译文）
```

- 队列建议最多 3~4 条，过期/被 revision 覆盖的任务直接丢弃；
- Qwen 超时 5 秒：回退显示原始 ASR，不阻塞后续句；
- 只翻译 `is_final=true`；partial 可以显示原文，不要用 Qwen 翻 partial，否则会浪费且译文抖动。

### 5.5 Prompt 约束（建议）

System：

> 你是日语到简体中文的实时字幕翻译器。只输出译文，不解释、不补写、不纠正原文；保留人名、专名和语气；原文是口语片段时按可理解的最小片段翻译；不要输出罗马字、括号说明或 Markdown。

User：上一句上下文 + glossary + 当前 final 日文。temperature 0.1~0.3，top_p 0.9，max_tokens 按句长限制。

- 不要让 Qwen 改写 ASR 原文；如果原文明显是碎片，按片段翻译，不要编造完整句子。
- 日文没有标点时，允许 Qwen 在译文中自然断句，但不要输出原文改写。

### 5.6 性能目标（需要实测）

- ASR finalization：语音结束后 1~2 秒内出 final；
- Qwen：短句 0.5~1.5 秒；
- 端到端：语音结束后 p50 ≤3 秒、p90 ≤5 秒（目标，不是承诺）；
- 显存：Moonshine 0 GPU；Qwen Q4_K_M 约 4.5~5GB + KV 0.5~1GB；桌面基线之外至少留 5.5GB；
- 如果 OOM：Qwen 降 Q4/减 context/部分层 offload；不要和 R2T2 等大模型同时常驻。

### 5.7 评测计划

1. **ASR**：沿用本报告的 8 段 + 场景 1 全章；CER 15.02% 是当前基线；
2. **翻译质量**：30 个 final 句子做人工 adequacy/fluency 评分；有 COMET 就跑 COMET，BLEU 只作参考；
3. **延迟**：ASR finalization、Qwen latency、队列等待、端到端 p50/p90；
4. **消融**：带/不带上一句上下文、带/不带 glossary；temperature 0.1/0.3；
5. **错误分析**：ASR 错字对译文的影响、Qwen 幻觉/漏译、短语气词处理。

### 5.8 实施步骤（建议顺序）

1. 确认 Qwen 服务：模型、端点、量化、当前显存；先不启动，和用户确认 GPU 窗口。
2. 定义 translation adapter + JSON/SSE 契约（与 ASR segment 对齐）。
3. 实现有界队列、final-only、revision/过期、超时回退。
4. 加 prompt/glossary/上下文；用 8 段跑通。
5. 用场景 1 全章跑端到端；记录 CER、译文质量、p50/p90、显存。
6. 更新 `docs/ASR.md` / `PROGRESS.md` / `AGENT_CHANGELOG.md`；不要改 ASR 路由。

### 5.9 非目标

- 不做 ASR 文本后处理/纠错（用户明确反对）；
- 不用 27B、云端翻译；
- 不做训练/批量/音色库改动；
- 不把连续整章流直接灌进 Moonshine；
- 不把 partial 送翻译。

---

## 6. 复现与文件地图

### 6.1 运行环境

- Moonshine：`.tmp/moonshine-venv`，`moonshine-voice==0.1.5`；
- VAD：`.tmp/vad-venv`（sherpa-onnx + silero_vad.onnx）；FSMN 用 `gsv5/.venv`；
- 台本对齐 / 特征：`gsv5/.venv`（funasr/sklearn/librosa）；
- 模型权重：`C:\Users\kevin\AppData\Local\moonshine_voice\...`；
- **这些都在 `.tmp`/用户缓存，不是生产依赖；不要删。**

### 6.2 关键脚本

| 文件 | 作用 |
| --- | --- |
| `.tmp/ja_build_ref.py` | 单场景台本 ↔ 音频字符级对齐 |
| `.tmp/ja_build_all.py` | 7 场景批量对齐 |
| `.tmp/ja_extract.py` | 8 段基准片段抽取 |
| `.tmp/ja_bench/ja_moonshine_bench.py` | Moonshine 8 段 / 参数扫描 |
| `.tmp/ja_bench/ja_moonshine_per_line.py` | oracle 句边界整章 CER |
| `.tmp/ja_bench/vad_scene1.py` | FSMN-VAD 原始段 |
| `.tmp/ja_bench/silero_scene1.py` | Silero VAD 原始段 |
| `.tmp/ja_bench/vad_clean.py` | FSMN 合并/丢弃/低能量切分 |
| `.tmp/ja_bench/ja_moonshine_vad_clean.py` | 外部 VAD 整章 CER（**最终 15.02%**） |
| `.tmp/ja_bench/uvr5_probe.py` | UVR5 HP2 5 分钟试点 |
| `.tmp/ja_bench/denoise_300s.py` | 频谱减噪试点 |
| `.tmp/ja_bench/vad_ml.py` | 片段级语音/非语音分类器 |

### 6.3 关键结果 JSON

- `align_scene1.json` ~ `align_scene7.json`：台本对齐；
- `ja_clips.json`：8 段清单；
- `moonshine_small_u1p0_vadthr.json`：8 段 small 结果；
- `moonshine_tiny_u1p0_vadthr.json`：8 段 tiny 结果；
- `sensevoice_offline.json`：8 段 SenseVoice 离线；
- `moonshine_scene1_per_line.json`：oracle 句边界整章；
- `moonshine_vad_clean_scene1.json`：**外部 VAD 整章 15.02%**；
- `uvr5_asr_compare_300s.json`：UVR5 试点；
- `vad_ml_rows.json`：片段分类器训练/测试特征。

### 6.4 一句话复现

```bash
# 台本对齐（场景 1）
gsv5/.venv/Scripts/python.exe .tmp/ja_build_ref.py 1

# 外部 VAD 整章（需先有 vad_fsmn_clean.json）
.tmp/moonshine-venv/Scripts/python.exe .tmp/ja_bench/ja_moonshine_vad_clean.py
```

---

## 7. 风险与限制（交接必读）

1. **真值不是人耳逐句校验**：来自台本 + 对齐，对齐率 92.8%~96%；CER 有少量参考误差。
2. **8 段样本偏乐观**：整章真实口径看 15.02%~15.44%，不要引用 4.4%。
3. **BGM/SE 误检**：外部 VAD 的 162 段中 42 段无台本行，会有多余文本；Qwen 翻译前要跳过空段/明显噪声段。
4. **连续实时不达标**：speech-only RTF 1.37；session RTF 0.755；17 分钟连续流未跑完。
5. **CPU 占用高**：Moonshine small 约 20 个逻辑线程（i7-14650HX 接近吃满）；Qwen 在 GPU 时 CPU 仍要留给 ASR。
6. **许可**：Moonshine Community License 非商业；商用/分发前确认。
7. **Qwen 未实测**：本文没有启动 Qwen 服务；端到端延迟/显存/译文质量都需要负责 agent 实测。
8. **不是 Whisper 对比**：本次没有跑 Whisper；不要拿外部 31.5% 等不同素材数字直接横比。

---

## 8. 交接检查清单

- [ ] 读完本文件 + `.tmp/ja_bench/report.md`
- [ ] 确认 Qwen2.5-7B-abliterated 的服务/端点/量化；先不启动，确认 GPU 窗口
- [ ] 确认 ASR 侧使用 `small-streaming-ja` CPU，`u=1.0`、`vad=0.3`
- [ ] 确认翻译只消费 final segment，不消费 partial
- [ ] 实现终稿队列 + revision/过期 + 超时回退
- [ ] 用 8 段跑通端到端，再跑场景 1 整章
- [ ] 记录 CER、译文质量、p50/p90、显存；更新文档
- [ ] 不改现有 ASR 路由/页面行为（只做加法）
- [ ] 不使用 27B/云端；不把 ASR 文本纠错当主线

---

**附：当前最重要的一句话**

> 日语流式 ASR 已经能用外部 VAD + Moonshine small 跑到整章 CER **15.02%**，适合做**离线/有停顿的实时草稿**；连续高密度实时和 BGM/SE 清洗仍未解决，Qwen 翻译应基于 final line 接入，不要继续在 ASR 后处理/过滤器上加码。

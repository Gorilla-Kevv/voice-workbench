# 引擎评估：Irodori-TTS（日语特化 + emoji 风格控制）

> 触发问题：用户提出 Irodori-TTS（`github.com/Aratako/Irodori-TTS`）"是对日语语音合成特化的模型"，
> 要求核实该说法并与现有引擎（GPT-SoVITS v2ProPlus / IndexTTS-2.5 / 网易 Confucius4-TTS）以及
> 上一轮评估过的 Genie-TTS、dots.tts 对比，并**实测训练日语的情况**。
> 本轮不改项目代码；基准脚本、模型与音频样本全部落在仓库外 `F:\schoolCompWorks\clone\_bench\`。
> 评估时间：2026-10-08 22:10 – 10-09 00:20 BY Qoder。同轮已实测：Genie-TTS、dots.tts（阶段 27）+
> Irodori-TTS 推理 39 条与训练 3 组探针（阶段 28，本文）。

---

## 1. 结论先说

| 问题 | 答案 |
| --- | --- |
| 真的是日语特化吗 | **是，而且是硬约束。** 模型卡明确 `language: ja`、"supports Japanese text input only"；文本/描述编码器是 `sbintuitions/modernbert-ja-310m`（日语 ModernBERT），声码 codec 是作者自训的 `Semantic-DACVAE-Japanese-32dim`（48kHz），文本归一化是日语规则表（剥 `♡ ● ▼ ♀ ♂ ①②③`、全角问号感叹号归一等）。它不像 GPT-SoVITS 那样"顺带支持日语"，而是整条链路都为日语装配 |
| 情感/风格操控是真的吗 | **是，且是我们现有栈里独一档。** 45 个官方 emoji 表（`EMOJI_ANNOTATIONS.md`）覆盖情感（喜/怒/哀/驚/心配/照れ/優しさ）、韵律（⏩早口 / 🐢ゆっくり / ⏸️間 / 📢エコー / 📞電話越し）、以及**非语言人声**（🤭笑い / 😭嗚咽 / 😱悲鳴 / 😮‍💨吐息 / 🤧咳 / 😒舌打ち / 🥤飲み込む / 😴寝言 / 🎵鼻歌 / 👅舐める音），可重复同一 emoji 加强；另有自由文本 `--caption` 走第三条条件分支 |
| 与 dots.tts 的情感控制差别 | dots.tts 只能"生成后再用 Edit 检查点改情感"（两段式、另一个 2.76GB 模型）；Irodori 是**生成时一次到位**，且能出非语言人声。代价：只有日语。数值精度控制（semitones / rate 倍率）仍是 dots.tts 更强，Irodori 没有 pitch/rate 参数 |
| 性能在我们机器上什么水平 | int4 + 默认 40 步 RTF **0.503**（≈GPT-SoVITS 的 0.46），净占显存 ~4.6GB；**6 步 + sway 实测 RTF 0.121，是这台 8.6GB 卡上最快的引擎**（比 GPT-SoVITS 快约 3.8 倍），还输出 48kHz。`--model-precision bf16` 没有加速（0.597），只省约 400MB |
| 男声能用 emoji 控制吗 | **基本不能——本机复现了官方 issue #9。** 用我们音色库的男声参考音时，😊/😠/😭/🤭 的 F0 全锁在 110.3–111.9Hz（跨度 1.6Hz，等于没动），只有时长与停顿在变（🤭 静音帧 44→57 仍有插入）。我们音色库是男声 ⇒ UI 不能宣传"男声情感操控"，只能说"节奏与插入音" |
| emoji 有没有失效项 | 有，实测两条：⏩（早口）语速 5.25 vs 基线 5.26 完全没变快；👂（囁き）能量 0.262 反而略高于基线 0.243。情感类（😊😠😭😱）与插入音类（🤭😮‍💨）有效，速率/音量类基本无效 |
| 训练日语可行吗 | **能跑，但有两个硬雷。** 本机实测（§5）：Speaker Inversion 在 bf16 基座上 batch 8 + 梯度检查点 **2.2 s/步、峰值净占 ~4.4GB**，默认 3000 步外推 **约 1.8 小时**，训出的 `.speaker.safetensors` 已验证可直接用于 `--ref-embed` 推理（闭环通）；LoRA batch 2 是 9.9 s/步（3000 步 ≈ 8.3 小时）。**雷一**：官方 `prepare_manifest.py` 在 Windows 上把 16/16 样本**静默丢弃**、退出码 0、产出空 manifest（我在本机复现了 issue #40）→ 接入必须校验 manifest 非空。**雷二**：训练数据本身要带 emoji 标注，否则模型学不到"这个 emoji→这种读法"（作者原话，issue #8 还说约 2h 数据能学到音色但强情感下会漂移） |
| 该不该接进项目 | 定位与现有三套**不重叠**（它们做中文/多语，Irodori 做日语 + emoji 风格），建议按"日语专用引擎"接入，不动主力。风险集中在 Windows 依赖链、水印开销、男声 emoji 失效与采样长尾，见 §6 |

---

## 2. 模型与能力事实（可核查来源）

| 项 | 值 | 来源 |
| --- | --- | --- |
| 架构 | Rectified-Flow DiT（joint-attention + Low-Rank AdaLN + half-RoPE + SwiGLU）在连续 DACVAE latent 上；文本/描述共享 ModernBERT-ja-310m；参考语音走 speaker patch encoder；v4.1 独立重训时长预测器 | [repo README](https://github.com/Aratako/Irodori-TTS)、[v4.1-Small 模型卡](https://huggingface.co/Aratako/Irodori-TTS-v4.1-Small) |
| 检查点尺寸 | v4.1-Small bf16 **3.06 GB**；量化版 int4 **0.79 GB** / int8 0.85 / fp8 0.85；MF（MeanFlow 4 步）2.88 GB；**v4-Large 12.25 GB**（且 v4-Large 是 **Gemma 条款，不是 MIT**） | [Quantized repo](https://huggingface.co/Aratako/Irodori-TTS-v4.1-Small-Quantized)、[v4-Large](https://huggingface.co/Aratako/Irodori-TTS-v4-Large) |
| 许可 | MIT + 附加**伦理限制**（禁止未经同意的模仿/深伪）；作者确认允许商用，未禁止去水印（水印是 SilentCipher，可用时自动加） | 模型卡 License 段、[issue #32](https://github.com/Aratako/Irodori-TTS/issues/32) |
| emoji 控制规模 | 官方文档表 `EMOJI_ANNOTATIONS.md` 列 **45** 个（三语释义），代码白名单 `irodori_tts/duration.py:9 ALLOWED_ANNOTATION_EMOJIS` 有 **56** 个 → 做 UI 以代码常量为准。作者自述：表尾 emoji 训练样本极少（🤐 约 1000 / 4000 万），效果不完全稳定 | 两处文件本机核对、[issue #35](https://github.com/Aratako/Irodori-TTS/issues/35) |
| 语言 | 仅日语 | 模型卡 Limitations 第一条 |
| 客观指标 | Joyo Kanji Yomi（训练集未含）：v4.1-Small Kana-CER **7.29%** / 句级 2.36% / CER 4.69%；v4-Small 7.43/2.89/5.35；600M-v3-VD 8.49/2.45/4.88；JSUT BASIC5000 句级 kana-CER **3.43%**。对照（他人论文口径，卡里声明"不是受控排名"）：T5Gemma-TTS 13.81/3.69，Sarashina2.2 7.83/3.41 | v4.1-Small 模型卡 Benchmarks |
| 指标缺口 | **没有人类 MOS**（卡里自己写明没做大规模人工评测）；Voice Design 遵循度用 Gemini 判分（1–5）：v3-VD 4.2096 → v4-Small 4.2339 → v4-Large 4.2991 | 同上 |
| 克隆相似度 | JVS CAM++ 余弦：单条短参考 v3 **0.6782** > v4-Small 0.6610（卡里承认短参考退化，建议 ≥30s 干净参考）；~30s 0.7521；120s 0.7753 | v4-Small/v4.1 模型卡 |
| 训练数据 | **作者从未公布数据集名称与小时数**，只说"扩充的高质量日语语音数据集"；标注由微调过的 Qwen3-Omni-30B 自动生成，约 4000 万样本量级（作者在 issue 里的口头说法） | [issue #35](https://github.com/Aratako/Irodori-TTS/issues/35) |
| 官方服务形态 | 另有 [Irodori-TTS-Server](https://github.com/Aratako/Irodori-TTS-Server)：OpenAI 兼容 `POST /v1/audio/speech`，暴露 `irodori.caption`、`num_steps`、`speed 0.25–4.0`、长文本切分、音色 CRUD，默认 int8 | 该 repo README |

---

## 3. 本机性能实测（RTX 4060 Laptop 8.6 GB）

协议与上一轮一致：同一套 6 句日语文本、单进程只加载一次模型（暖机单独计时）、
整卡显存 0.25s 采样取峰值、RTF = 合成耗时 / 音频时长。本机其它进程当时占 ~2.3–3.0 GB，
所以"净占"用峰值减基线估算。

| 配置（int4-weight-only） | 载模型 | RTF 均值 | 整卡峰值 / 净占 | 输出 |
| --- | --- | --- | --- | --- |
| `--model-precision fp32`（CLI 默认，40 步） | 20.5s | **0.503**（中位 0.478） | 7647 MB / ≈4.6 GB | 48 kHz |
| `--model-precision bf16`（README 推荐） | 19.0s | 0.597 | 7238 MB / ≈4.2 GB | 48 kHz |
| 带参考音克隆（speaker 分支开） | 23.0s | 0.851（0.53–1.14） | 7752 MB / ≈4.7 GB | 48 kHz |
| caption 语音设计（5 组） | 22.8s | 0.626 | 7200 MB | 48 kHz |

**步数就是它的性能杠杆**（同一条 51 字长句，输出时长恒为 11.04s）：

| 采样配置 | sample_rf | RTF | F0 中位 |
| --- | --- | --- | --- |
| 40 步 linear（默认） | 4430 ms | 0.441 | 226.4 Hz |
| 20 步 | 2291 ms | 0.246 | 213.8 Hz |
| 10 步 | 1258 ms | 0.166 | 217.2 Hz |
| **6 步 + sway(-1.0)** | **904 ms** | **0.121** | 220.2 Hz |

横向对照（同机同协议，上一轮实测）：

| 引擎 | RTF | 暖机 | 显存峰值 | 采样率 |
| --- | --- | --- | --- | --- |
| **Irodori int4 + 6步sway** | **0.121** | 21s | ≈4.7 GB 净占 | **48 kHz** |
| GPT-SoVITS v2ProPlus（GPU） | 0.46 | 22.2s | 4563 MB | 32 kHz |
| Irodori int4 默认 40 步 | 0.503 | 20.5s | ≈4.6 GB 净占 | 48 kHz |
| Genie-TTS（CPU ONNX） | 0.851 | 7.5s | 0 | 32 kHz |
| dots.tts SOAR q8（audio.cpp/CUDA） | 0.918 | ~10s | 7742 MB | 48 kHz |
| IndexTTS-2.5（GPU） | 1.354 | 64.9s | 7562 MB | 22.05 kHz |
| 网易 Confucius4-TTS（GPU） | 1.605 | 68.9s | 7752 MB | 22.05 kHz |

要点：

1. **它是我们在 8.6GB 卡上拿到的最快引擎**：6 步 + sway 实测 RTF 0.121，比 GPT-SoVITS 快 ~3.8 倍，
   而且输出 48kHz（GPT-SoVITS 是 32kHz）。降步数的代价是质量，我的 F0/时长指标看不出退化，
   **但这类指标测不出气口、毛刺、 Metadata 类伪影——必须靠耳朵验收**，官方 MF 检查点的数据
   也提醒步数不能瞎砍（RF 只跑 4 步会把克隆相似度从 0.7521 打崩到 0.3835）。
2. `--model-precision bf16` 在我这台 cc8.9 上**没有加速**（0.597 vs 0.503），只省约 400MB；
   int4 权重路径本身把显存压在 ~4.6GB，这是它能和别的进程共存的关键。
3. **显存不是瓶颈，但也不能忽略**：净占 ~4.6GB 与网易(4.9)/IndexTTS(5.3) 同档，
   仍然必须进 arbiter 排队，不能与它们共存。
4. **尾延迟有雷（实测两次）**：一次 emoji 批次里 `⏩` 用 15.16s 合成 4.00s 音频（RTF 3.79），
   另一次 `⏩`+男声参考用 **89.17s 合成 4.96s**（RTF 18.0），都发生在 `sample_rf` 阶段。
   我没有把它当成引擎缺陷就写结论——专门做了复测：无参考条件下 `⏩` 换 seed 重复 6 次全部 2.5–2.6s（正常），
   带参考条件换 seed 43/44 也正常，**只有 seed 42 那一次炸**；把步数降到 20 后同一条命令 2.16s 出结果。
   结论：这是**偶发的采样长尾**，约 1/40 次，可用"步数降低 + 请求超时重试"兜住，但接入时**必须有超时护栏**。

---

## 4. 情感/风格控制实测

### 4.1 emoji 控制（同一句 `今日の会議は午後三時に変更になりました。`，只换 emoji，女声无参考）

| 用例 | 时长 | 字·秒⁻¹ | F0 中位 | F0 p90 | 有声帧 | 静音帧 |
| --- | --- | --- | --- | --- | --- | --- |
| 无 emoji | 3.80 | 5.26 | 223.3 | 297.4 | 70 | 25 |
| 😊 喜び | 4.92 | 4.27 | **269.7** | 351.7 | 64 | 59 |
| 😊😊😊 | 5.72 | 4.02 | 260.9 | 345.3 | **85** | 58 |
| 😠 怒り | 4.68 | 4.49 | 268.9 | 355.1 | 66 | 51 |
| 😭 泣き | 4.64 | 4.53 | 266.7 | 354.0 | 62 | 54 |
| 😱 悲鳴 | 5.28 | 3.98 | 265.2 | **384.0** | 83 | 49 |
| 🤭 笑い | 5.88 | 3.57 | **172.7** | 270.6 | 69 | **78** |
| 😮‍💨 吐息 | 5.20 | 4.42 | 271.2 | 359.8 | 61 | 69 |
| 👂 囁き | 4.48 | 4.69 | 271.2 | 358.2 | 59 | 53 |
| ⏩ 早口 | 4.00 | 5.25 | 153.8 | 219.2 | 64 | 36 |
| 🐢 ゆっくり | 4.36 | 4.82 | 258.1 | 355.1 | 68 | 41 |

判读：

- **情感维度确实动**：F0 从基线 223 抬到 265–271（喜怒哀乐惊全线抬升），🤭 反而压到 172.7 且
  静音帧从 25 涨到 78（= 插入笑声/停顿这类**非语言人声**的直接信号），👂 有声帧最少（59）。
- **放大有效**：😊×3 比单个 😊 时长 5.72 vs 4.92、有声帧 85 vs 64 → 官方"重复同一 emoji 加强"的说法成立。
- **两条没兑现**：⏩ 语速 5.25 ≈ 基线 5.26（没变快），🐢 4.82（略慢但远低于预期）；
  👂 的能量 0.262 甚至高于基线 0.243，"耳语"在能量维度上没体现（可能是气声化而非降能量，我的指标区分不了）。
  → **emoji 的效果高度不均匀**，与模型卡自述"effect may vary and is not always perfectly consistent"一致。

### 4.2 caption 语音设计（同一句，只换描述文本）

| caption | F0 中位 | 字·秒⁻¹ | 时长 |
| --- | --- | --- | --- |
| 明るい元気・少し早口な若い女性 | **259.5** | **5.56** | 3.60 |
| 落ち着いた女性話者（基线） | 223.3 | 5.26 | 3.80 |
| 深く傷つき泣き出しそうで声が震える | 152.1 | 5.26 | 3.80 |
| 低く渋い年配男性・ゆったり | **146.8** | 4.76 | 4.20 |
| ささやき声・電話越し | 143.5 | 4.95 | 4.04 |

- **caption 管音色/音高/语速很有效**（F0 跨 1.77 倍：143.5→259.5），"早口"字样也确实带来最高语速。
- 与参考音分工清楚：加男声参考后 F0 直接落到 111–114 Hz（见 4.3），**参考音定音色、caption 定风格**成立。

### 4.3 官方"emoji 对男声几乎无效"——本机复现（issue #9）

同一批 emoji 打在中文男声参考音（F0 ~111Hz）上：

| 用例 | 时长 | 字·秒⁻¹ | F0 中位 | 有声帧 | 静音帧 |
| --- | --- | --- | --- | --- | --- |
| male 无 emoji | 4.96 | 4.03 | 111.4 | 80 | 44 |
| male 😊 | 5.56 | 3.78 | **111.4** | 101 | 38 |
| male 😠 | 4.96 | 4.23 | 111.9 | 85 | 39 |
| male 😭 | 5.56 | 3.78 | 110.3 | 96 | 43 |
| male 🤭 | 5.80 | 3.62 | 111.0 | 88 | **57** |

**F0 完全不动（110.3–111.9，跨度 1.6Hz）**，只有时长/停顿在变（🤭 静音帧 57 vs 基线 44 仍有插入）。
这条对我们尤其重要：**音色库里是男声**，所以"emoji 情感"在我们的男声上大概率只买到"节奏与插入音"，
买不到明显的音调情绪 → 接入时 UI 预期必须这样写死，不能宣传"男声情感操控"。

### 4.4 与 dots.tts 的控制方式对照

| | Irodori | dots.tts |
| --- | --- | --- |
| 生成时指令 | ✅ emoji 45 个 + 自由文本 caption（一次到位） | ❌ 实测无效（`<emo>` 内联与 instruction 模板都不动 F0） |
| 生成后改情感 | ❌（无编辑模型） | ✅ Edit 检查点 `<emo>/<pitch>/<rate>`，实测 F0 106→222.8、rate×1.32 |
| 非语言人声（笑/哭/叹气/咳） | ✅ emoji 独有能力，实测静音帧 +112%（25→78） | ❌ 没有这类标签 |
| 语言 | 仅日语 | 中/英/日/韩等 24 语种 |
| 数值精度控制 | ❌ 无 pitch/rate 数值参数（只有 duration_scale / 步数） | ✅ `<pitch semitones>` `<rate factor>` |


---

## 5. 训练日语的实测与判断

### 5.1 本机实测（bf16 基座 3.06GB，16 条日语音频作数据）

先说数据的性质：训练素材是我用 Irodori/ IndexTTS 生成的日语音频（16 条，0.9–3.0s latent 90–156 帧）。
**这一节只回答"我们这张 8.6GB 卡能不能跑起来、要多久"，不是数据质量或音色相似度结论**——
真实微调必须换成有授权的日语语料（JSUT / JVS / 自采），且按官方建议给数据本身打 emoji 与 caption 标注。

| 探针 | 配置 | 结果 | 每步耗时 | 整卡显存峰值 |
| --- | --- | --- | --- | --- |
| Speaker Inversion | bf16 基座 + batch 2 + 梯度检查点，15 步 | ✅ 完成（loss 0.87→0.79，产出 `checkpoint_final.speaker.safetensors` 49KB） | ~7s/步（含首步） | 6131 MB |
| Speaker Inversion | 同上，**batch 8**，10 步 | ✅ 完成 | **2.2 s/步** | 6911 MB |
| LoRA | r16 目标 `diffusion_attn` + batch 2 + 梯度检查点，15 步 | ✅ 完成（loss 0.77→0.78） | **9.9 s/步** | 6614 MB |
| 闭环验证 | 用训出的 `.speaker.safetensors` 走 `--ref-embed` 推理 | ✅ 出音 4.16s，`total_to_decode` 4.00s | — | — |

外推到可用规模（按 repo 默认步数）：

- Speaker Inversion 默认 3000 步 → batch 8 实测 2.2 s/步 ⇒ **约 1.8 小时**，显存有余量，
  这是我们这张卡上唯一"一个晚上能出结果"的训练路径。
- LoRA 默认 30000 步是作者尺度；按 9.9 s/步换算 3000 步就要 **8.3 小时**，
  若要做社区那条 2500 步风格微调，需要接受整夜级耗时或把 batch 提到 4–8（显存是否吃得下要再测）。

### 5.2 训练数据的 Windows 陷阱（本机复现，比上面所有数字都重要）

官方数据入口 `prepare_manifest.py` 在这台机器上的真实行为：

```text
Generating train split: 16 examples
done. seen=16 written=0 skipped_audio=16
skip breakdown:
  dataset_iter_error: 16
```

**退出码 0、日志说 "done"、`manifest.jsonl` 0 字节、latents 目录空**——16 条样本全部被静默丢掉。
根因就是我在 §6 记的那条：datasets 的 Audio 解码走 torchcodec，Windows 装不上（cu128 索引无 wheel），
它不报错只是跳过。这与上游 [issue #40](https://github.com/Aratako/Irodori-TTS/issues/40) 描述完全一致，
**本机第一次尝试训练就会撞上，而且没有任何提示**。

绕过办法（本轮实测可用）：不调 `prepare_manifest.py`，直接用仓库自己的
`irodori_tts.codec.DACVAECodec.encode_file()` 把本地 wav 编成 latent，再按官方 schema 手写 JSONL
（字段 `text/caption/latent_path/speaker_id/num_frames`）交给 `train.py`。脚本在
`_bench/train_irodori_probe.py:build_manifest()`。**接入项目时这条必须做成显式校验**：
manifest 行数 > 0 才允许开训，否则就是"跑了一晚上训练了个空数据集"。

### 5.3 已有的可核查外部数据点（先记录，作为对照）

- 作者配置是数据中心尺度：全量微调与 LoRA 都是 `batch_size: 40`、`gradient_accumulation_steps: 2`、
  `max_steps: 30000`，**梯度检查点默认关闭**，repo 里没有任何"最低显存"声明，只在注释里说
  "GPU 显存紧张时打开 gradient_checkpointing"（[configs/train_v4_small_lora.yaml](https://github.com/Aratako/Irodori-TTS/blob/main/configs/train_v4_small_lora.yaml)）
- Speaker Inversion 配置显存友好得多：`batch_size: 16`、**gradient_checkpointing: true**、3000 步、
  只训 16 个 embedding token、基座冻结（[configs](https://github.com/Aratako/Irodori-TTS/blob/main/configs/train_v4_small_speaker_inversion.yaml)）
  ——注意官方 batch 16 比我们实测的 batch 8 更大，我们没试 16（会撞显存墙，值得后续验证）
- 社区消费级实测：[irodori-style-lora](https://github.com/vaundykimura/irodori-style-lora) 在 **RTX 3070 8GB** 上
  batch 2 + 梯度检查点跑 2500 步约 **1.5–2 小时**（自评"风格分离仍然偏弱"）——比我的 9.9 s/步外推更乐观，
  差异可能来自数据长度与 compile 设置，我们的数字是保守上界；
  [Irodori-TTS-Client](https://github.com/loaigirlxoxo-oss/Irodori-TTS-Client) 明确"训练只在 16GB 验证过"，
  其"かんたん学習"峰值 ~11GB，LoRA batch 8 + v4.1-Small（120s 参考）~9.5GB
- 效果预期要压低：[issue #8](https://github.com/Aratako/Irodori-TTS/issues/8)——约 2 小时干净日语数据能学到音色，
  但**强情感下音色会漂移**；作者本人说 LoRA 配方"基本没探索过"，建议更小 batch + 更多步、lr 3e-4～1e-3、
  并**给训练数据本身打 emoji 标注**（否则模型学不到"这个 emoji→这种读法"）


---

## 6. 风险登记（含本机实测撞到的）

| 风险 | 说明 | 证据 |
| --- | --- | --- |
| **Windows 依赖链是二等公民** | `torchcodec>=0.10,<0.11` 在 cu128 索引**没有 Windows wheel**，而 torch≥2.9 的 `torchaudio.load` 完全依赖它 → 任何读参考音频的路径直接 `ImportError`。本轮靠 `sitecustomize` 把 `torchaudio.load` 换成 soundfile 才跑通（脚本里带垫片）。更糟的是 [issue #40](https://github.com/Aratako/Irodori-TTS/issues/40)：即使 torchcodec 装上，FFmpeg DLL 缺失会让训练**静默跳过每一个样本**（`skip breakdown: dataset_iter_error`），社区解法是"full shared"FFmpeg 构建 | **本机复现**：`prepare_manifest.py --dataset json --data-files` 结果 `seen=16 written=0 skipped_audio=16`，退出码 0、manifest 0 字节（§5.2）+ issue #40 |
| git-only 依赖 | `dacvae` 不在 PyPI（`git+https://github.com/facebookresearch/dacvae`），`silentcipher` 也是 git+pinned-commit；本机的 github.com 直连被墙，只能走 codeload 拉 tarball，再补 `descript-audiotools` | [pyproject.toml](https://github.com/Aratako/Irodori-TTS/blob/main/pyproject.toml) |
| 水印不可关 | SilentCipher 可用时自动加水印，`--no-watermark` 请求**没有被合并**（PR #38）；该 PR 实测水印约占单次请求耗时的**一半**、约 **0.9 GB** 峰值显存。本轮环境未装 SilentCipher，因此我的 RTF 是**不含水印的最好情况**，真实接入要按 ≈2× 预算 | [PR #38](https://github.com/Aratako/Irodori-TTS/pull/38) |
| 长文本不稳 | 训练音频都 ≤30s，>30s 出现退化/幻觉（[issue #13](https://github.com/Aratako/Irodori-TTS/issues/13)）→ 接入必须自带切句 | issue #13 |
| v4 特有崩溃模式 | 当输入 `text` 写得像"描述"时 v4 会塌（官方 demo 可复现，issue 仍 open）（[#41](https://github.com/Aratako/Irodori-TTS/issues/41)） | issue #41 |
| 男性音色 emoji 弱 | emoji 控制"对男声几乎无效"（[#9](https://github.com/Aratako/Irodori-TTS/issues/9)），且表尾 emoji 训练样本极少（🤐 约 1000/4000万），作者自己说"标注可能有错、效果不完全稳定" | issue #9 / #35 |
| caption 与参考音冲突 | 卡里明确：两者矛盾会导致不稳定输出/一个条件压过另一个 → UI 要把"参考音定音色、caption 定情绪"写死成引导 | 模型卡 Limitations |
| **采样长尾（本机实测）** | 约 1/40 的请求出现灾难性慢生成：`⏩` 无参考时 15.16s 合成 4.00s 音频，`⏩`+男声参考时 **89.17s 合成 4.96s**，都卡在 `sample_rf`。定向复测（无参考 6 次、换 seed 2 次）全部正常，**只有 seed 42 那次炸**；同一条命令把步数降到 20 变 2.16s。结论：偶发长尾，接入必须有请求超时 + 重试（降步数即可绕开） | 本文 §3 要点 4，脚本 `irodori_run_all.py --mode fastprobe` |
| emoji 数量口径不一致 | 官方 `EMOJI_ANNOTATIONS.md` 列 **45** 个，代码 `irodori_tts/duration.py:9 ALLOWED_ANNOTATION_EMOJIS` 是 **56** 个 → 做 UI 调色板要以代码常量为准，文档表只给释义 | 本机读取两处文件核对 |
| 训练"空转"风险 | 与上一条同源：数据入口静默丢样本 → 训练可以"成功跑完"却什么都没学。**任何训练前都要断言 manifest 行数 > 0** | §5.2 本机实测 |
| 少字与 MF 的取舍 | MF 4 步接近 RF 40 步质量（Joyo 92.76 vs 93.42），但**RF 只用 4 步会把克隆相似度打崩**（JVS cos 0.7521 → 0.3835）；MF 会锁定 guidance（CFG 被忽略）。本文 §3 的 6 步+sway 是 RF 路径，**质量必须由耳朵验收，我的 F0/时长指标看不出伪影** | [MF 模型卡](https://huggingface.co/Aratako/Irodori-TTS-v4.1-Small-MF) |
| v4-Large 许可不同 | 基于 T5Gemma-2，**Gemma Terms 而非 MIT**，且 12.25 GB 显存放不下 → 本项目不考虑 | v4-Large 卡 |
| 没有官方音色库 | 核查过作者 22 个 GitHub 仓库与 9 个 HF 模型库，**不存在** "IRODORI-SP" 之类专业声优包；社区用自训 `.speaker.safetensors` 或第三方 Anime 版 | 本轮核查 |
| 无人类 MOS / 无跨语种能力 | 只有自动 benchmark；中文/英文不能用 → 不能替代现有主力，只能并行新增 | 模型卡 |

---

## 7. 接入建议（若你点头）

1. **形态**：走 `Aratako/Irodori-TTS-Server`（OpenAI 兼容，默认 int8，已有 caption/num_steps/speed/音色 CRUD），
   网关侧照 netease/indextts 的既有模式做 `/api/irodori/*` 透传 + RuntimeSupervisor 启停，
   比我们自己包 `infer.py` 便宜得多。**注意**：该服务同样要解决 Windows 的音频解码路径
   （坑 33 ②），并且我们实测 int4 比 int8 更省显存（0.79GB 权重 / 净占 ~4.6GB），
   建议直接用 `int4-weight-only` + `--model-precision fp32`（bf16 在本机不快）。
2. **arbiter/preload 记账**：净占 ~4.6GB（生成，不含参考音）到 ~4.7GB（带参考音）；若把水印装上，
   按上游 PR #38 再 +~0.9GB 且耗时约翻倍。必须复用"模型已加载就跳过准入"的修法（坑 26 同款 bug）。
3. **超时护栏（新增，必须做）**：`sample_rf` 存在偶发长尾（实测最坏 89s 出 4.96s 音频），
   服务侧要有请求超时 + 自动降步重试（40→20 步即可绕开），否则一次坏 seed 会把整条链路挂住。
4. **UI 定位**：新导航组"日语 · emoji 风格"，与"情感可控"（IndexTTS，中文 8 维向量）并列而非互相替代；
   页面把 emoji 调色板按代码常量 `ALLOWED_ANNOTATION_EMOJIS`（**56 个**，官方文档表只列 45 个）生成，
   带日语/中文释义；**⏩/🐢/👂 这类实测未兑现的标签不要承诺效果**；
   话者如果是男声，界面上要把 emoji 效果降级描述为"节奏/插入音"（§4.3 实测 F0 不动）；
   默认切句 ≤ 25 字、caption 只描述情绪/环境不定音色。
5. **训练**：只做 Speaker Inversion（登记专属日语音色，实测 2.2 s/步 @batch 8、3000 步 ~1.8h 一晚出结果），
   不做全量微调；数据必须自己带 emoji 标注；**训练前断言 manifest 行数 > 0**（坑 33 ①）。
6. **不做**：不替代主力（它只会日语）；不碰 v4-Large（Gemma 条款 + 12.25GB）；不在中文链路里引用它。
7. **先听再决定**：我的指标只能证明"有变化"，不能证明"好听"。要耳朵判的四条见 §8 末尾清单。


---

## 8. 复现清单

脚本都在 `_bench/`（仓库外，项目代码零改动）：

| 脚本 | 作用 |
| --- | --- |
| `irodori_run_all.py` | 单进程加载一次，跑 perf / emoji / caption / steps / ref / refemoji / fastprobe / stability 八组，自带整卡显存采样与阶段耗时 |
| `analyse_wavs.py` | 自适应阈值 F0 / 语速 / 能量 / 有声帧测量（跨引擎同一把尺子） |
| `train_irodori_probe.py` | 本地音频→DACVAE latent→JSONL（绕开官方入口）+ Speaker Inversion / LoRA 显存与每步耗时实测 |
| `shim/sitecustomize.py` | Windows 的 `torchaudio.load`→soundfile 垫片 |
| `chunked_dl.sh` | 镜像限速时的 Range 并发下载器（8 路 ≈3.5MB/s） |

环境与资源：venv `irodori-venv`（py3.12 + torch 2.10.0+cu128 + torchao 0.16 + transformers 5.19 +
descript-audiotools + torchdata，**未装 torchcodec/silentcipher**）；模型 `models/irodori_v4.1_small_int4/`
（int4 0.79GB + tokenizer 7MB）、`models/irodori_bf16/`（3.06GB，训练用）、`dacvae_local/weights.pth`
（410MB，注意首次下载被截断过，`torch.load` 报 central directory 错，续传后正常）；
代码 `Irodori-TTS/` 与 `dacvae/`（都走 codeload tarball，github.com 直连本机不通）。
产物：`out/irodori/*.wav`（39 条）、`irodori_fp32.json` 等 8 组指标、`irodori_acoustics.json`、
`outputs/speaker_inversion/checkpoint_final.speaker.safetensors`。

**试听重点**（我的声学指标测不出来的东西，需要你耳朵判）：`emo_chuckle`（有没有真的笑出来）、
`emo_scream`、`cap_deep_old_male`（低男声自然度）、`male_joy` vs `male_none`（男声 emoji 是否真的无感）、
`steps_6_sway` vs `steps_40`（砍步数有没有毛刺/发虚）、`ref_00`（中文男声参考读日语的口音与相似度）。


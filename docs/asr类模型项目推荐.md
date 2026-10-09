我先做一轮检索，确认这些项目在 2026 年的最新状态（版本、许可证、支持情况），避免给出过时的结论。
再核实几个关键项目的当前状态（含直接吃视频文件的端到端工具）。
先说一个关键事实：**没有任何语音识别模型能直接"吃"视频文件**。所有方案的底层都是同一条流水线——把视频里的音轨抽出来，再交给 ASR 模型。差别只在于：有的项目帮你把这两步封装好了（拖个 mp4 进去就出字），有的需要你自己用命令行串起来。
抽音轨这一步就一条命令，ASR 模型基本都要求 **16kHz 单声道**：

```bash
ffmpeg -i input.mp4 -vn -ar 16000 -ac 1 -c:a pcm_s16le audio.wav
# 想省磁盘就用 MP3：ffmpeg -i input.mp4 -vn -ar 16000 -ac 1 -b:a 64k audio.mp3
```

下面按"模型引擎"和"开箱即用工具"两层来推荐。

---

## 一、ASR 引擎（模型层）

### A. Whisper 系 —— 多语种通用，生态最成熟

| 项目 | 特点 | 许可 |
|---|---|---|
| **faster-whisper** | Whisper 的 CTranslate2 重写版，同精度下比原版快 4–5 倍、显存更低，支持 int8 量化。支持约 99 种语言。**通用场景的默认首选** | MIT |
| **WhisperX** | faster-whisper + wav2vec2 强制对齐（词级时间戳误差从约 ±500ms 压到 ±50ms）+ pyannote 说话人分离，直接输出 srt/vtt/json | BSD-2-Clause |
| **whisper.cpp** | 纯 C/C++，零 Python 依赖，CPU 和 Apple Silicon（CoreML/Metal）上最快，`--output-srt` 直接出字幕 | MIT |
| **openai/whisper** | 官方参考实现，慢、占显存，只建议做基线对比或微调研究 | MIT |

**准确度**：英文短音频第三方榜（Open ASR Leaderboard，2026-07-31 快照）平均 WER：Whisper-large-v3 为 6.55%，large-v3-turbo 为 7.01%。**注意：只有 large-v3 级别才谈得上多语种可用，base/small 基本只对英文有意义。** 中文是 Whisper 的短板。

### B. 中文系 —— 中文明显强于 Whisper

| 项目 | 特点 | 许可 |
|---|---|---|
| **FunASR**（阿里达摩院工具包） | 一站式：VAD + 识别 + 标点 + 说话人分离 + 情感/事件识别全自带，一个 API 调用搞定。内含 Paraformer、SenseVoice-Small、Fun-ASR-Nano 等模型 | 工具包 MIT，模型权重另有协议 |
| **Qwen3-ASR-1.7B / 0.6B** | 30 种语言 + 22 种中文方言（合计 52），流式/离线同一套模型，配 Qwen3-ForcedAligner 出时间戳，还能识别歌曲。0.6B 在 128 并发下约 2000 倍实时吞吐。**方言和中英混说是它最强的地方** | Apache-2.0 |
| **FireRedASR2S**（小红书） | ASR + VAD + 语种识别 + 标点四件套，官方称普通话平均 CER 2.89%，24 个公开测试集上表现领先 | Apache-2.0 |

**准确度**：FunASR 官方在 184 个中文音频（约 192 分钟、H100）上的自测：SenseVoice-Small 中文 CER 7.81%，Whisper-large-v3 为 20.02%。Qwen3-ASR-1.7B 官方 WER：AISHELL-2 2.71%、WenetSpeech 4.97/5.88、方言 KeSpeech 5.10，均优于 Whisper-large-v3。

> 先解释两个词：**WER/CER 就是"错字率"**，数值越低越准。CER 按字算（中文用这个），WER 按词算（英文用这个）。

**代价**：FireRedASR2S 的 LLM 版 8.3B，单卡 32GB 起步才稳，AED 版单条音频限 60 秒——门槛偏高，普通团队不建议第一个上。

### C. NVIDIA NeMo 系 —— 英文批量处理的速度之王

| 项目 | 特点 |
|---|---|
| **Parakeet-TDT-0.6B-v3** | 吞吐怪物，RTFx 约 6000（即 1 秒能处理约 100 分钟音频），英文 WER 5.66%，v3 版本已扩展多语种 |
| **Canary-Qwen-2.5B** | FastConformer 编码器 + Qwen3-1.7B 解码器，英文短音频平均 WER 5.06%，当前开源英文精度第一梯队；同时支持语音翻译 |

**限制**：权重是 CC-BY-4.0（可商用但**必须署名**），且高度依赖 NVIDIA GPU；语种覆盖远不如 Whisper（Canary-v2 约 25 种欧洲语言）。中文场景基本用不上。

### D. 端侧 / 离线部署

- **sherpa-onnx**（Apache-2.0）：只做推理，ONNX Runtime 即可跑，不装 PyTorch。支持 Paraformer / Whisper / SenseVoice，覆盖 Linux/macOS/Windows/Android/iOS/树莓派/WebAssembly。**要把中文 ASR 塞进客户端或嵌入式设备时用它。**
- **Vosk**：轻量、模型小、语言多，精度一般，胜在部署简单。
- **Moonshine**：27M 超轻量，为端侧而生；**中文版不是 MIT**，年收入超 100 万美元需商业授权，注意避坑。

---

## 二、一体化工具（直接吃视频文件）

如果你不想碰命令行，这三个都支持直接导入 mp4/mkv 并导出字幕：

| 项目 | 特点 | 许可 |
|---|---|---|
| **Buzz** | 桌面 GUI（Win/macOS/Linux），后端可选 Whisper / whisper.cpp / faster-whisper，支持文件夹监听批量、YouTube 链接、实时麦克风，导出 TXT/SRT/VTT/CSV | MIT |
| **Vibe** | Tauri + whisper.cpp，跨平台，导出 SRT/VTT/TXT/DOCX/PDF/JSON，带说话人分离、yt-dlp、HTTP API，界面最现代 | 开源 |
| **Whishper** | Docker Compose 自托管（5 个容器），faster-whisper + 内置字幕编辑器 + LibreTranslate 翻译，适合挂到内网服务器上给多人用 | 开源 |

---

## 三、怎么选

选型的第一个分岔口是**语种**，第二个是**硬件**。
### 按需求补齐

- **要词级时间戳 / 卡拉OK 式字幕** → WhisperX（英文）或 Qwen3-ASR + Qwen3-ForcedAligner（中文）
- **要"谁说的"** → FunASR（内置说话人分离，零额外配置）或 WhisperX + pyannote
- **要跑在手机/树莓派/浏览器** → sherpa-onnx 或 Vosk
- **要挂到内网给团队用** → Whishper，或 FunASR 的 `funasr-server`（吐 OpenAI 兼容接口，已有 Whisper 的 SDK 可直接复用）
- **要批量处理几百小时存档** → Parakeet-TDT-0.6B-v3（英文）或 SenseVoice-Small（中文）

### 关于那些"准确率数字"，有两个提醒

1. **厂商自测 vs 第三方榜要分开看。** FunASR 的 7.81% vs Whisper 20.02% 是官方在自有中文数据上的自测；Qwen3-ASR 的 WER 也出自官方仓库。这类数字方向可信（中文系确实显著强于 Whisper），但绝对值会随你的素材变化。英文侧的 5.06 / 5.39 / 6.55 来自第三方 Open ASR Leaderboard，可比性强得多。
2. **中文目前没有权威第三方榜。** 建议从你自己的视频里挑 20–30 条（含噪音、口音、专业术语）跑一遍再定，比看任何榜单都准。

### 落地时容易踩的坑

- 音频统一到 **16kHz 单声道**，能省掉大量解码开销。
- **务必开 VAD**（语音活动检测）：既提速，又能显著减少"静音段瞎编词"的幻觉。
- 中文素材**手动指定语言**，不要让模型自动猜，猜错会整段崩。
- 长视频按 VAD 切片处理，别整段塞进去。
- **许可陷阱**：WhisperX 的说话人分离依赖 pyannote，模型需在 HuggingFace 上接受协议并配 token，商用前要看清其条款；Moonshine 中文版非 MIT；Paraformer 权重有独立模型协议；Parakeet / Canary 是 CC-BY-4.0，**部署时必须保留署名**。

---

**给你的直接建议**：如果是中文视频（课程录播、会议、访谈）并且机器上有 NVIDIA 显卡，直接用 **Qwen3-ASR-1.7B**——Apache-2.0 可商用、方言和中英混说表现最好、自带时间戳。没有显卡就用 **SenseVoice-Small**（CPU 上约 17 倍实时，10 分钟音频约 35 秒）。不想碰命令行的话，先装 **Buzz**，把 mp4 拖进去跑通一遍，确认效果后再决定要不要上更重的方案。



# 开源语音识别（ASR）GitHub 仓库清单

> 检索时间：2026-09-24。星标数为检索快照，不同来源略有出入，仅供量级参考。
> 所有 ASR 模型都只接受音频，视频需先用 FFmpeg 抽音轨：`ffmpeg -i in.mp4 -vn -ar 16000 -ac 1 -c:a pcm_s16le out.wav`

---

## 一、Whisper 系（多语种通用，生态最成熟）

| 仓库 | 说明 | 许可 | 星标 |
|---|---|---|---|
| https://github.com/openai/whisper | 官方参考实现，约 99 种语言。慢、占显存，一般只作基线 | MIT | ~108k |
| https://github.com/SYSTRAN/faster-whisper | CTranslate2 重写，同精度快 4–5 倍，支持 int8。**通用首选** | MIT | — |
| https://github.com/m-bain/whisperX | faster-whisper + wav2vec2 词级对齐 + pyannote 说话人分离，直出 srt/vtt/json | BSD-2-Clause | ~23.6k |
| https://github.com/ggml-org/whisper.cpp | 纯 C/C++，零 Python 依赖，CPU / Apple Silicon 最快，`--output-srt` 直出字幕 | MIT | — |

## 二、中文系（中文显著强于 Whisper）

| 仓库 | 说明 | 许可 | 星标 |
|---|---|---|---|
| https://github.com/modelscope/FunASR | 阿里达摩院工具包。VAD + 识别 + 标点 + 说话人 + 情感一站式，含 Paraformer 等 | 工具包 MIT，模型权重另有协议 | — |
| https://github.com/FunAudioLLM/SenseVoice | SenseVoice-Small，中英日韩粤，情感/音频事件识别，CPU 约 17 倍实时 | Apache-2.0 | — |
| https://github.com/FunAudioLLM/Fun-ASR | 通义 Fun-ASR 系列，含轻量版 Fun-ASR-Nano（0.8B） | Apache-2.0 | — |
| https://github.com/QwenLM/Qwen3-ASR | Qwen3-ASR-1.7B / 0.6B，30 语言 + 22 中文方言，流式/离线统一，可出时间戳、识别歌曲 | Apache-2.0 | — |
| https://github.com/FireRedTeam/FireRedASR | 小红书第一代：FireRedASR-LLM（8.3B）/ AED（1.1B） | Apache-2.0 | — |
| https://github.com/FireRedTeam/FireRedASR2S | 小红书第二代全链路系统：ASR + VAD + LID + Punc 四模块，普通话 CER 2.89% | Apache-2.0 | — |

## 三、英文 / 欧洲语言（速度之王）

| 仓库 | 说明 | 许可 | 星标 |
|---|---|---|---|
| https://github.com/NVIDIA-NeMo/Speech | NeMo 框架（2026 年从 `NVIDIA-NeMo/NeMo` 拆出，v3.0.0 起独立）。Parakeet V3 / Canary V2 支持 25 种欧洲语言 | Apache-2.0（框架）；模型权重 CC-BY-4.0，需署名 | ~18k |

常用权重（HuggingFace，非 GitHub）：

- `nvidia/parakeet-tdt-0.6b-v3` — 批量吞吐之王，RTFx 约 6000
- `nvidia/canary-qwen-2.5b` — 英文 WER 5.63%，开源第一梯队
- `nvidia/parakeet-unified-en-0.6b` — 离线 + 流式一体，最低延迟约 160ms

## 四、端侧 / 离线部署

| 仓库 | 说明 | 许可 |
|---|---|---|
| https://github.com/k2-fsa/sherpa-onnx | ONNX Runtime 推理，不装 PyTorch；支持 Paraformer / Whisper / SenseVoice；覆盖 Linux/macOS/Windows/Android/iOS/树莓派/WASM | Apache-2.0 |
| https://github.com/alphacep/vosk-api | 轻量、模型小、语言多，精度一般，胜在部署简单 | Apache-2.0 |
| https://github.com/usefulsensors/moonshine | 27M 超轻量，为端侧实时转写设计。**中文版非 MIT**，商用需注意授权 | MIT（英文）/ 社区许可（中文） |

## 五、配套组件

| 仓库 | 说明 | 注意 |
|---|---|---|
| https://github.com/pyannote/pyannote-audio | 说话人分离。WhisperX 的分离能力就来自它 | 需在 HuggingFace 接受协议并配 token，商用前看清条款 |
| https://github.com/FFmpeg/FFmpeg | 视频抽音轨的必备工具（严格说不属于 ASR，但流水线离不开它） | LGPL/GPL，注意构建选项 |

## 六、一体化应用（视频直接拖进去）

| 仓库 | 说明 | 许可 |
|---|---|---|
| https://github.com/chidiwilliams/Buzz | 桌面 GUI（Win/macOS/Linux），后端可选 Whisper / whisper.cpp / faster-whisper，支持文件夹监听批量、YouTube 链接、实时麦克风，导出 TXT/SRT/VTT/CSV | MIT |
| https://github.com/thewh1teagle/vibe | Tauri + whisper.cpp，跨平台。导出 SRT/VTT/TXT/DOCX/PDF/JSON，带说话人分离、yt-dlp、HTTP API。**已支持 Whisper / Nemotron 3.5 / Parakeet TDT v3 多种模型** | 开源 |
| https://github.com/pluja/whishper | Docker Compose 自托管（5 容器），faster-whisper + 内置字幕编辑器 + LibreTranslate 翻译 | 开源 |

---

## 快速选型

- **中文视频 + 有 NVIDIA 显卡** → Qwen3-ASR-1.7B（`QwenLM/Qwen3-ASR`）
- **中文视频 + 纯 CPU** → SenseVoice-Small（`FunAudioLLM/SenseVoice`）
- **要说话人 / 标点 / 时间戳一站式** → `modelscope/FunASR`
- **中文精度极致追求 + 32GB 显存** → `FireRedTeam/FireRedASR2S`
- **英文/欧洲语言批量** → `NVIDIA-NeMo/Speech` + parakeet-tdt-0.6b-v3
- **语种不可预测** → `SYSTRAN/faster-whisper` large-v3
- **要词级时间戳 + 说话人** → `m-bain/whisperX`
- **不想碰命令行** → `chidiwilliams/Buzz` 或 `thewh1teagle/vibe`
- **塞进客户端 / 嵌入式** → `k2-fsa/sherpa-onnx`

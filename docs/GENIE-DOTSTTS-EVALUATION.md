# 引擎评估：Genie-TTS 与 dots.tts（含本机实测）

> 触发问题：用户希望"对生成的语音情感进行明显操控"，据此评估 Genie-TTS 是否值得把项目里的
> GPT-SoVITS 整体架构迁移过去，并追加 dots.tts 与现有 IndexTTS-2.5 / 网易 Confucius4-TTS 对比。
> 本文所有本机数字均为实测，脚本与音频样本在 `F:\schoolCompWorks\clone\_bench\`（仓库外，未改项目代码）。
> 评估时间：2026-10-08 16:31–17:35 BY Qoder。

---

## 1. 结论先说

| 问题 | 答案 |
| --- | --- |
| Genie-TTS 能操控情感吗 | **不能。** 全仓库对 `emotion / emo_ / 情感 / instruction` 的检索只命中两处 README 注释（"参考音频用于情感和语调克隆"）。它就是 GPT-SoVITS 的 ONNX CPU 推理器 + 权重转换器，情感机制与 GPT-SoVITS 完全相同（只能靠参考音频携带） |
| 该不该把 GPT-SoVITS 整体迁到 Genie | **不该。** 它不带训练（只有推理+转换），会直接废掉 `trainer/` 的 12 阶段训练流水线；API 连 `top_k/top_p/temperature/seed/speed` 都没有；版本只到 V2/V2ProPlus；实测质量与韵律稳定性劣于原版 |
| Genie 有没有可取之处 | 有一条真的：**零显存**（本机 CPU 实测 RTF 0.85、载模型 7.5s、不吃一张卡）。但这条收益可以用更小的动作拿到（见 §6） |
| 真正能给出情感操控的是谁 | **dots.tts**（尤其 `dots.tts.edit`）。本机实测：`<emo type="cheerful">` 让基频从 106 → 223 Hz，中文标签 `type="开心"` 同样生效，`<rate factor="1.3">` 实测语速倍率 1.32（误差 <2%），且局部编辑只改目标句、非目标句能量基本保持 |
| 但我们其实已经有情感数值控制 | 是。IndexTTS-2.5 的 8 维情感向量早已接入（阶段 26），本机实测同句换向量：flat F0 117 → 惊喜 315 / 哀 161，语速 3.71 → 5.85 字·s⁻¹。**缺的不是"生成时定情绪"，而是"对已有音频后期改情绪"**——这才是 dots.tts.edit 的独占价值 |

一句话建议：**不要迁移 GPT-SoVITS 架构；Genie 否掉；dots.tts 作为第三个本地引擎按 §6 试点接入，定位是"情感/韵律后期编辑"，不是主力合成。**

---

## 2. 实测环境与协议

| 项 | 值 |
| --- | --- |
| 机器 | RTX 4060 Laptop 8188 MiB / i7 24 线程 / Windows / F 盘余 643 GB |
| 网关 | `127.0.0.1:8787` 在跑；三引擎服务经 `POST /api/<engine>/service {"enabled":bool}` 托管启停（测后已恢复原状态：GPT-SoVITS/网易 关，IndexTTS 开且模型已卸载） |
| 参考音色 | 音色库 `842e1988abc8`（男，zh，5.44s）+ 用 IndexTTS 生成的 喜/怒/哀 三段做"情感参考" |
| 统一目标句 | 「今天的会议改到下午三点，请各位准时到场，不要迟到。」（22 字） |
| 性能协议 | 6 句固定文本（短句/长句/多音字/数词/段落），暖机 1 次不计，逐句记 RTF；整卡显存用 `nvidia-smi` 0.25s 采样取峰值 |
| 情感指标 | 帧级自相关取中位基频 F0、字·秒⁻¹ 语速、90 分位帧能量；阈值按文件自身能量自适应（第一版用绝对阈值，把"轻声音但有效"的合成误判成静音，已修正） |
| 关键教训 | 参考音频必须配**它自己的**转写。第一轮 flat 用错文本（拿 IndexTTS 句子配音色库原声），GPT-SoVITS 输出 23s 近静音——那是我的协议错，不是引擎缺陷，已重测 |

---

## 3. 性能实测对比

| 引擎 | 载模型/暖机 | RTF（本机均值） | 整卡显存峰值 | 输出采样率 | 显存归属 |
| --- | --- | --- | --- | --- | --- |
| GPT-SoVITS v2ProPlus（GPU，现状） | 暖机 22.2s | **0.46** | 4563 MB | 32 kHz | 现有 arbiter 管 |
| IndexTTS-2.5（GPU） | 暖机 64.9s | 1.354 | 7562 MB | 22.05 kHz | 同上 |
| 网易 Confucius4-TTS（GPU） | 暖机 68.9s | 1.605 | 7752 MB | 22.05 kHz | 同上 |
| **Genie-TTS ONNX（CPU）** | 载模型 **7.5s** | 0.851 | **0 MB** | 32 kHz | 不占 |
| **dots.tts SOAR q8（audio.cpp / CUDA）** | 载模型 ~10s | 0.918 | **7742 MB**（进程净占约 6.3 GB） | **48 kHz** | 需纳入 arbiter |

要点：

1. **GPT-SoVITS 在本机依然是最快的**（RTF 0.46）。Genie 的 CPU 化并没有带来速度收益，只是把负载从 GPU 搬到 CPU（0.85 vs 0.46，慢约 1.8 倍）。官方 README 的"1.13s 首帧延迟"是日语 20 字短句的**首次**延迟，不含稳态吞吐，不能当 RTF 读。
2. 但 Genie 的**冷启动 7.5s** 完胜现状三套的 22–69s 暖机，而且**完全绕开显存准入**（本项目最痛的坑 24/26 都是显存准入）。它的真实定位是"显存被占满时的备援合成"，不是"更快的引擎"。
3. dots.tts 输出 48 kHz（其余 22–32 kHz），音质上限更高；代价是它比 IndexTTS 还要吃显存（约 6.3 GB），在 8.6 GB 卡上必然与网易/IndexTTS 争卡，**只能排队不能共存**。
4. dots.tts 的官方 RTF 0.15–0.21 是 H800 数据；本机拿到 0.918，仍在"接近实时"一侧，可接受。

---

## 4. 情感能力实测

### 4.1 靠参考音频携带情感（五引擎同协议）

| 引擎 | flat | 喜 | 怒 | 哀 | 情感跨度 |
| --- | --- | --- | --- | --- | --- |
| GPT-SoVITS | F0 112.5 / 3.89 | 283.2 / 4.42 | 320.0 / 4.72 | 150.2 / 2.23 | ΔF0 207.5 Hz，Δ语速 2.49 |
| 网易 Confucius | 105.5 / 4.71 | 267.3 / 5.08 | 290.1 / 5.92 | 165.8 / 5.59 | ΔF0 184.6，Δ语速 1.21 |
| IndexTTS-2.5 | 124.6 / 4.32 | 253.4 / 4.86 | 315.0 / 5.85 | 160.4 / 3.99 | ΔF0 190.4，Δ语速 1.86 |
| Genie-TTS | 113.1 / 4.22 | 273.5 / 4.92 | 323.2 / 6.44 | 162.9 / 2.45 | ΔF0 210.1，**Δ语速 3.99** |
| dots.tts SOAR | 105.8 / 4.73 | 274.3 / 5.21 | 314.8 / 5.58 | 151.9 / 3.12 | ΔF0 209.0，Δ语速 2.46 |

（单位：F0 = Hz，第二个数 = 字·s⁻¹；同一目标句）

- 五套都能"克隆参考的情感"，差异在**稳定性**而不是有无。
- **Genie 的语速跨度最大（Δ3.99，哀 10.2s / 怒 3.88s）**，与 issue #31 社区实测反馈吻合："在小样本与情绪起伏大的角色身上更明显，情绪很容易乱飘"。这正是我们**不想要**的那种"情感明显"——它是不稳定的副产品。
- 网易把哀句压到 4.47s（Δ语速仅 1.21），情感携带最弱但最稳。

### 4.2 数值/指令化情感控制（关键差异）

| 能力 | 载体 | 本机实测证据 |
| --- | --- | --- |
| 生成时情感向量 | **IndexTTS-2.5（已接入，阶段 26）** | 同句换向量：flat F0 117 → 喜 275.6 / 怒 302.1 / 惊喜 315.0 / 惧 237.1 / 哀 160.9 / 平静 155.8；语速 flat 3.71 → 怒 5.01、哀 2.56。**单调、可复现、已在生产 UI 里** |
| 参考音频情感迁移 | 五套皆可 | 见 §4.1 |
| **对已有音频改情感** | **dots.tts.edit（项目当前没有）** | `<emo type="cheerful" level="2">` F0 106→222.8、能量 0.048→0.396；`type="angry" level="3"` F0→250.0；**中文标签 `type="开心"` / `"悲伤"` 同样生效**（F0 238.3 / 152.4，悲伤语速降到 3.40） |
| 数值韵律编辑 | dots.tts.edit | `<rate factor="1.3">` 实测 6.25 vs 基线 4.73 字·s⁻¹ = **×1.32**；`<pitch semitones="5">` F0 106→120.6（+13%，要求 +33%，属部分跟随） |
| 局部性与保持 | dots.tts.edit | 只给后半句加 `<emo type="angry">`：目标句 F0 106→331、能量 0.050→0.426；非目标句能量 0.0375→0.0414（基本保持） |
| 换 seed 抽韵律 | dots.tts | 官方建议用法；本机 seed 1 vs 7 能量 0.069→0.043（有变化，弱于情感标签） |

**重要边界（别被 README 骗）**：情感标签**不能**用在普通生成里。本机实测 `template_name=tts` 内联 `<emo>` 与 `template_name=instruction_tts` 的自然语言指令都**无效**——开心 vs 悲伤两组 F0 分别是 109.8/108.6 与 109.1/112.1，等于没动。情感控制只存在于 **Edit 检查点 + 结构化指令**这条路径上，因此落地形态必须是**两段式**：先生成（SOAR/MF），再改情感（Edit）。

---

## 5. Genie-TTS 逐项技术评估

| 维度 | 评价 | 证据 |
| --- | --- | --- |
| 模型架构 | 不是新模型，是 **GPT-SoVITS 的 ONNX 静态图重导出**（T2S encoder/decoder + VITS + V2ProPlus prompt encoder 分离），纯 CPU `CPUExecutionProvider` | `src/genie_tts/ModelManager.py:189`、`Core/Inference.py:63 t2s_cpu` |
| 性能 | CPU RTF 0.85（本机）、载模型 7.5s、运行时 ~200MB、零显存；比原版 GPU 慢 1.8 倍 | 本文 §3 |
| 功能完整性 | **明显缺失**：无训练、无批量、无参数控制。公开 API 只有 `tts(character_name, text, play, split_sentence, save_path)`；FastAPI 只有 6 个 POST（`/load_character` `/tts` `/stop` …），**连 `/health` 都没有** | `Internal.py:265`、`Server.py:49-155` |
| 与本项目接口契合度 | 差。现有网关透传的是 `/v1/tts` 全家桶（17 个合成参数 + 流式 + 批量 + 训练 + 音色 CRUD + 引擎注册表）。Genie 只能覆盖其中 1 项，其余要么重写要么砍掉 | `trainer/app/models.py:146-169`、`catalog.py:392-410` |
| 并发与状态 | 有真实缺陷：`Utils/Shared.py` 用**全局单槽** `current_prompt_audio` / `current_speaker`，多角色并发合成会互相踩参考音 | `Utils/Shared.py`、`Internal.py:186` |
| 兼容性 | 只 V2 / V2ProPlus；v3/v4 仍未完成；版本靠 `.pth` **体积 >150MB 猜**——我们整合包的 `s2Gv2Pro.pth` 是 155 MB，会被误判成 V2ProPlus 走错转换器 | `Converter/Converter.py:7`、`v2Pro/` 目录实测 |
| 安装/维护成本 | 高。`jieba_fast` 在 PyPI 上**从未发过 wheel**（15 个文件全是 sdist）→ Windows `pip install genie-tts` 直接失败（需 MSVC）；Python 3.13 连 `tokenizers` 都编不过。我最终是靠"定向装依赖 + 手写 jieba_fast 垫片"才跑起来。另外 `import genie_tts` 在缺 GenieData 时会**同步 `input()` 阻塞**，并在 GBK 控制台直接 `UnicodeEncodeError` 崩在导入期 | 本机安装日志；`Core/Resources.py:68`；PyPI 元数据核对 |
| 社区活跃度 | 单人项目（作者 96 commits，第二名 4），最后提交 2026-08-30，1794 stars / 36 open issues，最新 release 停在 2025-12-12（整合包 1.8 GB） | GitHub API |
| 质量风险 | issue #31 附音频对比：中文出现异常停顿、拖长音、多音字读错（缺 G2PW），维护者确认；#15 里用户报告"生成质量上下限差异很大" | issues #31 / #15 |
| 唯一的真收益 | 零显存备援 + 7.5s 冷启动 + 可复用我们已训练的 v2ProPlus 权重（本机转换实测成功，产出 320 MB ONNX，识别为 `Model Type: V2ProPlus`） | `_bench/onnx_model/` |

### 迁移判定

**必要性：不成立。** 迁移动机（情感操控）Genie 一件都没实现；性能上它比现状慢；功能上它砍掉训练与参数控制。

**风险：高。** 一旦替换，`trainer/` 的 12 阶段训练、UVR5、RVC/SVC/ASR 全部失去依托（它们与 GPT-SoVITS 共用同一套 runtime 与引擎注册表）；音色库虽已独立存储（阶段 26补7），但批量合成/训练页直连 `/api/sovits/v1/*`，不受 provider 抽象保护。

**如果只想要"零显存备援"**：不要换架构，加一个**可选第四服务**（`genie/` 目录 + 网关透传 + arbiter 里登记为 CPU 引擎），只覆盖 `/v1/tts` 的 preset 模式，20 行网关代码即可；训练/批量/变声照旧走 GPU。成本可控，收益独立。

---

## 6. dots.tts 评估与落地路径

**是什么**：2B 连续 AR（Qwen2.5-1.5B 文本 backbone + DiT flow-matching head + 冻结 48 kHz AudioVAE/BigVGAN + CAM++ x-vector 说话人条件），Apache-2.0，今天仍在提交（v0.3.1，1376 stars）。Seed-TTS-Eval 开源最好（zh WER 0.94 / SIM 81.0，24 语种平均 SIM 83.9 第一），EmergentTTS-Eval 情感项开源最佳 72.7%。带论文、doteBench（2081 条中英情感/韵律编辑用例）、SGLang Omni 服务化方案。

**两条接入形态的实测差别**：

| 形态 | 结论 |
| --- | --- |
| 官方 Python（`pip install dots.tts`） | **本机不建议**。要求 py3.10–3.12 + torch 2.8/CUDA 12.8、bf16 峰值 5.3–7.9 GB、`torch.compile` 冷启动约 3 分钟；我们整合包 runtime 是 py3.9 + torch 2.0 + cu118，必须另建 venv（可照 `netease/` 模式，但显存画像比网易更差） |
| **audio.cpp GGUF（本机实测采用）** | **可行**。纯 C++/ggml，无 Python 依赖，Windows 官方包 + CUDA 12.4 后端，SOAR/MF/Edit 三个 q8_0 GGUF 各 2.76 GB；实测载模型 ~10s、RTF 0.918、48 kHz 输出。缺点：q8 显存净占约 6.3 GB，8.6 GB 卡上必须进 arbiter 排队 |

**建议实施路径（试点，不动现有引擎）**：

1. **阶段 A（1 天，只读验证）**：用 `audiocpp_server.exe` 起一个本地服务（端口 9884），网关加 `/api/dots/*` 透传，`RuntimeSupervisor` 登记生命周期 + `arbiter`/`preload` 账本加一档（显存代价按实测 ~6.3 GB 记，比网易高）。验收：一次生成 + 一次 `<emo>` 编辑端到端通。
2. **阶段 B（1–2 天）**：前端新页「情感后期编辑」——上传/选取已有成品（音色库、批量结果、IndexTTS 产物皆可）→ 选情感类型（含中文名）+ level + 作用范围（整句/局部）→ 出对比试听（原 vs 编辑后，非目标句保持）。这一步直接命中用户的原始诉求。
3. **阶段 C（可选）**：把 `<rate>` / `<pitch>` / `<pause/>` 做成数值滑杆；`--seed` 抽卡做成"换一版韵律"按钮。
4. **不做**：不让 dots.tts 取代主力合成（显存与耗时都不划算），不在本项目里做它的微调/蒸馏（训练成本与 8 GB 卡不匹配）。

**风险登记**：

- 显存：q8 净占 ~6.3 GB，与 IndexTTS(5.3)/网易(4.9) 互斥且更吃紧；本机 Windows 桌面常驻约 1.4–5 GB，真跑需人工腾显存（沿用坑 24/26 的教训，准入必须"已加载就跳过"）。
- 两段式工作流要**同时**考虑两个 2.76 GB 检查点的加载切换成本（Edit 与 SOAR 不能同进程常驻）。
- 情感标签只在 Edit 生效，UI 必须避免用户在生成页放标签（实测无效，会造成"以为坏了"的误报）。
- `<pitch>` 只部分跟随（要求 +5 半音 ≈ +33% F0，实测 +13%），数值承诺要保守。
- 许可与合规：Apache-2.0 可商用；但零样本克隆的滥用水准很高，官方明确提示需加提示与水印——与我们既有的"不考虑商用"裁决并存，记录备查。

---

## 7. 复现清单（全部在仓库外）

| 脚本 | 作用 |
| --- | --- |
| `_bench/bench_existing.py <sovits\|indextts\|netease>` | 三引擎统一 RTF/暖机/显存峰值基准 |
| `_bench/bench_emo2.py <engine>` | 同句换参考音频的情感迁移探针（带自适应响度指标） |
| `_bench/bench_genie.py` / `bench_genie_emotion.py` | Genie CPU 基准与情感迁移（需 `_bench/genie-venv` + 手写 `jieba_fast.py` 垫片 + `GENIE_DATA_DIR`） |
| `_bench/convert_genie_model`（一次性命令见本节末尾） | 权重转 ONNX 实测 |
| `_bench/bench_dots.py` | audio.cpp 单会话 16 请求：性能 + 情感迁移 + 标签/指令/seed 控制 |
| `_bench/bench_dots_edit.py` | Edit 检查点的 `<emo>/<pitch>/<rate>` 控制矩阵 |
| `_bench/analyse_preservation.py` / `aggregate_results.py` | 局部保持性与跨引擎汇总表 |

```bash
# Genie 权重转换（本机实测成功，识别为 V2ProPlus）
GENIE_DATA_DIR=F:/schoolCompWorks/clone/_bench/GenieData PYTHONUTF8=1 \
  _bench/genie-venv/Scripts/python.exe -c "import genie_tts as g; g.convert_to_onnx(
    torch_ckpt_path=r'...GPT-SoVITS-v2pro-20250604/GPT_SoVITS/pretrained_models/s1v3.ckpt',
    torch_pth_path=r'...pretrained_models/v2Pro/s2Gv2ProPlus.pth',
    output_dir=r'F:\schoolCompWorks\clone\_bench\onnx_model')"

# dots.tts 生成（48kHz / RTF 0.92）
audiocpp_cli --task tts --family dots_tts --model dots-tts-soar-q8_0.gguf --backend cuda \
  --text "…" --voice-ref ref2/flat.wav --reference-text "…" --out out.wav --metrics

# dots.tts 情感编辑（中文标签可用）
audiocpp_cli --task tts --family dots_tts --model dots-tts-edit-q8_0.gguf --backend cuda \
  --text '<emo type="开心" level="2">今天的会议改到下午三点。</emo>' \
  --request-option source_audio=… --request-option template_name=edit --out edited.wav
```

试听样本：`_bench/out/{sovits,netease,indextts}_emo2/`、`_bench/out/genie_emo2/`、
`_bench/out/dots_emo2/`、`_bench/out/dots_edit/`、`_bench/out/indextts_emotion/`（8 维向量对照）。

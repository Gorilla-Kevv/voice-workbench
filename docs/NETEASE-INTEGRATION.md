# 网易模块整合方案：Confucius4-TTS + Confucius4-R2T2

目标：在**不替换、不改动任何现有链路**（MiMo 云端 / GPT-SoVITS 本地 / RVC / DDSP-SVC / FunASR·Whisper）的前提下，
接入网易有道 Confucius4 双模型，并在前端新增一个独立的「网易模块」，内含 TTS 与 ASR 两个功能入口。

结论先行：

> **可行，且延续 `MODERN-TTS-FEASIBILITY.md` 已论证的形态：引入第二个 Python 运行时。**
> 两个上游都要求 Python ≥ 3.10（TTS 要求 3.10 + CUDA 12.6；R2T2 上游实测 3.12），
> 现有 `trainer/` 的 py3.9 + torch 2.0.0+cu118 无法承载，塞进去会直接摧毁四条既有链路。
> 新运行时独立目录 `netease/`、独立端口 **9882**、**默认不启动**（opt-in），现有用户的启动体验一个字节不变。

本机环境已核实：RTX 4060 Laptop **8188 MiB**，驱动 572.61（**CUDA 12.8**）——满足 TTS 的 CUDA ≥ 12.6 要求。
8 GB 显存跑一个 1.3B LLM 形态的 TTS 是够的（fp16 约 4~6 GB），但**两个引擎不能同时常驻**，
`netease` 服务内部做引擎互斥（与 `trainer/app/engine.py` 同一套语义）。

---

## 1. 对比：网易工具 vs 现有工具

### 1.1 TTS：Confucius4-TTS vs GPT-SoVITS（本地）/ MiMo（云端）

数据来源为官方 GitHub README 与 HF 模型页（2026-09）。

| 维度 | **Confucius4-TTS**（网易，新增） | GPT-SoVITS v2ProPlus（现有本地） | MiMo（现有云端） |
| --- | --- | --- | --- |
| 协议 | **Apache-2.0（代码 + 权重，允许商用）** | MIT（代码）+ 各底模自有协议 | 商用 API，按量计费 |
| 架构 | 语音编码器 + LLM 两阶段（T2S + S2A），1.3B | GPT + SoVITS + VQ | 未公开 |
| 部署 | 本地，权重实测 TTS 侧 5.4 GB（+R2T2 4.1 GB），py3.10~3.12 + CUDA ≥ 12.6 | 本地整合包（py3.9） | 云端，零部署 |
| 语种 | **14 种**（中英日韩德法西印尼意泰葡俄马来越），**跨语种无口音** | 中 / 英 / 日 / 韩 / 粤 | 中（含 4 方言）/ 英 |
| 克隆 | **3 秒参考音频，免参考文本**，带情感迁移 | 3~10 s 参考音频 + **逐字转写文本**（必需） | 上传样本 ≤10 MB，云端克隆 |
| 推理生态 | 官方自带 FastAPI server / vLLM 加速 / Gradio | 本项目已深度整合（常驻管线 + 热切换） | 商用稳定 |
| 训练生态 | 官方微调脚本（T2S + S2A 分开训），**远不如 GPT-SoVITS 完整** | 12 阶段全流程已落地 | 不开放 |
| 速度（本机实测 2026-09，RTX 4060 Laptop 8 GB / fp16） | **稳态 RTF ≈ 2.0~2.5**（2.6 s 音频 6.3 s、4.1 s 音频 8.0 s；首条含预热要几分钟）；常驻 + 峰值显存约 4.9 GB | 本机最快（RTF ~0.028） | 快（云端） |

**互补关系（这是接入的价值，不是性能）：**

- **免参考文本克隆**是它独有的能力。现有音色库的每条音色都要逐字转写；网易只需音频。
  这意味着现有音色库的参考音频可以**直接喂给网易模块**，把「导入音色」的摩擦降到零；
- **14 语种 + 跨语种无口音**补掉了两个空白：MiMo 官方只开中英（README 明说日语韩语暂未开放），
  GPT-SoVITS 只有五语。德法西泰等语种第一次有了本地方案；
- **情感迁移**：参考音频的情绪可以带到合成结果里，现有两套模型都没有显式支持。

**劣势 / 风险（必须如实写）：**

- 独立 venv + CUDA 版 torch 2.7（约 2.6 GB）是主要安装成本，权重本身 TTS 侧只有 5.4 GB；
- 微调生态不成熟，**它不能替代 GPT-SoVITS 的训练链**，只能作为推理侧的补充音源；
- 8 GB 卡上推理速度预期慢于 GPT-SoVITS；流式合成仅 vLLM 后端可用（本方案首版不含流式，见 §6）。

### 1.2 ASR：Confucius4-R2T2 vs FunASR / faster-whisper（现有双通道）

| 维度 | **Confucius4-R2T2**（网易，新增） | FunASR（现有 resident） | faster-whisper（现有 resident / script） |
| --- | --- | --- | --- |
| 基座 | **Qwen3-ASR** + LSP 稳定前缀学习 | Paraformer 系 | Whisper |
| 真流式 | **✅ append-only（不改已输出文本）**，解码块 80ms~2s，延迟 200~600 ms | Paraformer 流式可用 | 伪流式（滑窗，会改写前文） |
| 精度 | 官方口径：流式 ≈ 离线，开源 SOTA；CV3-Eval 跨语种 WER 3.73%（TTS 论文口径） | 中英可用 | 多语种可用 |
| 权重协议 | 代码 Apache-2.0，**权重是网易自有许可（HF 页标注，商用需自行确认）** | Apache-2.0 | MIT |
| 部署 | py3.12 + **vLLM（CUDA 硬要求）**，LLM 形态较重 | 轻量，常驻秒级 | 轻量 |
| 输出 | 流式/离线一致，词元级时间戳 | 文本 + 时间戳 | 文本 + 段级时间戳 |

**互补关系：** 现有 ASR 的定位是「转写打底稿 + 造训练数据集」，FunASR/Whisper 离线通道已够用；
R2T2 的价值在**真流式**（append-only 不回头改字）——这是打字幕、实时听写场景的刚需，
现有两条通道都给不了。它同时是本机第一个能「边放边出字」的引擎。

**风险：** vLLM 后端对 CUDA/驱动挑剔、首次部署要额外下载 VAD 模型（若走官方 WS 服务器，本方案不依赖它）；
权重协议与 TTS 不同，商用前需单独确认。

### 1.3 共存策略

| 场景 | 用谁 | 理由 |
| --- | --- | --- |
| 日常中文合成、批量出音频 | GPT-SoVITS（现状不变） | 最快、训练链成熟 |
| 不想部署任何东西 / 音色设计 | MiMo（现状不变） | 云端零成本 |
| 德法西泰俄等小语种、跨语种、免转写克隆、情感迁移 | **网易 TTS（新）** | 能力补全 |
| 字幕 / 实时听写 / 对延迟敏感的转写 | **网易 ASR（新）** | 真流式 |
| 离线批量转写造数据集 | 现有 ASR（不变） | 轻量、已整合训练入口 |

---

## 2. 目标架构

```
浏览器 (5173)
   │
   ▼
Node 网关 (8787)
   ├── /api/tts ──────▶ MiMo 云端                     （不动）
   ├── /api/sovits/* ─▶ trainer  (9881) py3.9        （不动）
   └── /api/netease/* ▶ netease  (9882) py3.10+      （新增，第二个运行时）
                          ├─ Confucius4-TTS  进程内 import confuciustts
                          └─ Confucius4-R2T2 子进程 worker（vLLM 要求 main 环境）
```

### 2.1 关键设计决定

| 决定 | 理由 |
| --- | --- |
| 独立目录 `netease/`，与 `trainer/` 平级，**不改 trainer 一行代码** | 上游解释器/torch 要求互斥；「现有功能不变」是硬要求 |
| **不用官方 `server.py`（TTS）直接对外**，而是在自建 FastAPI 里 `import confuciustts` | 要统一响应契约（`ok/error.hint`）、能力清单、引擎互斥与「未安装」态；官方 server 只有裸 `/api/tts`，错误结构对不上 |
| R2T2 走**子进程 worker**（stdin/stdout JSON 行协议）而不是进程内 import | vLLM 引擎要求在 `__main__` 环境启动（上游 README 明确警告 spawn 问题）；worker 自成主进程，天然规避，还能独立配置解释器（`NETEASE_R2T2_PYTHON`，应对 TTS/R2T2 依赖冲突时分 venv 部署） |
| 引擎互斥做在 netease 进程内；**跨进程显存协调（对 trainer）本期不做** | 8 GB 卡上同时常驻 GPT-SoVITS + 1.3B LLM 本就不现实；先靠「启动前检查空闲显存 + 明确报错」兜底，跨运行时仲裁等 mtts 方案一起做（见 §6） |
| 网关代理**无状态转发**，不为 netease 做 supervisor | netease 是 opt-in 模块，生命周期归 `npm run dev:netease`（concurrently 之外）；探活失败给出可读 503 即可 |
| 权重下载走 HF 官方仓 + `HF_ENDPOINT` 镜像 | 不自建镜像、不硬编码模型源；TTS 官方支持首次运行自动下载 |

### 2.2 与「小米 MiMo 模块」的对照（UI/架构参考点）

| MiMo 模块的做法 | 网易模块的对应 |
| --- | --- |
| 侧栏独立分组「MiMo 云端」+ 三个页面 | 侧栏独立分组「网易模块」+ 两个页面（TTS / ASR） |
| Provider 抽象（`lib/providers/`） | **不进 Provider 抽象**：网易走本地服务直连客户端（`lib/netease.ts`），与 `asr.ts` / `vc.ts` 同一模式——它是本地引擎，不是云端 BYOK 服务，没有密钥态，塞进 Provider 抽象反而要为它特化 `requiresKey/capabilities` |
| `KeyGate` 密钥门禁 | 不需要（本地模块，进 `LOCAL_PAGES` 白名单） |
| 页面头部模型徽标 | `PAGE_META` + header model 文案 |
| 错误契约 `message + hint` | 完全一致（服务端就按这个契约返回） |

---

## 3. netease 服务 API 路由设计（:9882）

沿用全局约定：成功 `{ ok: true, ... }`；失败 `{ ok: false, error: { code, message, retryable, hint } }`。
`hint` 是给使用者的下一步动作，前端必须展示。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 服务体检：python/torch/device/显存 + 两个引擎的安装状态与缺失项 |
| GET | `/v1/netease/catalog` | 能力清单：TTS 语种表 / ASR 参数档位 / 权重就位状态（前端据此渲染与降级提示） |
| POST | `/v1/netease/engines/acquire` | 申请显存（`engine: "tts" \| "asr"`，`wait_seconds`） |
| POST | `/v1/netease/engines/release` | 释放显存 |
| GET | `/v1/confucius/pipeline` | TTS 引擎状态：是否已加载 / device / 已加载时长 |
| POST | `/v1/confucius/warmup` | 预加载模型（首次约 30~90 s） |
| POST | `/v1/confucius/unload` | 卸载模型归还显存 |
| POST | `/v1/confucius/tts` | **合成**。multipart：`text`、`lang`、参考音频（`file` 上传，或 `ref_path` 服务端路径）；返回 JSON（`audio_base64` + `sample_rate` + `duration_sec`） |
| GET | `/v1/r2t2/pipeline` | ASR 引擎状态 |
| POST | `/v1/r2t2/warmup` | 预加载（vLLM 起引擎较慢，worker 常驻） |
| POST | `/v1/r2t2/unload` | 停掉 worker 归还显存 |
| POST | `/v1/r2t2/transcribe` | **转写**。multipart：`file`（或 `ref_path`）、`language`（auto/Chinese/English/…）、`return_timestamps`；`stream=true` 时 NDJSON 增量返回（append-only 真流式，走 R2T2 `streaming_transcribe` 分块喂入） |

语种约定：TTS 的 `lang` 是**合成目标语种**（14 选 1，默认 `zh`）；参考音频语种无关紧要（跨语种是卖点）。
ASR 的 `language` 允许 `auto`。

### 3.1 引擎互斥与显存准入

- 进程内同一时刻只允许 `tts` / `asr` 一个引擎持显存；申请时若被占，等满 `wait_seconds` 后报
  `ENGINE_BUSY`，hint「到对应页面卸载，或调小模型档位」——与 trainer 的锁语义一致；
- 加载前检查 `torch.cuda.mem_get_info`，空闲不足报 `VRAM_INSUFFICIENT`，
  hint「关闭 GPT-SoVITS 服务或卸载网易另一引擎」（跨进程协调留待 mtts 阶段统一做）;
- **不静默落 CPU**：CPU 上 1.3B LLM 的 RTF 是几十倍，给了等于不可用，如实拒绝并提示。

---

## 4. 网关路由设计（:8787）

| 变更 | 内容 |
| --- | --- |
| `server/src/config/index.ts` | 新增 `netease` 段：`NETEASE_URL`（默认 `http://127.0.0.1:9882`）、`NETEASE_PROXY_TIMEOUT_MS`（0=不限） |
| `server/src/routes/netease.ts` | 透明反代（复制 `sovits.ts` 骨架，去掉 supervisor 依赖）：JSON / multipart / NDJSON 原样透传；上游不可达时返回结构化 503（含「如何启动」的 hint） |
| `server/src/index.ts` | `app.use('/api/netease', neteaseProxyRouter)` 挂在 `express.json()` **之前**（沿用已踩过的坑：multipart/流式不能被 body-parser 消费） |
| `server/src/routes/index.ts` | `/api/health` 的 `providers` 增加 `netease` 摘要（reachable 状态） |

前端探活约定（与现有三态语义对齐）：

- 网关 `/api/netease/health` 通 → `ready`（模型没装时服务自己返回 `installed=false` → 前端显示 `incomplete`）；
- 网关 503（netease 没启动）→ `offline`，但文案是「未启动（可选模块）」而不是故障语气。

---

## 5. 前端界面调整落地步骤

| 步骤 | 文件 | 内容 |
| --- | --- | --- |
| 1 | `app/src/types/netease.ts` | 契约类型（catalog / health / tts 请求响应 / transcribe 结果 / 流式事件），与 `netease/app/models.py` 一一对应 |
| 2 | `app/src/lib/netease.ts` | 客户端：默认同源 `/api/netease`，`localRequest` 同款超时与错误透传；流式转写用 NDJSON 逐行解析 |
| 3 | `app/src/pages/NeteaseTtsPage.tsx` | 合成页：文本框 + 14 语种下拉 + 参考音频三来源（**上传文件 / 从现有音色库选择**（经 `/api/sovits` 取列表并下载音频，免转写直接用）/ 服务端路径）+ 合成按钮 + 播放/下载 |
| 4 | `app/src/pages/NeteaseAsrPage.tsx` | 转写页：音频上传 + 语种 + 「快速转写 / 流式转写」两种模式，流式模式下逐块出字并区分「已固定 / 预测中」 |
| 5 | `app/src/types/index.ts` | `NavKey` 增加 `netease-tts` / `netease-asr`；`ModuleStates` 增加网易两态 |
| 6 | `app/src/App.tsx` | `PAGE_META` 两页标题、`LOCAL_PAGES` 白名单、header model 文案、独立的 netease 探活轮询（节奏复用 sovits 的 3s/30s/60s 策略） |
| 7 | `app/src/components/layout/AppShell.tsx` | 新导航分组「网易模块」（TTS / ASR 两项）+ 侧栏状态卡（四态文案） |

**两个页面的刻意取舍（首版不做，登记在 §6）：** 不接入统一历史记录（历史表结构绑定 MiMo 的
`SynthesisResult` 分段模型）；不做麦克风实时流式（浏览器 WebSocket → 网关 → 上游全链路改造，
收益依赖真实场景验证）；不做网易训练/微调界面（上游脚本形态与 GPT-SoVITS 完全不同）。

---

## 6. 迁移路径（本次执行 0~5，6+ 留待后续）

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| 0 | 环境核实（GPU/驱动 CUDA 12.8 ✓，磁盘 ✓） | ✅ 已完成 |
| 1 | `netease/` 服务骨架：server.py + app（config/errors/models/engine/api）+ TTS/ASR 适配器 + r2t2 worker；**无权重也能启动**，如实报告缺失项 | ✅ 本次交付 |
| 2 | 网关 `/api/netease` 透传 + health 汇总 | ✅ 本次交付 |
| 3 | 前端两页 + 导航 + 探活 | ✅ 本次交付 |
| 4 | 工程化：`npm run dev:netease` / `netease:check` / `scripts/preflight_netease.py` / README（venv 与权重下载指南） | ✅ 本次交付 |
| 5 | 校验：typecheck / eslint / build / Python 语法 / 网关服务不带权重启动冒烟 | ✅ 本次交付 |
| 6 | TTS 端到端实测（下载权重 → warmup → 单条合成 → RTF 与显存实测，已回填本文档 §1） | ✅ 2026-09 完成（RTF 2.0~2.5 / 4.9 GB；**ASR 侧在 Windows 上被 vLLM 卡住**，见 §7 风险） |
| 7 | 流式 TTS（vLLM 后端）+ 麦克风实时 ASR + 统一历史记录接入 | ⬜ 后续 |
| 8 | 跨运行时显存仲裁（与 trainer `/v1/engines` 对接，方案 B） | ⬜ 后续 |

### 阶段 6 的环境准备（用户操作，见 `netease/README.md`）

```bash
# 1) 建 venv（py3.10 满足 TTS；R2T2 上游实测 3.12，若依赖解析冲突则给 worker 单独配解释器）
python -m venv netease/.venv
# 2) 安装 torch（cu126 及以上）与两个上游包 + 服务依赖，然后：
npm run netease:check          # 预检脚本，逐项报告缺什么
npm run dev:netease            # 启动 netease 服务（默认不随 npm run dev 启动）
```

权重下载（一条命令，脚本按上游实际取用方式分流到 HF 缓存 / 本地目录）：

```bash
npm run netease:weights                                   # TTS 侧约 5.4 GB
npm run netease:weights -- --include-r2t2                 # 连 R2T2 一起下
npm run netease:weights -- --proxy http://127.0.0.1:7890  # HF 走本机代理（国内常用）
```

⚠️ 不能用 `huggingface-cli download --local-dir` 代替：T2S / S2A 权重是
`confuciustts/cli/inference.py` 里硬编码 `hf_hub_download(repo_id, filename)` 取的，
**只认 HF 缓存**，落到 `netease/models/Confucius4-TTS/` 它照样会重新下载。

---

## 7. 风险登记

| 风险 | 概率 | 影响 | 处置 |
| --- | --- | --- | --- |
| 8 GB 显存不够 TTS（fp16 估 4~6 GB，压线） | 中 | TTS 不可用 | warmup 时实测并如实报 `VRAM_INSUFFICIENT`；阶段 6 回填实测值后再定是否需要量化/换卡 |
| R2T2 的 vLLM 与 TTS 的依赖在同一 venv 冲突 | 中 | 双引擎难共存 | worker 支持独立解释器 `NETEASE_R2T2_PYTHON`，两个 venv 各管各的 |
| 上游 API 快速迭代（两仓都是新发布） | 中 | 升级即崩 | 接入面集中在 `netease/app/tts_engine.py` / `r2t2_worker.py` 两个薄文件，漂移时只改这两处 |
| TTS 免转写克隆的音色与音色库「同名音色」混淆 | 低 | 认知混乱 | 网易页面的音色库选择器明确标注「仅借用参考音频，逐字文本不参与合成」 |
| 磁盘不足（5.4 GB 权重 + 2.6 GB torch + venv） | 低 | 装不完 | preflight 检查剩余空间并在 README 标注预算（约 20 GB） |
| **Windows 上 R2T2 装不了**（vLLM 无 Windows 发行包） | 高（Windows） | ASR 引擎不可用 | README 明确标注；Windows 用 `--allow-missing-asr` 只跑 TTS，R2T2 需 WSL2 / Docker |
| R2T2 权重许可限制商用 | 低 | 法务风险 | 对比文档已显著标注，商用前单独确认 |

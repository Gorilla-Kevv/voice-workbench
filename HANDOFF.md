# HANDOFF

> 交付文档。供新会话接手使用，遵循 `token-efficient-agent-workflow` 规范：只记结论、决策与坑，不复述历史。
> 代码仓库是唯一真实的上下文来源，本文件只是索引。

## 项目

- **路径**：`F:\schoolCompWorks\clone\ttstool`
- **名称**：本地语音工作台（voice-workbench）
- **定位**：**纯本地部署**。线上旧版本在独立仓库维护，本仓库不涉及任何线上部署配置。

### 技术栈

| 层 | 技术 |
| --- | --- |
| 前端 `app/` | React 19 + TypeScript + Vite 7 + Tailwind CSS 3 + shadcn/ui（Radix） |
| 网关 `server/` | Node 18 + Express 4 + TypeScript（tsx 运行） |
| 模型服务 `trainer/` | Python 3.9（整合包自带 `runtime/python.exe`）+ FastAPI + Uvicorn |
| 网易模块 `netease/` | **主服务**：本机 py3.12 独立 venv + torch 2.7.0+cu126 + FastAPI；端口 9882，`npm run dev` 自动拉起 |
| GPT-SoVITS | **辅助服务**（训练链 + 批量合成仍靠它）：Python 3.9 整合包 + FastAPI；端口 9881 |
| IndexTTS `indextts/` | 第四个运行时之一：独立 venv + FastAPI；端口 9883 |
| Irodori-TTS `irodori/` | **日语特化**（阶段 30 接入中：30-1 环境 + 30-2 推理链路已完成）：独立 venv（**py3.12 + torch 2.10.0+cu128**）+ FastAPI；端口 9884 |
| 模型 | GPT-SoVITS v2ProPlus（本地 GPU）、MiMo（云端 API）、Confucius4-TTS / R2T2（本地，需自行下载权重）、Irodori v4.1-Small（日语，int4 推理档 + bf16 训练基座） |

### 运行环境路径（新会话直接照抄，别重新找）

| 运行时 | 解释器 / 入口 |
| --- | --- |
| GPT-SoVITS | `GPT-SoVITS-v2pro-20250604/runtime/python.exe`（整合包自带） |
| 网易 | `netease/.venv/Scripts/python.exe`（**必须用它**，整合包 python 缺 `confuciustts`） |
| IndexTTS | `indextts/.venv/`（`scripts/indextts.mjs` 会自己找） |
| **Irodori** | `irodori/.venv/Scripts/python.exe`；权重在 `irodori/models/`、上游代码在 `irodori/upstream/`（都在 gitignore 里）；清单 `irodori/weights.manifest.json` **进版本库** |
| uv（建 venv 用） | `C:\Users\kevin\.local\bin\uv`；⚠️ **缓存默认在 `D:\AI_Cache\uv`，沙箱里写不进去** → 先 `export UV_CACHE_DIR=<工作区内>` |

### 分支

- 当前：`feature/vc-svc`（origin 已同步）
- 主分支：`main`
- 远程：`https://github.com/Gorilla-Kevv/voice-workbench.git`

## 目标

### 已达成

1. GPT-SoVITS 官方能力移植：推理、训练、批量合成、音色库、权重管理
2. 保留并打通 MiMo 云端链路，两套模型通过 Provider 抽象共存
3. 训练流水线对齐官方 WebUI（12 阶段），含 UVR5 人声分离、切分、ASR、格式化、GPT/SoVITS 训练
4. 全站术语提示系统（100 条术语 + 右侧官方流程指引）
5. 新增板块：ASR 语音转文本、语音变声(RVC)、歌声转换(DDSP-SVC)（由并行工作产出）
6. 网易模块（Confucius4-TTS / R2T2）：第二个 Python 运行时 `netease/` + 前端「网易模块」两个页面，
   与现有链路完全共存（对比与方案见 `docs/NETEASE-INTEGRATION.md`）

### 非目标

- 不做线上部署（Docker / 云托管 / GitHub Pages 均已移除）
- 不改动官方整合包 `GPT-SoVITS-v2pro-20250604/` 下任何一行代码
- 不为不支持的能力做「静默降级」（宁可报清晰的错误）

## 结构

### 关键目录

| 目录 | 职责 |
| --- | --- |
| `app/src/pages/` | 14 个页面：通用合成、批量合成、音色设计、声音克隆、音色库、历史、训练、语音变声、歌声转换、语音转文本、网易合成、网易转写、**IndexTTS 合成**、设置 |
| `app/src/lib/providers/` | Provider 抽象：`mimo`（云端）、`gpt-sovits`（本地）、`selfhosted`（自定义） |
| `app/src/lib/voices.ts` | 音色库客户端（`/api/voicelib/*`，网关托管、跨模型通用；含浏览器端音频时长探测） |
| `app/src/lib/netease.ts` | 网易模块客户端（`/api/netease/*`，含 NDJSON 流式转写解析） |
| `app/src/lib/sovits.ts` | 本地服务客户端（含 NDJSON 流式解析、音频地址映射） |
| `app/src/lib/glossary.ts` | 术语表（100 条），含 `term/definition/impact/example` |
| `app/src/lib/flowGuide.ts` | 官方推荐流程（8 步，固化官方原话与数值） |
| `app/src/components/features/` | `TermTip`（术语提示）、`FlowGuide`（流程指引）、`ResultPanel`、`ErrorBoundary` 等 |
| `server/src/routes/sovits.ts` | 反向代理（必须挂在 `express.json()` **之前**，否则 multipart / 流式透传失效） |
| `server/src/routes/netease.ts` | 网易模块透明反代（同上挂载顺序；**无 supervisor**，opt-in 不拉起） |
| `server/src/services/sovits.ts` | 托管 Python 服务：探活、解释器探测、日志环形缓冲 |
| `trainer/app/sovits/` | 与官方代码的直连层：`bootstrap`（定位+sys.path）、`catalog`（能力清单，唯一常量源）、`pipeline`（**跨进程代理**）、`synth`（请求翻译 + 异常归一）、`voices`（音色库） |
| `trainer/app/sovits/worker/` | **官方管线 worker 子进程**（见 `docs/ENGINE-ISOLATION.md`）：`protocol`（行协议+stdout 隔离）、`server`（请求循环 + interrupt 读线程）、`client`（主进程侧拉起/心跳/退避重启）、`__main__`（按文件路径启动的入口） |
| `trainer/app/` | `training.py`（12 阶段编排）、`batch.py`、`inference.py`、`annotations.py`（清单读写）、`jobs.py`、`queue.py` |
| `trainer/tools/uvr_cli.py` | UVR5 非交互封装（调官方 `vr.py`/`mdxnet.py`，不改官方代码） |
| `netease/` | **第二个 Python 运行时**（py≥3.10）：`server.py`、`app/tts_engine.py`（Confucius4-TTS 直连）、`app/r2t2.py` + `app/r2t2_worker.py`（R2T2 子进程 worker，vLLM 需 main 环境）、`app/engine.py`（引擎互斥）。上游 API 漂移只改 `tts_engine.py` / `r2t2_worker.py` 两个薄文件 |
| `indextts/` | **第三个 Python 运行时**（uv 环境在 `upstream/.venv`，py3.11 + torch 2.8 cu128）：`server.py`、`app/{config,hardware,errors,indextts_engine,api}.py`。上游 `upstream/` 是 `git clone --depth 1` 的官方仓库（不改一行），权重在 `upstream/checkpoints/`（5.11 GB，ModelScope 下载）。端点：`/health`、`/v1/catalog`、`/v1/pipeline|warmup|unload`、`/v1/synth`（multipart：text/lang/file 或 ref_path/duration_factor/emo_vector/emo_file/emo_alpha）。上游 API 漂移只改 `indextts_engine.py` 一个薄文件 |
| `irodori/` | **第四个 Python 运行时**（venv 在 `irodori/.venv`，py3.12 + torch 2.10 cu128）：`server.py`、`app/{config,hardware,errors,inventory,windecode,api,engine,catalog,synth}.py`。`engine.py` 懒加载（上游 `get_cached_runtime` 单实例缓存）+ 显存准入（已加载跳过）+ 合成互斥；`catalog.py` 的 emoji 表**从上游源码 ast 解析**（不 import torch/gradio）；`synth.py` 收口日语校验 / 服务端切句 ≤25 字/段 / 参考三形态互斥。上游 `upstream/{Irodori-TTS,dacvae}/` 只读（tarball 来源锁定）；权重 `models/`、清单 `weights.manifest.json` 进版本库。端点：`/health`、`/v1/catalog|warmup|unload|synth|speakers`。上游 API 漂移只改 `engine.py`（RuntimeKey/SamplingRequest 映射）一个薄文件 |
| `voicelib/` | **音色库共享存储**（仓库根，不进版本库）：`voices.json` + `voices/<id>.<ext>`。网关（`server/src/services/voiceLibrary.ts`）与 trainer（`app/sovits/voices.py`）读写同一份，位置由 `VOICES_LIB_DIR` 统一覆盖。曾住 `trainer/.data/`，阶段 26补7 迁出（旧索引改名 `.migrated-to-voicelib` 保留） |

### 入口文件

- 前端：`app/src/main.tsx` → `App.tsx`
- 网关：`server/src/index.ts`
- 模型服务：`trainer/server.py`（**会自动判断解释器有无 torch，没有就用整合包的 `runtime/python.exe` 重新执行自己**）
- 网易服务：`netease/server.py`（**不自举解释器**——解释器不对就直接报错，见 `netease/README.md`）
- 一键启动：根目录 `start.bat`（网易服务不进 start.bat，opt-in：`npm run dev:netease`）

### 核心接口

- 后端统一响应：成功 `{ ok: true, ... }`；失败 `{ ok: false, error: { code, message, retryable, hint } }`
- `hint` 是给**使用者**的下一步动作，前端必须展示而不只是展示 `message`
- 主要端点：`/health`、`/v1/catalog`、`/v1/uvr/models`、`/v1/weights`、`/v1/voices`、`/v1/tts`、`/v1/tts/stream`、`/v1/tts/batch`、`/v1/train`、`/v1/train/plan`、`/v1/annotations/{job_id}`、`/v1/jobs`
- 网易服务端点（经网关 `/api/netease/*` 透传）：`/health`、`/v1/netease/catalog`、
  `/v1/netease/engines/{acquire,release}`、`/v1/confucius/{pipeline,warmup,unload,tts}`、`/v1/r2t2/*`
  —— `/health` **永远 200**，「服务活着」与「模型可用」是两件事（后者在 `engines.*.installed` 里）
- IndexTTS 端点（经网关 `/api/indextts/*` 透传）：`/health`（同 netease 哲学，永远 200）、
  `/v1/catalog`（语种/滑杆范围/情感维度/**准入门槛**——门槛真源在服务端，坑 19）、
  `/v1/pipeline`、`/v1/warmup`、`/v1/unload`、`/v1/synth`（multipart，返回 base64 音频）
- Irodori 端点（经网关 `/api/irodori/*` 透传，阶段 30-2）：`/health`（永远 200；`loaded` 现在接引擎真值）、
  `/v1/catalog`（emoji 56 个 × 官方释义、caption 预设、步数档 `[20,40]` 默认 20、仅 `ja`、
  `max_ref_seconds=120` —— **前端不要自己抄一份**）、`/v1/warmup`（`?blocking=false` 后台加载；
  **已加载直接返回不拦**）、`/v1/unload`（回报 `freed_mb`）、`/v1/speakers`、
  `/v1/synth`（JSON body：`text/caption/num_steps/schedule/seed/duration_scale` +
  参考三选一 `ref_voice`（音色库 id）/`ref_path`/`speaker_id`（互斥）；返回 base64 PCM_16 WAV）。
  错误码：`NO_JA_ONLY` / `REF_REQUIRED` / `REF_CONFLICT` / `REF_TOO_SHORT` / `VOICE_NOT_FOUND` /
  `TEXT_TOO_LONG` / `VRAM_INSUFFICIENT`(503) / `ENGINE_BUSY`(409) / `ENGINE_LOAD_FAILED`(503)
- 音色库端点（网关原生 `/api/voicelib/*`，阶段 26补7，**不依赖任何 Python 服务**）：
  `GET /`、`GET /:id`、`GET /:id/audio`、`POST /`（原始字节体 + 查询参数元数据）、`POST /source`、
  `PATCH /:id`、`POST /:id/audio`、`DELETE /:id`；trainer 的 `/v1/voices*` 保留且读写同一份数据（坑 27）
- GPU 进程端点（`/api/resources/gpu-processes`，阶段 26补9）：GET 列进程（pid + 显存读数，WDDM 拿不到为 null）；
  `POST /gpu-processes/kill {pid}` **手动停止**——护栏：pid 须在强刷后的 nvidia-smi 快照里、
  系统关键进程名单与网关自身一律拒绝；界面入口是 ResourceBudget 的「显存监控」小窗（右键行 → 停止）

### 数据模型

- 前端契约：`app/src/types/sovits.ts`（与后端 `trainer/app/models.py` 一一对应）
- 网易契约：`app/src/types/netease.ts`（与后端 `netease/app/models.py` 一一对应，**改一边必改另一边**）
- IndexTTS 契约：`app/src/types/indextts.ts`（与后端 `indextts/app/api.py` 返回一一对应，同上规矩）
- **结果列表底座**：`app/src/hooks/useResultStack.ts` + `app/src/components/features/ResultStack.tsx`
  —— 所有模块的结果栏都走这两个；别在某个页面再自造单值结果 state（见坑 18）
- **文件/文件夹拖拽底座**：`app/src/hooks/useFileDrop.ts`
  —— 全站 13 处上传点都展开它的 `rootProps`（含 `accept` 过滤、`input.files` 回填、目录递归）；
  新增上传入口请复用它，别再手写一遍 dragover/drop（见坑 25）
- **资源预估底座**：`app/src/lib/resources.ts` + `app/src/components/features/ResourceBudget.tsx`
  —— 显存门槛**只从服务端取**（trainer `/v1/engines`、`netease /health`），前端只留兜底常量；
  内存由网关 `/api/health` 的 `host` 提供（见坑 19）
- 持久化：
  - 音色库：仓库根 `voicelib/`（网关与 trainer 共享，跨模型通用，见坑 27）
  - 服务端：`trainer/.data/`（outputs、jobs、experiments、uploads）
  - 浏览器：`localStorage`（设置）+ `sessionStorage`（训练/批量会话）+ IndexedDB（历史）

## 决策与坑

### 已做决策（含原因）

| 决策 | 原因 |
| --- | --- |
| **本地引擎选型（阶段 27–28）：GPT-SoVITS 不迁 Genie-TTS；dots.tts 试点已作废；日语走 Irodori** | 阶段 27 源码核查 + 本机实测双重否掉 Genie：它没有任何情感参数（与 GSV 同靠参考音频），无训练、无 `top_k/temperature/seed/speed`、只支持 V2/V2ProPlus，实测 CPU RTF 0.85 反而慢于 GPU 的 0.46；它唯一真实收益是**零显存 + 7.5s 冷启动**，属于「备援第四服务」范畴而非架构替换。dots.tts 的 `<emo>` 编辑实测有效（F0 106→222.8、`<rate>` 精度 ±2%）但需两段式 + q8 净占 ~6.3GB，**用户 10.08 裁决"Genie-TTS 与 dots.tts 弃用，不考虑了"**。接力评估的 Irodori-TTS（阶段 28）在"情感明显操控"这条诉求上实测最强且最快（emoji/caption 有量化差异、int4 6 步 RTF 0.121），代价是仅日语 + 男声 emoji 失效 + Windows 依赖链（坑 33） |
| 模型管线**常驻内存**，不每次 subprocess 调 CLI | 官方 `inference_cli.py` 每次重加载 4 个模型（约 1 分钟），本地试听不可用 |
| Python 服务生命周期交给**启动编排器**（concurrently），不由网关托管 | 网关在 dev 下被 `tsx watch` 重启，若托管 Python 会连带重启（改一行代码等 40 秒重加载） |
| 网关代理用 `node:http` + `pipe` 而非 `fetch` | 音频上传（multipart）与流式（NDJSON）需要原始字节流，pipe 天然支持 |
| 官方能力清单只写一处：`trainer/app/sovits/catalog.py` | 版本/语种/预训练权重映射散落各处会导致升级时漏改 |
| 错误响应必须带 `hint` | 只报 `message` 用户无从下手（实测：用户对着「不支持合成语种 undefined」完全懵） |
| 渲染错误用错误边界兜底 | React 渲染抛错会卸载整棵树 → 纯白页面，无信息 |
| 术语提示：桌面悬浮 / 触屏点击 | Radix Tooltip 在触摸设备体验不可靠（悬浮不存在） |
| 资源站入口：顶栏常驻「资源库」**下拉面板**（26补7 常驻 → 26补9 面板化） | https://res.acgnai.top/ 等调研结果收进 `lib/resourceHub.ts`（五分类 20 条，已核实/未核实标记）；点开是滚动展开栏，音色库页右侧 1/3 内嵌同一份数据。旧版散落三处页内的形态已废。外部链接一律新窗口 + `noopener noreferrer` |
| 音色库导航独立成组（阶段 26补9） | 「音色库 · 跨模型共享 → 音色库管理」不再挂在 GPT-SoVITS 组下（存储早已跨模型，挂在下面继续误导）；GPT-SoVITS 组的训练入口改名「音色微调训练」保留——**改名区分，不是删入口** |
| **音色库独立于 GPT-SoVITS：共享存储 `voicelib/` + 网关托管接口**（阶段 26补7） | 音色库曾住在 trainer :9881 里，而 GPT-SoVITS 默认停用 —— IndexTTS / 网易页选一段参考音频竟要把整个 GPT-SoVITS 拉起来。现在数据在仓库根 `voicelib/`，常驻的网关直接供 `/api/voicelib`；trainer 同读一份，合成/批量按 voice_id 解析不受影响。时长/采样率改由浏览器探测（Node 无 soundfile），迁移由网关首访触发（旧索引改名保留） |
| 网易合成默认档位 **balanced**（非官方默认） | 官方默认 `num_beams=3` 会让 T2S 自回归跑三条候选（约 3 倍代价），是本机「慢」的主因之一；`balanced=(1,18)` 明显更快。档位定义在 `netease/app/routers/confucius.py::QUALITY_PRESETS`，要回官方默认选 `quality` |
| **第二套本地 TTS（IndexTTS-2.5）定位为「补充」** | 0.8B / BF16 / 官方 RTF 0.2065（4090 数据），**阶段 26 本机实测：暖态 RTF ≈ 2.2，显存被抢时 5~14；常驻实测约 5.3 GB（远超 2~3 GB 估计）**。独有价值是**情感向量 / 拼音注音 / 语速倍率**这类精细可控。但它只有 5 语种，跨语种弱于网易 → 不抢主服务位置。已全链路接入（服务 + 网关透传 + 前端页 + 资源管控，`docs/INDEX-TTS-INTEGRATION.md` 阶段 0~2 完成） |
| **主力模型不由我们预设**，交给「启动预加载选择」 | 用户 2026-10 裁决：网易 vs IndexTTS 谁当主力由**使用测试**决定。所以不做硬编码默认，改为开机时让用户选一个模型预加载（显存一次只够一个）。实现见 `server/src/services/preload.ts` + `StartupPreloadDialog`；新增模型只需往 `MODELS` 账本加一项 |
| 预加载顺序 **先让位 → 再检查 → 最后加载** | 反过来会因为另一套还占着显存导致检查必然失败，还会误导用户以为卡太小。这个顺序写在 `preload.ts` 的注释里 |
| 网易模块**不进 Provider 抽象**、独立成 `netease/` 运行时 | 上游要求 py≥3.10 + torch≥2.5 + cu≥12.6，与 trainer 的 py3.9/torch2.0 互斥（`MODERN-TTS-FEASIBILITY.md` 已论证）；它是本地引擎不是云端 BYOK，塞进 Provider 抽象反而要特化密钥态 |
| R2T2 走**子进程 worker**（stdin/stdout JSON 行协议） | vLLM 引擎要求 `__main__` 环境启动（上游 README 明确警告）；worker 自成主进程规避，还能用 `NETEASE_R2T2_PYTHON` 独立解释器解决依赖冲突 |
| **官方 GPT-SoVITS 管线移入独立 worker 进程**（2026-11，方案 B） | 官方 `AR/modules/activation.py` 在 **import 期**执行 `F.multi_head_attention_forward = <patch>`，改的是 torch 模块级单例 —— **整理 sys.path、摘 sys.modules 都救不了**，只能靠进程边界。踩到的坑是 RVC 变声报 `NameError: _in_projection`（补丁函数漏了这个名字，而 fairseq `MultiheadAttention` 恰好走那条分支）。顺带把 `bootstrap.install()` 的永久 `os.chdir` 也关了进去。**对外契约零变化**：`pipeline.py` 变同签名代理，`api.py`/`inference.py` 调用点一行未改；`/health` 只追加 `worker_alive`/`worker_error`/`worker_pid` 三个字段。完整设计与 139 项验证见 `docs/ENGINE-ISOLATION.md` |
| `bootstrap.install()` 加 `chdir=False` 默认参数，**`sys.path` 注入仍在主进程** | `os.chdir` 是会话级的、会改变主进程的相对路径语义，必须搬走；但 `sys.path` 得留 —— UVR5 / ASR 的脚本通道要 `from tools.uvr5.vr import ...`。只有 `worker/server.py::main()` 传 `chdir=True` |
| worker **按文件路径**启动，不用 `-m app.sovits.worker` | 整合包解释器是 embedded distribution（`runtime/python39._pth`），**完全忽略 `PYTHONPATH`** 且不给 `-m` 提供 `sys.path[0]` —— 用 `-m` 会以「No module named 'app'」死在我们的代码之前。按路径启动时 Python 会把该文件所在目录放进 `sys.path`，项目根由 `__main__.py` 自己补 |
| worker **懒启动**（第一次进入推理才拉） | 服务启动时不拉起，免得拖慢 `/health` 探活与前端首屏；`--warmup` 可提前摊掉首载的 24 s |
| **IPC 超时必须长于业务锁等待上限** | 同步路 330 s（> `SYNC_LOCK_WAIT_S=300`），否则 worker 健康地排队时会被主进程误判成超时。流式不设总超时，改逐块软超时（首块 120 s / 之后每块 30 s，出块即续期） |
| worker 崩溃**不自动重载模型**，只退避重启 | 冷启动 30~90 s + 2~4 GB 显存，自动重载会把「worker 反复崩」放大成「服务器反复 OOM」。退避 1/2/4/8/16/32/60 s，连续失败 5 次停止自动重启 |
| 退避窗口内的重试**等待**而不是立刻 503 | 「崩溃后马上重试」是最正常的行为；退避的目的是防 OOM 放大，不是拒绝对外服务。上限 10 s，超过才报错 |
| 网易两引擎**进程内互斥**，跨进程显存协调暂不做 | 8 GB 卡同时常驻 GPT-SoVITS + 1.3B LLM 本就不现实；先靠加载前空闲显存检查 + 明确报错兜底 |
| ~~网易模块 opt-in~~ **已改为主服务**（2026-10） | 免转写克隆 + 14 语种是日常合成的最优路径；`npm run dev` 现在会拉起它，网关仍**无 supervisor**（只转发不托管生命周期） |
| `dev:netease` 走 `--skip-if-missing` | 主服务也要照顾「没装权重」的机器：没 `netease/.venv` 或端口已被占用时安静跳过，不再崩掉一个 dev 窗格 |
| 网易不可用时**明确报错 + 给切换入口**，不自动回落 | 沿用现网哲学：不静默降级。页面给出「改用 GPT-SoVITS 批量合成」按钮，用户自己决定 |
| **跨运行时资源仲裁**：网关做仲裁器，只作用于自有服务 | trainer / netease / indextts 的引擎互斥互相看不见（跨进程）。仲裁器（`server/src/services/arbiter.ts`）在开跑前卸载**其余所有端**的常驻模型，并带心跳复检。**硬边界**：只向 `SOVITS_URL` / `NETEASE_URL` / `INDEXTTS_URL` 三个回环地址发请求（非回环直接拒绝），不扫描进程、不 kill PID —— 用户要求的「绝不触及系统外进程」落在代码里。**例外（阶段 26补9）**：显存监控小窗的 `POST /gpu-processes/kill` 可以杀外部进程，但只杀**用户亲眼选中**的 pid（快照核对 + 系统关键进程拒绝），与仲裁器的自动行为无关 |
| **GPT-SoVITS 默认停用**，生命周期交给网关按需拉起（2026-10） | 8 GB 显存装不下两套常驻模型；报错里让用户「先关掉 GPT-SoVITS」却没有入口可以关，等于给了个做不到的建议。`npm run dev` 不再拉起它，用户在设置里开；代价是 `tsx watch` 重启网关时子进程一起回收（开关是开的会自动再拉起） |
| TTS 默认 **fp16**，且只转三个大户（T2S / S2A / w2v-bert） | 上游全 fp32 约 7.5 GB，8 GB 卡必 OOM；BigVGAN / CAMPPlus 只占 0.45 GB / 几十 MB，留 fp32 反而避开两处 dtype 冲突（见坑 15） |
| 上游推理配置**不直接用**，复制成绝对路径副本再交给上游 | `inference_config.yaml` 里 `tokenizer_path` / `w2v_stat` 是相对路径、按 CWD 解析；服务从项目根启动就会找不到 |
| 权重下载**自己写脚本**，不用 `huggingface-cli download --local-dir` | 上游只认 HF 缓存（坑 13），且需要按实测速度在 ModelScope / 代理 / 直连之间选路（坑 14） |
| **Irodori 推理链路的三条小决策（阶段 30-2）** | ① **校验顺序 = 请求校验 → 显存准入 → 互斥**：改了请求就能修好的错（路径写错/非日语）不该被显存状态挡住；② **catalog 常量从上游源码 ast 解析**（emoji 全集在 `duration.py`、官方释义在 `gradio_emoji_palette.py`），不 import torch/gradio，上游升级自动跟随；③ **并发合成一律 409 拒绝而非排队**：8GB 卡排队第二条也是显存抖动，让调用方自己串行 |

### 已知坑（重要，改代码前先看）

1. **`start.bat` 必须存成 GBK / ANSI，且不能 `chcp 65001`**
   cmd 解析 bat 时会按字节 seek（`goto` / `call` / `for /f` 都会触发），UTF-8 多字节中文会让偏移算错，表现为某些行被从中间截断执行（`call :check_port` 变成 `eck_port`、`echo` 前缀被吃掉）。转码方式见 `.gitignore` 同目录说明，编辑后务必保持 ANSI。

2. **PowerShell 的 `$HOME`、`$PID` 是只读自动变量**
   用作变量名会直接报错。本项目脚本里已改用 `$SovitsHome`、`$targetPid`。

3. **`AudioPreDeEcho._path_audio_` 的 `vocal` / `ins` 参数顺序与 `AudioPre` 相反**
   官方源码注释「3个VR模型vocal和ins是反的」。`uvr_cli.py` 一律用**关键字参数**调用来规避。

4. **`tools/uvr5/vr.py` 用相对导入**（`from lib.lib_v5 import ...`）
   必须把 `tools/uvr5` 放进 `sys.path` 才能 import。

5. **Python 3.9 限制**
   - Pydantic 模型里不能写 `X | None`，必须 `Optional[X]`
   - `asyncio.Queue` 在 **构造时绑定事件循环** → 必须在 FastAPI lifespan 内创建，服务启动前建好会永远停在 `queued`

6. **前端弹窗重复触发的根因**
   `useSynthesis` 返回展开字面量（每次渲染新对象），而「已等待 N 秒」计时器每秒 setState → 依赖整个 controller 的 effect 每秒重跑 → toast 每秒弹一次。**依赖必须写成具体的 `controller.error`**。

7. **模型版本大小写**
   前端 model id 是小写（`gpt-sovits-v2proplus`），服务端版本名是混合大小写（`v2ProPlus`）。直接把后缀当版本名会报「未知模型版本」。现已双向处理：前端 `fields.version` 优先 + 大小写不敏感匹配，服务端 `catalog.resolve_version()` 归一化。

8. **`FormData.append(name, undefined)` 会写入字符串 `"undefined"`**
   音色库的 `prompt_lang` 曾因此入库成脏数据，导致每次合成都报「不支持合成语种 undefined」。写入端与读取端现在都做归一化（`normalize_prompt_lang`），历史脏数据会在服务启动时自动纠正并落盘。

9. **BS-RoFormer 在本机不可用**
   整合包里有权重但缺同名 `.yaml`，被模型扫描标为 `available=false`。官方推荐它是人声分离首选，本机只能先用 HP2 / HP5。

10. **`tools/denoise-model/` 是空目录**
    现有「语音降噪」阶段依赖的 FRCRN 模型不在本地（会尝试联网下载）。UVR5 的 DeEcho / ONNX 去混响模型在本地，可替代。

11. **训练顺序与官方建议相反**
    ~~我们是 `s1(GPT) → s2(SoVITS)`~~ **已修复（阶段 6）**：现为 `s2 → s1`（官方顺序）。
    「训完 SoVITS 重新提取语义 Token」评估过、不需要 —— `3-get-semantic.py` 用官方底模
    （`pretrained_s2G`）提取语义 Token，GPT 训练不依赖 SoVITS 微调产物。详见 `training.py` 模块注释。

12. **R2T2 的可用性要分两层说（2026-10 修正，之前判错了）**
    原结论「Windows 装不了 vLLM → R2T2 整个不可用」**过重**，实际是：
    - `pyproject.toml:67-69` 默认依赖 `qwen-asr[vllm]`（所以官方两条路都是 Linux：
      `INFER_MODE` 只有 `stream_vllm/onetime_vllm`；Docker 用 `qwenllm/qwen3-asr`）；
      但 **extra 可拆** —— 装 `qwen-asr==0.0.6`（纯 Python wheel，`py3-none-any`，Windows 可装，
      已验证下载）就走 transformers 后端；
    - `r2t2/r2t2_asr.py:23` `from qwen_asr.inference.qwen3_asr import Qwen3ASRModel`，
      `:189` `class R2T2ASRModel(Qwen3ASRModel)` —— **继承**，transformers 后端天然可用；
    - 但 `:267/352/527/621/802` 有 **5 处** `if self.backend != "vllm": raise ValueError(...)`
      → **流式被代码写死成 vLLM-only**。
    所以：**离线转写 Windows 原生可行**（我们没接，是判死刑导致的损失）；
    **流式转写 Windows 原生不可能**，只能 WSL2 / Docker。
    8 GB 卡上跑这条路径的已知代价（他人实测）：显存槛 ~5.5/6.5 GB、`SEGMENT_LENGTH=240` 外层切块、
    `MAX_INFERENCE_BATCH_SIZE=1`（默认 32 会爆 KV cache）、首 token 慢（torch 分配池未预热，
    预热一条空音频可规避）。
    官方 README 写明 `_, text = asr.streaming_transcribe(seg, state, max_new_tokens=4)`
    —— **增量文本在返回值的第二个元素**，不是从 `state` 读；定稿是 `finish_streaming_transcribe(state)`
    之后读 `state.text`。`r2t2_worker.py` 已按此改（`_coerce_text()` + `_state_text()` 兜底）。
    ⚠️ 仍未实测：**Windows 没有 vLLM 发行包**，本机这条链路要 WSL2 / Docker 才能跑。

13. **Confucius4-TTS 的权重只能走 HF 缓存**
    `confuciustts/cli/inference.py` 里 T2S / S2A 是硬编码 `hf_hub_download(repo_id, filename)`、
    CAMPPlus 同理，本地 `netease/models/Confucius4-TTS/` 放得再全也没用 —— 它照样会重新下载。
    所以权重探测查的是 **HF 缓存**（`_hf_cached()`），下载脚本会把文件按 `blobs/` + `snapshots/` +
    `refs/` 铺进去并用真实 etag 命名。改这条之前先看 `netease/README.md`「权重落在哪」。

14. **`hf-mirror` 与本版 huggingface_hub 不兼容**
    上游把 huggingface_hub 钉在 0.36.2，它对 `hf-mirror` 的 HEAD 请求拿到 **308 Permanent Redirect**
    （`requests.head` 默认不跟随），表现为 `LocalEntryNotFoundError`。
    实测链路速度：ModelScope 6~11 MB/s > 本机代理 2 MB/s > 直连 0.2 MB/s（还会撞 Xet CDN 的 SSL 错）。
    `scripts/download_netease_weights.py` 按这个顺序自动选路，`--proxy` 可指定代理。

15. **fp16 不能只调 `.half()`**
    上游不指定 dtype 全 fp32（约 7.5 GB，8 GB 卡必 OOM），但它有五处**硬编码 fp32 输入**
    会立刻让半精度模型炸（`RuntimeError: expected scalar type Float but found Half` =
    半精度模块收到 fp32 输入）：w2v 的 `input_features`、semantic_mean/std、参考 mel、
    CAMPPlus 风格向量，以及 `DummyPositionEmbedding.forward` 里写死的 `dtype=torch.float32`
    （它替换了 GPT2 的 wpe，zeros 一加就把整条序列抬回 fp32）。
    `tts_engine._enable_fp16()` 只转三个大户（T2S / S2A / w2v-bert），BigVGAN 与 CAMPPlus 留 fp32，
    再用薄包装把这几处边界对齐。改动前先读那段注释。

16. **写盘前必须把音频压成 float32**
    fp16 精度下上游返回的可能是 float16 数组，`soundfile` 不认 float16，会报
    `Format not recognised`。`tts_engine.generate()` 里统一 `np.asarray(..., dtype=np.float32)`。

17. **Windows 下 `torch.cuda.mem_get_info` 看不见别的进程占的显存（已修）**
    实测同一时刻：**torch 报 7099 MB 空闲，nvidia-smi 只报 2238 MB**（三次采样稳定，差 4.9 GB）。
    WDDM 下 cudaMemGetInfo 是「本进程的虚拟视图」，浏览器 / 模拟器 / GPT-SoVITS 占的全都不算进去。
    **后果**：准入检查形同虚设 —— nvidia-smi 只剩 2.6 GB 时空闲检查照样放行，模型靠抖动真加载起来了，
    然后第一条合成跑了 **378 秒**（正常 RTF 2.0~2.5，那条 RTF 49）。
    **已修**：`netease/app/hardware.py` 的 `vram_mb()` 改用 nvidia-smi 的 `memory.free`，
    torch 的读数保留在 `torch_free_mb` 做对照；两者差 >1 GB 时，报错文案直接说
    「有 N MB 被**其它进程**占用」。nvidia-smi 不可用时退回 torch。
    **trainer 侧已同步改**（2026-10 拍板）：`trainer/app/runtime.py::free_vram_mb()`
    同样改为 nvidia-smi 优先 → 退回 torch，并新增 `vram_free_mb_torch` 对照字段
    （引擎准入 / 队列准入 / `/health` 都随之变准）。实测：改前报 7099 MB，
    改后报 2550 MB ≈ nvidia-smi 的 2544 MB。
    ⚠️ 副作用：门槛数值（训练 6144 等）原本按乐观口径定，现在判定**更严格** ——
    这符合 trainer 自己的哲学（宁可多等，也不让任务跑到一半 OOM），但行为确实变了。

18. **结果不能再用单值 state 存，统一走 `useResultStack`**
    旧写法是「一个页面一个 `result` state，新的来了直接覆盖」，而且 `useSynthesis` 还会
    **顺手把上一条的 Blob 地址 revoke 掉**，连历史记录都救不回来。现在所有结果栏都走
    `useResultStack`（push/remove/clear，默认 12 条），只在**淘汰或用户显式删除**时才释放资源。
    三个容易踩的点：
    - `App.tsx` 按导航键**条件渲染页面**，切走就卸载 → 结果必须落在模块级缓存或 sessionStorage，
      不能只活在组件里（hook 已经处理，别绕过它自己写 state）；
    - Blob / ObjectURL 类结果**不能**配 `serialize`（刷新后地址必然失效）；
    - 预览用的 Blob 地址（例如变声页的源音频）会被下次选文件回收，入栈时要**另开一个快照地址**。

19. **资源预估的门槛值必须在服务端，前端只留兜底常量**
    各引擎的显存门槛是 `trainer` 引擎注册表里的数据（训练 6144 / UVR5 4096 / SoVITS 3072 …），
    网易 TTS 的门槛在 `netease/app/tts_engine.py::REQUIRED_VRAM_MB`。前端若另写一份，
    改了后端不改前端就会给出**错误的预估**，比不给预估更糟。
    `app/src/lib/resources.ts` 的顺序是：服务端值 → 兜底常量（注释里标了来源与实测依据）。
    内存例外：三个进程同机，**只有网关看得到全貌**，所以由网关 `/api/health` 的 `host` 提供。

20. **`express.json()` 挂载顺序现在管三条代理**
    `/api/sovits`、`/api/netease` 与 `/api/indextts` 都挂在 `express.json()` 之前（index.ts 内有注释）。新增代理路由时
    再犯「multipart/NDJSON 被 body-parser 消费」的老错，症状是上传与流式全部 400/空体。

21. **音色库的 `audio_path` 是服务端磁盘路径，不能当 URL 用**
    `resolveAudioUrl(voice.audio_path)` 会拼出 `/api/sovits/F:/…/xxx.mp3` → 404。
    可访问的地址只有试听那条：`/v1/voices/{id}/audio`（音色库页与网易合成页现都走它）。
    **同一处还有第二个坑**：`catch (e) { if (e instanceof RequestError) ... }` 会把
    fetch 层的普通 Error 静默吞掉，表现为「按钮闪一下、什么都没发生」——
    失败必须一律转成带 `hint` 的结构化错误再展示（阶段 23 已在网易合成页修）。

22. **`/v1/weights` 的 `default` 与 `pretrained` 必须是同一口径的路径**
    设置页权重面板拿 `default.*` 作下拉的选中值、拿 `pretrained.*` 作选项值；
    一个绝对一个相对时 Radix 匹配不上，**两个下拉框显示为空白**（看起来像「没有权重」）。
    现两边都是 `installation.path()` 的绝对形式。

23. **GPT-SoVITS 的 `enabled` 开关在进程就绪之前就已落盘**
    `setEnabled(true)` 先写 `server/.data/sovits-service.json` 再 `ensureStarted()`，
    而 Python 侧冷启动要数十秒。所以任何「看到 enabled 就认为没事了」的逻辑都会误判 ——
    `SovitsServiceNotice` 现在必须同时看 `starting`（本页正在开启就先留着给进度）。

24. **显存准入门槛按推理精度分档（已修，2026-10）**
    nvidia-smi 口径改对之后（坑 17），6144 MB 这个**按 fp32 估的**门槛套在默认 fp16 上，
    等于把 8 GB 卡的主服务锁死 —— Windows 桌面（MyDockFinder / explorer / webview）常驻就吃掉
    2.9~5 GB，GPT-SoVITS 一启动预加载再占约 1.8 GB，空闲常年只有 1~3 GB。
    现 `netease/app/tts_engine.py::required_vram_mb(precision)`：fp16 → **5120**（实测峰值 4.9 GB），
    fp32 → 6144 原值；预热与合成两条准入路径、`/health` 的 `tts_required_vram_mb`、
    catalog 的 `required_vram_mb` 都按实际精度取值（坑 19：真源在服务端，前端只有兜底常量）。
    ⚠️ 分档只是不再按错口径拦人，**不等于这台机器一定跑得起来**：桌面把卡占满时空闲仍不足 5 GB，
    得用户自己关占显存的程序。R2T2 的准入仍用 `REQUIRED_VRAM_MB = 6144`，本次未动。

25. **拖拽导入必须走 `app/src/hooks/useFileDrop.ts`，别各自写 onDrop**
    三个容易漏的点（阶段 24 踩过）：
    - **文件夹只能靠 `webkitGetAsEntry`**：`dataTransfer.files` 对目录只给一个 0 字节壳，
      里面有什么要 `createReader().readEntries()` **分批读到返回 0 条为止**（一次不一定返全）。
    - **拖完要回填 `input.files`**（`applyFilesToInput`）：原生控件靠它显示文件名，
      不回填就一直写着「未选择任何文件」，看着像没成功。
    - **`dragleave` 要用深度计数器**：指针掠过子元素会反复触发，直接置 false 会让高亮狂闪。
    `AppShell` 上有一层全局 `preventDefault` 兜底 —— 落在上传区之外的误拖，浏览器默认会
    把整个 SPA 导航走（表单状态全丢）。新增上传点只要展开 `rootProps` 就自动带上过滤与回填。

26. **IndexTTS 的显存画像与「自己拦自己」的准入 bug（阶段 26 实测）**
    - 0.8B / BF16 **实际常驻约 5.3 GB**（nvidia-smi 加载前后差值），不是官方口径能推出来的 2~3 GB
      —— w2v-bert、BigVGAN、QwenEmotion、codec 全都算上。准入门槛 `REQUIRED_VRAM_MB=3072` 因此偏低，
      上调与否待用户拍板（见 PROGRESS 阶段 26 未完成项）。
    - 准入检查必须**先看模型是否已常驻，已加载就跳过** —— 否则模型加载后空闲显存必然低于门槛，
      合成会被**自己的常驻显存**拦死（VRAM_INSUFFICIENT，正是坑 24 在网易侧修过的同款问题）。
    - warmup 首跑约 4 分钟，**大头是上游对辅助模型的 ModelScope → hf-mirror 网络探测超时**，
      权重其实全在本地（探测失败后回退读本地），真·加载仅约 10 秒。断网机器上会更久。
    - RTF 对「当时有多少程序在抢显存」极度敏感：暖态 2.2，桌面占满时 5~14。对比网易（稳态 2.0~2.5）
      时**必须在同一台机、同一种桌面状态下测**，不然结论会错。

27. **音色库是两份进程共写的同一份 JSON（阶段 26补7）**
    网关（Node）与 trainer（Python）都读写 `voicelib/voices.json`。规矩只有一条：
    **任何一次 persist 之前必须先看到磁盘上的最新表** —— trainer 侧 `VoiceLibrary._refresh()`
    按 mtime 在每次读写前刷新，网关侧干脆每次操作都重读文件。绕过这条（比如给 trainer 加缓存表）
    会让 trainer 把网关侧新增的音色**整表覆盖丢**。
    另外两点：迁移（`trainer/.data` → `voicelib/`）只由网关首访触发，只跑 trainer 不跑网关的机器
    会看到空库（旧索引改名 `.migrated-to-voicelib` 保留，起一次网关即恢复）；
    音频时长/采样率由**浏览器**探测后随创建请求带上（Node 没有 soundfile），curl 直连时可为空。

28. **跨引擎测量的两条协议铁律 + Genie-TTS 没有情感控制（阶段 27 实测）**
    做引擎对比时踩到两个会让结论失真的坑，下次直接照这条来：
    ① **响度阈值必须自适应**。各引擎输出电平差一个量级（网易峰值可到 0.9，GPT-SoVITS 常出 0.02），
      用绝对 rms 阈值会把「轻声但有效」的合成判成静音——第一版就把三个正常样本误报成退化。
      正确做法：阈值取该文件 90 分位帧能量的 25%。
    ② **参考音频必须配它自己的转写**。给音色库原声喂 IndexTTS 句子的文本，GPT-SoVITS 会输出
      20+ 秒近静音——那是 prompt 文本错配，不是引擎坏了，别把它当缺陷写进报告。
    ③ 一条事实核查结论，省得再调研：**Genie-TTS 完全没有情感控制**（全仓库只有 README 注释提到
      「参考音频用于情感克隆」，机制与 GPT-SoVITS 相同），它是 GPT-SoVITS 的 ONNX CPU 推理器 +
      权重转换器，无训练、无 `top_k/temperature/seed/speed`、只支持 V2/V2ProPlus，且版本靠 `.pth`
      体积 >150MB 猜（我们的 `s2Gv2Pro.pth` 155MB 会被误判）。`jieba_fast` 在 PyPI 从未发过 wheel
      → Windows `pip install genie-tts` 必挂；`import genie_tts` 缺资源时会同步 `input()` 阻塞，
      并在 GBK 控制台直接崩在导入期。评估与本机实测数据见 `docs/GENIE-DOTSTTS-EVALUATION.md`，
      基准脚本与音频样本在仓库外 `F:\schoolCompWorks\clone\_bench\`。

29. **GPT-SoVITS 的 MHA 补丁会污染同进程的 RVC（变声必崩）**
    `GPT_SoVITS/AR/modules/activation.py:14` 在 **import 期**执行
    `F.multi_head_attention_forward = multi_head_attention_forward_patched`，
    把 torch 的多头注意力全局换成它的 KV-cache 版。而补丁文件
    `AR/modules/patched_mha_with_cache.py` 只 import 了 `_in_projection_packed`，
    **漏了 `_in_projection`** —— 后者只在 `use_separate_proj_weight=True`（q/k/v 投影分开传）
    分支被用到。GPT-SoVITS 自己的 AR 走 packed 分支碰不到，所以官方链路上永远不暴露；
    RVC 的内容编码器是 **fairseq 的 HuBERT**（`infer/modules/vc/utils.py::load_hubert`），
    正好走 separate 分支 → 变声一开始就 `NameError: name '_in_projection' is not defined`。
    **修法（官方整合包零改动）**：`trainer/app/torch_compat.py::ensure_mha_patch_complete()`
    往补丁函数的 `__globals__` 补回该名字（torch 2.0.0 里在 `torch/nn/functional.py:4790`，
    缺失时回退到等价的三次 `F.linear`）。三处调用点：`vc/bootstrap.prepare_env()`、
    `vc/pipeline.VcEngine._context()`（**每次**变声前——补丁可能是 RVC 之后才被装上的，
    只在初始化补一次不够）、`svc/bootstrap.ensure_import_path()`。
    排障出口：`GET /v1/vc/catalog` 的 `mha_patch` 字段（`patched` / `in_projection_bound`）。
    验证脚本 `trainer/.tmp/check_mha_patch.py`（整合包 python 跑，能复现 NameError 并验证修复）。
    教训：三个上游共用**一个进程**时，"全局 monkey patch" 是隐性耦合，排查时先看
    `F.multi_head_attention_forward.__module__` 这类被换掉的全局对象。
    **已根治（2026-11，方案 B）**：GPT-SoVITS 现跑在独立 worker 进程里，补丁不再出那个进程，
    主进程的 `F.multi_head_attention_forward` 始终是原生实现。`torch_compat` **保留**
    （仍是对「未来某个引擎又打补丁」的兜底），但 RVC 路径已不再依赖它。
    见 `docs/ENGINE-ISOLATION.md`。

30. **worker 的 stdout 会被官方 `print` 污染**
    `TTS.py` 里有 `print(f"first_package_delay: ...")`、`print("%.3f\t%.3f\t...")` 等调试输出。
    worker 用 stdout 跑 JSON-lines 协议，这些 print 会插进协议流里把行撕开。
    **修法**：`protocol.isolate_stdout()` —— `os.dup(1)` 存下真 stdout 作为协议私有通道，
    再把 fd1 `dup2` 到 stderr，最后 `sys.stdout = sys.stderr`。于是官方 print 和日志
    统统走到 stderr（由主进程加 `[sovits-worker]` 前缀转发），协议通道干净。
    这是「必须踩一次才会想到」的坑：只重定向 `sys.stdout` 不够，C 层 fd 也得换。

31. **整合包解释器是 embedded distribution，忽略 `PYTHONPATH`**
    整合包里 `runtime/python39._pth` 内容只有 `python39.zip` / `.` / `import site` 三行。
    后果有二：(1) **完全忽略 `PYTHONPATH`**；(2) 不给 `-m` 提供 `sys.path[0]`。
    所以 `python -m app.sovits.worker` 会以「No module named 'app'」死在我们的代码之前
    —— 连错误都传不出来，对外表现只是「worker 启动超时（300 秒内未收到 ready）」。
    **修法**：按**文件路径**启动 `[python, "-u", "<abs>/__main__.py"]`，
    `__main__.py` 里自己把项目根 `sys.path.insert(0, ...)`。诊断方法：
    打印 `sys.path[:8]` + `cat runtime/python39._pth`。

32. **状态镜像的读取顺序会导致「服务撒谎」**
    `Pipeline.status()` 里若先把 `payload = self.state.to_dict()` 取好、**再**刷新 worker
    存活状态，返回的就是一帧过期快照 —— worker 刚猝死时 `loaded` 还是 `True`，
    `/health` 谎报「已就绪」，前端显示绿色，用户一点合成立刻 503。
    **修法**：(a) 刷新必须在 `to_dict()` **之前**；(b) 把「worker 死 → 模型没了」
    收口成 `PipelineState.mark_worker_lost()` 一个方法，供 `status()` /
    `_raise_worker_gone()` / `unload()` 三处共用（原来三处各自手改字段，漏一处就退化）。
    注意不能只靠发请求时才纠正 —— worker 自己猝死时没人发请求，
    只有读线程看到 EOF，必须让 `/health` 这条读路径负责纠正。

33. **Irodori-TTS 若要接入：Windows 三个必踩坑（阶段 28 本机实测）**
    ① **`prepare_manifest.py` 在 Windows 会静默空转**：datasets 的 Audio 解码走 torchcodec，
      cu128 索引没有 Windows wheel → 结果是 `seen=16 written=0 skipped_audio=16`、**退出码 0、
      manifest 0 字节**（上游 issue #40 的本地复现）。任何训练前必须断言 manifest 行数 > 0，
      否则会"跑一整晚训练了个空数据集"。绕法已验证可用：直接用
      `irodori_tts.codec.DACVAECodec.encode_file()` 编 latent，按官方 schema 手写 JSONL。
    ② **`torchaudio.load` 在本机直接 ImportError**（torch≥2.9 把它整个委托给 torchcodec），
      而读参考音/编 latent 都走这条路。基准脚本用 `_bench/shim/sitecustomize.py` 换成 soundfile；
      正式接入应在自己的服务里显式用 soundfile/ffmpeg，别依赖 torchaudio.load。
    ③ **emoji 情感控制对男声基本无效**（复现 issue #9）：同一批 emoji 打在男声参考音上，
      F0 全锁在 110.3–111.9Hz（跨度 1.6Hz）。我们音色库是男声 ⇒ UI 文案只能承诺"节奏与插入音"，
      不能写"男声情感操控"。另：⏩/🐢/👂 三条在女声上也没兑现（语速 5.25≈基线 5.26、能量没降）。
    附带：`dacvae` 与 `silentcipher` 是 **git-only 依赖**（PyPI 没有），github.com 直连不通时走
    codeload tarball；`sample_rf` 有**偶发长尾**（实测 89.17s 合成 4.96s，只在某个 seed 复现，
    降到 20 步即绕开）→ 服务侧必须有超时 + 重试。全部数据见 `docs/IRODORI-TTS-EVALUATION.md`。

34. **DDSP-SVC 的 `.pt` 不是自包含的：必须配同目录 `config.yaml`（阶段 27补4 实测）**
    RVC 的 `.pth` 自带版本/采样率信息，DDSP-SVC 的 `.pt` **只是纯权重** —— 采样率、编码器
    （`contentvec768l12tta2x`）、F0 提取器、`block_size` 全在同目录的 `config.yaml` 里。
    少一个都加载不了。这决定了三件事：① 导入入口**必须同时收两个文件**（只收 `.pt` 会得到
    一个「看得见、选不了」的幽灵条目）；② `catalog.list_models()` 把无 config 的标 `available=False`
    并给 hint；③ **删除必须成对删**（只删 `.pt` 会留下孤儿 config）。
    另一个连带坑：DDSP-SVC 官方导出的权重**几乎都叫 `model.pt`**，真正区分音色的是
    **所在目录名**（`<expdir>/model.pt`）——`describe_model()` 因此改成「在自有子目录时用目录名当 id」，
    否则多模型会在下拉框里挤成一堆 `model`，且 `id` 不唯一会让 `/models/load` 的 `model_key` 解析命中错条目。

35. **删模型端点要加「边界检查」，不能只按 id 删（阶段 27补4）**
    `DELETE /v1/svc/models` 的 `model` 参数接受「id / name / 绝对路径」三态（与 `/models/load` 口径一致），
    但**路径形态必须做归属校验**：只有落在 `catalog.model_dirs()` 之内的文件才允许删。
    否则一个传错路径的请求就能删掉用户任意位置的 `.pt`。实测：传 `vendor/rvc/.../not-ours.pt`
    会返回 `ok=False` + 明确理由，且文件原封不动。

36. **`audio/io.py::save()` 有两个独立缺陷，都是「照搬旧习惯」造成的（阶段 27补5，2026-10）**
    用户主诉「音频增益过大，全部失真」，根因在**第一个**；排查时又撞见**第二个**。

    **① 整数输入被强转 float32 → 100% 削波成方波。**
    RVC 的 `vc_single()` 返回的是**已缩放到 ±32768 的 int16**
    （`vendor/rvc/infer/modules/vc/pipeline.py` 末尾 `(audio_opt * max_int16).astype(np.int16)`）。
    原写法 `np.asarray(data, dtype=np.float32)` 把 `24351` 交给 soundfile ——
    而 soundfile 的**浮点约定是 [-1, 1]**，于是单样本直接顶满量程。
    实测对照：int16 原样写 absmax=0.7431 / 削波 0.00%；强转 float32 后 absmax=1.0000 / 削波 **100.00%**。
    修法：`np.issubdtype(array.dtype, np.floating)` **分流** —— 浮点规整成 float32，整数保留原 dtype。

    **② 多声道数组被 `.T` 转置 → libsndfile 直接拒绝。**
    `soundfile >= 0.12` 的 `sf.write` 要 **frames-first**（`(N, channels)`）；
    老版 librosa 习惯的 `(channels, frames)` 已经不认。原来的 `array.T` 对单声道 `(N,)` 无影响
    （`ndim == 1` 不转置），但立体声 `(N, 2)` 会被转成 `(2, N)` = **2 帧 × 80000 声道**，
    报 `LibsndfileError: Format not recognised`。变声主路径是单声道，所以这个坑一直没暴露。
    修法：删掉转置，只 `np.ascontiguousarray`；`ndim > 2` 明确抛 `AudioError`。
    回归锁：`.tmp/verify_vc_audio.py`（10 项，含「channels-first 必被拒绝」与「旧写法必 100% 削波」两条反证）。

37. **FastAPI 端点的 `payload: Any` 必须显式写 `Body(default=None)`（阶段 27补5）**
    裸 `def f(payload: Any)` 会被 FastAPI 当成**必需的 query 参数**，
    前端发 JSON body 就报 `422 VALIDATION_ERROR: query.payload Field required`。
    踩中的 7 个端点：`/v1/vc/merge`、`/v1/vc/train/plan`、`/v1/vc/train`
    （`routers/vc.py`）与 `/v1/asr/plan`、`/v1/asr/models/load`、`/v1/asr/train/plan`、`/v1/asr/train`（`routers/asr.py`）。

38. **同步端点里 `asyncio.Event()` 会炸：anyio 工作线程没有事件循环（阶段 27补5）**
    FastAPI 把同步端点丢进 anyio 线程池执行，那里没有「当前事件循环」，
    无参 `asyncio.Event()` 内部调 `get_event_loop()` → `RuntimeError: There is no current event loop
    in thread 'AnyIO worker thread'`。表现为「一提交训练就 500」。
    双管齐下修：① `Scheduler.start()` 记 `self._loop = asyncio.get_running_loop()`，
    `submit()` 用 `_make_cancel_event()` 在该 loop 上建 Event
    （3.9 没有 `Event(loop=...)`，构造后重绑 `event._loop`）；② 受影响的端点改 `async def`。

39. **`torch.save(payload, "路径字符串")` 在 Windows 上对中文名有奇偶陷阱（阶段 27补5，最迷惑的一个）**
    torch 的 `PyTorchFileWriter` 在 Windows 上用 **UTF-16** 打开路径，
    文件名里**奇数个非 ASCII 字符**时必然越界一格 →
    `RuntimeError: File ... cannot be opened.`，**偶数个则完全正常**。
    实测「验收二轮_训练_流水线」这个含奇数个中文字符的名字 100% 失败，换个偶数名就过 ——
    与路径长度、目录是否存在都无关，逐字符扫描才确认是奇偶规律。
    **修法：`with open(path, "wb") as h: torch.save(payload, h)`**（走文件对象，绕开字符串路径）。
    已改：`vc/lora.py::save_adapter()`、`vc/merge.py`。

40. **RVC 官方 mel 配置的口径必须照抄 `infer-web.py`，不能从 ckpt 里猜（阶段 27补5）**
    `ckpt["config"]` 的布局（`vendor/rvc/infer/lib/train/process_ckpt.py::savee()`）是：
    `[-1] sampling_rate`、`[-2] gin_channels`、`[-3] spk_embed_dim`、`[-4] upsample_kernel_sizes`（**是 list**）、
    `[-5] upsample_initial_channel`、`[-6] upsample_rates` ——
    **里面根本没有 `hop_length` / `n_mel_channels`**，必须去读官方 `configs/<v1|v2>/<sr>.json` 的 `data` 段。
    目录选择照抄官方 `infer-web.py`：`if version19 == "v1" or sr2 == "40k": config_path = "v1/%s.json"` ——
    **40k 走 v1 目录**（`n_mel_channels=125`、`hop_length=400`），与 v1 的 48k/32k 都不同。
    另一个易错点：config 文件名是 `40k.json` 而 ckpt 里存的是赫兹 `40000`，需要做 `"40000" → "40k"` 归一。
    误用 `cfg[-4]`（`upsample_kernel_sizes`，list）当 hop_size 会报
    `TypeError: int() argument must be ... not 'list'`。

41. **`svc_infer` 的产物路径嵌在 `artifacts.artifacts` 里，`urls` 却在外层（阶段 27补5）**
    前端展示「运行产物 + 本地路径」时最容易在这里漏掉路径。真实落库形状是：
    ```
    { "job_id": ..., "artifacts": { "vocal": "F:\\...\\song_vocal.wav", ... },
      "stages": [...], "urls": { "vocal": "/files/svc/<id>/song_vocal.wav", ... } }
    ```
    成因：`cover.py::run_cover()` 返回 `{"artifacts": {...}, "stages", "elapsed_s"}`，
    `routers/svc.py` 的 runner 直接 `{"job_id": ..., **result, "urls": urls}` 抛给队列。
    而 `vc_infer` 是扁平的（顶层直接 `output` + `urls.output`）—— **两类任务形状不同**。
    所以 `app/src/hooks/useVcRunHistory.ts::collectTracks()` 必须同时看顶层与内层 `artifacts`，
    且只接受「像盘符路径或 `/files/` 开头」的字符串，否则 `sample_rate` / `stages` / `info` 会被误当产物。
    回归锁：`.tmp/verify_run_artifacts.py`（20 项，覆盖 vc_infer 单产物 / 翻唱三轨 / 直接转换 / 四类边界）。

42. **资源预估的「重复扣账」：引擎已加载时不能再算 `空闲 − 需求`（阶段 27补6，2026-10 用户主诉）**
    主诉「网易模型显存空出来，模型已经预热成功加载后，上方检测又显示不够了
    （实际应该是自己的模型在跑，自己把自己检测到了）」。
    **读数没错，是算式错了**：引擎常驻后它自己占的那几 GB 已经反映在 `vram_free` 里，
    `estimateTask()` 再减一次需求就是**把模型自己当成了占用者**。
    实测复现（`loaded=True`、`free=807 MB`、`tts_required_vram_mb=5120`）：
    `807 − 5120 = −4313 → insufficient`，界面显示「还差约 4.3 GB」——与用户截图「还差约 4.8 GB」同量级。
    **修法（`app/src/lib/resources.ts::estimateTask()`）**：`engineLoaded` 时**不做减法**，
    `vram_free < 512` 才降级 `tight`；未加载时保留原算式。
    **字段名三个服务各不相同，别想当然**：
    网易 TTS → `engines.confucius_tts.loaded`；网易 ASR → `engines.r2t2.model_loaded`（**不是 `loaded`**）；
    IndexTTS → `engine.loaded`。
    **联动刷新同样关键**：`ResourceBudget` 原来只在挂载时 `refresh()` 一次，
    而页面挂载时父组件的 `engine` 还是 `null`、预热完成后才变 `true` ——
    只看第一次会永远停在「未加载」的旧算式上。修法是拿
    `loadedKey = ${neteaseTtsLoaded}|${neteaseAsrLoaded}|${indexttsLoaded}` 做 effect 依赖
    （用 `firstLoad` ref 跳过挂载那一次，避免开局打两次请求）。
    回归锁：`.tmp/verify_vram_estimate.py`（11 项：6 条纯算式 + 5 条真实 `/health` 核对）。

43. **`shutdown()` 只杀 `this.child` → 外部实例永远关不掉（阶段 27补6，2026-10 用户主诉「网易进程关不掉，想切换 IndexTTS 无法切换」）**
    服务有**三条启动路径**：① 网关 spawn（`this.child` 有值）；② `npm run dev` 的 concurrently 起的；
    ③ 用户手动 `node scripts/netease.mjs` 起的。②③ 都让 `this.child === null`，
    旧实现「`!child` 就放弃」→ **开关写成了 `enabled: false`，进程却还活着**。
    现场取证：`server/.data/netease-service.json` 是 `enabled: false`，9882 端口 PID 16780 仍 LISTENING，
    切 IndexTTS 时两个服务抢显存。
    **修法**：`shutdown()` 补第二路「**按端口反查 + 项目归属校验**」（`server/src/lib/processOwnership.ts`），
    先杀 `child`、再杀端口上能确认归属的。原界面的「外部实例请去终端 Ctrl+C」是**错误引导**，已改为读 `status.shutdownNote`。
    实测：关闭后显存 **6985 → 1059 MiB**（释放约 5.8 GB），端口释放。
    `sovits.ts` 有**同样的缺陷**（`shutdown()` 也只杀 `child`），已一并修。

44. **进程归属识别：宁可漏杀，不可错杀（阶段 27补6）**
    `lib/processOwnership.ts::classify()` 按可信度从高到低排五条判据：
    ⓪ **服务 `/health` 自报 PID**（最硬，为此给 netease / indextts 的 `/health` 都加了 `pid` 字段）；
    ① 命令行指向 `<root>/scripts/<name>.mjs`；② 项目绝对根路径 + 服务标识词；
    ③ **相对路径形态** `python netease/server.py`（正则必须是 `<hint>/server.py`，不能只凭 `server.py`——太泛会误伤别的项目）；
    ④⑤ 解释器 `ExecutablePath` 落在项目根内 + 服务标识词 / 入口脚本。
    **③ 是实测补的**：命令行 `"...Python312\python.exe" netease/server.py` 既无绝对路径也无 `scripts/`，
    判据 ①② 全命中不了，导致一次关停演练失败（`ours=false` → `stopped:false`）。
    **硬约束：判不了归属的进程一律不动** —— 停错别人的进程比「关不掉」严重得多。

45. **Windows 上必须 `taskkill /t /f`，且注意三代嵌套（阶段 27补6）**
    实测进程树是 `python.exe(监听者) ← python.exe ← node.exe`，真实监听者是**第三代**。
    只杀 node 会留下两个孤儿 python 继续占端口与显存；`child.kill()` 同理杀不干净。
    另注：`"/health` 自报的 `pid` 与 supervisor 的 `status().pid` **不是同一个** ——
    实测 node 包装进程 40640，真正监听的 python 是 38924，正因如此才需要自报 PID 这条判据。
    **调试侧**：Bash 工具跑 `powershell` 拿不到 stdout（安全策略），`wmic` 在 Win11 已移除，
    要用 Win32 API（`ctypes.CreateToolhelp32Snapshot`）或 Node 的 `execFile` 读进程信息。
    **`npx tsx` 脚本 `process.exit(0)` 会把 spawn 的子进程一起带走** ——
    后台起服务必须 `run_in_background=true` 并让脚本挂住（`await new Promise(() => {})`），
    `nohup ... &` 也会随命令结束被回收。

46. **侧栏状态与设置页开关必须共用同一个事实源（阶段 27补7，2026-10 用户主诉）**
    主诉「左侧状态栏显示网易已就绪，但设置页显示未启动，那到底是启动还是没启动？」
    —— 这不是两个 bug，是**同一个状态被两套独立探活各自缓存**：
    * 侧栏只探 `netease /health`（判「权重装了没 / 包能不能 import」），**完全不读 `enabled`**；
    * 设置页读 supervisor 的 `enabled` 与 `reachable`。
    `npm run dev` 用 concurrently **无条件**起 `dev:netease --skip-if-missing`，而 `enabled` 默认 `false`
    —— 所以「进程在跑 + 开关是关的」是**开发模式下的常态**，不是偶发。
    **修法（`app/src/App.tsx`）**：侧栏判定改成两级 —— 先问 supervisor 的 `enabled`
    （用户意图，唯一事实源），`enabled=true` 才去探 `/health` 判 ready / incomplete；
    `enabled=false` 一律 `offline`。设置页的 Badge 也统一到 `enabled && reachable` 口径
    （原来只看 `reachable`），并在 `enabled=false && reachable=true` 时补一句
    「检测到未托管的进程仍在 :9882 上运行」把实情说清。

47. **网关的状态接口必须「读时现探」，不能吐缓存（阶段 27补7）**
    `/api/netease/service` 与 `/api/indextts/service` 原来直接返回 `supervisor.status()`，
    而 `reachable` 只在 supervisor 自己的启动/关停流程里更新过 ——
    网关起来后从没探过就是初始的 `false`。于是出现
    「端口上明明有进程在跑，接口却报 `reachable=false`」，把界面上「未托管进程」的提示也吞掉了。
    修法：GET 处理器 `await supervisor.probe()` 再返回。
    **`/api/sovits/service` 本来就有这一行**（`await sovitsSupervisor.probe()`），
    netease / indextts 是漏网的那个 —— 新增服务接入时记得对齐。

48. **开关切换要广播，否则界面滞后一个轮询周期（阶段 27补7）**
    侧栏探活是 30s（就绪后）/ 10s（未就绪）轮询。用户点了设置页的开关后，
    侧栏要等下一轮才翻转，观感就是「点了没反应」。
    修法：`lib/localService.ts` 导出 `notifyServiceEnabledChanged()`，
    设置页 / 资源卡 / IndexTTS 页在所有 `toggle` 成功后调用；
    `App.tsx` 用一个 `serviceChangedTick` state 订阅 `service-enabled-changed` 事件并放进
    三个探活 effect 的 deps —— 事件一来 effect 重建、旧定时器被 cleanup 回收、立刻重探。

49. **RVC 的 `VC.get_vc(sid)` 拼的是 `f'{weight_root}/{sid}'` —— 嵌套模型加载的关键（阶段 30 / P0）**
    `vendor/rvc/infer/modules/vc/modules.py` 里：
    ```python
    person = f'{os.getenv("weight_root")}/{sid}'
    self.cpt = torch.load(person, map_location="cpu")
    ```
    改前 `pipeline.load()` 传的是 `str(path.name)`（只有文件名），而 `weight_root` 固定为
    模型库根目录 —— 于是**模型在子目录里时拼出来的路径根本不存在**，加载必然失败
    （实测：10/10 嵌套模型全部拼不出路径）。
    **修法（无需改上游）**：加载前把 `weight_root` 与 `index_root` 都设成
    **模型自己所在的目录**，`sid` 仍只传文件名：
    ```python
    os.environ["weight_root"] = str(path.parent)
    os.environ["index_root"] = str(path.parent)
    self._vc.get_vc(str(path.name))
    ```
    `index_root` 同理 —— 官方 `get_index_path_from_model()` 在它下面递归找 `.index`。

50. **多根搜索时，`find_model` 必须「逐根先精确后递归」，不能「所有根先精确再统一递归」（阶段 30 / P0）**
    错误写法（每根都只试相对路径，全部试完再统一递归）：
    ```python
    for root in roots:                     # ← 先跑完所有根的精确匹配
        if (root / name).is_file(): return root / name
    for root in roots:                     # ← 才轮到递归
        ...
    ```
    后果：`.data/vc/models/lenai.pth`（扁平、低优先级根）会抢在
    `models/RVC语音模型/MYGO全员/乐奈/lenai.pth`（嵌套、高优先级根）之前命中 ——
    用户在新根或嵌套目录里放的同名模型**永远选不中**。
    正确写法是**逐根闭环**：在同一个根里先试精确路径、再递归匹配，都不中才换下一根。

51. **换扫描根必须同时保留「兼容读取的旧位置」，且网关与引擎两侧的根列表要逐一对应（阶段 30 / P0）**
    直接换根会让既有模型全部「消失」（用户会以为数据丢了）。
    定为三根并存：`models/rvc/`（规范，写入根）→ `models/RVC语音模型/`（用户的组织方式）
    → `trainer/.data/vc/models/`（旧根）。
    **两侧必须对齐** —— 实测网关只配 1 个旧根时它看到 10 个、trainer 看到 18 个，
    结果是「引擎能加载但界面看不见」的错位；补齐后两侧都是 18。
    配置入口：trainer 用 `Settings.rvc_model_search_dirs`（`RVC_MODEL_DIRS` 可覆盖），
    网关用 `MODEL_CATEGORIES[].legacy_dirs`。

52. **路径边界检查要把「路径 == 根本身」算在界内（阶段 31 / P1）**
    `assertInsideCategory` 里写成 `relative !== '' && !startsWith('..')` 是错的：
    `path.relative(root, root)` 返回 `''`，于是**根本身被判成越界** ——
    实测后果是「把扁平旧根里的模型迁走」这种合法操作被自己的安全检查全部拒掉
    （8 个模型报「路径不在任何搜索目录内」）。
    正确写法：`relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))`。

53. **迁移要按「模型的文件」搬，不能按「目录」搬（阶段 31 / P1）**
    扁平布局下多个模型共用一个目录，若按目录整体搬，会把同目录里别的模型一起卷走。
    正确做法是只搬 `model.files` + 该模型自己的 sidecar。
    （配套设计：`ModelEntry.single_model_dir` 决定 sidecar 放目录级 `.meta.json`
     还是 `<stem>.meta.json` —— 否则同目录多模型会共用一份元数据、互相覆盖显示名。）

54. **Windows Git Bash 的 curl 会把 UTF-8 命令行参数转成 GBK 再发送（阶段 31 / P1 实测）**
    用 `curl -d '{"name":"改名后"}'` 测接口，中文在服务端会变成 `U+FFFD` 替换字符
    （3 个汉字 → 6 个 `\xef\xbf\xbd`），看起来像服务端编码 bug，**其实是测试工具的锅**。
    另：URL 里放未编码的中文会让 Node 的 HTTP 解析器直接回 **400 且无 body**（不是业务错误）。
    → 手工测接口请用 Python `urllib` + 显式 UTF-8 编码；前端 `fetch`/`URLSearchParams` 本身没问题。
    回归脚本已按此实现（`.tmp/verify_model_manage.py`）。

55. **任务产物里的 `urls.<key>` 是「服务内相对路径」，直接塞给 `<audio src>` 必然 404（阶段 32 / P2）**
    `/v1/jobs` 回的是 `/files/vc/<job>/converted.wav`，浏览器要的是 `/api/sovits/files/...`。
    vite 只代理 `/api`，网关根下也没有 `/files` 挂载 —— 所以**必须过 `resolveAudioUrl()` 补前缀**。
    阶段 27补5 的 `RunResultCard` 当时是直接用的原始值（同一条链路上的坑 27 复发），
    现在 `collectTracks()`（`@/lib/jobArtifacts.ts`）统一收口，变声 / 翻唱 / 产出记录页共用后一并修复。
    实测：`HEAD /api/sovits/files/vc/<job>/converted.wav` → 200 `audio/wav`。

56. **「历史记录」≠「全部产出」：本地引擎的产物根本不在 IndexedDB（阶段 32 / P2）**
    MiMo 的合成走浏览器库（IndexedDB），而 RVC / DDSP-SVC / GPT-SoVITS / UVR5 / ASR 的产物
    一律落在服务端 `trainer/.data/jobs/*.json`。**不是没记录，只是没有页面去读它。**
    `GET /v1/jobs` 不带 `kind` 就返回全部类型（`limit` 上限 200），产出记录页的数据源一直是现成的。

57. **注册表 id 与引擎 id 是两套，不能直接混用（阶段 33 / P3）**
    注册表用「按目录派生的稳定 id」，而 RVC 引擎 `find_model()` 认的是**主权重文件名的茎**。
    实测比对：`/v1/vc/catalog` 的 13 个 id 与注册表主权重茎集合**完全一致（diff=0）**，
    所以变声页用 `engineKeyOf()` 派生回引擎 key 即可 —— **不要**把注册表 id 直接传给引擎端点。
    DDSP-SVC 反过来：它的 load 收**绝对路径**，直接用 `files[role=primary].abs`。

58. **RVC 全量训练（`mode=full`）改前是「必挂」的，三个独立失败点（阶段 29）**
    ① `train.py::get_hparams()` 无条件读 `logs/<exp>/config.json`，而我们**从不生成**；
    ② 底模写死 `assets/pretrained_v2/f0G32k.pth`，本机**只有 40k**（`f0G40k` 69.7MB / `f0D40k` 136.3MB）；
    ③ 官方命令里的 `-sw` 我们没传，`-l` / `-c` 被写死。
    现在：`write_train_config()` 按官方规则（`v1` 或 `40k` → `configs/v1/<sr>.json`）生成配置；
    `resolve_pretrained()` 找不到底模就**不带 `-pg/-pd`**（官方做法，等于从零训）而不是拼不存在的路径。

59. **采样率 × 版本不是任意组合：40k 必须配 v1（阶段 29）**
    官方 `infer-web.py:555` 的硬性规则：`version=="v1" or sr=="40k"` → `configs/v1/<sr>.json`。
    本机 `configs/` 实际只有 **v1: 32k/40k/48k、v2: 32k/48k** —— 所以 `v2 + 40k` 是非法组合。
    预检 `training.preflight()` 会在**入队前**拦掉（`/v1/vc/train` 直接 400），plan 接口返回同样的结论。
    另外：**本机现成可跑的只有 40k + v1**（32k / 48k 没底模，会从零训练）。

60. **换数据源之前先确认「旧位置」已被注册表读到，否则模型会凭空消失（阶段 33 / P3）**
    DDSP-SVC 的模型一直放在 `trainer/.data/svc/models` 与 `models/checkpoints/ddsp`
    （引擎侧 `svc/bootstrap.py::model_dirs()`），而注册表只扫 `models/ddsp-svc/` ——
    直接换源的话 `total` 从 1 变 0。已给该类别补两根兼容根（RVC 在 P0 踩过同一个坑，坑 51）。
    **下一个要接数据源的类别，先跑一遍 `GET /api/models?category=<key>` 与引擎目录比对数量。**

61. **RuntimeSupervisor 的 flag 文件缺失时会 fallback 到 `defaultEnabled`（阶段 30-2 实测）**
    `server/.data/<id>-service.json` 不存在 ≠ 停用 —— netease 的默认值是 `true`，
    临时把 flag 移开再起网关，它照样把网易服务拉起来（且 `scripts/netease.mjs` 被 supervisor
    spawn 时**不带** `--skip-if-missing`）。测网关要么保留 flag 原样，要么测完
    `taskkill /t /f` 清理拉起的进程树。另：Git Bash 里 `taskkill /t` 的 `/t` 会被
    MSYS 转成路径 `T:/` 报「无效参数」—— 前面加 `MSYS_NO_PATHCONV=1`。

62. **从上游源码取常量做 ast 解析时，`X: tuple[...] = (...)` 是 `ast.AnnAssign` 不是 `ast.Assign`**
    Irodori 上游的 `ALLOWED_ANNOTATION_EMOJIS` 与 `EMOJI_PALETTE_ITEMS` 都是**带注解赋值**
    （阶段 28 的 56 个 emoji 白名单 + 45 条官方释义就藏在这两处，而这两个模块分别
    `import torch` / `import gradio`，catalog 不能直接 import）。第一版只认 `ast.Assign`
    静默解析出 0 个 emoji —— 回归锁在 `.tmp/verify_irodori_infer.py` A8/A9。
    以后凡是「不 import 上游、直接解析源码拿常量」的场景都用
    `irodori/app/catalog.py::_assign_targets()` 这个双兼容写法。

## 命令

| 用途 | 命令 |
| --- | --- |
| 安装依赖 | `npm run install:all` |
| **一键启动（推荐）** | 双击 `start.bat` |
| 开发模式 | `npm run dev`（并行起：本地模型服务 + 网关 + 前端） |
| 网易模块服务 | **已随 `npm run dev` 自动拉起**；单独重启用 `npm run dev:netease`（需先按 `netease/README.md` 建 venv + 下权重）。**阶段 26补3 起设置页有开关**（`GET/POST /api/netease/service`，网关托管；外部终端起的实例杀不掉进程，但会先卸模型归还显存） |
| GPT-SoVITS 服务 | **默认不启动**（显存留给主服务）；要用训练 / 批量 / 变声 / 翻唱时到**设置页**打开；想随 dev 一起起用 `npm run dev:all` |
| GPT-SoVITS 启停接口 | `GET/POST /api/sovits/service`（`{"enabled":true}`）；开关存在 `server/.data/sovits-service.json` |
| IndexTTS 服务 | `npm run dev:indextts`（第三个 Python 运行时：`indextts/upstream/.venv`，py3.11 + torch 2.8 cu128；端口 **9883**）；体检 `npm run indextts:check`；**阶段 26 起全链路已接入**（网关 `/api/indextts/*` 透传 + 前端「IndexTTS · 情感可控」页）；**设置页开关**（`GET/POST /api/indextts/service`，默认关） |
| IndexTTS 方案文档 | `docs/INDEX-TTS-INTEGRATION.md`（8 阶段计划；阶段 0/1/2 完成于 25，合成实测 + 透传 + 前端 + 资源管控完成于 26） |
| Irodori 服务 | `npm run dev:irodori`（第四个 Python 运行时：`irodori/.venv`，py3.12 + torch 2.10 cu128；端口 **9884**）；体检 `npm run irodori:check`；权重 `npm run irodori:weights`（`-- --training` 下训练档 bf16 2.9GB，30-5 前必须）；**30-2 起推理链路可用**（网关 `/api/irodori/*` 透传 + runtime/arbiter/preload 记账）；**启停接口已就位但设置页还没接 UI**（`GET/POST /api/irodori/service`，supervisor 默认停用；接 UI 是 30-7 的活）；**前端页也在 30-7**，当前用 curl/脚本调；推理链路验证 `python .tmp/verify_irodori_infer.py [--gateway]`（真合成段需显存 ≥4700MB） |
| 启动预加载 | `GET /api/preload/catalog`（各模型显存代价 + 当前余量）、`POST /api/preload`（执行）、`PUT /api/preload/preference`；偏好存 `server/.data/preload.json` |
| 网易模块体检 | `npm run netease:check`（或 `python scripts/preflight_netease.py [--allow-missing-asr]`） |
| 网易权重下载 | `npm run netease:weights [-- --proxy http://127.0.0.1:7890] [-- --include-r2t2]` |
| worker 隔离验证（5 个脚本，共 139 项） | 先起服务 `./GPT-SoVITS-v2pro-20250604/runtime/python.exe trainer/server.py --port 19881 --no-open --no-warmup`，然后：`python .tmp/worker_smoke.py`（32 项，任意 py）、`python .tmp/verify_http.py 19881`（51 项）、`python .tmp/verify_recovery.py 19881`（14 项）；另两个用整合包解释器：`.tmp/verify_isolation.py`（12 项）、`.tmp/verify_synthesis.py`（30 项）。**脚本里都清掉了 `http_proxy`**（本机系统代理会拦 127.0.0.1） |
| 只起网关+前端 | `npm run dev:cloud` |
| 只起本地模型服务 | `npm run dev:sovits` |
| 环境体检 | `npm run sovits:check`（退出码 0 表示就绪） |
| 类型检查 | `npm run typecheck` |
| 前端 lint | `cd app && npx eslint <文件或目录>` |
| 构建 | `npm run build` |
| 生产单端口 | `npm run preview` |
| Python 侧语法自检 | 见 `trainer/.tmp/syntax.py`（若不存在可临时创建，用 `ast.parse` 遍历） |

## 状态

### 当前状态

- `feature/vc-svc` 分支，origin 已同步（本地有阶段 6 改动待提交）
- `main` 分支停在 `f83d51b`（未包含 vc-svc 功能）
- 功能可用；本地服务、网关、前端三进程由 `start.bat` 统一拉起
- 术语表 100 条 + 页面接入 74 处
- 官方流程指引（8 步）已接入训练页与合成页
- HANDOFF「下一步」清单已清零（阶段 6）：训练顺序 s2→s1、设置页权重下拉 + E/S 解释、
  切分结果面板（时长降序 + >15s 高亮）、跨语言合成提示、校对文案、补词笔记删除
- 网易模块（阶段 7）已交付：`netease/` 服务骨架 + 网关透传 + 前端两页 + 体检脚本；
  **无权重也能启动并如实报告缺失**；浏览器实测两页渲染与探活状态正常
- **TTS 侧已装好并跑通（阶段 8）**：venv(py3.12) + torch 2.7.0+cu126 + 权重 5.4 GB 已就位；
  `npm run netease:check` 与 `preflight_netease.py --allow-missing-asr` 均退出码 0；
  真跑通过 zh / en 两条合成（RTF 2.0~2.5，常驻 + 峰值显存 4.9 GB）
- **ASR（R2T2）在 Windows 上不可用**：PyPI 上 vllm 只有 Linux wheel，r2t2 的 llama.cpp 后端
  也只有 Linux `.so`。要跑只能上 WSL2 / Docker（镜像 `qwenllm/qwen3-asr`）。
  流式字段已按官方 README 校准（坑 12），但**没有真机验证过**
- **浏览器链路已打通（阶段 8 续）**：`npm run dev` + `npm run dev:netease` 四端口在跑
  （5173 / 8787 / 9881 / 9882）；网关 `/api/netease/*` 透传正常，`/api/netease/health` 返回
  TTS `installed=true / missing=0`、R2T2 `installed=false`（两张状态卡如实显示已就绪 / 待补齐）；
  经网关代理合成一条 200（4.99 s 音频 / 24.36 s）。**GPT-SoVITS 的后台预加载已手动卸掉**
  （`POST /v1/engines/unload` + `/v1/pipeline/unload`）让位，下次用它会自动重新加载
- **浏览器人工走查已做完（阶段 23）**：网易合成页 + 阶段 6 新 UI 逐项点过，修掉 6 处只有实测才会
  暴露的缺陷（音色库取参考音频 404、失败被静默吞掉、`/v1/voices` 无限重试、启动进度 3 秒自消失、
  整页报错时丢掉「直接开启」入口、权重下拉显示空白）；新增坑 21~24
- **全站拖拽导入已就位（阶段 24）**：13 处上传点统一走 `app/src/hooks/useFileDrop.ts`，
  支持文件与**文件夹**（entry API 递归）、按 accept 过滤、回填 `input.files`；
  `AppShell` 加了全局 preventDefault 兜底（误拖不再把 SPA 导航走）；新增坑 25
- **IndexTTS 全链路已接入（阶段 26）**：真实合成实测跑通（中文 + 情感向量 + 经网关 multipart），
  修掉骨架 3 个必挂 bug（坑 26）；`/api/indextts/*` 透传、arbiter/preload/ResourceBudget 三服务化、
  前端「IndexTTS · 情感可控」页（8 维情感向量 / 情感参考音频 / 语速滑杆）全部就位；
  **本机暖态 RTF ≈ 2.2、常驻实测约 5.3 GB** —— 主力归属（vs 网易 2.0~2.5 / 4.9 GB）待用户听感 + 用时拍板
- **设置页已整体重排（阶段 26补2 + 26补3）**：五卡结构「模型与显存（开机预加载，提级到第一张）→
  本地服务（三运行时平铺，**每行都有连接开关**，GPT-SoVITS 高级配置行内展开）→
  云端合成 MiMo（按所选后端条件渲染：选 MiMo 才出现密钥区，选 GPT-SoVITS 只给指引）→ 合成偏好 → 站点信息」；
  「默认使用小米 MiMo」过时文案已清；网关新增 `services/runtime.ts` 托管 netease/indextts 进程生命周期
  （复用外部实例、关不掉时先卸模型并如实提示）
- **音色库已跨模型通用（阶段 26补7）**：数据迁到仓库根 `voicelib/`，网关原生 `/api/voicelib` 托管，
  GPT-SoVITS 停用时 IndexTTS / 网易 / 音色库页照常列音色与取音频（浏览器实测）；trainer 同读一份 +
  mtime 热重载（坑 27）；资源站入口常驻每页右上角
- **音色库页已是完整管理页（阶段 26补8）**：表格列表（名称/类型/语种/时长/大小/导入时间/状态）、
  搜索 + 三重筛选 + 五种排序 + 分页、单条精导弹窗与多文件批量快导（带进度与逐条失败原因）、
  跨页多选 + 批量删除 + 批量导出音频；编辑弹窗支持就地一键转写。纯前端改动，接口未动
- **显存监控小窗 + 导航/资源库收尾（阶段 26补9）**：ResourceBudget 头部「显存监控」→ 进程列表
  （pid/读数/大户高亮/占比条，WDDM 拿不到标「未知」），右键行可停止进程（网关三重护栏）；
  音色库独立成「跨模型共享」导航组、GPT-SoVITS 训练入口改名「音色微调训练」；
  顶栏「资源库」改为调研清单的滚动下拉面板，音色库页右侧 1/3 内嵌同一面板
- **GPT-SoVITS 辅助两页离线不塌页（阶段 26补10）**：训练/批量页删掉「connectionError 整页只留错误卡」的
  提前返回——现在服务停用时页面照常渲染，顶部提示卡 + 内嵌报错条（带「直接开启」与重试）；
  批量页的音色列表走网关共享库，离线也完整可用
- **RVC 变声结果听不了已修（阶段 27补3）**：根因是前端把服务端**绝对路径**`F:\...`交给 `resolveAudioUrl`，
  拼出必然 404 的 `/api/sovits/F:/...`，浏览器拿到零时长音频 → 播放器渲染成灰色禁用。
  新增 `pickArtifactUrl()`（`app/src/lib/sovits.ts`）收口「优先 urls、拦住盘符路径」，
  变声/翻唱两页都改走它；后端同步分支补 `urls`
- **DDSP-SVC 音色加载入口已补（阶段 27补4）**：`SingingConversionPage` 原来**只有一个下拉框**，
  无任何导入途径 —— 后端三个端点（load/unload/upload）其实早就齐了。新增 `SvcModelLibrary`
  组件（照 RVC 页契约）：拖拽或选文件**成对导入 `.pt` + `config.yaml`**、导入即热加载、
  列表标出「当前音色」、缺 config 的条目显示原因并禁用加载；后端补 `DELETE /v1/svc/models`
  （带归属边界检查，越界路径拒删）。顺带修掉 `describe_model()` 的 id 口径 ——
  原来取文件名 `model.pt` 的茎，导致下拉框里全是「model」且 id 不唯一，现改为优先取目录名。
  验证脚本 `.tmp/verify_svc_models.py` 25 项全绿；tsc / eslint / vite build 均通过
- **产出记录页已取代「历史记录」（阶段 32 / P2）**：三源合并 —— 服务端任务
  `GET /v1/jobs`（不带 kind，limit=200，实测 total=45）+ 本地模型 `/api/models/*`
  + 云端 IndexedDB（MiMo）。`collectTracks()` 提到 `@/lib/jobArtifacts.ts` 供 8 种 job kind 共用，
  并统一走 `resolveAudioUrl()` 补网关前缀（新坑 55）。三源各自取数各自报错：
  本地服务停着时只丢第一源，另两源照常显示。侧栏「历史记录」→「产出记录」
  （NavKey 仍是 `history`，`guides.ts` 的 FlowGuide 引用它）。
  **遗留**：浏览器人工走查未做（要跑一次变声 / 翻唱 / 训练各验一条）
- **体验收尾已做到一半（阶段 33 / P3）**：① 类别目录里**不构成模型的散文件**不再被静默丢弃 ——
  注册表新增 `listStrays()`，`GET /api/models?category=` 带出 `strays`，音色库面板列出路径 +
  大小 + 按类别规则生成的修复提示（实测 `no-primary` / `not-recognized` 两条分支都对）；
  ② **变声页 / 翻唱页的模型库**改走 `/api/models`（改名、删除走注册表，卡片补「旧位置 / 疑似重复」徽标）；
  ③ 顺带给 `ddsp-svc` 补了两个兼容旧根（否则换源会让已有音色消失，新坑 58）。
  **遗留**：GPT-SoVITS 的「零样本 / 微调权重」两段式选择器（阶段 34），以及换源后的真机加载验证
- **RVC 训练已与官方 WebUI 对齐（后端部分，阶段 29）**：`full`（全量微调）改前是必挂的 ——
  从不生成 `logs/<exp>/config.json`（`train.py` 无条件读）、底模写死本机没有的 32k、
  官方的 `-sw` 没传且 `-l`/`-c` 被写死。现在：config.json 按官方规则生成（40k 强制 v1）、
  底模按官方口径解析（**本机只有 40k**，32k/48k 按官方做法不带 `-pg/-pd` 并给警告）、
  命令与 `infer-web.py:571` 同构；新增 `preflight()` 预检（`/v1/vc/train` 入队前拦截非法组合）；
  filelist 补齐官方的两行静音样本（`logs/mute/` 本来就齐备）；训练过程逐 epoch + loss 上报。
  验证脚本 `.tmp/verify_vc_train_official.py` **35/35 全绿**。
  **前端入口已补齐（阶段 29补2，10.12）**：变声页独立「训练音色（RVC）」卡，LoRA / 全量两个 Tab；
  全量表单带**提交前预检**（防抖调 `/v1/vc/train/plan`，阻塞项红字、底模缺失只警告）。
  **遗留**：真机冒烟（要起服务走一遍）、MHA 排雷（T6）
- **GPT-SoVITS 已能选自训权重（阶段 34，10.12）**：合成页 `SovitsVoicePicker` 加「零样本（官方底模）/
  微调模型（自训权重）」两段式 —— 微调面板列 `/v1/weights` 的 GPT+SoVITS 对（`trained` 打「自训」徽标）、
  可一键**加载到显存**（`/v1/weights/load` 带 `eager`），`SynthesisPage` 按模式把 `gpt`/`sovits` 塞进
  `providerFields`（零样本走**删键**，避免与设置页默认值合并后残留旧权重）。
  **关键认知**：参考音频在两种模式下都必需（`synth.py::resolve_reference()` 拿不到就报错），
  两段式分的只是「官方底模 vs 自训权重」。**遗留**：真机冒烟
- **Irodori 推理链路已交付（阶段 30-2，10.13 BY ZCode）**：`/v1/catalog|warmup|unload|synth|speakers`
  五端点 + 网关 `/api/irodori/*` 透传 + runtime/arbiter/preload/resources 四处记账全接好；
  emoji 56 个 + 官方释义 45 条从上游源码 ast 解析；合成互斥 409；验证脚本 **31/31**
  （A 基础校验 21 + B 切句 4 + C0 准入 503 + D 网关 5）。**遗留**：C 段真机合成（6 句 / RTF≤0.25）
  被显存阻塞（桌面占用，空闲 3.2~3.9GB < 4700MB，准入 503 拦截行为已实测正确）；
  30-3 长尾护栏（当前 synth 无看门狗）、30-7 前端页/设置页 UI

### 验收标准

- `npm run typecheck` 通过
- `cd app && npx eslint src` 通过
- `npm run build` 通过
- `npm run sovits:check` 退出码 0
- `npm run netease:check` 退出码 0（Windows 上加 `--allow-missing-asr`，ASR 平台阻塞见坑 12）
- 浏览器打开 `http://localhost:5173` 三端口（5173 / 8787 / 9881）均就绪，页面无控制台报错

### 下一步（按优先级）

| 优先级 | 事项 | 备注 |
| --- | --- | --- |
| 高 | **产出记录页的浏览器人工走查（阶段 32 遗留验收）** | 跑一次 RVC 变声 + 一次翻唱 + 一次训练，三条记录都要出现在「产出记录」，且能内联播放、能复制本机路径。数据源已实测可用（`total=45`，音频地址加前缀 200），只差用户在浏览器点一遍 |
| 高 | **RVC 训练前端入口的真机冒烟（阶段 29补2 遗留）** | 前端已落地（独立训练卡 + 全量表单 + 提交前预检），typecheck / eslint / vite build 全过。只差起服务后在浏览器走一遍：变声页 → 训练音色 → 全量微调，**故意把采样率改成 v2 + 40k 看预检报红并禁用提交** → 改回 32k 提交一次小 epochs 训练 |
| 中 | **阶段 34 的真机冒烟（GPT-SoVITS 两段式选择器）** | 前端已落地：`SovitsVoicePicker` 的「零样本 / 微调权重」Tabs + 「加载到显存」热切换，`SynthesisPage` 按模式下发 `gpt`/`sovits`。要起服务走一遍：零样本合成 → 切微调选一对自训权重 → 加载到显存 → 合成 → **切回零样本确认不再带权重路径** |
| 低 | 变声 / 翻唱两页的**合成下拉**换源到 `/api/models` | 阶段 34 有意留后（无功能收益 + 要动已验证的转换主链路），建议与「变声 / 翻唱真机加载验证」同一轮做。方案见 `docs/VOICE-MODEL-MANAGEMENT-PLAN.md` §P3 |
| 中 | **变声 / 翻唱页换源后的真机加载验证（阶段 33 遗留）** | 已验证「引擎 id 集合 == 注册表主权重茎集合（13/13）」与数据源可用，但**没真跑 GPU 加载**。用户在页面上点一次「热加载」即可确认 |
| 低 | `ddsp-svc` 的两个旧根收口 | P1 的迁移脚本只做了 `rvc`；DDSP-SVC 的模型仍在 `trainer/.data/svc/models`（阶段 33 补的是只读兼容根） |
| **中** | ~~阶段 30-2：Irodori 推理链路~~ **已完成（10.13，30-1 + 30-2）**；下一小段 **30-3（长尾护栏）与 30-4（音色库多片段）可并行** | 30-3：服务端看门狗 + 自动降步重试一次 + `IRODORI_TIMEOUT`（当前 synth 无看门狗，撞 89s 长尾会占住请求到网关 240s 兜底）；30-4：`ref_clips/engine_tags/speaker_embeds` 扩展 + 网关/trainer 双向兼容 + UI 补录区。方案见 `docs/IRODORI-INTEGRATION-PLAN.md` §4.1 与 §9 |
| 中 | **Irodori 30-2 的 C 段真机合成补测** | `python .tmp/verify_irodori_infer.py`：显存 ≥4700MB 时 C 段自动执行（6 句 48kHz / RTF≤0.25 / 同 seed 确定 / 并发 409 / unload 归还）。当前桌面占显存（空闲 3.2~3.9GB），准入 503 拦截已实测正确，只差真合成 |
| 低 | Irodori 训练档权重下载 | `npm run irodori:weights -- --training`（bf16 基座 2.9GB）。**30-5 开工前必须**，30-2/30-3/30-4 不需要 |
| 高 | **决策：Irodori-TTS 是否接入（阶段 28 已给完整实测）** | 用户 10.08 明确 **Genie-TTS 与 dots.tts 弃用**（dots.tts 试点作废）。接力评估的 Irodori-TTS 是**真日语特化 + 真情感控制**：日语 only（ModernBERT-ja + 日语 DACVAE 48kHz），emoji 45 个实测能把 F0 从 223 抬到 271 / 压到 173，🤭 让静音帧 25→78（非语言人声），caption 拉开 F0 1.77 倍；**int4 + 6 步 sway 在本机 RTF 0.121，是 8.6GB 卡上最快的引擎**；训练侧 Speaker Inversion batch 8 实测 2.2 s/步、净占 ~4.4GB、3000 步 ≈1.8h 可一晚出结果。**代价三条**：仅日语、男声 emoji 几乎无效（我们库里就是男声）、Windows 依赖链要自己填坑（坑 33）。建议接入形态 = 跑 `Irodori-TTS-Server`（OpenAI 兼容 `POST /v1/audio/speech`，已暴露 caption/num_steps/speed/音色 CRUD）+ 网关 `/api/irodori/*` 透传 + arbiter/preload 记账 + **请求超时护栏**。详见 `docs/IRODORI-TTS-EVALUATION.md` §7 |
| 高 | 端到端实测阶段 6 的新 UI | **走查已做完一半**（阶段 23）：训练页 s2→s1 顺序 / 官方 hint / 完成卡 E-S 解释、设置页权重下拉（**实测出下拉显示空白，已修**，见坑 22）均浏览器验过；仍缺 ① 带 `slice` 阶段的任务来验切分结果面板（现有历史任务无一含切分），② 权重「加载所选权重」联动（本机 `GPT/SoVITS_weights_v2ProPlus/` 为空，没有训练产物可选） |
| 高 | **用实际合成对比网易 vs IndexTTS，决定主力** | **IndexTTS 已接入**（阶段 26），两套都可跑：网易稳态 RTF 2.0~2.5 / 常驻 4.9 GB；IndexTTS 暖态 RTF ≈ 2.2、显存被抢时 5~14 / 常驻实测 ≈ 5.3 GB。主力由**用户听感 + 使用测试**拍板；定完回填 preload 账本门槛与默认项 |
| 高 | 网易合成页的 UI 交互人工过一遍 | **已做完**（阶段 23）：上传、音色库选取（**实测必挂，已修**，见坑 21）、语种切换、回退按钮、显存不足报错均验过；**唯一没验到的是「合成成功 → 结果卡播放/下载」**，被显存准入拦死（见下一条），需要先把门槛口径拍板或手动腾显存 |
| 高 | **显存准入门槛按精度分档** | **已按用户拍板落地**（坑 24）：fp16 → 5120、fp32 → 6144，真源改为 `netease/app/tts_engine.py::required_vram_mb(precision)`。**需重启 9882 才生效**；另外这台机器 Windows 桌面常驻约 5 GB，5120 只是「不再按 fp32 的口径误拦」，真跑仍要用户先腾显存 |
| 中 | **真机验证拖拽导入的文件夹分支**（阶段 24） | 合成事件造不出 `FileSystemDirectoryEntry`，目录递归这条只能由用户从资源管理器真拖一个语料文件夹进训练页来确认（其余 13 处入口均已浏览器实测：过滤、回填、上传都正常） |
| 中 | 补网易合成页的**速度/质量档位选择器** | 阶段 22 半成品：后端三档（fast/balanced/quality）与 API 已可用，页面会固定用 balanced；补做点在 `NeteaseTtsPage` 合成内容卡里加 Select（选项来自 `catalog.tts.quality_presets`），并实测三档 RTF 与听感。**上次由用户叫停，重开需其点头** |
| 高 | **R2T2：先接离线（Windows 原生可行），流式再议** | 见坑 12 的修正：离线转写用 `qwen-asr` transformers 后端即可，不需 vLLM/WSL；流式被源码写死成 vLLM-only。已搁置的 WSL2 方案只服务于**流式**，不再是「ASR 整体」的前提 |
| 中 | fp16 音质人工确认 | 已出声（RMS 0.08~0.10），但没做过 A/B；若嫌糊，用 `NETEASE_TTS_PRECISION=fp32` 重试（需要 ≥8 GB 空闲显存） |
| 低 | 首条合成预热（实测 378 s） | 稳态 RTF 2.0~2.5，但冷启动第一条要几分钟。可考虑 warmup 时跑一句空合成把算子预热掉 |
| 低 | 观察新口径是否过严 | **已有结论，见上面「显存准入门槛是否按精度分档」与坑 24** —— 确实过严，正常用机状态下主服务开不起来 |
| 低 | 首条合成 378 s 复测 | 怀疑就是显存不足导致的抖动（当时只剩 ~300 MB 却被放行），口径修好后**在显存充足时复测**；若仍慢再考虑 warmup 里跑一句空合成预热 |
| ~~中~~ **已完成（阶段 26）** | ~~拍板：是否接入 IndexTTS-2.5~~ | 已全链路接入（`indextts/` :9883 + 网关透传 + 前端页 + arbiter/preload/ResourceBudget 三服务化）。当时的三个确认点结论：定位＝补充（导航组名「情感可控」不下主辅定论）；磁盘 5.11 GB 已就位；商用——用户裁决「不考虑商用」。**遗留待拍板**：准入门槛 3072 是否按实测常驻 5.3 GB 上调（见坑 26） |
| 中 | 决策：是否推进三模型整合 | `docs/` 已有 OmniVoice/VoxCPM2/Qwen3-TTS 可行性评估，待拍板；若推进，复用 netease 阶段验证过的「第二个运行时 + 无 supervisor 网关透传」模式 |
| 低 | 毛玻璃观感浏览器确认 | 阶段 5 遗留，多次预览被跳过 |
| 低 | BS-RoFormer 补 `.yaml` | 整合包有权重缺配置；补齐后模型列表自动变为可用（无需改代码） |

## 给下一会话的建议

- 先读本文件 + `PROGRESS.md`，再用搜索工具定位具体模块，**不要读全仓库**
- 改动前先看「已知坑」第 1、5、6 条（bat 编码、Python 3.9 限制、弹窗依赖）；
  动 `netease/` 前必看第 12~17 条（R2T2 平台阻塞、HF 缓存、hf-mirror、fp16、float32 写盘、显存口径）；
  动 `indextts/` 前必看第 26 条（显存画像、准入自锁 bug、warmup 网络探测、RTF 波动）；
  动任何结果栏前必看第 18 条（统一走 `useResultStack`）；动资源预估前看第 19 条（门槛值在服务
  端）；动任何上传/导入入口前看第 21、25 条（磁盘路径不能当 URL、拖拽统一走 `useFileDrop`）；
  动音色库（网关或 trainer 任一侧）前必看第 27 条（共写同一份 JSON，persist 前必须刷新）
- 每阶段结束更新 `PROGRESS.md`（六要素：已完成 / 未完成 / 改动文件 / 测试结果 / 风险 / 下一阶段入口）
- 聊天中只传：路径、摘要、diff、失败日志

> 上次文档更新时间：10.08 18:58 [BY Qoder]（阶段 27补1：RVC 变声 `_in_projection` NameError 修复，新增坑 29；同夜另有阶段 27补2 进程隔离收尾）> 本次文档更新时间：10.09 00:32 [BY Qoder]（阶段 28：Irodori-TTS 评估与本机推理/训练实测，新增坑 33；dots.tts 试点行按用户裁决改写为 Irodori 决策行）
> 本次文档更新时间：10.09 00:44 [BY Qoder]（阶段 27补4：DDSP-SVC 音色加载入口 + 导入/删除闭环；`describe_model` id 口径修正；新增坑 34/35）
> 本次文档更新时间：10.09 08:10 [BY Qoder]（阶段 27补6：用户主诉两个严重 bug —— ①显存预估「自己把自己检测成占用者」的重复扣账；②服务进程关不掉（只杀 child 导致外部实例漏网）。新增 `server/src/lib/processOwnership.ts`，`runtime.ts` / `sovits.ts` 的 `shutdown()` 均补端口反查一路；netease / indextts 的 `/health` 新增 `pid` 自报。新增坑 42–45）
> 本次文档更新时间：10.09 19:56 [BY Qoder]（阶段 31 / P1：音色模型统一管理「管得住」。新增 `/api/models` 的 import（流式落盘）/ rename（联动配套）/ update（sidecar 元数据）/ migrate（默认 dry-run）；前端加导入、批量重命名（带预览）、编辑弹窗、迁移确认；**已执行真实迁移**，18 个 RVC 模型收口到 `models/rvc/`，两个旧根清空，迁移后加载正常。修掉两个真 bug：路径边界检查把「根本身」判成越界、迁移按目录搬会卷走别的模型。新增坑 52–54）
> 本次文档更新时间：10.09 19:20 [BY Qoder]（阶段 30 / P0：音色模型统一管理「看得见」。新增网关 `modelRegistry.ts` + `/api/models/*`；RVC 改为「规范根 + 两个兼容旧根」的多根递归扫描，可见模型 5 → 18；`weight_root` 改指模型自身目录使**嵌套模型可加载**（改前 10/10 拼不出路径）；音色库页改多 Tab。方案见 `docs/VOICE-MODEL-MANAGEMENT-PLAN.md`。新增坑 49–51）
> 本次文档更新时间：10.10 02:26 [BY CodeBuddy]（阶段 29补1 完成：32k/48k 底模已下载到位——32k/40k/48k 三种采样率全可带底模训练，验证 37/37。阶段 29补2 进行中：训练卡已从音色工坊拆出，`FullTab` 未写，**工作区半成品未提交**）
> 本次文档更新时间：10.10 01:52 [BY CodeBuddy]（阶段 29：RVC 训练对齐官方 WebUI 的**后端部分** —— 生成 config.json（40k 强制 v1）、底模按官方口径解析（本机只有 40k，缺失则不带 -pg/-pd）、命令补 -sw 且 -l/-c 改为请求字段、preflight 预检在入队前拦截非法组合、filelist 补官方静音样本、训练逐 epoch + loss 上报。验证脚本 35/35 全绿。新增坑 58/59）
> 本次文档更新时间：10.10 01:17 [BY CodeBuddy]（阶段 33 / P3：未识别文件不再静默丢弃 —— 注册表新增 `listStrays()` + 面板新区块与修复提示；变声页 / 翻唱页模型库改走 `/api/models`（改名、删除走注册表）；`ddsp-svc` 补两个兼容旧根避免换源后模型消失。新增坑 57/58）
> 本次文档更新时间：10.09 23:41 [BY CodeBuddy]（阶段 32 / P2：产出记录页取代历史记录，三源合并 —— 服务端任务 + 本地模型 + 云端 IndexedDB；`collectTracks()` 提到 `@/lib/jobArtifacts.ts` 共用；产物 url 统一补网关前缀。新增坑 55/56）
> 本次文档更新时间：10.09 17:20 [BY Qoder]（阶段 27补7：用户主诉「左侧状态栏显示网易已就绪，但设置页显示未启动」。根因是**两套独立探活各自缓存**：侧栏只探 `/health` 不读 `enabled`，而 `npm run dev` 无条件起 netease、`enabled` 默认 false，导致「进程在跑 + 开关关着」成为开发模式常态。侧栏判定改为以 `enabled` 为唯一事实源；网关状态接口补「读时现探」；开关切换加 `service-enabled-changed` 广播。新增坑 46–48）
> 本次文档更新时间：10.13 01:55 [BY ZCode]（阶段 30-2：Irodori 推理链路 —— `/v1/catalog|warmup|unload|synth|speakers` 五端点 + 网关 `/api/irodori/*` 透传 + runtime/arbiter/preload/resources 四处记账；emoji 表从上游源码 ast 解析；验证 31/31，真机合成段被桌面显存阻塞待补测。新增坑 61/62）

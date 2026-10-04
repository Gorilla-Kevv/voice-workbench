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
| 模型 | GPT-SoVITS v2ProPlus（本地 GPU）、MiMo（云端 API）、Confucius4-TTS / R2T2（本地，需自行下载权重） |

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
| `app/src/pages/` | 13 个页面：通用合成、批量合成、音色设计、声音克隆、音色库、历史、训练、语音变声、歌声转换、语音转文本、网易合成、网易转写、设置 |
| `app/src/lib/providers/` | Provider 抽象：`mimo`（云端）、`gpt-sovits`（本地）、`selfhosted`（自定义） |
| `app/src/lib/netease.ts` | 网易模块客户端（`/api/netease/*`，含 NDJSON 流式转写解析） |
| `app/src/lib/sovits.ts` | 本地服务客户端（含 NDJSON 流式解析、音频地址映射） |
| `app/src/lib/glossary.ts` | 术语表（100 条），含 `term/definition/impact/example` |
| `app/src/lib/flowGuide.ts` | 官方推荐流程（8 步，固化官方原话与数值） |
| `app/src/components/features/` | `TermTip`（术语提示）、`FlowGuide`（流程指引）、`ResultPanel`、`ErrorBoundary` 等 |
| `server/src/routes/sovits.ts` | 反向代理（必须挂在 `express.json()` **之前**，否则 multipart / 流式透传失效） |
| `server/src/routes/netease.ts` | 网易模块透明反代（同上挂载顺序；**无 supervisor**，opt-in 不拉起） |
| `server/src/services/sovits.ts` | 托管 Python 服务：探活、解释器探测、日志环形缓冲 |
| `trainer/app/sovits/` | 与官方代码的直连层：`bootstrap`（定位+sys.path）、`catalog`（能力清单，唯一常量源）、`pipeline`（管线常驻）、`synth`（请求翻译）、`voices`（音色库） |
| `trainer/app/` | `training.py`（12 阶段编排）、`batch.py`、`inference.py`、`annotations.py`（清单读写）、`jobs.py`、`queue.py` |
| `trainer/tools/uvr_cli.py` | UVR5 非交互封装（调官方 `vr.py`/`mdxnet.py`，不改官方代码） |
| `netease/` | **第二个 Python 运行时**（py≥3.10）：`server.py`、`app/tts_engine.py`（Confucius4-TTS 直连）、`app/r2t2.py` + `app/r2t2_worker.py`（R2T2 子进程 worker，vLLM 需 main 环境）、`app/engine.py`（引擎互斥）。上游 API 漂移只改 `tts_engine.py` / `r2t2_worker.py` 两个薄文件 |

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

### 数据模型

- 前端契约：`app/src/types/sovits.ts`（与后端 `trainer/app/models.py` 一一对应）
- 网易契约：`app/src/types/netease.ts`（与后端 `netease/app/models.py` 一一对应，**改一边必改另一边**）
- **结果列表底座**：`app/src/hooks/useResultStack.ts` + `app/src/components/features/ResultStack.tsx`
  —— 所有模块的结果栏都走这两个；别在某个页面再自造单值结果 state（见坑 18）
- **资源预估底座**：`app/src/lib/resources.ts` + `app/src/components/features/ResourceBudget.tsx`
  —— 显存门槛**只从服务端取**（trainer `/v1/engines`、`netease /health`），前端只留兜底常量；
  内存由网关 `/api/health` 的 `host` 提供（见坑 19）
- 持久化：
  - 服务端：`trainer/.data/`（voices、outputs、jobs、experiments、uploads）
  - 浏览器：`localStorage`（设置）+ `sessionStorage`（训练/批量会话）+ IndexedDB（历史）

## 决策与坑

### 已做决策（含原因）

| 决策 | 原因 |
| --- | --- |
| 模型管线**常驻内存**，不每次 subprocess 调 CLI | 官方 `inference_cli.py` 每次重加载 4 个模型（约 1 分钟），本地试听不可用 |
| Python 服务生命周期交给**启动编排器**（concurrently），不由网关托管 | 网关在 dev 下被 `tsx watch` 重启，若托管 Python 会连带重启（改一行代码等 40 秒重加载） |
| 网关代理用 `node:http` + `pipe` 而非 `fetch` | 音频上传（multipart）与流式（NDJSON）需要原始字节流，pipe 天然支持 |
| 官方能力清单只写一处：`trainer/app/sovits/catalog.py` | 版本/语种/预训练权重映射散落各处会导致升级时漏改 |
| 错误响应必须带 `hint` | 只报 `message` 用户无从下手（实测：用户对着「不支持合成语种 undefined」完全懵） |
| 渲染错误用错误边界兜底 | React 渲染抛错会卸载整棵树 → 纯白页面，无信息 |
| 术语提示：桌面悬浮 / 触屏点击 | Radix Tooltip 在触摸设备体验不可靠（悬浮不存在） |
| 资源站入口：`ResourceSiteLink` 组件，三处（训练 / 变声 / 翻唱） | https://res.acgnai.top/ 提供角色语音数据集与 TTS·SVC 开源模型，正好补「训练没数据、变声没模型」两头；外部链接一律新窗口 + `noopener noreferrer` |
| 网易合成默认档位 **balanced**（非官方默认） | 官方默认 `num_beams=3` 会让 T2S 自回归跑三条候选（约 3 倍代价），是本机「慢」的主因之一；`balanced=(1,18)` 明显更快。档位定义在 `netease/app/routers/confucius.py::QUALITY_PRESETS`，要回官方默认选 `quality` |
| 网易模块**不进 Provider 抽象**、独立成 `netease/` 运行时 | 上游要求 py≥3.10 + torch≥2.5 + cu≥12.6，与 trainer 的 py3.9/torch2.0 互斥（`MODERN-TTS-FEASIBILITY.md` 已论证）；它是本地引擎不是云端 BYOK，塞进 Provider 抽象反而要特化密钥态 |
| R2T2 走**子进程 worker**（stdin/stdout JSON 行协议） | vLLM 引擎要求 `__main__` 环境启动（上游 README 明确警告）；worker 自成主进程规避，还能用 `NETEASE_R2T2_PYTHON` 独立解释器解决依赖冲突 |
| 网易两引擎**进程内互斥**，跨进程显存协调暂不做 | 8 GB 卡同时常驻 GPT-SoVITS + 1.3B LLM 本就不现实；先靠加载前空闲显存检查 + 明确报错兜底 |
| ~~网易模块 opt-in~~ **已改为主服务**（2026-10） | 免转写克隆 + 14 语种是日常合成的最优路径；`npm run dev` 现在会拉起它，网关仍**无 supervisor**（只转发不托管生命周期） |
| `dev:netease` 走 `--skip-if-missing` | 主服务也要照顾「没装权重」的机器：没 `netease/.venv` 或端口已被占用时安静跳过，不再崩掉一个 dev 窗格 |
| 网易不可用时**明确报错 + 给切换入口**，不自动回落 | 沿用现网哲学：不静默降级。页面给出「改用 GPT-SoVITS 批量合成」按钮，用户自己决定 |
| **跨运行时资源仲裁**：网关做仲裁器，只作用于自有服务 | trainer 与 netease 的引擎互斥互相看不见（跨进程）。仲裁器（`server/src/services/arbiter.ts`）在开跑前卸载另一端的常驻模型，并带心跳复检。**硬边界**：只向 `SOVITS_URL` / `NETEASE_URL` 两个回环地址发请求（非回环直接拒绝），不扫描进程、不 kill PID —— 用户要求的「绝不触及系统外进程」落在代码里 |
| **GPT-SoVITS 默认停用**，生命周期交给网关按需拉起（2026-10） | 8 GB 显存装不下两套常驻模型；报错里让用户「先关掉 GPT-SoVITS」却没有入口可以关，等于给了个做不到的建议。`npm run dev` 不再拉起它，用户在设置里开；代价是 `tsx watch` 重启网关时子进程一起回收（开关是开的会自动再拉起） |
| TTS 默认 **fp16**，且只转三个大户（T2S / S2A / w2v-bert） | 上游全 fp32 约 7.5 GB，8 GB 卡必 OOM；BigVGAN / CAMPPlus 只占 0.45 GB / 几十 MB，留 fp32 反而避开两处 dtype 冲突（见坑 15） |
| 上游推理配置**不直接用**，复制成绝对路径副本再交给上游 | `inference_config.yaml` 里 `tokenizer_path` / `w2v_stat` 是相对路径、按 CWD 解析；服务从项目根启动就会找不到 |
| 权重下载**自己写脚本**，不用 `huggingface-cli download --local-dir` | 上游只认 HF 缓存（坑 13），且需要按实测速度在 ModelScope / 代理 / 直连之间选路（坑 14） |

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

12. **R2T2 worker 的流式增量取值：已按官方 README 校准，但仍未在真机跑过**
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

20. **`express.json()` 挂载顺序现在管两条代理**
    `/api/sovits` 与 `/api/netease` 都挂在 `express.json()` 之前（index.ts 内有注释）。新增代理路由时
    再犯「multipart/NDJSON 被 body-parser 消费」的老错，症状是上传与流式全部 400/空体。

## 命令

| 用途 | 命令 |
| --- | --- |
| 安装依赖 | `npm run install:all` |
| **一键启动（推荐）** | 双击 `start.bat` |
| 开发模式 | `npm run dev`（并行起：本地模型服务 + 网关 + 前端） |
| 网易模块服务 | **已随 `npm run dev` 自动拉起**；单独重启用 `npm run dev:netease`（需先按 `netease/README.md` 建 venv + 下权重） |
| GPT-SoVITS 服务 | **默认不启动**（显存留给主服务）；要用训练 / 批量 / 变声 / 翻唱时到**设置页**打开；想随 dev 一起起用 `npm run dev:all` |
| GPT-SoVITS 启停接口 | `GET/POST /api/sovits/service`（`{"enabled":true}`）；开关存在 `server/.data/sovits-service.json` |
| 网易模块体检 | `npm run netease:check`（或 `python scripts/preflight_netease.py [--allow-missing-asr]`） |
| 网易权重下载 | `npm run netease:weights [-- --proxy http://127.0.0.1:7890] [-- --include-r2t2]` |
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
| 高 | 端到端实测阶段 6 的新 UI | 跑一轮真实训练：确认 s2→s1 顺序、切分结果面板、设置页权重加载联动；`step_stages()` 已用真模块断言过，浏览器侧未测 |
| 高 | 网易合成页的 UI 交互人工过一遍 | **接口链路已验完**（四端口在跑，网关透传 `/api/netease/*` 正常，经代理合成 200）；剩下上传参考音频、音色库选取、跨语种切换、结果卡播放/下载的手感 |
| 中 | 补网易合成页的**速度/质量档位选择器** | 阶段 22 半成品：后端三档（fast/balanced/quality）与 API 已可用，页面会固定用 balanced；补做点在 `NeteaseTtsPage` 合成内容卡里加 Select（选项来自 `catalog.tts.quality_presets`），并实测三档 RTF 与听感 |
| 高 | **拍板：装不装 WSL2 跑 R2T2** | 勘察已完成（WSL 2.7.14 就位、驱动 572.61 支持直通、Docker 未装），方案与成本见 `netease/README.md`「R2T2 落地方案」：**推荐只把 worker 放进 WSL**（TTS 不动），代价是 10~15 GB 磁盘 + 一次管理员权限。代码侧准备已做好（未配置时零影响）。装之前需要你点头 |
| 中 | fp16 音质人工确认 | 已出声（RMS 0.08~0.10），但没做过 A/B；若嫌糊，用 `NETEASE_TTS_PRECISION=fp32` 重试（需要 ≥8 GB 空闲显存） |
| 低 | 首条合成预热（实测 378 s） | 稳态 RTF 2.0~2.5，但冷启动第一条要几分钟。可考虑 warmup 时跑一句空合成把算子预热掉 |
| 低 | 观察新口径是否过严 | trainer 准入改用 nvidia-smi 后判定更严格，若出现「明明没跑别的却被拦」，回来看门槛数值是否需要按真实口径重新校准 |
| 低 | 首条合成 378 s 复测 | 怀疑就是显存不足导致的抖动（当时只剩 ~300 MB 却被放行），口径修好后**在显存充足时复测**；若仍慢再考虑 warmup 里跑一句空合成预热 |
| 中 | 决策：是否推进三模型整合 | `docs/` 已有 OmniVoice/VoxCPM2/Qwen3-TTS 可行性评估，待拍板；若推进，复用 netease 阶段验证过的「第二个运行时 + 无 supervisor 网关透传」模式 |
| 低 | 毛玻璃观感浏览器确认 | 阶段 5 遗留，多次预览被跳过 |
| 低 | BS-RoFormer 补 `.yaml` | 整合包有权重缺配置；补齐后模型列表自动变为可用（无需改代码） |

## 给下一会话的建议

- 先读本文件 + `PROGRESS.md`，再用搜索工具定位具体模块，**不要读全仓库**
- 改动前先看「已知坑」第 1、5、6 条（bat 编码、Python 3.9 限制、弹窗依赖）；
  动 `netease/` 前必看第 12~17 条（R2T2 平台阻塞、HF 缓存、hf-mirror、fp16、float32 写盘、显存口径）；
  动任何结果栏前必看第 18 条（统一走 `useResultStack`）；动资源预估前看第 19 条（门槛值在服务
  端）
- 每阶段结束更新 `PROGRESS.md`（六要素：已完成 / 未完成 / 改动文件 / 测试结果 / 风险 / 下一阶段入口）
- 聊天中只传：路径、摘要、diff、失败日志

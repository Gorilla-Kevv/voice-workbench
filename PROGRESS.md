# PROGRESS

> 按 `token-efficient-agent-workflow` 规范维护。每阶段独立、可验证、可交接。

## 阶段 1 — 本地化改造与架构搭建

- **已完成**
  - 移出全部线上部署产物（Dockerfile、cloudbaserc.json、deploy 脚本、部署文档）
  - 三层架构落地：前端 / Node 网关 / Python 模型服务
  - Python 服务改为**直接 import 官方管线**（模型常驻内存 + 权重热切换）
  - `server.py` 解释器自举（无 torch 时用整合包 `runtime/python.exe` 重新执行自己）
  - 训练流水线：12 阶段，全部调用官方脚本
  - 音色库、批量合成（含 ZIP + JSON/CSV 清单）、任务系统（进度/日志/取消）
  - 前端 Provider 抽象，MiMo 与 GPT-SoVITS 并存

- **未完成**：UVR5 人声分离（当时判断为「官方只有 Gradio，无法集成」—— 该判断后续被推翻）

- **改动文件**：`app/` 全量重写、`server/src/`、`trainer/` 全量重写、`package.json`、`scripts/`

- **测试结果**：真实训练跑通并产出权重（`final-verify_e1_s99.pth`，164.8MB）；端到端合成经网关代理成功

- **风险**：整合包路径依赖强；`sys.path` 与 `cwd` 敏感

- **下一阶段入口**：排查「页面白屏」与启动体验问题

---

## 阶段 2 — 启动体验与日志

- **已完成**
  - `start.bat` 一键启动（自动装依赖 + 环境体检 + 打开浏览器）
  - 修复 bat 编码导致的 cmd 解析错位（改 GBK/ANSI、去掉 `chcp 65001`）
  - 网关日志降噪：Python 输出不再逐行包成 JSON debug，改为就绪摘要
  - 侧栏连接状态**轮询**（前 90s 每 3s，之后 30s，就绪后 60s 复查）+ 三态（正在连接 / 已就绪 / 未连接）
  - Python 服务生命周期交给启动编排器（避免 `tsx watch` 重启连带重启模型服务）
  - 前端错误边界（白屏 → 可读错误卡片）

- **未完成**：无

- **改动文件**：`start.bat`、`scripts/`、`server/src/services/sovits.ts`、`server/src/index.ts`、`app/src/App.tsx`、`app/src/main.tsx`、`app/src/components/features/ErrorBoundary.tsx`、`app/src/components/layout/AppShell.tsx`

- **测试结果**：全新浏览器会话控制台零错误；冷启动期间显示「正在连接」而非「未连接」

- **风险**：`useIsMobile` 基于宽度断点，平板/触屏笔记本可能判断不准

- **下一阶段入口**：批量合成结果在切换页面后丢失

---

## 阶段 3 — 状态管理与数据修复

- **已完成**
  - 批量合成与训练页会话保留（模块级 + sessionStorage，跨页面、跨刷新）
  - 恢复轮询：回到页面时若任务仍在跑，接着跟踪进度
  - 防重复提交（切回页面后按钮不会被错误启用）
  - 音色库语种脏数据修复（`prompt_lang: "undefined"`），自动纠正并落盘
  - 版本大小写归一化（前后端双向）
  - 弹窗去重（依赖改为具体 `controller.error`）

- **未完成**：无

- **改动文件**：`app/src/pages/BatchPage.tsx`、`app/src/pages/TrainingPage.tsx`、`trainer/app/sovits/voices.py`、`trainer/app/sovits/catalog.py`、`trainer/app/sovits/pipeline.py`、`trainer/app/training.py`、`app/src/lib/providers/gpt-sovits.ts`、`app/src/App.tsx`

- **测试结果**：用户验证通过；音色库脏数据已纠正为 `zh`，合成成功（3.34s 音频）

- **风险**：sessionStorage 写入失败时静默降级为「仅当前会话内」

- **下一阶段入口**：对照官方推荐流程审查达标情况

---

## 阶段 4 — 官方流程对齐

- **已完成**
  - UVR5 人声分离（推翻原判断：官方 `vr.py`/`mdxnet.py` 可直接调用）
    - `trainer/tools/uvr_cli.py` 非交互封装，不改官方代码
    - 模型清单从 `uvr5_weights` 扫描，BS-RoFormer 缺 `.yaml` 标为不可用
    - 实测：HP2 处理 5.4s 音频，产出人声 + 伴奏双轨道
  - 切分参数界面化（8 个滑块，默认值与官方 WebUI 一致）
  - ASR 精度选择（按后端钳制：FunASR 仅 float32 且参数官方未接入；Faster Whisper 才生效）
  - 预训练权重路径自定义（GPT / SoVITS / 判别器，路径错误在预检阶段就报）
  - 标注校对（数据层 `annotations.py` + 三个 API + 界面：试听 / 改文本 / 标记丢弃 / 保存回清单）
  - 版本下拉标注「官方推荐」（v2Pro / v2ProPlus）

- **未完成**：训练顺序（仍是 s1→s2，官方建议 s2→s1）

- **改动文件**：`trainer/tools/uvr_cli.py`、`trainer/app/sovits/catalog.py`、`trainer/app/training.py`、`trainer/app/models.py`、`trainer/app/annotations.py`、`trainer/app/api.py`、`app/src/pages/TrainingPage.tsx`

- **测试结果**：预检打印的真实命令确认参数全部落位；`uvr` 实跑成功；`asr` 阶段 `-p int8` 正确传入

- **风险**：UVR5 依赖整合包内模型文件；BS-RoFormer 缺配置不可用

- **下一阶段入口**：术语提示与流程指引

---

## 阶段 5 — 术语与引导体系

- **已完成**
  - 术语表 `glossary.ts`：71 → **100 条**，每条「它是什么」+「它影响什么」+ 可选示例
  - `TermTip` 组件：桌面悬浮/键盘聚焦、触屏点击弹出；未收录术语不加虚线不弹空框
  - 毛玻璃外观（半透明 + `blur(12px)` + `@supports` 降级 + 主题自适应）
  - `flowGuide.ts` + `FlowGuide.tsx`：官方推荐流程 8 步，贴窗口右边缘，鼠标移到右侧展开；触屏点击开合
  - 页面接入点累计 **74 处**
  - 覆盖三个新页面（语音识别 / 语音变声 / 歌声转换）的术语

- **未完成**：无

- **改动文件**：`app/src/lib/glossary.ts`、`app/src/lib/flowGuide.ts`、`app/src/components/features/TermTip.tsx`、`app/src/components/features/FlowGuide.tsx`、8 个页面文件

- **测试结果**：`tsc` / ESLint / `vite build` 全部通过；构建产物确认毛玻璃相关类正确生成（含 `-webkit-` 前缀与 `@supports` 降级）

- **风险**：毛玻璃实际观感未经浏览器预览确认（多次预览被跳过）

- **下一阶段入口**：见 `HANDOFF.md` 的「下一步」清单（训练顺序、权重下拉、切分结果展示）

---

## 阶段 6 — 官方建议对齐收尾（HANDOFF 下一步清单清零）

- **已完成**
  - **训练顺序改为「先 SoVITS 后 GPT」**（官方 WebUI 中 SoVITS=1Ba、GPT=1Bb）
    - 后端：`STAGES` 元组与 `plan()` 步骤组装均改为 s2 → s1，`step_stages()` 自动跟随
    - 前端：流水线预览 Badge、阶段开关区同步换序，开关 hint 注明官方顺序
    - **「训完 SoVITS 重新提取语义 Token」评估结论：不需要**。`3-get-semantic.py`
      用 `pretrained_s2G`（官方底模）当 VQ 编码器提取语义 Token，官方 WebUI 与本管线
      传的都是底模路径，GPT 训练不依赖 SoVITS 微调产物 —— 两种训练互不依赖，
      先后顺序只是「尽早验证语料」的工程考量。结论已写入 `training.py` 模块注释
  - **权重选择下拉 UI（设置页）**：只读的权重卡片改为 `WeightsPanel`
    - GPT / SoVITS 两组下拉：训练产物按时间新→旧排列，附体积；官方底模作为零样本选项
    - 「加载所选权重」调 `/v1/weights/load`（eager 预热），完成后重新探测刷新「当前生效」
    - E/S 命名解释落在选择器旁边：「e = 轮数、s = 步数，一般选 e 最大的」
    - 训练完成卡片的指引文字同步更新（设置 → 推理权重）
  - **切分结果盘点**：官方要求「按时长从大到小排查，删掉 >15 秒的超长条」，现由系统代劳
    - 后端：slice 阶段完成后 `_summarize_slice()` 即时盘点（时长降序、>15s 判定），
      并进任务产物（跑着就能看，不等终态）；日志给出超长条清单
    - 前端：`JobDetail` 新增切分结果面板，超长条琥珀色高亮 + 警示；明细上限 200 条（按最长优先）
  - **合成页跨语言提示**：`SovitsVoicePicker` 常驻说明「参考音频语种（跟随音色库标注）
    ≠ 合成文本语种（本页下拉），两者可以不同」；不一致时显示跨语言合成提示卡
  - **标注校对文案**：改为「官方认为逐条校对非常耗时、收益有限，可以跳过；
    但合成结果出现怪异读音时，回来改对应条目是最有效的排查手段」
  - **删除 `app/src/lib/补词方式.txt`**（HANDOFF 清单项）
    - ⚠️ 事后核实：文件并非空文件（约 199 字节，`wc -l` 显示 0 是因为没有换行符）。
      按 HANDOFF 指示删除时内容未再确认，且未入 git，无法找回。若里面还有需要的信息，需人工补录
  - **USER-GUIDE 新增「14. 全链路测试流」**（应用方要求，供验收/回归测试）
    - 三条完整数据链：14.1 GPT-SoVITS（零样本→训练→权重切换→批量）、
      14.2 语音变声 RVC（权重→音色三来源→变声→A/B）、
      14.3 歌声转换 DDSP-SVC（权重→.pt 音色入位→分离缓存→翻唱向导三件套）
    - 每条 = 数据链总览 + 前置条件 + 主链路表（逐步「预期」）+ 分支场景表
    - 关键事实核对过代码：RVC 首个音色只能导入（工坊依赖已有底模）；缺 .index 时检索自动跳过；
      SVC 音色 = .pt+config.yaml 放 `.data/svc/models`（页面无上传 UI，API 可导入）；
      分离 `off` 时产物无伴奏/混音标签；BS-RoFormer 在分离引擎缺 .yaml 时用内置默认配置兜底
      （与训练页 UVR5 列表口径不同，8.1 已改注区分）；LoRA 产物是折入适配器的成品 .pth
    - 7.2/7.4/7.5 加了指向对应测试流的交叉引用

- **未完成**：无

- **改动文件**：`trainer/app/training.py`、`app/src/pages/TrainingPage.tsx`、`app/src/pages/SettingsPage.tsx`、`app/src/components/features/SovitsVoicePicker.tsx`、`app/src/types/sovits.ts`、`docs/USER-GUIDE.md`

- **测试结果**：`npm run typecheck` 通过；ESLint（4 个改动文件）通过；`npm run build` 通过；
  `npm run sovits:check` 退出码 0；Python `ast.parse` 通过；
  用真模块断言 `step_stages()`：全勾选/只勾 GPT/v2（无 sv）三种组合下 s2 均先于 s1、
  阶段集合与勾选一致

- **风险**：切分盘点逐文件测时长，超大语料（上千段）会增加一次性耗时（在切分本身之后，可接受）；
  新 UI（权重面板、切分面板、跨语言提示）尚未经浏览器实测

- **下一阶段入口**：跑一轮真实训练做端到端验收（新顺序 + 切分面板 + 权重面板联动）；
  或按 `docs/` 里三模型整合可行性评估推进决策

---

## 阶段 7 — 网易模块接入（Confucius4-TTS + Confucius4-R2T2，双模型共存）

- **已完成**
  - **决策与对比文档** `docs/NETEASE-INTEGRATION.md`：
    - 网易 vs 现有（TTS：Confucius4-TTS vs GPT-SoVITS/MiMo；ASR：R2T2 vs FunASR/Whisper）逐维对比；
    - 共存策略：GPT-SoVITS 保持训练+轻量推理首选、MiMo 保持云端零配置、网易补
      「免参考文本克隆 + 14 语种跨语种 + 情感迁移 + append-only 真流式 ASR」；
    - 结论延续 `MODERN-TTS-FEASIBILITY.md`：第二个 Python 运行时（py≥3.10 vs 现有 3.9），不动 `trainer/` 一行
  - **后端** `netease/`（15 个 py 文件，端口 9882，opt-in）：
    - `server.py`（--check 体检）+ `app/{config,errors,models,engine,hardware,api}.py`
    - `tts_engine.py`：Confucius4-TTS 直连（lazy import confuciustts，14 语种、免转写克隆、产物落盘 .data）
    - `r2t2.py` + `r2t2_worker.py`：R2T2 子进程 worker（vLLM 需 main 环境；stdin/stdout JSON 行协议；
      支持独立解释器 `NETEASE_R2T2_PYTHON` 解决依赖冲突）
    - 引擎互斥（TTS/ASR 不同时持卡，默认抢占让位）、显存准入检查（不静默落 CPU）
    - 错误契约与全局一致（`{ok, error:{code,message,retryable,hint}}`）
    - **无权重/无 torch 也能启动**，health/catalog 如实报告缺失项
  - **网关**：`/api/netease` 透明反代（挂在 `express.json()` 之前）；`/api/health` 增加 netease 摘要
    （带缓存的 TCP 探活；`optional: true` 标记「未启动是常态」）
  - **前端**：
    - `types/netease.ts` + `lib/netease.ts`（含 NDJSON 流式转写逐行解析与 abort）
    - `NeteaseTtsPage`：参考音频三来源（上传 / **复用现有音色库**（只取音频，逐字文本不参与））+ 14 语种 + 引擎管理卡
    - `NeteaseAsrPage`：快速 / 流式两种模式（流式 append-only 逐字出字、可取消）+ 时间戳 + 引擎管理卡
    - 侧栏新增「网易模块」分组 + 两张四态状态卡（offline 文案是「未启动（可选模块）」而非故障语气）
    - App.tsx 独立探活循环（3s/30s/60s 节奏，与 sovits 同常数）
  - **工程化**：`npm run dev:netease` / `netease:check`（`scripts/netease.mjs` 跨平台选解释器）、
    `scripts/preflight_netease.py`（解释器/torch/CUDA/依赖/权重/端口/磁盘逐项体检）、
    `netease/README.md`（60 GB 磁盘预算与逐步安装指南）、.gitignore 补 venv/.data
  - 文档：USER-GUIDE 新增「15. 网易模块」（定位 / 启用步骤 / 测试流 / 分支场景 / 许可提示）+ 命令与端口附录

- **未完成**（登记在 NETEASE-INTEGRATION.md §6，均为有意延后）
  - 权重（TTS 约 54 GB）未下载，端到端推理未实测；R2T2 worker 流式增量字段名需实测校准（防御式处理已就位）
  - TTS 流式合成（需上游 vLLM 后端）、麦克风实时 ASR、统一历史记录接入、跨运行时显存仲裁

- **改动文件**：`netease/`（新增 15 文件）、`server/src/{config/index.ts,index.ts,routes/index.ts,routes/netease.ts}`、
  `app/src/{App.tsx,types/{index,sovits,netease}.ts,lib/netease.ts,pages/Netease{Asr,Tts}Page.tsx,components/layout/AppShell.tsx}`、
  `package.json`、`scripts/{netease.mjs,preflight_netease.py}`、`.gitignore`、`docs/`、`HANDOFF.md`

- **测试结果**：`npm run typecheck` 通过；新增/改动文件 ESLint 通过（存量 ui/hooks 文件有 13 个与本次无关的
  lint 错误，未触碰）；`npm run build` 通过；Python `ast.parse` 全部通过；
  netease 服务无 torch/无权重冷启动冒烟通过（health/catalog/错误契约正确）；
  网关双态冒烟通过（netease 下线 → 结构化 503；上线 → 透传 + health reachable=true）；
  浏览器实测（1280×720，深色主题）：侧栏「网易模块」分组、两页完整渲染、
  引擎卡缺失项明细、模式切换与解码块选择器、探活「待补齐」状态卡全部正常

- **风险**：8 GB 显存对 1.3B TTS 属压线（估算 4~6 GB，准入门槛 6 GB），实测前不能保证可用；
  R2T2 与 TTS 依赖可能需要分 venv（worker 已支持独立解释器）；两上游均新发布，API 可能漂移
  （接入面已收窄到两个薄文件）

- **下一阶段入口**：按 `netease/README.md` 装环境 + 下载权重做端到端实测（HANDOFF「下一步」高优先级项）；
  或推进 `docs/MODERN-TTS-FEASIBILITY.md` 的三模型决策（复用本阶段验证的运行时模式）

---

## 阶段 8 — 网易模块装环境 + 端到端实测（TTS 跑通 / ASR 卡在平台）

- **已完成**
  - **环境**：py3.12 venv（`netease/.venv`）+ torch **2.7.0+cu126**（按上游 pin；PyPI 上的 torch 是 CPU 版，
    必须走 `download.pytorch.org/whl/cu126`）+ 上游 `requirements.txt`（过滤掉里面会覆盖 CUDA torch 的两行）
    + `pip install -e models-src/Confucius4-TTS`
  - **权重**：新增 `scripts/download_netease_weights.py`（`npm run netease:weights`）。
    ModelScope 优先、HF 经 `--proxy` 兜底；按上游实际取用方式分流 ——
    T2S/S2A/CAMPPlus 铺进 HF 缓存（真实 etag + snapshots + refs），w2v-bert 与 BigVGAN 落本地目录。
    **实际下载 5.4 GB（不是早期文档估的 54 GB）**
  - **接入修正**（都是实测逼出来的）：
    - 权重探测改为查 **HF 缓存**（`_hf_cached()`）+ 本地目录，不再查 `models/Confucius4-TTS/checkpoints`
    - 上游配置不再直接使用：`_materialize_config()` 复制一份把 `tokenizer_path` / `w2v_stat` 改成绝对路径，
      并把 w2v-bert / BigVGAN 指到本地目录（消掉 CWD 依赖，也让两个 `from_pretrained` 离线可用）
    - **`_enable_fp16()`**：fp32 全量约 7.5 GB 必 OOM，只转三个大户并对齐上游五处硬编码 fp32 输入
      （w2v `input_features`、semantic_mean/std、参考 mel、CAMPPlus 风格向量、
      `DummyPositionEmbedding` 里写死的 `dtype=torch.float32`）。`NETEASE_TTS_PRECISION` 可切回 fp32
    - 写盘前统一 `np.asarray(..., dtype=np.float32)`（fp16 下 soundfile 会报 `Format not recognised`）
    - 修两处 `probe_install()["package"]["missing"]` 的 KeyError（导入成功时没有这个键）：
      `server.py --check` 与 `/v1/confucius/warmup` 都是 500，之前没被触发过
    - **R2T2 流式字段按官方 README 校准**：增量文本在 `streaming_transcribe` **返回值**的第二个元素
      （不是 `state`），定稿是 finish 之后读 `state.text`；新增 `_coerce_text()`
  - **体检**：`npm run netease:check` 与 `scripts/preflight_netease.py --allow-missing-asr` 均退出码 0
  - **端到端实测**（RTX 4060 Laptop 8 GB，后台另有程序占约 2.7 GB）：
    - warmup 约 60~70 s；常驻 + 推理峰值显存约 **4.9 GB**
    - zh：2.57 s 音频 / 6.31 s（RTF 2.46）；en：4.11 s 音频 / 8.05 s（RTF 1.96）；RMS 0.077~0.097，无 NaN
    - **首条要 378 s**（算子 + allocator 预热），第二条起进入稳态

- **未完成（有据可查的阻塞，不是偷懒）**
  - **R2T2 在 Windows 上装不了**：PyPI 上 `vllm`（0.30.0）只有 Linux wheel；r2t2 的 llama.cpp 后端
    也只有 `libggml*.so` 与 `cpython-312-x86_64-linux-gnu` 产物。`pyproject.toml` 的 classifier 就是
    `Operating System :: POSIX :: Linux`。→ 要跑只能 WSL2 / Docker（`qwenllm/qwen3-asr`）
  - 因此**流式转写的实测校准仍未完成**：代码已按官方 README 校准，但没有真机验证
  - TTS 流式合成（需上游 vLLM 后端）、麦克风实时 ASR、统一历史记录接入、跨运行时显存仲裁（沿用阶段 7）

- **改动文件**：`netease/app/{config,tts_engine,r2t2_worker}.py`、`netease/app/routers/netease.py`、
  `netease/server.py`、`scripts/{download_netease_weights.py,preflight_netease.py,netease.mjs}`、
  `package.json`、`app/src/{types/netease.ts,pages/NeteaseTtsPage.tsx}`、
  `netease/README.md`、`docs/{NETEASE-INTEGRATION.md,USER-GUIDE.md}`、`HANDOFF.md`

- **测试结果**：`npm run netease:check` 退出码 0；`preflight_netease.py --allow-missing-asr` 退出码 0；
  `/health` 的 `engines.confucius_tts.installed=true` 且权重 5 项全就位；
  真跑 3 条合成（2 条 200 + 1 条写盘 bug 已修）；`npm run typecheck` 通过
- **浏览器链路实测（续）**：`npm run dev` 起 8787/5173 + 9881/9882 四端口；
  网关 `/api/health` 的 `netease.reachable=true`，`/api/netease/health` 透传回
  `installed=true / missing=0`（→ TTS 状态卡变绿）、`r2t2.installed=false`（→ ASR 卡如实显示待补齐）；
  **经网关代理**再合成一条：200，4.99 s 音频 / 24.36 s（RTF 4.88，当时显卡只剩 161 MB 空闲、被别的程序挤占）

- **风险**：fp16 音质只做了「有声 + 无 NaN」的粗校验，没做 A/B；首条预热的 378 s 体验很差；
  8 GB 卡必须关掉其它占显存的程序才稳（准入检查卡在 6 GB）
- **新发现的坑（坑 17）**：`check_vram()` 用的是 `torch.cuda.mem_get_info`，**与 nvidia-smi 口径不一致**
  —— 实测 nvidia-smi 报空闲 2.6 GB 时 warmup 仍被放行且模型真的加载成功了（加载后只剩 161 MB 空闲）。
  后果不是崩，是**推理期被挤占**：同一条合成在显存充裕时 RTF 2.0~2.5，挤占时掉到 4.88。
  要不要改用 nvidia-smi 采样做准入，待定（改之前先确认 Windows WDDM 下哪个口径更接近真实可用量）

---

## 阶段 10 — 各模块结果栏改「多条结果列表」（不再互相覆盖）

- **起因**：每个页面只用单值 state 存结果，合成/转写下一条就把上一条冲掉
  （`useSynthesis` 里还会顺手 `revokeObjectURL`，连旧音频地址一起回收）。
  用户明确要求：即使历史记录能找回，主界面也要**直接展示多条**。

- **已完成**
  - **共用底座**
    - `app/src/hooks/useResultStack.ts`：结果栈 `push / remove / clear`，默认上限 12 条，
      三层保留 —— React state → **模块级内存缓存**（`App.tsx` 按导航键条件渲染页面，
      切走就卸载，纯 state 会归零）→ 可选 `sessionStorage`（文本/服务端路径类结果刷新后仍可回看）
    - `app/src/components/features/ResultStack.tsx`：列表壳 —— 最新一条默认展开、其余折叠，
      每条带序号 / 时间 / 标题 / 摘要，支持单条删除与「清空（二次确认）」；
      用 `overrides` 覆盖表判定展开，避免 effect 内 setState
  - **逐模块接入**
    - `useSynthesis`：`results: SynthesisResult[]` + `removeResult/clearResults`，
      **只有淘汰或显式删除才 revoke**（`result` 仍返回最新一条，兼容旧调用方）
    - `ResultPanel`：`result` → `results`，单条展示体抽成 `ResultBody`，套 `ResultStack`
    - 通用合成 / 音色设计 / 声音克隆：传 `controller.results` + 删除/清空回调
    - 网易合成：每条存 `{result, audioUrl, text, refLabel}`，删掉原来「换结果就回收旧 URL」的逻辑
    - 网易转写 / ASR 转写：文本结果可 JSON 化 → 走 `sessionStorage` 持久化；
      流式模式的实时文本单独一块显示，定稿才入栈
    - 语音变声：每条存**源音频的独立快照地址**（预览那条会随下次选文件被回收），A·B 对比可回看
    - 歌声转换：翻唱按「批」入栈（歌名 + 音色 + 多轨），「只做分离」同样入栈
    - 批量合成：`rows` 单值 → `BatchRound[]`（一次「开始生成」= 一个批次），
      新批次追加、旧批次保留；批次结果从 `retained.rows` 迁到 `batch-rounds`

- **未完成**
  - 结果列表只保持在当前会话（Blob 类结果刷新后必然失效，这是浏览器限制，不是没做）
  - 「历史记录」页与本次会话列表尚未打通（历史仍是 MiMo 三页的 IndexedDB 通道）

- **改动文件**：新增 `app/src/hooks/useResultStack.ts`、`app/src/components/features/ResultStack.tsx`；
  改 `app/src/hooks/useSynthesis.ts`、`app/src/components/features/ResultPanel.tsx`、
  `app/src/pages/{SynthesisPage,VoiceDesignPage,VoiceClonePage,NeteaseTtsPage,NeteaseAsrPage,AsrPage,VoiceConversionPage,SingingConversionPage,BatchPage}.tsx`

- **测试结果**：`npm run typecheck` 通过；改动文件 eslint 全通过（`src` 全量 lint 的 13 处报错
  来自 `useSettings.ts` / `direct-api.ts` 等**本轮没碰**的文件，属既有问题）；`npm run build` 通过

- **风险**
  - 内存：默认每页留 12 条；MiMo 多段结果按段持有 Blob，长文本多段时占用会上去（已按条数封顶）
  - `useResultStack` 的模块级缓存用 `storageKey ?? useId()` 做键，页面若不传 `storageKey`，
    键位依赖组件在树中的位置（目前都传了 `storageKey`）
  - 批量页旧的 `retained.rows` 数据不会被迁移（格式变了），老会话读进来直接忽略

- **下一阶段入口**：浏览器逐个模块人工点一遍（合成两次看旧的是否还在、展开/删除/清空是否顺手）；
  决定是否把会话列表与「历史记录」页合并展示

- **下一阶段入口**（阶段 9 遗留）：人工确认侧栏状态卡缩小后的观感（是否要保留手动展开入口）
  —— 接口链路已全部验过，剩下的是 UI 交互手感；拍板 R2T2 走 WSL2 还是 Docker；
  决定 `check_vram()` 是否改成 nvidia-smi 口径

---

## 阶段 9 — 侧栏状态卡精简（缩小 + 加载完自动隐藏）

- **已完成**
  - `AppShell` 里 7 张状态卡改成统一数据驱动（`StatusCard[]`），MiMo 云端卡与各引擎卡共用同一个 `LinkCard`
  - **缩小一档**：卡片 `p-2.5 text-xs` → `px-2 py-1.5 text-[11px]`，图标 3.5 → 3，间距 `gap-2/space-y-2` → `1.5`，
    容器 `pb-5` → `pb-4`
  - **自动隐藏**：探活 / 加载期间整列可见；一旦没有 `checking` 的卡片，只保留需要用户动手的
    （待补齐 / 未配置 / 未连接），**全部就绪则整块不渲染**
  - 当前实际效果：从常驻 7 张降到 2 张（MiMo 待配置 + 网易转写 待补齐）

- **未完成**：无（本次是纯 UI 改动）

- **改动文件**：`app/src/components/layout/AppShell.tsx`

- **测试结果**：`npm run typecheck` 通过；eslint（该文件）通过；HMR 预览已刷新

- **风险**：砍掉「已就绪」卡片后，用户想确认某引擎是否在跑要进对应页面看；
  这是刻意的取舍（状态卡的原意是「告诉你该做什么」，不是常驻仪表盘）

- **下一阶段入口**：人工确认缩小后的观感（是否还想更小 / 是否要保留一个手动展开入口）

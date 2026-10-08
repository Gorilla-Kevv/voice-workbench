# PROGRESS

> 按 `token-efficient-agent-workflow` 规范维护。每阶段独立、可验证、可交接。

## 进度看板
- 当前正在开发任务：无进行中阶段——阶段 26 及补 2~6 已完成，**等用户实测对比网易 vs IndexTTS（听感 + 用时）拍板主力**
- 下一阶段任务：主力拍板后回填 preload 账本与门槛值；R2T2 离线转写接入（Windows 原生可行，见 HANDOFF 坑 12）
- 可提前进行的任务：阶段 22 半成品的档位选择器；旧 `flowGuide.ts` 清理
- 未完成的任务：阶段 11 的 WSL2 流式方案（已搁置）；fp16 音质 A/B（需用户听）

## 编号说明（2026-10-06 合规整理时补记）
- 历史上出现过**两组同号阶段**：「阶段 23」= 浏览器走查 与 文档修正、「阶段 24」= 全站拖拽导入 与 启动预加载。
  编号已被 HANDOFF（坑 22~25）与提交信息交叉引用，**不改号**，仅按完成时间相邻排序：
  走查(≤10-06 00:37) → 文档修正(10-06 00:37) → 拖拽(≤10-06 00:37) → 启动预加载(10-06 01:19)。
- 另有一次未单独立目的「阶段 26补」（侧栏手动折叠 + RVC/SVC 页去整页报错，提交 b1ee653），
  内容已并入「阶段 26」条目的补记段，不重复列。
- 早期条目（阶段 1~20）的署名与完成时间多为本次整理时按 git 提交时间**补记**；无法证实的标「未记录」，不臆造。

## 阶段 1 — 本地化改造与架构搭建
- 分支：main（feature/vc-svc 于 09-25 00:51 才创建）

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

## 阶段 2 — 启动体验与日志
- 分支：main（feature/vc-svc 于 09-25 00:51 才创建）

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

## 阶段 3 — 状态管理与数据修复
- 分支：main（feature/vc-svc 于 09-25 00:51 才创建）

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

## 阶段 4 — 官方流程对齐
- 分支：feature/vc-svc

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

## 阶段 5 — 术语与引导体系
- 分支：feature/vc-svc

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

## 阶段 6 — 官方建议对齐收尾（HANDOFF 下一步清单清零）
- 分支：feature/vc-svc

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

## 阶段 7 — 网易模块接入（Confucius4-TTS + Confucius4-R2T2，双模型共存）
- 分支：feature/vc-svc

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

## 阶段 8 — 网易模块装环境 + 端到端实测（TTS 跑通 / ASR 卡在平台）
- 分支：feature/vc-svc

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

## 阶段 9 — 侧栏状态卡精简（缩小 + 加载完自动隐藏） [完成时间：10.01 00:16 BY 未记录·git 提交时间补记]
- 分支：feature/vc-svc

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

## 阶段 10 — 各模块结果栏改「多条结果列表」（不再互相覆盖） [完成时间：10.01 00:42 BY 未记录·git 提交时间补记]
- 分支：feature/vc-svc

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

- **阶段 9 续**：按用户要求补「手动展开全部状态」入口 —— 容器常驻一行折叠按钮
  （箭头 + 「状态」/「全部状态」+ 右侧「N 项待处理」或「全部就绪」），默认只列出待处理卡片，
  点开显示全部；**探活期间强制全列**，避免加载进度被折叠掉。这样既保持简洁，又能随时看全状态排查

- **下一阶段入口**：浏览器逐个模块人工点一遍结果栏（合成两次看旧的是否还在、展开/删除/清空是否顺手）；
  决定 `check_vram()` 是否改成 nvidia-smi 口径

## 阶段 11 — R2T2 落地路径勘察（只勘察 + 做准备，未安装任何东西） [完成时间：10.01 23:24 BY 未记录·git 提交时间补记]
- 分支：feature/vc-svc

- **已完成**
  - **勘察结论（本机实测）**：WSL2 平台**已就绪**（`wsl --version` = 2.7.14.0，内核 6.18.33，只是没装发行版）；
    显卡驱动 **572.61**（≥510 即支持 WSL CUDA）+ Windows 11 25H2（10.0.26200）→ GPU 直通条件具备；
    **Docker 未安装**（Windows 上的 Docker Desktop 本身也跑在 WSL2 之上，多一层没必要）
  - **推荐方案（方案 B）**：只把 `r2t2_worker` 放进 WSL2，TTS 继续留在 Windows。
    TTS 在 Windows 已跑通（RTF 2.0~2.5），整体搬迁是白担一次回归风险；
    而 worker 与服务本来就是 stdin/stdout JSON 行协议，跨系统只是一层进程边界
  - **准备性代码改动（未配置 WSL 时行为完全不变）**
    - `NETEASE_R2T2_PYTHON` 支持整条命令行（shlex 切词），可填 `wsl.exe python`
    - 新增 `NETEASE_R2T2_WORKER`：WSL 里 Windows 路径不存在，要用 `/mnt/...` 形式
    - `r2t2_worker.py` 新增 `to_host_path()`：`F:\a\b.wav` → `/mnt/f/a/b.wav`

- **未完成（等用户拍板，本阶段不做）**
  - 装 WSL 发行版 + vLLM（需管理员权限，属系统级改动，未擅自执行）
  - 流式字段的真机校准（坑 12）——环境起来后的第一件事

- **改动文件**：`netease/app/{config.py,r2t2.py,r2t2_worker.py}`、`netease/README.md`、`HANDOFF.md`

- **测试结果**：`Settings.from_env()` 解析 OK（`wsl.exe python` 切词成两项、worker 路径可覆盖）；
  路径翻译验证 OK；`create_app()` 与 `/health` 回归通过（服务重启后 `ok=true`、TTS `installed=true`）

- **风险**：WSL 与 Windows 共用同一块 GPU，TTS 常驻 4.9 GB + vLLM 0.35（约 2.9 GB）**不能同时开**，
  必须沿用引擎互斥；WSL 侧还需 10~15 GB 磁盘（权重可复用 `HF_HOME=/mnt/d/AI_Cache/hub` 省 4 GB）；
  跨系统 stdin/stdout 的块间延迟会影响 80 ms 块长的流式体验，待实测

- **下一阶段入口**：用户拍板后按 `netease/README.md` 的 WSL 方案执行（装发行版 → venv → vllm →
  两个环境变量 → 用 `resources/test.wav` 校流式）；若否决，R2T2 保持「平台不支持」，ASR 页如实显示

## 阶段 12 — 修掉网易侧的显存准入假象（坑 17） [完成时间：10.02 00:16 BY 未记录·git 提交时间补记]
- 分支：feature/vc-svc

- **起因**：用户拍板「R2T2 先搁置，继续完善现有项目」。挑了清单里不需要 GPU 就能验证的一项：
  坑 17 的显存口径问题（当时只登记了现象，没定论）。

- **实测定性**
  - 同一时刻三次采样：**`torch.cuda.mem_get_info` = 7099 MB 空闲，`nvidia-smi` = 2238 MB 空闲**（差 4.9 GB）
  - 定性：WDDM 下 cudaMemGetInfo 是**本进程的虚拟视图**，看不见其它进程的占用
  - 这解释了之前的怪事：nvidia-smi 只剩 2.6 GB 时准入照样放行、模型还真加载起来了，
    代价是**第一条合成跑了 378 秒**（RTF 49，正常 2.0~2.5）—— 显存不够只能靠抖动硬跑

- **已完成**
  - `netease/app/hardware.py::vram_mb()` 改用 nvidia-smi 的 `memory.free`（跨进程真实值），
    torch 读数保留为 `torch_free_mb` 做对照；nvidia-smi 不可用时退回 torch
  - `check_vram()` 报错文案：两者差 >1 GB 时直接说「有 N MB 被**其它进程**占用」并列举常见占用者
  - `models.py` 的 `HealthResponse.vram` 放宽成 `dict[str, Any]`（值里有口径来源字符串，
    原来是 `dict[str, int]`，导致 `/health` 直接 500 —— 这个回归是改完当场撞出来的）

- **未完成**
  - `trainer/app/runtime.py::free_vram_mb()` 仍是 torch 口径（引擎准入 / 队列准入都用它），
    网易常驻 4.9 GB 时它会误判。**主服务，影响面大，未擅自改**，已列进 HANDOFF 待拍板
  - 「首条合成 378 s」待在显存充足时复测，确认是不是纯显存问题

- **改动文件**：`netease/app/{hardware.py,tts_engine.py,models.py}`、`HANDOFF.md`

- **测试结果**：`/health` 的 `vram` 返回 `{"free_mb":2187,"total_mb":8187,"torch_free_mb":7099,"source":"nvidia-smi"}`；
  空闲 1967 MB 时 `POST /v1/confucius/warmup` 正确返回 **503**（修之前会放行），
  错误正文提示「有约 5132 MB 被其它进程占用」

- **风险**：nvidia-smi 每次探测要起一次外部进程（10 s 超时兜底），`/health` 的频率下可忽略；
  若用户机器上 nvidia-smi 不在 PATH，自动退回 torch 口径，行为与修复前一致

- **下一阶段入口**：拍板 trainer 侧是否同步改口径；显存腾出来后复测首条合成耗时

## 阶段 13 — 网易改为主服务，GPT-SoVITS 降为辅助 [完成时间：10.02 02:07 BY 未记录·git 提交时间补记]
- 分支：feature/vc-svc

- **起因**：用户拍板「网易为主服务，GPT 为辅助」。范围是三件事 + 一条回退策略
  （导航与状态卡排主位 / 合成页默认引擎改网易 / `npm run dev` 自动拉起网易 / **不可用时明确报错不静默降级**）。

- **已完成**
  - **导航**：`NAV_GROUPS` 新增首位分组「网易 · 主服务」（零样本合成、流式转写），
    排在原「MiMo 云端」之前；「GPT-SoVITS 本地」改名为「GPT-SoVITS · 辅助」；
    侧栏副标题改「网易主服务 · GPT-SoVITS 辅助」
  - **状态卡顺序**：网易两卡 → GPT-SoVITS → RVC/SVC/ASR → MiMo 云端（顺序即优先级）；
    网易 offline 文案从「可选模块，默认不启动」改成「主服务未起来：先体检再单独启动」
  - **默认页**：`App` 的 `active` 初值 `'synthesis'` → `'netease-tts'`
  - **回退策略**：`NeteaseTtsPage` 新增可选 `onFallback`，App 传入 `() => setActive('batch')`；
    错误态与「权重未就绪」态各给一个「改用 GPT-SoVITS 批量合成」按钮 ——
    **不做自动回落**（沿用现网哲学：不静默降级）
  - **自动拉起**：`package.json` 的 `dev` 加入 netease 窗格（`--skip-if-missing`）；
    `scripts/netease.mjs` 新增该开关 —— 没有 `netease/.venv` 时安静跳过，
    **端口已被占用时也跳过**（避免「先手动起了再开 dev」时崩一个窗格）
  - `package.json` 描述同步更新

- **未完成**
  - 设置页默认值**未改**（用户未勾选该项）
  - GPT-SoVITS 各页（音色库 / 批量 / 训练）未做「辅助」的视觉降级，只改了导航文案与顺序

- **改动文件**：`app/src/App.tsx`、`app/src/components/layout/AppShell.tsx`、
  `app/src/pages/NeteaseTtsPage.tsx`、`scripts/netease.mjs`、`package.json`、`HANDOFF.md`

- **测试结果**：`npm run typecheck` 通过；改动文件 eslint 通过；
  `node scripts/netease.mjs --skip-if-missing` 在端口已占用时打印跳过并 exit 0；
  `npm run dev` 完整拉起后 **9881 / 9882 / 8787 / 5173 四端口全 up**，日志里 netease 窗格显示
  「9882 端口已有服务在跑，本次跳过启动」

- **风险**
  - `npm run dev` 现在多起一个 Python 进程，启动更慢、显存占用更高；
    没装 netease 的机器会自动跳过，装了的机器等于常驻（TTS 未预热时不占显存，预热后才占 ~4.9 GB）
  - 主服务不可用时落地页就是一张报错卡：这是刻意的（不静默降级），但新用户第一眼可能觉得「坏了」，
    文案已尽量说清原因与下一步动作
  - 网关仍无 supervisor：netease 挂了不会自动重启，只会在侧栏状态卡变「未启动」

## 阶段 14 — 资源占用预估与预警 [完成时间：10.02 02:19 BY 未记录·git 提交时间补记]
- 分支：feature/vc-svc

- **起因**：用户要求「运行前自动评估显存与内存；不足时给明确警告 + 降配置/释放/升硬件建议；
  重资源任务提前给出预估占用量」。

- **已完成**
  - **数据来源（三条，各自权威，不重复维护常量）**
    - 显存门槛：trainer `/v1/engines` 的 `required_mb`（sovits 3072 / rvc 2560 / svc 3072 /
      uvr5 4096 / asr 2048 / train 6144）+ netease `/health` 的 `tts_required_vram_mb`
    - 当前余量：netease 的 **nvidia-smi 口径**（跨进程真实值，坑 17 修完才可信）
      → 退回 trainer 的 `free_vram_mb`（torch 口径）
    - 内存：网关 `/api/health` 新增 `host { ram_total_mb, ram_free_mb, ram_used_mb }`
      （Node `os.freemem`，三个进程同机，只有网关看得到全貌）
  - **前端**：新增 `app/src/lib/resources.ts`（成本表 + 快照采集 + 判定 + `releaseVram()`）
    与 `app/src/components/features/ResourceBudget.tsx`
    - 展示：显存「需要 X · 空闲 Y / 共 Z」+ 内存「约 X · 空闲 Y」+ 「重新评估」
    - 判定：`ok` / `tight`（余量 <1 GB）/ `insufficient`（差多少直接给 GB）/ `unknown`（不编乐观结论）
    - 建议：可点的「释放常驻显存」+ 按任务给的「降低配置」具体参数 + 「升级硬件」文案
  - **接入页面**：网易合成（主服务）、模型训练、语音变声、歌声转换（分离 4 GB）、批量合成
  - `sovitsApi` 新增 `engines()` / `unloadEngines()`；类型补 `SovitsEnginesStatus`、
    `HealthInfo.host`、`NeteaseHealth.vram.source/torch_free_mb`

- **未完成**
  - 内存阈值是粗估（按任务给量级），没有实测 RSS 校准
  - 「降低配置」目前是文案建议，未做成一键改参数（改参数要动各页的表单，风险更大）

- **改动文件**：新增 `app/src/lib/resources.ts`、`app/src/components/features/ResourceBudget.tsx`；
  改 `server/src/routes/index.ts`、`app/src/lib/sovits.ts`、`app/src/types/{index.ts,sovits.ts,netease.ts}`、
  `app/src/pages/{NeteaseTtsPage,TrainingPage,VoiceConversionPage,SingingConversionPage,BatchPage}.tsx`

- **测试结果**：`npm run typecheck` / eslint（改动文件）/ `npm run build` 全通过；
  三个数据源实测取值正确：`host { total:32544, free:5616 }`、
  engines 门槛齐全、netease `vram { free:563, torch_free:7099, source:'nvidia-smi' }`
  → 页面据此判定 `insufficient`（当前正处在「显存被别的程序占满」的状态，报警符合事实）

- **风险**
  - 内存数是「约」，可能与实际 RSS 差较多，文案已写「约」
  - 快照在组件挂载时拉一次，长时间停留不会自动刷新（有「重新评估」按钮）；
    若后续要做实时守护，应提到 App 层做轮询而不是每个卡片各拉一次
  - 释放显存的动作会卸掉**正在常驻**的引擎（含网易 TTS），用户可能不期望 ——
    按钮文案已写明「释放常驻显存」，且只在预估不通过时出现

- **下一阶段入口**：确认各页预估卡的位置与文案；考虑把快照提到 App 层统一轮询；
  内存阈值若有条件可实测校准一次

- **下一阶段入口**（阶段 13 遗留）：浏览器确认落地页与导航顺序；若嫌主服务不可用时太硬，
  可考虑在落地页加一条「服务没起来时先看 GPT-SoVITS」的说明（仍不是自动回落）

## 阶段 15 — 三个外接板块的入口与来源标注 [完成时间：10.02 02:31 BY 未记录·git 提交时间补记]
- 分支：feature/vc-svc

- **起因**：变声 / 翻唱 / 转写三个入口挤在「AI 变声 / 语音与文本」两组里，
  用户分不清点进去用的是什么模型，也不知道这些能力来自哪个项目。

- **已完成**
  - **导航拆成三个模块**（组名直接写模型名，不再依赖 hover 提示）：
    - `RVC 变声` → 语音变声
    - `DDSP-SVC 歌声` → 歌声翻唱
    - `ASR 语音转文本` → 转写与数据集
    - 顺带把网易组名改成「网易 Confucius4 · 主服务」，模型族也进可见区域
  - **新增 `components/features/SourceNote.tsx`**：统一的「能力来源」条，
    写清上游项目名、本地位置、本项目做了什么
  - **三个页面各加一条**
    - 语音变声：RVC（Retrieval-based Voice Conversion），`vendor/rvc`
    - 歌声转换：DDSP-SVC（歌声转换）+ UVR5（音源分离），`vendor/ddsp-svc · 整合包 tools/uvr5`
    - 语音转文本：FunASR / faster-whisper（常驻）+ 整合包官方 ASR 脚本（脚本通道），
      `整合包 tools/asr`

- **未完成**：无（本次是纯标注改动）

- **改动文件**：新增 `app/src/components/features/SourceNote.tsx`；
  改 `app/src/components/layout/AppShell.tsx`、`app/src/pages/{VoiceConversionPage,SingingConversionPage,AsrPage}.tsx`

- **测试结果**：`npm run typecheck` / eslint / `npm run build` 全通过

- **风险**：侧栏分组变多（6 组），导航变长；`lg` 断点下侧栏可滚动，小屏仍是横向滚动条 ——
  若嫌长，可考虑把三组再收成一个「外接模型」分组，但那会退回「看不出用的是哪个模型」的老问题

- **下一阶段入口**：人工确认侧栏长度与分组名是否顺眼

## 阶段 16 — 操作指引系统重做（分步 + 圆形完成标识 + 跨页职责 + 复习） [完成时间：10.03 00:41 BY 未记录·git 提交时间补记]
- 分支：feature/vc-svc

- **起因**：旧指引只有「一句目标 + tips」，看不出先后与落点；用户要求
  ① 复用右侧弹窗 ② 写清每步怎么操作 ③ 复杂流程标注每页职责（上一页/本页/下一页）
  ④ 分步引导 + 圆形状态标识（未完成/已完成）实时更新 ⑤ 支持「重新开始」复习。

- **已完成**
  - **`lib/guides.ts`（新）**：结构化指引数据。每步强制写 `how`（具体怎么点/填/判断）、
    `page`（在哪做）、`prev`/`next`（上一页留下什么、下一页去哪）、可选 `autoKey`。
    三份指引：`netease-first`（主服务首跑）、`gpt-sovits-training`（跨 4 页训练链）、
    `first-run`（新手总览 5 步）
  - **`hooks/useGuideProgress.ts`（新）**：进度按指引独立记账，localStorage 持久化，
    模块级 listeners 保证跨页面同步；`markGuideEvent(key)` 供页面上报信号自动打勾；
    `reset()` 用于复习
  - **`components/features/FlowGuide.tsx` 重写**：沿用「贴边展开」交互（桌面悬浮 / 触屏点击），
    内容换成 —— 顶部进度条 + `x/N` +「重新开始」；每步一个圆形标识
    （未完成 = 空心虚线圈，已完成 = 实心圈 + 勾，与任务清单同一套视觉语言）；
    步骤里写清「怎么操作」与「上一步 / 下一步」；非本页的步骤给「去这一页」按钮直接跳转；
    底部可切换其它指引
  - **挂载位置改到外壳层**：`AppShell` 渲染 `<FlowGuide page={active} onNavigate={onNavigate} />`，
    因为跨页跳转只有外壳拿得到导航能力；移除 TrainingPage / SynthesisPage 里的两处重复引用
  - **自动打勾接了真实信号**：网易页选好参考音频 → `netease:ref-ready`；
    第一条合成成功 → `netease:first-synth`。观测不到的步骤仍可手动点圆圈切换

- **未完成**
  - 只有网易那条指引做了自动打勾，训练链 / 新手总览目前靠手动点
  - 没有「首次访问自动弹出」的强引导（当前是贴边自取，不打断操作）

- **改动文件**：新增 `app/src/lib/guides.ts`、`app/src/hooks/useGuideProgress.ts`；
  重写 `app/src/components/features/FlowGuide.tsx`；
  改 `app/src/components/layout/AppShell.tsx`、`app/src/pages/{NeteaseTtsPage,TrainingPage,SynthesisPage}.tsx`
  （旧 `lib/flowGuide.ts` 保留未删：术语/其它地方可能仍引用，待确认后再清理）

- **测试结果**：`npm run typecheck` / eslint（改动文件）/ `npm run build` 全通过

- **风险**
  - 指引内容是我按项目现状写的，参数名或按钮文案若后续改动会过期 —— 数据集中在
    `lib/guides.ts`，改起来是一处
  - 自动打勾依赖 `autoKey` 与页面上报点对齐，重构页面时容易漏改（已注释标出上报位置）
  - 右侧贴边条与「资源预估卡」可能在同一水平位置重叠（贴边条 z-40 且固定，内容区右侧有留白）

- **下一阶段入口**：人工走一遍三份指引，看步骤描述与实际界面是否对得上；
  决定是否给训练链接自动打勾；确认旧 `flowGuide.ts` 可否整体删除

## 阶段 17 — GPT-SoVITS 改为默认停用 + 可一键关闭（释放显存） [完成时间：10.03 02:58 BY 未记录·git 提交时间补记]
- 分支：feature/vc-svc

- **起因**：显存不足的报错写「先关闭 GPT-SoVITS 本地服务」，但界面里没有任何入口能关。
  用户进一步指定策略：**以后默认关闭 GPT-SoVITS 释放显存，网易为主力**，
  只有想用 GPT-SoVITS（训练 / 批量 / 变声 / 翻唱）时才去设置里手动开。

- **已完成**
  - **网关接管生命周期**：`config.sovits.autostart` 默认改为 `true`（旧值 false），
    这样「按需拉起」才有执行者；`npm run dev` **不再拉起** sovits，另开 `npm run dev:all` 保留旧行为
  - **持久开关**：`server/.data/sovits-service.json`（跨 `tsx watch` 重启保留，默认 false = 停用）
  - **新端点** `GET/POST /api/sovits/service`：开启 → `ensureStarted()` 拉起；
    关闭 → 先 `POST /v1/engines/unload` 卸常驻引擎，再 `taskkill /t /f` 杀进程树
    - 挂在代理**之前**（否则被代理的通配规则吃掉），并且这条路由自己开 `express.json()`
  - **如实区分两种关停**：我们拉起的 → 「已关闭，显存已归还」；
    外部实例（`npm run dev:sovits` / `start.bat`）→ **杀不掉**，提示用户去关那个终端，
    并说明只卸掉了引擎。不说「已关闭」骗人
  - **前端**：`lib/localService.ts`（启停客户端）；设置页加启用开关（默认关，写清什么时候该开）；
    资源预警卡在显存不足且 GPT-SoVITS 开着时，多给一个「关闭 GPT-SoVITS 服务」按钮
  - **顺带修掉一个陈旧状态问题**：`/api/health` 的 `sovits.reachable` 只在探活时更新，
    服务关掉后侧栏仍显示「已连接」。加了 30 秒周期探活；`/api/sovits/service` 的 GET 改为现探

- **未完成**
  - 依赖 GPT-SoVITS 的页面（训练 / 批量 / 变声 / 翻唱）在服务停用时，
    目前是通用的 503 提示，没有「去设置开启」的直达按钮

- **改动文件**：`server/src/{index.ts,config/index.ts,services/sovits.ts,routes/sovits.ts}`、
  `app/src/lib/{localService.ts,resources.ts}`、`app/src/components/features/ResourceBudget.tsx`、
  `app/src/pages/SettingsPage.tsx`、`app/src/types/index.ts`、`package.json`、`HANDOFF.md`

- **测试结果**：`npm run typecheck` / eslint / `npm run build` 全通过；
  实测（`npm run dev` 用新脚本重启后）：**默认 9881 不起** → POST 启用 → `reachable=true`（网关拉起）
  → POST 关闭 → **9881 停**、空闲显存 1236 → 1458 MB，提示文案为「已关闭…显存已归还」

- **风险**
  - 网关托管的副作用：`tsx watch` 改后端代码重启网关时会回收 GPT-SoVITS 子进程
    （开关是开的会自动再拉起，但正在跑的训练任务会中断）
  - 关停走的是 `taskkill /t /f`，若用户有未保存状态会直接丢 —— 训练任务请先在任务页取消
  - 外部实例杀不掉这条路径，文案已说明，但界面上「已停用」与侧栏「已连接」可能同时出现（属实）

- **下一阶段入口**：给训练 / 批量 / 变声 / 翻唱页加「服务已停用，去设置开启」的直达提示

## 阶段 18 — 资源仲裁：单模型独占，自动停掉本系统内竞争模型 [完成时间：10.04 12:34 BY 未记录·git 提交时间补记]
- 分支：feature/vc-svc

- **起因**：用户要求「一个模型运行时，自动停止系统内与之竞争资源的其它模型并释放显存；
  严格限制在本系统内，绝不触及系统外的进程」。
  这正是 HANDOFF 里挂了很久的「跨运行时显存仲裁」项（阶段 7 未完成清单第一条）。

- **边界定义（先于实现）**
  - **本系统** = 本项目自己拉起的两个 Python 服务：GPT-SoVITS（:9881）与网易（:9882），
    网关（:8787）是 Node 进程不占 GPU；
  - 仲裁器**只向这两个地址发请求**，且发请求前校验目标是回环地址
    （`SOVITS_URL` 若被配成非回环，会在启动阶段直接拒绝）；
  - 不扫描进程、不 kill 任何 PID、不触碰电脑上其它任何程序 ——
    浏览器 / 模拟器 / 游戏占的显存由资源预估卡提示用户自己处理。

- **已完成**
  - **`server/src/services/arbiter.ts`（新）**
    - `focus(engine)`：把资源集中给单一引擎 —— 卸载**另一端**服务上的全部模型
      （sovits 端：`/v1/engines/unload` + `/v1/pipeline/unload`；
      netease 端：`/v1/confucius/unload` + `/v1/r2t2/unload`），
      并在 netease 内部保证 TTS / ASR 二选一；
    - **心跳复检**：focus 持有期内（默认 10 分钟，可传 `holdSeconds`）每 15 秒
      重新卸载另一端，防止它被别的请求重新拉起；定时器 `unref` 不阻塞退出；
    - `releaseAll()`：全停，本系统内不留任何常驻模型；
    - 卸载失败不抛出（分类：服务没起=正常跳过；真失败=记入 `failed` 返回给界面）
  - **`server/src/routes/resources.ts`（新）**：`POST /api/resources/focus`、
    `POST /api/resources/release`、`GET /api/resources/focus`
  - **前端 `lib/arbiter.ts`（新）**：`focusBeforeRun(engine)` —— **仲裁失败不阻断任务**
    （它是优化，真正的准入由各服务自己的显存检查负责）
  - **接入开跑点**（7 处）：网易预热、训练、批量、变声、翻唱、分离、ASR 转写
  - **资源预估卡**：显存不足时新增「只跑这一个模型」按钮（= `focus(task)`）

- **未完成**
  - 页面上的「自动打勾」没有延伸到仲裁（仲裁结果只在 toast 里体现）；
  - 网易引擎内部互斥依赖它的 `engine_lock`（acquire 时抢占），仲裁器只是提前触发，未做深校验

- **改动文件**：新增 `server/src/services/arbiter.ts`、`server/src/routes/resources.ts`、
  `app/src/lib/arbiter.ts`；改 `server/src/routes/index.ts`、
  `app/src/components/features/ResourceBudget.tsx`、
  `app/src/pages/{NeteaseTtsPage,TrainingPage,BatchPage,VoiceConversionPage,SingingConversionPage,AsrPage}.tsx`

- **测试结果**：`npm run typecheck` / eslint（改动文件）/ `npm run build` 全通过。接口实测：
  - 非法引擎 → 400 `BAD_ENGINE`；
  - `focus netease-tts` → 卸载 netease 内部 r2t2，sovits 端未运行则跳过；
  - `focus sovits` → 卸载 netease 端 confucius + r2t2（两处）；
  - `release` → 全停后 `GET focus` 回 `{engine:null, remainSec:0}`；
  - `GET /focus` 正确显示持有者与剩余秒数

- **风险**
  - 心跳复检是「轮询卸载」，极端情况下两次心跳之间另一端可能短暂加载 ——
    但它会立刻被下一次心跳卸掉，不会与焦点引擎长期共存
  - focus 的 TTL（默认 10 分钟）过期后仲裁失效，长任务（训练数小时）需要传更大的 `holdSeconds`
    —— 目前训练页用的是默认值，**后续应把 TTL 与任务时长挂钩**
  - 只防「本系统内」的竞争：用户机器上其它程序的显存占用不在管辖范围（这是需求边界，不是缺陷）

- **下一阶段入口**：训练页把 `holdSeconds` 与预计训练时长挂钩；`focus` 结果在页面上做轻提示

## 阶段 19 — 资源站入口 + 仲裁持有期与任务时长挂钩 [完成时间：10.05 00:33 BY 未记录·git 提交时间补记]
- 分支：feature/vc-svc

- **起因**：用户要求内嵌 https://res.acgnai.top/ 的跳转链接（该站提供角色语音数据集与
  TTS / SVC 开源模型，站点名「AI Hobbyist 资源库」）；同时继续阶段 18 的下一步
  （训练页仲裁持有期与任务时长挂钩）。

- **已完成**
  - **新增 `components/features/ResourceSiteLink.tsx`**：统一的资源站入口
    （新窗口打开 + `rel="noopener noreferrer"` 防反向 tabnabbing），
    放在三处「缺素材 / 缺模型」的地方：
    - 训练页：缺训练数据集
    - 语音变声页：缺 .pth 音色模型
    - 歌声转换页：缺歌声转换模型 / 伴奏素材
  - **仲裁持有期与任务时长挂钩**（阶段 18 遗留）：
    - 训练：`focusBeforeRun('training', 6 * 3600)`（训练动辄数小时，默认 10 分钟根本不够）
    - 批量：`focusBeforeRun('sovits', 3600)`（几十条可能跑很久）
    - 其余短任务维持默认 600 秒
  - `focusBeforeRun` 增加 `holdSeconds` 参数，注释写明「长任务必须给大值」的原因

- **未完成**：无（链接是静态的；若站点改版无需同步）

- **改动文件**：新增 `app/src/components/features/ResourceSiteLink.tsx`；
  改 `app/src/lib/arbiter.ts`、`app/src/pages/{TrainingPage,VoiceConversionPage,SingingConversionPage,BatchPage}.tsx`

- **测试结果**：`npm run typecheck` / eslint（改动文件）/ `npm run build` 全通过；
  站点内容已抓取确认（「AI Hobbyist 资源库」：数据集 / TTS / SVS / SVC / GSV 部署工具），
  链接文案与站点定位一致

- **风险**：外部站点可用性不受本系统控制；链接全部新窗口打开，不劫持当前页

- **下一阶段入口**：训练页仲裁持有期目前是固定 6 小时，更准确的做法是按语料时长估算；
  仲裁结果可在页面上做轻提示（当前只进 toast）

## 阶段 20 — 依赖 GPT-SoVITS 的页面补「服务已停用」直达提示 [完成时间：10.05 00:43 BY 未记录·git 提交时间补记]
- 分支：feature/vc-svc

- **起因**：阶段 17 把 GPT-SoVITS 改成默认停用后，训练 / 批量 / 变声 / 翻唱 / 音色库
  这五个页面会直接失败，而通用报错只说「本地服务不可用」——
  用户既不知道有这个开关，也不知道该去哪开。

- **已完成**
  - **新增 `components/features/SovitsServiceNotice.tsx`**
    - 只在「已停用且未运行」时渲染（读不到状态或已启用→不显示，**宁可漏提示也不误报**）
    - 两个动作：**「直接开启」**（`localServiceApi.toggle(true)`，不用离开本页）+
      **「去设置页」**（可选 `onGoSettings` 回调，App 传入 `setActive('settings')`）
    - 文案说明为什么默认关闭（显存留给网易主服务）与首次开启要等 torch 导入
  - **接入五个依赖页**：训练 / 批量 / 语音变声 / 歌声转换 / 音色库，
    App 统一传 `goSettings`

- **未完成**：`直接开启` 的等待过程没有进度反馈（只有按钮转圈），
  首次要 import torch 数十秒，用户可能以为卡住 —— 后续可加「启动中，约需数十秒」的进度条

- **改动文件**：新增 `app/src/components/features/SovitsServiceNotice.tsx`；
  改 `app/src/App.tsx`、`app/src/pages/{TrainingPage,BatchPage,VoiceConversionPage,SingingConversionPage,VoiceLibraryPage}.tsx`

- **测试结果**：`npm run typecheck` / eslint（改动文件）/ `npm run build` 全通过；
  `/api/sovits/service` 当前返回 `{enabled:false, reachable:false}` → 提示条件成立，五页会显示

- **风险**：提示依赖 `/api/sovits/service` 的实时探活；网关不可达时组件拿不到状态而**不显示**
  （fail-safe：此时页面本来也用不了）

- **下一阶段入口**：给「直接开启」加启动进度反馈；确认五页提示的位置与文案是否碍眼

## 阶段 21 — 冷启动进度反馈 + trainer 侧显存口径同步改为 nvidia-smi [完成时间：10.05 01:09 BY CodeBuddy·git 提交时间补记]
- 分支：feature/vc-svc

- **起因**：① 上一阶段遗留「直接开启」只有转圈，首次要数十秒会被当成卡死；
  ② 用户拍板：trainer 侧显存口径也改（坑 17 的第二半）。

- **已完成**
  - **冷启动进度反馈**
    - `SovitsServiceNotice`：启动中显示「启动中，约需数十秒（首次要 import torch）· 已等待 N 秒」
      + 进度条（按实测 45 秒量级推进，只到 95%，不做假精确）+ 每秒走表；
      同时每 3 秒探真实状态，探到就绪提前收尾，不等 `toggle()` 返回
    - 设置页开关同样补秒表与进度条（只在**开启**时显示，关闭不用等）
  - **trainer 显存口径（坑 17 收尾）**
    - `trainer/app/runtime.py`：新增 `_nvidia_smi_free_mb()`（跨进程真实值）
      与 3 秒 TTL 缓存（避免 `/health` 轮询频繁起外部进程）；
      `free_vram_mb()` 改为 nvidia-smi 优先 → 退回 torch
    - `RuntimeInfo` 新增 `vram_free_mb_torch` 对照字段并进入序列化
      （两者之差 = 别的进程占了多少）
    - `/health` 的 `runtime.vram_free_mb` 随之变准
    - 修正 `trainer/app/queue.py` 里「直接问 torch 最准」的过时注释

- **未完成**：门槛数值（训练 6144 / UVR5 4096 等）仍按旧口径定，未重新校准

- **改动文件**：`trainer/app/{runtime.py,queue.py}`、
  `app/src/components/features/SovitsServiceNotice.tsx`、`app/src/pages/SettingsPage.tsx`、
  `HANDOFF.md`、`PROGRESS.md`

- **测试结果**
  - 冷启动实测 **43.9 秒**（与进度条 45 秒设定吻合）
  - 口径实测：`/v1/engines` 的 `free_vram_mb` = **2550 MB**，nvidia-smi = **2544 MB**（一致）；
    `/health` 显示 `vram_free_mb=2550`、`vram_free_mb_torch=7099` → 差 4549 MB 即外部占用
    （改前 trainer 一律报 7099）
  - 用整合包 py3.9 解释器导入验证通过（`python.exe -c "from app.runtime import free_vram_mb"`）

- **风险**
  - 判定变严格：可能出现「看着没跑别的却被拦」—— 这正是修掉的目标（宁可多等也不半途 OOM），
    但若发现门槛过严需重新校准数值
  - nvidia-smi 不在 PATH 的机器上会退回 torch，修复不生效（但不会更差）
  - `/health` 每次最多多一次（有 3 秒缓存）外部进程调用

- **下一阶段入口**：观察新口径下是否有任务被误拦；若有，按真实口径重新校准各引擎门槛

## 阶段 22 — 网易合成速度 / 质量档位（**半成品，UI 选择器未做**） [完成时间：10.05 03:16 BY CodeBuddy·git 提交时间补记]
- 分支：feature/vc-svc

- **起因**：用户问「官方 demo 为什么快」→ 排查结论（vLLM + 数据中心显卡 + 官方默认
  `num_beams=3`）之后，用户要求把速度 / 质量做成可调参数。

- **已完成（后端与 API 层，功能可用）**
  - `netease/app/routers/confucius.py`：新增三档预设
    `fast (1,10)` / `balanced (1,18)` / `quality (3,25)`（官方默认为 `(3,25)`），
    `POST /v1/confucius/tts` 接收 `quality` 表单字段，高级用法可直接传
    `num_beams` / `n_timesteps` 裸参数（优先于档位）
  - `tts_engine.generate()` 接受可选 `num_beams` / `n_timesteps` 并透传上游
    （只传显式给出的，其余走官方默认）
  - `/v1/netease/catalog` 的 `tts` 块暴露 `quality_presets`（含给界面看的说明文案）
    与 `default_quality`（= balanced）
  - 前端：类型、`neteaseApi.synthesize` 请求字段、页面状态与请求都已接好，
    初始值取服务端 `default_quality`
  - **分析结论（供后续参考）**：官方 demo 快的原因 = 数据中心显卡（带宽 8~13 倍）
    + vLLM（PagedAttention 等，2~5 倍）+ 他们可承担 beams=3；与 Gradio 无关（那只是 UI 壳）

- **未完成（本次被叫停）**
  - **界面上没有档位选择器** —— 页面会一直用服务端默认的 `balanced`，
    功能等价于「默认变快了」，但用户**暂时无法在界面上切档**。
    补做点：`NeteaseTtsPage` 的「合成内容」卡里加一个 Select，
    选项来自 `catalog.tts.quality_presets`（note 字段做说明），选中值进 `quality` state
  - 未实测各档位的实际加速比与音质差异

- **改动文件**：`netease/app/{tts_engine.py,routers/confucius.py,routers/netease.py}`、
  `app/src/{lib/netease.ts,types/netease.ts,pages/NeteaseTtsPage.tsx}`

- **测试结果**：`npm run typecheck` / eslint（改动文件）/ `npm run build` 全通过
  （当前状态自洽：API 可用，UI 缺选择器但不报错）

- **风险**：默认档从官方 `quality (3,25)` 改成了 `balanced (1,18)` ——
  合成会明显变快，但音质稳定性可能有细微差别；要回到官方默认，
  在界面（补做后）选「质量优先」或请求里传 `quality=quality`

- **下一阶段入口**：补 UI 档位选择器（约 10 行）；实测三档的 RTF 与听感

## 阶段 23 — 浏览器走查网易合成页 + 阶段 6 新 UI（修掉 6 处实测出来的缺陷） [完成时间：10.06 00:37 前 BY CodeBuddy·随提交 32319bd 补记]
- 分支：feature/vc-svc

- **起因**：HANDOFF「下一步」两条高优先级项 —— 网易合成页的 UI 交互人工过一遍、
  端到端实测阶段 6 的新 UI。接口链路早就验完了，这次专挑「只有人（或浏览器）才能发现」的问题。

- **已完成（走查结论 + 修复）**
  - **`NeteaseTtsPage`：音色库取不到音频（合成必挂）**
    取参考音频时把服务端的磁盘路径 `voice.audio_path` 直接丢给 `resolveAudioUrl()`，
    拼出 `GET /api/sovits/F:/…/voices/xxx.mp3` → **404**，且这条失败被 `catch` 里的
    `instanceof RequestError` 静默吞掉：按钮闪一下回到原样，**既不弹 toast 也没有错误卡**。
    改为走试听同一条路由 `/v1/voices/{id}/audio`（音色库页 359 行一直是这么用的），
    并把非 RequestError 的异常也翻成带 `hint` 的结构化错误。
  - **`NeteaseTtsPage`：服务停着时 `/v1/voices` 无限重试**
    effect 依赖里放了 `voicesLoading` —— 失败 → loading 归 false → effect 重跑 →
    再失败，实测每 1~2 秒一发 503 并伴随一条 toast。改为「失败就停，只给手动入口」。
  - **`NeteaseTtsPage`：音色库不可用时的界面从「卡在正在加载」变成可操作**
    新增 `voicesFailed` 三态占位（未加载 / 空库 / 失败），失败时页面内嵌
    `SovitsServiceNotice`（直接开启 / 去设置页）+「重新加载」按钮；
    顺带删掉过时文案「start.bat 会拉起它」（阶段 17 起默认停用）。
  - **`NeteaseTtsPage`：预览音频的 Blob 地址每次渲染泄漏一个**
    `src={URL.createObjectURL(file)}` 写在 JSX 里 → 每次渲染新开一个且永不回收。
    改成 `useMemo` + 卸载/换文件时 revoke。
  - **`SovitsServiceNotice`：启动进度反馈 3 秒就自己消失（阶段 21 白做）**
    服务端 `setEnabled(true)` 落盘在拉起**之前**，组件每 3 秒复检看到 `enabled=true`
    就 `return null`，而进程还要数十秒 —— 用户点完「直接开启」立刻失去所有反馈。
    改为「本页发起的启动过程（`starting`）期间不隐藏」，标题随之切成「正在启动 GPT-SoVITS 本地服务」。
  - **`BatchPage` / `TrainingPage`：整页报错时把「直接开启」入口弄丢 + 文案过时**
    两页 `if (connectionError) return <Alert/>` 会把页面里的 `SovitsServiceNotice` 一起替掉，
    而 Alert 正文写着「请确认已执行 `npm run dev`（会自动拉起）」—— 阶段 17 起这句不成立。
    改为把 Notice 嵌进 Alert 里（自带「只在停用时渲染」的语义），文案改说「默认停用，要先开启」。
  - **`trainer/app/api.py`：设置页权重下拉显示空白（阶段 6 交付的 UI 实测不通过）**
    `/v1/weights` 的 `pretrained.gpt/sovits` 回的是整合包**相对路径**，而前端把
    `default.*`（**绝对路径**）当选中值，两个口径对不上 → Radix 找不到匹配项，
    下拉框什么都不显示（实测两个触发器 innerText 均为空）。改为 `installation.path()` 绝对形式。
  - **走查通过、无需改动的部分**：语种下拉 14 项齐全、跨语种可切；上传参考音频（5.0s 预览正常、
    按钮按前置条件禁用）；音色库选取（服务在线时列表 + 「仅借用参考音频」说明卡）；
    「改用 GPT-SoVITS 批量合成」回退按钮可跳转且落地页正确显示停用提示；
    显存不足的错误卡带 `hint`（实测「需要约 6144 MB，当前仅 1069 MB」「有约 6030 MB 被其它进程占用」）；
    训练页流水线顺序 **SoVITS 先于 GPT**（阶段 6 核心项）+ 两条官方顺序 hint + 训练完成卡的 E/S 解释；
    设置页 WeightsPanel 结构完整（含「当前生效」「加载所选权重」）。

  - **显存准入门槛按精度分档（用户拍板后落地）**
    走查中发现 8 GB 卡在这套口径下根本开不起来：Windows 桌面常驻 2.9~5 GB + GPT-SoVITS 预加载 1.8 GB，
    空闲常年 1~3 GB，而门槛写死 6144（那是按 **fp32** 估的，默认却是 fp16）。
    新增 `netease/app/tts_engine.py::required_vram_mb(precision)` —— fp16 **5120**（实测峰值 4.9 GB）、
    fp32 保持 6144；预热、合成两条准入路径与 `/health`、catalog 暴露的数值统一按实际精度取。
    R2T2 的准入仍用 `REQUIRED_VRAM_MB = 6144`（不在这次范围内）。**需重启 9882 才生效**。
  - **其余模块页面状态走查（无需 GPU 的部分）**：变声 / 翻唱 / 转写三页的「能力来源」条、
    变声页资源预估卡、音色库页（1 条音色、状态正常）、网易转写页的「Windows 装不了 vLLM」如实 WIP 卡、
    MiMo 声音克隆页的「未配置密钥」引导 —— 渲染与文案均正常，未发现新问题。
    （ASR 转写页没有资源预估卡，属阶段 14 的接入范围选择，未擅自补）

- **未完成**
  - **网易合成成功路径的结果卡（播放 / 下载 / 多条并存）仍未实测** —— 门槛已按精度分档，
    但这台机器桌面常驻就把卡占了约 5 GB，重启 9882 后能报出 5120 的口径；真要跑得先腾显存
  - **阶段 6 的切分结果面板**：现有历史任务没有一个带 `slice` 阶段（`/v1/jobs` 核对过），
    要么跑一轮开切分的短任务，要么等有真实语料再看
  - 阶段 22 的速度/质量档位选择器：**未动**（用户上次明确叫停）

- **改动文件**：`app/src/pages/{NeteaseTtsPage,BatchPage,TrainingPage}.tsx`、
  `app/src/components/features/SovitsServiceNotice.tsx`、`app/src/App.tsx`、`trainer/app/api.py`、
  `netease/app/{tts_engine.py,routers/confucius.py,routers/netease.py}`

- **测试结果**：`npm run typecheck` / 改动文件 eslint / `npm run build` 全通过；
  `trainer/app/api.py` `ast.parse` 通过；服务重启后 `/v1/weights` 实测
  `default.gpt == pretrained.gpt`（MATCH），设置页两个权重触发器显示「官方预训练底模 · 零样本克隆」；
  浏览器复验：音色库失败态只发 1 次请求（`performance` 计数 8 秒内 18→18 不再增长）、
  「直接开启」进度条活过 10 秒并在就绪后自动收起、「重新加载」取回 1 条音色、
  选音色后合成能真正打到后端并返回结构化显存错误（旧版这里是无声 404）；
  netease venv 直接调用 `required_vram_mb()` 验证：precision=fp16 → 5120、fp32 → 6144；
  三个 netease 文件 `ast.parse` 通过

- **风险 / 新发现（需拍板）**：**nvidia-smi 口径 + 6144 MB 门槛在 8 GB 机器上近乎不可满足** ——
  Windows 桌面本身（MyDockFinder / explorer / webview 等）就稳定吃掉约 2.9~5 GB，
  GPT-SoVITS 一启动预加载再占约 1.8 GB，空闲长期在 1~3 GB 徘徊。
  改口径前（torch 视图）这类请求会被放行、模型靠抖动加载、代价是首条合成 378 秒；
  改口径后被正确拦下，但**主服务在正常用机的状态下也开不了**。
  建议（待用户点头）：`REQUIRED_VRAM_MB` 按精度分档 —— fp16 实测峰值 4.9 GB，
  门槛可从 6144 降到约 5120；fp32 保留 6144。门槛属服务端单一真源（坑 19），改一处即可。

- **下一阶段入口**：① 按上面建议校准准入门槛（或用户手动腾显存）后补测「合成成功 → 结果卡播放/下载」；
  ② 跑一条开切分的短任务验证阶段 6 的切分结果面板；③ 档位选择器仍等用户重新开工

## 阶段 23 — 文档修正：R2T2 可用性分层 + IndexTTS 接入方案
- 分支：feature/vc-svc

- **起因**：用户转述了别人在同一模型上的排查结论，指出我此前「Windows 装不了 vLLM → R2T2 整体不可用」
  下得过重；并要求**更新文档**，然后给出 **IndexTTS**（https://github.com/index-tts/index-tts）
  的本地化接入方案，且同样要有显存 / 内存 / 检测等性能管控。

- **已完成（纯文档，代码未动）**
  - **修正坑 12（R2T2 分层结论）**，证据全部取自本地仓库：
    - `Confucius4-R2T2/pyproject.toml:67-69` 默认 `dependencies=["qwen-asr[vllm]", ...]` → 官方两条路
      （`INFER_MODE` 仅 `stream_vllm/onetime_vllm`；Docker 用 `qwenllm/qwen3-asr`）确实是 Linux 路线，
      但 **extra 可拆**
    - `pyproject.toml:104-106` + `r2t2/r2t2_asr.py:23/189`：`qwen_asr` 是 PyPI 包，
      `R2T2ASRModel(Qwen3ASRModel)` 是继承 → transformers 后端天然可用
    - **流式被写死**：`r2t2_asr.py` 有 5 处 `if self.backend != "vllm": raise ValueError(...)`
      （行 267/352/527/621/802）→ 流式 Windows 原生不可能
    - 实测验证：`qwen_asr-0.0.6-py3-none-any.whl`（141 KB 纯 Python）在本机可下载 → Windows 可装
    - 结论：**离线转写 Windows 原生可行（我们没接，是判死刑的损失）；流式需 WSL2/Docker**
    - 同步记录他人实测的代价：显存槛 ~5.5/6.5 GB、`SEGMENT_LENGTH=240`、`MAX_INFERENCE_BATCH_SIZE=1`、
      首 token 慢（torch 分配池未预热）
  - **新增 `docs/INDEX-TTS-INTEGRATION.md`**：IndexTTS-2.5 一手资料（0.8B / 5 语种 / BF16 /
    官方 RTF 0.2065@4090 / `uv` 必需 / CUDA ≥12.8 / bilibili 许可）+ 与现有三套模型的对比 +
    部署形态（9883 独立端口、网关无 supervisor、opt-in）+ **资源管控设计**（复用 ResourceBudget
    成本表、arbiter 增加 `indextts` 引擎项、nvidia-smi 口径、体检脚本）+ 8 阶段计划 + 风险登记
  - HANDOFF：决策表补「IndexTTS 定位为补充」；下一步清单把原来「装不装 WSL2 跑 R2T2」
    改成「先接离线（Windows 原生可行），流式再议」

- **未完成**：代码一律未动（用户此前要求「停下所有任务」，本轮只做文档）

- **改动文件**：`netease/README.md`、`docs/INDEX-TTS-INTEGRATION.md`（新）、`HANDOFF.md`、`PROGRESS.md`

- **测试结果**：无代码改动，未跑构建；所有引用的行号均在本仓库实际核对过

- **风险**
  - IndexTTS 的 RTF 是从官方 4090 数据外推的，本机 4060 Laptop 需实测，方案里明确标注为估计值
  - 许可为 bilibili 模型使用协议（非 Apache），商用前必须单独确认 —— 已在文档显著位置标注
  - 若不采纳该方案，文档会成为噪音；建议保留在 `docs/`（与既有可行性评估同层），不进主流程

- **下一阶段入口**：等用户拍板 IndexTTS（定位 / 磁盘 / 许可）；若拍板，从阶段 0（环境核实）开始

## 阶段 24 — 全站文件/文件夹拖拽导入 [完成时间：10.06 00:37 前 BY CodeBuddy·随提交 32319bd 补记]
- 分支：feature/vc-svc

- **起因**：用户要求「所有需要文件/文件夹导入的都要支持拖动导入」。
  盘点后全站 13 处 `<input type=file>`，只有 MiMo 声音克隆的 `SamplePicker` 支持拖文件，
  且**没有一处能接住文件夹**（语料目录这种最自然的动作只能点开面板多选）。

- **已完成**
  - **共用底座 `app/src/hooks/useFileDrop.ts`**
    - 返回 `{ dragging, rootProps }`，`rootProps` 直接展开到任意容器（div / label / CardContent）
    - **文件夹递归**：走 `webkitGetAsEntry` + `createReader().readEntries` 分批读到底
      （`dataTransfer.files` 对目录只给一个 0 字节壳）；老浏览器没有 entry API 时退回 `files`
    - **按 `accept` 过滤**：拖进来不符类型的文件直接忽略，不会污染表单
    - **回填 `input.files`**（导出 `applyFilesToInput`）：原生控件靠它显示文件名，
      不回填就一直写着「未选择任何文件」，看着像没成功
    - `dragleave` 用深度计数器（`depth`）而不是直接置 false —— 否则拖过子元素时高亮会闪
    - 回调引用走 `useEffect` 保最新（React 19 禁止渲染期写 ref，eslint `react-hooks/refs` 会拦）
  - **13 处全部接入**（拖拽高亮 + 「可拖文件/文件夹进来」文案提示）：
    `SamplePicker`（升级为支持文件夹）、`NeteaseTtsPage` 参考音频、`NeteaseAsrPage` 音频、
    `AsrPage` 单条转写 + 数据集批量上传、`BatchPage` txt/csv 清单（整块文本区可接）、
    `TrainingPage` **语料目录（整个文件夹拖进来 → 递归取音频 → 自动填 `source_audio_dir`）**、
    `VoiceLibraryPage` 新建 + 替换参考音频、`VoiceConversionPage` 源音频 + 音色模型库
    （`.pth` 主体 / `.index` 可先拖后补，给了对应提示）、`SingingConversionPage` 歌曲 + 只做分离
  - **`AppShell` 全局兜底**：落在上传区之外的误拖不再把 SPA 导航走
    （浏览器默认会打开拖入的文件，当前表单状态全丢）；上传区自己 preventDefault 过就跳过
  - **顺带补的静默失败**：RVC `upload()` 只有 try/finally 没有 catch，导入失败时界面毫无反应
    （按钮路径同样受影响，拖拽会让误操作更常见）→ 补 `toast.error` 带 `hint`
  - **顺带修的泄漏**：`NeteaseAsrPage` 试听用 `URL.createObjectURL(file)` 写在 JSX 里，
    每次渲染泄漏一个 Blob 地址 → 改 `useMemo` + 换文件/卸载时 revoke（与阶段 23 同一条坑 18）

- **未完成**
  - **文件夹拖拽没做真机验证**：Playwright/合成事件造不出 `FileSystemDirectoryEntry`，
    只能验到「多文件拖入 + accept 过滤 + 回填 + 上传成功」这一层。递归分支需要用户
    从资源管理器真实拖一次
  - 拖进来的目录若混有非音频文件是**静默跳过**（与训练页官方口径一致），没有给「跳过了 N 个」的汇总

- **改动文件**：新增 `app/src/hooks/useFileDrop.ts`；
  改 `app/src/components/layout/AppShell.tsx`、`app/src/components/features/SamplePicker.tsx`、
  `app/src/pages/{NeteaseTtsPage,NeteaseAsrPage,AsrPage,BatchPage,TrainingPage,VoiceLibraryPage,VoiceConversionPage,SingingConversionPage}.tsx`

- **测试结果**：`npm run typecheck` / 改动文件 eslint / `npm run build` 全通过；
  浏览器合成 DragEvent 逐项实测：网易合成页（高亮 + 文件名 + `input.files=1` + 开始合成解禁）、
  网易转写页（同上 + 试听条出现）、训练页语料（3 个文件拖入 → 2 个音频被收、`notes.txt` 按 accept 过滤掉，
  **`POST /v1/train/upload` 返回 200 且目录字段自动填入** `trainer/.data/uploads/74c67028fe`）、
  批量页（拖入 3 行 .txt → 文本框出现 3 条 · 23 字）、音色库导入（文件名显示 + 回填）、
  变声/翻唱（文件进 input 且试听条出现）、RVC 音色模型库（只拖 `.index` → 给「再拖入同名 .pth 就会一起导入」提示；
  拖 `.pth` → 走完整上传链路）

- **风险**
  - 真实 OS 拖拽（尤其文件夹）与合成事件不完全等价，递归分支未真机验证
  - `applyFilesToInput` 依赖 `new DataTransfer()`（Chromium / Firefox / Safari 14+ 可用）；
    失败时只影响原生控件的文件名显示，功能本身已生效（已 try/catch）
  - 上传区大小按各页容器而定，训练页那条是「输入框 + 按钮」那一行，落点需要看提示文案
  - 测试过程中产生过两处残留（`trainer/.data/uploads/74c67028fe`、`.data/vc/models/fake-weight.*`），
    已按规矩送进**回收站**（未硬删除），模型目录复核后只剩原有 3 个 .pth

- **下一阶段入口**：请用户从资源管理器真拖一个语料文件夹进训练页，确认递归取文件；
  若要更贴心，可在拖目录后汇总「收了 N 个、跳过 M 个非音频」

## 阶段 24 — 启动预加载选择（双轨策略 + 显存与模型挂钩）[计划时间：10.5 22:10 BY CodeBuddy][完成时间：10.6 00:10 BY CodeBuddy]
- 分支：feature/vc-svc

- **起因**：用户裁决 —— IndexTTS 与网易谁当主力**由使用测试判断**，不预设；
  先走**双轨**，新增「网页启动时选择预加载哪个模型」的功能；
  磁盘不是瓶颈，**真正的问题是运行性能与显存**，需要细致处理；不考虑商用。

- **已完成**
  - **网关自己会读显存**（`server/src/lib/vram.ts`）：nvidia-smi 优先，3 秒缓存。
    为什么需要：原来显存数字来自网易服务，**它没起时就没有这个数**，
    而「启动要不要预加载」这个判断恰恰要在任何服务都还没起来时做
  - **预加载服务**（`server/src/services/preload.ts`）
    - 模型账本写成一张表，每个模型的 `vram_mb` 标注来源（网易 6144 取自
      `tts_engine.REQUIRED_VRAM_MB`；GPT-SoVITS 3072 取自 trainer 引擎注册表），方便实测校准
    - 执行顺序刻意是 **先让位 → 再检查 → 最后加载**：反过来会因为另一套还占着显存
      而必然检查失败，且失败原因会误导用户（以为卡太小）
    - 偏好持久化在 `server/.data/preload.json`；`'ask'` = 每次启动问用户
  - **接口**：`GET /api/preload/catalog`（账本 + 当前显存 + 装不装得下）、
    `GET /api/preload`、`PUT /api/preload/preference`、`POST /api/preload`（执行）
  - **网关启动**时按偏好自动预加载（不 await，界面先出来）
  - **前端**：`StartupPreloadDialog`（偏好为 ask 时开机弹出，列出每个模型的显存代价与当前余量，
    默认选中第一个**装得下**的，可勾「记住这次选择」）；设置页新增「启动时预加载的模型」分组

- **未完成**
  - IndexTTS 尚未接入，账本里暂时只有网易与 GPT-SoVITS；接入时只需在
    `preload.ts::MODELS` 加一项（方案见 `docs/INDEX-TTS-INTEGRATION.md`）
  - 未实测「预加载 GPT-SoVITS」的完整耗时（走的是与设置页开关相同的路径，此前实测 43.9 秒）

- **改动文件**：新增 `server/src/lib/vram.ts`、`server/src/services/preload.ts`、
  `server/src/routes/preload.ts`、`app/src/lib/preload.ts`、
  `app/src/components/features/StartupPreloadDialog.tsx`；
  改 `server/src/{index.ts,routes/index.ts}`、`app/src/{App.tsx,pages/SettingsPage.tsx}`

- **测试结果**：`typecheck` / eslint / `build` 全通过。接口实测：
  `GET /api/preload/catalog` → 偏好 ask、空闲 **3527 MB / 共 8188 MB**（nvidia-smi）、
  `netease-tts needs 6144 fits=false`、`sovits needs 3072 fits=true` —— 判断与事实一致，
  且**如实提示网易当前装不下**；`POST /api/preload {model:none}`、`PUT preference {model:ask}`
  返回正常；非法取值走 400

- **风险**
  - 预加载失败只进 toast 与日志，界面没有常驻提示（后续可在侧栏状态卡体现）
  - 显存门槛是估计值/上游值，实测后需回填校准
  - 预加载 GPT-SoVITS 会把「默认停用的服务」打开 —— 这是预期行为，但会改变用户的默认状态

- **下一阶段入口**：用实际合成对比两套模型（决定主力）；IndexTTS 接入后往账本加一项

## 阶段 25 — IndexTTS 本地服务骨架落地 [计划时间：10.5 22:10 BY CodeBuddy][完成时间：10.6 00:20 BY CodeBuddy]
- 分支：feature/vc-svc
- 已完成：
  - 阶段 0/1/2 连续执行（同会话自动续作）：环境核实（CUDA Toolkit 12.8.93 / uv 0.11.16 / 磁盘 664 GB）
    → `git clone --depth 1` 上游到 `indextts/upstream` → `uv sync`（清华镜像，torch 2.8.0+cu128，
    Python 3.11.13 由 uv 自动选择；DeepSpeed/WebUI extras 未装，fastapi/uvicorn/python-multipart 后补）
    → ModelScope 下载 IndexTTS-2.5 权重 **5.11 GB** 到 `indextts/upstream/checkpoints`（含 config.yaml）
  - 服务骨架：`indextts/server.py` + `indextts/app/{config,hardware,errors,indextts_engine,api}.py`，
    端点与网易同构（`/health` 永远 200、`/v1/pipeline|warmup|unload|synth`），
    显存口径 nvidia-smi 优先（与坑 17 修法一致），准入门槛 3072 MB（估计值）
  - 启动器 `scripts/indextts.mjs`（含 `--skip-if-missing`），`package.json` 加 `dev:indextts` / `indextts:check`
- 未完成：
  - **真实合成未实测**（模型未加载跑过一次 infer）；情感向量 / 拼音注音 / 语速倍率未接
  - 网关透传 `/api/indextts/*`、前端页面、`ResourceBudget` 成本表加 `indextts`、arbiter 引擎项 —— 全部未做
  - 三套服务（trainer / netease / indextts）的预加载账本只登记了前两套
- 改动文件：新增 `indextts/{server.py,app/*.py}`、`scripts/indextts.mjs`；
  改 `package.json`、`.gitignore`（忽略 upstream / .venv / checkpoints / .data）
- 测试结果：上游 venv 导入验证（indextts/omegaconf/librosa/modelscope 全 ok）；
  torch 2.8.0+cu128 CUDA=True；`--check` 体检通过（权重 config.yaml 在位）；
  服务启动后 `/health` = `{ok:true, cuda:true, vram.free=2963, source:nvidia-smi, engine.loaded:false}`
- 风险：`infer()` 的实际调用签名按官方 README 写，未跑过 —— 首次真实合成可能要对参数；
  `use_cuda_kernel` 默认关（Windows 编译环境不确定）；RTF 0.2065 是 4090 数据，本机需实测
- 下一阶段入口：真实合成实测（`/v1/warmup` + `/v1/synth`，用上游 examples 音频）；
  之后接网关透传与前端
- 本次文档更新时间：10.6 00:35

## 阶段 26 — IndexTTS 全链路接入：真实合成实测 + 网关透传 + 前端页面 + 资源管控 [计划时间：10.06 11:00 BY Qoder][完成时间：10.06 12:20 BY Qoder]
- 分支：feature/vc-svc

- **起因**：接续阶段 25（骨架已跑通 /health 但真实合成未实测）。按看板既定任务做阶段 26。

- **已完成**
  - **26a 真实合成实测**（跑通 6 条：中文 ×5、情感向量 ×1、经网关 multipart ×1）：
    - 输出 22050 Hz WAV，RMS 0.02~0.03 / 峰值 0.18~0.34，音频有效；
    - **稳态 RTF 2.2**（暖态 6.9s 音频 / 15.5s），冷启动首条 6.0；显存被桌面挤压时恶化到 5.4~14.4（波动大）；
    - **实测模型常驻约 5.3 GB**（加载前 free 5548 → 加载后 281），远超阶段 25 估计的 2~3 GB；
    - warmup 首跑约 4 分钟，**大头是上游对辅助模型（bigvgan/campplus）的 ModelScope/hf-mirror 网络探测超时**，权重其实全在本地 —— 真·加载仅约 10 秒。
  - **修掉 3 个骨架必挂 bug**（都在 `indextts/app/`）：
    - `IndexTTS2(...)` 传了上游不存在的 `use_cuda=` 参数（上游是 `device`）→ 首次加载即 TypeError；
    - `_guard_vram` 从模块导入 `REQUIRED_VRAM_MB`（实为类属性）→ 导入即 ImportError；
    - 模型常驻后合成被自己的显存准入拦死（free=451 < 3072 报 VRAM_INSUFFICIENT）→ guard 改为**已加载即跳过**。
  - **情感与语速接入**：`generate()` 与 `/v1/synth` 新增 `emo_vector`（8 维 JSON：喜/怒/哀/惧/厌恶/低落/惊喜/平静）、`emo_file`（情感参考音频）、`emo_alpha`、`duration_factor`（0.5~2.0，骨架已有）；新增 `GET /v1/catalog`（语种/滑杆范围/情感维度/准入门槛，服务端唯一事实源，与坑 19 同一哲学；文本描述控情感需额外 0.6B 模型，`emo_text_control:false` 如实报不接）。
  - **网关透传**：`server/src/routes/indextts.ts`（与 netease 同构的 node:http + pipe 透明转发 + 5 秒缓存探活，无 supervisor）挂 `/api/indextts`（**在 express.json() 之前**，坑 20）；`/api/health` 汇总加 `indextts` 段；config 加 `indextts.baseUrl/proxyTimeoutMs`（`INDEXTTS_URL` 可覆盖，回环口径不变）。
  - **资源管控三服务化**：arbiter（`ServiceName`/`RELEASE_ENDPOINTS`/`serviceOf`/`baseUrlOf`/focus/releaseAll/心跳的 others 全部从「二服务」扩到「三服务」，回环校验硬边界原样保留）；`/api/resources/focus` 的 ENGINES 加 `indextts-tts`；preload 账本 `MODELS` 加 `indextts-tts`（3072 准入口径 + 注释写明实测常驻 5.3 GB 与门槛待校准）；前端 `arbiter.ts`/`resources.ts`/`ResourceBudget`/`preload.ts` 类型与兜底同步。
  - **前端**：`app/src/pages/IndexttsTtsPage.tsx`（引擎状态卡 + 预热/卸载、参考音频上传/音色库选取双 tab、语种、时长系数滑杆、情感三模式〔跟随/8 维向量/情感参考+alpha〕、useResultStack 结果栏、useFileDrop 拖拽、内联错误卡带 hint）；`app/src/lib/indextts.ts` 客户端 + `app/src/types/indextts.ts` 契约；导航注册四处（NavKey / AppShell 状态文案 + NAV_GROUPS 新组「IndexTTS · 情感可控」+ 状态卡 / App.tsx 探活轮询 + 条件渲染 / PAGE_META）。
  - **用户走查后的两处 UI 修复（10.06 12:45 补）**：
    - 侧栏状态区改**纯手动展开/折叠**（`AppShell.tsx`）：去掉「探活期间强制全列、就绪后自动收起」的自动切换，折叠=只剩标题行（含 N 项待处理计数），展开=全部卡片，只由用户点击控制；
    - RVC / DDSP-SVC 页**目录拉取失败不再整页替换**（`VoiceConversionPage.tsx` / `SingingConversionPage.tsx`）：原 `if (loadError) return <报错卡>` 在冷启动场景表现为「先渲染完整页 → 几十秒后整个换成一张报错卡」；改为完整页常驻 + 页内 amber 横幅（标题「模型目录暂未取到」+ 重试按钮），浏览器实测两页均通过。

- **未完成**
  - 准入门槛 3072 偏低（实测常驻 5.3 GB）：是否上调到 ≈5120 **待用户拍板**——调高会挡住正常桌面状态下的开机，调低靠实测兜底。账本注释已标。
  - 主力对比（网易 vs IndexTTS）需用户亲自听感 + 用时判断；本轮只交付了客观数据（见 26a）。
  - 合成页的英文/日文语种、情感参考音频分支只过了 API，未逐一 UI 点；音色库取参考音频分支复用了网易页同一套代码路径（阶段 23 已实测过）。

- **改动文件**
  - Python：`indextts/app/indextts_engine.py`、`indextts/app/api.py`
  - 网关：`server/src/routes/indextts.ts`（新）、`server/src/{index.ts,config/index.ts,routes/index.ts,routes/resources.ts,services/arbiter.ts,services/preload.ts}`
  - 前端：`app/src/pages/IndexttsTtsPage.tsx`（新）、`app/src/lib/{indextts.ts（新）,resources.ts,arbiter.ts,preload.ts}`、`app/src/types/{indextts.ts（新）,index.ts,sovits.ts}`、`app/src/{App.tsx,components/layout/AppShell.tsx,components/features/ResourceBudget.tsx}`

- **测试结果**：`npm run typecheck`（app+server）✓；`eslint` 全部改动文件 ✓；`npm run build` ✓；
  经网关 multipart 合成 200（`/api/indextts/v1/synth`）✓；`/api/health` 的 `indextts.reachable=true` ✓；
  预加载弹窗正确显示 IndexTTS-2.5 账本项与「当前显存不够」判定 ✓；
  浏览器走查：导航新组渲染、切页成功、情感 Select 三选项、8 维滑杆 + alpha、合成按钮在未选参考音频时正确禁用、控制台无新报错（只有原有的 sovits 503 探活噪音，服务默认停用属预期）。

- **风险**
  - RTF 对桌面显存占用极度敏感（2.2 → 14.4），8 GB 卡上「够不够跑」取决于当时有多少程序在抢显存；文档与 hint 文案都按实测口径写了。
  - 上游 `infer()` 的情感向量与 emo_audio 同时给时行为由上游决定（我们只透传，不猜语义）。
  - warmup 首跑的 4 分钟网络探测无法配置绕过（上游写死 ModelScope→hf-mirror 顺序），断网环境下可能更久或直接失败——已在 catalog/页面文案注明。

- **下一阶段入口**：用户实测对比网易 vs IndexTTS 后拍板主力（回填 preload 账本与门槛值）；若继续，R2T2 离线转写（HANDOFF 坑 12：Windows 原生可行）是下一个高优先级项。
- 本次文档更新时间：10.06 12:45

## 阶段 26补2 — 设置页整体重排（模型选择提级 + 服务平铺 + 去嵌套）[计划时间：10.06 13:00 BY Qoder][完成时间：10.06 13:20 BY Qoder]
- 分支：feature/vc-svc

- **起因**：用户反馈设置页混乱——「语音模型与语言」还写着「默认使用小米 MiMo」（现状是网易/IndexTTS 本地模型）；
  「启动时预加载模型」嵌在 GPT-SoVITS 服务卡里，层级错位；要求重排为「用户选哪个模型就直接加载哪个」。

- **已完成**
  - **新①「模型与显存」**（页面第一张卡）：开机预加载从 GPT-SoVITS 卡里提出来独立成卡，
    选项做成卡片网格（网易 6.0GB / IndexTTS 3.0GB / GPT-SoVITS 3.0GB / 每次问我 / 不预加载），
    每张显示显存代价与「当前空闲不够」判定；顶部显示当前空闲显存与读数来源（nvidia-smi）。
  - **新②「本地服务」**：三个 Python 运行时平铺一屏——网易(:9882) / IndexTTS(:9883) / GPT-SoVITS(:9881)
    各一行，状态徽章 + 启停方式说明；GPT-SoVITS 行的开关（网关唯一托管的）与冷启动进度条保留。
  - **新③「GPT-SoVITS · 推理与训练配置」**：服务地址 / 运行时信息 / blockers / 推理权重面板 /
    默认版本 + 音色 + 语种 / 批量合成默认值，全部归到这一张卡（标题明确「只作用于 GPT-SoVITS 链路」）。
  - **新④「云端合成 · MiMo 与接口密钥」**：原「语音模型与语言」的 Provider 选择（云端三页的后端，
    不能删——SynthesisPage/VoiceClone/VoiceDesign 依赖 providerId）与 API 密钥卡合并，
    删掉过时文案「默认使用小米 MiMo」，说明改为「侧栏 MiMo 云端组的后端与密钥，本地模型不经过这里」。
  - ⑤合成偏好、⑥站点与模型信息保持；⑥的「已接入模型」从只列 MiMo MODE_META 改为五条链路清单。
  - 类型：`HealthInfo` 补 `netease` / `indextts` 字段（网关早已返回，前端类型没声明）+ `GatewayServiceStatus`。

- **未完成**：无（本阶段范围内）

- **改动文件**：`app/src/pages/SettingsPage.tsx`（重排）、`app/src/types/index.ts`

- **测试结果**：typecheck / eslint / build 全过；浏览器实测——第一卡显存判定正确（空闲 3.9GB：网易标
  「当前空闲不够」，3.0GB 两项不标），三服务徽章正确（网易/IndexTTS 运行中、GPT-SoVITS 未连接），
  六张卡齐全、旧文案「默认使用小米 MiMo」「语音模型与语言」无残留，控制台无新报错。

- **风险**：Provider 选择卡挪进云端卡后，`providerId='gpt-sovits'` 的老选项仍在（云端三页兼容），
  未做删除——若后续确认无人用可清理。

- **下一阶段入口**：不变（用户 A/B 定主力；R2T2 离线转写）
- 本次文档更新时间：10.06 13:20

## 阶段 26补3 — 三服务连接开关 + 设置页去嵌套 [计划时间：10.06 13:40 BY Qoder][完成时间：10.06 14:05 BY Qoder]
- 分支：feature/vc-svc

- **起因**：用户三点反馈——① 本地服务三行都该有开关（两个服务同时在跑会各占显存，影响单独跑模型）；
  ② 「GPT-SoVITS · 推理与训练配置」不该独立成卡，应并入 GPT-SoVITS 服务行内展开；
  ③ 云端卡里又嵌了一套 GPT-SoVITS 配置，且 API Key 应只在选中 MiMo 时才出现。

- **已完成**
  - **网关新增运行时服务托管**（`server/src/services/runtime.ts`）：通用 `RuntimeSupervisor`，
    网易(:9882) 与 IndexTTS(:9883) 各一实例。行为契约与 SovitsSupervisor 一致：
    探活可达就复用外部实例（不重复占端口）；enabled 落盘 `server/.data/<id>-service.json`
    （网易默认开=主服务随 dev，IndexTTS 默认关）；关闭 = **先卸常驻模型归还显存 → 再杀自己拉起的进程树**；
    外部终端起的实例杀不掉，但模型照卸，hint 如实说明「请在对应终端 Ctrl+C」。
    网关启动时按 enabled 后台拉起；SIGINT/exit 钩子收掉自己托管的子进程（tsx watch 重启不留孤儿）。
  - **启停接口**：`GET/POST /api/netease/service`、`/api/indextts/service`（`routes/runtimeService.ts` 工厂，
    挂在各自透明代理**之前**，与 sovitsServiceRouter 同规矩）；`/api/health` 的 netease/indextts 段补 `enabled`。
  - **设置页卡片②**：三行服务全部带 Switch + 状态徽章（运行中/启动中/未启动）+ 错误行；
    卡描述明确两层占用：「服务进程 ≈ 几百 MB torch 上下文；模型常驻数 GB，要预热/预加载才发生」。
  - **GPT-SoVITS 高级配置行内展开**：原独立卡整块并入服务行下方（「高级配置」按钮 + ChevronDown），
    默认收起；服务地址/运行时信息/weights/默认值/批量都在展开区里。
  - **云端卡条件渲染**：选 MiMo 才出现公用密钥 Alert + API Key + 接口地址；
    选 GPT-SoVITS 显示指引卡（「不需要密钥，配置统一在本地服务 → 高级配置」，消除双份配置的嵌套）；
    选自托管显示其 fields/presets。
  - 前端 `localService.ts` 加 `runtimeServiceApi`（state/toggle），30 秒轮询复查状态（服务可能被外部起停）。

- **未完成**：无（本阶段范围内）

- **改动文件**：新增 `server/src/services/runtime.ts`、`server/src/routes/runtimeService.ts`；
  改 `server/src/index.ts`、`server/src/routes/{netease,indextts}.ts`、
  `app/src/lib/localService.ts`、`app/src/pages/SettingsPage.tsx`、`app/src/types/index.ts`

- **测试结果**：typecheck（app+server）/ eslint / build 全过；接口实测——
  `GET /api/netease/service` = reachable+enabled+managed=false（复用 dev 起的实例）✓；
  `POST /api/indextts/service {enabled:false}` → 模型卸掉（pipeline loaded=false）+ hint 说明外部实例 ✓；
  浏览器走查：三行开关渲染、高级配置展开/收起、选 GPT-SoVITS 时密钥区隐藏 + 指引出现、
  切回 MiMo 密钥区恢复；控制台无新报错。

- **风险**：网关热重载（tsx watch）会连带回收**自己托管**的 netease/indextts 子进程并自动再拉起（enabled 时）——
  与 sovits 同一已知代价；外部终端起的实例不受此影响。

- **下一阶段入口**：不变（用户 A/B 定主力；R2T2 离线转写）
- 本次文档更新时间：10.06 14:05

## 阶段 26补4 — 显存不足时报错列出「谁在占 GPU」 [计划时间：10.06 14:20 BY Qoder][完成时间：10.06 14:35 BY Qoder]
- 分支：feature/vc-svc
- **起因**：网易预热失败实为显存准入拦截（需 5120 MB、仅剩 3919 MB），但旧报错只说「关掉占显存的程序」，用户无从下手。
- **已完成**：网关 `server/src/lib/gpuProcesses.ts`（nvidia-smi 进程表按名聚合、过滤无权限占位、10s 缓存）+
  `GET /api/resources/gpu-processes`；ResourceBudget 在 insufficient/tight 时列出进程清单（WDDM 拿不到每进程显存数，
  只报谁在与实例数）。实测本机 40+ GPU 进程（qemu 模拟器 / Epic / Trae / 网易云 / MyDockFinder 等）。
- **改动文件**：`server/src/lib/gpuProcesses.ts`（新）、`server/src/routes/resources.ts`、
  `app/src/lib/resources.ts`、`app/src/components/features/ResourceBudget.tsx`（提交 `b55744c`）
- **测试**：typecheck / eslint / build ✓；端点与页面渲染实测 ✓
- **风险**：无
- **下一阶段入口**：用户关程序腾显存后重试预热
- 本次文档更新时间：10.06 14:35

## 阶段 26补5 — 侧栏状态卡一键直达设置对应区块 [计划时间：10.06 14:40 BY Qoder][完成时间：10.06 15:00 BY Qoder]
- 分支：feature/vc-svc

- **起因**：用户要求左侧状态栏每张卡点击直达设置页对应位置，就地换模型 / 开关服务。

- **已完成**
  - `AppShell.tsx`：状态卡 div → button（hover 反馈 + title 提示），新增 `onOpenSettingsSection` prop；
    卡 id → 设置锚点映射 `SETTINGS_SECTION_OF`（网易两卡→网易行、IndexTTS→其行、
    sovits/rvc/svc/asr 四卡→GPT-SoVITS 行、MiMo→云端卡）。
  - `App.tsx`：`settingsSection` state + `goSettingsSection`（切页 + 传锚点）。
  - `SettingsPage.tsx`：`focusSection`/`onFocusHandled` props；挂载/变化后 120ms 滚动到
    `settings-<section>` 锚点（block:center）并加 2.6 秒紫色 ring 高亮；五个锚点 id 落位：
    preload / service-netease / service-indextts / service-sovits / cloud。
  - **顺带修文案**：预加载卡「当前空闲不够，开机会让位后再试」→「当前空闲不够，开机可能加载失败（可先关程序再试）」（原句不通）。
  - **验证了网关托管启停全链路**（26补3 的 supervisor 首次实测）：UI 点 IndexTTS 开关开 →
    网关 spawn（managed=true, pid 就位, /health 200）→ 再点关 → 进程回收、free 回到 5346 MB、
    状态卡变「未启动」。

- **未完成**：无（本阶段范围内）

- **改动文件**：`app/src/components/layout/AppShell.tsx`、`app/src/App.tsx`、`app/src/pages/SettingsPage.tsx`

- **测试结果**：typecheck / eslint / build 全过；浏览器实测：点「IndexTTS · 未启动」卡 →
  切到设置页、锚点滚进视口、高亮 ring 生效、行内开关可点；开关开→关全链路见上。

- **风险**：锚点消费走一次性 state（onFocusHandled 清空），重复点同一张卡会重新触发滚动（预期行为）。

- **下一阶段入口**：不变（用户 A/B 定主力；R2T2 离线转写）
- 本次文档更新时间：10.06 15:00

## 阶段 26补6 — IndexTTS 页引擎状态卡补「启动服务」快捷入口 [计划时间：10.06 15:20 BY Qoder][完成时间：10.06 15:35 BY Qoder]
- 分支：feature/vc-svc

- **起因**：用户要求 IndexTTS 引擎状态像 GPT-SoVITS 一样给快速开启入口——服务没起时不必离开本页去设置页/终端。

- **已完成**：`IndexttsTtsPage` 引擎状态卡在连不上服务时显示「启动服务」按钮，
  走 `runtimeServiceApi.toggle('indextts', true)`（与设置页开关同一后端，网关托管拉起）；
  启动中按钮转圈带文案，成功后自动重拉 catalog/pipeline 恢复卡片，失败给带 hint 的结构化错误。

- **改动文件**：`app/src/pages/IndexttsTtsPage.tsx`

- **测试结果**：typecheck / eslint / build ✓；浏览器实测：服务关闭态进本页 → 点「启动服务」→
  网关 spawn（managed=true）→ toast「服务已启动」→ 卡片恢复「未加载 + 预热」；测试后已关闭服务归还原状。

- **风险**：无

- **下一阶段入口**：不变（用户 A/B 定主力；R2T2 离线转写）
- 本次文档更新时间：10.06 15:35

## 阶段 26补7 — 音色库独立存储（跨模型通用）+ 资源站入口常驻顶栏 [计划时间：10.08 14:30 BY Qoder][完成时间：10.08 15:30 BY Qoder]
- 分支：feature/vc-svc

- **起因**：用户两点反馈——① IndexTTS 页「从音色库选择」必须把 GPT-SoVITS 服务拉起来才能用
  （音色库曾住在 trainer :9881 里，而它默认停用），逻辑离谱；要求音色库有独立存储路径、多模型通用。
  ② AI Hobbyist 资源库链接散落在三处页内，应常驻每个页面右上角（浏览器批注指向变声页那条）。

- **已完成**
  - **共享存储**：音色库迁到仓库根 `voicelib/`（`voices.json` + `voices/<id>.<ext>`，已进 .gitignore）。
    网关与 trainer 读写**同一份**；环境变量 `VOICES_LIB_DIR` 两端同参可改位置。
  - **网关原生音色库接口**（新增 `server/src/services/voiceLibrary.ts` + `routes/voicelib.ts`，
    挂 `/api/voicelib`，早于全局 express.json）：列表 / 详情 / 音频回放 / 创建（原始字节体 + 查询参数元数据，
    不引 multer）/ 磁盘路径登记 / 更新 / 替换音频 / 删除。响应形状与 trainer `Voice.to_dict()` 一致，
    前端 `SovitsVoice` 类型零改动。
  - **一次性迁移**：网关首次访问时若 `voicelib/` 为空且 `trainer/.data/voices.json` 存在 →
    复制托管音频、改写 audio_path、写新索引，旧索引**改名保留**
    （`.migrated-to-voicelib`，不删除）。实测本机 1 条音色迁移成功。
  - **trainer 指向共享目录 + 跨进程热重载**：`Settings.voices_lib_dir`（新）；
    `VoiceLibrary` 读写前按索引 mtime 刷新内存表——否则 trainer 启动后网关新增的音色
    会被 trainer 任何一次 persist **整表覆盖丢**（新坑 27）。
  - **时长/采样率改由浏览器探测**：Node 侧没有 soundfile/ffprobe，`probeAudioFile`（AudioContext 解码）
    在登记时随查询参数带上；GPT-SoVITS 的 3~10 秒警告口径不变。
  - **前端全部切到网关**：新 `app/src/lib/voices.ts`（voiceApi）；音色库页 CRUD、
    IndexTTS / 网易页音色 tab、批量页与 SovitsVoicePicker 列表源都改走 `/api/voicelib`；
    音色场景下的 `SovitsServiceNotice` 与「音色库来自 GPT-SoVITS」文案清除；
    sovits.ts 里已无人调用的音色方法段删除。trainer 的 `/v1/voices*` 保留（读写同一份，API 兼容）。
  - **资源站入口常驻右上角**：`ResourceSiteLink` 改紧凑形态挂进 AppShell 顶栏（所有页面可见），
    训练 / 变声 / 翻唱三处页内旧入口移除。

- **未完成**：无（本阶段范围内）

- **改动文件**：新增 `server/src/services/voiceLibrary.ts`、`server/src/routes/voicelib.ts`、
  `app/src/lib/voices.ts`；改 `server/src/index.ts`、`trainer/app/config.py`、`trainer/app/api.py`、
  `trainer/app/sovits/voices.py`、`trainer/.env.example`、`.gitignore`、
  `app/src/pages/{VoiceLibraryPage,IndexttsTtsPage,NeteaseTtsPage,BatchPage}.tsx`、
  `app/src/components/features/{SovitsVoicePicker,ResourceSiteLink}.tsx`、
  `app/src/components/layout/AppShell.tsx`、`app/src/App.tsx`、`app/src/lib/sovits.ts`；
  三页移除页内 ResourceSiteLink（TrainingPage / VoiceConversionPage / SingingConversionPage）

- **测试结果**：typecheck（app+server）/ eslint / build 全过；Python ast 自检过。
  接口实测：GET 列表含迁移记录 ✓、音频回放 200 audio/mpeg ✓、POST 创建（含中文元数据 + 原始字节体）✓、
  DELETE ✓。跨进程验证：独立 Python 实例读 voicelib 看到网关新增音色，网关删除后**不重启即感知** ✓。
  浏览器实测（GPT-SoVITS :9881 全程停用）：网易页与 IndexTTS 页「从音色库选择」直接列出「男 · 5.4s」并可选中；
  音色库页正常渲染（无服务提示卡）；UI 新建音色走通（浏览器解码报 4.0 秒 → 保存 → 列表刷新）；
  UI 删除走通；顶栏「资源库」链接在网易 / IndexTTS / 音色库页均常驻，指向 https://res.acgnai.top/；
  控制台无新报错（仅服务未起的 503 探活噪音）。

- **风险**：① 迁移只由网关触发——若有人只跑 trainer 不跑网关，音色库会显示为空（旧索引改名保留，
    起一次网关即恢复）；② 两进程并发写同一 JSON 的窗口极小（本地场景），真撞车以后写者为准；
    ③ 时长探测改在浏览器，用 curl 直连创建时 duration_s 可为空（只影响警告展示，不影响合成）。

- **下一阶段入口**：不变（用户 A/B 定主力；R2T2 离线转写）
- 本次文档更新时间：10.08 15:30

# PROGRESS

> 按 `token-efficient-agent-workflow` 规范维护。每阶段独立、可验证、可交接。

## 进度看板
- 最新完成：**阶段 38 = GPT-SoVITS v5 设置页服务控制与全站状态卡贯通**（10.19 13:26 BY Antigravity）—— 设置页补齐 `settings-service-gsv5` 本地服务卡（:9885，状态指示灯/未托管进程检测/最后错误提示/平滑启停 Switch）；侧栏状态卡与锚点路由接入 `gsv5Tts`；App.tsx 增加独立探活循环并与 supervisor 联动；`package.json` 补齐 `gsv5:check` 脚本；双工程 typecheck 与 production build 全绿。
- 最新完成：**阶段 37（K 系列）= AI 声音知识图谱与规范导出包**（10.19 03:15 BY ZCode）—— 对齐 `aiPaintingKownledge` 体系：7 篇 Markdown 核心规范手册（`knowledge-export/`）+ Linear 极简暗色交互门户（三大一等视图：篇目 / 术语速查 / 工具资源，全 token 化）+ 全局搜索 + hash 路由 + `knowledge-inbox` 收集缓存与 5 步整合工作流；`node knowledge-export/build.js` 10 份手册校验生成全通。
- 最新完成：**阶段 36 = GPT-SoVITS v5 本地化（v5dev / v5turbo 第五运行时）**（10.18 15:10 BY ZCode，10.19 补齐源码与 launcher）—— 独立 venv(py3.12+cu128) + upstream 核心代码与权重就位 + 双变体试金石通 + 网关透传代理与 supervisor + 前端 `Gsv5Page` 全链路接入与体检通过（`node scripts/gsv5.mjs --check` 退出码 0）。
- 最新完成：**阶段 35补1 = 工程技能配置 + 工作池 triage + ready-for-agent 清空**（10.17 22:20 BY ZCode）—— 规范标签体系落地，GitHub Issues 工作池 11 张票建立，#6 (TermTip 补三页) / #7 (SynthesisPage useResultStack 统一) / #8 (ddsp-svc 旧根收口真迁移) 全部交付并关票。
- 当前正在开发任务 / 工作池跟踪（GitHub Issues）：
  - `ready-for-agent` 0 张（已清空）；
  - `ready-for-human` 5 张（#1~#5 真机走查：#1 产出记录三源合并、#2 RVC 训练前端入口、#3 GPT-SoVITS 两段式选择器、#4 变声/翻唱加载、#5 Irodori 整链路与耳朵验收）；
  - `needs-triage` 3 张（#9 变声/翻唱合成下拉换源、#10 R2T2 离线转写接入、#11 网易合成页档位选择器）；
- 硬件窗口状态：当前空闲显存 **~6.1 GB**（6124 MB free），具备真机运行、GPU 冒烟与推理验证条件。
- 下一阶段任务：
  1. 依据当前空闲显存（~6.1GB）推进真机走查或 GPU 实测（Gsv5 / Irodori）；
  2. 针对 #9 / #10 / #11 评估推进或立项；
  3. 用户侧真机走查（#1~#5，显存充足窗口可跑）。
- 可提前进行的任务：利用当前 6.1GB 空闲显存执行 Irodori 训练/合成真机冒烟测试与 gsv5 GPU RTF 实测。
- 未完成的任务：用户侧真机人工走查（#1~#5，含耳朵验收）。
- 已否决路线：GPT-SoVITS 整体迁移到 Genie-TTS（阶段 27 否决）；dots.tts 试点（阶段 28 否决）。

## 编号说明（2026-10-06 合规整理时补记）
- 历史上出现过**两组同号阶段**：「阶段 23」= 浏览器走查 与 文档修正、「阶段 24」= 全站拖拽导入 与 启动预加载。
  编号已被 HANDOFF（坑 22~25）与提交信息交叉引用，**不改号**，仅按完成时间相邻排序：
  走查(≤10-06 00:37) → 文档修正(10-06 00:37) → 拖拽(≤10-06 00:37) → 启动预加载(10-06 01:19)。
- 另有一次未单独立目的「阶段 26补」（侧栏手动折叠 + RVC/SVC 页去整页报错，提交 b1ee653），
  内容已并入「阶段 26」条目的补记段，不重复列。
- 早期条目（阶段 1~20）的署名与完成时间多为本次整理时按 git 提交时间**补记**；无法证实的标「未记录」，不臆造。
- **原「阶段 29（计划）」条目已转为实施条目（后端对齐 10.10 落地），就地保留在计划块首位**，
  紧邻「阶段 30（计划）」；**阶段 34 之前不再搬移**，避免大范围改动历史顺序。
- **计划态条目（阶段 30 的「计划」条目，未动代码）单独成块、排在已完成阶段之后**，
  不计入「已完成阶段」的升序核对；阶段 32 及以后的新条目一律追加在该计划块之后（阶段区尾部）。

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

## 阶段 26补8 — 音色库管理页完整化（批量/搜索/筛选/分页） [计划时间：10.08 15:40 BY Qoder][完成时间：10.08 15:57 BY Qoder]
- 分支：feature/vc-svc

- **起因**：用户要求把音色库页升级为功能完整的管理页：列表含名称/类型/大小/导入时间、手动导入入口、
  批量删除与批量导出、搜索筛选、分页、导入状态提示与错误处理。另要求调研同类音色资源站（结果见本条风险下方备注，未入库）。

- **已完成**（全部为前端 `VoiceLibraryPage.tsx` 重写，网关/trainer 零改动——阶段 26补7 的接口面已够用）
  - **列表化**：卡片网格 → 表格式行（复选框 / 名称+标签 / 类型徽标 / 语种 / 时长 / 大小 / 导入时间 / 状态徽标 / 操作），
    窄屏按 md/lg/xl 逐级收起次要列；点行展开 → 试听、参考文本、备注、id、磁盘路径、完整警告。
  - **搜索与筛选**：关键词（名称/标签/备注/参考文本）+ 类型（本地托管/引用磁盘）+ 语种 + 状态（正常/有警告/文件丢失）
    四个条件全客户端过滤（本地库量级小），条件变化自动回第一页，一键清除筛选。
  - **排序与分页**：最近更新/最新导入/名称/时长/大小五种排序；10/20/50 条每页 + 上/下一页 + 计数。
  - **两种导入**：原「导入音色」弹窗保留（单条精导，带参考文本与一键智能转写）；
    新增「批量导入」——多选音频按文件名快速登记，逐条进度条（当前文件/已完成数/失败数），
    完成后汇总 toast；不支持格式与超 64 MB 在客户端先拦并逐个报原因。
  - **批量操作**：本页全选 + 跨页保持选择；选中后浮出操作条——批量删除（confirm + 汇总 toast）、
    批量导出音频（逐条从网关取回触发浏览器下载，文件名=音色名-id.原扩展名，350ms 间隔防多文件拦截）。
  - **编辑弹窗补强**：编辑里也能「一键智能转写」（自动取回该音色的参考音频喂 ASR，结果填入待核对）。

- **未完成**：无（本阶段范围内）

- **改动文件**：`app/src/pages/VoiceLibraryPage.tsx`（重写）

- **测试结果**：typecheck / eslint / build 全过；浏览器实测（GPT-SoVITS 仍停用）——
  注入 12 个合成 wav 批量导入（进度条 12/12、toast「已导入 12 条」、12 条缺文本警告正确标黄、分页 13 条 2 页）✓；
  搜索「测试音色05」筛出 3 条 ✓；状态筛选「正常」只剩「男」✓；本页全选 10 + 换页补选 2 = 已选 12 ✓；
  批量删除 12 条（网关复核 total=1、voicelib/voices/ 只剩 1 个文件）✓；批量导出 1 条（toast「已导出 1 条」+ 浏览器落盘）✓；
  拖入 .txt 被拦（toast「1 个文件被拒绝：不支持的格式 .txt」）✓；行展开试听/路径/警告 ✓。

- **风险**：① 批量导出连发多个下载会触发 Chrome「允许此网站下载多个文件」询问，toast 里已提示用户点允许；
    ② 批量快导登记的音色没有参考文本（GPT-SoVITS v3/v4 会报错），界面用警告 + 导入后提示引导补录；
    ③ 搜索/筛选全客户端——音色库到千条量级再考虑服务端分页，现阶段不预支复杂度。
  备注：音色资源站调研（用户附带需求）结论未入代码——最硬的同类渠道是 AI-Hobbyist GitHub 组织
  （res.acgnai.top 官方源码侧，数据集+训练好的模型免登录直下）；训练语料首选 AISHELL-3（Apache-2.0，OpenSLR 直下）；
  Emilia 量大但需 HF 账号申请；kbiao.net 与 B站若干模型配布可作补充（许可不明，谨慎商用）。

- **下一阶段入口**：不变（用户 A/B 定主力；R2T2 离线转写）
- 本次文档更新时间：10.08 15:57

## 阶段 26补9 — 显存监控小窗（右键停进程）+ 音色库独立入口 + 资源库展开面板 [计划时间：10.08 16:00 BY Qoder][完成时间：10.08 16:35 BY Qoder]
- 分支：feature/vc-svc

- **起因**：用户三点需求——① 资源预估窗加显存占用监控小窗：点击看后台进程、大户高亮、**右键菜单手动停止进程**，
  所有模型入口都要有；② 音色库从 GPT-SoVITS 导航组独立成单独入口，但 GPT-SoVITS 原训练入口不丢、改名区分；
  ③ 顶栏「资源库」改成展开式下拉面板，集中展示阶段调研的全部结果（含未核实的评论区/简介网盘链与 BV 快速链接），
  并在音色库页右侧约三分之一处内嵌同一面板。

- **已完成**
  - **网关**：`lib/gpuProcesses.ts` 重写——逐进程 pid + 显存读数（WDDM 拿不到就 null，界面标「未知」不编数）
    + 按名聚合视图（补 mem_mb/pids）；新增 `POST /api/resources/gpu-processes/kill`，护栏三连：
    pid 必须在强制刷新后的 nvidia-smi 快照里、系统关键进程名单（csrss/lsass/dwm/explorer 等）一律拒绝、
    网关自身 pid 拒绝；满足才 `taskkill /F /T`。与 arbiter「不扫描不主动 kill」的边界不冲突——只杀用户亲眼选中的。
  - **前端小窗**：新 `GpuMonitorWindow.tsx`（Dialog）——进程行按显存合计排序，≥1 GB 红标「显存大户」、
    ≥300 MB 琥珀「占用不小」、占比条可视化；右键行出 ContextMenu（逐 pid 停止 / 多实例全停，一次确认）；
    刷新按钮 + 结果回显条。挂在 `ResourceBudget` 头部「显存监控」按钮上——**所有模型入口一处接入全部生效**
    （网易/IndexTTS/批量/训练/变声/翻唱/ASR 共用底座）。
  - **导航**：音色库独立成组「音色库 · 跨模型共享 → 音色库管理」；GPT-SoVITS 组保留并改名训练入口
    「模型训练 → 音色微调训练」（hint 写明「训出专属权重后再回音色库登记」）；
    页头与四处「模型训练」文案引用同步。
  - **资源库面板**：新 `lib/resourceHub.ts`（调研快照 2026-10-08，五分类 20 条，每条带已核实/未核实标记与
    付费/需申请/网盘来源角标；B站三条真实网盘链：b23.tv 模型地址、夸克×2、百度+提取码）
    + `ResourceHub.tsx`（ResourceHubMenu 顶栏下拉 / ResourceHubList 内嵌列表，滚动浏览）；
    顶栏「资源库」由外链改为下拉展开栏；音色库页改 `lg:grid-cols-3`——左 2/3 管理表、右 1/3 资源库卡（sticky）；
    旧 `ResourceSiteLink.tsx` 移除（res.acgnai.top 收进面板第一条）。

- **未完成**：无（本阶段范围内）

- **改动文件**：新增 `app/src/components/features/GpuMonitorWindow.tsx`、`app/src/components/features/ResourceHub.tsx`、
  `app/src/lib/resourceHub.ts`；改 `server/src/lib/gpuProcesses.ts`、`server/src/routes/resources.ts`、
  `app/src/lib/resources.ts`、`app/src/components/features/ResourceBudget.tsx`、
  `app/src/components/layout/AppShell.tsx`、`app/src/pages/VoiceLibraryPage.tsx`、`app/src/App.tsx`、
  `app/src/lib/guides.ts`、`app/src/pages/AsrPage.tsx`；删 `app/src/components/features/ResourceSiteLink.tsx`

- **测试结果**：typecheck / eslint / build（app+server）全过。接口实测——gpu-processes 返回 32 类 37 进程含 pids ✓、
  kill 护栏：不存在的 pid 拒（NOT_LISTED）✓、pid 4 拒（PROTECTED）✓。浏览器实测——「显存监控」小窗打开列出进程与
  pid、「未知」如实显示；右键 cloudmusic 行出「停止进程 pid」菜单 ✓（未真杀任何进程）；顶栏「资源库」下拉含
  五分类 + 未核实徽标 + 洛天依/夸克链 + 滚动 ✓；导航「音色库 · 跨模型共享」独立成组、「音色微调训练」改名 ✓；
  音色库页左 496px/右 238px ≈ 2:1 内嵌资源库卡 ✓；控制台无新报错。

- **风险**：① 本机 WDDM 下 nvidia-smi 对所有进程都报 N/A——小窗的高亮/占比条依赖读数，读不到时按实例数排序、
    标「未知」，不假装精确；② taskkill /T 会带走子进程树，确认框已写明「未保存内容会一起丢」；
    ③ 资源库是 10.08 的调研快照，网盘链失效是常态——面板底部已注明快照日期与「商用前逐条自查」。

- **下一阶段入口**：不变（用户 A/B 定主力；R2T2 离线转写）
- 本次文档更新时间：10.08 16:35

## 阶段 26补10 — GPT-SoVITS 辅助两页：服务停用不再整页塌成错误卡 [计划时间：10.08 16:40 BY Qoder][完成时间：10.08 16:48 BY Qoder]
- 分支：feature/vc-svc

- **起因**：用户对照两张截图指出——「GPT-SoVITS · 辅助」组下的页面在服务停用时，
  应像训练页正常那样**整页渲染 + 顶部内嵌「服务未启动」提示**，而不是整页只剩一张错误卡（旧图形态）。

- **已完成**
  - `TrainingPage`：删除 `if (connectionError) return <整页 Alert>` 的提前返回；
    改为正常渲染整页，connectionError 存在时在「服务提示卡」下方补一条内嵌报错条
    （具体错误 + 「先用上方直接开启」+「重新加载」按钮）。
  - `BatchPage`：同款处理。另实测确认：音色列表走网关共享库后本页**离线也能完整可用**
    （connectionError 只在网关不可达时出现，提示卡常态显示「服务停用 + 直接开启」）。

- **未完成**：无（本阶段范围内）

- **改动文件**：`app/src/pages/TrainingPage.tsx`、`app/src/pages/BatchPage.tsx`

- **测试结果**：typecheck / eslint 过；浏览器实测（GPT-SoVITS 停用）——训练页整页渲染
  （资源预估卡含「显存监控」、语料与实验、流水线齐全）+ 提示卡 + 内嵌「本地服务未启动」报错条与重试 ✓；
  批量页整页渲染 + 提示卡 + 音色列表正常 ✓；控制台无新报错。

- **风险**：训练页探活要数秒才失败（health 超时），内嵌报错条会比提示卡晚出现几秒——与改造前一致，非新问题。

- **下一阶段入口**：不变（用户 A/B 定主力；R2T2 离线转写）
- 本次文档更新时间：10.08 16:48


## 阶段 27 — 引擎评估：Genie-TTS 与 dots.tts（含本机跨引擎实测基准） [计划时间：10.08 16:31 BY Qoder][完成时间：10.08 17:42 BY Qoder]
- 分支：feature/vc-svc

- **起因**：用户提出把 GPT-SoVITS 整体架构迁到 Genie-TTS（`github.com/High-Logic/Genie-TTS`），
  动机是「它能让生成的语音情感被明显操控」；随后追加 dots.tts（`github.com/studio-dots-ai/dots.tts`）
  与现有 IndexTTS-2.5 / 网易 Confucius4-TTS 一起对比。要求：先收集信息 + 跑数据，**不动任何项目代码**。

- **已完成**
  - **源码级核查 Genie-TTS**（浅克隆到临时目录，64 个 py 文件全量 grep）：确认它只是 GPT-SoVITS 的
    ONNX CPU 推理器 + 权重转换器，**情感控制为零**（全仓库只在 README 注释出现"情感和语调克隆"，
    即靠参考音频，与 GPT-SoVITS 同机制）；公开 API 无 `top_k/top_p/temperature/seed/speed`；
    FastAPI 6 个 POST 且无 `/health`；`Utils/Shared.py` 全局单槽参考音频是并发缺陷；
    版本只到 V2/V2ProPlus 且靠 `.pth` 体积 >150MB 猜版本（我们 `s2Gv2Pro.pth` = 155MB 会被误判）
  - **dots.tts 调研**：2B 连续 AR（Qwen2.5-1.5B + DiT flow-matching + 48kHz AudioVAE），Apache-2.0，
    当日仍在提交；官方 Python 路径要求 py3.10–3.12 + torch 2.8/CUDA 12.8 + bf16 5.3–7.9 GB +
    `torch.compile` 冷启动 ~3 分钟 → 本机 8.6 GB 卡不可行；社区 **audio.cpp**（ggml/C++，无 Python）
    原生支持 SOAR/MF/Edit 的 q8_0 GGUF + Windows CUDA 后端 → 本机可行路径
  - **本机实测基准**（脚本与样本全部落在仓库外 `F:\schoolCompWorks\clone\_bench\`，项目代码零改动）：
    统一 6 句文本 + 统一参考音色，测 RTF / 暖机 / 整卡显存峰值 / 采样率——
    GPT-SoVITS **RTF 0.46**、暖机 22.2s、峰值 4563 MB、32 kHz；IndexTTS 1.354 / 64.9s / 7562 MB / 22.05 kHz；
    网易 1.605 / 68.9s / 7752 MB / 22.05 kHz；**Genie CPU 0.851、载模型 7.5s、零显存、32 kHz**；
    **dots.tts SOAR q8 0.918、载模型 ~10s、净占 ~6.3 GB、48 kHz**
  - **情感能力实测**（同句只换参考音频，五引擎同一协议）：五套都能迁移情感，差异在稳定性；
    Genie 语速跨度最大（Δ3.99 字·s⁻¹，哀 10.2s / 怒 3.88s）与 issue #31「情绪很容易乱飘」吻合
  - **情感控制实测**：dots.tts.edit 的 `<emo type="cheerful|angry|melancholic">` 生效
    （F0 106→222.8 / 250.0），**中文标签 `type="开心|悲伤"` 同样生效**（F0 238.3 / 152.4）；
    `<rate factor="1.3">` 实测倍率 ×1.32；`<pitch semitones="5">` 仅部分跟随（+13%）；
    局部 `<emo>` 只改目标句（F0 106→331、能量 0.050→0.426），非目标句能量基本保持（0.0375→0.0414）；
    **反向验证：普通 TTS 模板内联 `<emo>` 与 `instruction_tts` 自然语言指令均无效**（开心/悲伤 F0 109.8 vs 108.6）
    → 情感控制必须走「生成 + Edit 两段式」
  - **Genie 权重转换打通**：`s1v3.ckpt` + `s2Gv2ProPlus.pth` → 320 MB ONNX，自动识别 `Model Type: V2ProPlus` ✓
  - **安装兼容性实测取证**：`jieba_fast` 在 PyPI **从未发布 wheel**（15 个文件全 sdist）→ Windows
    `pip install genie-tts` 必失败（需 MSVC）；py3.13 连 `tokenizers` 都编不过；最终靠定向装依赖 +
    手写 `jieba_fast` 垫片 + `HF_ENDPOINT=hf-mirror` 才跑通。另发现 `import genie_tts` 在缺 GenieData 时
    **同步 `input()` 阻塞**、并在 GBK 控制台 `UnicodeEncodeError` 崩在导入期（`Core/Resources.py:68`）
  - **交付文档**：新增 `docs/GENIE-DOTSTTS-EVALUATION.md`（结论 / 环境协议 / 性能表 / 情感表 / 逐维度评估 /
    迁移判定 / dots.tts 落地路径与风险 / 复现清单）

- **未完成**：dots.tts 试点阶段 A（`audiocpp_server` 9884 + 网关 `/api/dots/*` 透传 + arbiter/preload 记账）
  未开工——本阶段被明确要求「先不动代码」；Genie 的「零显存备援第四服务」方案同样只写到建议，未实施

- **改动文件**：`docs/GENIE-DOTSTTS-EVALUATION.md`（新增）、`PROGRESS.md`、`HANDOFF.md`。
  **项目代码零改动**；基准脚本/样本在仓库外 `_bench/`（`bench_existing.py`、`bench_emo2.py`、
  `bench_genie.py`、`bench_genie_emotion.py`、`bench_dots.py`、`bench_dots_edit.py`、
  `analyse_preservation.py`、`aggregate_results.py`）

- **测试结果**：三套本地服务全链路实测通（经网关 8787 透传，服务按阶段前状态恢复：
  GPT-SoVITS/网易 关、IndexTTS 开且模型已卸载，整卡显存回到 1460 MB）；Genie CPU 端到端出音 6 句 +
  情感迁移 4 句；dots.tts 单会话 16 请求全部成功 + Edit 情感矩阵 9 例全部成功；
  跨引擎汇总表 `_bench/comparison_tables.md`。**修正两处测量协议错误**：
  ① 绝对能量阈值把轻声有效合成误判为静音（已改自适应）；② flat 参考音配错转写导致
  GPT-SoVITS 出现 23s 近静音（属我方错误，配对文本后重测正常）——教训记入 HANDOFF 坑 28

- **风险**：① dots.tts q8 净占 ~6.3 GB，比网易/IndexTTS 更吃紧，接入必须复用「已加载就跳过准入」的修法；
  ② 情感标签只在 Edit 检查点生效，UI 若放到生成页会造成"以为坏了"的误报；③ dots.tts 音质/内容准确度
  未做 ASR 客观核对（本轮只测了声学指标与相对变化），试听样本在 `_bench/out/` 待用户听感裁决；
  ④ `<pitch>` 数值承诺要保守（实测 +13% 对要求 +33%）

---

## 阶段 27补1 —— RVC 变声 `NameError: _in_projection`（修复）

- 分支=feature/vc-svc

- **起因**：用户在语音变声页点「替换音色 / 开始变声」，报
  `VcError: 变声失败：... NameError: name '_in_projection' is not defined`，
  栈是 `vc_single → pipeline → hubert.extract_features → fairseq wav2vec2 → F.multi_head_attention_forward
  → GPT_SoVITS/AR/modules/patched_mha_with_cache.py:242`。

- **已完成**
  - **定位到根因（进程级污染，不是 RVC 自己的 bug）**：GPT-SoVITS 在
    `AR/modules/activation.py:14` **import 期**把 `F.multi_head_attention_forward`
    整体替换成它的 KV-cache 版；而该补丁文件只 import 了 `_in_projection_packed`，
    **漏了 `_in_projection`**（torch 2.0.0 里它存在于 `torch/nn/functional.py:4790`）。
    GPT-SoVITS 自己的 AR 走 packed 分支碰不到；RVC 的 fairseq HuBERT 把 q/k/v 投影
    分开传（`use_separate_proj_weight=True`）正好落在漏掉的分支 → 必崩
  - **修法（官方整合包零改动）**：新增 `trainer/app/torch_compat.py`，
    往补丁函数的 `__globals__` 里补回 `_in_projection`（torch 没有该私有名时回退到
    等价实现）；幂等，每次进入上游上下文前调用
  - **接入三处**：`vc/bootstrap.prepare_env()`（引擎初始化）、`vc/pipeline.VcEngine._context()`
    （每次变声前，覆盖「先 RVC → 后 GPT-SoVITS → 再 RVC」的晚装补丁顺序）、
    `svc/bootstrap.ensure_import_path()`（DDSP 同进程预防）
  - **排障出口**：`/v1/vc/catalog` 增加 `mha_patch` 字段（`patched` / `module` / `in_projection_bound`）

- **未完成**：真机端到端复跑（需要用户重启 trainer 并再点一次变声）——本机服务当前未起，
  且要占 GPU；本次只做到「复现 + 修复后同一探针通过」的 CPU 级验证

- **改动文件**：`trainer/app/torch_compat.py`（新增）、`trainer/app/vc/bootstrap.py`、
  `trainer/app/vc/pipeline.py`、`trainer/app/svc/bootstrap.py`、`trainer/app/routers/vc.py`、
  `trainer/.tmp/check_mha_patch.py`（一次性验证脚本）、`PROGRESS.md`、`HANDOFF.md`

- **测试结果**：`trainer/.tmp/check_mha_patch.py` 用整合包 python 跑通四步——
  ① 按路径加载官方补丁并装到 `F` 上；② **真实 fairseq `MultiheadAttention` 前向复现
  `NameError`**（与用户栈一致）；③ 调 `ensure_mha_patch_complete()` 返回 True、
  `in_projection_bound` 变 True；④ 修复后人工签名与 **fairseq 真实链路均通过**
  （输出 `[5, 2, 16]`）；⑤ 二次调用返回 False（幂等）。五个改动文件 `py_compile` 全过，
  `import app.torch_compat` 在无 torch 上下文下安全返回默认值

- **风险**：① 补的是**官方补丁的全局 dict**，若将来整合包升级自带修复，`ensure_mha_patch_complete()`
  会因名字已存在而直接返回 False，无副作用；② 补丁本身与 torch 版本强绑定（它是 torch 源码的复制），
  整合包若升 torch 需重跑本脚本；③ 未做 GPU 端到端复跑，修复有效性以 CPU 探针为准

- **下一阶段入口**：阶段 28（dots.tts 试点 A）。目标=端到端跑通一次生成 + 一次 `<emo>` 编辑；
  涉及文件=`server/src/services/runtime.ts`、`server/src/routes/`（新增 dots 透传）、
  `server/src/services/arbiter.ts`、`server/src/services/preload.ts`、`app/src/lib/`（新增 dots 客户端）；
  分支=feature/vc-svc；验证命令=`npm run typecheck && npm run lint` +
  `audiocpp_cli --task tts --family dots_tts --model dl/dots-tts-soar-q8_0.gguf --backend cuda --metrics`
- 本次文档更新时间：10.08 17:42

## 阶段 27补2 —— GPT-SoVITS 进程隔离（方案 B：官方管线移入独立 worker 进程）

- 分支=feature/vc-svc

- **起因**：补1 只治了症状（往补丁函数的 `__globals__` 里补名字）。用户追问
  「软件耦合性是不是太高了，能不能把三个引擎分割开」。核查后确认有**两条**不可恢复的
  进程级副作用：① `AR/modules/activation.py` import 期全局替换
  `F.multi_head_attention_forward`；② `bootstrap.install()` 里永久 `os.chdir`。
  这两条都不是「整理 sys.path / 摘 sys.modules」能解决的 —— 唯一干净的边界是进程。
  用户从三个选项里裁决 **「直接上 B」**：把官方 GPT-SoVITS 管线移进独立 worker 进程。

- **已完成**
  - **设计定稿**：新增 `docs/ENGINE-ISOLATION.md`（7 章，含调用面清单、
    IPC 契约、崩溃恢复策略、已知取舍、实测结果）
  - **worker 运行时**：新增 `trainer/app/sovits/worker/`——
    `protocol.py`（JSON-lines 信封 + `isolate_stdout()` + 错误序列化，17 项 code 映射表）、
    `server.py`（`Holder` 官方管线持有者 + `Worker` 请求循环 + 独立 daemon 读线程跑
    `interrupt`）、`client.py`（`WorkerClient` 拉起/心跳/退避重启/关停 + `StreamHandle`）、
    `__main__.py`（按文件路径启动的入口）
  - **代理化**：`pipeline.py` 整文件重写为同签名跨进程代理（602 → 640 行），
    `inference.py::split_text` 去掉对 `self.pipeline._pipeline.text_preprocessor` 的私有穿透，
    `api.py` 在 lifespan 里补 `shutdown()`
  - **`bootstrap.install()` 拆出 `chdir: bool = False`**：`os.chdir` 搬进 worker，
    **`sys.path` 注入留在主进程**（UVR5 / ASR 脚本通道要 `from tools.uvr5.vr import ...`）
  - **对外契约零变化**：`/health` 原有 19 个字段一个没少，只追加
    `worker_alive` / `worker_error` / `worker_pid`
  - **修掉验证阶段暴露的 3 个真实缺陷**（见下）

- **未完成**：RVC 与 DDSP-SVC 仍在主进程内（方案 B 只隔离 GPT-SoVITS）。
  截至目前它们没有暴露 import 期副作用；若将来出现，按 `ENGINE-ISOLATION.md` §2 的方案 C
  扩展即可，`worker/` 这套协议与客户端可直接复用

- **改动文件**：`trainer/app/sovits/worker/{__init__,protocol,server,client,__main__}.py`（新增）、
  `trainer/app/sovits/pipeline.py`（重写为代理）、`trainer/app/sovits/synth.py`（搬入
  `as_synthesis_error` / `last_chunk`）、`trainer/app/sovits/bootstrap.py`、
  `trainer/app/inference.py`、`trainer/app/api.py`、`trainer/server.py`、
  `docs/ENGINE-ISOLATION.md`（新增）、`docs/ARCHITECTURE.md`、`docs/VC-SVC-FEASIBILITY.md` §4、
  `.tmp/{worker_smoke,verify_isolation,verify_synthesis,verify_http,verify_recovery}.py`（验证脚本）

- **测试结果**：五份验证脚本 **139 项断言全过**——
  `worker_smoke.py` 32/32（协议/错误往返/stdout 隔离/生命周期/崩溃退避）、
  `verify_isolation.py` 12/12（隔离直接证据 + **反证**：worker 侧 `mha_patched=True`）、
  `verify_synthesis.py` 30/30（同步/流式/切分/批量/热切换/让位/取消/关停）、
  `verify_http.py` 51/51（HTTP 契约未变）、`verify_recovery.py` 14/14（崩溃检测+诚实上报+自愈）

- **验证阶段暴露并修掉的 3 个真实缺陷**
  1. **`/health` 谎报「已加载」**：`status()` 里先取 `to_dict()` 再刷新 worker 状态，
     拿到的是过期快照 → worker 猝死后仍报 `loaded=True`。修法：刷新挪到 `to_dict()` 之前，
     并新增 `PipelineState.mark_worker_lost()` 把「worker 死 → 模型没了」收口成一个方法
     （供 `status()` / `_raise_worker_gone()` / `unload()` 三处共用）
  2. **退避期内立刻 503 而非等待**：`ensure_started()` 一看在退避窗口里就抛 `WorkerGone`，
     于是「崩溃后马上重试」这种正常行为立刻失败。修法：窗口内阻塞等待（上限
     `_WAIT_BACKOFF_MAX_S = 10 s`），等完就重启；只有退避期长到不合理才报错
  3. **`taskkill` 输出编码**（次要）：`text=True` 用 utf-8 解 GBK 输出，在读线程里抛
     `UnicodeDecodeError`。验证脚本改为手动 `decode("mbcs")`

- **实测数据**：worker 首载官方管线约 24 s（冷缓存）/ 3~4 s（OS 缓存已热）；
  HTTP 预热（启动 + 拉 worker + 4 模型）约 30 s；单条同步合成 1~5 s；
  IPC 跳数开销可忽略；崩溃后自愈（重启 + 重载全部模型）约 30~51 s

- **风险**：① worker 与主进程各自持有 CUDA context（约 300~600 MB），8.6 GB 卡上是实打实开销；
  ② 音频多一趟 base64 编解码（每块约 18.75 KB，可忽略；长文本整段可能到几 MB）；
  ③ 官方 `TTS.run()` 内部吞异常 + yield 兜底空音频的行为**不因 worker 化改善**，
  真实堆栈仍要从 worker stderr 捞；④ `torch_compat` 变冗余但**刻意保留**，
  作为「未来某个引擎又打补丁」的兜底

- **下一阶段入口**：阶段 28（dots.tts 试点 A）。目标=端到端跑通一次生成 + 一次 `<emo>` 编辑；
  涉及文件=`server/src/services/runtime.ts`、`server/src/routes/`（新增 dots 透传）、
  `server/src/services/arbiter.ts`、`server/src/services/preload.ts`、`app/src/lib/`（新增 dots 客户端）；
  分支=feature/vc-svc；验证命令=`npm run typecheck && npm run lint` +
  `audiocpp_cli --task tts --family dots_tts --model dl/dots-tts-soar-q8_0.gguf --backend cuda --metrics`
- 本次文档更新时间：11.20（阶段 27补2 收尾）

## 阶段 28 — 引擎评估：Irodori-TTS（日语特化 + emoji 风格控制 + 本机训练实测） [计划时间：10.08 22:10 BY Qoder][完成时间：10.09 00:25 BY Qoder]
- 分支：feature/vc-svc

- **起因**：用户在阶段 27 后否掉 Genie-TTS 与 dots.tts（"弃用，不考虑了"），转提
  Irodori-TTS（`github.com/Aratako/Irodori-TTS`），要求 ① 核实"对日语语音合成特化"是否成立
  ② 与现有 IndexTTS-2.5 / 网易子曰 / Genie-TTS 横向对比 ③ **实测训练日语的情况**。
  约束同上一轮：先收集信息与跑数据，**不改项目代码**。

- **已完成**
  - **日语特化证实**：模型卡 `language: ja` + "supports Japanese text input only"；
    文本/描述编码器 = `sbintuitions/modernbert-ja-310m`、codec = 作者自训
    `Semantic-DACVAE-Japanese-32dim`（48kHz）、文本归一化是日语符号表；Joyo Kanji Yomi
    Kana-CER 7.29% / 句级 2.36%、JSUT BASIC5000 句级 kana-CER 3.43%，且卡里声明这两个榜
    **未进训练集**。作者从未公布数据集名称与小时数（只有 issue #35 的 ~4000 万样本口头说法），
    也**没有论文与人类 MOS**
  - **emoji 风格控制实测量化**（同一句只换 emoji，女声无参考）：基线 F0 223.3 →
    😊269.7 / 😠268.9 / 😭266.7 / 😱265.2（p90 高达 384）/ 🤭**172.7**；
    🤭 让静音帧 25→**78**（笑/停顿这类非语言人声的直接信号）；😊×3 比单个更强（5.72s / 有声帧 85）
    → "重复 emoji 加强"成立。**失效项也测出来了**：⏩ 语速 5.25 ≈ 基线 5.26（没变快）、
    👂 能量 0.262 ≥ 基线 0.243（耳语没降能量）
  - **男声 emoji 失效复现（issue #9）**：用我们音色库男声参考音时，😊/😠/😭/🤭 的 F0
    全锁在 **110.3–111.9 Hz（跨度 1.6Hz）**，只有时长/停顿变化 → 我们音色库是男声，
    UI 不能宣传"男声情感操控"
  - **caption 语音设计量化**：F0 跨 1.77 倍（143.5→259.5），"少し早口"确实给出最高语速 5.56；
    加男声参考后 F0 落到 111Hz → "参考音定音色、caption 定风格"验证通过
  - **性能基准（int4-weight-only，单进程一次加载）**：默认 40 步 RTF **0.503**（≈GPT-SoVITS 0.46）、
    净占显存 ~4.6GB、48kHz；**6 步 + sway 实测 RTF 0.121 = 这台 8.6GB 卡上最快**；
    `--model-precision bf16` 无加速（0.597）只省 ~400MB；带参考音（speaker 分支）RTF 0.851
  - **采样长尾定位**：两次灾难性慢生成（15.16s→4.00s 音频；**89.17s→4.96s 音频**）都卡在
    `sample_rf`。没有直接下"引擎缺陷"结论，而是专项复测：无参考 6 次 + 带参考换 seed 2 次全正常，
    **只 seed 42 那一次炸**；降到 20 步同一条命令 2.16s 完成 → 判定为偶发长尾，接入需超时护栏
  - **训练日语实测（3 组探针 + 闭环）**：Speaker Inversion（bf16 基座冻结、只训 16 个 embedding token、
    梯度检查点）batch 2 与 **batch 8 均跑通**，**2.2 s/步**、整卡峰值 6911MB（净占 ~4.4GB）、
    产出 `checkpoint_final.speaker.safetensors`，并用它 `--ref-embed` 推理成功（闭环）；
    LoRA（r16 diffusion_attn）batch 2 跑通，**9.9 s/步**、峰值 6614MB。
    外推官方默认步数：SI 3000 步 ≈ **1.8 小时**（我们这张卡唯一"一晚出结果"的路径）、
    LoRA 3000 步 ≈ 8.3 小时
  - **抓到并复现 Windows 训练硬雷**：官方 `prepare_manifest.py --dataset json --data-files`
    在本机 `seen=16 written=0 skipped_audio=16 / dataset_iter_error: 16`，**退出码 0、manifest 0 字节**
    （issue #40 的本地复现，根因是 datasets 的 Audio 解码依赖 torchcodec 而 cu128 索引无 Windows wheel）。
    绕法已实测可用：直接用仓库 `DACVAECodec.encode_file()` 编 latent + 按官方 schema 手写 JSONL
  - **环境取证**：torchcodec 在 Windows 上不可用导致 `torchaudio.load` 直接 ImportError
    （本轮靠 sitecustomize 垫片换 soundfile 跑通）；`dacvae` / `silentcipher` 都是 git-only 依赖
    （github.com 直连不通，走 codeload tarball）；huggingface.co 不通、hf-mirror 单连接被限速到
    ~120KB/s，最终用 **ModelScope 镜像 + 8 路 Range 并发**（≈3.5MB/s）取齐 4GB 权重；
    codec `weights.pth` 首次下载被截断（torch.load 报 central directory 错），续传后正常
  - **交付文档**：新增 `docs/IRODORI-TTS-EVALUATION.md`（结论表 / 事实来源表 / 性能实测与步数曲线 /
    emoji·caption·男声三张控制量表 / 训练实测与 Windows 陷阱 / 12 条风险登记 / 接入建议 / 复现清单）；
    HANDOFF 新增坑 29；本条目

- **未完成**：Irodori 未接入服务（按约束本阶段不动代码）；质量类主观指标（听感、伪影、口音）
  未判定——需用户听 `_bench/out/irodori/` 样本；`--no-watermark` 未合并导致的水印开销只引用了
  上游 PR #38 的数据（≈单次请求耗时的一半、~0.9GB），本机未实测（环境未装 SilentCipher，
  因此我的 RTF 是**不含水印的最好情况**）；LoRA batch>2 与 SI batch16（官方默认）未压测

- **改动文件**：`docs/IRODORI-TTS-EVALUATION.md`（新增）、`PROGRESS.md`、`HANDOFF.md`。
  **项目代码零改动**；测量脚本/模型/音频在仓库外 `_bench/`
  （`irodori_run_all.py`、`analyse_wavs.py`、`train_irodori_probe.py`、`shim/sitecustomize.py`、
  `chunked_dl.sh`；模型 int4 0.79GB + bf16 3.06GB + codec 410MB；39 条 wav + 8 组指标 JSON）

- **测试结果**：推理 39 条全部成功（含 8 组模式）、训练 3 组全部 exit=0、
  speaker embedding 闭环推理成功；emoji/caption 控制有量化差异；长尾问题定位到具体 seed 与绕法。
  基准服务状态：本轮**没有使用本机 dev 网关**（测试开始时 5173/8787 已停），
  Irodori 全程独立 venv + 独立进程，不与另一路 agent 的训练/网关改动争抢显存以外的资源

- **风险**：① 接入前必须解决 Windows 音频解码路径（torchcodec 缺失 → 要么自带 soundfile 入口，
    要么走 Irodori-TTS-Server，要么 Linux/WSL）；② 训练数据入口会静默空转，必须断言 manifest 非空；
    ③ 男声 emoji 基本无效，UI 文案要按实测口径写；④ 步数与质量的取舍需耳朵验收；
    ⑤ 净占 ~4.6GB 仍需与网易/IndexTTS/dots 排队，不能共存；⑥ 仅日语，不能替代主力；
    ⑦ v4-Large 是 Gemma 条款且 12.25GB，本项目不考虑

- **下一阶段入口**：等用户拍板是否接入。**若点头，建议 阶段 29 = Irodori 试点 A**：
  目标=用 `Irodori-TTS-Server`（OpenAI 兼容 `POST /v1/audio/speech`，暴露 caption/num_steps/speed/音色 CRUD）
  起 9885 + 网关 `/api/irodori/*` 透传 + arbiter/preload 记账（净占 ~4.6GB，含水印再 +0.9GB）+
  请求超时护栏（≥120s，命中长尾自动降步重试）；涉及文件=`server/src/services/runtime.ts`、
  `server/src/routes/`（新增 irodori 透传）、`server/src/services/arbiter.ts`、
  `server/src/services/preload.ts`、`app/src/lib/`（新增 irodori 客户端）；分支=feature/vc-svc；
  验证命令=`npm run typecheck && npm run lint` +
  `irodori-venv/Scripts/python.exe Irodori-TTS/infer.py --checkpoint models/irodori_v4.1_small_int4/model.safetensors --codec-repo dacvae_local/weights.pth --no-ref --caption "落ち着いた女性話者" --num-steps 6 --t-schedule-mode sway --show-timings`
- 本次文档更新时间：10.09 00:25

## 阶段 27补3 —— RVC 变声结果听不了（灰色播放器）[完成时间：10.09 00:25]

- 分支=feature/vc-svc

- **起因**：用户报告「RVC 换完人声，无法听替换后的声音」—— 变声页结果卡片的
  A/B 播放器整体灰色、`0:00 / 0:00`、播放按钮不可点。

- **根因（前端取了绝对路径当 URL）**：后端 `vc_runner` 同时回两个字段 ——
  `output` 是**服务端本地绝对路径**（`F:\...\trainer\.data\outputs\vc\<job>\converted.wav`），
  `urls.output` 才是浏览器能取的 Web 路径（`/files/vc/<job>/converted.wav`）。
  而 `VoiceConversionPage.tsx::onJobDone` 只读 `artifacts.output`（绝对路径），
  再交给 `resolveAudioUrl` 拼成 `/api/sovits/F:/schoolCompWorks/...` ——
  必然 404 → 浏览器拿到零时长音频 → 把控件渲染成灰色禁用。
  实测证据：旧地址返回 HTTP 404；`/files/vc/c8ee90254f94/converted.wav` 返回
  HTTP 200 / 230444 字节 / `audio/wav`。产物本身一直是好的，纯前端取错字段。

- **已完成**
  - 新增 `pickArtifactUrl()`（`app/src/lib/sovits.ts`，经 `lib/vc.ts` re-export）：
    统一「优先 `urls`，回退绝对路径」的取值规则，并用 `ABSOLUTE_PATH_RE` 拦住
    盘符路径 —— 与其产出必然 404 的地址，不如返回 `null` 让 UI 走降级分支。
    **收口成一个函数**是为了让这类 bug 不再各页面重写一遍（正是复发的温床）。
  - `VoiceConversionPage`：异步任务回调与同步响应两条路径都改走 `pickArtifactUrl`
  - `SingingConversionPage`：`collectArtifacts` 从 `resolveAudioUrl(x) ?? x`
    （会把绝对路径**原样透传**）改为逐键 `pickArtifactUrl`；`toTrack()` 助手
    不再把不可用路径塞成空串 `url: ''`（空 src 同样表现为灰色禁用）
  - 后端 `/v1/vc/convert` 的**同步分支**此前只回 `output`、没有 `urls`，
    一并补上（`{ "output": 绝对路径, "urls": { "output": "/files/vc/<token>/..." } }`）
  - `types/vc.ts::VcConvertSyncResponse` 补 `urls?` 字段

- **改动文件**：`app/src/lib/sovits.ts`、`app/src/lib/vc.ts`、
  `app/src/pages/VoiceConversionPage.tsx`、`app/src/pages/SingingConversionPage.tsx`、
  `app/src/types/vc.ts`、`trainer/app/routers/vc.py`

- **测试结果**：`pickArtifactUrl` 六组用例（真实异步产物 / 仅绝对路径 / Web 路径在
  output / null / 空对象 / 多轨 urls）行为全部正确；`npm run typecheck` 前后端均通过；
  改动文件 `eslint` 零告警；端到端 —— 同步 `/v1/vc/convert` 现在返回
  `urls.output`，该 URL 实测 HTTP 200 / 230444 字节 / `audio/wav` 可播放

- **风险**：无。产物磁盘路径与静态挂载点本来就没变，只是前端不再拼错地址

- **下一阶段入口**：阶段 29（RVC 训练对齐官方），见下条

## 阶段 27补4 —— DDSP-SVC 音色加载入口（音色库组件 + 导入/删除闭环）[完成时间：10.09 00:44 BY Qoder]

- 触发反馈（用户 10.09）：「DDSP SVC 的音色加载没做入口，现在加载不了别的音色」。
- 性质：**入口缺失**，不是后端缺能力 —— 三个端点（`load` / `unload` / `upload`）早就齐了，
  缺的是**前端把用户的手接到那些端点上**。

### 现状核查（动手前实测）

| 层 | 现状 | 结论 |
| --- | --- | --- |
| 后端路由 | `POST /v1/svc/models/load`（`path` 或 `model_key`）、`/unload`、`/upload`（`model`+`config`+`name`）俱全 | 可用 |
| 后端能力 | `catalog.list_models()` 从 `.data/svc/models` 与 `models/checkpoints/ddsp` 递归扫 `*.pt`，无同目录 `config.yaml` 标 `available=False` | 可用 |
| 前端 `lib` | `svcApi.loadModel` / `uploadModel` 已定义 | 可用 |
| **前端页面** | `SingingConversionPage.tsx` **只有一个 `<Select>` 下拉框**，全页无任何导入/上传入口 | **缺口在此** |
| 对照 | RVC 页 `VoiceConversionPage.tsx::ModelLibrary` 有完整实现（拖拽 + 两个 hidden input + 「导入 .pth」/「配套 .index」按钮 + toast 兜底） | 可照搬契约 |
| **后端删除** | SVC **没有** delete 端点（RVC 有 `DELETE /v1/vc/models`） | 需补 |

### 落地改动

**后端**

- `trainer/app/svc/catalog.py`
  - 新增 `describe_model()` 的 `id` 口径修正（**真实缺陷**，见下「顺带修掉的坑」）。
  - 新增 `find_model()`：按 id / name / 路径三态解析，与 `/models/load` 的口径对齐。
  - 新增 `delete_model()`：删 `.pt` 与同目录 `config.yaml`；**带边界检查** ——
    只删 `model_dirs()` 之内的文件，直接传外部路径进来会被拒绝（防止误删用户别处的模型）。
- `trainer/app/routers/svc.py`：新增 `DELETE /v1/svc/models?model=<id>`。

**前端**

- `app/src/lib/vc.ts`：`svcApi` 新增 `deleteModel(model, baseUrl)`。
- `app/src/pages/SingingConversionPage.tsx`：
  - 新增 `SvcModelLibrary` 组件（照 RVC 页既有契约）+ `SvcModelCard`。
  - 与 RVC 版的关键差异：**多一个必填的 `config.yaml`**。DDSP-SVC 的 `.pt` 是纯权重，
    采样率 / 编码器 / F0 提取器全在 config.yaml 里，少一个都加载不了 →
    接受 `.pt + .yaml/.yml` 成对导入，只给 `.pt` 时明确提示「还缺 config.yaml」而**不是静默失败**。
  - 导入即**自动热加载**（省掉「导入完还要再点一次加载」的往返）。
  - 列表项展示 `采样率 · 编码器 · F0 提取器 · 体积`，并标出**「当前音色」**
    （靠新增拉取的 `/v1/svc/pipeline`）；缺 config 的条目显示后端给的 hint 且加载按钮禁用。
  - 组件位置放在**翻唱向导之前** —— 没有音色就没法翻唱，先让用户把「料」备齐。
  - `refresh()` 顺带拉一次 `pipeline`；pipeline 失败静默（不把整页打成错误态）。

### 顺带修掉的坑（`describe_model` 的 id 口径）

**现象**：`catalog` 里那个模型明明在 `models/smoke/` 下，`id` 却是 `model`
（因为文件名是 `model.pt`），下拉框里显示成「model」，用户根本认不出是谁。

**根因**：`id` 取的是 `path.stem`（文件名茎），而 DDSP-SVC 官方导出的权重**几乎都叫 `model.pt`**，
真正区分音色的是**所在目录名**（`<expdir>/model.pt`）。

**后果**：多个模型会在下拉框里挤成一堆 `model`、`model`、`model`；且 `id` 不唯一，
`/models/load` 用 `model_key` 解析时会命中错误条目。

**修复**：模型位于自己的子目录里时用**目录名**当 `id`/`name`；只有在「一堆 `.pt` 平铺在
`models/` 下」这种非标准摆法才回退到文件名。已实测：`smoke` 现在显示为 `smoke`。

### 验证（`.tmp/verify_svc_models.py`，25 项全绿）

- 前置：模型齐全检查
- `GET /v1/svc/catalog`：目录数 ≥2、能看到既有音色、`available=True`、
  正确解析出 `sample_rate=44100` / `encoder=contentvec768l12tta2x` / 绝对 `path`
- `POST /v1/svc/models/upload`：`.pt + config.yaml` 成对导入 → `has_config=True` 且两者都落盘
- 导入后 catalog 立即可见、`available=True`、`name` 用了目录名
- `DELETE /v1/svc/models`：`removed` 同时含 `.pt` 与 `config.yaml`，删除后 catalog 不再有它
- **越界防护**：传一个真实存在但不在音色库目录内的 `.pt` → `ok=False` + 明确拒绝理由，
  且**文件仍在**（未被误删）
- 前端：`tsc --noEmit` 通过、`eslint` 零告警、`vite build` 成功（1892 modules）

### 遗留 / 未做

- **DDSP-SVC 训练**仍无入口，且上游 `ddsp-svc` 的训练链路与本项目尚未打通 ——
  与阶段 29（RVC 训练对齐官方）是同类问题，但**上游契约完全不同**（DDSP-SVC 是
  `preprocess.py → train_reflow.py` 两段式，RVC 是 `infer-web.py` 一把梭），
  需要单独调研立项。本阶段只解决**加载**入口。
- 音色库未做搜索/筛选/分页（RVC 页也没有；阶段 26补8 的「音色库管理页」是 GPT-SoVITS 那条线的）。

---

## 阶段 27补5 —— RVC 训练结果音频全失真 + 训练/运行产物在网站全量展示（持久化 + 本地路径 + 规范化命名）[完成时间：10.09 BY Qoder]

- 触发反馈（用户 10.09 原话）：
  > 「rvc训练结果有很大问题，音频增益过大，全部失真 `<converted.wav>`。训练和运行之后的产物应该在网站全部显示，
  > 同时也给出本地路径，规范化命名，支持用户手动命名，刚刚我训练的结果在网站重启之后就没了」
- 拆成 **4 个独立子诉求**，本轮全部落地：① 修音频失真；② 训练**和运行**的产物都要展示 + 给本地路径；
  ③ 规范化命名 + 支持手动命名；④ 训练结果不能因重启而消失。
- 性质：其中 ① 是**真实的数据损坏缺陷**（不是"听感不好"），③④ 是**持久化/契约**问题，
  ② 是**入口缺失**（后端数据一直都在，前端没读回来）。

### 子诉求 ① 音频失真（根因：int16 被当归一化浮点，100% 削波）

**定位**：`trainer/app/audio/io.py::save()` 原先无脑 `np.asarray(data, dtype=np.float32)`。
RVC 的 `vc_single()` 返回的是**已缩放到 ±32768 的 int16**
（`vendor/rvc/infer/modules/vc/pipeline.py` 末尾 `(audio_opt * max_int16).astype(np.int16)`）。
`24351` 强转 float32 后交给 soundfile，而 **soundfile 的浮点约定是 [-1, 1]** → 单样本顶满量程 → 整段变 ±32767 方波。

**量化取证**（`.tmp/verify_vc_audio.py`）：

| 写法 | absmax | 削波率 |
| --- | --- | --- |
| int16 原样写（修复后） | 0.7431 | **0.00%** |
| 强转 float32（旧写法） | 1.0000 | **100.00%** ← 用户听到的失真 |

**修法**：按 dtype **分流** —— `np.issubdtype(array.dtype, np.floating)` 为真时规整成 float32，
整数保留原 dtype（满量程语义）。

**排查中连带的第二个缺陷（同函数）**：多声道数组被 `array.T` 转置。
`soundfile >= 0.12` 要 **frames-first** `(N, channels)`；`(N, 2)` 转成 `(2, N)` 即
**2 帧 × 80000 声道** → `LibsndfileError: Format not recognised`。单声道 `(N,)` 不转置所以主路径没暴露。
→ 删掉转置，只 `ascontiguousarray`；`ndim > 2` 明确抛 `AudioError`。

### 子诉求 ② 训练 + 运行产物都在网站展示（含本地路径）

**训练侧**（上轮已完成，本轮复核）：`TrainResultCard` 读 `/v1/jobs?kind=vc_train`。

**运行侧**（本轮补齐）：
- 新增 `app/src/hooks/useVcRunHistory.ts` —— 从 `/v1/jobs?kind=` 读运行记录，
  并把 `job.artifacts` 解析成**可播放轨道**（`url` 给播放器 + `path` 给用户定位）。
- 新增 `app/src/components/features/RunResultCard.tsx` —— 变声页与翻唱页**共用**的产物面板，
  逐轨渲染内联 `<audio>` + 可点击复制的本机路径。
- 接线：`VoiceConversionPage.tsx`（`kind="vc_infer"`）、`SingingConversionPage.tsx`（`kind="svc_infer"`）
  各放一份；两页的 `onJobDone` 末尾广播 `notifyVcRunChanged()` 触发面板自动刷新。
- **踩到的形状差异（真缺陷）**：`vc_infer` 的产物路径在**顶层**（`output` + `urls.output`），
  而 `svc_infer` 的路径嵌在 **`artifacts.artifacts`** 内层、`urls` 却在外层
  （成因：`cover.py::run_cover()` 返回 `{"artifacts": {...}}`，路由 runner 再 `**result` 平铺）。
  → `collectTracks()` 同时看顶层与内层，且只接受「像盘符路径或 `/files/` 开头」的字符串，
  否则 `sample_rate` / `stages` / `info` 会被误当产物。**这正是之前会"只显示混音、漏掉新人声/伴奏"的原因。**

### 子诉求 ③ 规范化命名 + 手动命名

- `TrainRequest` 新增 `clean_name` 属性（`sanitize_name()`）、`sample_rate_hz`（容忍 `"40k"` / `"40000"` / `40000`）、
  `version_tag`（`v1` / `v2` 归一）。
- `to_dict()` 回显 `clean_name`（前端看到的名字与落盘文件名一致），原值另存 `raw_name` 不丢信息。
- 提交任务时 job name 用 `request.clean_name`（否则「训练结果」列表里显示的名字和产物文件名对不上）。
- 手动命名：`rename_model()`（`.pth` 与配套 `.index` 一起改名，目标同名时拒绝）。

### 子诉求 ④ 重启不丢

- **真相**：后端早已把任务持久化到 `trainer/.data/jobs/<id>.json`，`/v1/jobs?kind=` 支持过滤。
  丢记录是因为前端 `useResultStack` 用 **sessionStorage** + `LoraTab` 把 jobId 存在局部 state。
- 修法即 ② 的两块（`useVcTrainHistory` / `useVcRunHistory`），都改成**每次挂载向服务端要**。

### 顺带修掉的共性问题（不止服务本需求，是本轮最有价值的部分）

| # | 问题 | 影响面 | 修法 |
| --- | --- | --- | --- |
| 1 | 裸 `payload: Any` 被 FastAPI 当成**必需 query 参数** | 7 个端点（vc 3 + asr 4） | 全部 `Body(default=None)` |
| 2 | 同步端点里 `asyncio.Event()` 无事件循环（anyio 线程） | 提交训练必 500 | Scheduler 记 loop + `_make_cancel_event()` 绑 loop + 端点改 `async def` |
| 3 | `torch.save(payload, "路径字符串")` 在 Windows 对**奇数个非 ASCII 字符**的中文名必然失败 | 训练产物 `.pth` / `.lora.pt` 保存 | 改走 `open(path, "wb")` 文件对象（`lora.py` + `merge.py`） |
| 4 | RVC 官方 mel 配置口径（40k 在 **v1** 目录、`n_mels=125`/`hop=400`） | LoRA 微调对齐官方 | 新增 `_load_official_mel_config()` 读官方 JSON，不猜 ckpt |
| 5 | RVC 官方脚本裸 `except:` 吞异常且**恒返回 0** | 阶段"成功"但无产物 | `_stage_output_probe()` 按产物目录计数判成败 + `_stage_failure_hint()` |
| 6 | preprocess 只追加不清理 → 同名重跑混入残留 | filelist 错配 / 空清单 | `run()` 开头 `rmtree(exp_dir)` |
| 7 | preprocess 的 sr 要**裸赫兹值**（原先 `*1000` 得 40000000） | 产出 592MB 的 NaN「音频」 | 传 `str(sr)` |
| 8 | LoRA 注入在 `.to(device)` 之后 → 新层留 CPU | `Expected all tensors on same device` | 调换顺序（先注入后上设备） |
| 9 | `enc_q` 的 `y` 要**线性谱**（1025 通道）不是波形 | 权重维度不匹配 | 新增 `_linear_spectrogram()`，重写 `_collate()` |

### 验证

| 脚本 | 项数 | 结果 | 覆盖 |
| --- | --- | --- | --- |
| `.tmp/verify_vc_audio.py` | 10 | **全绿** | int16 分流 / 浮点无损 / 立体声 frames-first / 两条反证（旧写法 100% 削波、channels-first 必被拒） |
| `.tmp/verify_run_artifacts.py` | 20 | **全绿** | vc_infer 单产物 / 翻唱三轨 / 直接转换 / 4 类边界（空产物、只有路径、只有 url、元信息不误判） |
| `.tmp/verify_train_persist.py` | 10 | **全绿** | plan 收 JSON body / train 不再 500 / `/v1/jobs?kind=vc_train` / 磁盘 JSON 存在 / 名称已规范化 |
| `.tmp/run_train_direct.py` | — | **5 阶段全绿** | 直接调 `training.run()` 绕开显存门禁：preprocess 6 → f0 6 → feature 6 → filelist 6 → LoRA（141 层注入，754692 可训练参数），产物 `.pth` 52.6MB + `.lora.pt` 3.0MB，`loss 1412.566` |
| `tsc --noEmit` + `eslint` | — | **零报错** | 5 个改动前端文件 |

### 受阻（环境，非代码）

- 变声/翻唱的 **HTTP 端到端**因显存被 ~20 个桌面进程占满（实测 6985/8188 MB，仅剩 973 MB；
  DDSP-SVC 需 3584 MB、RVC 需 3072 MB）反复 `429 VRAM_INSUFFICIENT`。
  → 已把错误提示改**可行动**（`engine.py` 的 `hint`：关占用程序 / 卸载模型 / 看任务管理器），
  并把验证**下沉到单元级**以锁住回归。**未强杀用户进程。**

### 遗留 / 未做

- 阶段 29（RVC 训练对齐官方）仍未开工；DDSP-SVC **训练**入口仍缺（沿用阶段 27补4 的遗留说明）。
- `run_train_direct.py` 走的是 LoRA 路径；全量训练（`mode="full"`）未在本机验证过。

---

## 阶段 27补6 —— 两个严重 bug：显存预估「自己把自己检测成占用者」+ 服务进程关不掉 [完成时间：10.09 08:10 BY Qoder]

- 触发反馈（用户 10.09 原话）：
  > 「严重bug
  > 1 网易模型显存空出来，模型已经预热成功加载后，上方检测不到位，显示又不够了（实际应该是自己的模型在跑，自己把自己检测到了）
  > 2 网易进程关不掉，想切换indextts无法切换」

### Bug ① 显存预估的「重复扣账」

**根因**：`app/src/lib/resources.ts::estimateTask()` 一律算 `空闲 − 需求`。
引擎常驻后它自己占的那几 GB **已经反映在 `vram_free` 里**，再减一次需求 = 把模型自己当成了占用者。
**读数没错，是算式错了。**

**实测复现**（真实 `/health`，非构造数据）：

| 字段 | 值 |
| --- | --- |
| `engines.confucius_tts.loaded` | `True` |
| `vram.free_mb` | 807 / 8187 |
| `configuration.tts_required_vram_mb` | 5120 |

`807 − 5120 = −4313 → insufficient` → 界面「还差约 4.3 GB」——与用户截图「还差约 4.8 GB」同量级。

**修法**：`engineLoaded` 时**不做减法**，只在 `vram_free < 512` 时降级 `tight`；未加载保留原算式。

**两个连带关键点**：
1. **字段名三个服务各不相同，不能想当然** ——
   网易 TTS → `engines.confucius_tts.loaded`；网易 ASR → `engines.r2t2.model_loaded`（**不是 `loaded`**）；
   IndexTTS → `engine.loaded`。
2. **快照必须联动刷新** —— `ResourceBudget` 原来只在挂载时 `refresh()` 一次，
   而页面挂载时父组件的 `engine` 还是 `null`、预热完成后才变 `true`。
   只看第一次会**永远停在「未加载」的旧算式上**。
   → 用 `loadedKey = ${neteaseTtsLoaded}|${neteaseAsrLoaded}|${indexttsLoaded}` 做 effect 依赖
   （`firstLoad` ref 跳过挂载那一次，避免开局打两次请求）。

### Bug ② 服务进程关不掉

**现场取证**：`server/.data/netease-service.json` 已是 `enabled: false`，
但 9882 端口 PID 16780 **仍 LISTENING** → 切 IndexTTS 时两个服务抢显存。

**根因**：`RuntimeSupervisor.shutdown()` 原只杀 `this.child`，而服务有**三条启动路径**：
① 网关 spawn（`this.child` 有值）；② `npm run dev` 的 concurrently 起的；③ 用户手动起的。
②③ 都让 `this.child === null` → 旧实现直接放弃。

**修法**：新建 `server/src/lib/processOwnership.ts`，`shutdown()` 补第二路
「**按端口反查 + 项目归属校验**」：先杀 `child`，再杀端口上能确认归属的。
**硬约束：宁可漏杀，不可错杀** —— 判不了归属的进程一律不动。

**归属判据（按可信度从高到低，`classify()` 五条）**：

| # | 判据 | 备注 |
| --- | --- | --- |
| ⓪ | 服务 `/health` **自报 PID** | 最硬；为此给 netease / indextts 的 `/health` 都新增了 `pid` 字段 |
| ① | 命令行指向 `<root>/scripts/<name>.mjs` | 网关 spawn 的形态 |
| ② | 项目绝对根路径 + 服务标识词 | |
| ③ | **相对路径** `python netease/server.py` | **实测补的**：正则必须是 `<hint>/server.py`，只凭 `server.py` 太泛会误伤 |
| ④⑤ | 解释器 `ExecutablePath` 在项目根内 + 标识词 / 入口脚本 | 项目自带 venv 的形态 |

**③ 是实测撞出来的**：命令行 `"...Python312\python.exe" netease/server.py`
既无绝对路径也无 `scripts/`，①② 全落空 → 一次关停演练失败（`ours=false` → `stopped:false`）。

**Windows 三代嵌套**：`python.exe(监听者) ← python.exe ← node.exe`。
只杀 node 会留下两个孤儿 python 继续占端口与显存 → 必须 `taskkill /t /f`。
另注：`/health` 自报 `pid` 与 `status().pid` **不是同一个**（实测 node 40640 / python 38924），
正因如此才需要自报 PID 这条判据。

**同病同修**：`sovits.ts` 的 `shutdown()` 有**完全相同的缺陷**（也只杀 `child`），已一并改掉，
并抽出 `SOVITS_HINTS` 复用同一套判据。

**界面文案纠错**：原关停失败时的提示是「外部实例请去终端 Ctrl+C」——**这是错误引导**
（外部实例现在能关掉了）。改为读 `status.shutdownNote` 如实说明。

### 验证（都在真机跑过，非纸面推演）

| 验证 | 结果 |
| --- | --- |
| 归属判定（9882 相对路径 / 9883 绝对路径） | `ours=true` 均命中 |
| 自报 PID 判据 | `pid=38924 ours=true reason=服务 /health 自报 PID，归属确凿` |
| 关停演练（网易 + IndexTTS，`this.child === null` 场景） | `{"stopped":true,"releasedVram":true,"managed":true}`，端口释放，原 PID 全部退出 |
| 显存归还 | **6985 → 1059 MiB**（释放约 5.8 GB）；最终演练收尾时 **651 MiB** |
| 完整演练（拉起 → 预热 → 判定 → 关停） | `[旧] insufficient` / `[新] ok` ✅；`关闭后 (无 — 已释放)` ✅ |
| `.tmp/verify_vram_estimate.py` | **11/11 全绿**（6 条纯算式 + 5 条真实 `/health` 核对） |
| `tsc --noEmit`（server + app）+ `eslint`（7 个前端文件） | **零报错** |

### 改动文件

| 文件 | 改动 |
| --- | --- |
| `server/src/lib/processOwnership.ts` | **新建**：`findPortOwners` / `findServiceProcesses` / `killTree` / `isAlive` / `PROJECT_ROOT` |
| `server/src/services/runtime.ts` | `shutdown()` 补端口反查一路；`RuntimeSpec.hints`；`RuntimeStatus.shutdownNote` |
| `server/src/services/sovits.ts` | 同样修复；删掉本地 `killTree` 改复用共享实现；新增 `SOVITS_HINTS` |
| `server/src/routes/runtimeService.ts` | 关停提示改读 `status.shutdownNote` |
| `app/src/lib/resources.ts` | `estimateTask()` 分流；`ResourceSnapshot.loaded_engines`；`isEngineLoaded()` |
| `app/src/components/features/ResourceBudget.tsx` | `loadedKey` 联动刷新；结论文案分流；建议区抑制 |
| `netease/app/routers/netease.py` + `models.py` | `/health` 新增 `pid`（自报，供判据 ⓪） |
| `indextts/app/api.py` | 同上 |
| `app/src/types/netease.ts` / `indextts.ts` | 同步 `pid` 字段（契约两边一致） |

### 踩坑（已入 HANDOFF 坑 42–45）

- **Bash 工具跑 `powershell` 拿不到 stdout**（安全策略），`wmic` 在 Win11 已移除
  → 用 Win32 API（`ctypes.CreateToolhelp32Snapshot`）或 Node `execFile` 读进程信息。
- **`npx tsx` 脚本 `process.exit(0)` 会把 spawn 的子进程一起带走**
  → 后台起服务要 `run_in_background=true` 且脚本挂住（`await new Promise(() => {})`）；
  `nohup ... &` 同样会随命令结束被回收。
- 网易预热路由是 `/v1/confucius/warmup`（不是 `/v1/engines/load`）；
  `/v1/netease/engines/acquire` 只拿锁、**不加载权重**（实测 `loaded` 一直 `false`）。

### 遗留 / 未做

- 三个服务当前均为 **关闭态 + 端口空闲 + 显存已归还**（651 MiB），用户下次开局需重新启用。
- Irodori-TTS 若后续接入，同样要配 `hints` 才能让关停链路覆盖到它。

---

## 阶段 27补7 —— 侧栏「已就绪」与设置页「未启动」打架（状态事实源不统一）[完成时间：10.09 17:20 BY Qoder]

- 触发反馈（用户 10.09 原话）：
  > 「左侧状态栏出现显示网易已就绪，但是设置页显示未启动的问题，那到底是启动还是没启动？请核查。」

### 核查结论：**不是两个 bug，是同一个状态被两套独立探活各自缓存**

| 界面 | 读什么 | 判据 |
| --- | --- | --- |
| 左侧状态栏 | 只探 `netease /health` | 「权重装了没 / 包能不能 import」→ 装了就是 `ready` |
| 设置页 | supervisor 的 `enabled` + `reachable` | `enabled` 决定开关，`reachable` 决定 Badge |

**为什么必然打架**：`package.json` 的 `dev` 脚本是
`concurrently -n netease,server,app ... "npm run dev:netease -- --skip-if-missing" ...`
—— **无条件**起 netease，而 `enabled` 默认 `false`。
所以「**进程在跑 + 开关关着**」是开发模式下的**常态**，不是偶发：
侧栏看到进程 → 报「已就绪」；设置页看到 `enabled=false` → 报「未启动」。

现场取证（实测）：

| 端点 | 值 |
| --- | --- |
| `netstat` 9882 | PID 41276 LISTENING |
| 直连 `/health` | `ok:true`、`installed:true`、`importable:true` |
| 网关 `/api/netease/service` | `enabled:false`、`reachable:false`（**过期值**） |
| `server/.data/netease-service.json` | `{"enabled": false}` |

### 修复（三处，缺一不可）

**① 侧栏判定改为以 `enabled` 为唯一事实源**（`app/src/App.tsx`）
两级判定：先问 supervisor 的 `enabled`（用户意图），`enabled=true` 才去探 `/health`；
`enabled=false` 一律 `offline`。三个模块（sovits / netease / indextts）都改。

**② 网关状态接口补「读时现探」**（`server/src/routes/runtimeService.ts`）
`/api/netease/service` 与 `/api/indextts/service` 原来直接吐 `supervisor.status()`，
而 `reachable` 只在 supervisor 自己的启动/关停流程里更新过 —— 网关起来后从没探过就是初始 `false`。
导致「端口上有进程在跑，接口却报 `reachable=false`」，把界面上「未托管进程」的提示也吞掉了。
→ GET 处理器 `await supervisor.probe()` 再返回。
（`/api/sovits/service` **本来就有这一行**，netease / indextts 是漏网的。）

**③ 开关切换加广播**（`app/src/lib/localService.ts`）
侧栏探活是 30s/10s 轮询，用户点了开关要等下一轮才翻转，观感是「点了没反应」。
→ 新增 `notifyServiceEnabledChanged()`，所有 `toggle` 成功后调用；
`App.tsx` 用 `serviceChangedTick` state 订阅 `service-enabled-changed`，
放进三个探活 effect 的 deps —— 事件一来 effect 重建、立刻重探。

### 设置页文案同步（把实情说清）

- Badge 口径从 `reachable` 改为 `enabled && reachable`（与开关一致）：
  `starting` → 「启动中…」；`enabled && reachable` → 「运行中」；`enabled` 但不可达 → 「未就绪」；否则 → 「未启动」。
- 新增提示：`enabled=false && reachable=true` 时显示
  「检测到未托管的进程仍在 :9882 上运行（多由 `npm run dev` 或终端手动启动）。打开右侧开关可由网关接管；关闭开关则会把它收掉并归还显存。」

### 验证（真机，`.tmp/verify_sidebar_state.py` 4/4 全绿）

现场态（9882 有进程、`enabled=false`）：

| 判定 | 结果 |
| --- | --- |
| [旧] 只看 `/health` | `ready` ← **复现用户截图** |
| [新] 先看 `enabled` | `offline` |
| 设置页 Badge | `未启动` |
| 一致性铁律（`enabled=false` 时两侧必同为「未启动」） | ✅ |

反向验证（把开关打开）：`enabled=true` 后 → 侧栏 `ready` / Badge `运行中`，两侧仍一致。

`tsc --noEmit`（server + app）+ `eslint`（8 个前端文件）零报错。

### 改动文件

| 文件 | 改动 |
| --- | --- |
| `app/src/App.tsx` | 三个探活 effect 改为「先读 `enabled` 再探 health」；新增 `serviceChangedTick` + 事件订阅 |
| `app/src/lib/localService.ts` | 导出 `SERVICE_ENABLED_CHANGED_EVENT` 与 `notifyServiceEnabledChanged()` |
| `app/src/pages/SettingsPage.tsx` | Badge 口径统一；「未托管进程」提示；两处 toggle 加广播 |
| `server/src/routes/runtimeService.ts` | GET 补 `await supervisor.probe()` |
| `app/src/components/features/ResourceBudget.tsx` | 关停 GPT-SoVITS 后广播 |
| `app/src/components/features/SovitsServiceNotice.tsx` | 启动 GPT-SoVITS 后广播 |
| `app/src/pages/IndexttsTtsPage.tsx` | 启动 IndexTTS 后广播 |

### 遗留 / 未做

- 未做浏览器端走查（本机未起 dev server）；验证下沉到「复刻判定分支 + 打真实端点」的单元级。
- 侧栏与设置页仍各自轮询，理论上仍有 ≤30s 的窗口期不一致；靠 ③ 的广播覆盖了「用户主动切换」这条主路径。

---

## 阶段 30（P0）—— 音色模型统一管理：打通「看得见」 [完成时间：10.09 19:20 BY Qoder]

- 立项依据：用户要求「为 WebUI 设计一套清晰、可统一管理的音色模型管理系统」，
  完整方案见 `docs/VOICE-MODEL-MANAGEMENT-PLAN.md`（六期：P0–P5）。本轮做 P0。
- 触发的问题（核查实测）：
  1. 模型散落在 **5 个位置**，命名与嵌套规则互不一致；
  2. **`models/RVC语音模型/MYGO全员/<角色>/` 那批从未被任何扫描器看到** ——
     RVC 只扫 `trainer/.data/vc/models/` 的**一层** `*.pth`；
  3. 四套互不相通的模型列表实现（RVC / DDSP-SVC / GPT-SoVITS / 参考音频），
     形状、错误码、命名规则各不相同，且没有一个能跨类别统一管理；
  4. 历史记录只显示 MiMo（P2 处理）。

### 已完成

**后端**

| 文件 | 内容 |
| --- | --- |
| `server/src/services/modelRegistry.ts` | **新建**。类别定义表（唯一事实源）+ 递归扫描（深度 ≤2）+ 配套文件配对 + sidecar `.meta.json` + 重复检测 + 路径边界检查 |
| `server/src/routes/models.ts` | **新建**。`/api/models/{catalog,reveal}` + `GET/DELETE /api/models` |
| `server/src/index.ts` | 挂载 `/api/models`（必须早于全局 `express.json()`，同 voicelib） |
| `trainer/app/config.py` | 新增 `rvc_models_dir`（写入根）+ `rvc_model_search_dirs`（读取多根，可用 `RVC_MODEL_DIRS` 覆盖） |
| `trainer/app/vc/bootstrap.py` | `models_dir()` 改为 `models/rvc/`；新增 `models_dirs()` 返回读取多根 |
| `trainer/app/vc/models.py` | 多根递归扫描；`index_path_for()` 改为「同目录同 basename 优先」；`find_model()` 逐根闭环匹配；`_read_meta()` 加 mtime 缓存 |
| `trainer/app/vc/pipeline.py` | `load()` 里把 `weight_root`/`index_root` 指向**模型自己所在目录** —— 嵌套模型因此可加载，且**无需改上游代码** |

**前端**

| 文件 | 内容 |
| --- | --- |
| `app/src/lib/models.ts` | **新建**。统一模型管理客户端（含 GB 级 `formatBytes`） |
| `app/src/components/features/ModelCategoryPanel.tsx` | **新建**。类别面板：列表 / 打开目录 / 重新扫描 / 删除；三类状态提示（旧位置 / 疑似重复 / 缺配套文件） |
| `app/src/pages/VoiceLibraryPage.tsx` | 改为多 Tab 容器；原页面整体搬进「参考音频」Tab，逻辑未动 |

### 测试结果

| 验证 | 结果 |
| --- | --- |
| `.tmp/verify_rvc_scan.py`（多根递归 + 索引配对 + find_model 三形态） | **14/14 全绿** |
| `.tmp/verify_rvc_load_path.py`（嵌套模型路径解析 + 旧逻辑反证） | **11/11 全绿**（反证：旧逻辑 10/10 拼不出路径） |
| `GET /api/models/catalog` | 200，四个类别，rvc 计数 **18** |
| `GET /api/models?category=rvc` | 18 个，旧位置 / 重复标记正确 |
| `DELETE /api/models`（造假模型实测） | 一次移除 `.pth` + `.index` **两个文件**，联动正确 |
| 错误路径 | 未知类别 404 / 不存在 id 404 / 缺 id 400；`../../etc` 被拒 |
| **真实加载**（重启服务后） | `deng.pth`（**仅存在于嵌套位置**）加载成功且 `has_index=true`；`lenai` 优先命中嵌套规范位置 |
| `tsc --noEmit`（server + app）+ `eslint`（3 个前端文件） | 零报错 |

**改前 → 改后**：可见模型 **5 → 18**；`.index` 配对 6/6 正确；嵌套模型从「拼不出路径」到可加载。

### 实施中发现的两处设计偏差（原方案未预料）

1. **必须加「兼容读取的旧位置」**，否则改扫描根会让既有模型全部「消失」。
   定为三根并存，且**网关与 trainer 的根列表必须逐一对应** ——
   实测网关只配 1 个旧根时是 10 个、trainer 是 18 个；补齐后两侧都是 18。
2. **`find_model` 必须「逐根先精确后递归」**。原写法下
   `.data/vc/models/lenai.pth`（扁平）会抢在更高优先级的嵌套模型之前命中。

### 未完成（P1 起）

批量导入 / 批量重命名 / sidecar 元数据编辑 / 迁移脚本 / 产出记录页 / 各引擎页接新数据源。
P0 的导入仍走各引擎页原有的上传入口。

### 风险

- `models/rvc/`（规范根）目前为空，实际模型都在兼容旧位置 —— 需要 P1 的迁移脚本收口。
- 三根并存期间，同名模型会以「疑似重复」提示；用户可能不清楚该删哪一份。
- `_read_meta()` 用 `torch.load` 读 ckpt，已加 mtime 缓存；模型数量继续增长时要考虑懒加载。

---

## 阶段 31（P1）—— 音色模型统一管理：打通「管得住」 [完成时间：10.09 19:56 BY Qoder]

- 承接阶段 30（P0）。本轮做 P1：导入 / 重命名 / 元数据 / 迁移。
- 用户要求「两种模型导入方式（本地文件夹 + 网页）不冲突、重复要提醒、网页导入也落在本地同一文件夹」—— 本轮已实现并通过实测。

### 已完成

**后端**

| 文件 | 内容 |
| --- | --- |
| `server/src/services/modelRegistry.ts` | 新增 `importModel` / `renameModel` / `updateModelMeta` / `planMigration` / `runMigration`；`ModelEntry` 加 `single_model_dir`；sidecar 改为「单模型目录用 `.meta.json`、多模型目录用 `<stem>.meta.json`**（避免同目录多模型互相覆盖元数据）**；`assertInsideCategory` 覆盖全部搜索根 |
| `server/src/routes/models.ts` | 新增 `/import`（**流式落盘**，2 GB 上限，暂存目录与 models/ 同盘以保证原子 rename）、`/rename`、`/update`、`/migrate`（**默认 dry-run**） |

**前端**

| 文件 | 内容 |
| --- | --- |
| `app/src/lib/models.ts` | 新增 `importFile` / `rename` / `update` / `migratePlan` / `migrateRun` / `conflictOf`（从 409 取冲突详情） |
| `app/src/components/features/ModelCategoryPanel.tsx` | 加「导入文件 / 导入文件夹」按钮 + 进度条；勾选 + 批量重命名（前缀/后缀/查找替换，**带预览表**）；迁移确认弹窗；`useFileDrop` 拖拽 |
| `app/src/components/features/ModelEditDialog.tsx` | **新建**。单条编辑：文件名（联动提示会改哪些配套）+ 显示名 + 标签 + 备注 |

### 测试结果

`.tmp/verify_model_manage.py` **28/28 全绿**（用 Python urllib 而非 curl —— Git Bash 的 curl 会把 UTF-8 参数转 GBK，导致中文名在服务端变成 U+FFFD）。

| 项 | 结果 |
| --- | --- |
| 导入保留子目录（不拍平） | ✅ |
| 重复检测（同名同大小） | ✅ 409 + `conflict` |
| `keep_both` | ✅ 自动 `-1` |
| 重命名联动配套 + 中文名不损坏 | ✅ `.pth` + `.index` 一起改 |
| 元数据落盘并生效 | ✅ |
| 路径穿越 | ✅ `../../../evil` 剥成 `evil`，未逃出类别根；`.exe` 400 拒绝 |
| 迁移计划 | ✅ 按模型搬（每项文件同属一个目录） |
| **真实迁移 18 个 RVC 模型** | ✅ 全部到 `models/rvc/`，结构保留，两个旧根清空，迁移后加载正常 |

`tsc --noEmit`（server + app）+ `eslint`（5 个前端文件）零报错。

### 实施中修掉的两个真 bug

1. **`assertInsideCategory` 把「路径 == 根本身」判成越界**（多了个 `relative !== ''`）——
   扁平旧根里 8 个模型全部迁移失败。已修正。
2. **迁移按「目录」搬而非按「模型的文件」搬** —— 扁平布局下会把同目录别的模型一起卷走。已改为只搬 `model.files` + sidecar。

### 环境 / 数据变更（重要）

- **已执行真实迁移**：18 个 RVC 模型从 `models/RVC语音模型/**` 与 `trainer/.data/vc/models/*`
  搬到 `models/rvc/**`，两个旧根已清空。迁移只搬不删，可回滚（计划记录在 `.tmp/migrate-plan-before.json`）。
- 迁移后仍有 **4 对疑似重复**（扁平副本 vs 嵌套原件同名同大小），面板已标徽标，去重留给用户决定。
- 旧根仍是「兼容读取」配置，所以过程中模型不会消失。

### 未完成（P2 起）

产出记录页（三源合并）、各引擎页接新数据源、体验收尾。

### 风险

- 导入用「原始字节 + 查询参数」而非 multipart（网关没装解析器），2 GB 上限；超大 `.index`（实测 440 MB）走流式不会读进内存，但占用暂存盘。
- 拖拽导入会拍平（`useFileDrop` 的目录遍历不保留路径）；要保留结构须用「导入文件夹」按钮。
- 迁移只搬不删，旧根目录仍在配置里；等去重完成、确认无误后可考虑移除兼容根。


## 阶段 29 —— RVC 训练对齐官方 RVC WebUI（后端对齐 T1/T2/T4/T5 已落地）[计划时间：10.10 01:20 BY CodeBuddy][完成时间：10.10 01:52 BY CodeBuddy]

- 分支=feature/vc-svc
- 立项依据：用户 10.09 明确「模型训练要与官方一致，需要修改前端增加入口之类的也必须做」。
- 本轮范围：**T1（前置条件）+ T2（参数对齐）+ T4（进度可视化）+ T5（mute 样本）**。
  T3（前端新增「RVC 训练」入口）与 T6（MHA 排雷）见「阶段 29补1」。

### 已完成（本轮）

| 文件 | 内容 |
| --- | --- |
| `trainer/app/vc/training.py` | ① `write_train_config()`：训练前按官方规则（`infer-web.py:555`：`v1` 或 `40k` → `configs/v1/<sr>.json`，否则 `v2/<sr>.json`）写出 `logs/<exp>/config.json` —— **改前从不生成，`train.py::get_hparams()` 无条件读它，full 模式必挂（G3）**；② `resolve_pretrained()`：底模按官方口径在 `assets/pretrained*` 下找，**找不到就不带 `-pg/-pd`**（官方做法）而不是拼一个不存在的路径（G2）；③ `build_train_command()`：plan 与 run **共用同一份**命令构造，补齐官方的 `-sw`，`-l` / `-c` 改为请求字段（G4）；④ `preflight()`：采样率 × 版本组合校验 + 配置模板存在性 + 底模可用性，分「阻塞 / 警告」两级；⑤ `write_filelist()` 补齐官方的两行 `logs/mute/*` 静音样本（T5，发现 `vendor/rvc/logs/mute/` **本来就齐备**，不需要额外下载）；⑥ `parse_train_line()` + `TrainProgress`：解析 `Train Epoch: N [x%]` 与 `loss_gen=…` 逐行上报（T4） |
| `trainer/app/routers/vc.py` | `/v1/vc/train/plan` 响应新增 `preflight`（issues / warnings / 可用底模 / 可用组合）；`/v1/vc/train` 入队前先跑预检，阻塞项直接 400（不再让用户跑 20 分钟后才炸） |

**顺带修掉一个真 bug**：`plan()` 里 preprocess 传的是原始 `sample_rate`（如 `32k`），
而官方 `preprocess.py` 直接 `int(sys.argv[2])` —— 照 plan 里的命令复制去跑会 `ValueError`。
现在 plan 与 run 一致传赫兹整数。

**一个与计划不同的结论（重要）**：原计划 T1 写「补 32k 底模（下载约 200MB）」。
实测 `vendor/rvc/assets/pretrained_v2/` 下**只有 40k**（`f0G40k` 69.7MB + `f0D40k` 136.3MB），
而 `configs/v1/40k.json` **是存在的** —— 也就是说 **40k + v1 这条组合本机现成可用，不需要下载**。
所以本轮没有引下载，改为：① 40k 自动落到 v1（官方规则本来就强制）；② 32k/48k 缺底模时给**警告 + 从零训练**的明确说明，不静默失败。

### 测试结果

`.tmp/verify_vc_train_official.py` **35/35 全绿**（整合包解释器，不需要 GPU、不训练）：

| 项 | 结果 |
| --- | --- |
| config 选择规则 | v2+32k→v2/32k、v2+48k→v2/48k、v1+40k→v1/40k、**v2+40k 强制 v1/40k** 全部符合官方 |
| 三个模板文件存在 | ✅ `configs/v1/40k.json`、`v2/32k.json`、`v2/48k.json` |
| 底模解析 | 40k → `pretrained_v2/f0G40k.pth` + `f0D40k.pth`；32k → 空 + 可执行警告 |
| 预检 | v2+40k 阻塞；v1+40k 放行；v2+32k 放行但带警告 |
| 命令同构 | `-e -sr 40k -f0 -bs -g -te -se -pg -pd -l 1 -c 0 -sw 1 -v v1`（官方全部字段齐） |
| plan 步骤 | preprocess → f0 → feature → filelist → **config** → train → index |
| `write_train_config` 落盘 | 真写出 JSON，`data.sampling_rate=40000` |
| epoch 解析（T4） | `Train Epoch: 3 [45%]` / `loss_gen=5.678` / `====> Epoch: 3` 三类行均解析正确，进度分数与文案正确 |

### 未完成（阶段 29补1）

- **T3**：前端新增「RVC 训练」入口（现在藏在变声页底部「音色工坊」折叠卡里，且 `mode: 'full'` 前端不可达），
  表单要补齐训练模式 / 采样率 / 版本 / batch size / save_every / save_every_weights / if_latest / if_cache_gpu / 底模选择，
  并把 `/v1/vc/train/plan` 的 `preflight` 显示成就地提示（全量模式底模缺失要给可用清单）。
- **T6**：验证 MHA 补丁在训练路径上的实际状态（`training.run()` 不调用 `bootstrap.prepare_env()`）。
- **真机冒烟**：本轮只做逻辑校验，**没有真跑一次 full 训练**（要占显存、耗时长）。

### 风险

- `full` 模式只在 **40k + v1** 下有底模；32k / 48k 会从零训练（收敛慢、质量差）—— 界面必须把这条警告显示出来。
- 40k 模型比 32k 吃显存（8GB 卡上 batch_size 可能要降到 2~4），首次真跑要盯显存。
- `if_cache_gpu` 默认关（8GB 卡开缓存容易 OOM），与官方默认「否」一致。

### 下一阶段入口

阶段 29补1 —— T3 前端入口 + T6 排雷 + 一次 full 训练真机冒烟（小 epochs）。

- 分支=feature/vc-svc（拟定）
- 立项依据（原计划条目）：用户 10.09 明确「模型训练要与官方一致，需要修改前端增加入口之类的也必须做」。
  代码调研已完成（见下「现状核查」）。
- 目标：让「站内训练出来的 RVC 音色」与「官方 WebUI 训练出来的」等价可用，
  且前端能跑完**官方全部两条训练路径**（全量微调 / 轻量适配）。

### 现状核查（已实测，作为子任务的依据）

| # | 现象 | 证据 |
| --- | --- | --- |
| G1 | **`full` 模式前端不可达** | `mode: 'full'` 只存在于 `app/src/types/vc.ts:106` 的类型定义；`LoraTab` 硬编码 `mode: 'lora'`，全仓搜不到传 `'full'` 的调用点 |
| G2 | **`full` 模式缺 32k 底模** | `weights.py` 声明 `assets/pretrained_v2/f0G32k.pth` / `f0D32k.pth`，该目录**实际只有** `f0G40k.pth` / `f0D40k.pth`；而 `configs/v2/` 只有 32k/48k（无 40k），`training.py` 默认 `sample_rate="32k"` → 必失败 |
| G3 | **`full` 模式缺 `config.json`** | `train.py::get_hparams()` 无条件读 `logs/<exp>/config.json`；官方 `infer-web.py:556-568` 显式生成，**我们和 `preprocess.py` 都不生成** → 又一个独立失败点 |
| G4 | **训练参数与官方不一致** | 官方命令（`infer-web.py:572`）含 `-sw`（save_every_weights），我们**没传**；`-l 1` / `-c 0`（if_latest / if_cache_data_in_gpu）被**硬编码**，而官方 WebUI 是用户可选项 |
| G5 | **缺官方 `logs/mute` 静音样本行** | `write_filelist()` 注释里明说「省略 mute 两行」；官方会追加 `logs/mute/*`。当前 `logs/mute` 目录**已存在**但未被引用 |
| G6 | **进度上报粗** | `full` 模式只有 5 个阶段级 emit，**没有 epoch 级进度**（`train.py` 每 epoch 打到 stdout，我们只逐行转日志、不解析）；官方有 TensorBoard 的 loss 曲线 |
| G7 | **可发现性差** | RVC 训练藏在变声页（左侧 `rvc`）底部的「音色工坊」折叠卡里；顶部导航另有 `training` 页但那是 GPT-SoVITS 专用（`TrainingPage.tsx`），两者容易混淆 |
| G8 | **疑似 MHA 补丁未覆盖训练路径** | `training.run()` **不调用** `bootstrap.prepare_env()`，因此不执行 `torch_compat.ensure_mha_patch_complete()`；而 `extract_feature_print.py` 要 `import fairseq`（HuBERT）正是踩 `_in_projection` 的那条路径。阶段 27补2 隔离 GPT-SoVITS 后主进程 MHA 应已原生 → 大概率已免疫，但**未实测** |

### 子任务拆分

- ✅ **T1 · 补齐训练前置条件（10.10 已完成）**
  - 生成 `logs/<exp>/config.json`：按官方规则 `version=="v1" or sr=="40k"` → `configs/v1/<sr>.json`，否则 `configs/v2/<sr>.json` —— 已落地（`write_train_config()`）
  - 底模：**改为 ②**（实测 `configs/v1/40k.json` 与 `f0G40k/f0D40k` 本机都有，无需下载）；32k/48k 缺底模时按官方做法不带 `-pg/-pd` 并给警告 —— 见本条目上方「一个与计划不同的结论」
  - 验收：逻辑已验（35/35）；**真机跑通仍待 29补1**（要占显存）

- ✅ **T2 · 训练参数与官方对齐（10.10 已完成）**
  - 补 `-sw`（save_every_weights），并暴露为请求字段
  - 把 `-l` / `-c` 从硬编码改为请求字段（默认保持现行为 `1/0`，不破坏既有调用）
  - 校验 `sample_rate × version` 组合合法性（v2 无 40k），非法组合要在 **plan 阶段**就报错而不是跑到一半
  - 验收：`plan()` 输出的命令与官方 `infer-web.py` 同构，逐参数可对照

- **T3 · 前端新增「RVC 训练」入口（用户明确要求）**
  - 方案：把 RVC 训练从「音色工坊」折叠卡升级为**独立区块**，或在导航新增条目；
    需与 GPT-SoVITS 的 `training` 页做清晰区隔（命名/图标/一句话说明）
  - 表单补齐：训练模式（全量/轻量切换）、采样率、版本、batch size、save_every、
    save_every_weights、if_latest、if_cache_gpu、底模选择（全量模式）
  - 全量模式必须给出「底模缺失/参数非法」的就地提示（对接 T1/T2 的预检）
  - 验收：用户不看文档、只点界面即可跑通两条训练路径

- ✅ **T4 · 训练过程可视化对齐官方（10.10 已完成后端部分：逐 epoch + loss 上报；JobPanel 展示待 29补1 顺带确认）**
  - 解析 `train.py` stdout 的 epoch 行，上报 epoch 级进度（`progress` 0~1 细分）+ 实时 loss
  - 前端 JobPanel 展示：当前 epoch / 总 epoch、loss、已用时、预计剩余
  - 可选：暴露 TensorBoard `logs/<exp>` 目录入口（或读取 `events.out.tfevents.*` 画 loss 曲线）
  - 验收：训练中能看到逐 epoch 推进，而不是长时间停在「训练」一个阶段

- ✅ **T5 · 补齐 filelist 的 mute 样本（10.10 已完成）**
  - 按官方格式追加 `logs/mute/*` 两行（解除 `write_filelist()` 里的省略注释）
  - 验收：filelist 行数与官方一致；对比官方训练日志无「样本数不符」类偏差

- **T6 · 验证 MHA 补丁在训练路径上的实际状态（低优先，排雷用）**
  - 写一次性脚本：在训练用的解释器上下文里跑 `extract_feature_print.py` 的 fairseq HuBERT 前向
  - 若报 `_in_projection` → 在 `training.run()` 开头补 `bootstrap.prepare_env()`
  - 验收：CPU/GPU 探针通过，或证明已免疫

- **改动文件（预估）**：`trainer/app/vc/training.py`（主体）、`trainer/app/vc/bootstrap.py`、
  `trainer/app/weights.py`、`trainer/app/routers/vc.py`、`app/src/pages/VoiceConversionPage.tsx`
  （或新增 `RvcTrainingPage.tsx`）、`app/src/lib/vc.ts`、`app/src/types/vc.ts`、`PROGRESS.md`、`HANDOFF.md`

- **验证命令**：`npm run typecheck` + 对改动前端文件跑 `eslint`；
  训练链路用整合包解释器跑一次性脚本（`plan` → `run`，先小 epochs 冒烟）

- **风险**：① 全量训练耗时长、吃显存，需与其它引擎的显存互斥配合（`engines.acquire("rvc_train")` 已就位）；
  ② 补底模要下载约 200 MB，需确认镜像可达；③ 若 T6 证明仍需补丁，注意 `torch_compat` 与阶段 27补2 的隔离假设不冲突

- 本次文档更新时间：10.09 00:25（计划态，未动代码）

## 阶段 29补1 —— 补齐 32k / 48k 训练底模 [计划时间：10.10 02:00 BY CodeBuddy][完成时间：10.10 02:14 BY CodeBuddy]

- 分支：feature/vc-svc
- 用户 10.10 拍板：「下 32k/48k 底模，顺手补前端入口 → 最后真机小 epochs 冒烟」。本条是第一步。

### 已完成

| 文件 | 内容 |
| --- | --- |
| `trainer/app/weights.py` | 新增 `rvc_pretrained_g48` / `rvc_pretrained_d48`（`assets/pretrained_v2/f0G48k.pth`、`f0D48k.pth`）；并把四个底模的 `size_mb` 从估值（84/54）改成**下载后的实测值** |
| `vendor/rvc/assets/pretrained_v2/` | 实测下载到位：`f0G32k` 70.5MB、`f0D32k` 136.3MB、`f0G48k` 72.0MB、`f0D48k` 136.3MB（连同原有的 40k 一组，三种采样率齐了） |

下载走的是既有链路 `scripts/download_models.py --engine rvc`（镜像兜底 + 断点续传），**没有新造轮子**。

### 测试结果

- `.tmp/verify_vc_train_official.py` **37/37 全绿**（脚本里两条「32k 缺底模」的断言已按新事实改写为「必须有」，并补了 48k 两条）
- 复跑 dry-run：四个底模全部 `[skip]`（已存在），无 `.part` 残留

### 意义

改前 `full` 模式只有 **40k + v1** 一条路（32k/48k 只能从零训）；现在 **32k / 48k + v2** 也能带底模训，
**32k 更省显存**（8GB 卡上比 40k 稳），**48k 保留更多高频**。三条路都通了。

### 下一阶段入口

阶段 29补2 —— 前端「RVC 训练」入口（T3）+ 真机小 epochs 冒烟。

## 阶段 29补2 —— 前端「RVC 训练」入口（T3）[计划时间：10.10 02:20 BY CodeBuddy][完成时间：10.12 13:47 BY Qoder]

- 分支：feature/vc-svc
- 承接阶段 29（后端对齐 T1/T2/T4/T5）与 29补1（32k/48k 底模）。本阶段是 T3：**把官方两条训练路径都摆到界面上**。

### 已完成

| 文件 | 内容 |
| --- | --- |
| `app/src/types/vc.ts` | 补 `save_every_weights` / `if_latest` / `if_cache_gpu` / `pretrain_g` / `pretrain_d`（对应官方 train.py 的 `-sw` / `-l` / `-c` / `-pg` / `-pd`）；新增 `VcTrainPreflight` 与 `VcTrainPlanResponse.preflight` |
| `app/src/pages/VoiceConversionPage.tsx` | 训练从「音色工坊」折叠卡拆出为**独立「训练音色（RVC）」卡**（工坊卡只剩融合）；新增 **`FullTab`** 全量微调表单并挂载 `TrainCard` |

**`FullTab` 的两个设计要点**

1. **提交前先预检**：参数变化后防抖 500ms 自动调 `/v1/vc/train/plan`，把 `preflight.issues`（阻塞，红色）与 `preflight.warnings`（非阻塞，琥珀色）就地列出，并展示「配置模板 → 将写入路径」与本次会跑的 N 个步骤。
   这解决的是改前「提交后跑十几分钟才炸」——采样率 × 版本不合法、缺官方配置模板现在提交前就能看到。
2. **底模缺失只是警告，不是阻塞**：官方允许不带 `-pg/-pd` 从零训（收敛慢、质量差，但不失败），所以 `pretrain` 的 note 走 `warnings`，只有 `ok=false` 才禁用提交按钮。
   采样率下拉直接用 `preflight.available_combos[version]` 禁用不合法档位（v2 只有 32k/48k）。

### 测试结果

| 项 | 结果 |
| --- | --- |
| `npm run typecheck`（app + server） | 零报错（改前 8 处：2 处未用导入 + 6 处隐式 any） |
| `npx eslint`（2 个改动文件） | 零告警 |
| `npx vite build` | 1900 modules transformed **成功**（`--outDir dist-verify` 绕开沙箱清目录，产物已清理） |
| 后端 `/v1/vc/train/plan` 实调 | **未做** —— trainer 未运行（9881 无响应），只做了契约核对 |

### 未完成

- **真机冒烟**：需要用户起服务后走一遍「变声页 → 训练音色 → 全量微调 → 改采样率看预检报错 → 提交」。本轮只验证了类型、lint 与构建，没有跑真实 preflight 请求。

### 风险

- `preflight` 字段是**可选**的（`VcTrainPlanResponse.preflight?`），老后端没有这个字段时界面静默跳过预检框、提交按钮也不会被拦 —— 不会报错，但也失去了保护。等后端升级到阶段 29 版本才生效。
- 自动预检会在用户敲语料目录时逐次发请求（已防抖 500ms，`trainPlan` 超时 60s）；若 trainer 未启动，每次都会走 catch 显示「预检失败」，属预期。
- 全量训练耗时十几分钟到数小时，界面靠 `JobPanel` 轮询；阶段 29 的 T4（epoch 级进度）已在后端落地，前端无需改动即可显示。

### 下一阶段入口

阶段 34 —— GPT-SoVITS 两段式选择器：`SovitsVoicePicker` 加 Tabs「参考音频（零样本）」/「微调权重（`/v1/weights`）」，
选中即 `loadWeights`；并把变声 / 翻唱的**合成下拉**也接到注册表（`GET /api/models?category=`）。
涉及 `app/src/components/features/SovitsVoicePicker.tsx`、`app/src/pages/{VoiceConversionPage,SingingConversionPage,SovitsTrainingPage}.tsx`。

- 本次文档更新时间：10.12 13:47

## 阶段 30 —— Irodori-TTS 接入：日语克隆 + emoji 风格 + Speaker Inversion 音色固化 [计划时间：10.12 15:30 BY Qoder][30-1 完成时间：10.12 18:15 BY Qoder][30-2 完成时间：10.13 01:50 BY ZCode][30-3 完成时间：10.13 19:10 BY Qoder][30-4 完成时间：10.13 20:10 BY Qoder][30-5 完成时间：10.14 03:38 BY Qoder][30-6 完成时间：10.16 04:19 BY Qoder][30-7 完成时间：10.17 02:03 BY Qoder][30-8 完成时间：10.17 15:25 BY ZCode]

- 分支：feature/vc-svc
- 立项依据：用户 10.09 裁决「**做克隆和训练**」（并明确 Genie-TTS 与 dots.tts 弃用）。
  技术前提全部来自阶段 28 实测（`docs/IRODORI-TTS-EVALUATION.md`）。
- 方案全文：**`docs/IRODORI-INTEGRATION-PLAN.md`**（架构决策 / 接口契约 / 音色库扩展 / 训练三步与三道守卫 /
  前端文案红线 / 7 段拆分 / DoD / 风险表）
- **本条目 10.12 由「计划态」转为实施态**（就地保留位置，不搬移 —— 见文件头「编号说明」）。

### 用户拍板结果（10.12 15:30，答完即开工）

| # | 问题 | 裁决 | 落地口径 |
| --- | --- | --- | --- |
| ① | 推理默认步数 | **20 步默认 + 40 步作「最高质量」档** | `/v1/catalog` 的步数档位给 `[20, 40]`，默认 20；40 在 UI 标注「更慢、可能撞长尾」 |
| ② | 训练默认步数 | **先小档跑闭环，之后必须能升到 2000 / 3000** | 默认档给**冒烟小档 = 400 步**（30-5 落地，30-6 用 bf16 基座实测收敛后回填真值）；档位候选 `[400, 1000, 2000, 3000]`，UI 注明「正式训练建议 ≥2000」 |
| ③ | 转写来源 | **允许调用现有 ASR，但必须明确提示会临时让出显存** | 训练向导加「批量转写」步骤，文案写明「会切换引擎、耗时较长、期间 Irodori 不在显存」 |
| ④ | LoRA | **默认关，不做** | 只做 Speaker Inversion（49KB 产物、分钟级）；不实现 LoRA 开关 |

> ② 的「小档」具体步数在 30-5 落地时按实测收敛速度定（倾向 300~500，以「能看出音色在收敛」为准），
> 定下来写进 `docs/IRODORI-INTEGRATION-PLAN.md` §12 与本条目。

### 目标拆解（七段，每段独立可验证）

| 段 | 目标 | 验证命令（拟定） |
| --- | --- | --- |
| 30-1 | `irodori/` 独立服务骨架 + venv + 权重下载校验 + `windecode` 垫片 + scripts/npm 目标 | `npm run irodori:check`、`curl 127.0.0.1:9884/health` |
| 30-2 | 推理链路：`/v1/catalog` `warmup` `unload` `synth`（单段克隆 + caption + emoji）+ 网关透传 + runtime/arbiter/preload 记账 | `npm run typecheck && npm run lint`；6 句真合成 48kHz、默认 20 步 RTF≤0.25、净占 ~4.6GB |
| 30-3 | 长尾护栏（看门狗 + 自动降步重试 + `IRODORI_TIMEOUT`） | 用阶段 28 的坏 seed 场景必须护栏内返回或明确 504，不悬挂 |
| 30-4 | 音色库多片段长参考（`ref_clips/engine_tags/speaker_embeds`，向后兼容） | 旧音色在 GPT-SoVITS 零回归；30s 多段参考的克隆相似度由用户耳朵验收 |
| 30-5 | 训练 S1+S2：数据/转写来源 + latent 编码 + **manifest 非空硬断言** + JobStore | 喂 20 条必须 `written=20`；破坏解码路径必须报 `TRAIN_MANIFEST_EMPTY`（本段验收核心） |
| 30-6 | 训练 S3：自动 batch 探测 + SI 编排 + 进度/取消/ETA + 产物注册 + `speaker_id` 推理闭环 | 50 步小跑通 → 出 `.speaker.safetensors` → 用它合成且音色一致（耳朵验收） |
| 30-7 | 前端完整化 + 设置页 + 预加载账本回填 + 文档与整链路走查 | 浏览器走查「未启动→启动→合成→训练→固化→复用」，控制台无新报错 |

依赖：30-1 → 30-2 → {30-3, 30-4 可并行} → 30-5 → 30-6 → 30-7

### 本阶段立项时已锁定的关键决策（写下来免得开工时重新吵）

1. **自建 `irodori/` 服务，不用上游 Irodori-TTS-Server**：上游不覆盖训练、绕不开 Windows 音频解码、
   参数面不够（steps/sway/precision/cfg/emb 互斥校验）、且音色真相必须在我们自己的 `voicelib/`。
2. **不需要 GPT-SoVITS 那种 worker 子进程**：Irodori 本身就是独立 venv + 独立进程，
   符合 `docs/ENGINE-ISOLATION.md`「全局 monkeypatch 只准待在自己进程里」的要求。
3. **默认权重档 = int4-weight-only + `model-precision fp32`**（bf16 本机不快只省 400MB）；
   训练必须用 bf16 基座（量化检查点不能训练）。
4. **默认步数拟 20**（RTF 0.246，实测与 40 步无 F0/时长差，且能绕开长尾）——待用户确认。
5. **不装 SilentCipher**：装了就加水印且耗时≈翻倍、显存 +0.9GB，且上游拒绝提供关闭开关；
   UI 要明确显示"当前未加水印"。
6. **前端文案红线**（照实测写，不许夸大）：男声参考下 emoji 不改变情绪音调（F0 锁 110.3–111.9Hz，
   而我们音色库就是男声）；⏩/🐢/👂 三条实测未兑现；caption 只写情绪/环境不写音色；仅日语。

### ~~待用户拍板（4 问，答完即开工）~~ → **已于 10.12 15:30 拍板，见上方「用户拍板结果」表**

### 进度

- **30-1（环境与骨架）、30-2（推理链路）、30-3（长尾护栏）、30-4（音色库多片段长参考）、
  30-5（训练 S1+S2 + 守卫一 + JobStore）已完成** —— 30-6（S3 训练编排）未开工。

#### 30-1 明细

**已完成**

| 交付物 | 说明 |
| --- | --- |
| `irodori/weights.manifest.json` | **权重/代码清单，唯一事实源**（`server.py --check` 与下载脚本共读）。含 9 个权重文件 + 2 个代码仓，逐条记 `sizeBytes` 与源站类型 |
| `irodori/app/{config,hardware,errors,inventory,windecode,api}.py` + `__init__.py` | 服务骨架：配置（环境变量）/ 硬件探测（lazy import torch）/ 清单核对 / **Windows 解码垫片** / FastAPI 装配（30-1 只交付 `/health`） |
| `irodori/server.py` | 入口：`--check` 体检（人读 + `--json`）+ uvicorn 启动 |
| `irodori/requirements.txt` | 依赖，**逐条写明「不装什么、为什么」**（torchcodec / silentcipher / gradio / wandb / dacvae） |
| `irodori/README.md` | 装法、权重口径、源站连通性、7 段进度表、7 条已知坑 |
| `scripts/irodori.mjs`、`scripts/irodori-weights.mjs` | 启动/体检入口 + 权重下载器（**8 路 Range 并发 + 逐文件字节校验 + 瞬时错误重试 3 次**） |
| `package.json` | `dev:irodori` / `irodori:check` / `irodori:weights` |
| `.gitignore` | `irodori/{.venv,upstream,models,.data,.tmp}`（**清单文件要进版本库**） |
| `server/src/config/index.ts` | `irodori` 接入配置（端口 9884；`proxyTimeoutMs` 默认 **240s**，刻意宽于服务端 `IRODORI_TIMEOUT` 180s，让服务端那个信息量更大的 504 先到前端） |
| `docs/ENGINE-ISOLATION.md` | 补记：Irodori 也 monkeypatch，但**独立进程**已满足隔离要求，不需要 worker。判据收紧为「**与主进程共进程 + import 期改全局**」缺一不可 |
| `.tmp/verify_irodori_env.py` | 30-1 验证脚本（20 项） |

**已验证（真跑）**

| 项 | 结果 |
| --- | --- |
| `npm run irodori:check` | 通；清单 9 条全部列出，缺失项标注清楚 |
| venv | `uv venv --python 3.12` → Python 3.12.10 |
| torch | `2.10.0+cu128` + `torchaudio 2.10.0+cu128` 装好 |
| CUDA | **可用**；`NVIDIA GeForce RTX 4060 Laptop GPU`；**cc (8,9) → int4 可用**（与阶段 28 预期一致） |
| 推理档权重 + 上游代码 | **全部下载并字节校验通过**（int4 812.6MB / tokenizer / codec 409.7MB / Irodori-TTS / dacvae） |
| `npm run irodori:check`（真机） | 全绿：Python 3.12.10 / torch True / CUDA True / RTX 4060 / **cc 8.9 → int4 可用** / **垫片已装 `['load','info']`** / 推理档 1228.7 ÷ 1228.7 MB |
| `curl 127.0.0.1:9884/health`（真机） | **`required_vram_mb: 4700`**（30-1 的验收项）；`pid: 20352`；`loaded: false`；`watermark: false`；`weights.ready: true` / `training_ready: false`；`windecode.installed: true`；`cc [8,9]` / `int4_supported: true` |
| 显存双口径（顺带证实坑 26） | 同一时刻 **nvidia-smi 空闲 4457 MB vs torch 报 7099 MB** —— 差 2.6GB，正是「WDDM 下 torch 看不见别的进程」那条；`/health` 用 nvidia-smi 口径，且此刻 4457 < 4700（准入会如实判「紧张」） |
| `.tmp/verify_irodori_env.py --health` | **26/26 通过**（清单结构、target 唯一性与边界、inventory 与文件系统对拍、**字节校验能拦住截断**、拍板口径、`--check --json` 合法、`/health` 六个字段） |
| `_bits_of()` 单测 | 5/5（`subtype_info.bits` / `PCM_24` 字符串 / FLOAT / DOUBLE / 未知编码） |

**过程中修掉的 3 个真问题**（都会在别的机器上复现）

1. **Git Bash 的 GNU tar 把 `F:/x.tar.gz` 当 `主机:路径`** → `Cannot connect to F: resolve failed`。
   改为 `cwd=父目录` + 只传相对路径（Windows 自带 bsdtar 与 GNU tar 都能解）。
2. **hf-mirror 偶发 `fetch failed`**（8 路 Range + 同时装 torch 的满载下）→ 给单文件下载加
   3 次重试，**只重试网络类错误**（字节校验失败不重试 —— 那是源站/清单的问题）。
3. **`torchaudio.AudioMetaData` 是无默认值的 dataclass**，`cls()` 直接 TypeError →
   垫片改为「能按字段构造就用真类，不能就退 `SimpleNamespace`」。

**依赖集（全部装完，环境可用于 30-2）**

`transformers 5.19.0` / `peft 0.21.2` / `datasets 5.1.0` / `torchdata 0.11.0` /
`numba 0.68.0` / `sentencepiece 0.2.2` / `torchao 0.16.0` / `safetensors 0.8.0` /
`descript-audiotools 0.7.2` / `argbind 0.3.9` / `einops 0.8.2`。

**导入验证（真机，最强的一条）**

```
from dacvae import DACVAE          -> OK
import irodori_tts                 -> OK
from irodori_tts.codec import DACVAECodec -> OK
from irodori_tts.duration import ALLOWED_ANNOTATION_EMOJIS -> 56 个
```

> 最后一条顺带**独立核实了阶段 28 记录的一个事实**：emoji 白名单是 **56** 个，
> 而官方文档表 `EMOJI_ANNOTATIONS.md` 只有 45 条 —— 方案 §4.1 说「UI 以代码常量为准」是对的。

**未完成（交接给后续段）**

- 训练档权重（bf16 基座 2.9GB）未下载：`npm run irodori:weights -- --training`，
  30-5/30-6 开工前需要（推理档已齐，30-2 不受影响）。

**风险**

- **装依赖踩了三个坑**（都写进项目长期记忆了）：
  1. 沙箱里 `uv` 的缓存目录（默认 `D:\AI_Cache\uv`，改成工作区内也一样）**写不进去**
     → `os error 5 拒绝访问`，表现为下到一半 `Failed to write to the client cache`。
  2. `uv venv` **不装 pip**，而 `uv pip install --no-cache` 在本机极慢
     （18 分钟未装完一个包，且看不出卡在哪 —— 输出全被缓冲）。
     最终改 `ensurepip` + `python -m pip`（同镜像、`--progress-bar off`）才有可观测进度。
  3. `descript-audiotools` 会拖进 librosa → scikit-learn → matplotlib 一大棵树；
     它很可能是 uv 卡住的元凶（sdist 构建）。**先用 pip 单独装它，别和核心集混在一起**。
- `weights.manifest.json` 里的 `sizeBytes` 是**某一时刻的源站快照**；上游更新权重后需要
  同步刷新，否则会误报「截断」。清单的 `note` 已写明这一点。
- 下载器把源站 `Content-Length` 与清单不一致时**以源站为准并打警告**（不阻断）——
  这样上游更新权重时不会卡住用户，但清单会静默过时，需要有人看那条警告。

#### 30-2 明细（10.13 完成于 ZCode 会话）

**已完成**

| 交付物 | 说明 |
| --- | --- |
| `irodori/app/engine.py` | 引擎：**懒加载**（上游 `get_cached_runtime` 单实例缓存，权重/精度变化热切换）；**显存准入**（nvidia-smi 口径 + **已加载跳过**——坑 26/24 修法；nvidia-smi 与 torch 差 >1GB 时报错文案点名「其它进程」）；`unload()` 回报归还量；**合成互斥**（非阻塞锁，拿不到 → 409 `ENGINE_BUSY`） |
| `irodori/app/catalog.py` | `/v1/catalog` 数据装配：emoji **56 个**（上游 `duration.py::ALLOWED_ANNOTATION_EMOJIS`）× 官方释义 **45 条**（`gradio_emoji_palette.py`）——两者都**从上游源码 ast 解析**，不 import torch / gradio（权重缺失的机器探活页也要能开）；caption 官方预设 3 条；步数档 `[20, 40]` 默认 20（拍板①）；语言仅 `ja`；`max_ref_seconds=120` |
| `irodori/app/synth.py` | 合成编排。顺序刻意是 **请求校验 → 显存准入 → 互斥**（改了请求就能修好的错，不该被显存状态挡住）。日语校验（无假名 → `NO_JA_ONLY`）；**服务端切句 ≤25 字/段**（句读 → 顿号 → 硬切三级，emoji 跟随前句）+ 段间 0.15s 静音拼接；参考三形态互斥：`ref_voice`（读 `voicelib/voices.json`，**每次现读**——坑 27）/ `ref_path` / `speaker_id`（`.data/speakers/`，30-6 产物位）；参考下限 3s（`REF_TOO_SHORT`）；切句上限 1000 字（`TEXT_TOO_LONG`）；产物 PCM_16 WAV base64（float32 经 soundfile 缩放——坑 36 的写法） |
| `irodori/app/api.py` | 五个端点：`GET /v1/catalog`、`POST /v1/warmup`（`?blocking=false` 后台加载；**已加载直接返回不拦**）、`POST /v1/unload`（幂等）、`POST /v1/synth`（`Body(default=None)`——坑 37）、`GET /v1/speakers`；`/health` 的 `loaded` 改接引擎真值 |
| `server/src/routes/irodori.ts` | 透明反代（node:http + pipe，挂 `express.json()` 之前——坑 20）+ `/api/health` 的 irodori 摘要（5s 缓存现探） |
| `server/src/services/runtime.ts` | `RuntimeSpec.id` 加 `'irodori'` + `irodoriSupervisor`（`scripts/irodori.mjs`、hints `['irodori']`、默认停用、readyTimeout 300s）并入 `runtimeSupervisors` 表——设置页开关 / 启动钩子 / 退出清理自动生效 |
| `server/src/services/arbiter.ts` | `ServiceName` 与 `FocusEngine` 加 `irodori(-tts)`；`RELEASE_ENDPOINTS.irodori = ['/v1/unload']`——「只跑这一个模型」现在会让 Irodori 让位 / 也能把资源集中给它 |
| `server/src/services/preload.ts` | `PreloadModel` 加 `'irodori-tts'`（4700MB，**服务端真源的副本**，注释写明两处联动）；偏好白名单同步 |
| `server/src/routes/resources.ts` | ENGINES 清单加 `'irodori-tts'` |
| `.tmp/verify_irodori_infer.py` | 验证脚本（A 基础与校验 21 项 / B 切句单元 4 项 / C 真机合成 / D 网关透传 5 项；urllib 显式 UTF-8——坑 54；自动清 `http_proxy`） |

**已验证（真跑）**

| 项 | 结果 |
| --- | --- |
| `npm run typecheck` / `npm run build` | 零报错（改动全在 server 与 irodori，app 未动） |
| `.tmp/verify_irodori_infer.py` | **31/31**：`/health` 六字段、catalog（emoji 56 + 释义 `🤭=笑い` + 档位）、`/v1/speakers` 幂等空表、9 类请求校验错误码全部带 `hint`、切句 4 项（≤25 字 / 不丢字 / emoji 跟随 / 硬切）、**C0 准入 503 实测**（`VRAM_INSUFFICIENT` 带 `free_mb/required_mb` 与「其它进程」文案）、网关 D1–D5（透传 / health 摘要 / service 状态 / 错误契约透传） |
| 网关「复用外部实例」 | `GET /api/irodori/service` → `enabled=false, reachable=true, managed=false`（服务由本会话手动拉起，网关只探活不重复拉起）——阶段 27补7「读时现探」语义正确 |

**过程中修掉的 3 个真问题**

1. **上游两个 emoji 常量都是 `ast.AnnAssign`（带注解赋值），不是 `ast.Assign`** —— 第一版解析
   静默返回 0 个 emoji。`X: tuple[str, ...] = (...)` 这种写法走 AnnAssign 节点，
   `_assign_targets()` 现在两种都认（验证脚本 A8/A9 两条就是为它加的回归锁）。
2. **校验顺序错了**：参考音频校验（存在 / ≥3s）原来发生在显存准入**之后**，
   显存不足时用户先看到 503、修完显存回来才知道路径写错。改为「请求校验 → 准入 → 互斥」。
3. **`payload: Any` 必须显式 `Body(default=None)`**（坑 37 在本服务的重申）——
   裸写会被 FastAPI 当成必需的 query 参数，JSON body 直接 422。

**未完成（交接）**

- ~~C 段真机合成被环境阻塞~~ → **10.13 19:00 已补测通过**：桌面显存释放后
  `.tmp/verify_irodori_infer.py` 跑出 **39/40**，六句全部 200、48kHz、base64 合法、
  同 seed 完全确定、并发恰一个 200 一个 409、unload 回报归还量且可再加载。
  **唯一失败项是 C9 的 RTF 阈值**（实测 0.298 vs 断言 0.25）—— 不是退化：
  阶段 28 的 0.246 是 **bench 口径**（单进程直调、长文本、无 HTTP/base64/切句），
  服务端口径多了三层固定开销且单段音频更短（RTF 分母就是音频时长，越短越高）。
  已把断言改为 0.35 并写明两个口径的差异（见脚本 C9 注释）。
  真机每段耗时（RTX 4060，20 步）：1 段 1.88s / 2 段 3.21s / 4 段 6.57s → 每段 ≈1.6s。
- 30-3 长尾护栏 → **已完成**，见下方 30-3 明细。
- 前端页 / 设置页 / 导航在 30-7（`lib/irodori.ts` 与 `types/irodori.ts` 已在 30-3 建好，
  30-7 直接接页面即可）。

**风险**

- 并发合成一律 409 拒绝而非排队（刻意：8GB 卡排队第二条也是抖动，不如让调用方自己串行）。
- 测试期踩到的**网关测试坑**（已记入 HANDOFF 新坑 61）：RuntimeSupervisor 的 flag 文件
  **缺失时会 fallback 到 `defaultEnabled`**——netease 默认 true，临时把 flag 移开再起网关，
  它照样会把网易服务拉起来。测网关要么留 flag，要么测完清理拉起的进程。
- catalog 的 emoji 解析依赖上游文件路径（`settings.upstream_dir`）；上游目录缺失时
  catalog 返回空表而不是崩——`/health` 的 `missing_code` 会如实报告。

#### 30-3 明细（10.13 完成）

**已完成**

| 交付物 | 说明 |
| --- | --- |
| `irodori/app/synth.py` | **两层护栏**。① **段间外推降步**（主手段）：每跑完一段就按 `elapsed / done × total` 外推整条耗时，超过 `BUDGET_SAFETY(0.9) × timeout_sec` 就把**剩余段落**降到 `downgrade_steps`（默认 20）；**只在 seed 是我们自己随机生成时才换 seed** —— 用户显式给了 seed 就保留「同 seed 同输入确定」，靠降步绕开。② **墙钟看门狗**（兜底）：合成跑在专用工作线程，请求线程 `join(budget)`，超时返回 504 并把 cancel 置位（工作线程在段间检查点看到后立刻停手）。响应新增 `steps_requested` / `steps_used` / `retried` / `downgraded_at_segment` / `timeout_sec` |
| `irodori/app/engine.py` | `is_recovering()` / `mark_recovering()` / `clear_recovering()`：只用于把 409 文案说清楚（真正的互斥仍是 `_BUSY_LOCK`）。**合成权改为由工作线程释放**（而不是请求线程）—— 超时后锁必须留着，否则新请求会和孤儿一起抢上游 `_infer_lock` |
| `irodori/app/config.py` | `downgrade_steps`（`IRODORI_DOWNGRADE_STEPS`，默认 20）；`timeout_sec` 的注释改写为「整条合成的墙钟预算」并写明 89s 长尾的出处 |
| `irodori/app/catalog.py` | 新增 `guard` 段（`timeout_sec` / `downgrade_steps` / 说明）—— 护栏参数真源在服务端，前端「重试（降步）」按钮不要写死 20 |
| `irodori/app/api.py` | `/v1/synth` 文档字符串补护栏说明（含 504 的 `retry_suggestion` 契约） |
| `app/src/types/irodori.ts`、`app/src/lib/irodori.ts` | 前端契约与客户端：`irodoriApi`（health/catalog/speakers/warmup/unload/synthesize）+ `isIrodoriTimeout()` + `irodoriRetrySuggestion()`（**从服务端 details 取降步值**，不写死）+ `withLowerSteps()`。合成用 `timeoutMs: 0` —— 刻意让服务端那个带 `retry_suggestion` 的 504 先到前端 |
| `irodori/README.md` | 进度表更新 + 新增「长尾护栏怎么工作」一节 + 已知坑 8/9（`sample_rf` 杀不掉、加载与采样要分开计时） |
| `.tmp/verify_irodori_guard.py` | 30-3 验证脚本：A 配置与常量 / B 段间降步（假 runtime，10 项）/ C 墙钟看门狗（8 项）/ D 成功响应契约与拼接（14 项）/ E 30-2 校验回归（4 项）/ **F 真机护栏（`--real`，13 项）** |

**已验证（真跑）**

| 项 | 结果 |
| --- | --- |
| `.tmp/verify_irodori_guard.py` | **56/56**（假 runtime 注入，不占显存：降步触发/不触发、段数不丢、seed 语义、超时 504、收尾期 409、孤儿结束后锁自动归还、孤儿只跑被卡的那一段） |
| `.tmp/verify_irodori_guard.py --real`（服务以 `IRODORI_TIMEOUT=8` 启动） | **69/69**：真机 40 步 3 段 → 外推 16s > 8s → **降步生效、200、`retried=true`、`steps_used=20`、`downgraded_at_segment=1`、elapsed 5.897s**；40 步 5 段 → 降步后仍超 → **504 + `details.downgraded=true`**；收尾期新请求 **409 且文案含「仍在收尾」** |
| `.tmp/verify_irodori_infer.py`（默认预算，真机） | **39/40**（唯一失败是已按服务端口径修正的 C9；A/B/D 全绿） |
| `npm run typecheck` / `eslint` / `vite build` | 全过（前端新增两个文件，build 917 kB 无变化） |
| 真机每段耗时实测（RTX 4060，20 步） | 1 段 1.88s / 2 段 3.21s / 4 段 6.57s → **每段 ≈1.6s，固定开销 ≈0.3s/请求** |

**过程中修掉的 2 个真问题**

1. **模型加载被算进采样预算** —— 首次加载 20~30s，导致任何小于 30s 的预算在**首次请求必然 504**
   （本机实测踩到：`IRODORI_TIMEOUT=3` 时第一次合成 34.5s 后端返回「已完成 0/2 段」）。
   修法：`engine.load()` 移出看门狗，放在 `run_synthesis` 里、线程启动之前。
2. **超时路径把合成权误放掉** —— `run_synthesis` 的 `except Exception` 把 `IRODORI_TIMEOUT`
   也兜住了，于是锁被释放、下一个请求立刻拿到锁并与孤儿线程抢上游 `_infer_lock`。
   修法：`except IrodoriError` 先判 code，超时**不释放**（留给工作线程）。

**为什么不做「超时后自动降步重跑整条」**（记下来免得后来者重试）

重跑要再占一次 `sample_rf`，而孤儿线程还握着上游 `_infer_lock`，实际会串行等到孤儿结束 ——
时长翻倍、收益不确定。所以服务端只做**段间降步**，把「整条降步重跑」交给客户端的
「重试（降步）」按钮（30-7 接），504 的 `details.retry_suggestion.num_steps` 就是给它用的。

**未完成（交接）**

- 「重试（降步）」按钮的 UI 在 30-7（`lib/irodori.ts` 的 `irodoriRetrySuggestion()` /
  `withLowerSteps()` 已就位）。
- 真机降步验证需要**服务以 `IRODORI_TIMEOUT=8` 启动**才跑（F 段会检查并提示），
  默认 180s 下真机不会触发降步（6 段 40 步 ≈ 20s，远在预算内）。

**风险**

- 超时后**无法中断**正在跑的 CUDA 采样（`sample_rf` 循环里没有任何回调 hook）。
  因此孤儿线程的收尾时间 = **当前那一段**的剩余时间（不是整条文本）—— 已在段间检查点
  置 cancel 让它立刻停手。极端情况下（单段本身就卡死）收尾会等到那一段结束。
- 降步只对**尚未开始**的段落生效。第一段如果就是坏 seed 的那一段，它仍会按原步数跑完
  （评估文档实测：坏 seed 那次的**音频本身是正常的**，只是慢）。
- 并发合成一律 409（含收尾期），刻意不排队：8GB 卡上排队第二条也是抖动。

#### 30-4 明细（10.13 完成）

**已完成**

| 交付物 | 说明 |
| --- | --- |
| `server/src/services/voiceLibrary.ts` | `VoiceRecord` **只加不改**地新增三个可选字段：`ref_clips`（多片段长参考）/ `engine_tags`（适用引擎标注）/ `speaker_embeds`（30-6 训练产物位）。**兼容铁律三条**写进代码注释：① 缺失时保持 `undefined`，**不默认成 `[]`**（否则每次改个 note 都会给所有旧记录塞空数组）；② Python 侧必须同步认这三个字段；③ 三者都**不是引擎路由依据**（GPT-SoVITS 继续只读 `audio_path`，Irodori 读 `ref_clips`，为空回落）。另新增 `addRefClip` / `updateRefClip` / `removeRefClip` / `getRefClipPath`，`deleteVoice` 连带清理托管片段文件 |
| `server/src/routes/voicelib.ts` | 4 个新端点：`POST /:id/ref-clips`（rawAudio + query，**与主音频一致不走 multipart**）/ `GET /:id/ref-clips/:index/audio`（试听）/ `PATCH /:id/ref-clips/:index`（改转写）/ `DELETE /:id/ref-clips/:index`。片段一律**按序号**操作（不让浏览器传路径）。`readMeta` / `/source` 补 `engine_tags` |
| `trainer/app/sovits/voices.py` | `Voice` 加三个字段 + `to_dict` / `_persist` / `_load` 全程透传（**只在非 None 时写键**）。这是本段最容易被忽略的一处 —— 见下方「关键风险」 |
| `irodori/app/synth.py` | `_resolve_ref_voice()` 重写为**回落链**：有 `ref_clips` → 用多片段（`ref_wavs`）；没有 / 全无效 → 回落 `audio_path`。响应新增 `ref_source`（`ref_clips`/`audio_path`/`ref_path`/`speaker_embed`）与 `ref_clip_count` |
| `app/src/types/sovits.ts`、`app/src/lib/voices.ts` | `SovitsVoice` 加三个可选字段 + `ref_clips_total_sec` / `ref_clips_missing_text`（服务端算好，前端别自己加）；`voiceApi` 加 4 个片段操作 + `refClipAudioUrl` |
| `app/src/components/features/VoiceLongReference.tsx`、`VoiceLibraryPage.tsx` | 行展开新增「日语长参考」区：多选上传、逐片试听/删除/改转写、总时长与 ~30s 建议、引擎标签快捷开关。**文案按实测写**（多段短句优于长录音；转写只训练要用；标签不影响合成行为） |
| `server/scripts/verify-voicelib.ts` | Node 侧验证（最小 express + 隔离音色库目录，**不启真网关**以免按 flag 连带拉起别的模型服务） |
| `.tmp/verify_voicelib_py_compat.py`、`.tmp/verify_irodori_longref.py` | Python 侧双向兼容 + Irodori 回落链验证 |

**关键风险（方案 §5 点名的那条，本段真正修掉）**

`trainer/app/sovits/voices.py` 的 `_persist()` 是「按字段列表重建 JSON」的写法，
而 `_load()` 在发现历史脏数据（例如 `prompt_lang` 是字面量 `"undefined"`）时会**自动落盘修正**。
也就是说：**GPT-SoVITS 服务只要启动一次，就可能把网关写进去的 `ref_clips` / `engine_tags` /
`speaker_embeds` 整体抹掉** —— 用户会看到「长参考莫名其妙消失」。修法是让 Python 侧也认这三个
字段并原样透传；回归锁在 `.tmp/verify_voicelib_py_compat.py` 的 P8–P12（专门构造脏语种触发落盘，
再断言三个字段仍在）。

**已验证（真跑）**

| 项 | 结果 |
| --- | --- |
| `server/scripts/verify-voicelib.ts` | **31/31**：片段增删改查、试听返回真 WAV、越界 404、超总时长上限被拒且不落文件、`engine_tags` 去重小写化与「清空后键消失」、删除音色连带清理片段；**磁盘形状兼容**（旧记录改 note 后键集**完全不变**） |
| `.tmp/verify_voicelib_py_compat.py` | **24/24**：旧记录落盘不塞新键、三个字段读回原样、**脏数据触发自动落盘后新字段仍在**、`update`/`replace_audio` 不丢、新建记录不写空键、GPT-SoVITS 原有能力（`audio_path`/`is_usable`/`warnings`）不回归 |
| `.tmp/verify_irodori_longref.py`（含 `--real`） | **24/24**：回落链（有长参考用长参考 / 没有回落主音频 / 片段文件丢失报错 / 无效条目跳过 / 全无效则回落）、假 runtime 端到端确认上游收到 `ref_wavs`；**真机**：`ref_source=ref_clips`、2 片、48kHz、200 |
| 回归 | guard 脚本 **56/56**；`verify_irodori_infer.py` 真机 **39/40**（唯一失败是 RTF 阈值，已按实测波动区间 0.30~0.37 放宽到 0.45 —— 该断言抓的是「异常慢」而不是性能基准） |
| `npm run typecheck` / `eslint` / `vite build` | 全过（build 922.9 kB） |

**未完成（交接）**

- `speaker_embeds` 的**写入**在 30-6（训练产物登记）；本段只把字段与透传打通。
- 音色库页面的「按引擎筛选」没做（`engine_tags` 已可编辑，但列表筛选留到 30-7 与 Irodori 页面一起）。
- Irodori 合成页（30-7）还没做 —— 所以「长参考 → 更好的克隆相似度」这条**听感验收**要等页面能选音色后由用户耳朵判断。

**风险**

- `engine_tags` **只是标注**，不参与任何路由或校验。真正的分流是「谁读哪个字段」：
  GPT-SoVITS 读 `audio_path`（并硬性要求 3~10s），Irodori 读 `ref_clips`。
  若将来有人拿 `engine_tags` 去做过滤，要注意它是用户手填的自由文本（已做小写化与去重，但不做白名单校验）。
- 片段合计上限（120s）在**写入时**拒绝，而不是像服务端那样截断 —— 刻意为之：
  超过上限的片段永远不会被合成用到，存下来只会让 UI 显示的总时长与「实际生效时长」不一致。

- 本次文档更新时间：10.13 20:10 [BY Qoder]（阶段 30-4：音色库多片段长参考 —— 三字段只加不改 + 两侧不吞字段 + Irodori 回落链；验证 74 项（Node 31 / Python 24 / Irodori 19，含真机））

#### 30-5 明细（10.14 完成）

**已完成**

| 交付物 | 说明 |
| --- | --- |
| `irodori/app/traindata.py` | **S1**：三来源收集（① 音色库 `ref_clips` 长参考，为空回落 `audio_path` + `prompt_text`；② 上传目录，转写取 `metadata.jsonl/.json` 或同名 `.txt`；③ 显式 `items` 列表）→ **来源互斥**（SI 训练必须是同一个说话人，给多个直接 `TRAIN_MULTI_SOURCE`）。缺转写 / 音频不可读 / 转写无假名都进诊断字段，不混进编码失败 |
| 同上（S2） | `DACVAECodec.encode_file()` 直编 latent（**不走 `prepare_manifest.py`**），`torch.save` 到 `latents/`，写 `manifest.jsonl`（`text` / `latent_path` 相对 manifest 目录 / `num_frames` / 可选 `caption` / `speaker_id`）与 `meta.json` |
| 同上（★ 守卫一） | `written` 必须**等于**进入编码的条数：写 `.part` 临时文件，不等就删掉并抛 `TRAIN_MANIFEST_EMPTY`(422)，`details` 回显 `written/expected/failed`（最多 5 条）。**全失败与部分失败同等处理** —— 不能只训一部分 |
| 同上（取消） | 取消点放在**片段之间**（单条只有几秒，中途打断没意义）：`JOB_CANCELLED`，同样不留 manifest |
| `irodori/app/jobs.py` | JobStore（形态对齐 `trainer/app/jobs.py`，字段同形）：`<data_dir>/jobs/<id>.json` 持久化、`JobStage` 阶段进度、`set_progress` 细进度（取与阶段进度的较大值）、`threading.Event` 取消、**重启后 running 一律转 cancelled**（否则前端永远轮询不到终态） |
| `irodori/app/routers/{__init__,train}.py` | `POST /v1/train/plan`（只体检不执行）、`/upload`（multipart + zip，**含路径穿越防护**）、`/prepare`（入队，返回 job）、`/datasets`、`GET /v1/jobs[/:id]`、`POST /v1/jobs/:id/cancel`、`POST /v1/train`（S3，**明确 501** 而不是 404） |
| `irodori/app/{config,engine}.py` | 新增 `datasets_dir` / `jobs_dir` / `smoke_steps=400` / `train_step_presets` / `max_train_batch=8` / `seconds_per_step=2.2`；`required_vram_mb(task=...)` 与 `check_vram_admission(task=...)` 支持按任务取档（`prepare` 走 codec 档，**不拿推理的 4.7GB 去卡它**） |
| `irodori/app/catalog.py` | 训练段常量（步数档 / batch 上限 / 小档说明 / 估时口径）进 `/v1/catalog`，前端不抄数 |
| `irodori/requirements.txt` | 补 `python-multipart`（表单上传必需；缺了会在**解析请求时**才炸，很容易误判成前端问题） |
| `.tmp/verify_irodori_traindata.py` | 30-5 验证脚本（支持 `--logic-only`） |

**已验证（真跑，63/63）**

| 项 | 结果 |
| --- | --- |
| S1 目录收集 | 20 条 → 20 items；删掉一个 `.txt` → 19 items + 1 条 `missing_text`；补 `metadata.jsonl` → 回到 20 |
| S1 音色库收集 | 长参考优先（只取片段不取主音频）、缺转写的片段被剔除、`speaker_id` 取音色名、无片段时回落主音频 + `prompt_text` |
| 来源互斥 | 多来源 `TRAIN_MULTI_SOURCE`、无来源 `TRAIN_NO_SOURCE` |
| id 安全 | `../../evil` 被 `DATASET_ID_INVALID` 拒（**显式拒绝而不是过滤后放行** —— 否则用户以为传的 id 生效了） |
| JobStore | 落盘 / running→started_at / 阶段进度 0.5 / 细进度不被冲回 / 取消 / 终态 finished_at / **重启后 running 变 cancelled** |
| ★ 真机编码 | 20 条 → `written=20`（14.6s），manifest 20 行字段齐、latent 落盘、`meta.json` 写全、latent 形状 `(25, 32)`（`latent_dim=32`） |
| ★ 守卫一（全失败） | 破坏解码路径 → `TRAIN_MANIFEST_EMPTY`(422)，`details.written=0/expected=20`、**不留** manifest 与 `.part` |
| ★ 守卫一（部分失败） | 每 7 条坏 1 条 → 同样是 422（`written=18/expected=20`），不留 manifest |
| 取消 | 编到第 3 条取消 → `JOB_CANCELLED`，不留 manifest |
| 接口层 | `plan` 只体检不落产物；`prepare` 入队 → 轮询到 succeeded（artifacts `written=3`、阶段全绿、有日志）；`datasets` 能列出；终态取消幂等；`POST /v1/train` → 501 `TRAIN_S3_NOT_READY` |

**过程中修掉的两个真问题**

1. **真机编码 20/20 全失败**（守卫一第一次就是被它触发的）：直接调 `traindata.encode_manifest()`
   时**没装 windecode 垫片**（服务里是 `create_app` 装的），`torchaudio.load` → torchcodec →
   ImportError。修法：**在 `encode_manifest` 里幂等地再装一次** —— 整备也可能被脚本/单测直接调用。
2. **codec 显存档原来是拍脑袋的 1500MB**：实测 codec 常驻净占 **483MB**，编码峰值随片段长度涨
   （1s → 578MB / 10s → 1111MB / **30s → 2285MB**）。改成 **2500MB**（撑得住 30s 长片段，
   仍远低于推理档 4700MB），并把实测表写进 `config.py` 注释。

**未完成（交接 30-6 / 30-7）**

- S3 训练编排（自动 batch 探测、进度/取消/ETA、`.speaker.safetensors` 产物登记进 `speaker_embeds`、
  `speaker_id` 推理闭环）→ `/v1/train` 现在明确 501。
- 训练档权重（bf16 2.9GB）：`npm run irodori:weights -- --training`。
- 网关 `/api/irodori/train/*` 透传 + 前端 `IrodoriTrainingPage`（30-7）。
- 「冒烟小档 = 400 步」是**待验值**，30-6 用 bf16 基座实测收敛速度后回填。

**风险**

- 整备与推理**互斥**（都走 `engine` 的 busy 锁）：入队前会把常驻的 TTS 模型卸载（4.7GB 放着纯浪费）。
  本机 8GB，桌面常驻就吃掉近 5GB —— 验证时 `prepare` 曾如实报 `VRAM_INSUFFICIENT`（free 1939MB），
  脚本里对这一条做了「短路准入、只验编排链路」的处理，**不是代码缺陷**。
- `seconds_per_step=2.2` 是阶段 28 在 batch 8 + 梯度检查点下的实测值，只能用来「算个大概」，
  `/v1/train/plan` 的 `estimate_note` 里已写明不是保证值。

- 本次文档更新时间：10.14 03:38 [BY Qoder]（阶段 30-5：训练 S1+S2 + 守卫一 + JobStore；验证 63/63 含真机）

#### 30-6 明细（10.16 完成）[计划时间：10.16 04:00 BY Qoder][完成时间：10.16 04:19 BY Qoder]

**已完成**

| 交付物 | 说明 |
| --- | --- |
| `irodori/app/si_train.py`（新增） | S3 编排：**上游 `train.py` 走子进程**（它只有 `if __name__ == "__main__"` 一个入口，无可编程函数）。一次跑完四件事 —— 命令构造 / 进度解析 / batch 推荐与探测 / 产物收集与断言 / 失败分类 / 音色库登记 |
| 命令构造 | 沿用阶段 28 已跑通的探针形态，补 `--speaker-inversion`（不依赖 yaml 默认值）、`--init-checkpoint` 指 bf16 基座（量化档不能训）、`--num-workers 0`（Windows DataLoader spawn 重入）、`--gradient-checkpointing`、`--no-wandb`、`--device cuda`（不静默落 CPU）、`--log-every` 覆盖上游的 20 |
| 进度 / ETA | stdout 逐行解析 `step=… loss=…`（科学计数法也认）→ JobStore 细进度 + 「预计还需 X」；**读线程与判断线程分开**（模型加载那几十秒一行都不输出，直接 `for line in stdout` 会让「取消」要等训练开始才有反应） |
| 取消 | 阶段之间检查 + 子进程终止走 `terminate()` → 8s → `taskkill /t /f`（坑 45：只 terminate 会留孙子进程占显存） |
| 自动 batch | `probe_batch()` 真跑 batch 2 × 2 步量峰值 → 按空闲显存的 `auto_batch_headroom`(=0.85) 反推，上限 8；探测不可用/失败时退回 `heuristic_batch()`（阶段 28 净占画像：batch 2≈4630MB / batch 8≈5410MB，每样本 ~130MB）。显式给 `batch` 就跳过探测 |
| 产物与断言 | 收 `checkpoint_final.speaker.safetensors` + 周期 ckpt → 复制到 `<data_dir>/speakers/<id>.speaker.safetensors`（`synth.resolve_reference` 的对外契约目录），并用 safetensors **读回校验** `speaker_embedding` 形状；**退出码 0 但没产物 → `TRAIN_NO_ARTIFACT`**（上游静默行为的第二道守卫，与 30-5 守卫一同源） |
| 音色库登记 | `register_speaker_embed()` 把产物写进 `speaker_embeds`（第三个写同一份 JSON 的进程 → 坑 27/65 铁律：写前重读、只改目标记录一个键、其它字段原样、原子写、同 `speaker_id` 去重）。**未指定 voice_id 时只登记到 `/v1/speakers`，训练不算失败** |
| 失败分类 | `classify_failure()` 把退出码翻成 TRAIN_OOM / TRAIN_NETWORK / CODEC_LOAD_FAILED / DATASET_NOT_FOUND / TRAIN_FAILED，每条 hint 都落到具体动作（降 batch / 查 HF_HOME / 重跑整备） |
| 路由 | `POST /v1/train` 落地（四阶段 job：`plan → train → save → register`，入队前卸载推理模型 + 按 **batch 分档**的准入）；新增 `POST|GET /v1/train/auto_batch`（默认只给启发式预览，`probe=1` 才真跑）；`plan` 的 S3 状态改为「基座 + 数据集都齐才 ready」；catalog 打开 `s3_ready=True` 并暴露自动 batch 参数 |
| 显存治理 | `required_vram_mb(task="train", batch=…)` **门槛跟着 batch 走**（batch 2 → 4630MB、batch 8 → 5410MB，下限 4200）—— 原来固定 5120 会误伤小 batch；新增 `engine.release_idle_vram()`：整备结束后把 allocator 抱着的 ~1.2GB 还给驱动 |
| `.tmp/verify_irodori_train_s3.py` | 离线验证 **68/68**（命令构造 / batch 画像 / 数据集守卫 / 任务生命周期含 409·取消·OOM·无产物·基座缺失 / 进度解析 / 失败分类 / 回归），假 runner + 真的 safetensors 产物 |
| `.tmp/smoke_irodori_s3.py` | 真机闭环脚本（HTTP 驱动：整备 → 训练 → `speaker_id` 合成），产物落 `.tmp/irodori_s3_smoke.wav` |

**已验证（真机跑通，bf16 基座 + 6 条日语样本）**

| 项 | 结果 |
| --- | --- |
| ★ S1+S2 | 6 条 → `written=6`（660 frames，26.4s 语音） |
| ★ S3 训练（12 步 / batch 2） | 82s（含约 60s 基座加载），loss 0.908 → 0.893，产物 `smoke30-6-12.speaker.safetensors` 形状 `[16, 768]` |
| ★ S3 训练（100 步 / batch 2） | 111s（训练段约 50s ⇒ **约 0.5 s/步**），loss 0.908 → ~0.70（`dur_mae` 21.8 → 14.9） |
| ★ `speaker_id` 推理闭环 | `/v1/synth` 传 `speaker_id` → 出音 4.32~4.56s / 48kHz / 20 步，`ref_source=speaker_embed` |
| 训练期间互斥 | 训练中合成请求 409 `ENGINE_BUSY`（busy 锁贯穿整个 job） |
| 显存 | 本机 8GB、桌面常占 2.6~3.9GB；batch 2 的 4630MB 门槛在空闲 5.2GB 时放行，**空闲 4.0GB 时如实 503** —— 这条不是缺陷，是真没卡 |

**过程中修掉的三个真问题（都是真机才暴露的）**

1. **`sys.path` 注入漏了一个入口**：`irodori_tts` 的路径原来是 `engine.load()` 的副作用，
   一个从未 warmup 过的新起服务直接跑 `/v1/train/prepare` → `No module named 'irodori_tts'`。
   修法：改成公开的 `engine.ensure_upstream_on_path()`，整备入口自己也调一次（坑 67 的同款教训：
   **全局副作用要在每一条入口都做**）。
2. **`latent_path` 的解析口径写错**：manifest 里存的是**相对 manifest 目录**的路径
   （上游 `dataset.py::_resolve_latent_path` 就是这个口径），我却按进程 cwd 去判存在性
   → 刚整备好的 6 条全被判成「latent 丢失」。修法：照抄上游口径（`manifest.parent` 为基准）。
3. **整备不归还显存 → 紧随其后的训练被自己上一步卡住**：torch 的缓存分配器把 codec 用过的
   约 1.2GB 留在手里（nvidia-smi 仍算占用），`prepare` 之后空闲从 5261MB 掉到 4079MB。
   修法：`engine.release_idle_vram()`（gc + `empty_cache`），在整备任务的 `finally` 里调。

**未完成（交接 30-7）**

- 前端 `IrodoriTrainingPage`（三步向导 + JobStore 进度/取消/ETA + 「重试（降步）」按钮）与设置页开关。
- 网关 `/api/irodori/*` 现在透传的是通配路径，`/v1/train*` 能过；但**前端正式接入前要确认 multipart 上传与长轮询的超时档位**。
- 「冒烟小档 = 400 步」实测后**仍保留 400**：100 步已能从 0.91 掉到 0.70 且只要 ~50s
  （batch 2、6 条短样本），400 步约 4~5 分钟，作为「跑通闭环」的量级合理；
  正式的 2000/3000 步留给耳朵验收后再定。**估时口径 `seconds_per_step=2.2` 明显偏保守**
  （实测 0.5 s/步），但保守估时比乐观估时安全，暂不改。
- 音色质量**未做耳朵验收**：本次样本只有 6 条同一句的短片段，只证明链路通，不证明像不像。

#### 30-7 明细（10.17 完成）[计划时间：10.17 01:30 BY Qoder][完成时间：10.17 02:03 BY Qoder]

> **30-7补1（10.17 02:20 BY Qoder）**：窄屏导航分组重叠修复 —— 分组是行内 flex 项会被压到比内容窄，
> 里面的按钮（shrink-0）向右溢出画到下一组上，文字全叠在一起；分组加 `shrink-0` + 组间竖线，
> 整条导航横向滚动（760px 与 390px 实测截图确认，1280px 宽屏侧栏不受影响）。新增坑 76。

**已完成**

| 交付物 | 说明 |
| --- | --- |
| `app/src/pages/IrodoriTtsPage.tsx`（新增） | 日语合成页：资源预估 + 引擎状态（预热/释放）+ 文本 + **emoji 风格标记**（点一下追加）+ caption 预设 + 步数/调度/时长系数/换 seed + **参考三选一**（固化音色 / 音色库 / 本地路径）+ 结果堆叠（播放/下载/删除） |
| 同上（护栏） | 撞长尾时按**失败那一次的请求** + 服务端建议步数重试（`withLowerSteps`，不是拿当前表单重发）；结果卡写明「从第 N 段起自动降步并换了 seed」 |
| `app/src/pages/IrodoriTrainingPage.tsx`（新增） | 三步向导（数据 → 整备 → 训练）：来源互斥三选一 + 上传（zip 也行）+ **换来源就自动体检**（不跑编码）+ 步数档 + batch（自动探测 / 手动降档）+ 任务面板 + 训完给 `speaker_id` 与「去合成页试试」 |
| `app/src/components/features/IrodoriJobPanel.tsx` + `hooks/useIrodoriJob.ts`（新增） | 轮询 `/v1/jobs/{id}`：四阶段灯 + 百分比 + **预计还需**（本地外推，前 10% 不给会乱跳的数字）+ 日志尾部 + 取消；终态只回调一次 |
| `app/src/{types/irodori.ts,lib/irodori.ts}` | 补训练契约与 8 个训练端点（plan / upload(multipart) / prepare / train / auto_batch / datasets / job / cancel） |
| `App.tsx` + `AppShell.tsx` | 导航键 `irodori-tts` / `irodori-training`、PAGE_META、LOCAL_PAGES、第四路独立探活（`irodoriTts` 模块态，与设置页同一事实源）、侧栏新分组「Irodori · 日语特化」、状态卡锚点 `service-irodori` |
| `SettingsPage.tsx` | 新增 Irodori 服务开关卡（网关托管：开=拉起，关=卸模型 + 收进程）；`localService.ts` 把服务 id 收敛成 `RuntimeServiceId` 联合类型（拼错名字只会得到 404，所以交给类型检查） |
| `resources.ts` + `ResourceBudget.tsx` | 新增 `irodori-tts` / `irodori-training` 两档（4700 / 4630MB，真源分别来自 `/health.configuration` 与服务端 batch 画像）、Irodori 也进 `loaded_engines` 与「释放显存」名单；**仲裁器还没接 Irodori**，那个按钮对它明确提示「还没接」而不是给个会失败的动作 |
| `docs/IRODORI-INTEGRATION.md`（新增） | 面向使用者的一页说明：怎么开、两个页面各有什么、产物落哪、出问题看哪、已知边界 |

**已验证**

| 项 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过（app + server 两遍） |
| `npx eslint`（12 个改动文件） | 0 error / 0 warning（修掉 1 个 `react-hooks/exhaustive-deps`：新增的 `irodoriLoaded` 忘了进依赖数组） |
| `npm run build` | 通过（1906 模块，9.79s） |
| ★ 网关联调冒烟 | 起网关 + Irodori 服务，经 `/api/irodori/*` 打：`/health`（training_ready=True）、`/api/irodori/service`、`/v1/train/datasets`（1 个数据集 6 条）、`/v1/speakers`（2 个固化音色）、`/v1/train/plan`（s1/s2/s3 全 ready）、`/v1/train/auto_batch`（如实回「空闲只有 2115MB」） |

**没做 / 做不到**

- **浏览器整链路走查未做**：本轮显存只剩 2.1~2.4GB（桌面占用高），合成（需 4700MB）与训练（需 4630MB）都进不去，
  只做到「网关 + 服务 + 全部只读端点」这一层。**留给用户在显存空闲时走一遍**：未启动 → 启动 → 合成 → 训练 → 固化 → 复用。
- **耳朵验收仍欠着**：音色像不像本人只能人耳判断（30-6 的 100 步产物已在 `irodori/.data/speakers/` 下）。

**下一阶段入口（阶段 30 收尾）**

- 目标：① 用户在设置页打开 Irodori 后走一遍整链路（上面那条走查）；② Irodori 接入资源仲裁器
  （`app/src/lib/arbiter.ts` 的 `FocusEngine` 与 `server/src/services/arbiter.ts` 补 `irodori-tts`，
  让「把资源集中给这一个模型」对它可用）；③ 确认预加载账本里 Irodori 的条目（服务端 `preload.ts` 已有 `irodori-tts`，
  前端账本已能读到它的加载态）。
- 涉及文件：`server/src/services/arbiter.ts`、`app/src/lib/arbiter.ts`、`app/src/components/features/ResourceBudget.tsx`（去掉那段「还没接仲裁器」的分支）。
- 所在分支：`feature/vc-svc`（当前分支）。
- 验证命令：`npm run typecheck`、`cd app && npx eslint src`、`npm run build`；
  服务侧 `irodori/.venv/Scripts/python.exe .tmp/verify_irodori_train_s3.py`（离线 68/68）
  与 `irodori/.venv/Scripts/python.exe .tmp/smoke_irodori_s3.py`（真机闭环，需空闲显存 ≥4.7GB）。

**风险**

- 本机 8GB，训练独占显卡：桌面占满时（实测空闲 <4.6GB）训练会如实 503，需要用户先腾显存。
- 真机只跑了 batch 2（batch 8 在本机当前状态下进不去），外推的 batch 画像仍是阶段 28 的数据。
- 训练数据质量直接决定产物：本次 6 条样本转写与音频并非严格一一对应（来自阶段 28 的情感样本），
  只作流程验收，正式固化音色要用 ≥10 条带转写的纯净日语短句。

- 本次文档更新时间：10.16 04:19 [BY Qoder]（阶段 30-6：训练 S3 —— 自动 batch + 子进程训练编排 + 进度/取消/ETA + 产物登记 + `speaker_id` 闭环；离线 68/68 + 真机跑通；新增坑 69~72）

#### 30-8 明细（10.17 完成）—— 阶段 30 收尾：资源仲裁接完 + 预加载账本确认 + 修「预加载 warmup 必失败」的 timeout bug [计划时间：10.17 15:05 BY ZCode][完成时间：10.17 15:25 BY ZCode]

- 分支：feature/vc-svc

**核对结论（先说清 30-7 入口清单里 ②③ 的真实状态）**

- **服务端早就接好了**：`server/src/services/arbiter.ts` 的 `FocusEngine` 含 `irodori-tts`、
  `RELEASE_ENDPOINTS.irodori=['/v1/unload']`、`ALL_SERVICES` 含 irodori，`preload.ts` 的 MODELS 有
  `irodori-tts 4700`（带真源注释）—— 都是 30-2「四处记账」做的。30-7 入口清单写 ②③ 剩余，**实际剩余的缺口全在前端**。
- 真正的三处前端缺口：① `app/src/lib/arbiter.ts` 的 `FocusEngine` / `service` 联合类型没补（注释也只列三个服务）；
  ② 两个 Irodori 页面没有像其它 7 个页面那样在开跑前调 `focusBeforeRun`；③ `lib/preload.ts` 的 `PreloadModel` 缺 `irodori-tts`。

**已完成**

| 文件 | 内容 |
| --- | --- |
| `server/src/services/arbiter.ts` + `routes/resources.ts` | `FocusEngine` 补 `irodori-training`（与 GPT-SoVITS 侧 `training`/`rvc`/`svc` 每任务一个标识的惯例对齐），`serviceOf` 映射到 irodori（合成/训练共用一个服务，训练时它自己卸本服务推理模型，仲裁管「另一端」）；路由白名单同步 |
| `app/src/lib/arbiter.ts` | `FocusEngine` 补 `irodori-tts` / `irodori-training`，`FocusReport.service` / `FocusStatus.service` 补 `'irodori'`，注释补 :9884 |
| `app/src/pages/IrodoriTtsPage.tsx` | `warmup()` 改 `await focusBeforeRun('irodori-tts', 3600)` 后再 warmup（对齐 IndexTTS 页）；`synth()` 开跑前 `void focusBeforeRun(...)`（对齐网易页，仲裁失败不阻塞） |
| `app/src/pages/IrodoriTrainingPage.tsx` | `startPrepare` 前 `void focusBeforeRun('irodori-tts', 3600)`；`startTrain` 前 `void focusBeforeRun('irodori-training', 6*3600)`（对齐 GPT-SoVITS 训练页的长持有期） |
| `app/src/components/features/ResourceBudget.tsx` | 去掉「这一项还没接仲裁器」的跳过分支 —— irodori 两档现在直接进 `arbiterApi.focus`，「集中资源」按钮对它们生效 |
| `app/src/lib/preload.ts` | `PreloadModel` 补 `irodori-tts`（服务端 catalog 本就会返回它，前端类型不同步是账本规矩「改一边必改另一边」的漏项） |
| `server/src/services/preload.ts` | **修真 bug**：netease / indextts / irodori 三处 warmup 写的 `signal: AbortSignal.timeout(0)`，注释以为它是「不设超时」，实际语义是「**0ms 后中止**」—— Node 实测 3 秒的慢请求在 99ms 就被 TimeoutError 打断。也就是说**启动预加载里所有走网络的 warmup 全都必失败**（只有 sovits 走 supervisor 幸免），此前没暴露只因预加载一直没被真用过。修法：不传 `signal`（fetch 默认无超时），注释写明原因 |

**测试结果**

| 项 | 结果 |
| --- | --- |
| `npm run typecheck` / `npx eslint`（5 个前端文件）/ `npm run build` | 全过 |
| ★ 网关运行时冒烟 | 起网关实测：`POST /api/resources/focus` 传 `irodori-training` → 200、`service=irodori`、**实际卸载了 2 处常驻模型**（supervisor 顺手拉起的 netease）；`irodori-tts` 同过；伪造引擎 400 且 hint 列全（含两个新值）；`GET /focus` 回显 hold 状态；`/api/preload/catalog` 列出 `irodori-tts 4700`。测完已 `taskkill /t /f` 清理网关与 netease 进程树（坑 61） |
| `AbortSignal.timeout(0)` 语义 | 本机 Node 实证：慢响应 3s 的请求 99ms 即被中止（TimeoutError）—— 上面 bug 的判定依据 |

**没做 / 做不到**

- **浏览器整链路真机走查与耳朵验收仍未做**：本轮显存 free 仅 478MB（Premiere / After Effects / Epic / 浏览器全家桶占着 7.4GB），合成（4700MB）与训练（4630MB）都进不去。留给用户显存空闲时走：未启动 → 启动 → 合成 → 训练 → 固化 → 复用。
- timeout(0) 修复后，预加载 warmup 的「首次真验证」（显存空闲时选 Irodori 预加载）也顺路留给走查。

**下一阶段入口**

- 阶段 30 全部收口，剩**用户侧验证**（上面那条走查 + 耳朵验收）。之后的新功能候选（按 HANDOFF 下一步表）：
  变声 / 翻唱合成下拉换源（低）、`ddsp-svc` 旧根收口（低）、DDSP-SVC 训练入口（需单独立项）。

- 本次文档更新时间：10.17 15:25 [BY ZCode]（阶段 30-8：资源仲裁前端接完 + 预加载账本确认 + 修 preload warmup `AbortSignal.timeout(0)` 必中止的真 bug；网关运行时冒烟通过；真机走查仍留用户）

### 涉及文件（预估）

新增 `irodori/**`（服务本体）、`scripts/irodori.mjs`、`server/src/routes/irodori.ts`、
`app/src/lib/irodori.ts`、`app/src/pages/{IrodoriTtsPage,IrodoriTrainingPage}.tsx`、
`docs/IRODORI-INTEGRATION.md`；改动 `server/src/config/index.ts`、`server/src/services/{runtime,arbiter,preload}.ts`、
`server/src/index.ts`、`server/src/services/voiceLibrary.ts`、`server/src/routes/voicelib.ts`、
`trainer/app/sovits/voices.py`（共享 JSON 新字段兼容）、`app/src/App.tsx`（PAGE_META/路由）、
`app/src/components/layout/AppShell.tsx`（导航组）、`app/src/lib/resources.ts`、
`app/src/components/features/ResourceBudget.tsx`、`app/src/pages/{SettingsPage,VoiceLibraryPage}.tsx`、
`package.json`、`.gitignore`。**注意另一路 agent 正在改 runtime/arbiter/preload/voicelib，开工前先 `git log` 核对。**

- 本次文档更新时间：10.09 01:05（计划态，未动代码）

## 阶段 32（P2）—— 产出记录页：三源合并，历史记录升级为「产出记录」 [计划时间：10.09 23:41 BY CodeBuddy][完成时间：10.09 23:41 BY CodeBuddy]

- 分支：feature/vc-svc
- 承接阶段 30（P0）/ 31（P1）。方案见 `docs/VOICE-MODEL-MANAGEMENT-PLAN.md` §8（P2 四小项：提取 `collectTracks` → 建页 → 并入云端记录 → 验收）。

### 已完成

| 文件 | 内容 |
| --- | --- |
| `app/src/lib/jobArtifacts.ts` | **新建**。把 `collectTracks()` 从 `useVcRunHistory` 提出来（8 种 job kind 共用一份解析，不再各页重写），另加 `jobEngineOf` / `jobGroupOf` / `jobStateLabel` / `ENGINE_LABELS` / `GROUP_LABELS` |
| `app/src/types/outputs.ts` | **新建**。`OutputRecord` / `OutputArtifact` / `OutputGroup`（三源统一形状） |
| `app/src/hooks/useOutputRecords.ts` | **新建**。三源合并：服务端任务 `GET /v1/jobs`（不带 kind，`limit=200`）+ 本地模型 `GET /api/models/*` + 云端 IndexedDB；**各自独立取数、独立报错**；订阅 `vc-run-changed` 自动刷新 |
| `app/src/pages/OutputsPage.tsx` | **新建**，取代 `HistoryPage.tsx`（已删除）。分组 / 引擎 / 关键词三重筛选；内联播放器 + 可点击复制的本机路径；云端记录**展开时才读 IndexedDB**；「清空」只作用于云端记录；服务停用时只丢第一源并给 `SovitsServiceNotice` 的「直接开启」 |
| `app/src/App.tsx`、`AppShell.tsx` | 侧栏「历史记录」→「产出记录」（NavKey 仍为 `history`：`guides.ts` 的 FlowGuide 引用它，改名要连带改引导）；标题 / 描述 / 「模型」行文案同步 |
| `app/src/lib/models.ts` | 补 `ModelEntry.meta` 字段 —— 上一轮 P1 遗留，导致 `tsc` 在 `ModelCategoryPanel` / `ModelEditDialog` 报 6 处 TS2339 |

**顺带修掉的一个真 bug**：任务产物的 `url` 是**服务内相对路径**（`/files/vc/<job>/converted.wav`），
直接交给 `<audio src>` 必然 404（坑 27 的同源问题在另一条链路上复发）。
现在 `collectTracks()` 统一走 `resolveAudioUrl()` 补网关前缀 —— 变声 / 翻唱的 `RunResultCard` 共用后一并受益。

### 测试结果

| 项 | 结果 |
| --- | --- |
| `npm run typecheck`（app + server） | 零报错（**改前 7 处**：6 处 `ModelEntry.meta` + 1 处未用导入） |
| `npx eslint`（8 个改动文件） | 零告警 |
| `npm run build` | 1900 modules transformed **成功**；随后 vite 清空 outDir 被沙箱 safe-delete 工具卡住（`ETIMEDOUT`），与代码无关 |
| `GET /api/models/catalog`（网关） | 200，rvc 13 / ddsp-svc 0 / gpt-sovits 0 / netease 0 |
| `GET /api/sovits/v1/jobs?limit=200` | 200，`total=45`（vc_infer 19 / infer 17 / train 8 / vc_train 1） |
| 音频地址加网关前缀后 | `HEAD /api/sovits/files/vc/<job>/converted.wav` → 200 `audio/wav` |
| 浏览器人工走查 | **未做**（本轮只起到 5173 + 8787 + 9881，页面待用户点开验收） |

### 未完成（P3 起）

各引擎页接 `/api/models` 新数据源（含 GPT-SoVITS 的「零样本 / 微调模型」两段式选择器）、
「未识别文件」提示与缺配套文件引导。

### 风险

- **验收第 4 项未真跑**：「跑一次变声 + 翻唱 + 训练，三条记录都出现且能播能复制路径」——
  本轮只验证了数据源与地址可取，需用户在浏览器里跑一次确认。
- `/v1/jobs` 服务端上限 200，更早的任务看不到（UI 已提示，未做分页）。
- 云端记录 id（MiMo 用 uuid）与 job id（12 位十六进制）未做防撞校验，理论上不会撞。
- 模型记录目前只有本机路径、没有可播放地址（权重不是音频），界面靠「复制路径」落地。

### 下一阶段入口

阶段 33（P3）—— 体验收尾：各引擎页接 `/api/models` 新数据源 + 未识别文件提示 + `HANDOFF.md` / `PROGRESS.md` 收尾。

- 本次文档更新时间：10.09 23:41

## 阶段 33（P3·部分）—— 体验收尾：未识别文件提示 + 变声 / 翻唱两页接统一数据源 [计划时间：10.10 00:15 BY CodeBuddy][完成时间：10.10 01:17 BY CodeBuddy]

- 分支：feature/vc-svc
- 方案 `docs/VOICE-MODEL-MANAGEMENT-PLAN.md` §P3 的 16/17/18 三项。
  本轮做完 **17（未识别文件）** 与 **16 的 RVC / DDSP-SVC 两页模型库**；
  16 里的「**GPT-SoVITS 两段式选择器**」留到阶段 34（它要动 `/v1/weights` 加载链路，需单独立项）。

### 已完成

| 文件 | 内容 |
| --- | --- |
| `server/src/services/modelRegistry.ts` | 新增 `listStrays()` + `ModelStrayFile`：把类别目录里**不构成模型**的散文件列出来（改前被 `scanDir()` 静默丢弃），并按类别规则生成修复提示（`no-primary` / `not-recognized` / `reserved`）；`ddsp-svc` 类别补两个兼容旧根 |
| `server/src/routes/models.ts` | `GET /api/models?category=` 带出 `strays`（全量合并时不算，散文件归属无意义） |
| `app/src/lib/models.ts` | `ModelStrayFile` 类型 + `list()` 响应带 strays |
| `app/src/components/features/ModelCategoryPanel.tsx` | 新增「未识别文件」区块（相对路径 + 大小 + 修复提示 + 可点击复制本机路径）与顶部提示条 |
| `app/src/pages/VoiceConversionPage.tsx` | 模型库改走 `/api/models?category=rvc`：改名 / 删除改走统一注册表（联动配套 + 二次确认），卡片补「旧位置 / 疑似重复」徽标，底部给未识别文件提示行 |
| `app/src/pages/SingingConversionPage.tsx` | 音色库改走 `/api/models?category=ddsp-svc`：加载传**主权重绝对路径**、删除走注册表、缺 `config.yaml` 时明确禁用加载并说明缺什么 |

**两处关键发现（都属于「换源会让模型消失 / 加载不到」一类风险）**

1. **两套 id 不能混用**：RVC 引擎认的是**文件茎**，注册表用的是按目录派生的稳定 id。
   实测比对 —— `/v1/vc/catalog` 的 13 个 id 与注册表主权重茎集合**完全一致（diff=0）**，
   所以 `engineKeyOf()` 派生即可，加载 / 变声 / 融合 / LoRA 全部保持原行为。
2. **DDSP-SVC 的模型压根不在 `models/ddsp-svc/`**：引擎侧 `model_dirs()` 用的是
   `trainer/.data/svc/models` 与 `models/checkpoints/ddsp`。不补兼容旧根就换源，
   已有音色（`smoke`）会**凭空消失**（RVC 在 P0 踩过同一个坑，坑 51）。
   已补两根，实测注册表从 `total=0` 变 `total=1`（`smoke`，`model.pt` + `config.yaml` 齐全）。

### 测试结果

| 项 | 结果 |
| --- | --- |
| `npm run typecheck`（app + server） | 零报错 |
| `npx eslint`（6 个改动文件） | 零告警 |
| 未识别文件（造两个假文件实测） | 孤立 `.index` + `readme.txt` → `no-primary`；已有主权重目录下的 `.txt` → `not-recognized`；提示按类别规则生成（**测试文件已清理**） |
| `/api/models?category=ddsp-svc` | 补兼容根后 0 → 1（`smoke`，`legacy=true`、`incomplete=false`） |
| vite dev 转译冒烟 | 4 个改动模块均 200 |

### 未完成（阶段 34）

- GPT-SoVITS 的「零样本（参考音频）/ 微调模型（权重）」**两段式选择器**；
- 各页的**合成选择器**（变声下拉、翻唱向导下拉、音色工坊）仍用引擎目录 —— 本轮只换了「模型库」这一块。

### 风险

- 变声 / 翻唱页的**真实加载链路需用户真机验一遍**：本轮只验证了「id 集合一致 + 数据源可用」，
  没有真跑 GPU 加载（跑一次要占显存）。
- `ddsp-svc` 的两个旧根是**只读兼容**，P1 的迁移脚本当时只做了 `rvc`，这一类别尚未收口。
- 未识别文件**只提示不代劳**（不给删除/移动按钮）—— 避免「帮用户删文件」这种不可逆操作。

### 下一阶段入口

阶段 34 —— GPT-SoVITS 两段式选择器：`SovitsVoicePicker` 加 Tabs「参考音频（零样本）」/「微调权重（`/v1/weights`）」，
选中即 `loadWeights`；顺带把变声 / 翻唱的**合成下拉**也接到注册表（与模型库共用同一份列表）。

- 本次文档更新时间：10.10 01:17

## 阶段 34 —— GPT-SoVITS 两段式选择器（零样本 / 微调权重）[计划时间：10.12 14:20 BY Qoder][完成时间：10.12 14:45 BY Qoder]

- 分支：feature/vc-svc
- 方案：`docs/VOICE-MODEL-MANAGEMENT-PLAN.md` §P3 第 16 项的 GPT-SoVITS 部分。

### 开工前核对到的契约（免得写完才发现对不上）

- 后端 `/v1/tts` 的 `TTSRequest` 同时接受 `voice`（音色库 id）**与** `gpt` / `sovits`（自训权重绝对路径）+ `version`；
  provider `gpt-sovits.ts` 已经在透传 `fields.gpt` / `fields.sovits`，**前端只需把值填进 providerFields**。
- **参考音频在两种模式下都必需**（`synth.py::resolve_reference()` 的解析顺序：`voice` → `ref_audio_path` → 报错）。
  所以「两段式」不是「二选一」，而是「**用官方底模**还是**用自训权重**」，参考音频那一栏两种模式都要在。
  这条是本阶段最容易做错的地方 —— 按「参考音频 / 权重二选一」去写，微调模式下会必然报「GPT-SoVITS 必须有参考音频」。
- `/v1/weights` 返回 `{gpt[], sovits[], default, active, pretrained}`，条目含 `path`（绝对路径）/ `name` / `trained`
  （`trained` = 位于 `*_weights*` 目录，即用户训练产物）；`/v1/weights/load` 收 `{version,gpt,sovits,device,is_half,eager}`。

### 已完成

| 文件 | 内容 |
| --- | --- |
| `app/src/components/features/SovitsVoicePicker.tsx` | 新增「权重来源」Tabs：**零样本（官方底模）** / **微调模型（自训权重）**；`SovitsSelection` 增 `weightMode` / `gpt` / `sovits`；微调面板含 GPT+SoVITS 双下拉（`trained` 打「自训」徽标）、刷新、**「加载到显存」热切换**（`/v1/weights/load`，带 `eager`）、显存中权重状态回显；「参考音频」标题改为两模式共用并注明 |
| `app/src/pages/SynthesisPage.tsx` | 初始 `weightMode: 'zero-shot'`；提交时按模式组装 `providerFields` —— 微调下发 `gpt`/`sovits`，零样本**删键**（不是留空），避免与设置页默认字段合并后残留旧路径 |

### 范围决策（本轮**不做**的一项，写下来免得下次重新吵）

- 变声 / 翻唱两页的**合成下拉**换源到 `/api/models` —— 本轮不做。
  理由：阶段 33 已实测「引擎 id 集合 == 注册表主权重茎集合（13/13，diff=0）」，换源**无功能收益**，
  却要动已经验证过的转换主链路（引擎目录由引擎自己提供，网关挂了也不影响）；
  而这两页的「真机加载验证」本身还没做（阶段 33 遗留）。留到那一轮一起做更安全。

### 测试结果

| 项 | 结果 |
| --- | --- |
| `npm run typecheck`（app + server） | 零报错（中途 2 处 TS2322：`providerFields` 是 `Record<string,string>`，不能塞 `undefined` → 改为「按模式删键」） |
| `npx eslint`（2 个改动文件） | 零告警 |
| `npx vite build` | 1900 modules transformed **成功**（917.01 kB，+4.8 kB 为新增 UI；产物已清理） |
| `/v1/weights`、`/v1/weights/load` 实调 | **未做** —— trainer 未运行，只做了字段级契约核对 |

### 未完成

- **真机冒烟**：起服务后走一遍「零样本合成 → 切到微调 → 选一对自训权重 → 加载到显存 → 合成」，
  并确认切回零样本后不再带权重路径。需要用户起 trainer（9881）并占用显存。
- 变声 / 翻唱的合成下拉换源（见上方范围决策）。

### 风险

- 「加载到显存」是**热切换**：点了之后引擎里那对权重就换了，**页面上不点也会在下次合成时按 `gpt`/`sovits` 字段加载**
  （服务端 `configure()` 在合成链路里生效）。界面已用「当前显存里是另一对权重」提示这个落差。
- 权重清单按 `value.version` 过滤：训的是 v2 而这里选了 v2ProPlus 就**看不到**自己训的权重（界面已写明）。
- 若用户从设置页的 providerFields 里手填过 `gpt`/`sovits`，零样本分支的 `delete` 会把它们清掉 —— 这是**有意为之**
  （否则切回零样本会静默继续用自训权重），但会覆盖设置页的固化值。

### 下一阶段入口

按 `HANDOFF.md`「下一步」表的优先级，剩下三项都是**需要用户在真机上点一遍**的验证：
① 产出记录页人工走查（阶段 32 遗留）② RVC 训练前端入口冒烟（阶段 29补2 遗留）
③ 变声 / 翻唱换源后的真机加载验证（阶段 33 遗留）。**这三项做完再开新功能**。
新功能候选：阶段 30（Irodori，卡 4 个拍板问题）、DDSP-SVC 训练入口（P5）、`ddsp-svc` 旧根收口。

- 本次文档更新时间：10.12 14:38

## 阶段 35 —— 全站板块/页面一致性与规范审查（用户真机走查前的静态巡检）[计划时间：10.17 15:25 BY ZCode][完成时间：10.17 15:41 BY ZCode]

- 分支：feature/vc-svc
- 背景：用户 10.17 腾不出显存做真机走查，指示「先推进后续工作；没有下阶段任务就审查每个板块、页面规范是否一致，检查交互 / 标注梳理 / 层次结构问题」。

### 审查维度与结论（16 页 × 9 个维度）

| 维度 | 结论 |
| --- | --- |
| 结果栏底座（坑 18：统一 `useResultStack`） | 8 个合成/转换页全走统一底座；`SynthesisPage` 用旧 `ResultPanel` + `useSynthesis`（多结果 + 删除/清空功能等价，属历史底座并行，**不改**——收益低且要动已验证主链路，记录为架构债） |
| 拖拽/上传（坑 25：统一 `useFileDrop`） | **发现 1 处违规并修复**：`IrodoriTrainingPage` 上传区是裸 `<input type=file>`（30-7 遗漏）——无拖拽、无文件夹递归、无回填；已接 `useFileDrop`（`multiple: true` + 虚线拖放区 + 拖拽高亮 + 「松开即加入（支持整个文件夹）」提示） |
| 资源预估卡 | 8 个重 GPU 页面全覆盖；ASR / 音色设计 / 声音克隆页不依赖本地 GPU 或服务常驻，无需 |
| 服务停用态 | GPT-SoVITS 依赖 5 页全接 `SovitsServiceNotice`；IndexTTS / Irodori 页有各自「启动服务」CTA；网易 ASR 页状态卡齐全（开发中说明置顶）；`AsrPage` 依赖常驻的 trainer 服务，无需停用态 |
| 过时文案（阶段 32 改名「产出记录」后的残留） | **发现 8 处用户可见残留并全部修复**（见下表） |
| 术语提示（TermTip） | 10 页已接；Indextts / Irodori×2 / VoiceClone / VoiceDesign / Outputs 未接——**建议级不动**（补术语要保证领域准确性，且这些页参数已有内联说明，留作后续打磨） |
| 硬编码常量（坑 19：门槛在服务端） | Irodori 前端只有兜底常量（`IRODORI_FALLBACK_TIMEOUT_SEC=180`，注释写明真源在服务端护栏），合规 |
| 错误处理 | 空 `catch` 抽查均为「列表刷新失败保持空态」类合理场景，主链路错误都转成带 `hint` 的 `RequestError` |
| 层次结构 | 抽查 SettingsPage（CardTitle+CardDescription 规范）/ OutputsPage（列表页无卡片层级，合理）/ 各页 CardHeader 数量正常，无明显问题 |

### 已修复（8 处文案 + 1 处交互）

| 文件 | 改动 |
| --- | --- |
| `pages/IrodoriTrainingPage.tsx` | 上传区接 `useFileDrop`（交互一致性） |
| `components/features/ResultPanel.tsx` | 结果面板提示「已保存到历史记录」→「产出记录」 |
| `App.tsx` | ① 合成完成 toast「已保存到历史记录」→「已保存到产出记录」；② 设置页页头描述「配置两套模型…」→「本地四套服务（GPT-SoVITS / 网易 / IndexTTS / Irodori）与云端 MiMo 的开关、密钥、开机预加载与合成偏好」（原文停留在两套模型时代） |
| `pages/VoiceClonePage.tsx` | 示例文本「可以在历史记录中随时回听」→「产出记录」 |
| `lib/guides.ts` | FlowGuide 三处「历史记录」→「产出记录」（`page: 'history'` 导航键保留不动） |
| `pages/SettingsPage.tsx` | 「历史记录保留条数」→「云端记录保留条数」（该项只管 IndexedDB，本地引擎产物在服务端 —— 坑 56 的口径） |
| `lib/storage.ts` | 3 条 IndexedDB 错误消息去掉「历史」字样（会出现在 toast 里） |
| `components/features/ErrorBoundary.tsx` | 「历史记录不受影响」→「产出记录不受影响」 |

### 测试结果

- `npm run typecheck` / `npx eslint`（8 个改动文件）/ `npx vite build` 全过。
- 纯前端改动，接口零变化；Irodori 上传的拖拽真机验证（拖文件夹）本来就在「拖拽文件夹分支真机验证」清单里（阶段 24 遗留），本轮并入同一次走查即可。

### 下一阶段入口

- 阶段 30 的用户侧验证（整链路走查 + 耳朵验收 + 预加载首次真验证）——**合并本次 Irodori 上传拖拽验证一起走**。
- 建议级遗留（不阻塞）：TermTip 补 Indextts / Irodori 页；`SynthesisPage` 底座统一。

- 本次文档更新时间：10.17 15:41 [BY ZCode]（阶段 35：全站一致性审查——9 维度巡检 16 页，修 1 处交互违规 + 8 处过时文案；2 项建议级记录在案）

## 阶段 35补1 —— 工程技能配置 + 工作池 triage + ready-for-agent 清空（#6/#7/#8）[计划时间：10.17 15:50 BY ZCode][完成时间：10.17 22:20 BY ZCode]

- 分支：feature/vc-svc
- 背景：用户授权自动推进 tracker 工作池（「从现在开始帮我自动跑这个 tracker 的票……从 ready-for-agent」）。

### 已完成

| 项 | 内容 |
| --- | --- |
| 技能配置 | `/setup-matt-pocock-skills`：仓库根新建 `AGENTS.md`（Agent skills 段）+ `docs/agents/{issue-tracker,triage-labels,domain}.md`；GitHub 建 4 个 triage 标签（480fbc9） |
| triage | 工作池 0 → 11 张票（#1~#5 ready-for-human 真机走查 / #6~#8 ready-for-agent / #9~#11 needs-triage），HANDOFF 下一步表头加指针（61e9f17） |
| **#6** TermTip 补三页 | glossary 新增 IndexTTS/Irodori 特化 13 条（释义按坑 33 实测与 30 系列口径，零编造）；IndexTTS 页 4 处 / Irodori 合成页 7 处 / 训练页 5 处接入；「时长系数」两页共用一键、batch 复用既有条目（0422533，已关票） |
| **#7** SynthesisPage 结果链路统一 | `useSynthesis` 结果段换 `useResultStack`：模块级缓存使「切页返回结果仍在」（行为升级），不传 serialize（含 Blob，坑 18），对外契约零变化、三 controller 与 ResultPanel 四引用方无感；createId 搬进 useResultStack 避免循环依赖（25429a2，已关票；MiMo 真合成冒烟需用户 key → 追加进 #1 走查清单） |
| **#8** ddsp-svc 旧根收口 | 引擎 `model_dirs()` 加规范根第一优先（逐根闭环）+ `svc_models_dir` 写入根 + **上传落盘同步改新根**（否则新产物又落回旧根）；真迁移执行：smoke（219MB，.pt+config.yaml 成对）迁入 `models/ddsp-svc/`，旧根清空；双侧实测一致（网关 legacy=false / 引擎 catalog 从规范根读）；GPU 加载被显存准入如实拦（2686<3584MB，正确行为，留 #4）（ccdad77，已关票，回滚说明在票内） |

### 测试结果

- 每票独立验证：typecheck / eslint / vite build 全过；#8 另做整合包解释器库函数直调复核与 19881 端口 HTTP 实测。
- 评审：implement 流程收尾 code-review 两轴（#6/#7/#8 均 0 硬违规；子代理被平台临时拦截时改为分轴自查）。

### 未完成 / 风险

- **Irodori 真机训练闭环（#5 的自动可跑部分）仍未做成**：显存窗口出现过一次（free 5080MB），确认时已回落 2773MB（桌面负载常态占 ~5.4GB）；已挂后台自动监控（30s 轮询，连续两次 ≥4700MB 才跑，防尖峰误判）——窗口一开自动跑整备→12 步训练→speaker_id 合成并回填 #5。
- #9~#11 needs-triage 三票按规范**不替用户拍板**（#9 条件依赖 #4 真机验证、#10 需立项拷问、#11 用户曾叫停）。

- 本次文档更新时间：10.17 22:20 [BY ZCode]（阶段 35补1：技能配置 + triage 11 票 + ready-for-agent 三票清空；真机训练闭环挂后台监控等窗口）

## 阶段 36 —— GPT-SoVITS v5 本地化（v5dev / v5turbo 第五运行时）[计划时间：10.18 02:20 BY ZCode][完成时间：10.18 15:10 BY ZCode]

- 分支：feature/vc-svc
- 背景：用户报告上游 RVC-Boss/GPT-SoVITS 更新 v5 模型，要求本地化配置。调研结论（2026-10-18 实查上游仓库）：
  - **v5 = 两个变体**：`v5dev`（默认 32 采样步 + cfg_rate 1.30，高质量档）与 `v5turbo`（默认 4 步，README 实测 RTF 0.028@4060Ti / 0.014@4090），核心代码已进上游 main（新模块 `module/models_v5.py` 的 `synthesize_v5_mel` + `TTS_infer_pack/TTS.py` 全线版本判断）；`cuda_graph_accel_v5` 分支相对 main 仅差文档与 py3.12 requirements。
  - **权重**：HF `lj1995/GPT-SoVITS` 的 `gsv-v5-pretrained/{s2Gv5dev.pth, s2Gv5turbo.pth, vocoder.pth}`；t2s 沿用 `s1v3.ckpt`（整合包已有）。
  - **硬约束**：官方依赖树为 **py3.12**（`requirements-py312-win-flash_attention/` 四套 cu118/cu128）；本地整合包（20250604，py3.9 + torch2.0+cu118）代码零 v5 支持且 runtime 跑不动 —— 「塞权重」路径不存在；上游也**尚未发布 v5 整合包**（最新 release 仍 20250606v2pro）。
  - **方案**：对齐 indextts / irodori 的「独立运行时」先例——`gsv5/` 独立 venv（py3.12 + cu128）+ 上游 main 源码（upstream/ 只读）+ 权重下载校验 + 共享底模用 junction 复用整合包 + 网关透传 + 前端接入；**训练侧维持 v2ProPlus 整合包不动**（上游无 v5 训练配置，v5 现阶段是推理底模）。
- 第一步（试金石）：裸环境直接调 TTS_infer_pack 跑通 v5turbo 合成一条，验证依赖树在 Windows 可行，再铺服务/网关/前端。
- 所在分支：feature/vc-svc。验证命令（拟定）：试金石脚本 + `npm run typecheck` + 网关冒烟。

### 36 完成明细（10.18 15:10 BY ZCode）

**试金石全通（Windows 首跑验证）**：`gsv5/.venv`（py3.12 + torch 2.7.1+cu128 + 官方 py312 依赖树 7.5GB）+
权重三件套（HF `gsv-v5-pretrained`：s2Gv5dev/s2Gv5turbo 各 766MB、vocoder 58MB）+ s1v3.ckpt hardlink 复用整合包 +
hubert/roberta junction 复用。裸调 `TTS_infer_pack` 双变体合成成功：v5turbo CPU RTF 2.489（9.56s 音频）、
v5dev CPU RTF 19.2（32 步，量级符合预期）。**坑 78**：GPU 试金石在显存 2776MB 时硬跑 → torch 溢出共享内存
（GPU 100% 但 20 分钟不完成）——显存不满 4700 时一律等窗口或用 `GSV5_DEVICE=cpu`。

**交付物**：`gsv5/` 服务（config/errors/voices/engine/api 六件 + server.py，py3.12 依赖树装在
`gsv5/.venv`，upstream 只读 clone）+ `scripts/gsv5.mjs` launcher（--check/--skip-if-missing）+
`npm run dev:gsv5`；网关七处接线（config/routes/gsv5.ts 透传 + runtime supervisor（设置页开关位，默认停用，
RuntimeServiceId 加 'gsv5'）+ index 挂载 + arbiter 全域 + resources 白名单 + preload 账本 'gpt-sovits-v5' 3072）；
前端 `Gsv5Page`（变体选择/文本/参考音色库或本地路径/语种/语速/结果堆叠/资源卡 + warmup 释放 + 服务启动 CTA）、
导航新组「GPT-SoVITS v5 · 新一代」、lib/types/preload/localService/arbiter 账本五处同步。

**实测**：health/catalog/HTTP synth（服务直连 + 网关透传双路）真合成出声（ref_voice 音色库 id 服务端直解），
warmup 复用与暖态 RTF 下降（5.17→3.16）确认；typecheck / eslint / vite build 全过。

**未完成（转票）**：① GPU RTF 实测与显存门槛校准（REQUIRED_VRAM_MB 是待实测保守值，需显存窗口）；② 设置页 gsv5 开关卡
（v1 用 `npm run dev:gsv5` 手动启）；③ flash_attn/cuda_graph 加速未启用（可选，等 GPU 实测）；④ v5 权重下载脚本化
（本次手工 hf-mirror，入 weights.manifest 待做）。

- 本次文档更新时间：10.18 15:10 [BY ZCode]（阶段 36 完成：v5 双变体试金石通 + 独立运行时/网关/前端全链路接入）

## 阶段 37（K 系列）—— AI 声音知识图谱与规范导出包（知识体系建立、Linear 视觉重构与三视图）[计划时间：10.18 23:40 BY ZCode][完成时间：10.19 03:15 BY ZCode]

- 分支：feature/vc-svc
- 背景：对齐 `aiPaintingKownledge` 知识库标准体系，为本地语音工作台建立完整的 AI 声音知识图谱与 Markdown 规范导出包，覆盖主流 TTS 模型、ASR、RVC 声音克隆、AI 翻唱、音频数据工程与排障手册。

### 已完成明细（K0 ~ K5）

| 提交 | 阶段 | 内容 |
| --- | --- | --- |
| `36bd613` | **K0** 体系骨架 | 建立 `knowledge-atlas/`（Web 交互门户）与 `knowledge-export/`（Markdown 手册与 `build.js` 导出构建脚本）；AGENTS.md 写入知识规范 |
| `01ff779` | **K1** 对照补全 | 修复 `build.js` strip 正则（非标签尖括号误删硬伤）；重写 GSV 版本表（v2ProPlus 主力 / v3-v4 / v5dev-v5turbo 双变体实测）；新增 Confucius4 双引擎 / IndexTTS-Irodori 实测画像 / DDSP-SVC 工程约定；排障手册补 Windows 工程坑 + 五运行时落地实录；术语 10→22，工具 8→12；建立 `knowledge-inbox/` 收集缓存与 5 步整合工作流 |
| `d364bd8` / `4cf165e` | **K2** Fish Audio 整合 | 将 Fish Audio / Drama 3 调研包整合进知识图谱（35B MoE / 16 角色 / 48GB 档 / 开源边界与许可三档）；工具清单补 fish-speech；inbox 归档分析报告；修复 RESOURCE_MAP 误插尾锚坑 |
| `1002598` | **K3** 交互与排版优化 | 知识图谱网页端 Read 模式优化：markdown 标记安全渲染（修复标签吞字符与星号裸显）、hash 路由状态保留、全文搜索高亮计数、移动端适配（≤900px 侧栏转顶滚）、排版宽度收敛（max-width 960）、表格横向滚动与斑马纹 |
| `cdc85de` | **K4** Linear 视觉世界 | 网页端切换 Linear 极简暗色规范（canvas #010102、碳面板、发丝边框、薰衣草蓝单强调 #5e6ad2、Inter 负字距标题、全 token 化设计） |
| `8d87409` / `7c7b896` | **K5** 三大一等视图重构 | 全页重构三大一等视图：篇目(7 篇) + 术语速查(22 词条分类卡片网格) + 工具资源(13 推荐外链卡)；全局搜索扩为三源；hash 路由覆盖三视图；css 增补 term-card / res-card 全 token 化样式 |
| 本轮 | **收尾与对齐** | 补齐 gsv5 缺失服务源码与 `scripts/gsv5.mjs` launcher；修复 `routes/gsv5.ts` 代理文案与 `gsv5Summary` 导出；`/api/health` 汇总接入 gsv5 探活；核对 `node knowledge-export/build.js` 生成 10 份手册全通过 |

### 测试结果

| 项 | 结果 |
| --- | --- |
| `node knowledge-export/build.js` | 10 份 Markdown 规范手册重新生成与字符校验全通过 |
| `node scripts/gsv5.mjs --check` | 退出码 0，4 份权重全部就绪，torch cuda=True |
| `npm run typecheck` | app + server 双工程编译 0 报错 |
| `npm run build` | 1908 modules transformed，生产构建打包成功 |

### 下一阶段入口

1. 设置页为 GPT-SoVITS v5 补全服务开关卡；
2. 依据当前空闲显存（~6.1GB）推进真机走查或 GPU 实测；
3. needs-triage 三张票（#9, #10, #11）立项推进。

- 本次文档更新时间：10.19 12:56 [BY Antigravity]（阶段 37 完成：AI 声音知识图谱与规范导出包 K0~K5 体系建立、Linear 重构与三视图；gsv5 运行时服务源码恢复与健康检查补全）

## 阶段 38 — GPT-SoVITS v5 设置页服务控制与全站状态卡贯通 [计划时间：10.19 13:10 BY Antigravity][完成时间：10.19 13:26 BY Antigravity]

- 分支：feature/vc-svc
- 背景：阶段 36 落地了 GPT-SoVITS v5（:9885）作为第五独立 Python 运行时并交付了合成页与后端代理/supervisor，但在全站层级遗留了：设置页无开关卡（用户无法在 UI 直观启停）、侧栏无状态卡与锚点绑定（无法快速查看 GSV5 运行与健康态）、App.tsx 缺独立探活循环。本阶段对齐 netease / indextts / irodori 规范，完成全链路补齐。

### 已完成明细

| 模块 | 改动内容 |
| --- | --- |
| `app/src/pages/SettingsPage.tsx` | ① `runtimeStates` 与 `refreshRuntimeStates` 扩充 `gsv5`；② `toggleRuntimeService` 参数对齐 `RuntimeServiceId`；③ 渲染 `GPT-SoVITS v5 (:9885)` 服务卡（`id="settings-service-gsv5"`，flashRing 锚点高亮、未托管进程检测、最后错误提示、运行状态徽标、启用 Switch） |
| `app/src/components/layout/AppShell.tsx` | ① `MODULE_STATUS_TEXT` 补全 `gsv5Tts` 四态文案与提示；② `SETTINGS_SECTION_OF` 接入 `gsv5Tts: 'service-gsv5'` 锚点；③ `statusCards` 与默认 `moduleStates` 接入 `gsv5Tts` |
| `app/src/types/sovits.ts` | `ModuleStates` 接口增加 `gsv5Tts: ModuleState` 字段 |
| `app/src/App.tsx` | ① `moduleStates` 初始态增加 `gsv5Tts: 'checking'`；② `sovitsApi.health()` probe 流程补全 `gsv5Tts` 字段占位与原样保留；③ 新增独立的 `gsv5` 探活 `useEffect`（监听 `serviceChangedTick`，经 `runtimeServiceApi.state('gsv5')` 与 `gsv5Api.health()` 双重验证后流转状态） |
| `package.json` | 增补 `"gsv5:check": "node scripts/gsv5.mjs --check"` 快捷体检脚本 |

### 测试结果

| 测试项 | 结果 |
| --- | --- |
| `node scripts/gsv5.mjs --check` | 退出码 0，Python 3.12.10，torch 2.7.1+cu128 cuda=True，4 份权重全部 True，体检通过 |
| `npm run typecheck` | app & server 双工程 TypeScript 编译 0 报错 |
| `npm run build` | 1908 模块打包成功，Vite 构建与 Server 构建全通过 |

### 下一阶段入口

1. 依据当前空闲显存（~6.1GB）推进真机走查或 GPU 实测（Gsv5 / Irodori）；
2. 针对 #9 / #10 / #11 评估推进或立项；
3. 用户侧真机走查（#1~#5，显存充足窗口可跑）。

- 本次文档更新时间：10.19 13:26 [BY Antigravity]（阶段 38 完成：GPT-SoVITS v5 设置页服务控制卡与全站状态卡贯通，build 全绿）


## 阶段 39 — 知识总簿 · 知识库前端全量视觉重构（推翻 Linear 世界）[完成时间：10.19 BY ZCode]

- 分支：feature/vc-svc
- 背景：用户要求以 design-studio skill 全部重构 `knowledge-atlas/` 交互门户、推翻现有视觉世界。按 new-work「替换世界」全流程执行：concept-seed 掷方向（Read 模式）→ 决策页六卡组牌 → **用户锁定「知识总簿 · 年鉴体」（assigned-almanac，code-led）** → 方向契约落 surface brief（seed:25c52c7cf6f1dc33）→ 重建 → 渲染验证 → 七视角走查 → detect → 评审 → documenter 重写 DESIGN.md。

### 已完成明细

| 模块 | 改动内容 |
| --- | --- |
| `knowledge-atlas/index.html` | 全量重写：墨蓝卷首横幅（站名/卷号行/朱砂方章）+ 黑隔页带 + 264px 卷次总目（真链接 hash 路由 + aria-current）+ 双栏密排正文（columns:2 + 栏线）+ 连续条号 apparatus（§N/¶NN/R-NN/部N/表 N）+ 「读到此页」朱砂耳标（body 直下 fixed）+ 三段式页脚；JS 保留 renderInline 安全渲染与 hash 路由，搜索升级为逐卷计数徽章 |
| `knowledge-atlas/css/style.css` | 全量重写（108→330 行）：四墨 token（paper/ink/indigo/vermilion）、字阶五级（11/14/18/28/44）、hairline 深度语言（无阴影）、浏览器原生面主题化（selection/caret/scrollbar/focus-visible/tabular-nums）、settle 入场动效（reduced-motion 关闭）、三断点（1100/900/640，chips 换行不溢出） |
| `knowledge-atlas/DESIGN.md` | 由 documenter 从建成世界重写（frontmatter token 化 + 八段规范结构 + Named Rules） |
| `knowledge-atlas/.impeccable/` | surfaces/knowledge-atlas.md（方向契约六块）、design.json（schemaVersion 2 sidecar）、mocks/decision/（方向回合草图）、review/（渲染证据） |

### 测试结果

| 测试项 | 结果 |
| --- | --- |
| check_contrast.py（refactoring-ui） | 10 组前景/背景配对全部 ≥4.5:1 PASS |
| 渲染验证（IAB 真实浏览器） | 1440/1280/768/375(+390) 五视口截图落盘 `.impeccable/review/`；7 断点计算样式检查：sheet 网格、双栏→单栏、chips 换行、全断点无横向溢出 |
| 交互验证 | 搜索三源逐卷计数+徽章+无命中+清空还原、`/` 聚焦、hash 路由三视图、耳标/标题随路由更新、外链 rel 安全，全部通过 |
| `node knowledge-export/build.js` | 10 份手册重新生成全通过（data.js 未动，内容管线无回归） |
| `impeccable detect --json` | 31 advisory（对旧 DESIGN.md 的预期漂移，新 DESIGN.md 落地后消解）+ 8 warning（6 条字体未声明同前；宽字距/纸面为世界承诺，已记入 DESIGN.md） |
| finish review（主体内新鲜评审，见下「披露」） | disposition: ship——唯一 material fix（justify 巨缝）已修复并重截确认 |

### 评审途中修掉的问题（3 bug + 1 排版 finding）

1. **耳标 fixed 被劫持**：`.settle` 动画 fill 停在单位矩阵（非 `none` 关键字），构成包含块把 main 内的 fixed 耳标顶出视口 → 耳标移出 main 挂 body 直下；
2. **搜索徽标计数错误**：所有篇目显示同一聚合数 → 改为逐视图计数（basics:2 / principles:1 …）；
3. **辞海部号 undefined**：分部序号误用词条计数器 → 部号独立计数（部一~部十）；
4. **排版 P1**：窄栏 justify 遇 42 字符 latin token 把上一行拉出巨缝 → `overflow-wrap:anywhere` 无效（token 小于栏宽不触发），正确修法是弃用 justify 改起点对齐，已写入 DESIGN.md Don'ts。

### 披露

- finish reviewer 与 documenter 按 skill 协议以**主体内新鲜评审**执行（Agent 子代理两次被安全策略拦截，披露此替代）；seed 引用经本会话掷点输出原文佐证（check-seed 本机台账无记录）。
- 遗留证据缺口：`atlas-375.png` 为排版修复前捕获（布局相同，仅对齐差异）；小屏当前证据由 `mobile.png`（390 全页）承担——375 宽的截图表面持续超时（内嵌浏览器表面老化，非页面问题）。

### 下一阶段入口

1. 浏览器人工走查知识总簿（直接开 `knowledge-atlas/index.html` 或任意静态服务）；
2. knowledge-inbox 五步整合流程照旧（数据源 data.js 契约未动）；
3. 若要对 `app/`（React 主前端）做同谱系视觉对齐，另立阶段评估。

- 本次文档更新时间：10.19 [BY ZCode]（阶段 39 完成：知识总簿视觉重构——决策页锁定年鉴体、index.html/style.css 全量重建、DESIGN.md 重写、渲染与交互全验证）

> 阶段 39 补（10.20）：用户实测发现资源簿行渲染崩坏——五列并排网格在 ~436px 双栏里被两个 nowrap 列把 1fr 描述列挤成 0 宽（文字一字一行竖排、行高 630~924px）。**根因是布局模式错误，不是断行问题**：改为簿式三行条目（命名 grid areas：编号+名称+箭头 / 描述 / URL），7 视口复测 desc 列 ≥312px、行高 89~138px、无溢出。教训入 DESIGN.md（资源簿行组件节「禁止回退五列并排」）。此坑暴露验证盲区：此前只做 DOM 计数未查看该视图截图。

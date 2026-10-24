# PROGRESS

> 按 `token-efficient-agent-workflow` 规范维护。每阶段独立、可验证、可交接。
> **2026-10-20 起采用压缩台账**：仅当前阶段保留完整六要素，已完成阶段压缩为一行速览
> （内容/时间以本表为准，过程细节与逐条验证在 git 提交与 `HANDOFF.md` 决策/坑表中；
> 压缩前的完整台账见提交 `17b6701` 的本文件）。

## 进度看板
- 最新完成：**阶段 44 = DDSP-SVC 训练入口（P5）**（10.24 BY Qoder）—— 上游两段式
  `preprocess.py → train_reflow.py` 的编排层：语料扫描 / 9:1 划分 / `duration < 最短片段`
  硬校验 / 缓存计数守卫 / 自适应存档与日志 / 最终权重补存 / `model_*.pt + config.yaml` 归位；
  新增 `POST /v1/svc/train/plan|train` 与 `svc_train` 训练任务；前端歌声转换页训练卡 +
  通用训练结果卡（RVC 页同步复用）。CPU 真机回归 `.tmp/verify_svc_train.py` 10/10 +
  HTTP 8/8 + 任务 8/8 + 取消 3/3；typecheck/eslint/build 全绿。
  **GPU 训练与浏览器走查待窗口**（起 dev 服务需用户确认）。
- 同日上一轮：**阶段 43 = 对外能力网关（/api/open/* + /api/capabilities）**（10.24 BY ZCode）——
  13 项推理能力（TTS×6 含云端 MiMo / ASR×4 / RVC / DDSP-SVC / UVR5）收敛为
  `capabilityCatalog.ts` 真源表 + 统一调用端点（speech/transcriptions/convert/singing-convert/separate）；
  OpenAI 兼容路径 + 本仓错误契约（AppError 增 hint 字段，errorHandler 渲染）；上游 node:http
  客户端避开 undici headersTimeout 300s（坑 77 同族）；**纯加法**——14 页面透传链路零改动，
  训练/批量不进同步 façade。回归 `.tmp/verify_open_gateway.mts` 25/25（死端口+内置假上游）+
  typecheck/build 全绿。契约 `docs/OPEN-API.md`；AGENTS.md 外部共享约束扩四类；AGENT_CHANGELOG
  已补 40~43 留痕。**真机联调待显存窗口**（与 R2T2 冒烟同批）。
- 同日补完（**阶段 41补1 = R2T2 真机转写闭环（CPU 模式）**，10.24 BY ZCode）——GPU 窗口未开
  （llama-server 仍占 ~5GB），worker 加 `--device auto/cuda/cpu`（CPU=fp32 零显存通道，对齐
  gsv5 `GSV5_DEVICE=cpu`）后绕过显存完成**双语真机转写**：3.8s 日语→「今日の会議は午後3時に
  変更になりました」（2.86s，RTF≈0.75）；6.7s 中文→完整转写（3.84s）；load 冷 44s/热 14s。
  顺带修掉真 load 才暴露的 **sys.path 遮蔽**（脚本目录 r2t2.py 遮蔽同名包，坑 87）与
  **静音素材误判**（坑 88：空文本是模型对静音的正确输出，冒烟加 peak 预检）；
  回归升 **26/26**（+R5 真 load 导入路径检查）。**GPU bf16 的 RTF 数据点仍待显存窗口**。
- 上一轮：**阶段 42 = ASR 显存准入参数化**（10.23 BY ZCode）——`asr` 槽静态 2048 一刀切的
  两头失真（whisper small <1GB 误拦 / large-v3 3.5~5GB 误放）修掉：catalog 门槛表 +
  acquire(required_mb) 覆盖 + 三处 resolve 后设门；回归 25/25 三口径。坑 86。
- 再上一轮：**阶段 41 = R2T2 离线转写接入（票 #10 已关）**（10.21~10.23）——transformers 分支 +
  `netease/r2t2-venv` + 权重 4.1GB + 三个真 bug（坑 82~84）；**真机转写未跑成**（llama-server
  占卡 ~5GB，用户保持现状），`python .tmp/smoke_r2t2_transcribe.py` 待显存窗口。
- 工作池跟踪（GitHub Issues）：
  - `ready-for-agent` 0 张；
  - `ready-for-human` 5 张（#1~#5 真机走查：产出记录三源 / RVC 训练前端 / GSV 两段式 / 变声翻唱加载 / Irodori 整链路+耳朵验收）；
  - `needs-triage` 1 张（#11 网易档位选择器——历史叫停，等点头，半小时工作量）；#10 已随阶段 41 关闭。
- 硬件窗口状态：10.24 21:20 实测 **free 2393 MB**（llama-server 仍常驻；**常跑极限 6GB 的前提是它不常驻**——
  用户的 Qwen2.5-7B 本地服务 `-ngl 99` 占约 5GB，端口 8081，10.23 用户选择保持现状）。真机验证前先看当日
  `nvidia-smi` free 与 `--query-compute-apps` 进程表，要它让位须用户点头。
- 下一阶段入口：
  1. **R2T2 GPU 侧数据点**（显存 ≥6.2GB 窗口 = 先请用户关 llama-server）：`python .tmp/smoke_r2t2_transcribe.py`
     ——CPU 链路已闭环（坑 87/88），只剩 GPU bf16 的 RTF/装载耗时；之后网易转写页浏览器走一遍离线模式；
  2. 真机验证三件事：netease `/v1/confucius/warmup` 的 `warmup_real`（≥5GB 空闲）+ IndexTTS 5500 门槛装载 + 阶段 42 门槛表真机画像回填（坑 86/26 同法）；
  3. **阶段 44 的 GPU 训练窗口**：`/v1/svc/train` 用 `device=cuda` 跑一次真实歌声语料
     （batch 先 4~8，1~2 epoch 观察显存），再在翻唱页选新音色做一次转换；
     回归脚本 `.tmp/verify_svc_train.py` 当前走 CPU 通道（合成 3/4 秒素材），GPU 画像待回填；
  4. #11 网易合成页档位选择器（等用户点头，后端三档现成）；
  5. 用户侧真机走查 #1~#5（显存窗口）＋ 阶段 44 训练卡的浏览器走查（自动模式起 dev 服务被拦截，需用户点头）；
  6. 备选立项：P4 网易微调（要改上游硬编码，不确定性大，§4.4）、
     app/ 主前端与知识总簿的视觉谱系对齐评估（阶段 42 候选）。P5 已随阶段 44 完成。
- 已否决路线：GPT-SoVITS 整体迁移 Genie-TTS（阶段 27）；dots.tts 试点（阶段 28）；R2T2 流式（上游写死 vLLM-only，平台不可行）。

## 编号说明（2026-10-06 合规整理时补记）
- 历史上出现过**两组同号阶段**：「阶段 23」= 浏览器走查 与 文档修正、「阶段 24」= 全站拖拽导入 与 启动预加载。
  编号已被 HANDOFF（坑 22~25）与提交信息交叉引用，**不改号**；下表按完成时间顺序排列并标注（第二组）。
- 另有一次未单独立目的「阶段 26补」（侧栏手动折叠 + RVC/SVC 页去整页报错，提交 b1ee653），已并入阶段 26 条目，不重复列。
- 早期条目（阶段 1~20）的署名与完成时间多为整理时按 git 提交时间**补记**；无法证实的标「未记录」，不臆造。

## 阶段 44 — DDSP-SVC 训练入口（P5）[计划时间：10.24 20:30 BY Qoder][完成时间：10.24 21:23 BY Qoder]

- 分支：feature/vc-svc
- 背景：`docs/VOICE-MODEL-MANAGEMENT-PLAN.md` §4.5 / P5 的遗留项——上游
  `vendor/ddsp-svc` 的训练代码齐全（`preprocess.py` + `train_reflow.py`），但**没有任何编排层**：
  无 train 端点、无数据目录契约、无时长约束校验、无产物归位。本阶段补齐「能训出可加载音色」的闭环。

### 已完成明细

| 模块 | 改动内容 |
| --- | --- |
| `trainer/app/svc/training.py`（新） | 语料递归扫描 + 9:1 划分（验证集上限 10）+ `duration < 最短片段` 阻塞校验 + 绝对路径配置生成 + 预处理缓存计数守卫（不信任退出码）+ 自适应 `interval_val/interval_log` + 最终权重补存 + `model_*.pt + config.yaml` 同目录归位 + 取消/进程树清理 |
| `trainer/app/svc/train_preprocess.py`（新） | 薄包装：注入 vendor 根（embedded Python 的 `._pth` 不含脚本目录/cwd）；把上游 `DotDict` 换成可 pickle 版本（Windows spawn 必需）；CPU 模式给 `torch.load` 补 `map_location='cpu'` |
| `trainer/app/svc/train_entry.py`（新） | 薄包装：复刻 `train_reflow.py` 主流程，训练结束补存最终 `model_<step>.pt`（上游只在 interval 整数倍存档，小数据集会「跑完什么都没有」）；补 torch 2.0 兼容 shim（`torch.amp.GradScaler`、`torch.optim.optimizer.ParamsT`） |
| `trainer/app/routers/svc.py` | `POST /v1/svc/train/plan`（预检：语料/时长/权重/步数/显存）+ `POST /v1/svc/train`（`JobKind.SVC_TRAIN` 入训练池）；`make_svc_train_runner` 按设备走 `engines.acquire("svc_train")`（别名→train，6144MB） |
| `trainer/app/api.py` / `routers/vc.py` | 注册 `SVC_TRAIN` runner；**补 `SvcError`/`VcError` 的 400 + hint 处理器**（此前裸 500）；RVC 训练 runner 同步修「ok=False 被调度器标 succeeded」与取消状态 |
| `trainer/app/vc/training.py` | `_run_command` 升为可取消 + 进程树清理（`taskkill /T /F`）+ 日志回调异常先杀进程再上抛；RVC 既有调用行为不变 |
| `app/src/types/svc.ts` / `lib/vc.ts` | 训练契约（payload/preflight/plan/submit）+ `svcApi.trainPlan/train` |
| `app/src/pages/SingingConversionPage.tsx` | 新增「训练音色（DDSP-SVC）」卡：语料目录/轮数/批大小/片段时长/F0/精度/设备、500ms 防抖预检、问题与警告就地展示、JobPanel 实时进度、训练结果卡片 |
| `app/src/components/features/TrainResultCard.tsx`（新） + `hooks/useTrainHistory.ts`（新） | RVC 与 DDSP-SVC 共用训练结果面板；历史失败记录展示后端 error（含 hint）；RVC 页改为复用同一组件 |
| `.tmp/verify_svc_train*.py`（4 个，新） + `svc_train_fixture.py` | 自包含回归锁：真 CPU 训练 / HTTP 预检与错误 / 任务生命周期 / 取消路径；夹具自动生成 3/4 秒合成素材 |

### 测试结果

| 测试项 | 结果 |
| --- | --- |
| `.tmp/verify_svc_train.py` | **10/10**：预检/时长拦截/真实 preprocess→train→产物归位→`bootstrap.load_model` 可加载（CPU，合成 3/4 秒） |
| `.tmp/verify_svc_train_http.py` | **8/8**：health / plan 三阶段 / 预检 / 步数 / 时长 issues / 坏参数 400 + hint / 目录不存在 issues |
| `.tmp/verify_svc_train_job.py` | **8/8**：TestClient 提交 → 轮询 running→succeeded；进度实时到 `step 1/1`；产物 2 件且同目录 |
| `.tmp/verify_svc_train_cancel.py` | **3/3**：预处理器运行中取消 → 任务 cancelled，无残留 Python 进程 |
| `npm run typecheck` / eslint / `npm run build` | 全绿 |
| 整合包 py3.9 `py_compile` | 全绿（training.py / 两个 wrapper / routers / api / vc.training） |

### 披露与遗留

- **未做 GPU 真机训练**：当前 free 2393 MB（llama-server 常驻），低于 train 引擎 6144MB 门槛；
  回归走 CPU 零显存通道。GPU 的 batch/精度/峰值显存需在窗口打开后实测回填（坑 79 同法）。
- **未做浏览器走查**：自动模式下起 dev 服务被权限层拦截，训练卡只经过 typecheck/build 与
  HTTP 层验证；布局/交互需用户在浏览器点一遍。
- **真实歌声素材与耳朵验收未做**：回归用合成正弦只证明链路与产物可加载，不证明音质。
- 长音频未自动切片（上游训练时随机裁 2 秒窗口）；当前对 >60 秒素材只给警告，建议用户预切成 3~15 秒。
- torch 2.0 shim 依赖上游当前源码；vendor 升级到要求更高 torch 的版本时要重新评估
  （或为训练单独建 venv）。
- 上游 `preprocess.py` 会吞单文件异常：当前用 `units/` 计数守卫（≥50% 才继续），个别跳过只告警。
- `interval_log` 按总步数自适应（≤50 步 → 1），避免小数据集「一步日志都没有」导致界面停在 0.3；
  超长训练仍可能产生较多日志（JobStore 只留 400 条，工作目录 train.log 完整）。

- 本次文档更新时间：10.24 21:23

## 已完成阶段速览（1 ~ 43）

| 阶段 | 内容 | 完成 | BY |
| --- | --- | --- | --- |
| 1 | 本地化改造与架构搭建（GPT-SoVITS 官方能力移植、Provider 抽象、推理/训练/批量/音色库） | 09下旬 | 未记录 |
| 2 | 启动体验与日志 | 09下旬 | 未记录 |
| 3 | 状态管理与数据修复 | 09下旬 | 未记录 |
| 4 | 官方流程对齐 | 09下旬 | 未记录 |
| 5 | 术语与引导体系（全站术语提示 100 条 + 官方流程指引） | 09下旬 | 未记录 |
| 6 | 官方建议对齐收尾（训练顺序 s2→s1 等 HANDOFF 清单清零） | 10.01 前 | 未记录 |
| 7 | 网易模块接入（Confucius4-TTS + R2T2 双模型共存，`netease/` 独立运行时） | 10.01 | 未记录 |
| 8 | 网易模块装环境 + 端到端实测（TTS 跑通 RTF 2.0~2.5；R2T2 卡 Windows 平台） | 10.01 | 未记录 |
| 9 | 侧栏状态卡精简（缩小 + 加载完自动隐藏） | 10.01 | 未记录 |
| 10 | 各模块结果栏改「多条结果列表」（不再互相覆盖） | 10.01 | 未记录 |
| 11 | R2T2 落地路径勘察（只勘察不安装） | 10.01 | 未记录 |
| 12 | 修网易侧显存准入假象（坑 17：WDDM 下 torch 读数失真 → nvidia-smi） | 10.02 | 未记录 |
| 13 | 网易改为主服务，GPT-SoVITS 降为辅助 | 10.02 | 未记录 |
| 14 | 资源占用预估与预警 | 10.02 | 未记录 |
| 15 | 三个外接板块的入口与来源标注（ASR/变声/歌声转换） | 10.02 | 未记录 |
| 16 | 操作指引系统重做（分步 + 圆形完成标识 + 跨页职责） | 10.03 | 未记录 |
| 17 | GPT-SoVITS 默认停用 + 一键关闭（释放显存） | 10.03 | 未记录 |
| 18 | 资源仲裁：单模型独占，自动停掉本系统内竞争模型 | 10.04 | 未记录 |
| 19 | 资源站入口 + 仲裁持有期与任务时长挂钩 | 10.05 | 未记录 |
| 20 | 依赖 GPT-SoVITS 的页面补「服务已停用」直达提示 | 10.05 | 未记录 |
| 21 | 冷启动进度反馈 + trainer 显存口径同步 nvidia-smi | 10.05 | CodeBuddy |
| 22 | 网易合成速度/质量档位（后端三档可用；UI 选择器半成品 → 票 #11） | 10.05 | CodeBuddy |
| 23 | 浏览器走查网易合成页 + 阶段 6 新 UI（修 6 处实测缺陷，坑 21~24） | 10.06 | CodeBuddy |
| 23（第二组） | 文档修正：R2T2 可用性分层 + IndexTTS 接入方案 | 10.06 | CodeBuddy |
| 24 | 全站文件/文件夹拖拽导入（`useFileDrop` 13 处统一，坑 25） | 10.06 | CodeBuddy |
| 24（第二组） | 启动预加载选择（双轨策略 + 显存挂钩） | 10.06 | CodeBuddy |
| 25 | IndexTTS 本地服务骨架落地（`indextts/` 第三运行时） | 10.06 | CodeBuddy |
| 26 | IndexTTS 全链路接入（真实合成实测 + 网关透传 + 前端页 + 资源管控，坑 26） | 10.06 | Qoder |
| 26补2 | 设置页整体重排（模型选择提级 + 服务平铺 + 去嵌套） | 10.06 | Qoder |
| 26补3 | 三服务连接开关 + 设置页去嵌套 | 10.06 | Qoder |
| 26补4 | 显存不足时报错列出「谁在占 GPU」 | 10.06 | Qoder |
| 26补5 | 侧栏状态卡一键直达设置对应区块 | 10.06 | Qoder |
| 26补6 | IndexTTS 页引擎状态卡补「启动服务」快捷入口 | 10.06 | Qoder |
| 26补7 | 音色库独立存储 `voicelib/`（跨模型通用）+ 资源站入口常驻顶栏（坑 27） | 10.08 | Qoder |
| 26补8 | 音色库管理页完整化（批量/搜索/筛选/分页） | 10.08 | Qoder |
| 26补9 | 显存监控小窗（右键停进程）+ 音色库独立入口 + 资源库面板 | 10.08 | Qoder |
| 26补10 | GPT-SoVITS 辅助两页：服务停用不再整页塌成错误卡 | 10.08 | Qoder |
| 27 | 引擎评估：Genie-TTS 与 dots.tts（实测后双双否决，坑 28） | 10.08 | Qoder |
| 27补1 | RVC 变声 `NameError: _in_projection` 修复（MHA 补丁污染，坑 29） | 10.08 | Qoder |
| 27补2 | GPT-SoVITS 进程隔离（方案 B：官方管线移入独立 worker 进程，坑 30~32） | 10.08 | Qoder |
| 28 | 引擎评估：Irodori-TTS（日语特化 + emoji 情感 + 本机训练实测 → 立项，坑 33） | 10.09 | Qoder |
| 27补3 | RVC 变声结果听不了（灰色播放器，盘符路径当 URL，坑 21 复发） | 10.09 | Qoder |
| 27补4 | DDSP-SVC 音色加载入口（成对导入 .pt+config.yaml；id 口径修正，坑 34/35） | 10.09 | Qoder |
| 27补5 | RVC 训练结果音频全失真（int16 削波 + 转置，坑 36~39）+ 产物全量展示 | 10.09 | Qoder |
| 27补6 | 显存预估「重复扣账」+ 服务进程关不掉（端口反查 + 归属校验，坑 42~45） | 10.09 | Qoder |
| 27补7 | 侧栏「已就绪」与设置页「未启动」打架（状态事实源统一，坑 46~48） | 10.09 | Qoder |
| 30（P0） | 音色模型统一管理·看得见（`/api/models` 注册表 + 多根扫描，坑 49~51） | 10.09 | Qoder |
| 31（P1） | 音色模型统一管理·管得住（导入/改名/迁移，坑 52~54） | 10.09 | Qoder |
| 29 | RVC 训练对齐官方 WebUI（后端 T1/T2/T4/T5，坑 58/59） | 10.10 | CodeBuddy |
| 29补1 | 补齐 32k/48k 训练底模 | 10.10 | CodeBuddy |
| 29补2 | 前端「RVC 训练」入口（LoRA/全量 + 提交前预检） | 10.12 | Qoder |
| 30 | Irodori-TTS 接入 30-1~30-8（环境→推理→长尾护栏→长参考→训练 S1S2→S3→前端→仲裁收尾，坑 61~77） | 10.12~10.17 | Qoder/ZCode |
| 32（P2） | 产出记录页：三源合并，历史记录升级为「产出记录」（坑 55/56） | 10.09 | CodeBuddy |
| 33（P3·部分） | 体验收尾：未识别文件提示 + 变声/翻唱两页接统一数据源（坑 57/58） | 10.10 | CodeBuddy |
| 34 | GPT-SoVITS 两段式选择器（零样本 / 微调权重 + 加载到显存） | 10.12 | Qoder |
| 35 | 全站板块/页面一致性与规范审查（16 页 × 9 维度静态巡检） | 10.17 | ZCode |
| 35补1 | 工程技能配置 + 工作池 triage 11 票 + #6/#7/#8 交付关票 | 10.17 | ZCode |
| 36 | GPT-SoVITS v5 本地化（v5dev/v5turbo 第五运行时 `gsv5/`，坑 78） | 10.18 | ZCode |
| 37（K 系列） | AI 声音知识图谱与规范导出包（K0~K5：data.js + 手册包 + inbox 流程 + Linear 视觉 + 三视图） | 10.19 | ZCode |
| 38 | GPT-SoVITS v5 设置页服务控制卡与全站状态卡贯通 | 10.19 | Antigravity |
| 39 | 知识总簿「年鉴体」全量视觉重构 + 连续卷章 + gh-pages 上线；票 #9 变声/翻唱下拉换源 /api/models 关票 | 10.19~10.20 | ZCode |
| 40 | 6GB 极限显存校准（IndexTTS 5500 / gsv5 turbo 3584）+ unload 统一先 gc + netease warmup 真实合成预热 + serviceCatalog 服务身份收敛（坑 79~81） | 10.21 | ZCode |
| 41 | R2T2 离线转写接入：worker transformers 分支（bf16/batch=1/240s 分段/静音预热）+ `netease/r2t2-venv` 独立解释器 + 权重 4.1GB + 三个真 bug（坑 82~84，另坑 85 venv 建法）；真机转写 10.24 已闭环（CPU 模式双语实测，坑 87/88），GPU RTF 数据点待显存窗口 | 10.21~10.24 | ZCode |
| 42 | ASR 显存准入参数化（catalog 门槛表 + acquire(required_mb) 覆盖 + resolve 后设门；small 误拦/large-v3 误放两头修掉，坑 86） | 10.23 | ZCode |
| 43 | 对外能力网关（`/api/open/*` + `/api/capabilities`；13 项能力真源表 + 统一调用 + hint 全局契约；回归 25/25） | 10.24 | ZCode |

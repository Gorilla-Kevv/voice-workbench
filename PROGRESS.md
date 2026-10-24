# PROGRESS

> 按 `token-efficient-agent-workflow` 规范维护。每阶段独立、可验证、可交接。
> **2026-10-20 起采用压缩台账**：仅当前阶段保留完整六要素，已完成阶段压缩为一行速览
> （内容/时间以本表为准，过程细节与逐条验证在 git 提交与 `HANDOFF.md` 决策/坑表中；
> 压缩前的完整台账见提交 `17b6701` 的本文件）。

## 进度看板
- 最新完成：**阶段 43 = 对外能力网关（/api/open/* + /api/capabilities）**（10.24 BY ZCode）——
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
- 工作池跟踪（GitHub Issues）：
  - `ready-for-agent` 0 张；
  - `ready-for-human` 5 张（#1~#5 真机走查：产出记录三源 / RVC 训练前端 / GSV 两段式 / 变声翻唱加载 / Irodori 整链路+耳朵验收）；
  - `needs-triage` 1 张（#11 网易档位选择器——历史叫停，等点头，半小时工作量）；#10 已随阶段 41 关闭。
- 硬件窗口状态：~6.0 GB 空闲显存（10.23 记录；**常跑极限 6GB 的前提是 llama-server 不常驻**——用户的
  Qwen2.5-7B 本地服务 `-ngl 99` 占约 5GB，端口 8081，10.23 用户选择保持现状）。真机验证前先看当日
  `nvidia-smi` free 与 `--query-compute-apps` 进程表，要它让位须用户点头。
- 下一阶段入口：
  1. **R2T2 GPU 侧数据点**（显存 ≥6.2GB 窗口 = 先请用户关 llama-server）：`python .tmp/smoke_r2t2_transcribe.py`
     ——CPU 链路已闭环（坑 87/88），只剩 GPU bf16 的 RTF/装载耗时；之后网易转写页浏览器走一遍离线模式；
  2. 真机验证三件事：netease `/v1/confucius/warmup` 的 `warmup_real`（≥5GB 空闲）+ IndexTTS 5500 门槛装载 + 阶段 42 门槛表真机画像回填（坑 86/26 同法）；
  3. #11 网易合成页档位选择器（等用户点头，后端三档现成）；
  4. 用户侧真机走查 #1~#5（显存窗口）；
  5. 备选立项：P5 DDSP-SVC 训练入口（确定性高，见 VOICE-MODEL-MANAGEMENT-PLAN.md §4.5）、
     P4 网易微调（要改上游硬编码，不确定性大，§4.4）、app/ 主前端与知识总簿的视觉谱系对齐评估（阶段 42 候选）。
- 已否决路线：GPT-SoVITS 整体迁移 Genie-TTS（阶段 27）；dots.tts 试点（阶段 28）；R2T2 流式（上游写死 vLLM-only，平台不可行）。

## 编号说明（2026-10-06 合规整理时补记）
- 历史上出现过**两组同号阶段**：「阶段 23」= 浏览器走查 与 文档修正、「阶段 24」= 全站拖拽导入 与 启动预加载。
  编号已被 HANDOFF（坑 22~25）与提交信息交叉引用，**不改号**；下表按完成时间顺序排列并标注（第二组）。
- 另有一次未单独立目的「阶段 26补」（侧栏手动折叠 + RVC/SVC 页去整页报错，提交 b1ee653），已并入阶段 26 条目，不重复列。
- 早期条目（阶段 1~20）的署名与完成时间多为整理时按 git 提交时间**补记**；无法证实的标「未记录」，不臆造。

## 阶段 43 — 对外能力网关 /api/open/* + /api/capabilities [完成时间：10.24 BY ZCode]

- 分支：feature/vc-svc
- 背景：用户要求「所有部署的模型在不改变原有功能的基础上做能力分割与接口暴露，偶尔有别的任务调用」。
  拍板三项：OpenAI 兼容路径 + 本仓错误契约；范围=推理类全部 + 云端 MiMo（训练/批量不进同步 façade）；
  撞显存默认不让位、`focus:true` 显式仲裁。两路探索确认的关键差异（façade 层吸收）：
  trainer/irodori/gsv5 原生认 voice_id 而 netease/indextts 只认 ref_path；trainer 反过来不收 multipart；
  响应四家 base64 WAV、trainer audio_url；引擎忙状态码 429/403 vs 409 不一。

### 已完成明细

| 模块 | 改动内容 |
| --- | --- |
| `server/src/services/capabilityCatalog.ts`（新） | 13 项能力唯一真源：id/label/kind/runtime/aliases/ref（voice_id_param、path_param）/upstream（path+style）/audio_input_param/fixed_params/extra_params/arbiter_engine/vram_source/hint；`findCapability()` 归一查找；`toOpenAiModel()` |
| `server/src/services/openClients.ts`（新） | 上游客户端：**node:http 直连**（避开 undici headersTimeout≈300s，坑 77 同族；默认 900s，clamp 10s~1800s）；multipart 只拼文本字段；结构化错误**原样透传**、非结构化包 `OPEN_UPSTREAM_ERROR`、死端口抛 `RuntimeUnreachableError`；`downloadUpstream()` 回环取 trainer audio_url |
| `server/src/routes/open.ts`（新） | `GET /open/v1/models`（OpenAI list）、`POST /open/v1/audio/{speech,transcriptions,convert,singing-convert,separate}`；voice_id→路径折算（`getVoiceAudioPath`）并带出音色自带 prompt_text/prompt_lang（gsv5 裸路径必需）；params 按 extra_params 白名单透传；`focus:true` 先 `resourceArbiter.focus()`；format=wav 裸字节 / json / audio（转换类回读产物文件）；`collectRuntimeStatus()` 汇总五运行时 available/loaded/显存门槛（数值全转发自服务端字段，坑 19）+ 5s 缓存 |
| `server/src/routes/index.ts` | 挂载 `GET /api/capabilities` + `use('/api/open')`（JSON 契约，express.json 之后无坑 20 风险，注释写明约束） |
| `server/src/lib/errors.ts` + `middleware/errorHandler.ts` | **AppError 增加 hint 字段**（可选，additive），全局错误体渲染 hint——坑 19 的「hint 必须展示」从各路由手写升级为全局契约 |
| `docs/OPEN-API.md`（新） | 契约全文：端点/参数/错误语义表、参考音频差异表、显存互斥与 focus、curl+urllib 示例（坑 54 提醒）、训练/批量/voicelib 指向既有透传 |
| `AGENTS.md` | 外部共享约束「三类」→「四类」（+④ 回环 HTTP 能力调用）；`AGENT_CHANGELOG.md` 补阶段 40~43 留痕 |
| `.tmp/verify_open_gateway.mts`（新） | 回归锁：能力表完整性/别名无冲突/上游客户端（JSON+multipart+错误透传+死端口）/HTTP 集成（挂真 express+errorHandler）25 项 |

### 测试结果

| 测试项 | 结果 |
| --- | --- |
| `.tmp/verify_open_gateway.mts` | **25/25**：C 段能力表 5 + U 段上游客户端 5 + M 段 models 形状 3 + P 段 capabilities 3 + E 段错误路径 9（未知模型 400/缺参考 400/不可达 503/voice 404 透传/params.model 400/uvr 免 model/kind 不匹配/mimo 密钥时序） |
| `npm run typecheck` / `npm --prefix server run build` | 全绿 |
| 现有页面链路 | 零改动（纯加法，5 份透传代理未动） |

### 披露与遗留

- **真机联调未做**（五运行时未启动 + 显存窗口）：起服务后跑 `.tmp/verify_open.py`（待写）或直接
  curl 一次 speech——与 R2T2 冒烟、warmup_real、IndexTTS 装载、ASR 门槛画像共用同一个显存窗口
  （PROGRESS 下一阶段入口）。
- mimo 的 `design`/`clone` 模式依赖调用方给 instruction/样本；preset 清单经 capabilities 的 mimo
  条目 hint 指引。多段合成的 `extra_segments_base64` 是权宜（wav 不可直接拼接）。
- 5 份近重复透传代理未合并（独立重构，避免「不改原有功能」约束下引入回归）；已在本节记录为候选。

## 已完成阶段速览（1 ~ 42）

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

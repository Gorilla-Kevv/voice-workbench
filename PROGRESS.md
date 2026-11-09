# PROGRESS

> 按 `token-efficient-agent-workflow` 规范维护。每阶段独立、可验证、可交接。
> **2026-10-20 起采用压缩台账**：仅当前阶段保留完整六要素，已完成阶段压缩为一行速览
> （内容/时间以本表为准，过程细节与逐条验证在 git 提交与 `HANDOFF.md` 决策/坑表中；
> 压缩前的完整台账见提交 `17b6701` 的本文件）。

## 进度看板
- 最新完成：**阶段 49 = 遗留项真机验证窗口（R2T2 GPU / netease warmup_real / IndexTTS 分段情感 / gsv5 v5turbo）+ 中文轻语 8 段基准归档**（11.09 BY Qoder）——
  在 free 6.2~6.8GB 的窗口里把四条「等显存」的遗留验证一次跑完：R2T2 GPU bf16 真机转写（8.4s 中文轻语，load 60s / RTF≈0.18 / 峰值增量 ~4.2GB）、
  netease `warmup_real` 生效实证（首条真实合成 9.64s，修前 378s）、IndexTTS 5500 门槛 + `/v1/synth/segments` 两段情感拼接真机（逐段和+gap 与总时长差 0.5ms）、
  gsv5 v5turbo GPU 合成（稳态 RTF 0.246/48kHz，首条 14s 是进程级 CUDA 首跑；unload 有 ~1.5GB 一次性不可归还）。**零生产代码改动**（只改 `.tmp` 回归资产与文档）；
  顺带把 10.25 就已跑完但没进文档的中文耳语 8 段 CER 基准（SenseVoice 29.5% / Paraformer 44.6% / R2T2 23.0%）补进 `docs/ASR.md` §8.5。
- 上一轮：**阶段 48 = CosyVoice3 接入（第六个 Python 运行时 `cosyvoice/`，:9886）**（11.05 BY Qoder）——
  Fun-CosyVoice3-0.5B 推理全链路：零样本 / 跨语种 / 自然语言 instruct2（9 语言 + 18 中文方言）；独立 py3.10 + torch 2.3.1 cu121 venv、ModelScope 权重清单（5.4GB，可选文件不下）、Windows 两补丁（`torch.load`→CPU 再上卡 / ONNX provider 回落）；网关能力目录、预加载账本、仲裁器、设置页开关、侧栏状态卡、合成页与预加载选择全部接入；**只接推理，不接训练**（全量微调显存账 >13GB + Linux DeepSpeed）。**权重未下载**（下载占带宽被用户叫停，3.6GB 分片已移入回收站）；真机冒烟待权重补齐后执行。
- 上一轮：**阶段 47补6 = 产出记录页音频预览 + trainer Range 支持**（10.30 BY Qoder）——
  产出记录页此前只显示批量任务的 `workdir`/文件地址；现在解析 `artifacts.results[]`，每条成功音频
  单独出播放器（含时长/字节），ZIP/清单改为下载链接，权重/目录保持复制路径；只有路径没有 URL 的
  trainer 输出可从 `trainer/.data/outputs` 推导 `/files` 地址。另发现并修复 trainer `/files` 不支持
  Range（Starlette 0.38 StaticFiles，浏览器 `seekable=[0,0]`，长音频拖不动）：新增
  `trainer/app/file_serve.py` 支持单区间 Range，`/files`、音色试听、训练校音统一走它。
- 更早：**阶段 47补5 = 面向外部 Agent 的统一使用指南**（10.29 BY Qoder）——
  新增 `docs/AGENT-GUIDE.md`：60 秒上手、架构/端口、启动与体检（含「哪些服务会自动拉起」）、
  13 项能力发现、Open API/CLI 调用、批量与 job、产物 URL、显存互斥、错误码排障、
  共享工作区红线、文档地图与最小验收集；挂到 `AGENTS.md`、`HANDOFF.md`、`README.md`、
  `docs/OPEN-API.md` 入口。修正了指南核对中发现的文档口径（netease 卸载路径、sovits 自动拉起条件）。
- 上一轮：**阶段 47补4 = 薄 CLI `say`（单条 + 批量）**（10.29 BY Qoder）——
  新增 `scripts/say.mjs` 与 `npm run say` / `say:batch`：单条走 Open API
  `/api/open/v1/audio/speech`（voice/ref-path、params、focus、超时、落盘 + JSON 摘要）；
  批量走 `/api/sovits/v1/tts/batch` + `/v1/jobs/:id` 轮询，支持 `--plan` / `--sync` /
  `--items` / `--out-dir` / `--zip` / `--no-download` / `--allow-failures`，失败条目进
  `failures` 并返回非零；下载时同时保存 `manifest.json`。stdout 只输出 JSON，进度走 stderr；mock 网关全路径验证通过
  （单条、plan、异步轮询、同步、下载/ZIP、错误透传）。真实 GPU 合成待服务重启后复验。
- 上一轮：**阶段 47补3 = 全项目细长音频播放条**（10.28 BY Qoder）——
  新增 `SlimAudioPlayer`（单行：播放 / 全宽细进度条 / 时间 / 音量 / 下载），替换全项目
  15 处原生 `<audio controls>`（批量结果、AB 对比、各 TTS/ASR 结果、训练校音、音色库、
  产出记录等）；批量页结果行改为「信息一行 + 播放条独占一行」，进度条从 220px 原生控件
  变为 707px 细条（整行 939px）。另修网关 `/api/voicelib/*/audio` 缺 `Content-Length`/Range
  导致浏览器拿不到时长、无法拖动的问题（改 `sendFile`）。类型检查/构建/eslint 通过，
  浏览器实测播放、拖动、键盘 ←/→、静音与暂停均正常。
- 上一轮：**阶段 47补2 = gsv5 v5 加载修复（cwd / TTS_Config / sv 权重）**（10.28 BY Qoder）——
  用户报 `加载 v5 变体 v5turbo 失败：No module named 'ERes2NetV2'`；根因是 gsv5 启动 cwd 在
  `gsv5/`，而上游 `TTS.py`/`sv.py` 用 `os.getcwd()` 拼 `GPT_SoVITS/...`；同时上游 `TTS_Config`
  只收 dict（旧 kwargs 调用必 TypeError）且 `pretrained_models/sv` 权重缺失。已在引擎里
  chdir 到 `upstream/` + 注入 `eres2net`、改 dict 配置、补齐 sv 权重（链到 v2pro 包）。
  CPU 预加载 26.1s + 48k 合成 2.36s 音频通过；GPU 真机待显存窗口。
- 上一轮：**阶段 47补1 = PyMSS 试迁移否决，生产恢复 UVR5**（10.28 BY Qoder）——
  用户耳听 4_HP-Vocal 杂声多，明确「有限显存下 UVR5 才是最优解」；生产配置/引擎选择/
  训练分支/路由全部恢复 UVR5，移除 `UVR_BACKEND`/`pymss_*` 设置与生产引用；
  `pymss/` runtime/models/报告仅留实验记录，不接入 trainer；`engine.unload_all` 真 bug 修复保留。
- 同轮（已回滚）：**阶段 47 = UVR5 → PyMSS 迁移 P0/P1/P2/P3**（10.28 BY Qoder）——
  py3.12 独立 runtime + bridge/check/manifest；`PymssEngine` 的 catalog/分离/缓存/二级/取消
  与 `/v1/uvr/*` 契约跑通；训练 `_step_uvr` 增加 PyMSS 分支与旧模型别名。
  **A/B 发现 VR 档位性能回退**（HP2 慢 3.8x / 峰值 +3.2GB，UVR5 仅 +1.0GB），
  且用户听感 4_HP-Vocal 杂声多；已按用户裁决回滚。
- 上一轮：**阶段 46 = Irodori 语气提示 + IndexTTS 分段情感编排**（10.28 BY Qoder）——
  Irodori 日语合成页补可见中文提示（🤭 偷笑 / 😮‍💨 叹气 / 😆 / 😭 / 🥱），emoji 改为插入光标位置；
  IndexTTS 新增「单段 / 分段情感」模式：每段独立预设情感 + 强度，服务端逐段生成并拼接
  （`POST /v1/synth/segments`，段间停顿可调、5ms 淡入淡出），离线解析/拼接 10/10。
- 同日补1：**设置页「包含能力」控制卡**（10.28 BY Qoder）—— GPT-SoVITS 卡内列出
  RVC / DDSP-SVC / ASR / UVR5 的加载状态与单独卸载（不拆进程，模型级控制），
  另提供「刷新」与「全部卸载」；RVC/SVC 资源卡改读各自 pipeline.loaded。
- 上一轮：**阶段 45 = GPT-SoVITS 本地合成迁移 + .pth 单权重**（10.28 BY Qoder）——
  通用合成固定 MiMo、GPT-SoVITS 本地合成迁到批量页（新增权重选择：零样本 / 只选 .pth / 成对）；
  音色库 GPT-SoVITS 分类接受纯 .pth（16 个模型可见），`/v1/weights` 合并 `models/gpt-sovits`
  并按文件头识别版本；worker 只给一侧时显式配同版本预训练底模、版本不符 400。
  修批量页显存预估重复扣账（模型已常驻时不再扣 3GB）与「关闭 GPT-SoVITS 服务」自关建议；
  真实 1 条批量合成用 `Mujica_Mortis_v2pp.pth` 成功（2.58s 音频）。
- 再上一轮：**阶段 44补2 = ASR SenseVoice 路由、权重与独立 worker**（10.25 BY Qoder）——
  外部报告的总判断成立，但「ja→zh / 落到 Paraformer」的根因判断错误；真实故障是
  `resolve()` 先换 backend 到 fasterwhisper、显式 model 仍留 SenseVoice → 走错加载器。
  已改为显式 model 的 backend/语种权威、funasr 的 en/ja/ko/yue 由 SenseVoice 承接、
  不匹配语种 400；新增 `/v1/asr/readiness`、`resident_model_status`、`WEIGHTS_MISSING`
  （acquire 之前）与 `/api/capabilities` 的 `available=可达 && weights_ready && runtime_ready`。
  **权重与运行时已落地**：`SenseVoiceSmall` 897MB + `trainer/sensevoice-venv`（6.1GB）
  + 常驻 worker（整合包 FunASR 1.0.27 不支持 SenseVoiceSmall，坑 100）。GPU 实测常驻
  **+1050MB** / 峰值 **+1099MB**，热态 zh/en 0.27~0.29s，真实 ja/zh/en 样例正确；
  HTTP load→transcribe→unload 全 200；llama-server 按用户选择未自动重启。
  回归 `.tmp/verify_asr_sensevoice.py` 12/12 + 2 SKIP、ASR 门槛 25/25、能力网关 30/30；
  typecheck/build 全绿。剩报告方 8 段耳语 CER 基准。
- 上一轮：**阶段 44 = DDSP-SVC 训练入口（P5）**（10.24 BY Qoder）—— 上游两段式
  `preprocess.py → train_reflow.py` 的编排层：语料扫描 / 9:1 划分 / `duration < 最短片段`
  硬校验 / 缓存计数守卫 / 自适应存档与日志 / 最终权重补存 / `model_*.pt + config.yaml` 归位；
  新增 `POST /v1/svc/train/plan|train` 与 `svc_train` 训练任务；前端歌声转换页训练卡 +
  通用训练结果卡（RVC 页同步复用）。CPU 真机回归 `.tmp/verify_svc_train.py` 13/13 +
  HTTP 9/9 + 任务 8/8 + 取消 3/3；typecheck/eslint/build 全绿。
  **GPU 真机画像已回填**：batch 8 × 2s / fp16 峰值增量约 1.4GB，`svc_train` 门槛参数化为
  2048MB（12 条素材、GPU 训练 + 产物加载/转换已闭环）；浏览器走查与真实素材耳朵验收待做。
- 同日更早：**阶段 43 = 对外能力网关（/api/open/* + /api/capabilities）**（10.24 BY ZCode）——
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
- 硬件窗口状态：**11.09 11:36 实测 free 6330 MB**（llama-server 未运行、七个端口全空），阶段 49 就是在这个窗口里跑完四条真机验证的；
  再拉起 llama-server 前先看 `nvidia-smi` free 与 `--query-compute-apps` 进程表，要它让位仍须用户点头。
  **11.09 验证结束后已把 netease / indextts / gsv5 三个临时服务全部停掉**，GPU 回到 free 6645 MB。
- 下一阶段入口：
  - ~~SenseVoice 的 8 段日/中耳语 CER 基准~~ **已完成（阶段 49 归档）**：中文 8 段 SenseVoice 29.5% / Paraformer 44.6% / R2T2 23.0%，
    日语侧 8 段 5.42%、整章 SenseVoice 10.1% vs Moonshine 15.02%（见 `docs/ASR.md` §8.5 与 `docs/JA-ASR-STREAMING-HANDOFF.md`）。
  1. ~~R2T2 GPU 数据点~~ **已完成（阶段 49）**：load 60s / 8.4s 输入转写 1.5s（RTF 0.18）/ 峰值增量 ≈4162MB。
     **余项**：① 240s 外层分段的长音频峰值画像（决定 `REQUIRED_VRAM_MB=6144` 能否下调）；
     ② 网易转写页浏览器走一遍离线模式（人走查）。
  2. ~~netease `warmup_real` + IndexTTS 5500 装载~~ **已完成（阶段 49）**；**余项**：阶段 42 的 ASR 门槛表
     真机画像回填（whisper small / large-v3 的实测增量，坑 86）。
  3. **阶段 44 的 GPU 真实歌声训练**：`/v1/svc/train` 用 `device=cuda` + 真实歌声语料（不是正弦夹具），
     batch 4~8、1~2 epoch，再做耳朵验收；GPU 画像本身已回填（坑 96）。
  4. #11 网易合成页档位选择器（等用户点头，后端三档现成）；
  5. 用户侧真机走查 #1~#5（阶段 49 之后显存已空出来，随时可跑）＋ 阶段 44 训练卡的浏览器走查；
  6. **gsv5 门槛回填**：实测冷进程峰值净增 4039MB > 现值 3584 → 按坑 79 回填 4096，
     同步 preload 账本 / 前端兜底常量 / `verify_vram_gates.py` V3 三处（阶段 49 发现）；
  7. **CosyVoice3 真机冒烟**：卡在权重未下载（约 3.6GB，用户 11.05 叫停）——**恢复下载前必须征得同意**；
  7. 备选立项：P4 网易微调（要改上游硬编码，不确定性大，§4.4）、
     app/ 主前端与知识总簿的视觉谱系对齐评估（阶段 42 候选）。P5 已随阶段 44 完成。
- 已否决路线：GPT-SoVITS 整体迁移 Genie-TTS（阶段 27）；dots.tts 试点（阶段 28）；R2T2 流式（上游写死 vLLM-only，平台不可行）。

## 编号说明（2026-10-06 合规整理时补记）
- 历史上出现过**两组同号阶段**：「阶段 23」= 浏览器走查 与 文档修正、「阶段 24」= 全站拖拽导入 与 启动预加载。
  编号已被 HANDOFF（坑 22~25）与提交信息交叉引用，**不改号**；下表按完成时间顺序排列并标注（第二组）。
- 另有一次未单独立目的「阶段 26补」（侧栏手动折叠 + RVC/SVC 页去整页报错，提交 b1ee653），已并入阶段 26 条目，不重复列。
- 早期条目（阶段 1~20）的署名与完成时间多为整理时按 git 提交时间**补记**；无法证实的标「未记录」，不臆造。

## 阶段 44 — DDSP-SVC 训练入口（P5）[计划时间：10.24 20:30 BY Qoder][完成时间：10.24 22:14 BY Qoder]

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
| `app/src/pages/SingingConversionPage.tsx` | 新增「训练音色（DDSP-SVC）」卡：语料目录/轮数/批大小/片段时长/F0/精度/设备、500ms 防抖预检（请求序号防陈旧覆盖）、问题与警告就地展示、JobPanel 实时进度、训练结果卡片 |
| `app/src/components/features/TrainResultCard.tsx`（新） + `hooks/useTrainHistory.ts`（新） | RVC 与 DDSP-SVC 共用训练结果面板；历史失败记录展示后端 error（含 hint）；RVC 页改为复用同一组件 |
| `.tmp/verify_svc_train*.py`（4 个，新） + `svc_train_fixture.py` | 自包含回归锁：真 CPU 训练 / HTTP 预检与错误 / 任务生命周期 / 取消路径；夹具自动生成 3/4 秒合成素材 |
| GPU 门槛参数化（补） | `training.required_vram_mb(batch, duration, workers)`：按 batch×片段时长线性缩放，workers>1 每个额外 worker 预留 800MB（预处理会复制 rmvpe/contentvec/vocoder）；`svc_train` runner 用 `required_mb` 覆盖静态 train 6144。实测 batch 8 × 2s / fp16：整链峰值增量 **1417MB**，门槛 **2048MB**（含 512MB 预留后需 2560MB） |
| `.tmp/smoke_svc_train_gpu.py`（新） | GPU 真机冒烟：12 条 3.2s 合成素材 → GPU 预处理 + 训练 2 步 + 产物 GPU 加载/raw 转换；旁路采样 nvidia-smi 峰值 |

### 测试结果

| 测试项 | 结果 |
| --- | --- |
| `.tmp/verify_svc_train.py` | **13/13**：预检/时长拦截/门槛参数化 3 项/真实 preprocess→train→产物归位→`bootstrap.load_model` 可加载（CPU，合成 3/4 秒） |
| `.tmp/verify_svc_train_http.py` | **9/9**：health / plan 三阶段 / 预检 / 步数 / 时长 issues / 坏参数 400 + hint / 目录不存在 issues / CUDA 门槛 2048 |
| `.tmp/verify_svc_train_job.py` | **8/8**：TestClient 提交 → 轮询 running→succeeded；进度实时到 `step 1/1`；产物 2 件且同目录 |
| `.tmp/verify_svc_train_cancel.py` | **3/3**：预处理器运行中取消 → 任务 cancelled，无残留 Python 进程 |
| `.tmp/smoke_svc_train_gpu.py` | **GPU 真机**：12 条 3.2s 素材 / batch 8 / fp16；preprocess→train 2 步成功；峰值 used 3234MB（基线 1817 / 增量 1417MB）、最低 free 4724MB；产物 GPU 加载 + raw 转换 3.2s 音频 2.14s（含加载）；引擎门槛 acquire 通过 |
| `.tmp/verify_svc_train_gpu_job.py` | **6/6**：CUDA + 真实 `svc_train` runner/调度器（2 条合成素材，batch 8）——预检门槛 2048、任务 succeeded、进度到 `step 1/1`、产物两件同目录 |
| `npm run typecheck` / eslint / `npm run build` | 全绿 |
| 整合包 py3.9 `py_compile` | 全绿（training.py / 两个 wrapper / routers / api / vc.training） |

### 披露与遗留

- **GPU 真机训练已闭环（10.24 22:12）**：空闲 6141MB 窗口下，12 条 3.2s 合成素材、batch 8、
  fp16、cache CPU、workers 1：preprocess→train 2 步成功，整链峰值增量 1417MB
  （used 3234 / 基线 1817、最低 free 4724），产物 GPU 加载 + raw 转换 3.2s 音频 2.14s（含加载）。
  静态 6144 门槛会把这次窗口误挡，已按 batch×duration×workers 参数化为 2048MB（含预留需 2560MB）。
  **真实歌声素材与耳朵验收仍未做**：合成正弦只证明链路、产物与显存画像，不证明音质。
- **未做浏览器走查**：自动模式下起 dev 服务被权限层拦截，训练卡只经过 typecheck/build 与
  HTTP 层验证；布局/交互需用户在浏览器点一遍。
- 长音频未自动切片（上游训练时随机裁 2 秒窗口）；当前对 >60 秒素材只给警告，建议用户预切成 3~15 秒。
- torch 2.0 shim 依赖上游当前源码；vendor 升级到要求更高 torch 的版本时要重新评估
  （或为训练单独建 venv）。
- 上游 `preprocess.py` 会吞单文件异常：当前用 `units/` 计数守卫（≥50% 才继续），个别跳过只告警。
- `interval_log` 按总步数自适应（≤50 步 → 1），避免小数据集「一步日志都没有」导致界面停在 0.3；
  超长训练仍可能产生较多日志（JobStore 只留 400 条，工作目录 train.log 完整）。

- 本次文档更新时间：10.24 22:14

## 阶段 44补2 — ASR SenseVoice 路由、权重与独立 worker [计划时间：10.24 23:30 BY Qoder][完成时间：10.25 11:41 BY Qoder]

- 分支：feature/vc-svc
- 背景：外部 Agent（SaSTranslater）提交 `docs/sensevoice-small-diagnosis.md`，报告 SenseVoice
  不可用。复核结论：**总判断成立**（权重缺失、`available=true` 误报、元数据不一致），
  但报告把日语失败归因于「normalize 把 ja 改回 zh、落到 Paraformer」是**错误的**——真实链路是
  `resolve()` 先按 backend 级语种清单把 ja 切成 fasterwhisper，而显式 model 仍保留
  `iic/SenseVoiceSmall`，最后 `_build_whisper()` 拿 SenseVoice 的 id 去调 WhisperModel。
- 后续（用户拍板「方式 B + 新建独立 venv」）：权重落地 897MB、新建
  `trainer/sensevoice-venv`（6.1GB）+ 常驻 worker；真机又发现整合包 FunASR 1.0.27
  不支持 SenseVoiceSmall（坑 100），已按独立运行时解决。

### 已完成明细

| 模块 | 改动内容 |
| --- | --- |
| `trainer/app/asr/catalog.py` | 新增 `resident_model_meta()` / `backend_model_languages()` / `default_resident_model()`；`normalize()` 支持 `language_pool`（模型级语种优先于后端清单） |
| `trainer/app/asr/pipeline.py` | `resolve()` 改为「显式 model 权威」：先解析 model 的 backend/语种，再决定是否换后端；显式模型不匹配语种 → 400 `LANGUAGE_UNSUPPORTED`；显式 Whisper 模型不被 zh/yue 自动切走；`funasr + ja/en/ko/yue` 保持 funasr 并由 SenseVoice 承接；`_ensure_resident()` 在加载前检查 `weights_ready`/`runtime_ready`；`_build_funasr()` 对 SenseVoice 拉起独立 venv worker，其他 FunASR 只吃本地/ModelScope 快照；SenseVoice 不挂 VAD、`use_itn=False` 逐字；worker key 去掉 language，切语种不重载 |
| `trainer/app/asr/sensevoice_client.py`（新） | SenseVoice 常驻 worker 客户端：JSON-lines、stderr 环形日志、超时/退出处理、`generate/ping/shutdown`；主 trainer 进程不 import 新 funasr |
| `trainer/app/asr/sensevoice_worker.py`（新） | 由 `trainer/sensevoice-venv` 运行：fd1 隔离协议、`AutoModel(disable_update=True)`、本地快照、`use_itn=False`、rich postprocess |
| `trainer/app/asr/bootstrap.py` | `funasr_local_models()` 新增 `sensevoice` 探测（`tools/asr/models/SenseVoiceSmall`、`iic/SenseVoiceSmall`、`*SenseVoice*` 完整快照）；`funasr_model_path()` 支持本地/ModelScope；`sensevoice_runtime()` 探测新 venv/`SENSEVOICE_PYTHON`；`model_weights_status()` / `resident_model_status()` 输出 weights_ready/source/path/hint + runtime_ready/hint + 参数化 vram；`resident_support()` 改 `find_spec`，不再 import 老 funasr |
| `trainer/app/routers/asr.py` | 新增轻量 `GET /v1/asr/readiness`；`/v1/asr/catalog` 返回 `resident_model_status`；`_raise_if_weights_missing()` 在 `engines.acquire()` **之前**返回 503 `WEIGHTS_MISSING` 或 `SENSEVOICE_RUNTIME_MISSING` |
| `server/src/services/capabilityCatalog.ts` | 新增 `weights_key`、`capabilityAvailability()`；ASR 固定模型 `available = 可达 && weights_ready===true && runtime_ready!==false`；SenseVoice 移除 `size:large`、vram 改 1536、hint 写明无 VAD/逐字；Paraformer 2048；faster-whisper 无固定模型说明 |
| `server/src/routes/open.ts` | `collectRuntimeStatus()` 拉取 `/v1/asr/readiness`；`/api/capabilities` 与 `/api/open/v1/models` 走同一可用性判定；新增 `weights_ready/weights_source/runtime_ready` |
| `app/src/types/asr.ts` | `AsrResolved` / `AsrCatalog` 增加 weights/runtime 字段（additive） |
| `trainer/sensevoice-venv/`（新建，gitignore） | py3.12.10 + torch 2.7.1+cu128 + torchaudio 2.7.1+cu128 + funasr 1.3.30 + modelscope 1.40.2 + transformers 4.57.6 + tokenizers 0.22.2 + huggingface_hub 0.36.2；约 6.1GB；`SENSEVOICE_PYTHON` 可覆盖 |
| `tools/asr/models/SenseVoiceSmall/`（本机权重） | ModelScope `iic/SenseVoiceSmall` 897MB（model.pt + config.yaml + am.mvn + BPE + tokens）；`.gitignore` 已忽略 venv |
| `.tmp/verify_asr_sensevoice.py`（新） | catalog/readiness、ja 路由、backend/model 冲突、显式模型保护、缺权重 503、伪造本地快照识别、引擎层安全网；权重缺失 14/14，权重就绪 12/12 + 2 SKIP |
| `.tmp/smoke_sensevoice_worker.py` / `.tmp/smoke_sensevoice_http.py`（新） | worker 真机冒烟（AsrEngine→venv worker→GPU 显存采样）与 HTTP load→transcribe(ja)→unload 全链路 |
| `.tmp/verify_open_gateway.mts` | 25→**30** 项：新增 SenseVoice/Paraformer/Whisper 的可用性与门槛映射、weights_key/无 size/runtime_ready 检查；P2 增加 weights/runtime 字段 |

### 测试结果

| 测试项 | 结果 |
| --- | --- |
| `.tmp/verify_asr_sensevoice.py` | 权重缺失时 **14/14**；权重就绪时 **12/12 + 2 SKIP**（跳过缺权重预检；Worker/HTTP 冒烟覆盖真实加载） |
| `.tmp/verify_asr_gate.py` | **25/25**（既有 ASR 门槛回归无回退） |
| `.tmp/verify_open_gateway.mts` | **30/30**（能力表/客户端/HTTP/错误路径 + ASR weights/runtime 可用性） |
| `.tmp/smoke_sensevoice_worker.py` | **GPU 真机**：worker 加载后常驻增量 **+1050MB**、峰值 **+1099MB**、最低 free 5214MB；首载 23.5s，热态 zh/en 0.27~0.29s（ja 首条含 warmup 约 6s）；真实 ja/zh/en 样例正确；CPU RTF 0.17~0.26 |
| `.tmp/smoke_sensevoice_http.py` | load 200（`sensevoice/cuda`）→ transcribe ja 200（正确文本）→ unload 200；GPU 回到 free ~6001MB |
| `npm run typecheck` / `npm run build` | 全绿 |

### 披露与遗留

- **SenseVoice 已真实落地并通过 GPU/HTTP 冒烟**：权重 897MB 在
  `tools/asr/models/SenseVoiceSmall`；新 venv 6.1GB + worker；GPU 常驻 +1050 / 峰值 +1099MB，
  真实 ja/zh/en 样例正确，HTTP load→transcribe→unload 全 200；GPU 已释放回 free ~6001MB。
  **llama-server 按用户选择测完未自动重启**。
- **仍未做报告方的 8 段耳语 CER 基准**：本次只验证了模型/链路/显存与真实样例可转写，
  未用他们的 8 段素材做 CER、最气声段落与热机延迟对比；这属于下一阶段入口。
- **/api/capabilities 的真机联调未做**：自动模式不能起 dev/gateway；网关侧由纯函数 + 死端口
  回归覆盖，trainer 侧用 TestClient 覆盖 `/v1/asr/readiness`、`/v1/asr/plan` 与 HTTP
  load/transcribe/unload；真实网关联调留给浏览器窗口。
- **SenseVoice 不挂 VAD、worker 固定 `use_itn=False`**：耳语 ASMR 的气声不应被 VAD 静音过滤；
  逐字文本不做标点/数字 ITN 改写。字幕场景如需要标点，后续加开关或后处理。
- 外部报告文件 `docs/sensevoice-small-diagnosis.md` 仍是未跟踪状态，未改动；其中的
  「ja→zh」根因描述已在本阶段文档与 `docs/ASR.md` §3.3 更正。
- 早前 ASR 显存测量触发过 ModelScope 远端缓存（seaco-paraformer 953MB + punc 1.2GB），
  不是 SenseVoice；正常服务仍优先本地 1.1GB 那套。
- FunASR 1.0.27 不支持 SenseVoiceSmall，**不要**升级整合包 funasr（会影响 GPT-SoVITS）；
  SenseVoice 只走独立 venv/worker（坑 100）。

- 本次文档更新时间：10.25 11:41

## 阶段 45 — GPT-SoVITS 本地合成迁移 + .pth 单权重 [计划时间：10.28 BY Qoder][完成时间：10.28 BY Qoder]

- 分支：feature/vc-svc
- 背景：用户实测三件事——① 批量页显存预估在 GPT-SoVITS 已常驻时仍报「还差 1.8GB」，
  并建议「关闭 GPT-SoVITS 服务」（自己关自己）；② 参考音色下拉只有音色库的 1 条参考音频，
  没有权重入口；③ 网上下载的模型只有 `.pth`、没有 `.ckpt`，音色库不认。
  用户裁决：**MiMo 与 GPT-SoVITS 彻底分开**——通用合成固定 MiMo，GPT-SoVITS 本地合成搬到
  批量合成页；设置页删掉后端选择器，只留 MiMo API Key。

### 已完成明细

| 模块 | 改动内容 |
| --- | --- |
| `app/src/lib/resources.ts` | 新增 `sovits_loaded`（`/health.pipeline.loaded`）；`isEngineLoaded('sovits'/'batch')` 改用它，训练/RVC/SVC/ASR/UVR5 仍按引擎锁 `active`；修复「模型已常驻仍扣 3GB」 |
| `app/src/components/features/ResourceBudget.tsx` | 任务本身跑在 :9881（sovits/batch/training/rvc/svc/uvr5/asr）时隐藏「关闭 GPT-SoVITS 服务」；未加载时说明 3GB 是首次加载门槛、不是当前占用 |
| `app/src/components/features/SovitsWeightPicker.tsx`（新） | 批量页权重选择：零样本 / 微调两侧独立可选；GPT/SoVITS 都有「预训练底模（自动）」；模型库权重带「模型库」徽标；按 basename 判断「已加载」；只选一侧可加载 |
| `app/src/pages/BatchPage.tsx` | 嵌入权重选择器；`buildPayload` 下发 `version/gpt/sovits`；参考音色下方提示「音色库 1 条 / 权重在下方选」；单条结果存原始 `/files/...`、渲染时解析一次，修复下载按钮二次拼接 404；参考音色旁新增「导入参考音频」（上传 / 拖拽 / 本机路径 + 名称 / 逐字转写 / 语种 / 智能转写），保存后写共享 voicelib 并自动选中 |
| `app/src/lib/sovits.ts` | `resolveAudioUrl` 对已带 `/api/` 的地址幂等，兼容旧持久化结果（下载/播放不再拼成 `/api/sovits/api/sovits/...`）；`catalog()` 把后端 `languages` 的 `code` 归一成前端契约的 `id`（否则 Select 的 value 全是 undefined → 全选/选不中） |
| `trainer/app/sovits/catalog.py` | `LANGUAGE_PRESETS` 补 `id`（与前端 `SovitsCatalogEntry` 契约一致；保留 `code` 兼容） |
| `app/src/pages/SynthesisPage.tsx` | 通用合成固定 MiMo（`isSovits=false`），不再受设置里遗留的 `providerId` 影响；旧本地分支保留但不可达 |
| `app/src/pages/SettingsPage.tsx` | 删除 PROVIDERS 后端选择网格、自托管预设与条件字段；云端区块只留 MiMo API Key + 可选接口地址；GPT-SoVITS 服务卡补「语音转文本 / 人声分离也走这条链路」 |
| `app/src/pages/VoiceDesignPage.tsx` / `VoiceClonePage.tsx` | `providerId` 固定 `mimo`（两页本就是 MiMo 专属） |
| `app/src/App.tsx` / `components/layout/AppShell.tsx` | 批量合成页描述与导航 hint 改为「本地 GPT-SoVITS · 零样本/微调权重（含 .pth）」 |
| `server/src/services/modelRegistry.ts` | `gpt-sovits` 主权重改为 `.ckpt` 或 `.pth`；同目录只有一个 `.ckpt` 时 `.pth` 全算配套，没有 `.ckpt` 时每个 `.pth` 各成一个模型 |
| `trainer/app/sovits/weight_meta.py`（新） | 按官方判据读文件头（00~06）识别 SoVITS 版本；`PK` 旧权重按体积回退 v1/v2/v3 |
| `trainer/app/discovery.py` | `WeightEntry` 增 `origin`（install / library），`to_dict` 透出 |
| `trainer/app/api.py` | `/v1/weights` 合并 `models/gpt-sovits/**` 的 `.pth`（文件头识别版本）与 `.ckpt`（同目录 `.pth` 推断）；返回 `origin=library` |
| `trainer/app/sovits/worker/server.py` | `_pair`：只给 SoVITS 时显式配同版本预训练 GPT、只给 GPT 时配预训练 SoVITS；SoVITS 版本与所选版本不符 → 400 `WEIGHT_VERSION_MISMATCH`；两侧都显式时原样使用 |
| `trainer/app/sovits/pipeline.py` | `current_pair` 与 worker 同口径（单侧显式时另一侧落预训练底模），避免状态栏显示「会配最新训练产物」 |
| `app/src/types/sovits.ts` | `SovitsWeight` 增可选 `origin` |

### 测试结果

| 测试项 | 结果 |
| --- | --- |
| `npm run typecheck` / `npm run build` | 全绿 |
| `npx eslint`（本次改动文件） | 无报错（仓库既有 13 条历史 lint 不在本次范围） |
| 整合包 py3.9 `py_compile`（api/discovery/pipeline/worker/weight_meta） | 全绿 |
| `.tmp/verify_sovits_pair.py`（新，离线） | **8/8**：版本识别、只给 SoVITS 配预训练 GPT、版本不符拒绝、两侧显式原样、只给 GPT 配预训练 SoVITS |
| 模型注册表（运行中网关） | `GET /api/models?category=gpt-sovits` → **16 个模型**，纯 .pth 全部可见，成对模型正确收 companion |
| `/v1/weights?version=v2ProPlus`（运行中 trainer） | **gpt 2 + sovits 16**（含 `origin: library`），`pretrained.available=true` |
| 浏览器真机走查（localhost:5173） | 批量页显示「模型已常驻显存，可以直接跑」、**无**「关闭 GPT-SoVITS 服务」；微调页签下拉列出 16 个模型库权重（含 Mujica/MyGO）；设置页云端区块只剩 MiMo Key |
| `/v1/tts/batch/plan`（.pth-only payload） | **200**，条目展开 1 条 |
| 下载 URL | `/api/sovits/files/...` **200**；旧双前缀 `/api/sovits/api/sovits/files/...` **404**（已修） |
| 批量页就地导入参考音频 | 浏览器实测：本机路径导入创建成功并自动选中（临时音色 `5fea0cdafac2` 已删除，库内保留 3 条）；取消/保存关闭正常（Dialog `key` 强制卸载，绕开 Radix exit 动画偶发卡住） |
| 音色库语种下拉 | 浏览器实测：修复前所有选项 `value=undefined` → 全部打勾；修复后仅当前项 `data-state=checked`，点击「日本語」后触发器正确变为日本語 |
| **真实 1 条批量合成**（`Mujica_Mortis_v2pp.pth` + 参考音色「男」） | **1/1 成功**，2.58s 音频、18.2s（含权重切换）；`active = s1v3.ckpt + Mujica_Mortis_v2pp.pth` |

### 披露与遗留

- **真实测试已切换当前常驻权重**：显存里现在是 `s1v3.ckpt + Mujica_Mortis_v2pp.pth`
  （free 约 764MB）。要用回预训练底模，到批量页权重选择器选「预训练底模（自动）」→ 加载到显存；
  或在显存监控里卸载。
- **`s1v3.ckpt` 命名澄清**：它是 GPT（s1）底模的版本号，官方 `v2Pro` / `v2ProPlus` 的
  `t2s_weights_path` 都指向它，**不是 v3 SoVITS**；v2ProPlus 的官方 SoVITS 是
  `s2Gv2ProPlus.pth`（当前已被用户选中的 `Mujica_Mortis_v2pp.pth` 替换）。
  权重选择器已显示「官方底模：X（GPT）+ Y（SoVITS）」并写了这条说明。
- **参考音频语种与文本语种要核对**：仁菜参考实际是日语，音色库曾误存为 `zh`；配中文文本时
  模型提前 EOS，只出 0.74s。已把该音色的 `prompt_lang` 修正为 `ja`，并在批量页新增跨语种
  琥珀色警告（参考语种 ≠ 文本语种时提示可能截断）。同权重换「男」（zh，中性参考）后
  中文 3.78s / 日文 4.22s 正常；长/表达性强的动漫台词本身也会让 GPT 提示过强，建议 3~5s 中性参考。
- **参考音频仍然必需**：纯 .pth 解决的是「音色模型」，不是「参考音频」；批量页的参考音色来自
  `voicelib/`，当前只有 1 条「男 5.4s」。要换参考音频需到「音色库管理」导入（建议同角色 3~10 秒）。
- **零样本语义按现状保留**：不指定权重时服务端仍按「最新训练产物 → 预训练底模」选，
  下拉标签已改为「零样本（不指定权重）」并在说明里写清，不再承诺「一定走官方底模」。
- **单侧权重是显式行为**：只选 SoVITS 时 GPT 一定用同版本预训练底模（不会悄悄配另一个音色的
  `.ckpt`）；版本不符直接 400，不会自动切版本。
- **旧代码未清**：`SynthesisPage` 的本地分支与 `SovitsVoicePicker.tsx` 已不可达/未引用，
  本轮为降低回归风险保留；下一轮可做纯删除清理。
- `settings.providerId` 字段仍在类型/存储里（历史数据兼容），但已没有 UI 入口，也不再影响
  MiMo 三页与批量页。

- 本次文档更新时间：10.28

## 阶段 46 — Irodori 语气提示 + IndexTTS 分段情感编排 [计划时间：10.28 BY Qoder][完成时间：10.28 BY Qoder]

- 分支：feature/vc-svc
- 背景：用户想「在目标文本里插入语气/大笑/叹气」。盘点后确认只有 MiMo（云端，句内音频标签）和
  Irodori（本地日语，emoji 风格标记）真正支持；用户要求：① 在 Irodori 合成页把能力提示写出来；
  ② 给 IndexTTS 做一层「文本分段 + 分段情感」编排，让本地中文/英文也能按段控制情绪。

### 已完成明细

| 模块 | 改动内容 |
| --- | --- |
| `app/src/pages/IrodoriTtsPage.tsx` | 文本区下方新增可见中文提示（🤭 偷笑 / 😮‍💨 叹气 / 😆 / 😭 / 🥱；句中/句尾都生效、修饰前一句、不改音色）；emoji 按钮从「追加到末尾」改为**插入光标位置**；emoji 面板再补一条操作提示 |
| `indextts/app/api.py` | 新增 `MAX_SEGMENTS=20` / `DEFAULT_GAP_MS=120`；`/v1/catalog` 增 `segment_synthesis`（上限/停顿范围）；新增 `POST /v1/synth/segments`（每段独立 8 维向量 + 强度，共享参考音频/语言/时长系数）；`_parse_segments()` 校验空段/坏向量/超限；`_concat_wavs()` 用 soundfile 拼接、段间静音 + 每段 5ms 淡入淡出防爆音 |
| `app/src/lib/indextts.ts` | 新增 `IndexttsSegmentPayload` / `IndexttsSegmentsPayload` 与 `synthesizeSegments()`（multipart：segments JSON + ref 文件/路径 + gap_ms） |
| `app/src/types/indextts.ts` | `IndexttsCatalog.segment_synthesis`；`IndexttsSegmentResult` / `IndexttsSegmentsResult` |
| `app/src/pages/IndexttsTtsPage.tsx` | 「单段合成 / 分段情感（按段拼接）」页签；分段编辑器（每段文本 + 跟随参考/8 个情感预设 + 强度滑杆、增删段、段间停顿 0~1000ms）；`handleSynthesizeSegments`；抽出 `resolveRefUpload` 供单段/分段共用；提交按钮按模式切换 |
| `app/src/lib/resources.ts` + `app/src/lib/vc.ts` + `app/src/components/features/ResourceBudget.tsx` | 资源卡增 `vc_loaded`/`svc_loaded`（读 `/v1/vc|svc/pipeline.loaded`，不再只看 `active` 锁）；RVC/SVC 未加载时的文案改为「本地推理服务已启动，但 RVC/DDSP-SVC 模型尚未加载」；「只跑这一个模型」「释放常驻显存」在目标模型未加载时额外调用 trainer `/v1/engines/unload`，卸掉同属 :9881 的 GPT-SoVITS 等引擎（网关 arbiter 只能按服务粒度让位） |
| `.tmp/verify_indextts_segments.py`（新，未跟踪） | 离线验证：解析两段、空段/坏向量/非数组/超限拒绝、两段 1s + 100ms gap 拼接为 2.1s、产物存在 |

### 测试结果

| 测试项 | 结果 |
| --- | --- |
| `npm run typecheck` / `npm run build` | 全绿 |
| `npx eslint`（本次改动文件） | 无报错 |
| IndexTTS venv `py_compile` | 全绿 |
| `.tmp/verify_indextts_segments.py` | **10/10**（解析/拒绝/拼接/时长/产物） |
| 浏览器走查 | Irodori 页中文提示已显示；IndexTTS 页「分段情感」页签、分段编辑器、`添加一段`（2/20）正常 |
| RVC 资源卡 | 浏览器实测：文案已变为「RVC 变声模型尚未加载」（不再误写 GPT-SoVITS）；RVC 当前 `loaded=false`、free 0.6GB / 需要 2.5GB，警告正确。未点击「只跑这一个模型」以免卸载用户当前常驻的 GPT-SoVITS；代码路径已改为目标未加载时先 `/v1/engines/unload` |
| IndexTTS 真机分段合成 | **未跑**：IndexTTS 准入门槛约 5.5GB，当前 free 约 0.9GB（GPT-SoVITS 常驻）；需腾显存并重启 IndexTTS 服务加载新端点 |

### 披露与遗留

- 分段模式每段只提供**预设情感**（跟随参考 / 喜 / 怒 / 哀 / 惧 / 厌恶 / 低落 / 惊喜 / 平静）+
  强度，对应 one-hot 8 维向量；需要精细 8 维向量仍用「单段合成」。
- **情感参考音频不分段**：`emo_file` 仍只在单段模式可用；分段模式只支持向量/强度。
- 参考音频、语言、时长系数是全局的；段间停顿默认 120ms，范围 0~1000ms；每段首尾 5ms 淡入淡出。
- 分段上限 20；服务端拼接要求各段采样率一致（同一引擎/参考下应一致，不一致会 400
  `SAMPLE_RATE_MISMATCH`）。
- **需要重启 IndexTTS 服务**才会加载 `/v1/synth/segments`；前端已按新契约实现，服务未重启时
  分段提交会 404/旧接口行为。
- Irodori 的 emoji 面板依赖服务 `/v1/catalog`；服务未启动时只显示文本区下的中文提示，面板不出现。
- 真机端到端（GPU 分段合成、听感、拼接处是否自然）待显存窗口补测。
- **RVC/SVC 同进程让位**：网关 arbiter 只能按「服务」让位，RVC/SVC/ASR/UVR5 与 GPT-SoVITS
  同属 :9881；资源卡现在在目标模型未加载时先调 trainer `/v1/engines/unload` 清同进程引擎，
  再 focus。若目标模型已加载则跳过卸载（避免把用户要用的模型卸掉）。

- 本次文档更新时间：10.28

## 阶段 46补1 — 设置页「包含能力」控制卡 [计划时间：10.28 BY Qoder][完成时间：10.28 BY Qoder]

- 分支：feature/vc-svc
- 背景：用户质疑「为什么不全拆进程、分别控制」。评估后结论：全拆的代价（多套 venv/端口/CUDA context/跨进程仲裁）
  大于收益；先做**模型级能力控制**，保留 :9881 单进程。
- 已完成：
  - `SettingsPage` 的 GPT-SoVITS 卡新增「包含能力（共用 :9881 进程）」：GPT-SoVITS 合成/训练、
    RVC、DDSP-SVC、ASR、UVR5 五行，显示 `已加载 / 未加载 / 按需`，每行可单独卸载；
    顶部有「刷新」「全部卸载」。GPT-SoVITS 状态读 `health.pipeline.loaded`，RVC/SVC/ASR 读各自
    `/v1/vc|svc|asr/pipeline.loaded`；UVR5 标注「按需」。
  - `svcApi.unloadModel`（`/v1/svc/models/unload`）；RVC/ASR 复用已有卸载客户端；
    「全部卸载」调 trainer `/v1/engines/unload`。
  - 设置页「本地服务」描述改为五个运行时，并注明 :9881 托管 RVC/DDSP/ASR/UVR5。
- 测试：浏览器实测设置页卡片正确显示 GPT-SoVITS `已加载`、RVC/DDSP/ASR `未加载`、UVR5 `按需`；
  typecheck/build/eslint 全绿。未点击卸载，避免改变用户当前常驻的 GPT-SoVITS 模型。
- 披露：这是**模型级**控制，不是进程级；卸载只释放模型/显存，服务进程仍在。加载仍在各功能页
  选择模型/权重；「全部卸载」会卸掉 :9881 内所有引擎，但不会停止服务进程。真正进程隔离
  （独立 venv/端口/健康检查/跨进程仲裁）仍是单独阶段，未做。
- 本次文档更新时间：10.28

## 阶段 47 — UVR5 → PyMSS 迁移 P0/P1/P2/P3 [计划时间：10.28 BY Qoder][完成时间：10.28 BY Qoder]

> **后续：2026-10-28 用户耳听否决（4_HP-Vocal 杂声多；8GB 显存 UVR5 更优），生产代码已回滚为纯 UVR5；
> 本节保留 P0/P1/P2/P3 实验记录与 A/B 数据，不再作为生产路径。**

- 分支：feature/vc-svc
- 依据：`docs/PYMSS-MIGRATION-PLAN.md`。目标是把 `/v1/uvr/*`、DDSP-SVC 翻唱向导、训练 `_step_uvr`
  的分离统一切到独立 py3.12 PyMSS bridge；保留旧契约与 UVR5 回退，P0 未确认前不删 UVR5。

### 已完成明细

| 模块 | 改动内容 |
| --- | --- |
| `pymss/`（新，runtime 不入库） | py3.12.10 venv；pymss 2.0.14 / pymss-core 0.1.4 / **torch 2.11.0+cu128**；`bridge.py`（JSON-lines 子进程协议）、`check.py`、`train_cli.py`、`README.md`、`weights.manifest.json`（9 个模型 + SHA256/大小；license 待核对）、`AB-REPORT.md` |
| `pymss/bridge.py` | source/model/model_dir/outputs/format/agg/device/params；progress/result/error JSON lines；stderr 只放日志；DeEcho 的 `No Reverb`/`No Echo` stem 大小写不敏感发现 |
| `trainer/app/audio/pymss.py`（新） | `PymssEngine`：catalog（映射/可用性/backend/models_ready/**PyMSS 专用 vram_mb**：HP2 3400 / vocal_main 3500 / hifi 2100 / dereverb 3000）、分离、ArtifactCache（key 含 backend/model/pymss_version）、二级净化（DeEcho stem 映射）、子进程取消/进程树清理、错误码（NOT_READY/MODEL_MISSING/INFER_FAILED） |
| `trainer/app/config.py` | `uvr_backend`（默认 uvr5）、`pymss_dir/model_dir/python/device` 及 env 覆盖 |
| `trainer/app/api.py` | 按 `UVR_BACKEND` 选择 `PymssEngine` / `Uvr5Engine`；`ctx.uvr5` 变量名保持，调用点不变 |
| `trainer/app/routers/uvr.py` | PyMSS 后端不再依赖 GPT-SoVITS 安装目录；runner 传 `cancel_event` |
| `trainer/app/training.py` | `_step_uvr` 在 pymss 后端走 `pymss/train_cli.py`；旧 UVR5 模型 ID 经 `PYMSS_TRAIN_ALIASES` 映射；无映射的 `onnx_dereverb_By_FoxJoy` 明确报错不静默换 |
| `trainer/app/engine.py` | 修 `unload_all()`：除 active 外还要跑所有已注册 unloader（GPT-SoVITS 管线可能已加载但 active 为空） |
| `scripts/pymss-check.mjs` + `package.json` | `npm run pymss:check`：检查 py3.12/pymss/CUDA/模型清单 |
| `.gitignore` | 忽略 `pymss/.venv/`、`pymss/models/`、`pymss/.uv-cache/` |

### 测试结果

| 测试项 | 结果 |
| --- | --- |
| `npm run pymss:check` | **READY**（Python 3.12.10 / pymss 2.0.14 / torch 2.11.0+cu128 CUDA True / 9 模型齐全） |
| `.tmp/verify_pymss_engine.py`（CPU 真跑 HP2） | catalog `backend=pymss/models_ready=True`；分离 35.6s；vocal/instrumental 均存在 |
| `.tmp/verify_pymss_secondary.py` | 缓存首跑计算、二跑 **0.007s 命中**；HP2 + DeReverb：47.9s，净化 stem `ref_Vocals_No Reverb.wav` |
| `.tmp/verify_pymss_http.py`（TestClient，CPU） | `/v1/uvr/catalog` 200 backend=pymss；`/v1/uvr/separate wait=true` 200，urls voval+instrumental；契约不变 |
| PyMSS 训练 CLI（CPU） | HP2 25.5s，`ref_Vocals.wav` / `ref_Instrumental.wav` 落盘 |
| PyMSS 取消 | 1s 后 set cancel_event → `CANCELLED`；检查无 `pymss/bridge.py` 残留进程 |
| UVR5 旧路径基线 | A/B CLI：HP2 12.7s/+1041MB、HP5 10.7s/+1197MB（正常）；运行中 trainer 的 HTTP 回归返回 429（旧服务未重启，非本次代码回归），未继续 |
| py_compile / typecheck / build | 全绿 |
| **P0 A/B（GPU，25s ASMR）** | HP2：UVR5 12.7s/+1041MB vs PyMSS 48.5s/+3210MB；HP5：UVR5 10.7s/+1197MB vs 3HP 66.9s/+3274MB；BS：UVR5 CLI 失败（缺 yaml）vs PyMSS 9.2s/+1876MB；DeReverb：UVR5 10.9s/+1019MB vs PyMSS 57.5s/+2833MB。试听页 `.tmp/pymss_ab/index.html` |

### 披露与遗留

- **默认后端仍是 `uvr5`**：A/B 显示 PyMSS 的 VR 档位在这台 8GB 卡上明显更慢、更吃显存
  （HP2 慢约 3.8x、峰值 +3.2GB；UVR5 fp16 仅 +1.0GB）。P6 默认切换**未做**；
  PyMSS 作为 `UVR_BACKEND=pymss` opt-in。`use_amp=True+batch_size=1` 实测 HP2 39.2s/+3313MB，
  未解决 VR 路径的 fp32/显存问题。
- **`vocal_main` 未冻结**：3/4/5/6 都能跑，但 A/B 素材是单主唱 ASMR（无和声），不足以判断
  「仅保留主唱」；暂用 `3_HP-Vocal-UVR.pth` 作为候选默认，等带和声歌曲耳听后再写死。
- **BS-RoFormer**：PyMSS 更快更省（9.2s/+1.9GB）；UVR5 基线 CLI 因整合包缺同名 `.yaml` 失败，
  但项目内的 `Uvr5Engine` 用内置默认配置可跑，需补一次 API 路径的 BS 基线同口径对比。
- **许可**：9 个模型的 `license` 仍为「待核对」；P6 前逐个核对上游模型卡，不明确不用于分发。
- **P4 前端文案/ResourceBudget 未改**：默认仍是 UVR5，改文案会误导；等 P6 切换时一起做。
- **P5 全量回归未做完**：`UVR_BACKEND=uvr5` HTTP 旧路径、翻唱端到端、训练 UVR5、取消/无残留进程
  仍需在默认切换前跑一遍；本次已做 PyMSS 侧 CPU/HTTP/训练 CLI、取消测试与 A/B；UVR5 旧路径
  仅完成 CLI A/B 基线（HTTP 因运行中旧 trainer 返回 429 未跑）。
- **GPU 操作**：A/B 前临时卸载了 GPT-SoVITS `ykn神人版`，测完已按原路径恢复（当前 loaded=True）；
  未重启/关闭 trainer 服务；IndexTTS/GPT-SoVITS 等其它状态未动。
- 新增 runtime 与模型都在 gitignore；`pymss/.venv`/`pymss/models` 体积不计入仓库。

- 本次文档更新时间：10.28

## 阶段 47补1 — 用户否决 PyMSS，生产恢复 UVR5 [完成时间：10.28 BY Qoder]

- 决策：用户实际听感确认 **PyMSS 4_HP-Vocal 杂声多**，且 8GB 显存下 UVR5 的延迟/占用更优；
  **放弃 PyMSS 迁移**，生产恢复纯 UVR5。
- 已完成回滚：
  - `config.py` 移除 `uvr_backend` / `pymss_*` 设置；`api.py` 恢复 `Uvr5Engine`；
    `training.py` 移除 PyMSS 分支/别名；`routers/uvr.py` 恢复 UVR5 `_home` 与无 `cancel_event`；
    `audio/uvr5.py` 恢复原签名。
  - `trainer/app/audio/pymss.py` 与 `scripts/pymss-check.mjs` 归档到 `.tmp/rejected_pymss/`；
    `package.json` 移除 `pymss:check`；生产代码已无 `pymss` 引用。
  - `pymss/`（runtime/models/bridge/check/train_cli/AB 报告）保留为**未接入的实验记录**；
    README 与 AB 报告已标注否决；`.gitignore` 的 pymss 条目保留。
  - 保留 `trainer/app/engine.py::unload_all()` 的真 bug 修复（遍历所有 unloader），
    与 PyMSS 无关，能修复「已加载但 active 为空」卸不掉的问题。
- 验证：`grep` 生产代码无 `pymss/uvr_backend` 引用；py_compile / typecheck 全绿；
  运行中的 trainer 一直走 UVR5，`ykn神人版` 已恢复 loaded=True；未重启服务。
- 遗留：`pymss/.venv` + `pymss/models` 仍占磁盘（模型约 2.2GB），用户确认后可走回收站清理；
  A/B 证据在 `pymss/AB-REPORT.md` 与 `.tmp/pymss_ab/index.html`；UVR5 权重/代码未删除。

- 本次文档更新时间：10.28

## 阶段 47补2 — gsv5 v5 加载修复（cwd / TTS_Config / sv 权重）[完成时间：10.28 BY Qoder]

- 现象：批量页选 v5turbo 合成报 `合成失败 加载 v5 变体 v5turbo 失败：No module named 'ERes2NetV2'`。
- 根因（三处叠加）：
  1. `scripts/gsv5.mjs` 以 `gsv5/` 为 cwd 起服务，而上游 `TTS_infer_pack/TTS.py`（`now_dir = os.getcwd()`）
     与 `sv.py`（`os.getcwd()/GPT_SoVITS/eres2net`）都按 cwd 拼相对路径；cwd 不对时 eres2net 不在
     `sys.path`，`from ERes2NetV2 import ERes2NetV2` 直接失败，SV 权重路径同样失效。
  2. 上游 `TTS_Config.__init__` 只接受 dict/str；引擎仍用旧 kwargs（`device=`/`version="custom"`），
     即使 import 通过也会 `TypeError`；version 必须是具体变体名，且需放在 `custom` 键下。
  3. `gsv5/upstream/GPT_SoVITS/pretrained_models/sv/pretrained_eres2netv2w24s4ep4.ckpt` 缺失
     （上游 `.gitignore` 忽略 `pretrained_models/*`，gsv5 只链了 hubert/roberta）。
- 修复：
  - `gsv5/app/gsv5_engine.py`：`ensure_upstream_on_path()` 增加 `os.chdir(upstream)`，并把
    `upstream` / `upstream/GPT_SoVITS` / `upstream/GPT_SoVITS/eres2net` 都注入 `sys.path`；
    `TTS_Config` 改为 `{"custom": {device,is_half,version=variant,...}}`。
  - `gsv5/upstream/GPT_SoVITS/pretrained_models/sv/`：从本机 v2pro 安装包补齐 SV 权重（107MB）。
- 验证：gsv5 venv CPU 预加载 v5turbo 26.1s（s1v3/vocoder/s2Gv5turbo/BERT/HuBERT 全命中）；
  CPU 合成短句输出 48kHz / 2.36s 音频（13.1s）；`py_compile` 通过。未启动 GPU 服务、未占显存。
- 遗留：GPU 真机 v5 合成待验（当前空闲 3235MB < v5turbo 门槛 3584MB，需先卸常驻模型或等窗口）。

- 本次文档更新时间：10.28

## 阶段 47补3 — 全项目细长音频播放条 [完成时间：10.28 BY Qoder]

- 问题：批量页结果行的原生 `<audio controls>` 被 `max-w-[220px]` 压成短胶囊，长音频难以拖动；
  全项目还有 15 处原生播放器样式/宽度不一。
- 新增 `app/src/components/features/SlimAudioPlayer.tsx`：单行细长播放条（播放/暂停、全宽细进度条、
  当前/总时长、静音+音量、下载）；支持拖动、键盘 ←/→（±5s）/Home/End、全局单曲仲裁、
  autoPlay、compact（隐藏音量滑杆）、外部 `audioRef`、时长回调。
- 替换范围：BatchPage、ABPlayer、Gsv5Page、IrodoriTtsPage、IndexttsTtsPage、NeteaseAsrPage、
  NeteaseTtsPage、OutputsPage、RunResultCard、SamplePicker、VoiceLongReference、
  SingingConversionPage、TrainingPage、VoiceConversionPage、VoiceLibraryPage；
  批量页结果行改为「信息一行 + 播放条整行」，进度条 707px（原 220px）。
- 配套后端：`server/src/routes/voicelib.ts` 两处试听路由从 `createReadStream` 改 `sendFile`，
  补 `Content-Length` / `Accept-Ranges`，否则浏览器拿不到时长也无法 seek。
- 验证：typecheck（app/server）、app build、eslint 全过；浏览器实测音色库 467px 播放条与
  批量结果 939px 紧凑行（高 38px），muted 播放、60%/80% 拖动定位、ArrowLeft 回退、暂停状态切换正常。
- 保留：结果面板的波形/增益播放器（`AudioPlayer`）未改，它本来就是全宽可拖动且带 0.5~4x 增益。

- 本次文档更新时间：10.28

## 阶段 47补4 — 薄 CLI `say`（单条 + 批量）[完成时间：10.29 BY Qoder]

- 目标：让 Agent / 终端不依赖页面即可跑合成；复用现有网关与 trainer，不新增后端逻辑。
- 新增：
  - `scripts/say.mjs`：单条 + 批量组合式 CLI（`batch` 子命令）。
  - `package.json`：`npm run say` / `npm run say:batch`。
  - `docs/CLI.md`：参数、JSON 输出、退出码、示例；README「命令行合成」与 HANDOFF 命令表补条目。
- 单条：`--model` + `--voice|--ref-path` + `--text|--text-file` → Open API
  `/api/open/v1/audio/speech`（`format:json`），写 WAV 后输出 JSON 摘要；支持 `--params`、
  `--focus`、GPT-SoVITS 权重快捷参数、超时；MiMo 多段写出 `*.partN.wav`。
- 批量：`--text|--file|--text-file|--items` → `/api/sovits/v1/tts/batch`；默认异步提交 +
  `/v1/jobs/:id` 轮询（进度走 stderr），终态后下载结果到 `--out-dir`（默认 `say-out/<job_id>`），
  `--zip` 额外下载 ZIP；`--plan` 只展开；`--sync` 同步；`--stop-on-error` / `--no-zip` /
  `--no-download` / `--allow-failures` / `--poll-ms` / `--timeout` 均已支持。
- 输出契约：stdout 永远单段 JSON（成功摘要或 `{ok:false,error}`）；退出码 0 成功、1 失败或存在
  未豁免的失败条目；错误码/提示透传网关与上游。
- 验证：`node --check`、`--help`、npm scripts；`/api/capabilities` 因服务未启动未真连；用
  `.tmp/say-cli-mock.mjs` 模拟网关验证单条落盘、plan、异步轮询（running→succeeded）、
  2 条音频 + ZIP 下载、同步模式、上游 400 透传、网关不可达提示，全部通过。
- 遗留：真实网关 + 模型服务的单条/批量合成待服务重启后复验（本次服务均已关闭，未擅自拉起）。

- 本次文档更新时间：10.29

## 阶段 47补5 — 面向外部 Agent 的统一使用指南 [完成时间：10.29 BY Qoder]

- 问题：能力/启动/显存/红线信息散在 `AGENTS.md`、`HANDOFF.md`、`docs/OPEN-API.md`、`docs/CLI.md`，
  外部 Agent 借用工具时缺少单一入口。
- 新增 `docs/AGENT-GUIDE.md`（12 节）：60 秒上手；这是什么/不是什么；架构与端口（8787/9881~9885）；
  启动/停止/体检（含自动拉起差异）；能力发现（13 项 id/别名/参数/可用性语义）；单条 Open API
  （TTS/ASR/VC/SVC/分离 + 参考音频与引擎参数）；批量与长任务（batch/plan/jobs/artifacts URL）；
  CLI 速查；资源与并发；共享红线；错误码排障表；文档地图与最小验收集；维护约定。
- 入口挂载：`AGENTS.md` 顶部（只借用能力的 Agent 先读）、`HANDOFF.md` 项目信息、README「命令行合成」、
  `docs/OPEN-API.md` 顶部、`docs/USER-GUIDE.md` 顶部（人用手册指向 Agent 指南）。
- 核对修正：netease 卸载路径为 `/api/netease/v1/confucius|r2t2/unload`；GPT-SoVITS 仅在设置页
  启用时由 `/api/sovits/*` 代理自动拉起，`/api/open/*` 永不拉起；`focus` 仅单条 TTS。
- 验证：文档内容逐项对照 `capabilityCatalog.ts`、`routes/open.ts`、`routes/voicelib.ts`、
  `serviceCatalog.ts`、`sovits.ts` 与 `scripts/say.mjs`；本次未改代码，无构建/回归影响。

- 本次文档更新时间：10.29

## 阶段 47补6 — 产出记录页音频预览 + trainer Range 支持 [完成时间：10.30 BY Qoder]

- 问题：产出记录页对批量任务只显示 `workdir` / ZIP / 清单，`artifacts.results[]` 里的音频没有展开；
  非音频 URL 还会被当成播放器；trainer `/files` 不支持 Range，长音频无法拖动。
- 前端：
  - `app/src/lib/jobArtifacts.ts`：批量任务展开 `results[]` 为逐条音频轨道（标签含序号/文件名/
    时长/文本摘要）；新增 `kind: audio|file` 与字节数；ZIP/清单/实验目录/权重等非音频产物不再进播放器；
    只有本机路径的音频产物可从 `trainer/.data/outputs/<rel>` 推导 `/files/<rel>` 地址。
  - `app/src/hooks/useOutputRecords.ts` / `types/outputs.ts`：传递 `kind`/`bytes`。
  - `app/src/pages/OutputsPage.tsx`：音频出 `SlimAudioPlayer`，普通文件出「下载 / 打开」链接，
    路径仍可点击复制。
- 后端：
  - 新增 `trainer/app/file_serve.py`：单区间 Range（206/416、`Accept-Ranges`、
    `Content-Range`、HEAD、分块流式），路径安全由调用方限定。
  - `trainer/app/api.py`：`/files` 从 `StaticFiles` 改为 Range 路由；`/v1/voices/:id/audio`
    与 `/v1/annotations/audio` 也改用 Range 响应；移除旧 `_guess_audio_type`。
- 验证：
  - 真实 job 夹具：批量任务 2 条结果 → 2 个 audio 轨道（`/api/sovits/files/...`），ZIP/清单为
    file 轨道，路径型输出可推导 URL；合成/变声 fixture 解析正确。
  - 浏览器（真实网关 + 真实历史 job）：产出记录页批量记录出现「第 1 条 · 000-.wav · 4.7s · 文本」+
    细长播放器；ZIP/清单显示「下载 / 打开」，无播放器；页面共 81 个历史音频播放器。
  - TestClient：`/files` Range → 206（0-99 / 100- / -50），越界 → 416，HEAD → 206，
    路径穿越 → 404；`/v1/voices/:id/audio` Range → 206；py_compile/typecheck/eslint 通过。
- 注意：当前运行中的 :9881 仍是旧进程；**重启 GPT-SoVITS 服务后 Range 生效**（拖动进度条需要）。
  本次未重启/停止用户服务。

- 本次文档更新时间：10.30

## 阶段 49 — 遗留项真机验证窗口 + 中文轻语基准归档 [计划时间：11.09 BY Qoder][完成时间：11.09 BY Qoder]

- 分支：feature/vc-svc
- 背景：PROGRESS 的「下一阶段入口」前四条（R2T2 GPU 数据点、netease `warmup_real`、IndexTTS 5500 门槛
  + 分段情感、gsv5 v5 真机）全是**等显存窗口**的项，此前一直卡着；另有一条「报告方 8 段耳语 CER 基准」
  其实 10.25 就跑了（`.tmp/asr_bench_zh/report.md`），只是没进文档。本轮 free 6.2~6.8 GB、
  七个端口全空（`llama-server` 未运行），把五件事一次做完。**零生产代码改动** —— 只动 `.tmp` 回归资产与文档。

### 已完成明细

| 模块 | 改动内容 |
| --- | --- |
| `docs/ASR.md` §8.5（新） | 归档中文轻语 8 段基准（SenseVoice / Paraformer / R2T2）+ 日语侧 8 段与整章结论（引用 `docs/JA-ASR-STREAMING-HANDOFF.md`）+ 两条输出瑕疵（SenseVoice `😔` 情绪标记、Paraformer `status.device=null`） |
| `.tmp/verify_open_gateway.mts` | 能力数 13→**14**、tts 6→**7**（阶段 48 新增 `cosyvoice3-tts` 后锁未同步）；改成 `EXPECTED_TOTAL` / `EXPECTED_TTS` 常量集中放置 |
| `.tmp/verify_sovits_pair.py` | 夹具从写死子目录改为 `_find_model()` 的 `rglob` 解析（权重已按角色重组到 `models/gpt-sovits/<角色>/`） |
| `.tmp/smoke_r2t2_transcribe.py` | ① 子进程补 `PYTHONIOENCODING=utf-8`（与生产 `netease/app/r2t2.py` 同款，否则第一条中文日志就让父进程 `UnicodeDecodeError`）；② GPU 护栏改成**在进程内等窗口**（最多 180s），阈值 6200 不动 |
| `.tmp/gpu-verify-20261109/`（新，未跟踪） | 本轮四个真机脚本 + 日志：`verify_netease_warmup.py`、`verify_indextts_segments_live.py`、`verify_gsv5_live.py`、各服务日志与 `*_vram.csv` 采样 |

### 测试结果

| 测试项 | 结果 |
| --- | --- |
| `.tmp/smoke_r2t2_transcribe.py`（**R2T2 GPU bf16**） | **PASS**：free 6213 MB → load **60s**（含静音预热 2.8s）→ 8.4s 中文轻语转写 **1.5s（RTF≈0.18）**，文本与参考一致；**峰值净增 ≈6134 MB**（used 1742→7876，采样最低 free **82 MB**） |
| `verify_netease_warmup.py`（**warmup_real**） | **PASS**：冷进程 warmup 端点 84.8s（其中 `warmup_real.done` 6.73s）→ 第 1 条真实合成 **9.64s / 4.97s 音频（RTF 1.94）**、第 2 条 8.94s（2.01）；热进程重载 19.5s（warmup_real 1.64s）→ 首条 6.53s（1.33）、次条 5.59s（1.03）；unload 后 free 回到基线之上 |
| `verify_indextts_segments_live.py`（**5500 门槛 + 分段情感**） | **PASS**：门槛 5500 放行；装载 57.9s、常驻 **+5029 MB**（全链峰值净增 5541MB）；单段情感 2.47s 音频/6.62s（RTF 2.68）；两段（平静 0.8 / 喜 0.8）+ gap 150ms → 逐段和 7.814s + 0.15 = **7.964s**，实际 **7.9635s**（差 0.5ms），22.05kHz，产物落盘 351KB；unload 归还 |
| `verify_gsv5_live.py`（**v5turbo GPU**） | **PASS**：冷进程装载 52.7s、常驻 +2334 MB（全链峰值净增 4039MB）、首条 14.03s（RTF 3.47，进程级 CUDA 首跑）、次条 1.69s（**RTF 0.419**）；热进程重载 5.2s、首条 1.97s（0.487）、次条 0.99s（**0.246**）；48kHz；峰值净占 ≈3400 MB（门槛 3584 留 184MB）；循环 load→unload 水位稳定（4619→4637）＝不是累积泄漏 |
| 中文轻语 8 段 CER（归档复核） | SenseVoice **29.5%**（41/139）/ Paraformer **44.6%**（62/139）/ R2T2 CPU **23.0%**（32/139）；bootstrap 2 万次：Paraformer−SenseVoice 95% CI 5.1~24.8pp、P=99.9%；R2T2 vs SenseVoice CI 跨 0（不显著） |
| 离线回归（委派 teammate，`.tmp/regression-20261109/`） | typecheck / build / `run_artifacts` 20/20 / `asr_gate` 25/25 / `asr_sensevoice` 12+2SKIP / `vc_audio` 10/10 / `voicelib_py_compat` 24/24 / `indextts_segments` 10/10 / `r2t2_offline` 21/21 / `svc_train` 13/13（真 CPU 训练 107s）/ `svc_train_http` 9/9 / `svc_train_job` 8/8 |
| `.tmp/verify_vram_estimate.py`（补跑真实 /health 段） | **9/9**（第 2 节对着运行中的 :9882 核对，此前因服务未起 SKIP） |
| 修正后的两份回归锁复跑 | `.tmp/verify_open_gateway.mts` **30/30**（能力数 13→14 后）；`.tmp/verify_sovits_pair.py` **8/8**（夹具改 `rglob` 后） |
| 环境收尾 | 七个端口全空、无残留 python、GPU 回到 free 6645 MB（桌面基线 1313 MB） |

### 披露与遗留

- **R2T2 的 GPU 峰值比文档口径还略高，6144 门槛不能下调**：文档写「净占 ~5.5GB、GPU 模式约 5.9GB」，
  实测（bf16 / batch=1 / 8.4s 输入）**峰值净增 ≈6134 MB**、采样最低 free **82 MB**、RTF 0.18。
  也就是说 **6200 MB 的冒烟护栏只够刚好放下，几乎没有余量**；`REQUIRED_VRAM_MB = 6144` 是准的，
  **不要**因为「短样例看起来只要 4GB」就下调。GPU 跑 R2T2 前请先关掉占卡的大户。
- **netease 的 fp16 峰值余量极小**：warmup 期间采样最低 free **79 MB**（桌面 used 1.7GB 时模型侧
  峰值约 6.3GB）。5120 的门槛能放进来，但真跑起来几乎没有余量 —— 再叠加浏览器/IDEA 这类大户就会
  溢出共享内存（坑 78）。**预期行为**：先关占卡程序再 warmup。
- **gsv5 的 `/v1/unload` 不归还首次 CUDA 初始化的一次性成本（实测 ~1.5GB）**：unload 后 free 只到
  5021 MB（进程还没首次加载时是 6619）；再调一次 unload 也不动；循环 load→unload 稳定在同一水位
  （不是累积泄漏）。后果：**要换别的引擎得停 gsv5 服务进程，只 unload 会留下 1.5GB 幽灵占用**
  （例：出 gsv5 后 free 5021 < netease fp16 门槛 5120）。已记坑 112。
- **gsv5 的门槛 3584 比实测峰值低约 450MB（待回填，本轮不动常量）**：冷进程全链峰值净增
  **4039 MB**（used 1301→5340，最短一行文本），而 `gsv5/app/config.py::REQUIRED_VRAM_MB`
  仍是阶段 40 估的 3584。这意味着「free 3584~4000 MB」的窗口会被放进来、然后可能撞坑 78 的
  溢出假死。**建议下一轮按坑 79 回填为 4096**，同步 `server/src/services/preload.ts`
  （`vram_mb`）、`app/src/lib/resources.ts`（兜底常量）与 `.tmp/verify_vram_gates.py` V3 三处。
- **gsv5 没有 `warmup_real` 等价物**：进程启动后第一条合成要 **14s**（RTF 3.47），之后稳态 0.246；
  与 netease 修前的 378s 同源（算子首跑），但量级可接受，本轮不改。
- **IndexTTS 的 RTF 2.68 是「桌面在抢卡」口径**：装载后 free 只剩 1375 MB，单段 2.47s 音频耗 6.62s。
  与网易（1.03~1.94）对比时必须同机同状态（坑 26 的老规矩）。
- **SenseVoice 输出带 `😔` 情绪标记**：`rich_transcription_postprocess` 的副产物，worker 没剥。
  转写结果当参考文本/字幕时会混进表情。**是否在 worker 侧过滤（或单开 `emotion` 字段）需要产品决策**，
  本轮只写进 `docs/ASR.md` §7/§8.5，未改代码。
- **CosyVoice3 仍缺权重**：`cosyvoice/models/Fun-CosyVoice3-0.5B/` 不存在，`available=false`；
  恢复下载（约 3.6GB）**必须先征得用户同意**，本轮未动网络。
- **既有 lint 债未清**：`cd app && npx eslint src` 有 **13 个错误**，全部落在本轮未改动的 11 个文件
  （`react-refresh/only-export-components` ×7、`useHistory` 渲染期读 ref、`useRecorder` 无用表达式等）；
  对本次未提交改动的 39 个 app 文件单独 lint 为 0 错。建议单开票处理。
- **阶段 45~49 已入库并推送**（2026-11-09，使用者要求）：`9c9abbf` 实现（92 文件）→ `689a246`
  文档与知识库（14 文件）→ `b42a60a` `.tmp` 回归锁入库（31 份脚本）。`origin/feature/vc-svc`
  已同步到 `b42a60a`；工作区只剩 `.tmp` 的本地数据（bench 音频、venv、日志、证据 JSON）与
  `.zcode/` 未跟踪。此前各阶段写的「本次未提交 git」已失效。

- 本次文档更新时间：11.09

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
| 48 | CosyVoice3 接入（第六个运行时 `cosyvoice/`，:9886；Fun-CosyVoice3-0.5B 推理：零样本/跨语种/instruct2，9 语言 + 18 中文方言；Windows 两补丁；网关能力/预载/仲裁/设置页/侧栏/合成页全链路；只接推理不接训练） | 11.05 | Qoder |
| 49 | 遗留项真机验证窗口：R2T2 GPU 转写 / netease `warmup_real` / IndexTTS 5500+分段情感 / gsv5 v5turbo GPU；中文轻语 8 段 CER 基准归档进 `docs/ASR.md` §8.5；回归资产修正（能力数 13→14、sovits 夹具 rglob、R2T2 冒烟脚本编码与等窗口） | 11.09 | Qoder |

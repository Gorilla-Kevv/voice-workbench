# AGENT_CHANGELOG —— 外部共享目录改动记录（ttstool）

> 本仓库经 `link_ttstool` Junction 被 `Mega-Scale AI Workflow Integration Project` 引用，**可能同时有多个 Agent 在此工作**。
> 规范：任何 Agent 对本仓库的改动或服务操作，必须在本文档追加记录（**倒序，最新在上**），注明时间、Agent、改动内容、原因、验证、回滚方式与对其他 Agent 的影响。
> 相关规范见本仓库 `AGENTS.md`「外部共享约束」节与主中枢 `AGENTS.md` 第二节核心红线「外部共享目录改动记录」。

---

## [2026-10-25 11:41 BY Qoder] 阶段 44补2续：SenseVoice 权重落地 + 独立 venv/worker + GPU 画像

- **文件改动**：
  1. 新增 `trainer/app/asr/sensevoice_client.py`（常驻 worker 客户端：JSON-lines、stderr 日志、超时/退出）与 `trainer/app/asr/sensevoice_worker.py`（fd1 协议隔离、FunASR 1.3.30、本地快照、`use_itn=False`）；
  2. `trainer/app/asr/pipeline.py`（SenseVoice 走 worker、`runtime_ready`/`SENSEVOICE_RUNTIME_MISSING`、worker key 去 language、`_funasr_generate` 传 language、unload 调 worker.shutdown、status 加 runtime 字段）；`trainer/app/asr/bootstrap.py`（`sensevoice_runtime()`、runtime_ready/hint、`resident_support` 改 find_spec 不 import 老 funasr）；`trainer/app/routers/asr.py`（acquire 前检查 runtime）；`trainer/app/asr/catalog.py`（SenseVoice 实测注释）；
  3. `server/src/services/capabilityCatalog.ts` + `server/src/routes/open.ts`（`runtime_ready` 参与 available，响应加字段）；`app/src/types/asr.ts`（runtime 字段）；
  4. `.gitignore`（`trainer/sensevoice-venv/`）；
  5. 新建 **`trainer/sensevoice-venv/`**（py3.12.10 + torch 2.7.1+cu128 + funasr 1.3.30 + modelscope 1.40.2 + transformers 4.57.6 + tokenizers 0.22.2 + huggingface_hub 0.36.2，约 6.1GB，gitignore；用 gsv5 的 uv 缓存安装）；
  6. 下载 **`GPT-SoVITS-v2pro-20250604/tools/asr/models/SenseVoiceSmall/`**（ModelScope `iic/SenseVoiceSmall`，897MB；model.pt + config.yaml + am.mvn + BPE + tokens；整合包目录 gitignore）；
  7. 回归/冒烟：`.tmp/verify_asr_sensevoice.py`（权重就绪 12/12 + 2 SKIP）、`.tmp/smoke_sensevoice_worker.py`、`.tmp/smoke_sensevoice_http.py`、`.tmp/verify_open_gateway.mts`（30/30）；文档 `docs/ASR.md`、`docs/OPEN-API.md`、`PROGRESS.md`、`HANDOFF.md`（坑 100）。
- **原因**：用户选择「方式 B（本地快照）+ 新建独立 SenseVoice venv」并授权 GPU 实测。真机发现整合包 FunASR **1.0.27** 只注册旧 `SenseVoice`（Whisper 架构），不支持当前 `SenseVoiceSmall`；`trust_remote_code` 在 1.0.27 无效。为避免升级整合包影响 GPT-SoVITS，新建独立 venv + 常驻 worker。
- **验证**：GPU（RTX 4060 Laptop，free 6313MB 窗口）worker 加载后常驻增量 **+1050MB**、峰值 **+1099MB**、最低 free 5214MB；首载 23.5s，热态 zh/en 0.27~0.29s（ja 首条 warmup 约 6s）；真实 ja/zh/en 样例正确；CPU 加载 6.4s、RTF 0.17~0.26。HTTP `/v1/asr/models/load`→`transcribe`(ja)→`unload` 全 200；ASR 门槛 25/25、能力网关 30/30、typecheck/build 全绿。**llama-server 按用户选择测完未自动重启**；GPU 已释放回 free ~6001MB。
- **对其他 Agent 的影响**：SenseVoice 现在可用（`available` 需 weights_ready+runtime_ready）；新增约 6.1GB venv + 897MB 权重；可用 `SENSEVOICE_PYTHON` 覆盖解释器；worker 是 trainer 按需拉起的常驻子进程，不是独立网络服务；不要升级整合包 funasr（会波及 GPT-SoVITS ASR 训练/官方脚本）。
- **回滚方式**：删除 `trainer/sensevoice-venv/` 与 `SenseVoiceSmall/`（进回收站并留痕）、还原代码/文档/回归；无数据库迁移。

---

## [2026-10-25 00:31 BY Qoder] 阶段 44补2：ASR SenseVoice 路由与权重就绪修复

- **文件改动**：
  1. `trainer/app/asr/catalog.py`（`resident_model_meta` / `backend_model_languages` / `default_resident_model`；`normalize(language_pool=...)`）；
  2. `trainer/app/asr/pipeline.py`（resolve 改为显式 model 权威、显式模型不匹配语种 400、`_ensure_resident` 权重预检、`_build_funasr` 本地/ModelScope 路径、SenseVoice 不挂 VAD/punc）；
  3. `trainer/app/asr/bootstrap.py`（SenseVoice 本地/ModelScope 探测、`funasr_model_path` / `model_weights_status` / `resident_model_status`）；
  4. `trainer/app/routers/asr.py`（`GET /v1/asr/readiness`、catalog 加 `resident_model_status`、acquire 之前 `WEIGHTS_MISSING` 预检）；
  5. `server/src/services/capabilityCatalog.ts` + `server/src/routes/open.ts`（`weights_key`、`capabilityAvailability`、ASR `available=可达 && weights_ready===true`、`weights_ready/weights_source`、SenseVoice 1536/无 size、fetch `/v1/asr/readiness`）；
  6. `app/src/types/asr.ts`（weights 字段 additive）；`.tmp/verify_asr_sensevoice.py`（新 14 项）与 `.tmp/verify_open_gateway.mts`（25→29 项）；
  7. 文档：`docs/ASR.md` §3.3、`docs/OPEN-API.md`、`PROGRESS.md`、`HANDOFF.md`（坑 97~99）。
- **原因**：外部 Agent 提交 `docs/sensevoice-small-diagnosis.md`。复核确认报告总判断（SenseVoice 不可用、available 误报、元数据不一致）成立，但其「ja 被 normalize 改回 zh、落到 Paraformer」的根因判断错误；真实故障是 resolve 先换 backend 到 fasterwhisper、显式 model 仍保留 SenseVoice，最后走错加载器。按用户「开始按上面的修」实施。
- **验证**：`.tmp/verify_asr_sensevoice.py` **14/14**（含 ja 路由 / 显式模型保护 / 缺权重 503 / readiness / 伪造本地快照 / 引擎层安全网；不加载模型）；`.tmp/verify_asr_gate.py` **25/25**；`.tmp/verify_open_gateway.mts` **29/29**；`npm run typecheck` / `npm run build` 全绿。**没有下载 SenseVoice 权重、没有真实加载/CER**（本机仍缺 `iic/SenseVoiceSmall`，约 1GB 待用户点头）；GPU 当前被 llama-server 等占用（free 969MB）。
- **对其他 Agent 的影响**：ASR `resolve` 的语种/后端语义变化（显式 model 权威；funasr 的 ja/en/ko/yue 由 SenseVoice 承接；显式模型与语种不匹配返回 400 `LANGUAGE_UNSUPPORTED`）；ASR 固定模型缺权重返回 503 `WEIGHTS_MISSING`；`/api/capabilities` ASR 项新增 `weights_ready/weights_source` 且 `available` 更严格；`/api/open/v1/models` 同步。未启停常驻服务；未新增模型文件。
- **回滚方式**：git 还原上述代码/文档与两个 `.tmp` 回归锁；无数据迁移；已存在的 ModelScope 缓存不受影响。

---

## [2026-10-24 22:43 BY Qoder] ASR 已落地模型与显存画像（只补文档/注释，无行为改动）

- **文件改动**：`docs/ASR.md` 新增 §3.2「已落地模型与显存画像」；`trainer/app/asr/catalog.py` 的 `REQUIRED_VRAM_MB` 后补一段实测注释。`.tmp/measure_asr_*.py` / `measure_whisper_turbo_fp32.py` 为一次性测量脚本（未入库）。
- **原因**：用户询问「目前搭载好的 ASR 模型有哪些、各自占用多少显存」。代码里的 `REQUIRED_VRAM_MB` 是准入门槛（量级估算），不是实际占用；顺手把真机画像写进文档，避免下次再猜。
- **验证 / 操作**：在本机 RTX 4060 Laptop 8GB 上逐个加载→3 秒音频转写→卸载：
  FunASR Paraformer-zh（本地 1.1GB）+1213MB / 峰值 +1257MB（门槛 2048）；
  faster-whisper small int8 +260MB（门槛 1024）；
  large-v3-turbo fp16 +1568/+1808、int8 +800/+1072、fp32 +3212/+3646（门槛 3072/2560/6144）；
  R2T2 未加载（free 5978MB < 6144MB 门槛；文档口径 GPU bf16 净占约 5.5GB，CPU 0）。
  每次均 `engine.unload()`，GPU 已释放（22:43 used 1886 / free 6072MB），无常驻服务残留。
- **副作用披露**：首次直接调用 FunASR 时未绑定 GPT-SoVITS 安装目录，走了远端别名，在 `D:\AI_Cache\modelscope\models\iic\` 下载了 `speech_seaco_paraformer_large...`（953MB）与 `punc_ct-transformer_cn-en-common-vocab471067-large`（1.2GB）。正常服务启动会 `bootstrap.install()` 并优先用本地 1.1GB 那套；这两份缓存不是默认路径，可保留作 fallback 或清理。
- **对其他 Agent 的影响**：无代码行为变化，`REQUIRED_VRAM_MB` 门槛值未改；仅新增文档与注释。
- **回滚方式**：git 还原 `docs/ASR.md` 与 `catalog.py` 注释；ModelScope 缓存按需清理。

---

## [2026-10-24 22:12 BY Qoder] 阶段 44补：GPU 真机画像与 svc_train 门槛参数化

- **文件改动**：`trainer/app/svc/training.py`（新增 `required_vram_mb(batch, duration, workers)`，preflight 用它算门槛）、`trainer/app/routers/svc.py`（`engines.acquire("svc_train", required_mb=...)`）、`.tmp/verify_svc_train.py`（10→13 项，加门槛参数化检查）、`.tmp/verify_svc_train_http.py`（8→9 项，H9 CUDA 门槛）、新增 `.tmp/smoke_svc_train_gpu.py`（GPU 冒烟/画像采样）；PROGRESS/HANDOFF 同步。
- **原因**：用户于 10.24 22:00 左右打开 GPU 窗口；静态 `train` 6144MB 门槛加 512MB 预留需 6656MB，而当时 free 6141MB，会把本可跑下的 DDSP 训练误拒。按坑 24/72/86 的参数化原则回填实测画像。
- **验证**：12 条 3.2s 合成素材 / batch 8 / fp16 / cache CPU / workers 1 → GPU 预处理 + 训练 2 步成功；nvidia-smi 峰值 used 3234MB（基线 1817，增量 **1417MB**）、最低 free 4724MB；产物 GPU 加载 + raw 转换 3.2s 音频 **2.14s**（含加载）；`required_mb=2048` 的 engine gate 通过。回归：CPU 训练 13/13、HTTP 9/9、任务 8/8、取消 3/3、**CUDA 真实 runner/调度器 6/6**（`.tmp/verify_svc_train_gpu_job.py`）。
- **对其他 Agent 的影响**：`svc_train` 的显存门槛不再是静态 6144，而是 `max(2048, min(6144, 1024 + 48*batch*seconds + 800*(workers-1)))`；preflight 的 `vram.required_mb` 数值随之变化。未启动/停止常驻服务；GPU 训练进程已结束（free 回到 ~6131MB）。
- **回滚方式**：git 还原 `training.py` / `routers/svc.py` 两处；删除 `.tmp/smoke_svc_train_gpu.py` 与文档改动；无数据迁移。

---

## [2026-10-24 21:32 BY Qoder] 阶段 44：DDSP-SVC 训练入口（P5）

- **文件改动**：
  1. 新增 `trainer/app/svc/training.py`（语料扫描/9:1 划分/`duration` 校验/绝对路径 config/预处理计数守卫/自适应存档与日志/最终权重补存/产物归位/取消）、`trainer/app/svc/train_preprocess.py`、`trainer/app/svc/train_entry.py`（embedded Python 路径注入、可 pickle DotDict、CPU `torch.load`、torch 2.0 shim、最终存档）；
  2. `trainer/app/routers/svc.py`（`/v1/svc/train/plan|train` + `make_svc_train_runner`）、`trainer/app/api.py`（注册 `SVC_TRAIN`；补 `SvcError`/`VcError` 400+hint handler）、`trainer/app/routers/vc.py`（失败/取消状态修正）、`trainer/app/vc/training.py`（`_run_command` 可取消 + 进程树清理 + 回调异常保护）；
  3. 前端：`app/src/types/svc.ts`、`lib/vc.ts`、`pages/SingingConversionPage.tsx`（训练卡，含预检请求序号防陈旧覆盖）、新 `components/features/TrainResultCard.tsx`、新 `hooks/useTrainHistory.ts` / `useSvcTrainHistory.ts`、`pages/VoiceConversionPage.tsx` + `hooks/useVcTrainHistory.ts`（复用共享结果卡）、`types/vc.ts`（历史错误字段）；
  4. 回归锁：`.tmp/verify_svc_train.py`（10）、`.tmp/verify_svc_train_http.py`（8）、`.tmp/verify_svc_train_job.py`（8）、`.tmp/verify_svc_train_cancel.py`（3）、`.tmp/svc_train_fixture.py`；
  5. 文档：`PROGRESS.md` / `HANDOFF.md`（坑 89~95、命令表、状态）/ 本日志。
- **原因**：`docs/VOICE-MODEL-MANAGEMENT-PLAN.md` §4.5 / P5 遗留——上游训练脚本齐全但无编排层；用户要求继续推进。
- **验证**：四条回归全绿（CPU 零显存真跑；含 TestClient 任务生命周期与取消）；`npm run typecheck` / eslint / `npm run build` 全绿；整合包 py3.9 `py_compile` 全绿。**未做 GPU 训练与浏览器走查**（当前 free 2393MB，低于 6144MB 训练门槛；起 dev 服务在自动模式被权限层拦截）。
- **对其他 Agent 的影响**：新增 `/v1/svc/train/plan|train` 与 `JobKind.SVC_TRAIN`（经网关 `/api/sovits/*` 透传）；`SvcError`/`VcError` 现在返回 400 + code/hint（此前裸 500）；RVC 训练失败不再被标 succeeded；`_run_command` 增加可取消能力（RVC 既有调用行为不变）；未启动/停止任何常驻服务。
- **回滚方式**：git 还原上述文件并删除新增模块/回归锁；无数据迁移；`models/ddsp-svc/` 下已有模型不受影响。

---

## [2026-10-24 BY ZCode] 阶段 41补1：R2T2 真机转写闭环（CPU 模式）+ 两处真 bug

- **文件改动**：`netease/app/r2t2_worker.py`（新增 `--device auto/cuda/cpu`，CPU=fp32；main() 开头摘除脚本目录 sys.path——修「netease/app/r2t2.py 遮蔽 site-packages 的 r2t2 包」）；`.tmp/smoke_r2t2_transcribe.py`（--device 透传、CPU 跳过显存护栏、静音素材 peak 预检、超时 1500s）；`.tmp/verify_r2t2_offline.py`（+R5 真 load 导入路径检查，25→26 项）；`netease/README.md`/`HANDOFF.md`（坑 87/88）/`PROGRESS.md` 同步。
- **原因**：GPU 显存窗口持续未开（llama-server 占 ~5GB），用户指示「继续推进 R2T2」——用零显存通道完成最后一步真机验证。
- **验证**：`--device cpu` 双语真机转写通过（3.8s 日语→正确日文文本，2.86s；6.7s 中文→正确中文文本，3.84s；load 冷 44s/热 14s）；回归 26/26。
- **对其他 Agent 的影响**：R2T2 离线转写功能闭环；worker 新增 `--device` 参数（默认 auto，行为不变）；GPU bf16 RTF 数据点仍待显存窗口。
- **回滚方式**：git 还原 `r2t2_worker.py` 与两个 .tmp 脚本即可（`--device` 默认 auto 不改服务行为）。

---

## [2026-10-23~24 BY ZCode] 阶段 40~43：显存校准 / R2T2 离线转写 / ASR 门槛参数化 / 对外能力网关

- **文件改动**（按阶段分组，完整六要素台账见 `PROGRESS.md`，坑表见 `HANDOFF.md` 坑 79~86）：
  1. 阶段 40（10.21，回溯披露——早于本日志建档）：IndexTTS/gsv5 准入门槛按 6GB 极限校准（5500/3584）、五运行时 unload 统一「先 gc 再 empty_cache」、netease warmup 加最小真实合成预热、网关新增 `server/src/services/serviceCatalog.ts` 收敛五服务身份；
  2. 阶段 41（10.21~10.23，回溯披露）：R2T2 离线转写接入——`netease/app/r2t2_worker.py` 加 transformers 后端、新环境 `netease/r2t2-venv/`（gitignore，约 6GB）、权重 `netease/models/Confucius4-R2T2/`（4.1GB）、`NETEASE_R2T2_BACKEND` 默认 transformers、launcher/preflight 探测、修 warmup 挂死等三个真 bug（坑 82~84）；票 #10 已关；
  3. 阶段 42（10.23）：ASR 显存准入参数化——`trainer/app/asr/catalog.py` 门槛表 + `trainer/app/engine.py` acquire 覆盖参数 + `routers/asr.py` 三处按 resolve 结果设门（坑 86）；
  4. 阶段 43（10.24，**本次**）：对外能力网关——新增 `server/src/services/capabilityCatalog.ts`、`server/src/services/openClients.ts`、`server/src/routes/open.ts`，挂载于 `routes/index.ts`（`/api/open/*` + `/api/capabilities`）；`lib/errors.ts` 的 AppError 增加 `hint` 字段、errorHandler 渲染 hint；新增 `docs/OPEN-API.md`；`AGENTS.md` 外部共享约束「三类」扩为「四类」（+④ 回环 HTTP 能力调用）。
- **原因**：用户指令——① 6GB 极限显存优化；② 推进票 #10；③ 统一 ASR 门槛；④ 「所有部署的模型做能力分割与接口暴露，供别的任务调用」。
- **验证**：阶段 40 `.tmp/verify_vram_gates.py` 12/12；阶段 41 `.tmp/verify_r2t2_offline.py --runtime` 25/25 + preflight 全绿（真机转写待显存窗口，冒烟脚本内置 6200MB 护栏）；阶段 42 `.tmp/verify_asr_gate.py` 25/25（含整合包 py3.9）；阶段 43 `.tmp/verify_open_gateway.mts` 25/25（死端口+内置假上游）+ `npm run typecheck`/build 全绿。现有页面透传端点零改动。
- **对其他 Agent 的影响**：① 新增对外调用面：外部任务可经 `http://127.0.0.1:8787/api/open/*` 调用 13 项推理能力（合法操作④），撞显存默认不让位、`focus:true` 才仲裁；② netease R2T2 后端默认变更（vllm→transformers），WSL 流式部署需显式设回 `NETEASE_R2T2_BACKEND=vllm`；③ GPU 互斥新增事实：用户自跑 llama-server（Qwen2.5-7B `-ngl 99`，约 5GB，端口 8081），GPU 验证前先看 `nvidia-smi`。
- **回滚方式**：git 还原对应文件；`netease/r2t2-venv/` 与 `netease/models/Confucius4-R2T2/` 为新增目录，删除即回退（进回收站并留痕）；能力网关回退 = 还原 `routes/index.ts` 并删除三个新文件。

---

## [2026-10-24 00:50 BY ZCode] 建立目录治理：AGENTS.md 追加共享约束节 + 新增本变更日志

- **文件改动**：
  1. `AGENTS.md` 末尾追加「外部共享约束」节 —— 界定主中枢（link_ttstool 引用方）对本仓的合法操作仅限三类（只读 `knowledge-export/*.md` 检索 / `knowledge_syncer` 挂载 `ai voice` 总结进 knowledge-atlas 并重编译 / 读规范文档），并确立独立仓库边界、大资产保护（models、GPT-SoVITS-v2pro、vendor、node_modules 严禁删移）与 GPU 互斥规则；
  2. 新增 `AGENT_CHANGELOG.md`（本文件）。
- **原因**：主中枢统一治理要求——为五个外部共享目录建立约束管理（参照 `F:\localmodels\AGENTS.md` 模板）。
- **验证**：纯文档改动；`app/`、`server/`、`knowledge-atlas/js/data.js` 与模型资产均未触碰，服务未启停。
- **对其他 Agent 的影响**：今后进入本仓库的 Agent（含主中枢同步任务）改动留痕从本条起强制。
- **回滚方式**：删除 `AGENT_CHANGELOG.md`，并移除 `AGENTS.md` 末尾「外部共享约束」节（建议回收站 / git 还原）。
- **备注**：本仓当前分支 `feature/vc-svc` 工作区存在**本次治理以外的未提交改动**（.gitignore / HANDOFF.md / PROGRESS.md / resources.ts / NeteaseAsrPage.tsx，非 ZCode 所为），ZCode 未提交、未触碰；治理文件暂存工作区，提交时请与本批改动分开处理。

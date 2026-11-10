# AGENT_CHANGELOG —— 外部共享目录改动记录（ttstool）

> 本仓库经 `link_ttstool` Junction 被 `Mega-Scale AI Workflow Integration Project` 引用，**可能同时有多个 Agent 在此工作**。
> 规范：任何 Agent 对本仓库的改动或服务操作，必须在本文档追加记录（**倒序，最新在上**），注明时间、Agent、改动内容、原因、验证、回滚方式与对其他 Agent 的影响。
> 相关规范见本仓库 `AGENTS.md`「外部共享约束」节与主中枢 `AGENTS.md` 第二节核心红线「外部共享目录改动记录」。
> **状态注（2026-11-09 BY Qoder）**：下文阶段 45~48 各条写的「本次未提交 git」已全部失效 —— 这些改动已在 2026-11-09 统一入库并推送：`9c9abbf`（阶段 45~48 实现）、`689a246`（文档与知识库）、`b42a60a`（`.tmp` 回归锁 31 份）；远端 `origin/feature/vc-svc` = `b42a60a`。

---

## [2026-11-09 BY Qoder] 阶段 49补：SenseVoice 标记过滤 + CosyVoice3 权重下载（限速/续传）

- **文件改动**：新增 `trainer/app/asr/sensevoice_text.py`（`EMOTION_MARKERS` 6 个 + `EVENT_MARKERS` 6 个 + `strip_markers()`）；`trainer/app/asr/sensevoice_worker.py`（`generate` 分支在 `rich_transcription_postprocess` 之后接 `strip_markers()`，import 走「按路径启动 / 当模块」双路兜底）；`scripts/cosyvoice-weights.mjs`（新增 `--parallel` / `--limit-kbps` / `--urls-only`、HTTP Range 断点续传、进度行带速度；修掉 `fs.createWriteStream(flags:'wb')` 在 Node 24 非法的崩溃）；`.tmp/verify_asr_sensevoice.py` 追加 A14~A16；文档 `docs/ASR.md` §7/§8.5、`docs/AGENT-GUIDE.md`、`docs/COSYVOICE3-INTEGRATION.md`、`PROGRESS.md`、`HANDOFF.md`（坑 99 追加）、本 changelog。
- **决策（使用者 2026-11-09 拍板）**：①「😔 情绪标记用过滤」→ 实现为**情绪 6 个 + 事件 6 个一起剥**（同一类非文本标注；只删 emoji，不改字不补标点）；若字幕想保留事件标记（BGM/掌声/咳嗽），把 `sensevoice_text.EVENT_MARKERS` 清空即可，情绪仍会剥。②「权重可以下，但不要占太多带宽」→ 下载脚本加限速与续传，本次以 `--parallel 1 --limit-kbps 2500`（实测稳定 **2.43 MB/s**）跑，未打满带宽。
- **操作记录（网络）**：ModelScope `FunAudioLLM/Fun-CosyVoice3-0.5B-2512` 12 项 / 5.05GB 下到 `cosyvoice/models/Fun-CosyVoice3-0.5B/`（gitignore，不进库）；残件落 `<file>.part`，重跑同命令按 Range 续传；单项直链可用 `node scripts/cosyvoice-weights.mjs --urls-only` 导出（也可手动/下载器接管）。
- **验证**：`py_compile`（整合包 py3.9）通过、sensevoice-venv py3.12 直接 import 通过；`.tmp/verify_asr_sensevoice.py` **15/15 + 2 SKIP**（A14 情绪、A15 事件+空格收拢、A16 逐字保留为新增）；真机 worker 冒烟（整合包解释器 → sensevoice-venv worker）ja/zh/en 三条真实样例**输出均无 emoji**：load 53.5s、常驻 +852MB / 峰值 +917MB、unload 归还到 6323MB。
- **对其他 Agent 的影响**：ASR 文本契约不变（仍逐字、无 ITN 标点），只是不再带 emoji；`/v1/asr/*`、`/api/capabilities`、错误码均未变。`scripts/cosyvoice-weights.mjs` 新开关向后兼容（默认并行 2、不限速）；权重目录仍是 gitignore。
- **回滚方式**：删 `trainer/app/asr/sensevoice_text.py` 并回滚 worker 中调用即可恢复「带 emoji」行为；`git checkout -- scripts/cosyvoice-weights.mjs` 回滚下载脚本；无数据迁移。

---


## [2026-11-09 BY Qoder] 阶段 49：遗留项真机验证窗口 + 中文轻语基准归档（零生产代码改动）

- **文件改动**：仅文档与 `.tmp` 回归资产 —— `docs/ASR.md`（新增 §8.5 轻语/耳语基准，并把「SenseVoice `😔` 情绪标记」「Paraformer `status.device=null`」写进 §7/§8.5 已知边界）、`PROGRESS.md`（阶段 49 台账 + 看板 + 下一阶段入口重排 + 速览表补 49 行）、`HANDOFF.md`（当前状态 + 命令表两行 + 坑 112~116 + 建议清单 + 时间戳）、本 changelog；`.tmp/verify_open_gateway.mts`（能力数 13→14、tts 6→7，收敛成 `EXPECTED_TOTAL`/`EXPECTED_TTS`）、`.tmp/verify_sovits_pair.py`（夹具改 `rglob` 按文件名找）、`.tmp/smoke_r2t2_transcribe.py`（子进程补 `PYTHONIOENCODING=utf-8`/`PYTHONUNBUFFERED=1`；GPU 护栏改成进程内等窗口最多 180s，阈值 6200 不变）、新增 `.tmp/gpu-verify-20261109/`（四个真机脚本 + 日志 + nvidia-smi 采样）。
- **操作记录（有 GPU 动作）**：11:36 实测 free 6330 MB、七个端口全空（`llama-server` 未运行），依次做四次真机验证，每次都是「起一个服务 → 验证 → 停掉」，**结束时七个端口全空、无残留 python、GPU 回到 free 6645 MB**：
  1. **R2T2 GPU bf16**（不起服务，脚本直连 worker）：free 6213 MB → load 60s（含静音预热 2.8s）→ 8.4s 中文轻语转写 1.5s（RTF≈0.18）、文本与参考一致；峰值净增 ≈6134 MB（最低 free 82 MB）；
  2. **netease `:9882`**：`POST /v1/confucius/warmup` 冷进程 84.8s（`warmup_real` 6.73s）→ 首条真实合成 9.64s、次条 8.94s；热进程重载 19.5s → 首条 6.53s、次条 5.59s；unload 后 free 回到基线之上；
  3. **IndexTTS `:9883`**：5500 门槛放行、装载 57.9s、常驻 +5029 MB；单段情感 2.47s 音频/6.62s；**`/v1/synth/segments` 两段（平静 0.8 / 喜 0.8）+ gap 150ms → 逐段和 7.814s + 0.15 = 7.964s，实际 7.9635s**；unload 归还；
  4. **gsv5 `:9885`**：v5turbo 冷进程装载 52.7s、常驻 +2334 MB、首条 14.03s（RTF 3.47，进程级 CUDA 首跑）、次条 1.69s（**RTF 0.419**）；热进程重载 5.2s、次条 0.99s（**0.246**）；48kHz；峰值净占 ≈3400 MB。**发现 `/v1/unload` 不归还首次 CUDA 初始化的一次性成本 ~1.5GB（循环 load→unload 水位稳定，不是累积泄漏）** → 换引擎要停服务而不是只 unload。
  另补跑 `.tmp/verify_vram_estimate.py` 的真实 `/health` 段（9/9）；离线回归委派 teammate 跑完 15 项（typecheck/build 与 12 项脚本实质通过）。
- **验证**：四份真机结果 JSON/日志在 `.tmp/gpu-verify-20261109/`（`netease_warmup_result.json`、`indextts_segments_result.json`、`gsv5_result.json`、`r2t2_gpu_smoke.log` + 三份 `*_vram.csv`）；离线回归日志 18 份在 `.tmp/regression-20261109/`；`npm run typecheck`、`npm run build`、`.tmp/verify_open_gateway.mts`（改后 30/30 待复跑）、`verify_asr_gate` 25/25、`verify_asr_sensevoice` 12/12+2SKIP、`verify_svc_train` 13/13（真 CPU 训练 107s）等。
- **对其他 Agent 的影响**：**生产代码零改动**（app/ server/ trainer/ netease/ indextts/ gsv5/ irodori/ cosyvoice/ 与任何服务的路由契约都没变）；`.tmp` 里三份回归锁改动只影响「跑测试的人」。运行期没有留下任何服务（8787/9881~9886 全空）。**本轮未动 git**；阶段 45~49 的全部改动随后按使用者要求于同一日入库并推送到 `origin/feature/vc-svc`（提交见上方的状态注）。新事实两条给后续 agent：① `gsv5` 只 unload 会占 1.5GB → 让位请停服务；② R2T2 GPU 实测峰值净增 ≈6.1GB（最低 free 82MB），6144 门槛不能下调、跑前要关占卡大户。
- **回滚方式**：文档回滚上述四份 `.md` 即可；`.tmp` 三份锁直接 `git checkout --`（若被跟踪）或忽略；`.tmp/gpu-verify-20261109/`、`.tmp/regression-20261109/` 可整目录删除，无数据迁移。GPU 侧无残留（已验证）。

---

## [2026-11-05 12:55 BY Qoder] 阶段 48：CosyVoice3 第六运行时接入（代码完成，权重未下载）

- **文件改动**：新增 `cosyvoice/`（`server.py`、`app/{config,errors,hardware,inventory,engine,catalog,synth,api}.py`、`requirements.txt`、`weights.manifest.json`、`README.md`；`.venv` / `upstream` / `models` / `.data` 均 gitignore）；新增 `scripts/cosyvoice.mjs`、`scripts/cosyvoice-weights.mjs`；网关 `server/src/{config/index.ts,index.ts,routes/index.ts,routes/cosyvoice.ts,routes/open.ts,routes/preload.ts,routes/resources.ts,services/{arbiter,capabilityCatalog,preload,runtime,serviceCatalog}.ts}`；前端 `app/src/{App.tsx,components/layout/AppShell.tsx,pages/SettingsPage.tsx,pages/CosyvoiceTtsPage.tsx,lib/{cosyvoice,localService,preload}.ts,types/{cosyvoice,index,sovits}.ts}`；文档 `docs/COSYVOICE3-INTEGRATION.md`、`docs/AGENT-GUIDE.md`、`docs/OPEN-API.md`、`AGENTS.md`、`HANDOFF.md`、`PROGRESS.md`、`.gitignore`、`package.json`。
- **行为变化**：新增能力 `cosyvoice3-tts`（:9886），支持 `zero_shot` / `cross_lingual` / `instruct2`；网关预加载、仲裁、设置页开关、侧栏状态卡、合成页与启动预加载选择全部接入；Windows 两补丁（`torch.load`→CPU 再上卡 / ONNX provider 回落）；**只接推理，不接训练**。
- **验证**：`npm run typecheck`（app+server）通过；`npm run build` 通过；`python -m py_compile cosyvoice/server.py cosyvoice/app/*.py` 通过；`npm run cosyvoice:check` 通过（py3.10 / torch 2.3.1+cu121 / CUDA / 上游代码 / 清单读取）；服务装配冒烟 `/health` 200、`/v1/catalog` 200（9 语言 / 11 个列名方言 / 3 模式）。
- **未验证**：真机合成、显存峰值与 RTF —— 权重未下载。
- **网络事件（重要）**：权重从 ModelScope 以 8 路 Range 并发下载，占用带宽导致用户网络明显变慢；已停止全部下载进程并确认无 `curl`/下载脚本残留，**约 3.6GB 分片已按用户指示移入回收站**。后续恢复下载前必须先征得用户同意，并降低并发（1–2 路）。
- **对其他 Agent 的影响**：:9886 空闲；CosyVoice 服务未启动、权重未下载；`/api/capabilities` 中 `cosyvoice3-tts` 在服务未启动时 `available=false`；现有五运行时路由/端口未变；工作区仍有他人未提交改动，**本次未提交 git**。
- **回滚方式**：回滚上述文件即可；删除 `cosyvoice/`、`scripts/cosyvoice*.mjs` 与新增文档即可完全移除；无数据迁移。

## [2026-10-30 16:10 BY Qoder] 借用语音能力：启动网关读取能力/音色库

- **服务操作**：在 `F:\schoolCompWorks\clone\ttstool` 后台启动 `npm run dev:server`（Node 网关 `127.0.0.1:8787`），仅用于 `GET /api/capabilities`、`/api/voicelib`、`/api/models` 读取；未启动/停止任何 TTS/ASR 运行时，未加载权重，未改代码。
- **原因**：微信小号链路准备接入本地 ASR/TTS；按用户指定，TTS 只用 GPT-SoVITS v2ProPlus（非 v5），RVC 暂缓，ASR 选最快模型。
- **核对结果**：GPU RTX 4060 Laptop 8GB，查询时空闲 3221 MiB；`gpt-sovits-v2proplus` available（vram 3072）；`sensevoice-small` available（vram 1536，最快候选）、`paraformer-zh` available（2048）；`/api/models` 已有 `若叶睦` GPT-SoVITS 权重（`Mujica_若葉睦_v2pp.ckpt/pth`），同目录有两段日文参考 WAV。
- **对其他 Agent 的影响**：8787 网关由本进程占用；如其他 Agent 需要网关请复用，不要重复启动。未占用 GPU 模型，未改变接口。
- **回滚方式**：停止本次后台 `npm run dev:server` 进程即可；无文件改动。

---

## [2026-10-30 BY Qoder] 阶段 47补6：产出记录页音频预览 + trainer Range

- **文件改动**：`app/src/lib/jobArtifacts.ts`（批量 `results[]` 展开为逐条音频轨道、`kind: audio|file`、路径推导 `/files` URL）、`app/src/hooks/useOutputRecords.ts`、`app/src/types/outputs.ts`、`app/src/pages/OutputsPage.tsx`（音频播放器/文件下载链接分流）；新增 `trainer/app/file_serve.py`；`trainer/app/api.py`（`/files`、`/v1/voices/:id/audio`、`/v1/annotations/audio` 改 Range 响应，移除 `_guess_audio_type`）；`PROGRESS.md`、`HANDOFF.md`（坑 111）、本 changelog 同步。
- **原因**：产出记录页只显示批量任务的 `workdir`/ZIP/清单（音频在 `artifacts.results[]` 未展开），且非音频 URL 被当成播放器；trainer 的 `StaticFiles` 不支持 Range，浏览器 `seekable=[0,0]`，长音频无法拖动。
- **行为变化**：批量结果逐条出细长播放器（含时长/字节/文本摘要）；ZIP/清单「下载 / 打开」；实验目录/权重仍复制路径；只有路径的 trainer 音频可推导预览 URL。Range 生效后长音频可拖动，音色试听/训练校音同步受益。
- **验证**：真实历史 job 夹具解析（批量 2 条→2 audio、ZIP/清单→file）；浏览器真实网关下产出记录页出现批量播放器与文件链接；TestClient `/files` 206/416/HEAD/路径穿越 404、`/v1/voices/:id/audio` 206；py_compile/typecheck/eslint 通过。**未重启 :9881**，运行中进程仍是旧代码，Range 需重启后生效。
- **对其他 Agent 的影响**：`/files` 契约仍是 GET（新增 HEAD/Range）；静态文件路径安全限制在 `outputs_dir`；产出记录页 DOM 结构变化（音频/文件分流）。当前 :8787 / :5173 / :9881 由其它会话占用（见上一条 16:10 记录），本阶段**未重启/停止**这些进程；运行中的 :9881 仍是旧代码，**Range 需其重启后生效**。前端改动会被 Vite HMR 自动加载。
- **回滚方式**：回滚上述前后端文件与文档即可；无数据迁移；改动未提交 git。

---

## [2026-10-29 BY Qoder] 阶段 47补5：面向外部 Agent 的统一使用指南

- **文件改动**：新增 `docs/AGENT-GUIDE.md`（能力发现 / 启动与端口 / Open API / CLI / 批量 job / 产物 URL / 显存互斥 / 错误码 / 共享红线 / 文档地图 / 最小验收集）；在 `AGENTS.md` 顶部、`HANDOFF.md` 项目信息、`README.md`「命令行合成」、`docs/OPEN-API.md` 顶部、`docs/USER-GUIDE.md` 顶部加入口；`PROGRESS.md`、本 changelog 同步。
- **目的**：给借用本工作区模型能力的外部 Agent 一份单一入口，减少四处翻文档和误用（特别是运行时未启动、显存互斥、批量不是同步 API、焦点让位差异）。
- **核对修正**：netease 卸载路径是 `/api/netease/v1/confucius/unload` 与 `/api/netease/v1/r2t2/unload`；GPT-SoVITS 仅在设置页启用时由 `/api/sovits/*` 代理自动拉起，`/api/open/*` 永不拉起；`focus:true` 仅单条 TTS 生效。
- **验证**：逐项对照 `server/src/services/capabilityCatalog.ts`、`routes/open.ts`、`routes/voicelib.ts`、`serviceCatalog.ts`、`sovits.ts`、`scripts/say.mjs`；本次仅文档，无代码/构建/服务变更。
- **对其他 Agent 的影响**：新增只读文档与入口；共享红线与既有 `AGENTS.md` 一致；不改变任何接口或运行行为。
- **回滚方式**：删除 `docs/AGENT-GUIDE.md` 并回滚上述入口行即可；改动未提交 git。

---

## [2026-10-29 BY Qoder] 阶段 47补4：薄 CLI `say`（单条 + 批量）

- **文件改动**：新增 `scripts/say.mjs`、`docs/CLI.md`；`package.json` 增加 `say` / `say:batch`；`README.md`（命令行合成节）、`docs/OPEN-API.md`（指向 CLI）、`HANDOFF.md`（命令表）、`PROGRESS.md`、本 changelog 同步。
- **能力**：单条走 `POST /api/open/v1/audio/speech`（voice_id/ref_path、params、focus、超时、WAV 落盘 + JSON 摘要）；批量走 `POST /api/sovits/v1/tts/batch` + `GET /v1/jobs/:id` 轮询，支持 `--plan` / `--sync` / `--items` / `--out-dir` / `--zip` / `--no-download` / `--stop-on-error` / `--allow-failures`，下载时同时保存 `manifest.json`。stdout 只有 JSON，进度走 stderr。
- **验证**：`node --check`、`--help`、npm scripts；用 `.tmp/say-cli-mock.mjs` 模拟网关验证单条落盘、plan、异步轮询、同步、2 条音频+ZIP 下载、上游 400 透传、网关不可达提示，全部通过。**未启动任何模型服务**（8787/9881 当前均未监听），真实 GPU 合成待复验。
- **对其他 Agent 的影响**：新增只读/调用型脚本，不改网关、trainer 或页面行为；Agent 调 CLI 用 `node scripts/say.mjs` 或 `npm run --silent say -- ...`（npm 默认 banner 会污染 stdout）。运行时/显存约束与页面一致，CLI 不自动拉起服务或下载权重。
- **回滚方式**：删除 `scripts/say.mjs` / `docs/CLI.md`、移除 `package.json` 两个脚本并回滚文档即可；无数据迁移；改动未提交 git。

---

## [2026-10-28 BY Qoder] 阶段 47补3：全项目细长音频播放条

- **文件改动**：新增 `app/src/components/features/SlimAudioPlayer.tsx`；替换 15 个文件的原生 `<audio controls>`（BatchPage / ABPlayer / Gsv5Page / IrodoriTtsPage / IndexttsTtsPage / NeteaseAsrPage / NeteaseTtsPage / OutputsPage / RunResultCard / SamplePicker / VoiceLongReference / SingingConversionPage / TrainingPage / VoiceConversionPage / VoiceLibraryPage）；`server/src/routes/voicelib.ts` 两处试听路由改 `sendFile`；`PROGRESS.md`、`HANDOFF.md`（坑 110）、本 changelog 同步。
- **行为变化**：所有原生音频控件换成单行细长播放条：全宽细进度条可拖动、键盘 ←/→ ±5 秒、Home/End、静音+音量、下载；AB 对比仍保留「换轨不丢进度」。批量页结果行改为信息一行 + 播放条整行（进度条由 220px 变为约 707px）。音色库试听补上 `Content-Length`/`Accept-Ranges`，浏览器可显示时长并 seek。
- **验证**：app/server typecheck、app build、eslint 全过；浏览器实测音色库 467px 与批量结果 939px 播放条（高 38px），播放、60%/80% 拖动、ArrowLeft、暂停切换正常；未改动结果面板的波形/增益播放器。
- **对其他 Agent 的影响**：后续页面不要再直接写 `<audio controls>`，统一用 `SlimAudioPlayer`；新增音频路由需用 `res.sendFile` 或等价实现提供 Range，否则进度条无法拖动。
- **回滚方式**：回滚上述前端文件与 `server/src/routes/voicelib.ts`，删除新增组件即可；无数据迁移；改动未提交 git。

---

## [2026-10-28 BY Qoder] 阶段 47补2：gsv5 v5 加载修复（cwd / TTS_Config / sv 权重）

- **文件改动**：`gsv5/app/gsv5_engine.py`（`ensure_upstream_on_path()` 增加 `os.chdir(upstream)` + 注入 `eres2net`；`TTS_Config` 改 dict `custom` 形式）；`gsv5/upstream/GPT_SoVITS/pretrained_models/sv/`（从本机 v2pro 安装包补齐 `pretrained_eres2netv2w24s4ep4.ckpt`，107MB，upstream 目录 gitignored）；`PROGRESS.md`、`HANDOFF.md`（坑 109）、本 changelog 同步。
- **问题**：用户报 `合成失败 加载 v5 变体 v5turbo 失败：No module named 'ERes2NetV2'`。根因三层：① 启动 cwd 是 `gsv5/`，上游 `TTS.py`/`sv.py` 用 `os.getcwd()` 拼 `GPT_SoVITS/...`；② 上游 `TTS_Config` 只接受 dict/str，旧 kwargs 调用会 TypeError；③ `pretrained_models/sv` 权重缺失。
- **验证**：gsv5 venv CPU 预加载 v5turbo 26.1s（s1v3/vocoder/s2Gv5turbo/BERT/HuBERT 全部命中）；CPU 短句合成输出 48kHz / 2.36s 音频（13.1s，4 steps）；`py_compile` 通过。**未启动 GPU 服务、未占显存**（当时空闲 3235MB < v5turbo 门槛 3584MB）。
- **对其他 Agent 的影响**：仅 gsv5 引擎改动；`gsv5/upstream` 是 gitignored 独立 clone，新增 `sv` 权重不进入本仓 git；未改 API 契约、未重启任何运行中的服务。
- **回滚方式**：回滚 `gsv5/app/gsv5_engine.py` 两处改动即可（sv 权重可保留，缺失会回到加载失败）；改动未提交 git。

---

## [2026-10-28 BY Qoder] 阶段 47补1：用户否决 PyMSS，生产恢复纯 UVR5

- **文件改动**：`trainer/app/config.py` / `api.py` / `training.py` / `routers/uvr.py` / `audio/uvr5.py` 恢复 UVR5 路径（移除 `uvr_backend`/`pymss_*`/`PymssEngine`/训练别名/`cancel_event`）；`trainer/app/audio/pymss.py` 与 `scripts/pymss-check.mjs` 归档到 `.tmp/rejected_pymss/`；`package.json` 移除 `pymss:check`；`pymss/README.md` / `AB-REPORT.md` 标注否决；`PROGRESS.md`、`HANDOFF.md`（坑 108）、本 changelog 同步。
- **决策**：用户耳听确认 PyMSS 4_HP-Vocal 杂声多；8GB 显存下 UVR5 的延迟/占用更优。**放弃 PyMSS 迁移**，生产恢复纯 UVR5。
- **保留**：`trainer/app/engine.py::unload_all()` 修复（遍历所有注册 unloader，修复「已加载但 active 为空」卸不掉）与 PyMSS 无关，保留。`pymss/.venv` + `pymss/models`（约 2.2GB 模型）与 A/B 报告仅作实验记录，不再接生产；未删除。
- **验证**：`grep` 生产代码无 `pymss/uvr_backend` 引用；py_compile / typecheck 全绿；运行中的 trainer 一直走 UVR5，`ykn神人版` loaded=True；未重启/关闭服务。
- **对其他 Agent 的影响**：生产分离/UVR5 行为恢复原样；`pymss/` 为未接入实验，**不要再接回**；磁盘清理需用户确认后走回收站。
- **回滚方式**：无需回滚（已恢复 UVR5）；如需重新评估 PyMSS，从 `.tmp/rejected_pymss/` 取回适配层、并重新加回 config/api/training/router 分支；改动未提交 git。

---

## [2026-10-28 BY Qoder] 阶段 47：UVR5 → PyMSS 迁移 P0~P3（默认仍 uvr5，PyMSS opt-in）

- **文件改动**：新增 `pymss/`（`bridge.py` / `check.py` / `train_cli.py` / `README.md` / `weights.manifest.json` / `AB-REPORT.md`；`.venv` 与 `models/` 已 gitignore）；新增 `trainer/app/audio/pymss.py`、`scripts/pymss-check.mjs`；修改 `trainer/app/config.py`（uvr_backend/pymss_*）、`trainer/app/api.py`（按后端选择引擎）、`trainer/app/routers/uvr.py`（PyMSS 不依赖 GPT-SoVITS 安装、cancel_event）、`trainer/app/training.py`（`_step_uvr` PyMSS 分支 + 旧模型别名）、`trainer/app/engine.py`（`unload_all` 遍历所有 unloader）、`package.json`（`pymss:check`）、`.gitignore`、`PROGRESS.md`、`HANDOFF.md`（坑 108）、本 changelog；`.tmp` 回归脚本未跟踪。
- **行为变化**：`UVR_BACKEND=pymss` 时 `/v1/uvr/*`、翻唱向导与训练 `_step_uvr` 走独立 py3.12 bridge；默认仍是 `uvr5`，旧路径保留。`PymssEngine` 保持 catalog/分离/缓存/二级/取消语义；DeEcho 净化 stem 映射为 `No Reverb`/`No Echo`；训练旧模型 ID 经别名映射，`onnx_dereverb_By_FoxJoy` 明确报错。
- **操作记录**：安装 `pymss/.venv`（py3.12.10 + pymss 2.0.14 + pymss-core 0.1.4 + **torch 2.11.0+cu128**），下载 9 个模型到 `pymss/models`（约 2.2GB）。A/B 前**临时卸载 GPT-SoVITS `ykn神人版`**，测完已按原路径恢复（`loaded=True`）；未重启 trainer/其它服务；未改动用户三方程序。
- **验证**：`npm run pymss:check` READY；CPU 真跑 HP2 35.6s、DeReverb 47.9s、缓存命中 0.007s；TestClient `/v1/uvr/catalog` + `separate wait=true` 200；训练 CLI CPU 25.5s；py_compile/typecheck/build 全绿；GPU A/B 数据见 `pymss/AB-REPORT.md` / `.tmp/pymss_ab/index.html`。
- **关键结论**：PyMSS 功能可用，但 8GB 卡 VR 档位明显回退（HP2 48.5s/+3210MB vs UVR5 12.7s/+1041MB；HP5/DeReverb 同量级回退）；BS-RoFormer 反而更快（9.2s/+1876MB，UVR5 CLI 缺 yaml 基线失败）。**默认不切换**；`vocal_main`、许可、耳听、BS 基线、P4/P5/P6 待定。
- **对其他 Agent 的影响**：新增 `pymss/.venv`（cu128 torch）与 `pymss/models`（gitignored，约 2.2GB），不要删除/移动；`UVR_BACKEND` 默认 uvr5，现网行为未变；`/v1/uvr/*` 契约未变；模型许可待核对，不要直接分发。
- **回滚方式**：回滚上述代码/文档；删 `UVR_BACKEND` 即回 uvr5；`pymss/` runtime/models 可保留（不影响默认），如需清理走回收站并留痕；无数据迁移；改动未提交 git。

---

## [2026-10-28 BY Qoder] 阶段 46补1：设置页「包含能力」控制卡（模型级，不拆进程）

- **文件改动**：`app/src/pages/SettingsPage.tsx`（GPT-SoVITS 卡新增包含能力列表 + 刷新/全部卸载 + 状态/单独卸载；「本地服务」描述改五个运行时）、`app/src/lib/vc.ts`（`svcApi.unloadModel`）、`PROGRESS.md`、`HANDOFF.md`（坑 107 补注）、本 changelog。
- **行为变化**：设置页 GPT-SoVITS 卡内显示 GPT-SoVITS / RVC / DDSP-SVC / ASR / UVR5 的 `已加载 / 未加载 / 按需`，每行可单独卸载；「全部卸载」调 trainer `/v1/engines/unload`。状态分别读 `health.pipeline`、`/v1/vc|svc|asr/pipeline`。这是**模型级**控制，不停止 :9881 进程；加载仍在各功能页。
- **验证**：浏览器实测设置页显示 GPT-SoVITS `已加载`、RVC/DDSP/ASR `未加载`、UVR5 `按需`；typecheck / build / eslint 全绿。**未点击卸载**，避免改变用户当前常驻的 GPT-SoVITS 模型。
- **对其他 Agent 的影响**：仅新增设置页 UI 与 `svcApi.unloadModel` 客户端；不改变服务路由/进程模型；`/v1/svc/models/unload` 端点原本已存在。真正进程拆分未做。
- **回滚方式**：回滚上述前端文件即可；无数据迁移；改动未提交 git。

---

## [2026-10-28 BY Qoder] 阶段 46：Irodori 语气提示 + IndexTTS 文本分段/分段情感编排

- **文件改动**：前端 `app/src/pages/IrodoriTtsPage.tsx`、`app/src/pages/IndexttsTtsPage.tsx`、`app/src/lib/indextts.ts`、`app/src/types/indextts.ts`；IndexTTS 服务 `indextts/app/api.py`；文档 `PROGRESS.md`、`HANDOFF.md`（坑 106）；回归 `.tmp/verify_indextts_segments.py`（未跟踪）。
- **行为变化**：① Irodori 日语合成页文本区下方新增可见中文提示（🤭 偷笑 / 😮‍💨 叹气 / 😆 / 😭 / 🥱；句中/句尾都生效、修饰前一句、不改音色），emoji 按钮改为**插入光标位置**；② IndexTTS 新增 `POST /v1/synth/segments`：每段独立 8 维情感向量/null + 强度，参考音频/语言/时长系数全局，段间 `gap_ms` 0~1000（默认 120）、每段首尾 5ms 淡入淡出，服务端拼接；③ IndexTTS 页新增「单段合成 / 分段情感（按段拼接）」页签，分段编辑器支持增删段、每段预设情感 + 强度、段间停顿；④ 单段/分段共用 `resolveRefUpload`。
- **操作记录**：**未启动/重启任何服务，未占用 GPU**。当前 GPU 约 0.9GB 空闲，IndexTTS 需 ~5.5GB，真机分段合成未跑；新增端点需重启 IndexTTS 服务才会加载。
- **验证**：typecheck / build 全绿；改动文件 eslint 无报错；IndexTTS venv `py_compile` 全绿；离线 `.tmp/verify_indextts_segments.py` **10/10**（解析/空段/坏向量/超限/两段 1s+100ms gap 拼接 2.1s/产物存在）；浏览器实测 Irodori 提示可见、IndexTTS 页签与分段编辑器正常（添加一段后 2/20）。
- **对其他 Agent 的影响**：IndexTTS 新增一个**加法**端点，旧 `/v1/synth` 契约不变；分段模式不支持 per-segment 情感参考音频（`emo_file` 仍只单段）；Irodori emoji 按钮行为从追加末尾变为插入光标。真机验收需腾显存并重启 IndexTTS。
- **回滚方式**：回滚上述文件即可；`/v1/synth/segments` 与前端分段 UI 均为新增，无数据迁移；改动未提交 git。

---

## [2026-10-28 BY Qoder] 阶段 45：GPT-SoVITS 本地合成迁到批量页 + 纯 .pth 单权重 + 显存预估修复

- **文件改动**：前端 `SovitsWeightPicker.tsx`（新）、`BatchPage.tsx`、`SynthesisPage.tsx`、`SettingsPage.tsx`、`VoiceDesignPage.tsx`、`VoiceClonePage.tsx`、`App.tsx`、`AppShell.tsx`、`lib/resources.ts`、`ResourceBudget.tsx`、`types/sovits.ts`；网关 `services/modelRegistry.ts`；trainer `app/api.py`、`app/discovery.py`、`app/sovits/weight_meta.py`（新）、`app/sovits/pipeline.py`、`app/sovits/worker/server.py`；文档 `PROGRESS.md`、`HANDOFF.md`（坑 101/102）、`docs/VOICE-MODEL-MANAGEMENT-PLAN.md`、本 changelog；回归 `.tmp/verify_sovits_pair.py`（未跟踪）。
- **行为变化**：① 通用合成固定 MiMo；GPT-SoVITS 本地合成与权重选择迁到批量合成页（零样本 / 只选 `.pth` / 成对）；② 设置页删除后端选择器，只留 MiMo API Key 与可选接口地址；③ 音色库 GPT-SoVITS 分类允许纯 `.pth`（同目录一个 `.ckpt` 时 `.pth` 仍算配套）；④ `/v1/weights` 合并 `models/gpt-sovits`，按文件头识别版本；⑤ worker 单侧缺权重时显式配同版本预训练底模，版本不符 400 `WEIGHT_VERSION_MISMATCH`；⑥ 批量页显存预估改用 `/health.pipeline.loaded`，不再重复扣 3GB；trainer 任务页不再显示「关闭 GPT-SoVITS 服务」；⑦ 批量页新增跨语种警告（参考音频语种 ≠ 文本语种时提示可能提前截断）；⑧ 修复批量单条结果下载按钮：状态存原始 `/files/...`、渲染/下载各解析一次，`resolveAudioUrl` 对已带 `/api/` 的地址幂等（旧双前缀 404）；⑨ 批量页参考音色旁新增「导入参考音频」（上传/拖拽/本机路径 + 名称/逐字转写/语种/智能转写），保存后写共享 voicelib 并自动选中；Dialog 加 key 强制卸载，避开 Radix exit 动画偶发卡住；⑩ 修复音色库语种下拉全选/选不中：`/v1/catalog` 的 `languages` 用 `code` 而前端契约用 `id`，`sovitsApi.catalog()` 归一成 `id`，后端 `LANGUAGE_PRESETS` 也补了 `id`；⑪ RVC/SVC 资源卡改为读各自 `/v1/vc|svc/pipeline.loaded`，文案按任务显示；「只跑这一个模型」/「释放常驻显存」在目标模型未加载时额外调 trainer `/v1/engines/unload`，释放同属 :9881 的 GPT-SoVITS 等引擎。
- **操作记录**：**真实 GPU 操作**——通过运行中的 :9881 用 `models/gpt-sovits/SoVITS_weights_v2ProPlus/Mujica_Mortis_v2pp.pth` 跑了一条批量合成（参考音色 `842e1988abc8`「男 5.4s」，文本「テスト一文です。」），1/1 成功、2.58s 音频；随后为排查用户 0.74s 短音频做了多组参考/权重交叉测试，**当前常驻权重已恢复为用户选择的 `刺团_仁菜_v2pp.ckpt + .pth`**（free 约 908MB）。另经 `PATCH /api/voicelib/d0022a9286cc` 把仁菜音色的 `prompt_lang` 从 `zh` 修正为 `ja`（ASR 确认参考音频是日语）。**导入功能真机验证**：在批量页用本机路径 `voicelib/voices/d0022a9286cc.wav` 创建临时音色 `5fea0cdafac2`（成功自动选中），随后已通过 `DELETE /api/voicelib/5fea0cdafac2` 删除，库内保留 3 条。未重启/关闭任何服务，未改动用户的三方程序。
- **验证**：typecheck / build 全绿；改动文件 eslint 无报错；py_compile 全绿；离线配对 8/8；`/api/models?category=gpt-sovits` 16 个模型；`/v1/weights` gpt 2 + sovits 16；浏览器实测批量页「模型已常驻显存」且无关闭服务按钮、微调下拉 16 个模型库权重、设置页只剩 MiMo Key；`.tmp` 批次产物 `trainer/.data/outputs/batch/f20b49495989/`。**短音频排查**：同仁菜权重 + 「男」参考（zh）→ 中文 3.78s / 日文 4.22s 正常；仁菜参考（ja）+ 仁菜权重 + 中文 → 0.74s；仁菜参考 + Roselia 权重 + 中文 → 5.02s。结论是仁菜参考（6.7s 动漫台词）与中文目标的组合触发提前 EOS，不是权重或批量链路坏。**下载修复验证**：`/api/sovits/files/batch/1bc64d7a7ec0/audio/000-.wav` 200，旧双前缀 `/api/sovits/api/sovits/files/...` 404；typecheck/eslint 通过。**语种下拉验证**：浏览器实测修复前 6 个选项全部 `data-state=checked`，修复后仅「中文」checked，点击「日本語」后触发器正确显示日本語（options 列表关闭）。**RVC 资源卡验证**：浏览器实测 RVC 页文案已变为「本地推理服务已启动，但 RVC 变声模型尚未加载」，RVC 实际 `loaded=false`、free 0.6GB / 需 2.5GB（警告正确）；未点击「只跑这一个模型」，以免卸载用户当前常驻的 GPT-SoVITS。
- **对其他 Agent 的影响**：生产路由/端口未变；MiMo 三页不再读全局 `providerId`；批量页请求新增可选 `version/gpt/sovits`；GPT-SoVITS 权重目录新增 `models/gpt-sovits/**` 的 `.pth` 会被 `/v1/weights` 列出。**当前已加载模型是仁菜 pair**；如需换权重在批量页选择后加载，或在显存监控卸载。仁菜音色 `prompt_lang` 已改为 `ja`，音色库/批量页需刷新后生效。
- **回滚方式**：回滚上述文件即可；`weight_meta.py`/`SovitsWeightPicker.tsx` 是新增文件。无数据迁移；不涉及删除。改动未提交 git。

---

## [2026-11-04 12:12 BY Qoder] B站 CosyVoice 3 两条总结同步进 TTS 图谱

- **文件改动**：`knowledge-atlas/js/data.js`（`tts-models.sections` 追加 2 个 B站选读块，+22 行）；`knowledge-export/01-参考书-主流 TTS 模型.md`（重编译，+16 行）；其余 `knowledge-export/*` 被 build.js 重写但内容无变化（仅行尾，`git diff --numstat` 为 0）；`AGENT_CHANGELOG.md`。
- **操作记录**：主中枢 `core/knowledge_syncer.py` 的 voice 插入逻辑已修正（原先用 aiPainting 的 `sub/parentIdx`，ttstool atlas 不支持；改为定位 `tts-models.sections` 数组末尾插入）；同步 `BV1VYH66bE1b`（Mac mini 本地 CosyVoice 3 实测）与 `BV165Mk6GENx`（本地 TTS 选型对比）。`node -e require(data.js)` 通过；`node knowledge-export/build.js` 10 份手册全部通过。未启动任何服务。
- **对其他 Agent 的影响**：TTS 图谱的 `tts-models` 现有 12 个子块，新增两条 B站选读；ttstool 生产代码/路由/页面未改；ttstool 工作区仍有他人未提交改动，**本次未提交**；`knowledge-atlas/index.html` 无 `?v=` 缓存参数，无需递增版本。备份：`.tmp/data.js_pre_bili_sync_20261104.js`。
- **回滚方式**：`cp .tmp/data.js_pre_bili_sync_20261104.js knowledge-atlas/js/data.js` 后重跑 `node knowledge-export/build.js`；或从 data.js 删除两个 `BV1VYH66bE1b` / `BV165Mk6GENx` 选读块。

## [2026-10-26 14:40 BY Qoder] SaSTranslater 已内聚 Moonshine 8 段 ASR（ttstool 保留可选对比）

- **文件改动**：ttstool 生产代码无改动；仅本 changelog 记录。ttstool `.tmp/ja_bench` 的 Moonshine 实验脚本/素材保留为历史来源。
- **操作记录**：SaSTranslater 新建 `scripts/ja_stream_asr.py` + `asr-moonshine-venv`，复制 Moonshine 模型缓存（148MB）与 8 段素材（2.2MB）到其本仓（均 gitignored）；本地单段 13.3s、8 段 ASR+桥离线 2m8s 通过；未启动任何服务。
- **对其他 Agent 的影响**：SaSTranslater 实时路线不再需要 ttstool；ttstool 仅保留 OPEN-API 网关/R2T2/SenseVoice 等可选跨模型对比。ttstool 端口/服务/生产路由未变。
- **回滚方式**：无生产代码回滚；如需恢复耦合，SaSTranslater 侧删除本地脚本/venv/模型/素材即可。

## [2026-10-26 14:10 BY Qoder] Moonshine 8 段流式循环真实中文翻译验证（7B 用户授权）

- **文件改动**：更新 `.tmp/ja_bench/moonshine_translate_8.jsonl`（真实中文输出）；`AGENT_CHANGELOG.md`。实验脚本 `.tmp/ja_bench/ja_moonshine_translate.py` 本轮未改。
- **操作记录**：用户授权 14:07 启动 7B（Qwen2.5-7B-abliterated Q4_K_M，PID 52552，:8081，c=2048）；跑 8 段 Moonshine small-streaming-ja（update=1.0，vad=0.3）+ `TranslationBridge`；**8/8 final → 8/8 `stop`、0 回退**，翻译延迟 710-1366ms；ASR 墙钟 2m11s；14:10 停止，8081 关闭、显存回落 2837MiB。未改生产 ASR 路由/端点/页面。
- **对其他 Agent 的影响**：实验链路验证完成；`.tmp` 脚本仍是未跟踪实验文件，**未提交**；生产 JA 流式 ASR 入口尚未接入。运行期间 CPU 约 20 线程 + 7B GPU，现已释放。
- **回滚方式**：删除 `.tmp/ja_bench/ja_moonshine_translate.py` 与 `moonshine_translate_8.jsonl`（回收站/留痕）；服务已停止，无生产代码回滚。

## [2026-10-26 13:20 BY Qoder] Moonshine 8 段流式循环接入 SaSTranslater 翻译桥（实验）

- **文件改动**：新增 `.tmp/ja_bench/ja_moonshine_translate.py`（实验脚本，未入生产 `scripts/`）；新增 `.tmp/ja_bench/moonshine_translate_8.jsonl`（离线回退运行结果）。未改生产端点、页面、ASR 路由或配置。
- **操作记录**：复用 `ja_moonshine_bench.py` 的 8 段 Moonshine small-streaming-ja 循环（update=1.0，vad=0.3），每个 final line 通过 SaSTranslater `scripts/asr_bridge.py` 的 `TranslationBridge` 提交到 `sas-cli --translate-jsonl`；离线运行（8081 未启动，`--timeout 1`）得到 8/8 final、8/8 `timeout` 回退，`bridge idle=True pending=0`，说明 ASR→桥→响应链路打通。ASR 8 段墙钟约 2m17s（CPU 约 20 线程）。
- **对其他 Agent 的影响**：仅 `.tmp` 实验产物；生产 ASR 路由/端口/页面未变；未启动任何服务。真实 7B 中文输出待用户授权 GPU 窗口后重跑。
- **回滚方式**：删除 `.tmp/ja_bench/ja_moonshine_translate.py` 与 `moonshine_translate_8.jsonl`（回收站/留痕）；无生产代码回滚。
- **备注**：ttstool 工作区仍有他人未提交改动，本次不提交；桥模块本体在 `F:\schoolCompWorks\clone\SaSTranslater\scripts\asr_bridge.py`（已随 SaSTranslater 阶段 23 提交）。

## [2026-10-26 00:30 BY Qoder] 日语流式 ASR 基准与 Qwen 接入交接文档

- **文件改动**：新增 `docs/JA-ASR-STREAMING-HANDOFF.md`（工作汇报 + Qwen2.5-7B 接入计划 + 交接清单）；实验脚本/结果/venv 均在 `.tmp/ja_bench/`、`.tmp/moonshine-venv/`、`.tmp/vad-venv/`（未改生产代码）。
- **原因**：用户要求把「Moonshine small-streaming-ja + 外部 VAD 句子级流式」的结论沉淀给负责 Qwen 翻译板块的 Agent，明确哪些路线已排除、哪些数字可引用。
- **结论摘要**：场景 1 外部 VAD + 句子级流式整章 CER **15.02%**（388/2583 字）；speech-only RTF **1.373**、session RTF **0.755**；oracle 句边界 15.44%；SenseVoice 离线整章 10.1%。UVR5/频谱减噪/片段分类器均未把 BGM/SE 清到可实时；连续 17 分钟整章流未跑完，不能整章灌。
- **对其他 Agent 的影响**：未改任何生产端点/页面/引擎行为；Moonshine 只装于 `.tmp` venv，权重在用户缓存 `C:\Users\kevin\AppData\Local\moonshine_voice\`，非生产依赖；Moonshine Community License 为非商业。Qwen 翻译接入必须以 final line 为输入、不消费 partial、不改 ASR 路由。
- **验证**：8 段基准、oracle 整章、外部 VAD 整章、UVR5/减噪/分类器试点均有 JSON/日志在 `.tmp/ja_bench/`；本次没有启动 Qwen/llama-server，端到端翻译待负责 Agent 实测。
- **回滚方式**：删除 `docs/JA-ASR-STREAMING-HANDOFF.md` 与 `.tmp/ja_bench`/两个 `.tmp` venv（回收站/留痕）；无生产代码或数据迁移。

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

# AGENT_CHANGELOG —— 外部共享目录改动记录（ttstool）

> 本仓库经 `link_ttstool` Junction 被 `Mega-Scale AI Workflow Integration Project` 引用，**可能同时有多个 Agent 在此工作**。
> 规范：任何 Agent 对本仓库的改动或服务操作，必须在本文档追加记录（**倒序，最新在上**），注明时间、Agent、改动内容、原因、验证、回滚方式与对其他 Agent 的影响。
> 相关规范见本仓库 `AGENTS.md`「外部共享约束」节与主中枢 `AGENTS.md` 第二节核心红线「外部共享目录改动记录」。

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

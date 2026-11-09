# AGENTS.md（voice-workbench 仓库级约定）

本地语音工作台：前端（`app/` React 19）+ Node 网关（`server/`）+ 六个 Python 运行时（`trainer/` GPT-SoVITS、`netease/`、`indextts/`、`irodori/`、`gsv5/`、`cosyvoice/`）。纯本地部署，无线上产物。

接手开发前先读 `HANDOFF.md`（环境路径 / 分支 / 已知坑 / 命令）与 `PROGRESS.md`（阶段台账，按 `token-efficient-agent-workflow` 维护）；方案与评估文档在 `docs/`。
**只借用本工作区模型能力（TTS/ASR/变声/分离）的 Agent，先读 `docs/AGENT-GUIDE.md`**：能力发现、Open API / CLI、显存互斥与共享工作区红线。

## Agent skills

### Issue tracker

Issues live in GitHub Issues（`Gorilla-Kevv/voice-workbench`），全部经 `gh` CLI 读写。See `docs/agents/issue-tracker.md`.

### Triage labels

使用五个规范角色同名标签（`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`）。See `docs/agents/triage-labels.md`.

### Domain docs

Single-context：根 `GLOSSARY.md` + `docs/adr/`（当前尚不存在，由 `/domain-modeling` 在术语与决策实际敲定时懒创建，勿提前建空壳）。See `docs/agents/domain.md`.

## AI 声音知识图谱与知识导出（knowledge-atlas / knowledge-export）

对齐 `aiPaintingKownledge` 知识库标准体系：
- **核心数据源**：`knowledge-atlas/js/data.js` 与 Web 交互门户 `knowledge-atlas/index.html`；
- **Markdown 规范手册包**：`knowledge-export/*.md`（覆盖 TTS 主流模型、ASR、RVC 声音克隆、AI 翻唱、音频工程与排障）；
- **编译与同步**：知识变更后执行 `node knowledge-export/build.js` 重新生成手册；
- **外部调研接入**：bili-duty skill 的检索产出在 `F:\schoolCompWorks\cloneili-duty-local\data\summaries`，其中 **`ai voice` 子目录是本项目要的路径**——调用 bili-duty 的场景，结果从这里读取。
- **收集缓存与整合流程**：手动收集物放 `knowledge-inbox/`（gitignore）；触发整合时走五步流程：分析文件 → 产出报告 → 验证可行性 → 横向对比 → 整合进 data.js → `node knowledge-export/build.js`。流程细则见 `knowledge-inbox/README.md`。

## 外部共享约束（多 Agent 共享目录，2026-10-24 新增）

- 本仓库经 `link_ttstool` Junction 被主中枢（Mega-Scale AI Workflow Integration Project）引用，**可能同时有多个 Agent 在此工作**；任何改动必须留痕仓根 `AGENT_CHANGELOG.md`（倒序，最新在上）。
- **主中枢对本仓的合法操作仅限四类**：① 只读 `knowledge-export/*.md` 检索；② 经 `core/knowledge_syncer.py` 将 B 站 `ai voice` 总结按追加式规则挂载进 `knowledge-atlas/js/data.js` → `node knowledge-export/build.js` 重编译 → 递增前端版本号；③ 读取本仓 `AGENTS.md` / `HANDOFF.md` 规范；④ **经回环 HTTP 调用 `/api/open/*` 使用已部署模型能力**（推理类计算调用，不算写操作；契约见 `docs/OPEN-API.md`，显存门槛/互斥语义务必先读）。其余写操作必须按本仓阶段流程立项，不得借道中枢直接改。
- **独立仓库边界**：本仓改动只在本仓提交；严禁把本仓文件提交进主中枢仓库，反之亦然。
- **大资产保护**：`models/`、`GPT-SoVITS-v2pro-20250604/`、`vendor/`、`node_modules/` 严禁删除或移动（清理只进回收站并留痕）。
- **GPU 互斥**：`trainer/` 训练与 TTS / 变声类推理占用 GPU，与 llama-server（localmodels）、ComfyUI（E:\ai绘图）共享 8GB 显存且互斥，拉起前必须确认显存归属。

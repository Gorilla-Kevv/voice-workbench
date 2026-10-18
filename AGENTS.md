# AGENTS.md（voice-workbench 仓库级约定）

本地语音工作台：前端（`app/` React 19）+ Node 网关（`server/`）+ 四个 Python 运行时（`trainer/` GPT-SoVITS、`netease/`、`indextts/`、`irodori/`）。纯本地部署，无线上产物。

接手开发前先读 `HANDOFF.md`（环境路径 / 分支 / 已知坑 77 条 / 命令）与 `PROGRESS.md`（阶段台账，按 `token-efficient-agent-workflow` 维护）；方案与评估文档在 `docs/`。

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

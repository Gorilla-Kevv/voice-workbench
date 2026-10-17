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

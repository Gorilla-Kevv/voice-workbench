# 前端（app/）

React 19 + TypeScript + Vite 7 + Tailwind CSS 3 + shadcn/ui。

```bash
npm run dev        # 开发服务器 http://localhost:5173（/api 由 Vite 代理到网关 :8787）
npm run build      # 产出 dist/，由网关静态托管
npm run typecheck  # 类型检查
```

完整的项目说明、架构与使用流程见仓库根目录的 [`../README.md`](../README.md)。

## 两条链路

界面同时服务两个模型，切换发生在「设置 → 语音模型与语言」：

| 目录 | 说明 |
| --- | --- |
| `src/lib/providers/` | Provider 抽象层：`mimo`（云端）/ `gpt-sovits`（本地）/ `selfhosted`（自定义服务） |
| `src/lib/api.ts` | MiMo 链路客户端（含 `direct` 模式，供纯静态托管复用） |
| `src/lib/sovits.ts` | GPT-SoVITS 本地服务客户端（含 NDJSON 流式解析、音频地址映射） |
| `src/types/sovits.ts` | 与 `trainer/app/models.py` 一一对应的契约类型 |

新增模型时只需要：实现一个 `TtsProvider` → 在 `providers/registry.ts` 注册 → 完成。
上层页面（合成 / 声音克隆）不需要改动。

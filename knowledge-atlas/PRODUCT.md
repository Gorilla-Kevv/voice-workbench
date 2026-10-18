# PRODUCT.md — AI 声音知识图谱

## 产品
voice-workbench 的知识层：静态单页站（GitHub Pages），把 `js/data.js` 里的声音领域知识呈现给人与 Agent。

## 用户与成功形态
- **维护者（主）**：快速查阅引擎结论、实测数据、版本情报；Read 模式成功 = 为理解结构化 + 阅读值得停留。
- **AI Agent（次）**：作为知识查询源被引用；结构稳定、数据新鲜（与仓库 data.js 同步）。

## 表面
- 单页三视图：**篇目**（7 篇参考书）、**术语**（22 条速查）、**资源**（13 项官方仓库）——data.js 的三块数据都应有一等视图。
- 全局搜索贯穿三视图；hash 路由可分享；移动端可用。

## 内容源
`knowledge-atlas/js/data.js`（由 `knowledge-export/build.js` 从 SECTIONS/GLOSSARY/RESOURCES 维护）；更新走 knowledge-inbox 五步流程。

## 非目标
不做登录、后端、评论、内容编辑——数据只经仓库流程变更。

## 视觉世界
**Linear**（templates/linear.app）：canvas #010102、碳面板、发丝边框、薰衣草蓝 #5e6ad2 单强调、Inter 负字距。高密度克制，无装饰性用色。

---
version: 1
slug: "knowledge-atlas"
primary_target: "knowledge-atlas"
related_targets: []
---

# Surface brief — knowledge-atlas 交互门户(替换世界)

范围与访客模式:静态单页站(`knowledge-atlas/index.html` + `js/data.js` 三视图:篇目 7 / 术语 22 / 资源 13),Read 模式。
受众与任务:维护者(主)快速查阅引擎结论、实测数据、版本情报;AI Agent(次)作结构化知识源。约束:保留 hash 路由、全局三源搜索、`/` 聚焦、移动端可用、`renderInline` 安全渲染、data.js 契约不动。

## Direction contract

**THESIS**:整座声音知识库排成一册高密度总簿——每条事实短、硬、可查,卷号与栏线是唯一的装饰;拒绝"侧栏 + 单栏英雄文"的文档站默认排布。

**OWN-WORLD**:纸面 `#f2efe6` 地 + 墨黑 `#191713` 双色印刷;墨蓝 `#2f4470` 只给卷首横幅(吃真实版面)与结构强调;朱砂 `#a63c2a` 只给印章、耳标、要目点缀;Noto Serif SC 衬线承担站名/卷次/条目标题,Noto Sans SC 承担正文,JetBrains Mono 只做条号与代号;深度语言只有 hairline 栏线与双线规则,无阴影。五位落选挑战者各捐一条纪律:连续条号(§001 起)、纸边"读到此页"耳标、卷间深色隔页带、状态标签全带文字不靠色相、主色占真版面。

**STORY**:维护者把总簿当速查卷宗——左栏卷次总目定位,右栏双栏密排扫读,表格与公式块是事实核心;术语=辞海,资源=资源簿;读完一卷,纸边耳标记进度。

**FIRST VIEWPORT**:1440 宽:墨蓝横幅(站名衬线 900 + 卷号行 + 朱砂方章)→ 全黑隔页带 → 236px 卷次总目 + 双栏正文(§001 数字音频基础、表 1 采样率速查、公式 callout),右缘朱砂耳标,底部页脚栏。签名交互:条号边栏 + 耳标随路由更新。

**FORM**:年鉴/总簿(我方接地候选第 7 位,决策页 assigned-almanac 锁定);seed:25c52c7cf6f1dc33

**FINISH**:unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.

未决:双栏在极窄条目(大表)下的断列策略,构建时以 `break-inside: avoid` + 列内自适应验证。

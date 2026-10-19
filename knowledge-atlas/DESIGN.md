---
name: AI 声音知识图谱 · 知识总簿
description: 纸面年鉴体知识总簿——暖纸地、墨黑 + 朱砂双色印刷、墨蓝卷首横幅、栏线即深度；为 voice-workbench 的声音领域知识提供可速查的卷宗式阅读。
colors:
  paper: "#f2efe6"
  paper-raised: "#ece8da"
  paper-sunken: "#e2ddcb"
  ink: "#191713"
  ink-secondary: "#4a4536"
  ink-tertiary: "#6e6858"
  indigo: "#2f4470"
  indigo-deep: "#24365a"
  indigo-tint: "rgba(47, 68, 112, 0.08)"
  vermilion: "#a63c2a"
  vermilion-paper: "#f6f0e4"
  hairline: "rgba(25, 23, 19, 0.25)"
  hairline-soft: "rgba(25, 23, 19, 0.14)"
typography:
  display:
    fontFamily: "Noto Serif SC, Songti SC, serif"
    fontSize: "44px"
    fontWeight: 900
    lineHeight: 1.15
    letterSpacing: "0.06em"
  headline:
    fontFamily: "Noto Serif SC, Songti SC, serif"
    fontSize: "28px"
    fontWeight: 900
    lineHeight: 1.3
    letterSpacing: "0.02em"
  title:
    fontFamily: "Noto Serif SC, Songti SC, serif"
    fontSize: "18px"
    fontWeight: 700
    lineHeight: 1.45
  body:
    fontFamily: "Noto Sans SC, Microsoft YaHei, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.78
  label:
    fontFamily: "JetBrains Mono, ui-monospace, Consolas, monospace"
    fontSize: "11px"
    fontWeight: 700
    letterSpacing: "0.28em"
  data:
    fontFamily: "JetBrains Mono, ui-monospace, Consolas, monospace"
    fontSize: "12px"
    fontWeight: 400
    fontFeature: "tabular-nums"
rounded:
  xs: "2px"
  sm: "6px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  xxl: "32px"
  section: "48px"
components:
  banner-masthead:
    backgroundColor: "{colors.indigo}"
    textColor: "{colors.paper}"
    typography: "{typography.display}"
    height: "auto"
  toc-link:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    padding: "8px 4px"
  toc-link-active:
    backgroundColor: "{colors.indigo-tint}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    padding: "8px 4px"
  input-search:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.xs}"
    padding: "8px 12px"
  entry-tag:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.xs}"
    padding: "0 8px"
  earmark-bookmark:
    backgroundColor: "{colors.vermilion}"
    textColor: "{colors.vermilion-paper}"
    typography: "{typography.label}"
    padding: "8px 12px 8px 16px"
---

# Design System: AI 声音知识图谱 · 知识总簿

## Overview

**Creative North Star: "一册值得传家的声音总簿"**

这个世界把整座声音知识库排成一册高密度印刷总簿：暖纸地上只有墨黑与朱砂两色印刷，墨蓝只出现在卷首横幅——让它吃掉真实版面，而不是做细线点缀。每条事实短、硬、可查，连续条号（§001 / ¶01 / R-01）、栏线、卷次编号是唯一的装饰系统；深度不用阴影，只用 hairline 栏线与纸面的两级抬升。阅读列保持文档本分（黑体正文、真实对比度、约 35em 的双栏密排），世界住在框架里：横幅、卷次总目、页眉页脚、表格与公式的排印方式。

**Key Characteristics:**
- 暖纸地 `#f2efe6` + 墨黑 `#191713` 的双色印刷纪律；朱砂 `#a63c2a` 是印章/耳标/计数的专属墨，永不铺底。
- 墨蓝 `#2f4470` 只给卷首横幅、链接与表格斑马纹的结构性暗示。
- 无阴影：深度 = hairline（墨 25%/14% 两档）+ 2px 实线规则 + 纸面两级抬升。
- 连续条号 apparatus 贯穿三视图（篇目 §N、辞海 ¶NN、资源簿 R-NN、分部 部N、表 N）。
- 衬线（Noto Serif SC 900/700）只做标题与卷次；正文一律黑体；等宽（JetBrains Mono）只做条号、代号、URL 与数据。
- 状态标签永远带文字（现役主流 / 经典架构 / 偏旧参考），颜色永不单独表意。

## Colors

四墨双色印刷：纸、墨、蓝、朱砂，加三档墨灰做文字层级。全部前景/背景配对经 WCAG 校验 ≥4.5:1。

### Primary
- **墨蓝 Indigo** (#2f4470): 卷首横幅的整版底色、导航卷次代号、正文链接、表格斑马纹的 tint 来源（8% 透明度）。深一档 #24365a 做链接 hover。它是结构之墨——出现在哪，哪里就是"框架/可点"。

### Secondary
- **朱砂 Vermilion** (#a63c2a): 印章描边、"读到此页"耳标、搜索命中计数、要目编号、套印方点。它的稀缺即语义：看见朱砂 = 看见 apparatus 或"你在这里"。文字在其上用 #f6f0e4。

### Neutral
- **纸 Paper** (#f2efe6): 全站地面。
- **抬升纸 Paper Raised** (#ece8da): 卷次目录栏、callout 底、行内 code 底。
- **沉纸 Paper Sunken** (#e2ddcb): hover 反馈、滚动条拇指。
- **墨 Ink** (#191713): 正文与标题文字、2px 实线规则、黑隔页带。
- **次墨 Ink Secondary** (#4a4536): 摘要与次要正文（8.3:1）。
- **三墨 Ink Tertiary** (#6e6858): 条号、图注、页脚（4.8:1，勿再浅）。
- **栏线 Hairline** (rgba(25,23,19,.25)) / **弱栏线** (.14): 全部 1px 分隔。

### Named Rules
**双色印刷 Rule.** 版面只有墨与朱砂两种"印刷色"；任何第三色只能以墨蓝的结构角色进入，且永不与朱砂同版争抢。
**横幅吃版 Rule.** 墨蓝横幅占据真实版面（约视口 1/5 高），是全站最大的色块——主色的存在感靠面积，不靠描边。

## Typography

**Display Font:** Noto Serif SC（Songti SC 兜底）——900/700 两档，只做站名、卷次、条目标题。
**Body Font:** Noto Sans SC（Microsoft YaHei 兜底）——400 一档承担全部正文。
**Label/Mono Font:** JetBrains Mono——条号、代号、URL、表格首列数据；永不用于正文与标题。

**Character:** 衬线黑重、字距微张（+0.06em），是铅印书名的声音；正文黑体 14px/1.78 密排，像词典正文一样安静。

### Hierarchy
- **Display** (900, 44px, 1.15, +0.06em): 仅卷首横幅站名。
- **Headline** (900, 28px, 1.3): 各视图标题（入门基础 / 辞海 / 资源簿）。
- **Title** (700, 18px, 1.45): 条目标题与分部标题，与 §N/部N 条号同基线。
- **Body** (400, 14px, 1.78): 正文，双栏约 35em；起点对齐——窄栏两端对齐遇长 token 会拉出巨缝，本系统明确弃用 justify。
- **Label** (500-700, 11px, +0.28em, 大写拉丁): 卷号行、眉批、 apparatus 标签。正文字距恒为 0。

### Named Rules
**字阶五级 Rule.** 字号只有 11/14/18/28/44 五级（步距 ≥25%），新层级先并级再加级。
**正文无字距 Rule.** letter-spacing 只属于等宽 apparatus 标签；正文与标题的中文不加拉字距。

## Layout

总簿开本：最大 1440px，左 264px 卷次总目 + 右正文的双栏栅格；目录栏 sticky 跟随。正文区双栏密排（`columns: 2`，栏距 48px，栏间 1px 栏线），≤1100px 收单栏，≤900px 目录栏转为顶部换行 chips、正文单栏，≤640px 横幅纵排、资源簿行收为两行。间距取 4/8/12/16/24/32/48/64 刻度；组间距（24px）恒大于组内行距（12px）。三断点：1100 / 900 / 640。

## Elevation & Depth

无阴影系统。深度由三件事承担：① 纸面两级抬升（目录栏/面板用 #ece8da，地面 #f2efe6）；② hairline 栏线（25% 墨为界、14% 墨为内分隔）；③ 2px 实线规则标记级界（视图头下、表头上下、分部标题下）。唯一越出纸面的元素是朱砂耳标（fixed 定位，撕票口 clip-path），它是"夹在书页上的签"，不是浮层。

## Shapes

小圆角世界：控件 2px（输入框、标签、计数徽章），印章 6px；其余全是直角。线语言只有三种：1px 弱栏线、1px 栏线、2px 实线规则。唯一的多边形裁切是耳标的撕票口（`clip-path: polygon` 左缘箭口），属于纸世界自身的材料行为。

## Components

### 卷首横幅 banner-masthead
- **Shape:** 直角，下缘 3px 墨线；内边距 32/48/24。
- **Primary:** 墨蓝整版底 + 纸色文字；左为卷号行（mono 11px +0.32em）→ 站名（衬线 900 44px）→ 副题（14px）；右为朱砂方章（88px，rotate 4deg，双行"声音/总簿"）。
- **States:** 无交互。

### 卷次总目 toc
- **Style:** 抬升纸底、右缘 1px 栏线；条目为 卷次代号（mono 蓝）+ 标题（14px）三列网格，1px 弱栏线分隔。
- **Hover:** 沉纸底。**Active:** 墨蓝 8% tint + 底缘转实墨线 + 加粗 + 卷次代号转朱砂；`aria-current="page"`。
- **搜索命中:** 条目右侧朱砂计数徽章（mono 11px，纸色字）。
- **移动端:** ≤900px 转为换行 chips（1px 栏线描边、2px 圆角）。

### 检索 input-search
- **Style:** 纸底、1px 栏线、2px 圆角；placeholder 三墨。
- **Focus:** 墨线边框 + 2px 墨蓝 outline（offset 1px）；光标朱砂。
- **Result:** 下方 mono 11px 计数行（"命中 N 处（篇目 X / 辞海 Y / 资源簿 Z）"或"无命中"）；`/` 键全局聚焦。

### 条目 entry
- **Shape:** 无盒——条目是排版单元不是卡片；标题行 = §N（mono 三墨）+ 衬线标题 + 状态标签（1px 墨框 2px 圆角，恒带文字）。
- **Body:** 黑体 14px/1.78，起点对齐；`<b>` 加粗、行内 code 抬升纸底。
- **表:** 表号行（mono 11px 加粗）→ 表格：表头 2px 墨线上下界、行 1px 栏线、偶行墨蓝 4% tint、首列 mono tabular-nums；外裹横向滚动容器。
- **公式 callout:** 1px 墨框 + 抬升纸底 + 朱砂方点 + 〔标题〕衬线朱砂 + 正文；`break-inside: avoid`。

### 资源簿行 res-row
- **Shape:** 簿式三行条目（命名 grid areas）：第一行 R-NN + 名称 + 箭头 SVG，第二行描述独占整行，第三行 URL；1px 弱栏线分行，`break-inside: avoid`。
- **禁止回退五列并排**：双栏密排下每栏只有 ~436px，`nowrap` 的名称列 + URL 列会把 `1fr` 描述列挤成 0 宽（文字一字一行竖排）——这是本项目踩过的真坑。
- **Hover:** 墨蓝 8% tint，箭头转朱砂。URL 允许 `overflow-wrap: anywhere` 断行；外链一律 `target="_blank" rel="noopener noreferrer"`。

### 耳标 earmark-bookmark
- **Style:** fixed 右缘（bottom 72px），朱砂底、纸色字、+0.22em 字距，撕票口 clip-path；文本 = "读到此页 · {当前卷}"，随路由更新；≤900px 隐藏。
- **注意:** 必须是 `<body>` 直接子元素——放进带 transform 动画的容器会被劫持 fixed 包含块（本项目踩过）。

### 页脚 site-foot
三段式（站名 / 数据源 mono / 当前卷），1px 墨线上界，11px +0.14em 三墨。

## Do's and Don'ts

### Do:
- **Do** 让每条内容挂连续条号（§/¶/R-/部/表），条号是本系统可被引用的骨架。
- **Do** 用栏线与纸面抬升表达层级；新增分隔先问"这条线是 25% 还是 14% 墨"。
- **Do** 保持状态标签的文字可读性——颜色只是辅助信号。
- **Do** 新视图沿用"左目录 + 右密排"开本；条目永远不是卡片。
- **Do** 表格首列数据用 mono tabular-nums。

### Don't:
- **Don't** 给正文或标题加 letter-spacing（apparatus 标签除外）。
- **Don't** 在窄栏（<40em）使用 `text-align: justify`——长 token 会把上一行拉出巨缝。
- **Don't** 引入第三种印刷色，或让朱砂铺版面底色。
- **Don't** 用阴影；深度语言只有栏线与纸面抬升。
- **Don't** 用 emoji/unicode 字符充当图标；图标一律手绘 SVG（统一 1.4 描边）。
- **Don't** 把 fixed 定位元素放进带 transform/animation 的祖先容器内。

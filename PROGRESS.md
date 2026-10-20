# PROGRESS

> 按 `token-efficient-agent-workflow` 规范维护。每阶段独立、可验证、可交接。
> **2026-10-20 起采用压缩台账**：仅当前阶段保留完整六要素，已完成阶段压缩为一行速览
> （内容/时间以本表为准，过程细节与逐条验证在 git 提交与 `HANDOFF.md` 决策/坑表中；
> 压缩前的完整台账见提交 `17b6701` 的本文件）。

## 进度看板
- 最新完成：**阶段 39 = 知识总簿 · 知识库前端全量视觉重构 + 连续卷章 + 上线 gh-pages**（10.19~10.20 BY ZCode）——
  design-studio 决策页锁定「知识总簿·年鉴体」替换 Linear 世界；index.html/style.css 全量重写（纸面双色印刷、
  卷次总目、双栏密排、连续条号、hairline 深度）；修 4 个问题（fixed 包含块劫持/搜索逐卷计数/部号 undefined/
  资源簿行窄栏挤成 0 宽）；连续滚动翻章 + 点击跳章 + scrollspy 跟随；已同步 gh-pages 上线
  （https://gorilla-kevv.github.io/voice-workbench/ ，提交 e0621ba）。
- 同日完成：**票 #9（变声/翻唱合成下拉换源 /api/models）已实施并关票**——注册表取数提升页面级，
  下拉与模型库面板同源（改名可见）；RVC 值=文件茎（id 集 13/13 已验证），DDSP-SVC 值=主权重绝对路径
  （引擎 find_model 三态解析），缺 config 按 incomplete/missing 禁用；typecheck/eslint/build 全绿，
  注册表数据形状直跑核对（rvc 13 条 / ddsp-svc required 角色）。
- 工作池跟踪（GitHub Issues）：
  - `ready-for-agent` 0 张；
  - `ready-for-human` 5 张（#1~#5 真机走查：产出记录三源 / RVC 训练前端 / GSV 两段式 / 变声翻唱加载 / Irodori 整链路+耳朵验收）；
  - `needs-triage` 2 张（#10 R2T2 离线转写——立项拷问已写进票，等拍板；#11 网易档位选择器——历史叫停，等点头，半小时工作量）。
- 硬件窗口状态：~6.1 GB 空闲显存（10.19 记录，真机走查/训练前先看当日 `nvidia-smi`）。
- 下一阶段入口：
  1. #10 R2T2 离线转写立项拍板（决策材料已附票内：transformers 后端 Windows 可行，成本=显存槛 5.5~6.5GB + 权重磁盘 + venv 膨胀）；
  2. #11 网易合成页档位选择器（等用户点头，后端三档现成）；
  3. 用户侧真机走查 #1~#5（显存窗口）；
  4. 备选立项：P5 DDSP-SVC 训练入口（确定性高，见 VOICE-MODEL-MANAGEMENT-PLAN.md §4.5）、
     P4 网易微调（要改上游硬编码，不确定性大，§4.4）、app/ 主前端与知识总簿的视觉谱系对齐评估（阶段 40 候选）。
- 已否决路线：GPT-SoVITS 整体迁移 Genie-TTS（阶段 27）；dots.tts 试点（阶段 28）；R2T2 流式（上游写死 vLLM-only，平台不可行）。

## 编号说明（2026-10-06 合规整理时补记）
- 历史上出现过**两组同号阶段**：「阶段 23」= 浏览器走查 与 文档修正、「阶段 24」= 全站拖拽导入 与 启动预加载。
  编号已被 HANDOFF（坑 22~25）与提交信息交叉引用，**不改号**；下表按完成时间顺序排列并标注（第二组）。
- 另有一次未单独立目的「阶段 26补」（侧栏手动折叠 + RVC/SVC 页去整页报错，提交 b1ee653），已并入阶段 26 条目，不重复列。
- 早期条目（阶段 1~20）的署名与完成时间多为整理时按 git 提交时间**补记**；无法证实的标「未记录」，不臆造。

## 阶段 39 — 知识总簿 · 知识库前端全量视觉重构（推翻 Linear 世界）[完成时间：10.19~10.20 BY ZCode]

- 分支：feature/vc-svc
- 背景：用户要求以 design-studio skill 全部重构 `knowledge-atlas/` 交互门户、推翻现有视觉世界。
  按 new-work「替换世界」全流程执行：concept-seed 掷方向（Read 模式）→ 决策页六卡组牌 →
  **用户锁定「知识总簿 · 年鉴体」（assigned-almanac，code-led）** → 方向契约落 surface brief
  （seed:25c52c7cf6f1dc33）→ 重建 → 渲染验证 → 七视角走查 → detect → 评审（ship）→ documenter 重写 DESIGN.md。

### 已完成明细

| 模块 | 改动内容 |
| --- | --- |
| `knowledge-atlas/index.html` | 全量重写：墨蓝卷首横幅（站名/卷号行/朱砂方章）+ 黑隔页带 + 264px 卷次总目（真链接 hash 路由 + aria-current）+ 双栏密排正文（columns:2 + 栏线）+ 连续条号 apparatus（§N/¶NN/R-NN/部N/表 N）+ 「读到此页」朱砂耳标（body 直下 fixed）+ 三段式页脚；**连续卷章**：九视图纵向排开、滚动翻章、点击标题平滑跳章、scrollspy 跟随（高亮/耳标/页脚卷号/标题），hash 随滚动 replaceState 可分享 |
| `knowledge-atlas/css/style.css` | 全量重写（108→340 行）：四墨 token（paper/ink/indigo/vermilion）、字阶五级（11/14/18/28/44）、hairline 深度语言（无阴影）、浏览器原生面主题化（selection/caret/scrollbar/focus-visible/tabular-nums）、settle 入场动效（reduced-motion 关闭）、三断点（1100/900/640） |
| `knowledge-atlas/DESIGN.md` | 由 documenter 从建成世界重写（frontmatter token 化 + 八段规范结构 + Named Rules + 定位纪律） |
| `knowledge-atlas/.impeccable/` | surfaces/knowledge-atlas.md（方向契约六块）、design.json（schemaVersion 2 sidecar）、decision-payload.json（方向回合档案） |
| gh-pages | 两次同步上线（2fbaf41 年鉴体、e0621ba 连续卷章），Pages 构建确认 |

### 评审途中修掉的问题（4 bug + 1 排版 finding）

1. **耳标 fixed 被劫持**：`.settle` 动画 fill 停在单位矩阵（非 `none` 关键字）构成包含块，把 main 内的 fixed 耳标顶出视口 → 耳标移出 main 挂 body 直下；
2. **搜索徽标计数错误**：所有篇目显示同一聚合数 → 改为逐视图计数；
3. **辞海部号 undefined**：分部序号误用词条计数器 → 部号独立计数（部一~部十）；
4. **资源簿行渲染崩坏**（用户实测发现）：五列并排网格在 ~436px 双栏里被两个 nowrap 列把 1fr 描述列挤成 **0 宽**（文字一字一行竖排、行高 630~924px）→ 改簿式三行条目（命名 grid areas），7 视口复测 desc ≥312px、行高 89~138px；
5. **排版 P1**：窄栏 justify 遇 42 字符 latin token 把上一行拉出巨缝 → `overflow-wrap:anywhere` 无效（token 小于栏宽不触发），弃用 justify 改起点对齐，已写入 DESIGN.md Don'ts。

### 测试结果

| 测试项 | 结果 |
| --- | --- |
| check_contrast.py（refactoring-ui） | 10 组前景/背景配对全部 ≥4.5:1 PASS |
| 渲染验证（IAB 真实浏览器） | 1440/1280/768/375(+390) 视口截图落盘 `.impeccable/review/`；7 断点计算样式检查：sheet 网格、双栏→单栏、chips 换行、全断点无横向溢出 |
| 交互验证 | 搜索三源逐卷计数+徽章+无命中+清空还原、`/` 聚焦、hash 路由、滚动翻章三段定位（卷三/辞海/底部资源簿）、点击跳章与 hash 直达落位、scrollRestoration=manual 后不再打架 |
| `node knowledge-export/build.js` | 10 份手册重新生成全通过（data.js 未动，内容管线无回归） |
| `impeccable detect --json` | 31 advisory（对旧 DESIGN.md 的预期漂移，新 DESIGN.md 落地后消解）+ 8 warning（字体未声明 6 条同前；宽字距/纸面为世界承诺，已记入 DESIGN.md） |
| finish review | disposition: **ship**——唯一 material fix（justify 巨缝）已修复并重截确认 |

### 披露与遗留

- finish reviewer 与 documenter 按 skill 协议以**主体内新鲜评审**执行（Agent 子代理两次被安全策略拦截，披露此替代）；seed 引用经本会话掷点输出原文佐证。
- `atlas-375.png` 为排版修复前捕获（布局相同仅对齐差异）；375 宽的截图表面持续超时（内嵌浏览器表面老化，非页面问题），小屏当前证据由 `mobile.png`（390 全页）承担。
- 验证盲区教训：资源簿行的崩坏说明**每个视图都要看渲染图，不能只做 DOM 计数**。

## 已完成阶段速览（1 ~ 38）

| 阶段 | 内容 | 完成 | BY |
| --- | --- | --- | --- |
| 1 | 本地化改造与架构搭建（GPT-SoVITS 官方能力移植、Provider 抽象、推理/训练/批量/音色库） | 09下旬 | 未记录 |
| 2 | 启动体验与日志 | 09下旬 | 未记录 |
| 3 | 状态管理与数据修复 | 09下旬 | 未记录 |
| 4 | 官方流程对齐 | 09下旬 | 未记录 |
| 5 | 术语与引导体系（全站术语提示 100 条 + 官方流程指引） | 09下旬 | 未记录 |
| 6 | 官方建议对齐收尾（训练顺序 s2→s1 等 HANDOFF 清单清零） | 10.01 前 | 未记录 |
| 7 | 网易模块接入（Confucius4-TTS + R2T2 双模型共存，`netease/` 独立运行时） | 10.01 | 未记录 |
| 8 | 网易模块装环境 + 端到端实测（TTS 跑通 RTF 2.0~2.5；R2T2 卡 Windows 平台） | 10.01 | 未记录 |
| 9 | 侧栏状态卡精简（缩小 + 加载完自动隐藏） | 10.01 | 未记录 |
| 10 | 各模块结果栏改「多条结果列表」（不再互相覆盖） | 10.01 | 未记录 |
| 11 | R2T2 落地路径勘察（只勘察不安装） | 10.01 | 未记录 |
| 12 | 修网易侧显存准入假象（坑 17：WDDM 下 torch 读数失真 → nvidia-smi） | 10.02 | 未记录 |
| 13 | 网易改为主服务，GPT-SoVITS 降为辅助 | 10.02 | 未记录 |
| 14 | 资源占用预估与预警 | 10.02 | 未记录 |
| 15 | 三个外接板块的入口与来源标注（ASR/变声/歌声转换） | 10.02 | 未记录 |
| 16 | 操作指引系统重做（分步 + 圆形完成标识 + 跨页职责） | 10.03 | 未记录 |
| 17 | GPT-SoVITS 默认停用 + 一键关闭（释放显存） | 10.03 | 未记录 |
| 18 | 资源仲裁：单模型独占，自动停掉本系统内竞争模型 | 10.04 | 未记录 |
| 19 | 资源站入口 + 仲裁持有期与任务时长挂钩 | 10.05 | 未记录 |
| 20 | 依赖 GPT-SoVITS 的页面补「服务已停用」直达提示 | 10.05 | 未记录 |
| 21 | 冷启动进度反馈 + trainer 显存口径同步 nvidia-smi | 10.05 | CodeBuddy |
| 22 | 网易合成速度/质量档位（后端三档可用；UI 选择器半成品 → 票 #11） | 10.05 | CodeBuddy |
| 23 | 浏览器走查网易合成页 + 阶段 6 新 UI（修 6 处实测缺陷，坑 21~24） | 10.06 | CodeBuddy |
| 23（第二组） | 文档修正：R2T2 可用性分层 + IndexTTS 接入方案 | 10.06 | CodeBuddy |
| 24 | 全站文件/文件夹拖拽导入（`useFileDrop` 13 处统一，坑 25） | 10.06 | CodeBuddy |
| 24（第二组） | 启动预加载选择（双轨策略 + 显存挂钩） | 10.06 | CodeBuddy |
| 25 | IndexTTS 本地服务骨架落地（`indextts/` 第三运行时） | 10.06 | CodeBuddy |
| 26 | IndexTTS 全链路接入（真实合成实测 + 网关透传 + 前端页 + 资源管控，坑 26） | 10.06 | Qoder |
| 26补2 | 设置页整体重排（模型选择提级 + 服务平铺 + 去嵌套） | 10.06 | Qoder |
| 26补3 | 三服务连接开关 + 设置页去嵌套 | 10.06 | Qoder |
| 26补4 | 显存不足时报错列出「谁在占 GPU」 | 10.06 | Qoder |
| 26补5 | 侧栏状态卡一键直达设置对应区块 | 10.06 | Qoder |
| 26补6 | IndexTTS 页引擎状态卡补「启动服务」快捷入口 | 10.06 | Qoder |
| 26补7 | 音色库独立存储 `voicelib/`（跨模型通用）+ 资源站入口常驻顶栏（坑 27） | 10.08 | Qoder |
| 26补8 | 音色库管理页完整化（批量/搜索/筛选/分页） | 10.08 | Qoder |
| 26补9 | 显存监控小窗（右键停进程）+ 音色库独立入口 + 资源库面板 | 10.08 | Qoder |
| 26补10 | GPT-SoVITS 辅助两页：服务停用不再整页塌成错误卡 | 10.08 | Qoder |
| 27 | 引擎评估：Genie-TTS 与 dots.tts（实测后双双否决，坑 28） | 10.08 | Qoder |
| 27补1 | RVC 变声 `NameError: _in_projection` 修复（MHA 补丁污染，坑 29） | 10.08 | Qoder |
| 27补2 | GPT-SoVITS 进程隔离（方案 B：官方管线移入独立 worker 进程，坑 30~32） | 10.08 | Qoder |
| 28 | 引擎评估：Irodori-TTS（日语特化 + emoji 情感 + 本机训练实测 → 立项，坑 33） | 10.09 | Qoder |
| 27补3 | RVC 变声结果听不了（灰色播放器，盘符路径当 URL，坑 21 复发） | 10.09 | Qoder |
| 27补4 | DDSP-SVC 音色加载入口（成对导入 .pt+config.yaml；id 口径修正，坑 34/35） | 10.09 | Qoder |
| 27补5 | RVC 训练结果音频全失真（int16 削波 + 转置，坑 36~39）+ 产物全量展示 | 10.09 | Qoder |
| 27补6 | 显存预估「重复扣账」+ 服务进程关不掉（端口反查 + 归属校验，坑 42~45） | 10.09 | Qoder |
| 27补7 | 侧栏「已就绪」与设置页「未启动」打架（状态事实源统一，坑 46~48） | 10.09 | Qoder |
| 30（P0） | 音色模型统一管理·看得见（`/api/models` 注册表 + 多根扫描，坑 49~51） | 10.09 | Qoder |
| 31（P1） | 音色模型统一管理·管得住（导入/改名/迁移，坑 52~54） | 10.09 | Qoder |
| 29 | RVC 训练对齐官方 WebUI（后端 T1/T2/T4/T5，坑 58/59） | 10.10 | CodeBuddy |
| 29补1 | 补齐 32k/48k 训练底模 | 10.10 | CodeBuddy |
| 29补2 | 前端「RVC 训练」入口（LoRA/全量 + 提交前预检） | 10.12 | Qoder |
| 30 | Irodori-TTS 接入 30-1~30-8（环境→推理→长尾护栏→长参考→训练 S1S2→S3→前端→仲裁收尾，坑 61~77） | 10.12~10.17 | Qoder/ZCode |
| 32（P2） | 产出记录页：三源合并，历史记录升级为「产出记录」（坑 55/56） | 10.09 | CodeBuddy |
| 33（P3·部分） | 体验收尾：未识别文件提示 + 变声/翻唱两页接统一数据源（坑 57/58） | 10.10 | CodeBuddy |
| 34 | GPT-SoVITS 两段式选择器（零样本 / 微调权重 + 加载到显存） | 10.12 | Qoder |
| 35 | 全站板块/页面一致性与规范审查（16 页 × 9 维度静态巡检） | 10.17 | ZCode |
| 35补1 | 工程技能配置 + 工作池 triage 11 票 + #6/#7/#8 交付关票 | 10.17 | ZCode |
| 36 | GPT-SoVITS v5 本地化（v5dev/v5turbo 第五运行时 `gsv5/`，坑 78） | 10.18 | ZCode |
| 37（K 系列） | AI 声音知识图谱与规范导出包（K0~K5：data.js + 手册包 + inbox 流程 + Linear 视觉 + 三视图） | 10.19 | ZCode |
| 38 | GPT-SoVITS v5 设置页服务控制卡与全站状态卡贯通 | 10.19 | Antigravity |

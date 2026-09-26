# PROGRESS

> 按 `token-efficient-agent-workflow` 规范维护。每阶段独立、可验证、可交接。

## 阶段 1 — 本地化改造与架构搭建

- **已完成**
  - 移出全部线上部署产物（Dockerfile、cloudbaserc.json、deploy 脚本、部署文档）
  - 三层架构落地：前端 / Node 网关 / Python 模型服务
  - Python 服务改为**直接 import 官方管线**（模型常驻内存 + 权重热切换）
  - `server.py` 解释器自举（无 torch 时用整合包 `runtime/python.exe` 重新执行自己）
  - 训练流水线：12 阶段，全部调用官方脚本
  - 音色库、批量合成（含 ZIP + JSON/CSV 清单）、任务系统（进度/日志/取消）
  - 前端 Provider 抽象，MiMo 与 GPT-SoVITS 并存

- **未完成**：UVR5 人声分离（当时判断为「官方只有 Gradio，无法集成」—— 该判断后续被推翻）

- **改动文件**：`app/` 全量重写、`server/src/`、`trainer/` 全量重写、`package.json`、`scripts/`

- **测试结果**：真实训练跑通并产出权重（`final-verify_e1_s99.pth`，164.8MB）；端到端合成经网关代理成功

- **风险**：整合包路径依赖强；`sys.path` 与 `cwd` 敏感

- **下一阶段入口**：排查「页面白屏」与启动体验问题

---

## 阶段 2 — 启动体验与日志

- **已完成**
  - `start.bat` 一键启动（自动装依赖 + 环境体检 + 打开浏览器）
  - 修复 bat 编码导致的 cmd 解析错位（改 GBK/ANSI、去掉 `chcp 65001`）
  - 网关日志降噪：Python 输出不再逐行包成 JSON debug，改为就绪摘要
  - 侧栏连接状态**轮询**（前 90s 每 3s，之后 30s，就绪后 60s 复查）+ 三态（正在连接 / 已就绪 / 未连接）
  - Python 服务生命周期交给启动编排器（避免 `tsx watch` 重启连带重启模型服务）
  - 前端错误边界（白屏 → 可读错误卡片）

- **未完成**：无

- **改动文件**：`start.bat`、`scripts/`、`server/src/services/sovits.ts`、`server/src/index.ts`、`app/src/App.tsx`、`app/src/main.tsx`、`app/src/components/features/ErrorBoundary.tsx`、`app/src/components/layout/AppShell.tsx`

- **测试结果**：全新浏览器会话控制台零错误；冷启动期间显示「正在连接」而非「未连接」

- **风险**：`useIsMobile` 基于宽度断点，平板/触屏笔记本可能判断不准

- **下一阶段入口**：批量合成结果在切换页面后丢失

---

## 阶段 3 — 状态管理与数据修复

- **已完成**
  - 批量合成与训练页会话保留（模块级 + sessionStorage，跨页面、跨刷新）
  - 恢复轮询：回到页面时若任务仍在跑，接着跟踪进度
  - 防重复提交（切回页面后按钮不会被错误启用）
  - 音色库语种脏数据修复（`prompt_lang: "undefined"`），自动纠正并落盘
  - 版本大小写归一化（前后端双向）
  - 弹窗去重（依赖改为具体 `controller.error`）

- **未完成**：无

- **改动文件**：`app/src/pages/BatchPage.tsx`、`app/src/pages/TrainingPage.tsx`、`trainer/app/sovits/voices.py`、`trainer/app/sovits/catalog.py`、`trainer/app/sovits/pipeline.py`、`trainer/app/training.py`、`app/src/lib/providers/gpt-sovits.ts`、`app/src/App.tsx`

- **测试结果**：用户验证通过；音色库脏数据已纠正为 `zh`，合成成功（3.34s 音频）

- **风险**：sessionStorage 写入失败时静默降级为「仅当前会话内」

- **下一阶段入口**：对照官方推荐流程审查达标情况

---

## 阶段 4 — 官方流程对齐

- **已完成**
  - UVR5 人声分离（推翻原判断：官方 `vr.py`/`mdxnet.py` 可直接调用）
    - `trainer/tools/uvr_cli.py` 非交互封装，不改官方代码
    - 模型清单从 `uvr5_weights` 扫描，BS-RoFormer 缺 `.yaml` 标为不可用
    - 实测：HP2 处理 5.4s 音频，产出人声 + 伴奏双轨道
  - 切分参数界面化（8 个滑块，默认值与官方 WebUI 一致）
  - ASR 精度选择（按后端钳制：FunASR 仅 float32 且参数官方未接入；Faster Whisper 才生效）
  - 预训练权重路径自定义（GPT / SoVITS / 判别器，路径错误在预检阶段就报）
  - 标注校对（数据层 `annotations.py` + 三个 API + 界面：试听 / 改文本 / 标记丢弃 / 保存回清单）
  - 版本下拉标注「官方推荐」（v2Pro / v2ProPlus）

- **未完成**：训练顺序（仍是 s1→s2，官方建议 s2→s1）

- **改动文件**：`trainer/tools/uvr_cli.py`、`trainer/app/sovits/catalog.py`、`trainer/app/training.py`、`trainer/app/models.py`、`trainer/app/annotations.py`、`trainer/app/api.py`、`app/src/pages/TrainingPage.tsx`

- **测试结果**：预检打印的真实命令确认参数全部落位；`uvr` 实跑成功；`asr` 阶段 `-p int8` 正确传入

- **风险**：UVR5 依赖整合包内模型文件；BS-RoFormer 缺配置不可用

- **下一阶段入口**：术语提示与流程指引

---

## 阶段 5 — 术语与引导体系

- **已完成**
  - 术语表 `glossary.ts`：71 → **100 条**，每条「它是什么」+「它影响什么」+ 可选示例
  - `TermTip` 组件：桌面悬浮/键盘聚焦、触屏点击弹出；未收录术语不加虚线不弹空框
  - 毛玻璃外观（半透明 + `blur(12px)` + `@supports` 降级 + 主题自适应）
  - `flowGuide.ts` + `FlowGuide.tsx`：官方推荐流程 8 步，贴窗口右边缘，鼠标移到右侧展开；触屏点击开合
  - 页面接入点累计 **74 处**
  - 覆盖三个新页面（语音识别 / 语音变声 / 歌声转换）的术语

- **未完成**：无

- **改动文件**：`app/src/lib/glossary.ts`、`app/src/lib/flowGuide.ts`、`app/src/components/features/TermTip.tsx`、`app/src/components/features/FlowGuide.tsx`、8 个页面文件

- **测试结果**：`tsc` / ESLint / `vite build` 全部通过；构建产物确认毛玻璃相关类正确生成（含 `-webkit-` 前缀与 `@supports` 降级）

- **风险**：毛玻璃实际观感未经浏览器预览确认（多次预览被跳过）

- **下一阶段入口**：见 `HANDOFF.md` 的「下一步」清单（训练顺序、权重下拉、切分结果展示）

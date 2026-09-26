# HANDOFF

> 交付文档。供新会话接手使用，遵循 `token-efficient-agent-workflow` 规范：只记结论、决策与坑，不复述历史。
> 代码仓库是唯一真实的上下文来源，本文件只是索引。

## 项目

- **路径**：`F:\schoolCompWorks\clone\ttstool`
- **名称**：本地语音工作台（voice-workbench）
- **定位**：**纯本地部署**。线上旧版本在独立仓库维护，本仓库不涉及任何线上部署配置。

### 技术栈

| 层 | 技术 |
| --- | --- |
| 前端 `app/` | React 19 + TypeScript + Vite 7 + Tailwind CSS 3 + shadcn/ui（Radix） |
| 网关 `server/` | Node 18 + Express 4 + TypeScript（tsx 运行） |
| 模型服务 `trainer/` | Python 3.9（整合包自带 `runtime/python.exe`）+ FastAPI + Uvicorn |
| 模型 | GPT-SoVITS v2ProPlus（本地 GPU）、MiMo（云端 API） |

### 分支

- 当前：`feature/vc-svc`（origin 已同步）
- 主分支：`main`
- 远程：`https://github.com/Gorilla-Kevv/voice-workbench.git`

## 目标

### 已达成

1. GPT-SoVITS 官方能力移植：推理、训练、批量合成、音色库、权重管理
2. 保留并打通 MiMo 云端链路，两套模型通过 Provider 抽象共存
3. 训练流水线对齐官方 WebUI（12 阶段），含 UVR5 人声分离、切分、ASR、格式化、GPT/SoVITS 训练
4. 全站术语提示系统（100 条术语 + 右侧官方流程指引）
5. 新增板块：ASR 语音转文本、语音变声(RVC)、歌声转换(DDSP-SVC)（由并行工作产出）

### 非目标

- 不做线上部署（Docker / 云托管 / GitHub Pages 均已移除）
- 不改动官方整合包 `GPT-SoVITS-v2pro-20250604/` 下任何一行代码
- 不为不支持的能力做「静默降级」（宁可报清晰的错误）

## 结构

### 关键目录

| 目录 | 职责 |
| --- | --- |
| `app/src/pages/` | 11 个页面：通用合成、批量合成、音色设计、声音克隆、音色库、历史、训练、语音变声、歌声转换、语音转文本、设置 |
| `app/src/lib/providers/` | Provider 抽象：`mimo`（云端）、`gpt-sovits`（本地）、`selfhosted`（自定义） |
| `app/src/lib/sovits.ts` | 本地服务客户端（含 NDJSON 流式解析、音频地址映射） |
| `app/src/lib/glossary.ts` | 术语表（100 条），含 `term/definition/impact/example` |
| `app/src/lib/flowGuide.ts` | 官方推荐流程（8 步，固化官方原话与数值） |
| `app/src/components/features/` | `TermTip`（术语提示）、`FlowGuide`（流程指引）、`ResultPanel`、`ErrorBoundary` 等 |
| `server/src/routes/sovits.ts` | 反向代理（必须挂在 `express.json()` **之前**，否则 multipart / 流式透传失效） |
| `server/src/services/sovits.ts` | 托管 Python 服务：探活、解释器探测、日志环形缓冲 |
| `trainer/app/sovits/` | 与官方代码的直连层：`bootstrap`（定位+sys.path）、`catalog`（能力清单，唯一常量源）、`pipeline`（管线常驻）、`synth`（请求翻译）、`voices`（音色库） |
| `trainer/app/` | `training.py`（12 阶段编排）、`batch.py`、`inference.py`、`annotations.py`（清单读写）、`jobs.py`、`queue.py` |
| `trainer/tools/uvr_cli.py` | UVR5 非交互封装（调官方 `vr.py`/`mdxnet.py`，不改官方代码） |

### 入口文件

- 前端：`app/src/main.tsx` → `App.tsx`
- 网关：`server/src/index.ts`
- 模型服务：`trainer/server.py`（**会自动判断解释器有无 torch，没有就用整合包的 `runtime/python.exe` 重新执行自己**）
- 一键启动：根目录 `start.bat`

### 核心接口

- 后端统一响应：成功 `{ ok: true, ... }`；失败 `{ ok: false, error: { code, message, retryable, hint } }`
- `hint` 是给**使用者**的下一步动作，前端必须展示而不只是展示 `message`
- 主要端点：`/health`、`/v1/catalog`、`/v1/uvr/models`、`/v1/weights`、`/v1/voices`、`/v1/tts`、`/v1/tts/stream`、`/v1/tts/batch`、`/v1/train`、`/v1/train/plan`、`/v1/annotations/{job_id}`、`/v1/jobs`

### 数据模型

- 前端契约：`app/src/types/sovits.ts`（与后端 `trainer/app/models.py` 一一对应）
- 持久化：
  - 服务端：`trainer/.data/`（voices、outputs、jobs、experiments、uploads）
  - 浏览器：`localStorage`（设置）+ `sessionStorage`（训练/批量会话）+ IndexedDB（历史）

## 决策与坑

### 已做决策（含原因）

| 决策 | 原因 |
| --- | --- |
| 模型管线**常驻内存**，不每次 subprocess 调 CLI | 官方 `inference_cli.py` 每次重加载 4 个模型（约 1 分钟），本地试听不可用 |
| Python 服务生命周期交给**启动编排器**（concurrently），不由网关托管 | 网关在 dev 下被 `tsx watch` 重启，若托管 Python 会连带重启（改一行代码等 40 秒重加载） |
| 网关代理用 `node:http` + `pipe` 而非 `fetch` | 音频上传（multipart）与流式（NDJSON）需要原始字节流，pipe 天然支持 |
| 官方能力清单只写一处：`trainer/app/sovits/catalog.py` | 版本/语种/预训练权重映射散落各处会导致升级时漏改 |
| 错误响应必须带 `hint` | 只报 `message` 用户无从下手（实测：用户对着「不支持合成语种 undefined」完全懵） |
| 渲染错误用错误边界兜底 | React 渲染抛错会卸载整棵树 → 纯白页面，无信息 |
| 术语提示：桌面悬浮 / 触屏点击 | Radix Tooltip 在触摸设备体验不可靠（悬浮不存在） |

### 已知坑（重要，改代码前先看）

1. **`start.bat` 必须存成 GBK / ANSI，且不能 `chcp 65001`**
   cmd 解析 bat 时会按字节 seek（`goto` / `call` / `for /f` 都会触发），UTF-8 多字节中文会让偏移算错，表现为某些行被从中间截断执行（`call :check_port` 变成 `eck_port`、`echo` 前缀被吃掉）。转码方式见 `.gitignore` 同目录说明，编辑后务必保持 ANSI。

2. **PowerShell 的 `$HOME`、`$PID` 是只读自动变量**
   用作变量名会直接报错。本项目脚本里已改用 `$SovitsHome`、`$targetPid`。

3. **`AudioPreDeEcho._path_audio_` 的 `vocal` / `ins` 参数顺序与 `AudioPre` 相反**
   官方源码注释「3个VR模型vocal和ins是反的」。`uvr_cli.py` 一律用**关键字参数**调用来规避。

4. **`tools/uvr5/vr.py` 用相对导入**（`from lib.lib_v5 import ...`）
   必须把 `tools/uvr5` 放进 `sys.path` 才能 import。

5. **Python 3.9 限制**
   - Pydantic 模型里不能写 `X | None`，必须 `Optional[X]`
   - `asyncio.Queue` 在 **构造时绑定事件循环** → 必须在 FastAPI lifespan 内创建，服务启动前建好会永远停在 `queued`

6. **前端弹窗重复触发的根因**
   `useSynthesis` 返回展开字面量（每次渲染新对象），而「已等待 N 秒」计时器每秒 setState → 依赖整个 controller 的 effect 每秒重跑 → toast 每秒弹一次。**依赖必须写成具体的 `controller.error`**。

7. **模型版本大小写**
   前端 model id 是小写（`gpt-sovits-v2proplus`），服务端版本名是混合大小写（`v2ProPlus`）。直接把后缀当版本名会报「未知模型版本」。现已双向处理：前端 `fields.version` 优先 + 大小写不敏感匹配，服务端 `catalog.resolve_version()` 归一化。

8. **`FormData.append(name, undefined)` 会写入字符串 `"undefined"`**
   音色库的 `prompt_lang` 曾因此入库成脏数据，导致每次合成都报「不支持合成语种 undefined」。写入端与读取端现在都做归一化（`normalize_prompt_lang`），历史脏数据会在服务启动时自动纠正并落盘。

9. **BS-RoFormer 在本机不可用**
   整合包里有权重但缺同名 `.yaml`，被模型扫描标为 `available=false`。官方推荐它是人声分离首选，本机只能先用 HP2 / HP5。

10. **`tools/denoise-model/` 是空目录**
    现有「语音降噪」阶段依赖的 FRCRN 模型不在本地（会尝试联网下载）。UVR5 的 DeEcho / ONNX 去混响模型在本地，可替代。

11. **训练顺序与官方建议相反**
    我们是 `s1(GPT) → s2(SoVITS)`；官方建议「先等 SoVITS 完成，再开 GPT」。**尚未修改**（改动涉及阶段编排与语义 Token 重提取，风险较高）。当前用流程指引文字告知用户。

## 命令

| 用途 | 命令 |
| --- | --- |
| 安装依赖 | `npm run install:all` |
| **一键启动（推荐）** | 双击 `start.bat` |
| 开发模式 | `npm run dev`（并行起：本地模型服务 + 网关 + 前端） |
| 只起网关+前端 | `npm run dev:cloud` |
| 只起本地模型服务 | `npm run dev:sovits` |
| 环境体检 | `npm run sovits:check`（退出码 0 表示就绪） |
| 类型检查 | `npm run typecheck` |
| 前端 lint | `cd app && npx eslint <文件或目录>` |
| 构建 | `npm run build` |
| 生产单端口 | `npm run preview` |
| Python 侧语法自检 | 见 `trainer/.tmp/syntax.py`（若不存在可临时创建，用 `ast.parse` 遍历） |

## 状态

### 当前状态

- `feature/vc-svc` 分支，origin 已同步
- `main` 分支停在 `f83d51b`（未包含 vc-svc 功能）
- 功能可用；本地服务、网关、前端三进程由 `start.bat` 统一拉起
- 术语表 100 条 + 页面接入 74 处
- 官方流程指引（8 步）已接入训练页与合成页

### 验收标准

- `npm run typecheck` 通过
- `cd app && npx eslint src` 通过
- `npm run build` 通过
- `npm run sovits:check` 退出码 0
- 浏览器打开 `http://localhost:5173` 三端口（5173 / 8787 / 9881）均就绪，页面无控制台报错

### 下一步（按优先级）

| 优先级 | 事项 | 备注 |
| --- | --- | --- |
| 高 | 训练顺序改为「先 SoVITS 后 GPT」 | 涉及阶段编排，需评估是否补「训完 SoVITS 重新提取语义 Token」 |
| 高 | 权重选择下拉 UI + E/S 命名解释 | 训完不知道选哪个权重，推理前必踩的坑 |
| 中 | 切分后展示结果：按时长排序 + >15 秒超长条提醒 | 官方明确要求 |
| 中 | 「参考音频语种 ≠ 合成语种」在合成页显式提示 | 官方强调的易混淆点 |
| 低 | 标注校对文案改为「官方认为可跳过」 | 当前措辞与官方判断冲突 |
| 低 | 删除 `app/src/lib/补词方式.txt`（未跟踪的笔记） | 每次 `git add -A` 都会误入 |

## 给下一会话的建议

- 先读本文件 + `PROGRESS.md`，再用搜索工具定位具体模块，**不要读全仓库**
- 改动前先看「已知坑」第 1、5、6 条（bat 编码、Python 3.9 限制、弹窗依赖）
- 每阶段结束更新 `PROGRESS.md`
- 聊天中只传：路径、摘要、diff、失败日志

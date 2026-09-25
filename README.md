# 本地语音工作台

把 **GPT-SoVITS** 完整搬到本地，和原有的 **小米 MiMo** 云端模型并排使用。
推理、训练、批量合成全部在本机完成，音频与语料不出本机。

- 想开箱即用、音色稳定 → 用 **MiMo（云端）**，填一个 API Key 就能合成；
- 想做日语/韩语、克隆自己的声音、批量做有声书、或者要数据不出机 → 用 **GPT-SoVITS（本地）**。

> 本项目**只面向本地部署**。线上一版（GitHub Pages 纯静态）保留在
> [mimo-voice-studio](https://github.com/Gorilla-Kevv/mimo-voice-studio) 独立维护，
> 站点：https://gorilla-kevv.github.io/mimo-voice-studio/
> 本仓库不再包含任何线上部署配置，也无需线上服务器或网络资源。

---

## 目录

- [能做什么](#能做什么)
- [架构](#架构)
- [目录结构](#目录结构)
- [快速开始](#快速开始)
- [验证安装](#验证安装)
- [使用流程](#使用流程)
- [接口一览](#接口一览)
- [配置项](#配置项)
- [已知边界与限制](#已知边界与限制)
- [数据与隐私](#数据与隐私)
- [文档](#文档)

---

## 能做什么

| 能力 | MiMo（云端） | GPT-SoVITS（本地） |
| --- | --- | --- |
| 通用语音合成 | 9 个官方预置音色 | 音色来自你导入的参考音频 |
| 音色设计（文字描述生成音色） | ✅ | ❌ 模型不支持，界面已如实标注 |
| 声音克隆 | 上传样本，零样本复刻 | ✅ 5 秒音频即可零样本 |
| 专属音色微调 | ❌ | ✅ 1 分钟语料起，输出专属权重 |
| 语种 | 中文（含方言标签）、English | 中 / 英 / 日 / 韩 / 粤，且可跨语言 |
| 批量合成 | — | ✅ 一份清单 → 一批音频 + ZIP + 清单文件 |
| 音色库 | 官方预置 | ✅ 参考音频 + 提示文本，常驻本机 |
| 流式合成 | ✅（官方链路） | ✅ v1/v2 系列（v3/v4 官方不支持） |
| 数据流向 | 音频上传至云端 | ✅ 全程不出本机 |

GPT-SoVITS 侧的推理参数（切分方式、top_k/top_p、temperature、repetition_penalty、
语速、fragment_interval、批大小、v3/v4 的采样步数与超采样、参考音频融合、
分桶与并行推理等）全部透传，未做删减。

### 语音变声与歌声转换（独立入口）

在 GPT-SoVITS 之外，本项目还提供两个相互独立的功能板块，
与 GPT-SoVITS 共用「本地引擎 + 显存互斥调度」，重合的音频处理下沉为共享内核：

| 板块 | 模型 | 场景 | 亮点 |
| --- | --- | --- | --- |
| 语音变声 | [RVC](https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI) | 说话 / 配音 / 朗读换音色 | 检索索引增强；**音色融合**（零训练插值）与**底模 + LoRA**（每个音色只训几 MB 适配器）缓解「换音色就要重训」 |
| 歌声转换 | [DDSP-SVC](https://github.com/yxlllc/DDSP-SVC) | 歌曲翻唱 / 歌声变声 | 显式 F0 建模、转调、四档音质；联动 UVR5 分离，一键产出新人声 / 伴奏 / 混音三件套，分离结果按内容指纹缓存复用 |

细节见 [`docs/VOICE-CONVERSION.md`](docs/VOICE-CONVERSION.md) 与
[`docs/SINGING-CONVERSION.md`](docs/SINGING-CONVERSION.md)。

### 语音转文本（独立入口）

第五个板块，同样与 GPT-SoVITS 共用「本地引擎 + 显存互斥调度」：

| 板块 | 模型 | 场景 | 亮点 |
| --- | --- | --- | --- |
| 语音转文本 | [FunASR](https://github.com/modelscope/FunASR) / [faster-whisper](https://github.com/SYSTRAN/faster-whisper) | 参考文本一键转写；批量语料 → 带标注的数据集 | 「导入音色」里点一下把参考音频转成逐字文本；**训练入口**把一批音频转成逐字文本 + 官方格式清单，直接喂给训练流水线 |

两条通道（模型常驻 / 整合包官方脚本）与降级规则、模块边界与调用关系见
[`docs/ASR.md`](docs/ASR.md)。

---

## 架构

```
                       ┌──────────────────────────────────────────┐
   浏览器  ──────────▶ │  Node 网关（server/，默认 127.0.0.1:8787）│
  localhost:5173       │  · /api/tts、/api/voices、/api/config    │  ──▶ MiMo 云端 API
                       │  · /api/sovits/*  → 反向代理             │
                       │  · 静态托管 app/dist（单地址访问）        │
                       └───────────────┬──────────────────────────┘
                                       │ 探活 / 原样透传
                                       ▼
                       ┌──────────────────────────────────────────┐
                       │  GPT-SoVITS 本地服务（trainer/，:9881）   │
                       │  · FastAPI：音色库 / 合成 / 流式 / 批量    │
                       │  · 任务系统：进度、日志、取消              │
                       │  · 训练流水线：11 个阶段                  │
                       └───────────────┬──────────────────────────┘
                                       │ 直接 import 官方推理管线
                                       │ （模型常驻内存，不重复加载）
                                       ▼
                       ┌──────────────────────────────────────────┐
                       │  GPT-SoVITS-v2pro-…（官方整合包，原地保留）│
                       │  · runtime/ 自带 Python 3.9 + torch      │
                       │  · GPT_SoVITS/ 官方推理与训练脚本         │
                       │  · pretrained_models/ 预训练权重          │
                       └──────────────────────────────────────────┘
```

三个关键设计决定，以及背后的原因：

1. **Python 服务直接 import 官方管线，而不是逐次调用官方 CLI。**
   官方 `inference_cli.py` 每次调用都要重新加载 4 个模型（约 1 分钟），
   在「本地随手试听」的场景下等于不可用。现在模型常驻内存，权重热切换，
   首次加载约 30~90 秒，之后单条合成只需推理本身的耗时。

2. **Python 服务必须跑在整合包自带的解释器里。**
   torch 装在那里。`server.py` 在启动时会判断当前解释器有没有 torch，
   没有就用 `runtime/python.exe` 重新执行自己 —— 所以 `python server.py`
   这条命令在任何 Python 下都能跑通。

3. **训练是全流程托管的 11 个阶段，而不是一堆按钮。**
   官方把「降噪 / 切分 / ASR / 标注 / 格式化 / 两个训练」分散在两页十几个控件里，
   且存在「切分之后文本就丢了」这类隐性依赖。这里把它们编成一条流水线，
   并在派发前做前置校验（预检接口会把每一步的命令拼给你看）。

---

## 目录结构

```
ttstool/
├── app/                          # 前端：React 19 + TypeScript + Vite + Tailwind + shadcn/ui
│   └── src/
│       ├── pages/                # 页面：合成 / 批量合成 / 音色库 / 训练 / 历史 / 设置 …
│       ├── components/features/  # 播放器、音色选择、样本采集、音色库选择器
│       ├── lib/
│       │   ├── providers/        # Provider 抽象：mimo / gpt-sovits / selfhosted
│       │   ├── sovits.ts         # GPT-SoVITS 本地服务客户端（含 NDJSON 流式解析）
│       │   └── api.ts            # MiMo 链路客户端
│       └── types/sovits.ts       # 与 Python 端一一对应的契约类型
├── server/                       # 网关：Node 18 + Express 4 + TypeScript
│   └── src/
│       ├── routes/sovits.ts      # /api/sovits/* 反向代理（透明透传 JSON/multipart/NDJSON）
│       ├── services/sovits.ts    # 本地服务接入：探活、外部进程等待、日志缓冲
│       └── services/mimo.ts      # MiMo 三模型封装（参数校验、分段、WAV 拼接、重试）
├── trainer/                      # 本地模型服务：Python 3.9+
│   ├── server.py                 # 入口：解释器自举 + 环境体检 + 启动
│   ├── app/
│   │   ├── sovits/               # 与官方仓库的直连层
│   │   │   ├── bootstrap.py      # 定位安装、注入 sys.path、加载官方模块
│   │   │   ├── catalog.py        # 官方能力清单（唯一的常量来源）
│   │   │   ├── pipeline.py       # 官方 TTS 管线常驻封装 + 权重热切换
│   │   │   ├── synth.py          # 统一请求 → 官方 inputs 的翻译与校验
│   │   │   └── voices.py         # 音色库（参考音频 + 提示文本）
│   │   ├── audio/                # 共享音频内核（两个新板块与训练共用）
│   │   │   ├── io.py             # 读写 / 重采样 / 格式归一
│   │   │   ├── slicer.py         # 静音切分
│   │   │   ├── uvr5.py           # UVR5 直连层（mdxnet / vr / bsroformer）
│   │   │   ├── cache.py          # 中间结果缓存（文件指纹 + 模型 + 参数）
│   │   │   └── mixer.py          # 混音（增益 / 延迟对齐 / 淡入淡出）
│   │   ├── vc/                   # 语音变声板块（RVC 直连层）
│   │   ├── svc/                  # 歌声转换板块（DDSP-SVC 直连层）
│   │   ├── asr/                  # 语音转文本板块：常驻转写 + 数据集训练入口
│   │   ├── engine.py             # 引擎注册表：独占加载、显存互斥、状态汇总
│   │   ├── vendor_paths.py       # temporary_context：临时 sys.path + cwd
│   │   ├── weights.py            # 预训练权重清单与体检
│   │   ├── routers/              # /v1/engines、/v1/uvr、/v1/asr、/v1/vc、/v1/svc 路由
│   │   ├── inference.py          # 合成执行层
│   │   ├── batch.py              # 批量合成编排（清单 / ZIP / 逐条容错）
│   │   ├── training.py           # 训练流水线（11 个阶段）
│   │   ├── api.py                # HTTP 路由
│   │   ├── jobs.py / queue.py    # 任务持久化与调度
│   │   └── runtime.py            # 运行环境探测
│   ├── requirements.txt
│   └── .env.example
├── GPT-SoVITS-v2pro-20250604/    # 官方整合包（原地保留，仅新增训练产物）
├── vendor/                       # 上游源码（git submodule，锁 commit）
│   ├── rvc/                      # RVC-Project/Retrieval-based-Voice-Conversion-WebUI
│   └── ddsp-svc/                 # yxlllc/DDSP-SVC
├── models/                       # 预训练权重与训练产物（gitignore，下载脚本按需拉取）
├── scripts/                      # 启动脚本（sovits.mjs / start.ps1 / start.sh）
│   │                             # + download_models.py / smoke_uvr5.py / smoke_vc.py / smoke_svc.py
├── docs/                         # 架构、集成与训练文档
├── start.bat                     # Windows 一键启动：双击即用
└── package.json
```

运行期数据全部落在 `trainer/.data/`（已被 `.gitignore` 忽略）：

```
trainer/.data/
├── voices/          # 音色库的参考音频
├── voices.json      # 音色库索引
├── outputs/         # 合成产物（含 batch/<任务号>/ 与 ZIP 清单）
├── jobs/            # 任务元数据（重启后可查历史）
├── uploads/         # 上传的语料
└── experiments/     # 训练实验（数据集、配置、日志、检查点）
```

---

## 快速开始

### 环境要求

| 项 | 要求 |
| --- | --- |
| Node.js | ≥ 18.17（推荐 20+） |
| Python | 3.9 ~ 3.12；**直接用整合包自带的 `runtime/python.exe` 最省事** |
| 显卡 | 建议 NVIDIA 8GB+ 显存（CPU 也能跑推理，但很慢；训练强烈建议 GPU） |
| GPT-SoVITS | 本项目同级目录下放好整合包，例如 `GPT-SoVITS-v2pro-20250604/` |

### 最快路径（Windows）

**双击项目根目录的 `start.bat`。** 它会把下面 1~3 步全部做完：

1. 检查 Node.js 版本（低于 18 会直接给出提示）；
2. 首次运行时自动安装依赖，并做一次本地模型服务体检；
3. 同时启动本地模型服务、网关与前端，然后打开浏览器。

停止服务只需关闭那个窗口。首次运行因为要装依赖并 `import torch`，大约需要 2~4 分钟；
之后每次启动约 30~90 秒（模型预加载）。

不想用它的话，下面是在终端里的手动步骤。

### 1. 安装依赖

```bash
npm run install:all
```

这一条命令会依次安装三处依赖：项目根（`concurrently`）、`app/`、`server/`。
Python 侧的依赖由本地服务自己处理，无需手动 `pip install`。

### 2. 配置（可选）

```bash
cp server/.env.example server/.env
# 若要用 MiMo 云端模型，在 server/.env 里填 MIMO_API_KEY
# 不填也可以：在页面「设置」中填自己的密钥（仅存浏览器本地）
```

### 3. 启动

```bash
npm run dev
```

这一条命令会**并行启动三个独立进程**：

1. **GPT-SoVITS 本地服务**（127.0.0.1:9881）—— 自动挑选整合包里带 torch 的解释器，
   并在后台预加载模型；
2. **Node 网关**（127.0.0.1:8787）；
3. **前端**（http://localhost:5173）。

打开 http://localhost:5173 即可使用。

> 为什么是三个并列进程，而不是让网关去管 Python？
> 因为开发时网关由 `tsx watch` 托管，改一行后端代码就会重启；
> 若 Python 是网关的子进程，每次都会连带重新加载模型（约 40 秒）。
> 交给启动编排器后，改后端代码不再影响模型服务。

> 首次启动时 Python 侧要 `import torch`（约 10~20 秒），模型预加载再花 30~90 秒。
> 期间页面可以正常打开，本地功能的按钮会提示「服务未就绪」。

### 单服务模式（构建后本地访问）

```bash
npm run preview      # = npm run build && npm start
```

只访问 http://127.0.0.1:8787 即可，前端产物由网关托管。

### 只启动本地模型服务

需要让它常驻（例如跑长训练），或想让网关复用你手动启动的实例：

```bash
# Windows
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start.ps1

# Linux / macOS
bash scripts/start.sh --mode local
```

因为 `npm run dev` 里已经有一个 sovits 任务在管这件事，此时需要**别让它重复启动**：
把 `dev` 换成 `dev:cloud`（只管网关与前端），或者给 sovits 任务传 `--port` 换一个端口。

---

## 验证安装

一条命令做完环境体检：

```bash
npm run sovits:check
```

输出会明确告诉你：是否找到整合包、用的是哪个解释器、显卡型号、缺哪些依赖、
默认版本权重是否齐备，以及**下一步该做什么**。同一份信息也可以从
`GET http://127.0.0.1:9881/health` 获取。退出码 0 表示就绪。

---

## 使用流程

### A. 零样本克隆（最快路径，5 秒音频）

1. 「音色库」→ 导入音色：上传一段 **3~10 秒**、单人、无背景音的音频，
   并填写它的**逐字转写文本**。（页面会直接回放这段音频，方便你判断素材质量）
   - 不知道这段音频说了什么，直接点「**一键智能转写（标注 ASR 模型）**」：
     本地 ASR 会识别出逐字文本并填进文本框，**对照音频核对一遍再保存**即可
     —— 错字会被直接学进模型；
   - 想给一批语料打底稿，用「语音转文本」页面的**训练入口**：
     一批音频 → 逐字文本 + 官方格式清单，产物可直接在「模型训练」里使用。
2. 「通用合成」→ 在设置页把模型切到 GPT-SoVITS → 选择刚导入的音色 → 合成。
   - 或直接去「批量合成」，那里也能选音色。

> 转写文本必须与音频内容一致。错字会被直接学进模型，表现为「某些字读音怪异」。

### B. 批量合成（做有声书 / 素材库）

1. 「批量合成」→ 粘贴文本清单（每行一条），或导入 `txt` / `csv`；
2. 选音色，按需展开高级参数（切分方式、语速、temperature、复读惩罚）；
3. 「试听首条」确认音色合适，再「开始批量合成」；
4. 完成后可以：
   - 逐条试听与下载；
   - 下载 **ZIP**（`audio/*.wav` + `manifest.json` + `index.csv`）；
   - 单条失败不影响整批，失败原因与修复建议会留在结果列表里。

清单文件与音频文件名一一对应，`index.csv` 用 UTF-8 BOM 写出，Excel 直接打开不乱码。

### C. 少样本微调（专属音色）

1. 「模型训练」→ 上传语料（或填写本机目录）；
2. 先点「预检计划」，确认每个阶段的命令与参数无误；
3. 点「开始训练」，可实时看阶段进度、日志，也可随时取消；
4. 训练完成后权重会写入 `GPT_weights_<版本>/` 与 `SoVITS_weights_<版本>/`，
   之后合成时会自动优先使用最新训练的权重。

细节与调参建议见 [`docs/TRAINING.md`](docs/TRAINING.md)。

---

## 接口一览

### Node 网关（:8787）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 网关 + MiMo + GPT-SoVITS 三者的汇总状态 |
| GET | `/api/tts/models` | MiMo 三种模式与模型标识 |
| GET | `/api/voices/presets` | MiMo 官方预置音色 |
| POST | `/api/voices/sample` | 校验克隆样本 |
| POST | `/api/config/verify` | 校验 MiMo API Key |
| POST | `/api/tts/synthesize` | MiMo 合成（三种模式统一入口） |
| ALL | `/api/sovits/*` | 原样转发到本地 GPT-SoVITS 服务 |

### GPT-SoVITS 本地服务（:9881，也经 `/api/sovits` 暴露）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 体检报告：环境、运行库、管线状态、阻断项与建议 |
| GET | `/v1/catalog` | 官方能力清单：版本、语种、切分方式、参数默认值 |
| GET | `/v1/pipeline` | 管线状态（是否已加载、当前版本与权重） |
| POST | `/v1/pipeline/warmup` | 预加载模型（`blocking=false` 后台进行） |
| POST | `/v1/pipeline/unload` | 释放模型并归还显存 |
| POST | `/v1/pipeline/stop` | 中断当前推理 |
| GET | `/v1/weights` | 列出可用的 GPT / SoVITS 权重（按版本） |
| POST | `/v1/weights/load` | 切换版本 / 权重 / 设备 / 精度 |
| GET | `/v1/voices` · `/v1/voices/{id}/audio` | 音色列表 · 回放参考音频 |
| POST | `/v1/voices` | 新建音色（multipart 上传） |
| POST | `/v1/voices/source` | 新建音色（引用磁盘已有文件） |
| PATCH | `/v1/voices/{id}` | 修改音色（名称 / 参考文本 / 语种 / 备注） |
| POST | `/v1/voices/{id}/audio` | 替换参考音频 |
| DELETE | `/v1/voices/{id}` | 删除音色 |
| POST | `/v1/tts` | 单条合成（返回 URL，可选内联 base64） |
| POST | `/v1/tts/stream` | 流式合成（NDJSON 分块，边收边播） |
| POST | `/v1/tts/batch` | 批量合成（可同步等待，或返回任务号） |
| POST | `/v1/tts/batch/plan` | 只展开清单，不合成 |
| POST | `/v1/text/split` | 预览官方切分结果 |
| POST | `/v1/train/plan` | 训练预检：逐阶段命令与参数 |
| POST | `/v1/train` | 提交训练任务 |
| POST | `/v1/train/upload` | 上传语料 |
| GET | `/v1/jobs` · `/v1/jobs/{id}` | 任务列表 · 任务详情（含日志） |
| POST | `/v1/jobs/{id}/cancel` | 取消任务 |

### 新板块（经同一本地服务暴露，网关同样透传）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/v1/engines` | 五个本地引擎（GPT-SoVITS / RVC / DDSP-SVC / UVR5 / ASR）的显存互斥状态 |
| POST | `/v1/engines/unload` | 手动卸载指定引擎并归还显存 |
| GET | `/v1/uvr/catalog` · `/v1/uvr/cache` | 分离档位与预置 · 缓存盘点 |
| POST | `/v1/uvr/separate` | UVR5 分离（人声 / 伴奏，可同步等待或任务化） |
| GET | `/v1/vc/catalog` · `/v1/vc/pipeline` | 变声模型库 · 引擎状态 |
| POST | `/v1/vc/models/load` · `/v1/vc/models/upload` | 热加载音色 · 导入 .pth/.index |
| POST | `/v1/vc/convert` | 语音变声（任务化，`wait=true` 可同步） |
| POST | `/v1/vc/merge` | 多权重音色融合（零训练） |
| POST | `/v1/vc/train/plan` · `/v1/vc/train` | 训练预检 · 提交训练（full / lora） |
| GET | `/v1/svc/catalog` · `/v1/svc/pipeline` | 歌声转换音色与档位 · 引擎状态 |
| POST | `/v1/svc/models/load` · `/v1/svc/models/upload` | 热加载 · 导入 .pt + config.yaml |
| POST | `/v1/svc/convert` | 干声直接转换 |
| POST | `/v1/svc/cover` | 翻唱向导：分离 → 转换 → 混音，三件套产物 |
| GET | `/v1/asr/catalog` · `/v1/asr/pipeline` | ASR 能力清单与两条通道体检 · 引擎状态 |
| POST | `/v1/asr/transcribe` | 单条转写（同步），供音色库的「一键智能转写」 |
| POST | `/v1/asr/train/plan` · `/v1/asr/train` | 训练入口预检 · 批量音频 → 逐字文本数据集 |
| GET | `/v1/asr/datasets` | 已生成的数据集盘点 |

统一响应格式：成功 `{ ok: true, ... }`；失败 `{ ok: false, error: { code, message, retryable, hint } }`。
`hint` 是面向使用者的「下一步该做什么」，前端会直接展示。

---

## 配置项

网关配置见 [`server/.env.example`](server/.env.example)，
本地服务配置见 [`trainer/.env.example`](trainer/.env.example)。
两份配置里的端口需要相互对应（默认 9881）。

最常改的几个：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `MIMO_API_KEY` | 空 | 留空则要求用户在页面里自带密钥 |
| `SOVITS_AUTOSTART` | `false` | 设为 `true` 时由网关自己拉起 Python 服务（默认交给启动编排器） |
| `GPT_SOVITS_HOME` | 自动探测 | 整合包不在项目同级目录时显式指定 |
| `TTS_DEFAULT_VERSION` | `v2ProPlus` | 默认模型版本 |
| `TTS_DEVICE` | `auto` | `auto` 交给官方按显存与算力决定 |
| `TTS_WARMUP` | `true` | 启动后后台预加载模型 |
| `TTS_DATA_DIR` | `trainer/.data` | 音色库与产物的落盘位置 |
| `OUTPUT_RETENTION_DAYS` | `30` | 输出音频保留天数，`0` 表示不清理 |

---

## 已知边界与限制

如实说明，避免把期望建立在不存在的功能上：

- **GPT-SoVITS 没有内置音色**，也不能用文字描述凭空生成音色。它的一切音色都来自
  参考音频（零样本）或训练权重（少样本）。界面已按此声明能力。
- **参考音频必须是 3~10 秒**，这是官方 `_set_prompt_semantic` 的硬约束，
  超出会直接报错，页面会在导入时提前提示。
- **v3 / v4 不支持流式推理**（官方使用声码器，代码里明确不支持），
  请求流式时会返回可读的错误而非静默降级。
- **单卡串行，且训练会独占显卡**。批量合成是串行的（这正是它快的原因：一次提交几百条）；
  训练开始前服务会**主动释放推理模型**，训练期间合成请求会被明确拒绝
  （提示「训练正在占用显卡」），训练结束后下次合成会自动重新加载模型。
  这是刻意的：在 8GB 级别的消费级显卡上，两者共存必然 OOM。
- **训练耗时**：本页的流水线是真的在跑官方脚本。1 分钟语料 + 8 epoch 的量级通常在
  十几分钟到半小时；中途可以看到每个阶段的输出。
- **v3/v4 训练走 LoRA**（官方 `s2_train_v3_lora.py`），v1/v2/v2Pro/v2ProPlus 走全量微调。
- **CPU 推理**可用但很慢（官方 RTF 数据：RTX 4060Ti 约 0.028，CPU 约 0.5）。
- 合成结果保存在**浏览器 IndexedDB**（历史记录）与 `trainer/.data/outputs`（服务端产物），
  两者独立；清理其中一个不影响另一个。

---

## 数据与隐私

- 使用 **GPT-SoVITS（本地）** 时，音频、语料、模型权重全部留在本机，
  `trainer/.data` 是唯一的运行期写入位置，可直接拷贝备份。
- 使用 **MiMo（云端）** 时需要联网，音频由 MiMo 官方接口生成；
  API Key 若填在页面里，只存浏览器 localStorage，不落服务端。
- 网关与本地服务默认只监听 `127.0.0.1`。要让局域网内其它设备访问，
  需显式改 `HOST=0.0.0.0`，并自行确认网络环境可信。
- 克隆他人声音需获得明确授权；禁止用于伪造身份、诈骗等违法用途。

---

## 文档

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) —— 三层架构与关键设计取舍
- [`docs/GPT-SOVITS.md`](docs/GPT-SOVITS.md) —— 从官方仓库移植了哪些能力、文件与参数对照
- [`docs/TRAINING.md`](docs/TRAINING.md) —— 本地训练完整指南与调参建议
- [`docs/ASR.md`](docs/ASR.md) —— 语音转文本的模块划分、两条通道与训练入口的调用关系
- [`trainer/README.md`](trainer/README.md) —— 本地模型服务的分层、接口与排障

## 常见问题

**双击 `start.bat` 后窗口一闪就没了**
说明某个前置检查失败了。脚本在出错时都会 `pause` 等待按键，所以如果窗口真的直接消失，
通常是文件被改动过（例如另存为带 BOM 的 UTF-8，会让第一行报「不是内部或外部命令」）。
在终端里执行 `start.bat` 就能看到完整报错。

**页面一片全白，什么都没有**
先看浏览器控制台。渲染期异常会被错误边界兜住，显示成一张「页面渲染出错」的卡片 ——
里面有错误信息、调用栈，以及「重置本地配置后重载」按钮，按提示操作即可
（只会清掉设置项，历史记录不受影响）。

如果连这张卡片都没有，说明前端资源根本没加载成功：确认终端里 Vite 打印了
`Local: http://localhost:5173/`，再在浏览器控制台的 Network 面板看是否有 404。

**提示端口 8787 或 5173 被占用**
上一次的服务没关干净。脚本会打印占用进程的 PID，执行 `taskkill /F /PID <PID>` 即可。

**本地模型服务一直起不来**
先跑 `npm run sovits:check` 看体检报告，它会指出具体缺什么（整合包、解释器、显卡、权重）。

**只想用 MiMo 云端，不想启动本地模型服务**
用 `npm run dev:cloud`，它只启动网关与前端，不会拉起 Python 服务。
界面上的 GPT-SoVITS 入口会提示服务未就绪，MiMo 功能不受影响。

---

## 致谢

- [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS)（MIT）—— 本地推理与训练的全部能力来源
- [RVC-Project/Retrieval-based-Voice-Conversion-WebUI](https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI)（MIT）—— 语音变声板块的上游
- [yxlllc/DDSP-SVC](https://github.com/yxlllc/DDSP-SVC)（MIT）—— 歌声转换板块的上游
- [UVR5](https://github.com/Anjok07/ultimatevocalremovergui)（MIT）—— 人声 / 伴奏分离（随 GPT-SoVITS 整合包提供）
- [GPT-SoVITS 语雀指南](https://www.yuque.com/baicaigongchang1145haoyuangong/ib3g1e) —— 数据准备与排障的权威参考
- 小米 MiMo 语音合成 —— 云端预置音色链路

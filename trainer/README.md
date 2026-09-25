# GPT-SoVITS 本地服务

本目录是项目的**模型服务层**：把官方 GPT-SoVITS 的推理与训练能力包成一套 HTTP 接口，
供 Node 网关（`../server`）与前端（`../app`）使用。

它不是一个可以随便挑个 Python 就跑的服务 —— 见下文「解释器」。

---

## 启动

```bash
# 推荐：由项目脚本挑好解释器再启动
cd ..
npm run dev:sovits          # Windows / Linux 均可（内部会分派到 start.ps1 / start.sh）

# 只做环境体检（退出码 0 表示就绪）
npm run sovits:check
```

也可以直接在任意 Python 下启动，`server.py` 会自动切换解释器：

```bash
python server.py                # 本地模式
python server.py --check        # 体检
python server.py --no-open      # 不自动打开浏览器
python server.py --port 9881 --home D:/GPT-SoVITS
```

日常使用时**不需要单独启动它**：`npm run dev` 会把它作为一个独立任务拉起，
与网关、前端并列 —— 这样改后端代码触发的网关重启（`tsx watch`）不会连带重启模型服务。

只有单独跑 `npm run dev:server` 时，才需要把 `SOVITS_AUTOSTART` 设为 `true`
（见 `../server/.env.example`），让网关自己拉起它。

---

## 解释器（最容易踩的坑）

torch 装在 GPT-SoVITS 整合包自带的 `runtime/` 里。
如果直接 `import torch` 失败，**不要**在这里装 torch —— 那样会得到两个互相冲突的环境。

正确做法是让服务跑在整合包自带的解释器里：

- 什么都不用做：`server.py` 启动时会自己判断并 `os.execve` 切换到该解释器；
- 或显式指定：`--python` / 环境变量 `TTS_PYTHON`。

服务本身只额外依赖 `fastapi` / `uvicorn` / `pydantic` / `python-multipart` / `PyYAML`，
整合包自带的 runtime 里已有这几个包，开箱可用。

---

## 分层

```
trainer/
├── server.py                 # 入口：解释器自举 → 环境体检 → 启动 uvicorn
├── app/
│   ├── sovits/               # 与官方仓库的直连层
│   │   ├── bootstrap.py      # 定位安装、注入 sys.path、chdir、加载官方模块
│   │   ├── catalog.py        # 官方能力清单（版本 / 语种 / 切分方式 / 预训练权重映射）
│   │   ├── pipeline.py       # 官方 TTS 管线常驻封装：权重热切换、串行推理、错误翻译
│   │   ├── synth.py          # 统一请求 → 官方 inputs 的翻译与前置校验
│   │   └── voices.py         # 音色库（参考音频 + 提示文本）
│   ├── inference.py          # 合成执行层：准备 → 调用 → 落盘 → URL
│   ├── batch.py              # 批量合成：清单展开、逐条容错、ZIP + manifest + CSV
│   ├── training.py           # 训练流水线：11 个阶段，全部调用官方脚本
│   ├── api.py                # HTTP 路由
│   ├── jobs.py / queue.py    # 任务持久化与调度（进度 / 日志 / 取消）
│   ├── asr/                  # 语音转文本板块：catalog / bootstrap / pipeline / training
│   ├── discovery.py          # 整合包定位与权重盘点
│   └── runtime.py            # 运行环境探测（启动前子进程 / 运行中进程内）
├── requirements.txt
└── .env.example
```

三条硬性约束，改动前请先读：

1. **本目录必须兼容 Python 3.9**（整合包自带的解释器版本）。
   Pydantic 会在定义模型时即时求值注解，因此 `trainer/app/models.py` 里
   **不能**使用 PEP 604 的 `str | None`，必须写 `Optional[str]`。
   违反这条会在 `import` 阶段直接抛 `TypeError`。
2. **`catalog.py` 是唯一允许出现官方常量的地方。** 其余模块一律从这里取值，
   这样官方升级只需改一处。
3. **推理与训练都通过官方脚本/模块执行**，不要在本目录里重新实现算法。

---

## 数据目录

运行期数据默认落在 `trainer/.data/`（可用 `TTS_DATA_DIR` 改）：

```
.data/
├── voices.json            # 音色库索引
├── voices/                # 音色库的参考音频
├── outputs/               # 合成产物；批量任务在 outputs/batch/<任务号>/
├── jobs/                  # 任务元数据（服务重启后仍可查历史与日志）
├── uploads/               # 上传的语料
├── asr/                   # 语音转文本：datasets/ 数据集、work/ 中间 wav、script/ 脚本通道产物
└── experiments/<实验名>/   # 训练实验：dataset/ 配置 日志 检查点
```

该目录已被 `.gitignore` 忽略，可直接整体拷贝做备份。

---

## 配置

全部通过环境变量，见 [`.env.example`](.env.example)。
本服务刻意不引入 dotenv 依赖 —— `.env` 不会自动生效，
请直接导出环境变量，或用 `scripts/start.ps1` / `start.sh` 的参数传入。

最常改的几个：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `9881` | 监听端口，需与 `../server/.env` 的 `SOVITS_URL` 对应 |
| `GPT_SOVITS_HOME` | 自动探测 | 整合包根目录 |
| `TTS_DEFAULT_VERSION` | `v2ProPlus` | 默认模型版本 |
| `TTS_DEVICE` | `auto` | `auto` 交给官方按显存与算力决定 |
| `TTS_WARMUP` | `true` | 启动后后台预加载模型 |
| `TTS_DATA_DIR` | `./.data` | 运行期数据目录 |
| `MAX_BATCH_ITEMS` | `200` | 单次批量合成的条目上限 |
| `INFER_TIMEOUT_S` | `600` | 单次合成超时 |
| `TRAIN_TIMEOUT_S` | `259200` | 单个训练步骤超时（默认 72 小时） |

---

## 排障

**先跑体检**，它会告诉你「下一步该做什么」：

```bash
python server.py --check        # 人读格式
python server.py --check --json # 机器可读
```

也可在服务运行时查 `GET /health`（同样的信息），
或用 `-v` 打开调试日志（`TTS_VERBOSE=true`）。

常见情况：

| 现象 | 原因与处理 |
| --- | --- |
| `未定位到 GPT-SoVITS 安装目录` | 设置 `GPT_SOVITS_HOME`，或把整合包放到项目同级目录 |
| `当前解释器缺少 torch` | 用整合包自带的 `runtime/python.exe` 启动，或让 `server.py` 自动切换 |
| `版本 X 缺少可用的预训练权重` | 补齐 `GPT_SoVITS/pretrained_models/`（见 `/health` 的缺失清单） |
| 合成报「参考音频时长不在 3~10 秒」 | 官方硬约束，重新裁剪参考音频 |
| 合成报「显存不足」 | 降低 batch_size、关闭并行推理、换更小的版本，或先停掉其它占卡程序 |
| 任务一直停在 `queued` | 检查 `/v1/scheduler` 的 `ready` 字段；若为 `false`，说明调度器未在事件循环内启动 |

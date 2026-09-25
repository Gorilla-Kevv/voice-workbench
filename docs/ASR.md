# ASR 语音转文本：模块划分与调用关系

本文回答两个问题，其余细节都在代码注释里：

1. **ASR 板块与主项目其它部分的边界在哪** —— 谁能碰谁、谁不该碰谁；
2. **训练入口的职责范围与调用关系** —— 它做什么、不做什么、被谁调用。

---

## 1. 为什么值得单独一个板块

项目里所有音色都来自参考音频，而参考音频必须配一段**逐字转写文本**：
缺文本相似度明显下降，v3/v4 模型直接报错。在此之前这段文本只能靠人一边听一边打 ——
慢，而且必然出错字，错字会被**直接学进模型**，表现为某些字读音怪异，事后极难定位。

于是有两个场景，它们的参数取向、耗时量级、失败后果都不同，
但共用同一套「音频 → 文本」能力，这就是板块的切分依据：

| 场景 | 入口 | 用户期待 |
| --- | --- | --- |
| 导入音色时填「参考文本」 | 「导入音色」里的「一键智能转写（标注 ASR 模型）」 | 点一下就出字，几秒内 |
| 把一批语料变成可训练的数据 | 「语音转文本」页面的**训练入口** | 几百条慢慢跑，能看进度、能取消 |

---

## 2. 模块划分

### 2.1 后端板块：`trainer/app/asr/`

| 文件 | 职责 | 依赖 |
| --- | --- | --- |
| `catalog.py` | 能力清单与场景预设。纯常量，无副作用 | `sovits/catalog.ASR_BACKENDS` |
| `bootstrap.py` | 整合包与官方脚本定位、两条通道的可用性探测、`AsrError` | `sovits/bootstrap`、`errors` |
| `pipeline.py` | `AsrEngine`：模型常驻、单条转写、结果缓存、卸载与状态 | `audio/io`、`audio/cache`、`bootstrap`、`catalog` |
| `training.py` | **训练入口**：批量音频 → 逐字文本数据集（含官方格式清单） | `annotations.write_list`、`audio/io`、`bootstrap` |

### 2.2 后端装配层：只有三处知道 ASR 的存在

| 位置 | 改了什么 | 为什么必须在这里 |
| --- | --- | --- |
| `engine.py` 的 `ENGINES` | 多一个 `asr` 引擎（`required_mb=2048`） | 引擎注册表是显存互斥的**唯一**仲裁者，ASR 与 TTS / RVC / DDSP-SVC 抢同一张卡 |
| `routers/__init__.py` | 调用 `asr.register(app, ctx)` | 新板块路由的统一挂载点 |
| `api.py` 的 `Context` 与 `register_runners` | 造一个 `AsrEngine`、`register_unloader("asr", ...)`、注册 `JobKind.ASR_TRAIN` 的执行体 | 对象生命周期与任务执行体只在装配层创建 |

### 2.3 HTTP 层：`trainer/app/routers/asr.py`

只做三件事：解析输入（上传 / 本机路径）、参数归一、把工作交给引擎或任务队列。
它不加载模型、不做音频处理 —— 那些在 `asr/` 里。

### 2.4 前端

| 文件 | 职责 |
| --- | --- |
| `types/asr.ts` | 与后端一一对应的契约类型（改后端时对照修改） |
| `lib/asr.ts` | `asrApi`：只用 `localRequest` / `appendForm`，不重复实现请求封装 |
| `pages/AsrPage.tsx` | 独立入口页面：单条转写 + 训练入口 + 数据集列表 |
| `pages/VoiceLibraryPage.tsx` | 「导入音色」里的「一键智能转写（标注 ASR 模型）」按钮 |
| `App.tsx` / `components/layout/AppShell.tsx` / `types/index.ts` | 导航键、页面路由、侧栏就绪卡片（与其它板块同一套写法） |

### 2.5 边界：什么不该发生

- ASR 板块**不依赖**任何其它板块的业务代码（不 import `vc/`、`svc/`、`inference.py`）。
- 其它板块**不依赖** ASR 板块。GPT-SoVITS 的训练流水线仍然自己跑官方 ASR 脚本，
  不会因为 ASR 板块改一行而改变行为（见 2.7）。
- 路由层不 import `funasr` / `faster_whisper`；模型加载只发生在 `pipeline.py`。
- `pipeline.py` 不认识 FastAPI；`training.py` 不认识节点调度（它只接收回调）。

### 2.6 借用的共享资产（单向依赖）

| 资产 | 提供什么 | 为什么复用而不是各写一份 |
| --- | --- | --- |
| `audio/io.py` | 探测 / 解码 / 重采样 / 转 16k 单声道 wav | 「把用户给的东西变成干净波形」各写一遍，必然出现「RVC 能吃、ASR 吃不下」 |
| `audio/cache.py` | 按「内容指纹 + 阶段 + 参数」缓存 | 同一段参考音频反复转写、改个备注再保存，不该重复算一遍 |
| `sovits/catalog.ASR_BACKENDS` | 后端 / 尺寸 / 语种 / 精度的官方清单 | 训练流水线的 ASR 阶段读的就是它，两份清单必然漂移 |

### 2.7 与「训练流水线里的 ASR 阶段」的关系（重要）

| | 训练流水线的 ASR 阶段（既有） | ASR 板块（本次新增） |
| --- | --- | --- |
| 位置 | `training.py` 的 `Stage("asr")` | `asr/` + `/v1/asr/*` |
| 触发 | GPT-SoVITS 微调流程的第 5 步 | 用户点按钮 / 提交任务 |
| 实现 | 子进程跑整合包 `tools/asr/*.py` | 常驻模型（优先），或同一批官方脚本（降级） |
| 产出 | `dataset/asr/*.list`（训练清单） | 逐字文本 + `dataset.list` + `index.csv` + `manifest.json` |
| 归属 | 属于 GPT-SoVITS 流水线；切分之后必须开 | 独立能力，任何「音频 → 文本」场景都可用 |

两者是**同源不同途**：脚本通道用的就是同一条命令，所以结果可以互相对照。
刻意**不**把训练流水线改成调用 ASR 板块 —— 训练链路的可复现性优先于代码复用，
而且流水线里的 ASR 是「整目录批处理」，与单条转写的语义并不相同。

---

## 3. 两条通道：`resident` 与 `script`

上游（FunASR / faster-whisper）没有给一个可以常驻的「类」，
只有两个命令行脚本（`tools/asr/funasr_asr.py`、`tools/asr/fasterwhisper_asr.py`），
设计用途是「给一个目录，产出标注」—— 批处理打标，而不是「给一段音频，立刻还我文本」。

| | `resident`（常驻优先） | `script`（脚本降级） |
| --- | --- | --- |
| 做法 | 直接 import `funasr` / `faster_whisper`，模型常驻内存 | 子进程跑官方脚本，cwd 为整合包根目录 |
| 速度 | 单条秒级（首次要加载模型） | 每条都要重新加载模型，分钟级 |
| 前提 | 服务所在解释器里装了对应包 | 能定位到整合包，且 `tools/asr/` 下有脚本 |
| 模型标识 | `catalog.RESIDENT_MODELS`（本板块唯一与上游命名耦合处） | 官方脚本的 `-s/-l/-p` 语义 |

选择顺序由 `bootstrap.resolve_channel()` 决定：默认**常驻优先**，
常驻不可用时自动降级到脚本，两条都不通则抛 `ASR_BACKEND_UNAVAILABLE` 并给出两条修复路径。

**降级一定是显式的**：结果里带 `channel` 与 `reason`，前端把它显示出来。
静默降级比慢几秒的代价大得多 —— 用户以为在用 large，实际跑的是 small，
被污染的参考文本会直接进音色库。

前端还可以强制通道（「优先通道」选择自动 / 常驻 / 脚本），
用来做「官方脚本结果对照」这类排查。

### 3.1 参数归一

`catalog.normalize()` 把用户给的四元组（backend / size / language / precision）
收敛到「该后端确实支持」的取值上，并把每一处纠正写进 `notes`。
不静默替换：用户以为自己用了 large，实际跑的是 medium，这种误会比报错更糟。

---

## 4. 训练入口的职责范围与调用关系

### 4.1 职责范围

**做**：

1. **采集** —— 把「语料目录 + 上传文件列表」摊平成待转写清单（按绝对路径去重、按时长过滤）；
2. **转写** —— 逐条调用引擎；单条失败不中断整批，失败原因逐条记录；
3. **导出** —— 逐字文本（一条一个文件）、官方格式清单、`index.csv`、`manifest.json`。

**不做（有意为之）**：

- **不给 ASR 模型本身做微调。** 上游没有把微调做成稳定的 CLI，让一个本地工作台去对接
  各家训练脚本只会带来版本地狱。扩展点已经留好：在 `training.run()` 里加一个阶段即可，
  不需要动其它任何文件。
- **不做音频切分。** 过长的音频按时长直接过滤掉并如实告知（`rejected` 计数 + 样例）。
  切分能力在 `audio/slicer.py`，要接进来也只需在采集阶段加一步。
- **不校验文本对错。** 逐字校对是既有「标注校对」（`/v1/annotations/*` + `annotations.py`）
  的职责。数据集产出的 `dataset.list` 就是它认的格式，两者天然衔接 ——
  ASR 打底稿、人工校对，是这个项目里唯一正确的分工。

### 4.2 调用关系

训练入口（任务化，可进度、可取消）：

```
前端 AsrPage
├─ POST /v1/asr/train/plan → routers/asr.py: asr_train_plan
│    └─ asr/training.plan() → AsrEngine.resolve()（参数归一 + 通道选择）→ 返回命令/产物路径
└─ POST /v1/asr/train      → routers/asr.py: asr_train
     └─ JobStore.create(JobKind.ASR_TRAIN) → Scheduler.submit(job)
          └─ routers/asr.py: make_asr_train_runner（调度器执行）
               ├─ EngineRegistry.acquire("asr")      ← 显存互斥的唯一入口
               └─ asyncio.to_thread(training.run, ctx.asr, request, progress, log, cancelled)
                    ├─ collect()                扫描 + 去重 + 时长过滤
                    ├─ AsrEngine.transcribe()   逐条（命中缓存则直接取）
                    └─ _export()                文本 / dataset.list / index.csv / manifest.json
```

单条转写（同步，不建任务）—— 也就是「一键智能转写」：

```
音色库按钮 / AsrPage「开始转写」
└─ POST /v1/asr/transcribe（multipart：file 或 source）
     └─ routers/asr.py: asr_transcribe
          ├─ EngineRegistry.acquire("asr")
          └─ asyncio.to_thread(AsrEngine.transcribe)
               ├─ audio/io.probe → 时长校验 → audio/io.to_mono_wav(16k 单声道)
               ├─ audio/cache 命中？→ 直接返回（cached=true）
               └─ 未命中 → _run_resident() 或 _run_script()
```

任务池归属：`JobKind.ASR_TRAIN` 登记在**推理池**（`jobs.INFER_POOL`）。
它名字里有 train，做的是逐条推理 —— 让它去占「训练」位会把显卡标记成「训练中」，
从而拒绝其它推理请求，那是 GPT-SoVITS 微调才该有的语义。

### 4.3 产物

```
trainer/.data/asr/
├── datasets/<name>/
│   ├── transcripts/0001_xxx.txt   逐字文本，一条一个文件（重跑时命中即跳过）
│   ├── dataset.list               官方格式：绝对路径|说话人|语种|文本
│   ├── index.csv                  UTF-8 BOM 写出，Excel 直接打开不乱码
│   └── manifest.json              每条的状态 / 通道 / 耗时 / 失败原因
├── work/                          16k 中间 wav（用完即删）
└── script/                        脚本通道的临时输入输出目录
```

转写缓存另存 `.data/cache/asr/<key>/`，键 = 音频内容指纹 + 归一化参数
（换语种、换尺寸不命中；文件改名、复制一份仍命中）。

---

## 5. 接口一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/v1/asr/catalog` | 能力清单 + 两条通道体检 + 引擎状态 + 已有数据集 |
| GET | `/v1/asr/pipeline` | 引擎状态（是否常驻、当前参数、缓存统计） |
| POST | `/v1/asr/plan` | 只算「会怎么跑」：通道 / 模型 / 被纠正的参数 |
| POST | `/v1/asr/models/load` · `/v1/asr/models/unload` | 加载 / 释放常驻模型 |
| POST | `/v1/asr/transcribe` | **单条转写（同步）**，供「一键智能转写」 |
| POST | `/v1/asr/upload` | 批量上传音频，返回落盘路径 |
| POST | `/v1/asr/train/plan` | **训练入口预检**：条数、通道、产物路径、将执行的命令 |
| POST | `/v1/asr/train` | **训练入口**：提交数据集构建任务（返回 `job_id`） |
| GET | `/v1/asr/datasets` | 已生成的数据集盘点 |

统一响应格式与其它板块一致：成功 `{ ok: true, ... }`，
失败 `{ ok: false, error: { code, message, retryable, hint } }`。

---

## 6. 配置项

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `ASR_BACKEND` | 空 | 留空 = 自动（常驻优先，其次官方脚本）；可选 `funasr` / `fasterwhisper` |
| `ASR_SIZE` | `large` | 官方脚本的尺寸语义（tiny~large / large-v3） |
| `ASR_LANGUAGE` | `zh` | 默认语种 |
| `ASR_PRECISION` | `float32` | 精度。FunASR 的 `-p` 官方标注「尚未接入」，实际不生效 |
| `ASR_DEVICE` | `auto` | 常驻通道的设备 |
| `ASR_CACHE` | `true` | 转写结果缓存 |

---

## 7. 已知边界与限制

- **不管理 ASR 权重。** 常驻通道首次使用由 funasr / ModelScope / HuggingFace 自己拉权重，
  `scripts/download_models.py` 不管它们，所以**没有** `--engine asr` 这个选项。
- **单条上限 900 秒**（`pipeline.MAX_CLIP_SECONDS`）：超出直接拒绝并提示先切分。
  长音频整段识别既慢，又容易在静音段「瞎编词」。
- **脚本通道慢**是设计使然（每条都重新加载模型）。批量请用常驻通道。
- **与其它引擎互斥**：转写会请走 GPT-SoVITS 推理管线，
  之后第一次合成要重新加载模型（30~90 秒）。这是单卡 8GB 上必然的代价，
  与 UVR5 / RVC / DDSP-SVC 的规则完全一致。
- **中文与多语种的取舍**：中文场景 FunASR（Paraformer）明显强于 Whisper；
  语种不确定时用 faster-whisper，方言与中英混说可以试 SenseVoice。
- **视频不能直接喂**：所有 ASR 都只吃音频，先抽音轨 ——
  `ffmpeg -i in.mp4 -vn -ar 16000 -ac 1 -c:a pcm_s16le audio.wav`。
- **自动转写的结果必须人工核对**：错字会被直接学进音色，
  所以界面上的按钮文案保留了「标注 ASR 模型」这个提示，转写结果也只是**填入**文本框，
  不会被自动保存。

---

## 8. 验证记录

2026-09-26，在真实整合包（`GPT-SoVITS-v2pro-20250604`，自带解释器 Python 3.9.13）上完成。

### 8.1 对照官方脚本核对了清单（发现三处会直接导致脚本报错的偏差）

`tools/asr/*.py` 的 argparse 是有 `choices` 的，清单写错不会降级，只会「invalid choice」退出。

| 项 | 修正前 | 官方实际 | 后果 |
| --- | --- | --- | --- |
| funasr sizes | `tiny~large` | 只有 `large`（`-s` 是占位，模型由 `create_model()` 固定为 Paraformer-large） | 选 small 时脚本照跑，参数却是假的 |
| funasr languages | `zh/en/ja/ko/yue` | `-l` 的 choices 是 `zh/yue/auto`，而 `create_model()` 只处理 `zh` 与 `yue`（传 auto 会抛 `ValueError`） | 选 en / auto 直接崩 |
| fasterwhisper sizes | `tiny/base/small/...` | `-s` 的 choices 来自 `tools/asr/config.py::get_models()` = `medium / medium.en / large-v2 / large-v3 / large-v3-turbo`（脚本另把 `large` 归一成 `large-v3`） | 选 tiny/base/small 直接退出 |

三处已按官方修正，并写回 `sovits/catalog.ASR_BACKENDS`（训练流水线的 ASR 阶段同样受益）。

### 8.2 实测数据

- **依赖齐备**：整合包 runtime 里 `torch / funasr / faster_whisper / modelscope / soundfile / librosa` 都在，两条通道实测都是 `resident` 可用。
- **本地权重复用**：`tools/asr/models/` 下已有 Paraformer-large + FSMN-VAD + CT-PUNC，常驻通道直接吃本地路径（`funasr_source: local`），**加载 4.4 秒**，不再联网下载同一套权重。
- **两条通道一致**：同一段 10 秒音频，常驻通道 **0.37 秒**，脚本通道（子进程跑官方 `funasr_asr.py`）**38~40 秒**，两者文本**完全一致**。这就是「常驻优先」的实证 —— 脚本通道那 40 秒几乎全花在加载模型上。
- **缓存命中**：第二次转写 0.12 秒，文本一致。
- **训练入口**：2 条音频 → 成功 1 / 空文本 1 / 失败 0，`dataset.list` + `index.csv` + `manifest.json` 齐备。

### 8.3 与推荐文档（`asr类模型项目推荐.md`）的对照

| 文档建议 | 本项目现状 | 结论 |
| --- | --- | --- |
| 中文 + 显卡 → Qwen3-ASR-1.7B | 不在整合包生态，需额外装 transformers/Qwen，权重另下 | **未接**。需要时可加为第三后端，扩展点就在 `catalog` + `bootstrap`，不用动其它文件 |
| 纯 CPU → SenseVoice-Small | 已在常驻通道模型清单里（`iic/SenseVoiceSmall`），首次使用需下载 | **可用**，且正好补上官方 funasr 脚本不支持 en / ja / ko 的缺口 |
| 一站式（VAD + 标点 + 说话人）→ FunASR | 正是整合包自带方案（Paraformer + FSMN-VAD + CT-PUNC） | **已采纳为默认后端** |
| 语种不可预测 → faster-whisper large-v3 | 整合包自带，作为多语种后端 | **已采纳** |
| 词级时间戳 → WhisperX / Qwen3-ForcedAligner | 未接（参考文本不需要时间戳） | 非目标；faster-whisper 的 `segments` 已带秒级时间戳 |

结论：当前选型（FunASR 默认 + faster-whisper 多语种）与推荐文档方向一致，且**零新增依赖** —— 对「音频不出本机」的本地工具来说，这条约束比榜单上的几个百分点更重要。

### 8.4 验证过程中修掉的两个问题

1. **空文本被统计成「失败」**：纯静音、纯音乐、语种不符都会得到空串，它不是服务出错。
   现在单独记为 `empty`，并在清单里写明「可能是纯静音、纯音乐，或语种与所选语言不符」。
2. **语种与后端不匹配时把语种改掉**：原本「FunASR + 英文」会被改成「FunASR + 中文」，
   等于把英文音频当中文转（Paraformer 会吐出一串似是而非的汉字）。
   现在的处理是**换后端而不是换语种**：FunASR 不支持的语种自动交给 faster-whisper，并把原因写进 `notes`。

另外对齐了官方的两条行为：faster-whisper 识别到中文 / 粤语时转交 FunASR
（官方 `fasterwhisper_asr.py::execute_asr()` 就是这么做的），以及在参数阶段直接切换 ——
省掉一次 Whisper 加载，而不是等识别完再把模型换来换去。

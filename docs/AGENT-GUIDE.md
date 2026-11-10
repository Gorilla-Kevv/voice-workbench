# 语音工作台 · Agent 使用指南

> 面向**借用本工作区模型能力**的外部 Agent。目标：读完本文件即可发现能力、启动依赖、调用合成/转写/变声/分离，并避开显存与协作红线。
>
> - 适用范围：`F:\schoolCompWorks\clone\ttstool`（voice-workbench）
> - 版本：2026-10-29
> - 更细的契约：`docs/OPEN-API.md`（HTTP）、`docs/CLI.md`（命令行）、`HANDOFF.md`（环境/坑）、`PROGRESS.md`（阶段台账）
> - 本文件是**面向使用者的单一入口**；改端口/接口/红线时先改这里，再同步其它文档。

---

## 0. 60 秒上手

```bash
# 1) 环境体检：网关是否在跑、哪些能力当前可用（不占显存）
node -e "fetch('http://127.0.0.1:8787/api/capabilities').then(r=>r.json()).then(d=>console.log(JSON.stringify({vram_free_mb:d.vram_free_mb,capabilities:d.capabilities.map(c=>({id:c.id,available:c.available,loaded:c.loaded,vram:c.vram_required_mb}))},null,2)))"

# 2) 单条合成（推荐给 Agent：stdout 只有 JSON）
node scripts/say.mjs --model gpt-sovits-v2proplus --voice <音色库id> --text "你好，世界。" --out out.wav

# 3) 批量合成（异步轮询 + 下载）
node scripts/say.mjs batch --voice <音色库id> --file lines.txt --out-dir out/batch1 --zip
```

三条硬性前提：

1. **网关** `127.0.0.1:8787` 必须可达；没起就 `npm run dev` / `npm run dev:cloud`。
2. **对应运行时**必须已启动（详见 §3）；Open API **不会**替你拉起运行时。
3. **显存**够用（8GB 卡，同一时刻只容一个本地引擎）；先看 `capabilities.vram_free_mb` 和 `available`。

---

## 1. 这是什么 / 不是什么

**是**：纯本地语音工作台。六个 Python 运行时提供 TTS / ASR / 变声 / 歌声转换 / 音源分离，Node 网关统一转发，React 前端只用于人工操作。

**不是**：

- 不是云服务，也没有鉴权：网关默认只监听回环地址。**不要把它暴露到公网**。
- 不是同步批处理 API：批量 / 训练是异步 job，必须轮询。
- 不是模型管理器：不会因一次调用自动下载权重；缺权重会报 `WEIGHTS_MISSING`。
- 不是通用工作流引擎：单条合成/转写/转换有 Open API；批量与训练走原生透传端点。

---

## 2. 架构与端口

| 组件 | 端口 | 职责 | 启动方式 |
| --- | --- | --- | --- |
| Node 网关 | **8787** | 前端托管、`/api/*` 代理、能力发现、Open API、资源仲裁 | `npm run dev:server` |
| React 前端（dev） | 5173 | 人工页面；Agent 一般不需要 | `npm run dev:app` |
| 主运行时 `trainer/` | **9881** | GPT-SoVITS v2、RVC、DDSP-SVC、ASR、UVR5；训练链 | `npm run dev:sovits` 或设置页开关；**设置页已启用时**，`/api/sovits/*` 首次请求会自动拉起 |
| 网易 `netease/` | **9882** | Confucius4-TTS、R2T2 离线转写 | `npm run dev:netease`（`npm run dev` 默认包含） |
| IndexTTS `indextts/` | **9883** | IndexTTS-2.5（8 维情感） | `npm run dev:indextts` 或设置页开关；**不自动拉起** |
| Irodori `irodori/` | **9884** | 日语 TTS + emoji 情感 | `npm run dev:irodori` 或设置页开关；**不自动拉起** |
| GPT-SoVITS v5 `gsv5/` | **9885** | v5turbo / v5dev 推理底模 | `npm run dev:gsv5` 或设置页开关；**不自动拉起** |
| CosyVoice3 `cosyvoice/` | **9886** | 9 语言 + 18 中文方言 / 自然语言 instruct | `npm run dev:cosyvoice` 或设置页开关；**不自动拉起** |

启动组合：

| 命令 | 启动内容 |
| --- | --- |
| `npm run dev` | netease + 网关 + 前端（**不含** :9881 / :9883 / :9884 / :9885 / :9886） |
| `npm run dev:all` | `dev` + GPT-SoVITS :9881 |
| `npm run dev:cloud` | 只起网关 + 前端 |
| `npm run dev:server` | 只起网关 |
| `npm run dev:sovits` / `dev:netease` / `dev:indextts` / `dev:irodori` / `dev:gsv5` / `dev:cosyvoice` | 单运行时 |
| 体检 | `npm run sovits:check` / `netease:check` / `indextts:check` / `irodori:check` / `gsv5:check` / `cosyvoice:check` |

> **自动拉起差异**：GPT-SoVITS 只有在设置页**已启用**（`server/.data/sovits-service.json`，默认关）时，`/api/sovits/*` 代理才会在 :9881 未运行时让 supervisor 尝试拉起；未启用时返回 503。`/api/open/*` 直接访问运行时，**任何情况下都不会拉起**。netease / indextts / irodori / gsv5 / cosyvoice 的代理也不自动拉起。

---

## 3. 启动、停止与体检（Agent 必读）

- **不要为了测试擅自拉起模型服务**。先 `nvidia-smi` 看显存；需要启动时优先用设置页开关或上表命令，用完按需卸载/停止。
- 停服务优先走接口/设置页，不要杀不认识的 `python.exe`（桌面常驻进程很多）。
- 模型加载态与任务锁是两件事：`capabilities.loaded` 表示模型是否常驻；任务正在跑不代表模型「已加载」字段一定为 true。
- 显存门槛一律以 `GET /api/capabilities` 的 `vram_required_mb` 为准，不要在本指南/脚本里硬编码。

常用卸载：

```bash
# 卸载 trainer 内所有引擎（GPT-SoVITS / RVC / DDSP / ASR / UVR5）
curl -s -X POST http://127.0.0.1:8787/api/sovits/v1/engines/unload

# 各服务自身的卸载接口（经网关）
curl -s -X POST http://127.0.0.1:8787/api/indextts/v1/unload
curl -s -X POST http://127.0.0.1:8787/api/irodori/v1/unload
curl -s -X POST http://127.0.0.1:8787/api/gsv5/v1/unload
curl -s -X POST http://127.0.0.1:8787/api/netease/v1/confucius/unload
curl -s -X POST http://127.0.0.1:8787/api/netease/v1/r2t2/unload
```

---

## 4. 能力发现

| 端点 | 用途 |
| --- | --- |
| `GET /api/capabilities` | 全量能力 + 可用性 + 显存/权重/运行时就绪状态 + `vram_free_mb` |
| `GET /api/open/v1/models` | OpenAI 形状清单（`id/kind/available`） |
| `GET /api/models` | 本地权重模型库（RVC / DDSP-SVC / GPT-SoVITS） |
| `GET /api/voicelib` | 音色库列表（参考音频与转写文本） |

`capabilities` 关键字段：

- `available`：本地能力 = 运行时可达 **且**（固定模型时）权重/专用运行时就绪；MiMo = 服务端密钥已配置。
- `loaded`：模型当前是否常驻（`null` = 取不到）。
- `weights_ready` / `runtime_ready`：固定模型 ASR 的两道门（SenseVoice 有自己的 venv）。
- `vram_required_mb` / `vram_source`：门槛与真源；网关不硬编码。
- `vram_free_mb`：nvidia-smi 口径的空闲显存。

### 能力 ID（14 项）

| kind | id | 说明 |
| --- | --- | --- |
| tts | `gpt-sovits-v2proplus` | 零样本 / 自训权重；`params.version/gpt/sovits` |
| tts | `confucius4-tts` | 14 语种、免转写克隆、`quality` 三档 |
| tts | `indextts-2.5` | 8 维情感 + 语速；仅单段（分段是页面编排） |
| tts | `irodori-tts` | **仅日语**；emoji 情感、固化音色 |
| tts | `gpt-sovits-v5` | v5turbo（4 步）/ v5dev（32 步） |
| tts | `cosyvoice3-tts` | 9 语言 + 18 中文方言；`mode` ∈ zero_shot / cross_lingual / instruct2；24kHz；**实测 RTF 4.5~6.2**（8GB 卡），权重 5.05GB 已就位 |
| tts | `mimo` | 云端；需服务端密钥；不占本机显存 |
| asr | `paraformer-zh` | 中文逐字 + 标点首选 |
| asr | `sensevoice-small` | 中英日韩粤；耳语友好；独立 worker |
| asr | `faster-whisper` | `params.size`：medium / large-v3 / large-v3-turbo |
| asr | `r2t2-offline` | Qwen3-ASR 基座离线；长音频 240s 分段 |
| vc | `rvc-convert` | `params.model` = 引擎 key |
| svc | `ddsp-svc-convert` | `params.model` = `.pt` 绝对路径 |
| separation | `uvr5-separate` | 人声/伴奏；`preset` 默认 `vocal_fast` |

别名（`gsv5`、`rvc`、`netease-tts`、`whisper` 等）大小写不敏感，完整别名见 `/api/capabilities`。

---

## 5. 单条调用（Open API）

统一前缀 `http://127.0.0.1:8787/api/open`。

### 5.0 参考音频与音色库（推荐先入库）

推荐把参考音频登记到音色库，之后所有能力都用 `voice_id`，避免各引擎对路径/转写字段的差异。

```bash
# 列出音色
curl -s http://127.0.0.1:8787/api/voicelib

# 从本机文件登记（JSON）
curl -s -X POST http://127.0.0.1:8787/api/voicelib/source \
  -H "Content-Type: application/json" \
  -d '{"name":"demo","audio_path":"F:\\audio\\ref.wav","prompt_text":"参考音频的逐字文本","prompt_lang":"zh"}'

# 从字节登记（请求体 = 音频裸字节，元数据走查询参数）
curl -s -X POST "http://127.0.0.1:8787/api/voicelib?name=demo&prompt_text=%E5%8F%82%E8%80%83%E6%96%87%E6%9C%AC&prompt_lang=zh" \
  -H "Content-Type: audio/wav" --data-binary @ref.wav
```

### 5.1 TTS：`POST /v1/audio/speech`

```jsonc
{
  "model": "gpt-sovits-v2proplus",
  "text": "要合成的文本",
  "voice_id": "音色库 id",           // 推荐；或
  "ref_path": "F:\\audio\\ref.wav",  // 服务端绝对路径（按引擎可能需要 prompt 文本）
  "lang": "zh",
  "format": "wav",                  // wav（默认，裸字节）| json（base64 + 时长/耗时）
  "focus": false,                   // true = 先仲裁卸载其它引擎（单条专用）
  "timeout_ms": 900000,
  "params": { "quality": "balanced" }
}
```

参考音频怎么给：

| 能力 | 音色库 id | 服务端路径 | 备注 |
| --- | --- | --- | --- |
| gpt-sovits-v2proplus | `voice_id` | ✓ `ref_path` | voice_id 自带参考文本 |
| confucius4-tts / indextts-2.5 | ✗ | ✓ `ref_path` | 传 voice_id 时网关折算成路径 |
| irodori-tts | ✓ `voice_id` | ✓ `ref_path` | 也支持 `params.speaker_id` |
| gpt-sovits-v5 | ✓ `voice_id` | ✓ `ref_path` | 裸路径必须带 `params.prompt_text/prompt_lang` |
| mimo | 预设音色或 data URI | ✗ | 见 `params.mode` |

常用引擎参数（白名单，更多见 `capabilities[].extra_params`）：

- `gpt-sovits-v2proplus`：`version`（v2ProPlus / v2Pro / v4 …）、`gpt`、`sovits`、`text_lang`、`prompt_text`、`prompt_lang`
- `confucius4-tts`：`quality` ∈ `fast/balanced/quality`、`num_beams`、`n_timesteps`
- `indextts-2.5`：`duration_factor`（0.5~2.0）、`emo_vector`（8 个 0~1）、`emo_alpha`
- `irodori-tts`：`caption`、`num_steps`、`schedule`、`seed`、`duration_scale`、`speaker_id`（**必须日语**）
- `gpt-sovits-v5`：`variant` ∈ `v5turbo/v5dev`、`sample_steps`、`speed_factor`、`seed`
- `mimo`：`mode` ∈ `preset/design/clone`、`voice`、`instruction`、`auto_segment`；preset 音色 id 见 `GET /api/voices/presets`，clone 的 `voice` 传 data URI

响应：

- `format` 缺省/`wav`：`200 audio/wav` 裸字节；头 `X-Open-Capability`、`X-Open-Sample-Rate`
- `format: "json"`：`{ok, model, audio_base64, sample_rate, duration_sec, elapsed_sec, ...}`
- MiMo 长文本自动分段：其余段在 `extra_segments_base64`

### 5.2 ASR：`POST /v1/audio/transcriptions`

```jsonc
{
  "model": "paraformer-zh",
  "audio_path": "F:\\audio\\clip.wav",  // 或 voice_id（音色库）
  "language": "zh",
  "return_timestamps": false,
  "timeout_ms": 900000,
  "params": {}
}
```

返回 `{ok, text, language, elapsed_sec, segments?, timestamps?, warning?}`。

- `sensevoice-small`：逐字、不做 ITN 标点，且已剥掉情绪/事件 emoji（2026-11-09）；需 `weights_ready && runtime_ready`。
- `faster-whisper`：`params.size/precision`；大型号首次使用会下载权重。
- `r2t2-offline`：长音频自动 240s 分段；时间戳未接 forced aligner。

### 5.3 变声 / 歌声转换 / 分离

| 端点 | 能力 | 关键参数 |
| --- | --- | --- |
| `POST /v1/audio/convert` | `rvc-convert` | `params.model` 必填（引擎 key）；`f0_up_key/f0_method/index_rate/...` |
| `POST /v1/audio/singing-convert` | `ddsp-svc-convert` | `params.model` 必填（`.pt` 绝对路径）；`key/spk_id/f0_method/quality/...` |
| `POST /v1/audio/separate` | `uvr5-separate` | `params.preset`（默认 `vocal_fast`）、`secondary`、`agg` |

请求通用形状：

```jsonc
{
  "model": "rvc-convert",
  "audio_path": "F:\\audio\\in.wav",
  "format": "meta",     // meta（默认，返回路径/元数据）| audio（回传产物字节）
  "timeout_ms": 900000,
  "params": { "model": "<rvc 引擎 key>" }
}
```

`meta` 响应：`{ok, model, runtime, output_file, result}`；分离额外有 `paths/urls`（人声/伴奏）。
整曲翻唱（分离 → 转换 → 混音）走 `POST /api/sovits/v1/svc/cover`（异步 job）。

---

## 6. 批量与长任务

### 6.1 GPT-SoVITS 批量合成

```
POST /api/sovits/v1/tts/batch
POST /api/sovits/v1/tts/batch/plan     # 只展开条目
GET  /api/sovits/v1/jobs/:id           # 轮询
POST /api/sovits/v1/jobs/:id/cancel    # 取消
```

请求（节选）：

```jsonc
{
  "items": [{"text": "...", "key": "line-001"}],  // 或
  "text": "第一行\n第二行",                        // 按非空行切分
  "voice": "<音色库 id>",
  "ref_audio_path": "...", "prompt_text": "...", "prompt_lang": "zh",
  "text_lang": "zh",
  "version": "v2ProPlus", "gpt": "...", "sovits": "...",
  "filename_template": "{index:03d}-{key}",
  "make_zip": true,
  "continue_on_error": true,
  "wait": false
}
```

- `wait:false` → `{job_id, state, total}`；轮询 job，终态 `succeeded/failed/cancelled`。
- 完成后 `job.artifacts`：`results[]`（`ok/filename/audio_url/bytes/duration_s/error/hint`）、`zip_url`、`manifest_url`。
- 产物 URL 形如 `/files/...`，经网关访问要加 `/api/sovits` 前缀（如 `/api/sovits/files/x/000.wav`）；已是 `/api/...` 的原样使用。
- 条目上限见 `EMPTY_BATCH` / `BATCH_TOO_LARGE` 错误 hint。

### 6.2 训练等其它长任务

不进 Open API façade。走既有透传并用 job 轮询：

- GPT-SoVITS 训练：`POST /api/sovits/v1/train`，轮询 `/api/sovits/v1/jobs/:id`
- Irodori 训练：`/api/irodori/v1/train/plan|upload|prepare|datasets` + `/api/irodori/v1/jobs`（详见 `docs/IRODORI-INTEGRATION.md`）
- IndexTTS / 网易训练链见各自文档

---

## 7. CLI 速查（`scripts/say.mjs`）

完整说明见 `docs/CLI.md`。要点：

- **stdout 只有一段 JSON**，进度/提示走 stderr；Agent 直接解析 stdout。
- 用 npm 调用时加 `--silent`：`npm run --silent say -- ...`，否则 npm banner 会污染 stdout。
- 单条：`--model + --voice|--ref-path + --text|--text-file`，默认走 Open API；`--focus` 仅单条。
- 批量：`batch` 子命令 + `--text|--file|--items`；默认异步轮询；`--plan` 只展开；`--sync` 同步；`--out-dir/--zip/--no-download/--stop-on-error/--allow-failures`。
- 退出码：`0` 成功；`1` 失败或存在未豁免的失败条目；错误 JSON 形如 `{ok:false,error:{code,status,message,hint}}`。
- CLI **不启动服务、不下载权重**。

```bash
# 批量只展开核对
node scripts/say.mjs batch --plan --voice <id> --file lines.txt

# 逐条 key / 参数
node scripts/say.mjs batch --voice <id> --items items.json --out-dir out --zip
```

`items.json` 形如：

```json
[{ "text": "第一条", "key": "line-001", "params": { "speed": 1.05 } }]
```

---

## 8. 资源与并发（最容易翻车）

1. **8GB 卡，本地引擎同一时刻只容一个**；桌面/浏览器本身常占数 GB。
2. 调用前先看 `GET /api/capabilities` 的 `vram_free_mb` 与目标 `vram_required_mb`。
3. 单条 **TTS** 请求可带 `"focus": true` 让网关仲裁卸载其它引擎（带 1h 心跳）；ASR/转换/分离端点没有 focus；**批量不会自动让位**。
4. 页面「设置 → 本地服务」可查看每个运行时的包含能力（GPT-SoVITS/RVC/DDSP/ASR/UVR5）并单独卸载；同属 :9881 的引擎只能通过 trainer `/v1/engines/unload` 释放。
5. 模型加载态看 `capabilities.loaded` 或各服务 `health` / `catalog` 返回的 `loaded` 字段；`/v1/engines.active` 只是任务锁。
6. 不要为测试拉起模型服务；不要杀不认识的 Python 进程；不要假设 `nvidia-smi` 能显示每进程显存（WDDM 下常为 N/A）。

---

## 9. 红线与协作约定

本仓库是**多 Agent 共享工作区**（见根 `AGENTS.md`），借用能力时必须遵守：

- **留痕**：任何改动/服务操作写 `AGENT_CHANGELOG.md`（倒序，最新在上）。
- **不删资产**：`models/`、`GPT-SoVITS-v2pro-20250604/`、`vendor/`、`node_modules/`、`pymss/`、`voicelib/` 及用户权重不得删除/移动；清理只进回收站并留痕。
- **不跨项目扫描**：未经允许不要读/搜当前工作区以外的项目。
- **不动别人的进程**：不认识的进程先别关；本项目自己的 Python 服务在列属正常。
- **不擅自起测试服务**：显存吃紧；启动前 `nvidia-smi` 并征得同意，用完立即停/卸载。
- **不做 UI 输入自动化**：未经明确要求，不要用 SendKeys/鼠标自动化抢用户键鼠。
- **不回显密钥**：MiMo key、代理配置等只报数量/长度，不输出值。
- **用户硬约束（跨项目协作、涉及翻译/ASR 后处理时）**：翻译只用 Qwen2.5-7B-abliterated（禁用 27B/云端）；不要把 ASR 文本后处理当主线（用户明确反对）。
- **只读边界**：主中枢对本仓只允许读 `knowledge-export/*.md`、追加 B 站知识同步、读规范、经回环 `/api/open/*` 调推理；其它写操作必须在本仓走阶段流程。
- **端口/服务**：网关 8787 仅供本机；不要绑定 `0.0.0.0` 或做端口转发。

---

## 10. 排障速查

| 现象 / 错误码 | 常见原因 | 处理 |
| --- | --- | --- |
| 连不上 8787 / `ECONNREFUSED` | 网关没起 | `npm run dev:server` / `npm run dev` |
| `OPEN_RUNTIME_UNREACHABLE`（503） | 运行时没起（Open API 不会自动拉起） | 按 §3 启动对应服务，或设置页开关 |
| `SOVITS_UNAVAILABLE`（503，代理） | :9881 启动失败/未安装 | 看 hint 与 `sovits:check`；`trainer/server.py` 日志 |
| `VRAM_INSUFFICIENT`（503） | 显存不足/别的引擎常驻 | 卸载其它引擎、关大占用程序；单条可 `focus:true` |
| `WEIGHTS_MISSING`（503） | 固定模型权重未就绪 | 按 hint 下载/放置；`capabilities.weights_ready` |
| `SENSEVOICE_RUNTIME_MISSING`（503） | SenseVoice 专用 venv 缺失 | 建 `trainer/sensevoice-venv` 或设 `SENSEVOICE_PYTHON` |
| 409 busy | 引擎正在跑别的任务 | 等任务结束；不要强杀 |
| 400 `INVALID_REQUEST` | 缺参考/参数越界/能力不匹配 | 看 `details.supported` 与 `extra_params` |
| `EMPTY_BATCH` / `BATCH_TOO_LARGE` | 批次为空/条目超上限 | 拆分批次 |
| 中文乱码/请求体被转 GBK | Git Bash `curl` 的编码问题（坑 54） | 用 `scripts/say.mjs` 或 Python `urllib` |
| 本机代理拦截 127.0.0.1 | `http_proxy` 环境变量 | 调本地接口前清掉 `http_proxy/https_proxy`，或设 `NO_PROXY=127.0.0.1` |
| `available=false` 但服务在跑 | 权重/专用运行时未就绪，或 MiMo 未配 key | 看 `weights_ready` / `runtime_ready` / `/api/capabilities.hint` |

---

## 11. 文档地图

| 文档 | 内容 |
| --- | --- |
| `AGENTS.md` | 仓库级约定、共享工作区红线 |
| `HANDOFF.md` | 环境路径、分支、命令表、**108+ 条已知坑**（改代码前先扫相关坑） |
| `PROGRESS.md` | 阶段台账（按 `token-efficient-agent-workflow` 维护） |
| `docs/OPEN-API.md` | Open API 完整契约、能力清单、错误页 |
| `docs/CLI.md` | `scripts/say.mjs` 全参数与输出契约 |
| `docs/ASR.md` | ASR 模型、路由、VAD、显存 |
| `docs/INDEX-TTS-INTEGRATION.md` | IndexTTS 接入与分段情感 |
| `docs/IRODORI-INTEGRATION.md` | Irodori 日语 TTS / 训练 |
| `docs/VOICE-CONVERSION.md` | RVC / DDSP-SVC 变声与翻唱 |
| `docs/ENGINE-ISOLATION.md` | trainer worker 隔离 |
| `docs/ARCHITECTURE.md` | 架构与关键取舍 |
| `AGENT_CHANGELOG.md` | 外部 Agent 改动/操作留痕（必须写） |

### 最小验收集（复制即用）

```bash
# 能力发现
node -e "fetch('http://127.0.0.1:8787/api/capabilities').then(r=>r.json()).then(d=>console.log(d.capabilities.map(c=>c.id+':'+c.available).join('\n')))"

# 单条（Open API；需目标运行时已启动）
node scripts/say.mjs --model gpt-sovits-v2proplus --voice <id> --text "测试" --out .tmp/say.wav

# 批量展开（不占 GPU）
node scripts/say.mjs batch --plan --voice <id> --file lines.txt

# 批量真跑（会占 GPU）
node scripts/say.mjs batch --voice <id> --file lines.txt --out-dir .tmp/batch --zip
```

---

## 12. 维护

- 端口、能力 id、参数白名单、启动命令、红线发生变化时，**先改本文件**，再同步 `docs/OPEN-API.md` / `docs/CLI.md` / `HANDOFF.md` / `README.md`。
- 新增能力：更新 `server/src/services/capabilityCatalog.ts` → `docs/OPEN-API.md` → 本文件 §4/§5。
- 修改后在 `AGENT_CHANGELOG.md` 留痕，并在 `PROGRESS.md` 记阶段（按升序追加）。
- 本文件的日期与“版本”行随每次实质修改更新。

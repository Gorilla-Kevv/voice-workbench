# 阶段 30 实施方案：Irodori-TTS 接入（克隆 + 音色固化训练）

> 立项依据：用户 10.09 裁决「做克隆和训练」；Genie-TTS / dots.tts 已弃用（阶段 27）。
> 全部技术前提与实测数据来自 `docs/IRODORI-TTS-EVALUATION.md`（阶段 28），本文件只写**怎么落地**。
> 分支：feature/vc-svc。编号说明：阶段 29 已由另一路 agent 立项给 RVC 训练对齐（PROGRESS 2136 行），
> 故本方案取 **阶段 30**，其内部拆 30-1 … 30-7，每段独立可验证。
> 行号提示：`runtime.ts` / `preload.ts` / `arbiter.ts` / `voicelib` 正被另一路 agent 修改，
> 本文只锚定**文件 + 符号名**，具体行号以开工时工作区为准。

---

## 1. 范围

| 做 | 不做 |
| --- | --- |
| 日语合成：参考音零样本克隆（单段 / 多段长参考） | 不替代主力（它只会日语），不动 GPT-SoVITS / 网易 / IndexTTS 任何链路 |
| caption 语音设计 + emoji 风格标注（56 个，取自代码常量） | 不做 v4-Large（12.25GB 且是 Gemma 条款，不是 MIT） |
| **Speaker Inversion 训练**：把日语音色固化成一个 49KB 的 `.speaker.safetensors`，注册进音色库当"角色"用 | 默认不做 LoRA / 全量微调（3000 步 ≈8.3h，作者自述 LoRA 配方"基本没探索过"）——留开关，见 §6.6 |
| 长参考音能力（音色库支持多片段，官方建议 ~30s） | 不做 MeanFlow 蒸馏、不做流式播放、不做 Windows 之外的平台适配 |
| 超时 + 降步重试护栏（实测有 89s 长尾） | 不去水印（上游拒绝 `--no-watermark`；本机未装 SilentCipher，装了会自动加水印） |

---

## 2. 架构决策：自建 `irodori/` 服务，不直接用上游 Irodori-TTS-Server

上游 server（OpenAI 兼容 `POST /v1/audio/speech`）看着省事，但有四条硬伤，逐条对应实测事实：

1. **它不覆盖训练**。Speaker Inversion 的入口是主仓库的 `train.py` + `prepare_manifest.py`，上游 server 只有推理。用户明确要训练，自建服务才能把"数据→latent→训练→注册"这条闭环放进同一个进程边界里管。
2. **Windows 音频解码它绕不开**。`torchaudio.load` 在 torch≥2.9 完全委托 torchcodec，而 cu128 索引**没有 Windows wheel**（阶段 28 实测 ImportError）。我们必须在自己的服务里显式装 soundfile 垫片，不该把这个补丁塞进别人的包里。
3. **参数面不够**。我们要暴露的 `num_steps` / `t_schedule_mode=sway` / `sway_coeff` / `model_precision` / `cfg_scale_caption` / `duration_scale` / `ref-embed vs ref-wav 互斥校验`，上游只有 caption/num_steps/speed。
4. **长参考的多片段管理要在我们这边**。音色库是我们自己的（`voicelib/`），多片段引用必须与网关共享，第三方 server 有自己的音色模型，接进来就是两套真相。

**服务骨架照 netease/indextts 的既有惯例**（同一套 RuntimeSupervisor + 透传 + arbiter + preload 记账）：

```text
irodori/
  server.py                 # 入口：解释器自举 + uvicorn 启动 + --check 健康模式（同 netease/server.py 形态）
  app/
    config.py               # 端口/权重路径/精度/batch 上限，读环境变量（IRODORI_PYTHON / IRODORI_PORT …）
    windecode.py            # ★ Windows 音频解码垫片（torchaudio.load/save → soundfile），import 期安装
    engine.py               # 模型常驻：RuntimeKey + DACVAECodec；显存画像与 required_vram_mb()
    refs.py                 # 参考音/多片段 latent 编码与缓存（LRU，带时长与片段数上限）
    synth.py                # 采样请求组装 + ★ 长尾护栏（看门狗 + 自动降步重试一次）
    jobs.py                 # JobStore（磁盘持久化 <data_dir>/jobs/<id>.json，形态对齐 trainer/app/jobs.py）
    traindata.py            # ★ 数据集→latent→manifest，含"written>0"硬断言
    speakers.py             # Speaker Inversion 训练编排 + .speaker.safetensors 产物登记
    routers/{irodori,train}.py
    errors.py               # 结构化错误码
  upstream/Irodori-TTS/     # git submodule 或 tarball 落盘（官方代码零改动，见 §7）
  models/                   # 权重（gitignore）：int4 0.79GB / bf16 3.06GB / codec 410MB / tokenizer 7MB
  .venv/                    # uv 建的独立环境（gitignore）
  README.md                 # 装法与权重清单（照 docs/NETEASE-INTEGRATION.md 的写法）
```

**进程隔离**：按 `docs/ENGINE-ISOLATION.md` 的规矩，"全局 monkeypatch 只准待在自己的进程里"。
Irodori 本来就是**独立 venv + 独立进程**，torchao/transformers 的任何全局替换都出不了这个进程，
所以**不需要**像 GPT-SoVITS 那样再开 worker 子进程；`windecode` 垫片只 patch 本进程的 `torchaudio`，
且在文件头写明"为何存在、何时该删"（等上游提供非 torchcodec 解码路径就撤）。

---

## 3. 依赖与权重的落地口径（阶段 28 已验证的装法）

| 项 | 结论（实测） |
| --- | --- |
| 环境 | Python **3.12**（3.13 编不过部分依赖）；`uv venv` + torch **2.10.0+cu128** + torchaudio 2.10 + torchao 0.16 + transformers 5.19 + peft 0.21 + datasets 5.1 + torchdata 0.11 + descript-audiotools 0.7.2 + soundfile |
| **不装** | torchcodec（无 Windows wheel，装了还会因 FFmpeg DLL 静默跳样本）、silentcipher（可选；装了水印耗时≈翻倍、显存 +0.9GB，先不装并在 UI 标注"未加水印"） |
| git-only 依赖 | `dacvae`（facebookresearch）与官方 `Irodori-TTS` 本体：github.com 直连不通，走 **codeload tarball**；dacvae 落 `irodori/upstream/dacvae/`（官方 codec 自带从同级目录回退加载的逻辑，别放错层——放错会变成命名空间遮蔽，报 `cannot import name 'DACVAE'`） |
| 权重下载 | huggingface.co 不通、hf-mirror 单连接 ~120KB/s；用 **ModelScope 镜像 + 8 路 Range 并发**（实测 ≈3.5MB/s）。脚本沿用 `_bench/chunked_dl.sh` 的做法进 `scripts/irodori-weights.mjs`，并**逐文件校验字节数**（阶段 28 曾因截断导致 `PytorchStreamReader failed … central directory`） |
| 默认权重组合 | 推理 `int4-weight-only` + `--model-precision fp32`（bf16 在本机不快，只省 400MB）；训练用 bf16 基座 3.06GB（量化检查点不能训练） |
| 磁盘 | 推理 1.2GB + 训练基座 3.1GB + 环境 ≈ 8GB；`.gitignore` 增 `irodori/.venv`、`irodori/models`、`irodori/.data`、`irodori/upstream` |

---

## 4. 接口契约

### 4.1 推理侧（网关透传 `/api/irodori/*`）

| 端点 | 方法 | 说明 |
| --- | --- | --- |
| `/health` | GET | `required_vram_mb`（真源在服务端）、`loaded`、`vram.free_mb`、`watermark: false`、权重与精度 |
| `/v1/catalog` | GET | emoji 表（**从 `irodori_tts.duration.ALLOWED_ANNOTATION_EMOJIS` 取 56 个**，不是文档里的 45）、caption 预设、步数档位、语言只有 `ja`、上限 `max_ref_seconds=120` |
| `/v1/warmup` `?blocking=` | POST | 载模型（实测 ~20s）；**已加载则直接返回不拦**（坑 26 修法） |
| `/v1/unload` | POST | 释放显存并回报归还量 |
| `/v1/synth` | POST | 见下表；返回 `{audio_base64, sample_rate: 48000, duration_sec, elapsed_sec, used_seed, steps_used, retried, voice_id, speaker_id}` |
| `/v1/speakers` | GET | 已固化的 speaker embedding 列表 |

`/v1/synth` 请求字段（全部可选，缺省走服务端默认）：

| 字段 | 取值 | 备注 |
| --- | --- | --- |
| `text` | 日语，**服务端强制切句 ≤25 字/段** | >30s 音频会退化/幻觉（issue #13），切句与拼接收在服务端 |
| `ref_voice` / `ref_path` | 音色库 id 或磁盘路径 | 与 `speaker_id` 互斥 |
| `speaker_id` | 用固化的 `.speaker.safetensors` | 官方要求 `--ref-embed` 与参考音互斥，服务端校验 |
| `ref_clips[]` | 多片段（长参考，建议 ~30s） | 每片各自编码后拼接，超上限截断 |
| `caption` | 自由日语文本 | **只描述情绪/环境/语域，不许描述音色**（卡里明确冲突会不稳） |
| `num_steps` / `schedule` | 默认 **20**；`linear`/`sway` | 40 是官方默认，但我实测 20 步 RTF 0.246 且 F0 无退化，长尾也能绕开 → **默认 20**，40 作为"最高质量"档 |
| `seed` | 整数 | 同 seed 同输入完全确定（阶段 28 实测）；UI 给"换一个种子"按钮 |
| `duration_scale` | 0.8–1.5 | 目前唯一的"时长/节奏"数值旋钮，没有 pitch/rate 参数，别在 UI 里伪造 |

错误码：`IRODORI_UNAVAILABLE`(503) / `VRAM_INSUFFICIENT`(503，带 `free_mb`+`required_mb`+谁在占) /
`ENGINE_BUSY`(409) / `NO_JA_ONLY`(400，检到非日语假名/汉字外文本) / `REF_TOO_SHORT`(3s 以下) /
`TRAIN_MANIFEST_EMPTY`(422，★ 雷一守卫) / `IRODORI_TIMEOUT`(504，长尾护栏命中)。

### 4.2 训练侧（同一服务内，形态对齐 trainer 的 job 体系）

| 端点 | 说明 |
| --- | --- |
| `POST /v1/train/plan` | 回显三步计划与预估耗时（按 batch 与步数算），**不执行** |
| `POST /v1/train` | 入队（轮询式，与 trainer `/v1/train` 同形态，前端 2s 轮询） |
| `GET /v1/jobs[/:id]`、`POST /v1/jobs/:id/cancel` | JobStore：磁盘持久化 + 阶段进度 + 日志尾部 |
| `POST /v1/train/upload` | 语料上传（wav 目录 / zip / 已有音色库长参考片段） |
| `GET /v1/train/auto_batch` | 自动 batch 探测（见 §6.4） |

---

## 5. 音色库扩展（唯一的"改数据结构"点，必须向后兼容）

现状：`voicelib/voices.json` 一条记录只有**一个** `audio_path`，GPT-SoVITS 还硬性要求 3–10s。
Irodori 的长参考需要多片段 → 只加不改：

- `VoiceRecord` 增加可选 `ref_clips: [{path, dur_s, sample_rate, text?}]`、`engine_tags: string[]`（如 `["gsv","irodori"]`）、`speaker_embeds: [{path, trained_at, steps, batch}]`。
- 旧记录不带这些字段照常工作；GPT-SoVITS 与网易/IndexTTS 继续只读 `audio_path`，**不受影响**。
- trainer 侧 `VoiceLibrary` 的"persist 前必须重读磁盘"铁律不变（坑 27），新增字段两侧都不能吞（Node 写、Python 读同一份 JSON）。
- UI（`VoiceLibraryPage`）：行展开里加"日语长参考"区——上传多片段（合计 ≤120s，提示"~30s 已拿到大部分收益"）、逐片试听、每片可填转写；"固化的日语音色"区列出该音色的 speaker embedding 与训练参数。

---

## 6. 训练（Speaker Inversion）流水线：三步 + 三道守卫

### 6.1 三步

| 步 | 动作 | 复用 |
| --- | --- | --- |
| S1 数据整备 | 收集目标说话人日语片段（**官方建议多段短句拼接，非单条长录音**），每条要 `text`（转写）与可选 `caption` | 转写来源三选一：① 音色库片段自带 `prompt_text` ② 上传同名 `.txt` ③ 调我们现有 ASR（需临时让出显存，UI 明示"训练前先转写，会切换 GPU 占用"） |
| S2 latent 编码 | 用官方 codec 把音频编成 DACVAE latent（32 维），写 `manifest.jsonl`（字段 `text/caption/latent_path/speaker_id/num_frames`） | **不走 `prepare_manifest.py`**（它在 Windows 会 16/16 静默跳过）；直接调 `DACVAECodec.encode_file()`，我在阶段 28 已用这条路编出 16/16 |
| S3 训练 | `train.py --config configs/train_v4_small_speaker_inversion.yaml --speaker-inversion --batch-size N --gradient-checkpointing --max-steps 3000`，基座冻结只训 16 个 embedding token | 产物 `checkpoint_final.speaker.safetensors`（49KB）→ 自动登记进音色库该音色的 `speaker_embeds` |

### 6.2 守卫一：manifest 非空硬断言（★ 最重要）

S2 结束后 **written 行数必须 > 0 且等于输入片段数**，否则 `TRAIN_MANIFEST_EMPTY` 直接失败退出，
错误文案要写人话："数据一条都没编码成功（多半是 Windows 音频解码不可用），训练不会开始"。
这条守卫存在的原因是上游那条雷**不报错**：退出码 0 + 空 manifest，能让人白跑一晚。

### 6.3 守卫二：显存准入"已加载就跳过"

沿用坑 26/坑 24 的修法。训练前检查：模型未加载 → 按 `required_vram_mb(train)` 判；已加载 → 跳过。
训练侧门槛按实测：**batch 8 + 梯度检查点 ≈4.4GB 净占**（整卡峰值 6911MB），我给的准入档位取 **5120MB**（含桌面波动余量）。

### 6.4 守卫三：自动 batch 探测

照社区客户端的做法：取最长 15 条片段，用 batch=2 试跑 2 步，按"吃满空闲显存的 85%"决定 batch，
上限 8（实测 batch 8 = 2.2 s/步；batch 再大没验过）。UI 显示选定 batch + 预估总时长。

### 6.5 时间与 ETA（给用户算清楚）

- 实测 **2.2 s/步**（batch 8，4060 Laptop 8.6GB）→ 官方默认 3000 步 ≈ **1.8 小时**。
- 3000 步不是必须的：日语音色固化通常 1000–1500 步就能听出稳定（保守起见的建议区间，非官方口径）。UI 默认给 **2000 步 ≈ 73 分钟**，并显示"边训边试听"入口（每 250 步存 best-N，可先听 `checkpoint_best`）。
- 训练期间该服务独占 GPU：合成请求一律 `ENGINE_BUSY`(409) 并提示"训练中，约 X 分钟后回来"。

### 6.6 LoRA（留开关，默认关）

`--enable-lora` 才暴露。实测 batch 2 = **9.9 s/步**（3000 步 ≈ 8.3 小时），且作者自己说 LoRA 配方
"基本没探索过"，issue #8 反馈强情感下音色漂移。UI 文案必须写"实验性，耗时 8 小时级，效果未验收"。

---

## 7. 官方代码零改动原则

沿用 `trainer/` 对 GPT-SoVITS 的做法：**不改上游一行**。所有适配集中在我们自己的
`irodori/app/` 里（垫片、切句、断言、注册表）。`irodori/upstream/Irodori-TTS/` 与 `dacvae/`
只做来源锁定（记录 tarball 的 commit），升级 = 换 tarball + 重跑验收清单。

---

## 8. 前端

- 导航新组：**「日语 · Irodori 风格」**（与「情感可控」= IndexTTS 中文 8 维向量并列，互不替代）。
  - `IrodoriTtsPage`（合成）：文本框 + emoji 调色板 + caption 输入（含官方示例预设）+ 参考音选择（音色库/上传/固化音色三选一）+ 步数档（快 6-sway / 平衡 20 / 最高 40）+ seed 换一版 + 结果堆叠（复用 `useResultStack`）。
  - `IrodoriTrainingPage`（音色固化）：三步向导（数据→整备→训练），JobStore 进度与日志、取消、训练完自动跳转"已注册"。
- **文案红线（照实测写，不许夸大）**：
  1. 男声参考下 emoji **不改变音高情绪**（实测 F0 锁在 110.3–111.9Hz，跨度 1.6Hz）→ 选中男声音色时，emoji 面板旁固定提示"对男声主要影响节奏与插入音，不改变情绪音调"。我们音色库现有那条就是男声。
  2. ⏩/🐢/👂 三条实测未兑现（语速 5.25 vs 基线 5.26；耳语能量不降）→ 调色板里标"效果不明显"。
  3. caption 只写情绪/环境，不写音色（写了两条会互相打架，模型卡明确警告）。
  4. 仅日语；非日语文本直接拒绝而不是硬合成。
- 设置页：`irodori` 服务开关 + 权重路径 + 精度/batch 上限 + "水印：未启用（依赖未装）"状态行。

---

## 9. 阶段拆分（每段独立可验证）

| 段 | 目标 | 主要涉及 | 验证 |
| --- | --- | --- | --- |
| **30-1** | 环境与骨架跑通：`irodori/` 目录、venv、权重下载校验、`server.py` + `/health` + `windecode` 垫片 + `scripts/irodori.mjs` + npm targets + `.gitignore` | `irodori/`、`scripts/`、`package.json`、`server/src/config/index.ts` | `npm run irodori:check`；`curl 127.0.0.1:9884/health` 出 `required_vram_mb`；权重字节数与 `--check` 一致 |
| **30-2** | 推理链路：`/v1/catalog` + `/v1/warmup/unload/synth`（单段克隆 + caption + emoji）+ 网关透传 + RuntimeSupervisor spec + arbiter `ServiceName` + preload `MODELS` 档位 | `irodori/app/*`、`server/src/routes/irodori.ts`、`server/src/services/{runtime,arbiter,preload}.ts` | `npm run typecheck && npm run lint`；真合成 6 句出 48kHz；RTF ≤0.25（默认 20 步）；显存读数与阶段 28 一致（净占 ~4.6GB） |
| **30-3** | 长尾护栏：服务端看门狗 + 自动降步重试一次 + `IRODORI_TIMEOUT`；网关 `proxyTimeoutMs` 档位；客户端"重试（降步）"按钮 | `irodori/app/synth.py`、`server/src/routes/irodori.ts`、`app/src/lib/irodori.ts` | 构造 40 步 + 已知坏 seed（阶段 28 的 seed 42 场景）→ 必须在护栏内返回且 `retried=true` |
| **30-4** | 音色库多片段长参考：`ref_clips/engine_tags/speaker_embeds` 扩展 + 网关/trainer 双向兼容 + UI 补录区 | `server/src/services/voiceLibrary.ts`、`server/src/routes/voicelib.ts`、`trainer/app/sovits/voices.py`、`VoiceLibraryPage` | 旧音色记录在 GPT-SoVITS 合成不回归；新增长参考后 Irodori 克隆相似度**用户耳朵验收**（重点：5.4s 短参考 vs 30s 多段参考的对比） |
| **30-5** | 训练 S1+S2：数据导入/转写来源 + latent 编码 + **manifest 非空断言** + JobStore | `irodori/app/{traindata,jobs,routers/train}.py` | 单元级：喂 20 条片段必须 `written=20`；故意断掉解码路径必须 `TRAIN_MANIFEST_EMPTY` 而不是静默通过（这条就是这个阶段的验收核心） |
| **30-6** | 训练 S3：自动 batch 探测 + SI 训练编排 + 进度/取消/ETA + 产物登记 + `--ref-embed` 推理闭环 | `irodori/app/speakers.py`、`IrodoriTrainingPage` | 小步数（50 步）跑完 → 产出 `.speaker.safetensors` → 用 `speaker_id` 合成成功且音色与参考一致（耳朵验收）；batch 探测值与实际显存不冲突 |
| **30-7** | 前端完整化 + 设置页 + 预加载账本回填 + 文档/走查（含 `docs/IRODORI-INTEGRATION.md`、HANDOFF 坑更新） | `app/src/pages/*`、`AppShell`/`PAGE_META`、`preload.ts`、`ResourceBudget` | 浏览器整链路走查（未启动→启动→合成→训练→固化→复用），控制台无新报错；侧栏/设置页状态一致（不重犯阶段 27补7 的两套探活问题） |

依赖关系：30-1 → 30-2 → {30-3, 30-4} → 30-5 → 30-6 → 30-7。30-4 与 30-3 可并行。

---

## 10. 完成定义（DoD）

1. 合成页能用**音色库现有男声**（5.4s）与**补录的 30s 多段参考**各出一条日语，用户耳朵认可"像那个人"。
2. emoji 与 caption 的效果与阶段 28 实测一致（女声明显、男声只有节奏变化），UI 文案没有夸大。
3. 训练闭环真跑通一次：导入 → 编码（manifest 非空）→ SI 训练（自动 batch）→ 产物注册 → `speaker_id` 直接合成，全程不手写命令行。
4. 长尾护栏在已知坏 seed 上生效（自动降步重试或明确 504，不悬挂）。
5. 显存治理接入：预算页/预加载/互斥都认得 `irodori`（净占 ~4.6GB，与网易/IndexTTS 互斥排队），"已加载跳过准入"不回退。
6. `npm run typecheck && npm run lint && npm run build` 全绿；GPT-SoVITS / 网易 / IndexTTS 三条现有链路**零回归**（重点回归：共享音色库读写、arbiter、预加载）。

---

## 11. 风险登记（实施期）

| 风险 | 缓解 |
| --- | --- |
| 上游模型卡没有中文/无文档，emoji 语义只能靠它自己的三语释义表 | 调色板直接展示官方释义，不自造中文翻译；效果按实测标注 |
| int4 权重 + torchao 的 tinygemm 只在 cc≥8.0 可用（本机 8.9 OK），换机可能失效 | `/health` 报 compute capability 与所选量化档，不匹配时回落 int8/bf16 并提示 |
| 训练时 `datasets` 的音频解码仍可能踩 torchcodec | S1/S2 完全不经 `datasets.Audio`，我们自己用 soundfile 读 |
| SI 训练要求每条数据有 `text`，真实语料要转写→触发 GPU 交接 | S1 支持"批量转写"向导步骤，明确提示会临时占用显存；也可只用带转写的音色库片段 |
| 长参考多片段与 GPT-SoVITS 的 3–10s 约束共存 | 用 `engine_tags` 分流；GPT-SoVITS 只取首片段并校验时长，超范围就在 UI 说明 |
| 另一路 agent 正在改 `runtime/arbiter/preload/voicelib` | 开工前 `git log` 核对 + 只改各自新增分支逻辑；改动窗口内避免同一函数并发编辑 |
| 只装了 CPU 侧没验 Linux | 本方案不承诺 Linux/WSL；垫片代码在非 Windows 分支自动跳过 |

---

## 12. 需要用户拍板（开工前答一次就够）

1. **默认步数**：我建议 **20 步**（RTF 0.246，实测 F0/时长与 40 步无差，且能绕开长尾）；要不要把 40 步留作"最高质量"档？
2. **训练默认步数**：我建议 **2000 步 ≈73 分钟**（官方配置是 3000 ≈1.8h）。选哪个？
3. **转写来源**：允许我在训练向导里调用现有 ASR（会临时从 Irodori 让出显存、走一次引擎切换），还是坚持"必须自带转写/用音色库已填文本"？
4. **LoRA 要不要开**：默认关（8 小时级 + 作者未验证）。要开我就按实验性开关实现。

答完这四点我就按 30-1 开工，每段完成即更新 PROGRESS.md 并本地提交（不 push）。

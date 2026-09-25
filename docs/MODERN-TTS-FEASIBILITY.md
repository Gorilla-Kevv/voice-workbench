# 可行性评估：整合 OmniVoice / VoxCPM2 / Qwen3-TTS

目标：在**保持 MiMo 云端与 GPT-SoVITS 本地两条既有链路完全不变**的前提下，把三个新模型纳入统一架构。

结论先行：

> **可行，但它不是"加三个 Provider"，而是引入第二个 Python 运行时。**
>
> 现有 `trainer/` 跑在 GPT-SoVITS 整合包的 **Python 3.9 + torch 2.0.0+cu118** 上，而三个新模型
> **全部要求 Python ≥ 3.10、torch ≥ 2.5**。两者不可能共存于同一解释器，强行升级 torch 会直接
> 摧毁 GPT-SoVITS / RVC / DDSP-SVC / UVR5 四条既有链路。因此必须新建一个独立 venv 与独立服务进程。
>
> 第二个必须提前说清的事实：**在 8.6 GB 显存上，新模型的推理速度并不比现在的 GPT-SoVITS 快。**
> 官方 RTF 是 H100 / 4090 的成绩，落到 RTX 4060 Laptop 要打折 3~5 倍；而 GPT-SoVITS 的官方
> RTF 约 0.028（4060Ti 实测量级）本就是极快的。新模型的价值在**质量、多语言覆盖、音色设计、
> 免训练克隆**，不在吞吐。把"性能不足"当作重构动因，重构完会失望；把"能力补全"当作动因，才站得住。

---

## 1. 现状：三条硬约束

| 约束 | 实测值 | 影响 |
| --- | --- | --- |
| 解释器 | Python 3.9.13（整合包 `runtime/python.exe`） | 三个新模型全部不满足 |
| torch / CUDA | 2.0.0+cu118，CUDA 11.8 | 三个新模型要求 torch ≥ 2.5、CUDA ≥ 12.0 |
| 显卡 | RTX 4060 Laptop **8.6 GB** | VoxCPM2 官方标称 ~8 GB，属于压线 |
| 依赖来源 | `trainer/requirements.txt` 只有 5 项，torch 来自整合包 | 新模型的 torch 必须装进**新** venv，不能碰整合包 |
| 显存调度 | `trainer/app/engine.py`：同一时刻只准一个引擎持显存 | 新服务在**另一个进程**，`engine.py` 看不见它 |

前三条决定了架构形态，最后一条决定了本次改造里唯一有技术难度的地方（见 §5）。

---

## 2. 三个模型：能力、成本与接入方式

数据来源为各上游官方 README / 文档（2026 年版本），显存与速度为官方标称，非本机实测。

| | **OmniVoice**（k2-fsa） | **VoxCPM2**（OpenBMB / 面壁） | **Qwen3-TTS**（Qwen） |
| --- | --- | --- | --- |
| 协议 | Apache-2.0 | Apache-2.0 | Apache-2.0 |
| 安装 | `pip install omnivoice` | `pip install voxcpm` | `pip install qwen-tts` |
| Python | ≥ 3.10 | ≥ 3.10 且 < 3.13 | 推荐 **3.12** |
| torch | 官方推荐 **2.8.0+cu128** | ≥ 2.5.0，CUDA ≥ 12.0 | 未声明，transformers 生态需 ≥ 2.5 |
| 可选加速 | flash-attn、FlashInfer（2~2.9×） | Nano-vLLM / vLLM-Omni | flash-attn-2（推荐）、vLLM-Omni |
| 参数量 | 未公开（扩散 LM 架构） | **2B** | **1.7B / 0.6B** |
| 输出采样率 | 24 kHz | **48 kHz** | 24 kHz 级（12Hz tokenizer） |
| 语言 | **600+** | 30 语言 + 9 种中文方言 | 10 语言 |
| 显存（官方） | ~4 GB | **~8 GB** | 1.7B 约 4~6 GB / 0.6B 约 2~3 GB |
| 声音克隆 | 参考音频 3~10s，`ref_text` 可选（内置 Whisper 自动转写） | 可控克隆（仅需音频）/ 极致克隆（音频 + 文本） | 3 秒克隆；`x_vector_only_mode=True` 时免 `ref_text` |
| 音色设计 | ✅ `instruct` 属性串 | ✅ 文本开头括号描述 | ✅ 独立 VoiceDesign 子模型 |
| 预置音色 | ❌ | ❌ | ✅ 9 个（Vivian / Ryan / Ono_Anna…） |
| 流式 | 有 batch CLI，无逐块流式 API | ✅ `generate_streaming` | ✅ 端到端 97 ms |
| Prompt 复用 | ✅ `VoiceClonePrompt.save("x.pt")` | 需自行缓存 | ✅ `create_voice_clone_prompt` |
| 微调 | `examples/` 提供全流程 | ✅ SFT / LoRA（5~10 分钟语料） | ✅ `finetuning/` |
| 本机预估 RTF | 0.4~0.8 | **1.0~1.5（慢于实时）** | 0.5~1.0（0.6B 约 0.3~0.5） |
| 权重体积 | ~4 GB | ~4 GB（bf16） | 1.7B ~3.5 GB + tokenizer |

**与现有能力的互补关系**（这才是整合的价值）：

- **GPT-SoVITS 缺音色设计** → VoxCPM2、Qwen3-TTS-VoiceDesign、OmniVoice 全部能补；
- **GPT-SoVITS 参考音频必须 3~10 秒且必须配逐字文本** → OmniVoice 可免文本（内置 ASR）、
  Qwen3-TTS 可 `x_vector_only_mode`、VoxCPM2 可控克隆只要音频。这一条能显著降低现有"导入音色"的摩擦；
- **MiMo 云端只有中英** → OmniVoice（600+）、VoxCPM2（30 + 方言）补多语言本地方案；
- **GPT-SoVITS 支持日韩粤** → 仍是日韩场景最快的本地路径，不应被替换。

---

## 3. 目标架构：第二个运行时

```
浏览器 (5173)
   │
   ▼
Node 网关 (8787)  ──/api/tts──▶ MiMo 云端（不变）
   ├── /api/sovits/*  ──透传──▶ trainer  (9881)  py3.9 + torch2.0+cu118  ← 一行不改
   │                              GPT-SoVITS / RVC / DDSP-SVC / UVR5 / ASR
   └── /api/mtts/*    ──透传──▶ mtts     (9882)  py3.12 + torch2.8+cu128  ← 新增
                                  OmniVoice / VoxCPM2 / Qwen3-TTS
```

命名说明：新目录本文统一记作 `mtts/`（Modern TTS），端口 9882。名字可改，关键点是
**它是与 `trainer/` 平级的第二个运行时，不是 `trainer/` 里的一个子模块**。

### 3.1 为什么不能塞进 `trainer/`

`trainer/app/engine.py` 的互斥、`vendor_paths.py` 的 `sys.modules` 摘除、`queue.py` 的调度，
全部建立在「所有引擎共享同一个进程、同一个 torch」之上。跨解释器后这些机制全部失效。
把 OmniVoice 塞进 py3.9 的第一次 `import torch` 就会失败——它的依赖树要求 py3.10+。

### 3.2 为什么也不建议动 `trainer/`

- GPT-SoVITS / RVC / DDSP-SVC 的可用版本是被 py3.9 + numpy 1.23 + torch 2.0 这个组合**钉死**的
  （见 `docs/VC-SVC-FEASIBILITY.md`：RVC 就是因为 main 分支要 py3.12 才改用 `20240604` 分支）；
- "保持现有功能不变"是硬要求，最稳的做法就是让 `trainer/` 一个字都不改。

### 3.3 新服务的内部结构

完全复用现有板块的接入模板（`trainer/app/<板块>/{bootstrap,catalog,pipeline}.py`
+ `routers/<板块>.py` + `engine.py` 登记 + `weights.py` 清单），只是换了个解释器：

```
mtts/
├── server.py                 # 入口：venv 自检 + 体检 + uvicorn（无解释器自举）
├── requirements.txt          # fastapi / uvicorn / pydantic / python-multipart + 三个模型包
├── .env.example
├── PINNED.md                 # 三个上游的验证通过版本（见 §7）
└── app/
    ├── api.py                # 只做组装：routers + Context
    ├── config.py             # Settings.from_env()，与 trainer/app/config.py 同风格
    ├── models.py             # Pydantic 契约
    ├── engine.py             # 进程内三选一互斥（抄 trainer/app/engine.py）
    ├── gpu_bridge.py         # 跨运行时显存协调（见 §5）—— 唯一的新机制
    ├── jobs.py / queue.py    # 抄 trainer 的任务模型
    ├── weights.py            # 权重清单（HF + ModelScope 双源）
    ├── omnivoice/  voxcpm/  qwen3/
    │   ├── bootstrap.py      # 建管道、lazy import、dtype/device 决策
    │   ├── catalog.py        # 能力清单（语言、模式、参数默认值、显存档位）
    │   └── pipeline.py       # 常驻封装 + 卸载
    └── routers/
        ├── __init__.py
        ├── engines.py        # /v1/engines（与 trainer 同名同构，便于网关汇总）
        ├── omnivoice.py      # /v1/omnivoice/*
        ├── voxcpm.py
        └── qwen3.py
```

**与 RVC / DDSP-SVC 的一个策略差异**：那两个上游是脚本式项目，只能 `vendor/` submodule + 临时
`sys.path` 接管。这三个都提供正规 PyPI 包，**应当 pip 安装，不要 submodule**——省掉
`vendor_paths.py` 那一整套路径隔离，也省掉上游升级时手工同步子模块的麻烦。

**共享音频内核**：`trainer/app/audio/` 里的 `io.py` / `slicer.py` / `cache.py` 若要复用，
建议把**只依赖 numpy / soundfile** 的部分抽到 `shared/audio/`，两个运行时用 `PYTHONPATH` 引入；
依赖 torch 的部分（uvr5）留在 `trainer/`。这一步要在阶段 0 预检时确认依赖面，
若 `io.py` 已经牵到 torch，就直接复制一份到 `mtts/app/audio/`，不做共享——重复一个小文件，
代价远小于跨版本共享一个会变的模块。

---

## 4. 接口设计

沿用现有约定：路径前缀 `/v1/<板块>/*`、统一响应 `{ok:true,...}` /
`{ok:false, error:{code,message,retryable,hint}}`、任务化接口支持 `wait=true` 同步返回。

三个板块**共用同一套动词**，前端才能用一个组件渲染三种模型：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/v1/<m>/catalog` | 能力清单：模式、语言、参数默认值、显存档位、是否已下载 |
| GET | `/v1/<m>/pipeline` | 引擎状态：是否已加载、dtype、device、当前显存 |
| POST | `/v1/<m>/pipeline/warmup` | 预加载（可后台） |
| POST | `/v1/<m>/pipeline/unload` | 卸载并归还显存 |
| POST | `/v1/<m>/tts` | 单条合成 |
| POST | `/v1/<m>/tts/stream` | 流式（NDJSON，仅 VoxCPM2 / Qwen3-TTS 支持；OmniVoice 返回明确错误而非静默降级） |
| POST | `/v1/<m>/tts/batch` | 批量（可任务化） |
| GET | `/v1/engines` | 与 `trainer` 的同名接口，供网关汇总全局显存视图 |

`<m>` ∈ `{omnivoice, voxcpm, qwen3}`。

### 4.1 统一请求体

三个模型的入参差异极大（OmniVoice 用 `ref_audio`+`ref_text`+`instruct`；VoxCPM2 用
`reference_wav_path`+`prompt_wav_path`+`prompt_text`；Qwen3-TTS 用 `ref_audio`+`ref_text`+`speaker`），
因此在 `mtts` 内部收敛成一份请求契约，由各 `pipeline` 负责翻译：

```python
class SynthesizeRequest(BaseModel):
    text: str
    mode: Literal["clone", "design", "preset"]      # preset 仅 Qwen3-TTS 支持
    language: str = "auto"
    voice_id: str | None = None                      # 引用共享音色库
    ref_audio: str | None = None                     # 直接给路径（不走音色库）
    ref_text: str | None = None
    instruct: str | None = None                      # 音色设计 / 风格控制
    speaker: str | None = None                       # Qwen3-TTS 预置音色
    speed: float = 1.0
    seed: int | None = None
    # 各模型独有能力，不强行统一，放在 params 里由 catalog 描述取值范围
    params: dict = {}
```

`mode` + `catalog` 的组合让前端可以做**能力降级提示**：例如 OmniVoice 收到 `preset`
就返回 `UNSUPPORTED_MODE` 并带上 `hint`「该模型无预置音色，请使用克隆或音色设计」——
与现有「GPT-SoVITS 不支持音色设计，界面如实标注」的处理方式一致。

### 4.2 统一音色库（关键设计决定）

三个模型的"音色"表示形式互不相同：OmniVoice 是 `VoiceClonePrompt(.pt)`、
Qwen3-TTS 是 `voice_clone_prompt` 对象、VoxCPM2 只有参考音频路径。

**建议：不新建音色库，而是扩展现有 `trainer/.data/voices/` 的索引，新增一个
`prompts/` 子目录按 `<voice_id>/<model>.pt` 存放预编码 prompt。**

理由是：现有"导入音色"流程已经是「传音频 + 填逐字文本 + 一键 ASR 转写」，用户在三个模型间
切换时不该重新导入一遍。而 prompt 预编码是三个模型都支持的优化（OmniVoice 官方明确给了
`VoiceClonePrompt.save()`，Qwen3-TTS 给了 `create_voice_clone_prompt()`），
批量合成时省掉每条重新编码参考音频的开销，收益明显。

代价：`mtts` 需要读 `trainer` 的数据目录。用 `TTS_DATA_DIR` 指向同一路径即可，两个服务不同时写
同一个 json（音色元数据仍由 `trainer` 写，`mtts` 只读 + 只写 `prompts/`）。

---

## 5. 资源管理：跨运行时显存互斥（唯一的真难点）

现状：`trainer/app/engine.py` 保证「同一进程内同一时刻只有一个引擎持显存」。
新增 `mtts` 后，两个进程互相看不见对方的 `torch.cuda.memory_allocated()`，
会出现「GPT-SoVITS 占着 3 GB + VoxCPM2 要 8 GB」的 OOM。

三个候选方案：

| 方案 | 做法 | 评价 |
| --- | --- | --- |
| A. 网关仲裁 | 网关持有全局租约，两个服务加载模型前先向网关申请 | 语义最干净，但网关要变有状态，且手动启动的 Python 服务会绕过它 |
| B. **trainer 主、mtts 从** ⭐ | `trainer` 增开 `POST /v1/engines/external`（登记/释放外部占用），`mtts` 加载前先调 `GET /v1/engines` 看有没有人、有就请求让位，成功后登记 | 改动最小：`trainer` 只加一个路由，`mtts` 单向往来；`/v1/engines` 状态页天然反映全局 |
| C. 独立仲裁进程 | 新增第三个进程专管显卡租约 | 最正，但多一个要维护、要排障的进程，对这个项目过度设计 |

**推荐 B。** 落地要点：

1. `trainer/app/routers/engines.py` 增加两个端点（这是本次对 `trainer/` 的**唯一**改动）：
   - `POST /v1/engines/external` `{name, action: "acquire"|"release"}` —— 登记/注销外部占用；
   - `GET /v1/engines` 的响应里多一个 `external` 字段。
2. `mtts/app/gpu_bridge.py`：`acquire()` 时先 `GET trainer /v1/engines`；若 `active` 非空则
   `POST trainer /v1/engines/unload` 请它让位，再检查 `free_vram_mb()`，最后登记自己。
3. **降级**：`trainer` 不可达（用户只跑 `mtts`）时，`gpu_bridge` 退化为只看本机
   `free_vram_mb()`，并在 `/health` 里标注 `coordination: "standalone"`。不因为协调方缺席就拒绝服务。
4. **超时与自愈**：登记带 TTL（默认 300 s），`mtts` 每 60 s 续约；进程被 kill 后 trainer 侧的外部占用
   最多错报 5 分钟，随后自动过期。

### 5.1 8.6 GB 上的准入档位

`mtts/app/engine.py` 的 `ENGINES` 表建议值（宁高勿低，估高只是提前拒绝，估低是跑到一半 OOM）：

| 引擎 | required_mb | 备注 |
| --- | --- | --- |
| `omnivoice` | 5120 | fp16，官方 ~4 GB，加激活值 |
| `qwen3` (1.7B) | 6144 | bf16 + tokenizer + KV cache |
| `qwen3` (0.6B) | 3072 | **建议默认档** |
| `voxcpm` | 8192 | 官方 ~8 GB；8.6 GB 卡上必然压线，需 `load_denoiser=False` |

VoxCPM2 的兜底链：fp16 → `load_denoiser=False` → 仍不足则明确报
`VRAM_INSUFFICIENT` 并提示「改用 Qwen3-TTS 0.6B 或卸载其他引擎」，**不静默落到 CPU**。
CPU 上 2B 模型的 RTF 会是几十倍，给了也等于不可用，不如如实拒绝。

---

## 6. 配置管理

| 位置 | 内容 |
| --- | --- |
| `mtts/.env.example` | `PORT=9882`、`MTTS_DEVICE=auto`、`MTTS_DTYPE=fp16`、`MTTS_DATA_DIR`（指向 `trainer/.data`）、`TRAINER_URL=http://127.0.0.1:9881`（GPU 协调对端）、`MTTS_WARMUP=false`、`MTTS_HF_ENDPOINT`（国内镜像）、`*_HOME` 三个模型目录 |
| `server/.env.example` | 增加 `MTTS_URL`、`MTTS_AUTOSTART=false` |
| `server/src/config/index.ts` | 增加 `mtts` 段，与 `sovits` 段同构 |
| `server/src/routes/` | 新增 `mtts.ts`——直接复制 `sovits.ts`，改前缀与端口，**零业务逻辑** |
| `server/src/index.ts` | `/api/mtts` 同样必须挂在 `express.json()` **之前**（沿用现有踩坑结论） |

**启动编排**：`package.json` 的 `dev` 增加第四个任务，但默认**不启动** `mtts`。
新增 `npm run dev:mtts`（四进程）与 `npm run mtts:check`。

理由很实际：`mtts` 的 venv 要 `import torch 2.8` 还要可能下载十几 GB 权重，
让所有用户在 `npm run dev` 时多等两分钟、多占一份显存，是纯粹的损失。
新能力应当是 **opt-in**，现有用户的启动体验一个字节都不该变。

---

## 7. 版本兼容策略

三个上游都处在快速迭代期（均为 2026 年新发布），必须 pin。

- **Python**：统一 **3.12.x**（满足 OmniVoice ≥3.10、VoxCPM2 的 `[3.10, 3.13)`、Qwen3-TTS 推荐的 3.12）。
- **torch**：统一 **2.8.x + cu128**；若 `nvidia-smi` 显示的驱动 CUDA Version < 12.8，
  退回 **cu126** 并重新验证（OmniVoice 官方只给 cu128 示例，但 wheel 索引里 cu126 通常也在）。
- **上游包**：`omnivoice` / `voxcpm` / `qwen-tts` 全部 `==` 精确 pin，记录在 `mtts/PINNED.md`，
  附验证日期与验证时的 commit。
- **权重**：HF 为主源，ModelScope 为国内备源（`mtts/app/weights.py` 复用
  `trainer/app/weights.py` 的 `WeightSpec(key, engine, relative, url, mirrors, size_mb, required)` 结构）；
  下载脚本并入现有 `scripts/download_models.py`。
- **升级流程（蓝绿）**：新建 `mtts/.venv-next` → 跑冒烟（§8）→ 比对三条固定文本的音频指纹 →
  通过才切 `.venv`。**永远不要在位升级**，因为 torch 升级一旦失败，回滚比重建还慢。
- **磁盘预算**：venv（torch+CUDA wheel 约 3 GB）+ 三份权重（约 12 GB）+ 输出缓存，
  建议预留 **30 GB**。

---

## 8. 测试策略

项目当前没有测试框架也没有 CI，质量手段是**冒烟脚本 + `npm run typecheck`**。
本次继续沿用这个路子，不引入 pytest——引入一个没人维护的测试框架比没有更糟。

| 脚本 | 作用 |
| --- | --- |
| `scripts/preflight_mtts.py` | 静态预检：Python / torch / CUDA 版本、`pip list` 与 PINNED 比对、三个包能否 `import`、权重是否就位、9882 端口是否被占 |
| `scripts/smoke_mtts.py --model <m>` | 真跑一条合成：产出 wav、打印耗时 / RTF / 峰值显存，退出码 0/1 |
| `scripts/smoke_mtts.py --all` | 串行跑三个模型，**每次只加载一个**，顺便验证 §5 的互斥与让位 |
| `scripts/bench_mtts.py` | 固定 20 中 + 20 英文本，输出 RTF、首包延迟、峰值显存对比表 |
| `npm run mtts:check` | 网关侧探活，与现有 `sovits:check` 同构 |
| `npm run sovits:check` | **回归项**：整合后必须仍然通过，这是"不影响现有业务"的直接证据 |

**基准分怎么打**：项目里已经有 ASR 板块（FunASR / faster-whisper）。
`bench_mtts.py` 可以调用现有的 `/v1/asr/transcribe` 对合成音频做转写，自动算 CER/WER——
这样"哪个模型更适合中文有声书"就有本机客观数据，不用靠听感争论。这是本项目独有的便利条件。

**契约测试**：加一个 `scripts/validate_catalog.py`，断言三个 `catalog` 输出的字段结构一致
（`modes` / `languages` / `params` / `vram_mb` / `weights_ready`）。前端按 schema 渲染，
schema 一旦漂移页面就会渲染错，这个校验是必要的。

---

## 9. 性能对比：预期与实话

| 模型 | 官方 RTF | 本机预估 RTF（4060 Laptop 8.6 GB） | 首包延迟 | 峰值显存 |
| --- | --- | --- | --- | --- |
| GPT-SoVITS（现有） | ~0.028（4060Ti） | 0.05~0.1 | 整段返回 | ~3 GB |
| OmniVoice | 0.0899（H100, bs=1, fp16, 32 步） | **0.4~0.8** | 整段返回 | ~4 GB |
| Qwen3-TTS 0.6B | — | **0.3~0.5** | ~100 ms（流式） | ~2.5 GB |
| Qwen3-TTS 1.7B | — | 0.5~1.0 | ~97 ms（流式） | ~5 GB |
| VoxCPM2 | ~0.30（4090） | **1.0~1.5（慢于实时）** | 流式可用 | ~8 GB |

三点必须写进预期管理：

1. **新模型在本机上都比 GPT-SoVITS 慢**，VoxCPM2 甚至可能慢于实时。它们换的是质量与能力，不是速度。
2. **首包延迟**才是新模型的真正优势：Qwen3-TTS 97 ms 与 VoxCPM2 流式，能做"边说边出声"的交互体验，
   这是 GPT-SoVITS 的非流式链路给不了的。建议把"流式播放"作为新模型的差异化卖点，而非吞吐。
3. `bench_mtts.py` 的实测数据出来之前，上表都是估算，README 里不能写成既成事实。

---

## 10. 迁移路径

| 阶段 | 内容 | 验收 | 对现有功能的影响 |
| --- | --- | --- | --- |
| **0. 预检** | 建 py3.12 venv，装 torch 2.8+cu128，装三个包，跑 `preflight_mtts.py`；确认驱动 CUDA 版本、磁盘空间、顶层模块名冲突表 | 三个包都能 `import`；`nvidia-smi` CUDA ≥ 12.6 | 无 |
| **1. 骨架** | `mtts/` 服务骨架 + `engine.py` + `routers/engines.py` + 网关 `/api/mtts` 透传 + `gpu_bridge`（方案 B，`trainer` 加两个端点） | `GET /api/mtts/v1/engines` 能反映两个进程的全局状态 | `trainer` 仅新增 2 个路由 |
| **2. OmniVoice** | 第一个跑通的模型（最轻 4 GB、600+ 语言、内置 ASR 免 `ref_text`） | 单条 + 批量 + 音色库接入 | 无 |
| **3. Qwen3-TTS** | 0.6B 默认 + 1.7B 可选；补上 GPT-SoVITS 缺的音色设计与预置音色 | VoiceDesign 页面可选此模型；流式播放可用 | 无 |
| **4. VoxCPM2** | 放最后：8 GB 压线，先 fp16 + `load_denoiser=False` 验证，不行就砍掉 | 在 8.6 GB 上能跑完一条 15 秒合成 | 无 |
| **5. 统一前台** | `providers/registry.ts` 注册三个 Provider、`SettingsPage` 表单、批量与历史接入、`recommendProvider` 扩展语言推荐 | 设置页切换模型可用；默认 Provider 仍是 `mimo` | 无 |
| **6. 微调（可选）** | VoxCPM2 LoRA / Qwen3-TTS SFT；OmniVoice 优先级最低 | — | 无 |

阶段排序的理由：OmniVoice 最轻且覆盖面最广，先跑通能最快验证整套新架构；
VoxCPM2 显存风险最高，放在最后，砍掉它也不影响前四个阶段的成果。

---

## 11. 建议达到的程度

**应当做到（L1 融入）**：

- 三个模型能单条 / 批量合成，走统一的请求契约与统一响应格式；
- 复用现有音色库，预编码 prompt 按模型缓存；
- 能力清单驱动前端（不支持的模式明确报错 + `hint`，不静默降级）；
- 跨进程显存互斥生效，`/v1/engines` 能看到全局；
- `npm run sovits:check` 与全部既有冒烟脚本仍然通过；
- 默认不启动，现有用户的启动体验不变。

**按模型能力差异化做（L2）**：

- 流式播放：Qwen3-TTS 与 VoxCPM2 支持，OmniVoice 明确返回不支持；
- 预置音色：只有 Qwen3-TTS 有 9 个，其余两个如实标注；
- prompt 预编码复用：三个都做，批量场景收益明显。

**明确不建议做**：

- ❌ 把新模型塞进 `trainer/` 的 py3.9 解释器，或为它们升级 torch / numpy；
- ❌ 统一微调流水线——三个上游的训练脚本形态差异太大（OmniVoice 的 `examples/`、
  VoxCPM2 的 yaml conf、Qwen3-TTS 的 `finetuning/`），成本远高于收益；
- ❌ 在 8.6 GB 卡上让任意两个大模型同时常驻；
- ❌ 引入 pytest / CI——与项目现状不符，先让冒烟脚本跑起来更实际。

---

## 12. 风险登记

| 风险 | 概率 | 影响 | 处置 |
| --- | --- | --- | --- |
| 驱动 CUDA < 12.6，装不了 torch 2.8 | 中 | 阻塞 | 阶段 0 第一条就查 `nvidia-smi`；不行退 cu118 的 torch 2.5（需验证 OmniVoice 是否接受） |
| VoxCPM2 在 8.6 GB 上 OOM | **高** | 该模型不可用 | 阶段 4 验证；失败则砍掉，文档如实写明「8 GB 卡不支持」 |
| 三个上游快速迭代导致 API 漂移 | 中 | 升级即崩 | 精确 pin + 蓝绿升级 + `PINNED.md` |
| 新装 torch 牵动系统 Python | 低 | 破坏整合包 | 只用 venv，绝不装进整合包 `runtime/python.exe` |
| 两个服务同时写 `voices.json` | 低 | 音色库损坏 | 约定 `trainer` 独占写元数据，`mtts` 只写 `prompts/` |
| 磁盘不足（约 30 GB） | 中 | 装不完 | 阶段 0 检查；权重按模型分批下载，不用全装 |

---

## 13. 阶段 0 待办清单

- [ ] `nvidia-smi` 确认驱动 CUDA Version（决定 cu128 还是 cu126）
- [ ] 确认剩余磁盘 ≥ 30 GB
- [ ] 建 py3.12 venv，装 torch 2.8 + 三个包，记录版本到 `mtts/PINNED.md`
- [ ] 跑 `import` 冒烟，记录顶层模块名冲突表（尤其 `qwen_tts` 与已有 `transformers` 的版本要求）
- [ ] 确认 `trainer/app/audio/io.py` 是否只依赖 numpy/soundfile（决定共享还是复制）
- [ ] 实测一条固定文本的 RTF 与峰值显存，替换 §9 的估算值

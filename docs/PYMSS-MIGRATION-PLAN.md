# UVR5 → PyMSS 后端替换计划书

> 状态：**只做计划，未实施**。分支 `feature/vc-svc`，日期 2026-10-28，BY Qoder。
> 目标读者：主任务 Agent。请按阶段执行，P0 未确认前**不要删除任何 UVR5 代码/权重**。
> 本仓库当前不是普通单服务：UVR5 同时被 `trainer` 的分离端点、DDSP-SVC 翻唱向导和 GPT-SoVITS 训练流水线使用；这是替换范围，不要只改一个页面。

---

## 0. TL;DR

- **推荐方案**：新增一个独立的 **Python 3.12 PyMSS runtime + CLI bridge**（不改 `vendor/rvc` 子模块），trainer 通过子进程调用 PyMSS，保留 `/v1/uvr/*` 对外契约和现有档位 key。
- **不要**把 `vendor/rvc` 升级到 main 来换 PyMSS：那会把 RVC 推理/训练一起拖到 py3.12，风险远大于收益。
- **PyMSS 模型映射基本现成**：`7_HP2-UVR.pth`（快速）、`model_bs_roformer_ep_317_sdr_12.9755.ckpt`（高保真，和当前同一个模型）、`UVR-DeEcho-DeReverb.pth` / `UVR-De-Echo-Normal.pth` / `UVR-De-Echo-Aggressive.pth`（二级去混响/去回声）。
- **唯一需要 A/B 决策的是 `vocal_main`（当前 HP5_only_main_vocal）**：PyMSS 没有同名 HP5，候选是 `3_HP-Vocal-UVR` / `4_HP-Vocal-UVR` / `5_HP-Karaoke-UVR` / `6_HP-Karaoke-UVR`。P0 听感对比后再定；如果都不合适，保留该档位的 UVR5 回退，不要硬换。
- 交付后保留一个 `UVR_BACKEND=pymss|uvr5` 临时开关；全量验收通过再删除 UVR5 路径。

---

## 1. 目标与非目标

### 目标

1. 把**所有** UVR5 分离调用切到 PyMSS：
   - `/v1/uvr/separate`（同步 + 异步 Job）；
   - DDSP-SVC 翻唱向导内部的分离（`svc.py` 的 `separation`）；
   - GPT-SoVITS 训练流水线的 `0a UVR5` 步骤（`training.py::_step_uvr`）。
2. 保持现有 `/v1/uvr/*` 请求/响应契约、档位 key、缓存与任务进度语义，前端不需要改 API。
3. 保留原 UVR5 产物格式、人声/伴奏命名语义和翻唱链路的三件套（人声 / 伴奏 / 混音）。
4. 提供离线就绪检查、模型清单、显存门槛和失败提示；8GB 卡上可明确判断能不能跑。
5. 通过 A/B 听感与延迟/显存实测，确认替换不劣于当前 UVR5 常用档位。

### 非目标

- 不升级 `vendor/rvc` 子模块，不改 RVC 推理/训练。
- 不改变前端页面结构与 `/v1/uvr/*` 路径。
- 不引入云服务、不改变纯本地部署定位。
- P0 前不删除 UVR5 的代码、权重、缓存或旧档位。

---

## 2. 现状盘点（替换面）

### 2.1 调用链

| 层 | 文件 / 位置 | 现状 |
| --- | --- | --- |
| 分离引擎 | `trainer/app/audio/uvr5.py` | `Uvr5Engine.catalog()` / `separate()`；进程内调用官方 `vr.py` / `mdxnet.py` / `bsroformer.py`；一次调用加载→推理→释放；支持主分离 + 二级净化；走 `ArtifactCache` |
| 档位/模型 | `trainer/app/audio/uvr5_catalog.py` | `SEPARATION_PRESETS`：`vocal_fast`(HP2)、`vocal_main`(HP5)、`vocal_hifi`(BS-RoFormer ep317)；`SECONDARY_PRESETS`：`dereverb`(VR-DeEchoDeReverb)、`deecho_normal`、`deecho_aggressive`；输出 wav/flac/mp3/m4a |
| HTTP | `trainer/app/routers/uvr.py` | `GET /v1/uvr/catalog`、`POST /v1/uvr/separate`（`wait=true` 同步 / 否则 Job）、`GET/DELETE /v1/uvr/cache`；错误码 `UVR5_FAILED` 等 |
| 翻唱向导 | `trainer/app/routers/svc.py` | 把 `uvr5=ctx.uvr5` 和 `separation={preset,secondary}` 传进转换管线；翻唱任务内部先分离再转换/混音 |
| 训练流水线 | `trainer/app/training.py::_step_uvr` | 调 `trainer/tools/uvr_cli.py` 子进程；用 `uvr_model` 指定 UVR5 模型；产物写 `dataset/uvr_vocal`、`dataset/uvr_ins` |
| 训练 CLI | `trainer/tools/uvr_cli.py` | py3.9 封装官方 UVR5；VR/MDX/RoFormer 三类；`vocal_root`/`ins_root` 参数顺序有坑 |
| 引擎门槛 | `trainer/app/engine.py` 的 `uvr5` 项 | 当前 4096MB 静态门槛；`Uvr5Engine` 在 `separate()` 里 `registry.acquire("uvr5")` |
| 前端 | `app/src/pages/SingingConversionPage.tsx` | 翻唱向导第一步 + “只做分离”卡片；`uvrApi.separate()`（`app/src/lib/vc.ts`）；`ResourceBudget task="uvr5"` |
| 术语/文案 | `app/src/lib/glossary.ts`、`docs/VOICE-CONVERSION.md` | UVR5 术语、模型说明、上游定位 |
| 权重 | 整合包 `GPT_SoVITS/...` 外层的 `tools/uvr5/uvr5_weights` | 由 `sovits_catalog.UVR5_WEIGHTS_DIR` 扫描；不属于 `vendor/rvc` |

> 注意：RVC 页（`VoiceConversionPage`）**没有**分离/混音，只有变声；不要顺手改它。

### 2.2 对外契约

必须保持以下字段/语义不变（前端与训练页依赖）：

- `POST /v1/uvr/separate`：`file` / `source` 二选一；`preset`、`secondary`、`agg`、`format`、`use_cache`、`wait`。
- 响应：`ok`、`job_id`（异步）、`urls.vocal`、`urls.instrumental`、`paths`、`model`、`secondary`、`cached`、`elapsed_s`、`meta`。
- `GET /v1/uvr/catalog`：`presets`、`secondary`、`formats`、`default_format`、`kinds`，以及每个档位的 `available`/`vram_mb`。
- 缓存 key：内容指纹 + `stage=separation` + 参数；替换后必须把 `backend`/`model`/`pymss_version` 纳入参数，避免命中旧 UVR5 缓存。
- 任务：`JobKind.SEPARATE` 的进度/取消/日志；训练 `_step_uvr` 的 `uvr_model` 字段。

---

## 3. 上游 PyMSS 事实（已核对）

| 项 | 事实 |
| --- | --- |
| 来源 | RVC 官方上游 `main` 的 `tools/pymss` + `tools/pymss_core`；PyPI `pymss==2.0.14`、`pymss-core==0.1.4`（RVC main 的 requirements 锁定） |
| Python | 上游 requirements 使用 **py3.12**（`requirments_cu118_py312.txt` / `cu128_py312.txt`）；不能直接塞进 trainer 的 embedded py3.9 |
| 许可 | `tools/pymss/LICENSE` 为 MIT；模型权重从 HF/ModelScope `baicai1145/pymss` 下载，**模型许可需逐个核对** |
| CLI | `pymss list/info/download/infer/ensemble/serve`；`infer` 支持 model/input/output/device/output-format/param；模型可自动下载 |
| 服务 API | `POST /v1/audio/separations`（JSON 或 octet-stream；返回 JSON/zip）、`GET /v1/models`、`POST /v1/models/load` 等；本计划**不采用常驻服务**，只用 CLI/bridge |
| 模型目录 | 默认 `~/.cache/pymss/models`，可用 `PYMSS_MODEL_DIR` 指定；仓库内建议 `pymss/models/`（gitignore） |
| 模型目录规模 | 官方 catalog 约 319 个模型；**只下载本次需要的 5~6 个**，不要 `download all` |

### 3.1 档位映射（P0 需要听感确认的用 ⚠️ 标记）

| 当前档位 | 当前 UVR5 模型 | PyMSS 候选 | 说明 |
| --- | --- | --- | --- |
| `vocal_fast` | `HP2_all_vocals` | `7_HP2-UVR.pth`（备选 8/9） | 同名 HP2 系，优先 7；P0 确认 |
| `vocal_main` | `HP5_only_main_vocal` | ⚠️ `3_HP-Vocal-UVR` / `4_HP-Vocal-UVR` / `5_HP-Karaoke-UVR` / `6_HP-Karaoke-UVR` | PyMSS 无 HP5 同名；**必须 A/B 听感/主唱保留度**后选；都不合适则本档位保留 UVR5 回退 |
| `vocal_hifi` | `model_bs_roformer_ep_317_sdr_12.9755` | `model_bs_roformer_ep_317_sdr_12.9755.ckpt` | 同名同架构，最稳 |
| `secondary=dereverb` | `VR-DeEchoDeReverb` | `UVR-DeEcho-DeReverb.pth` | 同名 VR，catalog 在 `legacy_vr` |
| `secondary=deecho_normal` | `VR-DeEchoNormal` | `UVR-De-Echo-Normal.pth` | 同名 VR |
| `secondary=deecho_aggressive` | `VR-DeEchoAggressive` | `UVR-De-Echo-Aggressive.pth` | 同名 VR |
| 当前 MDX 去混响（`onnx_dereverb_By_FoxJoy`） | `onnx_dereverb_By_FoxJoy` | 无同名；候选 `dereverb-echo_mel_band_roformer_sdr_13.4843_v2.ckpt` / `Lead_VocalDereverb.ckpt` | 若训练页仍暴露该模型，P0 决定映射或下线；不要静默换模型 |

> PyMSS 的 `agg`（VR 激进程度）需要确认是否支持；若不支持，保留该参数但映射为固定值，或在 catalog 里标 `agg_supported=false`，前端隐藏。

---

## 4. 架构决策

### 4.1 方案对比

| 方案 | 做法 | 风险 | 结论 |
| --- | --- | --- | --- |
| A. 升级 `vendor/rvc` 到 main | 直接使用 RVC main 的 PyMSS | 会把 RVC 推理/训练一起升到 py3.12；破坏现有 RVC 直连、LoRA、训练链 | ❌ 不做 |
| B. 独立 py3.12 runtime + CLI bridge | 新建 `pymss/` venv；trainer 以子进程调用 bridge；保留 `/v1/uvr/*` | 多一个运行时/venv；模型下载/许可；需要桥接进度/取消 | ✅ **推荐** |
| C. 独立常驻 PyMSS 服务 + 网关代理 | 起 :9886，trainer 走 HTTP | 多一个服务、端口、supervisor、arbiter、VRAM 常驻协调；当前分离是短任务，收益低 | 备选（将来需要并行/常驻时再做） |

### 4.2 推荐数据流（方案 B）

```
前端 / svc / training
        ↓ 现有 /v1/uvr/* 或内部调用
trainer 的 PymssEngine (trainer/app/audio/pymss.py)
        ↓ 子进程（py3.12）
pymss/.venv/python.exe pymss/bridge.py  --request <json>
        ↓ PyMSS Python API / CLI
pymss/models/<model>  →  outputs/vocal_*.wav / instrumental_*.wav
        ↓ JSON lines / stderr
trainer 收集产物 → ArtifactCache → /files/separation/<job>/...
```

- **进程隔离**：PyMSS 的 torch/依赖不污染 trainer 的 py3.9；CUDA 上下文随进程退出释放。
- **引擎门槛**：trainer 在起子进程前 `registry.acquire("uvr5")`，子进程结束后 release；不引入新端口/服务。
- **取消**：kill 子进程树（Windows `taskkill /T /F`）；训练任务的 cancel 复用现有进程树清理。
- **进度**：bridge 用 stdout JSON lines（`{"event":"progress","fraction":0.2,"message":"..."}`），stderr 收集 PyMSS 日志；trainer 映射到 JobStore。
- **缓存**：继续用 `ArtifactCache`；缓存 key 中加入 `backend=pymss`、`model`、`pymss_version`、`agg`、`format`，旧 UVR5 缓存不命中也不删除。
- **二级净化**：两次 bridge 调用（主分离 → 人声再净化），与当前语义一致；第二次只替换人声，保留第一次的伴奏。

---

## 5. 分阶段实施

### P0 — 模型 A/B 与映射冻结（先做，不写生产代码）

**目的**：确认 PyMSS 的档位映射，尤其是 `vocal_main`；避免“换完发现主唱被削”。

任务：

1. 建 `pymss/`（只放临时脚本/venv/模型，gitignore；不要改生产代码）：
   - Python 3.12 venv；安装 `pymss==2.0.14`、`pymss-core==0.1.4`；CUDA wheel 与当前驱动匹配（cu128 优先，按上游 `requirments_cu128_py312.txt`）。
   - `PYMSS_MODEL_DIR=<repo>/pymss/models`；下载候选模型（只下载 7~8 个，不下载全量）。
2. 准备 3 段测试素材（各 20~40 秒）：
   - 干净说话 + 轻伴奏；
   - 带和声/主唱的歌曲；
   - 现场/房间混响素材。
3. 对每个档位跑当前 UVR5 与 PyMSS 候选，输出 `vocal`/`instrumental`：
   - 记录：主唱保留度、和声/伴奏泄漏、齿音/气声、耗时、峰值显存、输出采样率/格式。
   - 有工具就用 SDR/SI-SDR（可选）；没有就做盲听 + 主观 1~5 分。
4. 产出 `pymss/weights.manifest.json`（选定模型名/大小/SHA256/来源/许可）与一页 A/B 结论，写入计划/交接文档。
5. **冻结映射表**；`vocal_main` 若没有可接受候选，明确“保留 UVR5 回退”并在 catalog 标注。

**验收**：每个档位有明确 PyMSS 模型；`vocal_main` 有结论（换 / 保留回退）；GPU 窗口内完成；不修改生产代码。

**需要用户点头**：A/B 需要约 3~5GB 显存窗口（当前 GPT-SoVITS 常驻时只剩 ~0.8GB）。

### P1 — PyMSS runtime 与 bridge

新增（建议目录）：

```
pymss/
  README.md                 # 运行时、模型、命令、许可
  bridge.py                 # trainer 调用的 JSON-lines bridge
  weights.manifest.json    # 选定模型清单（进版本库）
  models/                  # 模型权重（gitignore）
  .venv/                   # py3.12 venv（gitignore）
```

任务：

1. venv/依赖固定：`pymss==2.0.14` + `pymss-core==0.1.4` + 与驱动匹配的 torch；记录 `python -V` / `pip freeze` 关键行到 README。
2. `bridge.py` 协议：
   - 入参 JSON：`source`、`model`、`vocal_dir`、`inst_dir`、`format`、`agg`、`device`、`stems`；
   - 输出 stdout JSON lines：`progress` / `result`（vocal/instrumental 绝对路径）/ `error`（code/message/hint）；
   - stderr 输出 PyMSS 日志；不要混进 stdout；
   - 校验输入存在、输出目录可写、模型存在；缺模型给 `PYMSS_MODEL_MISSING`，缺 venv/pymss 给 `PYMSS_NOT_READY`；
   - 退出码 0/非 0；异常带原始错误。
3. 模型管理：
   - `pymss/weights.manifest.json`（选定模型、大小、SHA256、来源、许可）；
   - 下载脚本（`pymss download <model>`，支持 HF/ModelScope 镜像；离线环境预置模型）；
   - `scripts/pymss-check.mjs` 或 `pymss/check.py`：检查 venv、pymss 版本、模型文件、CUDA 可用性；失败给具体修复命令；
   - 模型目录 gitignore；不要动现有 UVR5 权重目录。
4. 许可：逐个核对选定模型许可；在 README/界面 SourceNote 标注来源；不明确时不用。

**验收**：在 py3.12 venv 下 `pymss infer` 能对测试音频出正确的 vocal/instrumental；bridge 的 JSON 协议/错误码可被脚本断言；`pymss-check` 在缺模型/缺 venv 时给出可读错误。

### P2 — trainer 适配层（保留 `/v1/uvr/*` 契约）

新增 `trainer/app/audio/pymss.py`（建议名 `PymssEngine`），保持与 `Uvr5Engine` 相同签名：

- `catalog(home)`：返回同样的 `presets/secondary/formats/default_format/kinds`，但 `model`/`available` 用 PyMSS 映射；补充 `backend: "pymss"`、`models_ready`、`required_vb`。
- `separate(home, src, preset_key, secondary_key, agg, fmt, use_cache, progress)`：
  - 校验 preset/secondary；`off` 档位仍直接返回源音频；
  - `ArtifactCache` 查/存；key 加 `backend=pymss` + 映射模型 + pymss 版本；
  - `registry.acquire("uvr5")`（保留逻辑门槛）；
  - 启动 `pymss/.venv/python.exe pymss/bridge.py` 子进程，传 JSON；解析 stdout 进度；stderr 日志；
  - 结束后校验 vocal/instrumental 存在；二级净化再跑一次 bridge；
  - 取消/超时：kill 进程树，返回 `SeparationError`；
  - 错误映射：缺模型/缺运行时/加载失败/GPU OOM/格式不支持 → 保留现有 `SeparationError` 语义 + 新 hint。
- `trainer/app/api.py`：按 `UVR_BACKEND`（`pymss|uvr5`）选择引擎；保留 `ctx.uvr5` 变量名以免大面积改调用点，或改为 `ctx.separation` 并同步 `uvr.py`/`svc.py`。
- `trainer/app/config.py`：新增 `pymss_dir`、`pymss_python`、`pymss_model_dir`、`uvr_backend`（默认 `pymss` 只在 P6 切换；迁移期默认 `uvr5`）。
- `uvr5_catalog.py`：保留公开 preset key；新增 `pymss_model` 字段/映射函数；`vram_mb` 按 P0 实测更新。
- `routers/uvr.py`：`/v1/uvr/catalog` 增加 `backend`/`models_ready`；缺 PyMSS 时 503 `PYMSS_NOT_READY`（带安装/下载 hint），不要裸 500。
- 训练页/翻唱页不需要改请求字段；若 `vocal_main` 映射变模型，只改后端映射。

**验收**：
- `.tmp/verify_pymss_backend.py`：catalog；缺 venv/模型错误；同步分离；异步 Job；缓存命中；二级净化；取消；格式；产物路径/采样率。
- 翻唱向导 `separation` 路径跑通（分离 → 转换 → 混音）。
- `UVR_BACKEND=uvr5` 下旧路径不回归。

### P3 — 训练流水线 `_step_uvr`

- 把 `trainer/app/training.py::_step_uvr` 从 `trainer/tools/uvr_cli.py` 切到 PymssEngine/bridge；保留 `uvr_model`、`uvr_keep_vocal/ins`、输出目录 `uvr_vocal`/`uvr_ins`。
- `uvr_model` 兼容：
  - 训练页的模型下拉来自 `/v1/uvr/models`（当前 UVR5 ID）；提供 **旧 ID → PyMSS 模型** 别名表，保持 UI 不改；
  - 如果某个旧模型没有 PyMSS 映射（如 `onnx_dereverb_By_FoxJoy`），在 catalog/下拉里标 `available=false` + 原因，不要静默替换；
  - P0 的 `vocal_main` 若回退 UVR5，则该模型走旧 CLI（混合模式），在 catalog 标注。
- 进度/取消：沿用训练 step 的取消/进程树清理；bridge 进度映射到 step progress。
- 训练产物命名/目录保持，后续切分/标注/训练步骤无需改。

**验收**：用小语料跑 `_step_uvr`，产物进 `uvr_vocal/uvr_ins`；取消无残留 PyMSS 进程；训练页选旧 UVR5 模型 ID 仍能工作（别名）。

### P4 — 资源、前端文案与文档

- `engine.py` 的 `uvr5` 门槛 / `uvr5_catalog.vram_mb` / `FALLBACK_VRAM_MB['uvr5']` / `ResourceBudget` 按 P0 实测更新（HP2/BS-RoFormer/去混响分别记录）。
- `ResourceBudget` 的 `uvr5` 提示：若 PyMSS 缺运行时/模型，显示“PyMSS 未就绪”，不要提示关 GPT-SoVITS（当前 trainer 任务文案已修，沿用）。
- 前端文案（不改 API）：
  - `SingingConversionPage` 的 SourceNote / “UVR5 分离”文案改为“PyMSS 音源分离（兼容原 UVR5 档位）”；
  - `glossary.ts` 的 UVR5 术语补“底层已切 PyMSS”；
  - 训练页 UVR5 步骤文案同步；
  - `docs/VOICE-CONVERSION.md`、训练文档、`docs/INDEX-TTS...` 不涉及。
- 保留旧 UVR5 权重目录和 `trainer/tools/uvr_cli.py` 直到 P6；不要删除用户文件。

**验收**：UI 不再误导“整合包 tools/uvr5 在跑”；资源门槛与实测一致；缺 PyMSS 时错误可操作。

### P5 — 测试与真机验收

必须覆盖：

1. **离线/单测**：bridge JSON 协议、错误码、缺 venv/模型、输出校验；PymssEngine catalog/映射/缓存 key。
2. **HTTP**：`/v1/uvr/catalog`、同步/异步分离、缓存命中/清理、取消、错误路径；`/api/capabilities`/`/api/open` 若引用 UVR5 能力需同步（检查 `capabilityCatalog`）。
3. **翻唱端到端**：一条真实歌曲 → 分离 → DDSP-SVC 转换 → 混音；对比当前 UVR5 结果；确认人声/伴奏/混音三件套。
4. **训练 UVR5**：小语料 `_step_uvr`，产物/取消/日志。
5. **A/B 听感**：P0 素材；记录主唱保留度、泄漏、气声、耗时、峰值显存；结论写入 PROGRESS/HANDOFF。
6. **显存**：8GB 卡；HP2/BS-RoFormer/去混响分别测峰值；更新门槛；与 GPT-SoVITS/RVC/DDSP 互斥验证。
7. **回归**：`UVR_BACKEND=uvr5` 旧路径；RVC 变声/训练不受影响；GPT-SoVITS 训练其它步骤不受影响。
8. **命令**：`npm run typecheck` / `build` / `eslint`（改动文件）/ `py_compile`（IndexTTS 之外用 trainer runtime）；新增 `npm run pymss:check`。

**验收标准**：
- 所有 UVR5 调用点默认走 PyMSS；旧 UVR5 仅作为显式回退；
- 同一档位主观质量不劣于当前，且延迟/显存有记录；
- 无残留 PyMSS 子进程/显存；取消可用；
- 缺模型/缺 venv 有可读错误；
- 现有翻唱/训练/前端契约无回归。

### P6 — 切换、清理与回滚

1. 默认 `UVR_BACKEND=pymss`；保留 `uvr5` 回退一个阶段。
2. 文档同步：`PROGRESS.md` 新阶段、`HANDOFF.md` 新坑（PyMSS py3.12/模型映射/取消）、`AGENT_CHANGELOG.md`、`docs/VOICE-CONVERSION.md`、`docs/TRAINING.md`（UVR5 步骤）。
3. 观察一个使用周期后，再决定是否删除 `trainer/tools/uvr_cli.py`、`uvr5.py` 的旧实现和 UVR5 权重引用；**不要删除用户的 UVR5 权重**，只移除代码依赖/文档，或保留只读兼容。
4. 回滚：`UVR_BACKEND=uvr5` + 恢复默认；PyMSS runtime/模型可保留不动；缓存 key 含 backend，无脏命中；无数据迁移。

---

## 6. 资源、缓存、取消的硬约束

- **缓存**：`backend`/`model`/`pymss_version` 必须进 separation cache key；否则换后端后命中旧 UVR5 产物，出现“换模型没变化”的假象。
- **进程树**：Windows 下用 `taskkill /T /F` 清理 bridge 及其子进程；取消后检查无 PyMSS Python 残留。
- **显存**：bridge 退出后 CUDA 上下文释放；trainer 的 `registry.release("uvr5")` 在 finally；不要在 bridge 运行期间切到别的 GPU 引擎。
- **模型下载**：默认离线优先；`pymss:check` 不自动下载；下载脚本显式执行；`PYMSS_MODEL_DIR` 指向仓库内目录，避免落到 `C:\Users\...\.cache`。
- **输出格式**：先验证 wav/flac；mp3/m4a 若 PyMSS 不支持，收窄 `OUTPUT_FORMATS` 并同步前端/训练页；不要静默降级。
- **许可**：PyMSS MIT，但每个模型单独核对；模型清单记录来源/许可，界面 SourceNote 标注。

---

## 7. 风险与应对

| 风险 | 概率 | 影响 | 应对 |
| --- | --- | --- | --- |
| PyMSS 需要 py3.12/torch cu128，venv 大、安装失败 | 中 | 迁移阻塞 | 用 uv + 上游 requirements；先跑 `pymss:check`；固定版本；记录 `UV_CACHE_DIR` |
| `vocal_main`（HP5）无同款，主唱被削 | 高 | 翻唱质量下降 | P0 A/B；没有合适候选就保留该档位 UVR5 回退，不硬换 |
| PyMSS CLI/API 版本漂移 | 中 | bridge 失败 | 固定 `pymss==2.0.14`/`pymss-core==0.1.4`；bridge 只依赖稳定 API；升级另立阶段 |
| 模型下载源不可用/许可不明 | 中 | 无法离线/合规 | 预置模型到仓库目录；HF/ModelScope 镜像；逐个记录许可；不明确不用 |
| 子进程 VRAM 不受 trainer 控制 | 中 | OOM/与 RVC 抢卡 | bridge 前 `registry.acquire`；短生命周期；实测门槛；必要时加 `PYMSS_DEVICE=cpu` 排障 |
| 取消后进程/显存残留 | 中 | 下次任务失败 | 进程树清理 + 取消回归；检查 nvidia-smi/python 残留 |
| 缓存旧 UVR5 命中 | 高 | “换了没效果” | cache key 加 backend/model/version；必要时清 `separation` 缓存 |
| 训练页 `uvr_model` ID 失效 | 高 | 训练 UVR5 步骤报错 | 兼容别名表；缺失模型标 `available=false` 并给原因 |
| 前端文案仍说“整合包 UVR5” | 中 | 误导 | P4 统一 SourceNote/术语/文档 |
| 8GB 卡实测窗口不足 | 高 | 验收拖延 | P0/P5 需用户提供 3~5GB 窗口；先 CPU/短素材做桥接测试 |

---

## 8. 待用户/主任务 Agent 决策

1. **`vocal_main`**：P0 选出最佳 PyMSS 候选；若都不行，接受“该档位保留 UVR5 回退”吗？
2. **最终是否删除 UVR5 代码/依赖**：建议保留一个阶段回退，再删；用户是否要求彻底移除？
3. **模型存储**：`pymss/models/`（仓库内，gitignore）还是 `models/pymss`？建议 `pymss/models`，与 runtime 同目录。
4. **是否要常驻服务**：推荐 CLI 子进程；如果将来需要并行/复用模型，再升级为 :9886 服务。
5. **GPU 窗口**：A/B 与真机验收需要约 3~5GB 空闲；当前 GPT-SoVITS 常驻时不够，需用户安排。

---

## 9. 交付清单（主任务 Agent 收尾时逐项打勾）

- [ ] `pymss/` runtime + `bridge.py` + `weights.manifest.json` + `README.md`
- [ ] `pymss:check` / 模型下载脚本
- [ ] `trainer/app/audio/pymss.py` + `UVR_BACKEND` 选择
- [ ] `Uvr5Engine` 等价契约（catalog/separate/cache/二级/取消）
- [ ] `training.py::_step_uvr` 切 PyMSS + `uvr_model` 别名
- [ ] `routers/uvr.py` 就绪检查/错误码/backend 字段
- [ ] P0 A/B 报告与映射冻结（含 `vocal_main` 结论）
- [ ] 显存/延迟实测回填（HP2 / BS-RoFormer / 去混响）
- [ ] 前端文案/术语/ResourceBudget 更新
- [ ] 回归：`/v1/uvr/*`、翻唱端到端、训练 UVR5、`UVR_BACKEND=uvr5` 回退
- [ ] 文档：PROGRESS / HANDOFF / AGENT_CHANGELOG / VOICE-CONVERSION / TRAINING
- [ ] 无残留 PyMSS 进程/显存；旧 UVR5 权重未删除

---

## 10. 参考命令（实施时按实际路径调整）

```bash
# 1) PyMSS runtime（py3.12；UV_CACHE_DIR 必须指到工作区内，避免 D:\AI_Cache 写不进去）
export UV_CACHE_DIR="$PWD/pymss/.uv-cache"
uv venv pymss/.venv --python 3.12
pymss/.venv/Scripts/python.exe -m pip install "pymss==2.0.14" "pymss-core==0.1.4"

# 2) 模型（示例；只下载选定模型，不要 all）
export PYMSS_MODEL_DIR="$PWD/pymss/models"
pymss/.venv/Scripts/pymss.exe download 7_HP2-UVR.pth
pymss/.venv/Scripts/pymss.exe download model_bs_roformer_ep_317_sdr_12.9755.ckpt
pymss/.venv/Scripts/pymss.exe download UVR-DeEcho-DeReverb.pth
pymss/.venv/Scripts/pymss.exe download UVR-De-Echo-Normal.pth
pymss/.venv/Scripts/pymss.exe download UVR-De-Echo-Aggressive.pth
pymss/.venv/Scripts/pymss.exe list --json

# 3) bridge 冒烟（实施后）
pymss/.venv/Scripts/python.exe pymss/bridge.py --request '<json>'

# 4) trainer 回归
python .tmp/verify_pymss_backend.py
npm run typecheck && npm run build
```

---

**一句话交接**：先做 P0 的模型 A/B（尤其是 `vocal_main`），再按 P1→P2→P3 把 trainer 的分离调用换成独立 py3.12 PyMSS bridge；`/v1/uvr/*` 契约和前端不动，UVR5 保留到全量验收后再删。

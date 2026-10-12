# GPT-SoVITS worker 进程隔离方案

> 状态：**已实施并通过验证**（任务 1~6 全部完成）
> 起因：RVC 变声时的 `NameError: name '_in_projection' is not defined`
> 前情：`docs/VC-SVC-FEASIBILITY.md` §4 曾判定「不需要为每个引擎开独立子进程 worker」
>
> **实测结论摘要**（详见 §7）
> - 主进程 `F.multi_head_attention_forward` 始终是原生实现（`patched=False`）——隔离生效
> - 主进程 cwd 从头到尾不变；worker 侧 `mha_patched=True` 且 cwd 在整合包根（反证补丁真的生效了，只是关在那边）
> - GPT-SoVITS 全链路行为不变：同步 / 流式 / 批量 / 切分 / 权重热切换 / 训练让位 / 取消
> - HTTP 契约零破坏：`/health` 原有字段一个不少（只追加 3 个 worker 字段）
> - worker 猝死后服务**不撒谎**（`loaded=False` + `worker_error`），下一次请求自动自愈
> - 代价：worker 首载官方管线约 24 s；IPC 跳数开销可忽略；单条合成仍是秒级

---

## 1. 为什么要做

### 1.1 现象

在语音转换（RVC）页面点「开始变声」，报：

```
VcError: 变声失败：Traceback (most recent call last): ...
NameError: name '_in_projection' is not defined
```

这个报错**只在同一个服务进程里先跑过 GPT-SoVITS 之后才会出现** —— 冷启动直接开 RVC 反而正常。

### 1.2 根因：进程级猴子补丁泄漏

`GPT_SoVITS/AR/modules/activation.py` 在 **import 期**就执行了一次全局替换：

```python
F.multi_head_attention_forward = multi_head_attention_forward_patched
```

`torch.nn.functional` 是模块级单例，这个替换影响**整个 Python 进程**，
不只影响 GPT-SoVITS 自己。后果分两层：

1. **函数体缺名字。** `patched_mha_with_cache.py` 只 `import` 了 `_in_projection_packed`
   （外加一句 `from torch.nn.functional import *`），**漏了 `_in_projection`**。
   被替换进来的函数，其 `__globals__` 里因此没有这个名字。
2. **RVC 恰好走那条分支。** `_in_projection` 只在
   `use_separate_proj_weight=True` 时被用到。fairseq 的 `MultiheadAttention`
   （RVC 的 HuBERT 里到处是）正好走这条路径 → `NameError`。

修复见 `trainer/app/torch_compat.py::ensure_mha_patch_complete()`：
把缺失的名字注入补丁函数的 `__globals__`（优先取 `torch.nn.functional._in_projection`，
否则用三次 `F.linear` 兜底）。**官方包一行未改，这是 workaround，不是结构性修复。**

### 1.3 第二条泄漏：永久 `os.chdir`

`trainer/app/sovits/bootstrap.py:121`：

```python
try:
    os.chdir(home)   # ← 不恢复
except OSError:
    pass
```

官方 `TTS.py` 用 `now_dir = os.getcwd()` 拼声码器路径，`1-get-text.py` 依赖 cwd 下的
`text/`，所以 cwd 必须是整合包根目录 —— 但这是**只增不减的进程状态**，
一旦 `bootstrap.install()` 被调过，主进程的 cwd 就永远变成了整合包目录。
所有相对路径的解释从此全部改口径。

### 1.4 为什么值得修

`EngineRegistry` 的 docstring 写得很清楚：RVC / DDSP-SVC 与 GPT-SoVITS
**不需要互相知道**，只要都走注册表。`vendor_paths` 已经提供了四层隔离原语
（`sys_path_context` / `working_directory` / `argv_context` / `ModuleScope`），
`sys.modules` 与 `sys.path` 都能恢复。

真正**恢复不了**的只有两条，它们都是「进程级副作用」：

| 泄漏 | 位置 | 能否在进程内恢复 |
| --- | --- | --- |
| `F.multi_head_attention_forward` 全局替换 | 官方 `activation.py` import 期 | ❌ 无法恢复原函数（原函数对象没被保存） |
| `os.chdir(home)` | 本仓库 `bootstrap.py:121` | ⚠️ 理论上可保存/恢复，但官方代码随时可能再 chdir |

因此**只有一个进程能信任「干净的 torch」**。把 GPT-SoVITS 挪出去，
这两条泄漏就被物理关在了 worker 进程里。

---

## 2. 方案选择与范围

### 2.1 三个选项

| 选项 | 内容 | 评价 |
| --- | --- | --- |
| **A** | 用 save/restore 把 monkey patch 收口，做最小加固 | 治标。补丁函数的 `__globals__` 是共享对象，RVC 侧仍时刻暴露 |
| **B** | **把 GPT-SoVITS 移入独立 worker 进程** | ✅ **采用**。泄漏被物理隔离，且是唯一能同时解决 `os.chdir` 的方案 |
| **C** | 三个引擎（GPT-SoVITS / RVC / DDSP-SVC）全部进程隔离 | ❌ 不做。单张 8.6 GB 卡上进程隔离**不带来并发收益**，却要为每个 worker 付模型加载 + 约 300~600 MB CUDA context 开销 |

### 2.2 为什么 C 不值得做

`EngineRegistry` 的 `acquire()` 已经是「同一时刻只有一个引擎持有 GPU」，
进程隔离**不会**让两个引擎并行跑起来 —— 显存上限摆在那（RTX 4060 Laptop，约 8.6 GB）。

隔离 RVC / DDSP-SVC 的**唯一**收益是省掉 `torch_compat` 那道补丁，
代价是三份 torch 常驻开销。不划算。

而隔离 GPT-SoVITS 的收益是**结构性的**：它是泄漏的源头，
把它关起来，主进程就重新变成「torch 干净」的进程。

### 2.3 为什么这不算推翻 `VC-SVC-FEASIBILITY.md` §4

§4 当年判定「不需要 worker」，理由是**顶层模块名冲突**
（GPT-SoVITS 的 `GPT_SoVITS`/`tools`/`config`；RVC 的 `infer`/`configs`/`i18n`/`tools`/`assets`；
DDSP-SVC 的 `ddsp`/`reflow`/`nsf_hifigan`/`encoder`/`optimizer`/`logger`/`slicer`/`exp`）。

那个理由**依然成立** —— `ModuleScope` + `vendor_paths` 确实解决了模块名冲突。
§4 **没有覆盖**的是「import 期的全局 monkey patch」这一类副作用。
所以结论不变，只是**新增了一个触发条件**：一旦某个引擎在 import 期修改进程级全局状态，
它就必须被隔离。

**补记（阶段 30，2026-10-12）**：按这条判据重新盘了一遍现有引擎 ——
**GPT-SoVITS 仍是唯一需要额外 worker 的**。Irodori-TTS 也会在 import 期 monkey patch
（`irodori/app/windecode.py` 用 soundfile 接管 `torchaudio.load`/`info`），
但它**本身就是独立 venv + 独立进程**，patch 出不了自己的进程边界，
已经满足本文件的「全局 monkeypatch 只准待在自己进程里」，**不需要再套一层 worker**。
netease / indextts 不 patch 任何全局状态。
⇒ 也就是说：需要 worker 的判据是「**与主进程共进程 + import 期改全局**」，缺一不可。

---

## 3. 调用面清单

任务 1 的产出。逐一标出 worker 化后各能力的归属。

### 3.1 所有 sovits 触点都汇聚在 `api.Context`

`trainer/app/api.py` 的 `Context.__init__` 是唯一的装配点：

```python
self.pipeline = Pipeline(settings.data_dir)                       # ← 要换实现
self.engine   = SynthesisEngine(settings, self.pipeline, self.voices)
self.batch    = BatchRunner(settings, self.engine)
self.installation = None
self.engines  = EngineRegistry(settings)
self.engines.register_unloader("sovits", self.pipeline.unload)    # ← 语义要保
```

全量 `ctx.pipeline` / `self.pipeline` 引用点（穷举，共 3 个文件）：

| 文件 | 行 | 调用 | 归属 |
| --- | --- | --- | --- |
| `api.py` | 80 | `Pipeline(settings.data_dir)` 构造 | 换成代理的构造 |
| `api.py` | 84 | `SynthesisEngine(settings, self.pipeline, self.voices)` | 不改（鸭子类型） |
| `api.py` | 99 | `register_unloader("sovits", self.pipeline.unload)` | 语义要保 |
| `api.py` | 128-129 | `set_training_active(True)` + `unload()` | 本地 + RPC |
| `api.py` | 138 | `set_training_active(False)` | 本地 |
| `api.py` | 172 | `resolve_defaults(version)` | 本地（纯文件系统） |
| `api.py` | 283 | `unload()`（lifespan 收尾） | RPC |
| `api.py` | 341 | `status()`（/health） | 本地状态 + RPC 心跳 |
| `api.py` | 412-458 | `status()` / `state.*`（/v1/pipeline, /v1/weights） | 本地状态镜像 |
| `api.py` | 416/424/429 | `warmup(blocking)` / `unload()` / `stop()` | RPC |
| `api.py` | 484-493 | `configure(...)` + `warmup(blocking=True)` | 本地意图 + RPC |
| `api.py` | 603 | `ctx.engine.synthesize_to_file(raw)` | 间接 RPC |
| `api.py` | 608 | `ctx.engine.split_text(...)` | 间接 RPC（**新方法**） |
| `api.py` | 625 | `ctx.pipeline.version`（流式 start 事件） | 本地 |
| `api.py` | 627 | `ctx.engine.stream(raw)` | 间接 RPC |
| `api.py` | 1004 | `ctx.pipeline.stop()`（取消任务） | RPC |
| `inference.py` | 84 | `Pipeline` 类型标注 | 改 import |
| `inference.py` | 101 | `configure(...)` | 本地意图 |
| `inference.py` | 113 | `self.pipeline.version` | 本地 |
| `inference.py` | 130/178/196 | `warmup(blocking=True)` | RPC |
| `inference.py` | 135 | `synthesize(inputs) -> (sr, ndarray)` | **RPC 主路径** |
| `inference.py` | 146 | `current_pair()` | 本地 |
| `inference.py` | 179 | `stream(inputs) -> Iterator[(sr, ndarray)]` | **RPC 流式路径** |
| `inference.py` | 197 | `self.pipeline._pipeline.text_preprocessor.pre_seg_text(...)` | **私有穿透，必须新增 RPC** |

### 3.2 需要跨进程的 9 条能力

| # | 方法 | 参数 | 返回 | 数据量 | 备注 |
| --- | --- | --- | --- | --- | --- |
| 1 | `status()` | — | dict | 小 | 本地镜像 + 心跳，不必每次 RPC |
| 2 | `warmup(blocking)` | bool | None | — | 阻塞版可等 90 s（首次加载） |
| 3 | `unload(wait_for_inference)` | bool | None | — | 训练让位、lifespan 收尾 |
| 4 | `stop()` | — | bool | — | 取消推理（官方 `stop_flag`） |
| 5 | `configure(...)` | version/device/is_half/gpt/sovits | dict | 小 | 意图留本地，落到 worker 在下一次 `_ensure` |
| 6 | `resolve_defaults(version)` | str | WeightPair | 小 | **纯文件系统扫描，留主进程** |
| 7 | `synthesize(inputs)` | dict | `(sr:int, ndarray:int16)` | **大** | 主路径 |
| 8 | `stream(inputs)` | dict | `Iterator[(sr, ndarray)]` | **大（分块）** | 逐块转发 |
| 9 | `split_text(text, lang, method)` | str×3 | dict | 小 | **新增**，替代私有穿透 |

### 3.3 主进程保留 vs 迁入 worker

**留主进程（不 import 任何官方模块）**

- `sovits/catalog.py` —— 纯常量表，是「唯一允许硬编码官方常量」的地方，必须留
- `sovits/synth.py` —— 请求翻译 + 校验 + WAV 编码，纯计算，不碰官方模块
- `sovits/voices.py` —— 音色库，跨进程共享 `voices.json`（靠 mtime 刷新），必须留
- `inference.py` —— `SynthOutcome` / `_write_output` / `url_for` / `cleanup_outputs` 全是主进程职责
- `batch.py` —— 逐条调 `engine.synthesize_to_file`，留在主进程
- `training.py` —— 本来就是 `asyncio` 子进程编排，**只通过钩子触达管线**（见 §3.4）
- `weights.py` / `discovery.py` / `annotations.py` / `jobs.py` / `queue.py` / `engine.py`
- `sovits/bootstrap.py` 的**定位部分**（`locate` / `Installation` / `layout`）—— 见 §3.5

**迁入 worker**

- `bootstrap.official()` —— 加载官方 `TTS_Config` / `TTS`，**这是猴子补丁的唯一触发入口**
- `bootstrap.install()` 的 `os.chdir` —— 跟着 worker 走
- `sovits/pipeline.py` 的 `_build` / `_reconfigure` / `_ensure` —— 官方管线实例只存在于 worker
- 官方 `pipeline.run(inputs)` 的生成器消费 —— 留在 worker

> **关键设计**：`Pipeline` 的**公开方法签名一个都不改**。
> worker 化后主进程的那个 `Pipeline` 变成一个**代理**，内部把 6 / 7 / 8 / 9 换成 IPC。
> 这样 `api.py`、`routers/*`、`inference.py`、`batch.py` 的调用点几乎零改动。

### 3.4 `training.py` 的真实耦合面（比预想的低）

全量 grep `pipeline` / `bootstrap` / `set_training_active` 在 `training.py` 里只有：

```
164:  """用钩子而不是让 `TrainEngine` 直接依赖 `Pipeline` ..."""
199:  installation = bootstrap.current()
1133: installation = bootstrap.current()
1184: installation = bootstrap.current()
```

**没有任何一处 `self.pipeline.*`。** 训练与推理的显存互斥通过 `TrainHooks` 注入：

```python
@dataclass
class TrainHooks:
    on_start:  Optional[Callable[[], None]] = None   # → Context._begin_training
    on_finish: Optional[Callable[[], None]] = None   # → Context._end_training
```

`_begin_training()` 做的事（`api.py:128-129`）：

```python
self.pipeline.set_training_active(True)   # 纯本地标志
self.pipeline.unload()                    # → 要变成 RPC：叫 worker 释放模型
```

**结论：训练链路只需要 worker 提供 `unload`。** `set_training_active` 是纯内存标志，留在主进程。
`bootstrap.current()` 的三处调用只是拿 `installation.home` 拼路径 —— 留主进程（§3.5）。

### 3.5 `bootstrap` 的分裂点（本方案最微妙的一处）

`bootstrap` 被**其他引擎**引用了，而且引用的是「定位」而不是「加载」：

| 引用点 | 用到的东西 | 是否触发 `official()` |
| --- | --- | --- |
| `asr/bootstrap.py:69` | `sovits_bootstrap.current()` | ❌ 否 |
| `routers/uvr.py:35` | `bootstrap.current()` | ❌ 否 |
| `vc/bootstrap.py:102` | `sovits_bootstrap`（拿整合包路径） | ❌ 否 |
| `training.py:199/1133/1184` | `bootstrap.current()` | ❌ 否 |
| `api.py` / `inference.py` / `batch.py` | `bootstrap.require()` / `bootstrap.current()` | ❌ 否 |
| `routers/uvr.py` | （UVR5 自己 import 官方 `tools/uvr5/*`） | ❌ 否 |

`current()` 只是 `return _bootstrapped`（一个 dataclass），`require()` 只是判空后返回它。
**`official()` 是唯一触发官方 import 的入口，而它在 sovits 包外无人调用。**

还有一个必须注意的细节：`install()` 除了 `os.chdir` 还做了 `sys.path.insert(0, home/core)`。
这个 `sys.path` 注入是**别的东西需要的** —— 比如 UVR5 要能 `from tools.uvr5.vr import ...`。
所以主进程**仍然需要 `sys.path` 注入**，只是**不再需要 `os.chdir`**。

**分裂方案：**

```
bootstrap.py
├── locate() / Installation / OfficialModules 数据结构   → 留主进程（纯文件系统）
├── current() / require() / to_dict()                    → 留主进程
├── install()                                            → 拆成两半：
│     ├── sys.path 注入                                  → 留主进程（UVR5/ASR 脚本通道需要）
│     └── os.chdir(home)                                 → 只进 worker
├── device_defaults()                                    → 见下
└── official() / official_error() / is_loaded()          → 只进 worker
```

`device_defaults()` 是个**特例**，它读 `_official.root_config`（官方 `config.py` 的
`infer_device` / `is_half` / `GPU_INFOS`，含 16 系显卡强制 float32 的经验值）。

但它唯一的调用方是 `pipeline.py:164/170` 的 `device` / `is_half` **property 兜底分支**
（只在用户没显式设置 device/is_half 时走）。而 `pipeline.py` 整个迁进 worker ——
**所以 `device_defaults()` 跟着 `Pipeline` 一起进 worker，主进程不需要它。**

主进程的 `Pipeline` 代理里，`device` / `is_half` 从 worker 心跳上报的
`status()` 里取，或直接用 `_target_device` / `_target_half`。

### 3.6 音频数据形状（IPC 编码决策的输入）

官方 `TTS.run()` 是一个生成器，逐块 `yield`：

```python
yield output_sr, np.zeros(int(output_sr*fragment_interval), dtype=np.int16)
yield self.audio_postprocess(...)      # → (sr, np.int16 array)
yield 16000, np.zeros(int(16000), dtype=np.int16)   # 异常兜底
```

- **dtype 恒为 `np.int16`**（异常兜底路径也是 int16）
- 采样率：v3 是 24000，其余是 32000（`TTS.py:1618/1688`）；异常兜底是 16000
- 流式模式下每块约 `output_sr * fragment_interval`（默认 0.3 s）个采样 →
  32000 × 0.3 ≈ 9600 个 int16 ≈ **18.75 KB/块**
- 非流式 `_last_chunk` 取最后一块，可能是整段（长文本 + `split_bucket=True` 时会被切片）

所以**每块音频最大也就几百 KB 量级**，可以用 `bytes.tobytes()` 直接塞进 JSON 的 base64，
不必另开二进制通道。

> 已有先例：`api.py` 的 `/v1/tts/stream` 事件里就是
> `base64.b64encode(chunk.tobytes()).decode("ascii")`。worker 协议沿用同一套编码，
> 主进程收到后 `np.frombuffer(..., dtype=np.int16)` 还原即可。

---

## 4. IPC 契约草案

### 4.1 为什么选 stdin/stdout JSON-lines

沿用 `docs/NETEASE-INTEGRATION.md` §2.1 的模板（Confucius4-R2T2 的 worker）。
理由：

1. **无需额外依赖**，不用起 HTTP / gRPC / ZeroMQ
2. **跨平台**，Windows 上不必处理命名管道
3. **日志天然分离** —— worker 的 `stdout` 只走协议，`stderr` 走日志转发
4. **进程生命周期由父子关系管理**，父进程崩了 worker 跟着死（不必额外清理逻辑）
5. **可独立解释器** —— 沿用 `NETEASE_R2T2_PYTHON` 那套做法，用 `GPT_SOVITS_PYTHON` 指定整合包自带的 python

> ⚠️ **必须处理的一点**：官方代码会往 stdout 打印东西。
> `TTS.py` 里有 `print(f"first_package_delay: ...")`、`print("%.3f\t%.3f\t...")` 等。
> 这些会污染 JSON-lines 流。
> **对策**：worker 启动时立即把 `sys.stdout` 换成 `sys.stderr`（
> `sys.stdout = sys.stderr`），然后把**原始 fd 1 复制一份**存为协议通道。
> 这样官方所有 `print` 都落到 stderr（被父进程当日志收走），
> 协议只走那条私有 fd。

### 4.2 消息信封

每行一个 JSON 对象，末尾 `\n`，`ensure_ascii=True`（避免 Windows 编码问题）：

```json
{"v": 1, "id": "r-42", "kind": "request", "method": "synthesize", "params": {...}}
{"v": 1, "id": "r-42", "kind": "response", "ok": true, "result": {...}}
{"v": 1, "id": "r-42", "kind": "response", "ok": false, "error": {...}}
{"v": 1, "id": "r-42", "kind": "event", "event": "chunk", "data": {...}}
```

| 字段 | 说明 |
| --- | --- |
| `v` | 协议版本，当前 `1`。不匹配直接拒绝 |
| `id` | 请求 ID，主进程生成（`r-<自增>`）。流式事件复用同一个 id |
| `kind` | `request` / `response` / `event` / `notice` |
| `method` | 仅 `request` 有 |
| `result` / `error` | 仅 `response` 有，二选一 |

### 4.3 生命周期消息

**握手（双向，worker 启动后第一件事）**

```json
// worker → 主进程
{"kind": "notice", "notice": "ready", "data": {
  "pid": 12345,
  "protocol": 1,
  "python": "F:/.../python.exe",
  "home": "F:/schoolCompWorks/clone/ttstool/GPT-SoVITS-v2pro-20250604",
  "torch": "2.5.1+cu121",
  "cuda_available": true,
  "gpu": "NVIDIA GeForce RTX 4060 Laptop GPU",
  "mha_patched": true,          // ← 诊断用：确认补丁在这个进程里生效
  "cwd": "F:/.../GPT-SoVITS-v2pro-20250604"
}}

// 主进程 → worker
{"kind": "request", "id": "r-1", "method": "hello", "params": {
  "device": "cuda:0", "is_half": true, "version": "v2ProPlus",
  "gpt": "F:/.../s1v3.ckpt", "sovits": "F:/.../s2Gv2ProPlus.pth"
}}
```

**心跳（主进程主动，默认 10 s 一次；worker 未在 30 s 内响应则判定僵死）**

```json
{"kind": "request", "id": "r-2", "method": "ping", "params": {}}
{"kind": "response", "id": "r-2", "ok": true, "result": {"alive": true, "busy": false}}
```

**关停（主进程 → worker，等待 `shutdown` 回应或超时 5 s 后强杀）**

```json
{"kind": "request", "id": "r-3", "method": "shutdown", "params": {}}
```

### 4.4 方法表

| method | params | result | 阻塞上限 |
| --- | --- | --- | --- |
| `hello` | device/is_half/version/gpt/sovits | `{"applied": {...}}` | 5 s |
| `ping` | — | `{"alive": true, "busy": bool}` | 5 s |
| `status` | — | `PipelineState.to_dict()` + `target_*` | 5 s |
| `configure` | version/device/is_half/gpt/sovits | status dict | 5 s |
| `warmup` | `{"blocking": true}` | status dict | **180 s**（首载 30~90 s） |
| `unload` | `{"wait_for_inference": true}` | `{}` | **300 s**（`SYNC_LOCK_WAIT_S`） |
| `stop` | — | `{"stopped": bool}` | 5 s |
| `synthesize` | `{"inputs": {...}}` | `{"sample_rate": 32000, "audio": "<base64 int16>"}` | **300 s** |
| `stream` | `{"inputs": {...}}` | 多个 `event: chunk` + 终态 `response` | **按块无上限，首块 60 s** |
| `split_text` | `{"text", "text_lang", "method"}` | `{"pieces": [...]}` | 30 s |

> **超时上限的来源**：`sovits/pipeline.py` 的 `SYNC_LOCK_WAIT_S = 300.0` /
> `STREAM_LOCK_WAIT_S = 5.0`。IPC 层的超时必须**大于**这些锁等待上限，
> 否则会在 worker 还在正常排队时被父进程误判为超时。
> 故 `synthesize` 的 IPC 超时取 300 + 30 = 330 s，`unload` 取 330 s。
>
> 流式不能设总超时 —— 长文本流可以跑很久。改为**逐块软超时**：
> 首块 60 s 内必须到（否则说明模型加载或预处理卡死），
> 之后每块 30 s，只要还在出块就不断续期。

### 4.5 流式事件

```json
// 首个块，带元信息
{"v":1,"id":"r-7","kind":"event","event":"chunk","data":{
  "index": 0, "sample_rate": 32000, "audio": "<base64 int16>", "samples": 9600, "first": true
}}
// 后续块
{"v":1,"id":"r-7","kind":"event","event":"chunk","data":{
  "index": 1, "sample_rate": 32000, "audio": "<base64 int16>", "samples": 9600
}}
// 全部出完
{"v":1,"id":"r-7","kind":"response","ok":true,"result":{"chunks": 12, "sample_rate": 32000}}
```

主进程的代理把 `event: chunk` 逐个 `yield` 出去，
`api.py` 的 `events()` 生成器**一行都不用改** —— 它拿到的还是 `(rate, ndarray)`。

### 4.6 错误映射

错误体沿用 `SovitsError.to_dict()` 的形状，跨进程原样透传：

```json
{"ok": false, "error": {
  "code": "CUDA_OOM",
  "message": "显存不足，推理中断",
  "hint": "可尝试：降低批大小...",
  "retryable": true
}}
```

`_as_synthesis_error()` 的翻译逻辑（`pipeline.py:564-599`，覆盖
`REF_AUDIO_DURATION` / `REF_AUDIO_MISSING` / `CUDA_OOM` / `PROMPT_TEXT_REQUIRED` /
`REPETITION` / `SYNTHESIS_FAILED`）**留在 worker 侧**，因为判据是
官方异常的原始文本（`"3~10秒"`、`"out of memory"` 等），只有 worker 拿得到。

worker 侧序列化：

```python
def _dump_error(exc):
    if isinstance(exc, SovitsError):
        return exc.to_dict()
    return  {"code": "WORKER_ERROR", "message": "%s: %s" % (type(exc).__name__, exc),
             "retryable": False}
```

主进程反序列化时**按 `code` 重建对应的异常类**，这样 `api.py` 的
`_register_errors` 异常处理器看到的还是原来的类型，HTTP 状态码语义不变。

> ⚠️ 注意：官方 `TTS.run()` 内部 `except Exception` 会
> `traceback.print_exc()` 然后 **`yield` 一个空音频兜底**（`TTS.py:1508-1519`）。
> 也就是说官方会**吞掉**异常并伪装成正常产出。
> 现有代码靠 `_last_chunk` 检查「全零/空音频」来间接发现，
> worker 化后这个行为不变（因为生成器消费逻辑仍在 worker 内），
> 但**真实堆栈会出现在 worker 的 stderr**，需要转发回主进程日志。

### 4.7 取消语义

当前 `POST /v1/jobs/{job_id}/cancel` 做两件事：

```python
ctx.scheduler.cancel(job)   # 本地取消标志
ctx.pipeline.stop()          # 打断 torch 推理
```

worker 化后 `pipeline.stop()` 变成一条 RPC。**难点是它必须能在
`stream` / `synthesize` 正在进行时插进去** —— 而 JSON-lines 是单通道的。

三种做法：

| 做法 | 评价 |
| --- | --- |
| 在请求行里带 `interruptible: true`，worker 起一个读线程专门收 `stop` | ✅ **采用** |
| 另开一个端口/管道专门收控制消息 | 复杂，Windows 上还要处理额外 fd |
| 让 `stop` 排队，等当前请求结束 | ❌ 那就完全没有「中断」效果了 |

**采用方案**：worker 主线程跑请求循环；**另起一个 daemon 读线程**，
只负责识别 `{"kind":"request","method":"interrupt"}` 这一种消息，
收到就立刻调官方 `pipeline.stop()`（置 `stop_flag`），不排队。
其余消息交给主线程按顺序处理。

官方 `TTS.py:1499` 有 `if self.stop_flag: yield ...; return`，
所以 `stop_flag` 置位后生成器会在下一个检查点自行结束 —— 这是官方的原生取消机制。

### 4.8 崩溃恢复

| 场景 | 检测 | 处理 |
| --- | --- | --- |
| worker 进程退出 | 读线程 `EOF` | 标记 `dead`，`status()` 返回 `loaded=False` + `worker_error` |
| worker 僵死（不响应 ping） | 3 次心跳未响应（30 s） | 强杀 + 重启 |
| worker 启动失败 | `ready` notice 超时 180 s | 记录 `worker_error`（含 stderr 尾部），不阻塞服务启动 |
| 重启后状态 | — | **不自动恢复模型**。下一次 `synthesize` 触发的 `warmup` 会重新加载 |

**为什么不在崩溃后自动重新加载模型**：冷启动 30~90 s + 2~4 GB 显存。
自动重载会让「worker 反复崩溃」变成「服务器反复 OOM」。宁可让用户看到
「推理 worker 已重启，请重试」的明确提示。

**退避重启**：连续崩溃时指数退避（1 s → 2 s → 4 s → … 上限 60 s），
连续失败 5 次后停止自动重启，只保留手动 `/v1/pipeline/warmup` 的入口。

### 4.9 启动与解释器选择

复用 `server.py` 已有的自举逻辑：

- `server.py::maybe_reexec()` 会把整个服务进程换成整合包自带的解释器
  （`os.execve(bundled, ...)`，带 `REEXEC_FLAG`）
- worker **应当用与主进程相同的解释器**，否则 torch 可能不在 `sys.path` 里
- 默认：`sys.executable`；可用环境变量 `GPT_SOVITS_WORKER_PYTHON` 覆盖

```python
cmd = [os.environ.get("GPT_SOVITS_WORKER_PYTHON") or sys.executable,
       "-u", "-m", "app.sovits.worker", "--home", str(home)]
env = {**os.environ,
       "PYTHONIOENCODING": "utf-8",
       "PYTHONUNBUFFERED": "1",
       "GPT_SOVITS_HOME": str(home)}
```

`-u` 很关键 —— 关掉用户态缓冲，否则 JSON-lines 会被 python 攒在缓冲区里，
父进程等不到响应。

---

## 5. 实施计划

### 任务 2：worker 入口与常驻管理

新建 `trainer/app/sovits/worker/`：

```
worker/
├── __init__.py
├── __main__.py      # python -m app.sovits.worker 入口
├── protocol.py      # 消息信封编解码 + fd1 重定向
├── server.py        # 请求循环 + interrupt 读线程 + 官方管线持有者
└── runtime.py       # 主进程侧：拉起 / 心跳 / 重启 / 关停
```

`server.py` 内部持有一个**不含 IPC 的原版 `Pipeline`**（= 今天的 `pipeline.py`
原样搬过来），只多一个 `split_text()` 方法。

### 任务 3：主进程代理

`trainer/app/sovits/pipeline.py` 改造成代理（或新增 `pipeline_proxy.py` 后
让 `__init__.py` 转发），**公开签名与返回值完全不变**：

- `status()` / `version` / `device` / `is_half` / `last_elapsed` → 本地缓存 + 心跳更新
- `warmup` / `unload` / `stop` / `synthesize` / `stream` / `split_text` → 转发 IPC
- `configure` / `resolve_defaults` / `current_pair` / `set_training_active` → 本地
- 新增 `split_text()`，`inference.py:197` 的私有穿透改为调用它

### 任务 4：流式与取消的跨进程语义

- `stream()` 返回的生成器必须能在**客户端断开时**通知 worker 中断
  （`GeneratorExit` → 发 `interrupt`）
- 保持 `STREAM_LOCK_WAIT_S = 5.0` 的语义：worker 侧抢锁失败立刻回 `BusyError`，
  不能变成「IPC 超时」
- 验证 NDJSON 事件顺序与 `api.py` 现有 `events()` 的假设一致

### 任务 5：验证

一次性脚本（用整合包解释器跑）：

1. **隔离生效**：主进程 `F.multi_head_attention_forward.__module__` 是原生 torch，
   worker 进程里是 `patched_mha_with_cache`
2. **RVC 无需补丁即可工作**：临时停用 `torch_compat` 的挂载点，跑一次变声
3. **主进程 cwd 不变**：`build_context()` 后 `os.getcwd()` 仍是项目根
4. **GPT-SoVITS 全链路回归**：合成 / 流式 / 批量 / 权重热切换 / 训练让位
5. **崩溃恢复**：`taskkill` worker，确认检测到并能重启

### 任务 6：文档与记忆

- `docs/ARCHITECTURE.md`：单进程 → worker 架构
- `docs/VC-SVC-FEASIBILITY.md` §4：补上「import 期全局 monkey patch」这个新触发条件
- 新增本文件 `docs/ENGINE-ISOLATION.md`
- `HANDOFF.md` / `PROGRESS.md` / 当天记忆日志

---

## 6. 已知取舍

| 取舍 | 说明 |
| --- | --- |
| **不省显存** | worker 与主进程各自持有 CUDA context（约 300~600 MB）。8.6 GB 的卡上这是实打实的开销 |
| **音频多一趟编解码** | `ndarray` → base64 → JSON → base64 → `ndarray`。每块约 18.75 KB，代价可忽略；但整段音频（长文本）可能到几 MB |
| **官方 print 会污染协议** | 靠 fd1 重定向解决，属于「必须踩一次才会想到」的坑 |
| **官方吞异常** | `TTS.run()` 内部 `except Exception` + yield 兜底空音频，worker 化后不改善。真实堆栈要从 worker stderr 捞 |
| **流式首块延迟** | 多一跳 IPC。实测应在个位数毫秒量级，不影响「马上听到」这个体验目标 |
| **`torch_compat` 变冗余** | 隔离生效后 RVC 不再需要它。**建议保留** —— 它同时是对「未来某个引擎又打了补丁」的兜底 |
| **主进程仍需 `sys.path` 注入** | `install()` 的 `os.chdir` 拆分出去，但 `sys.path` 要留（UVR5/ASR 脚本通道需要） |

---

## 7. 实施与验证结果（已完成）

### 7.1 最终落地形态

任务 2 的计划里列的是 `runtime.py`，实施时拆成了 `client.py` + `__main__.py`
（职责更清楚：前者是主进程侧的管理者，后者是 worker 的启动入口）。
实际文件：

```
trainer/app/sovits/worker/
├── __init__.py      # 分层说明
├── protocol.py      # 消息信封编解码 + stdout 隔离 + 错误序列化
├── server.py        # worker 侧：Holder（官方管线）+ Worker（请求循环 + interrupt 读线程）
├── client.py        # 主进程侧：WorkerClient（拉起 / 心跳 / 退避重启 / 关停）+ StreamHandle
└── __main__.py      # 按文件路径启动的入口
```

### 7.2 与原计划的三处偏离（都是被现实逼出来的）

| 偏离 | 原因 |
| --- | --- |
| **`_as_synthesis_error` / `_last_chunk` 搬到 `synth.py`** | 这两个函数 worker 与主进程都要用。留在 `pipeline.py` 会让 worker 反向依赖代理模块，形成循环 import |
| **按文件路径启动，不用 `-m app.sovits.worker`** | 整合包解释器是 embedded distribution（`runtime/python39._pth`），**完全忽略 `PYTHONPATH`** 且不给 `-m` 提供 `sys.path[0]`，`-m` 会以「No module named 'app'」死在我们的代码之前 |
| **`install()` 增加 `chdir: bool = False` 参数** | `sys.path` 注入必须留在主进程（UVR5 / ASR 脚本通道要 `from tools.uvr5.vr import ...`），只有 `os.chdir` 需要搬走。默认 `False`，只有 `worker/server.py::main()` 传 `True` |

### 7.3 验证脚本与结果

五个脚本全部通过，共 **139 项断言**：

| 脚本 | 项数 | 解释器 | 覆盖 |
| --- | --- | --- | --- |
| `.tmp/worker_smoke.py` | 32/32 | 任意 | 协议编解码 / 错误往返 / stdout 隔离 / 生命周期 / 崩溃退避 |
| `.tmp/verify_isolation.py` | 12/12 | 整合包 | 隔离生效的**直接证据 + 反证** |
| `.tmp/verify_synthesis.py` | 30/30 | 整合包 | 全链路回归（同步/流式/切分/批量/热切换/让位/取消/关停） |
| `.tmp/verify_http.py` | 51/51 | 任意 | HTTP 端到端（契约未变） |
| `.tmp/verify_recovery.py` | 14/14 | 任意 | 崩溃检测 + 诚实上报 + 自愈 |

### 7.4 隔离证据（最强的一条）

`verify_isolation.py` 第 [6] 组，同一时刻对比两边：

```
主进程 MHA 实现：torch.nn.functional.multi_head_attention_forward  patched=False
主进程 MHA 的 __globals__ 里根本没有 _in_projection 这个概念（原生函数）
主进程 cwd 从头到尾没变：F:\schoolCompWorks\clone\ttstool

worker 侧：mha_patched=True，cwd=F:\schoolCompWorks\clone\ttstool\GPT-SoVITS-v2pro-20250604
```

worker 侧 `mha_patched=True` 是**关键的反证** —— 它排除了「补丁压根没生效，
所以主进程干净」这种假阳性解释。脏东西确实产生了，只是被关在另一个进程里。

### 7.5 实测性能

| 项目 | 数值 |
| --- | --- |
| worker 首载官方管线 | 约 24 s（冷缓存）/ 3~4 s（OS 缓存已热） |
| HTTP 预热（启动 + 拉 worker + 4 个模型） | 约 30 s |
| 单条同步合成 | 1~5 s（取决文本长度） |
| IPC 跳数开销 | 可忽略（每块 ~18.75 KB base64） |
| 崩溃后自愈（重启 + 重载全部模型） | 约 30~51 s |

### 7.6 验证过程中发现并修掉的三个真实缺陷

这三个都不是测试脚本的错，是产品代码的 bug。记录在此，因为它们对应的
失效模式很隐蔽，将来改动这块代码时容易踩回去。

**缺陷 1：`/health` 谎报「已加载」。**
`status()` 里原本先把 `payload = self.state.to_dict()` 取好，**再**去刷新
worker 存活状态 —— 于是 worker 刚猝死那一帧，`loaded` 还是 `True`。
前端据此显示绿色「已就绪」，用户一点合成却立刻 503。
修复分两步：(a) 把刷新挪到 `to_dict()` **之前**；(b) 新增
`PipelineState.mark_worker_lost()` 把「worker 死 → 模型没了」这条不变式
收口成一个方法，供 `status()` / `_raise_worker_gone()` / `unload()` 三处共用
（原来是三处各自手改字段，漏一处就退化）。

**缺陷 2：退避期内立刻拒绝，而不是等待。**
`ensure_started()` 一看还在退避窗口里就抛 `WorkerGone`。但「崩溃后马上重试」
是最正常不过的行为（前端按钮、重试逻辑都会这么做），用户会立刻收到 503。
退避的本意是防「反复拉起放大成 OOM」，不是「拒绝对外服务」。
修复：退避窗口内改为**阻塞等待**（上限 `_WAIT_BACKOFF_MAX_S = 10 s`），
等完就重启；只有退避期长到不合理才报错。

**缺陷 3（次要）：`taskkill` 输出编码。**
`subprocess.run(..., text=True)` 默认 utf-8 解 GBK 输出，在读线程里抛
`UnicodeDecodeError`。虽不影响 `returncode` 判定，但会刷一屏难看堆栈。
验证脚本里改为手动 `decode("mbcs")`。

### 7.7 遗留与后续

- **`torch_compat` 保留**：隔离生效后它不再被 RVC 路径需要，但作为「未来某个
  引擎又打补丁」的兜底仍有价值。**不要删**。
- **未纳入本次范围的**：RVC 与 DDSP-SVC 仍在主进程内（方案 B 只隔离 GPT-SoVITS）。
  若将来它们也出现 import 期副作用，可按本文件 §2 的方案 C 扩展成三引擎全隔离 ——
  届时 `worker/` 这套协议与客户端可以直接复用。
- **worker 首载 24 s 无法消除**：那是官方四个模型加载的物理耗时，不是 IPC 开销。
  `--warmup` 可以在服务启动时提前拉起来摊掉这段等待。


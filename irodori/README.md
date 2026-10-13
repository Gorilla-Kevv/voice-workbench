# Irodori-TTS 本地服务（日语特化）

日语 TTS 的**第四个 Python 运行时**：零样本克隆 + caption/emoji 风格控制 + Speaker Inversion
音色固化（把日语音色压成一个 49KB 的 `.speaker.safetensors`，注册进音色库当「角色」用）。

> 它**不替代主力**（只会日语）。GPT-SoVITS / 网易 / IndexTTS 三条链路一行都不动。
> 立项依据与全部实测数据见 `docs/IRODORI-TTS-EVALUATION.md`（阶段 28），
> 落地方案见 `docs/IRODORI-INTEGRATION-PLAN.md`。

- 端口：**9884**
- 上游：`github.com/Aratako/Irodori-TTS`（MIT + 伦理限制：禁止未经同意的模仿/深伪）
- 本服务**自建**，不用上游 `Irodori-TTS-Server`（理由见方案 §2：它不覆盖训练、绕不开
  Windows 音频解码、参数面不够、音色真相必须在我们自己的 `voicelib/`）

---

## 一、为什么这个服务必须独立存在

三条硬事实（都是阶段 28 在本机实测出来的，不是推测）：

1. **torch ≥ 2.9 的 `torchaudio.load` 完全委托给 torchcodec**，而 torchcodec 在 cu128 索引下
   **没有 Windows wheel** → 任何读音频的路径直接 `ImportError`。
   更糟的是装上了也会因 FFmpeg DLL 缺失**静默跳过每一个样本**（上游 issue #40）：
   阶段 28 实测 `prepare_manifest.py` 把 16/16 个样本丢弃、**退出码 0**、产出 0 字节 manifest。
   → 对策是 `app/windecode.py`（soundfile 接管 torchaudio 的读接口）。
2. **int4 量化权重只在 compute capability ≥ 8.0 上可用**（torchao tinygemm）。
   `/health` 会报 cc 与 `int4_supported`，换机失效时上层据此回落 int8/bf16。
3. **官方没有任何音色库**（核查过作者 22 个仓库 + 9 个 HF 模型库），
   所以「音色」这件事只能由我们的 `voicelib/` 承担。

## 二、建 venv（py3.12 + torch 2.10 cu128）

`torch` 必须走 cu128 专用索引；其余包走 PyPI。**分两步装**是刻意的 ——
`--extra-index-url` 会让 pip 在两处之间挑，torch 可能被解析成 PyPI 上的默认 CUDA 版本。

```bash
# 1) 建 venv（uv 会自动找 3.12）
uv venv --python 3.12 irodori/.venv

# 2) torch 三件套（cu128 索引，约 2.8 GB）
uv pip install --python irodori/.venv \
  "torch==2.10.0+cu128" "torchaudio==2.10.0+cu128" \
  --index-url https://download.pytorch.org/whl/cu128

# 3) 其余依赖（133 个包；走清华镜像，PyPI 直连实测要 20+ 分钟）
uv pip install --python irodori/.venv -r irodori/requirements.txt \
  --index-url https://pypi.tuna.tsinghua.edu.cn/simple
```

> ⚠️ **`uv` 的缓存在本机沙箱里写不进去**（默认 `D:\AI_Cache\uv`，报 `os error 5 拒绝访问`）。
> 如果遇到 `Failed to write to the client cache`：`export UV_CACHE_DIR=<工作区内路径>`
> 或直接加 `--no-cache`。注意 `--no-cache` 会让每次重试都重新下载，所以先用镜像。

**不要**直接 `pip install -e irodori/upstream/Irodori-TTS`：上游 `pyproject.toml` 把
`torchcodec` 列为基础依赖、把 `silentcipher` 列成 git 依赖，两个在 Windows 上都装不上/不该装。
`requirements.txt` 里逐条写了「不装什么、为什么」。

装完自检：

```bash
npm run irodori:check
```

## 三、下载权重与上游代码

```bash
npm run irodori:weights              # 推理档（约 1.2 GB）+ 上游代码
npm run irodori:weights -- --training   # 连训练基座（再 +2.9 GB）
npm run irodori:weights -- --check      # 只核对，不下载
npm run irodori:weights -- --force      # 已就位也重下（修截断）
```

清单是 **`irodori/weights.manifest.json`**（唯一事实源，`server.py --check` 与下载脚本共读）：

| 档 | 内容 | 体积 |
| --- | --- | --- |
| 推理 | `int4-weight-only/model.safetensors` + tokenizer + DACVAE codec | ≈1.2 GB |
| 训练 | bf16 基座 `model.safetensors` + tokenizer（+ 官方 emoji 释义表） | ≈2.9 GB |
| 代码 | `upstream/Irodori-TTS`、`upstream/dacvae`（codeload tarball） | ≈几十 MB |

**源站口径**（本机 2026-10-12 实测）：

| 目标 | 源 | 说明 |
| --- | --- | --- |
| 两个 Irodori 模型仓 | `modelscope.cn` | HF 直连不通；ModelScope 有完整镜像 |
| DACVAE `weights.pth` | `hf-mirror.com` | 只有 HF 有，走镜像 |
| 上游代码 | `codeload.github.com` | `github.com` / `raw.githubusercontent.com` 直连不通 |

**为什么必须逐文件校验字节数**：镜像限速（单连接 ~120KB/s），所以下载器用 **8 路 Range 并发**；
而中断的下载**不会自己报错**，要等 `torch.load` 时才炸成
`PytorchStreamReader failed … central directory`（阶段 28 踩过）。
所以每个文件写完都比对清单里的 `sizeBytes`，对不上直接删掉重下。

## 四、启动

```bash
npm run dev:irodori     # 或：irodori/.venv/Scripts/python.exe irodori/server.py
npm run irodori:check   # 只体检不启动
```

体检/健康接口的字段：`required_vram_mb`（准入基准的**唯一事实源在服务端**）、`loaded`、
`vram.free_mb`（取 nvidia-smi 口径）、`watermark: false`（我们刻意不装 SilentCipher）、
`weights.ready` / `weights.training_ready`、`windecode`（垫片到底装没装）。

环境变量：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `IRODORI_PORT` | `9884` | 监听端口 |
| `IRODORI_PYTHON` | — | 指向 venv 解释器（`scripts/irodori.mjs` 优先用它） |
| `IRODORI_DEVICE` | `auto` | `auto` / `cuda` / `cpu` |
| `IRODORI_ALLOW_CPU` | 关 | 显式允许 CPU 推理（RTF 是几十倍，等于不可用，默认拒绝） |
| `IRODORI_PRECISION` | `fp32` | int4 权重档的配套精度 |
| `IRODORI_STEPS` | `20` | 默认采样步数（40 是「最高质量」档，见方案 §12 拍板） |
| `IRODORI_TIMEOUT` | `180` | 单次合成超时（秒），超时由护栏降步重试一次 |
| `IRODORI_NO_WINDECODE` | — | 置 1 关掉 soundfile 垫片（排障用） |
| `IRODORI_MODELS` / `IRODORI_UPSTREAM` / `IRODORI_DACVAE` | 见 `app/config.py` | 覆盖各目录位置 |

## 五、目录与「上游代码零改动」原则

```text
irodori/
  server.py                 入口：--check 体检 + uvicorn 启动
  requirements.txt          依赖（含「不装什么、为什么」）
  weights.manifest.json     ★ 权重/代码清单（唯一事实源，进版本库）
  app/
    config.py               端口/路径/精度/步数，读环境变量
    hardware.py             torch/CUDA/显存/cc 探测（lazy import，绝不模块级 import torch）
    inventory.py            清单核对（只读、现扫、带字节数校验）
    windecode.py            ★ Windows 音频解码垫片（何时该删写在文件头）
    errors.py               结构化错误码
    api.py                  FastAPI 装配（30-1 只有 /health）
  upstream/                 Irodori-TTS 与 dacvae（gitignore）
  models/                   权重（gitignore）
  .venv/                    独立环境（gitignore）
```

`upstream/` 下的**官方代码零改动**（方案 §7）：所有适配都在 `app/` 里做。
唯一例外是 `windecode.py` 的运行时 monkeypatch —— 它 patch 的是本进程的 `torchaudio`，
符合 `docs/ENGINE-ISOLATION.md`「全局 monkeypatch 只准待在自己进程里」。

> ⚠️ `upstream/dacvae` 必须与 `upstream/Irodori-TTS` **同级**：
> 上游 `codec.py` 从 `parents[2]/dacvae` 回退加载，放错层级会变成命名空间遮蔽，
> 报 `cannot import name 'DACVAE'`。

## 六、实施进度

按 `docs/IRODORI-INTEGRATION-PLAN.md` §9 的 7 段推进，每段独立可验证：

| 段 | 内容 | 状态 |
| --- | --- | --- |
| 30-1 | 环境与骨架（本文件覆盖的内容） | 完成 |
| 30-2 | 推理链路 `/v1/catalog` `/v1/warmup\|unload\|synth` + 网关透传 + 显存记账 | 完成（真机合成已验证） |
| 30-3 | 长尾护栏（段间降步 + 墙钟看门狗 + `IRODORI_TIMEOUT`） | 完成 |
| 30-4 | 音色库多片段长参考（`ref_clips` / `engine_tags` / `speaker_embeds`） | 未开始 |
| 30-5 | 训练 S1+S2（数据→latent→manifest，含**非空硬断言**）+ JobStore | 未开始 |
| 30-6 | 训练 S3（自动 batch + SI 编排 + 产物注册 + `speaker_id` 闭环） | 未开始 |
| 30-7 | 前端完整化 + 设置页 + 预加载账本 + 整链路走查 | 未开始 |

### 长尾护栏（30-3）怎么工作

采样有约 1/40 的概率撞上「灾难性慢生成」（阶段 28 实测最坏 **89s 出 4.96s 音频**，
卡在 `sample_rf`）。两层护栏：

1. **段间外推降步（主手段）** —— 服务端本来就按 ≤25 字切句，段与段之间是唯一
   真正可中断的点。每跑完一段就外推整条耗时，超过 `0.9 × IRODORI_TIMEOUT` 就把
   **剩余段落**降到 `IRODORI_DOWNGRADE_STEPS`（默认 20）并换 seed
   （依据：同一条命令 40 步 89s → 20 步 2.16s）。响应的 `retried` / `steps_used` /
   `downgraded_at_segment` 如实反映降级。
2. **墙钟看门狗（兜底）** —— 整个合成跑在专用线程里，请求线程只等 `IRODORI_TIMEOUT`
   秒。超时返回 **504 `IRODORI_TIMEOUT`**（带 `retry_suggestion.num_steps`）。
   ⚠️ 超时只能「放弃」不能「中断」：`sample_rf` 的循环没有任何回调 hook，
   已跑起来的 CUDA 采样 Python 层杀不掉。所以工作线程会在**段间检查点**看到
   取消标志后立刻停手（收尾时间 = 当前那一段的剩余时间），期间合成权仍被它持有，
   新请求拿 409 且文案会说明「上一次合成仍在收尾」。

> 加载模型（20~30s）**不计入**采样预算 —— 它是启动成本，算进去会让任何
> 小于 30s 的预算在首次请求必然 504（本机实测踩到，已修）。
>
> 护栏参数都在 `/v1/catalog` 的 `guard` 字段里（真源在服务端），前端不要写死 20 / 180。

## 七、已知坑（开工前先读）

1. **`torchaudio.load` 在 Windows 必崩** → 必须装垫片；`IRODORI_NO_WINDECODE=1` 只用于排障对比。
2. **下载截断不报错**，要到加载模型时才炸 → 永远用下载脚本，别手抄 URL 用浏览器下。
3. **int4 需要 cc ≥ 8.0** → 换机后先看 `/health` 的 `int4_supported`。
4. **训练数据的 Windows 陷阱**：官方 `prepare_manifest.py` 会静默丢弃全部样本且退出码 0
   → 30-5 必须做 `written > 0` 硬断言（这是 30-5 的验收核心）。
5. **长文本不稳**：训练音频都 ≤30s，>30s 会退化/幻觉（issue #13）→ 切句在服务端做，≤25 字/段。
6. **emoji 对男声几乎无效**（issue #9），且表尾 emoji 训练样本极少 → UI 文案不许夸大。
7. **水印**：本服务未装 SilentCipher，`/health` 恒报 `watermark: false`；界面要如实标注。
8. **`sample_rf` 跑起来就杀不掉**：采样循环里没有任何回调 hook（`log_fn` 只在每个阶段
   结束时打一次），所以护栏只能「段间降步 + 放弃收尾」，不要试图用线程 kill 或
   asyncio 超时去中断它 —— 那只会把 CUDA 状态和上游的 `_infer_lock` 搞乱。
9. **模型加载与采样要分开计时**：加载 20~30s 是一次性启动成本。把它算进采样预算，
   任何小预算都会在首次请求假超时（30-3 实测踩过）。

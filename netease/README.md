# 网易模块本地服务（netease/）

网易有道 Confucius4 双模型的**第二个 Python 运行时**：与 `trainer/` 平级、独立 venv、独立端口
（默认 **9882**）、**默认不启动**（opt-in）。为什么必须独立运行时，见
`docs/NETEASE-INTEGRATION.md` §2 —— 一句话：上游要求 py≥3.10 + torch≥2.5 + CUDA≥12.6，
而 `trainer/` 的 py3.9 + torch2.0/cu118 动不了。

| 引擎 | 模型 | 用途 | 关键卖点 |
| --- | --- | --- | --- |
| `confucius_tts` | [Confucius4-TTS](https://github.com/netease-youdao/Confucius4-TTS)（1.3B，Apache-2.0） | 零样本克隆合成 | **免参考文本**、跨语种无口音、情感迁移、14 语种 |
| `r2t2` | [Confucius4-R2T2](https://github.com/netease-youdao/Confucius4-R2T2)（Qwen3-ASR 基座） | 流式 / 离线转写 | append-only 真流式，延迟 200~600 ms |

两个引擎**不同时持卡**（8 GB 显存跑不动两个），服务内部互斥，后者加载时默认抢占前者。

## 环境准备（一次性）

磁盘预算约 **20 GB**（TTS 侧权重 5.4 GB + 可选 R2T2 4.1 GB + torch 2.6 GB + 产物），
显卡要求 CUDA 驱动 ≥ 12.6（本机 572.61 → CUDA 12.8 ✓，RTX 4060 Laptop 8 GB）。

```bash
# 0) 建 venv（Python 3.10~3.12；上游按 3.10 开发，本机用 3.12）
cd netease
py -3.12 -m venv .venv
.venv/Scripts/activate            # Windows；bash 用 source .venv/bin/activate

# 1) 服务自身依赖
pip install -r requirements.txt

# 2) CUDA 版 torch：**必须走 PyTorch 的 wheel 源**（PyPI 上的 torch 是 CPU 版）
#    版本按上游 requirements.txt 钉死（torch==2.7.0 / torchaudio==2.7.0）
pip install torch==2.7.0 torchaudio==2.7.0 --index-url https://download.pytorch.org/whl/cu126

# 3) 上游模型包
git clone https://github.com/netease-youdao/Confucius4-TTS models-src/Confucius4-TTS
# ⚠️ 上游 requirements.txt 里有一行 torch==2.7.0，直接 pip install -r 会把上面装的
#    CUDA 版覆盖成 PyPI 的 CPU 版。先装 torch，再装其余依赖（--no-deps 之外更稳的做法是
#    过滤掉 torch/torchaudio 两行，见 scripts/download_netease_weights.py 顶部注释的做法）。
pip install -e models-src/Confucius4-TTS

# 4) 权重下载（一条命令，自动分流；国内环境常需要 --proxy）
npm run netease:weights                                   # TTS 侧（约 5.4 GB）
npm run netease:weights -- --proxy http://127.0.0.1:7890  # HuggingFace 走本机代理
npm run netease:weights -- --include-r2t2                 # 连 R2T2 一起下（Linux/WSL 才用得上）

# R2T2（可选，Linux / WSL2）：pip install -e models-src/Confucius4-R2T2（自带 vLLM 依赖）
# 依赖若与 TTS 冲突：给 R2T2 单独建 venv，再设置 NETEASE_R2T2_PYTHON 指向它。
```

### 实测数据（RTX 4060 Laptop 8 GB，2026-09）

| 项 | 实测 |
| --- | --- |
| 首次加载（warmup） | 约 60~70 s |
| 常驻显存 + 推理峰值 | 约 4.9 GB（fp16；准入检查要求空闲 ≥ 6 GB） |
| 合成速度 | 短句 RTF ≈ 2.0~2.5（2.6 s 音频 6.3 s；4.1 s 音频 8.0 s）。**首条会慢到几分钟** —— 首次调用有 CUDA allocator / 算子预热，之后进入稳态 |
| 语种 | zh / en 均出声正常（参考音频用上游自带的 `resources/test.wav`） |

⚠️ 8 GB 卡上**必须关掉其它占显存的程序**再跑：实测时后台还挂着别的 GPU 程序（约 2.7 GB），
留给 TTS 的只有 5 GB 出头，稍有波动就会触发准入检查或显著变慢。

### 权重落在哪（重要）

上游取权重的方式不一样，所以落点也不一样：

| 权重 | 落点 | 为什么 |
| --- | --- | --- |
| `t2s_model.safetensors` / `s2a_model.pt` | **HF 缓存**（`$HF_HOME/hub`） | `confuciustts/cli/inference.py` 里硬编码 `hf_hub_download(repo_id, filename)`，本地目录再全也用不上 |
| `campplus_cn_common.bin` | HF 缓存 | 同上（`funasr/campplus`） |
| `facebook/w2v-bert-2.0` | `netease/models/w2v-bert-2.0` | `from_pretrained` 支持本地目录，可绕开缓存与联网 |
| `nvidia/bigvgan_v2_22khz_80band_256x` | `netease/models/bigvgan_v2_22khz_80band_256x` | 同上（只取 `config.json` + `bigvgan_generator.pt`，两个判别器各 1.4 GB 不需要） |

下载脚本会把前两项按缓存布局铺好（`blobs/` + `snapshots/` + `refs/`），
并用 HF 返回的真实 etag 命名，之后无论在线离线都能命中缓存。
本机 `HF_HOME=D:\AI_Cache`。

⚠️ **镜像坑**：上游把 `huggingface_hub` 钉在 0.36.2，该版本对 `hf-mirror` 的 HEAD 请求
拿到 **308 Permanent Redirect**（`requests.head` 默认不跟随重定向），表现为
`LocalEntryNotFoundError`。本机实测：直连 huggingface.co 约 0.2 MB/s 且会撞 Xet CDN 的
SSL 错误，ModelScope 约 6 MB/s，本机代理约 2 MB/s —— 下载脚本按这个顺序自动选路。

目录约定（可用环境变量改）：

```
netease/
├── models/Confucius4-TTS/    # NETEASE_TTS_HOME（含 config/inference_config.yaml + checkpoints/）
├── models/Confucius4-R2T2/   # R2T2 本地权重目录
└── .data/                    # 上传与产物（uploads/、tts 输出）
```

## 启动与体检

```bash
npm run netease:check   # 体检：逐项报告 python/torch/CUDA/依赖/权重缺什么（退出码 0 = 可启动）
npm run dev:netease     # 启动服务（不随 npm run dev 自动启动）

# 只跑 TTS、不装 R2T2（Windows 常见，见「已知限制」）：
npm run netease:check -- --allow-missing-asr

# 或直接：
netease/.venv/Scripts/python netease/server.py --check
netease/.venv/Scripts/python netease/server.py --port 9882
```

服务起来后，前端「网易模块」两个页面的状态卡会自动从「未启动」变绿；
权重没下载时显示「待补齐」，并提示本 README 的下载命令。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `NETEASE_PORT` | `9882` | 监听端口 |
| `NETEASE_HOST` | `127.0.0.1` | 监听地址 |
| `NETEASE_DEVICE` | `auto` | 推理设备；`cpu` 仅在 `NETEASE_ALLOW_CPU=1` 时生效（否则明确拒绝） |
| `NETEASE_TTS_PRECISION` | `fp16` | 推理精度。上游加载时不指定 dtype，全 fp32 约 8 GB+，8 GB 卡必 OOM；转 fp16 后常驻约 4 GB。要保真度可设 `fp32`（需更大显存） |
| `NETEASE_TTS_HOME` | `netease/models-src/Confucius4-TTS` | TTS 仓库目录（含 `config/inference_config.yaml` 与分词器）。**权重本体不在这里**，见上文「权重落在哪」 |
| `NETEASE_TTS_CONFIG` | `<tts_home>/config/inference_config.yaml` | TTS 推理配置。服务会把它复制成一份绝对路径副本（`.data/tts_inference_config.yaml`）再交给上游，避免 CWD 依赖 |
| `NETEASE_R2T2_MODEL` | 本地目录 → HF repo id | R2T2 模型路径或 repo id |
| `NETEASE_R2T2_PYTHON` | 服务自身解释器 | R2T2 worker 解释器（依赖冲突分 venv 时用） |
| `NETEASE_R2T2_GPU_UTIL` | `0.35` | vLLM gpu_memory_utilization |
| `NETEASE_R2T2_BACKEND` | `vllm` | R2T2 后端（本期仅 vllm） |

## API 速览

统一契约：成功 `{ok:true,...}`；失败 `{ok:false, error:{code,message,retryable,hint}}`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 体检（永远 200；权重缺失体现在 engines 里） |
| GET | `/v1/netease/catalog` | 能力清单（语种/参数/安装状态） |
| POST | `/v1/netease/engines/acquire` \| `/release` | 显存引擎互斥 |
| GET | `/v1/confucius/pipeline` · POST `warmup`/`unload` | TTS 引擎管理 |
| POST | `/v1/confucius/tts` | multipart：`text`,`lang`,`file`(或`ref_path`),`preempt` → `audio_base64` |
| GET | `/v1/r2t2/pipeline` · POST `warmup`/`unload` | ASR 引擎管理 |
| POST | `/v1/r2t2/transcribe` | multipart：`file`(或`ref_path`),`language`,`stream`,`chunk_ms` → JSON 或 NDJSON 流 |

## 已知限制（首版）

- **R2T2（ASR）在 Windows 上跑不起来**：上游依赖 vLLM，而 PyPI 上 `vllm` 只有 Linux
  wheel（0.30.0 实测 0 个 Windows 产物），r2t2 自带的 llama.cpp 后端也只有
  `*.so` + `cpython-312-x86_64-linux-gnu` 产物。Windows 上想用 R2T2 只能走
  **WSL2 或 Docker**（官方推荐镜像 `qwenllm/qwen3-asr`）。TTS 不受影响；
  体检时加 `--allow-missing-asr` 即可只校验 TTS 链路。
- TTS 流式合成需要上游 vLLM 后端，未接入（见方案文档 §6 阶段 7）；
- 麦克风实时流式转写未接入（需要浏览器→网关→上游全链路 WebSocket）；
- R2T2 worker 的流式增量取值**已按官方 README 校准**（增量文本在 `streaming_transcribe`
  的返回值里，定稿读 `finish_streaming_transcribe` 之后的 `state.text`），
  但因为没有 vLLM 环境，这条链路**尚未在真机上跑过**（`netease/app/r2t2_worker.py`）；
- 跨运行时显存仲裁（与 GPT-SoVITS 服务协调让位）未做，加载前只检查本机空闲显存。

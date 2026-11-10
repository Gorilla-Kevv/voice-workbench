# CosyVoice3 本地运行时（`cosyvoice/`，:9886）

第六个 Python 运行时。模型：**Fun-CosyVoice3-0.5B-2512**（Apache-2.0，24kHz，9 语言 + 18 中文方言）。
> **当前状态（2026-11-10）**：权重**已下载并逐文件校验**（12 项 / 5.05GB，ModelScope；礼貌模式
> `--parallel 1 --limit-kbps 2500`，实测 2.43MB/s、约 35 分钟）；**三模式真机冒烟通过**
> （零样本 / instruct2 四川话 / 跨语种日语，24kHz）。真机踩到两个 bug：venv 缺**导入期依赖**
> （见 `requirements.txt` 注释）与 CosyVoice3 的 `<|endofprompt|>` **硬断言**（见 `app/synth.py`）。
> **实测 RTF 4.5~6.2**（8GB 卡），短句可用、长文不实用。

定位是**方言/多语种 + 自然语言 instruct 的补充**，不替代网易 / IndexTTS / GPT-SoVITS / Irodori：

| 能力 | 本机其它引擎 | CosyVoice3 |
|---|---|---|
| 中文方言 | 无 | 18+（粤/闽南/四川/东北/上海…） |
| 控制面 | IndexTTS 8 维情感向量（精确） | 自然语言 instruct（语言/方言/情感/语速/音量） |
| 语种 | 网易 14 / IndexTTS 5 / GSV 5 | 9 |
| 参考转写 | 网易免转写 | 零样本与 instruct 需 `prompt_text`（跨语种不需要） |
| 采样率 | 22.05k / 32k / 48k | 24k |
| 显存（估） | 4.6~5.3GB 常驻 | 2.5~3.5GB（准入 4096MB） |

## 环境

要求 **Python 3.10** + `torch 2.3.1+cu121`。与现有五个运行时都不兼容，必须独立 venv。

```bash
# 1) 建 venv（uv 会自动下载 py3.10）
export UV_CACHE_DIR=F:/schoolCompWorks/clone/ttstool/.tmp/uv-cache
"C:/Users/kevin/.local/bin/uv.exe" venv --python 3.10 cosyvoice/.venv

# 2) 装依赖（torch 先走 cu121 索引，再装其余）
"C:/Users/kevin/.local/bin/uv.exe" pip install --python cosyvoice/.venv/Scripts/python.exe \
  torch==2.3.1 torchaudio==2.3.1 --index-url https://download.pytorch.org/whl/cu121
"C:/Users/kevin/.local/bin/uv.exe" pip install --python cosyvoice/.venv/Scripts/python.exe \
  -r cosyvoice/requirements.txt

# 3) 上游源码（只读，不改一行）
git clone --depth 1 --recurse-submodules --shallow-submodules \
  https://github.com/FunAudioLLM/CosyVoice.git cosyvoice/upstream/CosyVoice

# 4) 权重（约 5.4GB，ModelScope）
npm run cosyvoice:weights
```

## 命令

```bash
npm run dev:cosyvoice      # 启动（127.0.0.1:9886）
npm run cosyvoice:check    # 环境 + 权重 + 导入冒烟体检（--skip-import 跳过导入，快 10s）
npm run cosyvoice:weights  # 下载权重（--force / --only <id> / --dry-run / --urls-only）
# 礼貌模式（不占满带宽）：node scripts/cosyvoice-weights.mjs --parallel 1 --limit-kbps 2500
# 断点续传：残件留 <file>.part，重跑同一条命令即可（HTTP Range，实测可用）
```

## 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 永远 200；`weights.ready` / `loaded` / `vram` / `configuration.required_vram_mb` |
| GET | `/v1/catalog` | 语言、方言、模式、指令示例、语速范围、参考音限制 |
| POST | `/v1/warmup` | 加载模型（`?blocking=false` 后台加载） |
| POST | `/v1/unload` | 释放显存，回报归还量 |
| POST | `/v1/synth` | 合成一条，返回 base64 WAV + 落盘路径 + RTF |

### `/v1/synth` 请求

```json
{
  "text": "今天用四川话摆两句。",
  "mode": "zero_shot",
  "ref_voice": "音色库 id",
  "prompt_text": "参考音频的逐字转写",
  "speed": 1.0
}
```

- `mode`：
  - `zero_shot`：参考音 + `prompt_text`；音色最接近参考。
  - `cross_lingual`：参考音即可，不需要转写；可带 `language`（zh/en/ja/ko/de/es/fr/it/ru），服务端补 `<|xx|>` 前缀。
  - `instruct2`：参考音 + `prompt_text` + `instruct_text`，例如 `用四川话说这句话<|endofprompt|>`。
- 参考二选一：`ref_voice`（读共享 `voicelib/voices.json`）或 `ref_path`（本机 wav 路径）。
- 参考音 1~30 秒，官方建议 3~10 秒。

## Windows 已知坑与处理

1. **加载期显存 OOM**：上游 `CosyVoice3Model.load()` 用 `torch.load(map_location='cuda')`，WDDM 下大块分配易碎片化（上游 issue #1936，8GB/16GB 都复现）。`app/engine.py` 在构造模型期间把 `map_location` 临时改为 `cpu`，再 `load_state_dict` 逐张量拷到显存。
2. **ONNX provider 回落**：上游在 CUDA 可用时请求 `CUDAExecutionProvider`，而 Windows 装的是 CPU 版 onnxruntime；`app/engine.py` 在构造前过滤不可用 provider，自动回落 CPU。
3. **vLLM / TensorRT / DeepSpeed**：只在 Linux 可用，本运行时全部不用，走 PyTorch 路径。
4. **ttsfrd**：无 Windows wheel，官方默认回退 `wetext`（纯 Python），已装。
5. **24kHz + 11kHz 嘶声**：与 32/48kHz 产物混剪需重采样；11kHz 以上嘶声可在后处理低通（B站实测经验）。
6. **训练**：官方训练链依赖 DeepSpeed/sox/ttsfrd + 多卡，0.5B 全量微调显存账 >13GB，本机不接训练。

## 显存与速度

- fp16 权重约 1.7GB；加载 + KV/激活/ONNX 缓冲估计 2.5~3.5GB。准入先取 4096MB 保守值，**真机冒烟后回填**。
- 速度：B站 Mac mini CPU RTF ~2.5、MLX GPU 快 3.5 倍；Windows 4060 Laptop 需实测，预计 RTF 0.6~2.0。
- 8GB 卡必须独占：与网易 / IndexTTS / Irodori / GSV 互斥（网关仲裁器已接入 `cosyvoice-tts`）。

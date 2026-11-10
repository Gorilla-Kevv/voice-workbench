# CosyVoice3 接入（阶段 48）

> 目标：把 **Fun-CosyVoice3-0.5B-2512** 作为第六个本地 TTS 运行时接入，补上现有栈缺的
> **中文方言**与**自然语言 instruct** 能力。**只接推理，不接训练**。
>
> **当前状态（2026-11-05）**：代码、网关、前端全部接入并通过 typecheck/build；**权重未下载**
> （下载占用带宽被用户叫停，约 3.6GB 分片已移入回收站），因此真机冒烟未执行。服务可启动，
> `/health.weights.ready=false`，界面显示「待补齐」。恢复下载前必须征得用户同意。

## 1. 定位（为什么不替代现有引擎）

| 维度 | 现有最强 | CosyVoice3 | 结论 |
|---|---|---|---|
| 中文方言 | 无 | 18+（粤/闽南/四川/东北/上海…） | **独有** |
| 参考转写 | 网易免转写 | 零样本/instruct 需 `prompt_text`；跨语种不需要 | 网易更省事 |
| 情感精度 | IndexTTS 8 维向量 / 拼音 / 语速 | 自然语言 instruct（宽而不精） | IndexTTS 更可控 |
| 语种 | 网易 14 | 9 | 网易更宽 |
| 采样率 | GSV v5 / Irodori 48k | 24k | 低于高保真档 |
| 速度 | GSV 0.46 / Irodori 0.121 | 待实测（预计 0.6~2.0） | 不是速度卖点 |
| 显存 | 4.6~5.3GB | 2.5~3.5GB（准入 4096） | 更轻 |
| 流式 | 无 | 官方 150ms（Windows PyTorch 路径未验） | 未来可做 |

结论：**方言 / 多语种指令的补充**，不替换主服务。

## 2. 运行时

- 目录：`cosyvoice/`
- venv：`cosyvoice/.venv`（**py3.10 + torch 2.3.1+cu121**，与现有五个运行时全部隔离）
- 上游：`cosyvoice/upstream/CosyVoice`（只读 clone，含 `third_party/Matcha-TTS`）
- 权重：`cosyvoice/models/Fun-CosyVoice3-0.5B/`（约 5.4GB；`llm.rl.pt` / fp32 ONNX / batch tokenizer 不下）
- 端口：**9886**
- 入口：`scripts/cosyvoice.mjs`（`npm run dev:cosyvoice`）
- 体检：`npm run cosyvoice:check`
- 权重下载：`npm run cosyvoice:weights`（ModelScope；单连接实测 3~5MB/s）。
  **礼貌模式**（不占满家用带宽）：`node scripts/cosyvoice-weights.mjs --parallel 1 --limit-kbps 2500`
  —— 单连接 + 每连接限速 2.5MB/s；`--urls-only` 只打印 12 个直链（便于手动下载或交给下载器），
  `--only <id>` 只下某一项。**断点续传**：残件落 `<file>.part`，重跑同一命令会按 HTTP Range 续传
  （ModelScope 的 resolve 会 302 到 CDN，跟随重定向后返回 206，2026-11-09 实测可用）。

### 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 永远 200；权重/加载/显存/配置 |
| GET | `/v1/catalog` | 语言、方言、模式、指令示例、限制 |
| POST | `/v1/warmup` | 加载模型（`?blocking=false` 后台） |
| POST | `/v1/unload` | 释放显存 |
| POST | `/v1/synth` | 三模式合成，返回 base64 WAV + 落盘路径 + RTF |

## 3. Windows 两个必要补丁（`cosyvoice/app/engine.py`）

1. **`torch.load` 强制 CPU**：上游 `CosyVoice3Model.load()` 用 `map_location='cuda'` 直接搬权重，
   WDDM 下大块分配易碎片化 OOM（上游 issue #1936，8GB/16GB 都复现）。构造模型期间临时改为
   `map_location='cpu'`（并默认 `weights_only=True`），再 `load_state_dict` 逐张量上卡。
2. **ONNX provider 回落**：上游在 CUDA 可用时请求 `CUDAExecutionProvider`，Windows 装的是 CPU 版
   onnxruntime；构造前过滤不可用 provider，自动回落 `CPUExecutionProvider`。

其它平台差异：vLLM / TensorRT / DeepSpeed 仅 Linux，不用；`ttsfrd` 无 Windows wheel，官方回退
`wetext`（已装）；`pyworld` 有 cp310 Windows wheel。

## 4. 网关与前端接线

网关：
- `server/src/config/index.ts`：`COSYVOICE_URL`（默认 `:9886`）、超时 0
- `server/src/services/serviceCatalog.ts`：`RuntimeServiceId` + 卸载端点
- `server/src/services/runtime.ts`：`cosyvoiceSupervisor`（默认停用、按需启动）
- `server/src/services/preload.ts`：`cosyvoice-tts` 账本（4096MB）
- `server/src/services/arbiter.ts` + `routes/resources.ts`：`cosyvoice-tts` 焦点
- `server/src/services/capabilityCatalog.ts`：`cosyvoice3-tts` 能力
- `server/src/routes/cosyvoice.ts` + `index.ts`：透明代理 `/api/cosyvoice/*` 与 `/api/cosyvoice/service`
- `server/src/routes/index.ts`：`/api/health` 汇总 `cosyvoice`
- `server/src/routes/preload.ts`：预加载选项补全（顺带修正原先只允许 netease/sovits 的旧列表）

前端：
- `app/src/types/cosyvoice.ts` + `types/index.ts`
- `app/src/lib/cosyvoice.ts`
- `app/src/pages/CosyvoiceTtsPage.tsx`（三模式 + 方言快捷指令 + 音色库/路径参考）
- `App.tsx` / `AppShell.tsx`：路由、导航组「CosyVoice3 · 方言/多语种」、侧栏状态卡、探活
- `SettingsPage.tsx`：服务开关 + 体检/权重命令提示
- `lib/localService.ts` / `lib/preload.ts`：服务 id 与预加载模型

## 5. 已知限制

- **训练不现实**：0.5B 全量微调 fp32 权重 3.4GB + 梯度 3.4GB + AdamW 两阶矩 6.8GB > 13GB，
  还没算激活；官方训练链依赖 Linux DeepSpeed/sox/ttsfrd、三模块分开训（llm/flow/hifigan）。
  LoRA 理论上可压进 8GB，但官方未提供，且音色克隆质量依赖 LLM+flow 联合训练，不做。
- **无 vLLM/TensorRT**：Windows 只有 PyTorch 路径；流式 150ms 是官方口径，本机未验。
- **24kHz + 11kHz 嘶声**：与 48kHz 产物混剪需重采样；必要时后处理低通。
- **零样本需 `prompt_text`**：音色库已存转写，页面自动带入；裸音频需先跑 ASR。
- **并发**：单卡单路，第二条请求 409，不排队。

## 6. 验证清单

- [x] `npm run typecheck`（app + server）
- [x] `npm run build`（app + server）
- [x] `python -m py_compile cosyvoice/server.py cosyvoice/app/*.py`
- [x] `npm run cosyvoice:check`：py3.10 / torch / CUDA / 上游代码 / 权重清单
- [ ] 真机零样本冒烟（显存峰值 + RTF + 24kHz 频响）：**未执行**——权重未下载；用户 2026-11-05 叫停下载并清理分片

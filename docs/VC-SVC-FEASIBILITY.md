# 可行性预检：语音变声（RVC）与歌声转换（DDSP-SVC）

本文件是 `feature/vc-svc` 分支**阶段 0** 的产物：在写任何业务代码之前，先用实测数据回答
「这两个上游能不能在当前环境里直接用」。结论先行：

> **可行。** Python 3.9 兼容（最大风险点已解除）、两个上游的关键推理模块全部可导入、
> 预训练权重地址全部可达。需要新增的依赖只有 `torchcrepe` 与 `torchfcpe`（已装），
> UVR5 权重已在整合包里就位，无需额外下载。

复现方式：

```bash
python scripts/preflight_vendors.py     # 静态预检：语法 / 顶层模块名 / 依赖
python scripts/smoke_vendors.py         # 导入冒烟：关键模块能否真 import
```

两个脚本都要用 **整合包自带的解释器** 跑（`GPT-SoVITS-v2pro-20250604/runtime/python.exe`），
否则 `pip` 盘点与 import 结果都不是真实运行环境的结果。

---

## 1. 环境事实

| 项 | 实测值 | 来源 |
| --- | --- | --- |
| 解释器 | Python 3.9.13（整合包 `runtime/python.exe`） | `python -V` |
| torch | 2.0.0+cu118，CUDA 11.8 可用 | `torch.__version__` |
| 显卡 | NVIDIA GeForce RTX 4060 Laptop，**8.6 GB** | `torch.cuda.get_device_properties` |
| 关键已有依赖 | fairseq 0.12.2、librosa 0.9.2、pyworld 0.3.2、praat-parselmouth 0.4.2、numba 0.56.4、numpy 1.23.4、scipy 1.9.3、soundfile 0.12.1、onnxruntime-gpu 1.19.2、einops、rotary-embedding-torch、peft 0.14.0、accelerate 1.4.0、pytorch-lightning 2.1.3 | `pip list` |
| **faiss / scikit-learn** | **已安装**（RVC 的检索索引直接可用） | `importlib.util.find_spec` |

## 2. 上游选型：为什么 RVC 不用 main 分支

| 上游 | 采用 | 被否决的方案 | 原因 |
| --- | --- | --- | --- |
| RVC | `origin/20240604` @ `d60cd3d` | `main` @ `81eed5e` | main 面向 **Python 3.12**，要求 torch 2.7.1+cu118、numpy≥1.26.4、librosa≥0.10.2、scipy≥1.13.1、soundfile≥0.13 —— 与整合包环境（3.9 / torch 2.0 / numpy 1.23 / librosa 0.9.2）全面冲突，强行升级会直接破坏现有 GPT-SoVITS 链路 |
| DDSP-SVC | `origin/6.3` @ `d6dd52f` | 各分支差异不大 | 6.3 是最新稳定分支；`requirements.txt` 声明 `numpy==1.26.4`，但代码里没有 numpy 1.26 的专属 API，实测在 numpy 1.23.4 下全部模块可导入（**决定：不升级 numpy**，避免动到 GPT-SoVITS 的地基） |

RVC `20240604` 的 README 明确写「Python 版本大于 3.8」「建议 3.7-3.10」，
与本环境完全吻合；它的 `requirements.txt` 声明的 `numpy==1.23.5 / librosa==0.9.1 /
fairseq==0.12.2 / pyworld==0.3.2 / numba==0.56.4` 与已装版本一一对应。

## 3. 兼容性实测结果

| 检查项 | RVC (20240604) | DDSP-SVC (6.3) |
| --- | --- | --- |
| Python 3.9 语法编译 | 87/87 通过 | 38/38 通过 |
| 关键模块导入冒烟 | **6/6** | **6/6** |
| 缺失的第三方依赖 | 仅可选项（IPEX、FreeSimpleGUI、onnxsim、cv2） | 仅 GUI 项（FreeSimpleGUI） |

导入冒烟覆盖的模块（都是直连层要依赖的入口）：

- RVC：`infer.lib.audio`、`infer.lib.rmvpe`、`infer.lib.slicer2`、
  `infer.lib.infer_pack.models`、`infer.modules.vc.modules`、`infer.modules.vc.pipeline`
- DDSP-SVC：`ddsp.core`、`ddsp.vocoder`、`ddsp.unit2control`、`encoder`、
  `nsf_hifigan`、`slicer`

**新增安装的依赖**：`torchcrepe==0.0.24`、`torchfcpe==0.0.4`。
两者是硬需求——RVC 的 `infer/modules/vc/pipeline.py` 与 DDSP-SVC 的 `ddsp/vocoder.py`
都在**模块顶层** `import torchcrepe`，缺了连 import 都过不去。安装它们不会牵动 numpy / torch。

## 4. 顶层模块名冲突（决定直连层要不要做进程隔离）

三个上游各自占用的顶层模块名（实测）：

| 来源 | 顶层模块名 |
| --- | --- |
| GPT-SoVITS 整合包 | `GPT_SoVITS`、`tools`、`config` |
| RVC | `infer`、`configs`、`i18n`、`tools`（仅实时/批量 CLI 用）、`assets` |
| DDSP-SVC | `ddsp`、`reflow`、`nsf_hifigan`、`encoder`、`optimizer`、`logger`、`slicer`、`exp` |

结论：**核心推理路径上没有撞车**。

- RVC 推理只用 `infer.*` 与 `configs.*`，`tools.*` 只在实时变声 / 批量 CLI 里出现，本轮不做实时，不会碰；
- DDSP-SVC 的 `logger` 与标准库 `logging` 无关，也不与另两者冲突；
- 唯一的名义冲突是 `tools`（GPT-SoVITS vs RVC），且不在本轮使用路径上。

因此**不需要**为每个引擎开独立子进程 worker（那是更重的方案）。
采用更轻的做法：直连层用 `temporary_context()` 在导入/加载权重期间临时接管 `sys.path` 与 cwd，
引擎切换时把本次新进入 `sys.modules` 的顶层模块名摘掉，配合显存互斥即可。
（若后续引入 RVC 实时链路用到 `tools`，再退化为独立 worker 进程。）

## 5. 权重来源与可达性

全部实测 HTTP 200（HEAD 请求）：

| 权重 | 用途 | 来源 |
| --- | --- | --- |
| `hubert_base.pt` / `rmvpe.pt` | RVC 内容特征 / F0 | `huggingface.co/lj1995/VoiceConversionWebUI` |
| `f0G40k.pth` / `f0D40k.pth` 等 | RVC 训练底模 | 同上（`assets/pretrained_v2/`） |
| `pytorch_model.bin`（ContentVec） | DDSP-SVC 内容特征 | `huggingface.co/lengyue233/content-vec-best` |
| `hubert-soft` | DDSP-SVC 备用编码器 | GitHub `bshall/hubert` release |
| `pc_nsf_hifigan_44.1k_hop512_128bin` | DDSP-SVC 声码器 | GitHub `openvpi/vocoders` release |
| `rmvpe.zip` | DDSP-SVC F0 | GitHub `yxlllc/RMVPE` release |
| `hf-mirror.com` | 备用镜像 | 已验证可达，作为下载失败时的兜底 |

**UVR5 不需要下载**：整合包内 `GPT-SoVITS-v2pro-20250604/tools/uvr5/uvr5_weights/` 已有
`HP2_all_vocals.pth`、`HP5_only_main_vocal.pth`、`VR-DeEchoAggressive.pth`、
`VR-DeEchoNormal.pth`、`VR-DeReverb.pth`、`model_bs_roformer_ep_317_sdr_12.9755.ckpt`，
脚本侧 `mdxnet.py` / `vr.py` / `bsroformer.py` 与依赖目录 `lib/`、`bs_roformer/` 齐全。
（去混响权重在整合包里的实际文件名是 `VR-DeEchoDeReverb.pth`，官方 notes 里也写作
「去延迟 + 去混响」，档位配置按这个名字对齐。BS-RoFormer 缺同名 `.yaml` 也能用 ——
官方 `Roformer_Loader` 会回落到内置默认配置，只是分离质量略低于带配置的版本。）
（RVC 自己也带了一份 UVR5，在 `infer/lib/uvr5_pack/`，作为后备方案保留，本轮不使用。）

## 6. 由此确定的设计约束

1. **引擎互斥是硬约束**：8.6GB 显存放不下 GPT-SoVITS + RVC + DDSP-SVC + UVR5 任意两者，
   统一由 `engine.py` 做独占调度，切换即卸载并 `torch.cuda.empty_cache()`。
2. **不要全局 `chdir`**：现有 `sovits/bootstrap.py` 会永久切到整合包根目录，
   再加两个上游必然互相破坏。改为临时上下文接管（见第 4 节）。
3. **保持 vendor 干净**：两个上游是 submodule，任何补丁都写在我们的直连层里，
   不改上游一个字符（LoRA 注入同理，用 state dict 包装实现）。
4. **numpy 不动**：DDSP-SVC 声明 `numpy==1.26.4` 但实测不需要，维持 1.23.4 以保护 GPT-SoVITS。
   若将来 DDSP 出现 numpy 相关报错，再评估升级并同步回归 GPT-SoVITS。

## 7. 剩余风险

| 风险 | 等级 | 处置 |
| --- | --- | --- |
| 8.6GB 显存下多引擎并存 | 中 | 引擎互斥 + 显存准入 + 分离任务用完即卸；分离默认提供「低显存档位」（HP2 / VR 系列） |
| 权重下载失败（网络波动） | 中 | 下载器内置 `hf-mirror` 兜底与断点续传，缺失时 `/health` 给出「缺哪个、去哪下」 |
| DDSP-SVC 与 numpy 1.23 的潜在 API 差异 | 低 | 冒烟已过；训练链路跑通前再回归一次 |
| RVC 训练耗时（8GB 卡） | 中 | 底模 + LoRA 是本轮的主要缓解手段；全量训练仅用于底模，且给出明确耗时提示 |
| 声音克隆合规 | — | 两个板块入口均需与现有 README 一致地声明授权要求 |

---

相关文档：[`docs/VOICE-CONVERSION.md`](VOICE-CONVERSION.md)（语音变声）、
[`docs/SINGING-CONVERSION.md`](SINGING-CONVERSION.md)（歌声转换）。

# GPT-SoVITS 能力移植对照

本文说明本项目从官方仓库 [RVC-Boss/GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS)
（整合包 `GPT-SoVITS-v2pro-20250604`）移植了哪些能力、以什么形式提供，
以及哪些地方刻意**没有**移植。

前置资料：[GPT-SoVITS 语雀指南](https://www.yuque.com/baicaigongchang1145haoyuangong/ib3g1e)。

---

## 一、移植原则

1. **不重复实现算法**。所有推理与训练都调用官方代码，
   本项目只做「定位、翻译、编排、观测」四件事。
2. **不硬编码官方常量**。官方仓库的路径、版本映射、参数默认值全部集中在
   `trainer/app/sovits/catalog.py`，其余模块从这里取值 —— 官方升级时只需改一处。
3. **能力差异如实声明**。官方做不到的事（例如 v3/v4 流式），
   服务端返回可读的错误，前端也据此隐藏或标注。

---

## 二、推理能力对照

| 官方能力 | 官方入口 | 本项目 | 说明 |
| --- | --- | --- | --- |
| 零样本克隆 | `TTS_infer_pack.TTS` | ✅ `/v1/tts` | 5 秒参考音频即可 |
| 多参考音频融合 | `aux_ref_audio_paths` | ✅ | 可缓解音色漂移 |
| 文本切分策略 | `text_segmentation_method.py` | ✅ 六种全部可用 | `cut0`~`cut5`，默认 `cut5` |
| 采样参数 | `top_k/top_p/temperature/repetition_penalty` | ✅ 透传 | 范围校验后透传 |
| 语速与句间停顿 | `speed_factor/fragment_interval` | ✅ 透传 | 语速非 1.0 会自动关闭分桶 |
| 批内并行 | `batch_size/batch_threshold/split_bucket/parallel_infer` | ✅ 透传 | 显存不足时界面提示调小 |
| v3/v4 采样步数与超采样 | `sample_steps/super_sampling` | ✅ 透传 | 仅 v3/v4 生效 |
| 流式合成 | `streaming_mode`（三种质量档） | ✅ `/v1/tts/stream` | 官方在 v3/v4 上不支持，服务端会拒绝 |
| 权重热切换 | `init_t2s_weights` / `init_vits_weights` | ✅ `/v1/weights/load` | 不重启进程 |
| 设备与精度 | `set_device` / `enable_half_precision` | ✅ | `auto` 时沿用官方 `config.py` 的判断 |
| 多语种跨语言 | `v2_languages` | ✅ | 中/英/日/韩/粤 + `all_*` 变体 |
| 官方 WebAPI | `api_v2.py` | ⛔ 未使用 | 见下文「为什么不复用 api_v2.py」 |
| 官方 WebUI | `webui.py`（Gradio） | ⛔ 未使用 | 本项目提供自己的界面；WebUI 仍可独立运行 |

### 为什么不复用官方 `api_v2.py`

`api_v2.py` 是一个**独立常驻进程**，与训练脚本各自加载一份模型。
在本机单卡场景下，两份模型会互相抢显存；而且它不提供音色库、批量导出、
任务进度这些「产品化」能力。所以本项目把 `TTS_infer_pack` 直接嵌进自己的服务进程，
只保留一份模型。

---

## 三、训练能力对照

官方 WebUI 的两页流程被编成 **11 个阶段**，全部使用官方脚本：

| 阶段 | 官方脚本 | 关键参数 | 备注 |
| --- | --- | --- | --- |
| 语料导入 | — | — | 扫描音频、识别同名 `.lab`/`.txt`、统计有效语音时长 |
| 语音降噪 | `tools/cmd-denoise.py` | `-i -o -p` | 可选 |
| 音频切分 | `tools/slice_audio.py` | 位置参数 ×12 | 参数默认值取自官方 WebUI |
| 语音转文本 | `tools/asr/funasr_asr.py` 或 `fasterwhisper_asr.py` | `-i -o -s -l -p` | ASR 产物即训练清单 |
| 生成训练清单 | —（内联） | — | 官方格式 `wav\|说话人\|语种\|文本` |
| 文本与 BERT 特征 | `prepare_datasets/1-get-text.py` | 环境变量 | 按 `i_part` 分片，跑完自动合并 |
| HuBERT 特征 | `prepare_datasets/2-get-hubert-wav32k.py` | 环境变量 | 同时产出 32k 重采样音频 |
| 说话人向量 | `prepare_datasets/2-get-sv.py` | 环境变量 | 仅 v2Pro / v2ProPlus |
| 语义 Token | `prepare_datasets/3-get-semantic.py` | 环境变量 | 需要 `pretrained_s2G` 与 s2 配置 |
| GPT 训练 | `s1_train.py --config_file <yaml>` | YAML 配置 | 模板 `s1longer-v2.yaml` |
| SoVITS 训练 | `s2_train.py --config <json>`（v3/v4 走 `s2_train_v3_lora.py`） | JSON 配置 | 模板 `s2{version}.json` |

训练配置由本项目基于官方模板生成，覆盖的字段与官方 WebUI 的 `open1Ba` / `open1Bb`
完全一致（batch、epoch、save_every、梯度检查点、LoRA rank、DPO、权重保存目录等）。

### 三条来自官方源码的硬约束（本项目把它们前置成了校验）

1. **切分之后文本就丢了。** `slice_audio.py` 只输出音频，
   因此开启切分就必须开启 ASR —— 否则没有文本可训。
   若你已有「音频 + 同名 `.lab`」的成对数据，请关掉切分与 ASR。
2. **FunASR 只支持中文与粤语。** `funasr_asr.py::create_model` 对其它语种直接抛错；
   日语/韩语/英语必须换 faster-whisper。前端会自动切换，服务端也会在派发前拦下。
3. **`exp_dir` 必须与数据预处理的 `opt_dir` 一致。**
   `module/data_utils.py::TextAudioSpeakerLoader` 会断言
   `<exp_dir>/2-name2text.txt`、`4-cnhubert`、`5-wav32k`（v2Pro 还有 `7-sv_cn`）都存在。
   官方 WebUI 里这两个目录是同一个；本项目保留了 `dataset/` 这一层，因此两者都指向它。

---

## 四、权重与目录约定

| 版本 | GPT 权重目录 | SoVITS 权重目录 | 预训练 GPT | 预训练 SoVITS |
| --- | --- | --- | --- | --- |
| v1 | `GPT_weights` | `SoVITS_weights` | `s1bert25hz-2kh-…ckpt` | `s2G488k.pth` |
| v2 | `GPT_weights_v2` | `SoVITS_weights_v2` | `gsv-v2final-pretrained/s1…ckpt` | `s2G2333k.pth` |
| v2Pro | `GPT_weights_v2Pro` | `SoVITS_weights_v2Pro` | `s1v3.ckpt` | `v2Pro/s2Gv2Pro.pth` |
| v2ProPlus | `GPT_weights_v2ProPlus` | `SoVITS_weights_v2ProPlus` | `s1v3.ckpt` | `v2Pro/s2Gv2ProPlus.pth` |
| v3 | `GPT_weights_v3` | `SoVITS_weights_v3` | `s1v3.ckpt` | `s2Gv3.pth` |
| v4 | `GPT_weights_v4` | `SoVITS_weights_v4` | `s1v3.ckpt` | `gsv-v4-pretrained/s2Gv4.pth` |

选默认权重时的优先级：**该版本权重目录里最新的训练产物 → 官方预训练权重**。
这样「训练完就能立刻试听」不需要任何手工切换。

训练产物写在官方目录（推理侧才能发现），中间数据写在
`trainer/.data/experiments/<实验名>/`（不污染整合包）。

---

## 五、刻意没有移植的部分

| 官方组件 | 原因 |
| --- | --- |
| `webui.py`（Gradio 主界面） | 本项目提供自己的界面；官方 WebUI 仍可独立运行，互不影响 |
| `tools/uvr5/webui.py` | 它是 Gradio GUI，无法非交互调用。降噪改用官方的 `cmd-denoise.py`；需要人声/伴奏分离时请在官方 WebUI 里做 |
| `tools/subfix_webui.py`（文本校对 GUI） | 同上。设计上把「转写文本」作为音色库的一等字段，校对在合成页/音色库页完成 |
| `api.py`（旧版 API） | 已被 `api_v2.py` 取代 |
| `export_torch_script*.py` / `onnx_export.py` | 模型导出与加速部署，属于线上/边缘部署范畴，本项目定位为本地运行 |
| Docker / 云托管配置 | 本项目只面向本地部署 |

---

## 六、许可与合规

- GPT-SoVITS 本体为 **MIT** 许可，可商用。
- **模型权重与音色素材另算**：社区分享的音色模型多为 CC-BY-NC-4.0（不可商用），
  使用前请确认来源与授权。
- 克隆他人声音必须获得明确授权；禁止用于伪造身份、诈骗等违法用途。

# 歌声转换（DDSP-SVC）

> 上游：[yxlllc/DDSP-SVC](https://github.com/yxlllc/DDSP-SVC)
> （`vendor/ddsp-svc`，6.3 分支，锁 commit）。本服务的直连层在 `trainer/app/svc/`。

## 定位

把一首**歌里的人声**换成另一个音色：显式建模音高曲线（颤音、滑音、气声都保留），
支持转调与共振峰偏移。与「语音变声」的分工：

| | 语音变声（RVC） | 歌声转换（DDSP-SVC，本板块） |
| --- | --- | --- |
| 输入 | 说话 / 配音干声 | 歌曲（整首或已分离人声） |
| 音高 | 只做整体变调 | 逐帧 F0 建模 + 转调 |
| 生成器 | VITS 系 + 声码器 | DDSP 合成器 + Rectified Flow |
| 检索增强 | faiss index | 无 |
| 产物 | 单条音频 | 新人声 / 伴奏 / 混音三件套 |

## 与 UVR5 的联动（翻唱向导）

「翻唱向导」把整条链路编成一个任务：

```
上传歌曲
  ├─（可选）UVR5 分离 ──► 人声 / 伴奏
  │        └─（可选）二级处理：去回声 / 去混响
  ├─ 提 F0 + 内容特征 ──► 转换 ──► 新人声
  └─ 混音（增益 / 延迟补偿 / 淡入淡出）
        └─► 三件套：新人声 / 伴奏 / 混音
```

两个关键设计：

1. **缓存复用**：分离结果按「文件指纹 + 分离模型 + 二级处理」缓存在
   `trainer/.data/cache/separation/`。同一首歌换音色重跑时直接跳过分分离
   （实测 30s → 0.04s）—— 这是「向导敢做成一键」的前提；
2. **可以只做分离**：页面单独提供「只做分离」卡片，先听人声 / 伴奏，
   确认满意再进向导，分离结果自动复用。

## 音质档位（重要：没有「增强器」了）

6.x 分支已用 Rectified Flow 取代老版的 enhancer / shallow diffusion，
界面上的等价旋钮是三档预设：

| 档位 | 步数 | 采样器 | t_start | 适用 |
| --- | --- | --- | --- | --- |
| 快速 fast | 20 | euler | 0.7 | 先出效果 |
| 标准 standard | 50 | euler | 沿用 config | 日常使用 |
| 高质 quality | 100 | rk4 | 沿用 config | 细节与气息 |
| 纯 DDSP raw | 10 | euler | 1.0 | 相当于老版「关掉后处理」，最快最"电" |

## 使用流程

1. 「歌声转换」页 → 上传歌曲 → 选分离档位（默认快速 HP2）；
2. 选目标音色（`.pt` + 同目录 `config.yaml`，缺 config 的模型会明确标出不可用）；
3. 设转调（key）、音质档位、混音增益 → 一键开始；
4. 任务完成后三件套各自试听与下载，原曲 / 混音可 A·B 对比。

### 导入音色

DDSP-SVC 的模型目录结构是 `model.pt` + `config.yaml` 成对出现
（训练产物 `logs/<exp>/` 里自带）。界面「歌声转换」页列出的两个搜索目录：

* `trainer/.data/svc/models/`（界面导入）
* `models/checkpoints/ddsp/`（训练产物）

## 模型与权重

预训练权重统一放 `models/pretrained/ddsp/`（见 `trainer/app/weights.py` 清单）：

| 权重 | 位置 | 用途 |
| --- | --- | --- |
| ContentVec | `ddsp/contentvec/pytorch_model.bin` | 默认内容编码器 |
| NSF-HiFiGAN | `ddsp/nsf_hifigan/model`（+ `config.json`） | 声码器 |
| RMVPE | `ddsp/rmvpe/model.pt` | 默认 F0 提取器 |
| HubertSoft（可选） | `ddsp/hubert/hubert-soft-0d54a1f4.pt` | 轻量编码器 |

一键下载：`python scripts/download_models.py --engine svc`（支持 HF 镜像兜底与断点续传）。

## 注意事项

- 上游的三处相对路径（rmvpe / 声码器 / 编码器权重）全部改成了绝对路径传参，
  因此 DDSP-SVC 直连层**完全不依赖工作目录**，与 GPT-SoVITS、RVC 互不干扰；
- 长音频默认按静音切分（`slice_segments`），整首歌一口气推理会在 8GB 卡上峰值爆掉；
- 与其他引擎共用显存互斥调度：转换开始前会自动卸载别的引擎，结束时释放显存；
- 翻唱仅限已获授权的素材；请遵守所在地区的著作权法规。

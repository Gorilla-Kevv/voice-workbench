# UVR5 → PyMSS P0 A/B 报告

> **用户裁决（2026-10-28）：放弃 PyMSS 迁移**。4_HP-Vocal 杂声多；有限显存下 UVR5 最优。
> 生产已恢复 UVR5，本报告仅留作 A/B 证据。

- 日期：2026-10-28
- 素材：`D:\Media\asmr\全年龄\RJ01241346` 截取 25s（人声 + BGM/SE）；另两段 room/alt 已切好备用
- 环境：RTX 4060 Laptop 8GB；UVR5 直连（整合包 py3.9，fp16）；PyMSS 2.0.14 + torch 2.11.0+cu128（py3.12）
- 原始片段 / 试听页：`.tmp/pymss_ab/index.html`（每行左侧原始片段，右侧各引擎人声）

## 实测（25s 片段，GPU）

| 引擎 | 模型 | 耗时 | 峰值增量 | 最低 free | 产物 |
| --- | --- | ---: | ---: | ---: | --- |
| UVR5 | HP2_all_vocals | 12.67s | +1041MB | 3186MB | vocal + instrumental |
| PyMSS | 7_HP2-UVR.pth | 48.48s | +3210MB | 1017MB | vocal + instrumental |
| UVR5 | HP5_only_main_vocal | 10.74s | +1197MB | 6217MB | vocal + instrumental |
| PyMSS | 3_HP-Vocal-UVR.pth | 66.88s | +3274MB | 3982MB | vocal + instrumental |
| PyMSS | 4_HP-Vocal-UVR.pth | 66.07s | +3253MB | 3978MB | vocal + instrumental |
| PyMSS | 5_HP-Karaoke-UVR.pth | 65.58s | +2881MB | 4349MB | vocal + instrumental |
| PyMSS | 6_HP-Karaoke-UVR.pth | 36.92s | +2879MB | 4351MB | vocal + instrumental |
| UVR5 | BS-RoFormer ep317 | — | — | — | **失败：整合包缺同名 .yaml（CLI 要求）** |
| PyMSS | BS-RoFormer ep317 | **9.19s** | **+1876MB** | 5356MB | vocal + instrumental |
| UVR5 | VR-DeEchoDeReverb | 10.90s | +1019MB | 6211MB | 净化人声 |
| PyMSS | UVR-DeEcho-DeReverb | 57.46s | +2833MB | 4397MB | 净化人声（`No Reverb` stem） |

> PyMSS 额外试了 `use_amp=True + batch_size=1`：HP2 39.2s / +3313MB，仍远慢于 UVR5、显存没有下降；说明当前 PyMSS VR 路径基本按 fp32 跑，`use_amp` 没有解决 VR 模型的显存/速度问题。

## 结论（P0 冻结建议）

1. **功能上 PyMSS 可用**：HP2 / 3/4/5/6 HP / BS-RoFormer / DeReverb 都能出正确的人声/伴奏；DeEcho 的干净 stem 是 `No Reverb` / `No Echo`（不是 `vocals`），已在 `PymssEngine` 做映射。
2. **性能上 PyMSS 在 VR 系模型上明显退化**：HP2 慢 ~3.8x、显存高 ~3x；HP5 系慢 ~6x、显存高 ~2.7x；去混响慢 ~5x、显存高 ~2.8x。8GB 卡上这会直接改变可用性。
3. **BS-RoFormer 反而更好**：PyMSS 9.2s / +1.9GB，UVR5 CLI 因缺 yaml 失败；项目内 `Uvr5Engine` 走内置默认配置可跑，但这次 A/B 无法同口径对比，需要补一次 API 路径的 BS 基线。
4. **暂不切默认**：`UVR_BACKEND` 默认保持 `uvr5`；PyMSS 作为 opt-in（`UVR_BACKEND=pymss`）。P6 的默认切换需要：用户耳听 A/B + 模型许可核对 + 决定是否接受 VR 模型性能回退。
5. **`vocal_main` 仍未冻结**：3/4/5/6 都能跑，但当前素材是单主唱 ASMR（无和声），不足以判断「仅保留主唱」质量；需要一段带和声/主唱的真实歌曲做耳听。暂用 `3_HP-Vocal-UVR.pth` 作为候选默认，**不写死**。

## 试听与下一步

- 打开 `.tmp/pymss_ab/index.html`，重点听：主唱保留度、BGM 泄漏、齿音/气声、去混响后是否吃细节。
- 补一段 20~40s「带和声/主唱」歌曲：重跑 HP5 vs 3/4/5/6；再决定 `vocal_main` 映射。
- 许可：`weights.manifest.json` 里 9 个模型的 license 仍是「待核对」；P6 前逐个核对上游模型卡，不明确不用于分发。
- 性能：如果保留 PyMSS，优先考虑只在 `vocal_hifi`（BS-RoFormer）使用 PyMSS，VR 档位继续走 UVR5；或者单独研究 PyMSS VR 的 fp16/参数支持，不要在当前 A/B 结论上直接切默认。

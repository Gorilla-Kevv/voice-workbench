# 分析报告：Fish Audio / Drama 3 调研包（K2 整合）

- 分析时间：2026-10-19 · BY ZCode · 触发：用户「放了」（一句话流程）
- 产出：data.js 新增「Fish Audio / Drama 3」条目（models 篇 ChatTTS 之后）+ 工具清单补 fishaudio/fish-speech 主库；已 rebuild 并提交。

## 流程记录

1. **分析文件**：调研包 = Fish Audio 产品线全谱（Drama 3 35B MoE 旗舰 / S2-Pro / s1-mini / fish-speech-1.5）+ 开源边界（S2.1 Pro / S1 4B 闭源仅 API）+ 逐文件体积（HF API 实证）+ 许可三档 + 8GB 卡判定 + 社区 ComfyUI 移植生态。质量高：全部数字有 evidence/hf-api/*.json 原始返回背书，未采信自媒体。
2. **产出报告**：本文件。
3. **验证可行性**：无需实跑——「跑不动」的结论由体积实证（38.63 GiB vs 8GB 卡）与官方口径支撑，逻辑自洽。可执行项（S1-mini/1.5 本地跑）本项目暂不集成，留待需要时按包内复现方法验证。
4. **横向对比**：data.js 原无任何 Fish Audio 条目 → 全新收录，无冲突；与五运行时对照：该项目「纯本地非商用」裁决下 S1-mini/1.5 的 CC-BY-NC-SA 可用，Drama 3/S2-Pro 门槛远超本机。
5. **整合**：已完成（见上）。未收录进知识库的：逐文件体积明细与社区节点表——调研包本身留档于此，知识库条目已指明要点。

## 备注

- 包内「torch 2.13.0+cu130 / 驱动 572.61 只到 CUDA 12.8」为**绘画项目整合包**的基线，与本仓库 gsv5（torch 2.7.1+cu128）不冲突，勿混淆。

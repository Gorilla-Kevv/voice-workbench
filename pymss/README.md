# PyMSS runtime（已否决，仅留实验记录）

> **状态：已否决（2026-10-28）**。用户耳听 4_HP-Vocal 杂声多；8GB 显存上 UVR5 才是最优解。
> 生产代码已恢复纯 UVR5（无 `UVR_BACKEND` 切换），本文与 `pymss/` runtime/models 仅保留实验记录，
> 不再接入 trainer；`pymss/` 可直接回收（用户确认后走回收站）。

## 运行时

- Python **3.12.10**（`uv venv pymss/.venv --python 3.12.10`）
- `pymss==2.0.14`、`pymss-core==0.1.4`
- `torch` 必须装 **cu128** wheel（PyPI 默认是 CPU 版，`torch.cuda.is_available()` 会是 false）
  - 当前 CUDA 可用版本：`torch==2.11.0+cu128`
  - 安装命令：
    ```bash
    export UV_CACHE_DIR="$PWD/pymss/.uv-cache"
    pymss/.venv/Scripts/python.exe -m pip ... # 或 uv pip install
    uv pip install --python pymss/.venv/Scripts/python.exe \
      --index-url https://download.pytorch.org/whl/cu128 --reinstall "torch==2.11.0+cu128"
    ```

## 模型

- 目录：`pymss/models/`（gitignore；`PYMSS_MODEL_DIR` 可覆盖）
- 只下载需要的模型，不要 `pymss download all`：
  ```bash
  pymss/.venv/Scripts/pymss.exe download 7_HP2-UVR.pth --model-dir pymss/models --source modelscope
  pymss/.venv/Scripts/pymss.exe download model_bs_roformer_ep_317_sdr_12.9755.ckpt --model-dir pymss/models --source modelscope
  pymss/.venv/Scripts/pymss.exe download UVR-DeEcho-DeReverb.pth --model-dir pymss/models --source modelscope
  pymss/.venv/Scripts/pymss.exe download UVR-De-Echo-Normal.pth --model-dir pymss/models --source modelscope
  pymss/.venv/Scripts/pymss.exe download UVR-De-Echo-Aggressive.pth --model-dir pymss/models --source modelscope
  ```
- `vocal_main` 候选（P0 A/B 后冻结）：`3_HP-Vocal-UVR.pth` / `4_HP-Vocal-UVR.pth` /
  `5_HP-Karaoke-UVR.pth` / `6_HP-Karaoke-UVR.pth`。
- 来源：HF/ModelScope `baicai1145/pymss`；许可需逐个核对，未明确的模型不要用于分发。
  `weights.manifest.json` 记录选定模型的来源/大小/SHA256/许可。

## 就绪检查

```bash
pymss/.venv/Scripts/python.exe pymss/check.py
```

检查 Python 3.12、pymss/pymss-core 版本、torch CUDA、模型目录与 manifest 里的模型文件。

## bridge 协议

trainer 调：

```bash
pymss/.venv/Scripts/python.exe pymss/bridge.py --request '<json>'
# 或 --request-file <path>（Windows 命令行过长时用这个）
```

请求字段：

```json
{
  "source": "输入音频绝对路径",
  "model": "7_HP2-UVR.pth",
  "model_dir": "pymss/models",
  "outputs": {"vocals": "out/vocals", "instrumental": "out/inst"},
  "format": "wav",
  "agg": 10,
  "device": "cuda"
}
```

stdout 每行一个 JSON：`progress` / `result` / `error`；stderr 只放 PyMSS 日志。
`result.files` 的 key 与请求的 `outputs` 一致；文件名为 `<输入名>_<Stem>.<format>`（大小写不敏感匹配）。

## 映射（P0 冻结前）

| 档位 | PyMSS 模型 |
| --- | --- |
| vocal_fast | 7_HP2-UVR.pth |
| vocal_main | **待 A/B**（当前暂 3_HP-Vocal-UVR.pth） |
| vocal_hifi | model_bs_roformer_ep_317_sdr_12.9755.ckpt |
| dereverb | UVR-DeEcho-DeReverb.pth |
| deecho_normal | UVR-De-Echo-Normal.pth |
| deecho_aggressive | UVR-De-Echo-Aggressive.pth |

## 限制

- 未升级 `vendor/rvc`；PyMSS 只作为独立运行时。
- 当前 bridge 对二级 DeEcho 取 `vocals` 作为净化后的人声；P0 需确认该模型的 stem 语义。
- 未做常驻服务；需要并行/复用模型时再考虑 :9886。

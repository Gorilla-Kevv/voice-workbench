# -*- coding: utf-8 -*-
"""真机冒烟：R2T2 离线转写（transformers 后端）。

    python .tmp/smoke_r2t2_transcribe.py [audio.wav] [--device cpu]

护栏（对应坑 78：显存不足时 GPU 推理溢出共享内存假死）：
  1. GPU 模式先读 nvidia-smi 空闲显存，< 6200 MB 直接跳过（退出码 0，如实说明），绝不硬跑；
  2. `--device cpu` 走零显存排障通道（fp32，RTF 慢），跳过护栏；
  3. 权重文件不齐直接跳过；
  4. worker 走 r2t2-venv 解释器 + transformers 后端（与服务的 spawn 参数一致）。

流程：spawn → load（含静音预热）→ transcribe（印文本与耗时）→ unload（杀进程归还显存）。
"""

import json
import os
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VENV_PY = os.path.join(ROOT, "netease", "r2t2-venv", "Scripts", "python.exe")
WORKER = os.path.join(ROOT, "netease", "app", "r2t2_worker.py")
MODEL_DIR = os.path.join(ROOT, "netease", "models", "Confucius4-R2T2")
REQUIRED_FREE_MB = 6200  # bf16 净占 ~5.5 GB + 峰值余量；比服务端 6144 门槛再保守一点

ARGS = [a for a in sys.argv[1:]]
DEVICE = "cpu" if "--device" in ARGS and ARGS[ARGS.index("--device") + 1] == "cpu" else "auto"
AUDIO_CANDIDATES = [a for a in ARGS if not a.startswith("--") and a != "cpu"]
AUDIO = AUDIO_CANDIDATES[0] if AUDIO_CANDIDATES else os.path.join(ROOT, ".tmp", "irodori_short_ref.wav")


def free_vram_mb():
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.free", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=10,
        )
        return int(out.stdout.strip().splitlines()[0])
    except Exception:
        return None


def main():
    if not os.path.exists(VENV_PY):
        print("[skip] r2t2-venv 不存在，先按 netease/README.md 建环境")
        return 0
    needed = ["config.json", "model.safetensors", "tokenizer.json", "preprocessor_config.json", "chat_template.json"]
    missing = [f for f in needed if not os.path.exists(os.path.join(MODEL_DIR, f))]
    if missing:
        print(f"[skip] 权重未齐（缺 {missing}），先跑 npm run netease:weights -- --include-r2t2")
        return 0
    if not os.path.exists(AUDIO):
        print(f"[skip] 测试音频不存在：{AUDIO}")
        return 0
    # 静音素材会得到「空文本」——那是模型的正确输出，不是 bug（10.24 实测踩过：
    # .tmp 里两个 irodori ref wav 全是数字静音，白白误判一次）。先验能量再跑。
    try:
        import soundfile as sf
        import numpy as np
        data, _sr = sf.read(AUDIO, dtype="float32", always_2d=True)
        peak = float(np.abs(data.mean(axis=1)).max())
        if peak < 1e-4:
            print(f"[warn] 素材疑似数字静音（peak={peak:.6f}）：空文本是正确输出，换真人语音素材再验文本质量")
    except Exception:
        pass
    if DEVICE != "cpu":
        # 2026-11-09：桌面基线在 6188~6204 MB 之间抖动，阈值 6200 正好落在抖动带上，
        # 在外部脚本里先采样再起 python（导入 soundfile/numpy 约 1.5s）会输掉这场竞速。
        # 改成**在同一个进程里等窗口**（最多 3 分钟），采样后立刻 spawn —— 阈值不动。
        deadline = time.monotonic() + 180
        free = free_vram_mb()
        while free is not None and free < REQUIRED_FREE_MB and time.monotonic() < deadline:
            time.sleep(2)
            free = free_vram_mb()
        if free is None or free < REQUIRED_FREE_MB:
            print(f"[skip] 空闲显存 {free} MB < {REQUIRED_FREE_MB} MB（坑 78：硬跑会溢出共享内存假死），"
                  "关掉占显存的程序后重跑本脚本，或用 --device cpu 走零显存排障通道")
            return 0
        print(f"[run] 空闲显存 {free} MB，启动 worker（transformers 后端，加载约 1~2 分钟，含静音预热）…")
    else:
        print("[run] --device cpu：零显存排障通道（fp32，RTF 慢——CPU 上 1.5B 模型转写可能要数分钟）…")
    # 协议行的编码必须与生产客户端（`netease/app/r2t2.py`）完全一致：
    # 子进程 Windows 默认按 locale(GBK) 写 stdout，而父进程按 utf-8 读 —— worker 第一条
    # 中文日志（「加载 R2T2 模型…」）就会让父进程 UnicodeDecodeError。
    # 2026-11-09 本脚本漏了这两个环境变量，真机冒烟直接死在 load 之前。
    proc = subprocess.Popen(
        [VENV_PY, WORKER, "--model", MODEL_DIR, "--backend", "transformers", "--device", DEVICE],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=None,
        text=True, encoding="utf-8",
        env={**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUNBUFFERED": "1"},
    )

    def send(payload):
        proc.stdin.write(json.dumps(payload, ensure_ascii=False) + "\n")
        proc.stdin.flush()

    def recv_until(want_id, timeout=900):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            line = proc.stdout.readline()
            if not line:
                raise RuntimeError("worker stdout 关闭")
            line = line.strip()
            if not line:
                continue
            msg = json.loads(line)
            kind = msg.get("type")
            if kind == "log":
                print("    ·", msg.get("line", ""))
                continue
            if kind in {"result", "error", "pong", "ready"}:
                if kind == "ready":
                    print("    · [ready 广播]")
                    continue
                if msg.get("id") == want_id:
                    return msg
                continue
        raise RuntimeError(f"{timeout}s 内未收到 id={want_id} 的应答")

    try:
        send({"type": "ping", "id": "p1"})
        print("ping →", recv_until("p1", 30).get("type"))
        started = time.monotonic()
        send({"type": "load", "id": "load"})
        result = recv_until("load", 1500)  # CPU 模式 fp32 加载+预热可能超过 20 分钟
        if result.get("type") == "error":
            print("[x] 加载失败：", result.get("message"), "\n   hint:", result.get("hint"))
            return 1
        print(f"[ok] 模型就绪，load 总耗时 {time.monotonic() - started:.0f}s")

        send({"type": "transcribe", "id": "t1", "path": AUDIO, "language": "auto", "return_timestamps": False})
        result = recv_until("t1", 1500)
        if result.get("type") == "error":
            print("[x] 转写失败：", result.get("message"), "\n   hint:", result.get("hint"))
            return 1
        print(f"[ok] 转写完成：{result.get('elapsed_sec')}s，文本：")
        print("    ", (result.get("text") or "")[:500])
        if result.get("segments"):
            print(f"    （分段 {result.get('segments')} 段）")
        return 0
    finally:
        try:
            send({"type": "shutdown", "id": "bye"})
            proc.wait(timeout=15)
        except Exception:
            proc.kill()


if __name__ == "__main__":
    raise SystemExit(main())

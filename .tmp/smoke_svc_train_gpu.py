# -*- coding: utf-8 -*-
"""阶段 44 GPU 真机冒烟：12 条合成素材 → GPU 预处理 + 训练 + 产物加载/转换，采样显存峰值。

这个脚本**绕过** engines.acquire（直接调 training.run），目的就是先拿到真实画像，
再决定 svc_train 的参数化门槛。跑完把模型移到 .tmp，不留在受管模型库。
"""
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

import numpy as np
import soundfile as sf

ROOT = Path(r"F:\schoolCompWorks\clone\ttstool")
sys.path.insert(0, str(ROOT / "trainer"))
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from app.config import Settings  # noqa: E402
from app.engine import EngineRegistry  # noqa: E402
from app.svc import bootstrap, training  # noqa: E402
from app.svc.pipeline import SvcEngine  # noqa: E402

WORK = ROOT / "trainer" / ".tmp" / "ddsp_gpu"
CORPUS = WORK / "corpus"
DATA = WORK / "data"
NAME = "__stage44_gpu_smoke"
MODEL_DIR = ROOT / "models" / "ddsp-svc" / "_stage44_gpu_smoke"

if DATA.exists():
    shutil.rmtree(DATA, ignore_errors=True)
if CORPUS.exists():
    shutil.rmtree(CORPUS, ignore_errors=True)
CORPUS.mkdir(parents=True, exist_ok=True)

# 12 条 3.2s 素材：不同基频 + 起伏，保证 batch 8 有 2 个 batch（8 + 4）
sr = 44100
for i in range(12):
    seconds = 3.2
    t = np.arange(int(seconds * sr)) / sr
    freq = 180.0 + i * 18.0
    audio = 0.2 * np.sin(2 * np.pi * freq * t) * (0.6 + 0.4 * np.sin(2 * np.pi * (2.5 + i * 0.1) * t))
    sf.write(str(CORPUS / ("gpu-%02d.wav" % i)), audio.astype(np.float32), sr)
print("CORPUS", CORPUS, "files", len(list(CORPUS.glob("*.wav"))))

settings = Settings(data_dir=DATA)
request = training.SvcTrainRequest(
    name=NAME,
    corpus_dir=str(CORPUS),
    epochs=1,
    batch_size=8,
    duration=2.0,
    f0_method="rmvpe",
    amp_dtype="fp16",
    device="cuda",
    keep_workdir=True,
)
pre = training.preflight(settings, request)
print("PREFLIGHT", pre["ok"])
print("ISSUES", pre["issues"])
print("WARNINGS", pre["warnings"])
print("STEPS", pre["steps"])
print("VRAM_PRE", pre["vram"])
if not pre["ok"]:
    raise SystemExit(1)


def gpu_sample():
    try:
        out = subprocess.check_output(
            ["nvidia-smi", "--query-gpu=memory.used,memory.free", "--format=csv,noheader,nounits"],
            text=True,
        ).strip()
        used, free = [int(item.strip()) for item in out.split(",")]
        return used, free
    except Exception:
        return None


samples = []
baseline = gpu_sample()
stop = threading.Event()


def monitor():
    while not stop.is_set():
        item = gpu_sample()
        if item:
            samples.append((time.time(), item[0], item[1]))
        time.sleep(0.5)


thread = threading.Thread(target=monitor, daemon=True)
thread.start()
started = time.time()
log_lines = []
log_path = WORK / "gpu-train.log"
log_path.write_text("", encoding="utf-8")


def log(line):
    log_lines.append(line)
    with log_path.open("a", encoding="utf-8") as handle:
        handle.write(line + "\n")
    if any(key in line for key in ("[svc-train]", "[数据]", "epoch:", "final checkpoint")):
        print(line[:240])


print("GATE_REQUIRED_MB", request.vram_required_mb())
registry = EngineRegistry(settings)
handle = registry.acquire(
    "svc_train",
    reason="stage44 GPU smoke gate",
    required_mb=request.vram_required_mb(),
)
print("GATE_ACQUIRED", handle.to_dict())
try:
    result = training.run(
        settings,
        request,
        progress=lambda f, m: print("PROGRESS %.3f %s" % (f, m)) if any(k in m for k in ("训练", "预处理", "归位")) else None,
        log=log,
        job_id="stage44-gpu-smoke",
    )
finally:
    handle.release()
stop.set()
thread.join(timeout=2)
elapsed = time.time() - started

used_values = [item[1] for item in samples]
free_values = [item[2] for item in samples]
peak_used = max(used_values) if used_values else None
min_free = min(free_values) if free_values else None
print("RUN", result.get("ok"), result.get("error"), result.get("hint"))
print("ELAPSED_S", round(elapsed, 1))
print("BASELINE", baseline)
print("PEAK_USED_MB", peak_used, "MIN_FREE_MB", min_free, "SAMPLES", len(samples))
if baseline and peak_used:
    print("DELTA_USED_MB", peak_used - baseline[0])
print("STEPS_DONE", (result.get("steps") or {}).get("completed"))
print("ARTIFACTS", result.get("artifacts"))

# GPU 推理验证：加载刚训出的模型并跑一次 raw 档转换
if result.get("ok"):
    model_path = Path(result["model"])
    engine = SvcEngine(settings)
    status = engine.load(model_path)
    print("ENGINE", status)
    out = WORK / "converted-gpu.wav"
    conv_started = time.time()
    info = engine.convert(
        src=CORPUS / "gpu-00.wav",
        out_path=out,
        quality="raw",
        slice_segments=False,
    )
    print("CONVERT_S", round(time.time() - conv_started, 2), info)
    print("OUT", out, out.stat().st_size)
    engine.unload()

# 自建 scratch：模型移出受管目录
if MODEL_DIR.exists():
    dest = WORK / "artifact_stage44_gpu_smoke"
    if dest.exists():
        shutil.rmtree(dest, ignore_errors=True)
    shutil.move(str(MODEL_DIR), str(dest))
    print("MOVED_MODEL", dest)

sys.exit(0 if result.get("ok") else 1)

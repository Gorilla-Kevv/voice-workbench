# -*- coding: utf-8 -*-
"""SenseVoice worker 真机冒烟：AsrEngine → 新 venv worker → GPU 显存/真实样例。"""
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

ROOT = Path(r"F:\schoolCompWorks\clone\ttstool")
sys.path.insert(0, str(ROOT / "trainer"))
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from app.asr.pipeline import AsrEngine  # noqa: E402
from app.config import Settings  # noqa: E402
from app.sovits import bootstrap as sovits_bootstrap  # noqa: E402

WORK = ROOT / "trainer" / ".tmp" / "sensevoice_worker_probe"
if WORK.exists():
    shutil.rmtree(WORK, ignore_errors=True)
WORK.mkdir(parents=True, exist_ok=True)
MODEL_DIR = ROOT / "GPT-SoVITS-v2pro-20250604" / "tools" / "asr" / "models" / "SenseVoiceSmall"
inst = sovits_bootstrap.locate(str(ROOT / "GPT-SoVITS-v2pro-20250604"), auto_discover=False)
if inst is not None:
    sovits_bootstrap.install(inst)
settings = Settings(data_dir=WORK / "data", asr_device="cuda")


def gpu():
    out = subprocess.check_output(
        ["nvidia-smi", "--query-gpu=memory.used,memory.free", "--format=csv,noheader,nounits"],
        text=True,
    ).strip()
    used, free = [int(x.strip()) for x in out.split(",")]
    return used, free


engine = AsrEngine(settings)
baseline = gpu()
samples = []
stop = threading.Event()


def monitor():
    while not stop.is_set():
        samples.append(gpu())
        time.sleep(0.25)


thread = threading.Thread(target=monitor, daemon=True)
thread.start()
try:
    t = time.time()
    status = engine.load(backend="funasr", language="ja", model="iic/SenseVoiceSmall", channel="resident")
    print("LOAD_S", round(time.time() - t, 1))
    print("STATUS", {k: status.get(k) for k in ("model", "channel", "device", "funasr_source", "weights_ready", "weights_source", "runtime_ready")})
    resident = gpu()
    for name, lang in (("ja", "ja"), ("zh", "zh"), ("en", "en")):
        t = time.time()
        r = engine.transcribe(
            src=MODEL_DIR / "example" / (name + ".mp3"),
            backend="funasr",
            language=lang,
            model="iic/SenseVoiceSmall",
            channel="resident",
            use_cache=False,
        )
        print(name.upper(), repr(r.get("text"))[:300], "SEC", round(time.time() - t, 2), "LANG", r.get("language"))
finally:
    engine.unload()
    stop.set()
    thread.join(timeout=2)
    time.sleep(1)
    print("AFTER_UNLOAD", gpu())
print("BASELINE", baseline)
print("RESIDENT", resident)
peak = max((u for u, _ in samples), default=baseline[0])
print("PEAK_USED", peak, "MIN_FREE", min((f for _, f in samples), default=None))
print("RESIDENT_DELTA_MB", resident[0] - baseline[0])
print("PEAK_DELTA_MB", peak - baseline[0])
shutil.rmtree(WORK, ignore_errors=True)

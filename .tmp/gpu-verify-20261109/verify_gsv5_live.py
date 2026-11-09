# -*- coding: utf-8 -*-
"""真机验证：gsv5（GPT-SoVITS v5）v5turbo GPU 合成（阶段 47补2 遗留）。

    gsv5/.venv/Scripts/python.exe .tmp/gpu-verify-20261109/verify_gsv5_live.py

阶段 47补2 修了 cwd / `TTS_Config` dict / sv 权重三处，只做了 CPU 冒烟（预加载 26.1s、
短句 2.36s/48kHz），GPU 真机因为显存不够一直没跑。本脚本补 GPU：

  A. `/v1/warmup {variant:"v5turbo"}` 在真机上装载成功；
  B. `/v1/synth` 出 48kHz 音频，RTF 与耗时记录下来（turbo 4 步）；
  C. 第二条同请求的 RTF 用于稳态对照；
  D. `/v1/unload` 归还显存。

参考音频走音色库（`ref_voice`），prompt_text 由服务端从音色库带出 —— 与前端同一条路径。
"""

from __future__ import annotations

import json
import subprocess
import threading
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[2]
BASE = "http://127.0.0.1:9885"
OUT = Path(__file__).resolve().parent
VOICE_ID = "f9111eb8bbfe"  # zh，3.28s（音色库「ykn神人版」）
TEXT = "这是 GPT-SoVITS 第五代底模的显卡实测。"

_samples: list[int] = []
_stop = threading.Event()


def _free_mb() -> int | None:
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.free", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=10,
        )
        return int(out.stdout.strip().splitlines()[0])
    except Exception:
        return None


def _sampler() -> None:
    while not _stop.is_set():
        value = _free_mb()
        if value is not None:
            _samples.append(value)
        _stop.wait(0.5)


def main() -> int:
    result: dict = {"base": BASE, "voice": VOICE_ID, "text": TEXT}
    health = requests.get(f"{BASE}/health", timeout=60).json()
    result["health"] = health
    print("[1] health:", json.dumps(health, ensure_ascii=False)[:600])
    catalog = requests.get(f"{BASE}/v1/catalog", timeout=60).json()
    result["catalog"] = catalog
    print("    variants:", json.dumps(catalog.get("variants"), ensure_ascii=False))

    baseline = _free_mb()
    result["vram_free_baseline"] = baseline
    print(f"    基线空闲显存 = {baseline} MB")
    thread = threading.Thread(target=_sampler, daemon=True)
    thread.start()

    print("[2] POST /v1/warmup {variant: v5turbo} ...")
    started = time.monotonic()
    warm = requests.post(f"{BASE}/v1/warmup", json={"variant": "v5turbo"}, timeout=1800).json()
    load_sec = time.monotonic() - started
    loaded_free = _free_mb()
    result["warmup"] = {
        "ok": warm.get("ok"),
        "wall_sec": round(load_sec, 1),
        "free_after_mb": loaded_free,
        "resident_mb": (baseline - loaded_free) if baseline and loaded_free else None,
        "engine": warm.get("engine") or {k: v for k, v in warm.items() if k != "ok"},
    }
    print(f"    装载 {load_sec:.1f}s | 装载后空闲 {loaded_free} MB | 常驻增量 "
          f"{result['warmup']['resident_mb']} MB")
    if not warm.get("ok"):
        print("[x] warmup 失败:", json.dumps(warm, ensure_ascii=False)[:800])
        _stop.set()
        return 1

    def synth(label: str) -> dict:
        payload = {
            "variant": "v5turbo",
            "text": TEXT,
            "text_lang": "zh",
            "ref_voice": VOICE_ID,
            "sample_steps": 4,
            "speed_factor": 1.0,
            "seed": 42,
        }
        t0 = time.monotonic()
        response = requests.post(f"{BASE}/v1/synth", json=payload, timeout=1800)
        wall = time.monotonic() - t0
        if response.status_code != 200:
            print(f"[x] {label} 失败 {response.status_code}: {response.text[:600]}")
            return {"status": response.status_code, "error": response.text[:600]}
        body = response.json()
        print(f"    {label}: 服务端 {body.get('elapsed_sec')}s / 音频 {body.get('duration_sec')}s / "
              f"RTF {body.get('rtf')} / 采样率 {body.get('sample_rate')} / 墙钟 {wall:.2f}s")
        import base64  # noqa: PLC0415

        audio = base64.b64decode(body["audio_base64"])
        target = OUT / f"gsv5_{label}.wav"
        target.write_bytes(audio)
        return {
            "ok": True,
            "elapsed_sec": body.get("elapsed_sec"),
            "duration_sec": body.get("duration_sec"),
            "rtf": body.get("rtf"),
            "sample_rate": body.get("sample_rate"),
            "wall_sec": round(wall, 3),
            "bytes": len(audio),
            "path": str(target),
        }

    print("[3] 第 1 条 v5turbo 合成 ...")
    first = synth("first")
    print("[4] 第 2 条（稳态对照）...")
    second = synth("second")
    result["steps"] = {"first": first, "second": second}

    print("[5] POST /v1/unload ...")
    unload = requests.post(f"{BASE}/v1/unload", timeout=600).json()
    time.sleep(0.8)
    after = _free_mb()
    result["unload"] = unload
    result["vram_free_after_unload"] = after
    result["vram_free_min"] = min(_samples) if _samples else None
    result["vram_resident_mb"] = (baseline - loaded_free) if baseline and loaded_free else None
    result["vram_one_time_overhead_mb"] = (baseline - after) if baseline and after else None
    print(f"    unload 后空闲 {after} MB（基线 {baseline}，采样最低 {result['vram_free_min']}）")

    # 2026-11-09 实测：gsv5 的 unload **不会**回到「进程还没第一次加载」时的水位 ——
    # 首次加载会留下一次性成本（CUDA context + cuBLAS/cuDNN workspace + 上游模块级缓存，
    # 实测约 1.5 GB），第二次 unload 也不再释放。要判「是不是每次循环泄漏」，
    # 必须再走一轮 load→unload 看水位是否回到同一个值。
    print("[6] 循环 load→unload：确认残留是一次性成本而不是累积泄漏 ...")
    time.sleep(0.5)
    cycle_before = _free_mb()
    cycle_load_started = time.monotonic()
    requests.post(f"{BASE}/v1/warmup", json={"variant": "v5turbo"}, timeout=1800)
    cycle_load_sec = time.monotonic() - cycle_load_started
    cycle_loaded = _free_mb()
    requests.post(f"{BASE}/v1/unload", timeout=600)
    time.sleep(0.8)
    cycle_after = _free_mb()
    result["reload_cycle"] = {
        "free_before_mb": cycle_before,
        "load_sec": round(cycle_load_sec, 1),
        "free_loaded_mb": cycle_loaded,
        "free_after_unload_mb": cycle_after,
        "no_accumulation": (cycle_before is not None and cycle_after is not None
                            and abs(cycle_after - cycle_before) <= 250),
    }
    print(f"    循环前 {cycle_before} → 加载 {cycle_load_sec:.1f}s/{cycle_loaded} → unload {cycle_after} MB")

    _stop.set()
    ok = (
        warm.get("ok") is True
        and bool(first.get("duration_sec"))
        and 47000 <= int(first.get("sample_rate") or 0) <= 49000  # v5 应为 48kHz
        and result["reload_cycle"]["no_accumulation"]
        and after is not None and baseline is not None and after >= baseline - 1800
    )
    result["verdict"] = "PASS" if ok else "FAIL"
    print("\n[verdict]", result["verdict"])
    (OUT / "gsv5_result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())

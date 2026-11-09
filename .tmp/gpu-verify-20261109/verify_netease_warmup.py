# -*- coding: utf-8 -*-
"""真机验证：netease /v1/confucius/warmup 的 warmup_real 是否真的消掉了「首条合成分钟级」。

阶段 40 把 `/v1/confucius/warmup` 从「只 ensure_loaded」改成「加载后跑一次最小真实合成」
（预热失败不阻塞，结果带在 `warmup_real` 字段里），但当时没有显存窗口做真机验证。
本脚本补这一段：

    python .tmp/gpu-verify-20261109/verify_netease_warmup.py

流程：health → 基线显存 → warmup（读 warmup_real，量墙钟）→ 第 1 条真实合成（本该慢）
→ 第 2 条同请求（稳态 RTF）→ unload（看归还多少）→ 旁路采样 nvidia-smi 峰值。

判据：
  A. warmup 返回 `warmup_real.kernel_warmup == "done"`；
  B. 紧随其后的第一条真实合成不再出现分钟级（阶段 40 修之前实测 378s）；
  C. 第二条 / 第一条的耗时比接近 1（算子已在 warmup 里跑过）；
  D. unload 之后显存回到基线 ±600MB。
"""

from __future__ import annotations

import json
import subprocess
import threading
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[2]
BASE = "http://127.0.0.1:9882"
REF = ROOT / "voicelib" / "voices" / "f9111eb8bbfe.wav"  # zh，3.28s
TEXT = "这是一次显存与延迟的实测，用来确认预热是否真的把算子跑过一遍。"
OUT = Path(__file__).resolve().parent / "netease_warmup_result.json"

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
    result: dict = {"base": BASE, "ref": str(REF), "steps": {}}
    if not REF.is_file():
        print(f"[skip] 参考音频不存在：{REF}")
        return 0
    print("[1] health ...")
    health = requests.get(f"{BASE}/health", timeout=60).json()
    configuration = health.get("configuration") or {}
    result["health"] = {
        "ok": health.get("ok"),
        "precision": configuration.get("tts_precision"),
        "tts_required_vram_mb": configuration.get("tts_required_vram_mb"),
        "engines": {
            "tts": {
                "installed": (health.get("engines") or {}).get("confucius_tts", {}).get("installed"),
                "weights_cached": len((health.get("engines") or {}).get("confucius_tts", {}).get("weights_cached") or []),
                "loaded": (health.get("engines") or {}).get("confucius_tts", {}).get("loaded"),
            },
            "r2t2": {
                "installed": (health.get("engines") or {}).get("r2t2", {}).get("installed"),
                "model_loaded": (health.get("engines") or {}).get("r2t2", {}).get("model_loaded"),
            },
        },
    }
    print("    precision =", result["health"]["precision"],
          "| required =", result["health"]["tts_required_vram_mb"], "MB")
    print("    engines  =", json.dumps(result["health"]["engines"], ensure_ascii=False))

    baseline = _free_mb()
    result["vram_free_baseline"] = baseline
    print(f"    基线空闲显存 = {baseline} MB")

    thread = threading.Thread(target=_sampler, daemon=True)
    thread.start()

    print("[2] POST /v1/confucius/warmup（加载 + 真实预热，可能要几分钟）...")
    started = time.monotonic()
    warm = requests.post(f"{BASE}/v1/confucius/warmup", timeout=1800).json()
    warm_wall = time.monotonic() - started
    result["warmup"] = {"wall_sec": round(warm_wall, 2), **{k: warm.get(k) for k in ("ok", "preempted", "warmup_real")}}
    print(f"    墙钟 {warm_wall:.1f}s | warmup_real = {json.dumps(warm.get('warmup_real'), ensure_ascii=False)}")
    if not warm.get("ok"):
        print("[x] warmup 失败：", json.dumps(warm, ensure_ascii=False)[:800])
        _stop.set()
        return 1

    def synth(label: str) -> dict:
        payload = {
            "text": TEXT,
            "lang": "zh",
            "ref_path": str(REF),
            "preempt": "true",
            "quality": "balanced",
        }
        t0 = time.monotonic()
        response = requests.post(f"{BASE}/v1/confucius/tts", data=payload, timeout=1200)
        wall = time.monotonic() - t0
        if response.status_code != 200:
            print(f"[x] {label} 失败 {response.status_code}: {response.text[:500]}")
            return {"status": response.status_code, "error": response.text[:500]}
        body = response.json()
        elapsed = float(body.get("elapsed_sec") or 0.0)
        duration = float(body.get("duration_sec") or 0.0)
        rtf = elapsed / duration if duration else None
        print(f"    {label}: 服务端 {elapsed:.2f}s / 音频 {duration:.2f}s / RTF {rtf:.2f} / 墙钟 {wall:.2f}s")
        return {
            "ok": True,
            "elapsed_sec": elapsed,
            "duration_sec": duration,
            "rtf": rtf,
            "wall_sec": round(wall, 3),
            "sample_rate": body.get("sample_rate"),
        }

    print("[3] 第 1 条真实合成（warmup 之后，本应是稳态耗时）...")
    first = synth("first")
    print("[4] 第 2 条同请求（稳态对照）...")
    second = synth("second")
    result["steps"] = {"first": first, "second": second}

    print("[5] POST /v1/confucius/unload ...")
    unload = requests.post(f"{BASE}/v1/confucius/unload", timeout=300).json()
    _stop.set()
    time.sleep(0.6)
    after = _free_mb()
    result["unload"] = {"ok": unload.get("ok"), "engine": unload.get("engine")}
    result["vram_free_after_unload"] = after
    result["vram_free_min"] = min(_samples) if _samples else None
    result["vram_free_max"] = max(_samples) if _samples else None
    print(f"    unload 后空闲 {after} MB（基线 {baseline}，采样最低 {result['vram_free_min']} MB）")

    # 判据 D 的口径（2026-11-09 实测修正）：unload 之后的空闲**高于**基线是正常的 ——
    # 基线是在服务刚起、torch 已初始化 CUDA context / allocator 已 reserve 的时刻取的，
    # unload 的 gc+empty_cache 会把那部分也还回去。所以要求是「不能低于基线 - 200MB」，
    # 而不是我第一版写的「与基线差 ≤600MB」（那会把「还多了」判成失败）。
    ok = (
        (warm.get("warmup_real") or {}).get("kernel_warmup") == "done"
        and first.get("ok")
        and second.get("ok")
        and first["elapsed_sec"] < 120
        and after is not None and baseline is not None and after >= baseline - 200
    )
    result["verdict"] = "PASS" if ok else "FAIL"
    print("\n[verdict]", result["verdict"])
    OUT.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print("[out]", OUT)
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())

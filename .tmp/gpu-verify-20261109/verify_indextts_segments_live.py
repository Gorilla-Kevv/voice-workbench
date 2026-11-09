# -*- coding: utf-8 -*-
"""真机验证：IndexTTS 5500 显存门槛 + /v1/synth/segments 分段情感（阶段 46 遗留）。

    indextts/upstream/.venv/Scripts/python.exe .tmp/gpu-verify-20261109/verify_indextts_segments_live.py

覆盖三件事：
  A. 5500 MB 门槛在真机上放行并成功装载（坑 79 校准值；3072 会放进假死）；
  B. `/v1/synth` 单段情感向量可用（8 维）；
  C. `/v1/synth/segments` 两段不同情感 + 段间停顿，服务端拼接成一条——验收时长与逐段时长之和
     + gap 是否对得上、拼接是否成功；
  D. `/v1/unload` 归还显存（先 gc 再 empty_cache 的顺序，坑 79）。

旁路采样 nvidia-smi 记录常驻/峰值；产物与 JSON 落在本目录。
"""

from __future__ import annotations

import json
import subprocess
import threading
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[2]
BASE = "http://127.0.0.1:9883"
OUT = Path(__file__).resolve().parent
REF_ZH = ROOT / "voicelib" / "voices" / "f9111eb8bbfe.wav"  # zh 3.28s

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
    result: dict = {"base": BASE, "ref": str(REF_ZH)}
    if not REF_ZH.is_file():
        print(f"[skip] 参考音频不存在：{REF_ZH}")
        return 0
    health = requests.get(f"{BASE}/health", timeout=60).json()
    print("[1] health:", json.dumps({k: health.get(k) for k in ("ok", "engine", "gpu")}, ensure_ascii=False)[:400])
    catalog = requests.get(f"{BASE}/v1/catalog", timeout=60).json()
    result["catalog_limits"] = {
        "required_vram_mb": catalog.get("required_vram_mb"),
        "segment_synthesis": catalog.get("segment_synthesis"),
        "emo_dimensions": catalog.get("emo_dimensions"),
        "emo_alpha": catalog.get("emo_alpha"),
    }
    print("    catalog: required =", result["catalog_limits"]["required_vram_mb"],
          "| segment =", json.dumps(result["catalog_limits"]["segment_synthesis"], ensure_ascii=False))
    print("    emo_dimensions:", json.dumps(result["catalog_limits"]["emo_dimensions"], ensure_ascii=False))

    baseline = _free_mb()
    result["vram_free_baseline"] = baseline
    print(f"    基线空闲显存 = {baseline} MB")
    thread = threading.Thread(target=_sampler, daemon=True)
    thread.start()

    print("[2] POST /v1/warmup（IndexTTS 装载；权重已本地化，正常约 10~60s）...")
    started = time.monotonic()
    warm = requests.post(f"{BASE}/v1/warmup", timeout=1800).json()
    load_sec = time.monotonic() - started
    loaded_free = _free_mb()
    result["warmup"] = {"ok": warm.get("ok"), "wall_sec": round(load_sec, 1), "free_after_mb": loaded_free,
                        "engine": warm.get("engine") or warm.get("pipeline")}
    print(f"    装载 {load_sec:.1f}s | 装载后空闲 {loaded_free} MB | 常驻增量 "
          f"{baseline - loaded_free if baseline and loaded_free else '?'} MB")
    print("    engine:", json.dumps(warm.get("engine") or warm.get("pipeline"), ensure_ascii=False)[:300])

    if not warm.get("ok"):
        print("[x] warmup 失败:", json.dumps(warm, ensure_ascii=False)[:800])
        _stop.set()
        return 1

    # 8 维情感向量：目录里的维度顺序（喜/怒/哀/惧/厌恶/低落/惊喜/平静）
    vec_calm = [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0]
    vec_happy = [1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]

    print("[3] POST /v1/synth（单段 + 8 维情感向量）...")
    t0 = time.monotonic()
    single = requests.post(
        f"{BASE}/v1/synth",
        data={"text": "单段情感模式的实测。", "lang": "ZH", "ref_path": str(REF_ZH),
              "emo_vector": json.dumps(vec_happy), "emo_alpha": "0.7"},
        timeout=1800,
    )
    if single.status_code != 200:
        print("[x] 单段失败:", single.status_code, single.text[:600])
        result["single"] = {"status": single.status_code, "error": single.text[:600]}
    else:
        body = single.json()
        result["single"] = {k: body.get(k) for k in ("duration_sec", "elapsed_sec", "sample_rate", "path")}
        result["single"]["wall_sec"] = round(time.monotonic() - t0, 2)
        print("    ok:", json.dumps(result["single"], ensure_ascii=False))

    print("[4] POST /v1/synth/segments（两段不同情感 + 段间停顿）...")
    segments = [
        {"text": "前半段，先把语速放慢一点，语气平静。", "emo_vector": vec_calm, "emo_alpha": 0.8},
        {"text": "后半段，情绪开始上扬，声音明快起来。", "emo_vector": vec_happy, "emo_alpha": 0.8},
    ]
    gap_ms = 150
    t0 = time.monotonic()
    seg_response = requests.post(
        f"{BASE}/v1/synth/segments",
        data={"segments": json.dumps(segments, ensure_ascii=False), "lang": "ZH",
              "ref_path": str(REF_ZH), "gap_ms": str(gap_ms)},
        timeout=1800,
    )
    if seg_response.status_code != 200:
        print("[x] 分段失败:", seg_response.status_code, seg_response.text[:800])
        result["segments"] = {"status": seg_response.status_code, "error": seg_response.text[:800]}
    else:
        body = seg_response.json()
        parts = body.get("segments") or []
        sum_parts = sum(float(part.get("duration_sec") or 0) for part in parts)
        expected = sum_parts + gap_ms / 1000.0 * max(0, len(parts) - 1)
        result["segments"] = {
            "duration_sec": body.get("duration_sec"),
            "elapsed_sec": body.get("elapsed_sec"),
            "wall_sec": round(time.monotonic() - t0, 2),
            "sample_rate": body.get("sample_rate"),
            "path": body.get("path"),
            "parts": [{k: part.get(k) for k in ("index", "duration_sec", "elapsed_sec", "emo_alpha")} for part in parts],
            "sum_parts_sec": round(sum_parts, 3),
            "expected_with_gap_sec": round(expected, 3),
            "concat_matches": abs(float(body.get("duration_sec") or 0) - expected) < 0.05,
        }
        print("    ok:", json.dumps({k: result["segments"][k] for k in
                                     ("duration_sec", "sum_parts_sec", "expected_with_gap_sec", "concat_matches")},
                                    ensure_ascii=False))
        import base64  # noqa: PLC0415

        audio = base64.b64decode(body["audio_base64"])
        target = OUT / "indextts_segments_live.wav"
        target.write_bytes(audio)
        print("    产物:", target, len(audio), "bytes")

    print("[5] POST /v1/unload ...")
    unload = requests.post(f"{BASE}/v1/unload", timeout=600).json()
    _stop.set()
    time.sleep(0.8)
    after = _free_mb()
    result["unload"] = {"ok": unload.get("ok"), "engine": unload.get("engine") or unload.get("pipeline")}
    result["vram_free_after_unload"] = after
    result["vram_free_min"] = min(_samples) if _samples else None
    result["vram_free_max"] = max(_samples) if _samples else None
    result["vram_resident_mb"] = (baseline - loaded_free) if baseline and loaded_free else None
    print(f"    unload 后空闲 {after} MB（基线 {baseline}，采样最低 {result['vram_free_min']}）")

    ok = (
        warm.get("ok") is True
        and (result.get("single") or {}).get("duration_sec")
        and (result.get("segments") or {}).get("concat_matches") is True
        and after is not None and baseline is not None and abs(after - baseline) <= 800
    )
    result["verdict"] = "PASS" if ok else "FAIL"
    print("\n[verdict]", result["verdict"])
    (OUT / "indextts_segments_result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())

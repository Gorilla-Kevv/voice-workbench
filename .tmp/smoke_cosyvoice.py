"""阶段 48 真机冒烟：CosyVoice3 零样本 / instruct2 / 跨语种。

服务需先跑在 127.0.0.1:9886。脚本会：
1) 等 /health；2) warmup 并记录加载耗时与显存；3) 用音色库 f9111eb8bbfe（zh, 3.28s wav）
   跑三条合成；4) 落盘 WAV 到 .tmp/ 并打印 RTF / 显存；5) unload。
"""

from __future__ import annotations

import base64
import json
import subprocess
import time
import urllib.request
from pathlib import Path

BASE = "http://127.0.0.1:9886"
ROOT = Path(__file__).resolve().parent.parent
VOICE_ID = "f9111eb8bbfe"


def smi() -> str:
    try:
        return subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.used,memory.free", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=10,
        ).stdout.strip()
    except Exception as error:
        return f"n/a ({error})"


def request(path: str, payload: dict | None = None, timeout: int = 900) -> dict:
    data = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        BASE + path,
        data=data,
        headers={"Content-Type": "application/json"} if data is not None else {},
        method="POST" if data is not None or path.endswith(("warmup", "unload")) else "GET",
    )
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def main() -> None:
    print("VRAM before:", smi())
    for _ in range(120):
        try:
            health = request("/health", timeout=10)
            if health.get("ok"):
                break
        except Exception:
            pass
        time.sleep(1)
    else:
        raise SystemExit("service not reachable")

    print("health.weights.ready =", health["weights"]["ready"], "loaded =", health["loaded"])
    if not health["weights"]["ready"]:
        raise SystemExit(f"weights missing: {health['weights']['missing']}")

    started = time.time()
    print("warmup:", request("/v1/warmup", {}))
    print(f"warmup wall = {time.time() - started:.1f}s")
    print("VRAM after load:", smi())

    voice = None
    for item in json.loads((ROOT / "voicelib" / "voices.json").read_text(encoding="utf-8")):
        if item.get("id") == VOICE_ID:
            voice = item
            break
    if voice is None:
        raise SystemExit(f"voice {VOICE_ID} not found")

    cases = [
        ("zero", {
            "text": "你好，这是 CosyVoice 3 的本地零样本合成测试。",
            "mode": "zero_shot",
            "ref_voice": VOICE_ID,
            "prompt_text": voice.get("prompt_text") or "",
            "speed": 1.0,
        }),
        ("instruct_dialect", {
            "text": "今天天气巴适得很，我们出去耍一哈。",
            "mode": "instruct2",
            "ref_voice": VOICE_ID,
            "prompt_text": voice.get("prompt_text") or "",
            "instruct_text": "用四川话说这句话<|endofprompt|>",
            "speed": 1.0,
        }),
        ("cross_lingual_ja", {
            "text": "これはクロスリンガルのテストです。",
            "mode": "cross_lingual",
            "ref_voice": VOICE_ID,
            "language": "ja",
            "speed": 1.0,
        }),
    ]

    for name, payload in cases:
        before = smi()
        started = time.time()
        try:
            result = request("/v1/synth", payload)
            wall = time.time() - started
            audio = base64.b64decode(result["audio_base64"])
            out = ROOT / ".tmp" / f"cosyvoice_smoke_{name}.wav"
            out.write_bytes(audio)
            print(
                f"[{name}] ok wall={wall:.1f}s duration={result['duration_sec']}s "
                f"rtf={result['rtf']} sr={result['sample_rate']} bytes={len(audio)} "
                f"vram_before={before} vram_after={smi()} -> {out}"
            )
        except Exception as error:
            body = ""
            if hasattr(error, "read"):
                body = error.read().decode("utf-8", "replace")[:500]
            print(f"[{name}] FAILED {type(error).__name__}: {error} {body}")

    print("unload:", request("/v1/unload", {}))
    print("VRAM after unload:", smi())


if __name__ == "__main__":
    main()

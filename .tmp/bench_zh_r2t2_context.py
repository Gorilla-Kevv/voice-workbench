# -*- coding: utf-8 -*-
"""用 R2T2 CPU 通道复核 3 条参考有歧义的中文片段（不占显存）。"""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]  # 仓库根（原来写死本机绝对路径）
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
VENV_PY = ROOT / "netease" / "r2t2-venv" / "Scripts" / "python.exe"
WORKER = ROOT / "netease" / "app" / "r2t2_worker.py"
MODEL = ROOT / "netease" / "models" / "Confucius4-R2T2"
CLIPS = json.loads((ROOT / ".tmp" / "asr_bench_zh" / "clips.json").read_text(encoding="utf-8"))
TARGETS = {"zh_01", "zh_06", "zh_08"}


def main() -> int:
    proc = subprocess.Popen(
        [str(VENV_PY), str(WORKER), "--model", str(MODEL), "--backend", "transformers", "--device", "cpu"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=None,
        text=True, encoding="utf-8", errors="replace",
        env={**os.environ, "PYTHONIOENCODING": "utf-8"},
    )

    def send(payload):
        proc.stdin.write(json.dumps(payload, ensure_ascii=False) + "\n")
        proc.stdin.flush()

    def recv(want, timeout=1200):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            line = proc.stdout.readline()
            if not line:
                raise RuntimeError("worker stdout 关闭")
            line = line.strip()
            if not line:
                continue
            msg = json.loads(line)
            if msg.get("type") == "log":
                print("  ·", msg.get("line", ""))
                continue
            if msg.get("type") == "ready":
                print("  · [ready]")
                continue
            if msg.get("id") == want:
                return msg
        raise RuntimeError("timeout %s" % want)

    try:
        send({"type": "ping", "id": "p"})
        print("ping", recv("p", 30).get("type"))
        t = time.time()
        send({"type": "load", "id": "load"})
        r = recv("load", 1500)
        if r.get("type") == "error":
            print("[x] load", r.get("message"))
            return 1
        print("load %.1fs" % (time.time() - t))
        for clip in CLIPS:
            if clip["id"] not in TARGETS:
                continue
            t = time.time()
            send({"type": "transcribe", "id": clip["id"], "path": clip["path"], "language": "zh", "return_timestamps": False})
            r = recv(clip["id"], 600)
            if r.get("type") == "error":
                print(clip["id"], "[x]", r.get("message"))
                continue
            print("%s %.2fs | %s" % (clip["id"], time.time() - t, r.get("text")))
        return 0
    finally:
        try:
            send({"type": "shutdown", "id": "bye"})
            proc.wait(timeout=15)
        except Exception:
            proc.kill()


if __name__ == "__main__":
    raise SystemExit(main())

# -*- coding: utf-8 -*-
"""同一批中文 8 段：R2T2 CPU 转写 + 与 SenseVoice/Paraformer 同参考 CER。"""
import importlib.util
import json
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]  # 仓库根（原来写死本机绝对路径）
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
OUT = ROOT / ".tmp" / "asr_bench_zh"
VENV_PY = ROOT / "netease" / "r2t2-venv" / "Scripts" / "python.exe"
WORKER = ROOT / "netease" / "app" / "r2t2_worker.py"
MODEL = ROOT / "netease" / "models" / "Confucius4-R2T2"
CLIPS = json.loads((OUT / "clips.json").read_text(encoding="utf-8"))

spec = importlib.util.spec_from_file_location("b", ROOT / ".tmp" / "bench_zh_models.py")
bench = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bench)


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

    def recv(want, timeout=1500):
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
                continue
            if msg.get("id") == want:
                return msg
        raise RuntimeError("timeout %s" % want)

    rows = []
    try:
        send({"type": "ping", "id": "p"})
        recv("p", 30)
        t = time.time()
        send({"type": "load", "id": "load"})
        r = recv("load", 1800)
        if r.get("type") == "error":
            print("[x] load", r.get("message"))
            return 1
        load_s = time.time() - t
        print("R2T2 CPU load %.1fs" % load_s)
        for clip in CLIPS:
            t = time.time()
            send({"type": "transcribe", "id": clip["id"], "path": clip["path"], "language": "zh", "return_timestamps": False})
            r = recv(clip["id"], 900)
            wall = time.time() - t
            text = "" if r.get("type") == "error" else (r.get("text") or "")
            ref = bench.norm(clip["ref"])
            hyp = bench.norm(text)
            ops = bench.edit_ops(ref, hyp)
            row = {
                "id": clip["id"],
                "label": clip["label"],
                "duration_s": clip["duration_s"],
                "rms_dbfs": clip["rms_dbfs"],
                "ref": clip["ref"],
                "ref_norm": ref,
                "text": text,
                "hyp_norm": hyp,
                "ops": ops,
                "cer": round(ops["edits"] / len(ref), 4) if ref else None,
                "elapsed_s": r.get("elapsed_sec") if r.get("type") != "error" else None,
                "wall_s": round(wall, 2),
            }
            rows.append(row)
            print("%s %4.1fs cer=%.3f | %s" % (clip["id"], wall, row["cer"] or 0, text[:70]))
        return 0
    finally:
        try:
            proc.stdin.write(json.dumps({"type": "shutdown", "id": "bye"}) + "\n")
            proc.stdin.flush()
            proc.wait(timeout=15)
        except Exception:
            proc.kill()
        payload = {"model": "Confucius4-R2T2", "device": "cpu", "load_s": round(load_s, 2), "rows": rows}
        (OUT / "r2t2_cpu.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        ref_total = sum(len(r["ref_norm"]) for r in rows)
        edit_total = sum(r["ops"]["edits"] for r in rows)
        print("R2T2 CPU micro CER %.1f%% (%d/%d)" % (100 * edit_total / ref_total, edit_total, ref_total))
        print("wrote", OUT / "r2t2_cpu.json")


if __name__ == "__main__":
    raise SystemExit(main())

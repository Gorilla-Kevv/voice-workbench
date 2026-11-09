"""验证本轮两个修复的闭环：

A. **音频失真修复**（`audio/io.py::save()` 的 int16 强转）——
   走真实 HTTP 变声接口，检查产物不再削波。这是用户报的「增益过大、全部失真」。

B. **训练记录不再随重启丢失**——
   `/v1/jobs?kind=vc_train` 能取到历史训练任务（含产物清单），
   且 `artifacts.artifacts` 里每件产物都带本机绝对路径。

C. **手动命名**——`POST /v1/vc/models/rename` 能改名，且配套 `.index` 一起改。

前置：服务已在 127.0.0.1:19881；本机系统代理会拦 127.0.0.1，先清代理变量。
"""

from __future__ import annotations

import io
import json
import os
import sys
import urllib.error
import urllib.request
import uuid
import wave
from pathlib import Path

for key in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"):
    os.environ.pop(key, None)

import numpy as np  # noqa: E402

BASE = "http://127.0.0.1:19881"
ROOT = Path(__file__).resolve().parents[1]
TMP = ROOT / ".tmp"

passed = 0
failed = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global passed, failed
    if ok:
        passed += 1
        print("  [PASS] %s" % name)
    else:
        failed += 1
        print("  [FAIL] %s %s" % (name, detail))


def request(method: str, path: str, data: bytes | None = None, headers: dict | None = None, timeout: int = 600):
    req = urllib.request.Request(BASE + path, data=data, method=method, headers=headers or {})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read()
        ctype = resp.headers.get("Content-Type", "")
        if "json" in ctype:
            return resp.status, json.loads(body.decode("utf-8"))
        return resp.status, body


def multipart(fields: dict, files: dict) -> tuple[bytes, str]:
    boundary = "----wb" + uuid.uuid4().hex
    body = io.BytesIO()
    for key, value in fields.items():
        body.write(("--%s\r\n" % boundary).encode())
        body.write(('Content-Disposition: form-data; name="%s"\r\n\r\n' % key).encode())
        body.write(str(value).encode() + b"\r\n")
    for key, (filename, content, ctype) in files.items():
        body.write(("--%s\r\n" % boundary).encode())
        body.write(('Content-Disposition: form-data; name="%s"; filename="%s"\r\n' % (key, filename)).encode())
        body.write(("Content-Type: %s\r\n\r\n" % ctype).encode())
        body.write(content + b"\r\n")
    body.write(("--%s--\r\n" % boundary).encode())
    return body.getvalue(), "multipart/form-data; boundary=%s" % boundary


def wav_stats(path: Path) -> dict:
    with wave.open(str(path), "rb") as handle:
        frames = handle.readframes(handle.getnframes())
        rate = handle.getframerate()
        n = handle.getnframes()
    samples = np.frombuffer(frames, dtype=np.int16).astype(np.int64)
    peak = int(np.abs(samples).max()) if samples.size else 0
    clipped = float((np.abs(samples) >= 32760).mean()) if samples.size else 0.0
    rms = float(np.sqrt((samples.astype(np.float64) ** 2).mean())) if samples.size else 0.0
    return {"rate": rate, "seconds": n / rate if rate else 0, "peak": peak, "clip_ratio": clipped, "rms": rms}


print("== A. 音频失真修复（走真实变声接口）==")
# 造一段 6 秒语音样输入
sr = 16000
t = np.arange(sr * 6) / sr
f0 = 160 + 40 * np.sin(2 * np.pi * 0.4 * t)
phase = np.cumsum(2 * np.pi * f0 / sr)
probe = (0.25 * np.sin(phase) * (0.6 + 0.4 * np.sin(2 * np.pi * 0.8 * t))).astype(np.float32)
probe_path = TMP / "fix_probe_in.wav"
import soundfile as sf  # noqa: E402

sf.write(str(probe_path), probe, sr, subtype="PCM_16")

payload, ctype = multipart(
    {"model": "aiyi", "f0_method": "rmvpe", "wait": "true"},
    {"file": ("probe.wav", probe_path.read_bytes(), "audio/wav")},
)
try:
    status, result = request("POST", "/v1/vc/convert", payload, {"Content-Type": ctype})
except urllib.error.HTTPError as exc:
    status, result = exc.code, json.loads(exc.read().decode("utf-8"))

check("变声请求 HTTP 200", status == 200, str(status))
if status == 200 and isinstance(result, dict):
    url = (result.get("urls") or {}).get("output")
    check("返回可播放 Web 路径", bool(url), str(result)[:200])
    if url:
        _, raw = request("GET", url)
        out_file = TMP / "fix_probe_out.wav"
        out_file.write_bytes(raw if isinstance(raw, bytes) else b"")
        stats = wav_stats(out_file)
        print("      产物：%dHz · %.1fs · peak=%d · 削波=%.3f%% · rms=%.0f" % (
            stats["rate"], stats["seconds"], stats["peak"], stats["clip_ratio"] * 100, stats["rms"]))
        check("产物无明显削波（<0.5%）", stats["clip_ratio"] < 0.005, "clip=%.3f%%" % (stats["clip_ratio"] * 100))
        check("产物峰值未顶满量程", stats["peak"] < 32760, "peak=%d" % stats["peak"])
else:
    check("变声返回可解析", False, str(result)[:200])

print("== B. 训练记录持久化（/v1/jobs?kind=vc_train）==")
status, listing = request("GET", "/v1/jobs?kind=vc_train&limit=30")
check("HTTP 200", status == 200, str(status))
jobs = listing.get("jobs", []) if isinstance(listing, dict) else []
print("      训练任务数：%d" % len(jobs))
# 只要存在任一成功任务且带产物清单，就说明链路通
with_artifacts = [
    j for j in jobs
    if isinstance(j.get("artifacts"), dict) and j["artifacts"].get("artifacts")
]
if jobs:
    check("列表里每个任务都有 id/name/state", all(j.get("id") and j.get("name") and j.get("state") for j in jobs))
if with_artifacts:
    sample = with_artifacts[0]
    entries = sample["artifacts"]["artifacts"]
    print("      样例任务 %s（%s）产物 %d 件" % (sample["id"], sample.get("state"), len(entries)))
    check("产物项带本机绝对路径", all(isinstance(e.get("path"), str) and e["path"] for e in entries))
    check("产物项带体积", all(isinstance(e.get("size_mb"), (int, float)) for e in entries))
    check("产物路径确实存在", all(Path(e["path"]).is_file() for e in entries),
          "; ".join(e["path"] for e in entries if not Path(e["path"]).is_file())[:160])
else:
    print("      （本机暂无带产物的训练记录，跳过产物断言）")

print("== C. 手动命名（POST /v1/vc/models/rename）==")
# 造一个可改名的模型（直接拷贝 aiyi + 一个假索引）
models_dir = ROOT / "trainer" / ".data" / "vc" / "models"
src_model = models_dir / "aiyi.pth"
if not src_model.is_file():
    src_model = next(iter(sorted(models_dir.glob("*.pth"))), None)
check("存在可用于改名的源模型", src_model is not None and src_model.is_file())
if src_model is not None and src_model.is_file():
    old_stem = "renametest_%s" % uuid.uuid4().hex[:6]
    new_stem = "renamed_%s" % uuid.uuid4().hex[:6]
    old_model = models_dir / ("%s.pth" % old_stem)
    old_index = models_dir / ("%s.index" % old_stem)
    old_model.write_bytes(src_model.read_bytes())
    old_index.write_bytes(b"fake-index-bytes")

    payload, ctype = multipart({"model": old_stem, "name": new_stem}, {})
    status, renamed = request("POST", "/v1/vc/models/rename", payload, {"Content-Type": ctype})
    check("改名 HTTP 200", status == 200, str(status))
    check("ok=True", isinstance(renamed, dict) and renamed.get("ok") is True, str(renamed)[:200])
    new_model = models_dir / ("%s.pth" % new_stem)
    new_index = models_dir / ("%s.index" % new_stem)
    check("新 .pth 已就位", new_model.is_file())
    check("旧 .pth 已消失", not old_model.exists())
    check("配套 .index 一起改名", new_index.is_file() and not old_index.exists(),
          "new_index=%s old_index_exists=%s" % (new_index.is_file(), old_index.exists()))
    check("rename 回包带新名称", isinstance(renamed, dict) and renamed.get("name") == new_stem, str(renamed)[:160])

    # 规范化：带非法字符的名字应被清洗而不是直接失败
    payload, ctype = multipart({"model": new_stem, "name": "bad/name:v2"}, {})
    status, renamed2 = request("POST", "/v1/vc/models/rename", payload, {"Content-Type": ctype})
    check("非法字符名被规范化而非报错", status == 200 and isinstance(renamed2, dict) and "bad_name_v2" in str(renamed2),
          str(renamed2)[:160])
    # 清理
    for p in models_dir.glob("%s*" % new_stem):
        p.unlink(missing_ok=True)
    for p in models_dir.glob("bad_name_v2*"):
        p.unlink(missing_ok=True)

print()
print("结果：%d 通过 / %d 失败" % (passed, failed))
sys.exit(0 if failed == 0 else 1)

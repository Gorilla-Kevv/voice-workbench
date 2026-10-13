"""Irodori 推理链路验证（阶段 30-2）。

用法：
    python .tmp/verify_irodori_infer.py [port] [--gateway]

- 不带 --gateway：直连 Python 服务（默认 127.0.0.1:9884）；
- 带 --gateway：追测网关透传（/api/irodori/*、/api/health 的 irodori 摘要、
  /api/irodori/service 开关状态），网关默认 127.0.0.1:8787（--gw-port 可改）。

要点：
- 全部走 urllib + 显式 UTF-8（坑 54：Git Bash 的 curl 会把中文转 GBK，不用它）；
- 脚本里清掉 http_proxy（本机系统代理会拦 127.0.0.1）；
- 分四段：A 基础与校验（不需要模型）；B 切句单元（直接 import，不需要 torch）；
  C 真机合成（需要显存 ≥ 4700 MB，不足时如实跳过并保持退出码 0——环境阻塞不是代码缺陷）；
  D 网关透传（--gateway 时）。
"""

from __future__ import annotations

import base64
import io
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "irodori"))

for key in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"):
    os.environ.pop(key, None)

PORT = 9884
GW_PORT = 8787
WITH_GATEWAY = False
for arg in sys.argv[1:]:
    if arg == "--gateway":
        WITH_GATEWAY = True
    elif arg.startswith("--gw-port="):
        GW_PORT = int(arg.split("=", 1)[1])
    elif arg.isdigit():
        PORT = int(arg)

BASE = f"http://127.0.0.1:{PORT}"
GW = f"http://127.0.0.1:{GW_PORT}"

PASS = 0
FAIL = 0
FAILURES: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    global PASS, FAIL
    mark = "✓" if ok else "✗"
    print(f"  [{mark}] {name}" + (f"  —— {detail}" if detail and not ok else ""))
    if ok:
        PASS += 1
    else:
        FAIL += 1
        FAILURES.append(f"{name}: {detail}")


def request(method: str, url: str, payload: dict | None = None, timeout: float = 60.0):
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return res.status, json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        try:
            return error.code, json.loads(body)
        except json.JSONDecodeError:
            return error.code, {"raw": body}


# ---------------------------------------------------------------- A. 基础与校验

JA_TEXTS = [
    "今日はいい天気ですね、一緒に散歩しましょう。",
    "人工知能の発展により、音声合成はほぼ人間と区別がつかなくなりましたが、感情の細かい表現は今も課題です。",
    "彼は自分で学ぶだけでなく、クラスの友達を助けるのも喜んでやりました。",
    "2026年10月8日の午後3時15分から、会議は1時間30分続き、参加者は27人です。",
    "この文を落ち着いた調子で読んでください、区切りと強調の位置を間違えないでね。",
    "本日はお忙しい中、私たちの発表会にご参加いただき、誠にありがとうございます。この一年の成果を振り返るとともに、これからの方向性をご提案します。",
]

# 音色库第一条（男声 5.44s，阶段 28 用它做的克隆基准）
VOICE_ID = "842e1988abc8"


def make_short_wav(path: Path, seconds: float = 1.0) -> None:
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(48000)
        handle.writeframes(b"\x00\x00" * int(48000 * seconds))


def main() -> int:
    print(f"== A. 基础与校验（{BASE}）==")

    status, health = request("GET", f"{BASE}/health")
    check("A1 /health 200", status == 200, f"status={status} {health}")
    # ⚠️ 这条（以及 C0）**要求服务处于「刚起、未加载模型」的状态**。
    # 服务已经 warmup 过时它们会「失败」，但那是前置假设不成立，不是代码缺陷 ——
    # 想跑全绿就先重启服务再跑本脚本。
    check("A2 loaded 初始 false", health.get("loaded") is False, str(health.get("loaded")))
    check("A3 required_vram_mb=4700（服务端真源）",
          health.get("configuration", {}).get("required_vram_mb") == 4700,
          str(health.get("configuration", {}).get("required_vram_mb")))
    check("A4 watermark=false", health.get("watermark") is False, str(health.get("watermark")))
    check("A5 自报 PID", isinstance(health.get("pid"), int), str(health.get("pid")))
    check("A6 推理权重就绪", health.get("weights", {}).get("ready") is True,
          json.dumps(health.get("weights", {}).get("missing", []), ensure_ascii=False))

    status, cat = request("GET", f"{BASE}/v1/catalog")
    check("A7 /v1/catalog 200", status == 200, f"status={status}")
    check("A8 emoji 从上游常量取 56 个", cat.get("emoji", {}).get("count") == 56,
          str(cat.get("emoji", {}).get("count")))
    labels = {item["emoji"]: item["label"] for item in cat.get("emoji", {}).get("items", [])}
    check("A9 官方释义解析成功（🤭=笑い）", labels.get("🤭") == "笑い", str(labels.get("🤭")))
    check("A10 步数默认 20 + 档位含 40",
          cat.get("steps", {}).get("default") == 20
          and 40 in [p["value"] for p in cat.get("steps", {}).get("presets", [])],
          json.dumps(cat.get("steps", {}), ensure_ascii=False)[:120])
    check("A11 仅日语 + max_ref_seconds=120",
          cat.get("language", {}).get("supported") == ["ja"]
          and cat.get("reference", {}).get("max_ref_seconds") == 120,
          json.dumps({"lang": cat.get("language"), "ref": cat.get("reference")}, ensure_ascii=False)[:160])

    status, speakers = request("GET", f"{BASE}/v1/speakers")
    check("A12 /v1/speakers 幂等空表", status == 200 and speakers.get("count") == 0,
          f"status={status} {speakers}")

    short_wav = ROOT / ".tmp" / "irodori_short_ref.wav"
    make_short_wav(short_wav, 1.0)

    cases = [
        ("A13 中文文本 → NO_JA_ONLY",
         {"text": "你好世界，这是一段中文。", "ref_voice": VOICE_ID}, 400, "NO_JA_ONLY"),
        ("A14 缺参考 → REF_REQUIRED",
         {"text": "こんにちは、テストです。"}, 400, "REF_REQUIRED"),
        ("A15 ref_voice+speaker_id → REF_CONFLICT",
         {"text": "こんにちは", "ref_voice": VOICE_ID, "speaker_id": "x"}, 400, "REF_CONFLICT"),
        ("A16 ref_voice+ref_path → REF_CONFLICT",
         {"text": "こんにちは", "ref_voice": VOICE_ID, "ref_path": "C:/x.wav"}, 400, "REF_CONFLICT"),
        ("A17 未知音色 → VOICE_NOT_FOUND",
         {"text": "こんにちは", "ref_voice": "no-such-voice"}, 400, "VOICE_NOT_FOUND"),
        ("A18 短参考 → REF_TOO_SHORT",
         {"text": "こんにちは", "ref_path": str(short_wav)}, 400, "REF_TOO_SHORT"),
        ("A19 num_steps=0 → BAD_REQUEST",
         {"text": "こんにちは", "ref_voice": VOICE_ID, "num_steps": 0}, 400, "BAD_REQUEST"),
        ("A20 duration_scale=2.0 → BAD_REQUEST",
         {"text": "こんにちは", "ref_voice": VOICE_ID, "duration_scale": 2.0}, 400, "BAD_REQUEST"),
        ("A21 schedule 非法 → BAD_REQUEST",
         {"text": "こんにちは", "ref_voice": VOICE_ID, "schedule": "fast"}, 400, "BAD_REQUEST"),
    ]
    for name, payload, want_status, want_code in cases:
        status, body = request("POST", f"{BASE}/v1/synth", payload)
        code = body.get("error", {}).get("code")
        hint = body.get("error", {}).get("hint", "")
        check(name, status == want_status and code == want_code and bool(hint),
              f"status={status} code={code} body={json.dumps(body, ensure_ascii=False)[:200]}")

    print(f"== B. 切句单元（直接 import，不需要 torch）==")
    from app.synth import SEGMENT_MAX_CHARS, split_sentences  # noqa: E402

    long_text = "人工知能の発展により、音声合成はほぼ人間と区別がつかなくなりました。感情の細かい表現は今も課題です。"
    chunks = split_sentences(long_text)
    check("B1 全部片段 ≤25 字", all(len(c) <= SEGMENT_MAX_CHARS for c in chunks) and len(chunks) >= 2,
          str([f"{len(c)}:{c}" for c in chunks]))
    merged = "".join(chunks)
    check("B2 拼接回原文不丢字（去空格）", merged.replace(" ", "") == long_text.replace(" ", ""),
          f"{merged!r}")

    emoji_text = "今日の会議は午後三時に変更になりました😊"
    emoji_chunks = split_sentences(emoji_text)
    check("B3 emoji 跟随句子不被切丢", len(emoji_chunks) == 1 and "😊" in emoji_chunks[0],
          str(emoji_chunks))

    no_punct = "这是一段完全没有标点的很长文本" * 5  # 110 字，无句读
    hard = split_sentences(no_punct)
    check("B4 无句读硬切仍 ≤25", all(len(c) <= SEGMENT_MAX_CHARS for c in hard) and hard,
          str([len(c) for c in hard]))

    print("== C. 真机合成（需要显存 ≥ 4700 MB；不足则如实跳过）==")
    free_mb = health.get("vram", {}).get("free_mb") or 0
    if free_mb < 4700:
        ok, detail = _expect_vram_reject()
        check("C0 显存不足 → warmup 必须被 503 拦下（准入路径本身就是交付物）", ok, detail)
        print(f"  ! 显存 {free_mb} MB < 4700 MB：C 段真合成跳过（环境阻塞，非代码缺陷）")
        print("    补测命令：腾出显存后 python .tmp/verify_irodori_infer.py")
    else:
        _run_real_synth_suite()

    if WITH_GATEWAY:
        print(f"== D. 网关透传（{GW}）==")
        _run_gateway_suite()

    print(f"\n通过 {PASS} / {PASS + FAIL}")
    if FAILURES:
        print("失败项：")
        for item in FAILURES:
            print(f"  - {item}")
    return 1 if FAIL else 0


def _expect_vram_reject() -> tuple[bool, str]:
    status, body = request("POST", f"{BASE}/v1/warmup", {}, timeout=30)
    code = body.get("error", {}).get("code")
    details = body.get("error", {}).get("details", {})
    ok = status == 503 and code == "VRAM_INSUFFICIENT" and "free_mb" in details and "required_mb" in details
    return ok, f"status={status} body={json.dumps(body, ensure_ascii=False)[:200]}"


def _run_real_synth_suite() -> None:
    started = time.perf_counter()
    status, body = request("POST", f"{BASE}/v1/warmup", {}, timeout=600)
    load_elapsed = time.perf_counter() - started
    check("C1 warmup 200", status == 200, f"status={status} {json.dumps(body, ensure_ascii=False)[:200]}")
    check("C2 加载耗时 ~20s 量级", 5 <= load_elapsed <= 120, f"{load_elapsed:.1f}s")

    _, health = request("GET", f"{BASE}/health")
    check("C3 /health.loaded=true", health.get("loaded") is True, str(health.get("loaded")))

    text = JA_TEXTS[0]
    started = time.perf_counter()
    status, body = request("POST", f"{BASE}/v1/synth",
                           {"text": text, "ref_voice": VOICE_ID, "seed": 1234}, timeout=600)
    elapsed = time.perf_counter() - started
    check("C4 首句合成 200", status == 200, f"status={status} {json.dumps(body, ensure_ascii=False)[:240]}")
    if status == 200:
        check("C5 采样率 48000", body.get("sample_rate") == 48000, str(body.get("sample_rate")))
        check("C6 时长/RTF 合理", body.get("duration_sec", 0) > 1 and (body.get("rtf") or 9) < 1.0,
              f"duration={body.get('duration_sec')} rtf={body.get('rtf')}")
        audio = base64.b64decode(body.get("audio_base64", ""))
        check("C7 base64 是合法 WAV（RIFF 头）", audio[:4] == b"RIFF", audio[:8].hex())

    rtfs = []
    for i, sentence in enumerate(JA_TEXTS):
        started = time.perf_counter()
        status, body = request("POST", f"{BASE}/v1/synth",
                               {"text": sentence, "ref_voice": VOICE_ID, "seed": 100 + i}, timeout=600)
        wall = time.perf_counter() - started
        rtf = (body.get("rtf") if status == 200 else None) or 99
        rtfs.append((sentence[:12], status, rtf, wall, body))
        print(f"    句{i + 1}: status={status} rtf={rtf if rtf < 90 else '-'} wall={wall:.2f}s")
    check("C8 六句全部 200", all(s == 200 for _, s, _, _, _ in rtfs),
          str([(t, s) for t, s, *_ in rtfs]))
    ok_rtfs = [r for _, s, r, _, _ in rtfs if s == 200]
    avg_rtf = sum(ok_rtfs) / len(ok_rtfs) if ok_rtfs else 99.0
    # ⚠️ 阈值口径（30-3/30-4 复核时两次调整，别照抄阶段 28 的 0.246）：
    #   阶段 28 的 0.246 是 **bench 口径** —— 单进程直调、长文本、无 HTTP / base64 / 切句；
    #   服务端口径多了三层固定开销（HTTP + base64 编解码 + 每段 duration 预测与 codec 编码），
    #   且服务端按 ≤25 字切句后单段音频更短 —— 而 RTF 的分母就是音频时长，音频越短 RTF 越高。
    #   实测（RTX 4060，20 步，同一台机器不同时刻）：**0.298 ~ 0.370** 波动 ——
    #   显存紧张 / GPU 降频都会推高它。所以这条断言的目的是**抓异常慢**
    #   （落到 CPU 回退、显存交换时会 >1.0），不是性能基准；0.45 是留足波动的上限。
    check("C9 平均 RTF ≤ 0.45（服务端口径，见注释；抓异常慢而非性能基准）", avg_rtf <= 0.45, f"avg={avg_rtf:.3f}")

    status, body = request("POST", f"{BASE}/v1/synth",
                           {"text": "今日の会議は午後三時に変更になりました😊",
                            "caption": "落ち着いた、近い距離感の女性話者",
                            "ref_voice": VOICE_ID, "seed": 7}, timeout=600)
    check("C10 emoji + caption 合成 200", status == 200,
          f"status={status} {json.dumps(body, ensure_ascii=False)[:200]}")

    status, a = request("POST", f"{BASE}/v1/synth",
                        {"text": JA_TEXTS[2], "ref_voice": VOICE_ID, "seed": 42}, timeout=600)
    status, b = request("POST", f"{BASE}/v1/synth",
                        {"text": JA_TEXTS[2], "ref_voice": VOICE_ID, "seed": 42}, timeout=600)
    check("C11 同 seed 同输入完全确定", status == 200 and a.get("audio_base64") == b.get("audio_base64"),
          "两次 base64 不一致" if status == 200 else f"status={status}")

    results: list = []

    def _worker():
        results.append(request("POST", f"{BASE}/v1/synth",
                               {"text": "並列リクエストのテストです。", "ref_voice": VOICE_ID}, timeout=600))

    threads = [threading.Thread(target=_worker) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    codes = sorted(s for s, _ in results)
    check("C12 并发请求恰好一个成功、另一个 409 ENGINE_BUSY",
          codes == [200, 409] and all(
              (body.get("error", {}).get("code") == "ENGINE_BUSY") for s, body in results if s == 409),
          f"codes={codes} {json.dumps([b for s, b in results if s != 200], ensure_ascii=False)[:160]}")

    status, body = request("POST", f"{BASE}/v1/unload", {}, timeout=120)
    check("C13 unload 回报归还量", status == 200 and (body.get("freed_mb") or 0) > 0,
          f"status={status} {json.dumps(body, ensure_ascii=False)[:160]}")
    _, health = request("GET", f"{BASE}/health")
    check("C14 unload 后 loaded=false", health.get("loaded") is False, str(health.get("loaded")))

    status, body = request("POST", f"{BASE}/v1/warmup", {}, timeout=600)
    check("C15 卸载后可再次加载（热路径）", status == 200, f"status={status}")
    request("POST", f"{BASE}/v1/unload", {}, timeout=120)


def _run_gateway_suite() -> None:
    status, body = request("GET", f"{GW}/api/irodori/health")
    check("D1 网关透传 /health 200", status == 200 and body.get("service") == "irodori",
          f"status={status} {json.dumps(body, ensure_ascii=False)[:160]}")

    status, body = request("GET", f"{GW}/api/irodori/v1/catalog")
    check("D2 网关透传 /v1/catalog", status == 200 and body.get("emoji", {}).get("count") == 56,
          f"status={status}")

    status, body = request("GET", f"{GW}/api/health")
    summary = body.get("data", {}).get("irodori", {})
    check("D3 /api/health 带 irodori 摘要", status == 200 and "reachable" in summary,
          json.dumps(summary, ensure_ascii=False)[:160])

    status, body = request("GET", f"{GW}/api/irodori/service")
    check("D4 /api/irodori/service 开关状态可读", status == 200 and "enabled" in body,
          f"status={status} {json.dumps(body, ensure_ascii=False)[:160]}")

    status, body = request("POST", f"{GW}/api/irodori/v1/synth",
                           {"text": "你好世界中文", "ref_voice": VOICE_ID})
    check("D5 错误契约经网关透传（中文 → NO_JA_ONLY）",
          status == 400 and body.get("error", {}).get("code") == "NO_JA_ONLY",
          f"status={status} {json.dumps(body, ensure_ascii=False)[:160]}")


if __name__ == "__main__":
    raise SystemExit(main())

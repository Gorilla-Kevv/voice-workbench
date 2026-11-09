"""HTTP 层端到端验证（走真实的服务端口）。

验证重构后每条 HTTP 路径的**对外契约没变**，并确认 lazy-start 的 worker
会在第一次需要模型时才起来。

用普通 Python 跑即可（不需要 torch）—— 它只发 HTTP 请求。

用法：
    python .tmp/verify_http.py [port]
"""

from __future__ import annotations

import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request

for _key in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"):
    os.environ.pop(_key, None)

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 19881
BASE = "http://127.0.0.1:%d" % PORT

PASSED: list = []
FAILED: list = []


def check(name: str, ok: bool, detail: str = "") -> None:
    (PASSED if ok else FAILED).append(name)
    print("  %s %s%s" % ("PASS" if ok else "FAIL", name, ("  → " + detail) if detail else ""))


def request(method: str, path: str, body=None, timeout=600):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(
        BASE + path,
        method=method,
        data=data,
        headers={"Content-Type": "application/json"} if data else {},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            raw = response.read().decode("utf-8")
            return response.status, raw
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8")


def get_json(path: str, **kw):
    status, raw = request("GET", path, **kw)
    return status, (json.loads(raw) if raw else {})


def post_json(path: str, body=None, **kw):
    status, raw = request("POST", path, body or {}, **kw)
    return status, (json.loads(raw) if raw else {})


def main() -> int:
    print("=" * 70)
    print("HTTP 层端到端验证   %s" % BASE)
    print("=" * 70)

    # ---------- 1. 元信息 ----------
    print("\n[1] 元信息端点")
    status, health = get_json("/health")
    check("/health 返回 200", status == 200, "status=%d" % status)
    check("health.ok 为真", health.get("ok") is True)
    pipeline = health.get("pipeline") or {}
    check("包含新增字段 worker_alive", "worker_alive" in pipeline, str(pipeline.get("worker_alive")))
    check("包含新增字段 worker_error", "worker_error" in pipeline)
    check("包含新增字段 worker_pid", "worker_pid" in pipeline)
    check(
        "原有字段一个没少",
        all(
            key in pipeline
            for key in ("loaded", "loading", "device", "is_half", "version", "gpt", "sovits",
                        "load_seconds", "loaded_at", "synth_count", "total_audio_seconds",
                        "last_error", "warmup_error", "target_version", "target_device",
                        "target_is_half", "streaming_supported", "languages", "training_active")
        ),
    )
    check("能力清单未缩水", bool(health.get("capabilities", {}).get("inference")))

    status, catalog_payload = get_json("/v1/catalog")
    check("/v1/catalog 返回 200", status == 200, "status=%d" % status)
    check("catalog 有版本清单", bool((catalog_payload.get("catalog") or {}).get("versions")),
          "%d 个版本" % len((catalog_payload.get("catalog") or {}).get("versions") or []))

    status, weights = get_json("/v1/weights")
    check("/v1/weights 返回 200", status == 200, "status=%d" % status)
    check(
        "默认权重可解析（resolve_defaults 仍在主进程）",
        bool((weights.get("default") or {}).get("gpt_name")),
        "%s / %s" % ((weights.get("default") or {}).get("gpt_name"), (weights.get("default") or {}).get("sovits_name")),
    )

    status, engines = get_json("/v1/engines")
    check("/v1/engines 返回 200", status == 200, "status=%d" % status)

    # ---------- 2. worker 懒启动 ----------
    print("\n[2] worker 懒启动（进入时才起来，不拖慢服务启动）")
    status, before = get_json("/v1/pipeline")
    check("首次查询 worker 尚未启动", (before.get("pipeline") or {}).get("worker_alive") is False,
          "worker_alive=%r" % (before.get("pipeline") or {}).get("worker_alive"))

    # ---------- 3. 预热 ----------
    print("\n[3] 预热（会拉起 worker 并加载 4 个模型）")
    started = time.monotonic()
    # blocking 是 **query 参数**（FastAPI 的标量参数默认走 query），body 里传没用
    status, warmed = request("POST", "/v1/pipeline/warmup?blocking=true", None, timeout=600)
    warmed = json.loads(warmed) if warmed else {}
    elapsed = time.monotonic() - started
    check("warmup 返回 200", status == 200, "status=%d 用时 %.1fs" % (status, elapsed))
    if status != 200:
        print("     响应：%s" % str(warmed)[:300])
    warm_pipeline = warmed.get("data") or {}
    check("worker 已起来", warm_pipeline.get("worker_alive") is True, "pid=%s" % warm_pipeline.get("worker_pid"))
    check("worker_pid 已记录", isinstance(warm_pipeline.get("worker_pid"), int), str(warm_pipeline.get("worker_pid")))
    check("管线已加载", warm_pipeline.get("loaded") is True)
    check("已记录 GPT 权重", bool(warm_pipeline.get("gpt")), str(warm_pipeline.get("gpt")))
    check("已记录 SoVITS 权重", bool(warm_pipeline.get("sovits")), str(warm_pipeline.get("sovits")))

    # ---------- 4. 音色库 ----------
    print("\n[4] 音色库")
    status, voices = get_json("/v1/voices")
    check("/v1/voices 返回 200", status == 200, "status=%d" % status)
    items = voices.get("voices") or []
    check("音色库非空", len(items) >= 1, "%d 条" % len(items))
    if not items:
        print("  音色库为空，跳过后续合成相关检查")
        return _report()
    voice_id = items[0]["id"]

    # ---------- 5. 文本切分（原私有穿透点） ----------
    print("\n[5] 文本切分预览（重构前是 _pipeline 私有穿透）")
    text = "你好，这是通过 HTTP 走的切分预览测试。"
    status, split = post_json(
        "/v1/text/split", {"text": text, "text_lang": "zh", "text_split_method": "cut5"}
    )
    check("切分返回 200", status == 200, "status=%d" % status)
    if status != 200:
        print("     响应：%s" % str(split)[:300])
    segments = split.get("segments") or []
    check("返回 segments 数组", bool(segments), "%d 段" % len(segments))
    check("段落结构未变（index/text/chars）",
          all({"index", "text", "chars"} <= set(s) for s in segments))
    check("附带 total/chars 汇总", "total" in split and "chars" in split)

    # ---------- 6. 同步合成 ----------
    print("\n[6] 同步合成 /v1/tts")
    payload = {"text": "你好，这是 worker 隔离重构后的同步合成验证。", "text_lang": "zh", "voice": voice_id}
    started = time.monotonic()
    status, synth = post_json("/v1/tts", payload, timeout=600)
    elapsed = time.monotonic() - started
    check("合成返回 200", status == 200, "status=%d 用时 %.1fs" % (status, elapsed))
    if status != 200:
        print("     响应：%s" % str(synth)[:400])
    else:
        check("返回 audio_url", bool(synth.get("audio_url")), str(synth.get("audio_url")))
        check("返回 duration_s", (synth.get("duration_s") or 0) > 0.5, "%.2fs" % (synth.get("duration_s") or 0))
        check("采样率合法", synth.get("sample_rate") in (24000, 32000), str(synth.get("sample_rate")))
        url = synth.get("audio_url") or ""
        if url.startswith("/files/"):
            fetch = urllib.request.Request(BASE + url)
            try:
                with urllib.request.urlopen(fetch, timeout=30) as response:
                    blob = response.read()
                check("音频文件可下载", len(blob) > 1000, "%d 字节" % len(blob))
                check("是合法 WAV（RIFF 头）", blob[:4] == b"RIFF" and blob[8:12] == b"WAVE")
            except Exception as exc:  # noqa: BLE001
                check("音频文件可下载", False, "%s: %s" % (type(exc).__name__, exc))

    # ---------- 7. 流式合成 ----------
    print("\n[7] 流式合成 /v1/tts/stream（NDJSON）")
    status, raw = request("POST", "/v1/tts/stream", payload, timeout=600)
    check("流式返回 200", status == 200, "status=%d" % status)
    if status == 200:
        events = [json.loads(line) for line in raw.splitlines() if line.strip()]
        kinds = [e.get("type") for e in events]
        check("首个事件是 start", kinds and kinds[0] == "start", str(kinds[:3]))
        check("含 meta 事件", "meta" in kinds)
        chunks = [e for e in events if e.get("type") == "chunk"]
        check("至少一块 chunk", len(chunks) >= 1, "%d 块" % len(chunks))
        check("含 done 事件", "done" in kinds, str(kinds))
        if chunks:
            first = chunks[0]
            decoded = base64.b64decode(first.get("audio") or "")
            check("chunk 音频可解码为 int16", len(decoded) % 2 == 0 and len(decoded) > 0,
                  "%d 字节 / %s 采样" % (len(decoded), first.get("samples")))
            check("chunk 带 sample_rate", first.get("sample_rate") in (16000, 24000, 32000),
                  str(first.get("sample_rate")))
        done = next((e for e in events if e.get("type") == "done"), {})
        check("done 带 audio_url", bool(done.get("audio_url")), str(done.get("audio_url")))
        check("无 error 事件", "error" not in kinds)

    # ---------- 8. 批量 ----------
    print("\n[8] 批量合成 /v1/tts/batch/plan + /v1/tts/batch")
    batch_payload = {"text": "第一句。\n第二句。", "text_lang": "zh", "voice": voice_id}
    status, plan = post_json("/v1/tts/batch/plan", batch_payload)
    check("批量规划返回 200", status == 200, "status=%d" % status)
    check("展开为两条", len(plan.get("entries") or plan.get("items") or []) == 2,
          str(len(plan.get("entries") or plan.get("items") or [])))

    started = time.monotonic()
    status, job = post_json("/v1/tts/batch", batch_payload, timeout=900)
    elapsed = time.monotonic() - started
    check("批量返回 200", status == 200, "status=%d 用时 %.1fs" % (status, elapsed))
    if status == 200:
        check("批量成功两条", job.get("succeeded") == 2,
              "成功 %s / 失败 %s" % (job.get("succeeded"), job.get("failed")))

    # ---------- 9. 卸载 ----------
    print("\n[9] 卸载 /v1/pipeline/unload")
    # 注意：unload 的返回是 MessageResponse， 历来是 null ——
    # 这是**重构前就有的契约**，不能为了测试方便去改它。
    # 真正的状态要另外查 /v1/pipeline。
    status, unloaded = post_json("/v1/pipeline/unload", {}, timeout=600)
    check("unload 返回 200", status == 200, "status=%d" % status)
    check("unload 消息未变", "已释放模型" in (unloaded.get("message") or ""),
          unloaded.get("message"))
    check("unload 的 data 仍是 null（契约未变）", unloaded.get("data") is None,
          repr(unloaded.get("data")))
    _, after_unload = get_json("/v1/pipeline")
    unload_state = after_unload.get("pipeline") or {}
    check("worker 仍存活（只是没了模型）", unload_state.get("worker_alive") is True,
          "worker_alive=%r pid=%r" % (unload_state.get("worker_alive"), unload_state.get("worker_pid")))
    check("状态改为未加载", unload_state.get("loaded") is False, "loaded=%r" % unload_state.get("loaded"))
    check("设备回落为 cpu", unload_state.get("device") == "cpu", str(unload_state.get("device")))
    # worker 进程号应当没变 —— 证明只是卸载模型，不是重启进程
    check("worker 进程号未变（不是重启）",
          unload_state.get("worker_pid") == warm_pipeline.get("worker_pid"),
          "%r → %r" % (warm_pipeline.get("worker_pid"), unload_state.get("worker_pid")))

    print("\n" + "=" * 70)
    return _report()


def _report() -> int:
    print("通过 %d 项，失败 %d 项" % (len(PASSED), len(FAILED)))
    if FAILED:
        print("失败项：")
        for name in FAILED:
            print("  - %s" % name)
    print("=" * 70)
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())

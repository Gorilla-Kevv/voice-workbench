"""崩溃恢复验证（走真实服务的 HTTP 端口）。

最重要的一条运营安全性：worker 崩了之后，服务**不能**跟着坏掉。

专门验证「服务撒谎」这个最危险的失效模式：worker 一死，模型就没了，
但主进程的内存镜像里 `loaded` 还停在 True —— 如果 `/health` 照实上报，
用户会看到一个「已加载」的服务，然后每次合成都莫名失败。

流程：
    1. 预热，确认 worker 起来了
    2. 从服务自己的 /health 里读出 worker PID
    3. 用 taskkill 硬杀那个 PID（模拟显存不足导致的 worker 猝死）
    4. 立刻查 /health —— loaded 必须变成 False，worker_alive 必须变 False，
       且要能说明原因（worker_error 非空）
    5. 再发一次合成 —— 必须能自愈（自动重启 worker 并重新加载模型）

用法：
    python .tmp/verify_recovery.py [port]
"""

from __future__ import annotations

import json
import os
import subprocess
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
            return response.status, response.read().decode("utf-8")
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
    print("崩溃恢复验证   %s" % BASE)
    print("=" * 70)

    # ---------- 1. 预热 ----------
    print("\n[1] 预热")
    status, warmed = request("POST", "/v1/pipeline/warmup?blocking=true", None, timeout=900)
    if status != 200:
        print("预热失败（%d）：%s" % (status, warmed[:300]))
        return 1
    _, health = get_json("/health")
    pipeline = health.get("pipeline") or {}
    pid = pipeline.get("worker_pid")
    check("worker 已启动", pipeline.get("worker_alive") is True, "pid=%s" % pid)
    check("模型已加载", pipeline.get("loaded") is True)
    check("能读到 worker PID", isinstance(pid, int), str(pid))
    if not isinstance(pid, int):
        return _report()

    # ---------- 2. 硬杀 ----------
    print("\n[2] 硬杀 worker 进程（模拟猝死）")
    try:
        # taskkill 的中文输出是 GBK/ANSI 编码，用 text=True 走 utf-8 会在
        # subprocess 的读线程里抛 UnicodeDecodeError（噪声，但很难看）。
        # 干脆拿 bytes 自己按 mbcs（Windows ANSI 代码页）解。
        result = subprocess.run(
            ["taskkill", "/F", "/PID", str(pid)],
            capture_output=True,
            timeout=30,
        )
        killed = result.returncode == 0
        if not killed:
            print("     taskkill 输出：%s" % result.stderr.decode("mbcs", errors="replace"))
    except Exception as exc:  # noqa: BLE001
        killed = False
        print("     taskkill 失败：%s" % exc)
    check("worker 进程已被杀死", killed, "pid=%d" % pid)

    # ---------- 3. 服务必须诚实地报告 ----------
    print("\n[3] 服务必须诚实报告（不能谎报「已加载」）")
    # 读线程要一点点时间发现 EOF
    deadline = time.monotonic() + 15
    reported = {}
    while time.monotonic() < deadline:
        _, health = get_json("/health")
        reported = health.get("pipeline") or {}
        if reported.get("worker_alive") is False:
            break
        time.sleep(0.5)
    check("worker_alive 变为 False", reported.get("worker_alive") is False,
          "worker_alive=%r" % reported.get("worker_alive"))
    check("loaded 变为 False（不谎报已加载）", reported.get("loaded") is False,
          "loaded=%r" % reported.get("loaded"))
    check("给出了可读的失败原因", bool(reported.get("worker_error")),
          str(reported.get("worker_error"))[:120])
    check("服务本身仍然健康（/health 返回 200）", bool(health.get("ok")))

    # ---------- 4. 自愈 ----------
    print("\n[4] 下一次合成就自愈（自动重启 worker + 重新加载模型）")
    _, voices = get_json("/v1/voices")
    items = voices.get("voices") or []
    if not items:
        print("  音色库为空，跳过自愈验证")
        return _report()
    payload = {"text": "崩溃恢复测试。", "text_lang": "zh", "voice": items[0]["id"]}

    started = time.monotonic()
    status, synth = post_json("/v1/tts", payload, timeout=900)
    elapsed = time.monotonic() - started
    check("合成成功（worker 已自动重启）", status == 200,
          "status=%d 用时 %.1fs" % (status, elapsed))
    if status != 200:
        print("     响应：%s" % str(synth)[:400])
    else:
        check("返回了音频", bool(synth.get("audio_url")), str(synth.get("audio_url")))
        _, health = get_json("/health")
        after = health.get("pipeline") or {}
        check("新 worker 已起来", after.get("worker_alive") is True, "pid=%s" % after.get("worker_pid"))
        check("换了一个新进程号", after.get("worker_pid") != pid,
              "%s → %s" % (pid, after.get("worker_pid")))
        check("模型重新加载完成", after.get("loaded") is True)
        check("错误信息已清空", not after.get("worker_error"),
              str(after.get("worker_error"))[:120])

    return _report()


def _report() -> int:
    print("\n" + "=" * 70)
    print("通过 %d 项，失败 %d 项" % (len(PASSED), len(FAILED)))
    if FAILED:
        print("失败项：")
        for name in FAILED:
            print("  - %s" % name)
    print("=" * 70)
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())

"""Irodori 长尾护栏验证（阶段 30-3）。

用法：
    irodori/.venv/Scripts/python.exe .tmp/verify_irodori_guard.py

**不加载真模型、不占显存**：把 `engine.load` 换成一个假 runtime，合成耗时由脚本控制
（真实长尾要 89s 才现形一次，而护栏的本质是「时间预算怎么花」，用假耗时反而能精确
覆盖三条路径：正常 / 段间降步 / 墙钟超时）。

真机合成（30-2 欠的 C 段）仍被桌面显存阻塞，本脚本不替代它。

分五段：
- A 配置与常量（护栏参数可配、catalog 真源）
- B 段间外推降步（主手段）：慢→降步、快→不降、段数不丢、seed 语义
- C 墙钟看门狗（兜底）：超时 504、合成权留到收尾、期间的 409 文案
- D 成功响应契约与音频拼接
- E 30-2 校验回归（护栏没把已有校验弄坏）
"""

from __future__ import annotations

import io
import json
import os
import sys
import time
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "irodori"))

for key in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"):
    os.environ.pop(key, None)

PASS = 0
FAIL = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"  ✓ {name}")
    else:
        FAIL += 1
        print(f"  ✗ {name}" + (f"  <- {detail}" if detail else ""))


import torch  # noqa: E402  - 假 runtime 要造 tensor（CPU 即可）

from app import catalog as catalog_mod  # noqa: E402
from app import engine as engine_mod  # noqa: E402
from app import synth as synth_mod  # noqa: E402
from app.config import Settings  # noqa: E402
from app.errors import IrodoriError  # noqa: E402

# ---------------------------------------------------------------------------
# 假上游：把 `irodori_tts.inference_runtime` 塞进 sys.modules，这样 synth 内部
# `from irodori_tts.inference_runtime import SamplingRequest` 拿到的是我们的替身，
# 既不用真加载模型，也不依赖上游目录存在。
# ---------------------------------------------------------------------------


class FakeSamplingRequest:
    def __init__(self, **kwargs) -> None:
        self.__dict__.update(kwargs)


sys.modules["irodori_tts"] = SimpleNamespace(__path__=[])
sys.modules["irodori_tts.inference_runtime"] = SimpleNamespace(SamplingRequest=FakeSamplingRequest)


class FakeRuntime:
    """按 `cost(index, steps)` 睡眠后返回一段静音。记录每一次请求便于断言。"""

    def __init__(self, cost, sample_rate: int = 48000, seg_seconds: float = 0.2) -> None:
        self.cost = cost
        self.sample_rate = sample_rate
        self.seg_seconds = seg_seconds
        self.requests: list[dict] = []

    def synthesize(self, request, log_fn=None):  # noqa: ANN001 - 签名对齐上游
        index = len(self.requests)
        self.requests.append({"text": request.text, "steps": request.num_steps, "seed": request.seed})
        time.sleep(self.cost(index, request.num_steps))
        frames = int(self.sample_rate * self.seg_seconds)
        audio = torch.zeros(1, frames, dtype=torch.float32)
        return SimpleNamespace(audio=audio, sample_rate=self.sample_rate)


def install_fake_runtime(runtime: FakeRuntime) -> None:
    engine_mod.load = lambda _settings: (runtime, True)  # type: ignore[assignment]
    engine_mod.check_vram_admission = lambda _settings, *, loaded: {"vram": None, "required_mb": 4700}  # type: ignore[assignment]


def reset_busy() -> None:
    """把合成权与 recovering 标志恢复干净（用例之间互不污染）。"""
    engine_mod.clear_recovering()
    if not engine_mod.try_acquire_busy():
        return
    engine_mod.release_busy()


def make_settings(timeout: float, downgrade: int = 20) -> Settings:
    settings = Settings()
    settings.timeout_sec = timeout
    settings.downgrade_steps = downgrade
    return settings


REF_WAV = ROOT / ".tmp" / "irodori_guard_ref.wav"


def ensure_ref_wav() -> Path:
    """造一条 4s 静音参考（假 runtime 不读内容，只要时长够 3s 下限）。

    不复用 `.tmp/irodori_short_ref.wav`：那条只有 1.0s，会被 REF_TOO_SHORT 拦下 ——
    它本来就是 30-2 用来验「短参考被拒」的。
    """
    if not REF_WAV.is_file():
        import numpy as np

        import soundfile as sf

        sf.write(str(REF_WAV), np.zeros(int(16000 * 4.0), dtype=np.float32), 16000, subtype="PCM_16")
    return REF_WAV
TEXT_10 = "あいうえお。かきくけこ。" * 5  # 10 个句子 → 切句后 5 段（每 2 句 10 字 ≤25）


def payload_of(text: str = TEXT_10, **kwargs) -> synth_mod.SynthPayload:
    base = {"text": text, "ref_path": str(REF_WAV)}
    base.update(kwargs)
    return synth_mod.parse_payload(base)


def run(settings: Settings, runtime: FakeRuntime, **kwargs):
    install_fake_runtime(runtime)
    return synth_mod.run_synthesis(settings, payload_of(**kwargs))


print("=" * 66)
print("A. 配置与常量")
print("=" * 66)

os.environ["IRODORI_TIMEOUT"] = "77"
os.environ["IRODORI_DOWNGRADE_STEPS"] = "12"
env_settings = Settings.from_env()
os.environ.pop("IRODORI_TIMEOUT")
os.environ.pop("IRODORI_DOWNGRADE_STEPS")
check("A1 IRODORI_TIMEOUT 可配", env_settings.timeout_sec == 77.0, f"{env_settings.timeout_sec}")
check("A2 IRODORI_DOWNGRADE_STEPS 可配", env_settings.downgrade_steps == 12, f"{env_settings.downgrade_steps}")

default_settings = Settings()
check("A3 默认预算 180s", default_settings.timeout_sec == 180.0)
check("A4 默认降步档 20（拍板①）", default_settings.downgrade_steps == 20)
check("A5 BUDGET_SAFETY 在 (0,1)", 0 < synth_mod.BUDGET_SAFETY < 1, str(synth_mod.BUDGET_SAFETY))

cat = catalog_mod.build_catalog(default_settings)
guard = cat.get("guard") or {}
check("A6 catalog 暴露 timeout_sec", guard.get("timeout_sec") == 180.0, json.dumps(guard, ensure_ascii=False)[:80])
check("A7 catalog 暴露 downgrade_steps", guard.get("downgrade_steps") == 20)
check("A8 health 配置也带 downgrade_steps", "downgrade_steps" in default_settings.as_dict())

print()
print("=" * 66)
print("B. 段间外推降步（主手段）")
print("=" * 66)

try:
    ensure_ref_wav()
    check("B0 参考音频就绪（≥3s）", REF_WAV.is_file())
except Exception as error:  # noqa: BLE001
    check("B0 参考音频就绪（≥3s）", False, f"{type(error).__name__}: {error}")

# B1：40 步很慢（1.2s/段），降到 20 步后 0.1s/段 —— 模拟「长尾撞上后降步就正常」
slow_then_fast = FakeRuntime(lambda _i, steps: 3.0 if steps > 20 else 0.1)
settings_b = make_settings(timeout=5.0)
result_b = run(settings_b, slow_then_fast, num_steps=40)

segments_expected = len(synth_mod.split_sentences(TEXT_10))
check("B1 触发降步 retried=True", result_b.get("retried") is True, json.dumps(result_b, ensure_ascii=False)[:200])
check("B2 steps_requested 保留 40", result_b.get("steps_requested") == 40, str(result_b.get("steps_requested")))
check("B3 steps_used 降到 20", result_b.get("steps_used") == 20, str(result_b.get("steps_used")))
check("B4 downgraded_at_segment 有值", isinstance(result_b.get("downgraded_at_segment"), int),
      str(result_b.get("downgraded_at_segment")))
check("B5 段数不丢", len(slow_then_fast.requests) == segments_expected,
      f"{len(slow_then_fast.requests)} != {segments_expected}")
check("B6 第一段仍是 40 步（当前段杀不掉，只影响后续）", slow_then_fast.requests[0]["steps"] == 40)
check("B7 后续段全部降到 20 步", all(item["steps"] == 20 for item in slow_then_fast.requests[1:]))
check("B8 总耗时回到预算内", result_b.get("elapsed_sec", 999) < 5.0, str(result_b.get("elapsed_sec")))

# B9：一直很快 → 不降步
fast = FakeRuntime(lambda _i, _steps: 0.02)
result_fast = run(make_settings(timeout=5.0), fast, num_steps=40)
check("B9 快场景不降步", result_fast.get("retried") is False, str(result_fast.get("retried")))
check("B10 快场景步数不变", result_fast.get("steps_used") == 40)

# B11/B12：seed 语义
seed_runtime = FakeRuntime(lambda _i, steps: 3.0 if steps > 20 else 0.1)
result_seed = run(make_settings(timeout=5.0), seed_runtime, num_steps=40, seed=123)
seeds = [item["seed"] for item in seed_runtime.requests]
check("B11 显式 seed 全程保留（同 seed 同输入确定）", all(s == 123 + i for i, s in enumerate(seeds)), str(seeds))
check("B12 显式 seed 时 used_seed 原样回显", result_seed.get("used_seed") == 123)

rand_runtime = FakeRuntime(lambda _i, steps: 3.0 if steps > 20 else 0.1)
run(make_settings(timeout=5.0), rand_runtime, num_steps=40)
rand_seeds = [item["seed"] for item in rand_runtime.requests]
seed_jumped = len(rand_seeds) > 1 and rand_seeds[1] - rand_seeds[0] != 1
check("B13 随机 seed 在降步时被换掉（避开坏 seed）", seed_jumped, str(rand_seeds))

# B14：已经是 20 步就无从再降
low_runtime = FakeRuntime(lambda _i, _steps: 0.3)
result_low = run(make_settings(timeout=5.0), low_runtime, num_steps=20)
check("B14 20 步场景不触发降步（降无可降）", result_low.get("retried") is False)

print()
print("=" * 66)
print("C. 墙钟看门狗（兜底）")
print("=" * 66)

reset_busy()
hang_runtime = FakeRuntime(lambda _i, _steps: 3.0)
settings_c = make_settings(timeout=1.0)
install_fake_runtime(hang_runtime)
started = time.perf_counter()
timeout_error: IrodoriError | None = None
try:
    synth_mod.run_synthesis(settings_c, payload_of(num_steps=40))
except IrodoriError as error:
    timeout_error = error
elapsed_c = time.perf_counter() - started

check("C1 超时抛 IRODORI_TIMEOUT", timeout_error is not None and timeout_error.code == "IRODORI_TIMEOUT",
      str(timeout_error and timeout_error.code))
check("C2 504 状态码", timeout_error is not None and timeout_error.status == 504)
check("C3 不悬挂：1s 预算 ~1s 就返回", elapsed_c < 2.0, f"{elapsed_c:.2f}s")
if timeout_error is not None:
    details = timeout_error.details or {}
    check("C4 details.timeout_sec", details.get("timeout_sec") == 1.0, str(details))
    check("C5 details.retry_suggestion.num_steps=20",
          (details.get("retry_suggestion") or {}).get("num_steps") == 20, str(details))
    check("C6 details 带段进度", "segments_total" in details and "segments_done" in details)
    check("C7 retryable=True（客户端可一键降步重试）", timeout_error.retryable is True)
    check("C8 hint 说清「降到 20 重试」", "20" in timeout_error.hint, timeout_error.hint)

check("C9 超时后标记 recovering", engine_mod.is_recovering() is True)
held = engine_mod.try_acquire_busy()
if held:
    engine_mod.release_busy()
check("C10 合成权仍被孤儿持有（不能放，否则抢上游锁）", held is False)

# C11：孤儿还在收尾时发起新请求 → 409 且文案点明「仍在收尾」
busy_error: IrodoriError | None = None
try:
    synth_mod.run_synthesis(settings_c, payload_of(num_steps=20))
except IrodoriError as error:
    busy_error = error
check("C11 收尾期间新请求 409", busy_error is not None and busy_error.status == 409,
      str(busy_error and busy_error.status))
check("C12 文案区分「仍在收尾」", busy_error is not None and "仍在收尾" in busy_error.message,
      str(busy_error and busy_error.message))

# C13/C14：孤儿跑完后自动恢复
time.sleep(3.5)
check("C13 孤儿结束后 recovering 自动清除", engine_mod.is_recovering() is False)
recovered = engine_mod.try_acquire_busy()
if recovered:
    engine_mod.release_busy()
check("C14 合成权自动归还", recovered is True)
check("C15 孤儿只跑了被卡的那一小段（cancel 生效）", len(hang_runtime.requests) == 1,
      f"requests={len(hang_runtime.requests)}")

print()
print("=" * 66)
print("D. 成功响应契约与音频拼接")
print("=" * 66)

reset_busy()
d_runtime = FakeRuntime(lambda _i, _steps: 0.01, seg_seconds=0.5)
result_d = run(make_settings(timeout=10.0), d_runtime, text="あいうえお。かきくけこ。")
for field in ("audio_base64", "sample_rate", "duration_sec", "elapsed_sec", "rtf",
              "steps_requested", "steps_used", "retried", "timeout_sec", "segments"):
    check(f"D-{field} 字段存在", field in result_d, str(sorted(result_d))[:120])
check("D-采样率 48kHz", result_d.get("sample_rate") == 48000)

import soundfile as sf  # noqa: E402

wav_bytes = io.BytesIO(__import__("base64").b64decode(result_d["audio_base64"]))
info = sf.info(wav_bytes)
check("D-WAV 可解码且为 48kHz", info.samplerate == 48000, str(info.samplerate))
n_segments = result_d["segments"]
expected = n_segments * 0.5 + (n_segments - 1) * synth_mod.SEGMENT_GAP_SECONDS
check("D-时长=段时长+段间静音", abs(info.duration - expected) < 0.05,
      f"{info.duration:.3f} vs {expected:.3f}")
check("D-段数=切句结果", n_segments == len(synth_mod.split_sentences("あいうえお。かきくけこ。")),
      f"{n_segments}")

print()
print("=" * 66)
print("E. 30-2 校验回归（护栏没弄坏已有逻辑）")
print("=" * 66)

reset_busy()
try:
    synth_mod.parse_payload({"text": "今天天气不错", "ref_path": str(REF_WAV)})
    check("E1 中文仍被 NO_JA_ONLY 拒绝", False)
except IrodoriError as error:
    check("E1 中文仍被 NO_JA_ONLY 拒绝", error.code == "NO_JA_ONLY", error.code)

try:
    synth_mod.parse_payload({"text": "あいうえお"})
    check("E2 缺参考仍被 REF_REQUIRED 拒绝", False)
except IrodoriError as error:
    check("E2 缺参考仍被 REF_REQUIRED 拒绝", error.code == "REF_REQUIRED", error.code)

try:
    synth_mod.parse_payload({"text": "あいうえお", "ref_path": str(REF_WAV), "speaker_id": "x"})
    check("E3 speaker_id 与参考仍互斥", False)
except IrodoriError as error:
    check("E3 speaker_id 与参考仍互斥", error.code == "REF_CONFLICT", error.code)

check("E4 切句仍 ≤25 字/段",
      all(len(item) <= synth_mod.SEGMENT_MAX_CHARS
          for item in synth_mod.split_sentences("あ" * 80 + "。")))

# ---------------------------------------------------------------------------
# F. 真机护栏（--real）：需要服务在跑，且**以 IRODORI_TIMEOUT=8 启动**
#
# 为什么固定在 8s：真机每段 20 步约 1.6s、40 步约 3.2s（本机 RTX 4060 实测），
# 触发线是 0.9×8=7.2s。40 步跑完 3 段中的第 1 段外推 ≈9.6s → 触发降步，
# 降到 20 步后总耗时 ≈5.9s 仍在预算内 → 200 + retried=True。
# 把段数加到 5 段则降步后仍超 → 504 + details.downgraded=True（两条路径都覆盖）。
# ---------------------------------------------------------------------------

if "--real" in sys.argv:
    print()
    print("=" * 66)
    print("F. 真机护栏（--real）")
    print("=" * 66)

    import urllib.error  # noqa: E402
    import urllib.request  # noqa: E402

    BASE = "http://127.0.0.1:9884"

    def http(method: str, path: str, body=None, timeout: float = 300):
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(f"{BASE}{path}", data=data, method=method,
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.status, json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read().decode("utf-8"))

    status, health = http("GET", "/health")
    if status != 200:
        check("F0 服务可达", False, f"status={status}")
    else:
        timeout_real = health["configuration"]["timeout_sec"]
        check("F0 服务可达", True)
        check("F1 服务端预算 = 8s（否则本段断言不适用）", timeout_real == 8.0, f"timeout_sec={timeout_real}")
        if not health["loaded"]:
            print("     （模型未加载，先 warmup，不计入断言）")
            http("POST", "/v1/warmup", {})

        def synth_real(text: str, steps: int | None = None):
            body: dict = {"text": text, "ref_path": str(REF_WAV)}
            if steps:
                body["num_steps"] = steps
            return http("POST", "/v1/synth", body)

        # 3 段：外推超触发线 → 降步 → 总耗时回到预算内
        s3, b3 = synth_real("あいうえお。かきくけこ。" * 6, 40)
        check("F2 降步场景返回 200", s3 == 200 and b3.get("ok") is True,
              json.dumps(b3.get("error", {}), ensure_ascii=False)[:160])
        if b3.get("ok"):
            check("F3 retried=True（真机降步生效）", b3.get("retried") is True, str(b3.get("retried")))
            check("F4 steps_used 降到 20", b3.get("steps_used") == 20, str(b3.get("steps_used")))
            check("F5 段数完整（没丢段）", b3.get("segments") == 3, str(b3.get("segments")))
            check("F6 回到预算内", (b3.get("elapsed_sec") or 99) < 8.0, str(b3.get("elapsed_sec")))

        # 5 段：降步后仍超 → 504，但 details 要表明护栏已经介入
        s5, b5 = synth_real("あいうえお。かきくけこ。" * 10, 40)
        check("F7 超预算场景返回 504", s5 == 504, f"status={s5}")
        err5 = b5.get("error") or {}
        check("F8 错误码 IRODORI_TIMEOUT", err5.get("code") == "IRODORI_TIMEOUT", str(err5.get("code")))
        check("F9 details 显示护栏已降步", (err5.get("details") or {}).get("downgraded") is True,
              json.dumps(err5.get("details"), ensure_ascii=False)[:160])
        check("F10 retry_suggestion.num_steps=20",
              ((err5.get("details") or {}).get("retry_suggestion") or {}).get("num_steps") == 20)

        # 收尾期间的第二条请求：409 且文案点明「仍在收尾」
        s6, b6 = synth_real("こんにちは。", 20)
        check("F11 收尾期间新请求 409", s6 == 409, f"status={s6}")
        check("F12 文案说明「仍在收尾」", "仍在收尾" in ((b6.get("error") or {}).get("message") or ""),
              str((b6.get("error") or {}).get("message")))
else:
    print()
    print("（跳过 F 段真机护栏：加 --real 且服务以 IRODORI_TIMEOUT=8 启动时才跑）")

print()
print("=" * 66)
print(f"结果：{PASS} 通过 / {FAIL} 失败")
print("=" * 66)
sys.exit(1 if FAIL else 0)

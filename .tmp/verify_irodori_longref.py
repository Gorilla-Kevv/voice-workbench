"""Irodori「音色库长参考」解析链验证（阶段 30-4）。

用法：
    irodori/.venv/Scripts/python.exe .tmp/verify_irodori_longref.py
    # 加 --real 时额外跑真机合成（需服务在 9884 且显存充足）

验的是**回落链**：同一个音色在 GPT-SoVITS 眼里是「一条 3~10 秒主音频」，
在 Irodori 眼里可能是「几段短句拼起来的长参考」。`ref_voice` 必须
**有长参考就用长参考，没有才回落主音频** —— 否则音色库里配的 ref_clips
就是死数据（用户以为在用长参考，实际用的是 5 秒主音频）。

不加载真模型（假 runtime 注入），所以不需要显存；音色库指向 .tmp 下的临时目录。
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import time
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "irodori"))

for key in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"):
    os.environ.pop(key, None)

TMP_LIB = ROOT / ".tmp" / "irodori-longref-lib"
shutil.rmtree(TMP_LIB, ignore_errors=True)
(TMP_LIB / "voices").mkdir(parents=True, exist_ok=True)
os.environ["VOICES_LIB_DIR"] = str(TMP_LIB)

import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402
import torch  # noqa: E402

from app import engine as engine_mod  # noqa: E402
from app import synth as synth_mod  # noqa: E402
from app.config import Settings  # noqa: E402
from app.errors import IrodoriError  # noqa: E402

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


def make_wav(path: Path, seconds: float, sample_rate: int = 16000) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), np.zeros(int(seconds * sample_rate), dtype=np.float32), sample_rate, subtype="PCM_16")
    return path


# ---- 假上游（同 verify_irodori_guard.py 的做法） ----
class FakeSamplingRequest:
    def __init__(self, **kwargs) -> None:
        self.__dict__.update(kwargs)


sys.modules["irodori_tts"] = SimpleNamespace(__path__=[])
sys.modules["irodori_tts.inference_runtime"] = SimpleNamespace(SamplingRequest=FakeSamplingRequest)


class FakeRuntime:
    def __init__(self) -> None:
        self.requests: list[dict] = []

    def synthesize(self, request, log_fn=None):  # noqa: ANN001
        self.requests.append({
            "text": request.text,
            "ref_wav": getattr(request, "ref_wav", None),
            "ref_wavs": getattr(request, "ref_wavs", None),
            "num_steps": request.num_steps,
        })
        audio = torch.zeros(1, int(48000 * 0.2), dtype=torch.float32)
        return SimpleNamespace(audio=audio, sample_rate=48000)


FAKE = FakeRuntime()
engine_mod.load = lambda _settings: (FAKE, True)  # type: ignore[assignment]
engine_mod.check_vram_admission = lambda _settings, *, loaded: {"vram": None, "required_mb": 4700}  # type: ignore[assignment]

settings = Settings()
settings.timeout_sec = 60.0

# ---- 造音色库 ----
main_a = make_wav(TMP_LIB / "voices" / "a.wav", 5.0)
clip_a1 = make_wav(TMP_LIB / "voices" / "a.ref0.wav", 12.0)
clip_a2 = make_wav(TMP_LIB / "voices" / "a.ref1.wav", 14.0)
main_b = make_wav(TMP_LIB / "voices" / "b.wav", 6.0)
main_c = make_wav(TMP_LIB / "voices" / "c.wav", 4.0)

(TMP_LIB / "voices.json").write_text(json.dumps([
    {
        "id": "voice-a",
        "name": "有长参考",
        "audio_path": str(main_a),
        "prompt_text": "てすと",
        "prompt_lang": "ja",
        "ref_clips": [
            {"path": str(clip_a1), "dur_s": 12.0, "sample_rate": 16000, "text": "おはよう"},
            {"path": str(clip_a2), "dur_s": 14.0, "sample_rate": 16000, "text": "こんばんは"},
        ],
        "engine_tags": ["irodori"],
    },
    {
        "id": "voice-b",
        "name": "只有主音频",
        "audio_path": str(main_b),
        "prompt_text": "てすと",
        "prompt_lang": "ja",
    },
    {
        "id": "voice-c",
        "name": "片段文件丢了",
        "audio_path": str(main_c),
        "prompt_text": "てすと",
        "prompt_lang": "ja",
        "ref_clips": [{"path": str(TMP_LIB / "voices" / "gone.wav"), "dur_s": 10.0}],
    },
], ensure_ascii=False, indent=2), encoding="utf-8")

print("=" * 66)
print("A. 回落链：有长参考用长参考，没有才回落主音频")
print("=" * 66)

ref_a = synth_mod.resolve_reference(settings, synth_mod.SynthPayload(text="あ", ref_voice="voice-a"))
check("A1 有 ref_clips → ref_source=ref_clips", ref_a.get("ref_source") == "ref_clips",
      str(ref_a.get("ref_source")))
check("A2 传出的是多片段（ref_wavs，2 片）",
      isinstance(ref_a.get("ref_wavs"), list) and len(ref_a["ref_wavs"]) == 2,
      json.dumps(ref_a.get("ref_wavs"), ensure_ascii=False))
check("A3 没有退回单条 ref_wav", ref_a.get("ref_wav") is None, str(ref_a.get("ref_wav")))
check("A4 回显片段数 2", ref_a.get("ref_clip_count") == 2, str(ref_a.get("ref_clip_count")))
check("A5 回显音色名", ref_a.get("voice_name") == "有长参考", str(ref_a.get("voice_name")))

ref_b = synth_mod.resolve_reference(settings, synth_mod.SynthPayload(text="あ", ref_voice="voice-b"))
check("A6 没有 ref_clips → 回落 audio_path", ref_b.get("ref_source") == "audio_path",
      str(ref_b.get("ref_source")))
check("A7 回落时传单条 ref_wav", ref_b.get("ref_wav") == str(main_b), str(ref_b.get("ref_wav")))
check("A8 回落时 ref_clip_count=0", ref_b.get("ref_clip_count") == 0)

print()
print("=" * 66)
print("B. 错误路径")
print("=" * 66)

try:
    synth_mod.resolve_reference(settings, synth_mod.SynthPayload(text="あ", ref_voice="voice-c"))
    check("B1 片段文件丢失时报错", False, "没报错")
except IrodoriError as error:
    check("B1 片段文件丢失时报错", error.code == "REF_NOT_FOUND", error.code)

try:
    synth_mod.resolve_reference(settings, synth_mod.SynthPayload(text="あ", ref_voice="nope"))
    check("B2 音色 id 不存在 → VOICE_NOT_FOUND", False, "没报错")
except IrodoriError as error:
    check("B2 音色 id 不存在 → VOICE_NOT_FOUND", error.code == "VOICE_NOT_FOUND", error.code)

# ref_clips 里混进无效条目（没有 path / 不是 dict）应被跳过，不能崩
(TMP_LIB / "voices.json").write_text(json.dumps([
    {
        "id": "voice-a",
        "name": "有长参考",
        "audio_path": str(main_a),
        "prompt_text": "t",
        "prompt_lang": "ja",
        "ref_clips": [{"dur_s": 3.0}, "junk", None, {"path": str(clip_a1), "dur_s": 12.0}],
    },
], ensure_ascii=False), encoding="utf-8")
ref_junk = synth_mod.resolve_reference(settings, synth_mod.SynthPayload(text="あ", ref_voice="voice-a"))
check("B3 无效片段条目被跳过（只剩 1 片有效）",
      ref_junk.get("ref_clip_count") == 1 and ref_junk.get("ref_source") == "ref_clips",
      json.dumps(ref_junk, ensure_ascii=False)[:160])

# ref_clips 全是无效条目 → 回落主音频（而不是报「没参考」）
(TMP_LIB / "voices.json").write_text(json.dumps([
    {
        "id": "voice-a",
        "name": "全无效",
        "audio_path": str(main_a),
        "prompt_text": "t",
        "prompt_lang": "ja",
        "ref_clips": [{"dur_s": 3.0}, None],
    },
], ensure_ascii=False), encoding="utf-8")
ref_fallback = synth_mod.resolve_reference(settings, synth_mod.SynthPayload(text="あ", ref_voice="voice-a"))
check("B4 ref_clips 全无效 → 回落主音频", ref_fallback.get("ref_source") == "audio_path",
      str(ref_fallback.get("ref_source")))

print()
print("=" * 66)
print("C. 端到端（假 runtime）：ref_voice 走长参考时，上游确实收到 ref_wavs")
print("=" * 66)

(TMP_LIB / "voices.json").write_text(json.dumps([
    {
        "id": "voice-a",
        "name": "有长参考",
        "audio_path": str(main_a),
        "prompt_text": "てすと",
        "prompt_lang": "ja",
        "ref_clips": [
            {"path": str(clip_a1), "dur_s": 12.0, "sample_rate": 16000},
            {"path": str(clip_a2), "dur_s": 14.0, "sample_rate": 16000},
        ],
    },
], ensure_ascii=False), encoding="utf-8")

FAKE.requests.clear()
payload = synth_mod.parse_payload({"text": "あいうえお。", "ref_voice": "voice-a", "num_steps": 20})
result = synth_mod.run_synthesis(settings, payload)
check("C1 合成成功", result.get("ok") is True)
check("C2 响应 ref_source=ref_clips", result.get("ref_source") == "ref_clips", str(result.get("ref_source")))
check("C3 响应 ref_clip_count=2", result.get("ref_clip_count") == 2)
check("C4 上游收到 ref_wavs（2 片）",
      FAKE.requests and len(FAKE.requests[0]["ref_wavs"] or []) == 2,
      json.dumps(FAKE.requests[0] if FAKE.requests else None, ensure_ascii=False)[:200])
check("C5 上游没有收到单条 ref_wav", (FAKE.requests[0]["ref_wav"] if FAKE.requests else "x") is None)

# 回落路径的端到端
(TMP_LIB / "voices.json").write_text(json.dumps([
    {
        "id": "voice-b",
        "name": "只有主音频",
        "audio_path": str(main_b),
        "prompt_text": "てすと",
        "prompt_lang": "ja",
    },
], ensure_ascii=False), encoding="utf-8")
FAKE.requests.clear()
result_b = synth_mod.run_synthesis(
    settings, synth_mod.parse_payload({"text": "あいうえお。", "ref_voice": "voice-b"})
)
check("C6 回落路径 ref_source=audio_path", result_b.get("ref_source") == "audio_path",
      str(result_b.get("ref_source")))
check("C7 上游收到单条 ref_wav", FAKE.requests and FAKE.requests[0]["ref_wav"] == str(main_b),
      str(FAKE.requests[0]["ref_wav"] if FAKE.requests else None))

print()
print("=" * 66)
print("D. 真机（--real）：用真音色库的长参考合成")
print("=" * 66)

if "--real" in sys.argv:
    import urllib.error
    import urllib.request

    def http(method: str, path: str, body=None, timeout: float = 300):
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(f"http://127.0.0.1:9884{path}", data=data, method=method,
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.status, json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read().decode("utf-8"))

    status, health = http("GET", "/health")
    check("D0 服务可达", status == 200, f"status={status}")
    if status == 200:
        # ⚠️ 用**临时音色库**（服务端也要以 VOICES_LIB_DIR 指向它启动），
        # 绝不往用户的真音色库里塞测试片段。
        (TMP_LIB / "voices").mkdir(parents=True, exist_ok=True)
        make_wav(TMP_LIB / "voices" / "a.wav", 5.0)
        make_wav(TMP_LIB / "voices" / "a.ref0.wav", 12.0)
        make_wav(TMP_LIB / "voices" / "a.ref1.wav", 14.0)
        (TMP_LIB / "voices.json").write_text(json.dumps([
            {
                "id": "voice-a",
                "name": "真机长参考",
                "audio_path": str(TMP_LIB / "voices" / "a.wav"),
                "prompt_text": "てすと",
                "prompt_lang": "ja",
                "ref_clips": [
                    {"path": str(TMP_LIB / "voices" / "a.ref0.wav"), "dur_s": 12.0, "sample_rate": 16000},
                    {"path": str(TMP_LIB / "voices" / "a.ref1.wav"), "dur_s": 14.0, "sample_rate": 16000},
                ],
            },
        ], ensure_ascii=False), encoding="utf-8")

        s, b = http("POST", "/v1/synth", {"text": "こんにちは。", "ref_voice": "voice-a"})
        if s == 503:
            print("     （显存不足，D 段如实跳过 —— 不是代码缺陷）")
        else:
            check("D1 真机合成 200", s == 200 and b.get("ok") is True,
                  json.dumps(b.get("error", {}), ensure_ascii=False)[:200])
            if b.get("ok"):
                check("D2 真机走的是长参考", b.get("ref_source") == "ref_clips", str(b.get("ref_source")))
                check("D3 片段数 2", b.get("ref_clip_count") == 2, str(b.get("ref_clip_count")))
                check("D4 采样率 48kHz", b.get("sample_rate") == 48000, str(b.get("sample_rate")))
else:
    print("（跳过 D 段：加 --real 且服务以 VOICES_LIB_DIR 指向临时库、在 9884 上跑时才验）")

shutil.rmtree(TMP_LIB, ignore_errors=True)

print()
print("=" * 66)
print(f"结果：{PASS} 通过 / {FAIL} 失败")
print("=" * 66)
sys.exit(1 if FAIL else 0)

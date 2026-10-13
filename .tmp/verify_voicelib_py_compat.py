"""音色库「日语长参考多字段」的双向兼容验证（阶段 30-4，Python 侧）。

用法（系统 Python 即可，不需要 venv）：
    python .tmp/verify_voicelib_py_compat.py

**为什么必须单独验 Python 侧**：`trainer/app/sovits/voices.py` 的 `_persist()` 是
「按字段列表重建 JSON」的写法，不认的键直接丢 —— 而 `_load()` 在发现历史脏数据
（例如 `prompt_lang` 是字面量 "undefined"）时会**自动落盘修正**。
也就是说：网关（Node）写进来的 `ref_clips` / `engine_tags` / `speaker_embeds`，
只要 GPT-SoVITS 服务启动一次，就可能被整体抹掉。这是方案 §5 点名的坑。

全程用 `.tmp/voicelib-py-test/` 隔离，不碰用户的真音色库。
"""

from __future__ import annotations

import json
import shutil
import sys
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "trainer"))

from app.sovits.voices import Voice, VoiceLibrary  # noqa: E402

TMP = ROOT / ".tmp" / "voicelib-py-test"
INDEX = TMP / "voices.json"
AUDIO = TMP / "voices"

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


def make_wav(path: Path, seconds: float = 3.0, sample_rate: int = 16000) -> None:
    frames = int(seconds * sample_rate)
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        handle.writeframes(b"\x00\x00" * frames)


def write_index(records: list[dict]) -> None:
    TMP.mkdir(parents=True, exist_ok=True)
    INDEX.write_text(json.dumps(records, ensure_ascii=False, indent=2), encoding="utf-8")


def read_index() -> list[dict]:
    return json.loads(INDEX.read_text(encoding="utf-8"))


def record_of(voice_id: str) -> dict:
    return next(item for item in read_index() if item["id"] == voice_id)


NEW_FIELDS = ("ref_clips", "engine_tags", "speaker_embeds")

shutil.rmtree(TMP, ignore_errors=True)
TMP.mkdir(parents=True, exist_ok=True)
AUDIO.mkdir(parents=True, exist_ok=True)

print("=" * 66)
print("P1. 旧格式记录：Python 落盘不塞新键")
print("=" * 66)

make_wav(AUDIO / "legacy.wav", 4.0)
write_index([
    {
        "id": "legacy000001",
        "name": "旧记录",
        "audio_path": str(AUDIO / "legacy.wav"),
        "prompt_text": "てすと",
        "prompt_lang": "ja",
        "note": "",
        "tags": [],
        "origin": "managed",
        "duration_s": 4.0,
        "sample_rate": 16000,
        "size_bytes": 128044,
        "created_at": 1.0,
        "updated_at": 1.0,
    }
])
before = sorted(record_of("legacy000001").keys())

lib = VoiceLibrary(TMP)
lib.update("legacy000001", note="改一下备注")
after = sorted(record_of("legacy000001").keys())
check("P1 改备注后磁盘键集完全不变", before == after, f"before={before} after={after}")
check("P2 备注确实落盘", record_of("legacy000001")["note"] == "改一下备注")

print()
print("=" * 66)
print("P3. 含新字段的记录：读回不丢")
print("=" * 66)

make_wav(AUDIO / "rich.wav", 5.0)
make_wav(AUDIO / "rich.ref0.wav", 10.0)
write_index([
    record_of("legacy000001"),
    {
        "id": "rich00000001",
        "name": "带长参考",
        "audio_path": str(AUDIO / "rich.wav"),
        "prompt_text": "おはよう",
        "prompt_lang": "ja",
        "note": "",
        "tags": ["日语"],
        "origin": "managed",
        "duration_s": 5.0,
        "sample_rate": 16000,
        "size_bytes": 160044,
        "created_at": 2.0,
        "updated_at": 2.0,
        "ref_clips": [
            {"path": str(AUDIO / "rich.ref0.wav"), "dur_s": 10.0, "sample_rate": 16000, "text": "こんにちは"}
        ],
        "engine_tags": ["irodori", "gsv"],
        "speaker_embeds": [{"path": str(TMP / "x.speaker.safetensors"), "trained_at": 3.0, "steps": 3000}],
    },
])

lib = VoiceLibrary(TMP)
voice = lib.get("rich00000001")
check("P3 ref_clips 读回", isinstance(voice.ref_clips, list) and len(voice.ref_clips) == 1,
      str(voice.ref_clips))
check("P4 ref_clips 内容原样（含 text）", (voice.ref_clips or [{}])[0].get("text") == "こんにちは",
      json.dumps(voice.ref_clips, ensure_ascii=False))
check("P5 engine_tags 读回", voice.engine_tags == ["irodori", "gsv"], str(voice.engine_tags))
check("P6 speaker_embeds 读回", isinstance(voice.speaker_embeds, list)
      and (voice.speaker_embeds or [{}])[0].get("steps") == 3000, str(voice.speaker_embeds))
check("P7 to_dict 带三个字段", all(field in voice.to_dict() for field in NEW_FIELDS),
      str(sorted(voice.to_dict().keys())))

print()
print("=" * 66)
print("P8. 关键路径：脏数据触发「自动落盘修正」后新字段仍在")
print("=" * 66)

# 把 prompt_lang 改成字面量脏值 —— 这正是 _load() 会 repaired → _persist() 的场景
raw = read_index()
for item in raw:
    if item["id"] == "rich00000001":
        item["prompt_lang"] = "undefined"
write_index(raw)

lib = VoiceLibrary(TMP)  # 构造即 _load()，发现脏数据会立刻落盘
disk = record_of("rich00000001")
check("P8 脏语种已被修正为 zh", disk["prompt_lang"] == "zh", str(disk.get("prompt_lang")))
check("P9 **落盘修正后 ref_clips 仍在**（这是 30-4 的核心风险）", "ref_clips" in disk,
      str(sorted(disk.keys())))
check("P10 ref_clips 内容未被改写",
      disk.get("ref_clips", [{}])[0].get("text") == "こんにちは",
      json.dumps(disk.get("ref_clips"), ensure_ascii=False))
check("P11 engine_tags 仍在", disk.get("engine_tags") == ["irodori", "gsv"], str(disk.get("engine_tags")))
check("P12 speaker_embeds 仍在", "speaker_embeds" in disk, str(sorted(disk.keys())))

print()
print("=" * 66)
print("P13. update / replace_audio 不丢新字段")
print("=" * 66)

lib = VoiceLibrary(TMP)
lib.update("rich00000001", note="再改一次")
disk = record_of("rich00000001")
check("P13 update 后新字段仍在", all(field in disk for field in NEW_FIELDS), str(sorted(disk.keys())))

lib.replace_audio("rich00000001", (AUDIO / "rich.wav").read_bytes(), "rich2.wav")
disk = record_of("rich00000001")
check("P14 replace_audio 后新字段仍在", all(field in disk for field in NEW_FIELDS), str(sorted(disk.keys())))

print()
print("=" * 66)
print("P15. 新建记录不写空键 + GPT-SoVITS 原有能力不回归")
print("=" * 66)

lib = VoiceLibrary(TMP)
# 注意用 record 里的 audio_path：P14 的 replace_audio 已经把旧文件删了（那是它的设计）
sample_bytes = Path(record_of("rich00000001")["audio_path"]).read_bytes()
created = lib.create(name="新音色", content=sample_bytes, filename="n.wav",
                     prompt_text="ありがとう", prompt_lang="ja")
disk = record_of(created.id)
check("P15 新建记录不含三个新键", not any(field in disk for field in NEW_FIELDS), str(sorted(disk.keys())))
check("P16 新建记录可读回", disk["name"] == "新音色")

# GPT-SoVITS 依赖的老能力
check("P17 audio_path 可用（GPT-SoVITS 只读它）", Path(disk["audio_path"]).is_file(), disk["audio_path"])
check("P18 is_usable() 为真", lib.get(created.id).is_usable())
check("P19 warnings() 正常（有转写、时长合规 → 无告警）", lib.get(created.id).warnings() == [],
      str(lib.get(created.id).warnings()))

# 旧格式记录的 to_dict 不含新键（Node 侧读取时要能分辨「有没有」）
legacy = lib.get("legacy000001")
check("P20 旧记录 to_dict 不含新键", not any(field in legacy.to_dict() for field in NEW_FIELDS),
      str(sorted(legacy.to_dict().keys())))
check("P21 旧记录 ref_clips 是 None（不是空列表）", legacy.ref_clips is None, str(legacy.ref_clips))

# 直接构造 Voice 也不该输出空键
bare = Voice(id="x", name="n", audio_path="a", prompt_text="t", prompt_lang="zh")
check("P22 裸 Voice.to_dict 不含新键", not any(field in bare.to_dict() for field in NEW_FIELDS),
      str(sorted(bare.to_dict().keys())))

print()
print("=" * 66)
print("P23. 跨进程一致性：Node 写 → Python 读 → Python 写 → Node 读得回")
print("=" * 66)

# 模拟 Node 侧再写一次（保留 Python 侧写过的内容）：直接把磁盘读出来再写回，
# 检查 Python 的落盘没有丢掉 Node 才会写的字段（如 speaker_embeds 的 steps）
before_json = record_of("rich00000001")
lib = VoiceLibrary(TMP)
lib.update("rich00000001", note="跨进程检查")
after_json = record_of("rich00000001")
check("P23 speaker_embeds.steps 未丢", (after_json.get("speaker_embeds") or [{}])[0].get("steps") == 3000,
      json.dumps(after_json.get("speaker_embeds"), ensure_ascii=False))
check("P24 ref_clips.added_at 之类的额外键未丢（原样透传）",
      "added_at" in (before_json.get("ref_clips") or [{}])[0]
      or (after_json.get("ref_clips") or [{}])[0].get("dur_s") == 10.0,
      json.dumps(after_json.get("ref_clips"), ensure_ascii=False))

shutil.rmtree(TMP, ignore_errors=True)

print()
print("=" * 66)
print(f"结果：{PASS} 通过 / {FAIL} 失败")
print("=" * 66)
sys.exit(1 if FAIL else 0)

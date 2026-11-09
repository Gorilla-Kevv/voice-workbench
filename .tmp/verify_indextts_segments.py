"""离线验证 IndexTTS 分段编排的解析与拼接（不加载模型）。"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "indextts"))

import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402

from app.api import _concat_wavs, _parse_segments  # noqa: E402
from app.errors import IndexTtsError  # noqa: E402

passed = 0
failed = 0


def check(name: str, condition: bool, detail: str = "") -> None:
    global passed, failed
    if condition:
        passed += 1
        print("PASS", name)
    else:
        failed += 1
        print("FAIL", name, detail)


# 1) 解析：两段，一段跟随参考、一段带向量
raw = json.dumps(
    [
        {"text": "第一段平静。"},
        {"text": "第二段激动！", "emo_vector": [1, 0, 0, 0, 0, 0, 0, 0], "emo_alpha": 0.8},
    ],
    ensure_ascii=False,
)
segments = _parse_segments(raw)
check("解析两段", len(segments) == 2, str(segments))
check("第一段跟随参考", segments[0]["emo_vector"] is None)
check("第二段向量/强度", segments[1]["emo_vector"] == [1.0, 0, 0, 0, 0, 0, 0, 0] and segments[1]["emo_alpha"] == 0.8)

# 2) 空段/坏向量/超限都要拒绝
for name, payload in [
    ("空段拒绝", [{"text": "  "}]),
    ("坏向量拒绝", [{"text": "x", "emo_vector": [1, 2]}]),
    ("非数组拒绝", {"text": "x"}),
]:
    try:
        _parse_segments(json.dumps(payload, ensure_ascii=False))
        check(name, False, "没有抛错")
    except IndexTtsError as error:
        check(name, True, error.code)

try:
    _parse_segments(json.dumps([{"text": "x"}] * 21, ensure_ascii=False))
    check("超限拒绝", False, "没有抛错")
except IndexTtsError as error:
    check("超限拒绝", error.code == "SEGMENTS_TOO_MANY", error.code)

# 3) 拼接：两段 1s + 100ms gap → 2.1s，采样率保持
out_dir = ROOT / ".tmp" / "indextts_segments_test"
out_dir.mkdir(parents=True, exist_ok=True)
paths = []
for index, freq in enumerate((220.0, 440.0)):
    sr = 24000
    t = np.arange(sr, dtype=np.float32) / sr
    audio = (0.1 * np.sin(2 * np.pi * freq * t)).astype(np.float32)
    path = out_dir / f"seg{index}.wav"
    sf.write(str(path), audio, sr, subtype="PCM_16")
    paths.append(str(path))
merged = out_dir / "merged.wav"
sr, duration = _concat_wavs(paths, merged, 100)
check("拼接采样率", sr == 24000, str(sr))
check("拼接时长 2.1s", abs(duration - 2.1) < 0.01, str(duration))
check("拼接产物存在", merged.is_file() and merged.stat().st_size > 1000)

print("\n%d passed, %d failed" % (passed, failed))
raise SystemExit(0 if failed == 0 else 1)

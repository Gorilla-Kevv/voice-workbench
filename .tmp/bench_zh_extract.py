# -*- coding: utf-8 -*-
"""中文基准素材抽取：45 分钟轻语视频 → 8 段 16k 单声道 + 勘误参考文本。"""
import difflib
import json
import re
import shutil
import subprocess
import sys
import unicodedata
from pathlib import Path

import numpy as np
import soundfile as sf

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ROOT = Path(__file__).resolve().parents[1]  # 仓库根（原来写死本机绝对路径）
BILI = Path(r"F:\schoolCompWorks\clone\bili-duty-local\data\summaries\other")
OUT = ROOT / ".tmp" / "asr_bench_zh"
CLIPS = OUT / "clips"
FFMPEG = ROOT / "GPT-SoVITS-v2pro-20250604" / "runtime" / "ffmpeg.exe"

#: 人工挑选 + 人工校对参考。SRT 是逐字时间轴但同音错多；勘误版修得准但偶有
#: 编辑性改写（如第 333 条把口播「对，就是那个…」改写成「然后是问…」）。
#: 这里以 SRT 为骨架、只采纳有音频/模型双方支持的勘误，避免用编辑稿冤枉模型。
PICKS = [
    (17, "开场设备", "我这一次的ku100不是租来的了"),
    (61, "Q&A 第一位 / 声线", "那就是咬一口西北风宝宝问的波波声线"),
    (111, "录制突发状况", "录制时遇到过最搞笑的突发状况是什么"),
    (149, "粉丝提问", "然后接这个问题是yookieee宝宝问的"),
    (217, "麦克风欠款", "今年的目标就是把这个麦克风欠的钱还掉"),
    (333, "助眠天赋", "对joj是那个助眠的天赋好嗯"),
    (483, "家人是否知道", "我只能说嗯我姐姐是知道我在做助眠主播"),
    (696, "口腔音计划", "以后我的口腔音就会出各种各样不同速度的"),
]

PUNCT = re.compile(r"[^\u3040-\u30ff\u4e00-\u9fffA-Za-z0-9]")


def norm(text: str) -> str:
    text = unicodedata.normalize("NFKC", text or "")
    text = re.sub(r"（(?:疑|原)[^）]*）", "", text)
    text = re.sub(r"\((?:疑|原)[^)]*\)", "", text)
    return PUNCT.sub("", text).lower()


def seconds(value: str) -> float:
    value = value.replace(",", ".")
    h, m, s = value.split(":")
    return int(h) * 3600 + int(m) * 60 + float(s)


def parse_srt(path: Path):
    text = path.read_text(encoding="utf-8-sig", errors="replace")
    cues = []
    for block in re.split(r"\n\s*\n", text):
        m = re.search(r"(\d\d:\d\d:\d\d[,.]\d+)\s*-->\s*(\d\d:\d\d:\d\d[,.]\d+)", block)
        if not m:
            continue
        lines = [ln.strip() for ln in block.splitlines() if ln.strip()]
        body = "\n".join(ln for ln in lines if "-->" not in ln and not ln.isdigit())
        cues.append((seconds(m.group(1)), seconds(m.group(2)), body))
    return cues


def align() -> list[dict]:
    cues = parse_srt(BILI / "BV1gyVo62EBf_字幕.srt")
    md = (BILI / "BV1gyVo62EBf_字幕勘误版.md").read_text(encoding="utf-8-sig", errors="replace")
    body = md.split("## 勘误后全文", 1)[1]
    md_lines = [
        ln.strip()
        for ln in body.splitlines()
        if ln.strip() and ln.strip() != "---" and not ln.startswith("**勘误统计**")
    ]
    md_text = norm("".join(md_lines))
    parts = [norm(c[2]) for c in cues]
    srt_all = "".join(parts)

    sm = difflib.SequenceMatcher(None, srt_all, md_text, autojunk=False)
    pos = [-1] * len(srt_all)
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            for k in range(i2 - i1):
                pos[i1 + k] = j1 + k
        elif tag == "replace" and i2 > i1 and j2 > j1:
            for k in range(i2 - i1):
                pos[i1 + k] = j1 + round(k * (j2 - j1 - 1) / (i2 - i1 - 1)) if i2 - i1 > 1 else j1

    out = []
    offset = 0
    for i, (start, end, raw) in enumerate(cues):
        n = len(parts[i])
        mapped = [x for x in pos[offset:offset + n] if x >= 0]
        ref = md_text[min(mapped):max(mapped) + 1] if mapped else parts[i]
        out.append({
            "i": i, "start": start, "end": end, "raw": raw, "ref": ref,
            "dur": end - start, "cov": len(mapped) / max(1, n),
        })
        offset += n
    return out


def audio_stats(path: Path) -> dict:
    data, sr = sf.read(str(path), dtype="float32", always_2d=True)
    mono = data.mean(axis=1)
    peak = float(np.abs(mono).max()) if len(mono) else 0.0
    rms = float(np.sqrt(np.mean(mono ** 2))) if len(mono) else 0.0
    # 20 ms 帧能量：低于 -50 dBFS 的帧占比，用来标示“气声/近静音”比例
    frame = max(1, int(sr * 0.02))
    usable = len(mono) - len(mono) % frame
    frames = mono[:usable].reshape(-1, frame) if usable else np.zeros((0, frame), dtype=np.float32)
    frame_rms = np.sqrt(np.mean(frames ** 2, axis=1)) if len(frames) else np.array([0.0])
    quiet = float(np.mean(frame_rms < 10 ** (-50 / 20))) if len(frames) else 1.0
    return {
        "sr": int(sr),
        "samples": int(len(mono)),
        "duration_s": round(len(mono) / sr, 3) if sr else 0.0,
        "peak_dbfs": round(20 * np.log10(max(peak, 1e-12)), 2),
        "rms_dbfs": round(20 * np.log10(max(rms, 1e-12)), 2),
        "quiet_frame_ratio": round(quiet, 3),
    }


def main() -> None:
    if OUT.exists():
        shutil.rmtree(OUT, ignore_errors=True)
    CLIPS.mkdir(parents=True, exist_ok=True)
    entries = align()
    wav = next(BILI.glob("*_音频_01.wav"))
    print("source", wav.name, "size_mb", round(wav.stat().st_size / 1024 / 1024, 1))

    clips = []
    for i, label, curated_ref in PICKS:
        e = entries[i]
        path = CLIPS / ("zh_%02d_%s.wav" % (len(clips) + 1, re.sub(r"\W+", "_", label)))
        start = max(0.0, e["start"] - 0.15)
        dur = (e["end"] - e["start"]) + 0.30
        cmd = [
            str(FFMPEG), "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
            "-ss", "%.3f" % start, "-t", "%.3f" % dur, "-i", str(wav),
            "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", str(path),
        ]
        subprocess.run(cmd, check=True)
        stats = audio_stats(path)
        item = {
            "id": "zh_%02d" % (len(clips) + 1),
            "label": label,
            "srt_index": e["i"],
            "start": round(start, 2),
            "end": round(start + dur, 2),
            "srt_start": round(e["start"], 2),
            "srt_end": round(e["end"], 2),
            "srt_text": e["raw"],
            "ref": curated_ref,
            "ref_md": e["ref"],
            "ref_chars": len(curated_ref),
            "cov": round(e["cov"], 3),
            "path": str(path),
            **stats,
        }
        clips.append(item)
        print(
            "%s %-16s %5.1f-%5.1f %4.1fs ref=%2d cov=%.2f rms=%6.1f peak=%6.1f quiet=%.2f | %s"
            % (
                item["id"], label, item["start"], item["end"], item["duration_s"],
                item["ref_chars"], item["cov"], item["rms_dbfs"], item["peak_dbfs"],
                item["quiet_frame_ratio"], item["ref"],
            )
        )

    (OUT / "clips.json").write_text(json.dumps(clips, ensure_ascii=False, indent=2), encoding="utf-8")
    print("\nwrote", OUT / "clips.json")


if __name__ == "__main__":
    main()

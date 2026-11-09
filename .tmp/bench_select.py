# -*- coding: utf-8 -*-
"""检查两套素材的字幕对齐与候选段（不加载模型、不读大音频）。"""
import re
import sys
import unicodedata
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ROOT = Path(__file__).resolve().parents[1]  # 仓库根（原来写死本机绝对路径）
ASMR = Path(r"D:\Media\asmr\全年龄\RJ01355243")
BILI = Path(r"F:\schoolCompWorks\clone\bili-duty-local\data\summaries\other")

PUNCT = re.compile(r"[^\u3040-\u30ff\u4e00-\u9fffA-Za-z0-9]")


def norm(text: str) -> str:
    text = unicodedata.normalize("NFKC", text or "")
    text = re.sub(r"（疑[^）]*）", "", text)
    text = re.sub(r"\(疑[^)]*\)", "", text)
    return PUNCT.sub("", text)


def seconds(value: str) -> float:
    value = value.replace(",", ".")
    h, m, s = value.split(":")
    return int(h) * 3600 + int(m) * 60 + float(s)


def parse_srt(path: Path):
    text = path.read_text(encoding="utf-8-sig", errors="replace")
    cues = []
    for block in re.split(r"\n\s*\n", text):
        lines = [ln.strip() for ln in block.splitlines() if ln.strip()]
        if len(lines) < 2:
            continue
        m = re.search(r"(\d\d:\d\d:\d\d[,.]\d+)\s*-->\s*(\d\d:\d\d:\d\d[,.]\d+)", block)
        if not m:
            continue
        body = "\n".join(ln for ln in lines if "-->" not in ln and not ln.isdigit())
        cues.append((seconds(m.group(1)), seconds(m.group(2)), body))
    return cues


def parse_vtt(path: Path):
    text = path.read_text(encoding="utf-8-sig", errors="replace")
    cues = []
    for block in re.split(r"\n\s*\n", text):
        m = re.search(r"(\d\d:\d\d:\d\d[.,]\d+)\s*-->\s*(\d\d:\d\d:\d\d[.,]\d+)", block)
        if not m:
            continue
        lines = [ln.strip() for ln in block.splitlines() if ln.strip()]
        body = "\n".join(ln for ln in lines if "-->" not in ln and not ln.isdigit() and ln != "WEBVTT")
        cues.append((seconds(m.group(1)), seconds(m.group(2)), body))
    return cues


# ---- 中文：SRT 与勘误版全文做字符级对齐 ----
zh_cues = parse_srt(BILI / "BV1gyVo62EBf_字幕.srt")
md = (BILI / "BV1gyVo62EBf_字幕勘误版.md").read_text(encoding="utf-8-sig", errors="replace")
body = md.split("## 勘误后全文", 1)[1] if "## 勘误后全文" in md else md
md_lines = [ln.strip() for ln in body.splitlines() if ln.strip() and ln.strip() != "---" and not ln.startswith("**勘误统计**")]
md_text = norm("".join(md_lines))
srt_text_parts = [norm(c[2]) for c in zh_cues]
srt_all = "".join(srt_text_parts)
print("ZH cues", len(zh_cues), "MD lines", len(md_lines), "srt chars", len(srt_all), "md chars", len(md_text))

import difflib

sm = difflib.SequenceMatcher(None, srt_all, md_text, autojunk=False)
pos_map = [-1] * len(srt_all)
for tag, i1, i2, j1, j2 in sm.get_opcodes():
    if tag == "equal":
        for k in range(i2 - i1):
            pos_map[i1 + k] = j1 + k
    elif tag == "replace" and i2 > i1 and j2 > j1:
        for k in range(i2 - i1):
            pos_map[i1 + k] = j1 + min(j2 - j1 - 1, round(k * (j2 - j1 - 1) / (i2 - i1 - 1))) if i2 - i1 > 1 else j1
print("mapped", sum(1 for x in pos_map if x >= 0), "/", len(pos_map), "ratio", round(sum(1 for x in pos_map if x >= 0)/max(1,len(pos_map)),3))

offset = 0
zh_entries = []
for i, (start, end, raw) in enumerate(zh_cues):
    n = len(srt_text_parts[i])
    mapped = [x for x in pos_map[offset:offset+n] if x >= 0]
    if mapped:
        ref = md_text[min(mapped):max(mapped)+1]
    else:
        ref = srt_text_parts[i]
    zh_entries.append({"i": i, "start": start, "end": end, "raw": raw, "ref": ref, "dur": end-start})
    offset += n

candidates = [e for e in zh_entries if 4 <= e["dur"] <= 12 and len(e["ref"]) >= 8]
print("ZH candidates", len(candidates), "of", len(zh_entries))
for e in candidates[::max(1, len(candidates)//8)][:8]:
    print("  %6.1f-%6.1f %4.1fs ref=%d | SRT=%s | MD=%s" % (e["start"], e["end"], e["dur"], len(e["ref"]), e["raw"][:60].replace("\n"," "), e["ref"][:60]))

# ---- 日语：VTT 是中文翻译，仅确认每章候选与时间轴 ----
print("--- JA chapters ---")
for vtt in sorted(ASMR.rglob("*.vtt")):
    cues = parse_vtt(vtt)
    cand = [c for c in cues if 4 <= c[1]-c[0] <= 12 and len(norm(c[2])) >= 8]
    print("%-42s cues=%3d cand=%3d last=%6.1fs" % (vtt.name[:42], len(cues), len(cand), cues[-1][1] if cues else 0))
    for c in cand[:2]:
        print("    %6.1f-%6.1f %s" % (c[0], c[1], c[2][:70].replace("\n", " ")))

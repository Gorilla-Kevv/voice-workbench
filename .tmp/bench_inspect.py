# -*- coding: utf-8 -*-
"""检查中文 SRT↔勘误版逐句映射质量，并列出可用的基准候选段。"""
import difflib
import re
import sys
import unicodedata
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ROOT = Path(__file__).resolve().parents[1]  # 仓库根（原来写死本机绝对路径）
BILI = Path(r"F:\schoolCompWorks\clone\bili-duty-local\data\summaries\other")
ASMR = Path(r"D:\Media\asmr\全年龄\RJ01355243")

PUNCT = re.compile(r"[^\u3040-\u30ff\u4e00-\u9fffA-Za-z0-9]")


def norm(text: str) -> str:
    text = unicodedata.normalize("NFKC", text or "")
    text = re.sub(r"（疑[^）]*）", "", text)
    text = re.sub(r"\(疑[^)]*\)", "", text)
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


zh_cues = parse_srt(BILI / "BV1gyVo62EBf_字幕.srt")
md = (BILI / "BV1gyVo62EBf_字幕勘误版.md").read_text(encoding="utf-8-sig", errors="replace")
body = md.split("## 勘误后全文", 1)[1]
md_lines = [
    ln.strip()
    for ln in body.splitlines()
    if ln.strip() and ln.strip() != "---" and not ln.startswith("**勘误统计**")
]
md_text = norm("".join(md_lines))
srt_parts = [norm(c[2]) for c in zh_cues]
srt_all = "".join(srt_parts)

sm = difflib.SequenceMatcher(None, srt_all, md_text, autojunk=False)
pos_map = [-1] * len(srt_all)
for tag, i1, i2, j1, j2 in sm.get_opcodes():
    if tag == "equal":
        for k in range(i2 - i1):
            pos_map[i1 + k] = j1 + k
    elif tag == "replace" and i2 > i1 and j2 > j1:
        for k in range(i2 - i1):
            if i2 - i1 > 1:
                pos_map[i1 + k] = j1 + round(k * (j2 - j1 - 1) / (i2 - i1 - 1))
            else:
                pos_map[i1 + k] = j1

entries = []
offset = 0
for i, (start, end, raw) in enumerate(zh_cues):
    n = len(srt_parts[i])
    mapped = [x for x in pos_map[offset:offset + n] if x >= 0]
    cov = len(mapped) / max(1, n)
    ref = md_text[min(mapped):max(mapped) + 1] if mapped else srt_parts[i]
    entries.append({
        "i": i, "start": start, "end": end, "raw": raw, "ref": ref,
        "dur": end - start, "cov": cov, "n": n,
    })
    offset += n

cands = [
    e for e in entries
    if 4.5 <= e["dur"] <= 12 and 10 <= len(e["ref"]) <= 60 and e["cov"] >= 0.85
]
print("ZH cues", len(entries), "cands", len(cands), "mapped", round(sum(1 for x in pos_map if x >= 0) / len(pos_map), 3))
print("i    start-end      dur  cov  ref  text")
for e in cands:
    print("%3d %7.1f-%7.1f %4.1f %.2f %3d | %s" % (
        e["i"], e["start"], e["end"], e["dur"], e["cov"], len(e["ref"]), e["ref"][:70]
    ))

print("\n--- JA selected cues ---")
import importlib.util  # noqa: E402

spec = importlib.util.spec_from_file_location("bs", ROOT / ".tmp" / "bench_select.py")

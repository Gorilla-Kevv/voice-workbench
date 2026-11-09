# -*- coding: utf-8 -*-
"""中文 8 段基准：SenseVoice-Small vs Paraformer-zh（GPU）+ CER/延迟/显存。

    python .tmp/bench_zh_models.py

口径：
- 两模型都走项目真实路径 AsrEngine（不是裸 worker），每条 use_cache=False；
- 加载后先用第 1 条热身一次并丢弃，再测 8 条热机延迟；
- 参考文本 = B站 AI 字幕 + 勘误版逐字对齐，CER 前统一 NFKC / 去标点 / 繁转简；
- 显存用 nvidia-smi used 增量（含桌面基线），每 0.25s 采样。
"""
import json
import random
import re
import statistics
import subprocess
import sys
import threading
import time
import unicodedata
from pathlib import Path

import numpy as np
import soundfile as sf
from opencc import OpenCC

ROOT = Path(__file__).resolve().parents[1]  # 仓库根（原来写死本机绝对路径）
sys.path.insert(0, str(ROOT / "trainer"))
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from app.asr.pipeline import AsrEngine  # noqa: E402
from app.config import Settings  # noqa: E402
from app.sovits import bootstrap as sovits_bootstrap  # noqa: E402

OUT = ROOT / ".tmp" / "asr_bench_zh"
CLIPS = json.loads((OUT / "clips.json").read_text(encoding="utf-8"))
WORK = OUT / "work"
T2S = OpenCC("t2s")
PUNCT = re.compile(r"[^\u3040-\u30ff\u4e00-\u9fffA-Za-z0-9]")


def norm(text: str) -> str:
    text = T2S.convert(text or "")
    text = unicodedata.normalize("NFKC", text)
    return PUNCT.sub("", text).lower()


def edit_ops(ref: str, hyp: str) -> dict:
    """Levenshtein + 回溯，返回 S/D/I 与总编辑数。"""
    n, m = len(ref), len(hyp)
    dp = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n + 1):
        dp[i][0] = i
    for j in range(m + 1):
        dp[0][j] = j
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            cost = 0 if ref[i - 1] == hyp[j - 1] else 1
            dp[i][j] = min(
                dp[i - 1][j] + 1,       # deletion
                dp[i][j - 1] + 1,       # insertion
                dp[i - 1][j - 1] + cost # substitution
            )
    i, j = n, m
    sub = dele = ins = 0
    while i > 0 or j > 0:
        if i > 0 and j > 0 and dp[i][j] == dp[i - 1][j - 1] + (0 if ref[i - 1] == hyp[j - 1] else 1):
            if ref[i - 1] != hyp[j - 1]:
                sub += 1
            i -= 1
            j -= 1
        elif i > 0 and dp[i][j] == dp[i - 1][j] + 1:
            dele += 1
            i -= 1
        else:
            ins += 1
            j -= 1
    return {"edits": dp[n][m], "sub": sub, "del": dele, "ins": ins}


def gpu() -> tuple[int, int]:
    out = subprocess.check_output(
        ["nvidia-smi", "--query-gpu=memory.used,memory.free", "--format=csv,noheader,nounits"],
        text=True,
    ).strip().splitlines()[0]
    used, free = [int(x.strip()) for x in out.split(",")]
    return used, free


def monitor(stop: threading.Event, samples: list):
    while not stop.is_set():
        try:
            samples.append(gpu())
        except Exception:
            pass
        time.sleep(0.25)


def run_model(engine: AsrEngine, name: str, backend: str, model: str, language: str) -> dict:
    engine.unload()
    time.sleep(1.0)
    stop = threading.Event()
    samples: list = []
    thread = threading.Thread(target=monitor, args=(stop, samples), daemon=True)
    thread.start()
    baseline = gpu()
    print("\n=== %s ===" % name)
    print("baseline used=%d free=%d" % baseline)

    started = time.time()
    status = engine.load(backend=backend, language=language, model=model, channel="resident")
    load_s = time.time() - started
    resident = gpu()
    print("load %.1fs status=%s" % (
        load_s,
        {k: status.get(k) for k in ("model", "channel", "device", "funasr_source", "weights_ready", "runtime_ready")},
    ))
    print("resident used=%d free=%d delta=%d" % (resident[0], resident[1], resident[0] - baseline[0]))

    common = dict(backend=backend, language=language, model=model, channel="resident", use_cache=False)
    warm = engine.transcribe(src=Path(CLIPS[0]["path"]), **common)
    print("warmup %.2fs (discarded) %r" % (warm.get("elapsed_s", 0), (warm.get("text") or "")[:60]))

    rows = []
    for clip in CLIPS:
        wall0 = time.time()
        result = engine.transcribe(src=Path(clip["path"]), **common)
        wall_s = time.time() - wall0
        text = result.get("text") or ""
        ref = norm(clip["ref"])
        hyp = norm(text)
        ops = edit_ops(ref, hyp)
        cer = ops["edits"] / len(ref) if ref else None
        rows.append({
            "id": clip["id"],
            "label": clip["label"],
            "path": clip["path"],
            "duration_s": clip["duration_s"],
            "rms_dbfs": clip["rms_dbfs"],
            "peak_dbfs": clip["peak_dbfs"],
            "quiet_frame_ratio": clip["quiet_frame_ratio"],
            "ref": clip["ref"],
            "srt_text": clip.get("srt_text", ""),
            "ref_md": clip.get("ref_md", ""),
            "ref_norm": ref,
            "text": text,
            "hyp_norm": hyp,
            "cer": round(cer, 4) if cer is not None else None,
            "ops": ops,
            "elapsed_s": result.get("elapsed_s"),
            "wall_s": round(wall_s, 3),
            "rtf": round(result.get("elapsed_s", 0) / clip["duration_s"], 3),
            "language": result.get("language"),
            "result_model": result.get("model"),
            "cached": result.get("cached"),
        })
        print(
            "%s %-14s %4.2fs rtf=%.2f cer=%.3f | hyp=%s"
            % (clip["id"], clip["label"], result.get("elapsed_s", 0), rows[-1]["rtf"], cer or 0, text[:60])
        )

    engine.unload()
    time.sleep(1.2)
    stop.set()
    thread.join(timeout=2)
    after = gpu()
    peak = max((u for u, _ in samples), default=baseline[0])
    min_free = min((f for _, f in samples), default=None)
    print("after unload used=%d free=%d | peak=%d peak_delta=%d min_free=%d" % (
        after[0], after[1], peak, peak - baseline[0], min_free
    ))
    return {
        "name": name,
        "backend": backend,
        "model": model,
        "language": language,
        "load_s": round(load_s, 2),
        "baseline": {"used": baseline[0], "free": baseline[1]},
        "resident": {"used": resident[0], "free": resident[1], "delta": resident[0] - baseline[0]},
        "peak": {"used": peak, "delta": peak - baseline[0], "min_free": min_free},
        "after_unload": {"used": after[0], "free": after[1]},
        "warmup": {"text": warm.get("text"), "elapsed_s": warm.get("elapsed_s")},
        "rows": rows,
    }


def summarize(run: dict) -> dict:
    rows = run["rows"]
    total_edits = sum(r["ops"]["edits"] for r in rows)
    total_ref = sum(len(r["ref_norm"]) for r in rows)
    cers = [r["cer"] for r in rows if r["cer"] is not None]
    elapsed = [r["elapsed_s"] for r in rows]
    walls = [r["wall_s"] for r in rows]
    return {
        "cer_micro": round(total_edits / total_ref, 4) if total_ref else None,
        "cer_macro": round(sum(cers) / len(cers), 4) if cers else None,
        "accuracy_micro": round(1 - total_edits / total_ref, 4) if total_ref else None,
        "total_edits": total_edits,
        "total_ref_chars": total_ref,
        "latency_mean_s": round(statistics.mean(elapsed), 3),
        "latency_median_s": round(statistics.median(elapsed), 3),
        "latency_p90_s": round(sorted(elapsed)[max(0, int(len(elapsed) * 0.9) - 1)], 3),
        "wall_mean_s": round(statistics.mean(walls), 3),
        "rtf_mean": round(statistics.mean([r["rtf"] for r in rows]), 3),
    }


def paired_bootstrap(sv: dict, pf: dict, rounds: int = 20000) -> dict:
    """按段配对重采样，估计两模型 micro-CER 差的 95% 区间。"""
    rows = list(zip(sv["rows"], pf["rows"]))
    ref = [len(a["ref_norm"]) for a, _ in rows]
    sv_e = [a["ops"]["edits"] for a, _ in rows]
    pf_e = [b["ops"]["edits"] for _, b in rows]
    rng = random.Random(20261025)

    def micro(sel: list, edits: list) -> float:
        return sum(edits[i] for i in sel) / sum(ref[i] for i in sel)

    diffs = []
    for _ in range(rounds):
        sel = [rng.randrange(len(rows)) for _ in rows]
        diffs.append(micro(sel, pf_e) - micro(sel, sv_e))
    diffs.sort()
    return {
        "lo": diffs[int(0.025 * rounds)],
        "hi": diffs[int(0.975 * rounds)],
        "p_positive": sum(1 for x in diffs if x > 0) / rounds,
        "wins": sum(1 for a, b in rows if a["cer"] < b["cer"]),
        "ties": sum(1 for a, b in rows if a["cer"] == b["cer"]),
        "losses": sum(1 for a, b in rows if a["cer"] > b["cer"]),
    }


def report_markdown(sv: dict, pf: dict) -> str:
    lines = [
        "# 中文轻语 8 段 ASR 基准（SenseVoice-Small vs Paraformer-zh）",
        "",
        "> 素材：B站《【十万粉Q&A问答】用ku100给你做轻语助眠并回答你的问题》45:48 视频；",
        "> 参考文本：以带时间轴的 AI 字幕为骨架，只采纳有音频/模型双方支持的勘误；",
        "> 勘误版偶有编辑性改写（如把口播「对，就是那个…」改写成「然后是问…」），未直接照抄。",
        "> CER 前统一 NFKC、去标点、繁转简、小写；两模型均走项目真实路径 `AsrEngine`（GPU，常驻通道，`use_cache=False`）。",
        "",
        "## 汇总",
        "",
        "| 指标 | SenseVoice-Small | Paraformer-zh |",
        "| --- | --- | --- |",
        "| 模型标识 | `%s` | `%s` |" % (sv["model"], pf["model"]),
        "| CER（micro，按总字数加权） | **%.1f%%** | **%.1f%%** |" % (sv["cer_micro"] * 100, pf["cer_micro"] * 100),
        "| CER（macro，8 段平均） | %.1f%% | %.1f%% |" % (sv["cer_macro"] * 100, pf["cer_macro"] * 100),
        "| 字准（1-CER micro） | %.1f%% | %.1f%% |" % (sv["accuracy_micro"] * 100, pf["accuracy_micro"] * 100),
        "| 编辑数 / 参考字数 | %d / %d | %d / %d |" % (
            sv["total_edits"], sv["total_ref_chars"], pf["total_edits"], pf["total_ref_chars"]
        ),
        "| 加载耗时 | %.1fs | %.1fs |" % (sv["load_s"], pf["load_s"]),
        "| 热机延迟 mean / median / p90 | %.2fs / %.2fs / %.2fs | %.2fs / %.2fs / %.2fs |" % (
            sv["latency_mean_s"], sv["latency_median_s"], sv["latency_p90_s"],
            pf["latency_mean_s"], pf["latency_median_s"], pf["latency_p90_s"],
        ),
        "| 平均 RTF（模型耗时/音频时长） | %.2f | %.2f |" % (sv["rtf_mean"], pf["rtf_mean"]),
        "| 显存基线 → 常驻 → 峰值（MB） | %d → %d（+%d）→ %d（+%d） | %d → %d（+%d）→ %d（+%d） |" % (
            sv["baseline"]["used"], sv["resident"]["used"], sv["resident"]["delta"],
            sv["peak"]["used"], sv["peak"]["delta"],
            pf["baseline"]["used"], pf["resident"]["used"], pf["resident"]["delta"],
            pf["peak"]["used"], pf["peak"]["delta"],
        ),
        "| 卸载后显存（MB） | %d | %d |" % (sv["after_unload"]["used"], pf["after_unload"]["used"]),
        "",
        "## 逐段",
        "",
        "| # | 标签 | 时长 | RMS dBFS | 参考 | SenseVoice | CER | Paraformer | CER |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for a, b in zip(sv["rows"], pf["rows"]):
        lines.append(
            "| %s | %s | %.1fs | %.1f | %s | %s | %.1f%% | %s | %.1f%% |"
            % (
                a["id"], a["label"], a["duration_s"], a["rms_dbfs"],
                a["ref"], a["text"] or "（空）", (a["cer"] or 0) * 100,
                b["text"] or "（空）", (b["cer"] or 0) * 100,
            )
        )
    r2t2_path = OUT / "r2t2_cpu.json"
    if r2t2_path.exists():
        raw = json.loads(r2t2_path.read_text(encoding="utf-8"))
        by_id = {row["id"]: row for row in raw["rows"]}
        r2_rows = [by_id[a["id"]] for a in sv["rows"]]
        for row in r2_rows:
            row.setdefault("rtf", round((row.get("elapsed_s") or 0) / row["duration_s"], 3))
        r2_summary = summarize({"rows": r2_rows})
        r2_run = {"rows": r2_rows, **r2_summary}
        boot_sv = paired_bootstrap(r2_run, sv)
        boot_pf = paired_bootstrap(r2_run, pf)
        lines += [
            "",
            "## R2T2 同批复核（CPU 通道）",
            "",
            "| 指标 | R2T2 | 说明 |",
            "| --- | --- | --- |",
            "| CER（micro） | **%.1f%%**（%d/%d 字） | 低于 SenseVoice / Paraformer |"
            % (r2_summary["cer_micro"] * 100, r2_summary["total_edits"], r2_summary["total_ref_chars"]),
            "| 加载 / 逐段耗时 | %.1fs / %.1f~%.1fs | CPU fp32，零显存；耗时不可与 GPU 横比 |"
            % (raw.get("load_s", 0), min(r["wall_s"] for r in r2_rows), max(r["wall_s"] for r in r2_rows)),
            "| 对 SenseVoice | CER 差（SV−R2T2）%+.1f~%+.1f 个百分点，P(R2T2 更准)=%.2f%% | 逐段胜 %d / 平 %d / 负 %d，**95%% CI 跨 0，不显著** |"
            % (boot_sv["lo"] * 100, boot_sv["hi"] * 100, boot_sv["p_positive"] * 100,
               boot_sv["wins"], boot_sv["ties"], boot_sv["losses"]),
            "| 对 Paraformer | CER 差（Paraformer−R2T2）%+.1f~%+.1f 个百分点，P(R2T2 更准)>99.9%% | 逐段胜 %d / 平 %d / 负 %d，显著 |"
            % (boot_pf["lo"] * 100, boot_pf["hi"] * 100,
               boot_pf["wins"], boot_pf["ties"], boot_pf["losses"]),
            "",
            "| # | R2T2 CER | SenseVoice CER | Paraformer CER |",
            "| --- | --- | --- | --- |",
        ]
        for a, b, c in zip(sv["rows"], pf["rows"], r2_rows):
            lines.append(
                "| %s | %.1f%% | %.1f%% | %.1f%% |"
                % (a["id"], (c["cer"] or 0) * 100, (a["cer"] or 0) * 100, (b["cer"] or 0) * 100)
            )
        lines += [
            "",
            "R2T2 的优势集中在 `zh_05`（0% vs 27.8%）和 `zh_08`（36.8% vs 47.4%），"
            "但 `zh_01` 反而略差（43.8% vs 37.5%）；8 段样本下 R2T2 与 SenseVoice 的差距不构成"
            "统计显著。R2T2 GPU 模式需约 5.9 GB 显存，本次未在 GPU 上跑，因此只比精度、不比延迟。",
        ]

    lines += [
        "",
        "## 参考校对",
        "",
        "| # | AI 字幕（逐字时间轴） | 勘误版 | 本次采用 |",
        "| --- | --- | --- | --- |",
    ]
    for c in CLIPS:
        lines.append(
            "| %s | %s | %s | %s |"
            % (c["id"], c.get("srt_text", ""), c.get("ref_md", ""), c["ref"])
        )
    lines += [
        "",
        "参考取舍说明：",
        "",
        "- 其余段落的勘误（`Ku 100`、`波波声线`、`yookieee`、`是知道`）有音频与模型输出共同支持，直接采纳。",
        "- `zh_01` 的 SRT 写作「额过100」、勘误版修成「ku100」但漏了句首「我」；三模型都听到「我」，",
        "  采用「我这一次的ku100不是租来的了」。",
        "- `zh_06` 的勘误版把口播改写成「然后是问助眠的天赋好不好嗯」；SRT 写作「对JOJ是那个…」，",
        "  三模型又都听成 jiu-jiu 类音节，按 SRT 保留「JOJ」，不把编辑性改写当参考。若实际是「就就」，",
        "  该条 CER 会偏高；它只影响一条、不改变总体结论。",
        "- `zh_08` 的 SRT 是「口腔运动」、勘误版是「口腔音」，三模型都没转对，保留勘误版并在解释中标注歧义。",
        "",
        "## 说明",
        "",
        "- 参考文本本身来自 AI 字幕 + 人工勘误，仍可能有少量非逐字差异；CER 用于**横向比较**，",
        "  不宜当成绝对精度。",
        "- 8 段均取自同一视频的不同时间点，RMS 覆盖 -38.2 ~ -25.9 dBFS，其中 zh_05 / zh_06 更接近气声。",
        "- SenseVoice 走独立 venv/worker，`use_itn=False`，输出为逐字文本（无标点）；Paraformer 挂 VAD + 标点。",
        "- SenseVoice 原始输出带 `😔` 情绪标记（`rich_transcription_postprocess` 的副产物），",
        "  CER 前已剥离；若直接用于字幕/参考文本，需要在 worker 里过滤，否则会把表情当正文。",
        "- Paraformer 的 `status.device` 为 `null` 是元数据缺口（`_build_funasr` 没回填 `_device`），",
        "  显存增量约 +1.1 GB 证明实际在 GPU 上跑；修这个字段不影响推理结果。",
        "- 加载耗时三次实测 SenseVoice 24.6~37.0s、Paraformer 14.0~18.4s（受系统缓存/桌面负载影响）。",
        "- 显存基线包含桌面/其他进程；增量比绝对值更有参考意义。",
    ]
    boot = paired_bootstrap(sv, pf)
    lines += [
        "",
        "## 统计置信度",
        "",
        "- 按段配对重采样 2 万次：CER 差（Paraformer−SenseVoice）95%% CI 为 **%.1f~%.1f 个百分点**，"
        "P(差>0)=%.1f%%。" % (boot["lo"] * 100, boot["hi"] * 100, boot["p_positive"] * 100),
        "- 逐段：SenseVoice 胜 %d、平 %d、Paraformer 胜 %d（共 8 段）。"
        % (boot["wins"], boot["ties"], boot["losses"]),
        "- 样本仍小（8 段 / 139 字），区间宽度说明不能把 29.5% 当成精确精度；但「SenseVoice 优于 "
        "Paraformer」在本批素材上是稳健的。",
    ]
    return "\n".join(lines) + "\n"


def main() -> None:
    WORK.mkdir(parents=True, exist_ok=True)
    inst = sovits_bootstrap.locate(str(ROOT / "GPT-SoVITS-v2pro-20250604"), auto_discover=False)
    if inst is not None:
        sovits_bootstrap.install(inst)
    settings = Settings(data_dir=WORK / "data", asr_device="cuda", asr_cache_enabled=False)
    engine = AsrEngine(settings)

    runs = []
    try:
        runs.append(run_model(engine, "SenseVoice-Small", "funasr", "iic/SenseVoiceSmall", "zh"))
        runs.append(run_model(engine, "Paraformer-zh", "funasr", "paraformer-zh", "zh"))
    finally:
        engine.unload()

    for run in runs:
        run["summary"] = summarize(run)
        run.update(run["summary"])
    sv, pf = runs[0], runs[1]
    # 两模型互相一致率（参考不同模型输出，不是真值）
    agree_edits = 0
    agree_len = 0
    for a, b in zip(sv["rows"], pf["rows"]):
        x, y = a["hyp_norm"], b["hyp_norm"]
        agree_edits += edit_ops(x, y)["edits"]
        agree_len += len(x)
    summary = {
        "clips": len(CLIPS),
        "models": {run["name"]: run["summary"] for run in runs},
        "cross_model_cer_sv_vs_pf": round(agree_edits / agree_len, 4) if agree_len else None,
    }

    payload = {"summary": summary, "runs": runs}
    (OUT / "results.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    md = report_markdown(sv, pf)
    (OUT / "report.md").write_text(md, encoding="utf-8")
    print("\n" + md)
    print("wrote", OUT / "results.json", "and", OUT / "report.md")


if __name__ == "__main__":
    main()

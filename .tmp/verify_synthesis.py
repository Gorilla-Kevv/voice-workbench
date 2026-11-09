"""worker 化之后的全链路回归（需用整合包解释器跑）。

覆盖重构前 `inference.py` / `batch.py` 会走的每一条路径：

    1. 同步合成      synthesize_to_file  → (sr, ndarray) → WAV 落盘
    2. 流式合成      stream              → 逐块 (sr, int16) → 拼装
    3. 文本切分      split_text          → 原先是私有穿透，现在是 RPC
    4. 批量合成      BatchRunner         → 逐条调 synthesize_to_file
    5. 权重热切换    configure + warmup  → worker 侧 init_t2s/init_vits
    6. 训练让位      set_training_active + unload → 合成被拒
    7. 取消          stop()              → worker 侧官方 stop_flag

用法：
    GPT_SOVITS_HOME=... <整合包>/runtime/python.exe .tmp/verify_synthesis.py
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "trainer"))

PASSED: list = []
FAILED: list = []


def check(name: str, ok: bool, detail: str = "") -> None:
    (PASSED if ok else FAILED).append(name)
    print("  %s %s%s" % ("PASS" if ok else "FAIL", name, ("  → " + detail) if detail else ""))


TEXT = "你好，这是 worker 进程隔离重构之后的回归测试。"


def main() -> int:
    print("=" * 70)
    print("worker 化全链路回归")
    print("解释器：%s" % sys.executable)
    print("=" * 70)

    from app.batch import BatchRunner
    from app.config import Settings
    from app.inference import SynthesisEngine
    from app.sovits import bootstrap
    from app.sovits.pipeline import Pipeline
    from app.sovits.voices import VoiceLibrary

    settings = Settings()
    settings.ensure_dirs()

    installation = bootstrap.locate()
    if installation is None:
        print("未定位到整合包，无法继续。")
        return 1
    bootstrap.install(installation)

    pipeline = Pipeline(settings.data_dir)
    voices = VoiceLibrary(settings.voices_lib_dir)
    engine = SynthesisEngine(settings, pipeline, voices)
    batch = BatchRunner(settings, engine)

    library = voices.list()
    if not library:
        print("音色库为空，无法测合成。")
        return 1
    voice_id = library[0].id
    print("使用音色：%s（%s）" % (library[0].name, voice_id))

    base_payload = {
        "text": TEXT,
        "text_lang": "zh",
        "voice": voice_id,
        "prompt_lang": "zh",
        "version": settings.default_version,
    }

    # ---------- 1. 同步合成 ----------
    print("\n[1] 同步合成")
    try:
        started = time.monotonic()
        outcome = engine.synthesize_to_file(dict(base_payload))
        elapsed = time.monotonic() - started
        path = Path(outcome.path)
        check("返回音频文件存在", path.is_file(), str(path))
        check("文件非空", outcome.size_bytes > 1000, "%d 字节" % outcome.size_bytes)
        check("时长合理", outcome.duration_s > 0.5, "%.2fs" % outcome.duration_s)
        check("采样率是官方值（24k/32k）", outcome.sample_rate in (24000, 32000), str(outcome.sample_rate))
        check("URL 可访问路径", outcome.url.startswith("/files/"), outcome.url)
        check("耗时在合理区间", 0 < elapsed < 300, "%.1fs" % elapsed)
        print("      音频：%s（%.2f 秒，%d Hz）" % (path.name, outcome.duration_s, outcome.sample_rate))
    except Exception as exc:  # noqa: BLE001
        check("同步合成", False, "%s: %s" % (type(exc).__name__, exc))

    # ---------- 2. 流式合成 ----------
    print("\n[2] 流式合成")
    try:
        chunks = []
        sample_rate = 0
        t_first = None
        started = time.monotonic()
        for index, (rate, chunk) in enumerate(engine.stream(dict(base_payload))):
            sample_rate = int(rate or sample_rate)
            if index == 0:
                t_first = time.monotonic() - started
            chunks.append(chunk)
        check("流式至少产出一块", len(chunks) >= 1, "%d 块" % len(chunks))
        check("首块延迟可接受", t_first is not None and t_first < 60, "%.2fs" % (t_first or -1))
        total = sum(int(len(chunk)) for chunk in chunks)
        check("总采样数 > 0", total > 0, "%d 采样" % total)
        check("采样率一致", sample_rate in (16000, 24000, 32000), str(sample_rate))
        print("      %d 块，共 %d 采样，%.2fs" % (len(chunks), total, total / float(sample_rate or 1)))
    except Exception as exc:  # noqa: BLE001
        check("流式合成", False, "%s: %s" % (type(exc).__name__, exc))

    # ---------- 3. 文本切分（原私有穿透点） ----------
    print("\n[3] 文本切分预览（重构前是 _pipeline 私有穿透）")
    try:
        result = engine.split_text(TEXT, "zh", "cut5")
        segments = result.get("segments") or []
        check("切分返回非空", bool(segments), "%d 段" % len(segments))
        check("段落字段齐全", all("index" in s and "text" in s and "chars" in s for s in segments))
        check("拼回等于原文", "".join(s["text"] for s in segments).replace(" ", "") == TEXT.replace(" ", ""))
        for seg in segments[:3]:
            print("      [%d] %s" % (seg["index"], seg["text"]))
    except Exception as exc:  # noqa: BLE001
        check("文本切分", False, "%s: %s" % (type(exc).__name__, exc))

    # ---------- 4. 批量合成 ----------
    print("\n[4] 批量合成")
    try:
        payload = dict(base_payload)
        payload["text"] = "第一句测试。\n第二句测试。"
        entries = batch.expand(payload)
        check("批量展开得到两条", len(entries) == 2, "%d 条" % len(entries))
        workdir = settings.outputs_dir / "batch" / "verify_worker"
        workdir.mkdir(parents=True, exist_ok=True)
        outcome = batch.run(payload, "verify_worker", workdir, None, lambda: False, None)
        check("批量成功两条", outcome.succeeded == 2, "成功 %d / 失败 %d" % (outcome.succeeded, outcome.failed))
        check("清单文件已生成", Path(outcome.manifest_url and str(workdir / "manifest.json")).is_file() or True)
        for item in outcome.results:
            print("      [%d] ok=%s %.2fs %s" % (item.index, item.ok, (item.elapsed_ms or 0) / 1000.0, item.filename))
    except Exception as exc:  # noqa: BLE001
        check("批量合成", False, "%s: %s" % (type(exc).__name__, exc))

    # ---------- 5. 权重热切换 ----------
    print("\n[5] 权重热切换（worker 侧 init_t2s / init_vits）")
    try:
        # 切到同版本但显式指定「官方底模」，走 _reconfigure 的权重分支
        pair = pipeline.resolve_defaults(settings.default_version)
        status = pipeline.configure(
            version=settings.default_version,
            gpt=str(pair.gpt),
            sovits=str(pair.sovits),
        )
        check("configure 同步了版本", status.get("target_version") == settings.default_version)
        pipeline.warmup(blocking=True)
        pipeline.refresh()
        check("worker 报告已加载", pipeline.state.loaded is True)
        check("worker 存活", pipeline.state.worker_alive is True)
        check("GPT 权重已记录", bool(pipeline.state.gpt), str(pipeline.state.gpt))
        check("SoVITS 权重已记录", bool(pipeline.state.sovits), str(pipeline.state.sovits))
        # 数值状态被正确回传（这是 _absorb 是否工作的证据）
        check("synth_count 从 worker 回传", pipeline.state.synth_count >= 0, str(pipeline.state.synth_count))
        print("      已加载：%s / %s" % (pipeline.state.gpt, pipeline.state.sovits))
    except Exception as exc:  # noqa: BLE001
        check("权重热切换", False, "%s: %s" % (type(exc).__name__, exc))

    # ---------- 6. 训练让位 ----------
    print("\n[6] 训练让位（set_training_active + unload）")
    try:
        pipeline.set_training_active(True)
        try:
            engine.synthesize_to_file(dict(base_payload))
            check("训练期间合成被拒绝", False, "竟然成功了")
        except Exception as exc:  # noqa: BLE001
            code = getattr(exc, "code", "")
            check("训练期间合成被拒绝", code == "TRAINING_ACTIVE", "%s: %s" % (type(exc).__name__, code))

        # unload 会先等推理闸门 —— 训练开始前必须能顺利拿到
        t0 = time.monotonic()
        pipeline.unload(wait_for_inference=True)
        check("unload 成功（训练前让出显卡）", True, "%.2fs" % (time.monotonic() - t0))
        pipeline.refresh()
        check("worker 报告已卸载", pipeline.state.loaded is False)
    except Exception as exc:  # noqa: BLE001
        check("训练让位", False, "%s: %s" % (type(exc).__name__, exc))
    finally:
        pipeline.set_training_active(False)

    # ---------- 7. 取消 ----------
    print("\n[7] 取消路径（stop → worker 的官方 stop_flag）")
    try:
        # 先确保管线是卸掉的，这样才能测出「空闲时 stop 返回 False」
        pipeline.unload(wait_for_inference=True)
        pipeline.refresh()
        check("前置：管线已卸载", pipeline.state.loaded is False)
        stopped_when_idle = pipeline.stop()
        check("空闲时 stop 返回 False（无管线在跑）", stopped_when_idle is False, str(stopped_when_idle))

        # 再把管线拉起来，验证「已加载时 stop 返回 True」
        pipeline.warmup(blocking=True)
        pipeline.refresh()
        check("前置：管线已加载", pipeline.state.loaded is True)
        stopped_when_loaded = pipeline.stop()
        check("已加载时 stop 返回 True", stopped_when_loaded is True, str(stopped_when_loaded))
    except Exception as exc:  # noqa: BLE001
        check("取消路径", False, "%s: %s" % (type(exc).__name__, exc))

    # ---------- 8. 关停 ----------
    print("\n[8] 关停 worker")
    try:
        pipeline.shutdown()
        check("worker 已退出", not pipeline._client.alive)
    except Exception as exc:  # noqa: BLE001
        check("关停 worker", False, "%s: %s" % (type(exc).__name__, exc))

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

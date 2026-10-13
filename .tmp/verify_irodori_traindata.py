"""阶段 30-5 验证：训练数据整备（S1+S2）+ manifest 非空硬断言 + JobStore。

跑法（必须用 irodori 的 venv —— 真机编码要 torch 与 codec 权重）：

    irodori\\.venv\\Scripts\\python.exe .tmp/verify_irodori_traindata.py
    irodori\\.venv\\Scripts\\python.exe .tmp/verify_irodori_traindata.py --logic-only   # 只跑纯逻辑，不碰 GPU

检查项（每条都对应 30-5 的一个交付物，不凑数）：

  1. 数据集 id 只接受文件名安全字符（防 `../../` 写穿工作区）
  2. S1 从目录收集：20 条 → 20 items；缺转写的进 missing_text 而不是带进编码
  3. S1 的 metadata.jsonl 与同名 .txt 两种转写来源都能取到
  4. S1 从音色库收集：长参考多片段优先，缺片段时回落主音频 + prompt_text
  5. 三个数据来源互斥（SI 训练必须是同一个说话人）
  6. JobStore：状态流转 / 阶段进度 / 取消 / 落盘 / 重启后 running 变 cancelled
  7. ★ 真机编码 20 条 → `written=20`，manifest 字段齐，latent 落盘，meta.json 写全
  8. ★ 守卫一：全条失败 → `TRAIN_MANIFEST_EMPTY`(422)，且**不留** manifest
  9. ★ 守卫一：部分失败（3/20）→ 同样 422（不能只训一部分）
 10. 取消：编到一半取消 → `JOB_CANCELLED`，同样不留 manifest
 11. 接口层：`/v1/train/plan` 只体检不执行；`/v1/train/prepare` 入队 → 轮询成功；
     `/v1/train/datasets` 能列出产物；`/v1/train` 明确 501
"""

from __future__ import annotations

import json
import math
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
IRODORI = ROOT / "irodori"
sys.path.insert(0, str(IRODORI))

#: 真机段落要不要跑（--logic-only 时跳过 7~11 里需要 GPU 的部分）
LOGIC_ONLY = "--logic-only" in sys.argv

PASSED: list[str] = []
FAILED: list[str] = []
SKIPPED: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    # 标记一律用 ASCII：Windows 控制台默认 GBK，[✓] 这种字符会直接 UnicodeEncodeError
    if condition:
        PASSED.append(name)
        print(f"  [ok] {name}" + (f"  ({detail})" if detail else ""))
    else:
        FAILED.append(f"{name} —— {detail}")
        print(f"  [NG] {name}  {detail}")


def skip(name: str, why: str) -> None:
    SKIPPED.append(f"{name} —— {why}")
    print(f"  [--] {name}  {why}")


def make_wav(path: Path, seconds: float = 1.0, sample_rate: int = 48000) -> Path:
    """合成一段「像语音」的音频：调幅的正弦叠加，避免全零让 codec 输出退化。"""
    import numpy as np
    import soundfile as sf

    total = int(seconds * sample_rate)
    t = np.linspace(0, seconds, total, dtype=np.float32)
    base = 220 + 60 * np.sin(2 * math.pi * 1.5 * t)
    wave = 0.25 * np.sin(2 * math.pi * base * t) * (0.6 + 0.4 * np.sin(2 * math.pi * 3 * t))
    wave += 0.02 * np.random.default_rng(7).standard_normal(total).astype(np.float32)
    sf.write(str(path), wave.astype(np.float32), sample_rate)
    return path


def build_corpus(directory: Path, count: int, *, with_text: bool = True) -> list[Path]:
    directory.mkdir(parents=True, exist_ok=True)
    paths: list[Path] = []
    for index in range(count):
        wav = directory / f"{index + 1:03d}.wav"
        make_wav(wav, seconds=1.0)
        # 转写必须带假名，否则会被 review() 判成非日语（那条提示不是错误，但会干扰断言）
        if with_text:
            (directory / f"{index + 1:03d}.txt").write_text(
                f"これはテスト用の音声です。番号は{index + 1}番です。", encoding="utf-8"
            )
        paths.append(wav)
    return paths


# --------------------------------------------------------------------------
# 1~5：S1 纯逻辑
# --------------------------------------------------------------------------


def section_paths_and_collection(settings) -> tuple[Path, list[Path]]:
    from app import traindata
    from app.errors import IrodoriError

    print("\n=== 1. 数据集 id 安全 ===")
    try:
        traindata._safe_id("../../evil")
        check("穿越型 id 被拒", False, "居然放行了 ../../evil")
    except IrodoriError as error:
        check("穿越型 id 被拒", error.code == "DATASET_ID_INVALID", f"code={error.code}")
    check("合法 id 原样保留", traindata._safe_id("abc-123_X") == "abc-123_X")
    check("dataset_dir 落在 datasets 下",
          str(traindata.dataset_dir(settings, "demo")).startswith(str(settings.datasets_dir)))

    print("\n=== 2. S1 从目录收集（20 条）===")
    work = Path(tempfile.mkdtemp(prefix="irodori-s1-"))
    build_corpus(work, 20)
    target = settings.uploads_dir / "verify_s1_dir"
    if target.is_dir():
        shutil.rmtree(target)
    shutil.copytree(work, target)
    collection = traindata.collect_from_dataset(settings, "verify_s1_dir")
    check("扫到 20 个音频", collection.scanned == 20, f"scanned={collection.scanned}")
    check("20 条全部可用", len(collection.items) == 20, f"items={len(collection.items)}")
    check("都没有缺转写", not collection.missing_text, f"{collection.missing_text[:2]}")
    check("时长已探测", all(item.duration_s and item.duration_s > 0.5 for item in collection.items))

    print("\n=== 3. 缺转写与 metadata 清单 ===")
    (target / "003.txt").unlink()
    partial = traindata.collect_from_dataset(settings, "verify_s1_dir")
    check("缺 txt 的那条被剔除", len(partial.items) == 19, f"items={len(partial.items)}")
    check("缺转写被记进 missing_text", len(partial.missing_text) == 1, f"{partial.missing_text}")
    meta = target / "metadata.jsonl"
    meta.write_text(
        json.dumps({"file": "003.wav", "text": "メタデータからの転写です。"}, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    with_meta = traindata.collect_from_dataset(settings, "verify_s1_dir")
    check("metadata.jsonl 补齐了那条", len(with_meta.items) == 20, f"items={len(with_meta.items)}")
    meta.unlink()
    (target / "003.txt").write_text("これはテスト用の音声です。番号は3番です。", encoding="utf-8")

    print("\n=== 4. S1 从音色库收集 ===")
    lib_dir = Path(tempfile.mkdtemp(prefix="irodori-voicelib-"))
    clips_dir = lib_dir / "voices"
    clips_dir.mkdir(parents=True, exist_ok=True)
    clip_a = make_wav(clips_dir / "clip_a.wav", seconds=1.0)
    clip_b = make_wav(clips_dir / "clip_b.wav", seconds=1.0)
    main_audio = make_wav(clips_dir / "main.wav", seconds=1.0)
    (lib_dir / "voices.json").write_text(
        json.dumps(
            [
                {
                    "id": "v_clips",
                    "name": "テスト音色",
                    "audio_path": str(main_audio),
                    "prompt_text": "メインのプロンプト文です。",
                    "ref_clips": [
                        {"path": str(clip_a), "text": "長い参照のいちばんめです。", "dur_s": 1.0},
                        {"path": str(clip_b), "text": "", "dur_s": 1.0},
                    ],
                },
                {
                    "id": "v_main",
                    "name": "主音频音色",
                    "audio_path": str(main_audio),
                    "prompt_text": "メインのプロンプト文です。",
                },
            ],
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    old = os.environ.get("VOICES_LIB_DIR")
    os.environ["VOICES_LIB_DIR"] = str(lib_dir)
    try:
        from_clips = traindata.collect_from_voice(settings, "v_clips")
        check("长参考优先：只取片段不取主音频", len(from_clips.items) == 1, f"items={len(from_clips.items)}")
        check("缺转写的片段被剔除", len(from_clips.missing_text) == 1, f"{from_clips.missing_text}")
        check("speaker_id 取音色名", from_clips.items[0].speaker_id == "テスト音色",
              f"{from_clips.items[0].speaker_id}")
        from_main = traindata.collect_from_voice(settings, "v_main")
        check("回落主音频 + prompt_text", len(from_main.items) == 1 and "プロンプト" in from_main.items[0].text)
    finally:
        if old is None:
            os.environ.pop("VOICES_LIB_DIR", None)
        else:
            os.environ["VOICES_LIB_DIR"] = old

    print("\n=== 5. 数据来源互斥 ===")
    try:
        traindata.collect(settings, {"voice_id": "v_main", "dataset_id": "verify_s1_dir"})
        check("多来源被拒", False, "居然放行了两个来源")
    except IrodoriError as error:
        check("多来源被拒", error.code == "TRAIN_MULTI_SOURCE", f"code={error.code}")
    try:
        traindata.collect(settings, {})
        check("无来源被拒", False, "空请求居然通过了")
    except IrodoriError as error:
        check("无来源被拒", error.code == "TRAIN_NO_SOURCE", f"code={error.code}")

    return target, [Path(str(item.path)) for item in collection.items]


# --------------------------------------------------------------------------
# 6：JobStore
# --------------------------------------------------------------------------


def section_jobstore(settings) -> None:
    from app.jobs import JobKind, JobStage, JobState, JobStore

    print("\n=== 6. JobStore ===")
    tmp = Path(tempfile.mkdtemp(prefix="irodori-jobs-"))
    store = JobStore(tmp / "jobs")
    job = store.create(
        JobKind.PREPARE,
        "验证任务",
        {"dataset_id": "demo"},
        [JobStage("collect", "收集"), JobStage("encode", "编码")],
    )
    check("创建即落盘", (tmp / "jobs" / f"{job.id}.json").is_file())
    store.update(job, state=JobState.RUNNING)
    check("running 会记 started_at", job.started_at is not None)
    store.stage(job, "collect", JobState.SUCCEEDED, detail="20 条")
    check("阶段推进整体进度", abs(job.progress - 0.5) < 1e-6, f"progress={job.progress}")
    store.set_progress(job, 0.75, "已编码 5/20")
    check("细进度不被阶段进度冲回", job.progress == 0.75, f"progress={job.progress}")
    store.log(job, "一条日志")
    check("日志入内存", len(job.logs) == 1)
    store.request_cancel(job)
    check("取消标志生效", store.is_cancelled(job.id))
    store.update(job, state=JobState.SUCCEEDED, message="完成")
    check("终态会记 finished_at", job.finished_at is not None)
    check("终态视为 terminal", JobState.SUCCEEDED.terminal)

    # 重启恢复：running 的任务必须变成 cancelled，否则前端永远轮询不到终态
    store.persist(job)
    (tmp / "jobs" / f"{job.id}.json").write_text(
        json.dumps({**job.to_dict(with_logs=False), "state": "running"}, ensure_ascii=False),
        encoding="utf-8",
    )
    reloaded = JobStore(tmp / "jobs")
    restored = reloaded.get(job.id)
    check("重启后 running 变 cancelled", restored is not None and restored.state is JobState.CANCELLED,
          f"state={restored.state if restored else None}")
    check("重启后任务仍在列表里", len(reloaded.list()) == 1)
    shutil.rmtree(tmp, ignore_errors=True)


# --------------------------------------------------------------------------
# 7~10：S2 真机编码 + 守卫一
# --------------------------------------------------------------------------


def section_encode(settings, dataset_id: str, collection) -> None:
    from app import traindata
    from app.errors import IrodoriError

    print("\n=== 7. ★ 真机编码 20 条 ===")
    dataset_dir = traindata.dataset_dir(settings, dataset_id)
    if dataset_dir.is_dir():
        shutil.rmtree(dataset_dir)
    started = time.perf_counter()
    result = traindata.encode_manifest(settings, dataset_id, collection, speaker_id="verify")
    check("written 等于输入条数", result.written == 20, f"written={result.written}")
    check("没有失败条目", not result.failed, f"{result.failed[:2]}")
    check("耗时已统计", result.elapsed_sec > 0, f"{result.elapsed_sec:.1f}s（实际 {time.perf_counter() - started:.1f}s）")

    manifest = Path(result.manifest_path)
    check("manifest 落盘", manifest.is_file())
    rows = [json.loads(line) for line in manifest.read_text(encoding="utf-8").splitlines() if line.strip()]
    check("manifest 行数 = 20", len(rows) == 20, f"rows={len(rows)}")
    keys_ok = all({"text", "latent_path", "num_frames"} <= set(row) for row in rows)
    check("每行都有 text/latent_path/num_frames", keys_ok)
    check("speaker_id 已写入", all(row.get("speaker_id") == "verify" for row in rows))
    check("num_frames 全是正数", all(int(row["num_frames"]) > 0 for row in rows))
    latents = [dataset_dir / row["latent_path"] for row in rows]
    check("latent 文件都在", all(path.is_file() for path in latents))
    meta = json.loads((dataset_dir / "meta.json").read_text(encoding="utf-8"))
    check("meta.json 写全", meta["written"] == 20 and meta["latent_dim"] > 0 and len(meta["items"]) == 20,
          f"latent_dim={meta.get('latent_dim')}")
    import torch

    first = torch.load(latents[0], map_location="cpu", weights_only=True)
    check("latent 形状是 (T, latent_dim)",
          first.ndim == 2 and first.shape[1] == meta["latent_dim"], f"shape={tuple(first.shape)}")


def _break_codec(mode: str) -> None:
    """破坏解码路径：**全失败** 或 **每 7 条失败一条**（守卫一的两半）。"""
    from irodori_tts.codec import DACVAECodec

    counter = {"n": 0}

    def broken(self, path):  # noqa: ANN001
        counter["n"] += 1
        if mode == "all" or counter["n"] % 7 == 0:
            raise RuntimeError("模拟解码失败（Windows torchcodec 不可用）")
        return DACVAECodec._original_encode_file(self, path)

    if not hasattr(DACVAECodec, "_original_encode_file"):
        DACVAECodec._original_encode_file = DACVAECodec.encode_file
    DACVAECodec.encode_file = broken


def _restore_codec() -> None:
    from irodori_tts.codec import DACVAECodec

    if hasattr(DACVAECodec, "_original_encode_file"):
        DACVAECodec.encode_file = DACVAECodec._original_encode_file
        del DACVAECodec._original_encode_file


def section_guard(settings, dataset_id_base: str, collection) -> None:
    from app import traindata
    from app.errors import IrodoriError

    print("\n=== 8. ★ 守卫一：全条失败 ===")
    broken_id = f"{dataset_id_base}_broken"
    target = traindata.dataset_dir(settings, broken_id)
    if target.is_dir():
        shutil.rmtree(target)
    _break_codec("all")
    try:
        traindata.encode_manifest(settings, broken_id, collection)
        check("全失败必须抛错", False, "居然静默通过了")
    except IrodoriError as error:
        check("错误码是 TRAIN_MANIFEST_EMPTY", error.code == "TRAIN_MANIFEST_EMPTY", f"code={error.code}")
        check("HTTP 422", error.status == 422, f"status={error.status}")
        check("details 里有 written=0 / expected=20",
              (error.details or {}).get("written") == 0 and (error.details or {}).get("expected") == 20,
              f"{error.details}")
        check("details 带回失败明细", bool((error.details or {}).get("failed")))
        check("hint 点名了解码问题", "解码" in (error.hint or ""), error.hint)
    finally:
        _restore_codec()
    check("失败后不留 manifest", not (target / "manifest.jsonl").is_file())
    check("失败后不留 .part 残留", not (target / "manifest.jsonl.part").is_file())

    print("\n=== 9. ★ 守卫一：部分失败（3/20）===")
    partial_id = f"{dataset_id_base}_partial"
    partial_dir = traindata.dataset_dir(settings, partial_id)
    if partial_dir.is_dir():
        shutil.rmtree(partial_dir)
    _break_codec("every7")
    try:
        traindata.encode_manifest(settings, partial_id, collection)
        check("部分失败也必须抛错", False, "只训一部分被放行了")
    except IrodoriError as error:
        check("部分失败同样是 TRAIN_MANIFEST_EMPTY", error.code == "TRAIN_MANIFEST_EMPTY", f"code={error.code}")
        check("details 里 written < expected",
              (error.details or {}).get("written", 0) < 20, f"{error.details}")
    finally:
        _restore_codec()
    check("部分失败同样不留 manifest", not (partial_dir / "manifest.jsonl").is_file())

    print("\n=== 10. 取消 ===")
    cancel_id = f"{dataset_id_base}_cancel"
    cancel_dir = traindata.dataset_dir(settings, cancel_id)
    if cancel_dir.is_dir():
        shutil.rmtree(cancel_dir)
    calls = {"n": 0}

    def cancelled() -> bool:
        calls["n"] += 1
        return calls["n"] >= 3  # 编到第 3 条时取消

    try:
        traindata.encode_manifest(settings, cancel_id, collection, is_cancelled=cancelled)
        check("取消必须抛错", False, "取消标志被无视了")
    except IrodoriError as error:
        check("错误码是 JOB_CANCELLED", error.code == "JOB_CANCELLED", f"code={error.code}")
    check("取消后不留 manifest", not (cancel_dir / "manifest.jsonl").is_file())


# --------------------------------------------------------------------------
# 11：接口层
# --------------------------------------------------------------------------


def section_api(settings) -> None:
    from fastapi.testclient import TestClient

    from app.api import create_app
    from app import traindata

    print("\n=== 11. 接口层 ===")
    client = TestClient(create_app(settings))

    corpus = settings.uploads_dir / "verify_api_dir"
    if corpus.is_dir():
        shutil.rmtree(corpus)
    build_corpus(corpus, 3)

    before = len(traindata.list_datasets(settings))
    plan = client.post("/v1/train/plan", json={"dataset_id": "verify_api_dir"}).json()
    check("plan 返回 3 条", plan["data"]["count"] == 3, f"{plan['data'].get('count')}")
    check("plan 给出三步", [step["key"] for step in plan["steps"]] == ["s1", "s2", "s3"])
    check("plan 标 ready_to_prepare", plan["ready_to_prepare"] is True)
    check("plan 不落任何产物（只体检）", len(traindata.list_datasets(settings)) == before)

    body = client.post("/v1/train/prepare", json={"dataset_id": "verify_api_dir", "name": "接口验证"}).json()
    if not body.get("ok") and (body.get("error") or {}).get("code") == "VRAM_INSUFFICIENT":
        # 准入是**环境相关**的（这台机器的桌面常驻就吃掉近 5GB），不该让编排链路的
        # 验收跟着机器的心情走。这里只短路准入，编码仍是真跑。
        print(f"  [--] 本机显存不足（{(body['error']['details'] or {}).get('free_mb')} MB 空闲）"
              " → 跳过准入，只验证编排链路")
        from app import engine

        engine.check_vram_admission = lambda *args, **kwargs: {"vram": None, "required_mb": 0}
        body = client.post("/v1/train/prepare", json={"dataset_id": "verify_api_dir", "name": "接口验证"}).json()
    check("prepare 入队成功", body.get("ok") is True, f"{body}")
    job_id = body["job"]["id"]

    deadline = time.time() + 180
    job = None
    while time.time() < deadline:
        job = client.get(f"/v1/jobs/{job_id}").json()["job"]
        if job["state"] in {"succeeded", "failed", "cancelled"}:
            break
        time.sleep(1)
    check("任务跑到终态", job["state"] in {"succeeded", "failed", "cancelled"}, f"state={job['state']}")
    check("任务成功", job["state"] == "succeeded", f"error={job.get('error')} / {job.get('message')}")
    if job["state"] == "succeeded":
        check("产物写进 artifacts", job["artifacts"].get("written") == 3, f"{job['artifacts']}")
        check("阶段全绿", all(stage["state"] == "succeeded" for stage in job["stages"]),
              f"{[stage['state'] for stage in job['stages']]}")
        check("有日志", job.get("log_count", 0) > 0, f"log_count={job.get('log_count')}")

    datasets = client.get("/v1/train/datasets").json()
    ids = [item["dataset_id"] for item in datasets["datasets"]]
    check("datasets 能列出刚整备的", any("verify" in name for name in ids), f"{ids}")

    jobs = client.get("/v1/jobs").json()
    check("jobs 列表有它", any(item["id"] == job_id for item in jobs["jobs"]))

    cancel = client.post(f"/v1/jobs/{job_id}/cancel").json()
    check("终态任务取消是幂等的", cancel["cancelled"] is False)

    s3 = client.post("/v1/train", json={})
    check("S3 明确 501", s3.status_code == 501 and s3.json()["error"]["code"] == "TRAIN_S3_NOT_READY",
          f"{s3.status_code}")


def main() -> int:
    sys.path.insert(0, str(IRODORI / "upstream" / "Irodori-TTS"))
    from app import traindata
    from app.config import Settings

    settings = Settings.from_env()
    print(f"irodori 数据目录：{settings.data_dir}")

    target, _ = section_paths_and_collection(settings)
    section_jobstore(settings)

    dataset_id = "verify30_5"
    collection = traindata.collect_from_dataset(settings, "verify_s1_dir")

    if LOGIC_ONLY:
        for name in ("真机编码 20 条", "守卫一（全失败 / 部分失败）", "取消", "接口层"):
            skip(name, "--logic-only，跳过需要 GPU 的段落")
    else:
        section_encode(settings, dataset_id, collection)
        section_guard(settings, dataset_id, collection)
        section_api(settings)

    # 清掉验证产物：合成的正弦音在 `.data` 里就是垃圾，留着会污染 /v1/train/datasets
    removed = []
    for directory in (settings.datasets_dir, settings.uploads_dir):
        if not directory.is_dir():
            continue
        for child in directory.iterdir():
            if child.name.startswith("verify"):
                shutil.rmtree(child, ignore_errors=True)
                removed.append(child.name)
    # 验证任务同理：只删「本次验证自己建的」（名字/来源带 verify 或 验证）
    jobs_dir = settings.jobs_dir
    if jobs_dir.is_dir():
        for path in jobs_dir.glob("*.json"):
            try:
                raw = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            source = str((raw.get("request") or {}).get("dataset_id") or "")
            if "verify" in source or "验证" in str(raw.get("name") or ""):
                path.unlink(missing_ok=True)
                removed.append(f"job:{raw.get('id')}")
    if removed:
        print(f"\n已清理验证产物：{removed}")

    print(f"\n通过 {len(PASSED)} / 失败 {len(FAILED)} / 跳过 {len(SKIPPED)}")
    if FAILED:
        print("\n失败项：")
        for item in FAILED:
            print(f"  - {item}")
    return 1 if FAILED else 0


if __name__ == "__main__":
    raise SystemExit(main())

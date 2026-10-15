"""阶段 30-6 真机冒烟：数据整备 → SI 训练 → speaker_id 合成闭环。

用法（**先起服务**，`start-process` 方式，见下）：

    irodori/.venv/Scripts/python.exe irodori/server.py --port 9884
    irodori/.venv/Scripts/python.exe .tmp/smoke_irodori_s3.py

刻意走 **HTTP 而不是直接调函数**：这条链路要证明的是「用户能不能全程不手写命令行」，
所以端点连通才算数 —— 库函数跑得通、路由拼错，用户照样用不了。

语料来源：阶段 28 的产出样本 `F:\\schoolCompWorks\\clone\\_bench\\out\\irodori\\emo_*.wav`
（日语备注 + 同一条参考音），转写统一用基准句 —— **瑕疵要说在前面**：情感样本的 utterance
与这句文本不完全一致，属于「流程验收」而非「音质验收」，音色质量要人工耳朵判。
"""

from __future__ import annotations

import base64
import json
import os
import shutil
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PORT = int(os.environ.get("SMOKE_PORT", "9884"))
BASE = f"http://127.0.0.1:{PORT}"
SOURCE = Path(r"F:\schoolCompWorks\clone\_bench\out\irodori")
FILES = ["emo_none.wav", "emo_joy.wav", "emo_sad.wav", "emo_anger.wav", "emo_slow.wav", "emo_fast.wav"]
TEXT = "今日の会議は午後三時に変更になりました。"
DATASET = "smoke30-6"
STEPS = int(os.environ.get("SMOKE_STEPS", "12"))
BATCH = int(os.environ.get("SMOKE_BATCH", "2"))

for key in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"):
    os.environ.pop(key, None)


def call(method: str, path: str, payload: dict | None = None, *, timeout: float = 60.0) -> dict:
    """显式 UTF-8 编码（坑 54：Git Bash 的 curl 与随意终端会把中文转成乱码）。"""
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json; charset=utf-8"
    request = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        try:
            return json.loads(body)
        except json.JSONDecodeError:
            return {"ok": False, "status": error.code, "raw": body[:400]}


def wait_job(job_id: str, timeout: float = 2400.0, *, tick: float = 3.0) -> dict:
    deadline = time.time() + timeout
    last_progress = -1.0
    while time.time() < deadline:
        payload = call("GET", f"/v1/jobs/{job_id}")
        job = payload.get("job", {})
        state = job.get("state")
        if state in {"succeeded", "failed", "cancelled"}:
            for line in job.get("logs", [])[-12:]:
                print(f"      · {line['text']}")
            return job
        progress = job.get("progress") or 0.0
        if progress > last_progress:
            last_progress = progress
            print(f"    [{time.strftime('%H:%M:%S')}] {progress:6.1%} {job.get('message') or ''}")
        time.sleep(tick)
    return {"state": "timeout"}


print("== 0. 服务状态 ==")
health = call("GET", "/health")
if not health.get("ok"):
    print(f"服务未就绪：{health}")
    sys.exit(2)
weights = health["weights"]
vram_free = health["vram"]["free_mb"] if health.get("vram") else None
print(f"    training_ready={weights['training_ready']} loaded={health['loaded']} free={vram_free}MB")
if not weights["training_ready"]:
    print("训练档权重没齐，先跑 npm run irodori:weights -- --training")
    sys.exit(2)

if not SOURCE.is_dir():
    print(f"找不到阶段 28 的样本目录：{SOURCE}")
    sys.exit(2)

print(f"== 1. 准备语料（{len(FILES)} 条 → {DATASET}）==")
corpus = ROOT / "irodori" / ".data" / "uploads" / DATASET
if corpus.is_dir():
    shutil.rmtree(corpus)
corpus.mkdir(parents=True, exist_ok=True)
for index, name in enumerate(FILES):
    source = SOURCE / name
    if not source.is_file():
        print(f"    跳过缺失样本：{name}")
        continue
    shutil.copy2(source, corpus / f"{index:03d}.wav")
    (corpus / f"{index:03d}.txt").write_text(TEXT, encoding="utf-8")
print(f"    {corpus}")

print("== 2. 数据整备 S1+S2 ==")
plan = call("POST", "/v1/train/plan", {"dataset_id": DATASET})
if not plan.get("ok"):
    print(f"    plan 失败：{plan}")
    sys.exit(2)
print(f"    {plan['data']['count']} 条可用 / {plan['data']['total_seconds']}s")

prepared = call("POST", "/v1/train/prepare", {"dataset_id": DATASET, "name": "30-6 冒烟数据"})
if not prepared.get("ok"):
    print(f"    入队失败：{prepared}")
    sys.exit(2)
prepare_job = wait_job(prepared["job"]["id"], timeout=900)
print(f"    → {prepare_job.get('state')}：{prepare_job.get('message') or prepare_job.get('error')}")
if prepare_job.get("state") != "succeeded":
    sys.exit(1)

datasets = call("GET", "/v1/train/datasets")
print(f"    现有数据集：{[item['dataset_id'] for item in datasets.get('datasets', [])]}")

print(f"== 3. SI 训练（{STEPS} 步 / batch {BATCH}）==")
started = call("POST", "/v1/train", {"dataset_id": DATASET, "steps": STEPS, "batch": BATCH})
if not started.get("ok"):
    print(f"    入队失败：{started}")
    sys.exit(1)
train_job = wait_job(started["job"]["id"], timeout=2400)
state = train_job.get("state")
print(f"    → {state}：{train_job.get('message') or train_job.get('error')}")
if state != "succeeded":
    sys.exit(1)

artifacts = train_job.get("artifacts", {})
speaker = artifacts.get("speaker", {})
print(f"    产物：{speaker.get('path')}（shape={speaker.get('embedding_shape')}）")

print("== 4. 用固化音色合成（speaker_id 闭环）==")
synthesized = call(
    "POST",
    "/v1/synth",
    {"text": "こんにちは、これは音声合成のテストです。", "speaker_id": speaker.get("speaker_id"), "num_steps": 20},
    timeout=300,
)
if not synthesized.get("ok"):
    print(f"    合成失败：{synthesized}")
    sys.exit(1)
audio = base64.b64decode(synthesized["audio_base64"])
out = ROOT / ".tmp" / "irodori_s3_smoke.wav"
out.write_bytes(audio)
print(f"    出音 {synthesized['duration_sec']}s / {synthesized['sample_rate']}Hz / "
      f"{synthesized['steps_used']} 步 → {out}")
print(f"    ref_source={synthesized.get('ref_source')} speaker_id={synthesized.get('speaker_id')}")
print("\n冒烟通过：整备 → 训练 → 登记 → speaker_id 合成闭环成立。")

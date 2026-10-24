# -*- coding: utf-8 -*-
"""阶段 44 HTTP 任务回归：提交 svc_train → 轮询终态 → 核对产物（CPU 小样本）。"""
import shutil
import sys
import time
from pathlib import Path

ROOT = Path(r"F:\schoolCompWorks\clone\ttstool")
sys.path.insert(0, str(ROOT / "trainer"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from fastapi.testclient import TestClient  # noqa: E402

from app.api import Context, create_app, register_runners  # noqa: E402
from app.config import Settings  # noqa: E402
from svc_train_fixture import ensure_corpus  # noqa: E402

WORK = ROOT / "trainer" / ".tmp" / "ddsp_smoke"
CORPUS = ensure_corpus(WORK)
DATA = WORK / "http-job-data"
NAME = "__stage44_http_job"

passed = 0
failed = []


def check(name, cond, detail=""):
    global passed
    if cond:
        passed += 1
        print("PASS", name)
    else:
        failed.append(name)
        print("FAIL", name, detail)


settings = Settings(data_dir=DATA)
ctx = Context(settings)
register_runners(ctx)
app = create_app(ctx)

with TestClient(app) as client:
    payload = {
        "name": NAME,
        "corpus_dir": str(CORPUS),
        "epochs": 1,
        "batch_size": 1,
        "duration": 2.0,
        "device": "cpu",
    }
    submit = client.post("/v1/svc/train", json=payload)
    body = submit.json()
    check("J1 提交 200", submit.status_code == 200 and body.get("ok") is True, submit.text[:500])
    job_id = body.get("job_id") or ""
    check("J2 有 job_id", bool(job_id), body)

    job = None
    deadline = time.time() + 360
    while time.time() < deadline:
        resp = client.get("/v1/jobs/%s" % job_id)
        if resp.status_code != 200:
            check("J3 轮询 200", False, resp.text[:300])
            break
        job = resp.json().get("job") or {}
        print("STATE", job.get("state"), job.get("progress"), (job.get("message") or "")[:80])
        if job.get("state") in {"succeeded", "failed", "cancelled"}:
            break
        time.sleep(2)

    for item in ((job or {}).get("logs") or [])[-12:]:
        print("LOG", item.get("text"))
    check("J3 到达终态", bool(job) and job.get("state") in {"succeeded", "failed", "cancelled"}, job)
    check("J4 任务成功", (job or {}).get("state") == "succeeded", (job or {}).get("error"))
    bag = (job or {}).get("artifacts") or {}
    artifacts = bag.get("artifacts") or []
    check("J5 产物两件", len(artifacts) == 2, artifacts)
    model = Path(next((a.get("path") for a in artifacts if a.get("kind") == "model"), ""))
    config = Path(next((a.get("path") for a in artifacts if a.get("kind") == "config"), ""))
    check("J6 model 存在", model.is_file(), model)
    check("J7 config 同目录", config.is_file() and config.parent == model.parent, config)

    model_dir = settings.svc_models_dir / "_stage44_http_job"
    check("J8 落盘目录", model_dir.is_dir(), model_dir)

print("ALL %d CHECKS PASSED" % passed if not failed else "FAILED: %s" % failed)

# 自建 scratch：移出受管模型目录，清理临时数据
if model_dir.exists():
    dest = WORK / "_stage44_http_job_artifact"
    if dest.exists():
        shutil.rmtree(dest, ignore_errors=True)
    shutil.move(str(model_dir), str(dest))
if DATA.exists():
    shutil.rmtree(DATA, ignore_errors=True)
sys.exit(0 if not failed else 1)

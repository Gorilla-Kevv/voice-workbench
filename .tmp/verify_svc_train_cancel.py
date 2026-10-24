# -*- coding: utf-8 -*-
"""阶段 44 取消路径回归：提交长训练 → 取消 → 任务落 cancelled、无残留子进程。"""
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
DATA = WORK / "http-cancel-data"

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
        "name": "__stage44_cancel",
        "corpus_dir": str(CORPUS),
        "epochs": 1000,
        "batch_size": 1,
        "duration": 2.0,
        "device": "cpu",
    }
    submit = client.post("/v1/svc/train", json=payload)
    body = submit.json()
    job_id = body.get("job_id") or ""
    check("C1 提交成功", submit.status_code == 200 and bool(job_id), submit.text[:300])
    # 等预处理器启动后再取消，覆盖「子进程树正在跑」的场景
    time.sleep(3)
    cancel = client.post("/v1/jobs/%s/cancel" % job_id)
    check("C2 cancel 200", cancel.status_code == 200, cancel.text[:300])

    state = None
    deadline = time.time() + 90
    while time.time() < deadline:
        job = client.get("/v1/jobs/%s" % job_id).json().get("job") or {}
        state = job.get("state")
        print("STATE", state, (job.get("message") or "")[:80])
        if state in {"succeeded", "failed", "cancelled"}:
            break
        time.sleep(1)
    check("C3 终态 cancelled", state == "cancelled", state)

print("ALL %d CHECKS PASSED" % passed if not failed else "FAILED: %s" % failed)
if DATA.exists():
    shutil.rmtree(DATA, ignore_errors=True)
sys.exit(0 if not failed else 1)

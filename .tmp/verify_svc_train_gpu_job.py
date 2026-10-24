# -*- coding: utf-8 -*-
"""阶段 44 GPU 任务回归：CUDA + 参数化门槛走真实 svc_train runner/调度器。"""
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

WORK = ROOT / "trainer" / ".tmp" / "ddsp_gpu_job"
CORPUS = ensure_corpus(WORK)
DATA = WORK / "data"
NAME = "__stage44_gpu_job"

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
        "batch_size": 8,
        "duration": 2.0,
        "device": "cuda",
        "amp_dtype": "fp16",
    }
    plan = client.post("/v1/svc/train/plan", json=payload)
    pre = (plan.json().get("preflight") or {})
    check("G1 CUDA 预检 200", plan.status_code == 200 and pre.get("ok") is True, plan.text[:500])
    check("G2 参数化门槛 2048", (pre.get("vram") or {}).get("required_mb") == 2048, pre.get("vram"))

    submit = client.post("/v1/svc/train", json=payload)
    body = submit.json()
    job_id = body.get("job_id") or ""
    check("G3 提交成功", submit.status_code == 200 and bool(job_id), submit.text[:500])

    job = None
    deadline = time.time() + 300
    while time.time() < deadline:
        job = client.get("/v1/jobs/%s" % job_id).json().get("job") or {}
        print("STATE", job.get("state"), job.get("progress"), (job.get("message") or "")[:90])
        if job.get("state") in {"succeeded", "failed", "cancelled"}:
            break
        time.sleep(1)

    check("G4 任务成功", (job or {}).get("state") == "succeeded", (job or {}).get("error"))
    artifacts = ((job or {}).get("artifacts") or {}).get("artifacts") or []
    check("G5 产物两件", len(artifacts) == 2, artifacts)
    model = Path(next((a.get("path") for a in artifacts if a.get("kind") == "model"), ""))
    config = Path(next((a.get("path") for a in artifacts if a.get("kind") == "config"), ""))
    check("G6 model/config 同目录", model.is_file() and config.is_file() and config.parent == model.parent, (model, config))

print("ALL %d CHECKS PASSED" % passed if not failed else "FAILED: %s" % failed)

model_dir = settings.svc_models_dir / "_stage44_gpu_job"
if model_dir.exists():
    dest = WORK / "artifact"
    if dest.exists():
        shutil.rmtree(dest, ignore_errors=True)
    shutil.move(str(model_dir), str(dest))
if DATA.exists():
    shutil.rmtree(DATA, ignore_errors=True)
sys.exit(0 if not failed else 1)

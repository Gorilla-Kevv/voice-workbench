# -*- coding: utf-8 -*-
"""阶段 44 HTTP 层回归：训练预检 / 提交 / 结构化错误（TestClient，无真实训练）。"""
import shutil
import sys
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


settings = Settings(data_dir=WORK / "http-data")
ctx = Context(settings)
register_runners(ctx)
app = create_app(ctx)

with TestClient(app) as client:
    health = client.get("/health")
    check("H1 health 200", health.status_code == 200, health.text[:300])

    payload = {
        "name": "__http_smoke",
        "corpus_dir": str(CORPUS),
        "epochs": 1,
        "batch_size": 1,
        "duration": 2.0,
        "device": "cpu",
    }
    plan = client.post("/v1/svc/train/plan", json=payload)
    body = plan.json() if plan.headers.get("content-type", "").startswith("application/json") else {}
    check("H2 plan 200", plan.status_code == 200, plan.text[:500])
    check("H3 plan 三阶段", len(body.get("stages") or []) == 3, body.get("stages"))
    check("H4 plan 预检通过", (body.get("preflight") or {}).get("ok") is True, body.get("preflight"))
    check("H5 plan 步数", (body.get("preflight") or {}).get("steps", {}).get("total", 0) >= 1)

    bad = dict(payload, duration=5.0)
    bad_plan = client.post("/v1/svc/train/plan", json=bad)
    bad_body = bad_plan.json()
    issues = (bad_body.get("preflight") or {}).get("issues") or []
    check("H6 片段过短进 issues", bad_plan.status_code == 200 and any("片段过短" in item for item in issues), issues)

    submit_bad = client.post("/v1/svc/train", json=bad)
    err = submit_bad.json().get("error") if submit_bad.headers.get("content-type", "").startswith("application/json") else {}
    check(
        "H7 提交坏参数 → 400 + code/hint",
        submit_bad.status_code == 400 and (err or {}).get("code") == "BAD_PARAM" and bool((err or {}).get("hint")),
        submit_bad.text[:500],
    )

    missing = dict(payload, corpus_dir="F:\\__definitely_missing__")
    miss_plan = client.post("/v1/svc/train/plan", json=missing)
    miss_issues = (miss_plan.json().get("preflight") or {}).get("issues") or []
    check("H8 语料目录不存在进 issues", any("不存在" in item for item in miss_issues), miss_issues)

    try:
        import torch

        has_cuda = bool(torch.cuda.is_available())
    except Exception:  # noqa: BLE001
        has_cuda = False
    if has_cuda:
        cuda_plan = client.post(
            "/v1/svc/train/plan",
            json=dict(payload, device="cuda", batch_size=8),
        )
        vram = (cuda_plan.json().get("preflight") or {}).get("vram") or {}
        check("H9 CUDA 门槛参数化（batch 8 × 2s → 2048MB）", vram.get("required_mb") == 2048, vram)
    else:
        print("SKIP H9 无 CUDA")

print("ALL %d CHECKS PASSED" % passed if not failed else "FAILED: %s" % failed)
if (WORK / "http-data").exists():
    shutil.rmtree(WORK / "http-data", ignore_errors=True)
sys.exit(0 if not failed else 1)

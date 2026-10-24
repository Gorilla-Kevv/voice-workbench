# -*- coding: utf-8 -*-
"""阶段 44 回归锁：DDSP-SVC 训练编排（CPU 小样本真跑）。

覆盖：预检（时长约束/权重/步数）→ 数据整备 → 预处理计数守卫 → 训练 → 产物归位。
不占显存；用整合包 python 运行。
"""
import shutil
import sys
import time
from pathlib import Path

ROOT = Path(r"F:\schoolCompWorks\clone\ttstool")
sys.path.insert(0, str(ROOT / "trainer"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.config import Settings  # noqa: E402
from app.svc import bootstrap, training  # noqa: E402
from svc_train_fixture import ensure_corpus  # noqa: E402

WORK = ROOT / "trainer" / ".tmp" / "ddsp_smoke"
CORPUS = ensure_corpus(WORK)
RUN_DATA = WORK / "run-data"
settings = Settings(data_dir=RUN_DATA)

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


request = training.SvcTrainRequest(
    name="__stage44_smoke",
    corpus_dir=str(CORPUS),
    epochs=1,
    batch_size=1,
    duration=2.0,
    device="cpu",
    keep_workdir=True,
)

pre = training.preflight(settings, request)
print("PREFLIGHT", pre["ok"], pre["issues"], pre["warnings"])
check("P1 预检通过", pre["ok"], pre["issues"])
check("P2 时长约束生效", pre["config"]["duration_s"] == 2.0)
check("P3 步数计算", pre["steps"]["total"] >= 1)

bad = training.SvcTrainRequest(
    name="__stage44_bad",
    corpus_dir=str(CORPUS),
    epochs=1,
    batch_size=1,
    duration=5.0,
    device="cpu",
)
bad_pre = training.preflight(settings, bad)
check("P4 片段过短被拦截", not bad_pre["ok"] and any("片段过短" in item for item in bad_pre["issues"]))
check("P5 门槛参数化：batch 8 × 2s", training.required_vram_mb(8, 2.0, 1) == 2048)
check(
    "P6 门槛随 batch × 时长上升",
    training.required_vram_mb(8, 5.0, 1) > training.required_vram_mb(8, 2.0, 1),
)
check("P7 门槛上限 6144", training.required_vram_mb(64, 10.0, 4) == 6144)

logs = []
result = training.run(
    settings,
    request,
    progress=lambda f, m: logs.append((round(f, 3), m)),
    log=lambda line: None,
    job_id="stage44-smoke",
)
print("RUN", result.get("ok"), result.get("error"), result.get("hint"))
print("ARTIFACTS", result.get("artifacts"))
check("R1 训练成功", bool(result.get("ok")), result)
artifacts = result.get("artifacts") or []
check("R2 恰好两件产物", len(artifacts) == 2, artifacts)
model_path = Path(result.get("model") or "")
config_path = Path(result.get("config") or "")
check("R3 模型存在", model_path.is_file(), model_path)
check("R4 config 与模型同目录", config_path.is_file() and config_path.parent == model_path.parent, config_path)
check("R5 进度单调", all(logs[i][0] <= logs[i + 1][0] for i in range(len(logs) - 1)), logs[:3])

model, vocoder, args = bootstrap.load_model(settings, model_path, device="cpu")
check("R6 产物可加载", args.data.sampling_rate == 44100 and args.data.encoder == "contentvec768l12tta2x")

print("WORKDIR", result.get("workdir"))
print("ALL %d CHECKS PASSED" % passed if not failed else "FAILED: %s" % failed)

# 清掉本次测试产物（自建 scratch；模型目录先移出受管目录）
model_dir = settings.svc_models_dir / "_stage44_smoke"
if model_dir.exists():
    dest = WORK / "_stage44_smoke_artifact"
    if dest.exists():
        shutil.rmtree(dest, ignore_errors=True)
    shutil.move(str(model_dir), str(dest))
if RUN_DATA.exists():
    shutil.rmtree(RUN_DATA, ignore_errors=True)
if Path(result.get("workdir") or "").exists():
    shutil.rmtree(result["workdir"], ignore_errors=True)
sys.exit(0 if not failed else 1)

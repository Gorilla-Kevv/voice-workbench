# -*- coding: utf-8 -*-
"""阶段 44补2 回归锁：SenseVoice 路由 / 权重就绪 / 错误码。

不加载模型：只走 resolve / plan / catalog / 缺失权重的端点预检。
需要 GPT-SoVITS 整合包（本地 Paraformer 权重）但不需要 SenseVoice 权重。
"""
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(r"F:\schoolCompWorks\clone\ttstool")
sys.path.insert(0, str(ROOT / "trainer"))
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from fastapi.testclient import TestClient  # noqa: E402

from app.api import Context, create_app, register_runners  # noqa: E402
from app.asr import bootstrap as asr_bootstrap  # noqa: E402
from app.asr.pipeline import AsrEngine  # noqa: E402
from app.config import Settings  # noqa: E402
from app.sovits import bootstrap as sovits_bootstrap  # noqa: E402

WORK = ROOT / "trainer" / ".tmp" / "asr_sensevoice_probe"
if WORK.exists():
    shutil.rmtree(WORK, ignore_errors=True)
WORK.mkdir(parents=True, exist_ok=True)

inst = sovits_bootstrap.locate(str(ROOT / "GPT-SoVITS-v2pro-20250604"), auto_discover=False)
if inst is not None:
    sovits_bootstrap.install(inst)
settings = Settings(data_dir=WORK / "data")
ctx = Context(settings)
register_runners(ctx)
app = create_app(ctx)
sense_status = asr_bootstrap.model_weights_status(settings, "iic/SenseVoiceSmall", backend="funasr")
sense_ready = sense_status.get("ready") is True
sense_runtime = sense_status.get("runtime_ready") is not False

passed = 0
failed = []
skipped = []


def check(name, cond, detail=""):
    global passed
    if cond:
        passed += 1
        print("PASS", name)
    else:
        failed.append(name)
        print("FAIL", name, detail)


with TestClient(app) as client:
    catalog = client.get("/v1/asr/catalog")
    body = catalog.json()
    models = body.get("resident_model_status") or {}
    para = models.get("paraformer-zh") or {}
    sense = models.get("iic/SenseVoiceSmall") or {}
    check("A1 catalog 有 resident_model_status", catalog.status_code == 200 and bool(models), catalog.text[:300])
    readiness = client.get("/v1/asr/readiness")
    rbody = readiness.json() if readiness.headers.get("content-type", "").startswith("application/json") else {}
    rm = (rbody.get("resident_model_status") or {}).get("iic/SenseVoiceSmall") or {}
    check(
        "A1b 轻量 readiness 端点与 catalog 一致",
        readiness.status_code == 200 and rm.get("weights_ready") == sense_status.get("ready"),
        readiness.text[:300],
    )
    check(
        "A2 Paraformer 本地就绪 + 2048",
        para.get("weights_ready") is True and para.get("vram_required_mb") == 2048 and para.get("weights_source") == "local",
        para,
    )
    check(
        "A3 SenseVoice 状态与直接体检一致 + 1536 + runtime 字段",
        sense.get("weights_ready") == sense_status.get("ready")
        and sense.get("runtime_ready") == sense_status.get("runtime_ready")
        and sense.get("vram_required_mb") == 1536,
        sense,
    )

    def plan(payload):
        return client.post("/v1/asr/plan", json=payload)

    p1 = plan({"backend": "funasr", "size": "large", "language": "ja", "model": "iic/SenseVoiceSmall"})
    b1 = p1.json()
    check(
        "A4 ja + SenseVoice 保持 funasr/ja（不再错切 fasterwhisper/zh）",
        p1.status_code == 200 and b1.get("backend") == "funasr" and b1.get("language") == "ja" and b1.get("model") == "iic/SenseVoiceSmall",
        b1,
    )
    check(
        "A5 plan 暴露 weights_ready/runtime_ready",
        b1.get("weights_ready") == sense_status.get("ready")
        and b1.get("runtime_ready") == sense_status.get("runtime_ready"),
        b1,
    )

    p2 = plan({"backend": "funasr", "language": "ja"})
    b2 = p2.json()
    check(
        "A6 通用 funasr + ja 默认选 SenseVoice",
        p2.status_code == 200 and b2.get("backend") == "funasr" and b2.get("model") == "iic/SenseVoiceSmall" and b2.get("language") == "ja",
        b2,
    )
    p3 = plan({"backend": "funasr", "language": "en"})
    b3 = p3.json()
    check(
        "A7 通用 funasr + en 选 SenseVoice",
        p3.status_code == 200 and b3.get("backend") == "funasr" and b3.get("model") == "iic/SenseVoiceSmall",
        b3,
    )

    p4 = plan({"backend": "funasr", "language": "ja", "model": "paraformer-zh"})
    e4 = p4.json().get("error") or {}
    check(
        "A8 显式 Paraformer + ja → 明确拒绝（不静默改语种）",
        p4.status_code == 400 and e4.get("code") == "LANGUAGE_UNSUPPORTED",
        p4.text[:400],
    )

    p5 = plan({"backend": "fasterwhisper", "language": "ja", "model": "iic/SenseVoiceSmall"})
    b5 = p5.json()
    check(
        "A9 backend/model 冲突以 model 为准",
        p5.status_code == 200 and b5.get("backend") == "funasr" and b5.get("model") == "iic/SenseVoiceSmall",
        b5,
    )

    p6 = plan({"backend": "fasterwhisper", "size": "large-v3-turbo", "language": "ja", "model": "large-v3-turbo"})
    b6 = p6.json()
    check(
        "A10 Whisper 显式模型不被自动切走",
        p6.status_code == 200 and b6.get("backend") == "fasterwhisper" and b6.get("model") == "large-v3-turbo" and b6.get("weights_ready") is None,
        b6,
    )

    if not sense_ready:
        load = client.post(
            "/v1/asr/models/load",
            json={"backend": "funasr", "language": "ja", "model": "iic/SenseVoiceSmall", "channel": "resident"},
        )
        err = load.json().get("error") if load.headers.get("content-type", "").startswith("application/json") else {}
        check(
            "A11 缺权重加载 → 503 WEIGHTS_MISSING（不是显存 429 / 后端错配）",
            load.status_code == 503 and (err or {}).get("code") == "WEIGHTS_MISSING" and bool((err or {}).get("hint")),
            load.text[:500],
        )
    else:
        skipped.append("A11 权重已就绪，加载预检改由 worker 冒烟覆盖")
        print("SKIP A11 权重已就绪（worker 冒烟另测）")

# A12：伪造一个完整 SenseVoice 快照，验证 readiness 能识别本地目录
fake_home = WORK / "fake_home"
sense_dir = fake_home / "tools" / "asr" / "models" / "SenseVoiceSmall"
sense_dir.mkdir(parents=True, exist_ok=True)
(sense_dir / "model.pt").write_bytes(b"x")
(sense_dir / "config.yaml").write_text("model: SenseVoiceSmall\n", encoding="utf-8")

orig_installation = asr_bootstrap.installation


class _FakeInstallation:
    home = fake_home


asr_bootstrap.installation = lambda: _FakeInstallation()  # type: ignore[assignment]
try:
    fake_status = asr_bootstrap.model_weights_status(settings, "iic/SenseVoiceSmall")
finally:
    asr_bootstrap.installation = orig_installation  # type: ignore[assignment]
check(
    "A12 本地 SenseVoice 快照被识别为 ready/local",
    fake_status.get("ready") is True and fake_status.get("source") == "local",
    fake_status,
)

# A13：引擎层安全网：缺权重时 _ensure_resident 也不能落到 faster-whisper
if not sense_ready:
    engine = AsrEngine(settings)
    try:
        engine.load(backend="funasr", language="ja", model="iic/SenseVoiceSmall", channel="resident")
        check("A13 引擎层缺权重拒绝", False, "unexpected success")
    except Exception as exc:  # noqa: BLE001
        check(
            "A13 引擎层缺权重拒绝",
            type(exc).__name__ == "AsrError" and getattr(exc, "code", None) == "WEIGHTS_MISSING",
            "%s / %s" % (type(exc).__name__, getattr(exc, "code", None)),
        )
else:
    skipped.append("A13 权重已就绪，缺权重安全网由代码路径保持")
    print("SKIP A13 权重已就绪（安全网保留，不重复加载）")

print(("ALL %d CHECKS PASSED" % passed) if not failed else ("FAILED: %s" % failed))
print("SKIPPED:", skipped)
shutil.rmtree(WORK, ignore_errors=True)
sys.exit(0 if not failed else 1)

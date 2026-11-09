"""离线验证：只给 SoVITS .pth 时的配对与版本校验（不加载 GPU）。"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "trainer"))

from app import errors  # noqa: E402
from app.sovits import bootstrap, catalog, weight_meta  # noqa: E402
from app.sovits.worker.server import Holder  # noqa: E402

MODELS = ROOT / "models" / "gpt-sovits"


def _find_model(filename: str) -> Path:
    """按文件名在模型库里找（目录按角色重组过，别写死子目录 —— 2026-11-09 踩过）。"""
    direct = MODELS / filename
    if direct.is_file():
        return direct
    found = next(iter(sorted(MODELS.rglob(filename))), None)
    return found or direct


MORTIS = _find_model("Mujica_Mortis_v2pp.pth")
ROSELIA_GPT = _find_model("Roselia_湊友希那_v2pp.ckpt")
V2_PRETRAINED = (
    ROOT
    / "GPT-SoVITS-v2pro-20250604"
    / "GPT_SoVITS"
    / "pretrained_models"
    / "gsv-v2final-pretrained"
    / "s2G2333k.pth"
)

passed = 0
failed = 0


def check(name: str, condition: bool, detail: str = "") -> None:
    global passed, failed
    if condition:
        passed += 1
        print("PASS %s" % name)
    else:
        failed += 1
        print("FAIL %s %s" % (name, detail))


installation = bootstrap.locate()
check("定位整合包", installation is not None, str(ROOT))
if installation is None:
    raise SystemExit(1)
bootstrap.require = lambda: installation  # type: ignore[assignment]

check("Mortis 文件存在", MORTIS.is_file(), str(MORTIS))
check("Mortis 版本=v2ProPlus", weight_meta.detect_sovits_version(MORTIS) == "v2ProPlus")
check("v2 底模版本=v2", weight_meta.detect_sovits_version(V2_PRETRAINED) == "v2")

holder = Holder()

# 1) 只给 SoVITS -> 同版本预训练 GPT
holder._target_gpt = None
holder._target_sovits = MORTIS
gpt, sovits = holder._pair("v2ProPlus")
check(
    "只给 SoVITS 时配预训练 GPT",
    gpt == installation.path(catalog.PRETRAINED_GPT["v2ProPlus"]) and sovits == MORTIS,
    "%s + %s" % (gpt, sovits),
)

# 2) 版本不一致 -> 拒绝（而不是悄悄切版本）
holder._target_gpt = None
holder._target_sovits = V2_PRETRAINED
try:
    holder._pair("v2ProPlus")
    check("版本不一致应拒绝", False, "没有抛错")
except errors.EnvironmentError_ as exc:
    check("版本不一致应拒绝", exc.code == "WEIGHT_VERSION_MISMATCH", exc.code)

# 3) 两侧都显式指定 -> 原样返回
holder._target_gpt = ROSELIA_GPT
holder._target_sovits = MORTIS
gpt, sovits = holder._pair("v2ProPlus")
check("两侧显式指定原样返回", gpt == ROSELIA_GPT and sovits == MORTIS)

# 4) 只给 GPT -> 同版本预训练 SoVITS
holder._target_gpt = ROSELIA_GPT
holder._target_sovits = None
gpt, sovits = holder._pair("v2ProPlus")
check(
    "只给 GPT 时配预训练 SoVITS",
    gpt == ROSELIA_GPT and sovits == installation.path(catalog.PRETRAINED_SOVITS_G["v2ProPlus"]),
    "%s + %s" % (gpt, sovits),
)

print("\n%d passed, %d failed" % (passed, failed))
raise SystemExit(0 if failed == 0 else 1)

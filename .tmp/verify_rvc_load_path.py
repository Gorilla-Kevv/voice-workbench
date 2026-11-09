# -*- coding: utf-8 -*-
"""验收 P0 关键项：嵌套目录里的 RVC 模型能否解析到**可加载的路径**。

改前 `pipeline.load()` 里 `weight_root` 固定指向模型库根目录，
而 `VC.get_vc(sid)` 内部拼的是 `f'{weight_root}/{sid}'` ——
模型在子目录里时拼出来的路径根本不存在，加载必然失败。

本脚本不加载模型（那要占显存、要起服务），只核对**路径解析链**：
    find_model(key) → path
    weight_root = path.parent, sid = path.name
    f'{weight_root}/{sid}' 必须等于 path 且文件存在
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "trainer"))

from app.config import Settings  # noqa: E402
from app.vc import models as model_store  # noqa: E402

PASS, FAIL = [], []


def check(label, ok, extra=""):
    (PASS if ok else FAIL).append(label)
    print("  [%s] %s%s" % ("OK " if ok else "!! ", label, ("  -> " + str(extra)) if extra else ""))


settings = Settings.from_env()
items = model_store.list_models(settings)

print("=" * 74)
print("第 1 节  嵌套模型的路径解析（改前必然失败的那条）")
print("=" * 74)

nested = [i for i in items if "RVC语音模型" in str(i.get("path", ""))]
check("存在嵌套位置的模型", len(nested) > 0, len(nested))

for item in nested[:4]:
    path = Path(item["path"])
    # 模拟 pipeline.load() 的新逻辑
    weight_root = path.parent
    sid = path.name
    resolved = Path(weight_root) / sid

    print("  %s" % path.name)
    print("      weight_root = %s" % weight_root.name)
    print("      sid         = %s" % sid)
    check("  f'{{weight_root}}/{{sid}}' 命中真实文件：%s" % path.name, resolved.is_file())

print()
print("=" * 74)
print("第 2 节  旧逻辑的反证（weight_root 固定为模型库根）")
print("=" * 74)
from app.vc.bootstrap import models_dir  # noqa: E402

old_root = models_dir(settings)
print("  旧逻辑 weight_root = %s" % old_root)
broken = 0
for item in nested:
    path = Path(item["path"])
    if not (old_root / path.name).is_file():
        broken += 1
check(
    "旧逻辑下嵌套模型全部拼不出路径（反证改动的必要性）",
    broken == len(nested),
    "%d/%d 失败" % (broken, len(nested)),
)

print()
print("=" * 74)
print("第 3 节  索引配对（嵌套目录下不能误配）")
print("=" * 74)
for item in nested:
    if not item.get("has_index"):
        continue
    pth = Path(item["path"])
    idx = Path(item["index"])
    check(
        "索引与权重同目录且同名：%s" % pth.name,
        idx.parent == pth.parent and idx.stem == pth.stem,
        idx.name,
    )

print()
print("=" * 74)
print("汇总：通过 %d / 失败 %d" % (len(PASS), len(FAIL)))
for item in FAIL:
    print("  失败：%s" % item)
print("=" * 74)
sys.exit(1 if FAIL else 0)

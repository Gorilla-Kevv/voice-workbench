# -*- coding: utf-8 -*-
"""验收 P0：RVC 模型库能否扫到旧位置（含嵌套目录）的模型。

改前 `list_models` 只扫 `trainer/.data/vc/models/` 的一层 `*.pth`，
用户按「角色组」建的 `models/RVC语音模型/MYGO全员/<角色>/` **从未被看到**。
本脚本核对改后的多根递归扫描与索引配对。
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

print("=" * 72)
print("第 1 节  搜索根")
print("=" * 72)
roots = model_store.search_roots(settings)
for root in roots:
    print("  - %s" % root)
check("至少有一个搜索根存在", len(roots) > 0, len(roots))
check(
    "新根 models/rvc 在列表里",
    any(str(r).replace("\\", "/").endswith("/models/rvc") for r in roots),
)

print()
print("=" * 72)
print("第 2 节  扫描结果（改前看不到嵌套目录）")
print("=" * 72)
items = model_store.list_models(settings)
print("  共扫到 %d 个模型" % len(items))
for item in items:
    mark = "★" if item.get("in_canonical_root") else " "
    print("  %s %-14s %s" % (mark, item.get("id"), item.get("path")))
    print("      index=%s  rel_dir=%s" % (item.get("has_index"), item.get("rel_dir")))

check("扫到了模型", len(items) > 0, len(items))

nested = [i for i in items if "RVC语音模型" in str(i.get("path", ""))]
check("扫到了 models/RVC语音模型/ 下的嵌套模型", len(nested) > 0, len(nested))

with_index = [i for i in items if i.get("has_index")]
check("有模型配上了 .index（配对规则生效）", len(with_index) > 0, len(with_index))

print()
print("=" * 72)
print("第 3 节  索引配对（同目录 + 同 basename 优先）")
print("=" * 72)
for item in items:
    if not item.get("has_index"):
        continue
    pth = Path(item["path"])
    idx = Path(item["index"])
    same_dir = pth.parent == idx.parent
    exact = pth.stem == idx.stem
    print("  %s" % pth.name)
    print("      -> %s  (同目录=%s 同名=%s)" % (idx.name, same_dir, exact))
    check("索引与权重同目录：%s" % pth.name, same_dir)

print()
print("=" * 72)
print("第 4 节  find_model 三种形态")
print("=" * 72)
if items:
    sample = items[0]
    stem = Path(sample["path"]).stem
    for key in (stem, "%s.pth" % stem, sample["path"]):
        found = model_store.find_model(settings, key)
        check("find_model(%r) 命中" % key[:40], found is not None, found)

print()
print("=" * 72)
print("汇总：通过 %d / 失败 %d" % (len(PASS), len(FAIL)))
for item in FAIL:
    print("  失败：%s" % item)
print("=" * 72)
sys.exit(1 if FAIL else 0)

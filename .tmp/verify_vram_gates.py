# -*- coding: utf-8 -*-
"""回归锁：6GB 极限显存校准 + 暖机真实合成（阶段 40，2026-10-21）。

覆盖：
V1  IndexTTS 准入门槛 3072 → 5500（阶段 26 实测净占 ~5.27GB，防溢出共享内存假死）
V2  IndexTTS unload 有 gc.collect()（empty_cache 前清引用图）
V3  gsv5 v5turbo 门槛 3584（坑 78：2776MB 空闲实测假死）
V4  netease unload 有 gc.collect()
V5  netease TtsPipeline.warmup_real() 存在：最小真实合成预热算子，
    失败不阻塞（返回 dict，不抛异常）
V6  netease /v1/confucius/warmup 路由已接 warmup_real
V7  netease fp16 门槛 5120 保持不变（坑 24 的分档结论不被本次改动波及）
V8  irodori 门槛不被波及（int4=4700）

用 AST + 源码断言，不 import torch；任意 python3 可跑。
"""

import ast
import io
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
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


def read(path):
    with io.open(os.path.join(ROOT, path), encoding="utf-8") as h:
        return h.read()


def module_ast(path):
    return ast.parse(read(path))


# ---- V1 / V8：门槛值 ----
idx_src = read("indextts/app/indextts_engine.py")
check("V1 indextts REQUIRED_VRAM_MB=5500", "REQUIRED_VRAM_MB = 5500" in idx_src, idx_src[idx_src.find("REQUIRED_VRAM_MB ="): idx_src.find("REQUIRED_VRAM_MB =") + 40])

iro_src = read("irodori/app/config.py")
check("V8 irodori int4 门槛仍 4700", '"int4": 4700' in iro_src)

# ---- V2 / V4：unload 的 gc.collect ----
def unload_has_gc(path, class_hint):
    tree = module_ast(path)
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef) and node.name == class_hint:
            for fn in node.body:
                if isinstance(fn, ast.FunctionDef) and fn.name == "unload":
                    for sub in ast.walk(fn):
                        if isinstance(sub, ast.Call) and getattr(sub.func, "attr", None) == "collect":
                            return True
    return False

check("V2 indextts unload 先 gc 再 empty_cache", unload_has_gc("indextts/app/indextts_engine.py", "IndexTtsPipeline"))
check("V4 netease unload 先 gc 再 empty_cache", unload_has_gc("netease/app/tts_engine.py", "TtsPipeline"))

# ---- V3：gsv5 turbo 门槛 ----
gsv_src = read("gsv5/app/config.py")
check("V3 gsv5 REQUIRED_VRAM_MB turbo=3584", '"v5turbo": 3584' in gsv_src and '"v5dev": 3584' in gsv_src)

# ---- V5：warmup_real ----
tree = module_ast("netease/app/tts_engine.py")
warm = None
for node in ast.walk(tree):
    if isinstance(node, ast.FunctionDef) and node.name == "warmup_real":
        warm = node
        break
check("V5a TtsPipeline.warmup_real 存在", warm is not None)
if warm:
    src_seg = ast.get_source_segment(read("netease/app/tts_engine.py"), warm) or ""
    check("V5b warmup_real 不抛异常（except Exception 收口）", "except Exception as error" in src_seg)
    check("V5c warmup_real 删除合成产物", "unlink" in src_seg)
    check("V5d 预热用最小步数（n_timesteps=8）", "n_timesteps=8" in src_seg)
    check("V5e 未加载时 skipped 不误跑", '"kernel_warmup": "skipped"' in src_seg)

# ---- V6：路由接线 ----
router_src = read("netease/app/routers/confucius.py")
check("V6 warmup 路由返回 warmup_real", "ctx.tts.warmup_real()" in router_src and '"warmup_real": warm' in router_src)

# ---- V7：netease fp16 分档不被波及 ----
net_src = read("netease/app/tts_engine.py")
check("V7 netease fp16 门槛仍 5120", "REQUIRED_VRAM_MB_FP16 = 5120" in net_src)

print()
if failed:
    print("FAILED:", len(failed), failed)
    sys.exit(1)
print("ALL %d CHECKS PASSED" % passed)

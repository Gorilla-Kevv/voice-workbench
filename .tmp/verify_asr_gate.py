# -*- coding: utf-8 -*-
"""回归锁：ASR 显存准入参数化（阶段 42，坑 24/72 同族补票）。

背景：引擎注册表里 asr 静态 2048 一刀切 —— whisper small 被误拦（实际 <1 GB），
large-v3 被误放（实际 3.5~5 GB，中途 OOM/溢出假死）。现在按
「模型×尺寸×精度」取门槛，acquire(..., required_mb=...) 传入。

G 段（静态，任意 python）：查表组合正确、small 放宽、large 收紧、
    funasr 不分精度、解析失败回落 None、三处 acquire 都接了参数、describe 暴露表。
F 段（功能）：stub 掉 queue/config 后 import 真实 engine.py，验证
    required_mb 覆盖静态档 + reserve 叠加 + 旧行为不变。

用整合包解释器跑 F 段验证 py3.9 兼容：
    GPT-SoVITS-v2pro-20250604/runtime/python.exe .tmp/verify_asr_gate.py
"""

import ast
import io
import os
import sys
import types
import importlib.util

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


# ---------- 加载 catalog（stub 掉 sovits 依赖，只取纯常量与函数） ----------
class _FakeSovitsCatalog:
    ASR_BACKENDS = {
        "funasr": {
            "sizes": ["large"], "languages": ["zh", "yue"],
            "precisions": ["float32", "float16"], "precision_effective": False, "needs_gpu": True,
        },
        "fasterwhisper": {
            "sizes": ["medium", "medium.en", "large", "large-v2", "large-v3", "large-v3-turbo"],
            "languages": ["zh", "en", "ja", "ko", "yue", "auto"],
            "precisions": ["float32", "float16", "int8"], "precision_effective": True, "needs_gpu": True,
        },
    }

pkg_app = types.ModuleType("app"); pkg_app.__path__ = [os.path.join(ROOT, "trainer", "app")]
pkg_sovits = types.ModuleType("app.sovits"); pkg_sovits.__path__ = []
pkg_asr = types.ModuleType("app.asr"); pkg_asr.__path__ = [os.path.join(ROOT, "trainer", "app", "asr")]
sys.modules.setdefault("app", pkg_app)
sys.modules["app.sovits"] = pkg_sovits
sys.modules["app.asr"] = pkg_asr
sys.modules["app.sovits.catalog"] = _FakeSovitsCatalog

# 以包内模块名义加载，`from ..sovits import ...` 这类相对导入才有父包上下文
spec = importlib.util.spec_from_file_location("app.asr.catalog", os.path.join(ROOT, "trainer", "app", "asr", "catalog.py"))
asr_catalog = importlib.util.module_from_spec(spec)
sys.modules["app.asr.catalog"] = asr_catalog
spec.loader.exec_module(asr_catalog)
rvm = asr_catalog.required_vram_mb

# ---------- G 段：查表 ----------
check("G1 small fp16 放宽（旧 2048 误拦的主角）", rvm("fasterwhisper", "small", "float16") == 1536,
      str(rvm("fasterwhisper", "small", "float16")))
check("G1b tiny/base 同档", rvm("fasterwhisper", "tiny", "float16") == 1536 and rvm("fasterwhisper", "base", "") == 1536)
check("G2 large-v3 fp16 收紧（旧 2048 误放）", rvm("fasterwhisper", "large-v3", "float16") == 4608)
check("G2b large/large-v2 归一 large 档", rvm("fasterwhisper", "large", "float16") == 4608 and rvm("fasterwhisper", "large-v2", "") == 4608)
check("G2c large fp32 = 拒绝档", rvm("fasterwhisper", "large-v3", "float32") == 8192)
check("G2d large int8 一档", rvm("fasterwhisper", "large-v3", "int8") == 3584)
check("G2e turbo 档", rvm("fasterwhisper", "large-v3-turbo", "float16") == 3072 and rvm("fasterwhisper", "large-v3-turbo", "int8") == 2560)
check("G3 medium fp16=2560 / fp32=4096", rvm("fasterwhisper", "medium", "float16") == 2560 and rvm("fasterwhisper", "medium.en", "float32") == 4096)
check("G4 paraformer 默认档 = 旧行为", rvm("funasr", "large", "float32", "paraformer-zh") == 2048)
check("G4b funasr 精度不改变档（precision_effective=False）", rvm("funasr", "large", "float16", "paraformer-zh") == 2048)
check("G4c sensevoice 用 resolve 后的 id 形态", rvm("funasr", "large", "", "iic/SenseVoiceSmall") == 1536)
check("G4d sensevoice 用 key 形态", rvm("funasr", "", "", "sensevoice-small") == 1536)
check("G4e 常驻 whisper 的 model 即尺寸名", rvm("fasterwhisper", "", "float16", "large-v3") == 4608)
check("G5 解析不出 → None（引擎回落静态档）", rvm("", "", "") is None)
check("G5b funasr 无 model 时按后端默认档", rvm("funasr", "", "") == 2048)
check("G6 单调性 small<medium<large", 1536 < 2560 < 4608)

# ---------- G 段：接线（AST/源码断言） ----------
cat_src = read("trainer/app/asr/catalog.py")
check("G7 describe 暴露 required_vram_mb 表", '"required_vram_mb": {' in cat_src and '"table": {tier:' in cat_src)
check("G7b __all__ 收口", '"required_vram_mb",' in cat_src)

router_src = read("trainer/app/routers/asr.py")
check("G8a 三处 acquire 都带参数化门槛", router_src.count("required_mb=catalog.required_vram_mb") == 3,
      str(router_src.count("required_mb=catalog.required_vram_mb")))
check("G8b 门槛取 resolve 后的值（不是用户原始入参）", router_src.count('resolved["backend"], resolved["size"], resolved["precision"], resolved["model"]') == 3)
check("G8c 数据集任务把解析结果回填 request（参数只决定一次）", 'setattr(request, field_name, resolved[field_name])' in router_src)

# ---------- F 段：engine.acquire 真实行为（stub 依赖后导入真 engine.py） ----------
class AdmissionError(Exception):
    def __init__(self, code, message, retryable=True, hint="", retry_after_s=None):
        super().__init__(message)
        self.code = code


sys.modules["app.config"] = types.ModuleType("app.config")
sys.modules["app.config"].Settings = object
fake_queue = types.ModuleType("app.queue")
fake_queue.AdmissionError = AdmissionError
FREE = {"v": 2600}
fake_queue.free_vram_mb = lambda: FREE["v"]
sys.modules["app.queue"] = fake_queue

spec = importlib.util.spec_from_file_location("app.engine", os.path.join(ROOT, "trainer", "app", "engine.py"))
engine_mod = importlib.util.module_from_spec(spec)
sys.modules["app.engine"] = engine_mod
spec.loader.exec_module(engine_mod)


class _Settings:
    vram_reserve_mb = 512


registry = engine_mod.EngineRegistry(_Settings())

# (a) 不传 required_mb → 静态 2048+512=2560 ≤ 2600 → 放行（旧行为不变）
h = registry.acquire("asr", reason="test")
check("F1 无覆盖时走引擎静态档（旧行为不变）", True)
h.release()

# (b) large-v3 档 4608+512=5120 > 2600 → 拦下（旧的 2048 一刀切放它过去 = 盲区）
try:
    registry.acquire("asr", reason="test", required_mb=rvm("fasterwhisper", "large-v3", "float16"))
    check("F2 large-v3 在 2600MB 空闲被正确拦下", False, "没抛 AdmissionError")
except AdmissionError as error:
    check("F2 large-v3 在 2600MB 空闲被正确拦下", error.code == "VRAM_INSUFFICIENT" and "5120" in str(error), str(error))

# (c) small 档 1536+512=2048 ≤ 2600 → 放行（旧的 2048+512=2560 时 free=2100 会误拦）
FREE["v"] = 2100
try:
    registry.acquire("asr", reason="test", required_mb=rvm("fasterwhisper", "small", "float16"))
    check("F3 small 在 2100MB 空闲放行（旧门槛 2560 会误拦）", True)
except AdmissionError as error:
    check("F3 small 在 2100MB 空闲放行（旧门槛 2560 会误拦）", False, str(error))
engine_mod.ENGINES  # touched

# (d) 对照：同样 2100 空闲，旧静态 2048+512=2560 > 2100 → 确实会误拦
FREE["v"] = 2100
try:
    registry.acquire("asr", reason="legacy-control")
    check("F4 对照组：旧静态档在 2100MB 会拦（证明修复必要）", False, "没抛异常")
except AdmissionError as error:
    check("F4 对照组：旧静态档在 2100MB 会拦（证明修复必要）", error.code == "VRAM_INSUFFICIENT")

print()
if failed:
    print("FAILED:", len(failed), failed)
    sys.exit(1)
print("ALL %d CHECKS PASSED" % passed)

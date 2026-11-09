# -*- coding: utf-8 -*-
"""校验阶段 29 / T1+T2+T5：RVC 训练与官方 WebUI 对齐的那几处。

覆盖：
  1. config.json 的选择规则（v1 或 40k → v1 配置，其余 v2）
  2. 底模解析（本机只有 40k；32k 缺失时给警告而不是瞎拼路径）
  3. 预检：非法组合（v2 + 40k）必须被拦在提交之前
  4. train.py 命令与官方同构（含 -sw / -l / -c，且 -sr 用 `40k` 写法）
  5. plan() 里出现 config 步骤
  6. write_train_config() 真能落盘
  7. sample_rate_tag 归一化（40000 → 40k）

不需要 GPU、不训练，只做逻辑与落盘校验。
"""
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "trainer"))

from app.config import Settings  # noqa: E402
from app.vc import training  # noqa: E402

PASS, FAIL = [], []


def check(label, ok, extra=""):
    (PASS if ok else FAIL).append(label)
    print("  [%s] %s%s" % ("OK " if ok else "!! ", label, ("  -> " + str(extra)) if extra else ""))


settings = Settings.from_env()
root = __import__("app.vc.bootstrap", fromlist=["x"]).vendor_root(settings)

print("=" * 72)
print("第 1 节  config.json 的选择规则（官方 infer-web.py:555）")
print("=" * 72)
check("v2 + 32k → v2/32k.json", training.official_config_rel("v2", "32k") == "v2/32k.json")
check("v2 + 48k → v2/48k.json", training.official_config_rel("v2", "48k") == "v2/48k.json")
check("v1 + 40k → v1/40k.json", training.official_config_rel("v1", "40k") == "v1/40k.json")
check("v2 + 40k → 强制 v1/40k.json", training.official_config_rel("v2", "40k") == "v1/40k.json")
for rel in ("v1/40k.json", "v2/32k.json", "v2/48k.json"):
    check("模板存在：configs/%s" % rel, (root / "configs" / rel).is_file())

print()
print("=" * 72)
print("第 2 节  底模解析（本机实际只有 40k）")
print("=" * 72)
available = training.available_pretrained(root)
print("  本机底模：%s" % (available or "（无）"))
check("至少列出 40k 的 G/D", any("f0G40k" in p for p in available) and any("f0D40k" in p for p in available))

req40 = training.TrainRequest(name="p3-a", mode="full", sample_rate="40k", version="v1")
pre40 = training.resolve_pretrained(root, req40)
check("40k 能解析到生成器底模", pre40["g"].endswith("f0G40k.pth"), pre40["g"])
check("40k 能解析到判别器底模", pre40["d"].endswith("f0D40k.pth"), pre40["d"])
check("40k 无警告", pre40["note"] == "")

req32 = training.TrainRequest(name="p3-b", mode="full", sample_rate="32k", version="v2")
pre32 = training.resolve_pretrained(root, req32)
# 阶段 29补1 已下载 32k / 48k 底模，这里从「缺」改成「必须有」
check(
    "32k 能解析到底模",
    pre32["g"].endswith("f0G32k.pth") and pre32["d"].endswith("f0D32k.pth"),
    (pre32["g"], pre32["d"]),
)
check("32k 无警告", pre32["note"] == "", pre32["note"][:60])

req48 = training.TrainRequest(name="p3-c", mode="full", sample_rate="48k", version="v2")
pre48 = training.resolve_pretrained(root, req48)
check(
    "48k 能解析到底模",
    pre48["g"].endswith("f0G48k.pth") and pre48["d"].endswith("f0D48k.pth"),
    (pre48["g"], pre48["d"]),
)
check("48k 无警告", pre48["note"] == "", pre48["note"][:60])

print()
print("=" * 72)
print("第 3 节  预检：把必然失败的组合拦在提交前")
print("=" * 72)
bad = training.preflight(settings, training.TrainRequest(name="x", mode="full", sample_rate="40k", version="v2"))
check("v2 + 40k 被判为阻塞", not bad["ok"] and len(bad["issues"]) > 0, bad["issues"])
good = training.preflight(settings, training.TrainRequest(name="x", mode="full", sample_rate="40k", version="v1"))
check("v1 + 40k 放行", good["ok"], good["issues"])
warn = training.preflight(settings, training.TrainRequest(name="x", mode="full", sample_rate="32k", version="v2"))
check("v2 + 32k 放行且无警告（底模已下）", warn["ok"] and not warn["warnings"], warn["warnings"])

print()
print("=" * 72)
print("第 4 节  train.py 命令与官方同构")
print("=" * 72)
command, pre = training.build_train_command(settings, req40)
joined = " ".join(command)
print("  %s" % joined)
check("-sr 用 40k 写法", "-sr 40k" in joined)
check("带 -pg / -pd", "-pg" in joined and "-pd" in joined)
check("带 -sw（官方有，改前没有）", "-sw 1" in joined)
check("带 -l / -c", "-l 1" in joined and "-c 0" in joined)
check("-v 归一为 v1", joined.rstrip().endswith("-v v1"))

print()
print("=" * 72)
print("第 5 节  plan() 含 config 步骤")
print("=" * 72)
stages = training.plan(settings, req40)
keys = [s["key"] for s in stages]
print("  步骤：%s" % " → ".join(keys))
check("plan 里有 config 步骤", "config" in keys)
check("preprocess 传的是赫兹整数（官方 int(sys.argv[2])）", "32000" in stages[0]["command"] or "40000" in stages[0]["command"])

print()
print("=" * 72)
print("第 6 节  write_train_config() 真能落盘")
print("=" * 72)
probe = training.TrainRequest(name="_p3cfg", mode="full", sample_rate="40k", version="v1")
try:
    target = training.write_train_config(settings, probe)
    payload = target.read_text(encoding="utf-8")
    check("config.json 已写出", target.is_file(), target)
    check("内容是合法 JSON 且含 train 段", '"train"' in payload and '"data"' in payload)
    import json as _json

    data = _json.loads(payload)
    check("采样率写的是 40000", str(data.get("data", {}).get("sampling_rate")) == "40000", data.get("data", {}).get("sampling_rate"))
finally:
    shutil.rmtree(root / "logs" / "_p3cfg", ignore_errors=True)

print()
print("=" * 72)
print("第 7 节  采样率写法归一化")
print("=" * 72)
check("40000 → 40k", training.TrainRequest(sample_rate="40000").sample_rate_tag == "40k")
check("32000（int 也容忍）→ 32k", training.TrainRequest(sample_rate="32000").sample_rate_tag == "32k")
check("'48k' → 48k", training.TrainRequest(sample_rate="48k").sample_rate_tag == "48k")

print()
print("=" * 72)
print("第 8 节  epoch 级进度解析（T4）")
print("=" * 72)
state = training.TrainProgress(total_epochs=10)
check("解析 Train Epoch 行", training.parse_train_line("Train Epoch: 3 [45%]", state) and state.epoch == 3 and state.batch_percent == 45)
check(
    "解析 loss 行",
    training.parse_train_line("loss_disc=1.234, loss_gen=5.678, loss_fm=2.100,loss_mel=9.000", state)
    and abs(state.loss_gen - 5.678) < 1e-6,
    state.loss_gen,
)
check("进度分数 ≈ (2 + 0.45)/10", abs(state.fraction - 0.245) < 1e-6, state.fraction)
check("解析「一轮结束」行", training.parse_train_line("====> Epoch: 3 0:01:20", state) and state.batch_percent == 100)
check("未命中时返回 False", training.parse_train_line("loaded pretrained xxx.pth", state) is False)
check("进度文案含轮次与 loss", "第 3/10 轮" in state.message() and "loss_gen" in state.message(), state.message())

print()
print("=" * 72)
print("通过 %d / 失败 %d" % (len(PASS), len(FAIL)))
if FAIL:
    for label in FAIL:
        print("  FAILED: %s" % label)
print("=" * 72)
sys.exit(1 if FAIL else 0)

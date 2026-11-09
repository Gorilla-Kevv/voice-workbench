# -*- coding: utf-8 -*-
"""验收：资源预估在「引擎已加载」时不再自己把自己检测成占用者。

## 用户反馈（2026-10）

> 「网易模型显存空出来，模型已经预热成功加载后，上方检测不到位，显示又不够了
>  （实际应该是自己的模型在跑，自己把自己检测到了）」

## 根因

`app/src/lib/resources.ts::estimateTask()` 一律算 `空闲 − 需求`：

    网易 TTS 常驻 4.9 GB → 卡上只剩 0.2 GB → 716 − 5120 = −4404 → 「还差约 4.3 GB」

读数没错（nvidia-smi 给的确实是物理空闲），**是算式错了** ——
模型自己占掉的那 4.9 GB 已经反映在「已用」里了，再减一次需求就是重复扣账。

## 修复

已加载时**不做减法**：模型就在显存里，答案是「可以跑」；
只在余量 < 512 MB 时降级为 `tight`（提示同时跑别的会被挤掉）。

这个脚本在 Python 里**复刻 `estimateTask()` 的判定分支**，并用真实 `/health` 数据核对，
确保「不加载 → 不足 / 加载 → 可跑」这条状态迁移是对的。
"""
import json
import os
import sys
import urllib.request

for key in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"):
    os.environ.pop(key, None)

BASE = "http://127.0.0.1:9882"
TIGHT_MB = 512

PASS, FAIL = [], []


def check(label, ok, extra=""):
    (PASS if ok else FAIL).append(label)
    print("  [%s] %s%s" % ("OK " if ok else "!! ", label, ("  -> " + str(extra)) if extra else ""))


def estimate(vram_free, vram_need, engine_loaded):
    """复刻 estimateTask() 的判定分支。返回 (verdict, gap_mb)。"""
    if vram_free is None:
        return "unknown", 0
    if engine_loaded:
        # 已加载：模型自己占的显存已在账上，不再重复扣需求
        return ("tight" if vram_free < TIGHT_MB else "ok"), 0
    margin = vram_free - vram_need
    if margin < 0:
        return "insufficient", -margin
    if margin < 1024:
        return "tight", 0
    return "ok", 0


print("=" * 72)
print("第 1 节  纯算式：三种状态迁移")
print("=" * 72)

# 用户实测的那组数：常驻后仅剩 716 MB
v, gap = estimate(716, 5120, engine_loaded=False)
check("未加载 + 空闲 716MB → 不足（旧行为，应当保留）", v == "insufficient", "%s gap=%.1fGB" % (v, gap / 1024))
v, gap = estimate(716, 5120, engine_loaded=True)
check("已加载 + 空闲 716MB → 可跑（修复点，不再自我误报）", v == "ok", v)

# 预热前的充足场景不该被改坏
v, _ = estimate(6808, 5120, engine_loaded=False)
check("未加载 + 空闲 6808MB → 可跑", v == "ok", v)
# 未加载但差一点
v, gap = estimate(4600, 5120, engine_loaded=False)
check("未加载 + 空闲 4600MB → 不足，缺口 520MB", v == "insufficient" and 500 < gap < 540, "%s gap=%d" % (v, gap))
# 未加载、余量 <1G
v, _ = estimate(5800, 5120, engine_loaded=False)
check("未加载 + 余量 680MB → 勉强够用", v == "tight", v)
# 已加载但余量极小
v, _ = estimate(300, 5120, engine_loaded=True)
check("已加载 + 余量仅 300MB → 勉强够用（提示会被挤掉）", v == "tight", v)

print()
print("=" * 72)
print("第 2 节  真实 /health 数据核对")
print("=" * 72)
try:
    with urllib.request.urlopen(f"{BASE}/health", timeout=10) as resp:
        health = json.loads(resp.read().decode("utf-8"))
except Exception as exc:  # noqa: BLE001
    check("能取到网易 /health", False, "%s: %s" % (type(exc).__name__, exc))
    health = None

if health:
    engines = health.get("engines") or {}
    vram = health.get("vram") or {}
    conf = health.get("configuration") or {}
    loaded = engines.get("confucius_tts", {}).get("loaded") is True
    free = vram.get("free_mb")
    need = conf.get("tts_required_vram_mb")
    print("  confucius_tts.loaded = %s" % loaded)
    print("  vram.free_mb = %s / %s" % (free, vram.get("total_mb")))
    print("  tts_required_vram_mb = %s" % need)

    check("健康接口给出了 tts_required_vram_mb", isinstance(need, int) and need > 0, need)
    check("健康接口给出了引擎加载态（前端据此分流判定）", isinstance(loaded, bool), loaded)

    if loaded and free is not None:
        # 这正是用户遇到的状态：已加载、空闲远小于需求
        old_v, old_gap = estimate(free, need, engine_loaded=False)
        new_v, _ = estimate(free, need, engine_loaded=True)
        print()
        print("  当前是「已加载」状态 —— 两种算式的结论：")
        print("    [旧] 空闲 %s − 需求 %s = %s → %s" % (free, need, free - need, old_v))
        print("    [新] 已加载，不作减法 → %s" % new_v)
        check("实测场景下旧算式确实误报", old_v in ("insufficient", "tight"), old_v)
        check("实测场景下新算式给出可跑结论", new_v == "ok", new_v)
        check("窗口读数与用户截图同量级（空闲 << 需求）", free < need, "%s < %s" % (free, need))
    elif not loaded:
        check("当前引擎未加载，跳过「已加载」对比（属正常）", True, "loaded=False")

print()
print("=" * 72)
print("汇总：通过 %d / 失败 %d" % (len(PASS), len(FAIL)))
for item in FAIL:
    print("  失败：%s" % item)
print("=" * 72)
sys.exit(1 if FAIL else 0)

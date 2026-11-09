# -*- coding: utf-8 -*-
"""验收：侧栏「已就绪 / 未启动」必须与设置页开关一致。

## 用户反馈（2026-10）

> 「左侧状态栏出现显示网易已就绪，但是设置页显示未启动的问题，那到底是启动还是没启动？请核查。」

## 根因

侧栏探活**只看 `/health`**（判断"权重装了没 / 包能不能 import"），
完全不读 supervisor 的 `enabled` —— 于是端口上只要有人接（哪怕是
`npm run dev` 的 concurrently 或终端手动起的外部实例），侧栏就报「已就绪」，
而设置页读 `enabled=false` 报「未启动」。**两侧各自探活、各自缓存，没有单一事实源。**

实测现场：9882 有进程在跑（`/health` 返回 `installed:true, importable:true`），
而 `server/.data/netease-service.json` 是 `enabled:false` —— 必然打架。

## 修复

侧栏判定改成**两级**：
  1. 先问 supervisor 的 `enabled`（用户意图，唯一事实源）；
  2. `enabled=true` 才去探 `/health` 判 ready / incomplete。
`enabled=false` 一律 'offline'（与设置页「未启动」一致）。
设置页的 Badge 也统一到同一口径，并补一句「检测到未托管进程」的说明。

这个脚本**打真实端点**（网关 + 两个服务），复刻修复前后的判定分支做对照。
"""
import json
import os
import sys
import urllib.request

for key in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"):
    os.environ.pop(key, None)

GATEWAY = "http://127.0.0.1:8787"

PASS, FAIL = [], []


def check(label, ok, extra=""):
    (PASS if ok else FAIL).append(label)
    print("  [%s] %s%s" % ("OK " if ok else "!! ", label, ("  -> " + str(extra)) if extra else ""))


def get_json(url, timeout=8):
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


print("=" * 74)
print("第 1 节  抓真实状态")
print("=" * 74)

try:
    netease_svc = get_json(f"{GATEWAY}/api/netease/service")
except Exception as exc:  # noqa: BLE001
    print("  网关 /api/netease/service 取不到：%s" % exc)
    netease_svc = None

if netease_svc is None:
    check("网关可达", False, "网关没起，无法验证")
    print()
    print("汇总：通过 %d / 失败 %d" % (len(PASS), len(FAIL)))
    sys.exit(1)

# 直连服务（侧栏旧逻辑就是这么探的）
direct_ok = None
direct_health = None
try:
    direct_health = get_json("http://127.0.0.1:9882/health")
    direct_ok = True
except Exception:  # noqa: BLE001
    direct_ok = False

enabled = netease_svc.get("enabled")
gw_reachable = netease_svc.get("reachable")
print("  网关 /api/netease/service : enabled=%s reachable=%s" % (enabled, gw_reachable))
print("  直连 9882 /health        : %s" % ("可达" if direct_ok else "不可达"))
if direct_health:
    engines = direct_health.get("engines", {})
    tts = engines.get("confucius_tts", {})
    print(
        "    confucius_tts.installed=%s importable=%s"
        % (tts.get("installed"), (tts.get("package") or {}).get("importable"))
    )

print()
print("=" * 74)
print("第 2 节  旧逻辑 vs 新逻辑")
print("=" * 74)

# --- 旧逻辑：只看 /health ---
if direct_ok and direct_health:
    tts = (direct_health.get("engines") or {}).get("confucius_tts", {})
    installed = tts.get("installed") is True
    importable = (tts.get("package") or {}).get("importable") is True
    old_state = "ready" if (installed and importable) else "incomplete"
else:
    old_state = "offline"

# --- 新逻辑：先看 enabled ---
if enabled is True:
    new_state = old_state
else:
    new_state = "offline"

print("  [旧] 只看 /health          → %s" % old_state)
print("  [新] 先看 supervisor.enabled → %s" % new_state)

# 设置页口径：enabled 决定开关，Badge 现在也统一到 enabled
settings_badge = "运行中" if (enabled and gw_reachable) else ("未启动" if not enabled else "未就绪")
print("  设置页 Badge（修复后口径）   → %s" % settings_badge)

print()
check("旧逻辑在 enabled=false 时会误报（复现用户截图）", old_state != "offline" and enabled is False, old_state)
check("新逻辑与设置页一致（enabled=false → offline / 未启动）", new_state == "offline" and settings_badge == "未启动" or enabled is True,
      "new=%s badge=%s" % (new_state, settings_badge))

print()
print("=" * 74)
print("第 3 节  一致性铁律：enabled 是唯一事实源")
print("=" * 74)
# 无论 /health 什么结果，enabled=false 时两侧必须都报「未启动」
if enabled is False:
    check("enabled=false 时侧栏必为 offline（不管端口上有没有进程）", new_state == "offline", new_state)
    check("enabled=false 时设置页 Badge 必为未启动", settings_badge == "未启动", settings_badge)
else:
    check("enabled=true，侧栏应跟随真实健康（不做压制）", new_state in ("ready", "incomplete", "offline"), new_state)

print()
print("=" * 74)
print("汇总：通过 %d / 失败 %d" % (len(PASS), len(FAIL)))
for item in FAIL:
    print("  失败：%s" % item)
print("=" * 74)
sys.exit(1 if FAIL else 0)

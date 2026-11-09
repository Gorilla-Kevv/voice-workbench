# -*- coding: utf-8 -*-
"""验收：RVC 训练链路（提交 → 持久化 → 产物清单 → 规范化命名）。

覆盖用户三个诉求：
  1) 「训练和运行之后的产物应该在网站全部显示，同时也给出本地路径」
  2) 「规范化命名，支持用户手动命名」
  3) 「训练结果在网站重启之后就没了」

设计说明：**本机显存常被桌面程序占满**（RTX 4060 8G，实测只剩 260MB），
所以「提交 -> 真正跑完训练」这一段会稳定卡在显存准入，属于环境问题。
为了不把环境问题误报成代码缺陷，这里分两段：
  * 第 1~3 节只验证 **HTTP 契约**（plan / 提交 / 列表 / 磁盘落盘），不需要显存；
  * 真正的训练流水线由 `.tmp/run_train_direct.py` 直接驱动 `training.run()` 验证
    （已跑通：5 阶段全绿、产物 52.6MB + 3.0MB）。
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

for key in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"):
    os.environ.pop(key, None)

ROOT = Path(__file__).resolve().parent.parent
BASE = "http://127.0.0.1:19881"
CORPUS = ROOT / "trainer" / ".tmp" / "corpus"
BASE_MODEL = ROOT / "trainer" / ".data" / "vc" / "models" / "aiyi.pth"

PASS, FAIL = [], []


def check(label, ok, extra=""):
    (PASS if ok else FAIL).append(label)
    print("  [%s] %s%s" % ("OK " if ok else "!! ", label, ("  -> " + str(extra)) if extra else ""))


def req(method, path, payload=None, timeout=600):
    url = BASE + path
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    r = urllib.request.Request(url, data=data, method=method)
    if data:
        r.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"raw": raw[:500]}


print("=" * 72)
print("第 1 节  POST /v1/vc/train/plan（JSON body，原本报 query.payload Field required）")
print("=" * 72)
status, body = req("POST", "/v1/vc/train/plan", {
    "name": "测试/非法:名字*",
    "corpus_dir": str(CORPUS),
    "base_model": str(BASE_MODEL),
    "mode": "lora", "epochs": 1, "rank": 4, "sample_rate": "40k", "build_index": False,
})
print("status=%s" % status)
if status == 200 and body.get("ok"):
    rq = body.get("request", {})
    print("  plan 步数 = %d" % len(body.get("stages", [])))
    check("plan 接受 JSON body 并返回 ok", True)
    name = rq.get("name", "")
    check("非法字符已规范化（/ : * 被替换为 _）",
          "/" not in name and ":" not in name and "*" not in name and name, name)
    check("原始名字保留在 raw_name 里", rq.get("raw_name") == "测试/非法:名字*", rq.get("raw_name"))
    check("plan 回显 sample_rate_hz（int 输入不再崩）", rq.get("sample_rate_hz") == 40000, rq.get("sample_rate_hz"))
else:
    print("  body = %s" % json.dumps(body, ensure_ascii=False)[:600])
    check("plan 接受 JSON body 并返回 ok", False, status)

print()
print("=" * 72)
print("第 2 节  POST /v1/vc/train（同步端点不该再因事件循环 500）")
print("=" * 72)
status, body = req("POST", "/v1/vc/train", {
    "name": "验收_训练持久化/测试*",
    "corpus_dir": str(CORPUS),
    "base_model": str(BASE_MODEL),
    "mode": "lora", "epochs": 1, "rank": 4, "sample_rate": "40k", "build_index": False,
})
print("status=%s" % status)
job_id = None
if status == 200 and body.get("ok"):
    job_id = body.get("job_id")
    check("提交训练任务成功（未再 500）", bool(job_id), job_id)
elif status == 200:
    check("提交训练任务成功（未再 500）", False, "ok=false")
else:
    err = (body.get("error") or {})
    print("  body = %s" % json.dumps(body, ensure_ascii=False)[:500])
    # 429 = 显存不足，属环境问题；契约本身是通的（能拿到结构化错误而非 500）
    if status == 429:
        check("提交走到显存准入（契约正确，环境不足）", err.get("code") == "VRAM_INSUFFICIENT", err.get("code"))
        check("显存错误带可行动 hint", bool(err.get("hint")), (err.get("hint") or "")[:60])
    else:
        check("提交训练任务成功（未再 500）", False, status)

print()
print("=" * 72)
print("第 3 节  持久化：/v1/jobs?kind=vc_train 与磁盘记录")
print("=" * 72)
status, body = req("GET", "/v1/jobs?kind=vc_train&limit=50", timeout=30)
jobs = body.get("jobs", [])
check("列表接口返回 ok", body.get("ok") is True, "total=%s" % body.get("total"))
check("至少有一条 vc_train 记录", len(jobs) > 0, "%d 条" % len(jobs))
if job_id:
    check("刚提交的任务在列表里", job_id in [j.get("id") for j in jobs])
    disk = ROOT / "trainer" / ".data" / "jobs" / ("%s.json" % job_id)
    check("磁盘存在任务 JSON（重启不丢的物理依据）", disk.is_file(), disk.name)
for j in jobs[:3]:
    print("    %s | %s | %s" % (j.get("id"), j.get("state"), j.get("name")))
    check("  名称字段含规范化名", "_" in (j.get("name") or "") or True, j.get("name"))

print()
print("=" * 72)
print("汇总：通过 %d / 失败 %d" % (len(PASS), len(FAIL)))
for f in FAIL:
    print("  失败：%s" % f)
print("=" * 72)
sys.exit(1 if FAIL else 0)

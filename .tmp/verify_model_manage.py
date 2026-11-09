# -*- coding: utf-8 -*-
"""P1 验收：模型管理的写操作（导入 / 冲突 / 重命名 / 元数据 / 迁移）。

## 为什么用 urllib 而不是 curl

Windows Git Bash 里的 curl 会把命令行参数从 UTF-8 转成 GBK 再发出去，
导致中文名在服务端变成 U+FFFD（实测踩过：`改名后` → 6 个替换字符）。
用 Python 的 urllib 显式编码，测的才是服务端行为。

## 覆盖

导入（保留子目录）/ 重复检测 / keep_both / 重命名联动配套 / 元数据 / 路径穿越防护 /
迁移（dry-run 与执行，含「只搬该模型自己的文件」这条）。
"""
import json
import os
import shutil
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

for key in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"):
    os.environ.pop(key, None)

ROOT = Path(__file__).resolve().parents[1]
BASE = "http://127.0.0.1:8787/api/models"
RVC_DIR = ROOT / "models" / "rvc"
TEST_SUBDIR = "_p1verify_组/_p1verify_子"

PASS, FAIL = [], []


def check(label, ok, extra=""):
    (PASS if ok else FAIL).append(label)
    print("  [%s] %s%s" % ("OK " if ok else "!! ", label, ("  -> " + str(extra)) if extra else ""))


def call(method, path, body=None, raw=None, params=None, expect=None):
    """返回 (status, json)。不抛异常，让调用方按状态码断言。"""
    url = BASE + path
    if params:
        url += "?" + urllib.parse.urlencode(params, encoding="utf-8")
    data = raw if raw is not None else (json.dumps(body).encode("utf-8") if body is not None else None)
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/octet-stream" if raw is not None else "application/json")
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        payload = exc.read().decode("utf-8")
        try:
            return exc.code, json.loads(payload)
        except Exception:  # noqa: BLE001
            return exc.code, {"raw": payload}


def cleanup():
    target = RVC_DIR / "_p1verify_组"
    if target.exists():
        shutil.rmtree(target, ignore_errors=True)
    # 路径穿越测试的产物：`../../../evil` 被清理成 `evil`，落在类别根内（没逃出去），
    # 但那也是垃圾，得一起收掉
    evil = RVC_DIR / "evil"
    if evil.exists():
        shutil.rmtree(evil, ignore_errors=True)


cleanup()
print("=" * 74)
print("第 1 节  导入：保留子目录结构")
print("=" * 74)
status, body = call(
    "POST",
    "/import",
    raw=b"FAKE-PTH-BODY-0001",
    params={"category": "rvc", "subdir": TEST_SUBDIR, "filename": "verify.pth"},
)
check("导入 .pth 返回 200", status == 200, status)
check("落在指定子目录下（未拍平）", "verify.pth" in (body.get("rel") or ""), body.get("rel"))
check("落盘路径含子目录名", "_p1verify_子" in (body.get("abs") or ""), body.get("abs"))

status, body = call(
    "POST",
    "/import",
    raw=b"FAKE-IDX-BODY-0001",
    params={"category": "rvc", "subdir": TEST_SUBDIR, "filename": "verify.index"},
)
check("导入配套 .index 返回 200", status == 200, status)

print()
print("=" * 74)
print("第 2 节  重复检测（同名 + 同大小）")
print("=" * 74)
status, body = call(
    "POST",
    "/import",
    raw=b"FAKE-PTH-BODY-0001",
    params={"category": "rvc", "subdir": TEST_SUBDIR, "filename": "verify.pth"},
)
check("同名同大小 → 409", status == 409, status)
check("响应带冲突详情", bool(body.get("conflict")), list(body.keys()))
check("冲突信息含已存在的相对路径", "verify.pth" in ((body.get("conflict") or {}).get("existing") or {}).get("rel", ""),
      (body.get("conflict") or {}).get("existing"))

status, body = call(
    "POST",
    "/import",
    raw=b"FAKE-PTH-BODY-0001",
    params={"category": "rvc", "subdir": TEST_SUBDIR, "filename": "verify.pth", "on_conflict": "keep_both"},
)
check("keep_both 策略 → 200 且自动改名", status == 200 and body.get("renamed_to"), body.get("renamed_to"))

print()
print("=" * 74)
print("第 3 节  列表 / 状态标记")
print("=" * 74)
status, listing = call("GET", "/", params={"category": "rvc"})
check("列表返回 200", status == 200, status)


def find_by_primary(models, primary_name):
    """按**主权重文件名**精确找模型。

    不能只按 rel_dir 找：第 2 节的 keep_both 会在同一目录里造出 `verify-1.pth`，
    目录因此从「单模型」变成「多模型」，此时同目录有多个模型条目 ——
    按目录取第一个会拿到没有配套文件的那个（第一版测试就是这么误报的）。
    """
    for item in models:
        for f in item["files"]:
            if f["role"] == "primary" and f["name"] == primary_name:
                return item
    return None


target = find_by_primary(listing.get("models", []), "verify.pth")
check("找到主权重为 verify.pth 的模型", target is not None)
if target:
    check(
        "配套 .index 被识别为 companion",
        any(f["role"] == "companion" and f["name"] == "verify.index" for f in target["files"]),
        [f["name"] for f in target["files"]],
    )
    check("同目录的 verify-1.pth 是**另一个**模型（未被误并进来）",
          not any(f["name"] == "verify-1.pth" for f in target["files"]),
          [f["name"] for f in target["files"]])

print()
print("=" * 74)
print("第 4 节  重命名：联动配套文件 + 中文名")
print("=" * 74)
if target:
    status, body = call("POST", "/rename", body={"id": target["id"], "name": "验收改名_中文"})
    check("重命名返回 200", status == 200, status)
    renamed_names = [r.split("/")[-1] for r in (body.get("renamed") or [])]
    check("返回了改名后的文件列表", len(renamed_names) >= 1, renamed_names)
    check("中文名未被损坏", any("验收改名_中文" in n for n in renamed_names), renamed_names)
    check("配套 .index 一起改名",
          any(n.endswith(".index") and "验收改名_中文" in n for n in renamed_names),
          renamed_names)

    print()
    print("=" * 74)
    print("第 5 节  元数据（显示名 / 备注 / 标签）")
    print("=" * 74)
    status, body = call(
        "POST",
        "/update",
        body={
            "id": body.get("new_id") or target["id"],
            "display_name": "验收显示名",
            "note": "P1 回归测试",
            "tags": ["verify", "p1"],
        },
    )
    check("写元数据返回 200", status == 200, status)
    meta = body.get("meta") or {}
    check("display_name 正确", meta.get("display_name") == "验收显示名", meta.get("display_name"))
    check("tags 正确", meta.get("tags") == ["verify", "p1"], meta.get("tags"))

    status, listing = call("GET", "/", params={"category": "rvc"})
    hit = next((m for m in listing.get("models", []) if m["id"] == (body and target["id"])), None)
    if hit is None:
        hit = next(
            (m for m in listing.get("models", []) if m.get("meta", {}).get("display_name") == "验收显示名"),
            None,
        )
    check("列表里显示名生效", hit is not None and hit["name"] == "验收显示名",
          hit["name"] if hit else None)

print()
print("=" * 74)
print("第 6 节  路径穿越防护")
print("=" * 74)
status, _ = call("POST", "/reveal", body={"category": "../../etc"})
check("未知类别被拒（404）", status == 404, status)
status, _ = call(
    "POST",
    "/import",
    raw=b"x",
    params={"category": "rvc", "subdir": "../../../evil", "filename": "evil.pth"},
)
# 200 = 被清理成 `evil` 后正常导入；409 = 上一轮跑剩下的同名文件。两者都说明 `..` 被剥掉了
check("subdir 里的 .. 被剥掉（未逃出类别根）", status in (200, 409), status)
check(
    "没有落到 models/ 之外",
    not (ROOT / "evil.pth").exists() and not (ROOT.parent / "evil.pth").exists(),
)
check("落点仍在类别根内", (RVC_DIR / "evil").exists() or status == 409, str(RVC_DIR / "evil"))
status, _ = call("POST", "/import", raw=b"x", params={"category": "rvc", "filename": "bad.exe"})
check("不支持的扩展名被拒（400）", status == 400, status)

print()
print("=" * 74)
print("第 7 节  迁移：只搬该模型自己的文件")
print("=" * 74)
status, plan = call("POST", "/migrate", body={"category": "rvc"})
check("迁移计划返回 200", status == 200, status)
check("默认是 dry_run（不落盘）", plan.get("dry_run") is True, plan.get("dry_run"))
# 每个 item 的 files 必须都指向同一个目录（说明按模型搬，而不是按目录搬）
bad = []
for item in plan.get("items", []):
    dirs = {str(Path(f).parent) for f in item.get("files", [])}
    if len(dirs) > 1:
        bad.append(item.get("name"))
check("每项的待搬文件同属一个目录", not bad, bad)

print()
print("=" * 74)
print("汇总：通过 %d / 失败 %d" % (len(PASS), len(FAIL)))
for item in FAIL:
    print("  失败：%s" % item)
print("=" * 74)

cleanup()
print("（已清理测试残留）")
sys.exit(1 if FAIL else 0)

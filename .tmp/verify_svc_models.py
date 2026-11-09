"""验证 DDSP-SVC 音色库的「导入 / 删除」闭环（本轮新增的前端入口靠它撑起来）。

覆盖：
1. `GET /v1/svc/catalog`            —— 能看到既有音色与搜索目录
2. `POST /v1/svc/models/upload`     —— .pt + config.yaml 成对导入成功
3. 导入后 catalog 里出现该音色且 available=True
4. `DELETE /v1/svc/models`          —— 删除该音色（.pt 与 config.yaml 一起消失）
5. 删除**不在音色库目录内**的模型被拒绝（防止误删用户别处的文件）

前置：服务已在 127.0.0.1:19881 跑起来；本机系统代理会拦 127.0.0.1，先清代理变量。
"""

from __future__ import annotations

import io
import json
import os
import sys
import urllib.request
import uuid
from pathlib import Path

for key in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"):
    os.environ.pop(key, None)

BASE = "http://127.0.0.1:19881"
ROOT = Path(__file__).resolve().parents[1]
SMOKE = ROOT / "trainer" / ".data" / "svc" / "models" / "smoke"

passed = 0
failed = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global passed, failed
    if ok:
        passed += 1
        print("  [PASS] %s" % name)
    else:
        failed += 1
        print("  [FAIL] %s %s" % (name, detail))


def request(method: str, path: str, data: bytes | None = None, headers: dict | None = None):
    req = urllib.request.Request(BASE + path, data=data, method=method, headers=headers or {})
    with urllib.request.urlopen(req, timeout=120) as resp:
        return resp.status, json.loads(resp.read().decode("utf-8"))


def multipart(fields: dict[str, tuple[str, bytes]], files: dict[str, tuple[str, bytes, str]]) -> bytes:
    boundary = "----wb" + uuid.uuid4().hex
    body = io.BytesIO()
    for key, value in fields.items():
        body.write(("--%s\r\n" % boundary).encode())
        body.write(('Content-Disposition: form-data; name="%s"\r\n\r\n' % key).encode())
        body.write(value.encode() + b"\r\n")
    for key, (filename, content, ctype) in files.items():
        body.write(("--%s\r\n" % boundary).encode())
        body.write(
            ('Content-Disposition: form-data; name="%s"; filename="%s"\r\n' % (key, filename)).encode()
        )
        body.write(("Content-Type: %s\r\n\r\n" % ctype).encode())
        body.write(content + b"\r\n")
    body.write(("--%s--\r\n" % boundary).encode())
    return body.getvalue(), ("multipart/form-data; boundary=%s" % boundary)


print("== 0. 前置检查 ==")
check("smoke 模型齐全（.pt + config.yaml）", (SMOKE / "model.pt").is_file() and (SMOKE / "config.yaml").is_file())

print("== 1. GET /v1/svc/catalog ==")
status, catalog = request("GET", "/v1/svc/catalog")
check("HTTP 200", status == 200, str(status))
dirs = catalog.get("model_dirs") or []
check("返回 model_dirs（>=2 个搜索目录）", len(dirs) >= 2, str(dirs))
smoke_entry = next((m for m in catalog.get("models", []) if m.get("id") == "smoke"), None)
check("能看到既有的 smoke 音色", smoke_entry is not None)
if smoke_entry:
    check("smoke available=True（有 config.yaml）", smoke_entry.get("available") is True)
    check("smoke 解析出采样率 44100", smoke_entry.get("sample_rate") == 44100, str(smoke_entry.get("sample_rate")))
    check("smoke 解析出编码器", smoke_entry.get("encoder") == "contentvec768l12tta2x", str(smoke_entry.get("encoder")))
    check("smoke 带绝对 path", bool(smoke_entry.get("path")), str(smoke_entry.get("path")))

print("== 2. POST /v1/svc/models/upload（.pt + config.yaml）==")
label = "verify_%s" % uuid.uuid4().hex[:6]
weight_bytes = (SMOKE / "model.pt").read_bytes()
config_bytes = (SMOKE / "config.yaml").read_bytes()
payload, ctype = multipart(
    {"name": label},
    {
        "model": ("%s.pt" % label, weight_bytes, "application/octet-stream"),
        "config": ("config.yaml", config_bytes, "text/yaml"),
    },
)
status, uploaded = request("POST", "/v1/svc/models/upload", payload, {"Content-Type": ctype})
check("HTTP 200", status == 200, str(status))
check("ok=True", uploaded.get("ok") is True)
check("has_config=True", uploaded.get("has_config") is True, str(uploaded))
check("落盘路径存在", Path(uploaded.get("path", "")).is_file(), str(uploaded.get("path")))
check("落盘目录含 config.yaml", (Path(uploaded.get("path", "")).parent / "config.yaml").is_file())

print("== 3. 导入后 catalog 可见 ==")
_, catalog2 = request("GET", "/v1/svc/catalog")
entry = next((m for m in catalog2.get("models", []) if m.get("id") == label), None)
check("新音色出现在 catalog", entry is not None)
if entry:
    check("新音色 available=True", entry.get("available") is True, str(entry))
    check("新音色 name 用了目录名", entry.get("name") == label, str(entry.get("name")))

print("== 4. DELETE /v1/svc/models ==")
status, deleted = request("DELETE", "/v1/svc/models?model=%s" % label)
check("HTTP 200", status == 200, str(status))
check("ok=True", deleted.get("ok") is True, str(deleted))
removed = deleted.get("removed") or []
check("removed 里有 .pt", any(str(p).endswith(".pt") for p in removed), str(removed))
check("removed 里有 config.yaml", any(str(p).endswith("config.yaml") for p in removed), str(removed))
_, catalog3 = request("GET", "/v1/svc/catalog")
check("删除后 catalog 里不再有它", all(m.get("id") != label for m in catalog3.get("models", [])))

print("== 5. 越界删除被拒绝 ==")
# 造一个真实存在、但不在音色库目录内的 .pt，验证边界检查而不是「找不到」
outside_dir = ROOT / ".tmp" / "outside_model"
outside_dir.mkdir(parents=True, exist_ok=True)
outside = outside_dir / "outsider.pt"
outside.write_bytes(b"not a real model")
status, refused = request("DELETE", "/v1/svc/models?model=%s" % outside)
check("HTTP 200（软失败）", status == 200, str(status))
check("ok=False", refused.get("ok") is False, str(refused))
check("给出拒绝理由（音色库目录）", "音色库目录" in (refused.get("message") or ""), str(refused))
check("越界文件仍在（未被误删）", outside.is_file())
outside.unlink(missing_ok=True)

print()
print("结果：%d 通过 / %d 失败" % (passed, failed))
sys.exit(0 if failed == 0 else 1)

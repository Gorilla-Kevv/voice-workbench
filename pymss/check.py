"""PyMSS 就绪检查：在 pymss/.venv 里运行，缺什么给什么修复命令。

用法：
  pymss/.venv/Scripts/python.exe pymss/check.py
  pymss/.venv/Scripts/python.exe pymss/check.py --json
"""

from __future__ import annotations

import argparse
import importlib.metadata as metadata
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
MANIFEST = ROOT / "weights.manifest.json"
DEFAULT_MODEL_DIR = Path(os.environ.get("PYMSS_MODEL_DIR") or (ROOT / "models"))


def _version(package: str) -> str | None:
    try:
        return metadata.version(package)
    except metadata.PackageNotFoundError:
        return None


def _manifest_models() -> list[dict]:
    if not MANIFEST.is_file():
        return []
    try:
        data = json.loads(MANIFEST.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    return list(data.get("models") or [])


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    checks: list[dict] = []

    def add(name: str, ok: bool, detail: str, hint: str = "") -> None:
        checks.append({"name": name, "ok": ok, "detail": detail, "hint": hint})

    py_ok = sys.version_info[:2] >= (3, 12)
    add("python", py_ok, sys.version.split()[0], "PyMSS 需要 Python 3.12（uv venv pymss/.venv --python 3.12）")

    pymss = _version("pymss")
    core = _version("pymss-core")
    add("pymss", pymss == "2.0.14", pymss or "未安装", "pymss/.venv/Scripts/python.exe -m pip install pymss==2.0.14 pymss-core==0.1.4")
    add("pymss-core", core == "0.1.4", core or "未安装", "同上")

    try:
        import torch  # noqa: PLC0415

        torch_version = torch.__version__
        cuda_ok = bool(torch.cuda.is_available())
        add("torch", cuda_ok, f"{torch_version} / CUDA={cuda_ok}", "安装 cu128 wheel；CPU 版只能排障，不能做 P0 A/B")
    except Exception as exc:  # noqa: BLE001
        add("torch", False, f"{type(exc).__name__}: {exc}", "在 pymss/.venv 里安装 torch")

    model_dir = DEFAULT_MODEL_DIR
    add("model_dir", model_dir.is_dir(), str(model_dir), "创建 pymss/models 或设置 PYMSS_MODEL_DIR")

    models = _manifest_models()
    if models:
        for item in models:
            name = str(item.get("name") or "")
            if not name:
                continue
            candidates = list(model_dir.rglob(name))
            add(f"model:{name}", bool(candidates), str(candidates[0]) if candidates else "缺失", "pymss.exe download %s --model-dir pymss/models" % name)
    else:
        files = list(model_dir.rglob("*.pth")) + list(model_dir.rglob("*.ckpt"))
        add("models", bool(files), f"{len(files)} 个权重文件（无 manifest，仅计数）", "补齐 pymss/weights.manifest.json")

    failed = [item for item in checks if not item["ok"]]
    if args.json:
        print(json.dumps({"ok": not failed, "checks": checks}, ensure_ascii=False, indent=2))
    else:
        for item in checks:
            print(("OK   " if item["ok"] else "FAIL ") + item["name"] + ": " + item["detail"])
            if not item["ok"] and item["hint"]:
                print("     -> " + item["hint"])
        print("\n%s" % ("READY" if not failed else "NOT READY (%d 项失败)" % len(failed)))
    return 0 if not failed else 1


if __name__ == "__main__":
    raise SystemExit(main())

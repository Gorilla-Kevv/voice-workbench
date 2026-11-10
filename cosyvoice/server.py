"""CosyVoice3 本地服务入口（:9886）。

    python server.py                # 启动服务（默认 127.0.0.1:9886）
    python server.py --check        # 只做环境体检，不启动服务
    python server.py --check --json # 体检结果以 JSON 输出
    python server.py --port 9886

没有解释器自举：本服务跑在独立 venv（py3.10 + torch 2.3.1+cu121），
解释器不对就该立刻说清楚，而不是悄悄换一个继续跑（与 netease/irodori 同一理由）。
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

# WDDM 下把显存分配改成可扩展段，缓解 torch.load / 模型加载的大块分配碎片。
# 必须在 import torch 之前设置；engine 里是 lazy import，这里启动最早。
os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")

COSYVOICE_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(COSYVOICE_DIR))

# Windows 控制台默认 GBK，--check 的 ✓/✗ 会直接 UnicodeEncodeError；
# 启动器虽然设了 PYTHONIOENCODING，但用户手动 python server.py 时也要能跑。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # pragma: no cover - 非交互流
        pass

BANNER = """
  ============================================
   CosyVoice3 · 方言/多语种 TTS 本地服务（:9886）
  ============================================
"""


def parse_args(argv=None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="cosyvoice", description="CosyVoice3 本地语音服务")
    parser.add_argument("--check", action="store_true", help="只做环境体检，不启动服务")
    parser.add_argument("--json", action="store_true", help="体检结果以 JSON 输出（配合 --check）")
    parser.add_argument(
        "--skip-import",
        action="store_true",
        help="体检时跳过「导入冒烟」（默认会真 import 上游模块，约 8~12 秒）",
    )
    parser.add_argument("--port", type=int, default=None, help="监听端口（默认 COSYVOICE_PORT 或 9886）")
    parser.add_argument("--host", type=str, default=None, help="监听地址（默认 COSYVOICE_HOST 或 127.0.0.1）")
    return parser.parse_args(argv)


#: 只在 Linux 训练侧出现的依赖：缺它们不影响推理，导入冒烟里按「警告」处理而不是阻塞。
_LINUX_ONLY_IMPORTS = ("deepspeed", "vllm", "tensorrt")

#: 导入冒烟的脚本：把上游与 Matcha 挂进 sys.path（与 engine.ensure_upstream_on_path 同口径），
#: 然后**把上游 `cosyvoice.**` 全部 import 一遍**。为什么要全量：推理的 import 链很长
#: （cli.cosyvoice → flow.flow_matching → matcha.utils → lightning/rich/gdown/wget，
#: 以及 dataset.processor → pyarrow），只验「权重在不在」会把缺依赖留到 warmup 才炸
#: （2026-11-10 真机踩过：load 报 ENGINE_LOAD_FAILED: No module named 'lightning'）。
_IMPORT_PROBE = r"""
import importlib, os, sys
from pathlib import Path
up = Path(sys.argv[1])
sys.path.insert(0, str(up))
sys.path.insert(0, str(up / "third_party" / "Matcha-TTS"))
os.chdir(up)
mods = []
for path in (up / "cosyvoice").rglob("*.py"):
    parts = list(path.relative_to(up).with_suffix("").parts)
    if parts[-1] == "__init__":
        parts = parts[:-1]
    if parts:
        mods.append(".".join(parts))
failures = {}
for name in sorted(set(mods)):
    try:
        importlib.import_module(name)
    except Exception as error:
        failures.setdefault("%s: %s" % (type(error).__name__, error), []).append(name)
print("MODULES", len(set(mods)))
for key, names in failures.items():
    print("FAIL", key)
    print("AFFECTED", ",".join(names[:8]))
"""


def import_probe(settings) -> dict:
    """真 import 一遍上游模块，返回 {ok, modules, failures:[{error, affected}]}。

    子进程执行：既隔离 torch 初始化，也避免把半失败的模块留在当前进程里。
    """
    upstream = settings.upstream_dir
    if not upstream.is_dir():
        return {"ok": False, "skipped": True, "reason": "上游代码缺失", "modules": 0, "failures": []}
    try:
        proc = subprocess.run(  # noqa: S603 - 参数来自本文件常量与配置路径
            [sys.executable, "-c", _IMPORT_PROBE, str(upstream)],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=300,
        )
    except subprocess.TimeoutExpired:
        return {"ok": False, "modules": 0, "failures": [{"error": "导入冒烟超时（300s）", "affected": []}]}

    modules = 0
    failures: list[dict] = []
    pending: dict | None = None
    for line in (proc.stdout or "").splitlines():
        if line.startswith("MODULES "):
            modules = int(line.split()[1])
        elif line.startswith("FAIL "):
            pending = {"error": line[5:].strip(), "affected": []}
            failures.append(pending)
        elif line.startswith("AFFECTED ") and pending is not None:
            pending["affected"] = [item for item in line[9:].split(",") if item]
    if not failures and proc.returncode != 0:
        tail = (proc.stderr or "").strip().splitlines()[-3:]
        failures.append({"error": "探针进程异常退出：%s" % " / ".join(tail), "affected": []})

    blocking = [item for item in failures if not any(token in item["error"] for token in _LINUX_ONLY_IMPORTS)]
    warnings = [item for item in failures if any(token in item["error"] for token in _LINUX_ONLY_IMPORTS)]
    return {
        "ok": not blocking,
        "modules": modules,
        "failures": blocking,
        "warnings": warnings,
        "skipped": False,
    }


def run_check(as_json: bool, skip_import: bool = False) -> int:
    from app import __version__
    from app.config import REQUIRED_VRAM_MB, Settings, load_manifest
    from app.hardware import compute_capability, device_name, probe, vram_mb
    from app.inventory import describe_missing, group_report, resolve_weights_manifest_path, scan

    settings = Settings.from_env()
    info = probe()
    inventory = scan(settings)
    vram = vram_mb()
    capability = compute_capability()
    manifest = load_manifest()

    blockers: list[str] = []
    if not info["torch"]:
        blockers.append(f"torch 不可用：{info['error'] or '未安装'}（本服务要求 torch 2.3.1+cu121）")
    elif not info["cuda"] and not settings.allow_cpu:
        blockers.append("torch 没有 CUDA。请装 cu121 版 torch（CPU 推理 RTF 约 2.5，等于不可用）。")
    if not settings.upstream_dir.is_dir() and not inventory["missing_code"]:
        blockers.append(f"未找到上游代码：{settings.upstream_dir}")

    imports = {"ok": True, "skipped": True, "modules": 0, "failures": [], "warnings": []}
    if not skip_import:
        imports = import_probe(settings)
        for failure in imports["failures"]:
            affected = "、".join(failure.get("affected") or []) or "（未知模块）"
            blockers.append(f"导入期缺依赖：{failure['error']}（影响 {affected}）")

    report = {
        "version": __version__,
        "python": sys.version.split()[0],
        "python_ok": sys.version_info[:2] == (3, 10),
        "torch": info["torch"],
        "cuda": info["cuda"],
        "device": info["device"],
        "gpu_name": device_name(),
        "compute_capability": capability,
        "vram": vram,
        "required_vram_mb": REQUIRED_VRAM_MB,
        "manifest_path": str(resolve_weights_manifest_path() or "(未找到 weights.manifest.json)"),
        "manifest_entries": len(manifest.get("entries") or []),
        "weights": {
            "ready": inventory["inference_ready"],
            "groups": group_report(inventory),
            "files": inventory["files"],
            "code": inventory["code"],
            "missing_text": describe_missing(inventory),
        },
        "imports": imports,
        "port": settings.port,
        "configuration": settings.as_dict(),
        "blockers": blockers,
    }

    if as_json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        _print_human(report, settings, inventory)
    return 1 if blockers else 0


def _print_human(report: dict, settings, inventory: dict) -> None:
    ok = lambda flag: "✓" if flag else "✗"  # noqa: E731

    print(BANNER)
    print(f"  Python     : {report['python']}  {ok(report['python_ok'])} 需要 3.10")
    print(f"  torch      : {report['torch']}")
    print(f"  CUDA       : {report['cuda']}  {report['gpu_name'] or '(无 CUDA)'}")
    print(f"  端口       : {settings.port}")
    if report["vram"]:
        vram = report["vram"]
        print(
            f"  显存       : 空闲 {vram['free_mb']} / 共 {vram['total_mb']} MB"
            f"（{vram['source']}；准入需 {report['required_vram_mb']} MB）"
        )
    print(f"  清单       : {report['manifest_path']}（{report['manifest_entries']} 条）")
    imports = report.get("imports") or {}
    if imports.get("skipped"):
        print("  导入冒烟   : 已跳过（--skip-import）")
    elif imports.get("ok"):
        print(f"  导入冒烟   : ✓ 上游 {imports.get('modules', 0)} 个模块全部可 import")
    else:
        print(f"  导入冒烟   : ✗ {len(imports.get('failures') or [])} 处失败")
        for failure in imports.get("failures") or []:
            mark = "、".join(failure.get("affected") or []) or "（未知模块）"
            print(f"      - {failure['error']}（影响 {mark}）")
    for warning in imports.get("warnings") or []:
        print(f"      ! 忽略（Linux-only）：{warning['error']}")

    print("\n  权重：")
    for group in report["weights"]["groups"]:
        print(f"    [{ok(group['ready'])}] {group['label']}  {group['have_mb']} / {group['need_mb']} MB")
    for item in inventory["files"]:
        mark = "✓" if item["ok"] else ("!" if item["exists"] else "·")
        req = "必需" if item["required"] else "可选"
        print(f"      {mark} [{req}] {item['target']}  —— {item['note']}")
    for item in inventory["code"]:
        print(f"      {'✓' if item['exists'] else '·'} [代码] {item['target']}  —— {item['note']}")

    if report["blockers"]:
        print("\n  [x] 无法启动：")
        for item in report["blockers"]:
            print(f"      - {item}")
        print("\n  下一步：阅读 cosyvoice/README.md 建 venv 并安装依赖，然后重跑 --check。")
    elif not inventory["inference_ready"]:
        print("\n  [!] 环境就绪，但推理权重未齐 —— 服务可以起来并如实报告「待补齐」。")
        print("      补齐：npm run cosyvoice:weights")
    else:
        print("\n  [✓] 环境与权重就绪，可以启动：python server.py（或 npm run dev:cosyvoice）")
    print()


def main(argv=None) -> int:
    args = parse_args(argv)
    if args.check:
        return run_check(as_json=args.json, skip_import=args.skip_import)

    from app.api import create_app
    from app.config import Settings

    settings = Settings.from_env()
    port = args.port or settings.port
    host = args.host or settings.host

    import uvicorn

    print(BANNER)
    uvicorn.run(create_app(settings), host=host, port=port, log_level="info")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

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
    parser.add_argument("--port", type=int, default=None, help="监听端口（默认 COSYVOICE_PORT 或 9886）")
    parser.add_argument("--host", type=str, default=None, help="监听地址（默认 COSYVOICE_HOST 或 127.0.0.1）")
    return parser.parse_args(argv)


def run_check(as_json: bool) -> int:
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
        return run_check(as_json=args.json)

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

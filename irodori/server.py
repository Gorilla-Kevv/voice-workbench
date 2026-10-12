"""Irodori-TTS 本地服务入口（日语特化 TTS）。

    python server.py                # 启动服务（默认 127.0.0.1:9884）
    python server.py --check        # 只做环境体检，不启动服务
    python server.py --check --json # 体检结果以 JSON 输出
    python server.py --port 9884

**没有解释器自举**（trainer/server.py 有）——这是刻意的，与 `netease/server.py` 同一理由：
本服务跑在独立 venv（py3.12 + torch 2.10+cu128）里，项目里不存在「可以自动找到的替代解释器」；
解释器不对就该立刻说清楚，而不是悄悄换一个继续跑。

体检与 /health 共用 `app/inventory.py` 的同一套清单核对逻辑，
所以「--check 说齐了」与「/health 说 ready」永远一致（不会出现两套事实源）。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

IRODORI_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(IRODORI_DIR))

#: 刻意不用 ASCII art：反斜杠在 Windows 终端里既难转义又容易显示错位，
#: 服务名的辨识度靠这行中文就够了。
BANNER = """
  ============================================
   Irodori-TTS · 日语特化本地服务（:9884）
  ============================================
"""


def parse_args(argv=None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="irodori", description="Irodori-TTS 本地语音服务")
    parser.add_argument("--check", action="store_true", help="只做环境体检，不启动服务")
    parser.add_argument("--json", action="store_true", help="体检结果以 JSON 输出（配合 --check）")
    parser.add_argument("--port", type=int, default=None, help="监听端口（默认 IRODORI_PORT 或 9884）")
    parser.add_argument("--host", type=str, default=None, help="监听地址（默认 IRODORI_HOST 或 127.0.0.1）")
    return parser.parse_args(argv)


def run_check(as_json: bool) -> int:
    """体检：解释器 / torch / CUDA / 垫片 / 权重 / 上游代码 / 端口。退出码 0 = 可以启动服务。"""
    from app import __version__, windecode
    from app.config import Settings, load_manifest, required_vram_mb
    from app.hardware import compute_capability, device_name, probe, vram_mb
    from app.inventory import describe_missing, group_report, resolve_weights_manifest_path, scan

    settings = Settings.from_env()
    info = probe()
    shim = windecode.install()
    inventory = scan(settings)
    vram = vram_mb()
    capability = compute_capability()
    manifest = load_manifest()

    blockers: list[str] = []
    if not info["torch"]:
        blockers.append(f"torch 不可用：{info['error'] or '未安装'}（本服务要求 torch 2.10+cu128）")
    elif not info["cuda"] and not settings.allow_cpu:
        blockers.append("torch 没有 CUDA。请装 cu128 版 torch（CPU 推理 RTF 是几十倍，等于不可用）。")
    if not settings.upstream_dir.is_dir() and not inventory["missing_code"]:
        blockers.append(f"未找到上游代码：{settings.upstream_dir}")

    report = {
        "version": __version__,
        "python": sys.version.split()[0],
        "python_ok": sys.version_info >= (3, 12),
        "torch": info["torch"],
        "cuda": info["cuda"],
        "device": info["device"],
        "gpu_name": device_name(),
        "compute_capability": capability,
        "int4_supported": None if capability is None else capability[0] >= 8,
        "vram": vram,
        "required_vram_mb": required_vram_mb(settings.precision),
        "windecode": shim,
        "manifest_path": str(resolve_weights_manifest_path() or "(未找到 weights.manifest.json)"),
        "manifest_entries": len(manifest.get("entries") or []),
        "weights": {
            "ready": inventory["inference_ready"],
            "training_ready": inventory["training_ready"],
            "groups": group_report(inventory),
            "files": inventory["files"],
            "code": inventory["code"],
            "missing_text": describe_missing(inventory),
        },
        "port": settings.port,
        "configuration": settings.as_dict(),
        "blockers": blockers,
    }

    # 权重缺失**不算阻断项**：服务要能起来并如实报告（前端据此显示「待补齐」），
    # 只有「解释器/torch 不对」才是真的起不来。
    if as_json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        _print_human(report, settings, inventory)
    return 1 if blockers else 0


def _print_human(report: dict, settings, inventory: dict) -> None:
    ok = lambda flag: "✓" if flag else "✗"  # noqa: E731 - 打印专用的小工具

    print(BANNER)
    print(f"  Python     : {report['python']}  {ok(report['python_ok'])} 需要 ≥ 3.12")
    print(f"  torch      : {report['torch']}")
    print(f"  CUDA       : {report['cuda']}  {report['gpu_name'] or '(无 CUDA)'}")
    cap = report["compute_capability"]
    if cap:
        note = "int4 可用" if report["int4_supported"] else "int4 不可用（cc < 8.0）→ 需回落 int8/bf16"
        print(f"  compute cap: {cap[0]}.{cap[1]}  （{note}）")
    print(f"  端口       : {settings.port}")
    print(f"  精度/步数  : {settings.precision} / 默认 {settings.default_steps} 步（档位 {list(settings.step_presets)}）")
    if report["vram"]:
        vram = report["vram"]
        print(
            f"  显存       : 空闲 {vram['free_mb']} / 共 {vram['total_mb']} MB"
            f"（{vram['source']}；准入需 {report['required_vram_mb']} MB）"
        )
    print(f"  垫片       : {'已装 ' + str(report['windecode']['patched']) if report['windecode']['installed'] else '未装'}"
          f"  —— {report['windecode']['reason']}")
    print(f"  清单       : {report['manifest_path']}（{report['manifest_entries']} 条）")

    print("\n  权重：")
    for group in report["weights"]["groups"]:
        flag = ok(group["ready"])
        print(f"    [{flag}] {group['label']}  {group['have_mb']} / {group['need_mb']} MB")
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
        print("\n  下一步：阅读 irodori/README.md 建 venv 并安装依赖，然后重跑 --check。")
    elif not inventory["inference_ready"]:
        print("\n  [!] 环境就绪，但推理权重未齐 —— 服务可以起来并如实报告「待补齐」。")
        print("      补齐：npm run irodori:weights")
    else:
        print("\n  [✓] 环境与权重就绪，可以启动：python server.py（或 npm run dev:irodori）")
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

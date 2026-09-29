"""网易模块本地服务入口（Confucius4-TTS + Confucius4-R2T2）。

    python server.py                # 启动服务（默认 127.0.0.1:9882）
    python server.py --check        # 只做环境体检，不启动服务
    python server.py --check --json # 体检结果以 JSON 输出
    python server.py --port 9882

**没有解释器自举**（trainer/server.py 有）——这是刻意的：
本服务运行在一个独立的 venv 里（py≥3.10 / torch≥2.5 / cu≥12.6），
项目里不存在「可以自动找到的替代解释器」；解释器不对就应该立刻说清楚，
而不是悄悄换一个继续跑。`npm run netease:check` 与本文档的 --check
都做同一件事：逐项报告缺什么、去哪装。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

NETEASE_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(NETEASE_DIR))

BANNER = r"""
  _   _ _____ _   _ _____ ______ _____
 | \ | | ____| \ | |_   _|  ____| ____|
 |  \| |  _| |  \| | | | | |__ | |___
 | |\  | |___| |\  | | | |  __|| |___
 |_| \_|_____|_| \_| |_| |_|   |_____|
  Confucius4-TTS + R2T2 · 网易模块本地服务
"""


def parse_args(argv=None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="netease", description="网易模块本地语音服务")
    parser.add_argument("--check", action="store_true", help="只做环境体检，不启动服务")
    parser.add_argument("--json", action="store_true", help="体检结果以 JSON 输出（配合 --check）")
    parser.add_argument("--port", type=int, default=None, help="监听端口（默认 NETEASE_PORT 或 9882）")
    parser.add_argument("--host", type=str, default=None, help="监听地址（默认 NETEASE_HOST 或 127.0.0.1）")
    return parser.parse_args(argv)


def run_check(as_json: bool) -> int:
    """体检：解释器 / torch / CUDA / 依赖 / 权重 / 端口。退出码 0 = 可以启动服务。"""
    from app import __version__
    from app.config import Settings
    from app.r2t2 import R2T2Manager
    from app.tts_engine import TtsPipeline

    settings = Settings.from_env()
    tts = TtsPipeline(settings)
    asr = R2T2Manager(settings)

    try:
        import torch  # noqa: F401

        torch_ok, torch_note = True, torch.__version__
    except Exception as error:
        torch_ok, torch_note = False, f"{type(error).__name__}: {error}"

    blockers: list[str] = []
    if not torch_ok:
        blockers.append(f"torch 不可用：{torch_note}（本服务要求 torch ≥ 2.5 + CUDA ≥ 12.6）")
    else:
        import torch

        if not torch.cuda.is_available() and not settings.allow_cpu:
            blockers.append("torch 没有 CUDA。请安装 cu126 及以上的 CUDA 版 torch（不要用 CPU 版）。")

    tts_install = tts.probe_install()
    asr_install = asr.probe_install()

    report = {
        "version": __version__,
        "python": sys.version.split()[0],
        "python_ok": sys.version_info >= (3, 10),
        "torch": torch_note if not torch_ok else torch.__version__,
        "cuda_ok": torch_ok and bool(__import__("torch").cuda.is_available()),
        "device": settings.device,
        "tts": tts_install,
        "asr": asr_install,
        "port": settings.port,
        "blockers": blockers,
    }
    # 权重缺失不算阻断项：服务要能起来并如实报告（前端据此显示「待补齐」），
    # 但依赖缺失算 —— 那种情况下连 catalog 都答不完整。
    python_ok = report["python_ok"]

    if as_json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print(BANNER)
        print(f"  Python     : {report['python']}{'  ✓' if python_ok else '  ✗ 需要 ≥ 3.10'}")
        print(f"  torch/CUDA : {report['torch']}  cuda={report['cuda_ok']}")
        print(f"  端口       : {settings.port}")
        print(f"  TTS  仓库  : {tts_install['home']}")
        for item in tts_install["missing"]:
            print(f"    - 缺 {item}")
        if tts_install["package"].get("missing"):
            print(f"    - 依赖 {tts_install['package']['missing']}")
        else:
            print(f"    - confuciustts {tts_install['package'].get('version') or '可导入'}")
        for item in tts_install.get("weights_cached", []):
            print(f"    - 就位 {item}")
        if tts_install.get("download_hint"):
            print(f"    - 补齐：{tts_install['download_hint']}")
        print(f"  推理精度   : {settings.precision}（NETEASE_TTS_PRECISION 可改）")
        print(f"  ASR  模型  : {asr_install['model']}  (本地={asr_install['model_local']})")
        for item in asr_install["missing"]:
            print(f"    - {item}")
        if blockers:
            print("\n  [x] 无法启动：")
            for item in blockers:
                print(f"      - {item}")
            print("\n  下一步：阅读 netease/README.md 建 venv 并安装依赖，然后重跑 --check。")
        else:
            print("\n  [✓] 环境就绪，可以启动：python server.py")
        print()

    if not python_ok or not torch_ok:
        return 1
    return 0


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

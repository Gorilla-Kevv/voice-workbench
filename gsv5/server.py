"""GPT-SoVITS v5 本地服务入口。

    python server.py            # 启动（默认 127.0.0.1:9885）
    python server.py --check    # 只做体检
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
UPSTREAM = HERE / "upstream"

sys.path.insert(0, str(HERE / "app"))
sys.path.insert(0, str(UPSTREAM))
sys.path.insert(0, str(UPSTREAM / "GPT_SoVITS"))

from app.api import create_app
from app.config import Settings


def parse_args(argv=None):
    parser = argparse.ArgumentParser(prog="gsv5", description="GPT-SoVITS v5 本地语音服务")
    parser.add_argument("--check", action="store_true", help="只做体检，不启动服务")
    parser.add_argument("--port", type=int, default=None)
    parser.add_argument("--host", type=str, default=None)
    return parser.parse_args(argv)


def run_check() -> int:
    settings = Settings()
    print("=== GPT-SoVITS v5 环境体检 ===")
    print(f"解释器     : {sys.executable}")
    print(f"Python     : {sys.version.split()[0]}（需要 3.12）")
    print(f"上游目录   : {settings.upstream_dir}")
    print(f"端口       : {settings.port}")
    try:
        import torch

        print(f"torch      : {torch.__version__} cuda={torch.cuda.is_available()}")
    except Exception as error:
        print(f"torch      : 不可用（{error}）")
    ready = settings.weights_ready()
    print(f"权重就绪   : {ready}")
    ok = all(ready.values()) and sys.version_info[:2] == (3, 12)
    print("体检通过" if ok else "有未就绪项，见上")
    return 0 if ok else 1


def main(argv=None) -> int:
    args = parse_args(argv)
    if args.check:
        return run_check()
    import uvicorn

    settings = Settings()
    port = args.port or settings.port
    host = args.host or settings.host
    uvicorn.run(create_app(settings), host=host, port=port, log_level="info")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

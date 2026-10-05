"""IndexTTS 本地服务入口。

    python server.py            # 启动（默认 127.0.0.1:9883）
    python server.py --check    # 只做体检

**注意**：必须用 `indextts/upstream/.venv` 里的解释器运行（依赖都装在那里），
launcher 脚本 `scripts/indextts.mjs` 已经处理好了；手动跑请自己指对解释器。
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
UPSTREAM = HERE / 'upstream'
#: 上游包的安装位置在 site-packages，这里只要保证 cwd/uv 环境对即可；
#: 但 `import indextts` 与本目录同名，必须确保 sys.path 里**先**有 site-packages
#: （由解释器自己保证），并且**不要**把本目录插到最前面 —— 否则会 import 到空壳。
sys.path.insert(0, str(HERE / 'app'))

from app.api import create_app  # noqa: E402
from app.config import Settings  # noqa: E402


def parse_args(argv=None):
    parser = argparse.ArgumentParser(prog='indextts', description='IndexTTS 本地语音服务')
    parser.add_argument('--check', action='store_true', help='只做体检，不启动服务')
    parser.add_argument('--port', type=int, default=None)
    parser.add_argument('--host', type=str, default=None)
    return parser.parse_args(argv)


def run_check() -> int:
    settings = Settings.from_env()
    print('=== IndexTTS 环境体检 ===')
    print(f'解释器     : {sys.executable}')
    print(f'Python     : {sys.version.split()[0]}（需要 3.10~3.11）')
    print(f'权重目录   : {settings.model_dir}')
    print(f'推理配置   : {settings.cfg_path} {"✓" if settings.cfg_path.exists() else "✗ 缺失"}')
    print(f'端口       : {settings.port}')
    try:
        import torch  # noqa: PLC0415

        print(f'torch      : {torch.__version__} cuda={torch.cuda.is_available()}')
    except Exception as error:  # noqa: BLE001
        print(f'torch      : 不可用（{error}）')
    ok = settings.cfg_path.exists() and sys.version_info[:2] in {(3, 10), (3, 11)}
    print('体检通过' if ok else '有阻断项，见上')
    return 0 if ok else 1


def main(argv=None) -> int:
    args = parse_args(argv)
    if args.check:
        return run_check()
    import uvicorn  # noqa: PLC0415

    settings = Settings.from_env()
    port = args.port or settings.port
    host = args.host or settings.host
    uvicorn.run(create_app(settings), host=host, port=port, log_level='info')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

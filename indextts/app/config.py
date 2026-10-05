"""IndexTTS 服务配置。

与 `netease/app/config.py` 同构：环境变量 + 显式默认值，不做隐式推断。
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

INDEXTTS_DIR = Path(__file__).resolve().parent.parent
#: 上游仓库（uv 环境在它下面）
UPSTREAM_DIR = INDEXTTS_DIR / 'upstream'


def _env(name: str) -> str:
    return (os.environ.get(name) or '').strip()


@dataclass
class Settings:
    port: int = 9883
    host: str = '127.0.0.1'
    #: 上游仓库目录（`import indextts` 要从这里找）
    upstream_dir: Path = UPSTREAM_DIR
    #: 权重目录（含 config.yaml）
    model_dir: Path = UPSTREAM_DIR / 'checkpoints'
    #: 是否用 BF16（官方推荐：更快且省显存，质量损失极小）
    use_bf16: bool = True
    #: 编译 CUDA kernel（Windows 上常因缺编译环境失败，默认关）
    use_cuda_kernel: bool = False
    allow_cpu: bool = False

    @classmethod
    def from_env(cls) -> 'Settings':
        return cls(
            port=int(_env('INDEXTTS_PORT') or 9883),
            host=_env('INDEXTTS_HOST') or '127.0.0.1',
            upstream_dir=Path(_env('INDEXTTS_UPSTREAM') or UPSTREAM_DIR),
            model_dir=Path(_env('INDEXTTS_MODEL_DIR') or (UPSTREAM_DIR / 'checkpoints')),
            use_bf16=(_env('INDEXTTS_BF16') or '1').lower() in {'1', 'true', 'yes', 'on'},
            use_cuda_kernel=(_env('INDEXTTS_CUDA_KERNEL') or '0').lower() in {'1', 'true', 'yes', 'on'},
            allow_cpu=(_env('INDEXTTS_ALLOW_CPU') or '0').lower() in {'1', 'true', 'yes', 'on'},
        )

    @property
    def cfg_path(self) -> Path:
        """上游推理配置：权重目录里的 config.yaml"""
        return self.model_dir / 'config.yaml'

    @property
    def uploads_dir(self) -> Path:
        return INDEXTTS_DIR / '.data' / 'uploads'

"""硬件探测：显存读数。

口径与 `netease/app/hardware.py` 一致：**nvidia-smi 优先**（跨进程真实值）。
torch 的 `mem_get_info` 在 Windows WDDM 下只看得到本进程视图，会误判
（见 HANDOFF 坑 17）—— 用户明确要求显存管控必须准确，所以不能省这一步。
"""

from __future__ import annotations

import subprocess
from typing import Optional

_STATE: dict = {'checked': False, 'cuda': False, 'error': ''}


def probe() -> dict:
    if _STATE['checked']:
        return dict(_STATE)
    try:
        import torch  # noqa: PLC0415

        _STATE['cuda'] = bool(torch.cuda.is_available())
    except Exception as error:  # pragma: no cover - 环境相关
        _STATE['error'] = f'{type(error).__name__}: {error}'
    _STATE['checked'] = True
    return dict(_STATE)


def _nvidia_smi_mb() -> Optional[tuple[int, int]]:
    try:
        result = subprocess.run(
            ['nvidia-smi', '--query-gpu=memory.free,memory.total', '--format=csv,noheader,nounits'],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode != 0:
            return None
        first = result.stdout.strip().splitlines()[0]
        free, total = (int(float(part)) for part in first.split(',')[:2])
        return free, total
    except Exception:  # pragma: no cover - 没装驱动工具
        return None


def vram_mb() -> Optional[dict]:
    """当前显卡空闲 / 总量（MB）。无 CUDA 时返回 None。"""
    if not probe()['cuda']:
        return None

    torch_free: Optional[int] = None
    total: Optional[int] = None
    try:
        import torch  # noqa: PLC0415

        free_bytes, total_bytes = torch.cuda.mem_get_info(0)
        torch_free = int(free_bytes // (1024 * 1024))
        total = int(total_bytes // (1024 * 1024))
    except Exception:  # pragma: no cover
        pass

    smi = _nvidia_smi_mb()
    if smi is None:
        if torch_free is None or total is None:
            return None
        return {'free_mb': torch_free, 'total_mb': total, 'torch_free_mb': torch_free, 'source': 'torch'}
    free, smi_total = smi
    return {
        'free_mb': free,
        'total_mb': total or smi_total,
        'torch_free_mb': torch_free if torch_free is not None else free,
        'source': 'nvidia-smi',
    }

"""SoVITS 权重版本识别（不 import 官方模块）。

官方 `process_ckpt.get_sovits_version_from_path_fast` 的判据：
新权重在文件头 2 字节写版本码（00~06）；老权重是 zip（`PK`）时按文件大小猜。
这里只复刻这两条，供主进程列权重、worker 缺 GPT 时挑底模使用；
真正加载仍由官方函数决定（worker 里会再校验一次，见 TTS.init_vits_weights）。

官方映射（`GPT_SoVITS/process_ckpt.py`）：
    00 v1 / 01 v2 / 02 v3 / 03 v3-lora / 04 v4-lora / 05 v2Pro / 06 v2ProPlus
"""

from __future__ import annotations

from pathlib import Path
from typing import Optional

_HEAD_TO_VERSION = {
    b"00": "v1",
    b"01": "v2",
    b"02": "v3",
    b"03": "v3",
    b"04": "v4",
    b"05": "v2Pro",
    b"06": "v2ProPlus",
}

# 官方注释里的旧权重体积分界（字节）
_V1_LIMIT = 82978 * 1024
_V3_LIMIT = 700 * 1024 * 1024


def detect_sovits_version(path: Path | str) -> Optional[str]:
    """读文件头判断 SoVITS 权重版本；无法判断时返回 None。"""
    target = Path(path)
    try:
        with target.open("rb") as handle:
            head = handle.read(2)
    except OSError:
        return None

    version = _HEAD_TO_VERSION.get(head)
    if version is not None:
        return version
    if head != b"PK":
        return None

    try:
        size = target.stat().st_size
    except OSError:
        return None
    if size < _V1_LIMIT:
        return "v1"
    if size < _V3_LIMIT:
        return "v2"
    return "v3"

"""静音切分。

两个板块都要在推理前把长音频切开：

* DDSP-SVC 的官方 `main_reflow.py` 就是这么做的 —— 一口气把整首歌塞进
  `Unit2Wav` 会在 8GB 卡上峰值爆掉，而分片之间的间隙补零几乎无损；
* RVC 的训练数据准备（`infer/modules/train/preprocess.py`）用的是同一套思路，
  只是参数不同（阈值 -42dB、最短 1500ms）。

这里把官方的分片逻辑搬到共享层（逻辑照搬，参数可配），
两个板块共用同一份，避免「同一段音频在 A 板块切成 5 段、在 B 板块切成 7 段」。
"""

from __future__ import annotations

from typing import List, Optional, Tuple

import numpy as np

from .io import load

#: 官方 main_reflow.py 的默认切分参数
DEFAULT_DB_THRESH = -40.0
DEFAULT_MIN_LENGTH_MS = 5000


def split(
    audio: np.ndarray,
    sample_rate: int,
    hop_size: float,
    db_thresh: float = DEFAULT_DB_THRESH,
    min_len_ms: int = DEFAULT_MIN_LENGTH_MS,
    slicer: Optional[object] = None,
) -> List[Tuple[int, np.ndarray]]:
    """按静音把音频切成若干片段。

    返回 `[(起始帧号, 片段波形)]`，帧号以 `hop_size` 为单位 ——
    这是官方 `main_reflow.py` 的约定：切片后要按帧号取回对应的 f0 与 volume。

    整段太短或没有静音时返回单片段（官方 `Slicer` 的行为是
    `{"0": {"slice": False, "split_time": "0,len"}}`）。
    """
    slicer_obj = slicer if slicer is not None else _make_slicer(sample_rate, db_thresh, min_len_ms)
    if slicer_obj is None:
        return [(0, audio)]

    chunks = dict(slicer_obj.slice(audio))
    result: List[Tuple[int, np.ndarray]] = []
    for value in chunks.values():
        tag = str(value.get("split_time", "0,0")).split(",")
        if len(tag) < 2 or tag[0] == tag[1]:
            continue
        start_frame = int(int(tag[0]) // hop_size)
        end_frame = int(int(tag[1]) // hop_size)
        if end_frame <= start_frame:
            continue
        result.append((start_frame, audio[int(start_frame * hop_size) : int(end_frame * hop_size)]))
    return result or [(0, audio)]


def _make_slicer(sample_rate: int, db_thresh: float, min_len_ms: int) -> Optional[object]:
    """尝试用 DDSP-SVC 自带的 `Slicer`；拿不到就返回 None（退化为不切分）。

    不强依赖上游：切分只是显存优化手段，上游不可用时不该让转换整体失败。
    """
    try:
        from slicer import Slicer  # type: ignore  # noqa: PLC0415

        return Slicer(sr=sample_rate, threshold=db_thresh, min_length=min_len_ms)
    except Exception:  # noqa: BLE001
        return None


def split_file(
    path,
    sample_rate: Optional[int] = None,
    hop_size: float = 512.0,
    db_thresh: float = DEFAULT_DB_THRESH,
    min_len_ms: int = DEFAULT_MIN_LENGTH_MS,
) -> Tuple[np.ndarray, int, List[Tuple[int, np.ndarray]]]:
    """读文件并切分，返回 `(整条波形, 采样率, 片段列表)`。"""
    audio, sr = load(path, sr=sample_rate, mono=True)
    return audio, sr, split(audio, sr, hop_size, db_thresh, min_len_ms)

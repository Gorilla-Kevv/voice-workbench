"""混音：把转换后的人声与伴奏合成一首歌。

歌声转换的最后一步不是「导出 wav」而是「混音」—— 少了这一步，用户拿到的是
一条干声，还得自己去 DAW 里对齐。这里提供三件必需的事：

1. **增益**：人声与伴奏的音量比（转换后的人声响度往往与源不一致）；
2. **延迟对齐**：分离与重采样会引入几十毫秒的偏移，不补偿会出现回声感；
3. **淡入淡出**：拼接处的爆音几乎都来自这里。

输出三种产物：新人声、伴奏、混音。前两种是给进阶用户自己后期用的，
混音才是绝大多数人想要的成品。
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Tuple

import numpy as np

from .io import load, save


@dataclass
class MixOptions:
    """混音参数。"""

    #: 人声增益（dB）
    vocal_gain_db: float = 0.0
    #: 伴奏增益（dB）
    instrumental_gain_db: float = 0.0
    #: 人声相对伴奏的延迟补偿（毫秒，正值表示人声延后）
    vocal_delay_ms: float = 0.0
    #: 淡入淡出时长（毫秒），0 表示不做
    fade_ms: float = 15.0

    def to_dict(self) -> dict:
        return {
            "vocal_gain_db": self.vocal_gain_db,
            "instrumental_gain_db": self.instrumental_gain_db,
            "vocal_delay_ms": self.vocal_delay_ms,
            "fade_ms": self.fade_ms,
        }


def _gain(db: float) -> float:
    return float(10.0 ** (db / 20.0))


def _align_length(a: np.ndarray, b: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
    """把两条波形补齐到相同长度（尾部补零）。"""
    length = max(len(a), len(b))
    if len(a) < length:
        a = np.pad(a, (0, length - len(a)))
    if len(b) < length:
        b = np.pad(b, (0, length - len(b)))
    return a, b


def _apply_delay(vocal: np.ndarray, sample_rate: int, delay_ms: float) -> np.ndarray:
    """把人声整体后移（正值）或前移（负值），长度保持不变。"""
    shift = int(round(delay_ms * sample_rate / 1000.0))
    if shift == 0:
        return vocal
    shifted = np.zeros_like(vocal)
    if shift > 0:
        if shift < len(vocal):
            shifted[shift:] = vocal[: len(vocal) - shift]
    else:
        offset = -shift
        if offset < len(vocal):
            shifted[: len(vocal) - offset] = vocal[offset:]
    return shifted


def _fade(data: np.ndarray, sample_rate: int, fade_ms: float) -> np.ndarray:
    """两端等长的淡入淡出（升余弦），消除拼接爆音。"""
    if fade_ms <= 0:
        return data
    length = int(round(fade_ms * sample_rate / 1000.0))
    if length <= 1 or length * 2 >= len(data):
        return data
    ramp = 0.5 - 0.5 * np.cos(np.linspace(0.0, np.pi, length, dtype=np.float32))
    result = data.astype(np.float32).copy()
    result[:length] *= ramp
    result[-length:] *= ramp[::-1]
    return result


def _peak_normalize(data: np.ndarray, ceiling: float = 0.99) -> np.ndarray:
    """峰值归一化到 ceiling。超过 1.0 会削波，混音后几乎必然越界。"""
    peak = float(np.max(np.abs(data))) if len(data) else 0.0
    if peak <= ceiling or peak == 0.0:
        return data
    return (data * (ceiling / peak)).astype(np.float32)


def mix(
    vocal_path: Path,
    instrumental_path: Optional[Path],
    out_path: Path,
    options: Optional[MixOptions] = None,
    sample_rate: Optional[int] = None,
) -> Path:
    """人声 + 伴奏 → 混音文件。返回输出路径。"""
    options = options or MixOptions()
    vocal, sr = load(vocal_path, sr=sample_rate, mono=True)
    vocal = _apply_delay(vocal, sr, options.vocal_delay_ms)
    vocal = vocal * _gain(options.vocal_gain_db)

    if instrumental_path is None or not Path(instrumental_path).is_file():
        result = vocal
    else:
        inst, inst_sr = load(instrumental_path, sr=sr, mono=True)
        inst = inst * _gain(options.instrumental_gain_db)
        vocal, inst = _align_length(vocal, inst)
        result = vocal + inst

    result = _peak_normalize(result.astype(np.float32))
    result = _fade(result, sr, options.fade_ms)
    return save(out_path, result, sr)


def export_tracks(
    vocal_path: Path,
    instrumental_path: Optional[Path],
    out_dir: Path,
    options: Optional[MixOptions] = None,
    basename: str = "result",
) -> dict:
    """一次产出「新人声 / 伴奏 / 混音」三件套。

    返回逻辑名 → 路径；伴奏缺失时只有人声与混音（混音即人声本身）。
    """
    options = options or MixOptions()
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    vocal, sr = load(vocal_path, sr=None, mono=True)
    vocal = _fade(_peak_normalize(vocal * _gain(options.vocal_gain_db)), sr, options.fade_ms)
    vocal_out = save(out_dir / ("%s_vocal.wav" % basename), vocal, sr)

    result: dict = {"vocal": str(vocal_out), "sample_rate": sr}

    if instrumental_path and Path(instrumental_path).is_file():
        inst_out = save(out_dir / ("%s_instrumental.wav" % basename), load(instrumental_path, sr=sr, mono=True)[0], sr)
        result["instrumental"] = str(inst_out)

    mixed = mix(vocal_path, instrumental_path, out_dir / ("%s_mix.wav" % basename), options, sample_rate=sr)
    result["mix"] = str(mixed)
    return result

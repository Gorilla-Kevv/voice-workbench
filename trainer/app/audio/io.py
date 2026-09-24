"""音频读写与指纹。

两个新板块（语音变声 / 歌声转换）都要先「把用户给的东西变成一条干净的波形」，
这一步如果各写一遍，就会出现「RVC 能吃的格式 DDSP-SVC 吃不下」这类问题。
所以统一在这里：

* `probe()` —— 只读元信息，不解码整条音频（上传校验要靠它）；
* `load()` —— 解码成 float32 单声道/多声道 + 目标采样率；
* `save()` —— 写 wav/flac，采样率与位深显式指定；
* `fingerprint()` —— 给缓存用的内容指纹。

`soundfile` 覆盖绝大多数格式；个别 m4a/aac 由 PyAV（`av`）兜底 —— 整合包里
就带着 ffmpeg，PyAV 也在依赖里，不必另外装可执行文件。
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Tuple

import numpy as np

AUDIO_SUFFIXES = {".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aac", ".wma", ".opus", ".webm"}

#: 指纹采样块大小（头尾各取这么多字节）。整文件 hash 太慢，只 hash 大小又不抗改名
SAMPLE_BYTES = 256 * 1024


class AudioError(Exception):
    """音频读取或写入失败。"""


@dataclass
class AudioInfo:
    duration: float
    sample_rate: int
    channels: int
    frames: int = 0

    def to_dict(self) -> dict:
        return {
            "duration": round(self.duration, 3),
            "sample_rate": self.sample_rate,
            "channels": self.channels,
            "frames": self.frames,
        }


def probe(path: Path) -> AudioInfo:
    """读取音频元信息。失败抛 `AudioError`（带原因，可直接透给前端）。"""
    path = Path(path)
    if not path.is_file():
        raise AudioError("音频文件不存在：%s" % path.name)
    try:
        import soundfile as sf  # noqa: PLC0415

        info = sf.info(str(path))
        return AudioInfo(
            duration=float(info.duration),
            sample_rate=int(info.samplerate),
            channels=int(info.channels),
            frames=int(info.frames),
        )
    except AudioError:
        raise
    except Exception:  # noqa: BLE001 - libsndfile 不支持的格式交给 PyAV
        return _probe_with_av(path)


def _probe_with_av(path: Path) -> AudioInfo:
    import av  # noqa: PLC0415

    with av.open(str(path)) as container:
        stream = next((s for s in container.streams if s.type == "audio"), None)
        if stream is None:
            raise AudioError("文件里没有音轨：%s" % path.name)
        rate = int(stream.rate or 44100)
        channels = int(stream.channels or 1)
        duration = float(stream.duration * stream.time_base) if stream.duration else 0.0
        frames = int(duration * rate) if duration else 0
        if not duration and container.duration:
            duration = container.duration / 1_000_000.0
            frames = int(duration * rate)
        return AudioInfo(duration=duration, sample_rate=rate, channels=channels, frames=frames)


def load(path: Path, sr: Optional[int] = None, mono: bool = True) -> Tuple[np.ndarray, int]:
    """解码为 float32 波形，返回 `(waveform, sample_rate)`。

    `mono=True` 时多声道按 `librosa.to_mono` 的规则先转置再取均值 ——
    与两个上游（RVC `load_audio`、DDSP-SVC `librosa.load(mono=True)`）保持一致，
    避免同一段音频在两个板块里听起来不一样。
    """
    path = Path(path)
    try:
        import soundfile as sf  # noqa: PLC0415

        data, native_sr = sf.read(str(path), dtype="float32", always_2d=True)
    except Exception:  # noqa: BLE001
        data, native_sr = _load_with_av(path)

    if mono and data.ndim == 2 and data.shape[1] > 1:
        data = np.mean(data, axis=1)
    elif mono and data.ndim == 2:
        data = data[:, 0]
    data = np.ascontiguousarray(data, dtype=np.float32)

    if sr and sr != native_sr:
        data = resample(data, native_sr, sr)
        native_sr = sr
    return data, int(native_sr)


def _load_with_av(path: Path) -> Tuple[np.ndarray, int]:
    """PyAV 兜底解码：用于 libsndfile 读不了的封装（常见是 m4a / aac）。"""
    import av  # noqa: PLC0415

    info = _probe_with_av(path)
    resampler = av.AudioResampler(format="fltp", layout="mono" if info.channels == 1 else "stereo", rate=info.sample_rate)
    chunks = []
    with av.open(str(path)) as container:
        stream = next((s for s in container.streams if s.type == "audio"), None)
        if stream is None:
            raise AudioError("文件里没有音轨：%s" % path.name)
        for frame in container.decode(stream):
            for out in resampler.resample(frame):
                array = out.to_ndarray()
                chunks.append(array)
    if not chunks:
        raise AudioError("解码失败（没有取到任何音频帧）：%s" % path.name)
    data = np.concatenate(chunks, axis=1) if chunks[0].ndim > 1 else np.concatenate(chunks)
    return np.ascontiguousarray(data.T, dtype=np.float32), info.sample_rate


def resample(data: np.ndarray, src_sr: int, dst_sr: int) -> np.ndarray:
    """重采样。优先 librosa（高质量），不可用时退回线性插值。

    线性插值在 44.1k→16k 这种大比例上会有可闻的高频损失，
    所以只在 librosa 缺失时才用，并在调用方无法感知的情况下静默降级 ——
    服务环境里 librosa 一定在（GPT-SoVITS 依赖它）。
    """
    if src_sr == dst_sr:
        return data
    try:
        import librosa  # noqa: PLC0415

        return librosa.resample(data, orig_sr=src_sr, target_sr=dst_sr).astype(np.float32)
    except Exception:  # noqa: BLE001
        length = int(round(len(data) * dst_sr / float(src_sr)))
        source = np.linspace(0.0, 1.0, num=len(data), endpoint=False, dtype=np.float32)
        target = np.linspace(0.0, 1.0, num=length, endpoint=False, dtype=np.float32)
        return np.interp(target, source, data).astype(np.float32)


def save(path: Path, data: np.ndarray, sample_rate: int, subtype: str = "PCM_16") -> Path:
    """写音频文件。父目录自动创建。"""
    import soundfile as sf  # noqa: PLC0415

    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    array = np.asarray(data, dtype=np.float32)
    if array.ndim > 1:
        array = np.ascontiguousarray(array.T)
    sf.write(str(path), array, int(sample_rate), subtype=subtype)
    return path


def fingerprint(path: Path) -> str:
    """内容指纹：文件大小 + 头尾各 256KB 的 sha256。

    刻意**不含** mtime 与文件名：同一首歌复制一份、改个名字，
    应该命中同一份分离缓存 —— 这正是「换音色重跑时跳过分离」的前提。
    """
    path = Path(path)
    size = path.stat().st_size
    digest = hashlib.sha256()
    digest.update(str(size).encode("ascii"))
    with path.open("rb") as handle:
        digest.update(handle.read(SAMPLE_BYTES))
        if size > SAMPLE_BYTES:
            handle.seek(max(0, size - SAMPLE_BYTES))
            digest.update(handle.read(SAMPLE_BYTES))
    return digest.hexdigest()[:32]


def to_mono_wav(src: Path, dst: Path, sample_rate: Optional[int] = None) -> Tuple[Path, AudioInfo]:
    """把任意音频转成单声道 wav，返回路径与信息。

    上游两个模型都只吃单声道：RVC 的 `load_audio` 用 ffmpeg 转单声道，
    DDSP-SVC 用 `librosa.to_mono`。这里统一先转好，省得各自踩坑。
    """
    data, sr = load(src, sr=sample_rate, mono=True)
    save(dst, data, sr)
    return dst, AudioInfo(duration=len(data) / float(sr), sample_rate=sr, channels=1, frames=len(data))

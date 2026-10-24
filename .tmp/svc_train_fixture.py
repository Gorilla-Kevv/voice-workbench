# -*- coding: utf-8 -*-
"""阶段 44 回归锁的共享夹具：生成两条 3/4 秒的合成人声（正弦 + 起伏）。"""
from pathlib import Path

import numpy as np
import soundfile as sf


def ensure_corpus(root: Path) -> Path:
    corpus = Path(root) / "corpus"
    corpus.mkdir(parents=True, exist_ok=True)
    specs = (("fixture-a.wav", 3.0, 220.0), ("fixture-b.wav", 4.0, 330.0))
    for name, seconds, freq in specs:
        target = corpus / name
        if target.is_file():
            continue
        sr = 44100
        t = np.arange(int(seconds * sr)) / sr
        audio = 0.2 * np.sin(2 * np.pi * freq * t) * (0.6 + 0.4 * np.sin(2 * np.pi * 3.0 * t))
        sf.write(str(target), audio.astype(np.float32), sr)
    return corpus

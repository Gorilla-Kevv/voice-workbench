"""UVR5 直连层的端到端冒烟测试。

`smoke_vendors.py` 只能证明模块能 import，证明不了「真的能分离出两条音轨」。
这个脚本补上后半段：合成一段测试音频 → 走一遍 `Uvr5Engine` → 检查产物。

它是**开发期工具**，跑一次要加载模型（几十秒）并占用显存，不要放进启动流程。

用法::

    python scripts/smoke_uvr5.py                 # 用快速分离档位
    python scripts/smoke_uvr5.py --preset vocal_hifi --seconds 6
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TRAINER = ROOT / "trainer"


def make_test_audio(path: Path, seconds: float = 4.0, sample_rate: int = 44100) -> Path:
    """合成一段「人声 + 伴奏」的测试音频。

    用两个不同频率的正弦叠加代替真实素材：它当然不是人声，
    但足以验证「模型加载 → 推理 → 落盘 → 缓存」这条链路是否通顺。
    """
    import numpy as np  # noqa: PLC0415

    t = np.linspace(0, seconds, int(seconds * sample_rate), endpoint=False, dtype=np.float32)
    vocal = 0.4 * np.sin(2 * np.pi * 220.0 * t) * (0.5 + 0.5 * np.sin(2 * np.pi * 1.5 * t))
    instrumental = 0.25 * np.sin(2 * np.pi * 440.0 * t) + 0.1 * np.sin(2 * np.pi * 880.0 * t)
    mix = np.clip(vocal + instrumental, -1.0, 1.0).astype(np.float32)

    import soundfile as sf  # noqa: PLC0415

    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), mix, sample_rate)
    return path


def main() -> int:
    parser = argparse.ArgumentParser(description="UVR5 直连层冒烟测试")
    parser.add_argument("--preset", default="vocal_fast", help="分离档位 key")
    parser.add_argument("--seconds", type=float, default=4.0, help="测试音频时长")
    parser.add_argument("--no-cache", action="store_true", help="跳过缓存，强制重算")
    args = parser.parse_args()

    sys.path.insert(0, str(TRAINER))
    from app.audio.cache import ArtifactCache  # noqa: PLC0415
    from app.audio.io import probe  # noqa: PLC0415
    from app.audio.uvr5 import Uvr5Engine  # noqa: PLC0415
    from app.config import Settings  # noqa: PLC0415
    from app.engine import EngineRegistry  # noqa: PLC0415
    from app.sovits import bootstrap  # noqa: PLC0415

    installation = bootstrap.locate(auto_discover=True)
    if installation is None:
        print("未找到 GPT-SoVITS 整合包，无法定位 tools/uvr5")
        return 1
    bootstrap.install(installation)
    print("整合包：%s" % installation.home)

    settings = Settings.from_env()
    settings.ensure_dirs()
    registry = EngineRegistry(settings)
    engine = Uvr5Engine(registry, ArtifactCache(settings.cache_dir))

    catalog = engine.catalog(installation.home)
    usable = [p for p in catalog["presets"] if p.get("available") and p.get("model")]
    print("可用档位：%s" % ", ".join("%s(%s)" % (p["key"], p["model"]) for p in usable) or "（无）")

    src = make_test_audio(settings.data_dir / "tmp" / "smoke_uvr5.wav", seconds=args.seconds)
    print("测试音频：%s（%.1fs）" % (src, probe(src).duration))

    def progress(fraction: float, message: str) -> None:
        print("  [%.0f%%] %s" % (fraction * 100, message))

    started = time.time()
    result = engine.separate(
        home=installation.home,
        src=src,
        preset_key=args.preset,
        secondary_key="none",
        agg=settings.uvr_agg,
        fmt="wav",
        use_cache=not args.no_cache,
        progress=progress,
    )
    print("第一次：%s" % result.to_dict())
    assert result.vocal and Path(result.vocal).is_file(), "未产出了人声轨"

    cached = engine.separate(
        home=installation.home,
        src=src,
        preset_key=args.preset,
        use_cache=True,
    )
    print("第二次：cached=%s（%.3fs）" % (cached.cached, cached.elapsed_s))
    print("引擎状态：%s" % registry.snapshot())
    print("总耗时 %.1fs" % (time.time() - started))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

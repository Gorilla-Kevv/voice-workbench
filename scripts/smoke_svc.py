"""歌声转换（DDSP-SVC）端到端冒烟测试。

要验证的不是一个模型的音质，而是**整条链路是否通顺**：
权重定位 → config.yaml 解析 → 声码器 / 编码器 / F0 提取器构造 →
分片推理 → 混音 → 三件套落盘。

所以这里用一个**随机初始化**的模型：架构与真实训练产物完全一致，
只是权重是随机的（出来的声音当然是噪声）。这样不必先训练几小时才能验证工程链路。

用法::

    python scripts/smoke_svc.py                  # 转换 + 翻唱向导全链路
    python scripts/smoke_svc.py --skip-cover     # 只测转换
"""

from __future__ import annotations

import argparse
import shutil
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TRAINER = ROOT / "trainer"

sys.path.insert(0, str(TRAINER))


def ensure_random_model(settings, vendor: Path, name: str = "smoke") -> Path:
    """造一个「架构正确、权重随机」的模型，供链路测试使用。"""
    import torch  # noqa: PLC0415
    import yaml  # noqa: PLC0415

    from app import vendor_paths  # noqa: PLC0415
    from app.svc import bootstrap  # noqa: PLC0415

    model_dir = settings.svc_dir / "models" / name
    model_dir.mkdir(parents=True, exist_ok=True)

    source_config = vendor / "configs" / "reflow.yaml"
    if not source_config.is_file():
        raise SystemExit("未找到上游 configs/reflow.yaml：%s" % source_config)
    config = yaml.safe_load(source_config.read_text(encoding="utf-8"))
    target_config = model_dir / "config.yaml"
    target_config.write_text(yaml.safe_dump(config, allow_unicode=True), encoding="utf-8")

    model_path = model_dir / "model.pt"
    if model_path.is_file():
        return model_path

    with vendor_paths.temporary_context(entries=[str(vendor)], argv=["svc"]):
        from reflow.vocoder import Unit2Wav  # type: ignore  # noqa: PLC0415

        model = Unit2Wav(
            config["data"]["sampling_rate"],
            config["data"]["block_size"],
            config["model"]["win_length"],
            config["data"]["encoder_out_channels"],
            config["model"]["n_spk"],
            config["model"]["use_norm"],
            config["model"]["use_attention"],
            config["model"]["use_pitch_aug"],
            128,  # vocoder.dimension：nsf-hifigan 的 num_mels
            config["model"]["n_aux_layers"],
            config["model"]["n_aux_chans"],
            config["model"]["n_layers"],
            config["model"]["n_chans"],
        )
    torch.save({"model": model.state_dict()}, str(model_path))
    print("已生成随机模型：%s（%.1f MB）" % (model_path, model_path.stat().st_size / 1e6))
    return model_path


def make_test_audio(path: Path, seconds: float = 6.0, sample_rate: int = 44100) -> Path:
    import numpy as np  # noqa: PLC0415
    import soundfile as sf  # noqa: PLC0415

    t = np.linspace(0, seconds, int(seconds * sample_rate), endpoint=False, dtype=np.float32)
    # 一段带颤音的"歌声"（正弦扫频）+ 一段伴奏，方便分离环节有东西可分
    melody = 0.4 * np.sin(2 * np.pi * (220 + 40 * np.sin(2 * np.pi * 0.8 * t)) * t)
    pad = 0.2 * np.sin(2 * np.pi * 330 * t)
    mix = np.clip(melody + pad, -1.0, 1.0).astype(np.float32)
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), mix, sample_rate)
    return path


def main() -> int:
    parser = argparse.ArgumentParser(description="歌声转换链路冒烟测试")
    parser.add_argument("--seconds", type=float, default=6.0)
    parser.add_argument("--skip-cover", action="store_true", help="只测转换，不跑翻唱向导")
    args = parser.parse_args()

    from app.audio.cache import ArtifactCache  # noqa: PLC0415
    from app.audio.uvr5 import Uvr5Engine  # noqa: PLC0415
    from app.config import Settings  # noqa: PLC0415
    from app.engine import EngineRegistry  # noqa: PLC0415
    from app.svc import catalog  # noqa: PLC0415
    from app.svc.cover import run_cover  # noqa: PLC0415
    from app.svc.pipeline import SvcEngine  # noqa: PLC0415
    from app.sovits import bootstrap as sovits_bootstrap  # noqa: PLC0415
    from app import weights  # noqa: PLC0415

    settings = Settings.from_env()
    settings.ensure_dirs()

    missing = weights.blockers(settings, "svc")
    if missing:
        print("缺少必需权重，请先运行 scripts/download_models.py --engine svc：")
        for item in missing:
            print("  - %s" % item)
        return 1

    installation = sovits_bootstrap.locate(auto_discover=True)
    if installation is None:
        print("未找到 GPT-SoVITS 整合包（UVR5 在它里面）")
        return 1

    vendor = settings.ddsp_dir
    model_path = ensure_random_model(settings, vendor)
    registry = EngineRegistry(settings)
    engine = SvcEngine(settings)
    registry.register_unloader("svc", engine.unload)

    print("\n[1] 加载模型")
    handle = registry.acquire("svc", reason="冒烟测试")
    try:
        status = engine.load(model_path)
        print("    %s" % status)
    finally:
        handle.release()

    print("\n[2] 直接转换（干声）")
    src = make_test_audio(settings.data_dir / "tmp" / "smoke_svc.wav", seconds=args.seconds)
    out = settings.data_dir / "tmp" / "smoke_converted.wav"

    def progress(fraction: float, message: str) -> None:
        print("    [%.0f%%] %s" % (fraction * 100, message))

    started = time.time()
    handle = registry.acquire("svc", reason="冒烟转换")
    try:
        info = engine.convert(src=src, out_path=out, model_path=model_path, quality="fast", progress=progress)
    finally:
        handle.release()
    print("    产物：%s（%.1f MB，%.1fs）" % (info["output"], Path(info["output"]).stat().st_size / 1e6, time.time() - started))
    print("    分段数：%d，采样率：%d" % (info["segments"], info["sample_rate"]))

    if args.skip_cover:
        print("\n引擎状态：%s" % registry.snapshot())
        return 0

    print("\n[3] 翻唱向导（分离 → 转换 → 混音）")
    uvr5 = Uvr5Engine(registry, ArtifactCache(settings.cache_dir))
    out_dir = settings.data_dir / "tmp" / "smoke_cover"
    if out_dir.exists():
        shutil.rmtree(out_dir, ignore_errors=True)

    result = run_cover(
        settings=settings,
        uvr5=uvr5,
        engine=engine,
        home=installation.home,
        src=src,
        model_path=model_path,
        out_dir=out_dir,
        separation={"preset": "vocal_fast", "secondary": "none", "use_cache": True},
        conversion={"quality": "fast", "key": 0.0},
        mix={"vocal_gain_db": 0.0, "instrumental_gain_db": -3.0},
        progress=progress,
    )
    print("    三件套：%s" % result["artifacts"])
    for stage in result["stages"]:
        print("    阶段 %-8s %s" % (stage.get("key"), "命中缓存" if stage.get("cached") else "完成"))
    print("    总耗时 %.1fs" % result["elapsed_s"])
    print("\n引擎状态：%s" % registry.snapshot())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

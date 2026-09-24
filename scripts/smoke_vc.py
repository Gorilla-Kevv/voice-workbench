"""语音变声（RVC）端到端冒烟测试。

与 `smoke_svc.py` 同样的思路：验证链路而不是音质。
用一个**随机初始化**的模型（架构与真实产物一致、权重随机），
把「加载 → 变声 → 融合 → LoRA 注入」整条路走一遍，
不必先花几小时训练一个真音色。

用法::

    python scripts/smoke_vc.py
    python scripts/smoke_vc.py --seconds 8
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TRAINER = ROOT / "trainer"

sys.path.insert(0, str(TRAINER))


def make_random_model(settings, index: int = 0) -> Path:
    """造一个架构正确、权重随机的推理模型（.pth）。"""
    import torch  # noqa: PLC0415

    from app import vendor_paths  # noqa: PLC0415
    from app.vc import bootstrap  # noqa: PLC0415

    root = bootstrap.vendor_root(settings)
    # 本分支的 configs/v2/ 只有 32k 与 48k（没有 40k），用 32k 更快
    with open(root / "configs" / "v2" / "32k.json", "r", encoding="utf-8") as handle:
        hps = json.load(handle)

    # 与官方 process_ckpt.savee() 完全一致的顺序
    config = [
        hps["data"]["filter_length"] // 2 + 1,
        32,
        hps["model"]["inter_channels"],
        hps["model"]["hidden_channels"],
        hps["model"]["filter_channels"],
        hps["model"]["n_heads"],
        hps["model"]["n_layers"],
        hps["model"]["kernel_size"],
        hps["model"]["p_dropout"],
        hps["model"]["resblock"],
        hps["model"]["resblock_kernel_sizes"],
        hps["model"]["resblock_dilation_sizes"],
        hps["model"]["upsample_rates"],
        hps["model"]["upsample_initial_channel"],
        hps["model"]["upsample_kernel_sizes"],
        hps["model"]["spk_embed_dim"],
        hps["model"]["gin_channels"],
        hps["data"]["sampling_rate"],
    ]

    with vendor_paths.temporary_context(entries=[str(root)], cwd=str(root), argv=["rvc"]):
        from infer.lib.infer_pack.models import SynthesizerTrnMs768NSFsid  # type: ignore  # noqa: PLC0415

        net = SynthesizerTrnMs768NSFsid(*config, is_half=False)
    weight = {k: v.half() for k, v in net.state_dict().items() if "enc_q" not in k}
    del net

    name = "smoke_%d" % index
    path = bootstrap.models_dir(settings) / ("%s.pth" % name)
    torch.save(
        {"weight": weight, "config": config, "info": "smoke", "sr": "40k", "f0": 1, "version": "v2"},
        str(path),
    )
    print("已生成随机模型：%s（%.1f MB）" % (path, path.stat().st_size / 1e6))
    return path


def make_test_audio(path: Path, seconds: float = 6.0, sample_rate: int = 44100) -> Path:
    import numpy as np  # noqa: PLC0415
    import soundfile as sf  # noqa: PLC0415

    t = np.linspace(0, seconds, int(seconds * sample_rate), endpoint=False, dtype=np.float32)
    # 带停顿的"说话"：两段 220Hz + 静音，便于 slicer 与 VAD 有东西可处理
    voice = 0.35 * np.sin(2 * np.pi * 220 * t) * (np.sin(2 * np.pi * 1.2 * t) > 0).astype(np.float32)
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), voice.astype(np.float32), sample_rate)
    return path


def main() -> int:
    parser = argparse.ArgumentParser(description="语音变声链路冒烟测试")
    parser.add_argument("--seconds", type=float, default=6.0)
    args = parser.parse_args()

    from app.config import Settings  # noqa: PLC0415
    from app.engine import EngineRegistry  # noqa: PLC0415
    from app.vc import bootstrap, lora, merge  # noqa: PLC0415
    from app.vc.pipeline import VcEngine  # noqa: PLC0415
    from app import weights  # noqa: PLC0415

    settings = Settings.from_env()
    settings.ensure_dirs()

    missing = weights.blockers(settings, "rvc")
    if missing:
        print("缺少必需权重，请先运行 scripts/download_models.py --engine rvc：")
        for item in missing:
            print("  - %s" % item)
        return 1

    print("ffmpeg：%s" % (bootstrap.ensure_ffmpeg(settings) or "未找到（变声会失败）"))

    registry = EngineRegistry(settings)
    engine = VcEngine(settings)
    registry.register_unloader("rvc", engine.unload)

    model_path = make_random_model(settings, 0)
    print("\n[1] 加载音色")
    handle = registry.acquire("rvc", reason="冒烟测试")
    try:
        print("    %s" % engine.load(model_path.name))
    finally:
        handle.release()

    print("\n[2] 变声")
    src = make_test_audio(settings.data_dir / "tmp" / "smoke_vc.wav", seconds=args.seconds)
    out = settings.data_dir / "tmp" / "smoke_vc_out.wav"
    started = time.time()
    handle = registry.acquire("rvc", reason="冒烟变声")
    try:
        info = engine.convert(
            src=src,
            out_path=out,
            model_key=model_path.name,
            f0_up_key=0,
            f0_method="rmvpe",
            index_rate=0.0,
            progress=lambda f, m: print("    [%.0f%%] %s" % (f * 100, m)),
        )
    finally:
        handle.release()
    print("    产物：%s（%.1f MB，%.1fs）" % (info["output"], Path(info["output"]).stat().st_size / 1e6, time.time() - started))
    print("    采样率：%d，时长 %.2fs" % (info["sample_rate"], info["duration"]))

    print("\n[3] 音色融合（两个随机模型 + 另一个模型）")
    second = make_random_model(settings, 1)
    merged = merge.merge_models(settings, [model_path, second], [0.7, 0.3], name="smoke_merged")
    print("    产物：%s，配比 %s" % (merged["path"], merged["ratios"]))

    print("\n[4] LoRA 注入 / 存档 / 热切换")
    import torch  # noqa: PLC0415

    from app import vendor_paths  # noqa: PLC0415

    root = bootstrap.vendor_root(settings)
    with vendor_paths.temporary_context(entries=[str(root)], cwd=str(root), argv=["rvc"]):
        from infer.lib.infer_pack.models import SynthesizerTrnMs768NSFsid  # type: ignore  # noqa: PLC0415

        ckpt = torch.load(str(model_path), map_location="cpu")
        net = SynthesizerTrnMs768NSFsid(*list(ckpt["config"]), is_half=False)
        net.load_state_dict(ckpt["weight"], strict=False)

        cfg = lora.LoRAConfig(rank=8, alpha=16.0)
        injected = lora.inject_lora(net, cfg)
        print("    注入 %d 层，可训练参数 %d / 总参数 %d" % (injected["injected"], injected["trainable"], injected["total"]))

        adapter = settings.vc_dir / "smoke.lora.pt"
        lora.save_adapter(net, adapter, {"config": cfg.to_dict()})
        print("    适配器：%s（%.2f MB）" % (adapter, adapter.stat().st_size / 1e6))

        applied = lora.apply_adapter(net, adapter)
        print("    热切换：注入 %d 层，载入 %d 层" % (applied["injected"], applied["applied"]))

    print("\n引擎状态：%s" % registry.snapshot())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

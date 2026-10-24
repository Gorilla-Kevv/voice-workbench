# -*- coding: utf-8 -*-
"""DDSP-SVC 训练入口（子进程）。

上游 `train_reflow.py` 只在 `interval_val` 的整数倍步数存档；如果总步数不是
`interval_val` 的倍数，**训练结束时的最后一版权重根本不会落盘**。小数据集下
（例如 10 条音频、batch 8、200 轮 = 250 步）默认 `interval_val=2000`，结果就是
「训练跑完了，磁盘上什么都没有」。

这里按上游 `__main__` 原样复刻训练流程，只在 `train()` 返回后补一次最终存档。
不改 vendor 一行；sys.path 注入的原因见 `train_preprocess.py`。
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path


def _vendor_root() -> Path:
    override = os.environ.get("DDSP_VENDOR_ROOT", "").strip()
    if override:
        return Path(override)
    # trainer/app/svc/train_entry.py -> 仓库根/vendor/ddsp-svc
    return Path(__file__).resolve().parents[3] / "vendor" / "ddsp-svc"


VENDOR = _vendor_root()
if str(VENDOR) not in sys.path:
    sys.path.insert(0, str(VENDOR))


def main() -> int:
    import torch  # noqa: PLC0415

    # 上游 reflow/solver.py 写的是 torch>=2.3 的 `from torch.amp import GradScaler`；
    # 整合包运行时是 torch 2.0（`torch.amp` 还没有这个名字）。补回旧 API 再导入
    # solver，避免为了训练另建一个包含 librosa/pyworld/tensorboard 的完整 venv。
    if not hasattr(torch.amp, "GradScaler"):
        torch.amp.GradScaler = torch.cuda.amp.GradScaler  # type: ignore[attr-defined]

    # 同族的第二处：上游 optimizer/chained_optimizer.py 只有类型注解用到
    # `torch.optim.optimizer.ParamsT`（torch>=2.3 才导出）。补一个等价位。
    import torch.optim.optimizer as _torch_optimizer  # noqa: PLC0415

    if not hasattr(_torch_optimizer, "ParamsT"):
        from typing import Any as _Any  # noqa: PLC0415
        from typing import Dict as _Dict  # noqa: PLC0415
        from typing import Iterable as _Iterable  # noqa: PLC0415
        from typing import Union as _Union  # noqa: PLC0415

        _torch_optimizer.ParamsT = _Union[  # type: ignore[attr-defined]
            _Iterable[torch.Tensor], _Iterable[_Dict[str, _Any]]
        ]

    from torch.optim import lr_scheduler  # noqa: PLC0415

    import logger.saver as saver_module  # noqa: PLC0415
    import reflow.solver as solver_module  # noqa: PLC0415
    from logger import utils  # noqa: PLC0415
    from optimizer.muon import Muon_AdamW  # noqa: PLC0415
    from reflow.data_loaders import get_data_loaders  # noqa: PLC0415
    from reflow.vocoder import Unit2Wav, Vocoder  # noqa: PLC0415

    parser = argparse.ArgumentParser()
    parser.add_argument("-c", "--config", required=True)
    cmd = parser.parse_args()

    args = utils.load_config(cmd.config)
    device = str(args.device)
    print(" > config:", cmd.config, flush=True)
    print(" >    exp:", args.env.expdir, flush=True)
    print(" > device:", device, flush=True)

    if device.startswith("cuda") and not torch.cuda.is_available():
        print("[svc-train] 配置要求 CUDA，但本进程检测不到可用 GPU", flush=True)
        return 2
    if str(args.model.type) != "RectifiedFlow":
        print(" [x] Unknown Model: %s" % args.model.type, flush=True)
        return 2

    vocoder = Vocoder(args.vocoder.type, args.vocoder.ckpt, device=device)
    model = Unit2Wav(
        args.data.sampling_rate,
        args.data.block_size,
        args.model.win_length,
        args.data.encoder_out_channels,
        args.model.n_spk,
        args.model.use_norm,
        args.model.use_attention,
        args.model.use_pitch_aug,
        vocoder.dimension,
        args.model.n_aux_layers,
        args.model.n_aux_chans,
        args.model.n_layers,
        args.model.n_chans,
    )

    if device.startswith("cuda"):
        torch.cuda.set_device(int(args.env.gpu_id))
    model.to(device)

    optimizer = Muon_AdamW(
        model,
        muon_args={"weight_decay": args.train.weight_decay},
        adamw_args={"weight_decay": 0},
    )
    initial_global_step, model, optimizer = utils.load_model(
        args.env.expdir, model, optimizer, device=device
    )
    for param_group in optimizer.param_groups:
        param_group["initial_lr"] = args.train.lr
        param_group["lr"] = args.train.lr * args.train.gamma ** max(
            (initial_global_step - 2) // args.train.decay_step, 0
        )
    scheduler = lr_scheduler.StepLR(
        optimizer,
        step_size=args.train.decay_step,
        gamma=args.train.gamma,
        last_epoch=initial_global_step - 2,
    )

    loader_train, loader_valid = get_data_loaders(args, whole_audio=False)

    class RecordingSaver(saver_module.Saver):
        created = []

        def __init__(self, *a, **kw):
            super().__init__(*a, **kw)
            RecordingSaver.created.append(self)

    # train() 内部自己 new Saver；换成记录版，训练结束后才能拿到最后一个实例
    solver_module.Saver = RecordingSaver
    solver_module.train(
        args,
        initial_global_step,
        model,
        optimizer,
        scheduler,
        vocoder,
        loader_train,
        loader_valid,
    )

    saver = RecordingSaver.created[-1] if RecordingSaver.created else saver_module.Saver(
        args, initial_global_step=initial_global_step
    )
    final_path = Path(saver.expdir) / ("model_%d.pt" % saver.global_step)
    saver.save_model(model, None, postfix=str(saver.global_step))
    print("[svc-train] final checkpoint saved: %s" % final_path, flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

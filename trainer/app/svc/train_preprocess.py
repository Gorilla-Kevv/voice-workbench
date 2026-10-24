# -*- coding: utf-8 -*-
"""DDSP-SVC 训练预处理入口（子进程）。

为什么不直接跑 `vendor/ddsp-svc/preprocess.py`：

1. 整合包解释器是 embedded distribution，`sys.path` 由 `runtime/python39._pth`
   固定，**既不包含 cwd 也不包含脚本目录**；DDSP 的 preprocess.py 又没有像
   RVC 那样 `sys.path.append(os.getcwd())`，直接按路径启动会死在
   `ModuleNotFoundError: No module named 'logger'`。
2. 上游 F0 提取器 rmvpe 写死相对路径 `pretrain/rmvpe/model.pt`；本项目的权重
   在 `models/pretrained/ddsp/` 下。调用方（`training.py`）把 cwd 固定到本次
   任务工作目录，并在那里准备同路径链接，所以这里只负责注入 vendor 根。

其余流程照上游 `__main__` 原样复刻（parse → load_config → 两次 preprocess），
不改 vendor 一行。
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
    # trainer/app/svc/train_preprocess.py -> 仓库根/vendor/ddsp-svc
    return Path(__file__).resolve().parents[3] / "vendor" / "ddsp-svc"


VENDOR = _vendor_root()
if str(VENDOR) not in sys.path:
    sys.path.insert(0, str(VENDOR))


# --------------------------------------------------------------------------
# 上游 DotDict 在 Windows spawn 下不可 pickle
#
# `logger/utils.py::DotDict.__getattr__` 对所有未知属性返回 None（而不是抛
# AttributeError），pickle 查找 `__getstate__` 时因此拿到 None 并调用它，报
# `TypeError: 'NoneType' object is not callable`。Linux 的 fork 不序列化
# initializer 参数，所以上游从未暴露；Windows 的 ProcessPoolExecutor 必挂。
# 这里换成同语义、但对 dunder 正确抛 AttributeError 的实现，再交给上游的
# 多进程预处理。子进程导入 __mp_main__（本文件）时也会执行同一段补丁。
# --------------------------------------------------------------------------
from logger import utils as _utils  # noqa: E402


class _PicklableDotDict(dict):
    def __getattr__(self, name):
        if name.startswith("__") and name.endswith("__"):
            raise AttributeError(name)
        value = dict.get(self, name)
        return _PicklableDotDict(value) if type(value) is dict else value

    __setattr__ = dict.__setitem__
    __delattr__ = dict.__delitem__


_utils.DotDict = _PicklableDotDict


# --------------------------------------------------------------------------
# CPU 排障通道：上游 RMVPE / ContentVec 的 torch.load 没有 map_location
#
# CPU 模式会设 `CUDA_VISIBLE_DEVICES=""`（让 rmvpe 自己也走 CPU）。但这些权重
# 是从 CUDA 张量保存的，torch.load 默认按原 device 恢复 → 报
# `Attempting to deserialize object on CUDA device 0 but device_count() is 0`。
# 在 CPU 模式下给 torch.load 补默认 map_location='cpu'；子进程导入本文件时
# 会执行同一段补丁（env 由 training.run 透传）。
# --------------------------------------------------------------------------
if os.environ.get("SVC_PREPROCESS_CPU") == "1":
    import torch as _torch  # noqa: E402

    _ORIG_TORCH_LOAD = _torch.load

    def _load_cpu(*args, **kwargs):
        kwargs.setdefault("map_location", "cpu")
        return _ORIG_TORCH_LOAD(*args, **kwargs)

    _torch.load = _load_cpu  # type: ignore[assignment]


def main() -> int:
    import torch  # noqa: PLC0415
    import torch.multiprocessing as mp  # noqa: PLC0415
    from logger import utils  # noqa: PLC0415

    import preprocess as upstream  # noqa: PLC0415

    parser = argparse.ArgumentParser()
    parser.add_argument("-c", "--config", required=True)
    parser.add_argument("-d", "--device", default=None)
    parser.add_argument("-j", "--workers", type=int, default=1)
    cmd = parser.parse_args()

    mp.set_start_method("spawn", force=True)
    device = cmd.device or ("cuda" if torch.cuda.is_available() else "cpu")
    args = utils.load_config(cmd.config)

    sample_rate = args.data.sampling_rate
    hop_size = args.data.block_size
    extensions = args.data.extensions
    use_pitch_aug = args.model.use_pitch_aug
    workers = max(1, int(cmd.workers or 1))

    print(
        "[svc-preprocess] device=%s workers=%d train=%s valid=%s"
        % (device, workers, args.data.train_path, args.data.valid_path),
        flush=True,
    )
    upstream.preprocess(
        args.data.train_path,
        args=args,
        sample_rate=sample_rate,
        hop_size=hop_size,
        device=device,
        use_pitch_aug=use_pitch_aug,
        extensions=extensions,
        workers=workers,
    )
    upstream.preprocess(
        args.data.valid_path,
        args=args,
        sample_rate=sample_rate,
        hop_size=hop_size,
        device=device,
        use_pitch_aug=False,
        extensions=extensions,
        workers=workers,
    )
    print("[svc-preprocess] done", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

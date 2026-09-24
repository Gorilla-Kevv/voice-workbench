"""DDSP-SVC 直连层：路径、权重与模型加载。

上游（`vendor/ddsp-svc`）是脚本式项目，`main_reflow.py` / `batch_infer.py` 把所有逻辑
写在 `if __name__ == '__main__'` 里，没有可复用的函数。最接近可复用实现的是
`gui_reflow.py` 的 `SvcDDSP` 类，但那个类又绑着 GUI。

所以这里自己编排，并把三处**相对路径依赖**全部改成绝对路径传参，
从而完全不需要 `os.chdir()`（这点很关键：GPT-SoVITS 已经永久占用了 cwd，
RVC 也需要临时 chdir，DDSP-SVC 能不凑这个热闹就不要凑）：

| 上游位置 | 相对路径 | 我们的绕法 |
| --- | --- | --- |
| `ddsp/vocoder.py:36` | `pretrain/rmvpe/model.pt` | 预注入 `ddsp.vocoder.F0_KERNEL['rmvpe']` |
| `reflow/vocoder.py:32` | `args.vocoder.ckpt` | 自己构造 `Vocoder(type, 绝对路径, device)` |
| `Units_Encoder(...)` | `args.data.encoder_ckpt` | 调用时传绝对路径 |

模型权重（.pt）**必须**与 `config.yaml` 同目录：训练时 `logger/saver.py` 会把
运行配置 dump 到 expdir，官方 `load_model_vocoder` 也是按这个约定找的。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, Optional, Tuple

import torch

from .. import vendor_paths
from ..config import Settings

__all__ = [
    "vendor_root",
    "ensure_import_path",
    "preinject_rmvpe",
    "resolve_pretrained",
    "load_model",
    "SvcError",
]


class SvcError(Exception):
    """DDSP-SVC 链路失败。消息可直接展示。"""

    def __init__(self, message: str, hint: str = "", code: str = "SVC_FAILED") -> None:
        super().__init__(message)
        self.message = message
        self.hint = hint
        self.code = code


def vendor_root(settings: Settings) -> Path:
    root = Path(settings.ddsp_dir)
    if not root.is_dir():
        raise SvcError(
            "未找到 DDSP-SVC 源码目录：%s" % root,
            hint="执行 git submodule update --init 拉取 vendor/ddsp-svc。",
            code="VENDOR_MISSING",
        )
    return root


def ensure_import_path(settings: Settings) -> Path:
    """把上游根目录放进 `sys.path`（幂等）。DDSP-SVC 的顶层模块名是 `ddsp` / `reflow` 等。"""
    root = vendor_root(settings)
    entry = str(root)
    if entry not in _IMPORTED_ROOTS:
        if entry in __import__("sys").path:
            __import__("sys").path.remove(entry)
        __import__("sys").path.insert(0, entry)
        _IMPORTED_ROOTS.append(entry)
    return root


_IMPORTED_ROOTS: list = []


def resolve_pretrained(settings: Settings, relative: str) -> Path:
    """把 config 里的相对权重路径解析到我们的 `models/pretrained/ddsp/` 下。

    config 里写的是 `pretrain/rmvpe/model.pt` 这类上游口径的路径，
    这里统一映射到 `models/pretrained/ddsp/<去掉 pretrain/ 前缀后的部分>`，
    与 `weights.py` 的清单保持一致。
    """
    relative = relative.replace("\\", "/").lstrip("./")
    if relative.startswith("pretrain/"):
        relative = relative[len("pretrain/") :]
    return Path(settings.pretrained_dir) / "ddsp" / relative


def preinject_rmvpe(settings: Settings, device: Optional[str] = None) -> bool:
    """把 rmvpe 模型按绝对路径预先塞进上游的模块级缓存。

    `ddsp/vocoder.py` 里 `F0_Extractor('rmvpe', ...)` 会走硬编码的相对路径
    `pretrain/rmvpe/model.pt`；它先看模块级字典 `F0_KERNEL` 里有没有，
    有就直接用。预注入后既拿到了绝对路径，又顺带避免了每个请求重复加载。
    """
    model_path = resolve_pretrained(settings, "pretrain/rmvpe/model.pt")
    if not model_path.is_file():
        return False
    root = ensure_import_path(settings)
    with vendor_paths.temporary_context(entries=[str(root)], argv=["svc"]):
        import ddsp.vocoder as vocoder_module  # type: ignore  # noqa: PLC0415
        from encoder.rmvpe import RMVPE  # type: ignore  # noqa: PLC0415

        if "rmvpe" not in vocoder_module.F0_KERNEL:
            vocoder_module.F0_KERNEL["rmvpe"] = RMVPE(str(model_path), hop_length=160)
    return True


def load_model(
    settings: Settings,
    model_ckpt: Path,
    device: Optional[str] = None,
) -> Tuple[Any, Any, Dict[str, Any]]:
    """加载 `(Unit2Wav, Vocoder, args)`。

    与官方 `load_model_vocoder` 等价，区别只有一处：声码器权重用**绝对路径**构造，
    因此不需要把 cwd 切到上游根目录。
    """
    model_ckpt = Path(model_ckpt)
    if not model_ckpt.is_file():
        raise SvcError("未找到歌声转换模型：%s" % model_ckpt, code="MODEL_MISSING")

    config_file = model_ckpt.parent / "config.yaml"
    if not config_file.is_file():
        raise SvcError(
            "模型缺少同目录的 config.yaml：%s" % model_ckpt.name,
            hint="DDSP-SVC 的训练产物目录里会带 config.yaml；导入模型时请连同它一起放进来。",
            code="CONFIG_MISSING",
        )

    root = ensure_import_path(settings)
    with vendor_paths.temporary_context(entries=[str(root)], argv=["svc"]):
        import yaml  # noqa: PLC0415
        from reflow.vocoder import Unit2Wav, Vocoder  # type: ignore  # noqa: PLC0415
        from reflow.vocoder import DotDict  # type: ignore  # noqa: PLC0415

        with config_file.open("r", encoding="utf-8") as handle:
            args = DotDict(yaml.safe_load(handle))

        if str(args.model.type) != "RectifiedFlow":
            raise SvcError(
                "config.yaml 里的 model.type 是 %s，本服务只接入 RectifiedFlow（6.x）" % args.model.type,
                hint="旧版 DDSP-SVC 模型请用上游自己的脚本推理，或重新训练。",
                code="UNSUPPORTED_MODEL",
            )

        target_device = device or ("cuda" if torch.cuda.is_available() else "cpu")
        vocoder_ckpt = resolve_pretrained(settings, str(args.vocoder.ckpt))
        if not vocoder_ckpt.is_file():
            raise SvcError(
                "缺少声码器权重：%s" % vocoder_ckpt,
                hint="下载 NSF-HiFiGAN 后放到该路径（见 weights.py 的 ddsp_nsf_hifigan）。",
                code="VOCODER_MISSING",
            )

        vocoder = Vocoder(str(args.vocoder.type), str(vocoder_ckpt), device=target_device)
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
        ckpt = torch.load(str(model_ckpt), map_location=torch.device(target_device))
        model.load_state_dict(ckpt["model"])
        model.eval().to(target_device)
        return model, vocoder, args


def build_units_encoder(settings: Settings, args: Dict[str, Any], device: Optional[str] = None) -> Any:
    """构造内容特征编码器，权重路径一律转绝对。"""
    root = ensure_import_path(settings)
    with vendor_paths.temporary_context(entries=[str(root)], argv=["svc"]):
        from ddsp.vocoder import Units_Encoder  # type: ignore  # noqa: PLC0415

        encoder = str(args["data"]["encoder"])
        ckpt = resolve_pretrained(settings, str(args["data"]["encoder_ckpt"]))
        if not ckpt.is_file():
            raise SvcError(
                "缺少内容编码器权重：%s" % ckpt,
                hint="下载 ContentVec 后放到该路径（见 weights.py 的 ddsp_contentvec）。",
                code="ENCODER_MISSING",
            )
        gate = args["data"].get("cnhubertsoft_gate", 10) if encoder == "cnhubertsoftfish" else 10
        return Units_Encoder(
            encoder,
            str(ckpt),
            args["data"]["encoder_sample_rate"],
            args["data"]["encoder_hop_size"],
            cnhubertsoft_gate=gate,
            device=device or ("cuda" if torch.cuda.is_available() else "cpu"),
        )


def build_f0_extractor(settings: Settings, args: Dict[str, Any], sample_rate: int, hop_size: float, method: str = "") -> Any:
    """构造 F0 提取器。`method` 为空时用 config 里的 `data.f0_extractor`。"""
    root = ensure_import_path(settings)
    preinject_rmvpe(settings)
    with vendor_paths.temporary_context(entries=[str(root)], argv=["svc"]):
        from ddsp.vocoder import F0_Extractor  # type: ignore  # noqa: PLC0415

        return F0_Extractor(
            method or str(args["data"]["f0_extractor"]),
            sample_rate,
            hop_size,
            float(args["data"]["f0_min"]),
            float(args["data"]["f0_max"]),
        )

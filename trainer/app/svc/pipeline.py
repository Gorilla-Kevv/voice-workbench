"""歌声转换引擎：模型常驻、权重热切换、一次转换。

与既有 GPT-SoVITS 管线同样的两个设计决定：

1. **模型常驻内存**。官方 `main_reflow.py` 每次调用都要重新加载模型与编码器，
   在「试听一下效果」的场景下等于不可用；这里加载一次，之后只做热切换。
2. **串行推理**。单卡 8GB，并发只会互相抢显存最终一起 OOM；
   串行化由上层队列（`queue.Pool`）与本服务的线程锁共同保证。

转换流程照搬官方 `main_reflow.py`（分片推理版），因为一次性把整首歌喂进
`Unit2Wav` 在 8GB 卡上峰值会爆 —— 分片之间的间隙补零，听感上无损。
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

import numpy as np
import torch

from ..audio.io import load, save
from ..audio.slicer import split
from ..config import Settings
from . import bootstrap, catalog

ProgressFn = Callable[[float, str], None]


class SvcEngine:
    """DDSP-SVC 推理引擎。"""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.model = None
        self.vocoder = None
        self.args: Optional[Dict[str, Any]] = None
        self.units_encoder = None
        self.model_path: Optional[Path] = None
        self.loaded_at: float = 0.0

    # ---------- 模型 ----------

    def load(self, model_path: Path) -> Dict[str, Any]:
        """加载（或热切换到）指定音色模型。"""
        model_path = Path(model_path)
        if self.model is not None and self.model_path == model_path:
            return self.status()

        self.unload()
        device = "cuda" if torch.cuda.is_available() else "cpu"
        model, vocoder, args = bootstrap.load_model(self.settings, model_path, device=device)
        self.model, self.vocoder, self.args = model, vocoder, args
        self.units_encoder = bootstrap.build_units_encoder(self.settings, args, device=device)
        self.model_path = model_path
        self.loaded_at = time.time()
        return self.status()

    def unload(self) -> None:
        """释放模型与显存。"""
        self.model = None
        self.vocoder = None
        self.args = None
        self.units_encoder = None
        self.model_path = None
        if torch.cuda.is_available():
            torch.cuda.empty_cache()

    @property
    def ready(self) -> bool:
        return self.model is not None and self.args is not None

    def status(self) -> Dict[str, Any]:
        if not self.ready:
            return {"loaded": False, "model": None}
        args = self.args or {}
        return {
            "loaded": True,
            "model": str(self.model_path),
            "name": self.model_path.parent.name if self.model_path else None,
            "sample_rate": args.get("data", {}).get("sampling_rate"),
            "encoder": args.get("data", {}).get("encoder"),
            "f0_extractor": args.get("data", {}).get("f0_extractor"),
            "n_spk": args.get("model", {}).get("n_spk", 1),
            "infer_step": args.get("infer", {}).get("infer_step"),
            "method": args.get("infer", {}).get("method"),
            "held_s": round(time.time() - self.loaded_at, 1) if self.loaded_at else 0.0,
        }

    # ---------- 转换 ----------

    def convert(
        self,
        *,
        src: Path,
        out_path: Path,
        model_path: Optional[Path] = None,
        key: float = 0.0,
        spk_id: int = 1,
        spk_mix: Optional[Dict[int, float]] = None,
        f0_method: str = "",
        quality: str = "standard",
        formant_shift: float = 0.0,
        threshold_db: float = -45.0,
        slice_segments: bool = True,
        progress: Optional[ProgressFn] = None,
    ) -> Dict[str, Any]:
        """执行一次歌声转换，返回产物信息与统计。"""
        if model_path:
            self.load(Path(model_path))
        if not self.ready:
            raise bootstrap.SvcError(
                "尚未加载歌声转换模型",
                hint="先在音色列表里选一个模型（.pt 且同目录有 config.yaml）。",
                code="MODEL_NOT_LOADED",
            )

        args = self.args or {}
        preset = catalog.quality_preset(quality)
        device = "cuda" if torch.cuda.is_available() else "cpu"

        if progress:
            progress(0.05, "读取音频")
        audio, sample_rate = load(src, sr=None, mono=True)
        duration = len(audio) / float(sample_rate)
        if progress:
            progress(0.15, "时长 %.1fs，采样率 %d" % (duration, sample_rate))

        hop_size = args["data"]["block_size"] * sample_rate / args["data"]["sampling_rate"]
        win_size = args["data"]["volume_smooth_size"] * sample_rate / args["data"]["sampling_rate"]

        if progress:
            progress(0.25, "提取音高（%s）" % (f0_method or args["data"]["f0_extractor"]))
        f0 = bootstrap.build_f0_extractor(self.settings, args, sample_rate, hop_size, f0_method).extract(
            audio, uv_interp=True, device=device
        )
        f0 = torch.from_numpy(f0).float().to(device).unsqueeze(-1).unsqueeze(0)
        if key:
            f0 = f0 * 2 ** (float(key) / 12)

        root_vendor = bootstrap.ensure_import_path(self.settings)
        with bootstrap.vendor_paths.temporary_context(entries=[str(root_vendor)], argv=["svc"]):
            from ddsp.core import upsample  # type: ignore  # noqa: PLC0415
            from ddsp.vocoder import Volume_Extractor  # type: ignore  # noqa: PLC0415

            volume = Volume_Extractor(hop_size, win_size).extract(audio)
            mask = (volume > 10 ** (float(threshold_db) / 20)).astype("float")
            mask = upsample(
                torch.from_numpy(mask).float().to(device).unsqueeze(-1).unsqueeze(0),
                args["data"]["block_size"],
            ).squeeze(-1)
            volume = torch.from_numpy(volume).float().to(device).unsqueeze(-1).unsqueeze(0)

        segments = (
            split(audio, sample_rate, hop_size)
            if slice_segments
            else [(0, audio)]
        )
        if progress:
            progress(0.35, "分成 %d 段，开始转换" % len(segments))

        total_frames = int(f0.size(1))
        block_size = int(args["data"]["block_size"])
        result = np.zeros(int(total_frames * hop_size) + block_size, dtype=np.float32)

        spk_tensor = torch.LongTensor(np.array([[int(spk_id)]])).to(device)
        aug_shift = torch.from_numpy(np.array([[float(formant_shift)]])).float().to(device)
        # 声码器支持音域偏移才生效（config 里 h.pc_aug 存在时）
        register_factor = 1.0
        try:
            if getattr(self.vocoder.vocoder.h, "pc_aug", None):
                register_factor = 2 ** (0.0 / 12)
        except Exception:  # noqa: BLE001
            register_factor = 1.0

        t_start = preset["t_start"]
        if t_start is None:
            t_start = float(args.get("model", {}).get("t_start", 0.0) or 0.0)
        infer_step = int(preset["infer_step"])
        method = str(preset["method"])

        with torch.no_grad():
            for index, (start_frame, segment) in enumerate(segments):
                if progress:
                    progress(0.35 + 0.6 * (index + 1) / len(segments), "转换第 %d/%d 段" % (index + 1, len(segments)))
                seg_input = torch.from_numpy(segment).float().unsqueeze(0).to(device)
                seg_units = self.units_encoder.encode(seg_input, sample_rate, hop_size)
                seg_f0 = f0[:, start_frame : start_frame + seg_units.size(1), :]
                seg_volume = volume[:, start_frame : start_frame + seg_units.size(1), :]
                if seg_units.size(1) == 0:
                    continue

                seg_wav = self.model(
                    seg_units,
                    seg_f0 / register_factor,
                    seg_volume,
                    spk_id=spk_tensor,
                    spk_mix_dict=spk_mix,
                    aug_shift=aug_shift,
                    vocoder=self.vocoder,
                    infer=True,
                    return_wav=True,
                    infer_step=infer_step,
                    method=method,
                    t_start=float(t_start),
                    use_tqdm=False,
                )
                seg_wav = seg_wav * mask[
                    :,
                    start_frame * block_size : (start_frame + seg_units.size(1)) * block_size,
                ]
                chunk = seg_wav.squeeze().cpu().numpy().astype(np.float32)
                offset = int(start_frame * hop_size)
                end = min(offset + len(chunk), len(result))
                result[offset:end] = chunk[: end - offset]

        out_path = Path(out_path)
        save(out_path, result, int(args["data"]["sampling_rate"]))
        if progress:
            progress(1.0, "转换完成")
        return {
            "output": str(out_path),
            "duration": duration,
            "sample_rate": int(args["data"]["sampling_rate"]),
            "segments": len(segments),
            "model": str(self.model_path),
            "key": key,
            "quality": preset["key"],
            "infer_step": infer_step,
            "method": method,
            "t_start": float(t_start),
        }

    def models(self) -> List[Dict[str, Any]]:
        return catalog.list_models(self.settings)


__all__ = ["SvcEngine"]

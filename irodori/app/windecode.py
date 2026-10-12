"""Windows 音频解码垫片：把 `torchaudio.load` / `torchaudio.info` 换成 soundfile 实现。

## 为什么必须有它

torch ≥ 2.9 的 `torchaudio.load` **完全委托给 torchcodec**（`torchaudio._backend` 默认
`"ffmpeg"`），而 torchcodec 在 cu128 索引下**没有 Windows wheel** → 任何读参考音频的路径
直接 `ImportError`。阶段 28 实测：`prepare_manifest.py` 在 Windows 上把 16/16 个样本
**静默丢弃**、退出码 0、产出 0 字节 manifest（复现上游 issue #40）—— 这类「不报错只是跳过」
比崩溃更难查，所以垫片要在**进程启动最早期**装好，而不是等某条路径偶然踩到。

## 什么时候该删掉它

上游一旦提供「非 torchcodec 的解码路径」（例如 torchaudio 恢复 soundfile 后端、
或 torchcodec 发布 Windows wheel），本文件整体作废。删除时连带删掉
`api.py` 里的 `windecode.install()` 调用与 `/health` 的 `windecode` 字段。

## 边界（很重要）

- **只 patch 本进程**。Irodori 是独立 venv + 独立进程，全局替换出不了这个进程，
  符合 `docs/ENGINE-ISOLATION.md` 的规矩（不需要像 GPT-SoVITS 那样再开 worker）。
- **只补 torchaudio 的两个读接口**（`load` / `info`）；写接口不动 —— 我们自己的产物
  用 soundfile 直接写，不走 torchaudio。
- 非 Windows 平台默认跳过：Linux 上 torchcodec 有 wheel，不需要垫片。
  用 `IRODORI_NO_WINDECODE=1` 可显式关闭；`install(force=True)` 可强制装（给测试用）。
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Optional


def _bits_of(raw: Any) -> int:
    """从 soundfile 的 `info()` 结果里挖出位深。

    不同 soundfile 版本字段名不一样（`subtype_info` 是对象、`subtype` 是字符串），
    拿不到就返回 0 —— 上层只用它做展示，不该因为这点信息让整个 info 调用失败。
    """
    for attr in ("subtype_info", "extra_info"):
        info = getattr(raw, attr, None)
        bits = getattr(info, "bits", None) if info is not None else None
        if isinstance(bits, int):
            return bits
    subtype = str(getattr(raw, "subtype", "") or "")
    # 形如 "PCM_16" / "PCM_24" / "FLOAT" / "DOUBLE"
    if subtype.startswith("PCM_"):
        try:
            return int(subtype.split("_", 1)[1])
        except ValueError:
            return 0
    if subtype == "FLOAT":
        return 32
    if subtype == "DOUBLE":
        return 64
    return 0

#: 垫片状态（health 里回报，方便排障时一眼看出到底装没装）
_STATE: dict[str, Any] = {
    "checked": False,
    "installed": False,
    "skipped": False,
    "reason": "",
    "patched": [],
}


def status() -> dict[str, Any]:
    """给 /health 用的只读状态。"""
    return {
        "installed": bool(_STATE["installed"]),
        "skipped": bool(_STATE["skipped"]),
        "reason": str(_STATE["reason"]),
        "patched": list(_STATE["patched"]),
    }


def _disabled_by_env() -> bool:
    return (os.environ.get("IRODORI_NO_WINDECODE") or "").strip() in {"1", "true", "yes", "on"}


def install(force: bool = False) -> dict[str, Any]:
    """把 torchaudio 的读接口换成 soundfile 实现。幂等，可在 import 期安全调用。"""
    if _STATE["checked"] and not force:
        return status()

    _STATE.update({"checked": True, "installed": False, "skipped": False, "reason": "", "patched": []})

    if _disabled_by_env():
        _STATE["skipped"] = True
        _STATE["reason"] = "IRODORI_NO_WINDECODE=1，按用户要求跳过"
        return status()

    if sys.platform != "win32" and not force:
        _STATE["skipped"] = True
        _STATE["reason"] = f"平台 {sys.platform} 不是 Windows（torchcodec 在 Linux/macOS 有 wheel，无需垫片）"
        return status()

    try:
        import soundfile as sf  # noqa: F401, PLC0415
        import torch  # noqa: F401, PLC0415
        import torchaudio  # noqa: F401, PLC0415
    except Exception as error:  # pragma: no cover - 环境相关
        # 依赖没装齐时**不抛**：让服务照常起来，由 /health 如实报告。
        # 否则「缺 soundfile」会表现成启动崩溃，用户看不出缺的是哪个包。
        _STATE["reason"] = f"依赖未就绪（{type(error).__name__}: {error}）"
        return status()

    import soundfile as sf  # noqa: PLC0415
    import torch  # noqa: PLC0415
    import torchaudio  # noqa: PLC0415

    patched: list[str] = []

    # ---- torchaudio.load -------------------------------------------------
    original_load = getattr(torchaudio, "load", None)

    def _sf_load(
        uri: Any,
        frame_offset: int = 0,
        num_frames: int = -1,
        normalize: bool = True,
        channels_first: bool = True,
        format: Optional[str] = None,
        **kwargs: Any,
    ) -> tuple[Any, int]:
        """soundfile 版 `torchaudio.load`，签名与返回形状对齐官方。

        `frame_offset` / `num_frames` 直接透传给 `sf.read(start=, frames=)`，
        所以「只读前 N 秒」这种用法（参考音频截断）行为不变。
        `normalize=False` 是 torchaudio 的整数 PCM 语义，soundfile 走 float32 时
        永远归一化到 [-1, 1] —— 上游所有调用点都用默认值，这里遇到 False 就退回原实现，
        宁可让它在原路径上报错，也不静默给错量级。
        """
        target = uri
        if isinstance(uri, (str, Path)):
            target = str(uri)
        elif not hasattr(uri, "read"):
            # 非路径且非文件对象（例如 tensor / bytes 流）→ 交回原实现
            if original_load is None:
                raise RuntimeError(f"无法用 soundfile 读取该输入：{type(uri)!r}")
            return original_load(uri, frame_offset, num_frames, normalize, channels_first, format, **kwargs)
        if not normalize:
            if original_load is None:
                raise RuntimeError("normalize=False 需要原生 torchaudio 解码路径")
            return original_load(uri, frame_offset, num_frames, normalize, channels_first, format, **kwargs)

        frames = -1 if num_frames is None or num_frames < 0 else int(num_frames)
        start = int(frame_offset or 0)
        data, sample_rate = sf.read(
            target,
            start=start,
            frames=frames,
            dtype="float32",
            always_2d=True,
        )
        tensor = torch.from_numpy(data)
        if channels_first:
            tensor = tensor.transpose(0, 1)  # (frames, channels) -> (channels, frames)
        return tensor.contiguous(), int(sample_rate)

    torchaudio.load = _sf_load  # type: ignore[assignment]
    patched.append("load")

    # ---- torchaudio.info -------------------------------------------------
    original_info = getattr(torchaudio, "info", None)

    def _sf_info(uri: Any, **kwargs: Any) -> Any:
        """soundfile 版 `torchaudio.info`，返回与 torchaudio.AudioMetaData 同形的对象。

        上游用它来取时长/采样率做校验（「参考音频够不够 3 秒」）。缺了它，
        这些校验会走 torchcodec → ImportError，所以一起补。
        """
        target = str(uri) if isinstance(uri, (str, Path)) else uri
        if not isinstance(target, str):
            if original_info is None:
                raise RuntimeError(f"无法用 soundfile 探测该输入：{type(uri)!r}")
            return original_info(uri, **kwargs)
        try:
            raw = sf.info(target)
        except Exception:
            if original_info is None:
                raise
            return original_info(uri, **kwargs)

        fields = {
            "sample_rate": int(raw.samplerate),
            "num_frames": int(raw.frames),
            "num_channels": int(raw.channels),
            "bits_per_sample": _bits_of(raw),
            "encoding": str(raw.subtype or ""),
        }

        # ⚠️ `torchaudio.AudioMetaData` 是**没有默认值**的 dataclass / NamedTuple，
        # `cls()` 会直接 TypeError（第一版就这么写错了）。所以：
        # 能按字段构造就用真类（保住 `isinstance` 判断），不能就退到 SimpleNamespace
        # —— 上层实际只读 `.sample_rate` / `.num_frames` 这几个字段，鸭子类型够用。
        meta = None
        meta_cls = getattr(torchaudio, "AudioMetaData", None)
        if meta_cls is not None:
            try:
                meta = meta_cls(**fields)  # type: ignore[call-arg]
            except Exception:
                meta = None
        if meta is None:
            meta = SimpleNamespace(**fields)
        try:
            # torchaudio 把 duration 做成派生属性；NamedTuple 不可写，写不进就算了
            meta.duration = float(raw.duration)
        except Exception:
            pass
        return meta

    torchaudio.info = _sf_info  # type: ignore[assignment]
    patched.append("info")

    _STATE["installed"] = True
    _STATE["patched"] = patched
    _STATE["reason"] = "已用 soundfile 接管 torchaudio.load / torchaudio.info"
    return status()

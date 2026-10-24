# -*- coding: utf-8 -*-
"""DDSP-SVC 训练流水线（阶段 44 / P5）。

上游只有两段：`preprocess.py` → `train_reflow.py`，两者都只接受一个 `-c config.yaml`。
本模块负责把它们变成可诊断、可取消、可复用的任务：

1. **数据整备**：扫描语料 → 校验片段时长 → 按 9:1 分训练/验证 →
   在工作目录下造出上游唯一认的 `data/{train,val}/audio/` 结构；
2. **预处理**：跑 `train_preprocess.py`（薄包装，解决 embedded Python 的
   sys.path 与 rmvpe 相对路径问题）；**不信任退出码**，按 `units/` 缓存计数判定；
3. **训练**：按总步数选择存档间隔，跑 `train_entry.py`（薄包装，训练结束补存
   最终权重 —— 上游只在 interval 整数倍存档，小数据集会「跑完什么都没有」）；
4. **产物归位**：`exp/model_*.pt` + `exp/config.yaml` 一起复制到
   `models/ddsp-svc/<音色名>/`（坑 34：两者必须同目录）。

与 RVC 训练共用 `StageResult` / `_run_command`：后者在阶段 44 增加了可取消与
进程树清理，RVC 的既有调用行为不变。
"""

from __future__ import annotations

import math
import os
import re
import shutil
import sys
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

import yaml

from ..audio.io import AudioError, probe
from ..config import Settings
from ..engine import ENGINES
from ..queue import free_vram_mb
from ..vc.training import StageResult, _run_command, sanitize_name
from . import bootstrap, catalog
from .bootstrap import SvcError

STAGES = ("preprocess", "train", "save")

#: 与整合包 NSF-HiFiGAN 声码器一致的采样率（配置模板与推理侧都按 44.1k 工作）
SAMPLE_RATE = 44100
DEFAULT_EPOCHS = 200
DEFAULT_BATCH_SIZE = 8
DEFAULT_DURATION = 2.0
MIN_DURATION = 0.5
MAX_DURATION = 10.0

#: 训练语料支持的容器。上游用 librosa.load，wav/flac/mp3/ogg 都有稳定解码后端；
#: m4a 依赖 audioread/ffmpeg，保留但由 probe 失败兜底。
TRAIN_SUFFIXES = {".wav", ".flac", ".mp3", ".ogg", ".m4a"}

#: 训练输出日志里上游的每步格式：
#: `epoch: 0 |   0/  1 | <exp> | batch/s: ... | lr: ... | loss: 55.891 | time: ... | step: 1`
_TRAIN_LINE_RE = re.compile(
    r"epoch:\s*(\d+)\s*\|\s*(\d+)\s*/\s*(\d+).*?loss:\s*([0-9.]+).*?step:\s*(\d+)"
)


# --------------------------------------------------------------------------
# 请求
# --------------------------------------------------------------------------


@dataclass
class SvcTrainRequest:
    """一次 DDSP-SVC 训练请求。字段与前端表单一一对应。"""

    name: str = "my-singing-voice"
    corpus_dir: str = ""
    epochs: int = DEFAULT_EPOCHS
    batch_size: int = DEFAULT_BATCH_SIZE
    #: 训练片段时长（秒），必须小于最短音频片段
    duration: float = DEFAULT_DURATION
    f0_method: str = "rmvpe"
    amp_dtype: str = "fp16"
    #: auto / cuda / cpu；cpu 是零显存排障通道（对齐 gsv5 / R2T2 的先例）
    device: str = "auto"
    workers: int = 1
    keep_workdir: bool = False

    @property
    def clean_name(self) -> str:
        return sanitize_name(self.name, fallback="singing-voice")

    def resolved_device(self) -> str:
        raw = str(self.device or "auto").strip().lower()
        if raw == "auto":
            return "cuda" if _cuda_available() else "cpu"
        if raw not in {"cuda", "cpu"}:
            raise SvcError(
                "不支持的训练设备：%s" % self.device,
                hint="device 只能是 auto / cuda / cpu。",
                code="SVC_TRAIN_BAD_DEVICE",
            )
        if raw == "cuda" and not _cuda_available():
            raise SvcError(
                "请求了 GPU 训练，但本机 CUDA 不可用",
                hint="改用 device=cpu（会慢很多），或先检查 torch / CUDA 安装。",
                code="SVC_TRAIN_CUDA_UNAVAILABLE",
            )
        return raw

    def vram_required_mb(self) -> int:
        """本次训练请求的显存门槛（阶段 44 GPU 画像，见 `required_vram_mb()`）。"""
        return required_vram_mb(
            _coerce_int(self.batch_size, DEFAULT_BATCH_SIZE),
            _coerce_float(self.duration, DEFAULT_DURATION),
            _coerce_int(self.workers, 1),
        )

    def to_payload(self) -> Dict[str, Any]:
        """持久化到 Job.request 的形状（只含 dataclass 字段，值已归一）。"""
        return {
            "name": self.clean_name,
            "corpus_dir": self.corpus_dir,
            "epochs": _coerce_int(self.epochs, DEFAULT_EPOCHS),
            "batch_size": _coerce_int(self.batch_size, DEFAULT_BATCH_SIZE),
            "duration": _coerce_float(self.duration, DEFAULT_DURATION),
            "f0_method": self.f0_method,
            "amp_dtype": self.amp_dtype,
            "device": self.device,
            "workers": _coerce_int(self.workers, 1),
            "keep_workdir": bool(self.keep_workdir),
        }


_SvcTrainRequest = SvcTrainRequest


def request_from_payload(data: Any) -> SvcTrainRequest:
    """把前端 JSON 收成请求对象；未知字段忽略，类型错误报 400。"""
    payload = data if isinstance(data, dict) else {}
    allowed = set(SvcTrainRequest.__dataclass_fields__.keys())
    # 未知字段直接忽略：前端版本可能比后端新，不该因此让整个预检失败。
    try:
        return SvcTrainRequest(**{k: v for k, v in payload.items() if k in allowed})
    except (TypeError, ValueError) as exc:
        raise SvcError(
            "训练参数格式不合法：%s" % exc,
            hint="epochs / batch_size / duration / workers 必须是数字。",
            code="BAD_PARAM",
        )


# --------------------------------------------------------------------------
# 语料扫描与预检
# --------------------------------------------------------------------------


@dataclass
class CorpusFile:
    path: Path
    duration: float
    sample_rate: int
    channels: int

    def to_dict(self) -> Dict[str, Any]:
        return {
            "path": str(self.path),
            "duration": round(self.duration, 3),
            "sample_rate": self.sample_rate,
            "channels": self.channels,
        }


@dataclass
class CorpusScan:
    root: Path
    files: List[CorpusFile]
    invalid: List[Dict[str, str]]
    train_files: List[CorpusFile]
    val_files: List[CorpusFile]
    total_s: float = 0.0
    shortest_s: float = 0.0
    longest_s: float = 0.0
    extensions: List[str] = None  # type: ignore[assignment]

    def __post_init__(self) -> None:
        if self.extensions is None:
            self.extensions = []

    def summary(self) -> Dict[str, Any]:
        return {
            "dir": str(self.root),
            "files": len(self.files),
            "total_s": round(self.total_s, 1),
            "shortest_s": round(self.shortest_s, 2),
            "longest_s": round(self.longest_s, 2),
            "train_count": len(self.train_files),
            "val_count": len(self.val_files),
            "extensions": list(self.extensions),
            "invalid": self.invalid[:20],
        }


def scan_corpus(corpus_dir: str) -> CorpusScan:
    """递归扫描语料目录，读取每个音频的时长与采样率。"""
    raw = str(corpus_dir or "").strip()
    if not raw:
        # 注意：Path("") 是当前目录 —— 不能把「没填目录」当成「扫描仓库根」
        return CorpusScan(root=Path(""), files=[], invalid=[], train_files=[], val_files=[])
    root = Path(raw).expanduser()
    files: List[CorpusFile] = []
    invalid: List[Dict[str, str]] = []
    if not root.is_dir():
        return CorpusScan(root=root, files=[], invalid=invalid, train_files=[], val_files=[])

    try:
        candidates = sorted(root.rglob("*"), key=lambda p: str(p).casefold())
    except OSError:
        candidates = []
    for path in candidates:
        if not path.is_file() or path.suffix.lower() not in TRAIN_SUFFIXES:
            continue
        try:
            info = probe(path)
        except AudioError as exc:
            invalid.append({"path": str(path), "reason": str(exc)})
            continue
        if info.duration <= 0:
            invalid.append({"path": str(path), "reason": "时长为 0 或无法解码"})
            continue
        files.append(CorpusFile(path=path, duration=info.duration, sample_rate=info.sample_rate, channels=info.channels))

    total_s = sum(item.duration for item in files)
    shortest = min((item.duration for item in files), default=0.0)
    longest = max((item.duration for item in files), default=0.0)
    extensions = sorted({item.path.suffix.lower().lstrip(".") for item in files})

    n = len(files)
    if n == 0:
        train_files: List[CorpusFile] = []
        val_files: List[CorpusFile] = []
    elif n == 1:
        # 单文件没有独立验证集：同一份素材两边都放，并在预检里明确警告
        train_files, val_files = files[:], files[:]
    else:
        val_count = min(10, max(1, int(round(n * 0.1))))
        val_count = min(val_count, n - 1)
        val_files = files[-val_count:]
        train_files = files[:-val_count]

    return CorpusScan(
        root=root,
        files=files,
        invalid=invalid,
        train_files=train_files,
        val_files=val_files,
        total_s=total_s,
        shortest_s=shortest,
        longest_s=longest,
        extensions=extensions,
    )


def _pretrained_paths(settings: Settings) -> Dict[str, Path]:
    return {
        "rmvpe": bootstrap.resolve_pretrained(settings, "pretrain/rmvpe/model.pt"),
        "contentvec": bootstrap.resolve_pretrained(settings, "pretrain/contentvec/pytorch_model.bin"),
        "vocoder": bootstrap.resolve_pretrained(settings, "pretrain/nsf_hifigan/model"),
        "vocoder_config": bootstrap.resolve_pretrained(settings, "pretrain/nsf_hifigan/config.json"),
    }


def _f0_dependency_issue(method: str, settings: Settings) -> Optional[str]:
    """检查所选 F0 方法在本运行时是否真的可用。"""
    method = (method or "").strip().lower()
    if method == "rmvpe":
        path = _pretrained_paths(settings)["rmvpe"]
        if not path.is_file():
            return "缺少 RMVPE 权重：%s（推理与训练都依赖它）" % path
        return None
    if method in {"dio", "harvest"}:
        try:
            import pyworld  # noqa: F401, PLC0415
        except Exception:  # noqa: BLE001
            return "F0 方法 %s 需要 pyworld，但当前训练运行时导入失败" % method
        return None
    if method == "parselmouth":
        try:
            import parselmouth  # noqa: F401, PLC0415
        except Exception:  # noqa: BLE001
            return "F0 方法 parselmouth 需要 praat-parselmouth，当前运行时未安装"
        return None
    if method == "crepe":
        try:
            import torchcrepe  # noqa: F401, PLC0415
        except Exception:  # noqa: BLE001
            return "F0 方法 crepe 需要 torchcrepe，当前运行时未安装"
        return None
    if method == "fcpe":
        try:
            import torchfcpe  # noqa: F401, PLC0415
        except Exception:  # noqa: BLE001
            return "F0 方法 fcpe 需要 torchfcpe，当前运行时未安装"
        return None
    return "未知 F0 方法：%s" % method


def required_vram_mb(batch_size: int, duration: float, workers: int = 1) -> int:
    """DDSP-SVC 训练的显存门槛（按请求参数分档，坑 24/72/86 同一原则）。

    2026-10-24 GPU 实测（RTX 4060 Laptop 8GB，batch 8 × duration 2s，fp16，
    cache_device=cpu，workers=1，12 条 3.2s 素材）：整条链（预处理 + 训练 + 验证）
    峰值增量约 **1.4GB**（nvidia-smi 峰值 used 3224MB，基线 1808MB）。
    这里取 2.0GB 起步（实测 + 余量），并按 batch × 片段时长线性缩放；
    预处理 workers>1 时每个额外 worker 会各自加载 rmvpe/contentvec/vocoder，
    预留 800MB/worker。上限沿用训练引擎的 6144MB（再高会让 8GB 卡完全进不去）。
    """
    batch = max(1, int(batch_size))
    seconds = max(MIN_DURATION, float(duration))
    workers = max(1, int(workers))
    scaled = 1024 + int(48 * batch * seconds) + 800 * (workers - 1)
    return max(2048, min(ENGINES["train"].required_mb, scaled))


def preflight(settings: Settings, request: SvcTrainRequest) -> Dict[str, Any]:
    """训练前的可执行体检。返回 `{ok, issues, warnings, ...}`。"""
    issues: List[str] = []
    warnings: List[str] = []
    scan = scan_corpus(request.corpus_dir)

    epochs, epochs_ok = _coerce_int_checked(request.epochs)
    batch_size, batch_ok = _coerce_int_checked(request.batch_size)
    duration, duration_ok = _coerce_float_checked(request.duration)
    workers, workers_ok = _coerce_int_checked(request.workers)

    if not epochs_ok or epochs < 1:
        issues.append("训练轮数必须是 ≥1 的整数")
        epochs = DEFAULT_EPOCHS
    if not batch_ok or batch_size < 1:
        issues.append("批大小必须是 ≥1 的整数")
        batch_size = DEFAULT_BATCH_SIZE
    if not duration_ok:
        issues.append("训练片段时长必须是数字")
        duration = DEFAULT_DURATION
    if not workers_ok:
        workers = 1
    workers = max(1, min(4, workers))
    batch_size = min(batch_size, 64)
    if epochs > 5000:
        warnings.append("训练轮数 %d 很多，单次可能跑很久；建议先小轮数试跑。" % epochs)
    if batch_size > 16:
        warnings.append("批大小 %d 在 8GB 卡上可能吃紧；首个跑局建议 8 或更低。" % batch_size)

    if not str(request.corpus_dir or "").strip():
        issues.append("请提供语料目录")
    elif not scan.root.is_dir():
        issues.append("语料目录不存在：%s" % scan.root)
    elif not scan.files:
        issues.append("语料目录里没有可解码的音频（支持 %s）" % "、".join(sorted(TRAIN_SUFFIXES)))
    if scan.invalid:
        warnings.append("有 %d 个文件无法解码，已跳过（首个：%s）" % (len(scan.invalid), scan.invalid[0]["path"]))
    if scan.files:
        if scan.shortest_s <= MIN_DURATION:
            issues.append(
                "片段过短：最短片段 %.2fs，低于最小训练片段 %.1fs，无法训练。请补更长的素材。"
                % (scan.shortest_s, MIN_DURATION)
            )
        elif duration >= scan.shortest_s:
            suggested = max(MIN_DURATION, math.floor((scan.shortest_s - 0.05) * 10) / 10)
            issues.append(
                "片段过短：最短片段 %.2fs，训练片段时长 duration=%.1fs 必须小于它。"
                "请把 duration 降到 %.1fs 或更小，或补更长的素材。"
                % (scan.shortest_s, duration, suggested)
            )
        if scan.shortest_s < 3.0:
            warnings.append("有片段短于 3 秒，训练稳定性可能一般（建议 3~15 秒的干净干声）。")
        if scan.total_s < 300:
            warnings.append("语料总时长 %.0f 秒（约 %.1f 分钟），偏少；10 分钟以上更稳。"
                            % (scan.total_s, scan.total_s / 60.0))
        if scan.longest_s > 60:
            warnings.append("最长片段 %.0f 秒，上游会在训练时随机裁剪 2 秒窗口；切成 3~15 秒片段会更快。" % scan.longest_s)
        if len(scan.files) == 1:
            warnings.append("只有 1 个音频文件：训练集与验证集相同，指标只用于看趋势。")
        if len(scan.files) > 1000:
            warnings.append("音频文件超过 1000 个，数据缓存可能占用较多内存；将自动关闭 cache_all_data。")
        off_sr = [item for item in scan.files if item.sample_rate != SAMPLE_RATE]
        if off_sr:
            warnings.append(
                "%d 个文件不是 %dHz，预处理会重采样（较慢）。首个：%s @ %dHz"
                % (len(off_sr), SAMPLE_RATE, off_sr[0].path.name, off_sr[0].sample_rate)
            )
    if duration < MIN_DURATION:
        issues.append("训练片段时长不能小于 %.1f 秒" % MIN_DURATION)
    if duration > MAX_DURATION:
        warnings.append("训练片段时长 %.1f 秒偏长，显存与单步耗时都会上升。" % duration)

    f0_method = str(request.f0_method or "rmvpe").strip().lower()
    valid_methods = {item["key"] for item in catalog.F0_METHODS}
    if f0_method not in valid_methods:
        issues.append("未知 F0 方法：%s（可选 %s）" % (f0_method, "、".join(sorted(valid_methods))))
    else:
        dep_issue = _f0_dependency_issue(f0_method, settings)
        if dep_issue:
            issues.append(dep_issue)

    try:
        vendor = bootstrap.vendor_root(settings)
        template = vendor / "configs" / "reflow.yaml"
        if not template.is_file():
            issues.append("缺少上游训练配置模板：%s" % template)
    except SvcError as exc:
        issues.append(exc.message)

    pretrained = _pretrained_paths(settings)
    missing: List[str] = []
    if not pretrained["contentvec"].is_file():
        missing.append("ContentVec 编码器：%s" % pretrained["contentvec"])
    if not pretrained["vocoder"].is_file():
        missing.append("NSF-HiFiGAN 声码器：%s" % pretrained["vocoder"])
    if not pretrained["vocoder_config"].is_file():
        missing.append("NSF-HiFiGAN 配置：%s" % pretrained["vocoder_config"])
    if f0_method == "rmvpe" and not pretrained["rmvpe"].is_file():
        missing.append("RMVPE 权重：%s" % pretrained["rmvpe"])
    for item in missing:
        issues.append("缺少预训练权重：%s" % item)

    try:
        device = request.resolved_device()
    except SvcError as exc:
        issues.append(exc.message)
        device = "cpu"

    amp_dtype = str(request.amp_dtype or "fp16").strip().lower()
    if amp_dtype not in {"fp16", "fp32", "bf16"}:
        issues.append("amp_dtype 只能是 fp16 / fp32 / bf16")
        amp_dtype = "fp32"
    if device == "cpu" and amp_dtype != "fp32":
        warnings.append("CPU 训练已自动改用 fp32（CPU 上的 fp16/bf16 autocast 不可用或极慢）。")
        amp_dtype = "fp32"

    batches_per_epoch = max(1, int(math.ceil(max(1, len(scan.train_files)) / float(batch_size))))
    total_steps = batches_per_epoch * epochs
    interval_val = _pick_interval(total_steps)
    interval_force_save = interval_val if total_steps <= 10000 else max(interval_val, 10000)
    if total_steps > 50000:
        warnings.append("总步数 %d 很大（约 %.1f 万），单次训练可能数小时；建议先小轮数试跑。" % (total_steps, total_steps / 10000.0))

    vram_required = required_vram_mb(batch_size, duration, workers) if device == "cuda" else 0
    vram_free = free_vram_mb() if device == "cuda" else None
    vram_ok = True
    if device == "cuda" and vram_free is not None:
        need = vram_required + settings.vram_reserve_mb
        vram_ok = vram_free >= need
        if not vram_ok:
            warnings.append(
                "当前空闲显存 %d MB，低于训练门槛 %d MB（含预留）。开跑时 engines.acquire 会拒绝；"
                "先关掉占显存的程序，或改用 CPU 排障。" % (vram_free, need)
            )

    workdir = _workdir(settings, "preview", request)
    model_dir = settings.svc_models_dir / request.clean_name
    return {
        "ok": not issues,
        "issues": issues,
        "warnings": warnings,
        "device": device,
        "corpus": scan.summary(),
        "config": {
            "path": str(workdir / "config.yaml"),
            "template": "configs/reflow.yaml",
            "duration_s": round(duration, 2),
            "sample_rate": SAMPLE_RATE,
            "amp_dtype": amp_dtype,
            "f0_method": f0_method,
        },
        "steps": {
            "batches_per_epoch": batches_per_epoch,
            "total": total_steps,
            "epochs": epochs,
            "batch_size": batch_size,
            "interval_val": interval_val,
            "interval_force_save": interval_force_save,
            "workers": workers,
        },
        "pretrained": {
            "rmvpe": str(pretrained["rmvpe"]) if pretrained["rmvpe"].is_file() else None,
            "contentvec": str(pretrained["contentvec"]),
            "vocoder": str(pretrained["vocoder"]),
            "missing": missing,
        },
        "output": {"workdir": str(workdir), "model_dir": str(model_dir)},
        "vram": {"required_mb": vram_required, "free_mb": vram_free, "ok": vram_ok},
    }


def plan(settings: Settings, request: SvcTrainRequest) -> List[Dict[str, Any]]:
    """只列出会跑什么，不执行。"""
    workdir = _workdir(settings, "preview", request)
    config_path = workdir / "config.yaml"
    return [
        {
            "key": "preprocess",
            "label": "预处理：F0 / units / volume 缓存",
            "command": "train_preprocess.py -c %s" % config_path,
        },
        {
            "key": "train",
            "label": "训练：Rectified Flow（结束时补存最终权重）",
            "command": "train_entry.py -c %s" % config_path,
        },
        {
            "key": "save",
            "label": "产物归位：model_*.pt + config.yaml → models/ddsp-svc/",
            "command": "(内部实现，无子进程)",
        },
    ]


# --------------------------------------------------------------------------
# 数据整备 / 配置生成
# --------------------------------------------------------------------------


def _link_or_copy(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.link(str(src), str(dst))
    except OSError:
        shutil.copy2(str(src), str(dst))


def _place_stem(index: int, src: Path) -> str:
    stem = sanitize_name(src.stem, fallback="clip")
    return "%05d_%s%s" % (index, stem, src.suffix.lower())


def prepare_data(
    settings: Settings,
    request: SvcTrainRequest,
    scan: CorpusScan,
    workdir: Path,
    device: str,
    log: Callable[[str], None],
) -> Dict[str, Any]:
    """按上游契约铺 `data/{train,val}/audio/`，并准备 rmvpe 的相对路径链接。"""
    if not scan.train_files or not scan.val_files:
        raise SvcError(
            "没有可用的训练/验证音频",
            hint="确认语料目录里有可解码的音频，并且至少有一条。",
            code="SVC_TRAIN_CORPUS_EMPTY",
        )
    splits = {"train": scan.train_files, "val": scan.val_files}
    for split, items in splits.items():
        target = workdir / "data" / split / "audio"
        target.mkdir(parents=True, exist_ok=True)
        for index, item in enumerate(items):
            _link_or_copy(item.path, target / _place_stem(index, item.path))
        log("[数据] %s：%d 条" % ("训练集" if split == "train" else "验证集", len(items)))

    if str(request.f0_method).strip().lower() == "rmvpe":
        rmvpe_src = _pretrained_paths(settings)["rmvpe"]
        if not rmvpe_src.is_file():
            raise SvcError(
                "缺少 RMVPE 权重：%s" % rmvpe_src,
                hint="下载 RMVPE 后放到该路径；或把 F0 方法改成 harvest / dio（pyworld）。",
                code="SVC_TRAIN_RMVP_MISSING",
            )
        _link_or_copy(rmvpe_src, workdir / "pretrain" / "rmvpe" / "model.pt")
    return {"train": len(scan.train_files), "val": len(scan.val_files)}


def build_config(
    settings: Settings,
    request: SvcTrainRequest,
    scan: CorpusScan,
    workdir: Path,
    device: str,
    duration_s: float,
    amp_dtype: str,
    interval_val: int = 2000,
    interval_force_save: int = 10000,
) -> Path:
    """以 `configs/reflow.yaml` 为模板生成本次任务的绝对路径配置。"""
    try:
        template = bootstrap.vendor_root(settings) / "configs" / "reflow.yaml"
    except SvcError:
        raise
    if not template.is_file():
        raise SvcError(
            "缺少上游训练配置模板：%s" % template,
            hint="检查 vendor/ddsp-svc 是否完整；git submodule update --init vendor/ddsp-svc。",
            code="SVC_TRAIN_TEMPLATE_MISSING",
        )
    with template.open("r", encoding="utf-8") as handle:
        cfg = yaml.safe_load(handle) or {}

    pretrained = _pretrained_paths(settings)
    data = cfg.setdefault("data", {})
    data["sampling_rate"] = SAMPLE_RATE
    data["duration"] = round(float(duration_s), 3)
    data["train_path"] = str(workdir / "data" / "train")
    data["valid_path"] = str(workdir / "data" / "val")
    data["encoder_ckpt"] = str(pretrained["contentvec"])
    data["f0_extractor"] = str(request.f0_method or "rmvpe").strip().lower()
    data["extensions"] = list(scan.extensions) or ["wav"]

    cfg["device"] = device
    vocoder = cfg.setdefault("vocoder", {})
    vocoder["ckpt"] = str(pretrained["vocoder"])

    env = cfg.setdefault("env", {})
    env["expdir"] = str(workdir / "exp")
    env["gpu_id"] = 0

    train = cfg.setdefault("train", {})
    train["epochs"] = _coerce_int(request.epochs, DEFAULT_EPOCHS)
    train["batch_size"] = _coerce_int(request.batch_size, DEFAULT_BATCH_SIZE)
    train["amp_dtype"] = amp_dtype
    # Windows DataLoader 子进程会重新导入主模块；0 最稳，且本地数据量下差距不大。
    train["num_workers"] = 0
    train["cache_all_data"] = len(scan.files) <= 1000
    train["cache_device"] = "cpu"
    train["cache_fp16"] = True
    train["interval_log"] = 10
    train["interval_val"] = int(interval_val)
    train["interval_force_save"] = int(interval_force_save)

    model = cfg.setdefault("model", {})
    model["n_spk"] = 1

    path = workdir / "config.yaml"
    path.write_text(
        yaml.safe_dump(cfg, allow_unicode=True, sort_keys=False),
        encoding="utf-8",
    )
    return path


# --------------------------------------------------------------------------
# 主流程
# --------------------------------------------------------------------------


def run(
    settings: Settings,
    request: SvcTrainRequest,
    progress: Optional[Callable[[float, str], None]] = None,
    log: Optional[Callable[[str], None]] = None,
    cancelled: Optional[Callable[[], bool]] = None,
    job_id: Optional[str] = None,
) -> Dict[str, Any]:
    """跑完整条训练链。失败返回 `{ok: False, code, error, hint, stages}`。"""
    started = time.time()
    stages: List[StageResult] = []
    workdir = settings.svc_dir / "train" / (job_id or uuid.uuid4().hex[:12])
    log_path = workdir / "train.log"

    def emit(fraction: float, message: str) -> None:
        if progress:
            progress(float(fraction), message)

    def write_log(message: str) -> None:
        if log:
            log(message)
        try:
            with log_path.open("a", encoding="utf-8") as handle:
                handle.write(message.rstrip() + "\n")
        except OSError:
            pass

    def is_cancelled() -> bool:
        return bool(cancelled and cancelled())

    try:
        check = preflight(settings, request)
        if not check["ok"]:
            return {
                "ok": False,
                "code": "SVC_TRAIN_BAD_PARAM",
                "error": "训练参数不可用：%s" % "；".join(check["issues"]),
                "hint": "按预检提示修改；/v1/svc/train/plan 会给出同样的结论。",
                "stages": [],
            }

        if workdir.exists():
            shutil.rmtree(workdir, ignore_errors=True)
        workdir.mkdir(parents=True, exist_ok=True)
        write_log("[svc-train] 工作目录：%s" % workdir)

        device = check["device"]
        amp_dtype = check["config"]["amp_dtype"]
        duration_s = float(check["config"]["duration_s"])
        epochs = int(check["steps"]["epochs"])
        batch_size = int(check["steps"]["batch_size"])
        workers = int(check["steps"]["workers"])

        scan = scan_corpus(request.corpus_dir)
        emit(0.02, "准备训练数据…")
        prepare_data(settings, request, scan, workdir, device, write_log)
        config_path = build_config(
            settings,
            request,
            scan,
            workdir,
            device,
            duration_s,
            amp_dtype,
        )
        write_log("[svc-train] 配置：%s" % config_path)

        env = _subprocess_env(device)

        # ---- 预处理 ----
        preprocess_entry = Path(__file__).with_name("train_preprocess.py")
        preprocess_cmd = [
            sys.executable,
            "-u",
            str(preprocess_entry),
            "-c",
            str(config_path),
            "-d",
            device,
            "-j",
            str(workers),
        ]
        emit(0.06, "预处理：提取 F0 / units / volume 缓存…")
        write_log("[svc-train] 预处理命令：%s" % " ".join(preprocess_cmd))
        pre_started = time.time()
        code = _run_command(
            preprocess_cmd,
            cwd=workdir,
            log=write_log,
            cancelled=is_cancelled,
            env=env,
        )
        if is_cancelled():
            return _cancelled(stages, workdir)
        train_units = len(list((workdir / "data" / "train" / "units").glob("*.npy")))
        val_units = len(list((workdir / "data" / "val" / "units").glob("*.npy")))
        train_skipped = len(list((workdir / "data" / "train" / "skip").glob("*")))
        val_skipped = len(list((workdir / "data" / "val" / "skip").glob("*")))
        pitch_aug = (workdir / "data" / "train" / "pitch_aug_dict.npy").is_file() and (
            workdir / "data" / "val" / "pitch_aug_dict.npy"
        ).is_file()
        preprocess_ok = (
            code == 0
            and train_units > 0
            and val_units > 0
            and pitch_aug
            and train_units >= max(1, int(len(scan.train_files) * 0.5))
        )
        detail = "退出码 %d；训练缓存 %d 条 / 验证缓存 %d 条；跳过 %d/%d" % (
            code,
            train_units,
            val_units,
            train_skipped,
            val_skipped,
        )
        stages.append(
            StageResult(
                key="preprocess",
                label="预处理（F0 / units / volume）",
                ok=preprocess_ok,
                detail=detail,
                command=" ".join(preprocess_cmd),
                elapsed_s=time.time() - pre_started,
                outputs=[str(workdir / "data" / "train" / "units")] if train_units else [],
            )
        )
        if not preprocess_ok:
            return {
                "ok": False,
                "code": "SVC_TRAIN_PREPROCESS_EMPTY",
                "error": "预处理没有产出可用缓存（%s）" % detail,
                "hint": (
                    "常见原因：音频太短/太静、F0 提取失败、或 rmvpe 权重缺失。"
                    "先看日志 %s；也可以把 F0 方法换成 harvest / dio 再试。" % log_path
                ),
                "stages": [item.to_dict() for item in stages],
                "workdir": str(workdir),
            }
        if train_skipped or val_skipped:
            write_log("[svc-train] 警告：有片段在 F0 提取阶段被跳过（训练 %d / 验证 %d）" % (train_skipped, val_skipped))
        emit(0.28, "预处理完成：训练 %d 条 / 验证 %d 条" % (train_units, val_units))

        # ---- 按实际缓存条数重算步数与存档间隔 ----
        batches_per_epoch = max(1, int(math.ceil(train_units / float(batch_size))))
        total_steps = batches_per_epoch * epochs
        interval_val = _pick_interval(total_steps)
        interval_force_save = interval_val if total_steps <= 10000 else max(interval_val, 10000)
        # 小数据集总步数很少时，interval_log=10 会导致「一步日志都没有」，
        # 界面永远停在「训练中」。按总步数选一个能给出约 20~50 条日志的间隔。
        interval_log = 1 if total_steps <= 50 else (5 if total_steps <= 500 else 10)
        _rewrite_interval(config_path, interval_val, interval_force_save, interval_log)
        write_log(
            "[svc-train] 训练计划：%d batch/epoch × %d epoch = %d steps；每 %d 步验证/存档，每 %d 步记录日志"
            % (batches_per_epoch, epochs, total_steps, interval_val, interval_log)
        )

        # ---- 训练 ----
        train_entry = Path(__file__).with_name("train_entry.py")
        train_cmd = [sys.executable, "-u", str(train_entry), "-c", str(config_path)]
        write_log("[svc-train] 训练命令：%s" % " ".join(train_cmd))
        emit(0.3, "训练中…")
        train_started = time.time()
        state: Dict[str, Any] = {"step": 0, "epoch": 0, "loss": None}

        def train_log(line: str) -> None:
            write_log(line)
            hit = _TRAIN_LINE_RE.search(line)
            if hit:
                try:
                    epoch = int(hit.group(1))
                    batch = int(hit.group(2))
                    num_batches = int(hit.group(3))
                    loss = float(hit.group(4))
                    step = int(hit.group(5))
                except (TypeError, ValueError):
                    return
                state.update({"step": step, "epoch": epoch, "loss": loss})
                fraction = 0.3 + 0.62 * min(step / float(max(total_steps, 1)), 1.0)
                emit(
                    fraction,
                    "训练 第 %d/%d 轮 · %d/%d batch · loss %.3f · step %d/%d"
                    % (epoch + 1, epochs, batch + 1, num_batches, loss, step, total_steps),
                )

        code = _run_command(
            train_cmd,
            cwd=workdir,
            log=train_log,
            cancelled=is_cancelled,
            env=env,
        )
        if is_cancelled():
            return _cancelled(stages, workdir)
        exp_dir = workdir / "exp"
        latest = _latest_checkpoint(exp_dir)
        train_ok = code == 0 and latest is not None
        stages.append(
            StageResult(
                key="train",
                label="训练（Rectified Flow）",
                ok=train_ok,
                detail="退出码 %d；跑完 %d/%d 步%s"
                % (
                    code,
                    state["step"],
                    total_steps,
                    "" if latest is None else "；最新权重 %s" % latest.name,
                ),
                command=" ".join(train_cmd),
                elapsed_s=time.time() - train_started,
                outputs=[str(latest)] if latest else [],
            )
        )
        if not train_ok:
            if latest is None:
                hint = (
                    "训练进程结束但没有 model_*.pt。先看日志 %s；"
                    "若日志里是显存不足，把 batch 降到 2~4 或先用 CPU 排障。" % log_path
                )
            else:
                hint = "训练退出码非 0，但已有中间权重：%s。先看日志 %s。" % (latest, log_path)
            return {
                "ok": False,
                "code": "SVC_TRAIN_FAILED",
                "error": "训练未成功完成（退出码 %d）" % code,
                "hint": hint,
                "stages": [item.to_dict() for item in stages],
                "workdir": str(workdir),
            }

        # ---- 产物归位 ----
        emit(0.95, "产物归位…")
        save_started = time.time()
        model_dir = settings.svc_models_dir / request.clean_name
        model_dir.mkdir(parents=True, exist_ok=True)
        for old in list(model_dir.glob("*.pt")) + [model_dir / "config.yaml"]:
            if old.is_file():
                old.unlink()
        model_dst = model_dir / latest.name
        shutil.copy2(str(latest), str(model_dst))
        config_src = exp_dir / "config.yaml"
        if not config_src.is_file():
            config_src = config_path
            write_log("[svc-train] 警告：exp 下没有 saver dump 的 config.yaml，改用生成配置")
        config_dst = model_dir / "config.yaml"
        shutil.copy2(str(config_src), str(config_dst))
        save_ok = model_dst.is_file() and config_dst.is_file()
        stages.append(
            StageResult(
                key="save",
                label="产物归位（model_*.pt + config.yaml）",
                ok=save_ok,
                detail="%s（%.1f MB）+ config.yaml" % (model_dst.name, model_dst.stat().st_size / 1024 / 1024),
                elapsed_s=time.time() - save_started,
                outputs=[str(model_dst), str(config_dst)],
            )
        )
        if not save_ok:
            return {
                "ok": False,
                "code": "SVC_TRAIN_SAVE_FAILED",
                "error": "产物复制失败：%s" % model_dir,
                "hint": "检查目录权限与磁盘空间；中间权重仍在 %s。" % exp_dir,
                "stages": [item.to_dict() for item in stages],
                "workdir": str(workdir),
            }

        artifacts = [
            {
                "key": "model",
                "label": "%s（DDSP-SVC 模型）" % request.clean_name,
                "path": str(model_dst),
                "size_mb": round(model_dst.stat().st_size / 1024 / 1024, 1),
                "kind": "model",
            },
            {
                "key": "config",
                "label": "%s（训练配置 config.yaml）" % request.clean_name,
                "path": str(config_dst),
                "size_mb": round(config_dst.stat().st_size / 1024 / 1024, 3),
                "kind": "config",
            },
        ]
        if not request.keep_workdir:
            shutil.rmtree(workdir, ignore_errors=True)
        emit(1.0, "训练完成")
        return {
            "ok": True,
            "name": request.clean_name,
            "mode": "ddsp-svc",
            "device": device,
            "sample_rate": SAMPLE_RATE,
            "f0_method": str(request.f0_method or "rmvpe").strip().lower(),
            "model": str(model_dst),
            "config": str(config_dst),
            "artifacts": artifacts,
            "stages": [item.to_dict() for item in stages],
            "steps": {
                "batches_per_epoch": batches_per_epoch,
                "total": total_steps,
                "epochs": epochs,
                "batch_size": batch_size,
                "interval_val": interval_val,
                "interval_force_save": interval_force_save,
                "completed": state["step"],
            },
            "corpus": scan.summary(),
            "elapsed_s": round(time.time() - started, 1),
            "workdir": str(workdir) if request.keep_workdir else None,
        }
    except SvcError as exc:
        return {
            "ok": False,
            "code": exc.code,
            "error": exc.message,
            "hint": exc.hint,
            "stages": [item.to_dict() for item in stages],
            "workdir": str(workdir),
        }
    except Exception as exc:  # noqa: BLE001
        return {
            "ok": False,
            "code": "SVC_TRAIN_FAILED",
            "error": "%s: %s" % (type(exc).__name__, exc),
            "hint": "未预期的失败；完整日志：%s" % log_path,
            "stages": [item.to_dict() for item in stages],
            "workdir": str(workdir),
        }


# --------------------------------------------------------------------------
# 小工具
# --------------------------------------------------------------------------


def _workdir(settings: Settings, tag: str, request: SvcTrainRequest) -> Path:
    safe = request.clean_name if tag == "preview" else tag
    return settings.svc_dir / "train" / safe


def _subprocess_env(device: str) -> Dict[str, str]:
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUNBUFFERED"] = "1"
    if device == "cpu":
        # 上游 rmvpe 的 infer_from_audio 在 device=None 时会自己挑 CUDA；
        # CPU 排障通道必须把 GPU 彻底隐藏，否则「零显存」不成立。
        env["CUDA_VISIBLE_DEVICES"] = ""
        # 同时让预处理包装器给 torch.load 补 map_location='cpu'（权重是 CUDA 张量）
        env["SVC_PREPROCESS_CPU"] = "1"
    return env


def _pick_interval(total_steps: int) -> int:
    """选一个能整除总步数、且不超过 2000 的验证/存档间隔。"""
    total_steps = max(1, int(total_steps))
    if total_steps <= 2000:
        return total_steps
    for candidate in range(2000, 0, -1):
        if total_steps % candidate == 0:
            return candidate
    return total_steps


def _rewrite_interval(
    config_path: Path,
    interval_val: int,
    interval_force_save: int,
    interval_log: int = 10,
) -> None:
    with config_path.open("r", encoding="utf-8") as handle:
        cfg = yaml.safe_load(handle) or {}
    train = cfg.setdefault("train", {})
    train["interval_val"] = int(interval_val)
    train["interval_force_save"] = int(interval_force_save)
    train["interval_log"] = int(interval_log)
    config_path.write_text(
        yaml.safe_dump(cfg, allow_unicode=True, sort_keys=False),
        encoding="utf-8",
    )


def _latest_checkpoint(exp_dir: Path) -> Optional[Path]:
    items: List[Tuple[int, float, Path]] = []
    for path in exp_dir.glob("model_*.pt"):
        hit = re.search(r"model_(\d+)\.pt$", path.name)
        step = int(hit.group(1)) if hit else -1
        try:
            mtime = path.stat().st_mtime
        except OSError:
            continue
        items.append((step, mtime, path))
    if not items:
        return None
    return max(items, key=lambda item: (item[0], item[1]))[2]


def _cancelled(stages: List[StageResult], workdir: Path) -> Dict[str, Any]:
    return {
        "ok": False,
        "cancelled": True,
        "error": "训练已取消",
        "stages": [item.to_dict() for item in stages],
        "workdir": str(workdir),
    }


def _cuda_available() -> bool:
    try:
        import torch  # noqa: PLC0415

        return bool(torch.cuda.is_available())
    except Exception:  # noqa: BLE001
        return False


def _coerce_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return int(default)


def _coerce_int_checked(value: Any) -> Tuple[int, bool]:
    try:
        return int(value), True
    except (TypeError, ValueError):
        return 0, False


def _coerce_float(value: Any, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return float(default)


def _coerce_float_checked(value: Any) -> Tuple[float, bool]:
    try:
        return float(value), True
    except (TypeError, ValueError):
        return 0.0, False

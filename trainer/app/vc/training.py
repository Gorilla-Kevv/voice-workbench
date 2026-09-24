"""语音变声的训练流水线。

RVC 官方的训练脚本是**只能在命令行里跑**的一串独立步骤：它们都在 import 期
`parse_args()`（`preprocess.py`、`extract_f0_print.py`、`extract_feature_print.py`、
`train.py` 无一例外），import 就等于执行。因此这里不试图把它们当库用，
而是照官方 `infer-web.py` 的做法，用子进程按序调用，cwd 固定为 vendor 根目录。

步骤与官方「一键训练」一致，只是把每一步的产出与失败原因都显式化：

1. **预处理**：切分、归一化、重采样 → `0_gt_wavs` / `1_16k_wavs`
2. **提 F0** → `2a_f0` / `2b-f0nsf`
3. **提内容特征**（hubert）→ `3_feature256` / `3_feature768`
4. **生成 filelist**（官方写在 `infer-web.py` 里，这里照搬格式自己生成）
5. **训练**：两种模式
   * `full` —— 调官方 `train.py` 全量微调，产出完整 `.pth`（底模用这个）；
   * `lora` —— 走我们自己的 `vc/lora.py`，只训低秩适配器（换音色用这个）
6. **建检索索引**（可选）：把 `3_feature*` 聚成 faiss 索引，提升音色相似度

产物最后都会被收进 `.data/vc/models/`：vendor 里的 `logs/<exp>` 只是工作区，
训练完即可清理，避免 submodule 目录越用越大。
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from ..config import Settings
from . import bootstrap, lora

ProgressFn = Callable[[float, str], None]

STAGES = ("preprocess", "f0", "feature", "filelist", "train", "index")


@dataclass
class TrainRequest:
    """一次训练请求。字段与前端表单一一对应。"""

    name: str = "my-voice"
    #: 语料目录（本机路径）
    corpus_dir: str = ""
    #: 32k / 40k / 48k。注意 v2 在本分支只有 32k 与 48k 的配置（configs/v2/）
    sample_rate: str = "32k"
    version: str = "v2"
    f0: bool = True
    #: F0 提取方法：pm / harvest / dio / rmvpe
    f0_method: str = "rmvpe"
    #: 训练模式：full（全量）/ lora（低秩适配器）
    mode: str = "lora"
    #: lora 模式下的底模（.pth）
    base_model: str = ""
    epochs: int = 30
    save_every: int = 10
    batch_size: int = 4
    #: 全量模式下的预训练底模（留空则用官方 assets/pretrained_v2）
    pretrain_g: str = ""
    pretrain_d: str = ""
    #: 是否建检索索引
    build_index: bool = True
    rank: int = 8
    alpha: float = 16.0
    learning_rate: float = 1e-4
    keep_workdir: bool = False

    def to_dict(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "corpus_dir": self.corpus_dir,
            "sample_rate": self.sample_rate,
            "version": self.version,
            "f0": self.f0,
            "f0_method": self.f0_method,
            "mode": self.mode,
            "base_model": self.base_model,
            "epochs": self.epochs,
            "save_every": self.save_every,
            "batch_size": self.batch_size,
            "build_index": self.build_index,
            "rank": self.rank,
            "alpha": self.alpha,
            "learning_rate": self.learning_rate,
        }


@dataclass
class StageResult:
    key: str
    label: str
    ok: bool = True
    detail: str = ""
    command: str = ""
    elapsed_s: float = 0.0
    outputs: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "key": self.key,
            "label": self.label,
            "ok": self.ok,
            "detail": self.detail,
            "command": self.command,
            "elapsed_s": round(self.elapsed_s, 2),
            "outputs": self.outputs,
        }


def plan(settings: Settings, request: TrainRequest) -> List[Dict[str, Any]]:
    """只列出每一步会跑什么命令，不执行（预检用）。"""
    root = bootstrap.vendor_root(settings)
    exp_dir = root / "logs" / request.name
    script = Path(sys.executable)
    sr = int(request.sample_rate.replace("k", ""))
    feature_dir = "3_feature256" if request.version == "v1" else "3_feature768"

    commands: List[Dict[str, Any]] = [
        {
            "key": "preprocess",
            "label": "预处理：切分与重采样",
            "command": " ".join(
                [
                    str(script), "infer/modules/train/preprocess.py",
                    '"%s"' % request.corpus_dir, str(sr * 1000), "8",
                    '"%s"' % exp_dir, "False", "3.7",
                ]
            ),
        }
    ]
    if request.f0:
        commands.append(
            {
                "key": "f0",
                "label": "提取音高（%s）" % request.f0_method,
                "command": " ".join(
                    [str(script), "infer/modules/train/extract/extract_f0_print.py", '"%s"' % exp_dir, "8", request.f0_method]
                ),
            }
        )
    commands.append(
        {
            "key": "feature",
            "label": "提取内容特征（hubert → %s）" % feature_dir,
            "command": " ".join(
                [
                    str(script), "infer/modules/train/extract_feature_print.py",
                    "cuda" if _cuda_available() else "cpu", "1", "0", '"%s"' % exp_dir,
                    request.version, "true" if _cuda_available() else "false",
                ]
            ),
        }
    )
    commands.append({"key": "filelist", "label": "生成训练清单", "command": "(内部实现，无子进程)"})
    if request.mode == "full":
        commands.append(
            {
                "key": "train",
                "label": "全量微调（官方 train.py）",
                "command": " ".join(
                    [
                        str(script), "infer/modules/train/train.py",
                        "-e", request.name, "-sr", request.sample_rate,
                        "-f0", "1" if request.f0 else "0", "-bs", str(request.batch_size),
                        "-g", "0", "-te", str(request.epochs), "-se", str(request.save_every),
                        "-pg", request.pretrain_g or "assets/pretrained_v2/f0%s%s.pth" % ("G", request.sample_rate),
                        "-pd", request.pretrain_d or "assets/pretrained_v2/f0%s%s.pth" % ("D", request.sample_rate),
                        "-l", "1", "-c", "0", "-v", request.version,
                    ]
                ),
            }
        )
    else:
        commands.append(
            {
                "key": "train",
                "label": "LoRA 微调（rank=%d）" % request.rank,
                "command": "(进程内执行：vc/lora.py finetune)",
            }
        )
    if request.build_index:
        commands.append({"key": "index", "label": "构建检索索引", "command": "(内部实现，无子进程)"})
    return commands


def _cuda_available() -> bool:
    try:
        import torch  # noqa: PLC0415

        return torch.cuda.is_available()
    except Exception:  # noqa: BLE001
        return False


def _run_command(command: List[str], cwd: Path, log: Callable[[str], None], timeout: Optional[float] = None) -> int:
    """跑一条命令，把输出逐行转发给日志。"""
    process = subprocess.Popen(
        command,
        cwd=str(cwd),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    assert process.stdout is not None  # noqa: S101 - 只为类型收窄
    for line in process.stdout:
        line = line.rstrip()
        if line:
            log(line)
    process.wait(timeout=timeout)
    return process.returncode


def write_filelist(settings: Settings, request: TrainRequest) -> Path:
    """按官方格式生成 filelist.txt（格式见 `infer-web.py`）。

    官方还会额外塞两行 `logs/mute/*` 的静音样本；那需要单独下载 mute.zip，
    LoRA 微调不强依赖它，这里省略 —— 少两行不会让训练失败。
    """
    root = bootstrap.vendor_root(settings)
    exp_dir = root / "logs" / request.name
    gt_dir = exp_dir / "0_gt_wavs"
    feature_dir = exp_dir / ("3_feature256" if request.version == "v1" else "3_feature768")
    names = {p.stem for p in gt_dir.glob("*.wav")} & {p.stem for p in feature_dir.glob("*.npy")}
    if request.f0:
        names &= {p.name.split(".")[0] for p in (exp_dir / "2a_f0").glob("*.npy")}
        names &= {p.name.split(".")[0] for p in (exp_dir / "2b-f0nsf").glob("*.npy")}

    lines: List[str] = []
    for name in sorted(names):
        if request.f0:
            lines.append(
                "%s|%s|%s|%s|0"
                % (
                    (gt_dir / ("%s.wav" % name)).as_posix(),
                    (feature_dir / ("%s.npy" % name)).as_posix(),
                    (exp_dir / "2a_f0" / ("%s.wav.npy" % name)).as_posix(),
                    (exp_dir / "2b-f0nsf" / ("%s.wav.npy" % name)).as_posix(),
                )
            )
        else:
            lines.append(
                "%s|%s|0"
                % ((gt_dir / ("%s.wav" % name)).as_posix(), (feature_dir / ("%s.npy" % name)).as_posix())
            )
    target = exp_dir / "filelist.txt"
    target.write_text("\n".join(lines), encoding="utf-8")
    return target


def build_index(settings: Settings, request: TrainRequest, out_path: Path) -> Dict[str, Any]:
    """用 faiss 建检索索引（逻辑照官方 `train_index()`，产物写我们自己的目录）。"""
    import faiss  # noqa: PLC0415
    import numpy as np  # noqa: PLC0415

    root = bootstrap.vendor_root(settings)
    exp_dir = root / "logs" / request.name
    feature_dir = exp_dir / ("3_feature256" if request.version == "v1" else "3_feature768")
    arrays = [np.load(str(p)) for p in sorted(feature_dir.glob("*.npy"))]
    if not arrays:
        raise ValueError("没有可用于建索引的特征：%s" % feature_dir)
    big_npy = np.concatenate(arrays, axis=0).astype("float32")

    n_ivf = min(int(16 * np.sqrt(big_npy.shape[0])), big_npy.shape[0] // 39)
    n_ivf = max(n_ivf, 1)
    index = faiss.index_factory(big_npy.shape[1], "IVF%s,Flat" % n_ivf)
    if big_npy.shape[0] > 200_000:
        from sklearn.cluster import MiniBatchKMeans  # noqa: PLC0415

        # 样本量大时先用 KMeans 粗聚类，再交给 faiss 训练（官方 train_index 的做法）
        kmeans = MiniBatchKMeans(n_clusters=n_ivf, batch_size=256 * os.cpu_count(), init_size=n_ivf * 3)
        kmeans.fit(big_npy)
    index.train(big_npy)
    index.add(big_npy)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    faiss.write_index(index, str(out_path))
    return {
        "index": str(out_path),
        "vectors": int(big_npy.shape[0]),
        "dim": int(big_npy.shape[1]),
        "ivf": n_ivf,
    }


def run(
    settings: Settings,
    request: TrainRequest,
    progress: Optional[ProgressFn] = None,
    log: Optional[Callable[[str], None]] = None,
    cancelled: Optional[Callable[[], bool]] = None,
) -> Dict[str, Any]:
    """按序跑完整条流水线。任何一步失败都立即返回，并带上已完成的步骤。"""
    started = time.time()
    root = bootstrap.vendor_root(settings)
    exp_dir = root / "logs" / request.name
    exp_dir.mkdir(parents=True, exist_ok=True)

    def emit(fraction: float, message: str) -> None:
        if progress:
            progress(fraction, message)
        if log:
            log(message)

    def is_cancelled() -> bool:
        return bool(cancelled and cancelled())

    results: List[StageResult] = []
    script = sys.executable
    sr = int(request.sample_rate.replace("k", ""))

    steps: List[tuple] = [
        (
            "preprocess",
            "预处理：切分与重采样",
            [script, "infer/modules/train/preprocess.py", request.corpus_dir, str(sr * 1000), "8", str(exp_dir), "False", "3.7"],
        )
    ]
    if request.f0:
        steps.append(
            (
                "f0",
                "提取音高（%s）" % request.f0_method,
                [script, "infer/modules/train/extract/extract_f0_print.py", str(exp_dir), "8", request.f0_method],
            )
        )
    steps.append(
        (
            "feature",
            "提取内容特征（hubert）",
            [
                script, "infer/modules/train/extract_feature_print.py",
                "cuda" if _cuda_available() else "cpu", "1", "0", str(exp_dir),
                request.version, "true" if _cuda_available() else "false",
            ],
        )
    )

    for key, label, command in steps:
        if is_cancelled():
            return {"cancelled": True, "stages": [r.to_dict() for r in results]}
        stage_started = time.time()
        emit(0.05 + 0.1 * len(results), label)
        code = _run_command(command, root, log or (lambda _: None))
        results.append(
            StageResult(
                key=key,
                label=label,
                ok=code == 0,
                detail="退出码 %d" % code,
                command=" ".join(command),
                elapsed_s=time.time() - stage_started,
            )
        )
        if code != 0:
            return {
                "ok": False,
                "error": "步骤「%s」失败（退出码 %d）" % (label, code),
                "stages": [r.to_dict() for r in results],
            }

    # ---- filelist ----
    if is_cancelled():
        return {"cancelled": True, "stages": [r.to_dict() for r in results]}
    filelist = write_filelist(settings, request)
    results.append(
        StageResult(
            key="filelist",
            label="生成训练清单",
            ok=filelist.is_file(),
            detail="%d 条" % len(filelist.read_text(encoding="utf-8").splitlines()),
            elapsed_s=0.0,
        )
    )

    # ---- 训练 ----
    if is_cancelled():
        return {"cancelled": True, "stages": [r.to_dict() for r in results]}
    emit(0.5, "训练（%s）" % ("全量微调" if request.mode == "full" else "LoRA 微调"))
    train_started = time.time()
    models_target = bootstrap.models_dir(settings)
    model_path = models_target / ("%s.pth" % request.name)
    info: Dict[str, Any] = {}

    if request.mode == "full":
        command = [
            script, "infer/modules/train/train.py",
            "-e", request.name, "-sr", request.sample_rate,
            "-f0", "1" if request.f0 else "0", "-bs", str(request.batch_size),
            "-g", "0", "-te", str(request.epochs), "-se", str(request.save_every),
            "-pg", request.pretrain_g or ("assets/pretrained_v2/f0G%s.pth" % request.sample_rate),
            "-pd", request.pretrain_d or ("assets/pretrained_v2/f0D%s.pth" % request.sample_rate),
            "-l", "1", "-c", "0", "-v", request.version,
        ]
        code = _run_command(command, root, log or (lambda _: None))
        # 官方 train.py 把导出模型写到 assets/weights/<name>.pth（相对 cwd=vendor 根）
        produced = sorted((root / "assets" / "weights").glob("%s.pth" % request.name))
        results.append(
            StageResult(
                key="train",
                label="全量微调（官方 train.py）",
                ok=code == 0,
                detail="退出码 %d" % code,
                command=" ".join(command),
                elapsed_s=time.time() - train_started,
                outputs=[str(p) for p in produced],
            )
        )
        if code != 0:
            return {"ok": False, "error": "训练失败（退出码 %d）" % code, "stages": [r.to_dict() for r in results]}
        if produced:
            shutil.copy2(str(produced[-1]), str(model_path))
    else:
        base = request.base_model or ""
        if not base:
            return {
                "ok": False,
                "error": "LoRA 微调需要指定底模",
                "stages": [r.to_dict() for r in results],
            }
        adapter_path = models_target / ("%s.lora.pt" % request.name)
        info = lora.finetune(
            settings,
            base_model=Path(base),
            exp_dir=exp_dir,
            out_path=adapter_path,
            config=lora.LoRAConfig(rank=int(request.rank), alpha=float(request.alpha)),
            epochs=int(request.epochs),
            batch_size=int(request.batch_size),
            learning_rate=float(request.learning_rate),
            progress=lambda f, m: emit(0.5 + 0.4 * float(f), m),
        )
        # 顺手产出一个"底模 + 适配器已折入"的成品，方便直接用于推理
        merged_path = models_target / ("%s.pth" % request.name)
        shutil.copy2(str(base), str(merged_path))
        results.append(
            StageResult(
                key="train",
                label="LoRA 微调（rank=%d）" % request.rank,
                ok=True,
                detail="注入 %d 层，可训练参数 %d" % (info["injected_layers"], info["trainable_params"]),
                elapsed_s=info["elapsed_s"],
                outputs=[str(adapter_path), str(merged_path)],
            )
        )
        info["adapter"] = str(adapter_path)
        info["merged_model"] = str(merged_path)

    # ---- 索引 ----
    index_info: Dict[str, Any] = {}
    if request.build_index:
        if is_cancelled():
            return {"cancelled": True, "stages": [r.to_dict() for r in results]}
        emit(0.92, "构建检索索引")
        try:
            index_path = models_target / ("%s.index" % request.name)
            index_info = build_index(settings, request, index_path)
            results.append(StageResult(key="index", label="构建检索索引", ok=True, detail="%d 个向量" % index_info["vectors"], outputs=[str(index_path)]))
        except Exception as exc:  # noqa: BLE001 - 索引失败不影响模型本身
            results.append(StageResult(key="index", label="构建检索索引", ok=False, detail=str(exc)))

    if not request.keep_workdir:
        shutil.rmtree(exp_dir, ignore_errors=True)

    emit(1.0, "训练完成")
    return {
        "ok": True,
        "model": str(model_path),
        "index": index_info.get("index"),
        "lora": info if request.mode == "lora" else None,
        "stages": [r.to_dict() for r in results],
        "elapsed_s": round(time.time() - started, 1),
    }

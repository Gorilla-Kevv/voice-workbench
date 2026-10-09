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
import re
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

#: 文件名里不允许出现的字符（Windows 保留字 + 路径分隔符 + 控制字符）
_UNSAFE_NAME_RE = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
#: Windows 保留设备名，作为文件名会直接失败
_RESERVED_NAMES = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}


def sanitize_name(raw: str, fallback: str = "voice") -> str:
    """把用户填的音色名规范成安全的文件名。

    「支持用户手动命名」的前提是这个名字要能安全地变成磁盘上的文件名：
    空格保留（可读性），盘符/路径分隔符/通配符全部换成 `_`，
    首尾的空白与点去掉（Windows 不允许结尾是点），空串回落到 fallback。
    保留中文 —— 用户多半会用中文命名自己的音色。
    """
    name = _UNSAFE_NAME_RE.sub("_", (raw or "").strip())
    name = name.strip(" .")
    # 折叠连续下划线，避免 `a___b` 这种噪声
    name = re.sub(r"_{2,}", "_", name)
    if not name:
        return fallback
    if name.upper() in _RESERVED_NAMES:
        return "%s_%s" % (name, fallback)
    return name[:64]


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
    #: 全量模式下的预训练底模（留空则按官方口径在 assets/ 下自动挑）
    pretrain_g: str = ""
    pretrain_d: str = ""
    #: 官方 train.py 的 `-sw`：每个存档点都单独存一份权重（官方 WebUI 的可选项，默认开）
    save_every_weights: bool = True
    #: 官方 train.py 的 `-l`：只保留「最新」一份权重（官方 WebUI 的可选项，默认开）
    if_latest: bool = True
    #: 官方 train.py 的 `-c`：把数据集缓存进显存（快但吃显存，8GB 卡上默认关）
    if_cache_gpu: bool = False
    #: 是否建检索索引
    build_index: bool = True
    rank: int = 8
    alpha: float = 16.0
    learning_rate: float = 1e-4
    keep_workdir: bool = False

    @property
    def clean_name(self) -> str:
        """规范化后的音色名（安全文件名）。所有落盘路径都用它，绝不用原始 `name`。"""
        return sanitize_name(self.name)

    @property
    def sample_rate_hz(self) -> int:
        """采样率的赫兹整数。容忍三种写法：`"40k"` / `"40000"` / `40000`。

        调用方（脚本、curl、旧版前端）给过来的可能是裸整数 40000 而不带 `k`，
        早先直接 `request.sample_rate.replace("k","")` 遇到 int 会 `AttributeError`
        → 端点 500（2026-10 实测）。这里做一次归一，别再让调用方猜格式。
        """
        raw = str(self.sample_rate or "").strip().lower()
        if raw.endswith("k"):
            return int(float(raw[:-1]) * 1000)
        return int(float(raw)) if raw else 32000

    @property
    def version_tag(self) -> str:
        """按采样率推出 RVC 的特征目录前缀（v1 是 256 维，v2 是 768 维）。"""
        return "v1" if str(self.version).strip().lower() == "v1" else "v2"

    @property
    def sample_rate_tag(self) -> str:
        """采样率的 `32k` 写法。

        官方脚本（`train.py` 的 `-sr`、底模文件名、config 文件名）一律认这种写法，
        而调用方可能传 `40000` / `"40000"` / `"40k"` —— 直接把原值拼进命令会
        找不到 `f0G40000.pth` 这种不存在的文件。统一从这里取。
        """
        hz = self.sample_rate_hz
        return "%dk" % (hz // 1000) if hz % 1000 == 0 else str(hz)

    def to_dict(self) -> Dict[str, Any]:
        return {
            # 回显 clean_name 而不是原始 name：前端拿这个字典直接展示「本次训练会落盘成什么」，
            # 若回显原始 name，用户会看到 `测试/非法:名字*`，随后产物却是 `测试_非法_名字_`，
            # 两边对不上（2026-10 验收时抓到的展示不一致）。
            "name": self.clean_name,
            "raw_name": self.name,
            "corpus_dir": self.corpus_dir,
            "sample_rate": self.sample_rate,
            "sample_rate_hz": self.sample_rate_hz,
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
            "save_every_weights": self.save_every_weights,
            "if_latest": self.if_latest,
            "if_cache_gpu": self.if_cache_gpu,
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
    exp_dir = root / "logs" / request.clean_name
    script = Path(sys.executable)
    sr = request.sample_rate_hz
    feature_dir = "3_feature256" if request.version_tag == "v1" else "3_feature768"

    commands: List[Dict[str, Any]] = [
        {
            "key": "preprocess",

            "label": "预处理：切分与重采样",
            "command": " ".join(
                [
                    str(script), "infer/modules/train/preprocess.py",
                    # 这里必须是**赫兹整数**：官方 preprocess.py 直接 `int(sys.argv[2])`，
                    # 传 `32k` 会 ValueError（plan 里此前就传的是原始字符串）。
                    '"%s"' % request.corpus_dir, str(sr), "8",
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
    # 官方在训练前会写 `logs/<exp>/config.json`；`train.py::get_hparams()` 无条件读它，
    # 缺了就是 FileNotFoundError。这一步改前完全没有 —— `full` 模式必挂（G3）。
    commands.append(
        {
            "key": "config",
            "label": "生成训练配置 config.json（configs/%s）"
            % official_config_rel(request.version_tag, request.sample_rate_tag),
            "command": "(内部实现，无子进程)",
        }
    )
    if request.mode == "full":
        command, _pre = build_train_command(settings, request)
        commands.append({"key": "train", "label": "全量微调（官方 train.py）", "command": " ".join(command)})
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


# --------------------------------------------------------------------------
# 与官方 RVC WebUI 对齐的三件事：config.json、底模、参数（阶段 29 / T1 + T2）
#
# 改前 `full`（全量微调）这条路径**根本跑不通**，三个独立的失败点：
#   G2 底模 `assets/pretrained_v2/f0G32k.pth` 本机没有（只有 40k）；
#   G3 `train.py::get_hparams()` 无条件读 `logs/<exp>/config.json`，而我们从不生成；
#   G4 官方命令里的 `-sw`（每存档点存权重）我们没传，`-l` / `-c` 被写死。
# 下面这三组函数把「官方怎么挑」原样落地，plan 与 run 共用，避免两处漂移。
# --------------------------------------------------------------------------

#: 官方 `infer-web.py:555` 的规则：v1 或 40k → v1 配置，其余 → v2 配置
def official_config_rel(version_tag: str, sr_tag: str) -> str:
    return "v1/%s.json" % sr_tag if (version_tag == "v1" or sr_tag == "40k") else "v2/%s.json" % sr_tag


#: 各版本实际支持的采样率（照 `vendor/rvc/configs/` 下真实存在的文件）
ALLOWED_COMBOS: Dict[str, set] = {"v1": {"32k", "40k", "48k"}, "v2": {"32k", "48k"}}


def available_pretrained(root: Path) -> List[str]:
    """磁盘上真实存在的底模（相对 vendor 根的路径，可直接喂给 `-pg` / `-pd`）。

    官方 WebUI 就是这么干的：下拉框里列的是 `assets/pretrained*` 下**真实存在**的文件，
    一份都没有时就不带 `-pg` / `-pd`（等于从零训）。
    """
    found: List[str] = []
    for sub in ("pretrained_v2", "pretrained"):
        base = root / "assets" / sub
        if not base.is_dir():
            continue
        for path in sorted(base.glob("f0*.pth")):
            found.append("%s/%s" % (sub, path.name))
    return found


def resolve_pretrained(root: Path, request: "TrainRequest") -> Dict[str, Any]:
    """按官方口径挑底模。返回 `{g, d, available, note}`；找不到就是空串（官方允许）。"""
    sr_tag = request.sample_rate_tag
    # 顺序照官方：v1 / 40k 先看 `assets/pretrained`（v1 底模），其余先看 `pretrained_v2`
    subs = ("pretrained", "pretrained_v2") if (request.version_tag == "v1" or sr_tag == "40k") else (
        "pretrained_v2",
        "pretrained",
    )
    picked: Dict[str, str] = {"g": "", "d": ""}
    if request.pretrain_g:
        picked["g"] = request.pretrain_g
    if request.pretrain_d:
        picked["d"] = request.pretrain_d
    for kind in ("g", "d"):
        if picked[kind]:
            continue
        letter = "G" if kind == "g" else "D"
        for sub in subs:
            rel = "%s/f0%s%s.pth" % (sub, letter, sr_tag)
            if (root / "assets" / sub / ("f0%s%s.pth" % (letter, sr_tag))).is_file():
                picked[kind] = rel
                break
    available = available_pretrained(root)
    note = ""
    if not picked["g"] or not picked["d"]:
        miss = [k for k in ("g", "d") if not picked[k]]
        note = (
            "找不到 %s 的%s底模（`assets/pretrained*` 下没有 f0%s%s.pth），"
            "将按官方做法**不带 -pg/-pd** 从零训练（收敛慢、质量差）。"
            "本机现成的底模：%s。"
            % (
                sr_tag,
                "生成器 / 判别器" if len(miss) == 2 else ("生成器" if "g" in miss else "判别器"),
                "G/D" if len(miss) == 2 else ("G" if "g" in miss else "D"),
                sr_tag,
                "、".join(available) or "（一个都没有）",
            )
        )
    return {"g": picked["g"], "d": picked["d"], "available": available, "note": note}


# --------------------------------------------------------------------------
# 训练过程的 epoch 级进度（阶段 29 / T4）
#
# 改前 `full` 模式只有「阶段级」的 5 次 emit：训练这一步一占就是十几分钟到几小时，
# 界面长时间停在「训练」两个字上，用户无法判断是卡死还是在跑。
# 官方 train.py 其实每 `log_interval` 个 batch 就打一行
# `Train Epoch: 3 [45%]` + 一行 `loss_gen=...`，这里把它解析出来逐条上报。
# --------------------------------------------------------------------------

_TRAIN_EPOCH_RE = re.compile(r"Train Epoch:\s*(\d+)\s*\[\s*(\d+)\s*%\]")
_TRAIN_EPOCH_DONE_RE = re.compile(r"====>\s*Epoch:\s*(\d+)")
_TRAIN_LOSS_RE = re.compile(r"loss_gen=([\d.]+).*?loss_fm=([\d.]+)")


@dataclass
class TrainProgress:
    """从 stdout 里逐步攒出来的训练进度。"""

    epoch: int = 0
    total_epochs: int = 0
    batch_percent: int = 0
    loss_gen: Optional[float] = None
    loss_fm: Optional[float] = None

    @property
    def fraction(self) -> float:
        if self.total_epochs <= 0:
            return 0.0
        done = max(self.epoch - 1, 0) + (self.batch_percent / 100.0)
        return min(max(done / self.total_epochs, 0.0), 1.0)

    def message(self) -> str:
        loss = "" if self.loss_gen is None else " · loss_gen %.3f" % self.loss_gen
        return "训练 第 %d/%d 轮（%d%%）%s" % (
            max(self.epoch, 1),
            self.total_epochs or max(self.epoch, 1),
            self.batch_percent,
            loss,
        )


def parse_train_line(line: str, state: TrainProgress) -> bool:
    """解析官方 train.py 的一行输出；命中并更新 state 返回 True。"""
    hit = _TRAIN_EPOCH_RE.search(line)
    if hit:
        state.epoch = int(hit.group(1))
        state.batch_percent = int(hit.group(2))
        return True
    hit = _TRAIN_LOSS_RE.search(line)
    if hit:
        try:
            state.loss_gen = float(hit.group(1))
            state.loss_fm = float(hit.group(2))
        except ValueError:
            return False
        return True
    hit = _TRAIN_EPOCH_DONE_RE.search(line)
    if hit:
        state.epoch = int(hit.group(1))
        state.batch_percent = 100
        return True
    return False


def write_train_config(settings: Settings, request: TrainRequest) -> Path:
    """生成 `logs/<exp>/config.json`（官方 `infer-web.py:556-569` 的同名动作）。

    `train.py::get_hparams()` 会无条件读它 —— 没有就直接 FileNotFoundError。
    官方只在文件不存在时写（避免覆盖用户手改过的配置），这里照做。
    """
    root = bootstrap.vendor_root(settings)
    exp_dir = root / "logs" / request.clean_name
    rel = official_config_rel(request.version_tag, request.sample_rate_tag)
    src = root / "configs" / rel
    if not src.is_file():
        raise ValueError(
            "官方配置模板不存在：configs/%s（版本 %s + 采样率 %s 的组合官方不支持）"
            % (rel, request.version_tag, request.sample_rate_tag)
        )
    exp_dir.mkdir(parents=True, exist_ok=True)
    target = exp_dir / "config.json"
    if not target.exists():
        data = json.loads(src.read_text(encoding="utf-8"))
        target.write_text(
            json.dumps(data, ensure_ascii=False, indent=4, sort_keys=True) + "\n", encoding="utf-8"
        )
    return target


def preflight(settings: Settings, request: TrainRequest) -> Dict[str, Any]:
    """训练前的**可执行**体检：把「跑起来才会炸」的问题提前列出来。

    返回 `{ok, issues, config, pretrained, available_combos}`。
    `issues` 里每一条都是用户能照着做的动作，不是堆栈。
    """
    root = bootstrap.vendor_root(settings)
    issues: List[str] = []  # 阻塞项：跑下去必然失败
    warnings: List[str] = []  # 非阻塞：能跑，但结果会打折
    sr_tag = request.sample_rate_tag
    version = request.version_tag

    allowed = ALLOWED_COMBOS.get(version, set())
    if sr_tag not in allowed:
        issues.append(
            "采样率 %s 与版本 %s 的组合官方不支持（%s 只有 %s）。"
            "40k 请改用 v1（官方 infer-web.py:555 的硬性规则），或换成 %s。"
            % (sr_tag, version, version, "、".join(sorted(allowed)), "、".join(sorted(allowed)))
        )
    rel = official_config_rel(version, sr_tag)
    config_exists = (root / "configs" / rel).is_file()
    if not config_exists:
        issues.append("缺少官方配置模板 configs/%s —— 该采样率暂不可训。" % rel)

    pre = resolve_pretrained(root, request)
    if request.mode == "full" and pre["note"]:
        # 官方允许不带底模（等于从零训），所以这只是**警告**不是阻塞
        warnings.append(pre["note"])

    return {
        "ok": not issues,
        "issues": issues,
        "warnings": warnings,
        "config": {"path": "logs/%s/config.json" % request.clean_name, "template": "configs/%s" % rel, "template_exists": config_exists},
        "pretrained": pre,
        "available_combos": {k: sorted(v) for k, v in ALLOWED_COMBOS.items()},
        "available_pretrained": pre["available"],
    }


def build_train_command(settings: Settings, request: TrainRequest) -> "tuple[List[str], Dict[str, Any]]":
    """构造官方 `train.py` 命令 —— **plan 与 run 共用同一份**，避免两处漂移。

    参数面照官方 `infer-web.py:571`：`-e -sr -f0 -bs -g -te -se [-pg -pd] -l -c -sw -v`。
    其中 `-pg` / `-pd` **只在真有底模时才带**（官方：下拉框为空就不传）。
    """
    pre = resolve_pretrained(bootstrap.vendor_root(settings), request)
    command: List[str] = [
        sys.executable,
        "infer/modules/train/train.py",
        "-e",
        request.clean_name,
        "-sr",
        request.sample_rate_tag,
        "-f0",
        "1" if request.f0 else "0",
        "-bs",
        str(request.batch_size),
        "-g",
        "0",
        "-te",
        str(request.epochs),
        "-se",
        str(request.save_every),
    ]
    if pre["g"]:
        command += ["-pg", pre["g"]]
    if pre["d"]:
        command += ["-pd", pre["d"]]
    command += [
        "-l",
        "1" if request.if_latest else "0",
        "-c",
        "1" if request.if_cache_gpu else "0",
        "-sw",
        "1" if request.save_every_weights else "0",
        "-v",
        request.version_tag,
    ]
    return command, pre


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

    官方会在末尾额外塞**两行** `logs/mute/*` 的静音样本（`infer-web.py:532-543`），
    作用是让模型学会「静音时不该出声」，抑制推理时的底噪与吞字。
    改前我们直接省略了这两行（当时以为要额外下载 mute.zip）——
    实际上 `vendor/rvc/logs/mute/` **已经齐备**（32k/40k/48k 三种采样率都有），
    所以阶段 29 起照官方补齐；文件不齐时静默跳过，不让训练因此失败。
    """
    root = bootstrap.vendor_root(settings)
    exp_dir = root / "logs" / request.clean_name
    gt_dir = exp_dir / "0_gt_wavs"
    feature_dir = exp_dir / ("3_feature256" if request.version_tag == "v1" else "3_feature768")
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
    # 官方的静音样本行（对齐 `infer-web.py:532`）—— 缺任何一个文件就整体跳过
    mute_dir = root / "logs" / "mute"
    mute_gt = mute_dir / "0_gt_wavs" / ("mute%s.wav" % request.sample_rate_tag)
    mute_feat = mute_dir / ("3_feature256" if request.version_tag == "v1" else "3_feature768") / "mute.npy"
    mute_f0 = mute_dir / "2a_f0" / "mute.wav.npy"
    mute_f0nsf = mute_dir / "2b-f0nsf" / "mute.wav.npy"
    mute_ready = mute_gt.is_file() and mute_feat.is_file()
    if mute_ready and request.f0:
        mute_ready = mute_f0.is_file() and mute_f0nsf.is_file()
    if mute_ready:
        if request.f0:
            mute_line = "%s|%s|%s|%s|0" % (
                mute_gt.as_posix(), mute_feat.as_posix(), mute_f0.as_posix(), mute_f0nsf.as_posix()
            )
        else:
            mute_line = "%s|%s|0" % (mute_gt.as_posix(), mute_feat.as_posix())
        # 官方 `for _ in range(2)`：同一条重复两次，等价于给它双倍权重
        lines.extend([mute_line, mute_line])

    target = exp_dir / "filelist.txt"
    target.write_text("\n".join(lines), encoding="utf-8")
    if not lines:
        # 空清单绝不能悄悄往下传：train.py / lora.py 会以「filelist.txt 是空的」
        # 之类的模糊理由炸掉，用户完全看不出是哪一步、为什么。这里给出可行动的诊断。
        counts = {
            "gt_wavs(0_gt_wavs)": len(list(gt_dir.glob("*.wav"))),
            "features(%s)" % feature_dir.name: len(list(feature_dir.glob("*.npy"))),
        }
        if request.f0:
            counts["f0(2a_f0)"] = len(list((exp_dir / "2a_f0").glob("*.npy")))
            counts["f0nsf(2b-f0nsf)"] = len(list((exp_dir / "2b-f0nsf").glob("*.npy")))
        raise ValueError(
            "训练清单为空：没有任何片段同时具备全部所需产物，无法进入训练。各阶段产物数量：%s。"
            "常见原因是语料太短/太静（被切分阶段全部丢弃）、或预处理阶段对部分文件报错。"
            "请查看 `%s/preprocess.log` 与 `%s/extract_f0_feature.log`。"
            % (
                "、".join("%s=%d" % kv for kv in counts.items()),
                exp_dir.name,
                exp_dir.name,
            )
        )
    return target


def _stage_output_probe(key: str, exp_dir: Path, request: TrainRequest) -> "tuple[Optional[int], str]":
    """查某个阶段到底产出了多少片段。返回 (数量, 说明)；不认识的阶段返回 (None, "")。

    存在的理由：官方脚本吞异常且恒返回 0，只能靠数产物判断真实成败。
    """
    if key == "preprocess":
        n = len(list((exp_dir / "0_gt_wavs").glob("*.wav")))
        return n, "产出 %d 个片段" % n
    if key == "f0":
        n = len(list((exp_dir / "2a_f0").glob("*.npy")))
        return n, "提取 %d 条音高" % n
    if key == "feature":
        feat = exp_dir / ("3_feature256" if request.version_tag == "v1" else "3_feature768")
        n = len(list(feat.glob("*.npy")))
        return n, "提取 %d 条特征" % n
    return None, ""


def _stage_failure_hint(key: str, exp_dir: Path) -> str:
    """给失败阶段一句「下一步该做什么」。"""
    logs = "、".join("%s.log" % p.name for p in exp_dir.glob("*.log")) or "（本阶段无日志）"
    if key == "preprocess":
        return (
            "预处理没产出片段。多半是语料不合格：太短（<1.5 秒有效人声）、太静（有效部分被 -42dB 阈值切掉）、"
            "或有 NaN/爆音。换成 3~10 秒的干净干声再试。详细原因见 `%s`。%s" % (exp_dir.name, logs)
        )
    if key == "f0":
        return "音高提取失败。常见原因是上一步的片段损坏，或 rmvpe 模型缺失。详见 `%s`。%s" % (exp_dir.name, logs)
    if key == "feature":
        return "内容特征提取失败。若是显存报错，先释放显卡（关浏览器/游戏）。详见 `%s`。%s" % (exp_dir.name, logs)
    return "详见 `%s`。%s" % (exp_dir.name, logs)


def build_index(settings: Settings, request: TrainRequest, out_path: Path) -> Dict[str, Any]:
    """用 faiss 建检索索引（逻辑照官方 `train_index()`，产物写我们自己的目录）。"""
    import faiss  # noqa: PLC0415
    import numpy as np  # noqa: PLC0415

    root = bootstrap.vendor_root(settings)
    exp_dir = root / "logs" / request.clean_name
    feature_dir = exp_dir / ("3_feature256" if request.version_tag == "v1" else "3_feature768")
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
    exp_dir = root / "logs" / request.clean_name
    # 先清掉上一次同名实验的残留。
    #
    # 坑（2026-10 实测）：RVC 的 preprocess 只**追加**产物，从不清理。同名实验重跑时，
    # 上一轮幸存的 `0_gt_wavs/*.wav` 会和新产物混在一起，write_filelist 于是把
    # 「有 gt_wav 但没有对应特征」的陈旧片段也算进去 —— 表现为 filelist 行数对不上，
    # 或直接 `filelist.txt 是空的` 报错，而真实原因藏在上一轮的残骸里。
    # 同名实验在语义上就是「覆盖重做」，所以这里直接重置目录，让每次结果只由本轮决定。
    if exp_dir.exists():
        shutil.rmtree(exp_dir, ignore_errors=True)
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
    sr = request.sample_rate_hz

    steps: List[tuple] = [
        (
            "preprocess",
            "预处理：切分与重采样",
            [script, "infer/modules/train/preprocess.py", request.corpus_dir, str(sr), "8", str(exp_dir), "False", "3.7"],
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
        detail = "退出码 %d" % code
        # RVC 官方的 preprocess / extract 脚本把异常全吞在裸 `except:` 里，
        # **无论成功失败都退出码 0**。所以不能只看退出码，必须查产物目录：
        # 否则「一条音频都没处理成功」会被判成通过，一路错到 filelist 才炸，
        # 报错点离现场很远（2026-10 实测）。
        if code == 0:
            produced, note = _stage_output_probe(key, exp_dir, request)
            if produced is not None:
                detail = "%s；%s" % (detail, note)
                if produced == 0:
                    code = 1
                    detail = "%s —— 未产出任何片段" % detail
        results.append(
            StageResult(
                key=key,
                label=label,
                ok=code == 0,
                detail=detail,
                command=" ".join(command),
                elapsed_s=time.time() - stage_started,
            )
        )
        if code != 0:
            return {
                "ok": False,
                "error": "步骤「%s」失败（%s）" % (label, detail),
                "hint": _stage_failure_hint(key, exp_dir),
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

    # ---- 训练配置 config.json（官方在训练前写，见 infer-web.py:556） ----
    if is_cancelled():
        return {"cancelled": True, "stages": [r.to_dict() for r in results]}
    try:
        config_path = write_train_config(settings, request)
        results.append(
            StageResult(
                key="config",
                label="生成训练配置 config.json",
                ok=config_path.is_file(),
                detail=str(config_path),
                elapsed_s=0.0,
                outputs=[str(config_path)],
            )
        )
    except ValueError as exc:
        results.append(StageResult(key="config", label="生成训练配置 config.json", ok=False, detail=str(exc)))
        return {"ok": False, "error": str(exc), "stages": [r.to_dict() for r in results]}

    # ---- 训练 ----
    if is_cancelled():
        return {"cancelled": True, "stages": [r.to_dict() for r in results]}
    emit(0.5, "训练（%s）" % ("全量微调" if request.mode == "full" else "LoRA 微调"))
    train_started = time.time()
    models_target = bootstrap.models_dir(settings)
    model_path = models_target / ("%s.pth" % request.clean_name)
    adapter_path = models_target / ("%s.lora.pt" % request.clean_name)
    info: Dict[str, Any] = {}

    if request.mode == "full":
        command, pre = build_train_command(settings, request)
        if pre["note"] and log:
            log(pre["note"])
        # 逐行解析官方输出的 epoch / loss，把「训练」这一大步拆成可见的推进
        state = TrainProgress(total_epochs=int(request.epochs))

        def train_log(line: str) -> None:
            if log:
                log(line)
            if parse_train_line(line, state):
                emit(0.5 + 0.4 * state.fraction, state.message())

        code = _run_command(command, root, train_log)
        # 官方 train.py 把导出模型写到 assets/weights/<name>.pth（相对 cwd=vendor 根）
        produced = sorted((root / "assets" / "weights").glob("%s.pth" % request.clean_name))
        results.append(
            StageResult(
                key="train",
                label="全量微调（官方 train.py）",
                ok=code == 0,
                detail="退出码 %d；跑到第 %d/%d 轮%s"
                % (
                    code,
                    state.epoch,
                    int(request.epochs),
                    "" if state.loss_gen is None else "，末次 loss_gen %.3f" % state.loss_gen,
                ),
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
        adapter_path = models_target / ("%s.lora.pt" % request.clean_name)
        info = lora.finetune(            settings,
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
        merged_path = models_target / ("%s.pth" % request.clean_name)
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
            index_path = models_target / ("%s.index" % request.clean_name)
            index_info = build_index(settings, request, index_path)
            results.append(StageResult(key="index", label="构建检索索引", ok=True, detail="%d 个向量" % index_info["vectors"], outputs=[str(index_path)]))
        except Exception as exc:  # noqa: BLE001 - 索引失败不影响模型本身
            results.append(StageResult(key="index", label="构建检索索引", ok=False, detail=str(exc)))

    if not request.keep_workdir:
        shutil.rmtree(exp_dir, ignore_errors=True)

    emit(1.0, "训练完成")

    # 产物清单：前端「训练结果」面板直接照着渲染，不必再去猜路径。
    # 每一项都带 `path`（本机绝对路径，给用户复制）与 `kind`（拿去做图标/说明）。
    artifacts: List[Dict[str, Any]] = []
    model_kind = "全量微调模型" if request.mode == "full" else "LoRA 合并模型"
    if model_path.is_file():
        artifacts.append(
            {
                "key": "model",
                "label": "%s（%s）" % (request.clean_name, model_kind),
                "path": str(model_path),
                "size_mb": round(model_path.stat().st_size / 1024 / 1024, 1),
                "kind": "model",
            }
        )
    if request.mode == "lora" and adapter_path.is_file():
        artifacts.append(
            {
                "key": "adapter",
                "label": "%s（LoRA 适配器 rank=%d）" % (request.clean_name, request.rank),
                "path": str(adapter_path),
                "size_mb": round(adapter_path.stat().st_size / 1024 / 1024, 1),
                "kind": "adapter",
            }
        )
    if index_info.get("index"):
        index_file = Path(str(index_info["index"]))
        if index_file.is_file():
            artifacts.append(
                {
                    "key": "index",
                    "label": "%s（检索索引）" % request.clean_name,
                    "path": str(index_file),
                    "size_mb": round(index_file.stat().st_size / 1024 / 1024, 1),
                    "kind": "index",
                }
            )

    return {
        "ok": True,
        "name": request.clean_name,
        "mode": request.mode,
        "sample_rate": request.sample_rate,
        "epochs": request.epochs,
        "model": str(model_path),
        "index": index_info.get("index"),
        "lora": info if request.mode == "lora" else None,
        "artifacts": artifacts,
        "stages": [r.to_dict() for r in results],
        "elapsed_s": round(time.time() - started, 1),
    }

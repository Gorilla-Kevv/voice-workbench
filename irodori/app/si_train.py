"""S3：Speaker Inversion 训练编排（30-6）。

**为什么是子进程**：上游 `train.py` 只有 `if __name__ == "__main__": main()` 一个入口
（`train.py:5202`），没有可编程函数；它还在 `main()` 里初始化分布式、建 DataLoader、
跑 torch 训练循环 —— 塞进 FastAPI 进程既拿不到干净的退路，也会让「取消」变成杀自己。
子进程给我们三样东西：

1. **边界清晰**：取消 = 终止进程树（`taskkill /t /f`，见坑 45），模型从显存里彻底走人；
2. **唯一的实时信号**：stdout 里的 `step=… loss=…` 行，我们把它解析成进度与 ETA；
3. **崩了不牵连服务**：训练进程 OOM 退出后，服务还能回答 `/health` 与 `/v1/jobs`。

命令形态沿用阶段 28 已跑通的探针脚本（`_bench/train_irodori_probe.py`），
在此之上补三件它没做的事：`--num-workers 0`（Windows 的 DataLoader worker 要求
入口有 `__main__` 守卫，我们这里是子进程+线程，只让它跑主进程最稳）、
`--no-wandb`（别偷偷起 wandb 联网）、`--device cuda`（不接受静默落 CPU，与本项目
其它服务「不静默降级」的口径一致）。

上游代码零改动（方案 §7）：需要改的行为一律走 CLI 参数，`train.py` 与它的 yaml
一个字节都不碰 —— 所以一期能覆盖的参数有限，覆盖不到的（如 `dataloader_persistent_workers`）
只能接受上游默认值（好消息是 `--num-workers 0` 之后它自动不生效）。
"""

from __future__ import annotations

import json
import os
import queue as queue_module
import re
import shutil
import subprocess
import sys
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional

from . import config
from .config import Settings
from .errors import IrodoriError
from .hardware import vram_mb
from .synth import voicelib_file
from . import traindata

#: 上游的最终产物名（`train.py::_final_checkpoint_path`）
FINAL_CHECKPOINT_NAME = "checkpoint_final.speaker.safetensors"
#: 固化的 speaker embedding 后缀（`irodori_tts/speaker_inversion.py:11`）
SPEAKER_SUFFIX = ".speaker.safetensors"
#: 周期产物的命名（`checkpoint_<step:07d>.speaker.safetensors`）
_PERIODIC_RE = re.compile(r"^checkpoint_(\d{7,})\.speaker\.safetensors$")
#: 训练循环每步打印（`train.py:4879`）：`step=120 loss=0.123456 rf=… dur=…`
_STEP_RE = re.compile(r"\bstep=(\d+)\b.*?\bloss=([0-9]+(?:\.[0-9]+)?(?:[eE][-+]?\d+)?)")

# 显存画像与准入算术都由 `config` 提供（**唯一事实源**，坑 19）—— 这里只做引用，
# 不在两个模块里各推一遍 `4630 + (batch-2)*130`。
# --------------------------------------------------------------------------
_NET_BASELINE_BATCH = config.TRAIN_NET_BASELINE_BATCH
_NET_BASELINE_MB = config.TRAIN_NET_BASELINE_MB
_PER_SAMPLE_MB = config.TRAIN_PER_SAMPLE_MB
#: 候选 batch 阶梯（官方 yaml 给的是 16，本机没验过 16，最大到 8 —— 方案 §6.4）
_BATCH_LADDER = (8, 6, 4, 2, 1)


class _VramSampler:
    """后台按固定节拍采 nvidia-smi，记住「训练期间最满的时刻」。

    为什么要单独一个采样线程：Linux 上可以精确测单进程峰值，Windows WDDM 下不行
    （坑 17），只能退而求其次 —— 在训练进程活着的时候盯着整卡空闲量，
    把「最低空闲」当作它的峰值。nvidia-smi 一次约 30ms，0.25s 一拍足够密。
    """

    def __init__(self, interval: float = 0.25) -> None:
        self.interval = interval
        self.baseline_free_mb: Optional[int] = None
        self.min_free_mb: Optional[int] = None
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    def start(self) -> "_VramSampler":
        reading = vram_mb()
        if reading is not None:
            self.baseline_free_mb = int(reading["free_mb"])
            self.min_free_mb = self.baseline_free_mb
        self._thread = threading.Thread(target=self._loop, name="irodori-vram", daemon=True)
        self._thread.start()
        return self

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                reading = vram_mb()
            except Exception:  # pragma: no cover - nvidia-smi 抖动
                reading = None
            if reading is not None:
                free = int(reading["free_mb"])
                if self.min_free_mb is None or free < self.min_free_mb:
                    self.min_free_mb = free
            self._stop.wait(self.interval)

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None and self._thread.is_alive():
            self._thread.join(timeout=2)

    @property
    def peak_used_mb(self) -> Optional[int]:
        """训练峰值占用（MB）= 开跑前的空闲 − 期间的最低空闲。"""
        if self.baseline_free_mb is None or self.min_free_mb is None:
            return None
        return max(0, self.baseline_free_mb - self.min_free_mb)


@dataclass
class BatchPlan:
    """batch 的选择结果（连「怎么选的」一起回显，别让用户对着数字猜）。"""

    batch: int
    source: str  # explicit / probe / heuristic / fallback
    note: str = ""
    peak_used_mb: Optional[int] = None
    free_mb: Optional[int] = None
    estimated_net_mb: Optional[int] = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "batch": self.batch,
            "source": self.source,
            "note": self.note,
            "peak_used_mb": self.peak_used_mb,
            "free_mb": self.free_mb,
            "estimated_net_mb": self.estimated_net_mb,
        }


@dataclass
class TrainRun:
    """一次训练子进程的结果。"""

    steps_seen: int = 0
    last_loss: Optional[float] = None
    elapsed_sec: float = 0.0
    returncode: int = 0
    cancelled: bool = False
    timed_out: bool = False
    tail: list[str] = field(default_factory=list)
    peak_used_mb: Optional[int] = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "steps_seen": self.steps_seen,
            "last_loss": self.last_loss,
            "elapsed_sec": round(self.elapsed_sec, 2),
            "returncode": self.returncode,
            "cancelled": self.cancelled,
            "timed_out": self.timed_out,
            "peak_used_mb": self.peak_used_mb,
            "tail": self.tail[-12:],
        }


# --------------------------------------------------------------------------
# 数据集：从 dataset_id 找到 manifest，并把「能不能训」先问清楚
# --------------------------------------------------------------------------


def dataset_manifest(settings: Settings, dataset_id: str) -> tuple[str, Path]:
    """`(dataset_id, manifest_path)`。数据集不存在就报 `DATASET_NOT_FOUND`。"""
    if not (dataset_id or "").strip():
        datasets = traindata.list_datasets(settings)
        raise IrodoriError(
            "DATASET_NOT_FOUND",
            "没有可用的数据集（先跑 POST /v1/train/prepare）",
            f"已整备的数据集：{len(datasets)} 个；传 dataset_id 指定其中一个。",
            status=404,
        )
    directory = traindata.dataset_dir(settings, dataset_id)  # id 非法 → DATASET_ID_INVALID
    safe_id = directory.name
    path = directory / traindata.MANIFEST_NAME
    if not path.is_file():
        datasets = traindata.list_datasets(settings)
        raise IrodoriError(
            "DATASET_NOT_FOUND",
            f"数据集 {safe_id} 没有 manifest（尚未整备或整备失败）",
            "先验数据：GET /v1/train/datasets"
            + (f"（现有 {len(datasets)} 个）" if datasets else "（现在一个都没有）")
            + "；没有就先跑 POST /v1/train/prepare。",
            status=404,
        )
    return safe_id, path


def manifest_stats(path: Path) -> dict[str, Any]:
    """manifest 的体检结果。**沿用 30-5 的守卫哲学**：上游会静默跳过数据，我们必须自己数。

    ⚠️ `latent_path` 的解析口径要照抄上游（`dataset.py::_resolve_latent_path`）：
    **相对路径以 manifest 所在目录为基准**，而不是进程的工作目录。踩这条的原因很实际 ——
    训练跑在另一个进程里（cwd 未设，继承服务自己的），按 cwd 解会全部解成不存在的文件，
    于是「明明刚整备好」却被判成「latent 全丢」。

    `missing_latent`：写了 manifest 之后、训练之前，latent 文件被删了（清理磁盘最常见）
    —— 上游的 DataLoader 会在这时抛一个看不懂的错，不如现在就说清。
    """
    rows = 0
    missing_latent = 0
    missing_text = 0
    frames = 0
    bad_lines = 0
    base = path.resolve().parent
    try:
        for row in traindata.iter_manifest_rows(path):
            rows += 1
            if not str(row.get("text") or "").strip():
                missing_text += 1
            latent = str(row.get("latent_path") or "")
            candidate = Path(latent)
            if latent and not candidate.is_absolute():
                candidate = base / candidate
            if not latent or not candidate.resolve().is_file():
                missing_latent += 1
            try:
                frames += int(row.get("num_frames") or 0)
            except (TypeError, ValueError):
                pass
    except (OSError, json.JSONDecodeError) as error:
        raise IrodoriError(
            "METADATA_BROKEN",
            f"manifest 读不出来：{error}",
            "重新跑一次 POST /v1/train/prepare（旧的 latent 不复用）。",
        ) from error
    return {
        "rows": rows,
        "bad_lines": bad_lines,
        "missing_text": missing_text,
        "missing_latent": missing_latent,
        "total_frames": frames,
        "total_seconds": round(frames / 25.0, 2) if frames else 0.0,
    }


def assert_trainable(stats: dict[str, Any], manifest_path: Path) -> None:
    """训练前的最后一道守卫：一条数据都没有、或 latent 全丢了，不许开训。

    理由与 30-5 的「守卫一」完全相同：**上游在这件事上是静默的** —— 空 manifest 会让它
    直接以退出码 0 跑完，用户等一晚上得到一个不存在的模型。这里必须显式炸掉。
    """
    if stats["rows"] <= 0:
        raise IrodoriError(
            "TRAIN_NO_DATA",
            f"manifest 是空的：{manifest_path}",
            "重新跑 POST /v1/train/prepare；上一版若无升级的本库文件，先删掉这个数据集目录。",
            details={"manifest": str(manifest_path)},
        )
    if stats["missing_latent"] >= stats["rows"]:
        raise IrodoriError(
            "TRAIN_NO_DATA",
            f"manifest 里 {stats['missing_latent']}/{stats['rows']} 条 latent 都不在磁盘上",
            "latent 被删了（清理临时文件？）。重新跑 POST /v1/train/prepare 生成。",
            details=stats,
        )
    if stats["missing_latent"]:
        # 丢一部分不致命（上游会跳过），但要在 plan 的日志里说清楚
        return
    return


# --------------------------------------------------------------------------
# batch：启发式兜底 + 真机探测
# --------------------------------------------------------------------------


def estimated_net_mb(batch: int) -> int:
    """按阶段 28 的净占画像估某个 batch 的占用（MB）。"""
    return int(_NET_BASELINE_MB + (batch - _NET_BASELINE_BATCH) * _PER_SAMPLE_MB)


def heuristic_batch(settings: Settings, free_mb: Optional[int]) -> BatchPlan:
    """不看 GPU、只按当前空闲显存给推荐值（探测不可用时的兜底）。

    `free_mb is None`（nvidia-smi 不可用）= 看不见显卡，此时保守取 2：
    宁可慢一点也不让第一条训练就 OOM 退出 —— 训练跑到第 900 步炸掉，
    比一开始就说「可能跑不动」让用户主动降档要糟得多。
    """
    headroom = max(0.1, min(settings.auto_batch_headroom, 1.0))
    if free_mb is None:
        return BatchPlan(
            batch=2,
            source="fallback",
            note="读不到显存（nvidia-smi 不可用），保守取 batch 2",
            estimated_net_mb=estimated_net_mb(2),
        )
    budget = int(free_mb * headroom)
    for candidate in _BATCH_LADDER:
        if candidate > settings.max_train_batch:
            continue
        if estimated_net_mb(candidate) <= budget:
            return BatchPlan(
                batch=candidate,
                source="heuristic",
                note=f"按阶段 28 净占画像估：空闲 {free_mb} MB 的 {int(headroom * 100)}% "
                     f"够 batch {candidate}（估 {estimated_net_mb(candidate)} MB）",
                free_mb=free_mb,
                estimated_net_mb=estimated_net_mb(candidate),
            )
    return BatchPlan(
        batch=1,
        source="heuristic",
        note=f"空闲只有 {free_mb} MB，连 batch 2 都可能不够 —— 先关占显存的程序再来",
        free_mb=free_mb,
        estimated_net_mb=estimated_net_mb(1),
    )


def probe_batch(
    settings: Settings,
    *,
    manifest: Path,
    output_dir: Path,
    steps: Optional[int] = None,
    logger: Optional[Callable[[str], None]] = None,
    is_cancelled: Optional[Callable[[], bool]] = None,
    timeout_sec: float = 420.0,
) -> BatchPlan:
    """真机探测：按 `settings.train_probe_batch` 实跑几步，量出峰值再外推。

    方案 §6.4 的做法（照搬社区客户端）：跑 batch 2 两步 → 看峰值 → 按「吃满空闲的
    `auto_batch_headroom`」反推能上到多大 batch，上限 `max_train_batch`。

    线性外推的依据：batch 之外的一切（基座权重 ~3GB、optimizer 只有 16 个 token 的状态）
    是常数，训练核心又是只训 embedding —— 显存随 batch 基本线性增长。
    这是**近似**，所以每次都会回显 `peak_used_mb` 让用户能核对，而不是给个黑箱数字。
    """
    is_cancelled = is_cancelled or (lambda: False)
    probe_steps = max(1, int(steps) if steps else int(settings.train_probe_steps))
    probe_batch_size = max(1, int(settings.train_probe_batch))
    probe_dir = output_dir.parent / f"{output_dir.name}-probe"

    baseline = vram_mb()
    free_before = int(baseline["free_mb"]) if baseline else None
    command = build_command(
        settings,
        manifest=manifest,
        output_dir=probe_dir,
        steps=probe_steps,
        batch=probe_batch_size,
        save_every=0,
        log_every=1,
    )
    if logger:
        logger(f"batch 探测：batch={probe_batch_size} 跑 {probe_steps} 步（约 1~2 分钟）")

    sampler = _VramSampler()
    run = _run_process(
        command,
        logger=logger,
        sampler=sampler,
        is_cancelled=is_cancelled,
        timeout_sec=timeout_sec,
        quiet=True,
    )
    if run.cancelled:
        raise IrodoriError("JOB_CANCELLED", "任务已取消（batch 探测阶段）", "可以重新发起训练。")
    if run.returncode != 0:
        if logger:
            logger(f"batch 探测失败（退出码 {run.returncode}），改用启发式推荐")
        plan = heuristic_batch(settings, free_before)
        plan.note += f"；真机探测失败：{classify_failure(run.returncode, run.tail)[1]}"
        return plan

    peak = sampler.peak_used_mb
    if not peak:
        plan = heuristic_batch(settings, free_before)
        plan.note += "；真机探测没量到峰值（nvidia-smi 不可用），改用启发式"
        return plan

    headroom = max(0.1, min(settings.auto_batch_headroom, 1.0))
    budget = int((free_before or peak) * headroom)
    # 峰值里包含与 batch 无关的常数部分（基座 + context），外推只算斜率
    constant = max(200, peak - probe_batch_size * _PER_SAMPLE_MB)
    chosen = probe_batch_size
    for candidate in _BATCH_LADDER:
        if candidate > settings.max_train_batch:
            continue
        if constant + candidate * _PER_SAMPLE_MB <= budget:
            chosen = candidate
            break
    return BatchPlan(
        batch=chosen,
        source="probe",
        note=f"实测 batch {probe_batch_size} 峰值 {peak} MB，空闲 {free_before} MB "
             f"× {int(headroom * 100)}% ⇒ batch {chosen}",
        peak_used_mb=peak,
        free_mb=free_before,
        estimated_net_mb=constant + chosen * _PER_SAMPLE_MB,
    )


# --------------------------------------------------------------------------
# 命令行
# --------------------------------------------------------------------------


def build_command(
    settings: Settings,
    *,
    manifest: Path,
    output_dir: Path,
    steps: int,
    batch: int,
    save_every: Optional[int] = None,
    log_every: Optional[int] = None,
    seed: Optional[int] = None,
    init_embedding: Optional[str] = None,
) -> list[str]:
    """拼 upstream `train.py` 的命令行。**全部参数都有出处**：

    - `--speaker-inversion`：官方 SI yaml 里已写 `speaker_inversion_enabled: true`，
      命令行再给一次是为了「我们这条路径一定是 SI」，避免将来换配置时静默变成普通训练；
    - `--num-workers 0`：Windows 下 DataLoader worker 要求入口有 `__main__` 守卫，
      我们在子进程里起训练，多 worker 会撞 spawn 重入（阶段 28 的探针也是这么跑的）；
    - `--no-wandb`：不联网、不偷偷建实验；
    - `--valid-ratio 0 --valid-every 0`：数据集小，切验证集会减少训练样本
      （官方 yaml 本来就没开）；
    - `--device cuda`：CPU 上 SI 训练是几十倍耗时，给了等于不可用（同 CPU 策略，不静默降级）。
    """
    if not settings.train_script.is_file():
        raise IrodoriError(
            "CODEC_LOAD_FAILED",
            f"找不到上游训练脚本：{settings.train_script}",
            "npm run irodori:weights 会把 upstream/Irodori-TTS 解到这里；手动确认目录存在。",
            status=503,
        )
    if not settings.si_config_file.is_file():
        raise IrodoriError(
            "CODEC_LOAD_FAILED",
            f"找不到上游 SI 配置：{settings.si_config_file}",
            "配置随 upstream tarball 一起下载；重跑 npm run irodori:weights。",
            status=503,
        )

    command = [
        sys.executable,
        "-u",
        str(settings.train_script),
        "--config",
        str(settings.si_config_file),
        "--manifest",
        str(manifest),
        "--init-checkpoint",
        str(settings.bf16_model_file),
        "--output-dir",
        str(output_dir),
        "--speaker-inversion",
        "--max-steps",
        str(max(1, int(steps))),
        "--batch-size",
        str(max(1, int(batch))),
        "--num-workers",
        "0",
        "--gradient-checkpointing",
        "--no-wandb",
        "--device",
        "cuda",
        "--precision",
        "bf16",
        "--log-every",
        str(max(1, int(log_every or settings.train_log_every))),
        "--save-every",
        str(max(0, int(steps if save_every is None else save_every))),
        "--valid-ratio",
        "0",
        "--valid-every",
        "0",
    ]
    if seed is not None:
        command += ["--seed", str(int(seed))]
    if init_embedding:
        command += ["--speaker-inversion-init-embedding", str(init_embedding)]
    return command


def training_env() -> dict[str, str]:
    """给训练子进程的环境。

    只做两件事：① 让 Python 与子进程的输出用 UTF-8（日志里全是日语假名，
    GBK 控制台会把线条打断 —— `errors="replace"` 也救不回来）；
    ② 显式保留 `HF_HOME`：分词器 `sbintuitions/modernbert-ja-310m` 是从 HF 缓存读的
    （SI 路径不像 meanflow 那样认 `<checkpoint>/tokenizer` 兄弟目录），本机 HF_HOME
    指向 `D:\\AI_Cache`，阶段 28 已经把缓存下载好了 —— 丢了它训练会在加载分词器时联网失败。
    """
    env = dict(os.environ)
    env.setdefault("PYTHONIOENCODING", "utf-8")
    env.setdefault("PYTHONUTF8", "1")
    return env


# --------------------------------------------------------------------------
# 子进程：统一的「拉起 + 逐行读 + 可取消 + 峰值采样」循环
# --------------------------------------------------------------------------


def _terminate(process: subprocess.Popen) -> None:
    """终止训练进程树。

    `terminate()` 之外必须补 `taskkill /t /f`：坑 45 实测过，Windows 上孙子进程
    （比如被 spawn 出来的 worker）不会随父进程的 terminate 一起走，留下就是占着显存。
    """
    if process.poll() is not None:
        return
    try:
        process.terminate()
    except Exception:  # pragma: no cover - 进程已退出
        return
    deadline = time.time() + 8
    while time.time() < deadline and process.poll() is None:
        time.sleep(0.3)
    if process.poll() is None and sys.platform.startswith("win"):
        subprocess.run(
            ["taskkill", "/t", "/f", "/pid", str(process.pid)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )


def _run_process(
    command: list[str],
    *,
    logger: Optional[Callable[[str], None]] = None,
    sampler: Optional[_VramSampler] = None,
    on_step: Optional[Callable[[int, Optional[float], Optional[float]], None]] = None,
    is_cancelled: Optional[Callable[[], bool]] = None,
    timeout_sec: Optional[float] = None,
    total_steps: int = 0,
    quiet: bool = False,
) -> TrainRun:
    """起子进程并逐行消费 stdout。

    ⚠️ 为什么把 stdout 读线程与「判断循环」分开：训练在**加载模型与构建数据**的几十秒里
    一行都不输出。若直接 `for line in process.stdout`，这段时间主线程完全阻塞 ——
    用户点「取消」要等到训练开始才有反应。所以这里用队列把两条线切开：
    读线程只管塞行，主线程 0.4s 一拍检查「取消 / 超时 / 进程退出」。
    """
    is_cancelled = is_cancelled or (lambda: False)
    run = TrainRun()
    started = time.perf_counter()

    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=training_env(),
        bufsize=1,
    )
    lines: "queue_module.Queue[Optional[str]]" = queue_module.Queue()

    def _pump() -> None:
        try:
            assert process.stdout is not None
            for line in process.stdout:
                lines.put(line)
        except Exception:  # pragma: no cover - stdout 在关闭时的竞态
            pass
        finally:
            lines.put(None)

    reader = threading.Thread(target=_pump, name="irodori-train-stdout", daemon=True)
    reader.start()
    if sampler is not None:
        sampler.start()
        run.peak_used_mb = None

    tail: deque[str] = deque(maxlen=60)
    first_step_at: Optional[float] = None
    per_step: Optional[float] = None

    try:
        while True:
            try:
                line = lines.get(timeout=0.4)
            except queue_module.Empty:
                if is_cancelled():
                    run.cancelled = True
                    _terminate(process)
                    break
                if timeout_sec and time.perf_counter() - started > timeout_sec:
                    run.timed_out = True
                    _terminate(process)
                    break
                if process.poll() is not None and not reader.is_alive():
                    break
                continue

            if line is None:
                break
            text = line.rstrip()
            if text:
                tail.append(text)
                if logger and not quiet:
                    logger(text)
            parsed = _STEP_RE.search(text)
            if parsed:
                try:
                    step = int(parsed.group(1))
                    loss = float(parsed.group(2))
                except ValueError:  # pragma: no cover - 正则已约束
                    continue
                now = time.perf_counter()
                if first_step_at is None:
                    first_step_at = now
                elif step > run.steps_seen:
                    per_step = (now - first_step_at) / max(1, step - 1)
                run.steps_seen = max(run.steps_seen, step)
                run.last_loss = loss
                if on_step:
                    eta = per_step * (total_steps - step) if (per_step and total_steps) else None
                    on_step(step, loss, eta)
                run.elapsed_sec = time.perf_counter() - started
    finally:
        # 队列里的残留不能再拖住主线程（训练已停），直接收干净
        try:
            process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            _terminate(process)
        if sampler is not None:
            sampler.stop()
            run.peak_used_mb = sampler.peak_used_mb
        run.tail = list(tail)
        run.returncode = process.returncode if process.returncode is not None else -1
        run.elapsed_sec = round(time.perf_counter() - started, 2)

    return run


# --------------------------------------------------------------------------
# 训练主入口
# --------------------------------------------------------------------------


def run_training(
    settings: Settings,
    *,
    manifest: Path,
    output_dir: Path,
    steps: int,
    batch: int,
    logger: Optional[Callable[[str], None]] = None,
    on_step: Optional[Callable[[int, Optional[float], Optional[float]], None]] = None,
    is_cancelled: Optional[Callable[[], bool]] = None,
    save_every: Optional[int] = None,
    seed: Optional[int] = None,
    init_embedding: Optional[str] = None,
) -> TrainRun:
    """跑一次 SI 训练（阻塞，调用方负责放到工作线程里）。

    只负责「跑」，不负责成功与否的判断 —— 那是 `collect_checkpoints()` 与
    `classify_failure()` 的事。分工理由和 30-5 一样：**每一步都要有一条自己的断言**，
    不能把「退出码 0」当成「模型训出来了」。
    """
    output_dir.mkdir(parents=True, exist_ok=True)
    timeout = settings.train_max_hours * 3600 if settings.train_max_hours > 0 else None
    sampler = _VramSampler()
    return _run_process(
        build_command(
            settings,
            manifest=manifest,
            output_dir=output_dir,
            steps=steps,
            batch=batch,
            save_every=save_every,
            seed=seed,
            init_embedding=init_embedding,
        ),
        logger=logger,
        sampler=sampler,
        on_step=on_step,
        is_cancelled=is_cancelled,
        timeout_sec=timeout,
        total_steps=steps,
    )


def collect_checkpoints(output_dir: Path) -> dict[str, Any]:
    """收产物：`checkpoint_final…` 是成品，周期 ckpt 是副产品（可回滚、可对比）。

    不存在的目录 / 空目录都返回空列表而不是抛异常 —— 失败诊断由调用方统一处理，
    这里只回答「磁盘上到底有什么」。
    """
    final = output_dir / FINAL_CHECKPOINT_NAME
    periodic: list[dict[str, Any]] = []
    if output_dir.is_dir():
        for path in sorted(output_dir.glob("checkpoint_*.speaker.safetensors")):
            match = _PERIODIC_RE.match(path.name)
            if not match:
                continue
            periodic.append(
                {
                    "step": int(match.group(1)),
                    "path": str(path),
                    "size_bytes": path.stat().st_size,
                }
            )
    periodic.sort(key=lambda item: item["step"])
    return {
        "final_path": str(final) if final.is_file() else None,
        "final_size_bytes": final.stat().st_size if final.is_file() else None,
        "periodic": periodic,
        "output_dir": str(output_dir),
    }


def publish_speaker(
    settings: Settings,
    *,
    final_path: Path,
    speaker_id: str,
    details: dict[str, Any],
) -> dict[str, Any]:
    """把上游产物搬到 `<data_dir>/speakers/<id>.speaker.safetensors`。

    为什么不由训练进程直接写到这里：上游会往 `--output-dir` 里塞一堆自己的东西
    （周期 ckpt、将来可能的日志/配置快照），而 `speakers/` 是**对外契约目录**
    （`synth.resolve_reference()` 就按 `<id>.speaker.safetensors` 找），
    必须保持一个目录一个 id、一个文件一个音色的干净形态。

    顺带做一条自己的断言：读回第一层，确认里面有 `speaker_embedding` 且形状是
    `(16, 768)`。理由与 30-5 的守卫一相同 —— 上游「写了个文件」不等于「写了能用的文件」。
    """
    target_dir = settings.speakers_dir
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / f"{speaker_id}{SPEAKER_SUFFIX}"
    shutil.copy2(final_path, target)

    shape: Optional[list[int]] = None
    names: list[str] = []
    try:
        from safetensors import safe_open  # noqa: PLC0415 - 惰性：只有用得上才 import
    except Exception:  # pragma: no cover - 环境缺失时跳过校验，不算失败
        shape = None
    else:
        try:
            with safe_open(str(target), framework="pt", device="cpu") as handle:
                keys = set(handle.keys())
                tensor = handle.get_tensor("speaker_embedding") if "speaker_embedding" in keys else None
                shape = list(tensor.shape) if tensor is not None else None
                names = sorted(keys)
        except Exception as error:  # pragma: no cover - 文件损坏时才到这
            target.unlink(missing_ok=True)
            raise IrodoriError(
                "METADATA_BROKEN",
                f"训练产物读不出来（不是有效的 speaker embedding）：{error}",
                "删掉 outputs 重跑一次训练；若稳定复现，去看训练日志的尾部。",
            ) from error
        if shape is None:
            target.unlink(missing_ok=True)
            raise IrodoriError(
                "METADATA_BROKEN",
                f"训练产物里没有 `speaker_embedding`（实际键：{names}）",
                "这是上游产出与我们契约不一致，先看 outputs 里原产物的实际内容。",
            )

    return {
        "speaker_id": speaker_id,
        "path": str(target),
        "size_bytes": target.stat().st_size,
        "embedding_shape": shape,
        **details,
    }


def register_speaker_embed(
    settings: Settings,
    *,
    voice_id: str,
    entry: dict[str, Any],
) -> Optional[dict[str, Any]]:
    """把训练产物登记进音色库的 `speaker_embeds`（30-4 加的字段）。

    ⚠️ 这是**第三个写同一份 JSON 的进程**（网关 Node、trainer Python、现在还有我们）。
    铁律照走（坑 27 / 坑 65）：
    - **写之前必须重读磁盘**（网关每次操作都重读，我们没有那个频率，所以只在
      这一刻读一次并只改目标记录的这一个键）；
    - 其它字段**原样保留**（不重建成白名单，否则会把网关刚写的字段抹掉）；
    - 缺失的新字段不写（不塞 null/空值污染磁盘形状）；
    - 原子写（临时文件 + replace），断电不会留半个 JSON。

    找不到 voice_id 时返回 None —— 训练本身就成功了，登记失败不该把任务判成失败。
    """
    path = voicelib_file(settings)
    if not path.is_file():
        return None
    try:
        records = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(records, list):
        return None

    target = next(
        (item for item in records if isinstance(item, dict) and item.get("id") == voice_id), None
    )
    if target is None:
        return None

    embeds = target.get("speaker_embeds")
    if not isinstance(embeds, list):
        embeds = []
    # 同一个 speaker_id 重复训练 → 覆盖同一条（按 speaker_id 去重，而不是无脑 append）
    embeds = [item for item in embeds if not (isinstance(item, dict) and item.get("speaker_id") == entry.get("speaker_id"))]
    embeds.append(entry)
    target["speaker_embeds"] = embeds

    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(records, ensure_ascii=False, indent=2), encoding="utf-8")
    temp.replace(path)
    return {
        "voice_id": voice_id,
        "voice_name": str(target.get("name") or ""),
        "speaker_embeds_count": len(embeds),
        "index": str(path),
    }


# --------------------------------------------------------------------------
# 失败分类：把上游的退出码翻译成「用户能行动」的一句话
# --------------------------------------------------------------------------


def classify_failure(returncode: int, tail: list[str]) -> tuple[str, str, str]:
    """`(code, message, hint)`。

    训练失败的排查成本极高（一次通常几十分钟），所以这里每条 hint 都要落到
    **具体动作**：降 batch、回购601权重、看哪个文件。「训练失败，详情见日志」这种
    话等于没说。
    """
    blob = "\n".join(tail[-30:])
    lowered = blob.lower()
    if "out of memory" in lowered or "cuda oom" in lowered or "cublas_status_alloc_failed" in lowered:
        return (
            "TRAIN_OOM",
            "训练显存不足（CUDA out of memory）",
            "把这个 variant 的 batch 调小（请求里给 batch=2 关掉自动探测），或先关掉占显存的程序。",
        )
    if any(token in lowered for token in ("connectionerror", "couldn't reach", "huggingface.co", "localentrynotfound", "offline", "timed out connecting", "max retries exceeded")):
        return (
            "TRAIN_NETWORK",
            "训练时联网失败（多半是加载现代BERT日语分词器）",
            "确认 HF_HOME 指向的缓存里已有 sbintuitions/modernbert-ja-310m；"
            "断网时可用 HF_HUB_OFFLINE=1 让它立刻失败而不是干等。",
        )
    if "torch.OutOfMemoryError".lower() in lowered:
        return (
            "TRAIN_OOM",
            "训练显存不足（torch.OutOfMemoryError）",
            "降低 batch 后重试；8GB 卡上 batch 8 已接近上限（阶段 28 实测整卡峰值 6911 MB）。",
        )
    if "modulenotfounderror" in lowered or "importerror" in lowered:
        return (
            "CODEC_LOAD_FAILED",
            f"训练环境缺依赖：{tail[-1] if tail else ''}".strip(),
            "用 irodori/.venv 的解释器跑本服务；缺什么看 irodori/requirements.txt。",
        )
    if "filenotfounderror" in lowered or "no such file" in lowered:
        return (
            "DATASET_NOT_FOUND",
            f"训练要读的文件不存在：{tail[-1] if tail else ''}".strip(),
            "manifest 里的 latent_path 可能已被清理；重跑 POST /v1/train/prepare。",
        )
    snippet = tail[-1] if tail else f"退出码 {returncode}"
    return (
        "TRAIN_FAILED",
        f"训练进程以退出码 {returncode} 结束：{snippet[:200]}",
        "看 GET /v1/jobs/{id} 的 logs（末尾 400 行）；常见原因是显存不足、权重缺失与数据为空。",
    )

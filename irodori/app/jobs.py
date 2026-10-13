"""任务模型与存储（形态对齐 `trainer/app/jobs.py`）。

为什么这里不直接 import trainer 的那份：两个服务的 venv 互相隔离
（`docs/ENGINE-ISOLATION.md` 的规矩），抽公共包就要回答「谁提供这个包」的问题。
形态对齐的意思是**字段同形**（`id/kind/state/progress/stages/logs/artifacts/…`），
这样将来网关或前端想合并两处的任务列表时不用做字段映射。

Irodori 侧的两点差异（都是刻意的）：

1. **种类只有三种**：`prepare`（S1+S2 数据整备）/ `train`（S3 SI 训练）/ `infer`。
   trainer 那边有八九种，是因为它一个服务扛了五条业务线；这里就一条。
2. **取消靠 `threading.Event`**，不用进程信号：Irodori 是单进程 + 工作线程，
   取消点是「每编完一条片段检查一次」—— 与 GPT-SoVITS 那种能杀子进程的情况不同。
"""

from __future__ import annotations

import json
import threading
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Iterable

#: 日志上限。训练日志很长（每 N 步一条），超出就丢最早的 —— 磁盘持久化里也只留尾部
MAX_LOGS = 400


class JobState(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"

    @property
    def terminal(self) -> bool:
        return self in {JobState.SUCCEEDED, JobState.FAILED, JobState.CANCELLED}


class JobKind(str, Enum):
    #: S1+S2：数据整备 + latent 编码（30-5）。只吃 codec，不吃 TTS 模型
    PREPARE = "prepare"
    #: S3：Speaker Inversion 训练（30-6）。独占显卡
    TRAIN = "train"
    #: 合成（目前仍是同步接口，占位以便将来长文本批量合成复用 JobStore）
    INFER = "infer"


@dataclass
class JobStage:
    """流水线中的一步，用于向前端呈现细分进度。"""

    key: str
    label: str
    state: JobState = JobState.QUEUED
    detail: str = ""
    started_at: int | None = None
    finished_at: int | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "label": self.label,
            "state": self.state.value,
            "detail": self.detail,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
        }


@dataclass
class Job:
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])
    kind: JobKind = JobKind.PREPARE
    name: str = ""
    state: JobState = JobState.QUEUED
    progress: float = 0.0
    message: str = ""
    error: str | None = None
    stages: list[JobStage] = field(default_factory=list)
    logs: list[dict[str, Any]] = field(default_factory=list)
    artifacts: dict[str, Any] = field(default_factory=dict)
    request: dict[str, Any] = field(default_factory=dict)
    created_at: int = field(default_factory=lambda: int(time.time() * 1000))
    started_at: int | None = None
    finished_at: int | None = None

    @property
    def elapsed_ms(self) -> int:
        end = self.finished_at or int(time.time() * 1000)
        return max(0, end - self.created_at)

    @property
    def waiting_ms(self) -> int:
        start = self.started_at or self.finished_at or int(time.time() * 1000)
        return max(0, start - self.created_at)

    def to_dict(self, with_logs: bool = True) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "id": self.id,
            "kind": self.kind.value,
            "name": self.name,
            "state": self.state.value,
            "progress": round(self.progress, 3),
            "message": self.message,
            "error": self.error,
            "stages": [stage.to_dict() for stage in self.stages],
            "artifacts": self.artifacts,
            "created_at": self.created_at,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "elapsed_ms": self.elapsed_ms,
            "waiting_ms": self.waiting_ms,
        }
        if with_logs:
            payload["logs"] = self.logs[-MAX_LOGS:]
            payload["log_count"] = len(self.logs)
        return payload


class JobStore:
    """线程安全的内存任务表 + 轻量磁盘持久化。

    落盘目录 `<data_dir>/jobs/<id>.json`：服务重启后历史任务仍可查（与 trainer 同口径）。
    日志不进 meta（频繁落盘会拖慢编码循环），只在终态时随 `persist` 一起写。
    """

    def __init__(self, jobs_dir: Path) -> None:
        self._dir = jobs_dir
        self._dir.mkdir(parents=True, exist_ok=True)
        self._jobs: dict[str, Job] = {}
        self._cancel: dict[str, threading.Event] = {}
        self._lock = threading.RLock()
        self._load()

    # ---------- 基础操作 ----------
    def create(
        self,
        kind: JobKind,
        name: str,
        request: dict[str, Any] | None = None,
        stages: Iterable[JobStage] = (),
    ) -> Job:
        job = Job(kind=kind, name=name, request=request or {}, stages=list(stages))
        with self._lock:
            self._jobs[job.id] = job
            self._cancel[job.id] = threading.Event()
        self.persist(job)
        return job

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            return self._jobs.get(job_id)

    def list(self, kind: JobKind | None = None, limit: int = 50) -> list[Job]:
        with self._lock:
            items = list(self._jobs.values())
        if kind is not None:
            items = [job for job in items if job.kind is kind]
        items.sort(key=lambda job: job.created_at, reverse=True)
        return items[:limit]

    def active_count(self, kind: JobKind | None = None) -> int:
        with self._lock:
            return sum(
                1
                for job in self._jobs.values()
                if (kind is None or job.kind is kind) and not job.state.terminal
            )

    def delete(self, job_id: str) -> bool:
        with self._lock:
            job = self._jobs.pop(job_id, None)
            self._cancel.pop(job_id, None)
        if job is None:
            return False
        (self._dir / f"{job_id}.json").unlink(missing_ok=True)
        return True

    # ---------- 状态流转 ----------
    def update(self, job: Job, **changes: Any) -> Job:
        """统一的状态变更入口：时间戳 + 落盘都在这里做，调用方别自己改字段。"""
        for key, value in changes.items():
            setattr(job, key, value)
        if "state" in changes:
            now = int(time.time() * 1000)
            if changes["state"] is JobState.RUNNING and job.started_at is None:
                job.started_at = now
            if getattr(changes["state"], "terminal", False) and job.finished_at is None:
                job.finished_at = now
                # 终态才把日志一起落盘（见类注释）
                self._drop_cancel(job.id)
        self.persist(job)
        return job

    def log(self, job: Job, text: str, level: str = "info") -> None:
        entry = {"ts": int(time.time() * 1000), "level": level, "text": text.rstrip()}
        with self._lock:
            job.logs.append(entry)
            if len(job.logs) > MAX_LOGS:
                del job.logs[: len(job.logs) - MAX_LOGS]

    def stage(self, job: Job, key: str, state: JobState, detail: str = "") -> None:
        now = int(time.time() * 1000)
        for stage in job.stages:
            if stage.key != key:
                continue
            stage.state = state
            if detail:
                stage.detail = detail
            if state is JobState.RUNNING and stage.started_at is None:
                stage.started_at = now
            if getattr(state, "terminal", False):
                stage.finished_at = now
            break
        if job.stages:
            done = sum(1 for stage in job.stages if stage.state.terminal)
            job.progress = round(done / len(job.stages), 3)
        self.persist(job)

    def set_progress(self, job: Job, progress: float, message: str | None = None) -> None:
        """阶段内的细进度（如「已编码 7/20 条」）。

        与 `stage()` 的分工：stage 管「走到第几步」，这里管「这一步走了多少」。
        整体 progress 取两者较大值，避免细进度把已完成阶段的进度冲回去。
        """
        job.progress = round(max(job.progress, min(max(progress, 0.0), 1.0)), 3)
        if message:
            job.message = message

    # ---------- 取消 ----------
    def request_cancel(self, job: Job) -> None:
        with self._lock:
            event = self._cancel.get(job.id)
        if event is not None:
            event.set()

    def is_cancelled(self, job_id: str) -> bool:
        with self._lock:
            event = self._cancel.get(job_id)
        return bool(event is not None and event.is_set())

    def _drop_cancel(self, job_id: str) -> None:
        with self._lock:
            self._cancel.pop(job_id, None)

    # ---------- 持久化 ----------
    def persist(self, job: Job) -> None:
        """写 meta 到磁盘。失败不该影响主流程，因此静默吞掉异常。"""
        try:
            (self._dir / f"{job.id}.json").write_text(
                json.dumps(job.to_dict(with_logs=False), ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except OSError:
            pass

    def _load(self) -> None:
        """重启后恢复历史任务。

        ⚠️ 恢复出来的一律是**终态**：进程重启后不可能还有线程在跑它，
        而「running」的任务会永远卡在前端的轮询里。trainer 那边有同样的处理。
        """
        for path in self._dir.glob("*.json"):
            try:
                raw = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            try:
                state = JobState(raw.get("state", "queued"))
                job = Job(
                    id=raw["id"],
                    kind=JobKind(raw.get("kind", "prepare")),
                    name=raw.get("name", ""),
                    state=state if state.terminal else JobState.CANCELLED,
                    progress=raw.get("progress", 0.0),
                    message=raw.get("message", ""),
                    error=raw.get("error")
                    or (None if state.terminal else "服务重启，任务中断"),
                    artifacts=raw.get("artifacts", {}),
                    request=raw.get("request", {}),
                    created_at=raw.get("created_at", 0),
                    started_at=raw.get("started_at"),
                    finished_at=raw.get("finished_at"),
                )
                job.stages = [
                    JobStage(
                        key=item["key"],
                        label=item.get("label", item["key"]),
                        state=JobState(item.get("state", "queued")),
                        detail=item.get("detail", ""),
                        started_at=item.get("started_at"),
                        finished_at=item.get("finished_at"),
                    )
                    for item in raw.get("stages", [])
                ]
            except (KeyError, ValueError):
                continue
            self._jobs[job.id] = job

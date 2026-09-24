"""任务模型与存储。

任务（Job）是调度的最小单位，分两类：

- infer：短任务，秒级，受推理并发闸门约束；
- train：长任务，分钟~小时级，受训练并发闸门 + 显存准入双重约束。

元信息会在状态变更时落盘到 `<data_dir>/jobs/<id>.json`，
这样服务重启后历史任务仍然可查，不必依赖外部数据库。
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
    INFER = "infer"
    TRAIN = "train"
    #: 音源分离（UVR5）。耗时与显卡占用都接近一次推理，归到推理池
    SEPARATE = "separate"
    #: 语音变声（RVC）：推理与训练
    VC_INFER = "vc_infer"
    VC_TRAIN = "vc_train"
    #: 歌声转换（DDSP-SVC）：推理（含翻唱向导）与训练
    SVC_INFER = "svc_infer"
    SVC_TRAIN = "svc_train"


#: 走「推理池」的种类：短任务，秒级~分钟级
INFER_POOL: frozenset = frozenset(
    {JobKind.INFER, JobKind.SEPARATE, JobKind.VC_INFER, JobKind.SVC_INFER}
)

#: 走「训练池」的种类：长任务，独占显卡
TRAIN_POOL: frozenset = frozenset({JobKind.TRAIN, JobKind.VC_TRAIN, JobKind.SVC_TRAIN})


def pool_of(kind: "JobKind") -> JobKind:
    """任务种类 → 队列池。

    新增的几种任务刻意**不新建池**：池的并发度是按「推理 / 训练」这两类资源语义
    配的（见 `Settings.max_infer_concurrency`），再按板块拆分只会让"同时能跑几个"
    变得难以解释。种类仍然细分，因为它决定产物类型、历史筛选与前端文案。
    """
    return JobKind.TRAIN if kind in TRAIN_POOL else JobKind.INFER


@dataclass
class JobStage:
    """流水线中的一步，用于向前端呈现细分进度。"""

    key: str
    label: str
    state: JobState = JobState.QUEUED
    detail: str = ""
    started_at: int | None = None
    finished_at: int | None = None

    def to_dict(self) -> dict:
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
    kind: JobKind = JobKind.INFER
    name: str = ""
    owner: str = "anonymous"
    state: JobState = JobState.QUEUED
    progress: float = 0.0
    message: str = ""
    error: str | None = None
    stages: list[JobStage] = field(default_factory=list)
    logs: list[dict] = field(default_factory=list)
    artifacts: dict[str, Any] = field(default_factory=dict)
    request: dict[str, Any] = field(default_factory=dict)
    priority: int = 0  # 数值越大越优先
    created_at: int = field(default_factory=lambda: int(time.time() * 1000))
    started_at: int | None = None
    finished_at: int | None = None

    # ---------- 派生 ----------
    @property
    def elapsed_ms(self) -> int:
        end = self.finished_at or int(time.time() * 1000)
        return max(0, end - self.created_at)

    @property
    def waiting_ms(self) -> int:
        """排队等待时长，是衡量调度质量的关键指标。"""
        start = self.started_at or self.finished_at or int(time.time() * 1000)
        return max(0, start - self.created_at)

    def to_dict(self, with_logs: bool = True) -> dict:
        payload: dict[str, Any] = {
            "id": self.id,
            "kind": self.kind.value,
            "name": self.name,
            "owner": self.owner,
            "state": self.state.value,
            "progress": round(self.progress, 3),
            "message": self.message,
            "error": self.error,
            "stages": [stage.to_dict() for stage in self.stages],
            "artifacts": self.artifacts,
            "priority": self.priority,
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
    """线程安全的内存任务表 + 轻量磁盘持久化。"""

    def __init__(self, jobs_dir: Path) -> None:
        self._dir = jobs_dir
        self._dir.mkdir(parents=True, exist_ok=True)
        self._jobs: dict[str, Job] = {}
        self._lock = threading.RLock()
        self._load()

    # ---------- 基础操作 ----------
    def create(
        self,
        kind: JobKind,
        name: str,
        request: dict[str, Any] | None = None,
        stages: Iterable[JobStage] = (),
        owner: str = "anonymous",
        priority: int = 0,
    ) -> Job:
        job = Job(
            kind=kind,
            name=name,
            request=request or {},
            stages=list(stages),
            owner=owner,
            priority=priority,
        )
        with self._lock:
            self._jobs[job.id] = job
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

    def active_count(self, kind: JobKind) -> int:
        with self._lock:
            return sum(1 for job in self._jobs.values() if job.kind is kind and not job.state.terminal)

    def delete(self, job_id: str) -> bool:
        with self._lock:
            job = self._jobs.pop(job_id, None)
        if job is None:
            return False
        (self._dir / f"{job_id}.json").unlink(missing_ok=True)
        return True

    # ---------- 状态流转 ----------
    def update(self, job: Job, **changes: Any) -> Job:
        """统一的状态变更入口，负责入混乱同步、时间戳与持久化。"""
        for key, value in changes.items():
            setattr(job, key, value)
        if "state" in changes:
            now = int(time.time() * 1000)
            if changes["state"] is JobState.RUNNING and job.started_at is None:
                job.started_at = now
            if getattr(changes["state"], "terminal", False) and job.finished_at is None:
                job.finished_at = now
        self.persist(job)
        return job

    def log(self, job: Job, text: str, level: str = "info") -> None:
        entry = {"ts": int(time.time() * 1000), "level": level, "text": text.rstrip()}
        with self._lock:
            job.logs.append(entry)
            if len(job.logs) > MAX_LOGS:
                del job.logs[: len(job.logs) - MAX_LOGS]
        # 日志不入 meta，避免频繁落盘影响调度；仅在终态时持久化

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
        # 依据已完成的步骤数推进整体进度，使前端无需等待终态即有反馈
        if job.stages:
            done = sum(1 for stage in job.stages if stage.state.terminal)
            job.progress = round(done / len(job.stages), 3)
        self.persist(job)

    # ---------- 持久化 ----------
    def persist(self, job: Job) -> None:
        """写 meta 到磁盘。失败不应影响主流程，因此静默吞掉异常。"""
        try:
            (self._dir / f"{job.id}.json").write_text(
                json.dumps(job.to_dict(with_logs=False), ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except OSError:
            pass

    def _load(self) -> None:
        """重启后恢复历史任务，便于查询以往的训练记录。"""
        for path in self._dir.glob("*.json"):
            try:
                raw = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            try:
                job = Job(
                    id=raw["id"],
                    kind=JobKind(raw.get("kind", "infer")),
                    name=raw.get("name", ""),
                    owner=raw.get("owner", "anonymous"),
                    state=JobState(raw.get("state", "queued")),
                    progress=raw.get("progress", 0.0),
                    message=raw.get("message", ""),
                    error=raw.get("error"),
                    artifacts=raw.get("artifacts", {}),
                    request=raw.get("request", {}),
                    priority=raw.get("priority", 0),
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

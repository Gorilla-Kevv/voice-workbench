"""任务调度与资源准入。

公网模式的核心风险不是「算不动」，而是「被挤爆」：
长训练任务一旦排队，短推理任务会被饿死；多人并发又会互相抢显存最终一起 OOM。
因此这里做了三件事：

1. **按任务类型分池**——推理与训练各自独立队列，训练占满 GPU 也不会阻塞试听合成；
2. **显存准入**——派发前确认剩余显存充足，宁可多等几秒也不让任务在半途 OOM；
3. **配额与队列上限**——超出即刻拒绝并返回 retryable 提示，避免请求无限堆积。
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Awaitable, Callable, Optional

from .config import Settings
from .jobs import Job, JobKind, JobState, JobStore, pool_of

Runner = Callable[[Job, asyncio.Event], Awaitable[dict]]


# ------------------------- 拒绝原因 -------------------------


class AdmissionError(Exception):
    """准入失败。携带可直接返回给前端的结构化信息。"""

    def __init__(self, code: str, message: str, retryable: bool = True, retry_after_s: int = 5) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable
        self.retry_after_s = retry_after_s

    def to_dict(self) -> dict:
        return {
            "code": self.code,
            "message": self.message,
            "retryable": self.retryable,
            "retry_after_s": self.retry_after_s,
        }


def queue_full(kind: str, size: int) -> AdmissionError:
    return AdmissionError(
        "QUEUE_FULL",
        f"{'训练' if kind == 'train' else '推理'}队列已满（{size}），服务繁忙，请稍后重试",
        retry_after_s=15,
    )


def quota_exceeded(scope: str, limit: int) -> AdmissionError:
    return AdmissionError(
        "QUOTA_EXCEEDED",
        f"今日{scope}额度已用尽（上限 {limit}）",
        retryable=False,
    )


# ------------------------- 显存查询 -------------------------


def free_vram_mb() -> Optional[int]:
    """查询可用显存（MB）。未知时返回 None，调用方据此决定是否拦截。

    本服务与模型跑在同一进程里，直接问 torch 最准；
    它比 `nvidia-smi` 还多一层好处：不需要外部可执行文件在 PATH 上。
    """
    from .runtime import free_vram_mb as _free_vram_mb  # noqa: PLC0415 - 避免循环导入

    return _free_vram_mb()


# ------------------------- 队列条目 -------------------------


@dataclass(order=True)
class QueueItem:
    """优先级队列条目。数值越小越先出队，因此 priority 取负。"""

    neg_priority: int = 0
    created_at: int = 0
    job: Job = field(compare=False, default=None)  # type: ignore[assignment]


class Pool:
    """一个任务池。

    注意 `queue` 刻意延迟到 `prepare()` 才创建 —— 它必须在**事件循环内部**构造。
    `Scheduler` 是在服务启动前（还没有 event loop 时）装配的，
    而 Python 3.9 的 `asyncio.Queue.__init__` 会立刻绑定当前 loop；
    若在这里就建好，队列会挂在那个永远不会运行 loop 上，
    表现为「任务入队后状态永远是 queued」——一个极难排查的死锁。
    """

    def __init__(self, kind: JobKind, concurrency: int, max_queue: int) -> None:
        self.kind = kind
        self.concurrency = concurrency
        self.max_queue = max_queue
        self.queue: Optional["asyncio.PriorityQueue[QueueItem]"] = None
        self.running: set[str] = set()
        self.workers: list = []

    def prepare(self) -> None:
        """在事件循环内创建队列。由 `Scheduler.start()` 调用。"""
        if self.queue is None:
            self.queue = asyncio.PriorityQueue(maxsize=self.max_queue)

    @property
    def ready(self) -> bool:
        return self.queue is not None

    @property
    def queued(self) -> int:
        return self.queue.qsize() if self.queue is not None else 0

    def snapshot(self) -> dict:
        return {
            "concurrency": self.concurrency,
            "running": len(self.running),
            "queued": self.queued,
            "max_queue": self.max_queue,
            "ready": self.ready,
        }


class Scheduler:
    """任务调度器。负责准入、排队、派发与取消。"""

    def __init__(self, settings: Settings, store: JobStore) -> None:
        self.settings = settings
        self.store = store
        self.pools = {
            JobKind.INFER: Pool(JobKind.INFER, settings.max_infer_concurrency, settings.max_queue_size),
            JobKind.TRAIN: Pool(JobKind.TRAIN, settings.max_train_concurrency, settings.max_queue_size),
        }
        self._runners: dict[JobKind, Runner] = {}
        self._cancel: dict[str, asyncio.Event] = {}
        self._usage: dict[tuple[str, str, str], int] = {}  # (owner, kind, date) -> count
        self._started = False

    # ---------- 注册执行体 ----------
    def register(self, kind: JobKind, runner: Runner) -> None:
        self._runners[kind] = runner

    # ---------- 生命周期 ----------
    async def start(self) -> None:
        """必须在事件循环内调用（见 `Pool` 的注释）。幂等。"""
        if self._started:
            return
        for pool in self.pools.values():
            pool.prepare()
            for index in range(pool.concurrency):
                pool.workers.append(
                    asyncio.create_task(self._worker(pool), name="sovits-%s-%d" % (pool.kind.value, index))
                )
        self._started = True

    @property
    def started(self) -> bool:
        return self._started

    async def stop(self) -> None:
        for pool in self.pools.values():
            for worker in pool.workers:
                worker.cancel()
            pool.workers.clear()
        self._started = False

    # ---------- 准入 ----------
    def _check_quota(self, job: Job) -> None:
        if not self.settings.is_public:
            return  # local 模式不做配额约束
        limit = (
            self.settings.daily_infer_quota
            if pool_of(job.kind) is JobKind.INFER
            else self.settings.daily_train_quota
        )
        if not limit:
            return
        today = time.strftime("%Y-%m-%d", time.localtime())
        key = (job.owner, job.kind.value, today)
        used = self._usage.get(key, 0)
        if used >= limit:
            raise quota_exceeded("训练" if pool_of(job.kind) is JobKind.TRAIN else "推理", limit)

    def _bump_quota(self, job: Job) -> None:
        if not self.settings.is_public:
            return
        today = time.strftime("%Y-%m-%d", time.localtime())
        key = (job.owner, job.kind.value, today)
        self._usage[key] = self._usage.get(key, 0) + 1

    def quota_snapshot(self, owner: str) -> dict:
        today = time.strftime("%Y-%m-%d", time.localtime())
        return {
            "infer": {
                "used": self._usage.get((owner, JobKind.INFER.value, today), 0),
                "limit": self.settings.daily_infer_quota,
            },
            "train": {
                "used": self._usage.get((owner, JobKind.TRAIN.value, today), 0),
                "limit": self.settings.daily_train_quota,
            },
        }

    # ---------- 提交 ----------
    def submit(self, job: Job) -> Job:
        """入队。失败时抛 AdmissionError，由路由层转为 HTTP 响应。"""
        self._check_quota(job)
        pool = self.pools[pool_of(job.kind)]
        if pool.queue is None:
            # 正常情况下 lifecyle 已保证 start() 被调用；这里显式失败，
            # 好过让任务永远停在 queued —— 那是最难查的一类故障。
            raise AdmissionError(
                "SCHEDULER_NOT_STARTED",
                "任务调度器尚未启动，无法接收任务",
                retryable=True,
                retry_after_s=3,
            )
        item = QueueItem(neg_priority=-job.priority, created_at=job.created_at, job=job)
        try:
            pool.queue.put_nowait(item)
        except asyncio.QueueFull as exc:
            raise queue_full(job.kind.value, pool.max_queue) from exc
        self._bump_quota(job)
        self._cancel[job.id] = asyncio.Event()
        self.store.log(job, f"已入队，前方等待 {pool.queued} 个任务")
        return job

    def cancel(self, job: Job) -> None:
        event = self._cancel.get(job.id)
        if event is not None:
            event.set()
        if job.state in {JobState.QUEUED, JobState.RUNNING}:
            self.store.update(job, state=JobState.CANCELLED, message="已被用户取消")

    def cancel_event(self, job: Job) -> asyncio.Event:
        if job.id not in self._cancel:
            self._cancel[job.id] = asyncio.Event()
        return self._cancel[job.id]

    # ---------- 派发 ----------
    async def _wait_for_vram(self, job: Job) -> None:
        """显存准入：训练类任务在显存不足时等待而非立即失败。"""
        if not self.settings.is_public:
            return
        need = self.settings.vram_reserve_mb
        deadline = time.monotonic() + 300
        while time.monotonic() < deadline:
            free = free_vram_mb()
            if free is None or free >= need:
                return  # 未知环境下不做拦截，避免误判
            self.store.update(job, message=f"等待显存释放（当前可用 {free}MB / 需要 {need}MB）")
            await asyncio.sleep(5)
        raise AdmissionError("VRAM_BUSY", f"等待显存超时：可用显存持续低于 {need}MB", retry_after_s=60)

    async def _worker(self, pool: Pool) -> None:
        while True:
            item = await pool.queue.get()
            job = item.job
            try:
                if job.state is JobState.CANCELLED:
                    continue
                await self._execute(pool, job)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - worker 不应因单个任务崩溃而退出
                self.store.update(
                    job, state=JobState.FAILED, error=f"{type(exc).__name__}: {exc}"
                )
            finally:
                pool.queue.task_done()
                pool.running.discard(job.id)
                self._cancel.pop(job.id, None)

    async def _execute(self, pool: Pool, job: Job) -> None:
        runner = self._runners.get(job.kind)
        if runner is None:
            self.store.update(job, state=JobState.FAILED, error="该类型任务未注册执行体")
            return

        await self._wait_for_vram(job)
        if self.cancel_event(job).is_set():
            self.store.update(job, state=JobState.CANCELLED, message="已被用户取消")
            return

        pool.running.add(job.id)
        self.store.update(job, state=JobState.RUNNING, message="任务开始执行")

        started = time.monotonic()
        try:
            artifacts = await runner(job, self.cancel_event(job))
        except asyncio.CancelledError:
            self.store.update(job, state=JobState.CANCELLED, message="已被用户取消")
            return
        except AdmissionError as exc:
            self.store.update(job, state=JobState.FAILED, error=exc.message)
            return
        except Exception as exc:  # noqa: BLE001
            self.store.update(job, state=JobState.FAILED, error=f"{type(exc).__name__}: {exc}")
            return

        self.store.log(
            job, f"完成，用时 {time.monotonic() - started:.1f}s", level="success"
        )
        self.store.update(
            job,
            state=JobState.SUCCEEDED,
            progress=1.0,
            artifacts=artifacts or {},
            message="任务完成",
        )

    # ---------- 观测 ----------
    def snapshot(self) -> dict:
        return {
            "mode": self.settings.mode.value,
            "infer": self.pools[JobKind.INFER].snapshot(),
            "train": self.pools[JobKind.TRAIN].snapshot(),
            "vram_free_mb": free_vram_mb(),
        }

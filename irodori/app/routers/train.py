"""训练侧路由（30-5：S1 数据整备 + S2 latent 编码；30-6：S3 Speaker Inversion 训练）。

形态对齐 `docs/IRODORI-INTEGRATION-PLAN.md` §4.2：

| 端点 | 作用 |
| --- | --- |
| `POST /v1/train/plan` | **只回显计划，不执行** |
| `POST /v1/train/upload` | 语料上传（音频 + 同名 `.txt`，或 zip） |
| `POST /v1/train/prepare` | 入队跑 S1+S2（轮询式，与 trainer `/v1/train` 同形态） |
| `POST /v1/train` | 入队跑 S3（SI 训练：自动 batch → 训练 → 产物登记） |
| `POST /v1/train/auto_batch` | 自动 batch 探测（`?probe=0` 只给启发式推荐） |
| `GET /v1/train/datasets` | 已整备好的数据集 |
| `GET /v1/jobs[/:id]`、`POST /v1/jobs/:id/cancel` | JobStore |

⚠️ 整备与推理**互斥**（都走 `engine` 的 busy 锁）：整备只加载 codec，所以入队前会
先把常驻的 TTS 模型卸载 —— 4.7GB 放在显存里纯属浪费，而本机只有 8GB。
**训练更占**：它在整张卡上跑几十分钟，入队前除了卸载还要按 `train` 档重新做准入。
"""

from __future__ import annotations

import threading
import time
import zipfile
from pathlib import Path
from typing import Any, Optional

from fastapi import Body, FastAPI, File, Form, UploadFile

from .. import engine, si_train, traindata
from ..config import Settings
from ..errors import IrodoriError
from ..hardware import vram_mb
from ..inventory import scan
from ..jobs import Job, JobKind, JobStage, JobState, JobStore
from ..si_train import BatchPlan

#: 上传目录里允许落盘的后缀（zip 单独处理）
_ALLOWED_UPLOAD_SUFFIXES = (
    traindata.AUDIO_SUFFIXES | traindata.TEXT_SUFFIXES | {".json", ".jsonl", ".zip"}
)


def register(app: FastAPI, settings: Settings, store: JobStore) -> None:
    """把训练路由挂到 app 上。

    刻意写成「函数 + app 参数」而不是 `APIRouter`：本服务的路由都在 `api.py`
    里按「一条路由一个函数」平铺，这里只是把训练那几条单独拆文件，
    保持同样的装配方式（create_app 里一行 `train.register(...)`）。
    """

    def _body(payload: Any) -> dict[str, Any]:
        if payload is None:
            return {}
        if not isinstance(payload, dict):
            raise IrodoriError("BAD_REQUEST", "请求体必须是 JSON 对象", "检查 Content-Type 与 body 结构。")
        return payload

    def _job_or_404(job_id: str) -> Job:
        job = store.get(job_id)
        if job is None:
            raise IrodoriError(
                "JOB_NOT_FOUND",
                f"任务不存在：{job_id}",
                "任务 id 来自 POST /v1/train/prepare 的返回；服务重启后旧任务仍在 /v1/jobs 列表里。",
                status=404,
            )
        return job

    # ------------------------------------------------------------------
    # 计划（不执行）
    # ------------------------------------------------------------------

    @app.post("/v1/train/plan")
    def train_plan(payload: Any = Body(default=None)) -> dict[str, Any]:
        """回显三步计划与数据体检结果，**不跑任何编码**。

        数据问题（缺转写、音频不可读、转写不是日语）都在这里报清楚 ——
        这是「改几个文件就能修好」的错误，不该等用户排了 20 分钟队才看见。
        """
        request = _body(payload)
        collection = traindata.collect(settings, request)
        inventory = scan(settings)
        tips = traindata.review(collection)
        return {
            "ok": True,
            "service": "irodori",
            "steps": [
                {
                    "key": "s1",
                    "label": "数据整备",
                    "state": "ready" if collection.items else "blocked",
                    "detail": f"{len(collection.items)} 条可用 / 扫描到 {collection.scanned} 个音频"
                              f" / 合计 {collection.total_seconds:.1f}s",
                },
                {
                    "key": "s2",
                    "label": "latent 编码",
                    "state": "ready" if collection.items else "blocked",
                    "detail": "写 manifest.jsonl（written 必须等于待编码条数，否则 422 TRAIN_MANIFEST_EMPTY）",
                },
                {
                    "key": "s3",
                    "label": "Speaker Inversion 训练",
                    # 训练不仅需要 bf16 基座，还需要已整备好的数据集 —— 两个都齐才 ready
                    "state": _s3_state(inventory["training_ready"], traindata.list_datasets(settings)),
                    "detail": _s3_detail(settings, inventory["training_ready"], traindata.list_datasets(settings)),
                },
            ],
            "data": {
                **collection.to_dict(),
                "items": [item.to_dict() for item in collection.items[:20]],
            },
            "warnings": tips,
            "ready_to_prepare": len(collection.items) > 0,
            "training": _training_section(settings, inventory["training_ready"]),
        }

    # ------------------------------------------------------------------
    # 上传
    # ------------------------------------------------------------------

    @app.post("/v1/train/upload")
    async def train_upload(
        files: list[UploadFile] = File(default=[]),  # noqa: B008
        dataset_id: str = Form(default=""),  # noqa: B008
    ) -> dict[str, Any]:
        """接收语料，落到 `<data_dir>/uploads/<dataset_id>/`。

        同时接受 `.zip`（整体解压，含路径穿越防护）。转写的约定：
        `001.wav` 配 `001.txt`，或用 `metadata.jsonl`（每行 `{"file","text"}`）。
        """
        if not files:
            raise IrodoriError("NO_FILES", "没有收到文件", "至少上传一个音频文件；配同名 .txt 给转写。")
        target_id = dataset_id.strip() or traindata.new_dataset_id()
        directory = traindata.upload_dir(settings, target_id)
        directory.mkdir(parents=True, exist_ok=True)

        saved: list[dict[str, Any]] = []
        skipped: list[dict[str, Any]] = []
        for upload in files:
            name = Path(upload.filename or "").name
            suffix = Path(name).suffix.lower()
            if suffix not in _ALLOWED_UPLOAD_SUFFIXES:
                skipped.append({"name": name, "reason": f"不支持的扩展名 {suffix or '(无)'}"})
                continue
            # 只取文件名：客户端可能带相对路径（../../evil.wav）
            destination = directory / name
            content = await upload.read()
            destination.write_bytes(content)
            saved.append({"name": name, "size": len(content), "kind": _kind_of(suffix)})
            if suffix == ".zip":
                saved.extend(_extract_zip(destination, directory, skipped))

        return {
            "ok": True,
            "dataset_id": target_id,
            "dir": str(directory),
            "files": saved,
            "skipped": skipped,
            "audio_count": sum(1 for item in saved if item["kind"] == "audio"),
            "hint": "下一步：POST /v1/train/plan 看体检结果，再 POST /v1/train/prepare 入队。",
        }

    # ------------------------------------------------------------------
    # 入队（S1+S2）
    # ------------------------------------------------------------------

    @app.post("/v1/train/prepare")
    def train_prepare(payload: Any = Body(default=None)) -> dict[str, Any]:
        """入队跑 S1+S2，立刻返回 job（前端 2s 轮询 `GET /v1/jobs/:id`）。

        前置动作刻意放在**入队之前**（不是丢给工作线程）：模型卸载与显存准入
        失败时用户立刻拿到明确错误，而不是等轮询才发现任务已经 failed。
        """
        request = _body(payload)
        job = store.create(
            JobKind.PREPARE,
            name=str(request.get("name") or "数据整备（S1+S2）"),
            request=request,
            stages=[
                JobStage(key="collect", label="收集语料与转写"),
                JobStage(key="encode", label="latent 编码"),
                JobStage(key="manifest", label="写 manifest 并断言非空"),
            ],
        )
        if not engine.try_acquire_busy():
            store.update(
                job,
                state=JobState.FAILED,
                error="ENGINE_BUSY",
                message="已有一条合成/训练在跑，显存同一时刻只服务一个请求",
            )
            raise IrodoriError(
                "ENGINE_BUSY",
                "已有一条合成/训练在跑，显存同一时刻只服务一个请求",
                "等它跑完（看 /v1/jobs 的状态），或先 POST /v1/unload 释放常驻显存。",
                status=409,
                retryable=True,
            )
        try:
            if engine.is_loaded():
                store.log(job, "检测到推理模型常驻显存，先卸载（整备只需要 codec）")
                engine.unload(settings)
            # 准入按 codec 档（1500MB）：整备不吃 TTS 模型，不该拿 4.7GB 去卡它
            engine.check_vram_admission(settings, loaded=False, task="prepare")
        except IrodoriError as error:
            store.update(job, state=JobState.FAILED, error=error.code, message=error.message)
            engine.release_busy()
            raise

        thread = threading.Thread(
            target=_run_prepare, args=(settings, store, job), name=f"irodori-prepare-{job.id}", daemon=True
        )
        thread.start()
        return {
            "ok": True,
            "job": job.to_dict(),
            "hint": "轮询 GET /v1/jobs/{id} 看进度；POST /v1/jobs/{id}/cancel 取消。",
        }

    # ------------------------------------------------------------------
    # S3（30-6 落地）
    # ------------------------------------------------------------------

    @app.post("/v1/train")
    def train_start(payload: Any = Body(default=None)) -> dict[str, Any]:
        """入队跑 S3（Speaker Inversion 训练），立刻返回 job。

        四个阶段（见 JobStage）：`plan`（batch 探测）→ `train`（子进程训练）→
        `save`（收产物 + 断言）→ `register`（登记进音色库）。

        **为什么 “纯请求错误” 要在建任务之前报掉**：数据集 id 写错、步数填了 0、
        训练基座没下 —— 这些都是「改一下请求就想再来一次」的错误，没必要在
        `/v1/jobs` 里留一串 failed 记录给用户自己擦屁股。反过来，显存准入与互斥
        失败**留在任务里**（那是环境状态，用户很可能想知道刚才到底为什么没跑起来）。
        """
        request = _body(payload)
        inventory = scan(settings)
        if not inventory["training_ready"]:
            raise IrodoriError(
                "TRAIN_BASE_MISSING",
                "训练档权重未就绪（bf16 基座），无法开始训练",
                "npm run irodori:weights -- --training 下载基座（约 2.9GB）；推理不受影响。",
                status=503,
                retryable=True,
                details={"missing": [item["target"] for item in inventory["missing"]]},
            )

        dataset_id, manifest = si_train.dataset_manifest(
            settings, str(request.get("dataset_id") or "")
        )
        stats = si_train.manifest_stats(manifest)
        si_train.assert_trainable(stats, manifest)

        steps = _coerce_steps(settings, request.get("steps"))
        voice_id = str(request.get("voice_id") or "").strip() or None
        speaker_id = str(request.get("speaker_id") or "").strip() or f"{dataset_id}-{steps}"
        explicit_batch = request.get("batch")
        explicit_plan: Optional[BatchPlan] = None
        if explicit_batch is not None:
            explicit_plan = BatchPlan(
                batch=max(1, int(explicit_batch)),
                source="explicit",
                note="请求里指定了 batch，跳过自动探测",
            )

        job = store.create(
            JobKind.TRAIN,
            name=str(request.get("name") or f"音色固化训练（{steps} 步）"),
            request={
                **request,
                "dataset_id": dataset_id,
                "steps": steps,
                "speaker_id": speaker_id,
                "voice_id": voice_id,
                "manifest": str(manifest),
            },
            stages=[
                JobStage(key="plan", label="显存与 batch 探测"),
                JobStage(key="train", label=f"SI 训练（{steps} 步）"),
                JobStage(key="save", label="收产物并断言"),
                JobStage(key="register", label="登记进音色库"),
            ],
        )

        if not engine.try_acquire_busy():
            store.update(
                job,
                state=JobState.FAILED,
                error="ENGINE_BUSY",
                message="已有一条合成/训练在跑，显存同一时刻只服务一个请求",
            )
            raise IrodoriError(
                "ENGINE_BUSY",
                "已有一条合成/训练在跑，显存同一时刻只服务一个请求",
                "等它跑完（看 /v1/jobs 的状态），或先 POST /v1/unload 释放常驻显存。",
                status=409,
                retryable=True,
            )
        try:
            # 训练要把整张卡用上几十分钟：先把推理模型请出去，再按训练档做准入
            if engine.is_loaded():
                store.log(job, "检测到推理模型常驻显存，先卸载（训练独占显卡）")
                engine.unload(settings)
            # 准入门槛跟 batch 走（batch 2 与 batch 8 差约 800MB，不该彼此挡路）
            admission_batch = (
                explicit_plan.batch
                if explicit_plan is not None
                else si_train.heuristic_batch(settings, _free_mb()).batch
            )
            engine.check_vram_admission(settings, loaded=False, task="train", batch=admission_batch)
        except IrodoriError as error:
            store.update(job, state=JobState.FAILED, error=error.code, message=error.message)
            store.log(job, f"失败[{error.code}]：{error.message}", level="error")
            engine.release_busy()
            raise

        thread = threading.Thread(
            target=_run_s3,
            args=(settings, store, job, dataset_id, manifest, steps, speaker_id, voice_id, explicit_plan),
            name=f"irodori-train-{job.id}",
            daemon=True,
        )
        thread.start()
        return {
            "ok": True,
            "job": job.to_dict(),
            "batch": (explicit_plan or si_train.heuristic_batch(settings, _free_mb())).to_dict(),
            "hint": "轮询 GET /v1/jobs/{id} 看进度；训练期间合成请求会返回 409。",
        }

    @app.post("/v1/train/auto_batch")
    def auto_batch(payload: Any = Body(default=None)) -> dict[str, Any]:
        """自动 batch 探测。`probe=false`（默认）只按当前空闲显存给启发式推荐。

        真机探测要真的把基座加载起来跑两步（约 1~2 分钟），所以默认不开 ——
        UI 拿它做「预计占用」的预览就够用了；真正开训时 `POST /v1/train` 会自行探测。
        """
        request = _body(payload)
        plan = si_train.heuristic_batch(settings, _free_mb())
        if not request.get("probe"):
            return {"ok": True, "batch": plan.to_dict(), "probed": False}
        dataset_id, manifest = si_train.dataset_manifest(
            settings, str(request.get("dataset_id") or "")
        )
        output_dir = settings.trainings_dir / f"{dataset_id}-probe"
        probed = si_train.probe_batch(
            settings,
            manifest=manifest,
            output_dir=output_dir,
            logger=lambda line: print(f"[irodori][auto-batch] {line}", flush=True),
        )
        return {"ok": True, "batch": probed.to_dict(), "probed": True}

    @app.get("/v1/train/auto_batch")
    def auto_batch_get(dataset_id: str = "", probe: bool = False) -> dict[str, Any]:
        return auto_batch({"dataset_id": dataset_id, "probe": probe})

    # ------------------------------------------------------------------
    # 数据集 / JobStore
    # ------------------------------------------------------------------

    @app.get("/v1/train/datasets")
    def train_datasets() -> dict[str, Any]:
        datasets = traindata.list_datasets(settings)
        return {"ok": True, "datasets": datasets, "count": len(datasets)}

    @app.get("/v1/jobs")
    def list_jobs(kind: str = "", limit: int = 50) -> dict[str, Any]:
        parsed: Optional[JobKind] = None
        if kind:
            try:
                parsed = JobKind(kind)
            except ValueError as error:
                raise IrodoriError("BAD_REQUEST", f"未知的任务种类：{kind}",
                                   f"可用：{'、'.join(item.value for item in JobKind)}。") from error
        jobs = store.list(parsed, max(1, min(limit, 200)))
        return {"ok": True, "jobs": [job.to_dict(with_logs=False) for job in jobs],
                "count": len(jobs), "active": store.active_count(parsed)}

    @app.get("/v1/jobs/{job_id}")
    def get_job(job_id: str) -> dict[str, Any]:
        return {"ok": True, "job": _job_or_404(job_id).to_dict()}

    @app.post("/v1/jobs/{job_id}/cancel")
    def cancel_job(job_id: str) -> dict[str, Any]:
        job = _job_or_404(job_id)
        if job.state.terminal:
            return {"ok": True, "job": job.to_dict(), "cancelled": False,
                    "hint": "任务已结束（成功/失败/取消），无需再取消。"}
        store.request_cancel(job)
        store.log(job, "收到取消请求，会在下一条片段编码前停下")
        return {"ok": True, "job": job.to_dict(), "cancelled": True,
                "hint": "取消点在下一条片段之前；已写入的 latent 不复用，重跑是整份重来。"}


# --------------------------------------------------------------------------
# 工作线程
# --------------------------------------------------------------------------


def _run_prepare(settings: Settings, store: JobStore, job: Job) -> None:
    """S1+S2 的执行体（后台线程，持有合成互斥锁直到结束）。"""
    request = job.request
    try:
        store.update(job, state=JobState.RUNNING, message="开始数据整备")

        # ---- S1 ----
        store.stage(job, "collect", JobState.RUNNING)
        collection = traindata.collect(settings, request)
        store.log(job, f"扫描 {collection.scanned} 个音频 → {len(collection.items)} 条可用")
        for item in collection.missing_text[:5]:
            store.log(job, f"缺转写，跳过：{item['path']}（{item['reason']}）", level="warn")
        for item in collection.unreadable[:5]:
            store.log(job, f"音频不可读，跳过：{item['path']}", level="warn")
        for tip in traindata.review(collection):
            store.log(job, f"提示：{tip}", level="warn")
        if store.is_cancelled(job.id):
            _finish_cancelled(store, job, "collect")
            return
        store.stage(
            job,
            "collect",
            JobState.SUCCEEDED,
            detail=f"{len(collection.items)} 条可用 / {collection.total_seconds:.1f}s",
        )

        # ---- S2 ----
        store.stage(job, "encode", JobState.RUNNING)
        dataset_id = str(request.get("dataset_id") or "").strip() or traindata.new_dataset_id()

        def on_progress(done: int, total: int, message: str) -> None:
            # 三段各占 1/3：collect 已完成，这里在 1/3 ~ 2/3 之间推进
            store.set_progress(job, 1 / 3 + (done / max(1, total)) / 3, message)
            if done % 5 == 0 or done == total:
                store.log(job, message)

        result = traindata.encode_manifest(
            settings,
            dataset_id,
            collection,
            speaker_id=str(request.get("speaker_id") or "").strip() or None,
            on_progress=on_progress,
            is_cancelled=lambda: store.is_cancelled(job.id),
        )
        store.stage(job, "encode", JobState.SUCCEEDED, detail=f"{result.written} 条 latent，{result.elapsed_sec:.1f}s")
        store.stage(job, "manifest", JobState.SUCCEEDED, detail=result.manifest_path)
        store.update(
            job,
            state=JobState.SUCCEEDED,
            progress=1.0,
            message=f"整备完成：{result.written} 条（{result.total_frames} frames）",
            artifacts=result.to_dict(),
        )
        store.log(job, f"manifest：{result.manifest_path}")
    except IrodoriError as error:
        if error.code == "JOB_CANCELLED":
            _finish_cancelled(store, job, "encode")
            return
        store.update(job, state=JobState.FAILED, error=error.code, message=error.message)
        store.log(job, f"失败[{error.code}]：{error.message}", level="error")
        if error.details:
            job.artifacts["error_details"] = error.details
            store.persist(job)
    except Exception as error:  # pragma: no cover - 兜底：不能让线程静默死掉
        store.update(job, state=JobState.FAILED, error="INTERNAL",
                     message=f"{type(error).__name__}: {error}")
        store.log(job, f"未预期的异常：{type(error).__name__}: {error}", level="error")
    finally:
        engine.release_busy()
        # 整备用到的 DACVAE 已经不需要了：把 allocator 缓存的这块显存还给驱动，
        # 否则紧接着的训练会被自己上一阶段留下的显存卡住（30-6 真机实测 ~1.2GB）
        engine.release_idle_vram()


def _run_s3(
    settings: Settings,
    store: JobStore,
    job: Job,
    dataset_id: str,
    manifest: Path,
    steps: int,
    speaker_id: str,
    voice_id: Optional[str],
    explicit_plan: Optional[BatchPlan],
) -> None:
    """S3 的执行体（后台线程，持有合成/训练互斥锁直到结束）。

    与 `_run_prepare` 同形：每个阶段之间都检查一次取消 —— 训练是几十分钟级的任务，
    取消点不能只在最后。这里能停的地方是**阶段之间**与**子进程所在的进程边界**
    （训练循环本身我们插不进回调，只能杀进程，见 `si_train._terminate`）。
    """
    request = job.request
    output_dir = settings.trainings_dir / f"{dataset_id}-{job.id}"
    plan: Optional[BatchPlan] = None

    def _logger(text: str) -> None:
        store.log(job, text)

    try:
        store.update(job, state=JobState.RUNNING, message="开始训练（S3 Speaker Inversion）")

        # ---- 阶段 1：batch ----
        store.stage(job, "plan", JobState.RUNNING)
        if explicit_plan is not None:
            plan = explicit_plan
            store.log(job, f"按请求使用 batch={plan.batch}（跳过自动探测）")
        else:
            store.log(job, "自动探测 batch：真跑两步量显存（约 1~2 分钟）")
            try:
                plan = si_train.probe_batch(
                    settings,
                    manifest=manifest,
                    output_dir=output_dir,
                    logger=_logger,
                    is_cancelled=lambda: store.is_cancelled(job.id),
                )
            except IrodoriError as error:
                if error.code != "JOB_CANCELLED":
                    raise
                plan = None
        if plan is None or store.is_cancelled(job.id):
            _finish_cancelled(store, job, "plan")
            return
        store.log(job, f"batch={plan.batch}（{plan.source}）：{plan.note}")
        store.stage(job, "plan", JobState.SUCCEEDED, detail=f"batch={plan.batch} · {plan.source}")

        # ---- 阶段 2：训练 ----
        store.stage(job, "train", JobState.RUNNING)
        last: dict[str, Any] = {}

        def on_step(step: int, loss: Optional[float], eta: Optional[float]) -> None:
            message = f"第 {step}/{steps} 步" + (f" loss={loss:.5f}" if loss is not None else "")
            if eta is not None:
                message += f"，预计还需 {_eta_text(eta)}"
            # plan/train/save/register 四段：训练占中间 80%
            store.set_progress(job, min(0.95, 0.05 + (step / max(1, steps)) * 0.85), message)
            last["step"] = step
            last["loss"] = loss
            if step % 5 == 0 or step == steps:
                store.log(job, message)

        run = si_train.run_training(
            settings,
            manifest=manifest,
            output_dir=output_dir,
            steps=steps,
            batch=plan.batch,
            logger=_logger,
            on_step=on_step,
            is_cancelled=lambda: store.is_cancelled(job.id),
            save_every=request.get("save_every"),
            seed=request.get("seed"),
            init_embedding=request.get("init_embedding"),
        )
        if store.is_cancelled(job.id) or run.cancelled:
            _finish_cancelled(store, job, "train")
            return
        if run.timed_out:
            store.update(
                job,
                state=JobState.FAILED,
                error="TRAIN_TIMEOUT",
                message=f"训练超过 {settings.train_max_hours:g} 小时被强制停止",
            )
            store.log(job, f"超时被停止（已完成 {run.steps_seen} 步）", level="error")
            return
        if run.returncode != 0:
            code, message, hint = si_train.classify_failure(run.returncode, run.tail)
            store.update(job, state=JobState.FAILED, error=code, message=message)
            store.log(job, f"失败[{code}]：{message}", level="error")
            store.log(job, f"建议：{hint}", level="warn")
            if run.tail:
                store.log(job, f"训练进程尾部输出：{run.tail[-1][:300]}", level="error")
            return

        store.stage(
            job,
            "train",
            JobState.SUCCEEDED,
            detail=f"{run.steps_seen} 步 / {run.elapsed_sec:.0f}s"
                   + (f" / loss {run.last_loss:.5f}" if run.last_loss is not None else ""),
        )

        # ---- 阶段 3：产物 ----
        store.stage(job, "save", JobState.RUNNING)
        checkpoints = si_train.collect_checkpoints(output_dir)
        if not checkpoints["final_path"]:
            # 退出码 0 却没有产物 —— 与「守卫一」同源的上游静默行为，必须自己兜
            store.stage(job, "save", JobState.FAILED, detail="没有最终产物")
            store.update(
                job,
                state=JobState.FAILED,
                error="TRAIN_NO_ARTIFACT",
                message=f"训练进程退出码 0，但 {output_dir} 里没有最终产物",
            )
            store.log(job, f"产物目录内容：{sorted(p.name for p in output_dir.iterdir()) if output_dir.is_dir() else []}", level="error")
            return

        speaker = si_train.publish_speaker(
            settings,
            final_path=Path(str(checkpoints["final_path"])),
            speaker_id=speaker_id,
            details={
                "steps": steps,
                "batch": plan.batch,
                "dataset_id": dataset_id,
                "trained_at": int(time.time()),
                "last_loss": run.last_loss,
                "elapsed_sec": run.elapsed_sec,
                "engine": "irodori",
            },
        )
        store.stage(job, "save", JobState.SUCCEEDED, detail=speaker["path"])

        # ---- 阶段 4：登记 ----
        store.stage(job, "register", JobState.RUNNING)
        registered = None
        if voice_id:
            registered = si_train.register_speaker_embed(
                settings,
                voice_id=voice_id,
                entry={
                    "path": speaker["path"],
                    "speaker_id": speaker_id,
                    "trained_at": speaker["trained_at"],
                    "steps": steps,
                    "batch": plan.batch,
                },
            )
            if registered is None:
                store.log(job, f"音色 {voice_id} 不在音色库里，产物只登记到 /v1/speakers", level="warn")
        else:
            store.log(job, "未指定 voice_id：产物只在 /v1/speakers，可用 speaker_id 直接合成", level="warn")
        store.stage(job, "register", JobState.SUCCEEDED,
                    detail=registered["voice_name"] if registered else "仅本地 speaker 目录")

        store.update(
            job,
            state=JobState.SUCCEEDED,
            progress=1.0,
            message=f"训练完成：{steps} 步 / {run.elapsed_sec:.0f}s；speaker_id={speaker_id}",
            artifacts={
                "dataset_id": dataset_id,
                "manifest": str(manifest),
                "steps": steps,
                "batch": plan.to_dict(),
                "training": run.to_dict(),
                "checkpoints": checkpoints,
                "speaker": speaker,
                "registered": registered,
                "hint": f"用 /v1/synth 的 speaker_id={speaker_id} 合成即可听到固化后的音色。",
            },
        )
    except IrodoriError as error:
        if error.code == "JOB_CANCELLED":
            _finish_cancelled(store, job, "train")
            return
        store.update(job, state=JobState.FAILED, error=error.code, message=error.message)
        store.log(job, f"失败[{error.code}]：{error.message}", level="error")
        store.log(job, f"建议：{error.hint}", level="warn")
    except Exception as error:  # pragma: no cover - 兜底：不能让线程静默死掉
        store.update(job, state=JobState.FAILED, error="INTERNAL",
                     message=f"{type(error).__name__}: {error}")
        store.log(job, f"未预期的异常：{type(error).__name__}: {error}", level="error")
    finally:
        engine.release_busy()


def _coerce_steps(settings: Settings, value: Any) -> int:
    """步数解析：不在档位里也允许（有人就是想跑 37 步），但要给出清楚的边界。"""
    if value in (None, ""):
        return int(settings.smoke_steps)
    try:
        steps = int(str(value).strip())
    except (TypeError, ValueError) as error:
        raise IrodoriError(
            "BAD_REQUEST",
            f"steps 必须是整数：{value!r}",
            f"推荐档位：{list(settings.train_step_presets)}；也接受 1~20000 之间的任意整数。",
        ) from error
    if not 1 <= steps <= 20000:
        raise IrodoriError(
            "BAD_REQUEST",
            f"steps 超出范围：{steps}",
            f"1~20000。本机 batch 8 实测 2.2 s/步 —— 3000 步约 1.8 小时，量力而行。",
        )
    return steps


def _free_mb() -> Optional[int]:
    reading = vram_mb()
    return int(reading["free_mb"]) if reading else None


def _eta_text(seconds: float) -> str:
    """把秒说成人话：ETA 显示一定会出现在界面上，别让用户自己换算。"""
    total = int(max(0, seconds))
    hours, remainder = divmod(total, 3600)
    minutes, secs = divmod(remainder, 60)
    if hours:
        return f"{hours} 小时 {minutes} 分"
    if minutes:
        return f"{minutes} 分 {secs} 秒"
    return f"{secs} 秒"


def _finish_cancelled(store: JobStore, job: Job, stage_key: str) -> None:
    store.stage(job, stage_key, JobState.CANCELLED, detail="已取消")
    store.update(job, state=JobState.CANCELLED, message="任务已取消（在下一个片段前停下）")
    store.log(job, "任务已取消")


# --------------------------------------------------------------------------
# 辅助
# --------------------------------------------------------------------------


def _kind_of(suffix: str) -> str:
    if suffix == ".zip":
        return "archive"
    if suffix in traindata.AUDIO_SUFFIXES:
        return "audio"
    if suffix in traindata.TEXT_SUFFIXES:
        return "text"
    return "metadata"


def _extract_zip(archive: Path, destination: Path, skipped: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """解压 zip 到目标目录。

    ⚠️ 路径穿越防护是必须的：zip 里的条目名可以写 `../../evil.wav`，
    不检查就会把文件写到工作区外面去（Windows 下同样是真漏洞）。
    """
    extracted: list[dict[str, Any]] = []
    try:
        with zipfile.ZipFile(archive) as zf:
            for member in zf.infolist():
                if member.is_dir():
                    continue
                name = Path(member.filename).name
                suffix = Path(name).suffix.lower()
                if suffix not in _ALLOWED_UPLOAD_SUFFIXES:
                    skipped.append({"name": member.filename, "reason": f"不支持的扩展名 {suffix or '(无)'}"})
                    continue
                target = (destination / name).resolve()
                if not str(target).startswith(str(destination.resolve())):
                    skipped.append({"name": member.filename, "reason": "路径不合法（疑似穿越）"})
                    continue
                with zf.open(member) as source, target.open("wb") as out:
                    out.write(source.read())
                extracted.append({"name": name, "size": member.file_size, "kind": _kind_of(suffix)})
    except zipfile.BadZipFile as error:
        skipped.append({"name": archive.name, "reason": f"zip 损坏：{error}"})
    return extracted


def _s3_state(training_ready: bool, datasets: list[dict[str, Any]]) -> str:
    """S3 能不能开工：基座没下、或没有整备好的数据集，都跑不了 —— 如实标 blocked。

    理由与 30-5 一致：这两件事都能在**排期之前**查清，标成 ready 让用户排了队才失败，
    是白等几十分钟。
    """
    if not training_ready or not datasets:
        return "blocked"
    return "ready"


def _s3_detail(settings: Settings, training_ready: bool, datasets: list[dict[str, Any]]) -> str:
    if not training_ready:
        return "训练档权重（bf16 基座）未下载：npm run irodori:weights -- --training"
    if not datasets:
        return "还没有整备好的数据集：先跑 POST /v1/train/prepare"
    batch = si_train.heuristic_batch(settings, _free_mb())
    usable = [
        item for item in datasets if int(item.get("written") or item.get("rows") or 0) > 0
    ]
    return (
        f"可训练：{len(usable)}/{len(datasets)} 个数据集；"
        f"POST /v1/train 传 dataset_id 开跑，自动 batch 现估 {batch.batch}（{batch.source}）"
    )


def _training_section(settings: Settings, training_ready: bool) -> dict[str, Any]:
    """训练段的常量（真源在服务端，前端不要自己抄一份）。"""
    return {
        "steps_presets": [
            {
                "value": value,
                "estimated_minutes": round(value * settings.seconds_per_step / 60, 1),
                "note": ("冒烟小档：只为跑通闭环，具体步数待 30-6 实测回填"
                         if value == settings.smoke_steps
                         else ("官方默认量级" if value >= 2000 else "")),
            }
            for value in settings.train_step_presets
        ],
        "smoke_steps": settings.smoke_steps,
        "max_batch": settings.max_train_batch,
        "seconds_per_step": settings.seconds_per_step,
        # 30-6：batch 推荐改为「当下真算一遍」（探测留到真正开训时做，
        # 这里的 preview 只是给用户看「大概会选多大」）
        "batch": {
            **si_train.heuristic_batch(settings, _free_mb()).to_dict(),
            "auto": True,
            "max": settings.max_train_batch,
        },
        "s3_ready": True,
        "estimate_note": (
            f"按阶段 28 实测 {settings.seconds_per_step}s/步（batch {settings.max_train_batch}"
            " + 梯度检查点，RTX 4060 Laptop）估算，不是保证值。"
        ),
        "training_ready": training_ready,
    }

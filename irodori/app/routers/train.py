"""训练侧路由（30-5：S1 数据整备 + S2 latent 编码，S3 在 30-6）。

形态对齐 `docs/IRODORI-INTEGRATION-PLAN.md` §4.2：

| 端点 | 作用 |
| --- | --- |
| `POST /v1/train/plan` | **只回显计划，不执行** |
| `POST /v1/train/upload` | 语料上传（音频 + 同名 `.txt`，或 zip） |
| `POST /v1/train/prepare` | 入队跑 S1+S2（轮询式，与 trainer `/v1/train` 同形态） |
| `GET /v1/train/datasets` | 已整备好的数据集 |
| `GET /v1/jobs[/:id]`、`POST /v1/jobs/:id/cancel` | JobStore |
| `POST /v1/train` | S3，30-6 落地（现在明确 501，不静默假装能跑） |

⚠️ 整备与推理**互斥**（都走 `engine` 的 busy 锁）：整备只加载 codec，所以入队前会
先把常驻的 TTS 模型卸载 —— 4.7GB 放在显存里纯属浪费，而本机只有 8GB。
"""

from __future__ import annotations

import threading
import zipfile
from pathlib import Path
from typing import Any, Optional

from fastapi import Body, FastAPI, File, Form, UploadFile

from .. import engine, traindata
from ..config import Settings
from ..errors import IrodoriError
from ..inventory import scan
from ..jobs import Job, JobKind, JobStage, JobState, JobStore

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
                    # 训练档权重没下就不能跑 —— 如实标成 blocked，别让用户排了队才发现
                    "state": "blocked" if not inventory["training_ready"] else "todo",
                    "detail": ("30-6 落地（自动 batch 探测 + 产物登记 + speaker_id 推理闭环）"
                               if inventory["training_ready"]
                               else "训练档权重（bf16 基座）未下载：npm run irodori:weights -- --training"),
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
    # S3（30-6）
    # ------------------------------------------------------------------

    @app.post("/v1/train")
    def train_start(payload: Any = Body(default=None)) -> dict[str, Any]:
        """S3 训练入口：**30-6 才落地**。

        刻意先占位并返回 501（而不是 404）：契约写在方案 §4.2 里，前端会照着调，
        让它「明确地还没实现」比「找不到这个接口」好排查得多。
        """
        _ = _body(payload)
        raise IrodoriError(
            "TRAIN_S3_NOT_READY",
            "S3（Speaker Inversion 训练）在 30-6 落地，现在还不能跑",
            "先用 POST /v1/train/prepare 把数据整备好；训练档权重需 npm run irodori:weights -- --training。",
            status=501,
            retryable=True,
        )

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
        # 自动 batch 探测在 30-6；这里先把「还没有」说清楚，而不是给个拍脑袋的数字
        "batch": {"value": None, "auto": True, "max": settings.max_train_batch,
                  "note": "自动 batch 探测在 30-6 落地，现在先按上限 8 估时"},
        "estimate_note": (
            f"按阶段 28 实测 {settings.seconds_per_step}s/步（batch {settings.max_train_batch}"
            " + 梯度检查点，RTX 4060 Laptop）估算，不是保证值。"
        ),
        "training_ready": training_ready,
    }

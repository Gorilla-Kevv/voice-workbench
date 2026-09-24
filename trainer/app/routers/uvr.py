"""UVR5 音源分离端点。

分离是「歌声转换」的第一段，但它本身也是一项独立能力 ——
语音变声板块同样需要它（带伴奏的素材要先抽干声才能训练），
所以单独暴露成 `/v1/uvr/*`，两个板块共用。

设计上刻意保留两个入口：

* `POST /v1/uvr/separate` —— 提交任务，返回 job_id，前端轮询进度（长音频用这个）；
* `wait=true` —— 同步等待完成，短音频与「先试听一下分离效果」用这个。

产物一律复制到 `outputs/separation/<job_id>/` 再给出 URL：
命中缓存时源头在 `.data/cache/`，那个目录不在静态托管范围内，
直接返回缓存路径会得到 404。
"""

from __future__ import annotations

import shutil
import time
import uuid
from pathlib import Path
from typing import Any, Dict, Optional

from fastapi import FastAPI, File, Form, UploadFile

from ..audio.io import AUDIO_SUFFIXES
from ..audio.uvr5 import SeparationError, SeparationResult
from ..jobs import Job, JobKind
from ..sovits import bootstrap


def _home(ctx) -> Path:
    """分离用的整合包根目录（UVR5 住在 GPT-SoVITS 整合包里）。"""
    installation = bootstrap.current()
    if installation is None:
        raise SeparationError(
            "未定位到 GPT-SoVITS 安装目录，无法加载 UVR5",
            hint="设置 GPT_SOVITS_HOME 指向整合包根目录后重启服务。",
            code="ENV_NOT_READY",
        )
    return installation.home


def _save_upload(ctx, upload: UploadFile) -> Path:
    """把上传的音频落到 uploads 目录，返回路径。"""
    suffix = Path(upload.filename or "audio").suffix.lower()
    if suffix not in AUDIO_SUFFIXES:
        raise SeparationError(
            "不支持的音频格式：%s" % (upload.filename or "未知"),
            hint="支持 %s。" % "、".join(sorted(AUDIO_SUFFIXES)),
            code="BAD_FORMAT",
        )
    target_dir = ctx.settings.uploads_dir / "uvr"
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / ("%s_%s" % (uuid.uuid4().hex[:8], Path(upload.filename or "audio").name))
    with target.open("wb") as handle:
        shutil.copyfileobj(upload.file, handle)
    return target


def _publish(ctx, result: SeparationResult, job_id: str) -> Dict[str, Any]:
    """把产物复制到可静态访问的位置，并拼出 URL。"""
    out_dir = ctx.settings.separation_dir / job_id
    out_dir.mkdir(parents=True, exist_ok=True)
    urls: Dict[str, str] = {}
    paths: Dict[str, str] = {}

    for key, source in (("vocal", result.vocal), ("instrumental", result.instrumental)):
        if not source or not Path(source).is_file():
            continue
        target = out_dir / ("%s%s" % (key, Path(source).suffix))
        if Path(source).resolve() != target.resolve():
            shutil.copy2(str(source), str(target))
        paths[key] = str(target)
        urls[key] = "/files/separation/%s/%s" % (job_id, target.name)

    payload = result.to_dict()
    payload["urls"] = urls
    payload["paths"] = paths
    return payload


def make_separation_runner(ctx):
    """构造分离任务的执行体。

    与既有 runner 一样：阻塞式的 torch 调用丢进线程池，进度与日志桥接回任务对象。
    """

    async def separation_runner(job: Job, cancel_event) -> Dict[str, Any]:
        request = job.request or {}
        source = Path(request.get("source") or "")
        home = _home(ctx)

        def progress(fraction: float, message: str) -> None:
            ctx.store.update(job, progress=round(float(fraction), 3), message=message)

        def log(message: str, level: str = "info") -> None:
            ctx.store.log(job, message, level)

        log("开始分离：%s" % source.name)
        result = await _to_thread(
            ctx.uvr5.separate,
            home=home,
            src=source,
            preset_key=request.get("preset", ctx.settings.uvr_preset),
            secondary_key=request.get("secondary", "none"),
            agg=int(request.get("agg", ctx.settings.uvr_agg)),
            fmt=request.get("format", ctx.settings.uvr_format),
            use_cache=bool(request.get("use_cache", ctx.settings.uvr_cache_enabled)),
            progress=progress,
        )
        if cancel_event.is_set():
            return {"job_id": job.id, "cancelled": True}

        log("分离完成（%s，%.1fs）" % ("命中缓存" if result.cached else "本次计算", result.elapsed_s))
        return {"job_id": job.id, **_publish(ctx, result, job.id)}

    return separation_runner


async def _to_thread(func, **kwargs):
    import asyncio  # noqa: PLC0415

    return await asyncio.to_thread(func, **kwargs)


def register(app: FastAPI, ctx) -> None:
    @app.get("/v1/uvr/catalog", tags=["uvr"])
    def uvr_catalog() -> Any:
        """预置档位 + 本机实际可用的模型。"""
        return {"ok": True, **ctx.uvr5.catalog(_home(ctx))}

    @app.get("/v1/uvr/cache", tags=["uvr"])
    def uvr_cache_stats() -> Any:
        """缓存统计：每个阶段多少条、占多少空间。"""
        return {"ok": True, **ctx.uvr5.cache.stats()}

    @app.delete("/v1/uvr/cache", tags=["uvr"])
    def uvr_cache_clear(stage: Optional[str] = None) -> Any:
        """清理缓存。`stage` 为空表示全清。"""
        removed = ctx.uvr5.cache.clear(stage)
        return {"ok": True, "removed": removed, "message": "已清理 %d 条缓存" % removed}

    @app.post("/v1/uvr/separate", tags=["uvr"])
    async def separate(
        file: UploadFile = File(None),
        source: str = Form(""),
        preset: str = Form("vocal_fast"),
        secondary: str = Form("none"),
        agg: int = Form(10),
        format: str = Form("wav"),
        use_cache: bool = Form(True),
        wait: bool = Form(False),
    ) -> Any:
        """提交一次分离。`file` 与 `source` 二选一。"""
        src: Path
        if file is not None and (file.filename or ""):
            src = _save_upload(ctx, file)
        elif source.strip():
            src = Path(source.strip()).expanduser()
            if not src.is_file():
                raise SeparationError(
                    "音频文件不存在：%s" % src,
                    hint="确认路径正确且服务进程有权限读取。",
                    code="SOURCE_MISSING",
                )
        else:
            raise SeparationError(
                "请先上传音频或填写本机路径",
                hint="上传走 multipart 的 file 字段，本机文件走 source 字段。",
                code="MISSING_INPUT",
            )

        request = {
            "source": str(src),
            "preset": preset or ctx.settings.uvr_preset,
            "secondary": secondary or "none",
            "agg": agg,
            "format": format or ctx.settings.uvr_format,
            "use_cache": use_cache,
        }

        # 同步模式：短音频或"只想先听一下分离效果"，不必走任务轮询
        if wait:
            started = time.time()
            result = ctx.uvr5.separate(
                home=_home(ctx),
                src=src,
                preset_key=request["preset"],
                secondary_key=request["secondary"],
                agg=request["agg"],
                fmt=request["format"],
                use_cache=use_cache,
            )
            return {"ok": True, **_publish(ctx, result, uuid.uuid4().hex[:12])}

        job = ctx.store.create(
            JobKind.SEPARATE,
            name="音源分离：%s" % src.name,
            request=request,
            owner="local",
        )
        ctx.scheduler.submit(job)
        return {
            "ok": True,
            "job_id": job.id,
            "message": "分离任务已入队，请轮询 /v1/jobs/%s" % job.id,
            "request": request,
        }

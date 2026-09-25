"""HTTP 层。

端点按职责分区，两条原则贯穿始终：

1. **能力缺失也要说清话** —— 依赖没装好时返回可读的 blockers 与修复建议，
   而不是一个 500；
2. **契约稳定** —— 前端（以及本项目的 Node 网关）依赖这份契约，
   新增参数一律「追加」，不改动已有字段语义。

同步 vs 异步：所有会碰模型的端点都写成 **同步函数**。
FastAPI 会把同步端点丢进线程池，因此阻塞式的 torch 推理不会卡住事件循环，
而我们可以放心使用普通的 `threading.Lock` 做串行化 —— 比在 asyncio 里
小心翼翼地隔离 torch 简单得多。
"""

from __future__ import annotations

import asyncio
import base64
import json
import shutil
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional
from urllib.parse import quote

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import __version__
from . import annotations
from . import routers
from .asr.pipeline import AsrEngine
from .audio.cache import ArtifactCache
from .audio.uvr5 import Uvr5Engine
from .batch import BatchRunner
from .config import AUDIO_SUFFIXES, Settings
from .engine import EngineRegistry
from .errors import BadRequestError, NotFoundError, SovitsError
from .inference import SynthesisEngine
from .jobs import Job, JobKind, JobState, JobStore
from .models import (
    AnnotationSaveRequest,
    BatchRequest,
    CancelRequest,
    HealthResponse,
    JobListView,
    JobView,
    MessageResponse,
    TextSplitRequest,
    TrainRequest,
    TTSRequest,
    WeightLoadRequest,
)
from .queue import AdmissionError, Scheduler
from .sovits import bootstrap, catalog
from .sovits.pipeline import Pipeline
from .sovits.voices import VoiceLibrary
from .svc.pipeline import SvcEngine
from .training import TrainEngine, TrainHooks, step_stages
from .vc.pipeline import VcEngine
from . import weights

MAX_UPLOAD_BYTES = 512 * 1024 * 1024  # 单个语料文件上限


class Context:
    """全局依赖容器。所有对象在启动时构造一次，注入到各处理器。"""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.started_at = time.time()
        self.store = JobStore(settings.jobs_dir)
        self.scheduler = Scheduler(settings, self.store)
        self.pipeline = Pipeline(settings.data_dir)
        self.voices = VoiceLibrary(settings.data_dir)
        self.engine = SynthesisEngine(settings, self.pipeline, self.voices)
        self.batch = BatchRunner(settings, self.engine)
        self.training = TrainEngine(
            settings,
            self.store,
            TrainHooks(on_start=self._begin_training, on_finish=self._end_training),
        )
        # 允许 /v1/pipeline 在运行期切换安装目录
        self.installation: Optional[bootstrap.Installation] = None

        # ---- 两个新板块的共享设施 ----
        #
        # 引擎注册表是显存互斥的唯一仲裁者：GPT-SoVITS（既有链路）登记进来后，
        # RVC / DDSP-SVC / UVR5 只要都走 acquire()，就不需要互相知道对方的存在。
        self.engines = EngineRegistry(settings)
        self.engines.register_unloader("sovits", self.pipeline.unload)
        self.uvr5 = Uvr5Engine(self.engines, ArtifactCache(settings.cache_dir))
        self.svc = SvcEngine(settings)
        self.engines.register_unloader("svc", self.svc.unload)
        self.vc = VcEngine(settings)
        self.engines.register_unloader("rvc", self.vc.unload)
        # ASR 也吃显存，因此同样登记进注册表：转写期间会请走其它引擎，
        # 反过来别人在场时转写也会先把它卸掉 —— 规则统一，没有例外。
        self.asr = AsrEngine(settings)
        self.engines.register_unloader("asr", self.asr.unload)

    def gpt_home(self):
        """UVR5 住在 GPT-SoVITS 整合包里，这里统一取它的根目录。"""
        installation = self.installation or bootstrap.current()
        return installation.home if installation else None

    # ---------- 训练与推理的显存互斥 ----------

    def _begin_training(self) -> None:
        """训练开始前释放推理管线。

        训练脚本会自己加载一整套模型；本服务常驻的推理管线如果还占着显存，
        在 8GB 级别的显卡上两者会一起 OOM（这是实测出来的，不是推测）。
        释放而不是「共享」，是因为训练与推理都不可能只用到一半显存。

        这里额外占住引擎注册表的「训练」位：新增的 RVC / DDSP-SVC / UVR5 也走注册表，
        于是「训练期间拒绝一切推理与分离」这条规则对它们自动生效，
        不需要每个板块各自记得判断一次。
        """
        self.pipeline.set_training_active(True)
        self.pipeline.unload()
        try:
            self.engines.acquire("train", reason="GPT-SoVITS 训练")
        except AdmissionError:
            # 训练是最高优先级：即便准入判断保守地拒绝了，也要把位置占住
            self.engines.release("train")
            self.engines.acquire("train", reason="GPT-SoVITS 训练")

    def _end_training(self) -> None:
        self.pipeline.set_training_active(False)
        self.engines.release("train")

    # ---------- 能力判定 ----------

    def blockers(self) -> List[str]:
        """返回「还差什么才能干活」。每一条都对应一个可执行的下一步。"""
        issues: List[str] = []
        installation = bootstrap.current()
        if installation is None:
            issues.append(
                "未定位到 GPT-SoVITS 安装目录。请设置环境变量 GPT_SOVITS_HOME 指向其根目录，"
                "或把整合包放在项目同级目录后重启服务。"
            )
            return issues

        from .runtime import probe_current  # noqa: PLC0415

        runtime = probe_current()
        if not runtime.has_torch:
            issues.append(
                "当前解释器缺少 torch：%s。请用 GPT-SoVITS 自带解释器启动服务"
                "（scripts/start.ps1 / start.sh 会自动选择）。" % runtime.executable
            )
        elif runtime.missing_libs:
            issues.append("缺少推理依赖：%s" % "、".join(runtime.missing_libs))

        if not installation.layout.can_infer:
            issues.append("安装目录中未找到推理入口（inference_webui.py），无法合成")
        if not installation.layout.can_train:
            issues.append("安装目录中未找到训练脚本（s1_train.py / s2_train.py），无法训练")

        # 默认版本的权重是否齐备 —— 这是最常见的「装好了但跑不起来」
        try:
            pair = self.pipeline.resolve_defaults(self.settings.default_version)
            if not pair.gpt.is_file() or not pair.sovits.is_file():
                issues.append("默认版本 %s 的预训练权重不完整" % self.settings.default_version)
        except SovitsError as exc:
            issues.append(exc.message)
        return issues

    def capabilities(self) -> Dict[str, Any]:
        from .runtime import probe_current  # noqa: PLC0415

        runtime = probe_current()
        installation = bootstrap.current()
        return {
            "inference": bool(installation and installation.layout.can_infer and runtime.has_torch),
            "training": bool(installation and installation.layout.can_train and runtime.has_torch),
            "batch": True,
            "streaming": runtime.has_torch,
            "voice_library": True,
            "text_split_preview": runtime.has_torch,
            "dry_run": self.settings.dry_run,
            # 两个新板块：UVR5 分离随整合包可用，歌声转换还要看权重是否就位
            "separation": bool(installation),
            "singing_conversion": self._weights_ready("svc"),
            "voice_conversion": self._weights_ready("rvc"),
            "speech_recognition": self._asr_ready(),
        }

    def _asr_ready(self) -> bool:
        """ASR 就绪 = 至少有一条通道能用。

        刻意用 `module_present()`（只查包在不在）而不是真导入：`/health` 会被
        前端反复轮询，而 `import funasr` 顺带拉起 torch，几秒钟就过去了。
        """
        from .asr import bootstrap as asr_bootstrap  # noqa: PLC0415
        from .asr import catalog as asr_catalog  # noqa: PLC0415

        for backend in asr_catalog.BACKENDS:
            if asr_bootstrap.script_available(self.settings, backend):
                return True
            module = asr_catalog.resident_channel_module(backend)
            if module and asr_bootstrap.module_present(module):
                return True
        return False

    def _weights_ready(self, engine: str) -> bool:
        """只看**推理必需**的权重是否就位（训练用的底模缺失不算阻断）。"""
        report = weights.audit(self.settings, engine)
        missing = set(report["missing"])
        required = {w.key for w in weights.WEIGHTS if w.engine == engine and w.required}
        return not (missing & required)

    def hints(self) -> List[str]:
        hints: List[str] = []
        installation = bootstrap.current()
        from .runtime import probe_current  # noqa: PLC0415

        runtime = probe_current()
        if installation is None:
            hints.append("设置 GPT_SOVITS_HOME 指向 GPT-SoVITS 根目录后重启，即可自动发现")
            return hints
        if installation.python_executable and not runtime.has_torch:
            hints.append(
                "检测到整合包自带解释器 %s，请用它启动本服务" % installation.python_executable
            )
        if runtime.has_torch and not bootstrap.is_loaded():
            hints.append("首次合成需要加载模型（约 30~90 秒），之后会常驻内存")
        if not self.voices.list():
            hints.append("音色库为空：GPT-SoVITS 没有内置音色，请先导入一段 3~10 秒的参考音频")
        hints.extend(self._extra_hints())
        return hints

    def _extra_hints(self) -> List[str]:
        """两个新板块（变声 / 翻唱）的就绪指引。"""
        hints: List[str] = []
        from pathlib import Path as _Path  # noqa: PLC0415

        if not _Path(self.settings.rvc_dir).is_dir() or not _Path(self.settings.ddsp_dir).is_dir():
            hints.append(
                "语音变声 / 歌声转换的源码未拉取：执行 git submodule update --init vendor/rvc vendor/ddsp-svc"
            )
        from . import weights as weights_audit  # noqa: PLC0415

        missing = weights_audit.blockers(self.settings)
        if missing:
            hints.append(
                "新板块缺少 %d 项预训练权重：运行 python scripts/download_models.py 自动补齐" % len(missing)
            )
        return hints


# --------------------------------------------------------------------------
# 应用装配
# --------------------------------------------------------------------------


def create_app(ctx: Context) -> FastAPI:
    settings = ctx.settings

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> Any:
        """把调度器的启停挂在应用生命周期上，而不是靠调用方记得注册事件。

        这样启动顺序由框架保证：调度器一定在事件循环内启动
        （`asyncio.Queue` 的构造时机对 3.9 很关键，详见 `queue.Pool` 的注释），
        也一定在第一个请求之前完成。
        """
        await ctx.scheduler.start()
        try:
            yield
        finally:
            await ctx.scheduler.stop()
            ctx.pipeline.unload()

    app = FastAPI(
        title="GPT-SoVITS 本地语音工作台",
        version=__version__,
        description=(
            "本地部署的 GPT-SoVITS 推理与训练服务：零样本/少样本克隆、全参数透传、"
            "音色库、批量合成与一键训练。数据不出本机。"
        ),
        lifespan=lifespan,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.allow_origins,
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    settings.ensure_dirs()
    app.mount("/files", StaticFiles(directory=str(settings.outputs_dir)), name="files")
    app.state.ctx = ctx

    _register_meta(app, ctx)
    _register_pipeline(app, ctx)
    _register_voices(app, ctx)
    _register_tts(app, ctx)
    _register_train(app, ctx)
    _register_annotations(app, ctx)
    _register_jobs(app, ctx)
    _register_errors(app, ctx)
    # 两个新板块（语音变声 / 歌声转换）与共用的音源分离
    routers.register(app, ctx)
    return app


# --------------------------------------------------------------------------
# 元信息
# --------------------------------------------------------------------------


def _register_meta(app: FastAPI, ctx: Context) -> None:
    @app.get("/health", response_model=HealthResponse, tags=["meta"])
    def health() -> Any:
        from .runtime import probe_current  # noqa: PLC0415

        blockers = ctx.blockers()
        voices = ctx.voices.list()
        return HealthResponse(
            ok=True,
            version=__version__,
            mode=ctx.settings.mode.value,
            uptime_s=round(time.time() - ctx.started_at, 1),
            ready=not blockers,
            settings=ctx.settings.to_dict(),
            environment=bootstrap.to_dict(),
            runtime=probe_current().to_dict(),
            pipeline=ctx.pipeline.status(),
            scheduler=ctx.scheduler.snapshot(),
            engines=ctx.engines.snapshot(),
            capabilities=ctx.capabilities(),
            voices={
                "total": len(voices),
                "usable": sum(1 for voice in voices if voice.is_usable()),
            },
            blockers=blockers,
            warnings=ctx.settings.warnings(),
            hints=ctx.hints(),
        )

    @app.get("/v1/catalog", tags=["meta"])
    def get_catalog() -> Any:
        return {"ok": True, "catalog": catalog.to_public_catalog()}

    @app.get("/v1/uvr/models", tags=["meta"])
    def list_uvr_models() -> Any:
        """列出本机**实际可用**的 UVR5 模型（人声/伴奏分离、去混响、去延迟）。

        官方只给了 Gradio 界面（tools/uvr5/webui.py），没法集成；我们用自己的
        `trainer/tools/uvr_cli.py` 调官方算法本体，模型清单则从
        `tools/uvr5/uvr5_weights` 扫描。

        只列磁盘上真实存在的：比如 BS-RoFormer 缺同名的 .yaml 时会被标成
        `available=false` 并说明原因 —— 这比给一个点下去才报错的下拉框要好。
        """
        installation = bootstrap.current()
        if installation is None:
            raise SovitsError(
                "未定位到 GPT-SoVITS 安装目录",
                hint="设置 GPT_SOVITS_HOME 后重启服务。",
                code="ENV_NOT_READY",
                status=503,
            )
        models = catalog.list_uvr_models(installation.home)
        return {
            "ok": True,
            "models": models,
            "total": len(models),
            "formats": list(catalog.UVR5_FORMATS),
            "kinds": catalog.UVR5_MODEL_KINDS,
        }

    @app.get("/v1/env", tags=["meta"])
    def get_env() -> Any:
        from .runtime import probe_current  # noqa: PLC0415

        return {
            "ok": True,
            "settings": ctx.settings.to_dict(),
            "environment": bootstrap.to_dict(),
            "runtime": probe_current().to_dict(),
            "blockers": ctx.blockers(),
            "hints": ctx.hints(),
        }

    @app.get("/v1/scheduler", tags=["meta"])
    def get_scheduler() -> Any:
        return {"ok": True, "scheduler": ctx.scheduler.snapshot()}


# --------------------------------------------------------------------------
# 管线与权重
# --------------------------------------------------------------------------


def _register_pipeline(app: FastAPI, ctx: Context) -> None:
    @app.get("/v1/pipeline", tags=["pipeline"])
    def get_pipeline() -> Any:
        return {"ok": True, "pipeline": ctx.pipeline.status()}

    @app.post("/v1/pipeline/warmup", tags=["pipeline"])
    def warmup(blocking: bool = False) -> Any:
        ctx.pipeline.warmup(blocking=blocking)
        return MessageResponse(
            message="已在后台开始加载模型" if not blocking else "模型已加载",
            data=ctx.pipeline.status(),
        )

    @app.post("/v1/pipeline/unload", tags=["pipeline"])
    def unload() -> Any:
        ctx.pipeline.unload()
        return MessageResponse(message="已释放模型，显存已归还系统")

    @app.post("/v1/pipeline/stop", tags=["pipeline"])
    def stop() -> Any:
        stopped = ctx.pipeline.stop()
        return MessageResponse(message="已发送中断信号" if stopped else "当前没有正在进行的推理")

    @app.get("/v1/weights", tags=["pipeline"])
    def list_weights(version: Optional[str] = None) -> Any:
        installation = bootstrap.current()
        if installation is None:
            raise SovitsError(
                "未定位到 GPT-SoVITS 安装目录",
                hint="设置 GPT_SOVITS_HOME 后重启服务。",
                code="ENV_NOT_READY",
                status=503,
            )
        target_version = version or ctx.pipeline.version
        entries = installation.layout.weights_by_version()
        gpt = [item.to_dict() for item in entries if item.kind == "gpt" and item.version == target_version]
        sovits = [
            item.to_dict() for item in entries if item.kind == "sovits" and item.version == target_version
        ]

        payload: Dict[str, Any] = {
            "ok": True,
            "version": target_version,
            "gpt": gpt,
            "sovits": sovits,
            "active": {
                "gpt": ctx.pipeline.state.gpt,
                "sovits": ctx.pipeline.state.sovits,
                "loaded": ctx.pipeline.state.loaded,
                "device": ctx.pipeline.state.device,
                "is_half": ctx.pipeline.state.is_half,
            },
        }
        # 顺带给出「默认会选哪一个」，前端据此初始化下拉框
        try:
            pair = ctx.pipeline.resolve_defaults(target_version)
            payload["default"] = pair.to_dict()
        except SovitsError as exc:
            payload["default"] = None
            payload["warning"] = exc.message

        payload["pretrained"] = {
            "gpt": catalog.PRETRAINED_GPT.get(target_version),
            "sovits": catalog.PRETRAINED_SOVITS_G.get(target_version),
            "available": _pretrained_available(installation, target_version),
        }
        return payload

    @app.post("/v1/weights/load", tags=["pipeline"])
    def load_weights(payload: WeightLoadRequest) -> Any:
        status = ctx.pipeline.configure(
            version=payload.version,
            device=payload.device,
            is_half=payload.is_half,
            gpt=payload.gpt,
            sovits=payload.sovits,
        )
        if payload.eager:
            ctx.pipeline.warmup(blocking=True)
            status = ctx.pipeline.status()
        return {"ok": True, "pipeline": status}


def _pretrained_available(installation: bootstrap.Installation, version: str) -> bool:
    gpt = installation.path(catalog.PRETRAINED_GPT.get(version, ""))
    sovits = installation.path(catalog.PRETRAINED_SOVITS_G.get(version, ""))
    return bool(gpt.is_file() and sovits.is_file())


# --------------------------------------------------------------------------
# 音色库
# --------------------------------------------------------------------------


def _register_voices(app: FastAPI, ctx: Context) -> None:
    @app.get("/v1/voices", tags=["voices"])
    def list_voices() -> Any:
        voices = ctx.voices.list()
        return {"ok": True, "voices": [voice.to_dict() for voice in voices], "total": len(voices)}

    @app.get("/v1/voices/{voice_id}", tags=["voices"])
    def get_voice(voice_id: str) -> Any:
        return {"ok": True, "voice": ctx.voices.get(voice_id).to_dict()}

    @app.get("/v1/voices/{voice_id}/audio", tags=["voices"])
    def get_voice_audio(voice_id: str) -> Any:
        """回放音色的参考音频。

        没有这个接口，用户在音色库里就只能看到一行文件名 ——
        而「这段音频到底干不干净」恰恰是决定合成质量的关键，
        必须能直接听。
        """
        voice = ctx.voices.get(voice_id)
        path = Path(voice.audio_path)
        if not path.is_file():
            raise NotFoundError(
                "音色的音频文件已丢失：%s" % voice.name,
                hint="请重新上传，或修正音色的音频路径。",
            )
        return FileResponse(path, media_type=_guess_audio_type(path.suffix), filename=path.name)

    @app.post("/v1/voices", tags=["voices"])
    async def create_voice(
        name: str = Form(...),
        prompt_text: str = Form(""),
        prompt_lang: str = Form("zh"),
        note: str = Form(""),
        tags: str = Form(""),
        audio: UploadFile = File(...),
    ) -> Any:
        content = await audio.read()
        voice = ctx.voices.create(
            name=name,
            prompt_text=prompt_text,
            prompt_lang=prompt_lang,
            content=content,
            filename=audio.filename or "audio.wav",
            note=note,
            tags=_split_tags(tags),
        )
        return {"ok": True, "voice": voice.to_dict()}

    @app.post("/v1/voices/source", tags=["voices"])
    def create_voice_from_path(body: Dict[str, Any]) -> Any:
        """引用磁盘上已有的音频文件，不复制进托管目录。"""
        voice = ctx.voices.create(
            name=str(body.get("name") or ""),
            prompt_text=str(body.get("prompt_text") or ""),
            prompt_lang=str(body.get("prompt_lang") or "zh"),
            external_path=str(body.get("audio_path") or ""),
            note=str(body.get("note") or ""),
            tags=_split_tags(str(body.get("tags") or "")),
        )
        return {"ok": True, "voice": voice.to_dict()}

    @app.patch("/v1/voices/{voice_id}", tags=["voices"])
    def update_voice(voice_id: str, body: Dict[str, Any]) -> Any:
        voice = ctx.voices.update(
            voice_id,
            name=body.get("name"),
            prompt_text=body.get("prompt_text"),
            prompt_lang=body.get("prompt_lang"),
            note=body.get("note"),
            tags=body.get("tags"),
            audio_path=body.get("audio_path"),
        )
        return {"ok": True, "voice": voice.to_dict()}

    @app.post("/v1/voices/{voice_id}/audio", tags=["voices"])
    async def replace_voice_audio(voice_id: str, audio: UploadFile = File(...)) -> Any:
        content = await audio.read()
        voice = ctx.voices.replace_audio(voice_id, content, audio.filename or "audio.wav")
        return {"ok": True, "voice": voice.to_dict()}

    @app.delete("/v1/voices/{voice_id}", tags=["voices"])
    def delete_voice(voice_id: str) -> Any:
        ctx.voices.delete(voice_id)
        return MessageResponse(message="音色已删除")


# --------------------------------------------------------------------------
# 合成
# --------------------------------------------------------------------------


def _register_tts(app: FastAPI, ctx: Context) -> None:
    @app.post("/v1/tts", tags=["tts"])
    def synthesize(payload: TTSRequest) -> Any:
        raw = _dump(payload)
        outcome = ctx.engine.synthesize_to_file(raw)
        return {"ok": True, **outcome.to_payload(inline_base64=bool(raw.get("inline_base64")))}

    @app.post("/v1/text/split", tags=["tts"])
    def preview_split(payload: TextSplitRequest) -> Any:
        result = ctx.engine.split_text(payload.text, payload.text_lang, payload.text_split_method)
        return {"ok": True, **result}

    @app.post("/v1/tts/stream", tags=["tts"])
    def synthesize_stream(payload: TTSRequest) -> Any:
        """流式合成。

        产出 NDJSON：每行一个 JSON 事件，`chunk` 事件携带 base64 的 16bit PCM 分片，
        客户端可以边收边播；`done` 事件携带拼装后的完整 WAV 地址，便于落库与下载。
        """
        raw = _dump(payload)

        def events() -> Iterator[bytes]:
            started = time.monotonic()
            chunks: List[Any] = []
            merged: Any = None
            sample_rate = 0
            yield _line({"type": "start", "text": raw.get("text"), "version": ctx.pipeline.version})
            try:
                for index, (rate, chunk) in enumerate(ctx.engine.stream(raw)):
                    sample_rate = int(rate or sample_rate)
                    if index == 0:
                        yield _line({"type": "meta", "sample_rate": sample_rate})
                    chunks.append(chunk)
                    yield _line(
                        {
                            "type": "chunk",
                            "index": index,
                            "sample_rate": sample_rate,
                            "audio": base64.b64encode(chunk.tobytes()).decode("ascii"),
                            "samples": int(len(chunk)),
                        }
                    )
            except SovitsError as exc:
                yield _line({"type": "error", "error": exc.to_dict()})
                return
            except Exception as exc:  # noqa: BLE001
                yield _line(
                    {
                        "type": "error",
                        "error": {
                            "code": "STREAM_FAILED",
                            "message": "%s: %s" % (type(exc).__name__, exc),
                            "retryable": True,
                        },
                    }
                )
                return

            # 拼装完整音频并落盘：流式只解决「听到得快」，最终仍需要一个可下载的成品
            url = None
            duration = 0.0
            if chunks and sample_rate:
                import numpy as np  # noqa: PLC0415

                from .sovits import synth as synth_module  # noqa: PLC0415

                merged = np.concatenate(chunks)
                duration = round(len(merged) / float(sample_rate), 3)
                data = synth_module.to_wav_bytes(sample_rate, merged)
                target = ctx.settings.outputs_dir / ("%s.wav" % uuid.uuid4().hex[:12])
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
                url = ctx.engine.url_for(target)

            yield _line(
                {
                    "type": "done",
                    "audio_url": url,
                    "sample_rate": sample_rate,
                    "duration_s": duration,
                    "elapsed_ms": int((time.monotonic() - started) * 1000),
                }
            )

        return StreamingResponse(events(), media_type="application/x-ndjson")

    @app.post("/v1/tts/batch", tags=["tts"])
    async def synthesize_batch(payload: BatchRequest) -> Any:
        raw = _dump(payload)
        # 先做一次展开校验：宁可现在报错，也不要让用户等一个注定失败的任务
        entries = ctx.batch.expand(raw)

        job = ctx.store.create(
            JobKind.INFER,
            name="批量合成 %d 条" % len(entries),
            request=raw,
            owner="local",
        )
        ctx.scheduler.submit(job)

        if raw.get("wait", True) is False:
            return {
                "ok": True,
                "job_id": job.id,
                "state": job.state.value,
                "total": len(entries),
                "message": "任务已提交，请轮询 /v1/jobs/%s" % job.id,
            }

        finished = await _wait_terminal(job, ctx.settings.infer_timeout_s * max(1, len(entries)) + 60)
        return _batch_response(finished, len(entries))

    @app.post("/v1/tts/batch/plan", tags=["tts"])
    def plan_batch(payload: BatchRequest) -> Any:
        """只展开条目，不做合成。用于前端上传清单后先核对条数与内容。"""
        entries = ctx.batch.expand(_dump(payload))
        return {
            "ok": True,
            "total": len(entries),
            "items": [
                {"index": index, "key": entry.get("key"), "text": entry.get("text")}
                for index, entry in enumerate(entries)
            ],
        }


def _batch_response(job: Job, total: int) -> Dict[str, Any]:
    if job.state is JobState.FAILED:
        raise SovitsError(
            job.error or "批量合成失败",
            hint="可在任务详情中查看逐条日志。",
            code="BATCH_FAILED",
            status=502,
        )
    if job.state is JobState.CANCELLED:
        return {
            "ok": True,
            "job_id": job.id,
            "state": job.state.value,
            "total": total,
            "message": "任务已取消",
            "results": [],
        }
    artifacts = job.artifacts or {}
    return {
        "ok": True,
        "job_id": job.id,
        "state": job.state.value,
        "elapsed_ms": job.elapsed_ms,
        **artifacts,
    }


# --------------------------------------------------------------------------
# 训练
# --------------------------------------------------------------------------


def _register_train(app: FastAPI, ctx: Context) -> None:
    @app.post("/v1/train/plan", tags=["train"])
    def plan_train(payload: TrainRequest) -> Any:
        context, steps, skipped = ctx.training.plan(payload)
        return {
            "ok": True,
            "context": context.to_dict(),
            "skipped": skipped,
            "steps": [
                {
                    "stage": step.stage.key,
                    "label": step.stage.label,
                    "phase": step.stage.phase,
                    "note": step.stage.note,
                    "env": step.env,
                    "commands": [
                        " ".join(cmd) for cmd in (step.shards or ([step.cmd] if step.cmd else [])) if cmd
                    ],
                }
                for step in steps
            ],
        }

    @app.post("/v1/train", tags=["train"])
    async def train(payload: TrainRequest, request: Request) -> Any:
        _require_auth(ctx, request)
        if payload.plan_only:
            return plan_train(payload)

        context, steps, skipped = ctx.training.plan(payload)
        job = ctx.store.create(
            JobKind.TRAIN,
            name=payload.name,
            request=_dump(payload),
            stages=step_stages(payload),
            owner="local",
            priority=1,
        )
        ctx.store.log(job, "实验目录：%s" % context.workdir)
        for note in skipped:
            ctx.store.log(job, note, level="warn")
        ctx.scheduler.submit(job)

        return {
            "ok": True,
            "job_id": job.id,
            "state": job.state.value,
            "stages": [stage.to_dict() for stage in job.stages],
            "message": "训练任务已入队，请轮询 /v1/train/%s" % job.id,
        }

    @app.get("/v1/train", tags=["train"])
    def list_train_jobs(limit: int = 20) -> Any:
        jobs = ctx.store.list(kind=JobKind.TRAIN, limit=min(limit, 100))
        return {"ok": True, "jobs": [job.to_dict(with_logs=False) for job in jobs], "total": len(jobs)}

    @app.get("/v1/train/{job_id}", tags=["train"])
    def get_train_job(job_id: str) -> Any:
        job = ctx.store.get(job_id)
        if job is None:
            raise NotFoundError("训练任务不存在：%s" % job_id)
        return {"ok": True, "job": job.to_dict()}

    @app.post("/v1/train/upload", tags=["train"])
    async def upload_corpus(files: List[UploadFile] = File(...)) -> Any:
        """上传语料。同一批文件落在同一个目录，返回该目录供训练接口使用。"""
        batch_dir = ctx.settings.uploads_dir / uuid.uuid4().hex[:10]
        batch_dir.mkdir(parents=True, exist_ok=True)

        saved: List[str] = []
        rejected: List[str] = []
        total_bytes = 0
        for upload in files:
            suffix = Path(upload.filename or "").suffix.lower()
            if suffix not in AUDIO_SUFFIXES:
                rejected.append(upload.filename or "?")
                continue
            target = batch_dir / Path(upload.filename or "audio.wav").name
            with target.open("wb") as handle:
                shutil.copyfileobj(upload.file, handle)
            size = target.stat().st_size
            total_bytes += size
            if total_bytes > MAX_UPLOAD_BYTES:
                shutil.rmtree(batch_dir, ignore_errors=True)
                raise SovitsError(
                    "本批语料超过上限 %.0f MB" % (MAX_UPLOAD_BYTES / 1024 / 1024),
                    hint="请分批上传，或直接把音频放进本地目录后用 source_audio_dir 指定。",
                    code="UPLOAD_TOO_LARGE",
                    status=413,
                )
            saved.append(target.name)

        if not saved:
            shutil.rmtree(batch_dir, ignore_errors=True)
            raise SovitsError(
                "没有受支持的音频文件",
                hint="允许的后缀：%s" % "、".join(sorted(AUDIO_SUFFIXES)),
                code="NO_VALID_FILE",
                status=400,
                details={"rejected": rejected},
            )

        return {
            "ok": True,
            "dir": str(batch_dir),
            "files": saved,
            "rejected": rejected,
            "message": "已保存 %d 个文件，可直接用该目录发起训练" % len(saved),
        }


# --------------------------------------------------------------------------
# 标注校对
# --------------------------------------------------------------------------


def _register_annotations(app: FastAPI, ctx: Context) -> None:
    """ASR 结果的逐条校对。

    为什么必须有这一步：ASR 的错字会被**直接学进模型**，表现为某些字读音怪异，
    而且事后极难定位。官方用 `tools/subfix_webui.py`（Gradio）做这件事，
    集成不进来 —— 于是数据层抽到 `app/annotations.py`，界面由前端承担。
    """

    def _list_file_of(job_id: str) -> Path:
        job = ctx.store.get(job_id)
        if job is None:
            raise NotFoundError("任务不存在：%s" % job_id)
        raw = (job.artifacts or {}).get("list_file")
        if not raw:
            raise BadRequestError(
                "该任务没有产出训练清单",
                hint="只有跑过「语音转文本」或「生成训练清单」的任务才能校对。",
                code="NO_LIST",
            )
        return annotations.resolve_list_path(raw, Path(ctx.settings.data_dir))

    @app.get("/v1/annotations/{job_id}", tags=["train"])
    def list_annotations(job_id: str) -> Any:
        path = _list_file_of(job_id)
        items = annotations.parse_list(path)
        return {
            "ok": True,
            "job_id": job_id,
            "list_file": str(path),
            "items": [
                {
                    "index": item.index,
                    "audio_path": item.audio_path,
                    "audio_url": "/v1/annotations/audio?path=%s" % quote(item.audio_path, safe=""),
                    "speaker": item.speaker,
                    "language": item.language,
                    "text": item.text,
                    "exists": item.exists,
                }
                for item in items
            ],
            "total": len(items),
            "missing_audio": sum(1 for item in items if not item.exists),
        }

    @app.put("/v1/annotations/{job_id}", tags=["train"])
    def save_annotations(job_id: str, payload: AnnotationSaveRequest) -> Any:
        source = _list_file_of(job_id)
        items = annotations.parse_list(source)

        # 只应用传上来的改动：没传的保持原样。
        # 几百条的清单全量回传既浪费，也容易因为并发覆盖掉别人的修改。
        changed = 0
        for change in payload.items:
            if 0 <= change.index < len(items):
                items[change.index].text = change.text
                items[change.index].skip = change.skip
                changed += 1

        kept = [item for item in items if not item.skip]
        dropped = len(items) - len(kept)

        target = source
        if payload.save_as and payload.save_as.strip():
            target = annotations.resolve_list_path(
                payload.save_as.strip(), Path(ctx.settings.data_dir), "另存的清单"
            )
        annotations.write_list(target, kept)

        return {
            "ok": True,
            "list_file": str(target),
            "total": len(kept),
            "changed": changed,
            "dropped": dropped,
            "message": "已保存 %d 条%s" % (len(kept), ("，丢弃 %d 条" % dropped) if dropped else ""),
        }

    @app.get("/v1/annotations/audio", tags=["train"])
    def get_annotation_audio(path: str) -> Any:
        """回放清单里某条对应的音频。

        清单存的是绝对路径，而它可能来自用户（`list_file`），
        所以必须校验落在项目数据目录内 —— 否则一个带 `..` 的路径
        就能把整块磁盘读出来。
        """
        target = annotations.resolve_list_path(path, Path(ctx.settings.data_dir), "音频")
        if not target.is_file():
            raise NotFoundError(
                "音频文件不存在：%s" % target.name,
                hint="原始音频可能被清理或移动了，这条标注建议直接丢弃。",
            )
        return FileResponse(target, media_type=_guess_audio_type(target.suffix), filename=target.name)


# --------------------------------------------------------------------------
# 任务
# --------------------------------------------------------------------------


def _register_jobs(app: FastAPI, ctx: Context) -> None:
    @app.get("/v1/jobs", response_model=JobListView, tags=["jobs"])
    def list_jobs(kind: Optional[str] = None, limit: int = 50) -> Any:
        kind_enum: Optional[JobKind] = None
        if kind:
            try:
                kind_enum = JobKind(kind)
            except ValueError:
                raise SovitsError(
                    "未知任务类型：%s" % kind,
                    hint="可用值：infer、train",
                    code="BAD_PARAM",
                    status=400,
                )
        jobs = ctx.store.list(kind=kind_enum, limit=min(limit, 200))
        return JobListView(jobs=[job.to_dict(with_logs=False) for job in jobs], total=len(jobs))

    @app.get("/v1/jobs/{job_id}", response_model=JobView, tags=["jobs"])
    def get_job(job_id: str) -> Any:
        job = ctx.store.get(job_id)
        if job is None:
            raise NotFoundError("任务不存在：%s" % job_id)
        return JobView(job=job.to_dict())

    @app.post("/v1/jobs/{job_id}/cancel", response_model=MessageResponse, tags=["jobs"])
    def cancel_job(job_id: str, body: Optional[CancelRequest] = None) -> Any:
        job = ctx.store.get(job_id)
        if job is None:
            raise NotFoundError("任务不存在：%s" % job_id)
        ctx.scheduler.cancel(job)
        # 推理类任务还需要打断正在跑的 torch 推理
        ctx.pipeline.stop()
        ctx.store.log(job, "收到取消请求：%s" % (body.reason if body else ""), level="warn")
        return MessageResponse(message="已请求取消")

    @app.delete("/v1/jobs/{job_id}", response_model=MessageResponse, tags=["jobs"])
    def delete_job(job_id: str) -> Any:
        job = ctx.store.get(job_id)
        if job is None:
            raise NotFoundError("任务不存在：%s" % job_id)
        if not job.state.terminal:
            ctx.scheduler.cancel(job)
        ctx.store.delete(job_id)
        return MessageResponse(message="已删除")


# --------------------------------------------------------------------------
# 错误处理
# --------------------------------------------------------------------------


def _register_errors(app: FastAPI, ctx: Context) -> None:
    @app.exception_handler(SovitsError)
    async def _sovits_error(_: Request, exc: SovitsError) -> JSONResponse:
        return JSONResponse(status_code=exc.http_status, content={"ok": False, "error": exc.to_dict()})

    @app.exception_handler(AdmissionError)
    async def _admission(_: Request, exc: AdmissionError) -> JSONResponse:
        return JSONResponse(
            status_code=429 if exc.retryable else 403,
            content={"ok": False, "error": exc.to_dict()},
            headers={"Retry-After": str(exc.retry_after_s)} if exc.retryable else None,
        )

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
        """把 FastAPI 的 422 也统一成 {ok:false,error:{...}}。

        前端只有一套错误解析逻辑；如果参数校验走另一套格式，
        用户会看到「服务端返回了无法解析的数据」这种最没用的提示。
        """
        issues = []
        for item in exc.errors():
            location = ".".join(str(part) for part in item.get("loc", ()) if part != "body")
            issues.append({"field": location, "message": item.get("msg", ""), "type": item.get("type", "")})
        first = issues[0] if issues else {"field": "", "message": "请求参数不合法"}
        return JSONResponse(
            status_code=422,
            content={
                "ok": False,
                "error": {
                    "code": "VALIDATION_ERROR",
                    "message": "请求参数不合法：%s %s" % (first["field"], first["message"]),
                    "retryable": False,
                    "details": {"issues": issues},
                },
            },
        )

    @app.exception_handler(HTTPException)
    async def _http_error(_: Request, exc: HTTPException) -> JSONResponse:
        detail = exc.detail
        if isinstance(detail, dict):
            body = detail
        else:
            body = {"code": "HTTP_%d" % exc.status_code, "message": str(detail), "retryable": False}
        return JSONResponse(status_code=exc.status_code, content={"ok": False, "error": body})


# --------------------------------------------------------------------------
# 辅助
# --------------------------------------------------------------------------


def _dump(model: Any) -> Dict[str, Any]:
    """把 Pydantic 模型转成字典，额外字段（extra=allow）一并保留。"""
    if hasattr(model, "model_dump"):
        return model.model_dump()
    return dict(model)


def _split_tags(raw: str) -> List[str]:
    return [token.strip() for token in str(raw or "").replace("，", ",").split(",") if token.strip()]


_AUDIO_MIME = {
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
    ".flac": "audio/flac",
    ".ogg": "audio/ogg",
    ".m4a": "audio/mp4",
    ".webm": "audio/webm",
    ".aac": "audio/aac",
    ".wma": "audio/x-ms-wma",
}


def _guess_audio_type(suffix: str) -> str:
    return _AUDIO_MIME.get(suffix.lower(), "application/octet-stream")


def _line(payload: Dict[str, Any]) -> bytes:
    return (json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8")


def _require_auth(ctx: Context, request: Optional[Request]) -> None:
    """写操作的鉴权。仅 public 模式生效，且未配置令牌时放行（但 /health 会告警）。"""
    if not ctx.settings.is_public or not ctx.settings.admin_token:
        return
    if request is None:
        return
    provided = request.headers.get("x-api-key", "").strip()
    if provided and provided == ctx.settings.admin_token:
        return
    raise SovitsError(
        "需要有效的 API Key",
        hint="public 模式下，训练类接口需要携带 x-api-key 请求头。",
        code="UNAUTHORIZED",
        status=401,
    )


async def _wait_terminal(job: Job, timeout: float) -> Job:
    """轮询等待任务进入终态。相比 asyncio.Event，轮询不会因异常路径漏唤醒。"""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if job.state.terminal:
            return job
        await asyncio.sleep(0.2)
    raise SovitsError(
        "等待任务完成超时",
        hint="任务仍在后台运行，可通过任务接口继续查询。",
        code="TIMEOUT",
        status=504,
        retryable=True,
    )


# --------------------------------------------------------------------------
# 执行体注册
# --------------------------------------------------------------------------


def register_runners(ctx: Context) -> None:
    """注册两类任务的执行体。

    这里从 `job.request` 重建请求对象而不是闭包捕获请求对象 ——
    这样即便服务重启后从磁盘恢复了任务，也依然能拿到完整参数。
    """

    async def infer_runner(job: Job, cancel_event: asyncio.Event) -> Dict[str, Any]:
        """批量合成任务。

        合成本身是阻塞式的 torch 调用，因此丢进线程池执行，
        避免占住事件循环；同时把「进度 / 日志 / 取消」桥接回任务对象。
        """
        workdir = ctx.settings.outputs_dir / "batch" / job.id

        def progress(fraction: float, message: str) -> None:
            ctx.store.update(job, progress=round(float(fraction), 3), message=message)

        def log(message: str, level: str = "info") -> None:
            ctx.store.log(job, message, level)

        outcome = await asyncio.to_thread(
            ctx.batch.run,
            job.request,
            job.id,
            workdir,
            progress,
            lambda: cancel_event.is_set(),
            log,
        )
        payload = outcome.to_dict()
        payload["job_id"] = job.id
        payload["workdir"] = str(workdir)
        if outcome.cancelled:
            ctx.store.update(job, state=JobState.CANCELLED, message="已取消")
        return payload

    async def train_runner(job: Job, cancel_event: asyncio.Event) -> Dict[str, Any]:
        payload = TrainRequest(**job.request)
        return await ctx.training.run(job, payload, cancel_event)

    from .routers.asr import make_asr_train_runner  # noqa: PLC0415
    from .routers.svc import make_svc_runner  # noqa: PLC0415
    from .routers.uvr import make_separation_runner  # noqa: PLC0415
    from .routers.vc import make_vc_runner, make_vc_train_runner  # noqa: PLC0415

    ctx.scheduler.register(JobKind.INFER, infer_runner)
    ctx.scheduler.register(JobKind.TRAIN, train_runner)
    ctx.scheduler.register(JobKind.SEPARATE, make_separation_runner(ctx))
    ctx.scheduler.register(JobKind.SVC_INFER, make_svc_runner(ctx))
    ctx.scheduler.register(JobKind.VC_INFER, make_vc_runner(ctx))
    ctx.scheduler.register(JobKind.VC_TRAIN, make_vc_train_runner(ctx))
    ctx.scheduler.register(JobKind.ASR_TRAIN, make_asr_train_runner(ctx))


__all__ = ["Context", "create_app", "register_runners"]

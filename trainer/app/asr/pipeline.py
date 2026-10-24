"""ASR 推理引擎：模型常驻、单条转写、结果缓存。

职责边界只有一条：**输入一段音频，输出它的逐字文本。**
批量、清单、数据集这类「一批」的事情属于 `training.py`，不在这里。

与既有 GPT-SoVITS 管线同样的取舍：**模型常驻、配置热切换、串行推理**。
唯一的例外是脚本通道 —— 它每次转写按需起一个子进程，因此状态里会如实写
`loaded: false` 并说明原因，而不是假装加载成功。
"""

from __future__ import annotations

import gc
import json
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from ..audio.cache import ArtifactCache, cache_key
from ..audio.io import AUDIO_SUFFIXES, AudioError, probe, to_mono_wav
from ..config import Settings
from . import bootstrap, catalog
from .bootstrap import AsrError

__all__ = ["AsrEngine", "TARGET_SR"]

#: 识别采样率。几乎所有 ASR 模型的输入都固定 16k，写死以免各后端不一致。
TARGET_SR = 16000

#: 单条转写的时长上限（秒）。
#:
#: 长音频整段塞进模型既慢、又容易在静音段「瞎编词」。这条上限是**刻意的拒绝**：
#: 正确做法是先按静音切分（`audio/slicer.py`）再逐段转写，那属于批量流程的职责。
MAX_CLIP_SECONDS = 900.0

#: 脚本通道单次执行的超时（秒）。CPU 上跑 large 也要几分钟量级，给足余量。
SCRIPT_TIMEOUT_S = 1800.0

_MULTISPACE = re.compile(r"[ \t]{2,}")

#: 官方脚本产出的清单文件里的分隔符（与 `annotations.SEP` 一致）。
_LIST_SEP = "|"


class AsrEngine:
    """语音转文本引擎。全局唯一，挂在 `api.Context` 上。"""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.cache = ArtifactCache(settings.cache_dir)
        self._model: Any = None
        self._key: Tuple[Any, ...] = ()
        self._config: Dict[str, Any] = {}
        self._device: str = ""
        self._loaded_at: float = 0.0
        #: FunASR 权重的来源（`local` 用整合包已下载的，`remote` 由官方别名联网拉取），
        #: 只为排障用 —— 「为什么第一次转写这么慢」的答案通常就在这里。
        self._funasr_source: str = ""

    # ---------- 配置归一 ----------

    def resolve(
        self,
        *,
        backend: str = "",
        size: str = "",
        language: str = "",
        precision: str = "",
        model: str = "",
        channel: str = "",
    ) -> Dict[str, Any]:
        """把一组用户参数收敛成「实际会怎么跑」。

        预检接口直接把它吐给前端 —— 用户点「一键智能转写」之前就能看到
        走的是哪条通道、用的哪个模型、有没有被悄悄降级。
        """
        #: 先解决「语种与后端不匹配」：Official 脚本的 `-l` 是有 choices 的，
        #: 传错就直接退出。这里的处理原则是**换后端，而不是换语种** ——
        #: 把一段英文音频当中文转是错的（Paraformer 会得到一串似是而非的汉字），
        #: 换成能处理英文的后端才对。
        #:
        #: 阶段 44补2 的关键修正：**显式 model 是权威**。先把 model 解析成
        #: (backend, languages)，再决定要不要换后端；否则 `funasr + ja +
        #: iic/SenseVoiceSmall` 会被切到 fasterwhisper，model 却仍留在 SenseVoice，
        #: 最后拿 SenseVoice 的 id 去调 WhisperModel（backend/model 错配）。
        notes: List[str] = []
        target_language = (language or "").strip()
        model_key = (model or "").strip()
        chosen_backend = (backend or "").strip()
        base_backend = chosen_backend or str(getattr(self.settings, "asr_backend", "") or "") or catalog.DEFAULTS["backend"]
        model_meta = catalog.resident_model_meta(model_key) if model_key else None
        language_pool: Optional[List[str]] = None

        if model_meta is not None:
            model_backend = str(model_meta.get("backend") or "")
            if chosen_backend and chosen_backend != model_backend:
                notes.append(
                    "model %s 属于 %s，已按 model 的 backend 解析（不再静默换后端）"
                    % (model_key, model_backend)
                )
            chosen_backend = model_backend
            language_pool = list(model_meta.get("languages") or [])
            if target_language and language_pool and target_language not in language_pool:
                raise AsrError(
                    "模型 %s 不支持语种 %s" % (model_meta.get("label") or model_key, target_language),
                    hint="该模型可用语种：%s。" % "、".join(language_pool),
                    code="LANGUAGE_UNSUPPORTED",
                    status=400,
                    retryable=False,
                )
        else:
            chosen_backend = base_backend
            # 显式 pin 了未知 model 时也不自动换后端：宁可让加载器报清楚，
            # 也不要出现「backend 换了、model 没换」的错配。
            if not model_key and chosen_backend in catalog.BACKENDS and target_language:
                supported = catalog.BACKENDS[chosen_backend].get("languages") or []
                if target_language not in supported:
                    # funasr 先看常驻模型能否承接（SenseVoice 的 en/ja/ko）；
                    # 能承接就保持 funasr，否则沿用旧的换后端逻辑。
                    preferred = catalog.default_resident_model(chosen_backend, target_language)
                    if preferred is not None:
                        notes.append(
                            "funasr 的官方脚本不支持%s；由常驻 %s 承接，不切到 fasterwhisper"
                            % (
                                catalog.language_label(target_language),
                                preferred.get("label") or preferred.get("id"),
                            )
                        )
                    else:
                        for candidate in ("funasr", "fasterwhisper"):
                            if candidate == chosen_backend:
                                continue
                            if target_language in (catalog.BACKENDS[candidate].get("languages") or []):
                                notes.append(
                                    "%s 不支持%s，已改用 %s（换后端，而不是把音频当成另一种语言来转）"
                                    % (chosen_backend, catalog.language_label(target_language), candidate)
                                )
                                chosen_backend = candidate
                                break
            if chosen_backend == "funasr":
                preferred = catalog.default_resident_model(
                    "funasr", target_language or catalog.defaults(self.settings).get("language", "zh")
                )
                if preferred is not None:
                    model_key = str(preferred.get("id") or preferred.get("key") or "")
                    language_pool = list(preferred.get("languages") or [])

        backend2, size2, language2, precision2, extra = catalog.normalize(
            chosen_backend,
            size,
            language,
            precision,
            self.settings,
            language_pool=language_pool,
        )
        notes.extend(extra)
        picked = bootstrap.resolve_channel(self.settings, backend2, channel)

        # ---- 对齐官方的语种策略：中文 / 粤语交给 FunASR ----
        #
        # 官方 `fasterwhisper_asr.py::execute_asr()` 里藏着一条很容易被忽略的行为：
        # whisper 识别出 zh / yue 之后，会把整条音频**转交 FunASR 重做**，
        # 因为中文上 Paraformer 明显强于 Whisper（推荐文档的结论也是同一个方向）。
        # 与其等 whisper 检测完再切（那会把两个模型换来换去，反而更慢），
        # 不如在参数阶段就决定：语种明确是 zh / yue 时直接用 FunASR。
        # 显式 model 时不做这个自动切换（尊重调用方 pin 的权重）。
        if (
            backend2 == "fasterwhisper"
            and language2 in {"zh", "yue"}
            and not channel
            and not model_key
            and bootstrap.resident_support("funasr")["available"]
        ):
            preferred = catalog.default_resident_model("funasr", language2)
            model_key = str(preferred.get("id") or preferred.get("key") or "") if preferred else ""
            language_pool = list(preferred.get("languages") or []) if preferred else None
            backend2, size2, language2, precision2, extra = catalog.normalize(
                "funasr", "", language2, "", self.settings, language_pool=language_pool
            )
            notes.extend(extra)
            notes.append(
                "中文 / 粤语已改用 FunASR：官方 fasterwhisper_asr.py 在识别到中文后同样会"
                "转交 FunASR，这里直接在参数阶段切换，省掉一次 Whisper 加载"
            )
            picked = bootstrap.resolve_channel(self.settings, backend2, channel)

        model_id = model_key or self._default_model_id(backend2, size2, language2)
        weights = bootstrap.model_weights_status(
            self.settings, model_id, language2, backend=backend2
        )
        return {
            "backend": backend2,
            "size": size2,
            "language": language2,
            "precision": precision2,
            "model": model_id,
            "channel": picked["channel"],
            "reason": picked["reason"],
            "notes": notes,
            #: 权重就绪（True/False）或未知（None，例如 faster-whisper 的 HF 缓存）；
            #: 外部调用方与 /api/capabilities 都靠这个字段判断「能不能直接跑」。
            "weights_ready": weights.get("ready"),
            "weights_source": weights.get("source") or "",
            "weights_path": weights.get("path") or "",
            "weights_hint": weights.get("hint") or "",
            "key": (backend2, size2, language2, precision2, model_id, picked["channel"]),
        }

    @staticmethod
    def _default_model_id(backend: str, size: str, language: str) -> str:
        """常驻通道的默认模型标识。

        `fasterwhisper` 的标识与尺寸同名，直接用 size；`funasr` 需要按语种挑：
        中文用 Paraformer（逐字 + 标点最好），其它语种退回 SenseVoice（多语种）。
        """
        if backend == "fasterwhisper":
            # 官方脚本把 "large" 归一成 "large-v3"，常驻通道沿用同一个约定，
            # 免得两条通道用的不是同一个 Whisper 权重。
            return "large-v3" if size == "large" else size
        options = {item["key"]: item["id"] for item in catalog.resident_models(backend)}
        preferred = "paraformer-zh" if language == "zh" else "sensevoice-small"
        return options.get(preferred) or (list(options.values())[0] if options else size)

    # ---------- 生命周期 ----------

    def load(self, **kwargs: Any) -> Dict[str, Any]:
        """加载（或热切换到）指定模型。脚本通道没有常驻模型，只记录配置。"""
        config = self.resolve(**kwargs)
        if config["channel"] == "script":
            self._config = config
            return {
                **self.status(),
                "message": "当前解析为脚本通道：每次转写按需起子进程，不常驻模型。%s"
                % (config["reason"] or ""),
            }
        if self._model is not None and self._key == config["key"]:
            return self.status()
        self._ensure_resident(config)
        return self.status()

    def unload(self) -> None:
        """释放模型并归还显存。引擎注册表与「手动释放显存」都会调它。"""
        model, self._model = self._model, None
        self._key = ()
        self._device = ""
        if model is not None:
            del model
        gc.collect()
        try:
            import torch  # noqa: PLC0415

            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:  # noqa: BLE001 - 没有 torch 或没有显卡都不是错误
            pass

    @property
    def ready(self) -> bool:
        return self._model is not None

    def status(self) -> Dict[str, Any]:
        stages = (self.cache.stats().get("stages") or {})
        cached = stages.get("asr") or {"count": 0, "bytes": 0}
        return {
            "loaded": self._model is not None,
            "backend": self._config.get("backend"),
            "size": self._config.get("size"),
            "language": self._config.get("language"),
            "precision": self._config.get("precision"),
            "model": self._config.get("model"),
            "channel": self._config.get("channel"),
            "reason": self._config.get("reason", ""),
            "weights_ready": self._config.get("weights_ready"),
            "weights_source": self._config.get("weights_source"),
            "device": self._device or None,
            "funasr_source": self._funasr_source or None,
            "held_s": round(time.time() - self._loaded_at, 1) if self._loaded_at else 0.0,
            "cache": cached,
            "session_dir": str(self.settings.asr_dir),
        }

    def diagnostics(self) -> Dict[str, Any]:
        """两条通道的完整体检。转发给 `bootstrap`，免得路由层还要多认一个模块。"""
        return bootstrap.diagnose(self.settings)

    def _ensure_resident(self, config: Dict[str, Any]) -> Any:
        if self._model is not None and self._key == config["key"]:
            return self._model
        # 权重未就绪时在卸载旧模型之前就拒绝：既不会白丢当前模型，也不会把
        # 一次「缺权重」误报成上游加载失败。
        if config.get("weights_ready") is False:
            raise AsrError(
                "模型权重未就绪：%s" % config.get("model"),
                hint=str(config.get("weights_hint") or "先下载模型权重后重试。"),
                code="WEIGHTS_MISSING",
                status=503,
                retryable=False,
            )
        self.unload()
        backend = config["backend"]
        model_id = config["model"]
        if backend == "funasr":
            model = self._build_funasr(model_id, config["language"])
        elif backend == "fasterwhisper":
            model = self._build_whisper(model_id, config["precision"])
        else:
            raise AsrError(
                "不支持的 ASR 后端：%s" % backend,
                hint="可选：%s。" % "、".join(catalog.BACKENDS),
                code="BACKEND_UNSUPPORTED",
                status=400,
                retryable=False,
            )
        self._model = model
        self._key = config["key"]
        self._config = dict(config)
        self._loaded_at = time.time()
        return model

    def _build_funasr(self, model_id: str, language: str = "zh") -> Any:
        """构造 FunASR 模型。

        优先吃整合包里**已下载**的权重（`tools/asr/models/`），其次吃
        ModelScope 缓存里的完整快照；两者都没有时抛 `WEIGHTS_MISSING`，
        不再靠官方别名静默联网下载（下载耗时不可控，且与「可用」语义冲突）。
        """
        auto_model = bootstrap.import_funasr()
        local = bootstrap.funasr_local_models(self.settings)
        kwargs: Dict[str, Any] = {}
        weights = bootstrap.model_weights_status(self.settings, model_id, language)

        if model_id == "paraformer-zh":
            target, revision = bootstrap.funasr_model_path(self.settings, model_id, language)
            if target is None:
                raise AsrError(
                    "Paraformer-zh 权重未就绪",
                    hint=str(weights.get("hint") or "先把 FunASR 权重放进 tools/asr/models。"),
                    code="WEIGHTS_MISSING",
                    status=503,
                    retryable=False,
                )
            # 逐字参考文本要的正是 VAD + 标点：少了 VAD，短音频的静音段最容易出幻觉文本
            kwargs.update(model=str(target), model_revision=revision)
            if local.get("vad"):
                kwargs.update(vad_model=local["vad"], vad_model_revision="v2.0.4")
            if local.get("punc"):
                kwargs.update(punc_model=local["punc"], punc_model_revision="v2.0.4")
            self._funasr_source = str(weights.get("source") or "local")
        elif model_id in {"iic/SenseVoiceSmall", "sensevoice-small"}:
            target, _ = bootstrap.funasr_model_path(self.settings, model_id)
            if target is None:
                raise AsrError(
                    "SenseVoice-Small 权重未就绪",
                    hint=str(weights.get("hint") or "先下载 SenseVoice-Small 权重。"),
                    code="WEIGHTS_MISSING",
                    status=503,
                    retryable=False,
                )
            # 耳语/ASMR 场景刻意不挂 VAD：VAD 会把气声段落当静音切掉；
            # 标点也未接，调用方需要时自行后处理。
            kwargs.update(model=str(target))
            self._funasr_source = str(weights.get("source") or "local")
        else:
            kwargs.update(model=model_id)
            self._funasr_source = "remote"

        device = (self.settings.asr_device or "").strip()
        if device and device != "auto":
            kwargs["device"] = device
        try:
            return auto_model(**kwargs)
        except Exception as exc:  # noqa: BLE001
            raise AsrError(
                "加载 FunASR 模型失败（%s / %s）：%s" % (model_id, self._funasr_source, exc),
                hint=(
                    "本地权重损坏时可改用官方别名自动重下：删掉整合包的 "
                    "tools/asr/models 下对应目录，或改用 sensevoice-small / faster-whisper。"
                ),
                code="MODEL_LOAD_FAILED",
            ) from exc

    def _build_whisper(self, model_id: str, precision: str) -> Any:
        whisper_model = bootstrap.import_whisper()
        device, compute_type = self._whisper_runtime(precision)
        try:
            model = whisper_model(model_id, device=device, compute_type=compute_type)
        except Exception as exc:  # noqa: BLE001
            raise AsrError(
                "加载 faster-whisper 模型失败（%s）：%s" % (model_id, exc),
                hint="首次使用会从 HuggingFace 下载权重；没有显卡时把精度改成 int8。",
                code="MODEL_LOAD_FAILED",
            ) from exc
        self._device = "%s / %s" % (device, compute_type)
        return model

    @staticmethod
    def _whisper_runtime(precision: str) -> Tuple[str, str]:
        """faster-whisper 的设备与精度。CPU 上 fp16 会直接报错，必须换掉。"""
        if _cuda_available():
            return "cuda", precision if precision in {"float16", "float32", "int8"} else "float16"
        return "cpu", precision if precision == "float32" else "int8"

    # ---------- 转写 ----------

    def transcribe(
        self,
        *,
        src: Path,
        backend: str = "",
        size: str = "",
        language: str = "",
        precision: str = "",
        model: str = "",
        channel: str = "",
        use_cache: bool = True,
    ) -> Dict[str, Any]:
        """把一段音频转成逐字文本。"""
        src = Path(src)
        if not src.is_file():
            raise AsrError(
                "音频文件不存在：%s" % src,
                hint="确认路径，或重新上传一次。",
                code="SOURCE_MISSING",
                status=404,
                retryable=False,
            )
        try:
            info = probe(src)
        except AudioError as exc:
            raise AsrError(
                "无法解析音频：%s" % exc,
                hint="支持 %s。" % "、".join(sorted(AUDIO_SUFFIXES)),
                code="BAD_AUDIO",
                status=400,
                retryable=False,
            ) from exc
        if info.duration <= 0:
            raise AsrError(
                "音频长度为 0，无法转写",
                hint="重新导出一次音频，确认它不是空文件。",
                code="BAD_AUDIO",
                status=400,
                retryable=False,
            )
        if info.duration > MAX_CLIP_SECONDS:
            raise AsrError(
                "音频过长（%.1f 秒），超过单条上限 %.0f 秒" % (info.duration, MAX_CLIP_SECONDS),
                hint="先按静音切分成小段再逐段转写：整段识别既慢，也容易在静音段出现幻觉文本。",
                code="CLIP_TOO_LONG",
                status=400,
                retryable=False,
            )

        config = self.resolve(
            backend=backend, size=size, language=language, precision=precision, model=model, channel=channel
        )
        params = {name: config[name] for name in ("backend", "size", "language", "precision", "model", "channel")}
        key = cache_key(src, "asr", params)

        if use_cache and self.settings.asr_cache_enabled:
            hit = self.cache.find(key, "asr")
            if hit is not None:
                cached = _read_cached(hit)
                if cached is not None:
                    cached["cached"] = True
                    return cached

        wav = self._prepare_wav(src, key)
        try:
            started = time.time()
            detected = ""
            if config["channel"] == "resident":
                text, segments, detected = self._run_resident(wav, config)
            else:
                text, segments = self._run_script(wav, config)
            elapsed = time.time() - started
        finally:
            wav.unlink(missing_ok=True)

        notes = list(config["notes"])
        if detected in {"zh", "yue"} and config["language"] in {"", "auto"}:
            # 语种选了 auto 却识别到中文：给一条可执行的建议，而不是让用户自己发现。
            notes.append(
                "识别到%s语音：把语种显式选成 %s 会自动改用 FunASR，中文精度明显更好"
                % (catalog.language_label(detected), detected)
            )

        payload: Dict[str, Any] = {
            "text": text,
            "segments": segments,
            "language": config["language"],
            "backend": config["backend"],
            "size": config["size"],
            "precision": config["precision"],
            "model": config["model"],
            "channel": config["channel"],
            "reason": config["reason"],
            "notes": notes,
            "duration": round(info.duration, 2),
            "elapsed_s": round(elapsed, 2),
            "cached": False,
            "source": str(src),
            "cache_key": key,
        }
        if use_cache and self.settings.asr_cache_enabled:
            self._store_cache(key, params, payload)
        return payload

    def _prepare_wav(self, src: Path, key: str) -> Path:
        """统一成 16k 单声道 wav 再喂给模型。所有后端都是这个要求。"""
        work = self.settings.asr_dir / "work"
        work.mkdir(parents=True, exist_ok=True)
        stem = "".join(ch for ch in src.stem if ch.isalnum() or ch in "-_")[:24] or "clip"
        wav = work / ("%s_%s_16k.wav" % (key[:10], stem))
        if not wav.is_file():
            try:
                to_mono_wav(src, wav, sample_rate=TARGET_SR)
            except Exception as exc:  # noqa: BLE001
                raise AsrError(
                    "音频归一失败：%s" % exc,
                    hint="先用播放器把它转成 16k 单声道 wav 再试；个别封装（如带 DRM 的 m4a）解不开。",
                    code="AUDIO_CONVERT_FAILED",
                ) from exc
        return wav

    def _run_resident(
        self, wav: Path, config: Dict[str, Any]
    ) -> Tuple[str, List[Dict[str, Any]], str]:
        """走常驻模型。返回 `(文本, 分段, 识别到的语种)`。

        第三个返回值只用于「语种选 auto 时提醒用户其实可以指定」这类提示，
        FunASR 没有这个信息，就把传入的语种原样带回。
        """
        model = self._ensure_resident(config)
        if config["backend"] == "funasr":
            return self._funasr_generate(model, wav), [], config["language"]
        return self._whisper_generate(model, wav, config["language"])

    @staticmethod
    def _funasr_generate(model: Any, wav: Path) -> str:
        try:
            #: 与官方 `funasr_asr.py::only_asr()` 的调用形式保持一致 —— 不加任何额外参数。
            #:
            #: 这条是实测出来的：曾经这里写了 `batch_size_s=300, use_itn=True`，
            #: 结果同一段音频只转写出前一段（0.12 秒就返回），而官方脚本跑出的文本更长
            #: 也更完整。另外 `use_itn` 会把「二零二四」改写成「2024」，
            #: 而参考文本要的是**逐字**文本 —— 改写出来的数字会被直接学进音色。
            result = model.generate(input=str(wav))
        except Exception as exc:  # noqa: BLE001
            raise AsrError(
                "FunASR 转写失败：%s" % exc,
                hint="确认 model_id 与语种匹配（Paraformer 只认中文，其它语种用 SenseVoice）。",
                code="TRANSCRIBE_FAILED",
            ) from exc
        return _funasr_text(result)

    @staticmethod
    def _whisper_generate(
        model: Any, wav: Path, language: str
    ) -> Tuple[str, List[Dict[str, Any]], str]:
        try:
            # 参数与官方 `fasterwhisper_asr.py::execute_asr()` 保持一致
            # （含 vad_parameters），这样两条通道的结果可以直接对照。
            segments, info = model.transcribe(
                str(wav),
                language=None if language in {"", "auto"} else language,
                beam_size=5,
                vad_filter=True,
                vad_parameters=dict(min_silence_duration_ms=700),
            )
            collected: List[Dict[str, Any]] = []
            for segment in segments:
                collected.append(
                    {
                        "start": round(float(getattr(segment, "start", 0.0) or 0.0), 2),
                        "end": round(float(getattr(segment, "end", 0.0) or 0.0), 2),
                        "text": str(getattr(segment, "text", "") or "").strip(),
                    }
                )
        except Exception as exc:  # noqa: BLE001
            raise AsrError(
                "faster-whisper 转写失败：%s" % exc,
                hint="确认模型权重已下载；显存不足时把精度降到 int8，或换更小的尺寸。",
                code="TRANSCRIBE_FAILED",
            ) from exc
        return (
            _join_segments(item["text"] for item in collected),
            collected,
            str(getattr(info, "language", "") or "").lower(),
        )

    def _run_script(self, wav: Path, config: Dict[str, Any]) -> Tuple[str, List[Dict[str, Any]]]:
        """脚本通道：子进程跑官方脚本，命令与训练流水线的 ASR 阶段完全一致。

        为了转写「一段音频」，这里临时造一个只含这一个文件的输入目录 ——
        官方脚本本来就是按目录批处理的，把单条也表达成目录，比另写一份单条逻辑
        更不容易跟上游跑偏。
        """
        script = bootstrap.script_for(self.settings, config["backend"])
        home = bootstrap.require_installation().home
        stamp = "%d_%s" % (int(time.time() * 1000), config["backend"])
        work = self.settings.asr_dir / "script" / stamp
        in_dir = work / "in"
        out_dir = work / "out"
        in_dir.mkdir(parents=True, exist_ok=True)
        out_dir.mkdir(parents=True, exist_ok=True)
        target = in_dir / wav.name
        shutil.copy2(wav, target)

        cmd = [
            str(sys.executable),
            "-s",
            str(script),
            "-i",
            str(in_dir),
            "-o",
            str(out_dir),
            "-s",
            str(config["size"]),
            "-l",
            str(config["language"]),
            "-p",
            str(config["precision"]),
        ]
        try:
            completed = subprocess.run(
                cmd,
                cwd=str(home),
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=SCRIPT_TIMEOUT_S,
            )
        except subprocess.TimeoutExpired as exc:
            raise AsrError(
                "官方 ASR 脚本超时（>%.0f 秒）" % SCRIPT_TIMEOUT_S,
                hint="换更小的 size，或改用常驻通道（先加载模型，单条快得多）。",
                code="SCRIPT_TIMEOUT",
            ) from exc
        if completed.returncode != 0:
            tail = (completed.stderr or completed.stdout or "").strip().splitlines()[-6:]
            raise AsrError(
                "官方 ASR 脚本执行失败（退出码 %d）：%s" % (completed.returncode, " / ".join(tail) or "无输出"),
                hint="常见原因是缺少 funasr / faster-whisper 依赖，或模型权重未下载。",
                code="SCRIPT_FAILED",
            )

        return _read_script_lists(out_dir, target), []

    # ---------- 缓存 ----------

    def _store_cache(self, key: str, params: Dict[str, Any], payload: Dict[str, Any]) -> None:
        work = self.settings.asr_dir / "work"
        work.mkdir(parents=True, exist_ok=True)
        tmp = work / ("%s.json" % key[:12])
        try:
            tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
            self.cache.store(
                key,
                "asr",
                files={"transcript": tmp},
                params=params,
                note="%s / %s / %s" % (payload["backend"], payload["model"], payload["channel"]),
            )
        except OSError:
            pass  # 缓存写不进去不影响本次结果
        finally:
            tmp.unlink(missing_ok=True)


# --------------------------------------------------------------------------
# 纯函数
# --------------------------------------------------------------------------


def _read_cached(entry: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    path = (entry.get("files") or {}).get("transcript")
    if not path:
        return None
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _funasr_text(result: Any) -> str:
    """从 FunASR 的返回里取文本。

    不同模型/版本的键不一样（`text` / `sentence_info`），这里按兼容顺序取，
    取不到就返回空串 —— 让上层用「文本为空」这个事实去提示用户，
    比抛一个 500 更有用。
    """
    if isinstance(result, list) and result:
        first = result[0]
        if isinstance(first, dict):
            text = first.get("text")
            if not text:
                sentences = first.get("sentence_info") or []
                text = "".join(
                    str(item.get("text") or "") for item in sentences if isinstance(item, dict)
                )
            return _clean(str(text or ""))
    if isinstance(result, dict):
        return _clean(str(result.get("text") or ""))
    return ""


def _read_script_lists(out_dir: Path, target: Path) -> str:
    """从官方脚本产出的 `.list` 里取回这一段音频的文本。

    官方格式：`音频绝对路径|说话人|语种|文本`
    （与 `annotations.py` 同一套格式，故意不做第二种解析）。
    """
    for list_path in sorted(out_dir.rglob("*.list")):
        try:
            body = list_path.read_text(encoding="utf-8")
        except OSError:
            continue
        for line in body.splitlines():
            line = line.strip()
            if not line:
                continue
            parts = line.split(_LIST_SEP, 3)
            if len(parts) < 4:
                continue
            audio = Path(parts[0].strip())
            if audio.name == target.name or audio.stem == target.stem:
                return _clean(parts[3])
    return ""


def _join_segments(parts: Iterable[str]) -> str:
    """把分段文本拼成整段。

    Whisper 的片段自带前导空格，直接相连即可；中文片段通常不带空格，
    所以不会出现「中 文」这样的间隙 —— 不要自作聪明地加空格。
    """
    return _clean("".join(parts))


def _clean(text: str) -> str:
    """压掉多余空白，但保留英文单词之间的单个空格。"""
    return _MULTISPACE.sub(" ", text).strip()


def _cuda_available() -> bool:
    try:
        import torch  # noqa: PLC0415

        return bool(torch.cuda.is_available())
    except Exception:  # noqa: BLE001
        return False

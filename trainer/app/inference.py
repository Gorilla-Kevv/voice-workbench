"""合成执行层。

一次合成要经过四步，本模块负责把它们串起来并保证每一步都可观测：

    解析请求 → 配置管线（版本/权重/设备）→ 调用官方管线 → 落盘 + 生成 URL

与旧实现的根本差别：**不再为每次请求启动一个子进程**。
旧实现按官方 `inference_cli.py` 拼命令行，等于每次合成都要重新加载
4 个模型（约 1 分钟）—— 这在「本地随手试听」的场景下等于不可用。
现在模型常驻 `Pipeline`，单条合成只剩推理本身的耗时。
"""

from __future__ import annotations

import base64
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, Iterator, Optional, Tuple

from .config import Settings
from .errors import BadRequestError
from .sovits import catalog, synth
from .sovits.pipeline import Pipeline
from .sovits.synth import Reference
from .sovits.voices import VoiceLibrary

ProgressCallback = Callable[[float, str], None]


@dataclass
class SynthOutcome:
    """一次合成的结果。"""

    path: Path
    url: str
    filename: str
    size_bytes: int
    duration_s: float
    sample_rate: int
    elapsed_ms: int
    text: str
    text_lang: str
    mode: str
    version: str
    gpt_model: str
    sovits_model: str
    reference: Reference
    inputs: Dict[str, Any]

    def to_payload(self, inline_base64: bool = False) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "audio_url": self.url,
            "mime_type": "audio/wav",
            "bytes": self.size_bytes,
            "duration_s": self.duration_s,
            "sample_rate": self.sample_rate,
            "text": self.text,
            "text_lang": self.text_lang,
            "mode": self.mode,
            "version": self.version,
            "gpt_model": self.gpt_model,
            "sovits_model": self.sovits_model,
            "voice_id": self.reference.voice_id,
            "voice_name": self.reference.voice_name,
            "elapsed_ms": self.elapsed_ms,
        }
        if inline_base64:
            payload["audio"] = base64.b64encode(self.path.read_bytes()).decode("ascii")
        return payload


class SynthesisEngine:
    """合成的统一入口。单例使用。"""

    def __init__(
        self,
        settings: Settings,
        pipeline: Pipeline,
        library: VoiceLibrary,
    ) -> None:
        self.settings = settings
        self.pipeline = pipeline
        self.library = library

    # ------------------------------------------------------------------
    # 准备
    # ------------------------------------------------------------------

    def apply_target(self, payload: Dict[str, Any]) -> None:
        """把请求里的版本/权重/设备落到管线上。"""
        version = (payload.get("version") or "").strip() or None
        gpt = (payload.get("gpt") or "").strip() or None
        sovits = (payload.get("sovits") or "").strip() or None
        device = (payload.get("device") or "").strip() or None
        is_half = payload.get("is_half")

        if not any([version, gpt, sovits, device, is_half is not None]):
            return
        self.pipeline.configure(
            version=version,
            device=device,
            is_half=is_half if isinstance(is_half, bool) else None,
            gpt=gpt,
            sovits=sovits,
        )

    def prepare(self, payload: Dict[str, Any]) -> Tuple[Dict[str, Any], Reference]:
        """校验并翻译请求。不触发模型加载。"""
        self.apply_target(payload)
        merged = _merge_params(payload)
        built = synth.build_inputs(merged, self.library, self.pipeline.version)
        return built, built["reference"]

    # ------------------------------------------------------------------
    # 合成到文件
    # ------------------------------------------------------------------

    def synthesize_to_file(
        self,
        payload: Dict[str, Any],
        filename: Optional[str] = None,
        progress: Optional[ProgressCallback] = None,
    ) -> SynthOutcome:
        built, reference = self.prepare(payload)

        if progress:
            progress(0.05, "正在准备模型（首次加载约需 30~90 秒）")
        self.pipeline.warmup(blocking=True)
        if progress:
            progress(0.25, "模型就绪，开始推理")

        started = time.monotonic()
        sample_rate, audio = self.pipeline.synthesize(built["inputs"])
        elapsed_ms = int((time.monotonic() - started) * 1000)

        if progress:
            progress(0.9, "正在编码音频")

        raw = synth.to_wav_bytes(sample_rate, audio)
        relative_name = filename or ("%s.wav" % uuid.uuid4().hex[:12])
        path = self._write_output(relative_name, raw)
        duration = synth.audio_duration_s(sample_rate, audio)

        pair = self.pipeline.current_pair()
        if progress:
            progress(1.0, "完成")

        return SynthOutcome(
            path=path,
            url=self.url_for(path),
            filename=path.name,
            size_bytes=len(raw),
            duration_s=duration,
            sample_rate=int(sample_rate or 0),
            elapsed_ms=elapsed_ms,
            text=built["text"],
            text_lang=built["text_lang"],
            mode=built["mode"],
            version=pair.version,
            gpt_model=pair.gpt.stem,
            sovits_model=pair.sovits.stem,
            reference=reference,
            inputs=built["inputs"],
        )

    # ------------------------------------------------------------------
    # 流式
    # ------------------------------------------------------------------

    def stream(self, payload: Dict[str, Any]) -> Iterator[Tuple[int, Any]]:
        """流式产出 (采样率, int16 音频块)。

        官方在 v3/v4 上不支持流式，`synth.normalize_params` 会在更早的阶段拦下。
        """
        built, _ = self.prepare(payload)
        self.pipeline.warmup(blocking=True)
        for chunk in self.pipeline.stream(built["inputs"]):
            yield chunk

    # ------------------------------------------------------------------
    # 文本切分预览
    # ------------------------------------------------------------------

    def split_text(self, text: str, text_lang: str, method: str) -> Dict[str, Any]:
        """复用官方的切分实现，让用户在下单前就看到实际会被送去合成的句子。"""
        if method not in catalog.TEXT_SPLIT_METHODS:
            raise BadRequestError(
                "未知的文本切分方式：%s" % method,
                hint="可用值：%s" % "、".join(catalog.TEXT_SPLIT_METHODS),
            )
        from .sovits import bootstrap  # noqa: PLC0415

        official = bootstrap.official()
        self.pipeline.warmup(blocking=True)
        preprocessor = self.pipeline._pipeline.text_preprocessor  # noqa: SLF001 - 复用官方实例
        try:
            pieces = preprocessor.pre_seg_text(text, text_lang, method)
        except Exception as exc:  # noqa: BLE001
            raise BadRequestError(
                "文本切分失败：%s: %s" % (type(exc).__name__, exc),
                hint="请检查语种设置与文本内容。",
            ) from exc
        _ = official
        segments = [
            {"index": index, "text": piece, "chars": len(piece)} for index, piece in enumerate(pieces)
        ]
        return {
            "segments": segments,
            "total": len(segments),
            "chars": sum(item["chars"] for item in segments),
        }

    # ------------------------------------------------------------------
    # 输出管理
    # ------------------------------------------------------------------

    def _write_output(self, relative_name: str, raw: bytes) -> Path:
        """写入输出目录。`relative_name` 可含子目录（批量任务用它分目录存放）。"""
        target = (self.settings.outputs_dir / relative_name).resolve()
        outputs_root = self.settings.outputs_dir.resolve()
        if outputs_root not in target.parents and target != outputs_root:
            raise BadRequestError(
                "输出路径越界：%s" % relative_name,
                hint="输出文件必须落在数据目录的 outputs/ 下。",
                code="PATH_TRAVERSAL",
            )
        target.parent.mkdir(parents=True, exist_ok=True)
        # 同名时追加短后缀，避免批量任务互相覆盖
        if target.exists():
            target = target.with_name("%s-%s%s" % (target.stem, uuid.uuid4().hex[:6], target.suffix))
        target.write_bytes(raw)
        return target

    def url_for(self, path: Path) -> str:
        """把输出文件路径映射为可被浏览器访问的静态 URL。"""
        relative = path.resolve().relative_to(self.settings.outputs_dir.resolve())
        return "/files/%s" % relative.as_posix()

    def cleanup_outputs(self) -> int:
        """清理过期输出。返回删除的文件数。"""
        days = self.settings.output_retention_days
        if days <= 0:
            return 0
        cutoff = time.time() - days * 86400
        removed = 0
        for path in self.settings.outputs_dir.rglob("*"):
            if not path.is_file():
                continue
            try:
                if path.stat().st_mtime < cutoff:
                    path.unlink()
                    removed += 1
            except OSError:
                continue
        return removed


# --------------------------------------------------------------------------


def _merge_params(payload: Dict[str, Any]) -> Dict[str, Any]:
    """把 `params` 子字典与顶层字段合并，顶层优先。

    前端有两种写法：把参数放进 `params`（结构化），或直接平铺在请求体里（简洁）。
    两者都支持，避免因为风格差异产生「参数没生效」的错觉。
    """
    merged: Dict[str, Any] = {}
    params = payload.get("params")
    if isinstance(params, dict):
        merged.update(params)
    for key, value in payload.items():
        if key == "params":
            continue
        if value is not None:
            merged[key] = value
    return merged

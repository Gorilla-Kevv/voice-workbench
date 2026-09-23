"""批量合成。

官方 WebUI 只能逐条粘贴、逐条试听 —— 做有声书、课件、素材库时这件事会被放大成灾难。
本模块把「一份文本清单 → 一批音频 + 一个 ZIP」变成一次操作，并保证：

* **单条失败不拖垮整批**：默认继续执行，失败原因逐条记录（可用 `continue_on_error=false` 改回快速失败）；
* **可中止**：每条开始前检查取消标志，避免用户等一个已经取消的任务跑完；
* **有清单**：产出 `manifest.json` 与 `index.csv`，音频文件名与原文一一对应，便于回填到其它系统；
* **可复用同一音色与参数**：请求级默认值对每条生效，条目只覆盖自己关心的字段。

并行度刻意保持为 1：单卡串行是本地机器的物理约束，
真正提升吞吐的是「一次提交几百条」而不是「同时抢显存」。
"""

from __future__ import annotations

import csv
import io
import json
import re
import time
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from .config import Settings
from .errors import BadRequestError, SovitsError
from .inference import SynthesisEngine, SynthOutcome
from .sovits import catalog

ProgressCallback = Callable[[float, str], None]
CancelCheck = Callable[[], bool]

_INVALID_FILENAME = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


@dataclass
class BatchItemResult:
    index: int
    key: Optional[str]
    text: str
    ok: bool
    filename: Optional[str] = None
    audio_url: Optional[str] = None
    bytes: int = 0
    duration_s: float = 0.0
    elapsed_ms: int = 0
    error: Optional[str] = None
    hint: Optional[str] = None
    audio_path: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "index": self.index,
            "key": self.key,
            "text": self.text,
            "ok": self.ok,
            "filename": self.filename,
            "audio_url": self.audio_url,
            "bytes": self.bytes,
            "duration_s": round(self.duration_s, 3),
            "elapsed_ms": self.elapsed_ms,
            "error": self.error,
            "hint": self.hint,
        }


@dataclass
class BatchOutcome:
    job_id: str
    results: List[BatchItemResult] = field(default_factory=list)
    total_duration_s: float = 0.0
    cancelled: bool = False
    zip_url: Optional[str] = None
    manifest_url: Optional[str] = None

    @property
    def succeeded(self) -> int:
        return sum(1 for item in self.results if item.ok)

    @property
    def failed(self) -> int:
        return sum(1 for item in self.results if not item.ok)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "total": len(self.results),
            "succeeded": self.succeeded,
            "failed": self.failed,
            "cancelled": self.cancelled,
            "total_duration_s": round(self.total_duration_s, 3),
            "zip_url": self.zip_url,
            "manifest_url": self.manifest_url,
            "results": [item.to_dict() for item in self.results],
        }


class BatchRunner:
    """批量合成编排器。"""

    def __init__(self, settings: Settings, engine: SynthesisEngine) -> None:
        self.settings = settings
        self.engine = engine

    # ------------------------------------------------------------------
    # 条目展开
    # ------------------------------------------------------------------

    def expand(self, payload: Dict[str, Any]) -> List[Dict[str, Any]]:
        """把请求展开成条目列表，并合并请求级默认值。"""
        raw_items = payload.get("items") or []
        inline_text = payload.get("text")

        items: List[Dict[str, Any]] = []
        if isinstance(inline_text, str) and inline_text.strip():
            # 整段文本：按非空行切分。空行是作者用来分隔段落的，不该变成一条音频。
            for line in inline_text.splitlines():
                stripped = line.strip()
                if stripped:
                    items.append({"text": stripped})
        for item in raw_items:
            if not isinstance(item, dict):
                continue
            text = str(item.get("text") or "").strip()
            if not text:
                continue
            items.append(dict(item))

        if not items:
            raise BadRequestError(
                "批量合成没有任何有效条目",
                hint="请在 items 中提供条目，或直接把文本放在 text 字段（按非空行切分）。",
                code="EMPTY_BATCH",
            )

        limit = min(self.settings.max_batch_items, catalog.MAX_BATCH_ITEMS)
        if len(items) > limit:
            raise BadRequestError(
                "条目数 %d 超过上限 %d" % (len(items), limit),
                hint="请拆成多批提交，或通过 MAX_BATCH_ITEMS 调整上限。",
                code="BATCH_TOO_LARGE",
            )

        defaults = {
            key: value
            for key, value in payload.items()
            if key not in {"items", "text"} and value is not None
        }

        merged: List[Dict[str, Any]] = []
        for index, item in enumerate(items):
            entry = dict(defaults)
            entry.update({key: value for key, value in item.items() if value is not None})
            entry["text"] = str(item.get("text") or entry.get("text") or "").strip()
            # 条目级 params 与请求级 params 合并，条目优先
            entry["params"] = _merge_dict(defaults.get("params"), item.get("params"))
            entry["_index"] = index
            merged.append(entry)
        return merged

    # ------------------------------------------------------------------
    # 执行
    # ------------------------------------------------------------------

    def run(
        self,
        payload: Dict[str, Any],
        job_id: str,
        workdir: Path,
        progress: Optional[ProgressCallback] = None,
        should_cancel: Optional[CancelCheck] = None,
        log: Optional[Callable[[str, str], None]] = None,
    ) -> BatchOutcome:
        entries = self.expand(payload)
        filename_template = str(payload.get("filename_template") or "{index:04d}")
        continue_on_error = payload.get("continue_on_error", True) is not False
        make_zip = payload.get("make_zip", True) is not False

        workdir.mkdir(parents=True, exist_ok=True)
        audio_dir = workdir / "audio"
        audio_dir.mkdir(parents=True, exist_ok=True)
        # 输出必须在 outputs/ 之下，这样静态文件服务才能把它们暴露出去
        prefix = _relative_prefix(self.settings.outputs_dir, audio_dir)

        outcome = BatchOutcome(job_id=job_id)
        total = len(entries)

        def emit(fraction: float, message: str) -> None:
            if progress:
                progress(max(0.0, min(1.0, fraction)), message)

        def note(message: str, level: str = "info") -> None:
            if log:
                log(message, level)

        note("共 %d 条待合成，单卡串行执行" % total)
        emit(0.0, "准备批量合成")

        started = time.monotonic()
        for position, entry in enumerate(entries):
            if should_cancel and should_cancel():
                outcome.cancelled = True
                note("收到取消请求，已停止派发后续条目", "warn")
                break

            index = int(entry.get("_index", position))
            text = entry["text"]
            base_fraction = position / float(total)

            def item_progress(fraction: float, message: str) -> None:
                emit(base_fraction + fraction / float(total), "[%d/%d] %s" % (position + 1, total, message))

            try:
                outcome_path = self.engine.synthesize_to_file(
                    entry,
                    filename=self._filename_for(filename_template, index, entry, prefix),
                    progress=item_progress,
                )
                result = _to_result(index, entry, outcome_path)
                outcome.results.append(result)
                outcome.total_duration_s += outcome_path.duration_s
                note(
                    "[%d/%d] 完成 %s（%.2fs，%.0fKB）"
                    % (position + 1, total, result.filename, result.duration_s, result.bytes / 1024),
                    "success",
                )
            except SovitsError as exc:
                result = BatchItemResult(
                    index=index,
                    key=entry.get("key"),
                    text=text[:200],
                    ok=False,
                    error=exc.message,
                    hint=exc.hint,
                )
                outcome.results.append(result)
                note("[%d/%d] 失败：%s" % (position + 1, total, exc.message), "error")
                if not continue_on_error:
                    note("已按 continue_on_error=false 中止整批", "warn")
                    break
            except Exception as exc:  # noqa: BLE001 - 单条意外不应终止整批
                result = BatchItemResult(
                    index=index,
                    key=entry.get("key"),
                    text=text[:200],
                    ok=False,
                    error="%s: %s" % (type(exc).__name__, exc),
                )
                outcome.results.append(result)
                note("[%d/%d] 异常：%s" % (position + 1, total, exc), "error")
                if not continue_on_error:
                    break

        emit(0.97, "正在生成清单与压缩包")
        manifest = self._write_manifest(workdir, outcome, entries)
        outcome.manifest_url = self.engine.url_for(manifest)
        if make_zip and outcome.succeeded:
            archive = self._write_zip(workdir, audio_dir, manifest)
            outcome.zip_url = self.engine.url_for(archive)
        emit(1.0, "批量合成结束")
        note(
            "结束：成功 %d 条 / 失败 %d 条，总时长 %.1fs，耗时 %.1fs"
            % (outcome.succeeded, outcome.failed, outcome.total_duration_s, time.monotonic() - started),
            "success" if outcome.failed == 0 else "warn",
        )
        return outcome

    # ------------------------------------------------------------------
    # 产物
    # ------------------------------------------------------------------

    def _filename_for(
        self, template: str, index: int, entry: Dict[str, Any], prefix: str
    ) -> str:
        """按模板生成「相对输出目录」的路径，交给引擎落盘。"""
        key = entry.get("key")
        try:
            stem = template.format(index=index, key=key or "", text=entry.get("text", "")[:20])
        except (KeyError, IndexError, ValueError):
            # 模板写错不该让整批失败
            stem = "%04d" % index
        stem = _sanitize(stem) or "%04d" % index
        return "%s/%s.wav" % (prefix, stem)

    def _write_manifest(self, workdir: Path, outcome: BatchOutcome, entries: List[Dict[str, Any]]) -> Path:
        payload = {
            "generated_at": int(time.time() * 1000),
            "engine": "GPT-SoVITS",
            "version": self.engine.pipeline.version,
            "gpt_model": self.engine.pipeline.state.gpt,
            "sovits_model": self.engine.pipeline.state.sovits,
            "total": len(outcome.results),
            "succeeded": outcome.succeeded,
            "failed": outcome.failed,
            "total_duration_s": round(outcome.total_duration_s, 3),
            "items": [item.to_dict() for item in outcome.results],
        }
        manifest = workdir / "manifest.json"
        manifest.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

        # 同时产出一份 CSV：做有声书/课件时，通常要拿它去对照 Excel
        csv_path = workdir / "index.csv"
        buffer = io.StringIO()
        writer = csv.writer(buffer)
        writer.writerow(["index", "key", "text", "filename", "duration_s", "bytes", "status", "error"])
        for item in outcome.results:
            writer.writerow(
                [
                    item.index,
                    item.key or "",
                    item.text,
                    item.filename or "",
                    "%.3f" % item.duration_s,
                    item.bytes,
                    "ok" if item.ok else "failed",
                    item.error or "",
                ]
            )
        # utf-8-sig：Excel 打开中文 CSV 不会乱码
        csv_path.write_text(buffer.getvalue(), encoding="utf-8-sig")
        return manifest

    def _write_zip(self, workdir: Path, audio_dir: Path, manifest: Path) -> Path:
        target = workdir / "batch.zip"
        with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
            for path in sorted(audio_dir.glob("*.wav")):
                archive.write(path, arcname="audio/%s" % path.name)
            archive.write(manifest, arcname="manifest.json")
            csv_path = workdir / "index.csv"
            if csv_path.is_file():
                archive.write(csv_path, arcname="index.csv")
        return target


# --------------------------------------------------------------------------


def _to_result(index: int, entry: Dict[str, Any], outcome: SynthOutcome) -> BatchItemResult:
    return BatchItemResult(
        index=index,
        key=entry.get("key"),
        text=outcome.text[:200],
        ok=True,
        filename=outcome.filename,
        audio_url=outcome.url,
        bytes=outcome.size_bytes,
        duration_s=outcome.duration_s,
        elapsed_ms=outcome.elapsed_ms,
        audio_path=str(outcome.path),
    )


def _merge_dict(base: Any, override: Any) -> Dict[str, Any]:
    merged: Dict[str, Any] = {}
    if isinstance(base, dict):
        merged.update(base)
    if isinstance(override, dict):
        merged.update(override)
    return merged


def _sanitize(value: str) -> str:
    cleaned = _INVALID_FILENAME.sub("_", value).strip(" .")
    # Windows 对超长文件名不友好，留出足够余量
    return cleaned[:80]


def _relative_prefix(outputs_dir: Path, target: Path) -> str:
    """把输出子目录转成相对 outputs/ 的 posix 前缀。"""
    try:
        return target.resolve().relative_to(outputs_dir.resolve()).as_posix()
    except ValueError:
        return "batch"

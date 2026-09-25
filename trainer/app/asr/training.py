"""ASR 训练入口：把一批音频变成一份「音频 + 逐字文本」的数据集。

先说清楚这个模块**是**什么、**不是**什么，因为「训练」两个字很容易被误解：

* 它**是** GPT-SoVITS / RVC 训练流水线里那个「ASR 阶段」的独立化与通用化版本：
  输入一批音频，输出逐字文本 + 官方格式清单（`路径|说话人|语种|文本`），
  产物可以直接被 `training.py`（GPT-SoVITS）或 `vc/training.py`（RVC）消费，
  也可以直接丢进既有的「标注校对」页面逐条改。
* 它**不是**给 ASR 模型本身做微调。上游（FunASR / faster-whisper）没有把微调
  做成稳定的 CLI，让一个本地工作台去对接各家的训练脚本只会带来版本地狱。
  真正需要时，扩展点就在本模块的 `run()` 里 —— 加一个阶段，不动其它任何文件。

为什么批量必须走任务而不是同步请求：ASR 是逐条串行的，几百条音频就是几十分钟。
同步等待会让浏览器、网关和用户的心智一起超时。所以它和训练一样走任务队列
（进度 / 日志 / 可取消），但仍然登记在**推理池**里 —— 它做的是推理，不是训练。

产物（落在 `trainer/.data/asr/datasets/<name>/`）：

    transcripts/<序号>_<音频名>.txt   逐字文本，一条一个文件
    dataset.list                      官方格式清单，可直接喂给训练流水线
    index.csv                         UTF-8 BOM 写出，Excel 直接打开不乱码
    manifest.json                     每条的状态 / 通道 / 耗时 / 失败原因
"""

from __future__ import annotations

import csv
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from ..annotations import AnnotationItem, write_list
from ..audio.io import AUDIO_SUFFIXES, AudioError, probe
from ..config import Settings
from ..errors import SovitsError
from .bootstrap import AsrError

__all__ = [
    "STAGES",
    "DatasetRequest",
    "collect",
    "dataset_dir",
    "list_datasets",
    "plan",
    "run",
]

ProgressFn = Callable[[float, str], None]
LogFn = Callable[[str], None]
CancelCheck = Callable[[], bool]

#: 「训练入口」的三个阶段，与前端进度条一一对应。
STAGES = ("collect", "transcribe", "export")

#: 清单里的默认说话人名（官方要求四个字段都在，缺一不可）。
DEFAULT_SPEAKER = "speaker0"


@dataclass
class DatasetRequest:
    """一次数据集构建请求。字段与前端表单一一对应。"""

    #: 数据集名，同时是落盘目录名
    name: str = "asr-dataset"
    #: 语料目录（本机路径）
    corpus_dir: str = ""
    #: 显式文件列表（上传产物或用户手挑的文件）
    files: List[str] = field(default_factory=list)
    #: 目录是否递归
    recursive: bool = True
    #: 说话人名，写进官方清单第二列
    speaker: str = DEFAULT_SPEAKER
    #: 参数（留空则用 `.env` 与场景预设的默认值）
    backend: str = ""
    size: str = ""
    language: str = ""
    precision: str = ""
    model: str = ""
    channel: str = ""
    #: 时长过滤：太短（爆音/静音）与太长（整段朗读）都不适合做训练语料
    min_duration: float = 0.5
    max_duration: float = 60.0
    #: 已有文本的音频直接跳过（重跑时最省时的一环）
    skip_existing: bool = True
    #: 是否复用转写缓存
    use_cache: bool = True
    #: 文本为空（模型认为无人声）是否也写进清单。默认不写 ——
    #: 空文本的训练条目没有意义，还会让训练脚本报错。
    keep_empty: bool = False
    #: 单次任务最多处理多少条（防止误选整个磁盘）
    limit: int = 500

    def to_dict(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "corpus_dir": self.corpus_dir,
            "files": list(self.files),
            "recursive": self.recursive,
            "speaker": self.speaker,
            "backend": self.backend,
            "size": self.size,
            "language": self.language,
            "precision": self.precision,
            "model": self.model,
            "channel": self.channel,
            "min_duration": self.min_duration,
            "max_duration": self.max_duration,
            "skip_existing": self.skip_existing,
            "use_cache": self.use_cache,
            "keep_empty": self.keep_empty,
            "limit": self.limit,
        }


# --------------------------------------------------------------------------
# 采集
# --------------------------------------------------------------------------


def _public_engine(resolved: Dict[str, Any]) -> Dict[str, Any]:
    """对外暴露时去掉内部字段。

    `key` 只服务于引擎内部「这次要不要重新加载模型」的判断，
    它既不是参数也不是结果，不该出现在接口返回里。
    """
    return {name: value for name, value in resolved.items() if name != "key"}


def dataset_dir(settings: Settings, name: str) -> Path:
    """数据集目录。名字做一次消毒，避免 `..` 之类跑出数据目录。"""
    safe = "".join(ch for ch in (name or "") if ch.isalnum() or ch in "-_")
    return settings.asr_dir / "datasets" / (safe or "asr-dataset")


def collect(settings: Settings, request: DatasetRequest) -> List[Path]:
    """把「目录 + 显式文件列表」摊平成一份待转写清单。

    刻意不做成生成器：条数决定要展示给用户的进度分母，也决定要不要拒绝，
    这些都需要先数清楚。
    """
    found: List[Path] = []

    for raw in request.files:
        path = Path(str(raw)).expanduser()
        if path.is_file() and path.suffix.lower() in AUDIO_SUFFIXES:
            found.append(path)

    raw_dir = (request.corpus_dir or "").strip()
    if raw_dir:
        root = Path(raw_dir).expanduser()
        if not root.exists():
            raise AsrError(
                "语料路径不存在：%s" % root,
                hint="填一个本机目录（例如 D:\\素材\\语料），或改用文件上传。",
                code="CORPUS_MISSING",
                status=400,
                retryable=False,
            )
        if root.is_file():
            if root.suffix.lower() in AUDIO_SUFFIXES:
                found.append(root)
        else:
            walker = root.rglob("*") if request.recursive else root.glob("*")
            for path in sorted(walker):
                if path.is_file() and path.suffix.lower() in AUDIO_SUFFIXES:
                    found.append(path)

    # 按绝对路径去重：同一个文件既在目录里又被显式列出是常态
    seen = set()
    unique: List[Path] = []
    for path in found:
        try:
            marker = str(path.resolve())
        except OSError:
            continue
        if marker in seen:
            continue
        seen.add(marker)
        unique.append(path)
    return unique


def list_datasets(settings: Settings) -> List[Dict[str, Any]]:
    """盘点已有数据集，供前端展示与复用。"""
    root = settings.asr_dir / "datasets"
    items: List[Dict[str, Any]] = []
    if not root.is_dir():
        return items
    for entry in sorted(p for p in root.iterdir() if p.is_dir()):
        manifest = entry / "manifest.json"
        summary: Dict[str, Any] = {"name": entry.name, "dir": str(entry), "exists": True}
        if manifest.is_file():
            try:
                data = json.loads(manifest.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                data = {}
            summary.update(
                {
                    "created_at": data.get("created_at"),
                    "total": data.get("total", 0),
                    "succeeded": data.get("succeeded", 0),
                    "empty": data.get("empty", 0),
                    "failed": data.get("failed", 0),
                    "backend": data.get("backend"),
                    "model": data.get("model"),
                    "channel": data.get("channel"),
                    "list": str(entry / "dataset.list"),
                    "csv": str(entry / "index.csv"),
                }
            )
        items.append(summary)
    return items


# --------------------------------------------------------------------------
# 预检
# --------------------------------------------------------------------------


def plan(engine: Any, request: DatasetRequest) -> Dict[str, Any]:
    """只算「会做什么、产出在哪」，不执行。与 vc / sovits 的预检同一套语义。"""
    settings = engine.settings

    #: 预检的意义是「在动手之前把问题摆出来」，所以**环境不可用也要给出计划** ——
    #: 这时候抛异常，用户只知道「503」，却不知道自己有多少条音频要转、产物落在哪，
    #: 也不知道该去装什么。把通道不可用的事实塞进 `error`，前端一并展示。
    try:
        resolved = engine.resolve(
            backend=request.backend,
            size=request.size,
            language=request.language,
            precision=request.precision,
            model=request.model,
            channel=request.channel,
        )
        resolve_error = ""
    except SovitsError as exc:
        resolved = {
            "channel": "none",
            "reason": exc.message,
            "backend": request.backend or "",
            "size": request.size or "",
            "language": request.language or "",
            "precision": request.precision or "",
            "model": "",
            "notes": [],
        }
        resolve_error = exc.message

    try:
        paths = collect(settings, request)
        collect_error = ""
    except AsrError as exc:
        paths = []
        collect_error = exc.message

    out = dataset_dir(settings, request.name)
    accepted, rejected = _split_by_duration(paths, request)

    return {
        "dataset_dir": str(out),
        "request": request.to_dict(),
        "engine": _public_engine(resolved),
        "stages": [
            {
                "key": "collect",
                "label": "采集待转写音频",
                "detail": "找到 %d 个音频（%.0f~%.0f 秒内 %d 个）"
                % (len(paths), request.min_duration, request.max_duration, len(accepted)),
                "command": "",
            },
            {
                "key": "transcribe",
                "label": "逐条转写为逐字文本",
                "detail": "通道 %s，模型 %s，语种 %s"
                % (resolved.get("channel"), resolved.get("model"), resolved.get("language")),
                "command": _describe_command(settings, resolved, request),
            },
            {
                "key": "export",
                "label": "导出数据集",
                "detail": "dataset.list / index.csv / manifest.json → %s" % out,
                "command": "",
            },
        ],
        "totals": {
            "found": len(paths),
            "accepted": len(accepted),
            "rejected": len(rejected),
            "truncated": max(0, len(accepted) - max(0, int(request.limit))),
        },
        "rejected_samples": [str(path) for path in rejected[:20]],
        "error": collect_error or resolve_error,
    }


def _split_by_duration(
    paths: List[Path], request: DatasetRequest
) -> Tuple[List[Path], List[Path]]:
    """按时长把音频分成「可转写」与「跳过」。

    为什么要过滤：训练语料里混进 0.2 秒的爆音或 3 分钟的整段朗读，
    对训练只有坏处；而且过长的文件会让 ASR 在静音段编出文本。
    """
    accepted: List[Path] = []
    rejected: List[Path] = []
    for path in paths:
        try:
            info = probe(path)
        except AudioError:
            rejected.append(path)
            continue
        if request.min_duration <= info.duration <= request.max_duration:
            accepted.append(path)
        else:
            rejected.append(path)
    return accepted, rejected


def _describe_command(settings: Settings, resolved: Dict[str, Any], request: DatasetRequest) -> str:
    """给用户看「实际会跑什么」。

    常驻通道没有命令可展示（模型常驻在服务进程里），如实说明；
    脚本通道则把子进程命令原样拼出来 —— 与 `training.py` 的预检风格一致。
    """
    if resolved.get("channel") == "resident":
        return "常驻通道：%s（%s），不启动任何子进程" % (resolved.get("backend"), resolved.get("model"))
    return (
        "脚本通道：python -s tools/asr/%s_asr.py -i <语料目录> -o %s -s %s -l %s -p %s"
        % (
            "funasr" if resolved.get("backend") == "funasr" else "fasterwhisper",
            dataset_dir(settings, request.name) / "script_out",
            resolved.get("size"),
            resolved.get("language"),
            resolved.get("precision"),
        )
    )


# --------------------------------------------------------------------------
# 执行
# --------------------------------------------------------------------------


def run(
    engine: Any,
    request: DatasetRequest,
    progress: Optional[ProgressFn] = None,
    log: Optional[LogFn] = None,
    cancelled: Optional[CancelCheck] = None,
) -> Dict[str, Any]:
    """执行一次「音频 → 文本数据集」。单条失败不中断整批。"""
    settings: Settings = engine.settings

    def report(fraction: float, message: str) -> None:
        if progress is not None:
            progress(fraction, message)

    def note(message: str) -> None:
        if log is not None:
            log(message)

    def stopped() -> bool:
        return bool(cancelled and cancelled())

    # ---- 1. 采集 ----
    report(0.0, "采集待转写音频…")
    paths = collect(settings, request)
    if not paths:
        raise AsrError(
            "没有找到任何音频",
            hint="确认目录里有 %s 格式的文件，或改用文件上传。" % "、".join(sorted(AUDIO_SUFFIXES)),
            code="NO_AUDIO",
            status=400,
            retryable=False,
        )
    accepted, rejected = _split_by_duration(paths, request)
    limit = max(0, int(request.limit))
    if limit and len(accepted) > limit:
        note("待转写 %d 条，超过单次上限 %d 条，只处理前 %d 条" % (len(accepted), limit, limit))
        accepted = accepted[:limit]
    if rejected:
        note("按时长过滤掉 %d 条（%.1f~%.1f 秒之外或无法解析）" % (len(rejected), request.min_duration, request.max_duration))
    if not accepted:
        raise AsrError(
            "所有音频都被时长过滤掉了",
            hint="把时长范围放宽（默认 %.1f~%.1f 秒），或换一批语料。" % (request.min_duration, request.max_duration),
            code="NO_AUDIO",
            status=400,
            retryable=False,
        )

    out = dataset_dir(settings, request.name)
    transcript_dir = out / "transcripts"
    transcript_dir.mkdir(parents=True, exist_ok=True)
    note("数据集目录：%s" % out)

    resolved = engine.resolve(
        backend=request.backend,
        size=request.size,
        language=request.language,
        precision=request.precision,
        model=request.model,
        channel=request.channel,
    )
    note("转写通道：%s（%s / %s）%s" % (resolved["channel"], resolved["backend"], resolved["model"], resolved["reason"]))
    for item in resolved["notes"]:
        note(item)

    # ---- 2. 逐条转写 ----
    total = len(accepted)
    records: List[Dict[str, Any]] = []
    for index, path in enumerate(accepted, start=1):
        if stopped():
            note("已取消：完成 %d/%d" % (index - 1, total))
            return {"cancelled": True, "dataset_dir": str(out), "total": total, "done": index - 1}

        stem = "".join(ch for ch in path.stem if ch.isalnum() or ch in "-_")[:40] or "clip"
        text_path = transcript_dir / ("%04d_%s.txt" % (index, stem))
        record: Dict[str, Any] = {
            "index": index,
            "audio": str(path),
            "speaker": request.speaker or DEFAULT_SPEAKER,
            "language": resolved["language"],
            "text": "",
            "text_path": str(text_path),
            "ok": True,
            "error": "",
            "cached": False,
            "channel": resolved["channel"],
            "elapsed_s": 0.0,
        }

        if request.skip_existing and text_path.is_file():
            existing = text_path.read_text(encoding="utf-8").strip()
            if existing:
                record.update({"text": existing, "cached": True, "note": "已有文本，跳过"})
                records.append(record)
                report(index / total, "已跳过 %d/%d（已有文本）" % (index, total))
                continue

        try:
            result = engine.transcribe(
                src=path,
                backend=request.backend,
                size=request.size,
                language=request.language,
                precision=request.precision,
                model=request.model,
                channel=request.channel,
                use_cache=request.use_cache,
            )
            record.update(
                {
                    "text": result.get("text", ""),
                    "cached": bool(result.get("cached")),
                    "channel": result.get("channel", resolved["channel"]),
                    "elapsed_s": result.get("elapsed_s", 0.0),
                    "language": result.get("language", resolved["language"]),
                }
            )
            if record["text"]:
                text_path.write_text(record["text"] + "\n", encoding="utf-8")
            else:
                #: 空文本**不是**错误：纯静音、纯音乐、语种与所选语言不符都会得到空串。
                #: 它与「转写失败」必须分开统计 —— 混在一起的话，用户看到「失败 3 条」
                #: 会以为服务坏了，而实际只是有 3 段没听出内容。
                record["note"] = "未识别到文本（可能是纯静音、纯音乐，或语种与所选语言不符）"
        except AsrError as exc:
            # 单条失败不影响整批：音频损坏、格式怪、模型偶发失败都会走到这里
            record.update({"ok": False, "error": exc.message, "hint": exc.hint or ""})
        except Exception as exc:  # noqa: BLE001
            record.update({"ok": False, "error": "未预期的失败：%s" % exc})

        records.append(record)
        report(index / total, "已转写 %d/%d" % (index, total))

    if stopped():
        note("已取消：转写完成但未导出")
        return {"cancelled": True, "dataset_dir": str(out), "total": total, "done": total}

    # ---- 3. 导出 ----
    report(0.95, "导出数据集…")
    summary = _export(out, records, request, resolved)
    summary["dataset_dir"] = str(out)
    summary["total"] = total
    summary["rejected"] = len(rejected)
    summary["items"] = records[:200]
    note(
        "完成：成功 %d 条、空文本 %d 条、失败 %d 条"
        % (summary["succeeded"], summary["empty"], summary["failed"])
    )
    report(1.0, "数据集已导出")
    return summary


def _export(
    out: Path,
    records: List[Dict[str, Any]],
    request: DatasetRequest,
    resolved: Dict[str, Any],
) -> Dict[str, Any]:
    """写清单三件套。清单复用 `annotations.write_list`，保证与校对链路同一套格式。"""
    # 空文本的条目默认不进清单：它对训练没有任何价值，还会让官方脚本报错。
    usable = list(records) if request.keep_empty else [item for item in records if item["text"]]

    items = [
        AnnotationItem(
            index=position,
            audio_path=item["audio"],
            speaker=item["speaker"] or DEFAULT_SPEAKER,
            language=item["language"] or resolved["language"],
            text=item["text"],
        )
        for position, item in enumerate(usable)
    ]
    list_path = write_list(out / "dataset.list", items)

    csv_path = out / "index.csv"
    with csv_path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["音频", "文本", "语种", "说话人", "通道", "耗时秒", "命中缓存", "状态", "说明"])
        for item in records:
            writer.writerow(
                [
                    item["audio"],
                    item["text"],
                    item["language"],
                    item["speaker"],
                    item["channel"],
                    item["elapsed_s"],
                    "是" if item["cached"] else "否",
                    "正常" if item["ok"] else "失败",
                    item.get("error") or item.get("note", ""),
                ]
            )

    succeeded = sum(1 for item in records if item["ok"] and item["text"])
    empty = sum(1 for item in records if item["ok"] and not item["text"])
    failed = sum(1 for item in records if not item["ok"])
    manifest = {
        "name": request.name,
        "created_at": _now_ms(),
        "request": request.to_dict(),
        "backend": resolved["backend"],
        "model": resolved["model"],
        "channel": resolved["channel"],
        "language": resolved["language"],
        "total": len(records),
        "succeeded": succeeded,
        "empty": empty,
        "failed": failed,
        "entries": len(items),
        "files": {
            "list": str(list_path),
            "csv": str(csv_path),
            "transcripts": str(out / "transcripts"),
        },
    }
    manifest_path = out / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return {
        "list": str(list_path),
        "csv": str(csv_path),
        "manifest": str(manifest_path),
        "succeeded": succeeded,
        "empty": empty,
        "failed": failed,
        "entries": len(items),
        "engine": _public_engine(resolved),
    }


def _now_ms() -> int:
    import time  # noqa: PLC0415

    return int(time.time() * 1000)

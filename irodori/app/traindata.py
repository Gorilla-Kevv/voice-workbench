"""训练数据整备（S1）+ latent 编码（S2）与 manifest 非空硬断言。

## 为什么整条链路都是自己写的

上游 `prepare_manifest.py` 在 Windows 上会 **16/16 静默跳过、退出码 0、产出 0 字节
manifest**（阶段 28 实测，对应上游 issue #40）：它走 `torchaudio.load → torchcodec`，
而 cu128 索引没有 Windows wheel。我们有 `windecode.py` 垫片能绕开它，但垫片是
**本进程的替换**，直接跑上游脚本还得操心它的 `sys.path` 与参数面 —— 不如自己调
`DACVAECodec.encode_file()`（阶段 28 已用这条路编出 16/16）。

## 守卫一：manifest 非空硬断言（★ 本阶段的验收核心）

「数据一条都没编码成功」必须是**显式失败**，不能是空文件 + 退出码 0。
上游那条雷能让人白跑一晚（训练跑完了才发现 manifest 是空的），所以这里：

- 编码循环里每条失败都**记账**（路径 + 原因），不吞异常；
- 循环结束后 `written == 0` 或 `written < 待编码条数` → 一律 `TRAIN_MANIFEST_EMPTY`(422)；
- 错误 `hint` 直接点名最常见的成因（Windows 音频解码不可用），并回显前几条失败明细。

## 关于「输入片段数」的口径

S1 阶段缺转写的片段会被**提前剔除**并记进 `missing_text`（而不是带进编码再失败）——
缺转写是数据问题，用户在 `/v1/train/plan` 就能看见并修好，不该混进「编码失败」。
所以硬断言比的是「**进入编码的条数**」，不是「扫描到的音频文件数」。
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable, Optional

from .config import Settings
from .errors import IrodoriError
from .synth import voicelib_file
from . import windecode

#: 与网关 `voiceLibrary.ts` 的 ALLOWED_SUFFIXES 对齐（少了 .aac/.wma：
#: soundfile 走 libsndfile，这两个格式支持不稳，不如早点报错让用户转格式）
AUDIO_SUFFIXES = {".wav", ".mp3", ".flac", ".ogg", ".m4a", ".webm"}
#: 逐条转写：与音频同名的 `.txt`（最省事的约定，官方示例数据集也是这个形态）
TEXT_SUFFIXES = {".txt"}
#: 批量清单：可选，jsonl 每行 `{"file": "001.wav", "text": "..."}`，
#: json 是同构数组。两者都只认 `file/path/audio` 三个键（哪个有值用哪个）
MANIFEST_META_NAME = "meta.json"
MANIFEST_NAME = "manifest.jsonl"

#: 单条片段的合理区间（秒）。超出只是**提示**，不是硬校验 ——
#: 官方建议「多段短句」，但用户手上的素材未必切好了，硬拒只会逼他先去切音频
CLIP_MIN_SECONDS = 1.0
CLIP_MAX_SECONDS = 30.0
#: 数据集规模的建议下限（条）。少于这个数 SI 训练容易过拟合到少数几句的韵律
RECOMMENDED_MIN_ITEMS = 10


# --------------------------------------------------------------------------
# 数据结构
# --------------------------------------------------------------------------


@dataclass
class DataItem:
    """一条待编码的训练样本。"""

    path: Path
    text: str
    caption: Optional[str] = None
    speaker_id: Optional[str] = None
    #: 来源标注（`voice_clip` / `upload` / `explicit`），只用于日志与回显
    source: str = ""
    duration_s: Optional[float] = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "path": str(self.path),
            "text": self.text,
            "caption": self.caption,
            "speaker_id": self.speaker_id,
            "source": self.source,
            "duration_s": self.duration_s,
        }


@dataclass
class Collection:
    """S1 的结果：能编码的条目 + 三类「为什么不能用」的诊断。"""

    items: list[DataItem] = field(default_factory=list)
    missing_text: list[dict[str, Any]] = field(default_factory=list)
    unreadable: list[dict[str, Any]] = field(default_factory=list)
    non_japanese: list[dict[str, Any]] = field(default_factory=list)
    #: 扫描到的音频文件总数（items + 被剔除的那些）
    scanned: int = 0

    @property
    def total_seconds(self) -> float:
        return round(sum(item.duration_s or 0.0 for item in self.items), 3)

    def to_dict(self) -> dict[str, Any]:
        return {
            "count": len(self.items),
            "scanned": self.scanned,
            "total_seconds": self.total_seconds,
            "missing_text": self.missing_text,
            "unreadable": self.unreadable,
            "non_japanese": self.non_japanese,
        }


@dataclass
class ManifestResult:
    """S2 的结果。字段与 `meta.json` 同形（前端直接读 meta，不用再解析 jsonl）。"""

    dataset_id: str
    manifest_path: str
    latent_dir: str
    written: int
    expected: int
    skipped_missing_text: int
    failed: list[dict[str, Any]]
    total_frames: int
    total_seconds: float
    elapsed_sec: float

    def to_dict(self) -> dict[str, Any]:
        return {
            "dataset_id": self.dataset_id,
            "manifest_path": self.manifest_path,
            "latent_dir": self.latent_dir,
            "written": self.written,
            "expected": self.expected,
            "skipped_missing_text": self.skipped_missing_text,
            "failed": self.failed,
            "total_frames": self.total_frames,
            "total_seconds": round(self.total_seconds, 3),
            "elapsed_sec": round(self.elapsed_sec, 3),
        }


# --------------------------------------------------------------------------
# 路径
# --------------------------------------------------------------------------


def dataset_dir(settings: Settings, dataset_id: str) -> Path:
    """`<data_dir>/datasets/<id>`：manifest.jsonl + latents/ + meta.json 都在这下面。"""
    return settings.datasets_dir / _safe_id(dataset_id)


def upload_dir(settings: Settings, dataset_id: str) -> Path:
    return settings.uploads_dir / _safe_id(dataset_id)


def _safe_id(dataset_id: str) -> str:
    """数据集 id 只允许「文件名安全」的字符。

    id 会直接拼进路径（`datasets/<id>/...`），而它可能来自前端表单 ——
    不做这道过滤，`../../` 就能把产物写到工作区外面去。
    """
    raw = (dataset_id or "").strip()
    # 先**显式拒绝**带分隔符/id 里带 `..` 的输入，而不是过滤掉就算了：
    # 过滤后放行会让用户以为自己传的 id 生效了，实际目录名已经变了（排查时很坑）。
    if any(separator in raw for separator in ("/", "\\", ":")) or ".." in raw:
        raise IrodoriError(
            "DATASET_ID_INVALID",
            f"数据集 id 不能包含路径分隔符或 `..`：{dataset_id!r}",
            "只用字母、数字、连字符与下划线（它会进目录名）。",
        )
    kept = "".join(ch for ch in raw if ch.isalnum() or ch in "-_")
    if not kept:
        raise IrodoriError(
            "DATASET_ID_INVALID",
            f"数据集 id 不合法：{dataset_id!r}",
            "只用字母、数字、连字符与下划线（它会进目录名）。",
        )
    return kept


def new_dataset_id() -> str:
    import uuid

    return uuid.uuid4().hex[:12]


# --------------------------------------------------------------------------
# S1：数据整备
# --------------------------------------------------------------------------


def _read_text_file(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8").strip()
    except UnicodeDecodeError:
        # 用户手写的 txt 很可能是 GBK（Windows 记事本默认）
        return path.read_text(encoding="gbk", errors="replace").strip()
    except OSError:
        return ""


def probe_duration(path: Path) -> float:
    """读音频时长（秒）。读不出来抛 `REF_UNREADABLE` —— 与合成侧同一错误码。"""
    try:
        import soundfile as sf  # noqa: PLC0415
    except ImportError as error:  # pragma: no cover
        raise IrodoriError(
            "ENV_BROKEN", "soundfile 不可用，无法读取音频", "重装 venv：pip install soundfile。"
        ) from error
    try:
        return float(sf.info(str(path)).duration)
    except Exception as error:
        raise IrodoriError(
            "REF_UNREADABLE",
            f"音频读不出来：{path.name}（{error}）",
            "换成 wav/mp3/flac 等常见格式（ffmpeg 转一遍即可）。",
        ) from error


def _has_kana(text: str) -> bool:
    """至少有一个假名才算日语文本（与 synth 的 NO_JA_ONLY 判据同源）。"""
    import re

    return bool(re.search(r"[\u3040-\u309f\u30a0-\u30ff\u31f0-\u31ff\uff66-\uff9f]", text))


def collect_from_voice(
    settings: Settings,
    voice_id: str,
    *,
    speaker_id: Optional[str] = None,
    caption: Optional[str] = None,
) -> Collection:
    """音色库 → 训练样本。**长参考多片段优先**，没有才回落主音频（30-4 的回落链）。

    转写来源：片段自带的 `text`；回落到主音频时用音色的 `prompt_text`。
    """
    path = voicelib_file(settings)
    try:
        records = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise IrodoriError(
            "VOICE_NOT_FOUND",
            f"音色库不存在或为空：{path}",
            "先在「音色库」页导入音色；或改用 dataset_id / items 直接给音频。",
        ) from error
    except (json.JSONDecodeError, OSError) as error:
        raise IrodoriError("VOICE_LIB_BROKEN", f"音色库读不出来：{error}",
                           "检查 voicelib/voices.json 是否损坏。") from error
    if not isinstance(records, list):
        raise IrodoriError("VOICE_LIB_BROKEN", "音色库格式不对（应为数组）", "检查 voicelib/voices.json。")

    record = next(
        (item for item in records if isinstance(item, dict) and item.get("id") == voice_id), None
    )
    if record is None:
        raise IrodoriError(
            "VOICE_NOT_FOUND",
            f"音色库中没有 id 为 {voice_id!r} 的音色（共 {len(records)} 条）",
            "到「音色库」页核对音色 id。",
        )

    collection = Collection()
    effective_speaker = speaker_id or str(record.get("name") or voice_id)

    raw_clips = record.get("ref_clips")
    clips = [item for item in (raw_clips if isinstance(raw_clips, list) else [])
             if isinstance(item, dict) and item.get("path")]
    if clips:
        for clip in clips:
            path = Path(str(clip["path"]))
            collection.scanned += 1
            if not path.is_file():
                collection.unreadable.append({"path": str(path), "reason": "文件不存在"})
                continue
            text = str(clip.get("text") or "").strip()
            if not text:
                collection.missing_text.append({"path": str(path), "reason": "片段没有转写"})
                continue
            collection.items.append(
                DataItem(
                    path=path,
                    text=text,
                    caption=caption,
                    speaker_id=effective_speaker,
                    source="voice_clip",
                    duration_s=_safe_duration(path),
                )
            )
        return collection

    audio = str(record.get("audio_path") or "")
    if not audio:
        raise IrodoriError(
            "TRAIN_NO_DATA",
            f"音色 {voice_id!r} 既没有长参考片段也没有主音频",
            "在音色库里给它补上「日语长参考」片段（SI 训练要逐条转写，单条也行）。",
            status=422,
        )
    path = Path(audio)
    collection.scanned += 1
    if not path.is_file():
        raise IrodoriError("REF_NOT_FOUND", f"音色的主音频不存在：{path}",
                           "到音色库重新导入该音色。")
    text = str(record.get("prompt_text") or "").strip()
    if not text:
        collection.missing_text.append({"path": str(path), "reason": "音色没有填 prompt_text"})
        return collection
    collection.items.append(
        DataItem(
            path=path,
            text=text,
            caption=caption,
            speaker_id=effective_speaker,
            source="voice_audio",
            duration_s=_safe_duration(path),
        )
    )
    return collection


def _safe_duration(path: Path) -> Optional[float]:
    """时长只是统计/提示用，读不出来不该让整条数据报废 —— 所以失败返回 None。"""
    try:
        return probe_duration(path)
    except IrodoriError:
        return None


def _load_sidecar_map(directory: Path) -> dict[str, dict[str, str]]:
    """读可选的 `metadata.jsonl` / `metadata.json`（键是文件名小写）。"""
    for name in ("metadata.jsonl", "metadata.json"):
        target = directory / name
        if not target.is_file():
            continue
        mapping: dict[str, dict[str, str]] = {}
        try:
            if name.endswith("jsonl"):
                rows = [
                    json.loads(line)
                    for line in target.read_text(encoding="utf-8").splitlines()
                    if line.strip()
                ]
            else:
                parsed = json.loads(target.read_text(encoding="utf-8"))
                rows = parsed if isinstance(parsed, list) else [parsed]
        except (OSError, json.JSONDecodeError) as error:
            raise IrodoriError(
                "METADATA_BROKEN",
                f"{name} 解析失败：{error}",
                "清单每行形如 {\"file\": \"001.wav\", \"text\": \"…\"}；删掉它也能退回同名 .txt。",
            ) from error
        for row in rows:
            if not isinstance(row, dict):
                continue
            key = str(row.get("file") or row.get("path") or row.get("audio") or "").strip()
            if not key:
                continue
            mapping[Path(key).name.lower()] = {
                "text": str(row.get("text") or "").strip(),
                "caption": str(row.get("caption") or "").strip() or None,
            }
        return mapping
    return {}


def collect_from_dataset(
    settings: Settings,
    dataset_id: str,
    *,
    speaker_id: Optional[str] = None,
    caption: Optional[str] = None,
) -> Collection:
    """已上传目录 → 训练样本。

    转写来源优先级：① `metadata.jsonl/.json` ② 同名 `.txt`。
    两者都没有 → 记进 `missing_text`（用户照着列表补 txt 即可）。
    """
    directory = upload_dir(settings, dataset_id)
    if not directory.is_dir():
        raise IrodoriError(
            "DATASET_NOT_FOUND",
            f"数据集目录不存在：{directory}",
            "先 POST /v1/train/upload 上传音频与同名 .txt，或改用 voice_id / items。",
        )
    sidecar = _load_sidecar_map(directory)
    collection = Collection()
    files = sorted(
        (path for path in directory.rglob("*") if path.is_file() and path.suffix.lower() in AUDIO_SUFFIXES),
        key=lambda path: str(path).lower(),
    )
    for path in files:
        collection.scanned += 1
        entry = sidecar.get(path.name.lower())
        text = (entry or {}).get("text") or ""
        if not text:
            sibling = path.with_suffix(".txt")
            if sibling.is_file():
                text = _read_text_file(sibling)
        if not text:
            collection.missing_text.append({"path": str(path), "reason": "缺少转写（同名 .txt 或 metadata）"})
            continue
        row_caption = caption or (entry or {}).get("caption")
        collection.items.append(
            DataItem(
                path=path,
                text=text,
                caption=row_caption,
                speaker_id=speaker_id,
                source="upload",
                duration_s=_safe_duration(path),
            )
        )
    return collection


def collect_from_items(
    raw_items: Any,
    *,
    speaker_id: Optional[str] = None,
    caption: Optional[str] = None,
) -> Collection:
    """显式列表 → 训练样本（`[{"path": "...", "text": "...", "caption": "..."}]`）。"""
    if not isinstance(raw_items, list) or not raw_items:
        raise IrodoriError(
            "TRAIN_NO_SOURCE",
            "items 必须是非空数组",
            "每项形如 {\"path\": \"绝对路径.wav\", \"text\": \"日本語の転写\"}。",
        )
    collection = Collection()
    for raw in raw_items:
        if not isinstance(raw, dict):
            continue
        collection.scanned += 1
        raw_path = str(raw.get("path") or "").strip()
        if not raw_path:
            collection.missing_text.append({"path": "", "reason": "缺少 path"})
            continue
        path = Path(raw_path)
        if not path.is_file():
            collection.unreadable.append({"path": raw_path, "reason": "文件不存在"})
            continue
        text = str(raw.get("text") or "").strip()
        if not text:
            collection.missing_text.append({"path": raw_path, "reason": "缺少转写"})
            continue
        collection.items.append(
            DataItem(
                path=path,
                text=text,
                caption=str(raw.get("caption") or "").strip() or caption,
                speaker_id=speaker_id,
                source="explicit",
                duration_s=_safe_duration(path),
            )
        )
    return collection


def collect(settings: Settings, request: dict[str, Any]) -> Collection:
    """按请求里的**唯一**数据来源整备样本。

    三个来源互斥（voice_id / dataset_id / items）：同时给多个，用户自己也说不清
    训练集里到底混了谁的音频，而 SI 训练的前提就是「**同一个说话人**」。
    """
    speaker_id = _optional_str(request.get("speaker_id"))
    caption = _optional_str(request.get("caption"))
    voice_id = _optional_str(request.get("voice_id"))
    dataset_id = _optional_str(request.get("dataset_id"))
    items = request.get("items")

    given = [name for name, value in
             (("voice_id", voice_id), ("dataset_id", dataset_id), ("items", items)) if value]
    if len(given) > 1:
        raise IrodoriError(
            "TRAIN_MULTI_SOURCE",
            f"数据来源给了多个（{'、'.join(given)}），SI 训练要求同一个说话人",
            "只保留一个来源：voice_id（音色库）/ dataset_id（已上传）/ items（显式列表）。",
        )
    if voice_id:
        return collect_from_voice(settings, voice_id, speaker_id=speaker_id, caption=caption)
    if dataset_id:
        return collect_from_dataset(settings, dataset_id, speaker_id=speaker_id, caption=caption)
    if items:
        return collect_from_items(items, speaker_id=speaker_id, caption=caption)
    raise IrodoriError(
        "TRAIN_NO_SOURCE",
        "没有指定数据来源",
        "给 voice_id（音色库长参考）/ dataset_id（上传目录）/ items（显式列表）之一。",
    )


def _optional_str(value: Any) -> Optional[str]:
    text = str(value or "").strip()
    return text or None


def review(collection: Collection) -> list[str]:
    """给 `/v1/train/plan` 用的人话提示（照官方建议写，不夸大）。"""
    tips: list[str] = []
    if len(collection.items) < RECOMMENDED_MIN_ITEMS:
        tips.append(
            f"只有 {len(collection.items)} 条样本，官方建议多段短句（≥{RECOMMENDED_MIN_ITEMS} 条）"
            "效果更稳；条数太少容易把韵律一起固化进去。"
        )
    long_clips = [item for item in collection.items
                  if (item.duration_s or 0) > CLIP_MAX_SECONDS]
    if long_clips:
        tips.append(
            f"有 {len(long_clips)} 条超过 {CLIP_MAX_SECONDS:.0f}s：单条长录音里的停顿与语气漂移"
            "会污染 speaker embedding，建议切成短句。"
        )
    short_clips = [item for item in collection.items
                   if item.duration_s is not None and item.duration_s < CLIP_MIN_SECONDS]
    if short_clips:
        tips.append(f"有 {len(short_clips)} 条不足 {CLIP_MIN_SECONDS:.0f}s，信息量太少，建议换更完整的句子。")
    no_kana = [item for item in collection.items if not _has_kana(item.text)]
    if no_kana:
        tips.append(
            f"有 {len(no_kana)} 条转写里没有假名（可能是中文/英文）：Irodori 是日语特化模型，"
            "非日语文本训出来的 embedding 不能用于日语合成。"
        )
    if collection.missing_text:
        tips.append(f"有 {len(collection.missing_text)} 个音频缺转写，它们会被跳过（不进训练集）。")
    return tips


# --------------------------------------------------------------------------
# S2：latent 编码 + 硬断言
# --------------------------------------------------------------------------


def _load_codec(settings: Settings):
    """加载 DACVAE codec（官方 `DACVAECodec`，上游代码零改动）。

    刻意**不复用**推理 runtime 里的 codec：整备阶段会把 TTS 模型卸载（见
    `routers/train.py`），那时 runtime 已经没了，而编码只需要 codec 这一半。
    """
    from .hardware import resolve_device  # noqa: PLC0415

    # ★ 自己的一条入口，就得自己把 sys.path 挂好（坑 67 的同款教训）：
    # 整备常常跑在一个从未 warmup 过的新起服务上，那时 `engine.load()` 还没被调用过，
    # 指望它顺手注入路径会让 S2 直接以 ImportError 失败（30-6 真机冒烟实测）。
    from .engine import ensure_upstream_on_path  # noqa: PLC0415 - 惰性，避免 import 环

    ensure_upstream_on_path(settings)
    device = resolve_device(settings.device, allow_cpu=settings.allow_cpu)
    try:
        from irodori_tts.codec import DACVAECodec  # noqa: PLC0415
    except ImportError as error:
        raise IrodoriError(
            "UPSTREAM_MISSING",
            f"上游代码不可用：{error}",
            "先跑 npm run irodori:check 确认 irodori/upstream/Irodori-TTS 已就位。",
            status=503,
            retryable=True,
        ) from error
    try:
        # repo_id 传本地路径：codec.py:70 会在路径存在时直接用，不走 HF
        return DACVAECodec.load(repo_id=str(settings.codec_weights), device=device)
    except Exception as error:
        raise IrodoriError(
            "CODEC_LOAD_FAILED",
            f"DACVAE codec 加载失败：{type(error).__name__}: {error}",
            "确认 models/dacvae/weights.pth 已下载且完整（npm run irodori:check 会逐字节校验）。",
            status=503,
            retryable=True,
        ) from error


def encode_manifest(
    settings: Settings,
    dataset_id: str,
    collection: Collection,
    *,
    speaker_id: Optional[str] = None,
    on_progress: Optional[Callable[[int, int, str], None]] = None,
    is_cancelled: Optional[Callable[[], bool]] = None,
) -> ManifestResult:
    """把 S1 的样本编成 latent 并写 `manifest.jsonl`。

    返回的 `ManifestResult.written` **一定等于**进入编码的条数 —— 不等于就直接抛
    `TRAIN_MANIFEST_EMPTY`，绝不写半份 manifest 当成功（守卫一，见文件头）。

    `on_progress(done, total, message)` 与 `is_cancelled()` 给 JobStore 用：
    取消检查放在**片段之间**（单条编码只有几秒，没必要中途打断）。
    """
    items = list(collection.items)
    if not items:
        raise IrodoriError(
            "TRAIN_NO_DATA",
            "没有可编码的样本：全部缺转写或音频不可读",
            "照 /v1/train/plan 的 missing_text 列表补齐转写（同名 .txt）后重试。",
            status=422,
        )

    target = dataset_dir(settings, dataset_id)
    latent_dir = target / "latents"
    latent_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = target / MANIFEST_NAME

    started = time.perf_counter()
    # ★ 垫片在这里**再装一次**（幂等）：create_app 里装过一次，但整备也可能被脚本 /
    # 单测直接调用（我们的验证脚本就是）。少了它，torchaudio.load 会走 torchcodec
    # → Windows 上 ImportError → 全部条目失败 → 守卫一报警。宁可多装一次。
    windecode.install()
    codec = _load_codec(settings)
    import torch  # noqa: PLC0415

    written = 0
    failed: list[dict[str, Any]] = []
    total_frames = 0
    total_seconds = 0.0

    # 先写临时文件：中途失败时不会留下「看起来能用」的半份 manifest
    tmp_path = manifest_path.with_suffix(".jsonl.part")
    with tmp_path.open("w", encoding="utf-8") as handle:
        for index, item in enumerate(items, start=1):
            if is_cancelled is not None and is_cancelled():
                handle.close()
                tmp_path.unlink(missing_ok=True)
                raise IrodoriError(
                    "JOB_CANCELLED",
                    f"已取消：编到第 {written}/{len(items)} 条时停止",
                    "重新发起整备即可（已写入的 latent 不会复用，会整份重来）。",
                    status=409,
                )
            try:
                latent = codec.encode_file(item.path)
            except Exception as error:
                failed.append({
                    "path": str(item.path),
                    "reason": f"{type(error).__name__}: {error}",
                })
                if on_progress is not None:
                    on_progress(index, len(items), f"第 {index}/{len(items)} 条编码失败")
                continue

            tensor = latent
            if tensor.ndim == 3 and tensor.shape[0] == 1:
                tensor = tensor[0]
            tensor = tensor.detach().to("cpu").contiguous()
            latent_file = latent_dir / f"{written:08d}.pt"
            torch.save(tensor, latent_file)

            payload: dict[str, Any] = {
                "text": item.text,
                # 相对 manifest 所在目录：dataset.py:202 按这个口径解析
                "latent_path": os.path.relpath(latent_file, start=manifest_path.parent),
                "num_frames": int(tensor.shape[0]),
            }
            if item.caption:
                payload["caption"] = item.caption
            if item.speaker_id or speaker_id:
                payload["speaker_id"] = item.speaker_id or speaker_id
            handle.write(json.dumps(payload, ensure_ascii=False) + "\n")
            written += 1
            total_frames += int(tensor.shape[0])
            total_seconds += float(item.duration_s or 0.0)
            if on_progress is not None:
                on_progress(index, len(items), f"已编码 {written}/{len(items)} 条")

    # ---- 守卫一：非空硬断言（★）----
    if written == 0 or written < len(items):
        tmp_path.unlink(missing_ok=True)
        reason = (
            "一条都没编码成功（多半是 Windows 音频解码不可用）"
            if written == 0
            else f"只编码成功 {written}/{len(items)} 条"
        )
        raise IrodoriError(
            "TRAIN_MANIFEST_EMPTY",
            f"数据整备失败：{reason}，训练不会开始",
            (
                "先看是不是音频解码问题：确认 irodori 的 soundfile 可用（/health 的 windecode.installed）。"
                "失败明细见 details.failed（最多列 5 条），把对应音频换成 wav 再试。"
                if written == 0
                else "失败的条目已在 details.failed 列出；不能只训一部分 —— SI 要的是同一个说话人的完整分布。"
            ),
            status=422,
            details={
                "written": written,
                "expected": len(items),
                "dataset_id": dataset_id,
                "failed": failed[:5],
                "failed_count": len(failed),
            },
        )

    tmp_path.replace(manifest_path)
    result = ManifestResult(
        dataset_id=_safe_id(dataset_id),
        manifest_path=str(manifest_path),
        latent_dir=str(latent_dir),
        written=written,
        expected=len(items),
        skipped_missing_text=len(collection.missing_text),
        failed=failed,
        total_frames=total_frames,
        total_seconds=total_seconds,
        elapsed_sec=time.perf_counter() - started,
    )
    (target / MANIFEST_META_NAME).write_text(
        json.dumps(
            {
                **result.to_dict(),
                "created_at": int(time.time() * 1000),
                "latent_dim": int(getattr(codec, "latent_dim", 0) or 0),
                "sample_rate": int(getattr(codec, "sample_rate", 0) or 0),
                "items": [item.to_dict() for item in items],
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    return result


def list_datasets(settings: Settings) -> list[dict[str, Any]]:
    """已整备好的数据集（按 meta.json，读不出来就退回 manifest 行数）。"""
    root = settings.datasets_dir
    if not root.is_dir():
        return []
    out: list[dict[str, Any]] = []
    for directory in sorted(root.iterdir(), key=lambda path: path.name):
        manifest = directory / MANIFEST_NAME
        if not manifest.is_file():
            continue
        meta_path = directory / MANIFEST_META_NAME
        entry: dict[str, Any] = {"dataset_id": directory.name, "manifest_path": str(manifest)}
        if meta_path.is_file():
            try:
                entry.update(json.loads(meta_path.read_text(encoding="utf-8")))
                entry.pop("items", None)
            except (OSError, json.JSONDecodeError):
                pass
        else:
            try:
                entry["written"] = sum(
                    1 for line in manifest.read_text(encoding="utf-8").splitlines() if line.strip()
                )
            except OSError:
                entry["written"] = 0
        out.append(entry)
    return out


def iter_manifest_rows(path: Path) -> Iterable[dict[str, Any]]:
    """读 manifest.jsonl（给 30-6 的训练编排与自检用）。坏行跳过并计数由调用方处理。"""
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                yield json.loads(line)

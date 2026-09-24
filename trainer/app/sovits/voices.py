"""音色库。

GPT-SoVITS 与「预置音色」型 TTS 最大的不同：**它没有任何内置音色**。
零样本克隆的输入是一段 3~10 秒的参考音频 + 这段音频的逐字转写文本，
两者共同构成「音色」。所以一个可用的系统必须先把这件事产品化 ——
这就是音色库存在的理由：

1. 把参考音频与提示文本绑定成一个有名字、有备注的实体；
2. 反复合成时不必每次重新上传（本地场景里这是最烦人的一步）；
3. 让批量合成可以「一次选音色，跑几百条文本」。

数据落盘为 `<数据目录>/voices.json` + `<数据目录>/voices/<id>.<ext>`，
不引入数据库，便于直接拷贝和备份。
"""

from __future__ import annotations

import json
import shutil
import threading
import time
import uuid
import wave
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from ..errors import BadRequestError, NotFoundError
from . import catalog

#: 兜底语种。空值、非法值一律回落到它。
DEFAULT_PROMPT_LANG = "zh"


def normalize_prompt_lang(value: Optional[str]) -> str:
    """把外部传入的参考音频语种收敛成合法值。

    以前写入端只写 `prompt_lang or "zh"` —— 而 `"undefined"` 是**真值**，
    于是前端把未填的字段塞进 `FormData` 时（它会把 `undefined` 转成字符串），
    字面量 `"undefined"` 就直接进了音色库，之后每次合成都报
    「不支持合成语种 undefined」，用户对着报错完全无从下手。

    写入端（create / update / copy_into_library）与读取端（_load）都要过这一层：
    后者能让**已经存在的脏数据**在下次启动时自动修好，不需要用户重新上传。
    """
    code = (value or "").strip().lower()
    if catalog.is_supported_language(code):
        return code
    return DEFAULT_PROMPT_LANG

ALLOWED_SUFFIXES = {".wav", ".mp3", ".flac", ".ogg", ".m4a", ".webm", ".aac", ".wma"}
MAX_UPLOAD_BYTES = 64 * 1024 * 1024


@dataclass
class Voice:
    """一条音色记录。"""

    id: str
    name: str
    #: 音频文件绝对路径
    audio_path: str
    prompt_text: str
    prompt_lang: str
    note: str = ""
    tags: List[str] = field(default_factory=list)
    #: "managed"（上传/录制后由本服务托管）| "external"（引用磁盘上已有文件）
    origin: str = "managed"
    duration_s: Optional[float] = None
    sample_rate: Optional[int] = None
    size_bytes: int = 0
    created_at: float = 0.0
    updated_at: float = 0.0

    def to_dict(self) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "id": self.id,
            "name": self.name,
            "audio_path": self.audio_path,
            "prompt_text": self.prompt_text,
            "prompt_lang": self.prompt_lang,
            "note": self.note,
            "tags": list(self.tags),
            "origin": self.origin,
            "duration_s": round(self.duration_s, 2) if self.duration_s else None,
            "sample_rate": self.sample_rate,
            "size_bytes": self.size_bytes,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "exists": Path(self.audio_path).is_file(),
        }
        payload["warnings"] = self.warnings()
        return payload

    def warnings(self) -> List[str]:
        """把「会导致合成失败」的前置条件提前说清楚。

        官方在 `_set_prompt_semantic` 里硬性要求 3~10 秒，超出会直接抛
        `参考音频在3~10秒范围外，请更换！`。与其等用户踩到，不如现在提示。
        """
        issues: List[str] = []
        if not Path(self.audio_path).is_file():
            issues.append("音频文件已不存在，请重新上传或修正路径")
            return issues
        if not self.prompt_text.strip():
            issues.append("缺少参考文本：v3/v4 模型会直接报错，其余版本音色相似度也会明显下降")
        if self.duration_s is not None:
            if self.duration_s < catalog.REF_AUDIO_MIN_SEC:
                issues.append(
                    "时长 %.1f 秒，短于官方要求的 %.0f 秒" % (self.duration_s, catalog.REF_AUDIO_MIN_SEC)
                )
            elif self.duration_s > catalog.REF_AUDIO_MAX_SEC:
                issues.append(
                    "时长 %.1f 秒，长于官方要求的 %.0f 秒，请裁剪后再用"
                    % (self.duration_s, catalog.REF_AUDIO_MAX_SEC)
                )
        return issues

    def is_usable(self) -> bool:
        return Path(self.audio_path).is_file()


class VoiceLibrary:
    """音色库的读写入口。线程安全。"""

    def __init__(self, data_dir: Path) -> None:
        self._data_dir = data_dir
        self._audio_dir = data_dir / "voices"
        self._index_path = data_dir / "voices.json"
        self._lock = threading.RLock()
        self._items: Dict[str, Voice] = {}
        self._audio_dir.mkdir(parents=True, exist_ok=True)
        self._load()

    # ------------------------------------------------------------------
    # 查询
    # ------------------------------------------------------------------

    @property
    def data_dir(self) -> Path:
        return self._data_dir

    @property
    def audio_dir(self) -> Path:
        return self._audio_dir

    def list(self) -> List[Voice]:
        with self._lock:
            items = list(self._items.values())
        items.sort(key=lambda voice: voice.updated_at or voice.created_at, reverse=True)
        return items

    def get(self, voice_id: str) -> Voice:
        with self._lock:
            voice = self._items.get(voice_id)
        if voice is None:
            raise NotFoundError("音色不存在：%s" % voice_id, hint="它可能已被删除，请刷新列表。")
        return voice

    def resolve(self, raw: Optional[str]) -> Optional[Voice]:
        """把「音色 ID」解析为记录；解析不到返回 None（由调用方决定是否报错）。"""
        if not raw:
            return None
        with self._lock:
            return self._items.get(raw)

    def find_by_name(self, name: str) -> Optional[Voice]:
        with self._lock:
            for voice in self._items.values():
                if voice.name == name:
                    return voice
        return None

    # ------------------------------------------------------------------
    # 变更
    # ------------------------------------------------------------------

    def create(
        self,
        name: str,
        prompt_text: str,
        prompt_lang: str,
        content: Optional[bytes] = None,
        filename: Optional[str] = None,
        external_path: Optional[str] = None,
        note: str = "",
        tags: Optional[List[str]] = None,
    ) -> Voice:
        """新增音色。`content` 走托管存储，`external_path` 引用磁盘已有文件。"""
        name = (name or "").strip()
        if not name:
            raise BadRequestError("音色名称不能为空")
        if content is None and not external_path:
            raise BadRequestError("必须提供音频内容或外部音频路径")

        audio_path: Path
        origin: str
        if content is not None:
            suffix = Path(filename or "audio.wav").suffix.lower() or ".wav"
            if suffix not in ALLOWED_SUFFIXES:
                raise BadRequestError(
                    "不支持的音频格式：%s" % suffix,
                    hint="可用格式：%s" % "、".join(sorted(ALLOWED_SUFFIXES)),
                )
            if len(content) > MAX_UPLOAD_BYTES:
                raise BadRequestError(
                    "音频文件过大（%.1f MB），上限 %d MB"
                    % (len(content) / 1024 / 1024, MAX_UPLOAD_BYTES // 1024 // 1024)
                )
            if not content:
                raise BadRequestError("上传的音频内容为空")
            voice_id = uuid.uuid4().hex[:12]
            audio_path = self._audio_dir / ("%s%s" % (voice_id, suffix))
            audio_path.write_bytes(content)
            origin = "managed"
        else:
            source = Path(str(external_path)).expanduser()
            if not source.is_absolute():
                from . import bootstrap

                source = (bootstrap.require().home / source).resolve()
            if not source.is_file():
                raise BadRequestError("指定的音频文件不存在：%s" % source)
            voice_id = uuid.uuid4().hex[:12]
            audio_path = source
            origin = "external"

        duration, sample_rate = probe_audio(audio_path)
        now = time.time()
        voice = Voice(
            id=voice_id,
            name=name,
            audio_path=str(audio_path),
            prompt_text=(prompt_text or "").strip(),
            prompt_lang=normalize_prompt_lang(prompt_lang),
            note=note,
            tags=list(tags or []),
            origin=origin,
            duration_s=duration,
            sample_rate=sample_rate,
            size_bytes=audio_path.stat().st_size if audio_path.is_file() else 0,
            created_at=now,
            updated_at=now,
        )
        with self._lock:
            self._items[voice.id] = voice
            self._persist()
        return voice

    def update(
        self,
        voice_id: str,
        name: Optional[str] = None,
        prompt_text: Optional[str] = None,
        prompt_lang: Optional[str] = None,
        note: Optional[str] = None,
        tags: Optional[List[str]] = None,
        audio_path: Optional[str] = None,
    ) -> Voice:
        voice = self.get(voice_id)
        with self._lock:
            if name is not None and name.strip():
                voice.name = name.strip()
            if prompt_text is not None:
                voice.prompt_text = prompt_text.strip()
            if prompt_lang is not None:
                voice.prompt_lang = normalize_prompt_lang(prompt_lang)
            if note is not None:
                voice.note = note
            if tags is not None:
                voice.tags = list(tags)
            if audio_path is not None:
                candidate = Path(audio_path).expanduser()
                if not candidate.is_file():
                    raise BadRequestError("指定的音频文件不存在：%s" % candidate)
                voice.audio_path = str(candidate)
                voice.duration_s, voice.sample_rate = probe_audio(candidate)
                voice.size_bytes = candidate.stat().st_size
            voice.updated_at = time.time()
            self._persist()
        return voice

    def replace_audio(self, voice_id: str, content: bytes, filename: str) -> Voice:
        """替换音色音频（重新上传一段更干净的样本）。"""
        voice = self.get(voice_id)
        suffix = Path(filename or "audio.wav").suffix.lower() or ".wav"
        if suffix not in ALLOWED_SUFFIXES:
            raise BadRequestError("不支持的音频格式：%s" % suffix)
        target = self._audio_dir / ("%s%s" % (voice.id, suffix))
        target.write_bytes(content)
        with self._lock:
            # 旧的托管文件在换扩展名后就是垃圾，顺手清理
            old = Path(voice.audio_path)
            if voice.origin == "managed" and old.is_file() and old.resolve() != target.resolve():
                old.unlink(missing_ok=True)
            voice.audio_path = str(target)
            voice.origin = "managed"
            voice.duration_s, voice.sample_rate = probe_audio(target)
            voice.size_bytes = target.stat().st_size
            voice.updated_at = time.time()
            self._persist()
        return voice

    def delete(self, voice_id: str) -> bool:
        voice = self.get(voice_id)
        with self._lock:
            self._items.pop(voice_id, None)
            self._persist()
        if voice.origin == "managed":
            Path(voice.audio_path).unlink(missing_ok=True)
        return True

    def import_raw(self, content: bytes, filename: str, subdir: str = "incoming") -> Path:
        """把一段临时上传的音频落盘（尚未登记为音色）。"""
        suffix = Path(filename or "audio.wav").suffix.lower() or ".wav"
        target_dir = self._data_dir / subdir
        target_dir.mkdir(parents=True, exist_ok=True)
        target = target_dir / ("%s%s" % (uuid.uuid4().hex[:12], suffix))
        target.write_bytes(content)
        return target

    def copy_into_library(self, source: Path, name: str, prompt_text: str, prompt_lang: str, note: str = "") -> Voice:
        """把磁盘上的文件复制进托管目录并登记。批量准备语料时用得上。"""
        suffix = source.suffix.lower()
        voice_id = uuid.uuid4().hex[:12]
        target = self._audio_dir / ("%s%s" % (voice_id, suffix))
        shutil.copyfile(source, target)
        duration, sample_rate = probe_audio(target)
        now = time.time()
        voice = Voice(
            id=voice_id,
            name=name,
            audio_path=str(target),
            prompt_text=prompt_text,
            prompt_lang=normalize_prompt_lang(prompt_lang),
            note=note,
            origin="managed",
            duration_s=duration,
            sample_rate=sample_rate,
            size_bytes=target.stat().st_size,
            created_at=now,
            updated_at=now,
        )
        with self._lock:
            self._items[voice.id] = voice
            self._persist()
        return voice

    # ------------------------------------------------------------------
    # 持久化
    # ------------------------------------------------------------------

    def _persist(self) -> None:
        payload = [
            {
                "id": voice.id,
                "name": voice.name,
                "audio_path": voice.audio_path,
                "prompt_text": voice.prompt_text,
                "prompt_lang": voice.prompt_lang,
                "note": voice.note,
                "tags": voice.tags,
                "origin": voice.origin,
                "duration_s": voice.duration_s,
                "sample_rate": voice.sample_rate,
                "size_bytes": voice.size_bytes,
                "created_at": voice.created_at,
                "updated_at": voice.updated_at,
            }
            for voice in self._items.values()
        ]
        try:
            self._index_path.write_text(
                json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
            )
        except OSError:
            pass

    def _load(self) -> None:
        if not self._index_path.is_file():
            return
        try:
            raw = json.loads(self._index_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return
        if not isinstance(raw, list):
            return
        # 「是否需要落盘」必须拿**磁盘上的原始值**判断：内存里的值已经被
        # normalize_prompt_lang 改好了，拿它去比对永远相等，脏数据就永远写不回去。
        repaired = False
        for item in raw:
            try:
                stored_lang = item.get("prompt_lang")
                lang = normalize_prompt_lang(stored_lang)
                if stored_lang != lang:
                    repaired = True
                voice = Voice(
                    id=item["id"],
                    name=item["name"],
                    audio_path=item["audio_path"],
                    prompt_text=item.get("prompt_text", ""),
                    prompt_lang=lang,
                    note=item.get("note", ""),
                    tags=list(item.get("tags") or []),
                    origin=item.get("origin", "managed"),
                    duration_s=item.get("duration_s"),
                    sample_rate=item.get("sample_rate"),
                    size_bytes=item.get("size_bytes", 0),
                    created_at=item.get("created_at", 0.0),
                    updated_at=item.get("updated_at", 0.0),
                )
            except KeyError:
                continue
            self._items[voice.id] = voice

        # 发现历史脏数据（例如字面量 "undefined"）就顺手落盘修正：
        # 否则备份出去、或拷贝到另一台机器时，脏数据会跟着一起走。
        if repaired:
            self._persist()


# --------------------------------------------------------------------------
# 音频探测
# --------------------------------------------------------------------------


def probe_audio(path: Path) -> Tuple[Optional[float], Optional[int]]:
    """读取音频时长与采样率。

    优先级：soundfile（支持格式多）→ wave（标准库，仅 wav）→ 放弃并返回 None。
    返回 None 不是错误：前端只是少展示一个数字，合成时官方会做真正的校验。
    """
    try:
        import soundfile  # noqa: PLC0415

        info = soundfile.info(str(path))
        if info.samplerate:
            return float(info.frames) / float(info.samplerate), int(info.samplerate)
    except Exception:  # noqa: BLE001 - 探测失败不是错误
        pass

    try:
        with wave.open(str(path), "rb") as handle:
            frames = handle.getnframes()
            rate = handle.getframerate()
            if rate:
                return frames / float(rate), int(rate)
    except Exception:  # noqa: BLE001
        pass
    return None, None

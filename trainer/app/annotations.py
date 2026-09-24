"""训练清单（`.list`）的读写 —— 标注校对的数据层。

官方清单格式（来自 `funasr_asr.py` 的输出）：

    音频绝对路径|说话人名|语种|文本

之所以要单独做校对，是因为**ASR 的错字会被直接学进模型**：表现为某些字
读音怪异，而且事后极难定位。官方用 `tools/subfix_webui.py` 做这件事，
但那是 Gradio GUI，集成不进来 —— 于是我们把数据层抽出来，界面自己做。
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional

from .errors import BadRequestError, NotFoundError

#: 官方清单的分隔符
SEP = "|"

#: 官方格式固定 4 段；文本里再出现 `|` 就留在最后一段里，不再切分
_FIELDS = 4


@dataclass
class AnnotationItem:
    index: int
    audio_path: str
    speaker: str
    language: str
    text: str
    #: 用户标记「这条不要」：音频本身有问题、听不清，或混进了别人的声音
    skip: bool = False
    #: 用 `|` 分隔的原始行，改动后重新拼装时用它保持原有字段
    raw_extra: List[str] = None  # type: ignore[assignment]

    @property
    def exists(self) -> bool:
        return bool(self.audio_path) and Path(self.audio_path).is_file()


def parse_list(path: Path) -> List[AnnotationItem]:
    """解析官方格式的清单文件。"""
    if not path.is_file():
        raise NotFoundError(
            "清单文件不存在：%s" % path,
            hint="先跑一次带「语音转文本」的训练任务，或用已有的 .list 文件。",
        )
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise NotFoundError("读取清单失败：%s" % exc) from exc

    items: List[AnnotationItem] = []
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split(SEP, _FIELDS - 1)
        # 字段不足时按官方顺序补齐，避免后面出现 None
        while len(parts) < _FIELDS:
            parts.append("")
        audio, speaker, language, text = parts[0], parts[1], parts[2], parts[3]
        if not audio:
            continue
        items.append(
            AnnotationItem(
                index=len(items),
                audio_path=audio.strip(),
                speaker=speaker.strip(),
                language=language.strip(),
                text=text.strip(),
                raw_extra=parts[_FIELDS:],
            )
        )
    return items


def write_list(path: Path, items: List[AnnotationItem]) -> Path:
    """写回官方格式。原子写：先写临时文件再替换，避免写一半崩掉毁掉原清单。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = []
    for item in items:
        fields = [item.audio_path, item.speaker, item.language, item.text]
        fields += list(item.raw_extra or [])
        lines.append(SEP.join(fields))
    body = "\n".join(lines) + ("\n" if lines else "")

    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(body, encoding="utf-8")
    tmp.replace(path)
    return path


def resolve_list_path(candidate: Optional[str], data_dir: Path, label: str = "清单") -> Path:
    """把外部传入的清单路径解析成绝对路径，并**限制在项目数据目录内**。

    清单里存的是绝对路径，而它可能来自用户（`list_file`）。
    不做这个约束，一个带 `..` 的路径就能把整个磁盘读出来。
    """
    if not candidate or not candidate.strip():
        raise BadRequestError("未指定%s路径" % label, code="LIST_MISSING")
    path = Path(candidate.strip()).expanduser()
    if not path.is_absolute():
        path = (data_dir / path).resolve()
    else:
        path = path.resolve()

    root = data_dir.resolve()
    if path != root and root not in path.parents:
        raise BadRequestError(
            "%s路径不在项目数据目录内：%s" % (label, path),
            hint="出于安全考虑，只允许读取 %s 下的文件。" % root,
            code="LIST_OUT_OF_SCOPE",
        )
    return path

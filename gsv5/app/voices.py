"""音色库只读适配：voicelib/voices.json。

音色库共享：Node 网关与 trainer（Python 3.9）共写的存储（阶段 26补7 / 坑 27）。
本模块**只读**：由 `ref_voice` id 解析出音频路径 + 转写文本。
与 trainer 一致：**每次读前重读文件**（防内存表漂移）。
"""

from __future__ import annotations

import json
from pathlib import Path

from .errors import Gsv5Error


def resolve_voice(voices_lib_dir: Path, voice_id: str) -> dict:
    index = voices_lib_dir / "voices.json"
    if not index.is_file():
        raise Gsv5Error("VOICE_NOT_FOUND", "音色库为空或不存在", "先在音色库页面添加音色", 404)

    try:
        records = json.loads(index.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise Gsv5Error("VOICES_BROKEN", f"音色库索引无法解析：{error}", "检查 voicelib/voices.json 是否损坏") from error

    for record in records if isinstance(records, list) else []:
        if record.get("id") == voice_id:
            audio_path = record.get("audio_path") or ""
            if not audio_path or not Path(audio_path).is_file():
                raise Gsv5Error(
                    "VOICE_AUDIO_MISSING",
                    f"音色 {voice_id} 的音频文件不存在：{audio_path}",
                    "在音色库页面重新上传该音色音频",
                    404,
                )
            return {
                "audio_path": audio_path,
                "prompt_text": record.get("prompt_text") or "",
                "prompt_lang": record.get("prompt_lang") or "zh",
            }

    raise Gsv5Error("VOICE_NOT_FOUND", f"音色库中未找到音色：{voice_id}", "检查音色库列表中是否有该音色", 404)

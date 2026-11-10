# -*- coding: utf-8 -*-
"""SenseVoice 常驻 worker（由 trainer/sensevoice-venv 的解释器运行）。

协议：stdout 只走 JSON-lines（私有 fd），FunASR/tqdm 的所有输出重定向到 stderr。
命令：
  {"id":1,"cmd":"generate","input":"...","language":"ja"}
  {"id":2,"cmd":"ping"}
  {"cmd":"shutdown"}

模型只从本地快照加载（`SenseVoiceSmall/model.pt` + `config.yaml`），
`disable_update=True` 避免启动时联网检查。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import traceback
from pathlib import Path

# 纯函数模块（无副作用）：剥掉 rich postprocess 渲染出来的情绪/事件 emoji。
# worker 是按文件路径启动的，脚本目录就是 sys.path[0]；被当模块 import 时走 app.asr 前缀。
try:  # pragma: no cover - 两条路径都只是 import
    from sensevoice_text import strip_markers
except ImportError:  # pragma: no cover
    from app.asr.sensevoice_text import strip_markers

# 必须在 import funasr 之前隔离协议通道：fd1 -> stderr，协议走 dup 出来的私有 fd。
_PROTO_FD = os.dup(1)
os.dup2(2, 1)
sys.stdout = sys.stderr
_PROTO = os.fdopen(_PROTO_FD, "w", encoding="utf-8", buffering=1)


def emit(payload: dict) -> None:
    _PROTO.write(json.dumps(payload, ensure_ascii=False) + "\n")
    _PROTO.flush()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--device", default="auto")
    args = parser.parse_args()

    try:
        import torch  # noqa: PLC0415

        from funasr import AutoModel  # noqa: PLC0415
        from funasr.utils.postprocess_utils import rich_transcription_postprocess  # noqa: PLC0415

        device = (args.device or "auto").strip().lower()
        if device == "auto":
            device = "cuda" if torch.cuda.is_available() else "cpu"
        model_dir = Path(args.model).expanduser()
        if not (model_dir / "model.pt").is_file() or not (model_dir / "config.yaml").is_file():
            raise FileNotFoundError("SenseVoice 快照不完整：%s" % model_dir)
        model = AutoModel(model=str(model_dir), device=device, disable_update=True)
        emit(
            {
                "type": "ready",
                "device": device,
                "model_class": type(model.model).__name__,
                "model": str(model_dir),
            }
        )
    except Exception as exc:  # noqa: BLE001
        emit(
            {
                "type": "error",
                "error": "%s: %s" % (type(exc).__name__, exc),
                "trace": traceback.format_exc()[-2000:],
            }
        )
        return 1

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            continue
        command = message.get("cmd")
        if command == "shutdown":
            break
        if command == "ping":
            emit({"id": message.get("id"), "ok": True})
            continue
        if command == "generate":
            request_id = message.get("id")
            try:
                language = str(message.get("language") or "auto").strip().lower()
                if language not in {"auto", "zh", "en", "ja", "ko", "yue", "nospeech"}:
                    language = "auto"
                result = model.generate(
                    input=str(message.get("input") or ""),
                    language=language,
                    # 与 Paraformer 路径一致：参考文本要逐字，关闭 ITN/标点改写
                    use_itn=False,
                    batch_size_s=60,
                )
                text = rich_transcription_postprocess(result[0]["text"]) if result else ""
                # 2026-11-09：上游 postprocess 会把情绪/事件标签渲染成 emoji（实测带 😔），
                # 转写文本要进参考文本/字幕，这里统一剥掉。见 app/asr/sensevoice_text.py。
                text = strip_markers(text)
                emit({"id": request_id, "ok": True, "text": text, "language": language})
            except Exception as exc:  # noqa: BLE001
                emit(
                    {
                        "id": request_id,
                        "ok": False,
                        "error": "%s: %s" % (type(exc).__name__, exc),
                        "trace": traceback.format_exc()[-1500:],
                    }
                )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

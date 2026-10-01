"""Confucius4-R2T2 推理 worker —— **触碰上游 API 的另一个薄文件**。

为什么是独立子进程：R2T2 上游基于 vLLM，vLLM 引擎要求在 `__main__` 环境启动
（官方 README 明确警告 spawn 问题）；uvicorn/FastAPI 进程里直接 import 会撞上
multiprocessing 的守护进程限制。worker 自成主进程，天然规避；
还顺带解决了「R2T2 与 TTS 依赖冲突时用不同解释器」的问题（NETEASE_R2T2_PYTHON）。

协议（stdin/stdout，每行一个 JSON；vLLM 自身日志走 stderr 不进协议）：

    → {"type": "ping", "id": "x"}                      ← {"type": "pong", "id": "x"}
    → {"type": "load", "id": "x"}                      ← {"type": "ready"}（模型就绪）
    → {"type": "transcribe", "id", "path", "language", "return_timestamps"}
                                                       ← {"type": "result", "id", "text", ...}
    → {"type": "stream_transcribe", "id", "path", "language", "chunk_ms"}
                                                       ← 多条 {"type": "stream_delta", "id", "text", "confirmed_len"}
                                                       ← {"type": "result", "id", ...}（最终定稿）
    → {"type": "shutdown"}

任何命令失败都回 {"type": "error", "id", "code", "message", "hint"}。

上游漂移面（2026-09 按官方 README 校准过一次）：
- 流式增量文本在 **返回值** 里：`_, text = asr.streaming_transcribe(chunk, state, max_new_tokens=4)`，
  不是从 `state` 读；`_state_text(state)` 现在只是兜底。
- 定稿：`asr.finish_streaming_transcribe(state)` 之后读 `state.text`。
- ⚠️ 仍未在真机上跑过：Windows 无 vLLM 发行包（PyPI 上只有 Linux wheel），
  本机这条链路要靠 WSL2 / Docker 才能实测，见 netease/README.md 的已知限制。
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

#: 语言代码 → 上游期望的英文名（README 口径：Chinese/English/...）
LANGUAGE_NAMES = {
    "zh": "Chinese",
    "en": "English",
    "fr": "French",
    "de": "German",
    "it": "Italian",
    "ja": "Japanese",
    "ko": "Korean",
    "pt": "Portuguese",
    "ru": "Russian",
    "es": "Spanish",
    "ar": "Arabic",
}

TARGET_SR = 16000


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def emit_log(line: str) -> None:
    emit({"type": "log", "line": line})


class AsrSession:
    """模型常驻 + 单线程顺序执行（单卡串行哲学与 trainer 一致）。"""

    def __init__(self, args: argparse.Namespace) -> None:
        self._args = args
        self._asr = None
        self._model_id = args.model

    # ------------------------------------------------------------------ 加载

    def ensure_loaded(self) -> None:
        if self._asr is not None:
            return
        emit_log(f"加载 R2T2 模型（backend={self._args.backend}）：{self._model_id}")
        started = time.monotonic()
        from r2t2 import R2T2ASRModel  # noqa: PLC0415

        if self._args.backend == "vllm":
            self._asr = R2T2ASRModel.LLM(
                model=self._model_id,
                gpu_memory_utilization=self._args.gpu_util,
                max_model_len=self._args.max_model_len,
                max_inference_batch_size=self._args.max_batch,
                max_new_tokens=self._args.max_new_tokens,
            )
        else:
            raise ValueError(f"暂不支持的后端：{self._args.backend}（本期仅 vllm）")
        emit_log(f"R2T2 模型就绪，耗时 {time.monotonic() - started:.1f}s")
        emit({"type": "ready"})

    # ------------------------------------------------------------------ 离线转写

    def transcribe(self, path: str, language: str, return_timestamps: bool) -> dict:
        self.ensure_loaded()
        wav, sr = load_wav_16k(path)
        kwargs: dict = {"audio": [(wav, sr)], "return_time_stamps": return_timestamps}
        name = language_name(language)
        if name:
            kwargs["language"] = [name]
        started = time.monotonic()
        results = self._asr.transcribe(**kwargs)
        first = results[0]
        text = str(getattr(first, "text", "") or "")
        result: dict = {"text": text.strip(), "elapsed_sec": round(time.monotonic() - started, 2)}
        if return_timestamps:
            stamps = getattr(first, "time_stamps", None) or []
            result["timestamps"] = [
                {
                    "text": str(getattr(item, "text", "") or ""),
                    "start": getattr(item, "start", None),
                    "end": getattr(item, "end", None),
                }
                for item in stamps
            ]
        return result

    # ------------------------------------------------------------------ 流式转写

    def stream_transcribe(self, path: str, language: str, chunk_ms: int, max_new_tokens: int = 4) -> dict:
        self.ensure_loaded()
        wav, sr = load_wav_16k(path)
        chunk_size = max(1, int(sr * chunk_ms / 1000))
        kwargs: dict = {
            "context": "",
            "unfixed_chunk_num": 0,
            "unfixed_token_num": 1,
            "chunk_size_sec": chunk_ms / 1000.0,
        }
        name = language_name(language)
        if name:
            kwargs["language"] = name
        state = self._asr.init_streaming_state(**kwargs)

        started = time.monotonic()
        emitted_len = 0
        for offset in range(0, len(wav), chunk_size):
            chunk = wav[offset : offset + chunk_size]
            if len(chunk) < chunk_size:
                break  # 尾部不足一块留给 finalize
            step = self._asr.streaming_transcribe(chunk, state, max_new_tokens=max_new_tokens)
            # 上游 README：`_, text = asr.streaming_transcribe(seg, state, max_new_tokens=4)`
            # —— 增量文本在**返回值**里（第二个元素），不是从 state 读的。
            # 仍保留 state 兜底，防止上游版本漂移。
            text = _coerce_text(step) or (_state_text(state) or "")
            if len(text) > emitted_len:
                emitted_len = len(text)
                emit(
                    {
                        "type": "stream_delta",
                        "text": text,
                        "elapsed_sec": round(time.monotonic() - started, 2),
                    }
                )
        final = _finalize(self._asr, state)
        return {"text": final.strip(), "elapsed_sec": round(time.monotonic() - started, 2)}


def _coerce_text(value) -> str:
    """把上游的返回值统一成字符串：str / (_, text) 元组 / 带 .text 的对象都接。"""
    if isinstance(value, str):
        return value
    if isinstance(value, (tuple, list)):
        for item in reversed(value):  # README 里文本在第二个元素
            text = _coerce_text(item)
            if text:
                return text
        return ""
    text = getattr(value, "text", None)
    return str(text) if text else ""


def _state_text(state) -> str | None:
    """从 streaming_state 里拿当前累计文本。

    字段名是防御式尝试：官方 README 只展示了收尾后的 `state.text`，
    流式中间态的字段名未说明，这里按常见命名逐个试。
    """
    for attr in ("ongoing_text", "confirmed_text", "current_text", "text"):
        value = getattr(state, attr, None)
        if isinstance(value, str) and value:
            return value
    return None


def _finalize(asr, state) -> str:
    """收尾出定稿文本：官方 README 是 finish 之后读 `state.text`，返回值兜底。"""
    try:
        result = asr.finish_streaming_transcribe(state)
    except Exception as error:  # pragma: no cover - 上游漂移
        emit_log(f"finish_streaming_transcribe 失败：{type(error).__name__}: {error}")
        return _state_text(state) or ""
    return _state_text(state) or _coerce_text(result)


def language_name(code: str) -> str | None:
    """auto → None（交给上游自动判断）；zh/Chinese → Chinese。"""
    if not code or code.lower() in {"auto", ""}:
        return None
    if code in LANGUAGE_NAMES:
        return LANGUAGE_NAMES[code]
    if code.capitalize() in LANGUAGE_NAMES.values():
        return code.capitalize()
    return code


def to_host_path(path: str) -> str:
    """把可能来自 Windows 宿主的路径翻译成本进程能读的路径。

    worker 跑在 WSL / Linux 里时（Windows 没有 vLLM 发行包，这是 R2T2 唯一的落地方式），
    服务传过来的还是宿主路径 `F:\\a\\b.wav`，直接 open 必然 FileNotFoundError。
    Windows 盘符在 WSL 下就是 `/mnt/<盘符小写>/`，逐个折算即可；已经是 posix 路径则原样返回。
    """
    candidate = Path(path)
    if candidate.exists():
        return str(candidate)
    if len(path) >= 3 and path[1:3] in {":\\", ":/"} and path[0].isalpha():
        translated = "/mnt/" + path[0].lower() + path[2:].replace("\\", "/")
        return translated
    return path


def load_wav_16k(path: str) -> tuple:
    """读音频并重采样到 16 kHz 单声道。librosa 优先（上游示例同款），逐级降级。"""
    p = Path(to_host_path(path))
    if not p.exists():
        raise FileNotFoundError(f"音频不存在：{p}")
    try:
        import librosa  # noqa: PLC0415

        return librosa.load(str(p), sr=TARGET_SR, mono=True)
    except ImportError:
        pass
    import numpy as np  # noqa: PLC0415
    import soundfile as sf  # noqa: PLC0415

    data, sr = sf.read(str(p), dtype="float32", always_2d=True)
    mono = data.mean(axis=1)
    if sr != TARGET_SR:
        ratio = TARGET_SR / sr
        indices = np.arange(0, len(mono) - 1, ratio)
        mono = np.interp(indices, np.arange(len(mono)), mono).astype("float32")
    return mono, TARGET_SR


def main() -> None:
    parser = argparse.ArgumentParser(prog="r2t2_worker", description="Confucius4-R2T2 推理 worker")
    parser.add_argument("--model", required=True, help="模型路径或 HF repo id")
    parser.add_argument("--backend", default="vllm")
    parser.add_argument("--gpu-util", type=float, default=0.35)
    parser.add_argument("--max-model-len", type=int, default=16384)
    parser.add_argument("--max-batch", type=int, default=32)
    parser.add_argument("--max-new-tokens", type=int, default=4096)
    args = parser.parse_args()

    session = AsrSession(args)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError as error:
            emit({"type": "error", "id": "", "code": "BAD_REQUEST", "message": f"JSON 解析失败：{error}", "hint": "worker 协议要求每行一个 JSON 对象。"})
            continue
        kind = request.get("type", "")
        request_id = str(request.get("id", ""))
        try:
            if kind == "ping":
                emit({"type": "pong", "id": request_id})
            elif kind == "load":
                session.ensure_loaded()
            elif kind == "transcribe":
                result = session.transcribe(
                    path=str(request["path"]),
                    language=str(request.get("language", "auto")),
                    return_timestamps=bool(request.get("return_timestamps", False)),
                )
                emit({"type": "result", "id": request_id, **result})
            elif kind == "stream_transcribe":
                result = session.stream_transcribe(
                    path=str(request["path"]),
                    language=str(request.get("language", "auto")),
                    chunk_ms=int(request.get("chunk_ms", 160)),
                )
                emit({"type": "result", "id": request_id, **result})
            elif kind == "shutdown":
                emit({"type": "bye", "id": request_id})
                return
            else:
                emit({"type": "error", "id": request_id, "code": "UNKNOWN_COMMAND", "message": f"未知命令：{kind}", "hint": "核对 r2t2_worker 协议。"})
        except Exception as error:
            hint = "常见原因：模型未下载（先按 netease/README.md 下载权重）、显存不足、音频格式不支持。"
            if isinstance(error, FileNotFoundError):
                hint = "检查音频路径，或改用文件上传方式。"
            emit(
                {
                    "type": "error",
                    "id": request_id,
                    "code": "WORKER_ERROR",
                    "message": f"{type(error).__name__}: {error}",
                    "hint": hint,
                }
            )


if __name__ == "__main__":
    main()

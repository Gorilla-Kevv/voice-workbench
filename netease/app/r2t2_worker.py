"""Confucius4-R2T2 推理 worker —— **触碰上游 API 的另一个薄文件**。

为什么是独立子进程：R2T2 上游基于 vLLM，vLLM 引擎要求在 `__main__` 环境启动
（官方 README 明确警告 spawn 问题）；uvicorn/FastAPI 进程里直接 import 会撞上
multiprocessing 的守护进程限制。worker 自成主进程，天然规避；
还顺带解决了「R2T2 与 TTS 依赖冲突时用不同解释器」的问题（NETEASE_R2T2_PYTHON）——
qwen-asr 钉死 transformers==4.57.6，而 Confucius4-TTS 的 venv 是 4.52.4，
**两个依赖树不能共用一个解释器**，所以离线（transformers）路径也走独立 venv
（`netease/r2t2-venv`，见 netease/README.md）。

协议（stdin/stdout，每行一个 JSON；模型日志走 stderr 不进协议）：

    → {"type": "ping", "id": "x"}                      ← {"type": "pong", "id": "x"}
    → {"type": "load", "id": "x"}                      ← {"type": "ready"}（模型就绪）
    → {"type": "transcribe", "id", "path", "language", "return_timestamps"}
                                                       ← {"type": "result", "id", "text", ...}
    → {"type": "stream_transcribe", "id", "path", "language", "chunk_ms"}
                                                       ← 多条 {"type": "stream_delta", "id", "text", "confirmed_len"}
                                                       ← {"type": "result", "id", ...}（最终定稿）
    → {"type": "shutdown"}

任何命令失败都回 {"type": "error", "id", "code", "message", "hint"}。

两种后端（NETEASE_R2T2_BACKEND / --backend）：
- `transformers`（**Windows 原生可用**，离线转写）：qwen-asr 的 transformers 后端。
  8 GB 卡实测口径（HANDOFF 坑 12）：`max_inference_batch_size=1`（默认 32 会爆 KV cache）、
  外层按 ~240 s 分段再逐段喂上游（上游自己的 MAX_ASR_INPUT_SECONDS=1200 s 太长），
  bf16 权重净占 ~5.5 GB。**不支持时间戳**（需要额外的 forced aligner 模型）与流式。
- `vllm`（只有 Linux/WSL 有发行包）：官方完整能力，含流式。

上游漂移面（2026-09 按官方 README 校准过一次）：
- 流式增量文本在 **返回值** 里：`_, text = asr.streaming_transcribe(chunk, state, max_new_tokens=4)`，
  不是从 `state` 读；`_state_text(state)` 现在只是兜底。
- 定稿：`asr.finish_streaming_transcribe(state)` 之后读 `state.text`。
- 流式路径**仍未真机验证过**（本机 Windows 没有 vLLM）；离线 transformers 路径阶段 41 起接入。
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any

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

#: transformers 后端的**外层**分段秒数。上游 `MAX_ASR_INPUT_SECONDS=1200` 是为
#: 大显存机器定的；8 GB 卡上一次喂 20 分钟音频的注意力矩阵必爆。
#: 240 s 来自坑 12 的他机实测口径（与 batch=1、bf16 净占 ~5.5 GB 同一套画像）。
TRANSFORMERS_SEGMENT_SEC = 240.0


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
        elif self._args.backend == "transformers":
            self._asr = self._load_transformers(R2T2ASRModel)
        else:
            raise ValueError(
                f"暂不支持的后端：{self._args.backend}（可选：transformers=离线转写，Windows 可用 / vllm=完整能力，需 Linux/WSL）"
            )
        emit_log(f"R2T2 模型就绪，耗时 {time.monotonic() - started:.1f}s")
        emit({"type": "ready"})

    def _load_transformers(self, r2t2_model_cls) -> Any:
        """transformers 后端加载：bf16（卡不支持退 fp16）→ 上 GPU → 静音预热。

        - 不用 device_map（省掉 accelerate 的分发逻辑）：先上 CPU 再 `.to()`，
          与 qwen_asr 的 `inputs.to(self.model.device).to(self.model.dtype)` 推理路径对齐；
        - `max_inference_batch_size=1`：8 GB 卡上默认 32 会爆 KV cache（坑 12 实测口径）；
        - 加载完跑一条 0.5 s 静音：首条真实转写的耗时大头是 torch 分配池扩张 + kernel
          首跑（坑 12），在 ready 之前摊掉，产物不落盘；
        - `--device cpu` 显式走 CPU（fp32，bf16 的 CPU matmul 更慢）：零显存跑通链路
          的排障通道，RTF 慢但能用 —— 与 gsv5 的 `GSV5_DEVICE=cpu` 同一先例。
        """
        import numpy as np  # noqa: PLC0415
        import torch  # noqa: PLC0415

        device = self._args.device
        if device == "auto":
            device = "cuda" if torch.cuda.is_available() else "cpu"
        if device == "cuda" and not torch.cuda.is_available():
            raise ValueError("device=cuda 但当前解释器没有可用的 CUDA（torch 装的是 CPU 版？）")

        if device == "cuda":
            dtype = "bfloat16"
            if not torch.cuda.is_bf16_supported():
                dtype = "float16"
                emit_log("当前 GPU 不支持 bf16，退回 fp16")
        else:
            dtype = "float32"
        emit_log(f"transformers 后端加载：device={device}, dtype={dtype}（CPU 模式 RTF 慢，仅用于排障/零显存）")
        asr = r2t2_model_cls.from_pretrained(
            self._model_id,
            max_inference_batch_size=1,
            max_new_tokens=self._args.max_new_tokens,
            torch_dtype=dtype,
        )
        asr.model.to(device)
        emit_log(f"transformers 后端就绪：device={device}, dtype={dtype}")
        try:
            warm_started = time.monotonic()
            silence = np.zeros(int(TARGET_SR * 0.5), dtype="float32")
            asr.transcribe(audio=[(silence, TARGET_SR)])
            emit_log(f"算子预热完成，耗时 {time.monotonic() - warm_started:.1f}s")
        except Exception as error:  # noqa: BLE001 - 预热失败只记录：真正的转写自会给出真实错误
            emit_log(f"算子预热失败（不阻塞）：{type(error).__name__}: {error}")
        return asr

    # ------------------------------------------------------------------ 离线转写

    def transcribe(self, path: str, language: str, return_timestamps: bool) -> dict:
        self.ensure_loaded()
        if return_timestamps and self._args.backend == "transformers":
            raise ValueError(
                "transformers 后端暂不支持时间戳：需要额外的 forced aligner 模型（Qwen3-Forced-Aligner），"
                "本期未接入。请去掉 return_timestamps，或改用 vllm 后端（需 Linux/WSL）。"
            )
        wav, sr = load_wav_16k(path)
        if self._args.backend == "transformers" and len(wav) > sr * TRANSFORMERS_SEGMENT_SEC:
            return self._transcribe_segmented(wav, sr, language)
        return self._transcribe_once(wav, sr, language, return_timestamps)

    def _transcribe_once(self, wav, sr: int, language: str, return_timestamps: bool) -> dict:
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

    def _transcribe_segmented(self, wav, sr: int, language: str) -> dict:
        """超长音频按 ~240 s 外层分段，逐段过上游再拼接。

        上游自己的 `MAX_ASR_INPUT_SECONDS=1200` 是大显存口径；8 GB 卡一次喂 20 分钟
        音频必爆注意力显存（坑 12 的实测画像：240 s + batch=1 + bf16）。分段在
        worker 侧做而不是改上游——上游仓库只读。文本按段顺序直接拼接（与上游
        多 chunk 的 `"".join` 合并语义一致）。
        """
        segment_samples = int(sr * TRANSFORMERS_SEGMENT_SEC)
        total = len(wav)
        started = time.monotonic()
        texts: list[str] = []
        for offset in range(0, total, segment_samples):
            seg = wav[offset : offset + segment_samples]
            if len(seg) < TARGET_SR:  # 尾部不足 1 s 的碎段并入结果没有意义，忽略
                break
            part = self._transcribe_once(seg, sr, language, return_timestamps=False)
            texts.append(part.get("text", ""))
            emit_log(
                f"分段转写 {offset // sr + len(seg) // sr}s / {total // sr}s 完成"
                f"（累计 {len(texts)} 段）"
            )
        return {
            "text": "".join(texts).strip(),
            "elapsed_sec": round(time.monotonic() - started, 2),
            "segments": len(texts),
        }

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
    # 脚本目录（netease/app/）会以 sys.path[0] 出现 —— 里面的 r2t2.py（进程管理器）、
    # config.py、errors.py 会遮蔽 site-packages 的同名模块：`from r2t2 import R2T2ASRModel`
    # 实际 import 到的是自家 manager，报「attempted relative import with no known parent
    # package」。本 worker 自包含（只依赖 site-packages），直接把脚本目录整个摘掉。
    # 实测只有真 load 才会踩到：python -c 的探活（cwd=仓库根）与 ping 协议冒烟都覆盖不到。
    script_dir = str(Path(__file__).resolve().parent)
    sys.path[:] = [entry for entry in sys.path if str(Path(entry).resolve()) != script_dir]

    parser = argparse.ArgumentParser(prog="r2t2_worker", description="Confucius4-R2T2 推理 worker")
    parser.add_argument("--model", required=True, help="模型路径或 HF repo id")
    parser.add_argument(
        "--backend",
        default="transformers",
        help="transformers=离线转写（Windows 原生可用）；vllm=完整能力含流式（仅 Linux/WSL）",
    )
    parser.add_argument("--gpu-util", type=float, default=0.35, help="vLLM 专用：gpu_memory_utilization")
    parser.add_argument("--max-model-len", type=int, default=16384, help="vLLM 专用：max_model_len")
    parser.add_argument("--max-batch", type=int, default=32, help="vLLM 专用：max_inference_batch_size（transformers 后端固定 1，8 GB 卡口径）")
    parser.add_argument("--max-new-tokens", type=int, default=4096)
    parser.add_argument(
        "--device",
        default="auto",
        help="transformers 后端的推理设备：auto（默认，有 CUDA 用 CUDA）/ cuda / cpu（零显存排障通道，fp32，RTF 慢）",
    )
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
                # ready 是给 reader 线程用的无 id 广播（置 model_loaded）；
                # 这里再回一条带 id 的 result，manager 的 _request 才能解除等待 ——
                # 否则 warmup 会挂满 REQUEST_TIMEOUT_SEC（1800 s）才超时。
                # 旧代码只发 ready：Windows 上 worker 起不来，这个洞一直没暴露。
                emit({"type": "result", "id": request_id, "loaded": True})
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

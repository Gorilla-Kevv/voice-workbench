"""PyMSS bridge：由 trainer 以子进程方式调用的 JSON-lines 入口。

为什么不是常驻服务：分离是短任务，常驻会多一个端口/进程/VRAM 协调；bridge 退出后
CUDA 上下文随之释放，显存归还最干净。

协议：
  --request '<json>' 或 --request-file <path>
  入参：source / model / model_dir / outputs{stem:dir} / format / agg / device
  stdout：每行一个 JSON
    {"event":"progress","fraction":0.42,"message":"..."}
    {"event":"result","files":{"vocals":"...","instrumental":"..."},"sample_rate":44100,...}
    {"event":"error","code":"PYMSS_MODEL_MISSING","message":"...","hint":"..."}
  stderr：PyMSS 日志；绝不混入 stdout。
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, Optional


def emit(payload: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def error(code: str, message: str, hint: str = "") -> int:
    emit({"event": "error", "code": code, "message": message, "hint": hint})
    return 1


def _load_request(args: argparse.Namespace) -> Dict[str, Any]:
    raw = args.request
    if args.request_file:
        raw = Path(args.request_file).read_text(encoding="utf-8")
    if not raw:
        raise ValueError("缺少 --request 或 --request-file")
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise ValueError("request 必须是 JSON 对象")
    return data


def _validate(req: Dict[str, Any]) -> Dict[str, Any]:
    source = Path(str(req.get("source") or "")).expanduser()
    model = str(req.get("model") or "").strip()
    outputs_raw = req.get("outputs")
    if not source.is_file():
        raise ValueError("输入音频不存在：%s" % source)
    if not model:
        raise ValueError("缺少 model")
    if not isinstance(outputs_raw, dict) or not outputs_raw:
        raise ValueError("outputs 必须是非空对象 {stem: dir}")
    outputs: Dict[str, Path] = {}
    for stem, directory in outputs_raw.items():
        if not directory:
            continue
        target = Path(str(directory)).expanduser()
        target.mkdir(parents=True, exist_ok=True)
        if not os.access(target, os.W_OK):
            raise ValueError("输出目录不可写：%s" % target)
        outputs[str(stem)] = target
    if not outputs:
        raise ValueError("outputs 里没有可写目录")
    return {
        "source": source,
        "model": model,
        "model_dir": Path(str(req.get("model_dir") or os.environ.get("PYMSS_MODEL_DIR") or "")).expanduser()
        if (req.get("model_dir") or os.environ.get("PYMSS_MODEL_DIR"))
        else None,
        "outputs": outputs,
        "format": str(req.get("format") or "wav").lower(),
        "agg": req.get("agg"),
        "device": str(req.get("device") or "auto").lower(),
    }


def _read_audio_info(path: Path) -> Dict[str, Any]:
    try:
        import soundfile as sf  # noqa: PLC0415

        info = sf.info(str(path))
        return {"sample_rate": int(info.samplerate), "duration_s": float(info.frames / info.samplerate)}
    except Exception:  # noqa: BLE001
        return {"sample_rate": None, "duration_s": None}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", default="")
    parser.add_argument("--request-file", default="")
    args = parser.parse_args()

    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass
    logging.basicConfig(stream=sys.stderr, level=logging.INFO, format="%(message)s")

    try:
        req = _load_request(args)
        job = _validate(req)
    except Exception as exc:  # noqa: BLE001
        return error("BAD_REQUEST", str(exc), "检查 bridge 请求 JSON 与输入路径。")

    try:
        import pymss  # noqa: PLC0415
        from pymss import create_separator  # noqa: PLC0415
        from importlib.metadata import version as package_version  # noqa: PLC0415
    except Exception as exc:  # noqa: BLE001
        return error(
            "PYMSS_NOT_READY",
            "无法导入 PyMSS：%s: %s" % (type(exc).__name__, exc),
            "先运行 pymss/check.py；确认 pymss/.venv 与 pymss==2.0.14 已安装。",
        )

    store_dirs = {stem: str(path) for stem, path in job["outputs"].items()}
    inference_params: Dict[str, Any] = {}
    raw_params = req.get("params")
    if isinstance(raw_params, dict):
        inference_params.update({str(k): v for k, v in raw_params.items()})
    if job["agg"] is not None:
        # PyMSS 的 VR 系模型用 aggression；非 VR 模型会忽略不认识的键
        inference_params["aggression"] = int(job["agg"])

    last_progress = 0.0

    def on_progress(done: float, total: float, message: str = "") -> None:
        nonlocal last_progress
        now = time.time()
        if now - last_progress < 0.3:
            return
        last_progress = now
        fraction = 0.0 if not total else max(0.0, min(1.0, float(done) / float(total)))
        emit({"event": "progress", "fraction": round(fraction, 3), "message": message or "分离中"})

    started = time.time()
    try:
        separator = create_separator(
            job["model"],
            model_dir=job["model_dir"],
            device=job["device"],
            output_format=job["format"],
            store_dirs=store_dirs,
            progress_callback=on_progress,
            inference_params=inference_params,
        )
        separator.process_folder(job["source"])
    except FileNotFoundError as exc:
        return error(
            "PYMSS_MODEL_MISSING",
            "PyMSS 缺少模型或模型文件：%s" % exc,
            "运行 pymss/.venv/Scripts/pymss.exe download <model> --model-dir pymss/models。",
        )
    except Exception as exc:  # noqa: BLE001
        return error(
            "PYMSS_INFER_FAILED",
            "PyMSS 分离失败：%s: %s" % (type(exc).__name__, exc),
            "常见原因：显存不足、模型版本/架构不匹配、音频格式不受支持。可加 --debug 看 stderr。",
        )
    finally:
        # 让 PyMSS/torch 的缓存尽快归还；进程退出时本来也会释放
        try:
            import torch  # noqa: PLC0415

            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:  # noqa: BLE001
            pass

    stem = job["source"].stem
    files: Dict[str, str] = {}
    for name, directory in job["outputs"].items():
        suffix = f".{job['format']}".lower()
        hits = [
            path
            for path in directory.glob("*")
            if path.is_file()
            and path.suffix.lower() == suffix
            and path.stem.lower().endswith("_" + name.lower())
        ]
        hits.sort(key=lambda path: path.stat().st_mtime)
        if hits:
            files[name] = str(hits[-1])
    if not files:
        return error(
            "PYMSS_NO_OUTPUT",
            "PyMSS 已结束但没有找到输出文件（期望 *_<stem>.<format>）。",
            "确认模型的 target_stem 与请求的 outputs 键匹配（vocals/instrumental/echo）。",
        )

    primary = files.get("vocals") or next(iter(files.values()))
    info = _read_audio_info(Path(primary))
    emit(
        {
            "event": "result",
            "files": files,
            "sample_rate": info["sample_rate"],
            "duration_s": info["duration_s"],
            "model": job["model"],
            "pymss_version": package_version("pymss"),
            "elapsed_s": round(time.time() - started, 2),
        }
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

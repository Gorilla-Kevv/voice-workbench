"""带 Range 的静态文件响应。

为什么不用 FastAPI 的 StaticFiles / FileResponse：本项目 trainer 跑在
Starlette 0.38（Python 3.9 整合包），该版本不处理 `Range` 请求 —— 浏览器
拿到的音频 `seekable` 是 `[0, 0]`，长音频的进度条拖不动。这里实现单区间
Range（浏览器音频/视频实际只用这一种），并显式返回 `Accept-Ranges`。

安全边界由调用方负责：只允许把 `outputs_dir` 下的文件交给本模块。
"""

from __future__ import annotations

import mimetypes
from pathlib import Path
from typing import Iterator, Optional, Tuple

from fastapi import Request
from fastapi.responses import Response, StreamingResponse

CHUNK_SIZE = 1024 * 1024


def _content_type(path: Path) -> str:
    guessed = mimetypes.guess_type(str(path))[0]
    return guessed or "application/octet-stream"


def _parse_range(header: str, size: int) -> Optional[Tuple[int, int]]:
    """解析 `bytes=start-end` / `bytes=start-` / `bytes=-suffix`；非法返回 None。"""
    if not header.startswith("bytes="):
        return None
    spec = header[6:].split(",")[0].strip()
    if "-" not in spec:
        return None
    start_raw, end_raw = spec.split("-", 1)
    try:
        if start_raw == "":
            suffix = int(end_raw)
            if suffix <= 0:
                return None
            start = max(0, size - suffix)
            end = size - 1
        else:
            start = int(start_raw)
            end = int(end_raw) if end_raw else size - 1
    except ValueError:
        return None
    if start < 0 or start >= size or end < start:
        return None
    return start, min(end, size - 1)


def _file_chunks(path: Path, start: int, length: int) -> Iterator[bytes]:
    with path.open("rb") as handle:
        handle.seek(start)
        remaining = length
        while remaining > 0:
            chunk = handle.read(min(CHUNK_SIZE, remaining))
            if not chunk:
                break
            remaining -= len(chunk)
            yield chunk


def serve_file_with_range(request: Request, path: Path) -> Response:
    size = path.stat().st_size
    media_type = _content_type(path)
    base_headers = {"Accept-Ranges": "bytes"}

    range_header = request.headers.get("range")
    if range_header:
        parsed = _parse_range(range_header, size)
        if parsed is None:
            return Response(
                status_code=416,
                headers={**base_headers, "Content-Range": "bytes */%d" % size},
            )
        start, end = parsed
        length = end - start + 1
        headers = {
            **base_headers,
            "Content-Range": "bytes %d-%d/%d" % (start, end, size),
            "Content-Length": str(length),
        }
        if request.method == "HEAD":
            return Response(status_code=206, media_type=media_type, headers=headers)
        return StreamingResponse(
            _file_chunks(path, start, length),
            status_code=206,
            media_type=media_type,
            headers=headers,
        )

    headers = {**base_headers, "Content-Length": str(size)}
    if request.method == "HEAD":
        return Response(status_code=200, media_type=media_type, headers=headers)
    return StreamingResponse(
        _file_chunks(path, 0, size),
        status_code=200,
        media_type=media_type,
        headers=headers,
    )

"""清单核对：权重与上游代码在不在、字节数对不对。

只读、无状态、每次现扫；字节数校验是硬要求 —— 截断的权重会在**加载模型时**
才报 `PytorchStreamReader failed`，离下载失败已经很远。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Optional

from .config import Settings, load_manifest

_SIZE_TOLERANCE = 0.005


def _entry_state(settings: Settings, entry: dict[str, Any]) -> dict[str, Any]:
    relative = str(entry.get("target") or "")
    path = settings.target_path(relative)
    expected = int(entry.get("sizeBytes") or 0)
    exists = path.is_file()
    actual: Optional[int] = None
    if exists:
        try:
            actual = path.stat().st_size
        except OSError:
            actual = None

    size_ok = False
    note = ""
    if not exists:
        note = "缺失"
    elif actual is None:
        note = "无法读取文件大小"
    elif expected <= 0:
        size_ok = True
        note = "已就位（未登记期望大小）"
    else:
        delta = abs(actual - expected) / expected
        if delta <= _SIZE_TOLERANCE:
            size_ok = True
            note = "已就位"
        else:
            note = f"大小不符：实际 {actual} / 期望 {expected}（疑似下载截断，请重下）"

    return {
        "id": entry.get("id"),
        "group": entry.get("group"),
        "required": bool(entry.get("required")),
        "target": relative,
        "path": str(path),
        "purpose": entry.get("purpose"),
        "expected_bytes": expected,
        "actual_bytes": actual,
        "exists": exists,
        "size_ok": size_ok,
        "ok": exists and size_ok,
        "note": note,
    }


def _code_state(settings: Settings, entry: dict[str, Any]) -> dict[str, Any]:
    relative = str(entry.get("target") or "")
    path = settings.target_path(relative)
    marker = path / str(entry.get("marker") or "pyproject.toml")
    exists = marker.exists()
    return {
        "id": entry.get("id"),
        "target": relative,
        "path": str(path),
        "purpose": entry.get("purpose"),
        "exists": exists,
        "marker": str(marker),
        "note": "已就位" if exists else f"缺失（判据：{marker} 不存在）",
    }


def scan(settings: Settings) -> dict[str, Any]:
    manifest = load_manifest()
    entries = list(manifest.get("entries") or [])
    code = list(manifest.get("code") or [])

    files = [_entry_state(settings, entry) for entry in entries]
    codes = [_code_state(settings, entry) for entry in code]

    required = [item for item in files if item["required"]]
    inference_ready = bool(required) and all(item["ok"] for item in required)
    missing = [item for item in files if item["required"] and not item["ok"]]
    truncated = [item for item in files if item["exists"] and not item["size_ok"]]
    missing_code = [item for item in codes if not item["exists"]]

    return {
        "ok": not missing and not missing_code,
        "inference_ready": inference_ready and not missing_code,
        "files": files,
        "code": codes,
        "missing": missing,
        "truncated": truncated,
        "missing_code": missing_code,
        "bytes": {
            "have": sum(item["actual_bytes"] or 0 for item in files),
            "need": sum(item["expected_bytes"] for item in files),
        },
    }


def describe_missing(scan_result: dict[str, Any]) -> str:
    parts: list[str] = []
    for item in scan_result["missing"]:
        parts.append(f"缺 {item['target']}（{item['purpose']}）")
    for item in scan_result["truncated"]:
        parts.append(f"{item['target']} 疑似截断，需重下")
    for item in scan_result["missing_code"]:
        parts.append(f"缺上游代码 {item['target']}")
    return "；".join(parts) if parts else ""


def group_report(scan_result: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        {
            "name": "inference",
            "label": "推理档（CosyVoice3 0.5B）",
            "ready": scan_result["inference_ready"],
            "have_mb": round(scan_result["bytes"]["have"] / 1048576, 1),
            "need_mb": round(scan_result["bytes"]["need"] / 1048576, 1),
        }
    ]


def resolve_weights_manifest_path() -> Optional[Path]:
    from .config import MANIFEST_PATH

    return MANIFEST_PATH if MANIFEST_PATH.is_file() else None

"""清单核对：权重与上游代码到底在不在、字节数对不对。

**只读、无状态、每次现扫** —— 用户可能正在另开一个终端下载权重，
「刷新一下就能看见」是这个模块唯一的使用体验要求（与 modelRegistry 同一取舍）。

字节数校验是硬要求：阶段 28 的 codec 权重曾因下载截断报
`PytorchStreamReader failed … central directory`，那个错误发生在**加载模型时**，
离「下载失败」已经很远，查起来很费劲。这里在扫描阶段就把截断标出来。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Optional

from .config import Settings, load_manifest

#: 字节数允许多大误差。下载器按 Range 分片写盘，末片可能因源站 Content-Length
#: 与清单有 ±1 的出入；超过这个比例就认定截断。
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
        size_ok = True  # 清单没给期望值就不判
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
    # 「在不在」不看目录本身（tar 解出来可能是空壳），看一个稳定的特征文件
    marker = path / "pyproject.toml" if entry.get("id") == "upstream-irodori" else path / "dacvae"
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
    """扫描清单，返回分组结果。**不抛异常** —— 探活与 --check 都要能拿到部分结论。"""
    manifest = load_manifest()
    entries = list(manifest.get("entries") or [])
    code = list(manifest.get("code") or [])

    files = [_entry_state(settings, entry) for entry in entries]
    codes = [_code_state(settings, entry) for entry in code]

    def _group(name: str) -> list[dict[str, Any]]:
        return [item for item in files if item["group"] == name]

    inference = _group("inference")
    training = _group("training")

    def _ready(items: list[dict[str, Any]]) -> bool:
        """组内「必需项」全部 ok 才算就绪；非必需项缺失不影响。"""
        required = [item for item in items if item["required"]]
        return bool(required) and all(item["ok"] for item in required)

    missing = [item for item in files if item["required"] and not item["ok"]]
    truncated = [item for item in files if item["exists"] and not item["size_ok"]]
    missing_code = [item for item in codes if not item["exists"]]

    return {
        "ok": not missing and not missing_code,
        "inference_ready": _ready(inference) and not missing_code,
        "training_ready": _ready(training) and not missing_code,
        "files": files,
        "code": codes,
        "missing": missing,
        "truncated": truncated,
        "missing_code": missing_code,
        "bytes": {
            "inference_have": sum(item["actual_bytes"] or 0 for item in inference),
            "inference_need": sum(item["expected_bytes"] for item in inference),
            "training_have": sum(item["actual_bytes"] or 0 for item in training),
            "training_need": sum(item["expected_bytes"] for item in training),
        },
    }


def describe_missing(scan_result: dict[str, Any]) -> str:
    """把缺失项拼成一句人话，给 --check 与错误 hint 共用。"""
    parts: list[str] = []
    for item in scan_result["missing"]:
        parts.append(f"缺 {item['target']}（{item['purpose']}）")
    for item in scan_result["truncated"]:
        parts.append(f"{item['target']} 疑似截断，需重下")
    for item in scan_result["missing_code"]:
        parts.append(f"缺上游代码 {item['target']}")
    return "；".join(parts) if parts else ""


def group_report(scan_result: dict[str, Any]) -> list[dict[str, Any]]:
    """按「推理 / 训练」两档归并，给前端与 --check 打印用。"""
    return [
        {
            "name": "inference",
            "label": "推理档（日语合成）",
            "ready": scan_result["inference_ready"],
            "have_mb": round(scan_result["bytes"]["inference_have"] / 1048576, 1),
            "need_mb": round(scan_result["bytes"]["inference_need"] / 1048576, 1),
        },
        {
            "name": "training",
            "label": "训练档（音色固化）",
            "ready": scan_result["training_ready"],
            "have_mb": round(scan_result["bytes"]["training_have"] / 1048576, 1),
            "need_mb": round(scan_result["bytes"]["training_need"] / 1048576, 1),
        },
    ]


def resolve_weights_manifest_path() -> Optional[Path]:
    """暴露清单路径给排障用（--check 会打印它，方便核对「读的是哪一份」）。"""
    from .config import MANIFEST_PATH

    return MANIFEST_PATH if MANIFEST_PATH.is_file() else None

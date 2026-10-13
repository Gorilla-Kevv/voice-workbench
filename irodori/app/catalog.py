"""`/v1/catalog` 的数据装配：emoji 表、caption 预设、步数档位。

唯一常量源原则（与 `trainer/app/sovits/catalog.py` 同一哲学）：
emoji 与官方释义**都从上游代码取**，不在本仓库再抄一份 —— 上游改了调色板，
catalog 自动跟随。取法是 ast 解析而不是 import：

- `irodori_tts.duration.ALLOWED_ANNOTATION_EMOJIS`（56 个，**真正参与校验的常量**）：
  该模块顶部 `import torch`，catalog 不该为了一张表把 torch 拖进来（权重缺失的机器
  上探活页也要能打开）；
- `irodori_tts.gradio_emoji_palette.EMOJI_PALETTE_ITEMS`（45 条官方释义）：
  模块顶部 `import gradio`，本服务 venv 不装 gradio。

两个文件都是上游的普通源码文件，ast 提取是只读、零依赖、随上游升级自动同步的。
"""

from __future__ import annotations

import ast
from pathlib import Path
from typing import Any

from .config import Settings


def _upstream_file(settings: Settings, relative: str) -> Path | None:
    candidate = settings.upstream_dir / "irodori_tts" / relative
    return candidate if candidate.is_file() else None


def _literal_tuple_of_strings(node: ast.AST) -> tuple[str, ...] | None:
    """ast.literal_eval 的窄包装：只接受「纯字符串元组」，其余一律 None。"""
    try:
        value = ast.literal_eval(node)
    except (ValueError, SyntaxError, MemoryError):
        return None
    if isinstance(value, tuple) and all(isinstance(item, str) for item in value):
        return value
    return None


def _assign_targets(node: ast.AST) -> list[str]:
    """兼容 `X = ...`（Assign）与 `X: 注解 = ...`（AnnAssign）—— 上游两处常量都是后者。"""
    if isinstance(node, ast.Assign):
        return [t.id for t in node.targets if isinstance(t, ast.Name)]
    if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.value is not None:
        return [node.target.id]
    return []


def allowed_emojis(settings: Settings) -> tuple[str, ...]:
    """上游校验用的 emoji 全集（56 个）。解析失败返回空表并让 catalog 如实标 `source: none`。"""
    path = _upstream_file(settings, "duration.py")
    if path is None:
        return ()
    try:
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    except (OSError, SyntaxError):
        return ()
    for node in ast.walk(tree):
        if "ALLOWED_ANNOTATION_EMOJIS" in _assign_targets(node):
            value = _literal_tuple_of_strings(node.value)  # type: ignore[attr-defined]
            if value is not None:
                return value
    return ()


def _emoji_descriptions(settings: Settings) -> dict[str, tuple[str, str]]:
    """官方调色板释义（emoji → (label, description)，日文原文，不自造翻译）。

    `EMOJI_PALETTE_ITEMS` 是 `EmojiPaletteItem(...)` 构造调用元组，不是字面量，
    所以手工走 ast：只认「三个位置参数都是字符串常量」的调用，其余跳过。
    """
    path = _upstream_file(settings, "gradio_emoji_palette.py")
    if path is None:
        return {}
    try:
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    except (OSError, SyntaxError):
        return {}

    result: dict[str, tuple[str, str]] = {}
    for node in ast.walk(tree):
        if "EMOJI_PALETTE_ITEMS" not in _assign_targets(node):
            continue
        value = node.value  # type: ignore[attr-defined]
        if not isinstance(value, ast.Tuple):
            continue
        for item in value.elts:
            if not (isinstance(item, ast.Call) and len(item.args) == 3):
                continue
            parts: list[str] = []
            for arg in item.args:
                if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
                    parts.append(arg.value)
            if len(parts) == 3:
                result[parts[0]] = (parts[1], parts[2])
    return result


def emoji_table(settings: Settings) -> list[dict[str, str]]:
    """emoji 全集 × 官方释义。释义缺失的条目留空（前端显示原文 emoji 即可）。"""
    descriptions = _emoji_descriptions(settings)
    table: list[dict[str, str]] = []
    for emoji in allowed_emojis(settings):
        label, description = descriptions.get(emoji, ("", ""))
        table.append({"emoji": emoji, "label": label, "description": description})
    return table


def build_catalog(settings: Settings) -> dict[str, Any]:
    emojis = emoji_table(settings)
    return {
        "ok": True,
        "service": "irodori",
        "language": {
            "supported": ["ja"],
            "note": "仅日语。非日语文本（无假名）会被 NO_JA_ONLY 拒绝，不硬合成。",
        },
        "emoji": {
            "items": emojis,
            "count": len(emojis),
            "note": "官方释义为日文原文。男声参考下 emoji 不改变音高情绪（只影响节奏与插入音）。",
        },
        "caption": {
            "max_chars": 200,
            "note": "只描述情绪/环境/语域，不要描述音色 —— 与参考音频冲突时表现不稳（模型卡警告）。",
            "presets": [
                {"id": "calm", "text": "落ち着いた、近い距離感の女性話者"},
                {"id": "cheerful", "text": "明るく元気で、少し早口な若い女性話者"},
                {"id": "deep", "text": "低く渋い、年配の男性話者、ゆったり話す"},
            ],
        },
        "steps": {
            "default": settings.default_steps,
            "presets": [
                {"value": 20, "label": "平衡（默认）", "note": "实测 RTF 0.246，F0 与时长和 40 步无差"},
                {"value": 40, "label": "最高质量", "note": "更慢，且可能撞上采样长尾（服务端有护栏）"},
            ],
            "range": [1, 120],
            "schedules": [
                {"value": "linear", "label": "linear（默认）"},
                {"value": "sway", "label": "sway（小步数下更稳）"},
            ],
        },
        "duration_scale": {"min": 0.8, "max": 1.5, "default": 1.0,
                           "note": "唯一的时长/节奏数值旋钮；没有 pitch/rate 参数。"},
        "reference": {
            "max_ref_seconds": settings.max_ref_seconds,
            "min_ref_seconds": 3.0,
            "note": "官方建议 ~30s 已拿到大部分收益；多片段长参考在 30-4 接入音色库。",
        },
        "seed": {"note": "同 seed 同输入完全确定（阶段 28 实测）。注意：撞长尾自动降步时，"
                        "只有随机 seed 会被换掉 —— 你显式指定的 seed 一定保留。"},
        # 30-3：护栏参数同样遵循「真源在服务端」。前端拿它渲染「重试（降步）」按钮，
        # 不要自己写死 20 / 180 这两个数。
        "guard": {
            "timeout_sec": settings.timeout_sec,
            "downgrade_steps": settings.downgrade_steps,
            "note": (
                "采样有约 1/40 的长尾（坏 seed + 高步数，实测最坏 89s 出 4.96s 音频）。"
                "多段文本服务端会在段间自动降步并换 seed；单段撞上则由墙钟兜底返回 504，"
                "用 downgrade_steps 重试即可绕开。"
            ),
        },
        "watermark": False,
        # 30-5：训练段常量同样遵循「真源在服务端」。步数档 / batch 上限 / 小档说明
        # 都从 settings 来，UI 不要自己写死 400 / 8 / 2.2 这几个数。
        "training": {
            "steps_presets": [
                {
                    "value": value,
                    "estimated_minutes": round(value * settings.seconds_per_step / 60, 1),
                    "note": ("冒烟小档：只为跑通闭环，具体步数待 30-6 实测回填"
                             if value == settings.smoke_steps
                             else ("官方默认量级" if value >= 2000 else "")),
                }
                for value in settings.train_step_presets
            ],
            "smoke_steps": settings.smoke_steps,
            "max_batch": settings.max_train_batch,
            "seconds_per_step": settings.seconds_per_step,
            "estimate_note": (
                f"按阶段 28 实测 {settings.seconds_per_step}s/步（batch {settings.max_train_batch}"
                " + 梯度检查点，RTX 4060 Laptop）估算，不是保证值。"
            ),
            "s3_ready": False,
            "s3_note": "S3（Speaker Inversion 训练）在 30-6 落地；POST /v1/train 现在返回 501。",
        },
    }

"""音色融合：多个权重加权平均，零训练得到新音色。

RVC「换一个音色就要重新训一个模型」这条局限，最省事的缓解手段不是换架构，
而是**直接对已有权重做插值**。同一架构、同一采样率的两个模型，
它们的权重在参数空间里可以做线性组合，得到的模型往往同时具备两者的特征
（官方文档与社区都把它当作常规用法，上游 `process_ckpt.py:merge()` 也实现了两两融合）。

这里做了两处扩展：

1. **支持 2 个以上模型**：界面可以给每个音色一个滑杆，权重自动归一化；
2. **产物落我们自己的目录**：上游 `merge()` 的输出路径写死在 `assets/weights/`，
   我们写进 `.data/vc/models/`，并保留一份"由谁融合而来"的记录。

融合不是万能的：架构不同（v1 vs v2、32k vs 40k、f0 vs 无 f0）无法融合，
这里会在动手前先把这些不兼容的情况拦下来并说明原因。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Sequence, Tuple

import torch

from ..config import Settings
from .bootstrap import models_dir

__all__ = ["merge_models", "check_compatible"]


def _read_ckpt(path: Path) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    ckpt = torch.load(str(path), map_location="cpu")
    weight = ckpt.get("weight") or ckpt.get("model") or {}
    if not isinstance(weight, dict):
        raise ValueError("%s 里没有可融合的权重字段" % path.name)
    return ckpt, weight


def check_compatible(paths: Sequence[Path]) -> Tuple[bool, str]:
    """判断一组模型能不能互相融合。返回 (是否兼容, 原因)。

    架构签名用 JSON 串比较：config 里混着列表与标量，
    直接丢进 set 会因为内层 list 不可哈希而报 TypeError。
    """
    if len(paths) < 2:
        return False, "至少需要两个模型"
    signatures = []
    for path in paths:
        ckpt, _ = _read_ckpt(path)
        signature = json.dumps(
            {
                "config": list(ckpt.get("config") or []),
                "version": str(ckpt.get("version", "v1")),
                "f0": bool(ckpt.get("f0", 1)),
            },
            sort_keys=True,
        )
        signatures.append(signature)
    if len(set(signatures)) != 1:
        return False, "模型架构不一致（版本 / 采样率 / 是否带 F0 不同），无法融合"
    return True, ""


def merge_models(
    settings: Settings,
    paths: Sequence[Path],
    weights: Sequence[float],
    name: str = "",
) -> Dict[str, Any]:
    """按权重融合多个模型，产物写入模型库。

    `weights` 不需要预先归一化（内部会按总和归一）；全零时退化为等权。
    """
    paths = [Path(p) for p in paths]
    for path in paths:
        if not path.is_file():
            raise ValueError("模型文件不存在：%s" % path)
    ok, reason = check_compatible(paths)
    if not ok:
        raise ValueError(reason)

    total = float(sum(float(w) for w in weights)) or 1.0
    ratios = [float(w) / total for w in weights]

    base_ckpt, base_weight = _read_ckpt(paths[0])
    merged: Dict[str, Any] = {}
    for key, value in base_weight.items():
        if not torch.is_tensor(value):
            merged[key] = value
            continue
        accumulator = value.to(torch.float32) * ratios[0]
        for path, ratio in zip(paths[1:], ratios[1:]):
            _, weight = _read_ckpt(path)
            other = weight.get(key)
            if other is None or not torch.is_tensor(other) or other.shape != value.shape:
                # 形状不一致（典型是 emb_g.weight 的说话人数不同）：取最小的公共部分
                if other is not None and torch.is_tensor(other) and other.dim() == value.dim():
                    slices = tuple(slice(0, min(a, b)) for a, b in zip(value.shape, other.shape))
                    accumulator[slices] += other.to(torch.float32)[slices] * ratio
                continue
            accumulator += other.to(torch.float32) * ratio
        merged[key] = accumulator.to(value.dtype)

    label = (name or "merged").strip()
    target = models_dir(settings) / ("%s.pth" % label)
    payload: Dict[str, Any] = {
        "weight": merged,
        "config": base_ckpt.get("config"),
        "version": base_ckpt.get("version", "v1"),
        "f0": base_ckpt.get("f0", 1),
        "info": "融合：%s" % ", ".join("%s×%.2f" % (p.stem, r) for p, r in zip(paths, ratios)),
    }
    if base_ckpt.get("sr"):
        payload["sr"] = base_ckpt["sr"]
    torch.save(payload, str(target))

    return {
        "path": str(target),
        "name": target.stem,
        "size_mb": round(target.stat().st_size / 1024 / 1024, 1),
        "ratios": {p.stem: round(r, 4) for p, r in zip(paths, ratios)},
        "sources": [str(p) for p in paths],
    }


def merge_two(settings: Settings, path_a: Path, path_b: Path, alpha: float, name: str = "") -> Dict[str, Any]:
    """两模型融合的便捷入口：`alpha` 是第一个模型的占比。"""
    return merge_models(settings, [path_a, path_b], [float(alpha), 1.0 - float(alpha)], name=name)

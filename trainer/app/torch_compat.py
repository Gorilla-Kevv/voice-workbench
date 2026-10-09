"""跨上游的 torch 兼容修补（**不改官方整合包一行代码**）。

背景：GPT-SoVITS 在 `GPT_SoVITS/AR/modules/activation.py` 里做了一件影响全局的事::

    from AR.modules.patched_mha_with_cache import multi_head_attention_forward_patched
    F.multi_head_attention_forward = multi_head_attention_forward_patched

也就是 import 期把 torch 的多头注意力**整体替换**成它自己带 KV-cache 的版本，
进程内所有模型都躲不开。而那个补丁文件的导入列表是::

    from torch.nn.functional import (_mha_shape_check, _canonical_mask,
                                     _none_or_dtype, _in_projection_packed)

**漏了 `_in_projection`** —— 它只在 `use_separate_proj_weight=True` 分支被用到
（q/k/v 三个投影权重分开传的那种调用）。

* GPT-SoVITS 自己的 AR 走 packed 分支（传 `in_proj_weight`），所以从来碰不到，
  这个缺失在官方自己的链路上不会暴露；
* RVC 的内容编码器是 **fairseq 的 HuBERT**（`infer/modules/vc/utils.py::load_hubert`），
  fairseq 的 `MultiheadAttention` 把 `q_proj/k_proj/v_proj` 分开传，正好落在漏掉的
  那个分支上 → 变声一开始就 ``NameError: name '_in_projection' is not defined``。

官方整合包属于「非目标：不改动任何一行」（见 HANDOFF），所以这里不去改补丁文件，
而是**往补丁函数的 globals 里把缺的名字补回去**：

* 不动磁盘上的任何文件，补丁逻辑（KV-cache）保持官方原样；
* 对 GPT-SoVITS 自身无害（它走不到这个分支，等于多了一个可用名字）；
* 进程内只需补一次，且幂等 —— 补丁还没装上时直接返回 False。
"""

from __future__ import annotations

from typing import Any, Dict, Optional

__all__ = ["ensure_mha_patch_complete", "mha_patch_status"]


def _fallback_in_projection(query, key, value, w_q, w_k, w_v, b_q=None, b_k=None, b_v=None):
    """`torch.nn.functional._in_projection` 的等价实现。

    只在 torch 把这个私有名字移走时兜底（整合包 torch 2.0.0 里它有，
    见 `torch/nn/functional.py:4790`）。语义与官方一致：三次线性投影。
    """
    import torch  # noqa: PLC0415 - 只在真正需要兜底时才 import

    return (
        torch.nn.functional.linear(query, w_q, b_q),
        torch.nn.functional.linear(key, w_k, b_k),
        torch.nn.functional.linear(value, w_v, b_v),
    )


def ensure_mha_patch_complete() -> bool:
    """补齐 GPT-SoVITS 的 MHA 补丁缺失的 `_in_projection`。

    返回 True 表示本次真的补上了；False 表示不需要补（补丁未安装 / 已补齐 /
    当前环境没有 torch）。**幂等，可以每次进入上游上下文前调用**。

    调用时机必须覆盖「补丁可能还没装」的情况：GPT-SoVITS 与 RVC 谁先跑是不定的，
    所以不能只在引擎首次初始化时补一次 —— 见 `vc/pipeline.py::VcEngine._context`。
    """
    try:
        import torch.nn.functional as functional  # noqa: PLC0415 - 惰性：别为没装 torch 的环境付代价
    except Exception:  # noqa: BLE001 - 没有 torch 就没有要补的东西
        return False

    patched = getattr(functional, "multi_head_attention_forward", None)
    if patched is None or not callable(patched):
        return False

    module_name = getattr(patched, "__module__", "") or ""
    if "patched_mha" not in module_name:
        # 官方补丁尚未安装（GPT-SoVITS 还没被 import）—— 原生实现本来就是完整的
        return False

    globals_dict = getattr(patched, "__globals__", None)
    if not isinstance(globals_dict, dict):
        return False
    if "_in_projection" in globals_dict:
        return False

    imported = getattr(functional, "_in_projection", None)
    globals_dict["_in_projection"] = imported if callable(imported) else _fallback_in_projection
    return True


def mha_patch_status() -> Dict[str, Any]:
    """给 `/health` / 排障用：当前 `F.multi_head_attention_forward` 的状态。"""
    status: Dict[str, Any] = {
        "patched": False,
        "module": None,
        "in_projection_bound": None,
    }
    try:
        import torch.nn.functional as functional  # noqa: PLC0415
    except Exception:  # noqa: BLE001
        return status

    patched: Optional[Any] = getattr(functional, "multi_head_attention_forward", None)
    if patched is None:
        return status
    module_name = getattr(patched, "__module__", "") or ""
    status["module"] = module_name
    status["patched"] = "patched_mha" in module_name
    if status["patched"]:
        globals_dict = getattr(patched, "__globals__", {}) or {}
        status["in_projection_bound"] = callable(globals_dict.get("_in_projection"))
    return status

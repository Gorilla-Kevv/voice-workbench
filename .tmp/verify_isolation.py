"""进程隔离验证（需要用**整合包自带解释器**跑）。

验证三件事，全是「进程级副作用是否被关住」的直接证据：

  A. 主进程的 torch MHA 保持原生 —— worker 打了补丁，主进程没打
  B. 主进程 cwd 不被改变 —— `os.chdir` 已经被赶到 worker 里
  C. worker 内部确实是脏的（打了补丁、cwd 在整合包根）—— 反证隔离有效

C 很重要：只证明「主进程干净」是不够的，还要证明「脏东西确实存在于某处」，
否则可能是补丁压根没生效（那 RVC 就不再需要它了，结论就完全是另一回事）。

用法（整合包解释器）：
    "F:/schoolCompWorks/clone/ttstool/GPT-SoVITS-v2pro-20250604/runtime/python.exe" \
        .tmp/verify_isolation.py
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "trainer"))

PASSED: list = []
FAILED: list = []


def check(name: str, ok: bool, detail: str = "") -> None:
    (PASSED if ok else FAILED).append(name)
    print("  %s %s%s" % ("PASS" if ok else "FAIL", name, ("  → " + detail) if detail else ""))


def mha_state() -> dict:
    """当前进程里 `F.multi_head_attention_forward` 是不是被替换过。"""
    import torch.nn.functional as F

    func = F.multi_head_attention_forward
    module = getattr(func, "__module__", "") or ""
    name = getattr(func, "__name__", "") or ""
    globals_ = getattr(func, "__globals__", {}) or {}
    return {
        "module": module,
        "name": name,
        # 补丁版函数由 patched_mha_with_cache 提供
        "patched": module != "torch.nn.functional",
        # 补丁版的硬伤：__globals__ 里没有 _in_projection
        "has_in_projection": "_in_projection" in globals_,
    }


def main() -> int:
    print("=" * 70)
    print("进程隔离验证")
    print("解释器：%s" % sys.executable)
    print("主进程 cwd（启动时）：%s" % os.getcwd())
    print("=" * 70)

    cwd_before = os.getcwd()
    before = mha_state()
    print("\n[0] 基线（import 项目模块之前）")
    print("  MHA 实现：%s.%s  patched=%s" % (before["module"], before["name"], before["patched"]))

    # ---------- 导入项目模块 ----------
    from app.config import Settings
    from app.sovits import bootstrap
    from app.sovits.pipeline import Pipeline

    print("\n[1] 导入项目模块后，主进程仍然干净")
    after_import = mha_state()
    check(
        "导入项目模块没有触发官方模块",
        not after_import["patched"],
        "%s.%s" % (after_import["module"], after_import["name"]),
    )

    installation = bootstrap.locate()
    if installation is None:
        print("\n未定位到整合包，无法继续。请设置 GPT_SOVITS_HOME。")
        return 1
    print("  整合包：%s" % installation.home)

    # ---------- 主进程 install（不传 chdir） ----------
    cwd_before_install = os.getcwd()
    bootstrap.install(installation)

    print("\n[2] bootstrap.install() 不再改变主进程 cwd")
    check(
        "主进程 cwd 未被 chdir",
        os.getcwd() == cwd_before_install,
        os.getcwd(),
    )
    check(
        "cwd 仍是启动时的目录",
        os.getcwd() == cwd_before,
    )
    check(
        "cwd 不在整合包目录内",
        not os.getcwd().startswith(str(installation.home)),
    )

    # ---------- 主进程经过一次完整「配置意图」同步 ----------
    settings = Settings()
    settings.ensure_dirs()
    pipeline = Pipeline(settings.data_dir)

    print("\n[3] 主进程走过 configure() 之后仍然干净")
    pipeline.configure(
        version=settings.default_version,
        device=None if settings.device == "auto" else settings.device,
        is_half=settings.is_half,
    )
    after_configure = mha_state()
    check(
        "configure() 没污染主进程 MHA",
        not after_configure["patched"],
        "%s.%s" % (after_configure["module"], after_configure["name"]),
    )
    check("configure() 没改变主进程 cwd", os.getcwd() == cwd_before)

    # ---------- 拉起 worker，让它在里面真的把补丁装上 ----------
    print("\n[4] 拉起 worker，确认脏东西在那边")
    try:
        pipeline._client.ensure_started()
    except Exception as exc:  # noqa: BLE001
        check("worker 成功拉起", False, "%s: %s" % (type(exc).__name__, exc))
        print("\nworker 未起来，跳过 [5][6]")
        return _report()

    hello = pipeline._client.hello or {}
    check("worker 成功拉起", pipeline._client.alive, "pid=%s" % hello.get("pid"))
    check(
        "worker 的 cwd 在整合包根目录",
        str(hello.get("cwd") or "").replace("\\", "/").rstrip("/")
        == str(installation.home).replace("\\", "/").rstrip("/"),
        str(hello.get("cwd")),
    )

    # 让 worker 真正加载官方模块 —— 补丁是在 import 期打上的
    print("\n[5] 在 worker 里加载官方管线（这一步才会打上补丁）")
    try:
        pipeline.warmup(blocking=True)
        check("worker 加载管线成功", True, "%.1fs" % (pipeline.state.load_seconds or 0.0))
    except Exception as exc:  # noqa: BLE001
        check("worker 加载管线成功", False, "%s: %s" % (type(exc).__name__, exc))
        print("  （加载失败不影响隔离结论，但 [6] 的反证做不了）")

    print("\n[6] 隔离生效的最终证据")
    after_all = mha_state()
    check(
        "主进程 MHA 仍然是原生实现",
        not after_all["patched"],
        "%s.%s  patched=%s" % (after_all["module"], after_all["name"], after_all["patched"]),
    )
    check(
        "主进程 MHA 的 __globals__ 里根本没有 _in_projection 这个概念（原生函数）",
        after_all["has_in_projection"],
    )
    check("主进程 cwd 从头到尾没变", os.getcwd() == cwd_before, os.getcwd())

    worker_patched = bool(hello.get("mha_patched")) or None
    if worker_patched is not None:
        check(
            "worker 里 MHA 确实被打过补丁（反证：脏东西真的在那边）",
            worker_patched is True,
            "worker.mha_patched=%s" % worker_patched,
        )

    pipeline.shutdown()
    return _report()


def _report() -> int:
    print("\n" + "=" * 70)
    print("通过 %d 项，失败 %d 项" % (len(PASSED), len(FAILED)))
    if FAILED:
        print("失败项：")
        for name in FAILED:
            print("  - %s" % name)
    print("=" * 70)
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())

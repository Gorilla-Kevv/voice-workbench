"""vendor/ 上游关键模块的导入冒烟测试。

预检脚本（`preflight_vendors.py`）只做静态检查（语法 / import 名 / 依赖），
它回答不了真正的那个问题：**这些模块在当前解释器里到底能不能 import 起来**。
上游代码常常在导入期就读配置、拼权重路径、按 cwd 找文件，静态检查全部通过
也不代表能跑。本脚本补上这一层。

每个上游在**独立的子进程**里试导入：

* 上游会往 `sys.path` 里塞自己的根目录，同一进程里试两个仓库会互相污染；
* 导入失败往往伴随半个初始化（已加载的 torch 扩展无法卸载），
  子进程崩了也不影响下一次尝试。

用法::

    python scripts/smoke_vendors.py             # 全部检查
    python scripts/smoke_vendors.py --only rvc  # 只试 RVC
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path
from typing import List, Tuple

ROOT = Path(__file__).resolve().parents[1]

#: 各上游的关键模块：能 import 成功即说明「直连层有可依赖的入口」
TARGETS: List[Tuple[str, str, List[str]]] = [
    (
        "rvc",
        "vendor/rvc",
        [
            "infer.lib.audio",
            "infer.lib.rmvpe",
            "infer.lib.slicer2",
            "infer.lib.infer_pack.models",
            "infer.modules.vc.modules",
            "infer.modules.vc.pipeline",
        ],
    ),
    (
        "ddsp-svc",
        "vendor/ddsp-svc",
        [
            "ddsp.core",
            "ddsp.vocoder",
            "ddsp.unit2control",
            "encoder",
            "nsf_hifigan",
            "slicer",
        ],
    ),
]

#: 子进程里执行的代码：导入一批模块，把结果打成 JSON 打到 stdout
_WORKER = r"""
import json, sys, traceback
root, modules = sys.argv[1], sys.argv[2:]
sys.path.insert(0, root)
results = []
for name in modules:
    try:
        __import__(name)
        results.append({"module": name, "ok": True, "error": None})
    except Exception as exc:
        results.append({
            "module": name,
            "ok": False,
            "error": "%s: %s" % (type(exc).__name__, exc),
            "detail": traceback.format_exc().splitlines()[-3:],
        })
print("__RESULT__" + json.dumps(results, ensure_ascii=False))
"""


def run(label: str, root: str, modules: List[str]) -> int:
    """在子进程里试导入，返回失败个数。"""
    base = ROOT / root
    if not base.exists():
        print(f"  {label:<10} 未找到 {root}（请先 git submodule update --init）")
        return len(modules)

    proc = subprocess.run(
        [sys.executable, "-c", _WORKER, str(base), *modules],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        cwd=str(ROOT),
    )
    payload = ""
    for line in proc.stdout.splitlines():
        if line.startswith("__RESULT__"):
            payload = line[len("__RESULT__") :]
            break

    if not payload:
        print(f"  {label:<10} 子进程未返回结果（退出码 {proc.returncode}）")
        for line in (proc.stderr or "").splitlines()[-6:]:
            print(f"              {line}")
        return len(modules)

    import json

    results = json.loads(payload)
    failed = [r for r in results if not r["ok"]]
    print(f"  {label:<10} {len(results) - len(failed)}/{len(results)} 个模块可导入")
    # 标记一律用 ASCII：Windows 控制台默认 GBK，打印 ✓/✗ 会直接 UnicodeEncodeError
    for item in results:
        if item["ok"]:
            print(f"              [ok]   {item['module']}")
        else:
            print(f"              [fail] {item['module']} —— {item['error']}")
            for line in item.get("detail", []):
                print(f"                  {line.strip()}")
    return len(failed)


def main() -> int:
    parser = argparse.ArgumentParser(description="vendor/ 上游导入冒烟测试")
    parser.add_argument("--only", choices=["rvc", "ddsp-svc"], help="只测试指定上游")
    args = parser.parse_args()

    print(f"解释器: {sys.version.split()[0]}  ({sys.executable})")
    total_failed = 0
    for label, root, modules in TARGETS:
        if args.only and label != args.only:
            continue
        total_failed += run(label, root, modules)

    print("\n提示：失败项若为 GUI / 训练专用模块，可不计入直连层依赖范围。")
    return 0 if total_failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())

"""阶段 30-1 验证：Irodori 环境与骨架。

跑法：
    python .tmp/verify_irodori_env.py            # 静态核对（不需要 venv）
    python .tmp/verify_irodori_env.py --health   # 额外探一次 /health（需要服务在跑）

检查项（每条都对应 30-1 的一个交付物，不凑数）：
  1. 清单可读且结构完整（entries / code 都有，sizeBytes 全是正整数）
  2. 清单里的 target 不重复、且都在 irodori/ 之内（防手滑写到仓库别处）
  3. inventory.scan() 与文件系统一致（逐个 target 与 os.path 对拍）
  4. 字节数校验确实会拦截断（人为构造一个大小不符的项，必须被判 not ok）
  5. required_vram_mb / step_presets 的口径与用户拍板一致（20 默认、40 在档位里）
  6. server.py --check 能跑通（退出码 0/1 都算通过；崩了才算失败）
  7. （--health）GET /health 带 required_vram_mb / watermark / windecode / pid
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
IRODORI = ROOT / "irodori"
sys.path.insert(0, str(IRODORI))

PASSED: list[str] = []
FAILED: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    if condition:
        PASSED.append(name)
        print(f"  [✓] {name}")
    else:
        FAILED.append(f"{name} —— {detail}")
        print(f"  [x] {name}  {detail}")


def main() -> int:
    from app.config import Settings, load_manifest, required_vram_mb
    from app.inventory import scan

    settings = Settings.from_env()
    manifest = load_manifest()

    print("\n=== 1. 清单结构 ===")
    entries = manifest.get("entries") or []
    codes = manifest.get("code") or []
    check("清单有 entries", len(entries) > 0, f"entries={len(entries)}")
    check("清单有 code", len(codes) > 0, f"code={len(codes)}")
    bad_size = [e.get("id") for e in entries if not isinstance(e.get("sizeBytes"), int) or e["sizeBytes"] <= 0]
    check("每个 entry 的 sizeBytes 是正整数", not bad_size, f"异常项：{bad_size}")
    check("每个 entry 有 source", all(e.get("source") for e in entries))

    print("\n=== 2. target 合法性与唯一性 ===")
    targets = [str(e.get("target") or "") for e in entries] + [str(e.get("target") or "") for e in codes]
    dupes = {t for t in targets if targets.count(t) > 1}
    check("target 无重复", not dupes, f"重复：{dupes}")
    escaped = [t for t in targets if t.startswith("/") or ".." in t]
    check("target 都是 irodori/ 内的相对路径", not escaped, f"越界：{escaped}")
    check("每个 target 都落在 irodori/ 之下", all(IRODORI in settings.target_path(t).parents or settings.target_path(t) == IRODORI for t in targets))

    print("\n=== 3. inventory 与文件系统一致 ===")
    result = scan(settings)
    mismatched: list[str] = []
    for item in result["files"]:
        path = Path(item["path"])
        if item["exists"] != path.is_file():
            mismatched.append(item["target"])
    check("exists 字段与实际文件一致", not mismatched, f"不一致：{mismatched}")
    check("scan 返回分组", len(result["files"]) == len(entries), f"{len(result['files'])} vs {len(entries)}")

    print("\n=== 4. 字节数校验能拦住截断（构造用例）===")
    # 构造「真的被截断」：期望值取实际的一半。
    # ⚠️ 不能只差 1 字节 —— inventory 有 0.5% 容差（那是给 Range 分片边界留的余量），
    # 812MB 的文件差 1 字节是 1e-9 量级，**应当**被判为「已就位」。第一版用例就是这么写错的。
    real_size = Path(settings.target_path(entries[0]["target"])).stat().st_size
    fake_entry = {
        "id": "__probe__",
        "group": "inference",
        "required": True,
        "target": entries[0]["target"],  # 指向一个真实存在的文件
        "sizeBytes": real_size * 2,  # 期望两倍 → 实际只到一半，必然超容差
        "purpose": "构造用例",
    }
    original = list(entries)
    manifest["entries"] = [fake_entry]
    # 直接复用 _entry_state（模块级函数），避免依赖 load_manifest 的磁盘读取
    from app.inventory import _entry_state

    probe_state = _entry_state(settings, fake_entry)
    check(
        "大小不符时 ok=False 且 note 提示截断",
        probe_state["ok"] is False and "截断" in probe_state["note"],
        f"ok={probe_state['ok']} note={probe_state['note']}",
    )
    manifest["entries"] = original

    print("\n=== 5. 拍板口径落地 ===")
    check("默认步数 = 20", settings.default_steps == 20, f"实际 {settings.default_steps}")
    check("步数档位含 20 与 40", set(settings.step_presets) == {20, 40}, f"实际 {settings.step_presets}")
    check("准入基准 > 0 且是 int", isinstance(required_vram_mb(settings.precision), int) and required_vram_mb() > 0)
    check("端口 = 9884", settings.port == 9884, f"实际 {settings.port}")
    check("max_ref_seconds = 120", settings.max_ref_seconds == 120, f"实际 {settings.max_ref_seconds}")

    print("\n=== 6. server.py --check 能跑通 ===")
    proc = subprocess.run(
        [sys.executable, str(IRODORI / "server.py"), "--check", "--json"],
        capture_output=True,
        text=True,
        cwd=str(ROOT),
        timeout=120,
    )
    check("--check 退出码是 0 或 1（未崩）", proc.returncode in (0, 1), f"退出码 {proc.returncode} / {proc.stderr[:200]}")
    try:
        payload = json.loads(proc.stdout)
        check("--json 输出是合法 JSON", True)
        check("--json 含 weights.groups", "groups" in payload.get("weights", {}))
        check("--json 含 required_vram_mb", "required_vram_mb" in payload)
        check("--json 含 windecode 状态", "windecode" in payload)
    except Exception as error:
        check("--json 输出是合法 JSON", False, str(error))

    if "--health" in sys.argv:
        print("\n=== 7. /health 探活 ===")
        import urllib.request

        try:
            with urllib.request.urlopen("http://127.0.0.1:9884/health", timeout=15) as response:
                body = json.loads(response.read().decode("utf-8"))
            check("/health 200 且 ok=true", body.get("ok") is True)
            check("带 required_vram_mb", isinstance(body.get("configuration", {}).get("required_vram_mb"), int))
            check("watermark 显式为 False", body.get("watermark") is False)
            check("带 pid（网关据此确证端口归属）", isinstance(body.get("pid"), int))
            check("带 windecode 状态", "windecode" in body)
            check("带 weights.ready", isinstance(body.get("weights", {}).get("ready"), bool))
        except Exception as error:
            check("/health 可访问", False, f"{type(error).__name__}: {error}")

    print(f"\n{'=' * 60}")
    print(f"通过 {len(PASSED)} 项，失败 {len(FAILED)} 项")
    for item in FAILED:
        print(f"  ✗ {item}")
    return 1 if FAILED else 0


if __name__ == "__main__":
    raise SystemExit(main())

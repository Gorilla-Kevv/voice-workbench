"""网易模块环境预检（不启动服务）。

    python scripts/preflight_netease.py            # 人类可读报告
    python scripts/preflight_netease.py --json     # 机器可读

用法建议：用 **netease venv 的解释器** 跑本脚本 ——
    netease/.venv/Scripts/python scripts/preflight_netease.py
用系统 Python 跑也可以（报告 torch 缺失），但那不是 netease 服务的真实视角。

检查项与退出码：0 = 全部就绪；1 = 有阻断项（依赖缺失 / 解释器不符 / 端口被占）。
权重缺失只警告不阻断 —— 服务要能「无权重启动并如实报告」。
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import shutil
import socket
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NETEASE_DIR = ROOT / "netease"
sys.path.insert(0, str(NETEASE_DIR))


def check(name: str, ok: bool, detail: str, *, blocking: bool = True) -> dict:
    return {"name": name, "ok": ok, "detail": detail, "blocking": blocking}


def _version_at_least(version: str, minimum: tuple[int, int]) -> bool:
    try:
        parts = tuple(int(part) for part in version.split("."))
        return parts[: len(minimum)] >= minimum
    except ValueError:
        return False


def driver_cuda_version() -> str | None:
    """nvidia-smi 报告的驱动 CUDA Version（决定能装 cu126 还是 cu128 的 torch）。"""
    import re

    nvidia_smi = shutil.which("nvidia-smi")
    if not nvidia_smi:
        return None
    try:
        output = subprocess.run(
            [nvidia_smi], capture_output=True, text=True, timeout=10, check=False
        ).stdout
        match = re.search(r"CUDA Version:\s*([\d.]+)", output)
        return match.group(1) if match else None
    except Exception:
        return None


def main() -> int:
    parser = argparse.ArgumentParser(prog="preflight_netease", description="网易模块环境预检")
    parser.add_argument("--json", action="store_true", help="以 JSON 输出")
    parser.add_argument("--port", type=int, default=9882)
    parser.add_argument(
        "--allow-missing-asr",
        action="store_true",
        help="把 R2T2 相关项降为警告：没建离线转写环境（r2t2-venv）时只跑 TTS 用",
    )
    args = parser.parse_args()

    from app.config import Settings  # noqa: PLC0415
    from app.r2t2 import R2T2Manager  # noqa: PLC0415
    from app.tts_engine import TtsPipeline  # noqa: PLC0415

    settings = Settings.from_env()
    checks: list[dict] = []

    # 1. 解释器
    version = f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"
    checks.append(
        check(
            "Python ≥ 3.10",
            sys.version_info >= (3, 10),
            f"当前 {version}",
        )
    )

    # 2. torch / CUDA
    try:
        import torch

        checks.append(check("torch", True, torch.__version__))
        cuda_ok = bool(torch.cuda.is_available())
        checks.append(check("torch CUDA 可用", cuda_ok, "cuda 可用" if cuda_ok else "torch 没有 CUDA（需 cu126 及以上）"))
        if cuda_ok:
            free, total = torch.cuda.mem_get_info(0)
            checks.append(
                check(
                    "显存",
                    free // (1024 * 1024) >= 4096,
                    f"空闲 {free // (1024 * 1024)} MB / 共 {total // (1024 * 1024)} MB（TTS 建议空闲 ≥ 6 GB）",
                    blocking=False,
                )
            )
    except Exception as error:
        checks.append(check("torch", False, f"{type(error).__name__}: {error}"))

    # 3. 驱动 CUDA（装 torch 前用得上）
    driver_cuda = driver_cuda_version()
    checks.append(
        check(
            "驱动 CUDA ≥ 12.6",
            driver_cuda is not None and _version_at_least(driver_cuda, (12, 6)),
            f"nvidia-smi 报告 {driver_cuda or '未找到 nvidia-smi'}",
            blocking=False,
        )
    )

    # 4. 服务自身依赖
    for module_name in ("fastapi", "uvicorn", "pydantic", "multipart", "soundfile"):
        try:
            __import__(module_name)
            checks.append(check(f"依赖 {module_name}", True, "ok"))
        except Exception as error:
            checks.append(check(f"依赖 {module_name}", False, str(error)))

    # 5. 上游模型包
    tts = TtsPipeline(settings)
    asr = R2T2Manager(settings)
    tts_install = tts.probe_install()
    asr_install = asr.probe_install()
    checks.append(
        check(
            "confuciustts 包",
            tts_install["package"]["importable"],
            "可导入" if tts_install["package"]["importable"] else str(tts_install["package"].get("missing")),
        )
    )
    checks.append(
        check(
            "TTS 权重",
            tts_install["installed"],
            "; ".join(tts_install["missing"]) or f"就位（HF 缓存 {len(tts_install['weights_cached'])} 项）",
            blocking=False,
        )
    )
    if tts_install["missing"]:
        checks.append(
            check(
                "TTS 权重下载",
                False,
                f"补齐：{tts_install['download_hint']}（TTS 侧实测 11.5 GB，不是早期文档估的 54 GB）",
                blocking=False,
            )
        )

    # 5b / 6. R2T2：后端决定体检口径
    #   - transformers（默认，Windows 原生离线）：查 R2T2 专用解释器里 qwen_asr + r2t2 可导入；
    #   - vllm（WSL 完整能力）：查 vllm 可导入。
    # 解释器是独立 venv（qwen-asr 钉死 transformers==4.57.6，与 TTS venv 的 4.52.4 互斥），
    # 所以这里用子进程探它的真实导入性，而不是拿服务自己的解释器查。
    asr_blocking = not args.allow_missing_asr
    backend = settings.r2t2_backend
    # 解释器解析（env → r2t2-venv 自动探测 → python）在 Settings.resolved_r2t2_python
    # 一处收口，preflight 与服务/launcher 看到的是同一个值
    r2t2_python = settings.resolved_r2t2_python

    def probe_r2t2_interpreter(python_cmd: str, modules: tuple[str, ...]) -> tuple[bool, str]:
        import subprocess

        code = "import " + ", ".join(modules)
        # 与 app/r2t2.py::_spawn 同款切词规则：绝对路径是 Windows 路径形态，
        # 必须按 posix=False 切（默认的 posix=True 会把反斜杠当转义吞掉，
        # `F:\a\python.exe` 直接变 `F:apython.exe` → WinError 2）
        parts = shlex.split(python_cmd, posix=False) if Path(python_cmd).is_absolute() else shlex.split(python_cmd)
        try:
            proc = subprocess.run(  # noqa: S603
                [*parts, "-c", code],
                capture_output=True,
                text=True,
                timeout=60,
            )
        except Exception as error:
            return False, f"无法运行解释器 {python_cmd}：{type(error).__name__}: {error}"
        if proc.returncode == 0:
            return True, "可导入"
        detail = (proc.stderr or proc.stdout or "").strip().splitlines()
        return False, detail[-1][:200] if detail else f"exit={proc.returncode}"

    if backend == "vllm":
        checks.append(
            check("R2T2 后端", True, f"vllm（解释器 {r2t2_python}）", blocking=False)
        )
        vllm_ok, vllm_detail = probe_r2t2_interpreter(r2t2_python, ("vllm",))
        checks.append(
            check(
                "vllm 包（R2T2 解释器）",
                vllm_ok,
                f"{vllm_detail}；vLLM 只有 Linux wheel，Windows 原生装不了，WSL 部署见 netease/README.md",
                blocking=asr_blocking,
            )
        )
    else:
        checks.append(
            check("R2T2 后端", True, f"transformers（离线，解释器 {r2t2_python}）", blocking=False)
        )
        mods_ok, mods_detail = probe_r2t2_interpreter(r2t2_python, ("qwen_asr", "r2t2"))
        checks.append(
            check(
                "qwen_asr + r2t2 包（R2T2 解释器）",
                mods_ok,
                (
                    mods_detail
                    if mods_ok
                    else f"{mods_detail}；按 netease/README.md「R2T2」节建 netease/r2t2-venv（约 6 GB），"
                    "或加 --allow-missing-asr 只跑 TTS"
                ),
                blocking=asr_blocking,
            )
        )
    checks.append(check("R2T2 模型", asr_install["installed"], "; ".join(asr_install["missing"]) or "就位", blocking=False))

    # 7. 端口
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(1)
    port_free = sock.connect_ex(("127.0.0.1", args.port)) != 0
    sock.close()
    checks.append(check(f"端口 {args.port} 空闲", port_free, "空闲" if port_free else "已被占用（服务已在跑或端口冲突）"))

    # 8. 磁盘预算
    try:
        usage = shutil.disk_usage(NETEASE_DIR)
        free_gb = usage.free / (1024**3)
        checks.append(
            check(
                "磁盘余量 ≥ 20 GB",
                free_gb >= 20,
                f"剩余 {free_gb:.0f} GB（TTS 侧实际下载 5.4 GB，加 R2T2 共 9.5 GB；另留 torch 2.6 GB 与产物）",
                blocking=False,
            )
        )
    except Exception as error:
        checks.append(check("磁盘余量", False, str(error), blocking=False))

    blockers = [item for item in checks if item["blocking"] and not item["ok"]]

    if args.json:
        print(json.dumps({"ok": not blockers, "checks": checks, "blockers": blockers}, ensure_ascii=False, indent=2))
    else:
        print("网易模块环境预检（netease/）")
        print("=" * 56)
        for item in checks:
            mark = "✓" if item["ok"] else ("✗" if item["blocking"] else "!")
            print(f"  [{mark}] {item['name']}: {item['detail']}")
        print()
        if blockers:
            print("有阻断项：先解决上面标 ✗ 的条目（参考 netease/README.md），再重跑本脚本。")
        else:
            print("阻断项已清零（! 为警告不阻断）。启动：npm run dev:netease")
    return 1 if blockers else 0


if __name__ == "__main__":
    raise SystemExit(main())

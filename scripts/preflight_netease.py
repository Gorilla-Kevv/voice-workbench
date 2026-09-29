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
        help="把 R2T2（vLLM）相关项降为警告：Windows 无 vLLM 发行包，只跑 TTS 时用",
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

    # 5b / 6. R2T2：Windows 上没有 vLLM 发行包，允许显式降级为「只校验 TTS」
    asr_blocking = not args.allow_missing_asr
    asr_hint = (
        "Windows 无 vLLM 官方发行包（PyPI 上 vllm 只有 Linux wheel），R2T2 无法在本机原生运行；"
        "可选路径：WSL2 或 Docker（官方推荐镜像 qwenllm/qwen3-asr）。只跑 TTS 请加 --allow-missing-asr。"
        if os.name == "nt"
        else "按 netease/README.md 装 r2t2 + vllm（Python 3.10+）。"
    )
    try:
        import r2t2  # noqa: F401,PLC0415

        checks.append(check("r2t2 包", True, "可导入"))
    except Exception as error:
        checks.append(
            check(
                "r2t2 包",
                False,
                f"{type(error).__name__}: {error}；{asr_hint}",
                blocking=asr_blocking,
            )
        )
    checks.append(check("R2T2 模型", asr_install["installed"], "; ".join(asr_install["missing"]) or "就位", blocking=False))

    try:
        import vllm  # noqa: F401,PLC0415

        checks.append(check("vllm 包", True, getattr(vllm, "__version__", "ok")))
    except Exception as error:
        checks.append(check("vllm 包", False, f"{type(error).__name__}: {error}；{asr_hint}", blocking=asr_blocking))

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

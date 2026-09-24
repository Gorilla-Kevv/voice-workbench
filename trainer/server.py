"""GPT-SoVITS 本地服务入口。

    python server.py                    # 本地模式（默认）
    python server.py --check            # 只做环境体检，不启动服务
    python server.py --check --json     # 体检结果以 JSON 输出（便于脚本消费）
    python server.py --mode public      # 局域网共享：开启鉴权与配额
    python server.py --port 9881 --home D:/GPT-SoVITS

**解释器自举**是本文件最重要的职责。torch 装在哪，模型就在哪跑；
而用户很可能是用系统 Python 敲的 `python server.py`。所以启动前会先判断
当前解释器有没有 torch，没有就去整合包自带的 runtime 里找，找到了就用它
重新执行自己（`os.execv`，只重入一次）。这样「一条命令跑起来」才成立，
而不是要求用户先搞清楚该用哪个 python。

顺带把「下一步该做什么」直接打印出来 —— 本地排障最怕的是对着一串
traceback 猜缺了什么。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import webbrowser
from pathlib import Path

TRAINER_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(TRAINER_DIR))

from app import __version__  # noqa: E402
from app.api import Context, create_app, register_runners  # noqa: E402
from app.config import Settings  # noqa: E402
from app.runtime import probe, probe_current  # noqa: E402
from app.sovits import bootstrap  # noqa: E402

BANNER = r"""
   ______ _______        _______             _   _______ ______
  / _____|__   __|      / ____\ \           | | / /_   _|__   __|/ ____|
 | |  __   | |  ______| (___  \ \   ______  | |/ /  | |    | |  | (___
 | | |_ |  | | |______|\___ \  \ \ |______| |    \  | |    | |   \___ \
 | |__| |  | |         ____) |  \ \         | |\  \_| |_   | |   ____) |
  \_____|  |_|        |_____/    \_\        |_| \_\_____|  |_|  |_____/
        GPT-SoVITS 本地语音工作台 · 推理 / 训练 / 批量合成
"""

#: 自举重入的环境变量守卫，避免无限重启
REEXEC_FLAG = "TTS_SELF_BOOTSTRAPPED"


def parse_args(argv=None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="trainer",
        description="GPT-SoVITS 本地语音工作台服务",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "示例：\n"
            "  python server.py --check          # 只体检\n"
            "  python server.py --home D:/GPT-SoVITS\n"
            "  python server.py --mode public --port 9881\n"
        ),
    )
    parser.add_argument("--mode", choices=["local", "public"], help="覆盖 TTS_MODE")
    parser.add_argument("--host", help="监听地址（默认 127.0.0.1）")
    parser.add_argument("--port", type=int, help="监听端口（默认 9881）")
    parser.add_argument("--home", help="GPT-SoVITS 根目录，覆盖 GPT_SOVITS_HOME")
    parser.add_argument("--device", help="cuda:0 / cpu / auto")
    parser.add_argument("--version", dest="model_version", help="默认模型版本，如 v2ProPlus")
    parser.add_argument("--no-warmup", action="store_true", help="启动后不预加载模型")
    parser.add_argument("--no-open", action="store_true", help="启动后不自动打开浏览器")
    parser.add_argument("--reload", action="store_true", help="开发模式热重载")
    parser.add_argument("--dry-run", action="store_true", help="只打印将要执行的命令")
    parser.add_argument("--check", action="store_true", help="只做环境体检后退出")
    parser.add_argument("--json", action="store_true", help="体检结果以 JSON 输出")
    return parser.parse_args(argv)


def apply_args(args: argparse.Namespace) -> None:
    """命令行参数统一落到环境变量，保证全局只有一份配置。"""
    if args.mode:
        os.environ["TTS_MODE"] = args.mode
    if args.home:
        os.environ["GPT_SOVITS_HOME"] = args.home
    if args.host:
        os.environ["HOST"] = args.host
    if args.port:
        os.environ["PORT"] = str(args.port)
    if args.device:
        os.environ["TTS_DEVICE"] = args.device
    if args.model_version:
        os.environ["TTS_DEFAULT_VERSION"] = args.model_version
    if args.dry_run:
        os.environ["TTS_DRY_RUN"] = "1"


# --------------------------------------------------------------------------
# 解释器自举
# --------------------------------------------------------------------------


def current_interpreter_has_torch() -> bool:
    try:
        import torch  # noqa: PLC0415

        return True
    except Exception:  # noqa: BLE001
        return False


def maybe_reexec(settings: Settings) -> bool:
    """若当前解释器缺 torch，而整合包自带解释器可用，则用它重新执行自己。

    返回 True 表示已经完成重入（调用方应立即结束本进程）。
    """
    if current_interpreter_has_torch() or os.environ.get(REEXEC_FLAG) == "1":
        return False
    if settings.skip_ready_check:
        return False

    installation = bootstrap.locate(
        str(settings.gpt_sovits_home) if settings.gpt_sovits_home else None,
        auto_discover=settings.auto_discover,
    )
    if installation is None or not installation.python_executable:
        return False

    bundled = installation.python_executable
    # 已经就是它自己了（例如用户直接用 runtime/python.exe 启动）
    if os.path.abspath(bundled).lower() == os.path.abspath(sys.executable).lower():
        return False

    probe_result = probe(bundled, timeout=180)
    if not probe_result.has_torch:
        print(
            "  [!] 整合包自带解释器缺少 torch，无法自动切换：%s\n      %s"
            % (bundled, probe_result.torch_error or probe_result.probe_error or "原因未知")
        )
        return False

    print("  [→] 当前解释器没有 torch，改用 GPT-SoVITS 自带解释器重新启动：")
    print("      %s" % bundled)
    print("      （torch %s，%s）" % (probe_result.torch_version, probe_result.device_label))
    print()

    env = os.environ.copy()
    env[REEXEC_FLAG] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUNBUFFERED"] = "1"
    args = [bundled, str(Path(__file__).resolve())] + sys.argv[1:]
    try:
        os.execve(bundled, args, env)
    except OSError as exc:
        print("  [×] 切换失败：%s" % exc)
        return False
    return True  # 理论上到不了这里


# --------------------------------------------------------------------------
# 体检报告
# --------------------------------------------------------------------------


def collect_report(settings: Settings, ctx: Context) -> dict:
    """把体检结果整理成结构化数据，供打印与 /health 共用。"""
    installation = bootstrap.current()
    runtime = probe_current()
    blockers = ctx.blockers()

    layout = None
    if installation is not None:
        layout = installation.layout.to_dict()
        layout["python_executable"] = installation.python_executable

    from app import weights as weights_audit  # noqa: PLC0415 - server.py 是顶层脚本，只能绝对导入

    capabilities = ctx.capabilities()
    return {
        "version": __version__,
        "settings": settings.to_dict(),
        "layout": layout,
        "runtime": runtime.to_dict(),
        "pipeline": ctx.pipeline.status(),
        "voices": {"total": len(ctx.voices.list())},
        # 两个新板块：vendor 是否拉取、必需权重是否就位、模型库里有几个音色
        "extras": {
            "vendors": {
                "rvc": {"path": str(settings.rvc_dir), "found": Path(settings.rvc_dir).is_dir()},
                "svc": {"path": str(settings.ddsp_dir), "found": Path(settings.ddsp_dir).is_dir()},
            },
            "missing_weights": {
                engine: [
                    w.key
                    for w in weights_audit.WEIGHTS
                    if w.engine == engine and w.required and not weights_audit.target_path(w, settings).is_file()
                ]
                for engine in ("rvc", "svc")
            },
            "models": {
                "rvc": len(list(Path(settings.vc_dir / "models").glob("*.pth"))),
                "svc": len(list(Path(settings.svc_dir / "models").glob("*.pt"))),
            },
            "capabilities": {
                "separation": capabilities["separation"],
                "voice_conversion": capabilities["voice_conversion"],
                "singing_conversion": capabilities["singing_conversion"],
            },
        },
        "blockers": blockers,
        "warnings": settings.warnings(),
        "hints": ctx.hints(),
        "ready": not blockers,
    }


def print_report(report: dict) -> None:
    print(BANNER)
    settings = report["settings"]
    mode = settings["mode"]
    suffix = "（局域网共享 · 鉴权 + 配额）" if mode == "public" else "（本机 · 免鉴权）"
    print("  模式      : %s%s" % (mode, suffix))
    print("  地址      : http://%s:%s" % (_display_host(settings["host"]), settings["port"]))
    print("  数据目录  : %s" % settings["data_dir"])
    print()

    layout = report["layout"]
    if layout is None:
        print("  [×] 未发现 GPT-SoVITS 安装")
        print("      → 设置环境变量 GPT_SOVITS_HOME 指向其根目录，")
        print("        或把整合包解压到项目同级目录后重启")
        print()
    else:
        print("  [√] 已发现 GPT-SoVITS")
        print("      根目录    : %s" % layout["home"])
        print("      版本线索  : %s" % layout["variant"])
        print("      自带解释器: %s" % (layout.get("python_executable") or "无（使用当前解释器）"))
        print(
            "      推理入口  : %s / 训练入口: %s / 数据预处理: %s"
            % (
                "可用" if layout["can_infer"] else "缺失",
                "可用" if layout["can_train"] else "缺失",
                "可用" if layout["can_prepare"] else "缺失",
            )
        )
        print()
        print("  工具链    : %s" % ("、".join(sorted(layout["tools"])) or "未发现"))
        print()

    runtime = report["runtime"]
    print("  [%s] 运行环境" % ("√" if runtime["can_infer"] else "×"))
    print("      解释器  : %s (Python %s)" % (runtime["executable"], runtime["python_version"]))
    print("      设备    : %s" % runtime["device_label"])
    print("      torch   : %s" % (runtime["torch_version"] or "未安装"))
    if runtime["missing_libs"]:
        print("      缺失依赖: %s" % "、".join(runtime["missing_libs"]))
    if runtime["torch_error"]:
        print("      torch 错误: %s" % runtime["torch_error"])
    print()

    pipeline = report["pipeline"]
    print("  推理管线  : %s" % ("已加载" if pipeline["loaded"] else "未加载（首次合成时自动加载）"))
    print("      目标版本: %s / 设备: %s / 半精度: %s"
          % (pipeline["target_version"], pipeline["target_device"], pipeline["target_is_half"]))
    print("      音色库  : %d 条" % report["voices"]["total"])
    print()

    extras = report.get("extras")
    if extras:
        print("  新板块    :")
        labels = (("rvc", "语音变声"), ("svc", "歌声转换"))
        for key, label in labels:
            vendor = extras["vendors"][key]
            missing = extras["missing_weights"].get(key) or []
            if not vendor["found"]:
                status = "缺源码（git submodule update --init）"
            elif missing:
                status = "缺权重 %s（scripts/download_models.py --engine %s）" % (
                    "、".join(missing),
                    "rvc" if key == "rvc" else "svc",
                )
            else:
                status = "可用（%d 个音色）" % extras["models"][key]
            print("      %s  : %s" % (label, status))
        print("      分离    : %s" % ("可用（UVR5 随整合包）" if extras["capabilities"]["separation"] else "不可用"))
        print()

    blockers = report["blockers"]
    if blockers:
        print("  尚未就绪，请先完成以下步骤：")
        for index, issue in enumerate(blockers, start=1):
            print("    %d. %s" % (index, issue))
        print()
        print("  说明：服务仍会启动，/health 会持续返回同样的指引，方便排障时随时查看。")
    else:
        print("  [√] 全部就绪，可直接开始使用")
    print()

    for tip in report["warnings"]:
        print("  提示：%s" % tip)
    for hint in report["hints"]:
        print("  建议：%s" % hint)
    print()


def _display_host(host: str) -> str:
    return "127.0.0.1" if host in {"0.0.0.0", "::"} else host


# --------------------------------------------------------------------------
# 装配
# --------------------------------------------------------------------------


def build_context(settings: Settings) -> Context:
    installation = bootstrap.locate(
        str(settings.gpt_sovits_home) if settings.gpt_sovits_home else None,
        auto_discover=settings.auto_discover,
    )
    if installation is not None:
        bootstrap.install(installation)

    settings.ensure_dirs()
    ctx = Context(settings)
    ctx.installation = installation

    # 设备与版本偏好落到管线意图上（真正加载推迟到第一次合成或 warmup）
    device = settings.device if settings.device != "auto" else None
    ctx.pipeline.configure(
        version=settings.default_version,
        device=device,
        is_half=settings.is_half,
    )
    register_runners(ctx)
    return ctx


def main(argv=None) -> int:
    args = parse_args(argv)
    apply_args(args)

    settings = Settings.from_env()

    if args.check:
        return run_check(settings, args.json)

    if os.environ.get(REEXEC_FLAG) != "1":
        if maybe_reexec(settings):
            return 0
        # 重新读取：自举可能改变了环境（例如 home 的自动发现结果）
        settings = Settings.from_env()

    ctx = build_context(settings)
    report = collect_report(settings, ctx)
    if not args.json:
        print_report(report)
    else:
        print(json.dumps(report, ensure_ascii=False, indent=2))

    if settings.warmup and not args.no_warmup and not report["blockers"]:
        ctx.pipeline.warmup(blocking=False)
        if not args.json:
            print("  已开始后台预加载模型（首个请求无需等待）")
            print()

    app = create_app(ctx)

    url = "http://%s:%s/health" % (_display_host(settings.host), settings.port)
    if not args.no_open and not settings.is_public:
        try:
            webbrowser.open(url)
        except OSError:
            pass

    try:
        import uvicorn  # noqa: PLC0415
    except ImportError:
        print("缺少 uvicorn，请安装服务依赖： pip install -r requirements.txt")
        return 1

    uvicorn.run(
        app,
        host=settings.host,
        port=settings.port,
        reload=args.reload,
        log_level="debug" if settings.verbose else "info",
    )
    return 0


def run_check(settings: Settings, as_json: bool) -> int:
    """只做体检。退出码：0 就绪，1 未就绪 —— 便于脚本串联。"""
    if os.environ.get(REEXEC_FLAG) != "1":
        if maybe_reexec(settings):
            return 0
        settings = Settings.from_env()

    ctx = build_context(settings)
    # 体检时不要顺手把模型加载起来：用户可能只是想看看环境
    report = collect_report(settings, ctx)
    if as_json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print_report(report)
    return 0 if report["ready"] else 1


if __name__ == "__main__":
    raise SystemExit(main())

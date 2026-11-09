"""PyMSS 训练流水线 CLI：给 `training.py::_step_uvr` 用（运行在 pymss/.venv）。

与 `trainer/tools/uvr_cli.py` 的参数语义对齐，但底层走 PyMSS 的 Python API。
输出命名 `<输入名>_<Stem>.<format>`；训练后续步骤只扫描目录，不依赖具体文件名。
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

AUDIO_SUFFIXES = {".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aac", ".wma"}


def _stems_for(model: str) -> tuple[str, str | None]:
    """返回 (人声 stem, 伴奏 stem)。DeEcho 系没有“伴奏”，干净一路是 No Echo/Reverb。"""
    name = Path(model).stem.lower()
    if "deecho" in name and "dereverb" in name:
        return "No Reverb", None
    if "deecho" in name:
        return "No Echo", None
    return "vocals", "instrumental"


def main() -> int:
    parser = argparse.ArgumentParser(description="PyMSS 训练语料分离/净化")
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--model", required=True, help="PyMSS 模型名，如 7_HP2-UVR.pth")
    parser.add_argument("-i", "--input", required=True, help="输入音频文件或目录")
    parser.add_argument("--vocal-root", default="", help="人声/净化输出目录")
    parser.add_argument("--ins-root", default="", help="伴奏输出目录（DeEcho 系忽略）")
    parser.add_argument("--format", default="wav", choices=["wav", "flac", "mp3", "m4a"])
    parser.add_argument("--device", default="cuda", choices=["cuda", "cpu", "auto"])
    parser.add_argument("--agg", type=int, default=10)
    args = parser.parse_args()

    vocal_root = Path(args.vocal_root) if args.vocal_root else None
    ins_root = Path(args.ins_root) if args.ins_root else None
    if vocal_root is None and ins_root is None:
        print("至少要指定 --vocal-root 或 --ins-root", file=sys.stderr)
        return 1

    input_path = Path(args.input)
    if not input_path.exists():
        print("输入不存在：%s" % input_path, file=sys.stderr)
        return 1

    vocal_stem, ins_stem = _stems_for(args.model)
    store_dirs: dict[str, str] = {}
    if vocal_root is not None:
        vocal_root.mkdir(parents=True, exist_ok=True)
        store_dirs[vocal_stem] = str(vocal_root)
    if ins_root is not None and ins_stem is not None:
        ins_root.mkdir(parents=True, exist_ok=True)
        store_dirs[ins_stem] = str(ins_root)

    try:
        from pymss import create_separator  # noqa: PLC0415

        separator = create_separator(
            args.model,
            model_dir=args.model_dir,
            device=args.device,
            output_format=args.format,
            store_dirs=store_dirs,
            inference_params={"aggression": int(args.agg)},
        )
        separator.process_folder(str(input_path))
    except Exception as exc:  # noqa: BLE001
        print("PyMSS 训练分离失败：%s: %s" % (type(exc).__name__, exc), file=sys.stderr)
        return 1

    # 给训练日志一个可读的成功信号（不写 stdout 协议，训练只收 exit code）
    print("PyMSS 完成：%s -> %s" % (args.model, ", ".join(store_dirs)), file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

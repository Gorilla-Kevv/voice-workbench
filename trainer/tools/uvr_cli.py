"""UVR5 人声/伴奏分离 & 去混响 & 去延迟 —— 非交互式命令行封装。

官方只提供了 Gradio 版本（`tools/uvr5/webui.py`），没法集成进训练流水线。
但它界面背后的实质逻辑只是三件事：选模型、建推理对象、对每个音频调
`_path_audio_()`；算法本体全在 `tools/uvr5/vr.py`、`mdxnet.py`、
`bsroformer.py` 里，是可以直接调用的。

所以这个文件做的事，就是把 `webui.py` 里 `uvr()` 函数去掉 gradio 包装后
照抄过来，**不改动官方任何一行代码**。

两个从官方源码里读出来、必须注意的细节：

1. `vr.py` 用的是相对导入（`from lib.lib_v5 import ...`），必须把
   `tools/uvr5` 放进 `sys.path`，否则 import 失败。
2. `AudioPreDeEcho._path_audio_` 的参数顺序是
   `(music_file, vocal_root, ins_root, ...)`，而 `AudioPre` 的是
   `(music_file, ins_root, vocal_root, ...)` —— **两个类的 vocal/ins 是反的**
   （官方源码注释：「3个VR模型vocal和ins是反的」）。
   这里一律用关键字参数调用，避开这个坑。

用法：
    python uvr_cli.py --home <GPT-SoVITS根目录> --model HP2_all_vocals \
        -i <输入目录> -o-vocal <人声输出目录> -o-ins <伴奏输出目录> \
        --agg 10 --format flac --device cuda:0 --half
"""

from __future__ import annotations

import argparse
import os
import sys
import traceback
from pathlib import Path

AUDIO_SUFFIXES = {".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aac", ".wma", ".opus"}


def _bootstrap_uvr5(home: str) -> None:
    """把官方 tools/uvr5 挂进 sys.path。

    vr.py / mdxnet.py / bsroformer.py 内部用的是相对导入
    （`from lib.lib_v5 import ...`），只有把它们所在目录放进 sys.path 才能 import。
    """
    uvr5_dir = Path(home) / "tools" / "uvr5"
    if not uvr5_dir.is_dir():
        raise SystemExit("未找到官方目录：%s" % uvr5_dir)
    # 放最前面：官方目录里可能有与第三方同名的模块，优先用官方的
    sys.path.insert(0, str(uvr5_dir))


def _list_audio(directory: Path) -> list[Path]:
    return sorted(p for p in directory.iterdir() if p.is_file() and p.suffix.lower() in AUDIO_SUFFIXES)


def build_processor(home: str, model_name: str, agg: int, device: str, is_half: bool):
    """按模型名建官方推理对象，分派逻辑与 webui.py 保持一致。"""
    weight_root = Path(home) / "tools" / "uvr5" / "uvr5_weights"

    if model_name == "onnx_dereverb_By_FoxJoy":
        from mdxnet import MDXNetDereverb  # noqa: PLC0415

        return MDXNetDereverb(15)

    if "roformer" in model_name.lower():
        from bsroformer import Roformer_Loader  # noqa: PLC0415

        config = weight_root / ("%s.yaml" % model_name)
        if not config.is_file():
            raise SystemExit(
                "模型 %s 缺少同名配置文件 %s，无法加载。可把 yaml 放进 %s 后重试。"
                % (model_name, config.name, weight_root)
            )
        return Roformer_Loader(
            model_path=str(weight_root / ("%s.ckpt" % model_name)),
            config_path=str(config),
            device=device,
            is_half=is_half,
        )

    from vr import AudioPre, AudioPreDeEcho  # noqa: PLC0415

    weight = weight_root / ("%s.pth" % model_name)
    if not weight.is_file():
        raise SystemExit("未找到模型权重：%s" % weight)
    cls = AudioPreDeEcho if "DeEcho" in model_name else AudioPre
    return cls(agg=int(agg), model_path=str(weight), device=device, is_half=is_half)


def run(item: Path, processor, vocal_root: Path | None, ins_root: Path | None, fmt: str, is_hp3: bool) -> None:
    """处理单个音频。**一律用关键字参数**，避免两类模型 vocal/ins 顺序相反。"""
    processor._path_audio_(
        str(item),
        vocal_root=str(vocal_root) if vocal_root else None,
        ins_root=str(ins_root) if ins_root else None,
        format=fmt,
        is_hp3=is_hp3,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="UVR5 人声/伴奏分离 & 去混响 & 去延迟")
    parser.add_argument("--home", required=True, help="GPT-SoVITS 根目录（含 tools/uvr5）")
    parser.add_argument(
        "--model",
        required=True,
        help="模型名，例如 HP2_all_vocals / HP5_only_main_vocal / VR-DeEchoNormal / onnx_dereverb_By_FoxJoy",
    )
    parser.add_argument("-i", "--input", required=True, help="输入音频文件或目录")
    parser.add_argument("-o-vocal", "--vocal-root", default="", help="人声输出目录")
    parser.add_argument("-o-ins", "--ins-root", default="", help="非人声（伴奏）输出目录")
    parser.add_argument("--agg", type=int, default=10, help="人声提取激进程度（0~20，仅 VR 模型生效）")
    parser.add_argument("--format", default="flac", choices=["wav", "flac", "mp3", "m4a"], help="导出格式")
    parser.add_argument("--device", default="cuda:0", help="cuda:0 / cpu")
    parser.add_argument("--half", action="store_true", help="半精度推理（显存不足时去掉这个开关）")
    args = parser.parse_args()

    _bootstrap_uvr5(args.home)

    inp = Path(args.input)
    items = [inp] if inp.is_file() else _list_audio(inp)
    if not items:
        print("输入路径里没有可处理的音频：%s" % inp)
        return 1

    vocal_root = Path(args.vocal_root) if args.vocal_root else None
    ins_root = Path(args.ins_root) if args.ins_root else None
    if vocal_root is None and ins_root is None:
        print("至少要指定一个输出目录（-o-vocal 或 -o-ins）")
        return 1
    if vocal_root:
        vocal_root.mkdir(parents=True, exist_ok=True)
    if ins_root:
        ins_root.mkdir(parents=True, exist_ok=True)

    try:
        processor = build_processor(args.home, args.model, args.agg, args.device, args.half)
    except SystemExit as exc:
        print(str(exc))
        return 1
    except ImportError as exc:
        print("加载 UVR5 模块失败（可能缺少 onnxruntime / torch 等依赖）：%s" % exc)
        return 1

    is_hp3 = "HP3" in args.model
    failed = 0
    for item in items:
        try:
            run(item, processor, vocal_root, ins_root, args.format, is_hp3)
            print("%s -> Success" % item.name)
        except Exception:  # noqa: BLE001 - 单条失败不影响整批
            failed += 1
            print("%s -> Fail" % item.name)
            traceback.print_exc()

    # 与官方 webui 一样，结束时显式释放显存
    try:
        del processor.model
        del processor
    except Exception:  # noqa: BLE001
        pass
    try:
        import torch  # noqa: PLC0415

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:  # noqa: BLE001
        pass

    print("完成：共 %d 条，失败 %d 条" % (len(items), failed))
    return 0 if failed == 0 else 2


if __name__ == "__main__":
    sys.exit(main())

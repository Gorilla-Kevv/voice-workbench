"""UVR5 直连层：把官方分离算法接进本服务。

官方只给了 Gradio 界面（`tools/uvr5/webui.py`），那个模块 import 期就会
`app.launch()` 并读 `sys.argv`，没法直接用。但它的算法本体
`vr.py` / `mdxnet.py` / `bsroformer.py` 都是纯类，可以直接 import ——
项目里已经有一份命令行封装（`trainer/tools/uvr_cli.py`）用在了 GPT-SoVITS 的
训练流水线上。

这里要的是**进程内**调用，而不是再起一个子进程，原因有两个：

1. 分离常常是翻唱任务的第一段，后面还要接着转换与混音；子进程结束后
   权重就白加载了一次（VR 模型百 MB 级、RoFormer 数百 MB 级）；
2. 显存要统一调度：进程内的引擎注册表能确保分离与 RVC / DDSP-SVC 互斥。

两个从官方源码里读出来、必须照做的细节：

* `vr.py` 用相对导入（`from lib.lib_v5 import ...`），必须把 `tools/uvr5`
  放进 `sys.path`，否则 import 直接失败；
* `AudioPre` 与 `AudioPreDeEcho` 的 `vocal_root / ins_root` **参数顺序是反的**。
  一律用**位置参数**调用（第 2 位是伴奏目录、第 3 位是人声目录），
  两类模型都能落到语义正确的目录 —— 用关键字参数则会在 DeEcho/DeReverb 上把
  伴奏写进人声目录（文件名前缀仍然正确，所以肉眼很难发现）。
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from .. import vendor_paths
from ..sovits import catalog as sovits_catalog
from . import uvr5_catalog
from .cache import ArtifactCache, cache_key
from .io import probe

ProgressFn = Callable[[float, str], None]


class SeparationError(Exception):
    """分离失败。消息即可直接展示给用户。"""

    def __init__(self, message: str, hint: str = "", code: str = "UVR5_FAILED") -> None:
        super().__init__(message)
        self.message = message
        self.hint = hint
        self.code = code


@dataclass
class SeparationResult:
    """一次分离的结果。"""

    vocal: Optional[Path] = None
    instrumental: Optional[Path] = None
    model: str = ""
    secondary: str = ""
    agg: int = 10
    cached: bool = False
    elapsed_s: float = 0.0
    meta: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "vocal": str(self.vocal) if self.vocal else None,
            "instrumental": str(self.instrumental) if self.instrumental else None,
            "model": self.model,
            "secondary": self.secondary,
            "agg": self.agg,
            "cached": self.cached,
            "elapsed_s": round(self.elapsed_s, 2),
            "meta": self.meta,
        }


def uvr5_dir_of(home: Path) -> Path:
    return Path(home) / sovits_catalog.UVR5_DIR


def weights_dir_of(home: Path) -> Path:
    return Path(home) / sovits_catalog.UVR5_WEIGHTS_DIR


def available_models(home: Path) -> List[Dict[str, Any]]:
    """本机实际可用的 UVR5 模型（复用既有盘点，但不改它的分类口径）。

    这里额外补一个 `kind`（用我们修过 DeReverb 的分类逻辑），
    供预置档位判断「这个档位在本机能不能用」。
    """
    models = sovits_catalog.list_uvr_models(Path(home))
    for item in models:
        # 既有盘点用的是 `id`，这里统一补一个 `name`，避免调用方记住两套字段名
        name = str(item.get("id") or item.get("name") or "")
        item["name"] = name
        item["kind"] = uvr5_catalog.classify(name)
        item["separator"] = uvr5_catalog.is_separator(name)

        # BS-RoFormer 的同名 .yaml 是**可选**的：官方 `Roformer_Loader` 在配置缺失时
        # 会回落到内置默认配置（bsroformer.py 的 get_default_config）。
        # 既有盘点为了保守把它标成不可用，但那是训练流水线的口径；
        # 这里要能用就用，只在 note 里说明配置来源。
        if item["kind"] == uvr5_catalog.KIND_ROFORMER and item.get("missing_config"):
            item["available"] = True
            item["note"] = "%s（未提供同名 .yaml，使用内置默认配置）" % (item.get("note") or "高保真分离")
    return models


def expected_names(kind: str, src: Path, fmt: str, agg: int) -> Tuple[str, str]:
    """按官方写文件的规则推算产物名。

    四个类的命名规则都不一样，而且 `_path_audio_()` 一律返回 None ——
    产物路径只能自己拼，这是官方源码里读出来的事实，不是我们的约定。
    """
    base = src.name  # 含扩展名：vr.py:48 / mdxnet.py:175 用的是 basename
    stem = src.stem  # 去扩展名：bsroformer.py:204
    if kind == uvr5_catalog.KIND_ROFORMER:
        return "%s_vocals.%s" % (stem, fmt), "%s_other.%s" % (stem, fmt)
    if kind == uvr5_catalog.KIND_MDX:
        return "%s_main_vocal.%s" % (base, fmt), "%s_others.%s" % (base, fmt)
    # AudioPre / AudioPreDeEcho：位置参数调用下命名一致
    return "vocal_%s_%d.%s" % (base, agg, fmt), "instrument_%s_%d.%s" % (base, agg, fmt)


class Uvr5Engine:
    """UVR5 分离引擎。所有调用都经过引擎注册表，保证不与其它模型抢显存。"""

    def __init__(self, registry: Any, cache: ArtifactCache) -> None:
        self.registry = registry
        self.cache = cache

    # ---------- 能力清单 ----------

    def catalog(self, home: Path) -> Dict[str, Any]:
        """预置档位 + 本机可用模型。档位会标注本机是否真的能跑。"""
        installed = {str(item.get("name") or item.get("id")): item for item in available_models(home)}
        presets = []
        for item in uvr5_catalog.SEPARATION_PRESETS:
            entry = dict(item)
            model = str(item.get("model") or "")
            found = installed.get(model)
            entry["available"] = bool(model == "" or (found and found.get("available", True)))
            if model and not entry["available"]:
                entry["hint"] = "本机缺少权重 %s，请从整合包的 uvr5_weights 补齐" % model
            presets.append(entry)

        secondary = []
        for item in uvr5_catalog.SECONDARY_PRESETS:
            entry = dict(item)
            model = str(item.get("model") or "")
            found = installed.get(model)
            entry["available"] = bool(model == "" or (found and found.get("available", True)))
            secondary.append(entry)

        return {
            **uvr5_catalog.to_public(),
            "presets": presets,
            "secondary": secondary,
            "installed": list(installed.values()),
            "home": str(home),
        }

    # ---------- 分离 ----------

    def separate(
        self,
        *,
        home: Path,
        src: Path,
        preset_key: str = "vocal_fast",
        secondary_key: str = "none",
        agg: int = 10,
        fmt: str = uvr5_catalog.DEFAULT_FORMAT,
        out_dir: Optional[Path] = None,
        use_cache: bool = True,
        progress: Optional[ProgressFn] = None,
    ) -> SeparationResult:
        """执行一次分离（含可选二级处理）。命中缓存时直接返回既有产物。"""
        started = time.time()
        src = Path(src)
        if not src.is_file():
            raise SeparationError("待分离的音频不存在：%s" % src.name, code="SOURCE_MISSING")

        preset = uvr5_catalog.preset(preset_key)
        if preset is None:
            raise SeparationError("未知的分离档位：%s" % preset_key, code="BAD_PRESET")

        if not preset.get("model"):
            # 「不分离」也是一个合法档位：直接把源音频当人声返回
            info = probe(src)
            return SeparationResult(
                vocal=src,
                instrumental=None,
                model="",
                secondary="",
                elapsed_s=time.time() - started,
                meta={"skipped": True, "duration": info.duration, "sample_rate": info.sample_rate},
            )

        params = {
            "preset": preset_key,
            "secondary": secondary_key,
            "agg": agg,
            "format": fmt,
        }
        key = cache_key(src, "separation", params)
        if use_cache:
            hit = self.cache.find(key, "separation")
            if hit:
                if progress:
                    progress(1.0, "命中分离缓存，跳过分离")
                files = hit.get("files") or {}
                return SeparationResult(
                    vocal=Path(files["vocal"]) if files.get("vocal") else None,
                    instrumental=Path(files["instrumental"]) if files.get("instrumental") else None,
                    model=str(preset.get("model") or ""),
                    secondary=secondary_key,
                    agg=agg,
                    cached=True,
                    elapsed_s=time.time() - started,
                    meta={"cache_key": key},
                )

        work_dir = Path(out_dir) if out_dir else self.cache.dir_for(key, "separation")
        work_dir.mkdir(parents=True, exist_ok=True)
        vocal_dir = work_dir / "vocal"
        inst_dir = work_dir / "instrumental"
        vocal_dir.mkdir(parents=True, exist_ok=True)
        inst_dir.mkdir(parents=True, exist_ok=True)

        if progress:
            progress(0.05, "加载 %s" % preset.get("model"))

        handle = self.registry.acquire("uvr5", reason="UVR5 分离：%s" % src.name)
        try:
            vocal_path, inst_path = self._run_model(
                home=home,
                model=str(preset["model"]),
                kind=str(preset["kind"]),
                src=src,
                agg=agg,
                fmt=fmt,
                vocal_dir=vocal_dir,
                inst_dir=inst_dir,
                progress=progress,
            )
        finally:
            handle.release()

        secondary_preset = uvr5_catalog.secondary_preset(secondary_key)
        if secondary_preset and secondary_preset.get("model") and vocal_path:
            if progress:
                progress(0.75, "二级处理：%s" % secondary_preset["label"])
            handle = self.registry.acquire("uvr5", reason="UVR5 二级处理")
            try:
                cleaned, _ = self._run_model(
                    home=home,
                    model=str(secondary_preset["model"]),
                    kind=str(secondary_preset["kind"]),
                    src=vocal_path,
                    agg=agg,
                    fmt=fmt,
                    vocal_dir=work_dir / "clean",
                    inst_dir=work_dir / "residual",
                    progress=None,
                )
            finally:
                handle.release()
            if cleaned:
                vocal_path = cleaned

        result = SeparationResult(
            vocal=vocal_path,
            instrumental=inst_path,
            model=str(preset["model"]),
            secondary=secondary_key,
            agg=agg,
            cached=False,
            elapsed_s=time.time() - started,
            meta={"cache_key": key},
        )

        if use_cache and vocal_path:
            files: Dict[str, Path] = {"vocal": vocal_path}
            if inst_path:
                files["instrumental"] = inst_path
            self.cache.store(key, "separation", files, params=params, note=src.name)
        return result

    # ---------- 内部 ----------

    def _build(self, home: Path, model: str, kind: str, agg: int, device: str, is_half: bool) -> Any:
        """在临时上下文里构造官方推理对象。"""
        root = uvr5_dir_of(home)
        weights = weights_dir_of(home)
        with vendor_paths.temporary_context(entries=[str(root)], argv=["uvr5"]):
            if kind == uvr5_catalog.KIND_MDX:
                from mdxnet import MDXNetDereverb  # type: ignore  # noqa: PLC0415

                return MDXNetDereverb(15)
            if kind == uvr5_catalog.KIND_ROFORMER:
                from bsroformer import Roformer_Loader  # type: ignore  # noqa: PLC0415

                config = weights / ("%s.yaml" % model)
                return Roformer_Loader(
                    model_path=str(weights / ("%s.ckpt" % model)),
                    config_path=str(config) if config.is_file() else "",
                    device=device,
                    is_half=is_half,
                )
            from vr import AudioPre, AudioPreDeEcho  # type: ignore  # noqa: PLC0415

            cls = AudioPreDeEcho if kind == uvr5_catalog.KIND_DEECHO else AudioPre
            return cls(agg=int(agg), model_path=str(weights / ("%s.pth" % model)), device=device, is_half=is_half)

    def _run_model(
        self,
        *,
        home: Path,
        model: str,
        kind: str,
        src: Path,
        agg: int,
        fmt: str,
        vocal_dir: Path,
        inst_dir: Path,
        progress: Optional[ProgressFn],
    ) -> Tuple[Optional[Path], Optional[Path]]:
        """加载 → 推理 → 释放。返回 (人声, 伴奏)。"""
        try:
            import torch  # noqa: PLC0415

            use_cuda = torch.cuda.is_available()
            device = "cuda:0" if use_cuda else "cpu"
            is_half = use_cuda
        except Exception:  # noqa: BLE001
            device, is_half = "cpu", False

        # UVR5 往 sys.modules 里塞的顶层名 `lib` 太通用（`from lib.lib_v5 import ...`），
        # 用完必须摘掉，否则后来加载的引擎一旦也用这个名字就会拿到 UVR5 的那一份。
        scope = vendor_paths.ModuleScope()
        try:
            processor = self._build(home, model, kind, agg, device, is_half)
        except SystemExit as exc:
            raise SeparationError("加载 UVR5 模型失败：%s" % exc, hint="确认权重文件完整且与该模型架构匹配。") from exc
        except Exception as exc:  # noqa: BLE001
            raise SeparationError(
                "加载 UVR5 模型 %s 失败：%s" % (model, exc),
                hint="确认整合包 tools/uvr5/uvr5_weights 下存在该权重；RoFormer 还需要同名 .yaml。",
            ) from exc

        try:
            if progress:
                progress(0.2, "正在分离：%s" % src.name)
            # 位置参数：第 2 位=伴奏目录，第 3 位=人声目录（两类 VR 模型都适用）
            processor._path_audio_(str(src), str(inst_dir), str(vocal_dir), fmt, False)
        except Exception as exc:  # noqa: BLE001
            raise SeparationError(
                "UVR5 处理失败：%s" % exc,
                hint="常见原因是显存不足（换「快速分离」档位）或音频格式不受支持（先转成 wav）。",
                code="UVR5_INFER_FAILED",
            ) from exc
        finally:
            self._release(processor)
            scope.snapshot()
            scope.purge()

        vocal_name, inst_name = expected_names(kind, src, fmt, agg)
        vocal_path = vocal_dir / vocal_name
        inst_path = inst_dir / inst_name
        if not vocal_path.is_file():
            # 兜底：命名规则随上游版本变化时会走到这里，直接取目录里唯一的音频
            vocal_path = _first_audio(vocal_dir)
            inst_path = _first_audio(inst_dir)
        if progress:
            progress(0.7, "分离完成")
        return vocal_path, inst_path if (inst_path and inst_path.is_file()) else None

    @staticmethod
    def _release(processor: Any) -> None:
        """照抄官方 webui 的收尾：显式删引用 + 清显存。"""
        try:
            if hasattr(processor, "model"):
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


def _first_audio(directory: Path) -> Optional[Path]:
    if not directory.is_dir():
        return None
    for path in sorted(directory.iterdir()):
        if path.is_file() and path.suffix.lower() in {".wav", ".flac", ".mp3", ".m4a"}:
            return path
    return None


__all__ = [
    "SeparationError",
    "SeparationResult",
    "Uvr5Engine",
    "available_models",
    "expected_names",
    "uvr5_dir_of",
    "weights_dir_of",
]

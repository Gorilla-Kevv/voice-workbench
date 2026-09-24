"""翻唱向导：分离 → 转换 → 混音，一次跑完。

这是「更便捷的实现方式」的落点。用户真正想要的不是「先跑分离再跑转换」这两个动作，
而是「把这首歌换成某个音色唱」。所以把整条链路编成一个任务：

```
上传歌曲
  ├─（可选）UVR5 分离 ──► 人声 / 伴奏
  │        └─（可选）二级去混响
  ├─ 提 F0 与内容特征 ──► 转换 ──► 新人声
  └─ 混音 ──► 新人声 / 伴奏 / 混音 三件套
```

关键的效率设计：**分离与特征结果按内容指纹缓存**。
同一首歌换五个音色翻唱，第 2~5 次直接跳过分离（实测 30s → 0.04s），
这是整条链路里最省时的一环，也是「向导」敢做成一键的原因。

向导并不是唯一入口：想分步操作的用户可以用 `/v1/uvr/separate` 先听分离效果，
再用 `/v1/svc/convert` 只做转换 —— 两者共用同一套参数与缓存。
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from ..audio.mixer import MixOptions, export_tracks
from ..audio.uvr5 import Uvr5Engine
from ..config import Settings
from .pipeline import SvcEngine

ProgressFn = Callable[[float, str], None]


class CoverError(Exception):
    def __init__(self, message: str, hint: str = "", code: str = "COVER_FAILED") -> None:
        super().__init__(message)
        self.message = message
        self.hint = hint
        self.code = code


def run_cover(
    *,
    settings: Settings,
    uvr5: Uvr5Engine,
    engine: SvcEngine,
    home: Path,
    src: Path,
    model_path: Path,
    out_dir: Path,
    separation: Optional[Dict[str, Any]] = None,
    conversion: Optional[Dict[str, Any]] = None,
    mix: Optional[Dict[str, Any]] = None,
    progress: Optional[ProgressFn] = None,
) -> Dict[str, Any]:
    """执行一次完整翻唱。返回三件套与每个阶段的耗时。"""
    separation = separation or {}
    conversion = conversion or {}
    mix = mix or {}

    started = time.time()
    stages: List[Dict[str, Any]] = []
    src = Path(src)
    if not src.is_file():
        raise CoverError("待处理的音频不存在：%s" % src.name, code="SOURCE_MISSING")

    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    def report(fraction: float, message: str) -> None:
        if progress:
            progress(fraction, message)

    # ---------- 1. 分离 ----------
    preset_key = str(separation.get("preset") or settings.uvr_preset)
    report(0.02, "准备音源：%s" % src.name)
    separation_result = uvr5.separate(
        home=home,
        src=src,
        preset_key=preset_key,
        secondary_key=str(separation.get("secondary") or "none"),
        agg=int(separation.get("agg", settings.uvr_agg)),
        fmt=str(separation.get("format") or settings.uvr_format),
        use_cache=bool(separation.get("use_cache", settings.uvr_cache_enabled)),
        progress=lambda f, m: report(0.02 + 0.33 * f, m),
    )
    stages.append(
        {
            "key": "separate",
            "label": "人声分离" if preset_key != "off" else "跳过分离",
            "cached": separation_result.cached,
            "elapsed_s": round(separation_result.elapsed_s, 2),
            "model": separation_result.model,
        }
    )

    vocal_src = separation_result.vocal or src
    instrumental = separation_result.instrumental

    # ---------- 2. 转换 ----------
    report(0.4, "开始歌声转换")
    converted = out_dir / "converted.wav"
    convert_info = engine.convert(
        src=vocal_src,
        out_path=converted,
        model_path=Path(model_path),
        key=float(conversion.get("key", 0.0)),
        spk_id=int(conversion.get("spk_id", 1)),
        spk_mix=conversion.get("spk_mix"),
        f0_method=str(conversion.get("f0_method") or ""),
        quality=str(conversion.get("quality") or "standard"),
        formant_shift=float(conversion.get("formant_shift", 0.0)),
        threshold_db=float(conversion.get("threshold_db", -45.0)),
        slice_segments=bool(conversion.get("slice_segments", True)),
        progress=lambda f, m: report(0.4 + 0.45 * f, m),
    )
    stages.append(
        {
            "key": "convert",
            "label": "歌声转换",
            "elapsed_s": round(convert_info.get("elapsed_s", 0.0), 2),
            "segments": convert_info.get("segments"),
            "model": convert_info.get("model"),
        }
    )

    # ---------- 3. 混音 ----------
    report(0.88, "混音与导出")
    options = MixOptions(
        vocal_gain_db=float(mix.get("vocal_gain_db", 0.0)),
        instrumental_gain_db=float(mix.get("instrumental_gain_db", 0.0)),
        vocal_delay_ms=float(mix.get("vocal_delay_ms", 0.0)),
        fade_ms=float(mix.get("fade_ms", 15.0)),
    )
    artifacts = export_tracks(
        vocal_path=converted,
        instrumental_path=instrumental,
        out_dir=out_dir,
        options=options,
        basename=src.stem,
    )
    stages.append({"key": "mix", "label": "混音", "outputs": sorted(artifacts.keys())})

    report(1.0, "完成")
    return {
        "artifacts": artifacts,
        "stages": stages,
        "conversion": convert_info,
        "separation": separation_result.to_dict(),
        "elapsed_s": round(time.time() - started, 2),
    }

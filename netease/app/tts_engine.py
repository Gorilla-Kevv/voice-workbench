"""Confucius4-TTS 引擎适配层 —— **触碰上游 API 的两个薄文件之一**。

上游用法（官方 README，2026-09）：

    from confuciustts.cli.inference import ConfuciusTTS
    model = ConfuciusTTS(config_path="config/inference_config.yaml", device="cuda")
    audio = model.generate(text=..., lang=..., prompt_wav=..., verbose=True)
    sf.write("out.wav", audio, model.sample_rate)

设计约束：
- `confuciustts` 与 torch 全部 lazy import —— 没装依赖时服务要能启动并报告缺什么；
- 生成串行（同一把锁），与 trainer 的单卡串行同一哲学；
- **权重不在仓库目录里**：上游 `inference.py` 里 T2S / S2A 走 `hf_hub_download`、
  w2v-bert 与 BigVGAN 走 `from_pretrained(repo_id)` —— 全都只读 **HuggingFace 缓存**。
  所以 `probe_install()` 查的是缓存而不是本地目录；下载用
  `scripts/download_netease_weights.py`（TTS 侧实测 11.5 GB，不是文档里估的 54 GB）。
- 上游配置里 `tokenizer_path` / `w2v_stat` 是相对路径（按 CWD 解析），
  本层会生成一份把这两个路径改成绝对路径的配置副本再交给上游，避免 CWD 依赖。
"""

from __future__ import annotations

import threading
import time
import uuid
from pathlib import Path
from typing import Any, Optional

import numpy as np

from .config import NETEASE_DIR, Settings
from .errors import NeteaseError
from . import hardware

#: 本地权重目录（w2v-bert / BigVGAN 落在这里，见 scripts/download_netease_weights.py）
NETEASE_MODELS = NETEASE_DIR / "models"

#: 官方支持的 14 种合成目标语种（README 语言表）
TTS_LANGUAGES: list[dict[str, str]] = [
    {"code": "zh", "label": "中文"},
    {"code": "en", "label": "English"},
    {"code": "ja", "label": "日本語"},
    {"code": "ko", "label": "한국어"},
    {"code": "de", "label": "Deutsch"},
    {"code": "fr", "label": "Français"},
    {"code": "es", "label": "Español"},
    {"code": "id", "label": "Bahasa Indonesia"},
    {"code": "it", "label": "Italiano"},
    {"code": "th", "label": "ไทย"},
    {"code": "pt", "label": "Português"},
    {"code": "ru", "label": "Русский"},
    {"code": "ms", "label": "Bahasa Melayu"},
    {"code": "vi", "label": "Tiếng Việt"},
]

#: 显存放行门槛（MB）。fp16 实测常驻 + 推理峰值约 4.9 GB（RTX 4060 Laptop 8 GB，
#: 22050 Hz、7.7 s 音频），这里留一档余量。宁高勿低 —— 估高只是提前拒绝，估低是跑到一半 OOM。
REQUIRED_VRAM_MB = 6144

#: 只能通过 **HF 缓存** 拿到的（上游硬编码 `hf_hub_download(repo_id, filename)`）：
#: (HF repo id, 文件名)。缺哪个就点名哪个，方便直接补下载。
_HF_WEIGHT_FILES: tuple[tuple[str, str], ...] = (
    ("netease-youdao/Confucius4-TTS", "t2s_model.safetensors"),
    ("netease-youdao/Confucius4-TTS", "s2a_model.pt"),
    ("funasr/campplus", "campplus_cn_common.bin"),
)

#: 落在 `netease/models/<目录>` 的本地权重（`from_pretrained` 支持本地目录，可绕开缓存）：
#: (推理配置里的键, 目录名, 必需文件, HF repo id)。本地没有时退回查 HF 缓存。
_LOCAL_MODEL_DIRS: tuple[tuple[str, str, tuple[str, ...], str], ...] = (
    ("w2v_bert_path", "w2v-bert-2.0", ("config.json", "model.safetensors"), "facebook/w2v-bert-2.0"),
    ("vocoder_path", "bigvgan_v2_22khz_80band_256x", ("config.json", "bigvgan_generator.pt"), "nvidia/bigvgan_v2_22khz_80band_256x"),
)

#: 仓库目录里必须存在的本地文件（分词器与语义归一化统计量，随 git 克隆一起下来）
_LOCAL_FILES = ("checkpoints/tokenizer.json", "checkpoints/wav2vec2bert_stats.pt")


class TtsPipeline:
    """常驻封装：load 一次，反复 generate。"""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._model: Any = None
        self._device: str = ""
        self._loaded_at: float = 0.0
        self._lock = threading.Lock()

    # ------------------------------------------------------------------ 安装探测

    def probe_install(self) -> dict[str, Any]:
        home: Path = self._settings.tts_home
        config_path: Path = self._settings.resolved_tts_config
        missing: list[str] = []
        if not home.exists():
            missing.append(f"TTS 仓库目录不存在：{home}（按 netease/README.md 克隆 Confucius4-TTS）")
        else:
            if not config_path.exists():
                missing.append(f"推理配置不存在：{config_path}")
            for rel in _LOCAL_FILES:
                if not (home / rel).exists():
                    missing.append(f"仓库内缺少：{home / rel}")
        cached, uncached = _probe_hf_cache()
        missing.extend(f"权重未下载（HF 缓存里没有）：{repo}/{name}" for repo, name in uncached)
        # 本地目录权重：本地有就记下来，没有再退回查 HF 缓存
        local_ready: list[str] = []
        for _key, dirname, files, repo_id in _LOCAL_MODEL_DIRS:
            directory = NETEASE_MODELS / dirname
            if all((directory / name).exists() for name in files):
                local_ready.append(f"netease/models/{dirname}")
            elif not _hf_cached(repo_id, "config.json"):
                missing.append(f"权重未下载：netease/models/{dirname}（或 HF 缓存 {repo_id}）")
            else:
                local_ready.append(f"{repo_id}（HF 缓存）")
        info = hardware.probe()
        return {
            "engine": "tts",
            "home": str(home),
            "config_path": str(config_path),
            "installed": not missing,
            "missing": missing,
            "package": _probe_package(),
            "weights_cached": cached + local_ready,
            #: 权重缺 → 明确指向下载脚本，而不是含糊的「首次加载会自动下载」
            "download_hint": (
                "python scripts/download_netease_weights.py（用 netease venv 的解释器）"
                if uncached
                else ""
            ),
        }

    # ------------------------------------------------------------------ 生命周期

    @property
    def loaded(self) -> bool:
        return self._model is not None

    def status(self) -> dict[str, Any]:
        return {
            "engine": "tts",
            "loaded": self.loaded,
            "device": self._device or None,
            "loaded_for_sec": round(time.monotonic() - self._loaded_at, 1) if self.loaded else None,
        }

    def ensure_loaded(self) -> dict[str, Any]:
        if self.loaded:
            return self.status()
        install = self.probe_install()
        if install["package"].get("missing"):
            raise NeteaseError(
                "DEP_MISSING",
                "confuciustts 依赖不可用",
                "请在 netease venv 里安装：pip install -e <Confucius4-TTS 仓库>（见 netease/README.md）",
                details=install["package"],
            )
        if install["missing"]:
            raise NeteaseError(
                "WEIGHTS_MISSING",
                f"权重/文件未就位：{'；'.join(install['missing'])}",
                f"运行 {install['download_hint'] or 'python scripts/download_netease_weights.py'} 补齐后再重试。",
                retryable=False,
                details=install,
            )
        device = self._resolve_device()
        import soundfile as sf  # noqa: PLC0415  （仅确认可用性，真正使用在 generate）

        _ = sf
        try:
            from confuciustts.cli.inference import ConfuciusTTS  # noqa: PLC0415
        except Exception as error:
            raise NeteaseError(
                "DEP_IMPORT_FAILED",
                f"confuciustts 导入失败：{type(error).__name__}: {error}",
                "通常是 torch 版本不满足（需 ≥2.5 / cu12.6）。运行 npm run netease:check 查看逐项体检。",
                retryable=False,
            ) from error

        config_path = self._materialize_config(self._settings.resolved_tts_config)
        try:
            self._model = ConfuciusTTS(config_path=str(config_path), device=device)
        except Exception as error:
            self._model = None
            raise NeteaseError(
                "MODEL_LOAD_FAILED",
                f"TTS 模型加载失败：{type(error).__name__}: {error}",
                "常见原因：HF 缓存里的权重损坏（删除后重下）、显存不足（先卸载另一引擎）。"
                "若卡在下载，确认 HF_ENDPOINT 可用（hf-mirror 与本版 huggingface_hub 有 308 兼容问题）。",
                status=503,
                retryable=True,
            ) from error
        if device == "cuda" and self._settings.precision == "fp16":
            _enable_fp16(self._model)
        self._device = device
        self._loaded_at = time.monotonic()
        return self.status()

    def unload(self) -> dict[str, Any]:
        model, self._model = self._model, None
        self._device = ""
        self._loaded_at = 0.0
        if model is not None:
            try:
                del model
                import torch  # noqa: PLC0415

                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except Exception:
                pass
        return self.status()

    # ------------------------------------------------------------------ 推理

    def generate(self, text: str, lang: str, prompt_wav: Path) -> dict[str, Any]:
        if not text.strip():
            raise NeteaseError("EMPTY_TEXT", "合成文本为空", "请输入要合成的文本。")
        if lang not in {item["code"] for item in TTS_LANGUAGES}:
            raise NeteaseError(
                "UNSUPPORTED_LANGUAGE",
                f"不支持的合成语种：{lang}",
                f"官方支持 14 种，可选值：{' / '.join(item['code'] for item in TTS_LANGUAGES)}",
            )
        if not prompt_wav.exists():
            raise NeteaseError(
                "REF_AUDIO_MISSING",
                f"参考音频不存在：{prompt_wav}",
                "上传一段 3 秒以上的参考音频，或从音色库选择一条音色。",
            )

        self.ensure_loaded()
        sample_rate = 0
        started = time.monotonic()
        with self._lock:
            try:
                import soundfile as sf  # noqa: PLC0415
                import torch  # noqa: PLC0415

                audio = self._model.generate(text=text, lang=lang, prompt_wav=str(prompt_wav), verbose=False)
                if hasattr(audio, "detach"):  # torch.Tensor → numpy
                    audio = audio.detach().cpu().float().numpy()
                # 统一成 float32：fp16 精度下上游可能直接给出 float16 数组，
                # 而 soundfile 不认 float16（报 "Format not recognised"）。
                audio = np.asarray(audio, dtype=np.float32).reshape(-1)
                sample_rate = int(getattr(self._model, "sample_rate", 0) or 0)
                if sample_rate <= 0:
                    raise NeteaseError(
                        "UPSTREAM_DRIFT",
                        "无法从模型对象上读取 sample_rate",
                        "上游 confuciustts API 可能已变更，请核对 netease/app/tts_engine.py 的接入面。",
                    )
                out_dir = self._settings.uploads_dir / "tts"
                out_dir.mkdir(parents=True, exist_ok=True)
                out_path = out_dir / f"{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:8]}.wav"
                sf.write(str(out_path), audio, sample_rate)
                duration = float(len(audio) / sample_rate) if sample_rate else 0.0
            except NeteaseError:
                raise
            except Exception as error:
                raise NeteaseError(
                    "SYNTH_FAILED",
                    f"合成失败：{type(error).__name__}: {error}",
                    "常见原因：显存不足（卸载另一引擎后重试）、参考音频过短（≥3 秒）或格式不支持。",
                    retryable=True,
                ) from error
        return {
            "path": str(out_path),
            "sample_rate": sample_rate,
            "duration_sec": round(duration, 2),
            "elapsed_sec": round(time.monotonic() - started, 2),
        }

    # ------------------------------------------------------------------ 内部

    def _materialize_config(self, config_path: Path) -> Path:
        """把上游配置里的相对路径改成绝对路径后落一份副本。

        上游 `inference_config.yaml` 里 `tokenizer_path: ./checkpoints`、`w2v_stat:
        ./checkpoints/wav2vec2bert_stats.pt` 都是按 **CWD** 解析的；服务进程从项目根启动，
        CWD 不是仓库目录就会找不到。改成绝对路径后交差，不动上游文件本身。
        """
        import yaml  # noqa: PLC0415

        cfg = yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}
        base = config_path.parent.parent  # <仓库>/config/inference_config.yaml → <仓库>
        paths = cfg.get("paths") or {}
        for key in ("tokenizer_path", "w2v_stat"):
            raw = paths.get(key)
            if raw and not Path(raw).is_absolute():
                paths[key] = str((base / raw).resolve())
        # 本地目录优先：这两个 from_pretrained 都认本地路径，能绕开 HF 缓存与联网
        for key, dirname, files, _repo_id in _LOCAL_MODEL_DIRS:
            directory = NETEASE_MODELS / dirname
            if all((directory / name).exists() for name in files):
                paths[key] = str(directory)
        out_dir = self._settings.data_dir
        out_dir.mkdir(parents=True, exist_ok=True)
        out = out_dir / "tts_inference_config.yaml"
        out.write_text(yaml.safe_dump(cfg, allow_unicode=True, sort_keys=False), encoding="utf-8")
        return out

    def _resolve_device(self) -> str:
        preferred = self._settings.device
        try:
            return hardware.resolve_device(preferred, allow_cpu=self._settings.allow_cpu)
        except RuntimeError as error:
            raise NeteaseError(
                "DEVICE_UNAVAILABLE",
                str(error),
                "请确认在 netease venv 里安装了 CUDA 版 torch（pip install torch --index-url https://download.pytorch.org/whl/cu126）。",
            ) from error


def check_vram(required_mb: int = REQUIRED_VRAM_MB) -> Optional[dict[str, Any]]:
    """加载前的显存准入检查。跨进程（GPT-SoVITS）占用看不见，这里只看本机空闲。"""
    info = hardware.vram_mb()
    if info is None:
        return None
    if info["free_mb"] < required_mb:
        raise NeteaseError(
            "VRAM_INSUFFICIENT",
            f"空闲显存不足：需要约 {required_mb} MB，当前仅 {info['free_mb']} MB / 共 {info['total_mb']} MB",
            "先关闭 GPT-SoVITS 本地服务（或卸载网易另一引擎），再重试；跨进程显存仲裁见 docs/NETEASE-INTEGRATION.md §3.1。",
            status=503,
            details=info,
        )
    return info


def _enable_fp16(model: Any) -> None:
    """把显存大户转成 fp16，并把上游「凭空造出来的 fp32 输入」在边界上对齐到 fp16。

    为什么需要：上游 `ConfuciusTTS.__init__` 直接 `.to(device)`、**不指定 dtype**，
    1.3B T2S + w2v-bert-2.0 + S2A + BigVGAN 全 fp32 约 7.5 GB，8 GB 卡必然 OOM；
    转 fp16 后常驻约 4 GB（实测 4.9 GB 含推理峰值）。

    ⚠️ 简单的 `.half()` 会立刻崩：`RuntimeError: expected scalar type Float but found Half`
    —— 上游在四处凭空造 fp32 张量喂给半精度模型（实测定位）：
      1. `feature_extractor` 出来的 `input_features`（fp32）→ w2v-bert；
      2. `wav2vec2bert_stats.pt` 读出的 semantic_mean / semantic_std（fp32）；
      3. `_ref_mel()` 的参考 mel（fp32）→ S2A；
      4. `_extract_style()` 的 CAMPPlus 风格向量（fp32）→ S2A。
    所以这里只转三个大户（T2S / S2A / w2v-bert），BigVGAN 与 CAMPPlus 留 fp32
    （它们各自只占 0.45 GB / 几十 MB，且上游自己会把 mel `.float()`），
    再用三个薄包装把 1/2/3/4 的 dtype 对齐。
    """
    import torch  # noqa: PLC0415

    dtype = torch.float16
    for attr in ("t2s_model", "s2a_model", "w2v_model"):
        sub = getattr(model, attr, None)
        if sub is not None:
            try:
                sub.half()
            except Exception:  # pragma: no cover - 个别子模块不支持半精度
                pass
    for attr in ("semantic_mean", "semantic_std"):
        tensor = getattr(model, attr, None)
        if isinstance(tensor, torch.Tensor):
            setattr(model, attr, tensor.to(dtype))
    _cast_module_input(model, "w2v_model", dtype)
    _cast_method_output(model, "_ref_mel", dtype)
    _cast_method_output(model, "_extract_style", dtype)
    # 5. `DummyPositionEmbedding.forward` 硬编码 dtype=float32（上游用它替换了 GPT2 的 wpe），
    #    zeros 与半精度 inputs_embeds 相加会把整条序列抬回 fp32 → GPT2 的第一个 ln_1 就炸。
    transformer = getattr(getattr(model, "t2s_model", None), "transformer", None)
    _cast_forward_output(getattr(transformer, "wpe", None), dtype)


def _cast_module_input(model: Any, attr: str, dtype) -> None:
    """把喂给某个子模块的 `input_features` 转成 dtype（半精度权重只吃半精度输入）。"""
    module = getattr(model, attr, None)
    if module is None or getattr(module, "_netease_fp16_input_patched", False):
        return
    original = module.forward

    def forward(*args, **kwargs):
        features = kwargs.get("input_features")
        if features is not None and hasattr(features, "to"):
            kwargs["input_features"] = features.to(dtype)
        return original(*args, **kwargs)

    module.forward = forward
    module._netease_fp16_input_patched = True


def _cast_forward_output(module: Any, dtype) -> None:
    """把子模块 forward 的返回值转成 dtype（同上，但作用在模块而不是方法上）。"""
    if module is None or getattr(module, "_netease_fp16_output_patched", False):
        return
    original = module.forward

    def forward(*args, **kwargs):
        value = original(*args, **kwargs)
        return value.to(dtype) if hasattr(value, "to") else value

    module.forward = forward
    module._netease_fp16_output_patched = True


def _cast_method_output(model: Any, name: str, dtype) -> None:
    """把某个上游方法的返回值转成 dtype（它的调用方是半精度模型）。"""
    original = getattr(model, name, None)
    if original is None or getattr(original, "_netease_fp16_output_patched", False):
        return

    def wrapper(*args, **kwargs):
        value = original(*args, **kwargs)
        return value.to(dtype) if hasattr(value, "to") else value

    wrapper._netease_fp16_output_patched = True
    setattr(model, name, wrapper)


def _probe_hf_cache() -> tuple[list[str], list[tuple[str, str]]]:
    """检查 HF 缓存里有没有需要的权重文件（不联网）。

    返回 (已就位清单, 缺失清单)。上游取权重只认缓存，所以这里查缓存而不是本地目录。
    """
    cached: list[str] = []
    missing: list[tuple[str, str]] = []
    for repo_id, filename in _HF_WEIGHT_FILES:
        if _hf_cached(repo_id, filename):
            cached.append(f"{repo_id}/{filename}")
        else:
            missing.append((repo_id, filename))
    return cached, missing


def _hf_cached(repo_id: str, filename: str) -> bool:
    try:
        from huggingface_hub import try_to_load_from_cache
    except Exception:  # pragma: no cover - 没装 huggingface_hub
        return False
    try:
        found = try_to_load_from_cache(repo_id=repo_id, filename=filename)
    except TypeError:  # 老版本签名 try_to_load_from_cache(repo_id, filename, cache_dir=None)
        try:
            found = try_to_load_from_cache(repo_id, filename)
        except Exception:
            return False
    except Exception:
        return False
    return isinstance(found, str) and Path(found).exists()


def _probe_package() -> dict[str, Any]:
    """confuciustts 包是否可导入（不触发模型加载）。"""
    try:
        import confuciustts  # noqa: F401,PLC0415

        return {"importable": True, "version": str(getattr(confuciustts, "__version__", ""))}
    except Exception as error:
        return {"importable": False, "missing": [f"confuciustts（{type(error).__name__}: {error}）"]}

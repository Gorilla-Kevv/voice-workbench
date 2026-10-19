"""GPT-SoVITS v5 引擎封装 + 切换 + 合成缓存。

关键知识点（TTS_infer_pack/TTS.py）：
- v5 变体（v5turbo / v5dev）每个是一个 `TTS` 实例，vits 权重不同，t2s 都是 s1v3.ckpt；
- `TTS.run()` 返回 `(sample_rate, int16 ndarray)`；
- 换一次模型（s1v3.ckpt 155MB + s2G* 766MB + vocoder 58MB + 底模）在 8GB 卡上**同一时间只驻留一个**；
  切换 = 卸载旧的再加载新的；
- cwd 要进 upstream/（预训练模型路径相对 cwd），upstream 与 upstream/GPT_SoVITS 都要进 sys.path
  （避免 webui/api 相对导入报错），server.py 里已提前加过一次。
"""

from __future__ import annotations

import gc
import sys
import threading
import time
from pathlib import Path

import torch

from .config import REQUIRED_VRAM_MB, Settings, VARIANTS
from .errors import Gsv5Error


def free_vram_mb() -> int | None:
    try:
        import subprocess

        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.free", "--format=csv,noheader,nounits"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        return int(out.stdout.strip().splitlines()[0])
    except Exception:
        try:
            free, _total = torch.cuda.mem_get_info()
            return int(free / 1024 / 1024)
        except Exception:
            return None


class Gsv5Engine:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.lock = threading.Lock()
        self.loaded_variant: str | None = None
        self.loaded_at: float | None = None
        self.tts_pipeline = None

    def status(self) -> dict:
        return {
            "loaded": self.loaded_variant is not None,
            "variant": self.loaded_variant,
            "loaded_at": self.loaded_at,
            "required_vram_mb": REQUIRED_VRAM_MB.get(self.loaded_variant) if self.loaded_variant else None,
            "vram_free_mb": free_vram_mb(),
        }

    def ensure_upstream_on_path(self) -> None:
        """sys.path 注入（防多次注入）：坑 69 同源，直接合成也要能 import，指回 warmup 等。"""
        upstream = str(self.settings.upstream_dir)
        gpt_sovits = str(self.settings.upstream_dir / "GPT_SoVITS")
        if upstream not in sys.path:
            sys.path.insert(0, upstream)
        if gpt_sovits not in sys.path:
            sys.path.insert(0, gpt_sovits)

    def _variant_ready(self, variant: str) -> None:
        if variant not in VARIANTS:
            raise Gsv5Error("BAD_VARIANT", f"未知 v5 变体：{variant}，可选：{'/'.join(VARIANTS)}", status=400)
        ready = self.settings.weights_ready()
        vits_key = f"s2G{variant}.pth"
        if not ready.get(vits_key) or not ready.get("s1v3.ckpt") or not ready.get("vocoder.pth"):
            raise Gsv5Error(
                "WEIGHTS_MISSING",
                f"v5 权重缺失：{variant} 需要的底模未就绪",
                hint="从 HF lj1995/GPT-SoVITS 的 gsv-v5-pretrained 下载，参见阶段 36 文档。",
                status=503,
            )

    def load(self, variant: str) -> dict:
        self._variant_ready(variant)
        with self.lock:
            if self.loaded_variant == variant and self.tts_pipeline is not None:
                return {"loaded": True, "variant": variant, "reused": True}

            device = self.settings.device
            req_mb = REQUIRED_VRAM_MB.get(variant, 3072)
            if device == "cuda" and torch.cuda.is_available():
                free_mb = free_vram_mb()
                if free_mb is not None and free_mb < req_mb:
                    raise Gsv5Error(
                        "VRAM_INSUFFICIENT",
                        f"显存不足：当前空闲 {free_mb} MB，加载 GPT-SoVITS {variant} 需要约 {req_mb} MB。",
                        hint="请关闭其它占显存程序，或卸载其它模型常驻。",
                        status=503,
                    )

            self.ensure_upstream_on_path()
            start_t = time.time()
            self._release_locked()

            try:
                from TTS_infer_pack.TTS import TTS, TTS_Config

                cfg = TTS_Config(
                    device=device,
                    is_half=(device == "cuda"),
                    version="custom",
                    t2s_weights_path="GPT_SoVITS/pretrained_models/s1v3.ckpt",
                    vits_weights_path=self.settings.variant_weights_path(variant),
                    cnhuhbert_base_path="GPT_SoVITS/pretrained_models/chinese-hubert-base",
                    bert_base_path="GPT_SoVITS/pretrained_models/chinese-roberta-wwm-ext-large",
                )
                self.tts_pipeline = TTS(cfg)
                self.loaded_variant = variant
                self.loaded_at = time.time()
            except Exception as e:
                self._release_locked()
                raise Gsv5Error("LOAD_FAILED", f"加载 v5 变体 {variant} 失败：{e}", status=500) from e

            load_sec = round(time.time() - start_t, 2)
            return {"loaded": True, "variant": variant, "reused": False, "load_sec": load_sec}

    def unload(self) -> dict:
        with self.lock:
            self._release_locked()
            return {"loaded": False, "variant": None}

    def _release_locked(self) -> None:
        self.tts_pipeline = None
        self.loaded_variant = None
        self.loaded_at = None
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()

    def synthesize(self, payload: dict) -> list[tuple[int, bytes, int]]:
        """合成并返回 (sample_rate, wav_bytes(int16 ndarray)) 分段列表供调用方拼合。"""
        with self.lock:
            if self.tts_pipeline is None:
                raise Gsv5Error("ENGINE_NOT_LOADED", "模型尚未加载", hint="请先调用 POST /v1/warmup。", status=409)

            variant = payload.get("variant") or self.loaded_variant or "v5turbo"
            default_steps = 4 if variant == "v5turbo" else 32
            sample_steps = int(payload.get("sample_steps") or default_steps)

            req = {
                "text": payload.get("text") or "",
                "text_lang": payload.get("text_lang") or "zh",
                "ref_audio_path": payload.get("ref_audio_path") or "",
                "prompt_text": payload.get("prompt_text") or "",
                "prompt_lang": payload.get("prompt_lang") or "zh",
                "sample_steps": sample_steps,
                "speed_factor": float(payload.get("speed_factor") or 1.0),
                "seed": int(payload.get("seed") or -1),
            }

            chunks = []
            for sr, data in self.tts_pipeline.run(req):
                data_bytes = data.tobytes()
                chunks.append((sr, data_bytes, len(data_bytes)))
            return chunks

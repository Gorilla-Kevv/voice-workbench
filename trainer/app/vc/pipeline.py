"""语音变声引擎：模型热切换、检索索引、一次变声。

与既有 GPT-SoVITS 管线同样的取舍：模型常驻内存、权重热切换、串行推理。
多出来的两点是 RVC 特有的：

* **检索索引**（faiss）。`index_rate` 决定「检索出来的特征」在最终特征里占多少，
  0 表示不用索引。索引路径由 `vc/models.py` 按官方规则匹配好再传进来；
* **临时 cwd**。`assets/hubert/hubert_base.pt` 是硬编码相对路径，
  所以每次真正调用 VC 之前都要切到 vendor 根目录，调用完立刻还原
  （不能常驻切换：GPT-SoVITS 的官方代码也依赖 cwd，两者会互相破坏）。
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any, Callable, Dict, Optional

import numpy as np

from .. import vendor_paths
from ..audio.io import save
from ..config import Settings
from . import bootstrap, models as model_store

ProgressFn = Callable[[float, str], None]


class VcEngine:
    """RVC 推理引擎。"""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._vc = None
        self._config = None
        self._scope: Optional[vendor_paths.ModuleScope] = None
        self.model_path: Optional[Path] = None
        self.loaded_at: float = 0.0

    # ---------- 生命周期 ----------

    def _context(self):
        """RVC 调用期间接管 sys.path 与 cwd。"""
        root = bootstrap.vendor_root(self.settings)
        return vendor_paths.temporary_context(entries=[str(root)], cwd=str(root), argv=["rvc"])

    def _ensure_vc(self) -> None:
        if self._vc is not None:
            return
        bootstrap.prepare_env(self.settings)
        self._scope = vendor_paths.ModuleScope()
        with self._context():
            vc_cls = bootstrap.import_vc(self.settings)
            self._config = bootstrap.make_config()
            self._vc = vc_cls(self._config)
            self._scope.snapshot()

    def load(self, model_key: str) -> Dict[str, Any]:
        """加载（或热切换到）指定音色。"""
        path = model_store.find_model(self.settings, model_key)
        if path is None:
            raise bootstrap.VcError(
                "未找到音色模型：%s" % model_key,
                hint="先把 .pth 放进模型库（.data/vc/models），或从界面导入。",
                code="MODEL_MISSING",
            )
        hubert = bootstrap.assets_dir(self.settings) / "hubert" / "hubert_base.pt"
        if not hubert.is_file():
            raise bootstrap.VcError(
                "缺少 RVC 内容特征权重：%s" % hubert,
                hint="运行 python scripts/download_models.py --engine rvc 下载。",
                code="WEIGHT_MISSING",
            )

        self._ensure_vc()
        with self._context():
            self._vc.get_vc(str(path.name))
        self.model_path = path
        self.loaded_at = time.time()
        return self.status()

    def unload(self) -> None:
        """释放模型、还原 cwd、清掉本次引入的上游模块。"""
        if self._vc is not None:
            try:
                with self._context():
                    self._vc.get_vc("", -1)  # 官方语义：空模型名 = 卸载并释放显存
            except Exception:  # noqa: BLE001 - 卸载失败也要往下走
                pass
        self._vc = None
        self._config = None
        self.model_path = None
        if self._scope is not None:
            self._scope.snapshot()
            self._scope.purge()
            self._scope = None
        try:
            import torch  # noqa: PLC0415

            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:  # noqa: BLE001
            pass

    @property
    def ready(self) -> bool:
        return self._vc is not None and self.model_path is not None

    def status(self) -> Dict[str, Any]:
        if not self.ready:
            return {"loaded": False, "model": None}
        meta = model_store.describe(self.model_path)
        return {
            "loaded": True,
            "model": str(self.model_path),
            "name": self.model_path.stem,
            "sample_rate": meta.get("sample_rate"),
            "version": meta.get("version"),
            "f0": meta.get("f0"),
            "has_index": meta.get("has_index"),
            "device": getattr(self._config, "device", None),
            "is_half": getattr(self._config, "is_half", None),
            "held_s": round(time.time() - self.loaded_at, 1) if self.loaded_at else 0.0,
        }

    # ---------- 变声 ----------

    def convert(
        self,
        *,
        src: Path,
        out_path: Path,
        model_key: Optional[str] = None,
        f0_up_key: int = 0,
        f0_method: str = "rmvpe",
        index_rate: float = 0.3,
        filter_radius: int = 3,
        resample_sr: int = 0,
        rms_mix_rate: float = 0.25,
        protect: float = 0.33,
        progress: Optional[ProgressFn] = None,
    ) -> Dict[str, Any]:
        """执行一次语音变声。"""
        if model_key:
            self.load(model_key)
        if not self.ready:
            raise bootstrap.VcError(
                "尚未加载音色模型",
                hint="先在模型库里选一个 .pth。",
                code="MODEL_NOT_LOADED",
            )

        src = Path(src)
        if not src.is_file():
            raise bootstrap.VcError("待变声的音频不存在：%s" % src.name, code="SOURCE_MISSING")

        index = model_store.index_path_for(self.model_path)
        if index and index_rate > 0 and not index.is_file():
            index = None

        if progress:
            progress(0.1, "开始变声（%s）" % self.model_path.stem)

        with self._context():
            info, (tgt_sr, audio) = self._vc.vc_single(
                0,  # 单说话人模型恒为 0（官方 infer_cli.py 也是这么传的）
                str(src),
                int(f0_up_key),
                None,  # f0_file：官方界面用的曲线文件，直连不需要
                f0_method,
                str(index) if index else "",
                "",  # file_index2：备用索引，只在 file_index 为空时生效
                float(index_rate),
                int(filter_radius),
                int(resample_sr),
                float(rms_mix_rate),
                float(protect),
            )
        if audio is None:
            raise bootstrap.VcError(
                "变声失败：%s" % (info or "未知原因"),
                hint="常见原因是输入音频过长或采样率异常；先转成 16k/44.1k 单声道 wav 再试。",
                code="VC_INFER_FAILED",
            )

        if progress:
            progress(0.9, "写入音频")
        array = np.asarray(audio)
        save(out_path, array, int(tgt_sr) if tgt_sr else 44100, subtype="PCM_16")
        if progress:
            progress(1.0, "完成")
        return {
            "output": str(out_path),
            "sample_rate": int(tgt_sr) if tgt_sr else 44100,
            "duration": round(len(array) / float(tgt_sr or 44100), 2),
            "model": str(self.model_path),
            "f0_up_key": f0_up_key,
            "f0_method": f0_method,
            "index_rate": index_rate if index else 0.0,
            "used_index": bool(index),
            "info": str(info or ""),
        }

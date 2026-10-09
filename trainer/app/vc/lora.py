"""底模共享 + LoRA 微调：让「换一个音色」不再等于「重训一个模型」。

RVC 的原生用法是：每个音色从预训练底模出发，全量微调出一个 60~90MB 的 `.pth`。
换音色就要重训一遍，而且每个音色都占一份完整的模型。

LoRA 把这件事拆成两半：

* **底模**：训练一次（或直接用官方预训练权重），冻结不动；
* **适配器**：每个音色只训练一组低秩矩阵（rank 8 时通常 < 5MB），
  可以叠加在底模上，也可以随时拔掉换另一个。

好处是三重的：训练只反传极少数参数（快、显存省、不容易过拟合），
产物小（几十个音色也不占地方），切换是毫秒级的矩阵加法而不是重新加载模型。

实现上有意**不改动上游任何代码**：LoRA 以包装层的形式注入到已加载的模型上，
底模权重原样来自官方 ckpt，适配器是我们自己的产物格式。

关于训练：这里做的是**非对抗式微调**（mel 重建 + KL），不含判别器。
官方全量训练是 GAN，音色上限更高但更慢、更吃显存；
LoRA 微调本来就是在底模已经"会唱歌"的前提下做风格迁移，重建损失足够。
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple, Union

import torch
import torch.nn as nn

from ..config import Settings
from .bootstrap import vendor_root

__all__ = [
    "LoRAConfig",
    "LoRALayer",
    "inject_lora",
    "lora_parameters",
    "adapter_state_dict",
    "load_adapter",
    "merge_adapter",
    "unmerge_adapter",
    "save_adapter",
    "apply_adapter",
    "finetune",
]

#: 注入目标的模块类型。RVC 的生成器基本由这三种搭起来
TARGET_TYPES = (nn.Conv1d, nn.ConvTranspose1d, nn.Linear)


@dataclass
class LoRAConfig:
    rank: int = 8
    alpha: float = 16.0
    dropout: float = 0.0
    #: 通道跨度低于该值的层不注入（太小如 emb_g 768×1 无意义，太小的卷积收益也低）
    min_dim: int = 128

    @property
    def scaling(self) -> float:
        return self.alpha / float(self.rank) if self.rank else 1.0

    def to_dict(self) -> dict:
        return {"rank": self.rank, "alpha": self.alpha, "dropout": self.dropout, "min_dim": self.min_dim}


class LoRALayer(nn.Module):
    """把一个已有层包成 `原输出 + BA(x) * scaling`。

    A 用 1×1 卷积把通道压到 rank，B 再还原回原通道数并保持原来的卷积形状，
    这样输出张量形状与原来完全一致，可以原地替换、不需要改任何调用点。
    初始化时 B 全零 —— 注入后模型行为与底模完全一致，训练才逐步"偏离"。
    """

    def __init__(self, base: nn.Module, config: LoRAConfig) -> None:
        super().__init__()
        self.base = base
        self.rank = int(config.rank)
        self.scaling = float(config.scaling)
        self.dropout = nn.Dropout(config.dropout) if config.dropout > 0 else nn.Identity()

        if isinstance(base, nn.Linear):
            self.lora_a = nn.Linear(base.in_features, self.rank, bias=False)
            self.lora_b = nn.Linear(self.rank, base.out_features, bias=False)
            nn.init.kaiming_uniform_(self.lora_a.weight, a=5**0.5)
            nn.init.zeros_(self.lora_b.weight)
        elif isinstance(base, nn.Conv1d):
            self.lora_a = nn.Conv1d(base.in_channels, self.rank, kernel_size=1, bias=False)
            self.lora_b = nn.Conv1d(
                self.rank,
                base.out_channels,
                kernel_size=base.kernel_size,
                stride=base.stride,
                padding=base.padding,
                dilation=base.dilation,
                bias=False,
            )
            nn.init.kaiming_uniform_(self.lora_a.weight, a=5**0.5)
            nn.init.zeros_(self.lora_b.weight)
        elif isinstance(base, nn.ConvTranspose1d):
            self.lora_a = nn.ConvTranspose1d(base.in_channels, self.rank, kernel_size=1, bias=False)
            self.lora_b = nn.ConvTranspose1d(
                self.rank,
                base.out_channels,
                kernel_size=base.kernel_size,
                stride=base.stride,
                padding=base.padding,
                output_padding=base.output_padding,
                dilation=base.dilation,
                bias=False,
            )
            nn.init.kaiming_uniform_(self.lora_a.weight, a=5**0.5)
            nn.init.zeros_(self.lora_b.weight)
        else:  # pragma: no cover - 由 inject_lora 的类型过滤保证
            raise TypeError("不支持注入 LoRA 的层：%s" % type(base).__name__)

    def forward(self, x: torch.Tensor) -> torch.Tensor:  # noqa: D102 - 见类文档
        return self.base(x) + self.lora_b(self.lora_a(self.dropout(x))) * self.scaling

    def merged_weight_delta(self) -> torch.Tensor:
        """把 BA 折合成一个等效的权重增量（用于 merge）。"""
        weight_b = self.lora_b.weight
        weight_a = self.lora_a.weight
        if isinstance(self.base, nn.Linear):
            delta = weight_b @ weight_a
        else:
            # Conv1d: (out, r, k) × (r, in, 1) -> (out, in, k)
            delta = torch.einsum("ork,riq->oik", weight_b.squeeze(-1), weight_a.squeeze(-1)).unsqueeze(-1)
            if isinstance(self.base, nn.ConvTranspose1d):
                delta = delta.transpose(0, 1)
        return delta * self.scaling


def _parent_of(model: nn.Module, name: str) -> Tuple[nn.Module, str]:
    parts = name.split(".")
    parent = model
    for part in parts[:-1]:
        parent = getattr(parent, part)
    return parent, parts[-1]


def _channel_span(module: nn.Module) -> int:
    """可注入层的"通道跨度"。

    卷积权重形状是 `(out, in, kernel)`，直接取 min(weight.shape) 会拿到 3 的
    卷积核维度，把几乎所有卷积层都过滤掉；这里取前后通道数的较小值，
    与 Linear 的 `min(in, out)` 语义一致 —— LoRA 的 rank 应该压在通道上。
    """
    weight = module.weight
    if isinstance(module, nn.Linear):
        return int(min(weight.shape))
    return int(min(weight.shape[0], weight.shape[1]))


def inject_lora(model: nn.Module, config: Optional[LoRAConfig] = None) -> Dict[str, Any]:
    """给模型注入 LoRA 并冻结底模，返回统计信息。"""
    config = config or LoRAConfig()
    targets: List[Tuple[str, nn.Module]] = []
    for name, module in model.named_modules():
        if not isinstance(module, TARGET_TYPES):
            continue
        # 已被包装过的跳过（重复注入会嵌套，等效 rank 翻倍且难以推理）
        if isinstance(module, LoRALayer):
            continue
        if _channel_span(module) < config.min_dim:
            continue
        targets.append((name, module))

    for name, module in targets:
        parent, child = _parent_of(model, name)
        setattr(parent, child, LoRALayer(module, config))

    for parameter in model.parameters():
        parameter.requires_grad_(False)
    for parameter in lora_parameters(model):
        parameter.requires_grad_(True)

    return {
        "injected": len(targets),
        "rank": config.rank,
        "trainable": sum(p.numel() for p in lora_parameters(model)),
        "total": sum(p.numel() for p in model.parameters()),
        "config": config.to_dict(),
    }


def lora_parameters(model: nn.Module) -> Iterable[nn.Parameter]:
    """模型里所有 LoRA 参数。"""
    for module in model.modules():
        if isinstance(module, LoRALayer):
            yield from module.lora_a.parameters()
            yield from module.lora_b.parameters()


def adapter_state_dict(model: nn.Module) -> Dict[str, torch.Tensor]:
    """抽出适配器权重（前缀 `lora_`），用于存档。"""
    state: Dict[str, torch.Tensor] = {}
    for name, module in model.named_modules():
        if isinstance(module, LoRALayer):
            state["%s.lora_a.weight" % name] = module.lora_a.weight.detach().clone()
            state["%s.lora_b.weight" % name] = module.lora_b.weight.detach().clone()
    return state


def load_adapter(model: nn.Module, state: Dict[str, torch.Tensor]) -> int:
    """把适配器权重写回已注入 LoRA 的模型，返回命中的层数。"""
    applied = 0
    for name, module in model.named_modules():
        if not isinstance(module, LoRALayer):
            continue
        key_a = "%s.lora_a.weight" % name
        key_b = "%s.lora_b.weight" % name
        if key_a in state and key_b in state:
            module.lora_a.weight.data.copy_(state[key_a].to(module.lora_a.weight.device))
            module.lora_b.weight.data.copy_(state[key_b].to(module.lora_b.weight.device))
            applied += 1
    return applied


def merge_adapter(model: nn.Module) -> int:
    """把 LoRA 增量折进底模权重（推理更快，但切换音色要重新注入）。"""
    merged = 0
    for module in model.modules():
        if not isinstance(module, LoRALayer):
            continue
        delta = module.merged_weight_delta()
        base_weight = module.base.weight.data
        if delta.shape == base_weight.shape:
            base_weight.add_(delta.to(base_weight.device, base_weight.dtype))
            merged += 1
    return merged


def unmerge_adapter(model: nn.Module) -> int:
    """`merge_adapter` 的逆操作。"""
    unmerged = 0
    for module in model.modules():
        if not isinstance(module, LoRALayer):
            continue
        delta = module.merged_weight_delta()
        base_weight = module.base.weight.data
        if delta.shape == base_weight.shape:
            base_weight.sub_(delta.to(base_weight.device, base_weight.dtype))
            unmerged += 1
    return unmerged


def save_adapter(model: nn.Module, path: Path, meta: Optional[Dict[str, Any]] = None) -> Path:
    """存一个适配器文件（仅 LoRA 权重 + 元信息）。

    **必须经文件对象写，不能把路径字符串交给 `torch.save`。**
    坑（2026-10 实测）：torch 的 `PyTorchFileWriter` 在 Windows 上用 UTF-16 打开路径，
    文件名里**奇数个非 ASCII 字符**时会越界一格，直接
    `RuntimeError: File ... cannot be opened.`（偶数个则正常，极具迷惑性）。
    用户的中文音色名很容易撞上。走 `open(...,'wb')` 把编码交给 Python 的 IO 层就没这问题。
    """
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "format": "rvc-lora",
        "version": 1,
        "created_at": int(time.time()),
        "meta": meta or {},
        "state": {key: value.cpu() for key, value in adapter_state_dict(model).items()},
    }
    with open(path, "wb") as handle:
        torch.save(payload, handle)
    return path


def apply_adapter(model: nn.Module, adapter_path: Path, config: Optional[LoRAConfig] = None) -> Dict[str, Any]:
    """热切换：注入（如需）→ 载入适配器权重。"""
    payload = torch.load(str(adapter_path), map_location="cpu")
    if not isinstance(payload, dict) or payload.get("format") != "rvc-lora":
        raise ValueError("不是有效的 LoRA 适配器：%s" % adapter_path)
    meta = payload.get("meta") or {}
    if config is None:
        saved = meta.get("config") or {}
        config = LoRAConfig(
            rank=int(saved.get("rank", 8)),
            alpha=float(saved.get("alpha", 16.0)),
            dropout=float(saved.get("dropout", 0.0)),
            min_dim=int(saved.get("min_dim", 64)),
        )
    injected = inject_lora(model, config) if not _has_lora(model) else {"injected": 0}
    applied = load_adapter(model, payload.get("state") or {})
    return {"injected": injected.get("injected", 0), "applied": applied, "meta": meta}


def _has_lora(model: nn.Module) -> bool:
    return any(isinstance(module, LoRALayer) for module in model.modules())


# --------------------------------------------------------------------------
# 微调
# --------------------------------------------------------------------------

#: 官方 config 里我们真正需要的 mel 前端字段。缺一不可，缺了就算错 mel。
_MEL_KEYS = ("filter_length", "n_mel_channels", "sampling_rate", "hop_length", "win_length")


def _load_official_mel_config(sr: str, version: str) -> Dict[str, Any]:
    """读官方 `configs/<v1|v2>/<sr>.json` 里的 `data` 段。

    这是 mel 参数的**唯一权威来源** —— ckpt 里只存模型结构（`config`），
    不存 hop/n_mels 这类前端参数，凭 ckpt 推算一定会错。

    目录选择照抄官方 `infer-web.py`：
        if version19 == "v1" or sr2 == "40k":
            config_path = "v1/%s.json" % sr2
        else:
            config_path = "v2/%s.json" % sr2
    注意 40k 走的是 **v1** 目录（其 n_mel_channels=125，与 v2 的 80/128 都不同）。
    """
    root = Path(__file__).resolve().parents[3] / "vendor" / "rvc" / "configs"
    # `sr` 可能是 `"40k"`，也可能是 ckpt 里的裸赫兹 `"40000"`；配置文件名一律用 `40k` 形态。
    tag = str(sr).strip().lower()
    if tag.endswith("k"):
        tag = tag
    else:
        try:
            tag = "%dk" % (int(float(tag)) // 1000)
        except (TypeError, ValueError):
            tag = str(sr)
    candidates = []
    if version == "v1" or tag == "40k":
        candidates.append(root / "v1" / ("%s.json" % tag))
    candidates.append(root / "v2" / ("%s.json" % tag))
    candidates.append(root / "v1" / ("%s.json" % tag))

    for path in candidates:
        if not path.is_file():
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8")).get("data") or {}
        except Exception:  # noqa: BLE001 - 配置坏了就换下一个候选，最后统一报错
            continue
        if all(key in data for key in _MEL_KEYS):
            return data
    raise FileNotFoundError(
        "找不到官方 mel 配置：sr=%s version=%s（试过 %s）。"
        "vendor/rvc/configs 可能不完整，训练无法保证 mel 与推理一致。"
        % (sr, version, "、".join(str(p) for p in candidates))
    )


def finetune(
    settings: Settings,
    *,
    base_model: Path,
    exp_dir: Path,
    out_path: Path,
    config: Optional[LoRAConfig] = None,
    epochs: int = 10,
    batch_size: int = 4,
    learning_rate: float = 1e-4,
    device: Optional[str] = None,
    progress=None,
) -> Dict[str, Any]:
    """在已准备好的数据集上做 LoRA 微调（非对抗式：mel 重建 + KL）。

    `exp_dir` 是官方预处理产出的实验目录（含 `0_gt_wavs`、`3_feature768` 等），
    由 `vc/training.py` 生成；这里只负责训练。
    """
    from . import bootstrap  # noqa: PLC0415

    config = config or LoRAConfig()
    root = vendor_root(settings)
    filelist = Path(exp_dir) / "filelist.txt"
    if not filelist.is_file():
        raise FileNotFoundError("缺少 filelist.txt：%s（请先完成数据准备）" % filelist)

    samples = _load_filelist(filelist)
    if not samples:
        raise ValueError("filelist.txt 是空的：%s" % filelist)

    from ..vendor_paths import temporary_context  # noqa: PLC0415

    with temporary_context(entries=[str(root)], cwd=str(root), argv=["rvc"]):
        from infer.lib.infer_pack.models import (  # type: ignore  # noqa: PLC0415
            SynthesizerTrnMs256NSFsid,
            SynthesizerTrnMs256NSFsid_nono,
            SynthesizerTrnMs768NSFsid,
            SynthesizerTrnMs768NSFsid_nono,
        )
        from infer.lib.train import losses  # type: ignore  # noqa: PLC0415
        from infer.lib.train.mel_processing import (  # type: ignore  # noqa: PLC0415
            mel_spectrogram_torch,
            spec_to_mel_torch,
        )

        ckpt = torch.load(str(base_model), map_location="cpu")
        cfg = list(ckpt.get("config") or [])
        if not cfg:
            raise ValueError("底模里没有 config 段：%s" % base_model)
        version = str(ckpt.get("version", "v1"))
        f0 = int(ckpt.get("f0", 1))
        sample_rate = int(cfg[-1])
        if version == "v1":
            cls = SynthesizerTrnMs256NSFsid if f0 else SynthesizerTrnMs256NSFsid_nono
        else:
            cls = SynthesizerTrnMs768NSFsid if f0 else SynthesizerTrnMs768NSFsid_nono
        model = cls(*cfg, is_half=False)
        model.load_state_dict(ckpt.get("weight") or {}, strict=False)

        target_device = device or ("cuda" if torch.cuda.is_available() else "cpu")
        # 顺序要紧：**先注入 LoRA，再整体搬上设备**。
        # 反过来的话（先 `.to(device)` 再 `inject_lora`），新插入的 lora_a/lora_b
        # 是 CPU 张量，一旦前向就会 `Expected all tensors to be on the same device`
        # （2026-10 实测）。
        info = inject_lora(model, config)
        model = model.to(target_device)

        params = [p for p in lora_parameters(model)]
        optimizer = torch.optim.AdamW(params, lr=learning_rate)

        # mel 参数必须与官方训练/推理用的**完全一致**，否则算出来的 mel 与模型
        # 期望的分布对不上，听感会发闷、沙哑。这些值不在 ckpt 里，而在官方的
        # `configs/<v1|v2>/<sr>.json` —— 所以直接去读那份 JSON，别自行推算。
        #
        # 坑（2026-10 实测）：早先误取 `cfg[-4]` 当 hop_size。但按官方
        # `process_ckpt.savee()` 的布局，[-4] 是 `upsample_kernel_sizes`，是个 list，
        # 于是 `int() argument must be ... not 'list'` 直接崩。
        # 顺带纠正两个更隐蔽的错误来源：
        #   * 40k 的配置在 `configs/v1/40k.json`（**不是 v2** —— 官方 infer-web.py
        #     明确写 `if version19 == "v1" or sr2 == "40k": config_path = "v1/%s.json"`），
        #     其 `n_mel_channels=125`，既不是 80 也不是 256；
        #   * `n_mel_channels` 与 gin/spk 维度无关，凭 `cfg[-2]` 猜必错。
        mel_cfg = _load_official_mel_config(str(cfg[-1]), version)
        mel_kwargs = dict(
            n_fft=int(mel_cfg["filter_length"]),
            num_mels=int(mel_cfg["n_mel_channels"]),
            sampling_rate=int(mel_cfg["sampling_rate"]),
            hop_size=int(mel_cfg["hop_length"]),
            win_size=int(mel_cfg["win_length"]),
            fmin=float(mel_cfg.get("mel_fmin") or 0.0),
            fmax=mel_cfg.get("mel_fmax"),
        )

        started = time.time()
        for epoch in range(int(epochs)):
            running = 0.0
            count = 0
            for index in range(0, len(samples), int(batch_size)):
                batch = samples[index : index + int(batch_size)]
                tensors = _collate(batch, sample_rate, mel_cfg, target_device)
                if tensors is None:
                    continue
                phone, phone_lengths, pitch, pitchf, spec, spec_lengths, sid = tensors
                optimizer.zero_grad(set_to_none=True)
                with torch.autocast(device_type="cuda", enabled=False):
                    if f0:
                        y_hat, ids_slice, _x_mask, y_mask, (z, z_p, m_p, logs_p, m_q, logs_q) = model(
                            phone, phone_lengths, pitch, pitchf, spec, spec_lengths, sid
                        )
                    else:
                        y_hat, ids_slice, _x_mask, y_mask, (z, z_p, m_p, logs_p, m_q, logs_q) = model(
                            phone, phone_lengths, spec, spec_lengths, sid
                        )
                    # ---- 损失，口径对齐官方 train.py ----
                    # 目标 mel：线性谱 → spec_to_mel；预测 mel：波形 → mel_spectrogram。
                    # 两者都裁到共同长度再算 L1，避免 segment 切分导致的错位。
                    mel = spec_to_mel_torch(
                        spec.float(),
                        int(mel_cfg["filter_length"]),
                        int(mel_cfg["n_mel_channels"]),
                        int(mel_cfg["sampling_rate"]),
                        float(mel_cfg.get("mel_fmin") or 0.0),
                        mel_cfg.get("mel_fmax"),
                    )
                    y_mel = mel_spectrogram_torch(y_hat.float().squeeze(1), **mel_kwargs)
                    span = min(mel.size(-1), y_mel.size(-1))
                    loss = torch.nn.functional.l1_loss(y_mel[..., :span], mel[..., :span]) * 45.0
                    loss = loss + losses.kl_loss(z_p, logs_q, m_p, logs_p, y_mask)
                loss.backward()
                optimizer.step()
                running += float(loss.detach().cpu())
                count += 1
            if progress:
                progress((epoch + 1) / float(epochs), "第 %d/%d 轮，loss %.3f" % (epoch + 1, epochs, running / max(count, 1)))

    out_path = Path(out_path)
    save_adapter(model, out_path, {"config": config.to_dict(), "base": str(base_model), "epochs": epochs})
    return {
        "adapter": str(out_path),
        "base": str(base_model),
        "epochs": epochs,
        "samples": len(samples),
        "injected_layers": info["injected"],
        "trainable_params": info["trainable"],
        "elapsed_s": round(time.time() - started, 1),
    }


def _load_filelist(path: Path) -> List[List[str]]:
    """解析官方 filelist：`gt|feature|f0|f0nsf|spk`（无 f0 时少两列）。"""
    samples: List[List[str]] = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        samples.append(line.split("|"))
    return samples


def _collate(batch: List[List[str]], sample_rate: int, spectrogram: Any, device: str):
    """把一个 batch 的样本拼成模型输入。单条失败不影响整批。

    返回需与 `SynthesizerTrnMs768NSFsid.forward` 的顺序严格对应：
        phone, phone_lengths, pitch, pitchf, spec, spec_lengths, sid

    要点（每一条都踩过）：
      * `spec` 必须是**线性谱**（通道数 = `n_fft//2+1`，40k 是 1025），
        直接把波形塞进去会撞 `enc_q` 的 `spec_channels`：
        「expected input[...] to have 1025 channels, but got 1 channels」。
      * `sid` 不能漏，否则 `emb_g(ds)` 收到 None。
      * `spec_lengths` 是**帧数**（= 波形样本数 // hop_length），不是样本数。
    """
    phones, pitches, pitchfs, linears, sids = [], [], [], [], []
    for item in batch:
        try:
            import numpy as np  # noqa: PLC0415

            feature = np.load(item[1])  # hubert 内容特征 [T, 768]
            audio, _ = _read_audio(item[0], sample_rate)  # 原始波形（float32，[-1,1]）
            if audio is None or audio.size == 0:
                continue
            # 线性谱：官方 `text.spectrogram_torch` 的等价实现，n_fft=filter_length
            linear = _linear_spectrogram(audio, spectrogram, device="cpu")
            if linear is None or linear.size(-1) <= 0:
                continue
            phone = torch.from_numpy(feature).float()
            if len(item) >= 4:
                pitch = torch.from_numpy(np.load(item[2])).float()
                pitchf = torch.from_numpy(np.load(item[3])).float()
            else:
                pitch = pitchf = None

            # 三者的时间轴必须对齐到帧：特征帧数 ≤ 线性谱帧数
            spec_len = linear.size(-1)
            feature_len = phone.size(0)
            length = min(feature_len, spec_len)
            if length <= 0:
                continue

            # filelist 官方格式最后一列是说话人 id；缺失时按 0 处理
            # （单说话人微调本来就是 0，官方 infer-web 写 filelist 时也填 0）。
            sid = 0
            if len(item) >= 5:
                try:
                    sid = int(item[4])
                except (TypeError, ValueError):
                    sid = 0

            phones.append(phone[:length])
            linears.append(linear[..., :length])
            sids.append(sid)
            if pitch is not None:
                pitches.append(pitch[:length].long())
                pitchfs.append(pitchf[:length])
        except Exception:  # noqa: BLE001 - 单条数据损坏就跳过，训练不该被一条坏样本中断
            continue

    if not phones:
        return None
    max_len = max(p.size(0) for p in phones)
    phone_batch = torch.zeros(len(phones), max_len, phones[0].size(-1))
    phone_lengths = torch.LongTensor([p.size(0) for p in phones])
    spec_channels = linears[0].size(0)
    spec_batch = torch.zeros(len(linears), spec_channels, max_len)
    for index, (phone, linear) in enumerate(zip(phones, linears)):
        phone_batch[index, : phone.size(0)] = phone
        spec_batch[index, :, : linear.size(-1)] = linear

    out = [phone_batch.to(device), phone_lengths.to(device)]
    if pitches:
        pitch_batch = torch.zeros(len(pitches), max_len, dtype=torch.long)
        pitchf_batch = torch.zeros(len(pitchfs), max_len)
        for index, (pitch, pitchf) in enumerate(zip(pitches, pitchfs)):
            pitch_batch[index, : pitch.size(0)] = pitch
            pitchf_batch[index, : pitchf.size(0)] = pitchf
        out += [pitch_batch.to(device), pitchf_batch.to(device)]
    else:
        out += [torch.zeros(1).to(device), torch.zeros(1).to(device)]
    # spec_lengths 是帧数（官方 train.py 传的就是 y_lengths = 帧数），
    # 不是样本数 —— 传错会让 y_mask 与 enc_q 的卷积步长对不上。
    out += [spec_batch.to(device), phone_lengths.to(device)]
    out += [torch.LongTensor(sids).to(device)]
    return tuple(out)


def _read_audio(path: str, sample_rate: int):
    """读一条音频为 float32 单声道。返回 (np.ndarray | None, sr)。"""
    import numpy as np  # noqa: PLC0415

    try:
        import soundfile as sf  # noqa: PLC0415

        data, sr = sf.read(path, dtype="float32", always_2d=False)
        if data.ndim > 1:
            data = data.mean(axis=1)
        if sr != sample_rate:
            import librosa  # noqa: PLC0415

            data = librosa.resample(np.asarray(data, dtype=np.float32), orig_sr=sr, target_sr=sample_rate)
        return np.asarray(data, dtype=np.float32), sample_rate
    except Exception:  # noqa: BLE001
        try:
            import librosa  # noqa: PLC0415

            data, _ = librosa.load(path, sr=sample_rate, mono=True)
            return np.asarray(data, dtype=np.float32), sample_rate
        except Exception:  # noqa: BLE001
            return None, sample_rate


def _linear_spectrogram(audio, cfg: Any, device: str = "cpu"):
    """线性幅度谱，等价官方 `text.spectrogram_torch`（return_complex=False）。"""
    import numpy as np  # noqa: PLC0415
    import torch  # noqa: PLC0415

    n_fft = int(cfg["filter_length"])
    hop = int(cfg["hop_length"])
    win = int(cfg["win_length"])
    try:
        tensor = torch.from_numpy(np.asarray(audio, dtype=np.float32)).to(device)
        window = torch.hann_window(win).to(device)
        spec = torch.stft(
            tensor,
            n_fft,
            hop_length=hop,
            win_length=win,
            window=window,
            center=True,
            pad_mode="reflect",
            normalized=False,
            onesided=True,
            return_complex=True,
        )
        spec = torch.sqrt(spec.real.pow(2) + spec.imag.pow(2) + 1e-6)
        return spec.squeeze(0)
    except Exception:  # noqa: BLE001
        return None

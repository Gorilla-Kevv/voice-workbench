"""HTTP 契约层（Pydantic v2）。

**兼容性硬约束**：本服务运行在整合包自带的 Python 3.9 上，
而 Pydantic 会在定义模型时即时求值类型注解，因此这里
**禁止使用 PEP 604 联合类型（`str | None`）与内建泛型别名**，
统一使用 `typing.Optional / List / Dict`。违反这条会在 import 阶段直接崩。

设计取舍：

* 音频默认返回 **URL** 而非 base64 —— 本地服务与浏览器同机，
  走静态文件既能被 `<audio>` 直接 seek，也避免 base64 的 1.33 倍膨胀；
  需要内联时显式传 `inline_base64=true`；
* 合成参数分两层：核心字段显式声明（便于生成 OpenAPI 文档），
  `params` 与额外字段原样透传给官方管线（`extra="allow"`），
  这样官方新增参数时前端不必等待服务端升级。
"""

from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

SCHEMA_VERSION = "2.0"
SERVICE_VERSION = "2.0.0"

TtsMode = Literal["preset", "clone", "design"]


# ==========================================================================
# 通用
# ==========================================================================


class FlexibleModel(BaseModel):
    """允许透传额外字段的基类。

    官方管线有 20 多个参数且仍在演进，逐一声明会产生大量样板代码，
    也会让「官方加了参数但我们还没跟上」变成一个假故障。
    """

    model_config = ConfigDict(extra="allow", protected_namespaces=())


class MessageResponse(BaseModel):
    ok: bool = True
    message: str = ""
    data: Optional[Dict[str, Any]] = None


class ErrorBody(BaseModel):
    ok: bool = False
    error: Dict[str, Any]


# ==========================================================================
# 健康检查 / 能力清单
# ==========================================================================


class HealthResponse(BaseModel):
    ok: bool = True
    schema_version: str = SCHEMA_VERSION
    version: str = SERVICE_VERSION
    mode: str = "local"
    uptime_s: float = 0.0
    #: 是否所有前置条件都满足（找到安装 + torch 可用 + 权重齐备）
    ready: bool = False
    settings: Dict[str, Any] = Field(default_factory=dict)
    environment: Dict[str, Any] = Field(default_factory=dict)
    runtime: Dict[str, Any] = Field(default_factory=dict)
    pipeline: Dict[str, Any] = Field(default_factory=dict)
    scheduler: Dict[str, Any] = Field(default_factory=dict)
    capabilities: Dict[str, Any] = Field(default_factory=dict)
    voices: Dict[str, Any] = Field(default_factory=dict)
    blockers: List[str] = Field(default_factory=list)
    warnings: List[str] = Field(default_factory=list)
    hints: List[str] = Field(default_factory=list)


# ==========================================================================
# 音色库
# ==========================================================================


class VoiceCreateRequest(FlexibleModel):
    name: str = Field(..., min_length=1, max_length=80, description="音色名称")
    prompt_text: str = Field("", description="参考音频的逐字转写文本")
    prompt_lang: str = Field("zh", description="参考音频语种（zh/en/ja/ko/yue/auto）")
    note: str = Field("", description="备注")
    tags: List[str] = Field(default_factory=list)
    #: 与 `audio_path` 二选一：引用磁盘上已有的音频文件（不复制）
    audio_path: Optional[str] = Field(None, description="磁盘上的音频绝对路径（相对路径按 GPT-SoVITS 根目录解析）")


class VoiceUpdateRequest(FlexibleModel):
    name: Optional[str] = None
    prompt_text: Optional[str] = None
    prompt_lang: Optional[str] = None
    note: Optional[str] = None
    tags: Optional[List[str]] = None
    audio_path: Optional[str] = None


class VoiceView(BaseModel):
    ok: bool = True
    voice: Dict[str, Any]


class VoiceListView(BaseModel):
    ok: bool = True
    voices: List[Dict[str, Any]] = Field(default_factory=list)
    total: int = 0


# ==========================================================================
# 权重与管线
# ==========================================================================


class WeightLoadRequest(FlexibleModel):
    version: Optional[str] = Field(None, description="模型版本，如 v2ProPlus")
    gpt: Optional[str] = Field(None, description="GPT 权重路径或文件名片段")
    sovits: Optional[str] = Field(None, description="SoVITS 权重路径或文件名片段")
    device: Optional[str] = Field(None, description="cuda:0 / cpu / auto")
    is_half: Optional[bool] = None
    #: 是否立刻加载（默认 true；false 则只登记意图，等下次合成时加载）
    eager: bool = True


class WeightListView(BaseModel):
    ok: bool = True
    version: str
    gpt: List[Dict[str, Any]] = Field(default_factory=list)
    sovits: List[Dict[str, Any]] = Field(default_factory=list)
    active: Dict[str, Any] = Field(default_factory=dict)


# ==========================================================================
# 合成
# ==========================================================================


class TTSRequest(FlexibleModel):
    """单条合成请求。"""

    mode: TtsMode = "preset"
    text: str = Field(..., min_length=1, description="待合成文本")
    #: 音色库中的音色 ID；也接受音频文件路径
    voice: Optional[str] = Field(None, description="音色库 ID，或直接给参考音频路径")
    ref_audio_path: Optional[str] = Field(None, description="参考音频路径（与 voice 二选一）")
    prompt_text: Optional[str] = Field(None, description="参考音频转写文本")
    prompt_lang: Optional[str] = Field(None, description="参考音频语种")
    text_lang: Optional[str] = Field(None, description="待合成文本语种")
    #: 官方支持多参考音频融合，可显著缓解音色漂移
    aux_ref_audio_paths: List[str] = Field(default_factory=list)
    instruction: Optional[str] = Field(None, description="保留字段：MiMo 音色设计使用，此处忽略")
    #: 目标模型版本与权重（留空用服务端默认）
    version: Optional[str] = None
    gpt: Optional[str] = None
    sovits: Optional[str] = None
    device: Optional[str] = None
    is_half: Optional[bool] = None
    #: 是否在响应里内联 base64（默认 false，只给 URL）
    inline_base64: bool = False
    #: 官方参数集合，逐项透传；见 catalog.DEFAULT_SYNTH_PARAMS
    params: Dict[str, Any] = Field(default_factory=dict)


class TTSResponse(BaseModel):
    ok: bool = True
    #: 相对服务地址的静态文件路径，可直接交给 <audio src>
    audio_url: Optional[str] = None
    audio: Optional[str] = Field(None, description="base64 音频，仅当 inline_base64=true")
    mime_type: str = "audio/wav"
    bytes: int = 0
    duration_s: float = 0.0
    sample_rate: int = 0
    text: str = ""
    text_lang: str = ""
    mode: str = "preset"
    version: str = ""
    gpt_model: Optional[str] = None
    sovits_model: Optional[str] = None
    voice_id: Optional[str] = None
    voice_name: Optional[str] = None
    job_id: Optional[str] = None
    elapsed_ms: int = 0
    warning: Optional[str] = None


class TextSplitRequest(FlexibleModel):
    text: str = Field(..., min_length=1)
    text_lang: str = "zh"
    text_split_method: str = "cut5"


class TextSplitResponse(BaseModel):
    ok: bool = True
    segments: List[Dict[str, Any]] = Field(default_factory=list)
    total: int = 0
    chars: int = 0


# ==========================================================================
# 批量合成
# ==========================================================================


class BatchItem(FlexibleModel):
    """批量合成的一条。未填的字段继承请求级默认值。

    `text` 刻意不做 `min_length` 校验：批量清单里混入空行/空单元格是常态，
    把整批请求判为 422 会很烦人。空条目在展开阶段被安静跳过，并在清单里可见。
    """

    text: str = ""
    #: 便于用户对号入座（例如 Excel 行号、角色名）
    key: Optional[str] = None
    voice: Optional[str] = Field(None, description="覆盖默认音色")
    text_lang: Optional[str] = None
    prompt_text: Optional[str] = None
    params: Dict[str, Any] = Field(default_factory=dict)


class BatchRequest(FlexibleModel):
    """批量合成请求。

    这是本项目相对官方 WebUI 增补的核心能力：官方只能逐条粘贴文本，
    本服务接受「一份文本清单」，一次产出「一批音频 + 一个 ZIP」。
    """

    items: List[BatchItem] = Field(default_factory=list, description="待合成条目")
    #: 也可直接给「一段长文本」，服务端按换行/标点切分后逐条合成
    text: Optional[str] = Field(None, description="整段文本，按行切分为条目")
    #: 请求级默认值，被条目级字段覆盖
    voice: Optional[str] = None
    ref_audio_path: Optional[str] = None
    prompt_text: Optional[str] = None
    prompt_lang: Optional[str] = None
    text_lang: Optional[str] = None
    aux_ref_audio_paths: List[str] = Field(default_factory=list)
    version: Optional[str] = None
    gpt: Optional[str] = None
    sovits: Optional[str] = None
    device: Optional[str] = None
    is_half: Optional[bool] = None
    params: Dict[str, Any] = Field(default_factory=dict)
    #: 输出文件名模板，支持 {index} {key}
    filename_template: str = "{index:04d}"
    #: 是否打包 ZIP（默认 true）
    make_zip: bool = True
    #: 单条失败是否继续（默认 true）
    continue_on_error: bool = True
    #: 是否同步等待（默认 true；false 则立即返回 job_id 由前端轮询）
    wait: bool = True


class BatchItemResult(BaseModel):
    index: int
    key: Optional[str] = None
    text: str = ""
    ok: bool = False
    audio_url: Optional[str] = None
    filename: Optional[str] = None
    bytes: int = 0
    duration_s: float = 0.0
    elapsed_ms: int = 0
    error: Optional[str] = None
    hint: Optional[str] = None


class BatchResponse(BaseModel):
    ok: bool = True
    job_id: Optional[str] = None
    state: str = "succeeded"
    total: int = 0
    succeeded: int = 0
    failed: int = 0
    total_duration_s: float = 0.0
    elapsed_ms: int = 0
    results: List[BatchItemResult] = Field(default_factory=list)
    zip_url: Optional[str] = None
    manifest_url: Optional[str] = None
    message: str = ""


# ==========================================================================
# 训练
# ==========================================================================


class SliceParams(FlexibleModel):
    """音频切分参数，默认值对齐官方 WebUI。"""

    threshold: float = -34.0
    min_length: float = 4000.0
    min_interval: float = 300.0
    hop_size: float = 10.0
    max_sil_kept: float = 500.0
    max: float = 0.9
    alpha: float = 0.25
    n_parts: int = 1


class TrainRequest(FlexibleModel):
    """一键训练请求。

    语料来源有两种：

    * `source_audio_dir` —— 服务器本地目录（或 `/v1/train/upload` 返回的目录），
      里面放原始音频；若同时存在同名 `.lab` 文件则直接用作文本，否则走 ASR；
    * `list_file` —— 已经准备好的官方格式清单
      （每行 `音频名|说话人|语种|文本`），此时跳过 ASR 与标注整理。

    与官方 WebUI 的对应关系：本请求等价于「0-前置工具（降噪/切分/ASR/标注）」
    + 「1-训练（格式化 → GPT → SoVITS）」两页的完整串联。
    """

    name: str = Field(..., min_length=1, max_length=64, description="实验名，同时用作输出目录名")
    source_audio_dir: Optional[str] = Field(None, description="原始语料目录")
    list_file: Optional[str] = Field(None, description="已有的 list 清单文件")

    text_lang: Literal["zh", "en", "ja", "ko", "yue"] = "zh"
    version: str = "v2ProPlus"
    speaker: str = "default"
    gpu_ids: str = "0"

    # ---------- 阶段开关 ----------
    run_denoise: bool = Field(False, description="语音降噪（tools/cmd-denoise.py）")
    run_slice: bool = Field(True, description="静音切分（tools/slice_audio.py）")
    run_asr: bool = Field(True, description="语音转文本（FunASR / faster-whisper）")
    run_format: bool = Field(True, description="格式化训练集（1-get-text / 2-get-hubert / 2-get-sv / 3-get-semantic）")
    run_s1: bool = Field(True, description="GPT（语义）训练")
    run_s2: bool = Field(True, description="SoVITS（声学）训练")

    # ---------- 前置处理参数 ----------
    slice: SliceParams = Field(default_factory=SliceParams)
    asr_backend: Literal["funasr", "fasterwhisper"] = "funasr"
    asr_model_size: str = "large"
    asr_language: str = "zh"
    asr_precision: Literal["float16", "float32", "int8"] = "float16"

    # ---------- GPT（s1）训练参数 ----------
    epochs_s1: int = Field(15, ge=1, le=1000)
    batch_size_s1: int = Field(6, ge=1, le=128)
    save_every_epoch_s1: int = Field(5, ge=1, le=1000)
    if_dpo: bool = False

    # ---------- SoVITS（s2）训练参数 ----------
    epochs_s2: int = Field(8, ge=1, le=1000)
    batch_size_s2: int = Field(6, ge=1, le=128)
    save_every_epoch_s2: int = Field(4, ge=1, le=1000)
    text_low_lr_rate: float = Field(0.4, ge=0.0, le=1.0)
    if_grad_ckpt: bool = False
    lora_rank: int = Field(32, ge=1, le=256)

    # ---------- 通用训练开关 ----------
    if_save_every_weights: bool = True
    if_save_latest: bool = True
    dry_run: bool = False
    #: 训练前先验证命令能否构造出来，不真正执行
    plan_only: bool = False


class TrainResponse(BaseModel):
    ok: bool = True
    job_id: str
    state: str = "queued"
    stages: List[Dict[str, Any]] = Field(default_factory=list)
    message: str = ""


class UploadResponse(BaseModel):
    ok: bool = True
    dir: str
    files: List[str] = Field(default_factory=list)
    rejected: List[str] = Field(default_factory=list)
    message: str = ""


# ==========================================================================
# 任务
# ==========================================================================


class JobView(BaseModel):
    ok: bool = True
    job: Dict[str, Any]


class JobListView(BaseModel):
    ok: bool = True
    jobs: List[Dict[str, Any]] = Field(default_factory=list)
    total: int = 0


class CancelRequest(BaseModel):
    reason: str = ""

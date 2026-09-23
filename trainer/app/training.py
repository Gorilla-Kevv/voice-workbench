"""训练流水线编排。

完整对齐官方 WebUI 的两页流程（「0-前置工具」+「1-训练」），共 11 个阶段：

    import → denoise → slice → asr → list → text → hubert → sv → semantic → s1 → s2
    语料导入   降噪      切分    识别   清单   分词     HuBERT   说话人   语义      GPT   SoVITS

几个必须讲清楚的工程事实（都来自官方源码，不是我们的发明）：

* **切分之后文本就丢了**：`tools/slice_audio.py` 只输出音频，
  因此 `run_slice=true` 时必须有 ASR，否则没有文本可训。
  如果你手上已有「音频 + 同名 .lab 文本」的成对数据，请关掉切分与 ASR。
* **ASR 的产物就是训练清单**：`funasr_asr.py` 直接写出
  `绝对路径|说话人名|语种|文本`，这份格式正是 `1-get-text.py` 需要的。
  所以「清单」这一步只在「用 .lab 文本」时才由我们生成。
* **格式化的四个脚本没有命令行参数**，全部靠环境变量驱动
  （见 `prepare_datasets/*.py`），并且按 `i_part` 分片输出，
  跑完还要把分片拼回 `2-name2text.txt` 与 `6-name2semantic.tsv` —— 官方 WebUI 也是这么做的。
* **FunASR 只支持中文与粤语**（`create_model` 里对其它语种直接抛错），
  日语/韩语/英语必须换 faster-whisper；这一点在派发前就会拦下并给出建议。
* **权重写到官方目录**，实验数据写到本项目的 `experiments/` —— 这样既能让训练产物
  立刻被推理侧发现，又不会把 GPT-SoVITS 安装目录塞满中间文件。
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from .config import AUDIO_SUFFIXES, Settings
from .errors import BadRequestError, SovitsError
from .jobs import Job, JobStage, JobState, JobStore
from .models import TrainRequest
from .sovits import bootstrap, catalog

# --------------------------------------------------------------------------
# 阶段定义
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class Stage:
    key: str
    label: str
    phase: str  # corpus | dataset | train
    note: str = ""


STAGES: Tuple[Stage, ...] = (
    Stage("import", "语料导入", "corpus", "收集音频、识别可用的同名文本"),
    Stage("denoise", "语音降噪", "corpus", "tools/cmd-denoise.py"),
    Stage("slice", "音频切分", "corpus", "tools/slice_audio.py，切成 5~15 秒片段"),
    Stage("asr", "语音转文本", "corpus", "FunASR / faster-whisper，同时产出训练清单"),
    Stage("list", "生成训练清单", "corpus", "wav|说话人|语种|文本"),
    Stage("text", "文本与 BERT 特征", "dataset", "prepare_datasets/1-get-text.py"),
    Stage("hubert", "HuBERT 特征与重采样", "dataset", "prepare_datasets/2-get-hubert-wav32k.py"),
    Stage("sv", "说话人向量", "dataset", "prepare_datasets/2-get-sv.py（仅 v2Pro / v2ProPlus）"),
    Stage("semantic", "语义 Token", "dataset", "prepare_datasets/3-get-semantic.py"),
    Stage("s1", "GPT（语义）训练", "train", "s1_train.py"),
    Stage("s2", "SoVITS（声学）训练", "train", "s2_train.py"),
)

_STAGE_BY_KEY = {stage.key: stage for stage in STAGES}

#: 每个阶段的权重，用于把「步骤数」换算成更接近真实耗时的进度
_STAGE_WEIGHT = {
    "import": 0.02,
    "denoise": 0.06,
    "slice": 0.05,
    "asr": 0.14,
    "list": 0.01,
    "text": 0.06,
    "hubert": 0.08,
    "sv": 0.04,
    "semantic": 0.06,
    "s1": 0.22,
    "s2": 0.26,
}


@dataclass
class Step:
    """一个待执行步骤。`cmd is None` 表示由服务内联完成。"""

    stage: Stage
    cmd: Optional[List[str]] = None
    env: Dict[str, str] = field(default_factory=dict)
    note: str = ""
    #: 需要按分片并行执行的多条命令（预处理脚本按 GPU 分片）
    shards: List[List[str]] = field(default_factory=list)


@dataclass
class TrainContext:
    """一次训练的全部路径与派生信息。所有路径都是绝对路径。"""

    name: str
    version: str
    home: Path
    workdir: Path
    dataset_dir: Path
    audio_dir: Path
    list_path: Path
    speaker: str
    text_lang: str
    has_lab_text: bool = False
    asr_list: Optional[Path] = None

    @property
    def dataset_file_phoneme(self) -> Path:
        return self.dataset_dir / catalog.DATASET_FILES["phoneme"]

    @property
    def dataset_file_semantic(self) -> Path:
        return self.dataset_dir / catalog.DATASET_FILES["semantic"]

    def to_dict(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "version": self.version,
            "workdir": str(self.workdir),
            "audio_dir": str(self.audio_dir),
            "list_path": str(self.list_path),
            "speaker": self.speaker,
            "text_lang": self.text_lang,
        }


@dataclass
class TrainHooks:
    """训练开始/结束时的外部钩子。

    存在的唯一理由是**显存互斥**：训练脚本会自己加载一整套模型，
    而本服务常驻的推理管线占着同一张卡。训练开始前必须把推理管线释放掉，
    否则在 8GB 级别的消费级显卡上几乎一定 OOM（实测如此）。
    用钩子而不是让 `TrainEngine` 直接依赖 `Pipeline`，是为了让训练逻辑
    可以在没有推理管线的环境下（例如纯训练部署）独立工作。
    """

    on_start: Optional[Callable[[], None]] = None
    on_finish: Optional[Callable[[], None]] = None

    def start(self) -> None:
        if self.on_start:
            self.on_start()

    def finish(self) -> None:
        if self.on_finish:
            self.on_finish()


class TrainEngine:
    """把 `TrainRequest` 翻译成可执行的步骤序列，并负责跑完它。"""

    def __init__(
        self,
        settings: Settings,
        store: JobStore,
        hooks: Optional[TrainHooks] = None,
    ) -> None:
        self.settings = settings
        self.store = store
        self.hooks = hooks or TrainHooks()

    # ------------------------------------------------------------------
    # 规划
    # ------------------------------------------------------------------

    def plan(self, request: TrainRequest) -> Tuple[TrainContext, List[Step], List[str]]:
        """构造执行计划。任何前置条件不满足都在这里报错，而不是等跑到一半。"""
        installation = bootstrap.current()
        if installation is None:
            raise SovitsError(
                "未定位到 GPT-SoVITS 安装目录",
                hint="设置 GPT_SOVITS_HOME 环境变量指向整合包根目录后重启服务。",
                code="ENV_NOT_READY",
                status=503,
            )
        home = installation.home

        if request.version not in catalog.VERSIONS:
            raise BadRequestError(
                "未知模型版本：%s" % request.version,
                hint="可选值：%s" % "、".join(catalog.VERSIONS),
            )

        context = self._build_context(request, home, installation)
        skipped: List[str] = []
        steps: List[Step] = []

        # ---------- 语料阶段的互斥关系 ----------
        asr_allowed = request.run_asr
        slice_allowed = request.run_slice

        if not context.has_lab_text and not asr_allowed:
            raise BadRequestError(
                "语料里没有可用的同名文本（.lab / .txt），且未开启语音转文本",
                hint=(
                    "两种做法任选其一：\n"
                    "1) 开启「语音转文本」，让 FunASR / faster-whisper 自动生成文本；\n"
                    "2) 为每个音频准备一个同名 .lab 文本文件（编码 UTF-8），再关闭 ASR。"
                ),
                code="NO_TRANSCRIPT",
            )
        if slice_allowed and not asr_allowed and not context.has_lab_text:
            raise BadRequestError(
                "开启切分后必须开启语音转文本",
                hint="切分会丢弃原音频对应的文本，因此切分后只能靠 ASR 重新标注。",
                code="SLICE_REQUIRES_ASR",
            )

        if asr_allowed:
            backend = catalog.ASR_BACKENDS[request.asr_backend]
            if request.asr_backend == "funasr" and request.text_lang not in {"zh", "yue"}:
                raise BadRequestError(
                    "FunASR 只支持中文与粤语，无法识别语种 %s" % request.text_lang,
                    hint="请把 ASR 后端改为 faster-whisper（支持 %s）。"
                    % "、".join(catalog.ASR_BACKENDS["fasterwhisper"]["languages"]),
                    code="ASR_LANGUAGE_UNSUPPORTED",
                )
            if request.asr_language not in backend["languages"]:
                raise BadRequestError(
                    "%s 不支持语种 %s" % (backend["label"], request.asr_language),
                    hint="可用取值：%s" % "、".join(backend["languages"]),
                    code="ASR_LANGUAGE_UNSUPPORTED",
                )

        # ---------- 组装步骤 ----------
        steps.append(Step(stage=_STAGE_BY_KEY["import"], note="扫描语料并准备工作目录"))

        if request.run_denoise:
            steps.append(self._step_denoise(request, context))
        else:
            skipped.append("语音降噪：未勾选")

        if slice_allowed:
            steps.append(self._step_slice(request, context))
        else:
            skipped.append("音频切分：未勾选（按原文件直接使用）")

        if asr_allowed:
            steps.append(self._step_asr(request, context))
        else:
            skipped.append("语音转文本：未勾选（使用语料目录中的同名 .lab 文本）")

        # ASR 会自己产出清单；只有「用 .lab」时才需要我们生成
        if not asr_allowed:
            steps.append(Step(stage=_STAGE_BY_KEY["list"], note="由 .lab 文本生成官方格式清单"))
        elif request.list_file:
            skipped.append("生成训练清单：ASR 已产出清单")

        if request.run_format:
            steps.extend(self._steps_format(request, context, installation))
        else:
            skipped.append("格式化训练集：未勾选（将直接使用已存在的 2-name2text.txt / 6-name2semantic.tsv）")
            for key in ("text", "hubert", "sv", "semantic"):
                if key in _REQUIRED_DATASET_FILES:
                    self._require_dataset_file(context, key)

        if request.run_s1:
            steps.append(self._step_s1(request, context, installation))
        else:
            skipped.append("GPT（语义）训练：未勾选")

        if request.run_s2:
            steps.append(self._step_s2(request, context, installation))
        else:
            skipped.append("SoVITS（声学）训练：未勾选")

        if not any(step.stage.key in {"s1", "s2"} for step in steps):
            raise BadRequestError(
                "没有勾选任何训练阶段（GPT / SoVITS 至少选一个）",
                hint="若只想重跑数据预处理，请关闭全部训练开关并勾选所需的前置步骤。",
                code="NO_TRAIN_STAGE",
            )

        return context, steps, skipped

    # ---------- 上下文 ----------

    def _build_context(self, request: TrainRequest, home: Path, installation: Any) -> TrainContext:
        name = _safe_name(request.name)

        workdir = self.settings.experiments_dir / name
        dataset_dir = workdir / "dataset"

        if request.list_file:
            list_path = Path(request.list_file).expanduser()
            if not list_path.is_file():
                raise BadRequestError("指定的清单文件不存在：%s" % list_path)
            audio_dir = Path(request.source_audio_dir).expanduser() if request.source_audio_dir else home
            # 自带清单 = 文本已就绪，因此「无文本」的前置校验要放行
            has_lab = True
        else:
            if not request.source_audio_dir:
                raise BadRequestError(
                    "缺少语料目录",
                    hint="请填写 source_audio_dir（本地绝对路径），或先调用 /v1/train/upload 上传语料。",
                )
            audio_dir = Path(request.source_audio_dir).expanduser()
            if not audio_dir.is_dir():
                raise BadRequestError(
                    "语料目录不存在：%s" % audio_dir,
                    hint="若是通过 /v1/train/upload 上传的，请使用返回的 dir 字段。",
                )
            has_lab = self._scan_lab(audio_dir)
            # 清单路径**在规划期就完全确定**，不依赖任何「跑完再找」的逻辑。
            # 否则「规划」与「执行」会看到不同的目录状态，命令拼装随之漂移 ——
            # 这是最难查的一类缺陷（dry-run 通过，真跑失败）。
            list_path = self._plan_list_path(request, dataset_dir, audio_dir)

        context = TrainContext(
            name=name,
            version=request.version,
            home=home,
            workdir=workdir,
            dataset_dir=dataset_dir,
            audio_dir=audio_dir,
            list_path=list_path,
            speaker=request.speaker or "default",
            text_lang=request.text_lang,
            has_lab_text=has_lab,
            asr_list=Path(request.list_file).expanduser() if request.list_file else None,
        )
        return context

    @staticmethod
    def _plan_list_path(request: TrainRequest, dataset_dir: Path, audio_dir: Path) -> Path:
        """纯函数式地推导训练清单路径。

        * 开了 ASR：清单由 ASR 脚本产出，路径与官方约定一致
          （`<输出目录>/<输入目录名>.list`）；
        * 没开 ASR：由我们用 `.lab` 文本生成到 `dataset/train.list`。
        """
        if request.run_asr:
            stage_dir = TrainEngine._stage_dir_static(request, dataset_dir, audio_dir)
            return dataset_dir / "asr" / ("%s.list" % stage_dir.name)
        return dataset_dir / "train.list"

    @staticmethod
    def _stage_dir_static(request: TrainRequest, dataset_dir: Path, audio_dir: Path) -> Path:
        """ASR 与特征提取所使用的音频目录。

        必须与 `_slice_input` 一起看：降噪 → 切分 → 识别是一条单向链，
        每一环的输入都是上一环的输出目录。
        """
        if request.run_slice:
            return dataset_dir / "sliced"
        if request.run_denoise:
            return dataset_dir / "denoised"
        return audio_dir

    def _stage_dir(self, request: TrainRequest, context: TrainContext) -> Path:
        return self._stage_dir_static(request, context.dataset_dir, context.audio_dir)

    @staticmethod
    def _scan_lab(directory: Path) -> bool:
        """检查语料目录里是否存在与音频同名的文本文件。"""
        for path in directory.rglob("*"):
            if path.suffix.lower() in {".lab", ".txt"}:
                return True
            if path.suffix.lower() in AUDIO_SUFFIXES:
                stem = path.with_suffix("")
                if stem.with_suffix(".lab").is_file() or stem.with_suffix(".txt").is_file():
                    return True
        return False

    # ---------- 各阶段 ----------

    def _step_denoise(self, request: TrainRequest, context: TrainContext) -> Step:
        script = self._tool(request, context, "denoise")
        return Step(
            stage=_STAGE_BY_KEY["denoise"],
            cmd=[
                _py(),
                "-s",
                str(script),
                "-i",
                str(context.audio_dir),
                "-o",
                str(context.dataset_dir / "denoised"),
                "-p",
                request.asr_precision,
            ],
        )

    def _step_slice(self, request: TrainRequest, context: TrainContext) -> Step:
        script = self._tool(request, context, "slice")
        params = request.slice
        n_parts = max(1, int(params.n_parts))
        out_root = context.dataset_dir / "sliced"
        shards: List[List[str]] = []
        for part in range(n_parts):
            shards.append(
                [
                    _py(),
                    "-s",
                    str(script),
                    str(self._slice_input(request, context)),
                    str(out_root),
                    str(int(params.threshold)),
                    str(int(params.min_length)),
                    str(int(params.min_interval)),
                    str(int(params.hop_size)),
                    str(int(params.max_sil_kept)),
                    str(params.max),
                    str(params.alpha),
                    str(part),
                    str(n_parts),
                ]
            )
        return Step(stage=_STAGE_BY_KEY["slice"], cmd=shards[0], shards=shards)

    def _slice_input(self, request: TrainRequest, context: TrainContext) -> Path:
        """切分的输入：降噪后的目录优先，否则用原始语料目录。"""
        denoised = context.dataset_dir / "denoised"
        if request.run_denoise and denoised.is_dir():
            return denoised
        return context.audio_dir

    def _step_asr(self, request: TrainRequest, context: TrainContext) -> Step:
        backend = catalog.ASR_BACKENDS[request.asr_backend]
        script = self._ensure_file(context, backend["script"], "ASR 脚本")
        return Step(
            stage=_STAGE_BY_KEY["asr"],
            cmd=[
                _py(),
                "-s",
                str(script),
                "-i",
                str(self._stage_dir(request, context)),
                "-o",
                str(context.dataset_dir / "asr"),
                "-s",
                str(request.asr_model_size),
                "-l",
                str(request.asr_language),
                "-p",
                str(request.asr_precision),
            ],
            note="ASR 同时产出官方格式训练清单",
        )

    def _steps_format(
        self, request: TrainRequest, context: TrainContext, installation: Any
    ) -> List[Step]:
        """格式化训练集：1-get-text → 2-get-hubert → 2-get-sv → 3-get-semantic。

        这四个脚本没有命令行参数，全靠环境变量；且按 `i_part` 分片产出，
        因此我们把「分片数」设为 GPU 张数，与官方 WebUI 的行为一致。
        """
        gpu_ids = _gpu_list(request.gpu_ids)
        all_parts = len(gpu_ids)
        is_half = "True" if self._is_half() else "False"

        base_env = {
            "inp_text": str(self._resolve_list(context)),
            "inp_wav_dir": str(self._wav_dir(context, request)),
            "exp_name": context.name,
            "opt_dir": str(context.dataset_dir),
            "all_parts": str(all_parts),
            "is_half": is_half,
            "version": context.version,
            "bert_pretrained_dir": str(installation.path(catalog.BERT_DIR)),
            "cnhubert_base_dir": str(installation.path(catalog.HUBERT_DIR)),
            "sv_path": str(installation.path(catalog.SV_PRETRAINED)),
            "pretrained_s2G": str(installation.path(catalog.PRETRAINED_SOVITS_G[context.version])),
            "s2config_path": str(installation.path(catalog.s2_config_template(context.version))),
        }

        def shard_env(base: Dict[str, str], index: int) -> Dict[str, str]:
            env = dict(base)
            env["i_part"] = str(index)
            env["_CUDA_VISIBLE_DEVICES"] = gpu_ids[index]
            return env

        steps: List[Step] = []

        for key in ("text", "hubert", "sv", "semantic"):
            if key == "sv" and context.version not in {"v2Pro", "v2ProPlus"}:
                continue  # 只有 v2Pro 系列训练会用到说话人向量
            if key == "sv" and not self.settings.skip_ready_check:
                if not Path(base_env["sv_path"]).is_file():
                    raise BadRequestError(
                        "缺少说话人向量模型",
                        hint="请确认 GPT_SoVITS/pretrained_models/sv/ 下的 ERes2NetV2 权重已下载。",
                        code="SV_MODEL_MISSING",
                    )
            script = self._ensure_file(context, catalog.PREPARE_SCRIPTS[key], "预处理脚本")
            shards = [[_py(), "-s", str(script)] for _ in range(all_parts)]
            envs = [shard_env(base_env, index) for index in range(all_parts)]
            step = Step(stage=_STAGE_BY_KEY[key], cmd=shards[0], shards=shards)
            # 分片各自的 env 不同，这里用 note 承载，执行时按 index 取
            step.note = json.dumps(envs, ensure_ascii=False)
            steps.append(step)

        return steps

    def _step_s1(self, request: TrainRequest, context: TrainContext, installation: Any) -> Step:
        script = self._ensure_file(context, catalog.S1_TRAIN_SCRIPT, "GPT 训练脚本")
        template = self._ensure_file(context, catalog.s1_config_template(context.version), "GPT 训练配置模板")

        import yaml  # noqa: PLC0415 - 只在真正训练时才需要

        data = yaml.safe_load(template.read_text(encoding="utf-8-sig")) or {}
        s1_dir = context.workdir
        (s1_dir / "logs_s1").mkdir(parents=True, exist_ok=True)

        is_half = self._is_half()
        train = data.setdefault("train", {})
        if not is_half:
            train["precision"] = "32"
        train["batch_size"] = max(1, request.batch_size_s1 if is_half else max(1, request.batch_size_s1 // 2))
        train["epochs"] = request.epochs_s1
        train["save_every_n_epoch"] = request.save_every_epoch_s1
        train["if_save_every_weights"] = request.if_save_every_weights
        train["if_save_latest"] = request.if_save_latest
        train["if_dpo"] = request.if_dpo
        train["half_weights_save_dir"] = str(installation.path(catalog.GPT_WEIGHT_DIRS[context.version]))
        train["exp_name"] = context.name

        data["pretrained_s1"] = str(installation.path(catalog.PRETRAINED_GPT[context.version]))
        data["train_semantic_path"] = str(context.dataset_file_semantic)
        data["train_phoneme_path"] = str(context.dataset_file_phoneme)
        data["output_dir"] = str(s1_dir / ("logs_s1_%s" % context.version))

        config_path = context.workdir / "s1_config.yaml"
        config_path.parent.mkdir(parents=True, exist_ok=True)
        config_path.write_text(yaml.safe_dump(data, allow_unicode=True, sort_keys=False), encoding="utf-8")

        return Step(
            stage=_STAGE_BY_KEY["s1"],
            cmd=[_py(), "-s", str(script), "--config_file", str(config_path)],
            env={"_CUDA_VISIBLE_DEVICES": ",".join(_gpu_list(request.gpu_ids)), "hz": "25hz"},
        )

    def _step_s2(self, request: TrainRequest, context: TrainContext, installation: Any) -> Step:
        script = self._ensure_file(
            context, catalog.s2_train_script(context.version), "SoVITS 训练脚本"
        )
        template = self._ensure_file(
            context, catalog.s2_config_template(context.version), "SoVITS 训练配置模板"
        )

        data = json.loads(template.read_text(encoding="utf-8-sig"))
        is_half = self._is_half()
        train = data.setdefault("train", {})
        train["fp16_run"] = is_half
        train["batch_size"] = max(
            1, request.batch_size_s2 if is_half else max(1, request.batch_size_s2 // 2)
        )
        train["epochs"] = request.epochs_s2
        train["text_low_lr_rate"] = request.text_low_lr_rate
        train["pretrained_s2G"] = str(installation.path(catalog.PRETRAINED_SOVITS_G[context.version]))
        pretrained_d = catalog.PRETRAINED_SOVITS_D.get(context.version, "")
        train["pretrained_s2D"] = str(installation.path(pretrained_d)) if pretrained_d else ""
        train["if_save_latest"] = request.if_save_latest
        train["if_save_every_weights"] = request.if_save_every_weights
        train["save_every_epoch"] = request.save_every_epoch_s2
        train["gpu_numbers"] = request.gpu_ids or "0"
        train["grad_ckpt"] = request.if_grad_ckpt
        train["lora_rank"] = request.lora_rank

        data.setdefault("model", {})["version"] = context.version
        # exp_dir 必须与数据预处理脚本的 opt_dir 一致 ——
        # `TextAudioSpeakerLoader` 会断言 `<exp_dir>/2-name2text.txt`、
        # `<exp_dir>/4-cnhubert`、`<exp_dir>/5-wav32k`（v2Pro 还有 `7-sv_cn`）都存在。
        # 官方 WebUI 里 opt_dir 与 exp_dir 是同一个目录，我们保留了 dataset/ 这一层，
        # 因此两者都要指向它，否则训练会在 DataLoader 初始化时直接 AssertionError。
        dataset_dir = str(context.dataset_dir)
        data.setdefault("data", {})["exp_dir"] = dataset_dir
        data["s2_ckpt_dir"] = dataset_dir
        data["save_weight_dir"] = str(installation.path(catalog.SOVITS_WEIGHT_DIRS[context.version]))
        data["name"] = context.name
        data["version"] = context.version

        # 官方 WebUI 在启动 s2 训练前会先建好 `logs_s2_<version>` 目录，
        # `s2_train.py` 的权重保存（utils.my_save）会直接往里 `shutil.move`；
        # 目录不存在时训练会在最后一步（保存权重）才失败 —— 白跑几个小时，必须提前建。
        (context.dataset_dir / ("logs_s2_%s" % context.version)).mkdir(parents=True, exist_ok=True)

        config_path = context.workdir / "s2_config.json"
        config_path.parent.mkdir(parents=True, exist_ok=True)
        config_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

        return Step(
            stage=_STAGE_BY_KEY["s2"],
            cmd=[_py(), "-s", str(script), "--config", str(config_path)],
        )

    # ---------- 辅助 ----------

    def _tool(self, request: TrainRequest, context: TrainContext, key: str) -> Path:
        mapping = {
            "denoise": catalog.DENOISE_SCRIPT,
            "slice": catalog.SLICE_SCRIPT,
        }
        return self._ensure_file(context, mapping[key], "%s 工具" % key)

    def _ensure_file(self, context: TrainContext, relative: str, label: str) -> Path:
        path = context.home / relative
        if not path.is_file():
            raise BadRequestError(
                "缺少%s：%s" % (label, relative),
                hint="请确认 GPT-SoVITS 安装完整（官方仓库或整合包自带的文件不要删减）。",
                code="SCRIPT_MISSING",
            )
        return path

    def _resolve_list(self, context: TrainContext) -> Path:
        """返回规划期就已确定的清单路径。

        只做「有没有」的检查，不做「猜在哪」的搜索 ——
        路径推导全部集中在 `_plan_list_path`，两处逻辑一旦分叉就会产生
        「dry-run 通过、真跑失败」的隐性缺陷。
        """
        if not context.list_path:
            raise BadRequestError(
                "训练清单路径未确定",
                hint="请提供 source_audio_dir 或 list_file。",
                code="LIST_MISSING",
            )
        return context.list_path

    def _wav_dir(self, context: TrainContext, request: TrainRequest) -> Path:
        """特征提取脚本使用的音频目录（与清单里的路径可以互相印证）。"""
        return self._stage_dir(request, context)

    def _is_half(self) -> bool:
        from .runtime import probe_current  # noqa: PLC0415

        info = probe_current()
        return bool(info.has_gpu)

    def _require_dataset_file(self, context: TrainContext, key: str) -> None:
        target = (
            context.dataset_file_phoneme if key == "text" else context.dataset_file_semantic
        )
        if not target.is_file():
            raise BadRequestError(
                "已关闭「格式化训练集」，但缺少必需的数据集文件：%s" % target.name,
                hint="请开启「格式化训练集」重新生成，或手动把该文件放到实验目录下。",
                code="DATASET_FILE_MISSING",
            )

    # ------------------------------------------------------------------
    # 执行
    # ------------------------------------------------------------------

    async def run(self, job: Job, request: TrainRequest, cancel_event: asyncio.Event) -> Dict[str, Any]:
        context, steps, skipped = self.plan(request)
        for note in skipped:
            self.store.log(job, note, level="warn")

        context.workdir.mkdir(parents=True, exist_ok=True)
        context.dataset_dir.mkdir(parents=True, exist_ok=True)
        self.store.log(job, "实验目录：%s" % context.workdir)

        # 让出显卡：训练脚本需要完整的显存，常驻的推理管线必须先释放
        self.store.log(job, "正在释放推理模型以让出显存…")
        self.hooks.start()
        self.store.log(job, "显存已让出，训练期间合成功能会暂时不可用", "warn")
        self.store.update(job, message="开始执行训练流水线")
        try:
            return await self._run_steps(job, request, context, steps, skipped, cancel_event)
        finally:
            self.hooks.finish()
            self.store.log(job, "已释放训练占用，推理模型会在下次合成时重新加载")

    async def _run_steps(
        self,
        job: Job,
        request: TrainRequest,
        context: TrainContext,
        steps: List[Step],
        skipped: List[str],
        cancel_event: asyncio.Event,
    ) -> Dict[str, Any]:
        total_weight = sum(_STAGE_WEIGHT.get(step.stage.key, 0.05) for step in steps) or 1.0
        done_weight = 0.0

        for step in steps:
            if cancel_event.is_set():
                raise asyncio.CancelledError

            self.store.stage(job, step.stage.key, JobState.RUNNING)
            self.store.update(
                job,
                message="正在执行：%s（%s）" % (step.stage.label, step.stage.note or ""),
            )
            started = time.monotonic()

            if self.settings.dry_run or request.dry_run or request.plan_only:
                self.store.log(job, "[dry-run] %s" % (step.note or step.stage.label))
                for cmd in step.shards or ([step.cmd] if step.cmd else []):
                    if cmd:
                        self.store.log(job, " ".join(cmd))
                if step.stage.key == "import":
                    self._inline_import(job, context, request)
                if step.stage.key == "list":
                    self._inline_list(job, context)
                await asyncio.sleep(0.02)
                self.store.stage(job, step.stage.key, JobState.SUCCEEDED, detail="dry-run")
                done_weight += _STAGE_WEIGHT.get(step.stage.key, 0.05)
                self.store.update(job, progress=round(done_weight / total_weight, 3))
                continue

            try:
                if step.stage.key == "import":
                    self._inline_import(job, context, request)
                elif step.stage.key == "list":
                    self._inline_list(job, context)
                elif step.stage.key in {"text", "hubert", "sv", "semantic"}:
                    if step.stage.key == "text":
                        # 特征提取的唯一输入是清单；它由「上一环」（ASR 或清单生成）产出。
                        # 在这里断言，可以把「ASR 静默产出空文件」这类问题
                        # 变成一个能指出原因的报错，而不是四百行 traceback。
                        self._assert_list_ready(job, context)
                    await self._run_sharded(job, step, cancel_event)
                    self._merge_parts(job, context, step.stage.key)
                else:
                    await self._exec(job, step.cmd or [], step.env, cancel_event)
            except asyncio.CancelledError:
                self.store.stage(job, step.stage.key, JobState.CANCELLED, detail="已取消")
                raise
            except Exception as exc:  # noqa: BLE001
                self.store.stage(
                    job, step.stage.key, JobState.FAILED, detail="%s: %s" % (type(exc).__name__, exc)
                )
                raise

            self.store.stage(job, step.stage.key, JobState.SUCCEEDED)
            done_weight += _STAGE_WEIGHT.get(step.stage.key, 0.05)
            self.store.update(job, progress=round(done_weight / total_weight, 3))
            self.store.log(
                job,
                "阶段完成：%s（%.1fs）" % (step.stage.label, time.monotonic() - started),
                "success",
            )

        artifacts = self._collect_artifacts(context)
        for key, value in artifacts.items():
            self.store.log(job, "%s：%s" % (key, value), "success")
        return {"context": context.to_dict(), "skipped": skipped, **artifacts}

    # ---------- 内联阶段 ----------

    def _inline_import(self, job: Job, context: TrainContext, request: TrainRequest) -> None:
        """扫描语料，确认音频规模，并对「语料太少」这类问题提前预警。"""
        if request.list_file:
            self.store.log(job, "使用已有清单：%s" % context.list_path)
        else:
            audios = [
                path
                for path in context.audio_dir.rglob("*")
                if path.suffix.lower() in AUDIO_SUFFIXES
            ]
            if not audios:
                raise BadRequestError(
                    "语料目录中没有任何受支持的音频文件：%s" % context.audio_dir,
                    hint="支持的后缀：%s" % "、".join(sorted(AUDIO_SUFFIXES)),
                    code="NO_AUDIO",
                )
            total_seconds = 0.0
            for path in audios:
                total_seconds += _audio_seconds(path)
            self.store.log(
                job,
                "发现 %d 个音频，合计约 %.1f 分钟" % (len(audios), total_seconds / 60.0),
            )
            if total_seconds < 60:
                self.store.log(
                    job,
                    "提示：有效语音不足 1 分钟，官方的「少样本微调」建议至少 1 分钟",
                    "warn",
                )
            context.list_path = context.dataset_dir / "train.list"

    def _inline_list(self, job: Job, context: TrainContext) -> None:
        """由同名 .lab / .txt 生成官方清单：`wav|speaker|lang|text`。"""
        rows: List[str] = []
        missing: List[str] = []
        for path in sorted(context.audio_dir.rglob("*")):
            if path.suffix.lower() not in AUDIO_SUFFIXES:
                continue
            text = _read_sibling_text(path)
            if not text:
                missing.append(path.name)
                continue
            rows.append("%s|%s|%s|%s" % (path, context.speaker, context.text_lang, text))
        if not rows:
            raise BadRequestError(
                "没能从语料目录中找到任何可用的文本",
                hint="请为每个音频准备同名 .lab 或 .txt 文件（UTF-8 编码，内容为该段音频的逐字转写）。",
                code="NO_TRANSCRIPT",
            )
        if missing:
            self.store.log(
                job,
                "以下 %d 个音频缺少同名文本，已跳过：%s"
                % (len(missing), "、".join(missing[:8]) + ("…" if len(missing) > 8 else "")),
                "warn",
            )
        context.list_path.parent.mkdir(parents=True, exist_ok=True)
        context.list_path.write_text("\n".join(rows) + "\n", encoding="utf-8")
        self.store.log(job, "已生成清单：%s（%d 条）" % (context.list_path, len(rows)))

    def _assert_list_ready(self, job: Job, context: TrainContext) -> None:
        if not context.list_path.is_file():
            raise BadRequestError(
                "训练清单没有生成：%s" % context.list_path,
                hint=(
                    "清单由上一阶段产出。若用的是语音转文本，请检查日志中 ASR 的输出目录"
                    "是否与预期一致；若用的是 .lab 文本，请确认音频旁边确实存在同名文本。"
                ),
                code="LIST_MISSING",
            )
        rows = [
            line
            for line in context.list_path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        if not rows:
            raise BadRequestError(
                "训练清单为空：%s" % context.list_path,
                hint="ASR 对这批音频没有识别出任何文本，请检查音频是否真的是语音、语种设置是否正确。",
                code="LIST_EMPTY",
            )
        self.store.log(job, "清单就绪：%d 条" % len(rows))

    def _merge_parts(self, job: Job, context: TrainContext, key: str) -> None:
        """把分片产物拼成官方训练脚本期望的单一文件。"""
        if key == "text":
            parts = sorted(context.dataset_dir.glob("2-name2text-*.txt"))
            if len(parts) > 1:
                merged: List[str] = []
                for part in parts:
                    merged.extend(part.read_text(encoding="utf-8").strip("\n").split("\n"))
                context.dataset_file_phoneme.write_text(
                    "\n".join(item for item in merged if item) + "\n", encoding="utf-8"
                )
                for part in parts:
                    part.unlink(missing_ok=True)
                self.store.log(job, "已合并 %d 个文本分片 → %s" % (len(parts), context.dataset_file_phoneme.name))
            elif len(parts) == 1:
                shutil.move(str(parts[0]), str(context.dataset_file_phoneme))
        elif key == "semantic":
            parts = sorted(context.dataset_dir.glob("6-name2semantic-*.tsv"))
            if len(parts) > 1:
                merged_lines: List[str] = []
                for part in parts:
                    merged_lines.extend(part.read_text(encoding="utf-8").strip("\n").split("\n"))
                context.dataset_file_semantic.write_text(
                    "\n".join(item for item in merged_lines if item) + "\n", encoding="utf-8"
                )
                for part in parts:
                    part.unlink(missing_ok=True)
                self.store.log(
                    job, "已合并 %d 个语义分片 → %s" % (len(parts), context.dataset_file_semantic.name)
                )
            elif len(parts) == 1:
                shutil.move(str(parts[0]), str(context.dataset_file_semantic))

    # ---------- 子进程 ----------

    async def _run_sharded(self, job: Job, step: Step, cancel_event: asyncio.Event) -> None:
        """分片脚本默认串行执行。

        官方 WebUI 是并行拉起多个分片（每个绑一张卡）。本地大多只有一张卡，
        并行只会互相抢显存；因此这里串行，单卡场景下反而更快也更稳。
        """
        envs: List[Dict[str, str]] = []
        if step.note:
            try:
                envs = json.loads(step.note)
            except json.JSONDecodeError:
                envs = []
        shards = step.shards or ([step.cmd] if step.cmd else [])
        for index, cmd in enumerate(shards):
            if cmd is None:
                continue
            env = envs[index] if index < len(envs) else {}
            await self._exec(job, cmd, env, cancel_event)

    async def _exec(
        self,
        job: Job,
        cmd: List[str],
        extra_env: Dict[str, str],
        cancel_event: asyncio.Event,
    ) -> int:
        if not cmd:
            return 0
        env = os.environ.copy()
        env["PYTHONIOENCODING"] = "utf-8"
        env["PYTHONUNBUFFERED"] = "1"
        env.update({key: str(value) for key, value in extra_env.items()})
        # 官方脚本会读 CUDA_VISIBLE_DEVICES，也必须同步 _CUDA_VISIBLE_DEVICES 供其内部改判
        if extra_env.get("_CUDA_VISIBLE_DEVICES"):
            env["CUDA_VISIBLE_DEVICES"] = extra_env["_CUDA_VISIBLE_DEVICES"]

        self.store.log(job, "执行：" + " ".join(cmd))
        cwd = str(self.settings.data_dir)
        installation = bootstrap.current()
        if installation is not None:
            cwd = str(installation.home)

        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            cwd=cwd,
            env=env,
        )

        async def pump() -> None:
            assert proc.stdout is not None
            async for raw in proc.stdout:
                text = raw.decode("utf-8", errors="replace").rstrip()
                if text:
                    self.store.log(job, _trim(text))

        reader = asyncio.create_task(pump())
        deadline = time.monotonic() + self.settings.train_timeout_s
        try:
            while True:
                if cancel_event.is_set():
                    proc.kill()
                    raise asyncio.CancelledError
                if proc.returncode is not None:
                    break
                if time.monotonic() > deadline:
                    proc.kill()
                    raise SovitsError(
                        "训练超时，已终止进程",
                        hint="可通过 TRAIN_TIMEOUT_S 调整上限。",
                        code="TRAIN_TIMEOUT",
                    )
                await asyncio.sleep(0.5)
        finally:
            await reader
            await proc.wait()

        if proc.returncode != 0:
            raise SovitsError(
                "步骤执行失败，退出码 %s" % proc.returncode,
                hint="请查看上方日志中的最后几行报错。常见原因：显存不足、语料过少、依赖缺失。",
                code="STEP_FAILED",
            )
        return proc.returncode or 0

    # ---------- 产物 ----------

    def _collect_artifacts(self, context: TrainContext) -> Dict[str, Any]:
        installation = bootstrap.current()
        if installation is None:
            return {}
        artifacts: Dict[str, Any] = {
            "experiment": context.name,
            "version": context.version,
            "workdir": str(context.workdir),
        }
        for kind, directory in (
            ("gpt_model", catalog.GPT_WEIGHT_DIRS[context.version]),
            ("sovits_model", catalog.SOVITS_WEIGHT_DIRS[context.version]),
        ):
            base = installation.path(directory)
            if not base.is_dir():
                continue
            hits = sorted(
                (path for path in base.rglob("*%s*" % context.name) if path.is_file()),
                key=lambda path: path.stat().st_mtime,
                reverse=True,
            )
            if hits:
                artifacts[kind] = str(hits[0])
                artifacts["%s_dir" % kind] = str(base)
        return artifacts


# --------------------------------------------------------------------------
# 模块级辅助
# --------------------------------------------------------------------------

#: 关闭格式化时必须已存在的数据集文件
_REQUIRED_DATASET_FILES = ("text", "semantic")


def _py() -> str:
    """当前解释器。服务本身就跑在 GPT-SoVITS 环境里，直接复用即可。"""
    import sys

    return sys.executable


def _gpu_list(raw: str) -> List[str]:
    tokens = [token.strip() for token in str(raw or "0").replace(",", "-").split("-") if token.strip()]
    return tokens or ["0"]


def _safe_name(name: str) -> str:
    cleaned = "".join(ch if ch.isalnum() or ch in "-_." else "_" for ch in name.strip())
    return cleaned[:48] or "experiment"


def _read_sibling_text(audio: Path) -> str:
    """读取与音频同名的 .lab / .txt 文本。

    编码顺序是刻意的：`utf-8-sig` 排在前面 —— Windows 记事本与 PowerShell
    写出的 UTF-8 默认带 BOM，用普通 `utf-8` 读出来会多一个不可见字符，
    而这个字符会被当成正文喂进模型，训出来的音色会莫名其妙地发音异常。
    """
    for suffix in (".lab", ".txt"):
        candidate = audio.with_suffix(suffix)
        if not candidate.is_file():
            continue
        for encoding in ("utf-8-sig", "utf-8", "gbk"):
            try:
                return candidate.read_text(encoding=encoding).strip().replace("\n", " ")
            except (UnicodeDecodeError, OSError):
                continue
    return ""


def _audio_seconds(path: Path) -> float:
    from .sovits.voices import probe_audio  # noqa: PLC0415

    duration, _ = probe_audio(path)
    return duration or 0.0


def _trim(text: str) -> str:
    """压缩 tqdm 之类的超长进度行，避免日志被刷爆。"""
    if len(text) <= 240:
        return text
    return text[:160] + " … " + text[-60:]


def step_stages(request: TrainRequest) -> List[JobStage]:
    """按勾选情况构造流水线视图，未勾选的步骤不出现在前端进度里。

    这里必须与 `plan()` 生成的步骤集合保持一致 —— 进度条少一个阶段
    会让用户以为漏跑了，多一个则会看到一个永远不动的灰条。
    """
    stages: List[JobStage] = [JobStage(key="import", label=_STAGE_BY_KEY["import"].label)]
    wants_sv = request.version in {"v2Pro", "v2ProPlus"}

    for stage in STAGES:
        if stage.key == "import":
            continue
        if stage.key == "list":
            # 只有走「.lab 文本」时才需要我们生成清单
            if not request.run_asr:
                stages.append(JobStage(key=stage.key, label=stage.label))
            continue
        if stage.key in {"text", "hubert", "sv", "semantic"}:
            if not request.run_format:
                continue
            if stage.key == "sv" and not wants_sv:
                continue
            stages.append(JobStage(key=stage.key, label=stage.label))
            continue
        if stage.key == "asr":
            if request.run_asr:
                stages.append(JobStage(key=stage.key, label=stage.label))
            continue
        if request.run_denoise and stage.key == "denoise":
            stages.append(JobStage(key=stage.key, label=stage.label))
            continue
        if request.run_slice and stage.key == "slice":
            stages.append(JobStage(key=stage.key, label=stage.label))
            continue
        if request.run_s1 and stage.key == "s1":
            stages.append(JobStage(key=stage.key, label=stage.label))
            continue
        if request.run_s2 and stage.key == "s2":
            stages.append(JobStage(key=stage.key, label=stage.label))
    return stages

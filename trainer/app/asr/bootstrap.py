"""ASR 直连层：安装定位、官方脚本查找、通道选择与依赖探测。

ASR 与另外几个板块（GPT-SoVITS / RVC / DDSP-SVC / UVR5）最容易踩空的一点是：
**上游没有给一个可以常驻的「类」**。官方给的是两个命令行脚本
（`tools/asr/funasr_asr.py`、`tools/asr/fasterwhisper_asr.py`），设计用途是
「给一个目录，产出标注」——批处理打标，而不是「给一段音频，立刻还我文本」。

所以这里明确划分两条通道，并且**永远保持可降级**：

1. `resident`（常驻）：直接 `import funasr` / `import faster_whisper`，模型常驻内存。
   为什么要绕开官方脚本自己加载？与 GPT-SoVITS 那条决策同理 —— 官方脚本每次调用
   都要重新加载模型，large 级别要几十秒，而「一键智能转写」是用户在导入音色的对话框里
   点一下就该出结果的操作。代价是要维护一份模型标识映射（`catalog.RESIDENT_MODELS`），
   这是本板块唯一与上游模型命名耦合的地方。
2. `script`（脚本）：子进程跑官方脚本，cwd 为整合包根目录。**与训练流水线的 ASR 阶段
   是同一条命令**，因此结果可复现、可对照，也是「批量构建训练集」的默认通道。

降级是显式的：结果里会带 `channel` 与 `reason`，前端会把它显示出来。
静默降级比慢几秒的代价大得多 —— 用户以为在用 large，实际跑的是 small，
这种误会会直接污染音色库。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, Optional

from ..errors import EnvironmentError_, SovitsError
from . import catalog

__all__ = [
    "AsrError",
    "installation",
    "probe_module",
    "require_installation",
    "resident_support",
    "resolve_channel",
    "script_available",
    "script_for",
    "diagnose",
    "import_funasr",
    "import_whisper",
    "funasr_local_models",
]

#: 后端 → 整合包里的脚本语义标签（对应 `discovery.TOOL_STEP_LAYOUT`）。
SCRIPT_KEYS: Dict[str, str] = {
    "funasr": "asr_funasr",
    "fasterwhisper": "asr_fasterwhisper",
}


class AsrError(SovitsError):
    """ASR 链路失败。

    刻意继承 `SovitsError`（而不是像 VcError / SvcError 那样自立门户）：
    `api.py` 只为 `SovitsError` 注册了异常处理器，自己定义一个 Exception 子类
    会让错误变成 500 + 一堆栈，前端拿不到 `hint` —— 而 ASR 最常见的失败恰恰是
    「环境没装好 / 模型没下载」，这类失败必须把「下一步做什么」讲清楚。
    """

    code = "ASR_FAILED"
    http_status = 502
    retryable = True


def installation() -> Any:
    """当前的 GPT-SoVITS 安装对象（可能为 None）。"""
    from ..sovits import bootstrap as sovits_bootstrap  # noqa: PLC0415 - 避免导入期耦合

    return sovits_bootstrap.current()


def require_installation() -> Any:
    """ASR 脚本住在整合包里，没有安装目录就走不通脚本通道。"""
    found = installation()
    if found is None:
        raise EnvironmentError_(
            "未定位到 GPT-SoVITS 安装目录，ASR 脚本通道不可用",
            hint=(
                "设置 GPT_SOVITS_HOME 指向整合包根目录，或把整合包放在项目同级目录后重启服务；"
                "也可以改用常驻通道（在服务所在解释器里 pip install funasr）。"
            ),
            code="INSTALLATION_MISSING",
        )
    return found


def script_for(settings: Any, backend: str) -> Path:
    """定位某个后端对应的官方 ASR 脚本。"""
    if backend not in SCRIPT_KEYS:
        raise AsrError(
            "后端 %s 没有对应的官方脚本" % backend,
            hint="可选后端：%s。" % "、".join(SCRIPT_KEYS),
            code="BACKEND_UNSUPPORTED",
            status=400,
            retryable=False,
        )
    found = require_installation()
    tools = getattr(getattr(found, "layout", None), "tools", {}) or {}
    path = tools.get(SCRIPT_KEYS[backend])
    if path is None or not Path(path).is_file():
        raise EnvironmentError_(
            "整合包里未找到官方 ASR 脚本（tools/asr/%s）" % backend,
            hint="确认整合包完整；或改用常驻通道（pip install funasr / faster-whisper）。",
            code="SCRIPT_MISSING",
        )
    return Path(path)


def script_available(settings: Any, backend: str) -> bool:
    """脚本通道是否可用（不抛异常，供探测与清单使用）。"""
    try:
        script_for(settings, backend)
        return True
    except SovitsError:
        return False


def probe_module(module: str) -> Optional[str]:
    """尝试 import 一个模块。成功返回 None，失败返回可读的原因。"""
    try:
        __import__(module)
        return None
    except Exception as exc:  # noqa: BLE001 - 任何导入失败都只是"不可用"
        text = str(exc)
        return "%s: %s" % (exc.__class__.__name__, text) if text else exc.__class__.__name__


def funasr_local_models(settings: Any) -> Dict[str, str]:
    """整合包里已下载的 FunASR 权重（`tools/asr/models/`）。

    官方 `funasr_asr.py::create_model()` 用 `snapshot_download` 把
    Paraformer + FSMN-VAD + CT-PUNC 下载到整合包的 `tools/asr/models/` 下。
    实测整合包（v2pro-20250604）里这三个目录已经存在 —— 常驻通道直接吃这些
    本地路径，就不必再从 ModelScope 下一遍（同一套权重，两三百 MB）。

    返回 `{"asr": 路径 或 "", "asr_yue": …, "vad": …, "punc": …}`；
    缺哪一项就给空串，由调用方决定是否回落到官方别名。
    """
    found = installation()
    if found is None:
        return {}
    base = Path(found.home) / "tools" / "asr" / "models"
    if not base.is_dir():
        return {}

    def pick(prefix: str) -> str:
        try:
            hits = sorted(path for path in base.iterdir() if path.is_dir() and path.name.startswith(prefix))
        except OSError:
            return ""
        return str(hits[0]) if hits else ""

    return {
        "asr": pick("speech_paraformer"),
        "asr_yue": pick("speech_UniASR"),
        "vad": pick("speech_fsmn_vad"),
        "punc": pick("punc_ct-transformer"),
    }


def module_present(module: str) -> bool:
    """只查「这个包在不在」，**不真的导入它**。

    `/health` 不能慢：`import funasr` 会顺带拉起 torch，几秒钟就过去了。
    真正要跑的时候（`import_funasr`）才导入 —— 那时慢是应该的。
    """
    import importlib.util  # noqa: PLC0415

    try:
        return importlib.util.find_spec(module) is not None
    except (ImportError, ValueError):
        return False


def resident_support(backend: str) -> Dict[str, Any]:
    """常驻通道的可用性。"""
    module = catalog.resident_channel_module(backend)
    if not module:
        return {"available": False, "module": "", "error": "该后端没有常驻通道"}
    error = probe_module(module)
    return {"available": error is None, "module": module, "error": error or ""}


def _unavailable(backend: str, resident: Dict[str, Any]) -> EnvironmentError_:
    module = resident.get("module") or "对应依赖"
    return EnvironmentError_(
        "ASR 后端 %s 当前两条通道都不可用" % backend,
        hint=(
            "常驻通道：在服务所在解释器里 pip install %s（当前状态：%s）；"
            "脚本通道：确保能定位到 GPT-SoVITS 整合包，且 tools/asr/ 下有对应脚本。"
            % (module, resident.get("error") or "未安装")
        ),
        code="ASR_BACKEND_UNAVAILABLE",
    )


def resolve_channel(settings: Any, backend: str, prefer: str = "") -> Dict[str, str]:
    """决定这次转写走哪条通道，并说明理由。

    `prefer` 可以指定 `resident` / `script`；不指定时按「常驻优先」自动选，
    因为常驻通道对单条短音频快一个数量级。降级时一定带 `reason`。
    """
    resident = resident_support(backend)
    script_ready = script_available(settings, backend)

    if prefer == "resident":
        if resident["available"]:
            return {"channel": "resident", "reason": ""}
        if script_ready:
            return {
                "channel": "script",
                "reason": "常驻通道不可用（%s），已降级到官方脚本通道" % (resident.get("error") or "未安装"),
            }
        raise _unavailable(backend, resident)

    if prefer == "script":
        if script_ready:
            return {"channel": "script", "reason": ""}
        if resident["available"]:
            return {"channel": "resident", "reason": "未找到官方脚本，已改用常驻通道"}
        raise _unavailable(backend, resident)

    if resident["available"]:
        return {"channel": "resident", "reason": ""}
    if script_ready:
        return {
            "channel": "script",
            "reason": "未安装 %s，已降级到官方脚本通道（每条都要重新加载模型，会慢一些）"
            % (resident.get("module") or "依赖"),
        }
    raise _unavailable(backend, resident)


def import_funasr() -> Any:
    """导入 FunASR 的 `AutoModel`。"""
    try:
        from funasr import AutoModel  # type: ignore  # noqa: PLC0415
    except Exception as exc:  # noqa: BLE001
        raise EnvironmentError_(
            "未能导入 funasr：%s" % exc,
            hint="在服务所在的解释器里 pip install funasr modelscope，或改用 faster-whisper 后端。",
            code="BACKEND_UNAVAILABLE",
        ) from exc
    return AutoModel


def import_whisper() -> Any:
    """导入 faster-whisper 的 `WhisperModel`。"""
    try:
        from faster_whisper import WhisperModel  # type: ignore  # noqa: PLC0415
    except Exception as exc:  # noqa: BLE001
        raise EnvironmentError_(
            "未能导入 faster_whisper：%s" % exc,
            hint="在服务所在的解释器里 pip install faster-whisper，或改用 FunASR 后端。",
            code="BACKEND_UNAVAILABLE",
        ) from exc
    return WhisperModel


def diagnose(settings: Any) -> Dict[str, Any]:
    """两条通道的完整体检，供 `/v1/asr/catalog` 与 `/health` 展示。

    服务必须能在「什么都还没装」的情况下正常启动并如实回答「为什么用不了」，
    这是本地工具的基本礼貌。
    """
    found = installation()
    items = []
    for backend in catalog.BACKENDS:
        resident = resident_support(backend)
        try:
            script = script_for(settings, backend)
            script_info = {"available": True, "path": str(script), "error": ""}
        except SovitsError as exc:
            script_info = {"available": False, "path": "", "error": exc.message}
        try:
            channel = resolve_channel(settings, backend)["channel"]
        except SovitsError:
            channel = "none"
        items.append(
            {
                "id": backend,
                "channel": channel,
                "resident": resident,
                "script": script_info,
            }
        )
    return {
        "installation": str(found.home) if found is not None else None,
        "session_dir": str(settings.asr_dir),
        "backends": items,
    }

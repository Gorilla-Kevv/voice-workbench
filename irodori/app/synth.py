"""合成编排：请求校验（日语/参考音频）→ 服务端切句 → 逐段合成 → 拼接。

为什么切句收在服务端（而不是让前端自己分）：
>30s 的音频会退化/幻觉（上游 issue #13），且输出时长是模型预测的 ——
客户端既算不准也切不对。服务端按「≤25 字/段」强切、逐段合成、按顺序拼接，
对调用方暴露的仍然是一条完整的音频。

**切句顺带成了长尾护栏的支点**（30-3）：段与段之间是唯一真正可中断的点，
所以「外推超预算 → 剩余段落降步 + 换 seed」就挂在这个循环里
（见 `_run_synthesis_locked`），墙钟兜底见 `_run_with_watchdog`。

参考音频三选一（互斥，与上游 infer.py 的 ref_group 一致）：
- `ref_voice`：音色库 id → 读 `voicelib/voices.json` 解析成磁盘路径。
  只读不写，每次现读文件（坑 27：这是两进程共写的同一份 JSON）；
- `ref_path`：磁盘路径直用（本地工具，不做目录白名单）；
- `speaker_id`：固化的 `.speaker.safetensors`（30-6 训练产物）。
  官方要求 `--ref-embed` 与参考音互斥 → 同时给两样直接报错。
"""

from __future__ import annotations

import base64
import io
import json
import os
import random
import re
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

from . import engine
from .config import PROJECT_DIR, Settings
from .errors import IrodoriError

#: 合成文本总量上限。切句后每段 ≤25 字，1000 字 ≈ 40+ 段，再长就该走批量而不是单请求
MAX_TEXT_CHARS = 1000
#: 单段上限（方案 §4.1：服务端强制切句 ≤25 字/段）
SEGMENT_MAX_CHARS = 25
#: 参考音频下限（秒）。太短的参考克隆不出来，宁可报错
MIN_REF_SECONDS = 3.0
#: 段间静音（秒）。硬拼接会有「接缝感」，一小段静音最便宜地解决
SEGMENT_GAP_SECONDS = 0.15
#: 段间外推触发降步时只用到预算的这个比例。留一成余量给拼接、编码与响应序列化 ——
#: 卡在预算线上才降，等于每次都赌最后一段不超时
BUDGET_SAFETY = 0.9

#: 日语判定：文本里至少要有一个假名（平/片/半片）。汉字-only 的中文会被拒 ——
#: 这是「仅日语」服务的正确行为（方案 §4.1 错误码 NO_JA_ONLY）
_KANA_RE = re.compile(r"[\u3040-\u309f\u30a0-\u30ff\u31f0-\u31ff\uff66-\uff9f]")
_SENTENCE_END = "。！？!?…"
_CLAUSE_SPLIT = re.compile(r"(?<=[、，,])")


@dataclass
class SynthPayload:
    text: str
    caption: Optional[str] = None
    num_steps: Optional[int] = None
    schedule: str = "linear"
    seed: Optional[int] = None
    duration_scale: float = 1.0
    ref_voice: Optional[str] = None
    ref_path: Optional[str] = None
    speaker_id: Optional[str] = None
    ref_clips: list[str] = field(default_factory=list)


def parse_payload(body: Any) -> SynthPayload:
    if not isinstance(body, dict):
        raise IrodoriError("BAD_REQUEST", "请求体必须是 JSON 对象", "用 {\"text\": ...} 的 JSON body 重试。")
    text = str(body.get("text") or "").strip()
    if not text:
        raise IrodoriError("TEXT_REQUIRED", "text 不能为空", "填入要合成的日语文本。")
    if len(text) > MAX_TEXT_CHARS:
        raise IrodoriError(
            "TEXT_TOO_LONG",
            f"文本过长：{len(text)} 字（上限 {MAX_TEXT_CHARS}）",
            "拆成多条分别合成；更长的整篇文本适合走批量接口（30-7 接入）。",
        )
    if not _KANA_RE.search(text):
        raise IrodoriError(
            "NO_JA_ONLY",
            "本服务仅支持日语：文本里没有找到假名",
            "Irodori 是日语特化模型，中文/英文请改用网易、IndexTTS 或 GPT-SoVITS。",
        )

    steps = body.get("num_steps")
    if steps is not None:
        try:
            steps = int(steps)
        except (TypeError, ValueError) as error:
            raise IrodoriError("BAD_REQUEST", f"num_steps 必须是整数：{steps!r}", "用 20 或 40。") from error
        if not 1 <= steps <= 120:
            raise IrodoriError("BAD_REQUEST", f"num_steps 超出范围：{steps}", "取值 1~120；默认 20，40 为最高质量档。")

    schedule = str(body.get("schedule") or "linear").strip().lower()
    if schedule not in {"linear", "sway"}:
        raise IrodoriError("BAD_REQUEST", f"schedule 只支持 linear / sway：{schedule!r}", "删掉该字段用默认值即可。")

    seed = body.get("seed")
    if seed is not None:
        try:
            seed = int(seed)
        except (TypeError, ValueError) as error:
            raise IrodoriError("BAD_REQUEST", f"seed 必须是整数：{seed!r}", "同 seed 同输入完全确定。") from error

    duration_scale = body.get("duration_scale")
    if duration_scale is None:
        duration_scale = 1.0
    try:
        duration_scale = float(duration_scale)
    except (TypeError, ValueError) as error:
        raise IrodoriError("BAD_REQUEST", f"duration_scale 必须是数字：{duration_scale!r}", "取值 0.8~1.5。") from error
    if not 0.8 <= duration_scale <= 1.5:
        raise IrodoriError(
            "BAD_REQUEST",
            f"duration_scale 超出范围：{duration_scale}（允许 0.8~1.5）",
            "这是时长/节奏旋钮：>1 更慢更舒展，<1 更快更紧凑。",
        )

    caption = body.get("caption")
    caption = str(caption).strip() if caption else None
    if caption and len(caption) > 200:
        raise IrodoriError("CAPTION_TOO_LONG", f"caption 过长：{len(caption)} 字（上限 200）",
                           "caption 只描述情绪/环境/语域，一句话足够。")

    ref_voice = str(body.get("ref_voice") or "").strip() or None
    ref_path = str(body.get("ref_path") or "").strip() or None
    speaker_id = str(body.get("speaker_id") or "").strip() or None
    raw_clips = body.get("ref_clips")
    ref_clips = [str(item).strip() for item in raw_clips if str(item).strip()] if isinstance(raw_clips, list) else []

    has_audio_ref = bool(ref_voice or ref_path or ref_clips)
    if speaker_id and has_audio_ref:
        raise IrodoriError(
            "REF_CONFLICT",
            "speaker_id 与参考音频互斥（官方要求 --ref-embed 不能同时给参考音）",
            "用固化音色就只传 speaker_id；用参考音频就删掉 speaker_id。",
        )
    if ref_voice and ref_path:
        raise IrodoriError("REF_CONFLICT", "ref_voice 与 ref_path 二选一",
                           "音色库选音色用 ref_voice；直接给磁盘路径用 ref_path。")
    if not (speaker_id or has_audio_ref):
        raise IrodoriError(
            "REF_REQUIRED",
            "缺少参考音频：v4-Small 是说话人条件模型，没有参考合成不出目标音色",
            "从音色库选一条（ref_voice），或上传参考音频得到 ref_path；固化音色传 speaker_id。",
        )

    return SynthPayload(
        text=text,
        caption=caption or None,
        num_steps=steps,
        schedule=schedule,
        seed=seed,
        duration_scale=duration_scale,
        ref_voice=ref_voice,
        ref_path=ref_path,
        speaker_id=speaker_id,
        ref_clips=ref_clips,
    )


def split_sentences(text: str, max_chars: int = SEGMENT_MAX_CHARS) -> list[str]:
    """按句读切到 ≤max_chars。emoji 跟随它前面的句子（它们修饰的是前文）。"""
    pieces: list[str] = []
    buf = ""
    for ch in text:
        buf += ch
        if ch in _SENTENCE_END:
            pieces.append(buf)
            buf = ""
    if buf.strip():
        pieces.append(buf)

    chunks: list[str] = []
    current = ""
    for piece in pieces:
        piece = piece.strip()
        if not piece:
            continue
        if len(piece) > max_chars:
            if current:
                chunks.append(current)
                current = ""
            chunks.extend(_split_long(piece, max_chars))
            continue
        if len(current) + len(piece) <= max_chars:
            current += piece
        else:
            if current:
                chunks.append(current)
            current = piece
    if current:
        chunks.append(current)
    return chunks


def _split_long(piece: str, max_chars: int) -> list[str]:
    out: list[str] = []
    current = ""
    for part in _CLAUSE_SPLIT.split(piece):
        if len(part) > max_chars:
            if current:
                out.append(current)
                current = ""
            out.extend(part[i : i + max_chars] for i in range(0, len(part), max_chars))
        elif len(current) + len(part) <= max_chars:
            current += part
        else:
            if current:
                out.append(current)
            current = part
    if current:
        out.append(current)
    return out


def _voicelib_file(settings: Settings) -> Path:
    root = os.environ.get("VOICES_LIB_DIR") or str(PROJECT_DIR / "voicelib")
    return Path(root) / "voices.json"


def _resolve_ref_voice(settings: Settings, voice_id: str) -> tuple[Path, Optional[str]]:
    """音色库 id → 磁盘路径。返回 (路径, 音色名)。"""
    path = _voicelib_file(settings)
    try:
        records = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise IrodoriError(
            "VOICE_NOT_FOUND",
            f"音色库不存在或为空：{path}",
            "先在「音色库」页导入音色，或改用 ref_path 直接给磁盘路径。",
        ) from error
    except (json.JSONDecodeError, OSError) as error:
        raise IrodoriError("VOICE_LIB_BROKEN", f"音色库读不出来：{error}",
                           "检查 voicelib/voices.json 是否损坏（网关侧也能重建）。") from error
    if not isinstance(records, list):
        raise IrodoriError("VOICE_LIB_BROKEN", "音色库格式不对（应为数组）", "检查 voicelib/voices.json。")
    for record in records:
        if isinstance(record, dict) and record.get("id") == voice_id:
            audio = str(record.get("audio_path") or "")
            if not audio:
                break
            return Path(audio), str(record.get("name") or voice_id)
    raise IrodoriError(
        "VOICE_NOT_FOUND",
        f"音色库中没有 id 为 {voice_id!r} 的音色（共 {len(records)} 条）",
        "到「音色库」页核对音色 id；或改用 ref_path 直接给磁盘路径。",
    )


def _check_ref_file(path: Path, label: str) -> None:
    if not path.is_file():
        raise IrodoriError(
            "REF_NOT_FOUND",
            f"{label}不存在：{path}",
            "确认路径正确；从音色库选音色可避免手写路径。",
        )
    try:
        import soundfile as sf  # noqa: PLC0415 - venv 里必有（windecode 垫片的底层）
    except ImportError as error:  # pragma: no cover
        raise IrodoriError("ENV_BROKEN", "soundfile 不可用，无法读取参考音频", "重装 venv：pip install soundfile。") from error
    try:
        info = sf.info(str(path))
    except Exception as error:
        raise IrodoriError("REF_UNREADABLE", f"{label}读不出来：{error}",
                           "换成 wav/mp3/flac 等常见格式（ffmpeg 转一遍即可）。") from error
    if info.duration < MIN_REF_SECONDS:
        raise IrodoriError(
            "REF_TOO_SHORT",
            f"{label}只有 {info.duration:.1f}s（下限 {MIN_REF_SECONDS}s）",
            "参考太短克隆不出音色；官方建议 ~30s，音色库里的「日语长参考」多片段更好（30-4 接入）。",
        )


def resolve_reference(settings: Settings, payload: SynthPayload) -> dict[str, Any]:
    """把三种参考形态解成上游 SamplingRequest 的字段。返回含 ref_wav/ref_wavs/ref_embed 与回显信息。"""
    result: dict[str, Any] = {"voice_id": None, "speaker_id": None, "voice_name": None}

    if payload.speaker_id:
        speakers_dir = settings.data_dir / "speakers"
        candidates = [speakers_dir / f"{payload.speaker_id}.speaker.safetensors"]
        if candidates[0].is_file():
            result["ref_embed"] = str(candidates[0])
            result["speaker_id"] = payload.speaker_id
            return result
        found = sorted(speakers_dir.glob("*.speaker.safetensors")) if speakers_dir.is_dir() else []
        raise IrodoriError(
            "SPEAKER_NOT_FOUND",
            f"找不到固化音色 {payload.speaker_id!r}（现有 {len(found)} 个）",
            "固化音色来自训练（30-6）；先确认训练产物已生成，或改用参考音频。",
        )

    clips = [Path(item) for item in payload.ref_clips]
    if clips:
        for clip in clips:
            _check_ref_file(clip, "参考片段")
        result["ref_wavs"] = [str(clip) for clip in clips]
        return result

    if payload.ref_voice:
        path, name = _resolve_ref_voice(settings, payload.ref_voice)
        _check_ref_file(path, f"音色 {name} 的参考音频")
        result["ref_wav"] = str(path)
        result["voice_id"] = payload.ref_voice
        result["voice_name"] = name
        return result

    assert payload.ref_path is not None
    path = Path(payload.ref_path)
    _check_ref_file(path, "参考音频")
    result["ref_wav"] = str(path)
    result["voice_id"] = "ref_path"
    return result


def run_synthesis(settings: Settings, payload: SynthPayload) -> dict[str, Any]:
    """完整合成一条（带长尾护栏）。

    顺序刻意是：**先请求校验（参考音频存在/够长）→ 再显存准入 → 最后互斥**。
    参考音频不存在这类「改了请求就能修好」的错误，不该被显存状态挡住 ——
    否则用户会先去折腾显存，回来还是被告知路径写错了。

    护栏见 `_run_with_watchdog`：段间外推降步（主）+ 墙钟看门狗（兜底）。
    """
    reference = resolve_reference(settings, payload)
    engine.check_vram_admission(settings, loaded=engine.is_loaded())
    if not engine.try_acquire_busy():
        raise IrodoriError(
            "ENGINE_BUSY",
            # 两种「忙」要说清楚：一种在正常跑，一种是上一请求已被护栏放弃但还没跑完。
            # 后者用户只能等（没有任何操作能加速），不写清楚会被当成死锁。
            (
                "上一次合成已经超时被放弃，但它仍在收尾（采样无法从外部中断），"
                "显存要等它跑完才可用"
                if engine.is_recovering()
                else "已有一条合成/训练在跑，显存同一时刻只服务一个请求"
            ),
            "等它结束再试（约等于剩余段落的时长）；批量文本请走批量接口而不是并发请求。",
            status=409,
            retryable=True,
        )
    try:
        # ⚠️ 加载**刻意放在看门狗之外**：首次加载约 20s，是启动成本而不是采样成本。
        # 算进预算的话，任何小于 20s 的预算都会让第一次请求必然 504（本机实测踩到）。
        # 加载失败有它自己的错误码（ENGINE_LOAD_FAILED），不需要护栏兜。
        runtime, _ = engine.load(settings)
        return _run_with_watchdog(settings, payload, reference, runtime)
    except IrodoriError as error:
        # ⚠️ 超时是「放弃请求、但合成还在收尾」：合成权必须留给工作线程自己放。
        # 在这里放掉，下一个请求会立刻拿到锁、然后和孤儿一起抢上游的 _infer_lock。
        if error.code != "IRODORI_TIMEOUT":
            engine.release_busy()
        raise
    except Exception:
        # 走到这里说明工作线程根本没起来（start 失败等）：合成权没人会放，自己放掉
        engine.release_busy()
        raise


def _run_with_watchdog(
    settings: Settings, payload: SynthPayload, reference: dict[str, Any], runtime: Any
) -> dict[str, Any]:
    """墙钟看门狗（护栏第二层，兜底）。

    ☠️ 为什么只能「放弃」而不能「中断」：上游 `sample_rf` 的采样循环**没有任何回调
    hook**（`log_fn` 只在每个阶段结束时打一次，步与步之间没有），而一个已经在 CUDA 上
    跑起来的同步采样，Python 层既没有取消协议也没有线程 kill。所以超时后只能：

    1. 让请求线程带着 **504 `IRODORI_TIMEOUT`** 先返回（用户立刻拿到可行动的提示）；
    2. 让工作线程跑完剩余段落 —— 但它会在**段间检查点**看到 cancel 标志并立刻停手，
       所以实际收尾时间 = 当前那一段的剩余时间（而不是整条文本）；
    3. 合成权继续被持有到工作线程退出（此时新请求拿 409，文案由 `is_recovering` 区分）。

    真正能**绕开**长尾的是护栏第一层（段间外推降步），见 `_run_synthesis_locked`。
    """
    budget = max(float(settings.timeout_sec), 1.0)
    holder: dict[str, Any] = {}
    progress: dict[str, Any] = {"done": 0, "total": 0, "steps": None, "downgraded": False}
    cancel = threading.Event()

    def target() -> None:
        try:
            holder["result"] = _run_synthesis_locked(settings, payload, reference, runtime, cancel, progress)
        except BaseException as error:  # noqa: BLE001 - 异常要原样交给请求线程重新抛出
            holder["error"] = error
        finally:
            # 顺序要紧：先清 recovering，再放锁 —— 反过来会有一瞬间「锁空着但仍在收尾」
            engine.clear_recovering()
            engine.release_busy()

    worker = threading.Thread(target=target, name="irodori-synth", daemon=True)
    worker.start()
    worker.join(budget)

    if worker.is_alive():
        cancel.set()
        engine.mark_recovering()
        steps = progress.get("steps")
        raise IrodoriError(
            "IRODORI_TIMEOUT",
            (
                f"合成超过 {budget:.0f}s 预算仍未完成"
                f"（已完成 {progress.get('done', 0)}/{progress.get('total', 0)} 段，步数 {steps}）"
            ),
            "这是罕见的采样长尾（实测约 1/40，坏 seed + 高步数触发）。把 num_steps 降到 20 重试即可绕开；"
            "多段文本的服务端会自动对剩余段落降步，单段长文本建议拆开合成。",
            status=504,
            retryable=True,
            details={
                "timeout_sec": budget,
                "steps": steps,
                "segments_done": progress.get("done", 0),
                "segments_total": progress.get("total", 0),
                "downgraded": progress.get("downgraded", False),
                # 给客户端「重试（降步）」按钮用，别让前端自己猜降到几步
                "retry_suggestion": {"num_steps": settings.downgrade_steps},
            },
        )

    if "error" in holder:
        raise holder["error"]
    return holder["result"]


def _run_synthesis_locked(
    settings: Settings,
    payload: SynthPayload,
    reference: dict[str, Any],
    runtime: Any,
    cancel: "threading.Event",
    progress: dict[str, Any],
) -> dict[str, Any]:
    import torch  # noqa: PLC0415 - 合成期才有 torch

    from irodori_tts.inference_runtime import SamplingRequest  # noqa: PLC0415

    segments = split_sentences(payload.text)
    base_seed = payload.seed if payload.seed is not None else random.randint(0, 2**31 - 1)
    steps = payload.num_steps or settings.default_steps
    requested_steps = steps
    downgraded_at: Optional[int] = None

    budget = max(float(settings.timeout_sec), 1.0)
    trigger = budget * BUDGET_SAFETY
    progress.update({"total": len(segments), "steps": steps, "downgraded": False})

    started = time.perf_counter()
    pieces: list[Any] = []
    for index, segment in enumerate(segments):
        # 请求已被看门狗放弃：剩余段落不必再跑（省下的正是收尾时间）
        if cancel.is_set():
            raise IrodoriError("IRODORI_TIMEOUT", "合成已超过预算，放弃剩余段落", "", status=504)

        # ---- 护栏第一层：段间外推降步（真正绕开长尾的手段） ----
        # 依据是阶段 28 实测：同一条命令 40 步撞上坏 seed 要 89.17s，降到 20 步变 2.16s。
        # 只能对「还没跑的段」生效 —— 正在跑的那一段杀不掉（见 _run_with_watchdog 的说明），
        # 好在第一段通常就是最慢的那一段，跑完它之后预算还剩大半。
        if index > 0 and downgraded_at is None and steps > settings.downgrade_steps:
            elapsed = time.perf_counter() - started
            predicted = elapsed + (elapsed / index) * (len(segments) - index)
            if predicted > trigger:
                steps = settings.downgrade_steps
                downgraded_at = index
                # 只在我们自己随机 seed 时才换：用户显式给了 seed 就尊重「同 seed 同输入确定」，
                # 那种情况下靠降步绕开（实测够用），不偷偷改人家的输入。
                if payload.seed is None:
                    base_seed = random.randint(0, 2**31 - 1)
                progress.update({"steps": steps, "downgraded": True})
                print(
                    f"[irodori] 采样偏慢（{index} 段用了 {elapsed:.1f}s，"
                    f"按此速度整条约 {predicted:.0f}s > 预算 {budget:.0f}s）→ "
                    f"剩余段落降到 {steps} 步",
                    flush=True,
                )

        request = SamplingRequest(
            text=segment,
            caption=payload.caption,
            ref_wav=reference.get("ref_wav"),
            ref_wavs=reference.get("ref_wavs"),
            ref_embed=reference.get("ref_embed"),
            max_ref_seconds=settings.max_ref_seconds,
            num_steps=steps,
            seed=base_seed + index,
            duration_scale=payload.duration_scale,
            t_schedule_mode=payload.schedule,
        )
        result = runtime.synthesize(request, log_fn=lambda _msg: None)
        audio = result.audio.detach().to("cpu", dtype=torch.float32)
        if audio.ndim == 1:
            audio = audio.reshape(1, -1)
        elif audio.shape[0] != 1:
            audio = audio.reshape(1, -1)
        pieces.append(audio)
        progress["done"] = index + 1

    sample_rate = int(result.sample_rate)
    gap = torch.zeros(1, int(SEGMENT_GAP_SECONDS * sample_rate), dtype=torch.float32)
    merged: list[Any] = []
    for i, piece in enumerate(pieces):
        if i > 0:
            merged.append(gap)
        merged.append(piece)
    full = torch.cat(merged, dim=1).reshape(-1) if len(merged) > 1 else pieces[0].reshape(-1)

    duration_sec = full.shape[0] / sample_rate
    elapsed_sec = time.perf_counter() - started

    buffer = io.BytesIO()
    import numpy as np  # noqa: PLC0415
    import soundfile as sf  # noqa: PLC0415

    # float32 → PCM_16 WAV：soundfile 的浮点约定是 [-1,1]，int16 交给它自己缩放
    # （坑 36：绝不能把整数样本直接强转 float32 再写）
    sf.write(buffer, np.asarray(full.numpy(), dtype=np.float32), sample_rate, subtype="PCM_16", format="WAV")
    audio_base64 = base64.b64encode(buffer.getvalue()).decode("ascii")

    return {
        "ok": True,
        "audio_base64": audio_base64,
        "sample_rate": sample_rate,
        "duration_sec": round(duration_sec, 3),
        "elapsed_sec": round(elapsed_sec, 3),
        "rtf": round(elapsed_sec / duration_sec, 4) if duration_sec > 0 else None,
        "used_seed": base_seed,
        # 步数三分：请求要的 / 实际用的 / 有没有被护栏降过 —— 前端要把「质量档被自动调低」
        # 如实显示出来，否则用户以为拿到的还是 40 步的音质
        "steps_requested": requested_steps,
        "steps_used": steps,
        "retried": downgraded_at is not None,
        "downgraded_at_segment": downgraded_at,
        "timeout_sec": budget,
        "segments": len(segments),
        "voice_id": reference.get("voice_id"),
        "voice_name": reference.get("voice_name"),
        "speaker_id": reference.get("speaker_id"),
        "caption": payload.caption,
        "schedule": payload.schedule,
        "duration_scale": payload.duration_scale,
    }

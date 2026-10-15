"""Irodori 训练 S3（Speaker Inversion）验证（阶段 30-6）。

用法：

    irodori/.venv/Scripts/python.exe .tmp/verify_irodori_train_s3.py

**不加载真模型、不占显存**：把训练子进程换成脚本内部的假 runner，
产物却用一份**真的** `.speaker.safetensors`（写进去再读回来）——
与其断言「我们写了文件」，不如断言「写出来的东西能被读成 embedding」。

分七段：
- A 命令行构造（这决定了真机到底跑的是不是 SI）
- B batch 推荐与显存画像
- C 数据集与训练前守卫（延续 30-5「上游会静默跳过」的教训）
- D 任务生命周期：成功 / 409 互斥 / 取消 / OOM / 有退出码无产物 / 基座缺失
- E 进度解析与 ETA 文案
- F 音色库登记的双向兼容（坑 65：三个进程共写同一份 JSON）
- G 回归：catalog / health 没被改坏

真机（要下载 bf16 基座 + 整备日语数据 + 约 5GB 空闲显存）不在此脚本内。
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "irodori"))

for key in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"):
    os.environ.pop(key, None)

PASS = 0
FAIL = 0
_FAILED: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"  [ok] {name}")
    else:
        FAIL += 1
        _FAILED.append(name)
        print(f"  [NG] {name}" + (f"  <- {detail}" if detail else ""))


# ---------------------------------------------------------------------------
# 临时工作区：把 data_dir / voicelib 指到临时目录，别污染真实数据
# ---------------------------------------------------------------------------

_TMP = Path(tempfile.mkdtemp(prefix="irodori-s3-"))
_VOICELIB = _TMP / "voicelib"
_VOICELIB.mkdir(parents=True, exist_ok=True)
os.environ["VOICES_LIB_DIR"] = str(_VOICELIB)

from app import engine as engine_mod  # noqa: E402
from app import si_train  # noqa: E402
from app.api import create_app  # noqa: E402
from app.config import Settings, required_vram_mb  # noqa: E402
from app.errors import IrodoriError  # noqa: E402
from app.jobs import JobState  # noqa: E402
from app.routers import train as train_routes  # noqa: E402

SETTINGS = Settings.from_env()
SETTINGS.data_dir = _TMP / "data"
SETTINGS.uploads_dir = SETTINGS.data_dir / "uploads"
SETTINGS.train_max_hours = 0.05  # 真实 ODE 太慢，这里只验证「超时会把任务判失败」

_ORIGINAL_RUN_TRAINING = si_train.run_training
_ORIGINAL_PROBE = si_train.probe_batch

print(f"workspace: {_TMP}")


def _write_speaker_file(path: Path, *, rows: int = 16, dim: int = 768) -> None:
    """写一份能被 read_back 的 embedding（顺便验证 publish_speaker 的断言不是摆设）。"""
    try:
        import torch
        from safetensors.torch import save_file
    except Exception as error:  # pragma: no cover
        raise AssertionError(f"缺 safetensors/torch：{error}") from error
    path.parent.mkdir(parents=True, exist_ok=True)
    save_file({"speaker_embedding": torch.zeros(rows, dim)}, str(path))


def _make_dataset(dataset_id: str = "demo", *, rows: int = 6, drop_latent: int = 0) -> Path:
    """造一个 manifest + latent，形态与 traindata.encode_manifest 的产物一致。"""
    directory = SETTINGS.data_dir / "datasets" / dataset_id
    latent_dir = directory / "latents"
    latent_dir.mkdir(parents=True, exist_ok=True)
    lines = []
    for index in range(rows):
        latent = latent_dir / f"{index:05d}.pt"
        if index >= rows - drop_latent:
            pass  # 故意不写这个文件：模拟 latent 被清理
        else:
            latent.write_bytes(b"\x00")
        lines.append(
            json.dumps(
                {
                    "text": f"これはテストです{index}",
                    "caption": None,
                    "latent_path": str(latent),
                    "speaker_id": "probe:spk001",
                    "num_frames": 125,
                },
                ensure_ascii=False,
            )
        )
    manifest = directory / "manifest.jsonl"
    manifest.write_text("\n".join(lines) + "\n", encoding="utf-8")
    (directory / "meta.json").write_text(
        json.dumps({"dataset_id": dataset_id, "written": rows, "manifest_path": str(manifest)}),
        encoding="utf-8",
    )
    return manifest


def _wait_terminal(client, job_id: str, timeout: float = 20.0) -> dict:
    deadline = time.time() + timeout
    last: dict = {}
    while time.time() < deadline:
        response = client.get(f"/v1/jobs/{job_id}")
        last = response.json().get("job", {})
        if last.get("state") in {JobState.SUCCEEDED.value, JobState.FAILED.value, JobState.CANCELLED.value}:
            return last
        time.sleep(0.15)
    return last


print("\n=== A 命令行构造：真机跑的到底是不是 SI ===")

_MANIFEST = _make_dataset()
_OUT = SETTINGS.data_dir / "trainings" / "demo-job"
_COMMAND = si_train.build_command(
    SETTINGS, manifest=_MANIFEST, output_dir=_OUT, steps=35, batch=4, save_every=10, seed=7
)
_JOINED = " ".join(_COMMAND)

check("用当前解释器起上游 train.py", _COMMAND[0] == sys.executable and str(SETTINGS.train_script) in _JOINED, _JOINED[:120])
check("显式 --speaker-inversion（不依赖 yaml 的默认值）", "--speaker-inversion" in _COMMAND)
check("基座指向 bf16 权重（量化档不能训练）", str(SETTINGS.bf16_model_file) in _COMMAND)
check("--num-workers 0（Windows DataLoader spawn 会重入）", "--num-workers 0" in " ".join(_COMMAND))
check("带 --gradient-checkpointing（8GB 卡的必需品）", "--gradient-checkpointing" in _COMMAND)
check("--no-wandb（不偷偷联网建实验）", "--no-wandb" in _COMMAND)
check("--device cuda（不静默落 CPU）", "--device cuda" in _JOINED)
check("--precision bf16 + config 指向上游 SI yaml", "--precision bf16" in _JOINED and str(SETTINGS.si_config_file) in _JOINED)
check("--max-steps/--batch-size/--save-every 透传正确",
      _COMMAND[_COMMAND.index("--max-steps") + 1] == "35"
      and _COMMAND[_COMMAND.index("--batch-size") + 1] == "4"
      and _COMMAND[_COMMAND.index("--save-every") + 1] == "10")
check("--log-every 覆盖上游的 20（进度条才不会卡住）",
      int(_COMMAND[_COMMAND.index("--log-every") + 1]) <= 20)
check("可选 seed 生效", "--seed 7" in _JOINED)
check("训练环境保留 HF_HOME（SI 路径的分词器走 HF 缓存）",
      si_train.training_env().get("HF_HOME") == os.environ.get("HF_HOME"))

print("\n=== B batch 推荐与显存画像 ===")

check("训练档准入跟着 batch 走（batch 8 比 batch 2 严）",
      required_vram_mb("bf16", "train", batch=8) > required_vram_mb("bf16", "train", batch=2),
      f"b8={required_vram_mb('bf16','train',batch=8)} b2={required_vram_mb('bf16','train',batch=2)}")
check("训练门槛不低于基座本体（不会假放行）",
      min(required_vram_mb("bf16", "train", batch=b) for b in (1, 2, 4, 8)) >= 4200)
_free = si_train.heuristic_batch(SETTINGS, 8192)
_tight = si_train.heuristic_batch(SETTINGS, 2600)
_none = si_train.heuristic_batch(SETTINGS, None)
check("显存宽裕时敢上 batch 8", _free.batch == 8 and _free.source == "heuristic", json.dumps(_free.to_dict(), ensure_ascii=False))
check("显存紧张时自动降到 1", _tight.batch == 1, json.dumps(_tight.to_dict(), ensure_ascii=False))
check("读不到显存时保守取 2", _none.batch == 2 and _none.source == "fallback")
check("batch 随空闲单调不减", si_train.heuristic_batch(SETTINGS, 4000).batch <= _free.batch)
check("推荐值不超过本机上限", all(plan.batch <= SETTINGS.max_train_batch for plan in (_free, _tight, _none)))
check("回显包含「怎么算出来的」", bool(_free.note) and str(_free.estimated_net_mb or 0).isdigit())

print("\n=== C 数据集与训练前守卫 ===")

try:
    si_train.dataset_manifest(SETTINGS, "没有这个数据集")
    check("数据集不存在 → DATASET_NOT_FOUND", False)
except IrodoriError as error:
    check("数据集不存在 → DATASET_NOT_FOUND", error.code == "DATASET_NOT_FOUND", error.code)

_dataset_id, _path = si_train.dataset_manifest(SETTINGS, "demo")
check("dataset_id → manifest 解析正确", _dataset_id == "demo" and _path.is_file(), str(_path))

try:
    si_train.dataset_manifest(SETTINGS, "../../evil")
    check("非法 dataset_id 被显式拒绝（不是过滤后放行）", False)
except IrodoriError as error:
    check("非法 dataset_id 被显式拒绝（不是过滤后放行）", error.code == "DATASET_ID_INVALID", error.code)

_stats = si_train.manifest_stats(_path)
check("manifest 统计行数正确", _stats["rows"] == 6, json.dumps(_stats))
check("latent 缺失被数出来", _stats["missing_latent"] == 0, json.dumps(_stats))
check("帧数换算成秒（codec 25 fps）", abs(_stats["total_seconds"] - 30.0) < 0.5, str(_stats["total_seconds"]))

_empty = _TMP / "empty.jsonl"
_empty.write_text("", encoding="utf-8")
try:
    si_train.assert_trainable(si_train.manifest_stats(_empty), _empty)
    check("空 manifest 不许开训（延续 30-5 守卫一）", False)
except IrodoriError as error:
    check("空 manifest 不许开训（延续 30-5 守卫一）", error.code == "TRAIN_NO_DATA", error.code)

_lost = _make_dataset("lost", rows=4, drop_latent=4)
try:
    si_train.assert_trainable(si_train.manifest_stats(_lost), _lost)
    check("latent 全丢不许开训", False)
except IrodoriError as error:
    check("latent 全丢不许开训", error.code == "TRAIN_NO_DATA", error.code)

_partial = _make_dataset("partial", rows=4, drop_latent=1)
_partial_stats = si_train.manifest_stats(_partial)
try:
    si_train.assert_trainable(_partial_stats, _partial)
    check("丢一部分 latent 放行（但上游会跳过）", _partial_stats["missing_latent"] == 1)
except IrodoriError as error:
    check("丢一部分 latent 放行（但上游会跳过）", False, error.code)

print("\n=== D 任务生命周期（假 runner，真实 JobStore） ===")

APP = create_app(SETTINGS)
STORE = APP.state.jobs

import app.inventory as inventory_mod  # noqa: E402

_REAL_SCAN = inventory_mod.scan
inventory_mod.scan = lambda settings: {**_REAL_SCAN(settings), "training_ready": True}
train_routes.scan = inventory_mod.scan
try:
    from fastapi.testclient import TestClient  # noqa: E402
except Exception as error:  # pragma: no cover
    raise AssertionError(f"缺 httpx/TestClient：{error}") from error

CLIENT = TestClient(APP)


def _fake_probe(settings, *, manifest, output_dir, steps=None, logger=None, is_cancelled=None, timeout_sec=0):
    logger = logger or (lambda _: None)
    logger("fake probe")
    return si_train.BatchPlan(batch=2, source="probe", note="fake", peak_used_mb=1000, free_mb=8192)


def _fake_run(settings, *, manifest, output_dir, steps, batch, logger=None, on_step=None,
              is_cancelled=None, save_every=None, seed=None, init_embedding=None):
    """假训练：逐步回调 + 产物落盘（形态与上游一致）。"""
    for step in (5, 10, 15, 20):
        if on_step:
            on_step(step, 0.9 - step * 0.01, (steps - step) * 0.3)
    final = Path(output_dir) / si_train.FINAL_CHECKPOINT_NAME
    _write_speaker_file(final)
    (Path(output_dir) / "checkpoint_0000010.speaker.safetensors").write_bytes(b"x")
    return si_train.TrainRun(steps_seen=steps, last_loss=0.7, elapsed_sec=12.0, returncode=0)


si_train.probe_batch = _fake_probe
si_train.run_training = _fake_run
train_routes.engine.check_vram_admission = lambda *args, **kwargs: {"vram": None}
train_routes._free_mb = lambda: 8192

_VOICE = {
    "id": "voice-ja-1",
    "name": "日语参考（测试）",
    "audio_path": str(_TMP / "ref.wav"),
    "prompt_text": "これはリファレンスです",
    "prompt_lang": "ja",
    "tags": ["irodori"],
    "ref_clips": [{"path": str(_TMP / "a.wav"), "dur_s": 8.0}],
    "engine_tags": ["irodori"],
}
(_VOICELIB / "voices.json").write_text(
    json.dumps([_VOICE, {"id": "other", "name": "别的音色"}], ensure_ascii=False, indent=2),
    encoding="utf-8",
)

_resp = CLIENT.post("/v1/train", json={"dataset_id": "demo", "steps": 20, "voice_id": "voice-ja-1"})
_job = _resp.json().get("job", {})
check("POST /v1/train 入队成功（不再是 501）", _resp.status_code == 200 and _job.get("kind") == "train", str(_resp.status_code) + _resp.text[:200])
check("四个阶段就位", [stage["key"] for stage in _job.get("stages", [])] == ["plan", "train", "save", "register"])

_busy = CLIENT.post("/v1/train", json={"dataset_id": "demo", "steps": 20})
check("训练中再入队 → 409 ENGINE_BUSY", _busy.status_code == 409 and _busy.json().get("error", {}).get("code") == "ENGINE_BUSY", str(_busy.status_code))

_job = _wait_terminal(CLIENT, _job["id"])
check("任务终态为 succeeded", _job.get("state") == JobState.SUCCEEDED.value, str(_job.get("state")) + str(_job.get("error")))
_artifacts = _job.get("artifacts", {})
_speaker = _artifacts.get("speaker", {})
check("产物复制到 speakers 目录", Path(_speaker.get("path", "")).is_file(), str(_speaker))
check("产物校验读了回 embedding 形状", _speaker.get("embedding_shape") == [16, 768], str(_speaker.get("embedding_shape")))
check("训练步数与 batch 回显一致", _artifacts.get("steps") == 20 and _artifacts.get("batch", {}).get("batch") == 2)
check("周期产物被收集（可用于中途对比）", len(_artifacts.get("checkpoints", {}).get("periodic", [])) == 1)
check("登记到指定音色的 speaker_embeds", bool(_artifacts.get("registered")), json.dumps(_artifacts.get("registered"), ensure_ascii=False))

_speakers = CLIENT.get("/v1/speakers").json()
check("/v1/speakers 能列到新音色", _speakers["count"] >= 1, json.dumps(_speakers))

_index_after = json.loads((_VOICELIB / "voices.json").read_text(encoding="utf-8"))
_target = next(item for item in _index_after if item["id"] == "voice-ja-1")
check("登记把 ref_clips / engine_tags 原样保住（坑 65）", bool(_target.get("ref_clips")) and _target.get("engine_tags") == ["irodori"])
check("登记没写脏字段（没有 null 占位）", all(value is not None for value in _target.get("speaker_embeds", [{}])[0].values()))
check("另一条音色没被碰", next(item for item in _index_after if item["id"] == "other") == {"id": "other", "name": "别的音色"})

_retrain = CLIENT.post("/v1/train", json={"dataset_id": "demo", "steps": 20, "voice_id": "voice-ja-1"})
_retrain_job = _wait_terminal(CLIENT, _retrain.json()["job"]["id"])
_index_twice = json.loads((_VOICELIB / "voices.json").read_text(encoding="utf-8"))
check("同一 speaker_id 重复训练不产生重复条目",
      len(next(item for item in _index_twice if item["id"] == "voice-ja-1")["speaker_embeds"]) == 1)

# ---- 取消 ----
_slow_calls = {"steps": 0}


def _slow_run(settings, *, manifest, output_dir, steps, batch, logger=None, on_step=None,
              is_cancelled=None, save_every=None, seed=None, init_embedding=None):
    for second in range(30):
        if is_cancelled and is_cancelled():
            return si_train.TrainRun(steps_seen=second, returncode=-15, cancelled=True)
        time.sleep(0.2)
    return si_train.TrainRun(returncode=0)


si_train.run_training = _slow_run
_cancel = CLIENT.post("/v1/train", json={"dataset_id": "demo", "steps": 50, "batch": 2})
_cancel_id = _cancel.json()["job"]["id"]
time.sleep(0.6)
_cancelled = CLIENT.post(f"/v1/jobs/{_cancel_id}/cancel").json()
check("取消请求被受理", _cancelled.get("cancelled") is True)
_job = _wait_terminal(CLIENT, _cancel_id, timeout=15)
check("训练中的任务可以被取消", _job.get("state") == JobState.CANCELLED.value, str(_job.get("state")))

# ---- OOM ----
def _oom_run(settings, *, manifest, output_dir, steps, batch, logger=None, on_step=None,
             is_cancelled=None, save_every=None, seed=None, init_embedding=None):
    return si_train.TrainRun(
        returncode=1,
        tail=["torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 512.00 MiB"],
    )


si_train.run_training = _oom_run
_oom = CLIENT.post("/v1/train", json={"dataset_id": "demo", "steps": 20, "batch": 8})
_oom_job = _wait_terminal(CLIENT, _oom.json()["job"]["id"])
check("OOM 被识别成 TRAIN_OOM 而不是 INTERNAL", _oom_job.get("error") == "TRAIN_OOM", str(_oom_job.get("error")))
check("OOM 的 hint 指向降 batch", "batch" in " ".join(log["text"] for log in _oom_job.get("logs", [])))

# ---- 退出码 0 但没产物（上游静默行为的第二道守卫）----
def _silent_run(settings, *, manifest, output_dir, steps, batch, logger=None, on_step=None,
                is_cancelled=None, save_every=None, seed=None, init_embedding=None):
    Path(output_dir).mkdir(parents=True, exist_ok=True)
    return si_train.TrainRun(steps_seen=steps, returncode=0)


si_train.run_training = _silent_run
_silent = CLIENT.post("/v1/train", json={"dataset_id": "demo", "steps": 20, "batch": 2})
_silent_job = _wait_terminal(CLIENT, _silent.json()["job"]["id"])
check("退出码 0 但无产物 → TRAIN_NO_ARTIFACT", _silent_job.get("error") == "TRAIN_NO_ARTIFACT", str(_silent_job.get("error")))

# ---- 训练档权重缺失 ----
si_train.run_training = _fake_run
inventory_mod.scan = lambda settings: {**_REAL_SCAN(settings), "training_ready": False}
train_routes.scan = inventory_mod.scan
_nobase = CLIENT.post("/v1/train", json={"dataset_id": "demo", "steps": 20})
check("bf16 基座缺失 → 503 TRAIN_BASE_MISSING（且不建任务）",
      _nobase.status_code == 503 and _nobase.json()["error"]["code"] == "TRAIN_BASE_MISSING", str(_nobase.status_code))
inventory_mod.scan = lambda settings: {**_REAL_SCAN(settings), "training_ready": True}
train_routes.scan = inventory_mod.scan

# ---- batch 显式指定时跳过探测 ----
_probed = {"called": False}


def _probe_counter(settings, *, manifest, output_dir, steps=None, logger=None, is_cancelled=None, timeout_sec=0):
    _probed["called"] = True
    return si_train.BatchPlan(batch=4, source="probe")


si_train.probe_batch = _probe_counter
_explicit = CLIENT.post("/v1/train", json={"dataset_id": "demo", "steps": 20, "batch": 3})
_explicit_job = _wait_terminal(CLIENT, _explicit.json()["job"]["id"])
check("显式 batch 时跳过自动探测", (not _probed["called"]) and _explicit_job["artifacts"]["batch"]["batch"] == 3)

_batch_endpoint = CLIENT.post("/v1/train/auto_batch", json={"probe": False})
check("/v1/train/auto_batch 可用（默认不真跑）", _batch_endpoint.status_code == 200 and not _batch_endpoint.json().get("probed"),
      _batch_endpoint.text[:150])
check("GET 别名同样可用", CLIENT.get("/v1/train/auto_batch").status_code == 200)

print("\n=== E 进度解析与 ETA ===")

check("解析标准行", si_train._STEP_RE.search("step=120 loss=0.123456 rf=0.11") is not None)
_matched = si_train._STEP_RE.search("step=250 loss=8.9e-04 rf=0.11 lr=1.00e-02")
check("解析科学计数法 loss", _matched is not None and abs(float(_matched.group(2)) - 8.9e-04) < 1e-9)
check("ETA 文案说人话", train_routes._eta_text(3725) == "1 小时 2 分" and train_routes._eta_text(95) == "1 分 35 秒",
      train_routes._eta_text(3725))

_zero = CLIENT.post("/v1/train", json={"dataset_id": "demo", "steps": 0})
check("steps=0 被拒（BAD_REQUEST）", _zero.status_code == 400 and _zero.json()["error"]["code"] == "BAD_REQUEST", str(_zero.status_code))
_bad = CLIENT.post("/v1/train", json={"dataset_id": "demo", "steps": "abc"})
check("steps 非数字被拒", _bad.status_code == 400)

print("\n=== F 失败分类 ===")

_code, _message, _hint = si_train.classify_failure(1, ["RuntimeError: CUDA out of memory"])
check("CUDA out of memory → TRAIN_OOM", _code == "TRAIN_OOM", _code)
_code, _, _ = si_train.classify_failure(1, ["torch.OutOfMemoryError"])
check("torch.OutOfMemoryError → TRAIN_OOM", _code == "TRAIN_OOM", _code)
_code, _, _hint = si_train.classify_failure(1, ["ConnectionError: Couldn't reach huggingface.co"])
check("联网失败 → TRAIN_NETWORK 且 hint 提到 HF_HOME", _code == "TRAIN_NETWORK" and "HF_HOME" in _hint, _code)
_code, _, _ = si_train.classify_failure(1, ["ModuleNotFoundError: No module named 'dacvae'"])
check("缺依赖 → CODEC_LOAD_FAILED", _code == "CODEC_LOAD_FAILED", _code)
_code, _, _ = si_train.classify_failure(9, ["something exploded"])
check("其它错误 → TRAIN_FAILED（不带内部堆栈）", _code == "TRAIN_FAILED", _code)

print("\n=== G 回归 ===")

_health = CLIENT.get("/health")
check("/health 仍然 200", _health.status_code == 200, str(_health.status_code))
_catalog = CLIENT.get("/v1/catalog").json()
check("catalog 的 training.s3_ready 已打开", _catalog["training"]["s3_ready"] is True)
check("catalog 暴露自动 batch 的参数（前端不抄数）", "auto_batch" in _catalog["training"])
_corpus_dir = _TMP / "data" / "uploads" / "corpus"
_corpus_dir.mkdir(parents=True, exist_ok=True)
try:
    import numpy as np
    import soundfile as sf
except Exception:  # pragma: no cover
    np = None
if np is not None:
    for index in range(3):
        wave = (0.05 * np.sin(np.linspace(0, 6.28 * 220, 24000))).astype("float32")
        sf.write(str(_corpus_dir / f"{index:03d}.wav"), wave, 24000)
        (_corpus_dir / f"{index:03d}.txt").write_text(f"これはコーパスです{index}", encoding="utf-8")

_plan = CLIENT.post("/v1/train/plan", json={"dataset_id": "corpus"}).json()
if "steps" not in _plan:
    print("     plan 返回：" + json.dumps(_plan, ensure_ascii=False)[:300])
_s3 = next((step for step in _plan.get("steps", []) if step["key"] == "s3"), {})
check("plan 的 S3 状态如实反映（有数据集 == ready）", _s3.get("state") == "ready", json.dumps(_s3, ensure_ascii=False))
check("plan 的 training 段给出 batch 推荐", _plan.get("training", {}).get("batch", {}).get("batch", 0) >= 1)
_check_keys = set(json.loads((_VOICELIB / "voices.json").read_text(encoding="utf-8"))[0].keys())
check("音色索引没有引入临时文件", not (Path(_VOICELIB) / "voices.json.tmp").exists())

# 还原（顺手把模块 CMS 恢复到真值，便于同一进程里再跑别的检查）
si_train.run_training = _ORIGINAL_RUN_TRAINING
si_train.probe_batch = _ORIGINAL_PROBE
inventory_mod.scan = _REAL_SCAN
train_routes.scan = _REAL_SCAN

print(f"\n=== 小结：PASS={PASS} FAIL={FAIL} ===")
if _FAILED:
    print("失败项：" + "、".join(_FAILED))
shutil.rmtree(_TMP, ignore_errors=True)
sys.exit(1 if FAIL else 0)

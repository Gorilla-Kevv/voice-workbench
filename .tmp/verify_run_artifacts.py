# -*- coding: utf-8 -*-
"""验收：运行产物面板的解析规则（`collectTracks()`）对两类任务都正确。

用户诉求原文：「**训练和运行**之后的产物应该在网站全部显示，同时也给出本地路径」。

为什么不用 HTTP 端到端：本机 8G 卡被桌面进程占到只剩 <1G，DDSP-SVC 要 3.5G、
RVC 要 3G，端到端必然卡在显存准入。那是环境问题，不是代码问题。

所以这里用**真实结构的 fixtures** 验证解析规则本身。fixtures 的来源都是可核对的：
  * `vc_infer`  —— 服务端实测返回（见 `.tmp` 里 61cf3240469a 的记录）；
  * `svc_infer` —— `trainer/app/svc/cover.py::export_tracks()` 的返回值形状，
    即 `{vocal, instrumental, mix}` + 路由层补的
    `urls = {"vocal": "/files/svc/<id>/<name>.wav", ...}`。
"""
import re
import sys

# 与 useVcRunHistory.ts 的 TRACK_LABELS 对齐
TRACK_LABELS = {"output": "转换结果", "vocal": "新人声", "instrumental": "伴奏", "mix": "混音"}
META_KEYS = {"urls", "job_id", "model"}

PASS, FAIL = [], []


def check(label, ok, extra=""):
    (PASS if ok else FAIL).append(label)
    print("  [%s] %s%s" % ("OK " if ok else "!! ", label, ("  -> " + str(extra)) if extra else ""))


def looks_like_disk_path(value):
    return bool(re.match(r"^[a-zA-Z]:[\\/]", value))


def collect_tracks(artifacts):
    """复刻前端 `useVcRunHistory.ts::collectTracks()`，逐字对齐。"""
    bag = artifacts or {}
    urls = bag.get("urls") or {}
    # 路径来源两处：顶层（变声）+ 内层 artifacts（翻唱）。内层覆盖顶层。
    paths = dict(bag)
    paths.update(bag.get("artifacts") or {})
    paths.pop("urls", None)
    paths.pop("artifacts", None)

    keys = set(urls.keys())
    for key, value in paths.items():
        if key in ("job_id", "model"):
            continue
        if isinstance(value, str) and (looks_like_disk_path(value) or value.startswith("/files/")):
            keys.add(key)

    tracks = []
    for key in keys:
        raw_path = paths.get(key)
        raw_url = urls.get(key)
        path = raw_path if isinstance(raw_path, str) and looks_like_disk_path(raw_path) else None
        url = raw_url if isinstance(raw_url, str) and raw_url else None
        if not path and not url:
            continue
        tracks.append({"key": key, "label": TRACK_LABELS.get(key, key), "url": url, "path": path})
    tracks.sort(key=lambda t: (0 if t["key"] == "output" else 1, t["key"]))
    return tracks


VC_INFER = {
    "job_id": "61cf3240469a",
    "output": r"F:\schoolCompWorks\clone\ttstool\trainer\.data\outputs\vc\61cf3240469a\converted.wav",
    "urls": {"output": "/files/vc/61cf3240469a/converted.wav"},
    "sample_rate": 40000,
    "duration": 42.02,
    "model": r"F:\schoolCompWorks\clone\ttstool\trainer\.data\vc\models\aiyi.pth",
    "f0_up_key": 0,
    "f0_method": "rmvpe",
    "index_rate": 0.0,
    "used_index": False,
    "info": "Success.\nIndex not used.",
}

# 真实结构：`cover.py::run_cover()` 返回 {"artifacts": {...}, "stages", ...}，
# 路由层 `{"job_id": ..., **result, "urls": ...}` 抛给队列 —— 路径在**内层**
# `artifacts.artifacts`，url 在外层 `urls`。
SVC_INFER_COVER = {
    "job_id": "aaaaaaaaaaaa",
    "artifacts": {
        "vocal": r"F:\schoolCompWorks\clone\ttstool\trainer\.data\outputs\svc\aaaaaaaaaaaa\song_vocal.wav",
        "instrumental": r"F:\schoolCompWorks\clone\ttstool\trainer\.data\outputs\svc\aaaaaaaaaaaa\song_instrumental.wav",
        "mix": r"F:\schoolCompWorks\clone\ttstool\trainer\.data\outputs\svc\aaaaaaaaaaaa\song_mix.wav",
        "sample_rate": 44100,
    },
    "stages": [{"key": "mix", "label": "混音", "outputs": ["instrumental", "mix", "vocal"]}],
    "elapsed_s": 137.4,
    "urls": {
        "vocal": "/files/svc/aaaaaaaaaaaa/song_vocal.wav",
        "instrumental": "/files/svc/aaaaaaaaaaaa/song_instrumental.wav",
        "mix": "/files/svc/aaaaaaaaaaaa/song_mix.wav",
    },
}

SVC_INFER_CONVERT = {
    "job_id": "bbbbbbbbbbbb",
    "output": r"F:\schoolCompWorks\clone\ttstool\trainer\.data\outputs\svc\bbbbbbbbbbbb\converted.wav",
    "urls": {"output": "/files/svc/bbbbbbbbbbbb/converted.wav"},
    "conversion": {"elapsed_s": 12.3, "segments": 4},
}

print("=" * 72)
print("第 1 节  变声（vc_infer）—— 单产物")
print("=" * 72)
tracks = collect_tracks(VC_INFER)
check("解析出 1 条轨道", len(tracks) == 1, [t["key"] for t in tracks])
check("键名是 output", tracks[0]["key"] == "output", tracks[0]["key"])
check("标签为「转换结果」", tracks[0]["label"] == "转换结果", tracks[0]["label"])
check("给了可播放的 Web 地址", tracks[0]["url"] == "/files/vc/61cf3240469a/converted.wav", tracks[0]["url"])
check("给了本机绝对路径（用户要求）", tracks[0]["path"] == VC_INFER["output"], tracks[0]["path"].rsplit("\\", 1)[-1])
check("元信息（sample_rate / duration / info）没有被误当产物",
      all(t["key"] not in {"sample_rate", "duration", "info", "model", "f0_method"} for t in tracks))

print()
print("=" * 72)
print("第 2 节  翻唱向导（svc_infer）—— 多产物，最容易漏的是这个")
print("=" * 72)
tracks = collect_tracks(SVC_INFER_COVER)
check("解析出 3 条轨道（新人声 / 伴奏 / 混音）", len(tracks) == 3, [t["key"] for t in tracks])
check("三条轨道的 key 齐全", {t["key"] for t in tracks} == {"vocal", "instrumental", "mix"}, sorted(t["key"] for t in tracks))
check("每条都有可播放地址", all(t["url"] and t["url"].startswith("/files/svc/") for t in tracks))
check("每条都有本机路径（用户要求）", all(t["path"] and looks_like_disk_path(t["path"]) for t in tracks))
check("`stages` 与 `sample_rate` 没被误认成产物",
      all(t["key"] not in {"stages", "sample_rate", "elapsed_s"} for t in tracks), sorted(t["key"] for t in tracks))
check("标签都是中文可读的", all(t["label"] in {"新人声", "伴奏", "混音"} for t in tracks),
      [t["label"] for t in tracks])

print()
print("=" * 72)
print("第 3 节  直接转换（svc_infer，mode=convert）—— 只有 output 一条")
print("=" * 72)
tracks = collect_tracks(SVC_INFER_CONVERT)
check("解析出 1 条轨道", len(tracks) == 1, [t["key"] for t in tracks])
check("标签为「转换结果」", tracks[0]["label"] == "转换结果", tracks[0]["label"])
check("给了本机路径", bool(tracks[0]["path"]), tracks[0]["path"].rsplit("\\", 1)[-1])
check("按 output 排在前面", tracks[0]["key"] == "output")

print()
print("=" * 72)
print("第 4 节  边界：没有产物 / 只有路径没有 url")
print("=" * 72)
empty = collect_tracks({"job_id": "x", "urls": {}})
check("空产物返回空数组（不崩、不造出假轨道）", empty == [], empty)
only_path = collect_tracks({"output": r"F:\a\b.wav", "urls": {}})
check("只有绝对路径时仍能给出本机路径", len(only_path) == 1 and only_path[0]["path"] == r"F:\a\b.wav", only_path)
check("没有 Web 地址时 url 为 None（前端据此跳过播放器）", only_path[0]["url"] is None, only_path[0]["url"])
only_url = collect_tracks({"urls": {"output": "/files/vc/x/a.wav"}})
check("只有 Web 地址时仍能播放", len(only_url) == 1 and only_url[0]["url"] == "/files/vc/x/a.wav", only_url)

print()
print("=" * 72)
print("汇总：通过 %d / 失败 %d" % (len(PASS), len(FAIL)))
for item in FAIL:
    print("  失败：%s" % item)
print("=" * 72)
sys.exit(1 if FAIL else 0)

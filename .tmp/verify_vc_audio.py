# -*- coding: utf-8 -*-
"""验收：变声产物不再失真（用户主诉「音频增益过大，全部失真」）。

**为什么用单元级验证而不是 HTTP 端到端**：本机 RTX 4060（8G）常被 ~20 个桌面进程
（浏览器 / Steam / explorer / 桌面美化）占到只剩 <1G，RVC 需要 3G，端到端必然
卡在显存准入。那是环境问题，不是代码问题；用单元级验证才能真正锁住回归。

核心断言：`app.audio.io.save()` 必须**按 dtype 分流**处理输入 ——
  * 整数（int16）：原样交给 soundfile（满量程语义），absmax ≈ 0.74、0% 削波；
  * 浮点：规整成 float32，round-trip 无损。
修复前的做法（无脑 `np.asarray(data, dtype=np.float32)`）会把 ±32768 的 int16
当归一化浮点写出去，100% 削波成方波 —— 这正是用户听到的失真。
"""
import sys
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "trainer"))

from app.audio import io as audio_io  # noqa: E402

PASS, FAIL = [], []


def check(label, ok, extra=""):
    (PASS if ok else FAIL).append(label)
    print("  [%s] %s%s" % ("OK " if ok else "!! ", label, ("  -> " + str(extra)) if extra else ""))


tmp = Path(tempfile.mkdtemp())
try:
    # RVC `vc_single()` 的真实返回形态：已缩放到 ±32768 的 int16
    sig = (np.sin(np.linspace(0, 400 * np.pi, 80000)) * 24351).astype(np.int16)

    print("=" * 72)
    print("第 1 节  int16 输入（RVC vc_single 的返回形态）")
    print("=" * 72)
    p = tmp / "i16.wav"
    audio_io.save(p, sig, 40000)
    d, sr = sf.read(str(p), dtype="float32")
    absmax = float(np.abs(d).max())
    clipped = float((np.abs(d) >= 0.999).mean())
    print("  absmax=%.4f  clipped=%.2f%%" % (absmax, clipped * 100))
    check("int16 未被当作归一化浮点（absmax 未顶满）", absmax < 0.99, absmax)
    check("int16 输入 0%% 削波（修复前实测 80.72%%）", clipped < 0.01, "%.2f%%" % (clipped * 100))
    # 还原回 int16 应基本无损
    back = np.round(d * 32767).astype(np.int16)
    check("int16 round-trip 基本无损", bool(np.abs(back.astype(np.int32) - sig.astype(np.int32)).max() <= 2),
          "max diff=%d" % int(np.abs(back.astype(np.int32) - sig.astype(np.int32)).max()))

    print()
    print("=" * 72)
    print("第 2 节  浮点输入（[-1,1] 归一化）")
    print("=" * 72)
    fl = (np.sin(np.linspace(0, 400 * np.pi, 80000)) * 0.8).astype(np.float32)
    p2 = tmp / "f32.wav"
    audio_io.save(p2, fl, 40000)
    d2, _ = sf.read(str(p2), dtype="float32")
    print("  absmax=%.4f  clipped=%.2f%%" % (np.abs(d2).max(), (np.abs(d2) >= 0.999).mean() * 100))
    check("float32 输入 round-trip 无损", bool(np.allclose(d2, fl, atol=1e-4)))
    check("float32 输入 0% 削波", float((np.abs(d2) >= 0.999).mean()) < 0.01)

    p2b = tmp / "f64.wav"
    audio_io.save(p2b, fl.astype(np.float64), 40000)
    d2b, _ = sf.read(str(p2b), dtype="float32")
    check("float64 输入同样无损", bool(np.allclose(d2b, fl, atol=1e-4)))

    print()
    print("=" * 72)
    print("第 3 节  立体声（frames-first，不能转置）")
    print("=" * 72)
    st = np.stack([fl, fl * 0.5], axis=1)  # (N, 2)
    p3 = tmp / "st.wav"
    audio_io.save(p3, st, 40000)
    d3, _ = sf.read(str(p3), dtype="float32")
    check("立体声写出的帧数正确", d3.shape[0] == st.shape[0], d3.shape)
    check("立体声两个声道都在", d3.shape[1] == 2, d3.shape)
    # 反证：转成 channels-first 后 libsndfile 必然拒绝（旧写法的行为）
    try:
        bad = tmp / "st_bad.wav"
        sf.write(str(bad), np.ascontiguousarray(st.T), 40000, subtype="PCM_16")
        check("channels-first 写入应被 libsndfile 拒绝（反证旧转置有害）", False, "竟然写成功了")
    except sf.LibsndfileError:
        check("channels-first 写入应被 libsndfile 拒绝（反证旧转置有害）", True, "Format not recognised")
    except Exception as exc:  # noqa: BLE001
        check("channels-first 写入应被 libsndfile 拒绝（反证旧转置有害）", False, type(exc).__name__)

    print()
    print("=" * 72)
    print("第 4 节  对照：修复前的错误做法")
    print("=" * 72)
    wrong = np.asarray(sig, dtype=np.float32)
    p4 = tmp / "wrong.wav"
    sf.write(str(p4), wrong, 40000)
    d4, _ = sf.read(str(p4), dtype="float32")
    w_clip = float((np.abs(d4) >= 0.999).mean())
    print("  absmax=%.4f  clipped=%.2f%%  <-- 用户听到的失真" % (np.abs(d4).max(), w_clip * 100))
    check("确认旧写法确实会 100% 削波（反证根因）", w_clip > 0.9, "%.2f%%" % (w_clip * 100))
finally:
    import shutil

    shutil.rmtree(tmp, ignore_errors=True)

print()
print("=" * 72)
print("汇总：通过 %d / 失败 %d" % (len(PASS), len(FAIL)))
for f in FAIL:
    print("  失败：%s" % f)
print("=" * 72)
sys.exit(1 if FAIL else 0)

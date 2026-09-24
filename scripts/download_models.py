"""下载两个新板块需要的预训练权重。

权重清单集中在 `trainer/app/weights.py`（唯一事实来源），本脚本只负责取。
设计上三件事要注意：

1. **镜像兜底**：HuggingFace 在国内时好时坏，每个 HF 权重都配了 `hf-mirror.com`
   备用地址，主地址失败就换下一个；
2. **zip 自动解包**：NSF-HiFiGAN 与 RMVPE 发布的是 zip，解包后还要把文件摆到
   上游期望的位置（声码器要求 `model` 与 `config.json` 同目录）；
3. **幂等 + 断点续传**：已存在的文件直接跳过；下载中断留下 `.part` 时，
   下次带 `Range` 头续传，不必从头再来。

用法::

    python scripts/download_models.py                 # 下载全部缺失项
    python scripts/download_models.py --engine svc    # 只下歌声转换
    python scripts/download_models.py --only ddsp_rmvpe
    python scripts/download_models.py --dry-run       # 只看要下什么
"""

from __future__ import annotations

import argparse
import shutil
import sys
import zipfile
from pathlib import Path
from typing import List, Optional

ROOT = Path(__file__).resolve().parents[1]

sys.path.insert(0, str(ROOT / "trainer"))

from app.config import Settings  # noqa: E402
from app.weights import WEIGHTS, WeightSpec, target_path  # noqa: E402

CHUNK = 1024 * 512


def _download(url: str, target: Path, resume: bool = True) -> bool:
    """流式下载，支持断点续传。成功返回 True。"""
    import requests  # noqa: PLC0415

    headers = {}
    mode = "wb"
    done = 0
    if resume and target.with_suffix(target.suffix + ".part").is_file():
        part = target.with_suffix(target.suffix + ".part")
        done = part.stat().st_size
        headers["Range"] = "bytes=%d-" % done
        mode = "ab"

    try:
        # 连接 30s、每次读取最长 10 分钟：GitHub release 的 340MB 附件在网络抖动时
        # 完全可能出现几分钟的静默期，单值 timeout 会把它误判成失败。
        response = requests.get(url, stream=True, timeout=(30, 600), headers=headers)
        if response.status_code not in (200, 206):
            print("    HTTP %d，放弃该地址" % response.status_code)
            return False
        if response.status_code == 200 and done:
            # 服务端忽略了 Range：续传会把两份数据拼在一起，得到的文件必然损坏。
            # 这种情况只能从头再来。
            print("    服务端不支持断点续传，改为重新下载")
            done = 0
            mode = "wb"
        total = int(response.headers.get("content-length") or 0) + done
        target.parent.mkdir(parents=True, exist_ok=True)
        part_path = target.with_suffix(target.suffix + ".part")
        with part_path.open(mode) as handle:
            for chunk in response.iter_content(chunk_size=CHUNK):
                handle.write(chunk)
                done += len(chunk)
                if total:
                    print("\r    %.1f / %.1f MB" % (done / 1e6, total / 1e6), end="", flush=True)
        print()
        if total and done < total:
            print("    只收到 %.1f / %.1f MB，判定为截断（保留 .part 供下次续传）" % (done / 1e6, total / 1e6))
            return False
        part_path.replace(target)
        return True
    except Exception as exc:  # noqa: BLE001 - 换下一个地址继续试
        print("\n    失败：%s" % exc)
        return False


def _unzip(spec: WeightSpec, archive: Path, dest: Path) -> bool:
    """把下载的 zip 解到权重目录，并按上游期望摆放。

    * rmvpe.zip        → <dir>/model.pt
    * nsf_hifigan.zip  → <dir>/{model, config.json}（保持包内相对结构）

    `archive` 必须是**与产物不同名**的临时文件：zip 包里的文件名常常正好等于
    我们想要的产物名（rmvpe.zip 里就是 model.pt），若把压缩包直接下到目标路径，
    解压时会把自己覆盖掉，表现是「解到一半 EOFError，产物 0 字节」。
    """
    if not archive.is_file():
        return False
    dest.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive) as zf:
        zf.extractall(dest)

    # zip 里通常带一层目录，把文件摊平到 dest 根
    for entry in sorted(dest.iterdir()):
        if entry.is_dir():
            for inner in entry.iterdir():
                if inner.is_file():
                    inner.replace(dest / inner.name)
            try:
                entry.rmdir()
            except OSError:
                pass

    # 有些发布包里还套着一层 zip（NSF-HiFiGAN 就是：`model` 本身是个压缩包，
    # 真正的权重在 model.ckpt 里）。摊平后逐个处理，避免用户手工解包。
    for entry in sorted(dest.iterdir()):
        if entry.is_file() and zipfile.is_zipfile(str(entry)):
            with zipfile.ZipFile(entry) as nested:
                nested.extractall(dest / "_nested")
            for inner in (dest / "_nested").rglob("*"):
                if inner.is_file():
                    inner.replace(dest / inner.name)
            shutil.rmtree(dest / "_nested", ignore_errors=True)
            entry.unlink(missing_ok=True)

    # rmvpe：上游要的文件名是 model.pt
    if "rmvpe" in spec.key:
        for candidate in ("model.pt", "rmvpe.pt"):
            found = dest / candidate
            if found.is_file():
                if found.name != "model.pt":
                    found.replace(dest / "model.pt")
                return True

    # 声码器：上游要的文件名是 model，而发布包里叫 model.ckpt
    if "nsf_hifigan" in spec.key:
        ckpt = dest / "model.ckpt"
        if ckpt.is_file():
            ckpt.replace(dest / "model")
    return True


def fetch(spec: WeightSpec, settings: Settings, dry_run: bool = False) -> bool:
    target = target_path(spec, settings)
    if target.is_file():
        print("  [skip] %s 已存在" % spec.key)
        return True
    if dry_run:
        print("  [plan] %s → %s（%.0f MB）" % (spec.key, target, spec.size_mb))
        return True

    is_zip = spec.url.lower().endswith(".zip")
    # 压缩包先落到另一个名字，避免与包内同名文件互相覆盖（见 _unzip 的说明）
    archive = target.with_name(target.name + ".download.zip") if is_zip else target

    for attempt in range(2):  # 大文件下载偶发截断，重试一次比让用户手动跑划算
        for url in [spec.url] + list(spec.mirrors):
            print("  [get ] %s ← %s%s" % (spec.key, url, "" if attempt == 0 else "（第 %d 次重试）" % (attempt + 1)))
            if not _download(url, archive):
                continue
            if is_zip:
                # 当场验一次：下载被截断时 zipfile 会在解压到一半才报 EOFError，
                # 那时用户已经等了几百 MB，不如在这里就判死并交给重试。
                if not zipfile.is_zipfile(str(archive)):
                    print("    文件不完整（不是合法的 zip），已丢弃")
                    archive.unlink(missing_ok=True)
                    continue
                _unzip(spec, archive, target.parent)
                archive.unlink(missing_ok=True)
                if not target.is_file():
                    print("    解包后仍未找到 %s，请检查包内结构" % target.name)
                    return False
            if target.is_file():
                print("    完成：%s" % target)
                return True
    return False


def main() -> int:
    parser = argparse.ArgumentParser(description="下载 RVC / DDSP-SVC 的预训练权重")
    parser.add_argument("--engine", choices=["rvc", "svc", "all"], default="all")
    parser.add_argument("--only", default="", help="只下载指定 key（逗号分隔）")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    settings = Settings.from_env()
    keys = {k.strip() for k in args.only.split(",") if k.strip()}

    selected: List[WeightSpec] = []
    for spec in WEIGHTS:
        if args.engine != "all" and spec.engine != args.engine:
            continue
        if keys and spec.key not in keys:
            continue
        selected.append(spec)

    print("整合包：%s" % settings.rvc_dir)
    print("权重根：%s\n" % settings.pretrained_dir)

    failed = []
    for spec in selected:
        if not fetch(spec, settings, args.dry_run):
            failed.append(spec.key)

    if failed:
        print("\n以下权重下载失败：%s" % ", ".join(failed))
        print("可手动下载后放到 weights.py 里标注的路径，或重试本脚本（支持断点续传）。")
        return 1
    print("\n全部就绪。可用 `python scripts/download_models.py --dry-run` 复核，"
          "或看服务 /health 里的 capabilities。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""网易模块权重下载器。

为什么要自己写而不用 `huggingface-cli download`：
1. 上游 `confuciustts/cli/inference.py` 里 T2S / S2A 权重是硬编码
   `hf_hub_download(repo_id, filename)` 取的，**只认 HF 缓存**；CAMPPlus 同理；
   w2v-bert-2.0 与 BigVGAN 走 `from_pretrained`，**可以指本地目录**。
2. 本机实测链路（2026-09）：直连 huggingface.co 约 0.2 MB/s 且会撞 Xet CDN 的 SSL 错误；
   `hf-mirror` 对上游钉住的 huggingface_hub 0.36.2 返回 **308**（HEAD 不跟随重定向）
   直接报 `LocalEntryNotFoundError`；ModelScope 约 6 MB/s；本机代理约 2 MB/s。
   所以本脚本用 `requests` 自己下：**ModelScope 优先，HF 经代理兜底**，
   需要进 HF 缓存的那几个文件再按缓存布局铺进去（blobs + snapshots + refs）。

    python scripts/download_netease_weights.py --list
    python scripts/download_netease_weights.py --proxy http://127.0.0.1:7890
    python scripts/download_netease_weights.py --include-r2t2
"""

from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NETEASE_MODELS = ROOT / "netease" / "models"
MODELSCOPE = "https://www.modelscope.cn/models"
HF = "https://huggingface.co"

#: (HF repo id, 文件名, 是否有 ModelScope 镜像)
#: —— 这三个必须进 HF 缓存（上游硬编码 hf_hub_download）
HF_CACHE_FILES: tuple[tuple[str, str, bool], ...] = (
    ("netease-youdao/Confucius4-TTS", "t2s_model.safetensors", True),
    ("netease-youdao/Confucius4-TTS", "s2a_model.pt", True),
    ("funasr/campplus", "campplus_cn_common.bin", False),
)
#: (HF repo id, 本地目录名, 文件名, 是否有 ModelScope 镜像)
LOCAL_DIR_FILES: tuple[tuple[str, str, str, bool], ...] = (
    ("facebook/w2v-bert-2.0", "w2v-bert-2.0", "config.json", True),
    ("facebook/w2v-bert-2.0", "w2v-bert-2.0", "preprocessor_config.json", True),
    ("facebook/w2v-bert-2.0", "w2v-bert-2.0", "model.safetensors", True),
    ("nvidia/bigvgan_v2_22khz_80band_256x", "bigvgan_v2_22khz_80band_256x", "config.json", False),
    ("nvidia/bigvgan_v2_22khz_80band_256x", "bigvgan_v2_22khz_80band_256x", "bigvgan_generator.pt", False),
)
#: R2T2：worker 用本地目录加载，Windows 无 vLLM 故默认不下
R2T2_FILES: tuple[tuple[str, str, str, bool], ...] = (
    ("netease-youdao/Confucius4-R2T2", "Confucius4-R2T2", "config.json", True),
    ("netease-youdao/Confucius4-R2T2", "Confucius4-R2T2", "generation_config.json", True),
    ("netease-youdao/Confucius4-R2T2", "Confucius4-R2T2", "model.safetensors", True),
    ("netease-youdao/Confucius4-R2T2", "Confucius4-R2T2", "tokenizer.json", True),
    ("netease-youdao/Confucius4-R2T2", "Confucius4-R2T2", "tokenizer_config.json", True),
    ("netease-youdao/Confucius4-R2T2", "Confucius4-R2T2", "vocab.json", True),
    ("netease-youdao/Confucius4-R2T2", "Confucius4-R2T2", "merges.txt", True),
    ("netease-youdao/Confucius4-R2T2", "Confucius4-R2T2", "preprocessor_config.json", True),
    ("netease-youdao/Confucius4-R2T2", "Confucius4-R2T2", "special_tokens_map.json", True),
    ("netease-youdao/Confucius4-R2T2", "Confucius4-R2T2", "added_tokens.json", True),
    ("netease-youdao/Confucius4-R2T2", "Confucius4-R2T2", "chat_template.json", True),
)


def hf_cache_root() -> Path:
    from huggingface_hub.constants import HF_HUB_CACHE

    return Path(HF_HUB_CACHE)


def fetch(url: str, target: Path, proxies: dict | None, timeout: float = 60.0) -> float:
    """流式下载，返回平均速度（MB/s）。已存在则跳过返回 -1。"""
    import requests

    if target.exists() and target.stat().st_size > 0:
        return -1.0
    target.parent.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    done = 0
    with requests.get(url, stream=True, timeout=timeout, proxies=proxies or {}) as response:
        response.raise_for_status()
        with open(target, "wb") as handle:
            for chunk in response.iter_content(1 << 20):
                if not chunk:
                    continue
                handle.write(chunk)
                done += len(chunk)
    return done / 1e6 / max(time.monotonic() - started, 0.1)


def head_ok(url: str, proxies: dict | None, timeout: float = 20.0) -> tuple[bool, str]:
    """HEAD 探测，返回 (可用, etag)。"""
    import requests

    try:
        response = requests.head(url, timeout=timeout, allow_redirects=True, proxies=proxies or {})
    except Exception:
        return False, ""
    if response.status_code != 200:
        return False, ""
    etag = (response.headers.get("x-linked-etag") or response.headers.get("etag") or "").strip('"')
    return True, etag


def commit_sha(repo_id: str, proxies: dict | None) -> str:
    import requests

    try:
        data = requests.get(f"{HF}/api/models/{repo_id}", timeout=20, proxies=proxies or {}).json()
        return str(data.get("sha") or "main")
    except Exception:
        return "main"


def seed_hf_cache(repo_id: str, filename: str, source: Path, proxies: dict | None) -> str:
    """把已下载的文件铺进 HF 缓存布局（blobs/<etag> + snapshots/<sha>/<name> + refs/main）。"""
    storage = hf_cache_root() / ("models--" + repo_id.replace("/", "--"))
    _ok, etag = head_ok(f"{HF}/{repo_id}/resolve/main/{filename}", proxies)
    if not etag:
        digest = hashlib.sha256()
        with open(source, "rb") as handle:
            for block in iter(lambda: handle.read(1 << 20), b""):
                digest.update(block)
        etag = digest.hexdigest()
    sha = commit_sha(repo_id, proxies)
    blob = storage / "blobs" / etag
    pointer = storage / "snapshots" / sha / filename
    blob.parent.mkdir(parents=True, exist_ok=True)
    pointer.parent.mkdir(parents=True, exist_ok=True)
    if not blob.exists():
        shutil.copyfile(source, blob)
    if not pointer.exists():
        shutil.copyfile(source, pointer)  # 本机未开开发者模式，用拷贝而不是符号链接
    (storage / "refs").mkdir(parents=True, exist_ok=True)
    (storage / "refs" / "main").write_text(sha, encoding="utf-8")
    return str(pointer)


def download_one(repo_id: str, filename: str, proxies: dict | None, staging: Path) -> Path:
    """ModelScope 优先，HF（经代理）兜底。返回落盘路径。"""
    target = staging / repo_id.replace("/", "--") / filename
    if target.exists() and target.stat().st_size > 0:
        return target
    ms_url = f"{MODELSCOPE}/{repo_id}/resolve/master/{filename}"
    hf_url = f"{HF}/{repo_id}/resolve/main/{filename}"
    if head_ok(ms_url, proxies=None)[0]:
        speed = fetch(ms_url, target, proxies=None)
        print(f"    ✓ {filename}（ModelScope，{speed:.1f} MB/s）")
        return target
    speed = fetch(hf_url, target, proxies)
    print(f"    ✓ {filename}（HuggingFace{'+代理' if proxies else ''}，{speed:.1f} MB/s）")
    return target


def main() -> int:
    parser = argparse.ArgumentParser(description="下载网易模块所需的模型权重")
    parser.add_argument("--proxy", default=os.environ.get("HTTPS_PROXY") or "", help="HuggingFace 走本机代理，例如 http://127.0.0.1:7890")
    parser.add_argument("--include-r2t2", action="store_true", help="同时下载 Confucius4-R2T2 权重（需要 vLLM 才能用）")
    parser.add_argument("--list", action="store_true", help="只列计划，不下载")
    args = parser.parse_args()

    proxies = {"https": args.proxy, "http": args.proxy} if args.proxy else None
    staging = NETEASE_MODELS / ".staging"
    try:
        from huggingface_hub.constants import HF_HUB_CACHE
    except Exception:
        print("[x] 请用 netease venv 的解释器运行本脚本（缺 huggingface_hub）。")
        return 1

    print(f"HF 缓存 = {HF_HUB_CACHE}")
    print(f"代理     = {args.proxy or '（不走）'}\n")

    if args.list:
        for repo_id, filename, _ in HF_CACHE_FILES:
            print(f"  → HF 缓存  {repo_id}/{filename}")
        for repo_id, dirname, filename, _ in LOCAL_DIR_FILES:
            print(f"  → 本地目录 netease/models/{dirname}/{filename}（来自 {repo_id}）")
        if args.include_r2t2:
            for repo_id, dirname, filename, _ in R2T2_FILES:
                print(f"  → 本地目录 netease/models/{dirname}/{filename}（来自 {repo_id}）")
        return 0

    # 1. 必须进 HF 缓存的三个文件
    for repo_id, filename, _ms in HF_CACHE_FILES:
        print(f"[HF 缓存] {repo_id}/{filename}")
        try:
            source = download_one(repo_id, filename, proxies, staging)
            pointer = seed_hf_cache(repo_id, filename, source, proxies)
            print(f"    ✓ 已铺进缓存 {pointer}\n")
        except Exception as error:
            print(f"    [x] 失败：{type(error).__name__}: {str(error)[:200]}")
            print("        可加 --proxy http://127.0.0.1:7890 重试。")
            return 1

    # 2. 本地目录权重
    plan = list(LOCAL_DIR_FILES) + (list(R2T2_FILES) if args.include_r2t2 else [])
    for repo_id, dirname, filename, _ms in plan:
        dest = NETEASE_MODELS / dirname / filename
        print(f"[本地目录] {repo_id}/{filename} → netease/models/{dirname}")
        try:
            source = download_one(repo_id, filename, proxies, staging)
            dest.parent.mkdir(parents=True, exist_ok=True)
            if not dest.exists():
                shutil.move(str(source), str(dest))
            print(f"    ✓ {dest.stat().st_size / 1e6:.0f} MB\n")
        except Exception as error:
            print(f"    [x] 失败：{type(error).__name__}: {str(error)[:200]}")
            return 1

    print("全部就绪。下一步：npm run netease:check")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

# -*- coding: utf-8 -*-
"""回归锁：R2T2 离线转写（transformers 后端，阶段 41）。

静态段（默认，任意 python 可跑，AST + 源码断言）：
P1  worker 有 transformers 加载分支（from_pretrained + max_inference_batch_size=1）
P2  bf16 优先、卡不支持退 fp16
P3  加载后静音预热（算子首跑摊在 ready 之前），且预热失败不阻塞
P4  transformers 后端外层 240 s 分段（上游 MAX_ASR_INPUT_SECONDS=1200 是大显存口径）
P5  transformers 后端 + 时间戳 → 干净报错（不裸抛 upstream ValueError）
P6  load 命令回带 id 的 result（旧代码只发无 id 的 ready，warmup 会挂满 1800 s）
P7  config 默认后端 transformers（dataclass 字段 + env 兜底两处）
P8  manager.probe_install 报 backend + 解释器存在性检查
P9  launcher 自动探测 netease/r2t2-venv 并注入 NETEASE_R2T2_PYTHON（尊重显式设置）
P10 preflight 按 backend 分口径，用子进程探 R2T2 解释器

运行时段（--runtime，装好 r2t2-venv 后）：
R1  r2t2-venv 里 torch CUDA 可用
R2  qwen_asr + r2t2 可导入
R3  R2T2 权重目录文件齐（resolved_r2t2_model 默认路径）
R4  worker 协议冒烟：spawn → ping → pong（不加载模型，不占显存）
"""

import ast
import io
import os
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
passed = 0
failed = []


def check(name, cond, detail=""):
    global passed
    if cond:
        passed += 1
        print("PASS", name)
    else:
        failed.append(name)
        print("FAIL", name, detail)


def read(path):
    with io.open(os.path.join(ROOT, path), encoding="utf-8") as h:
        return h.read()


def source_of(path, fn_name):
    tree = ast.parse(read(path))
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name == fn_name:
            return ast.get_source_segment(read(path), node) or ""
    return ""


# ---- P1~P5：worker ----
w = "netease/app/r2t2_worker.py"
load_src = source_of(w, "_load_transformers")
check("P1a transformers 分支走 from_pretrained", "from_pretrained" in load_src)
check("P1b batch 固定 1（8GB 卡口径）", "max_inference_batch_size=1" in load_src)
check("P2a bf16 优先", 'dtype = "bfloat16"' in load_src)
check("P2b 不支持则退 fp16", "is_bf16_supported" in load_src and 'dtype = "float16"' in load_src)
check("P3a 静音预热", "np.zeros" in load_src and "asr.transcribe" in load_src)
check("P3b 预热失败不阻塞", "except Exception as error" in load_src and "不阻塞" in load_src)
transcribe_src = source_of(w, "transcribe")
check("P4a 240s 分段入口", "TRANSFORMERS_SEGMENT_SEC" in transcribe_src and "_transcribe_segmented" in transcribe_src)
check("P4b 分段常量=240", "TRANSFORMERS_SEGMENT_SEC = 240.0" in read(w))
check("P4c 分段拼接语义与上游一致", '"".join(texts)' in source_of(w, "_transcribe_segmented"))
check("P5 transformers+时间戳干净报错", "transformers 后端暂不支持时间戳" in transcribe_src)
main_src = source_of(w, "main")
check("P6 load 回带 id 的 result", '{"type": "result", "id": request_id, "loaded": True}' in read(w))
check("P6b worker 默认 backend=transformers", 'default="transformers"' in main_src)

# ---- P7：config ----
c = read("netease/app/config.py")
check("P7a dataclass 默认 transformers", 'r2t2_backend: str = "transformers"' in c)
check("P7b env 默认 transformers", '_env("NETEASE_R2T2_BACKEND", "transformers") or "transformers"' in c)

# ---- P8：manager ----
m = read("netease/app/r2t2.py")
check("P8a probe_install 报 backend", '"backend": self._settings.r2t2_backend' in m)
check("P8b 解释器存在性检查", "R2T2 解释器不存在" in m)
check("P8c spawn 报错文案覆盖两种后端", "netease/r2t2-venv" in m)

# ---- P9：launcher ----
l = read("scripts/netease.mjs")
check("P9a 自动探测 r2t2-venv", "r2t2-venv" in l and "resolveR2t2Env" in l)
check("P9b 尊重显式 NETEASE_R2T2_PYTHON", "NETEASE_R2T2_PYTHON?.trim()" in l)

# ---- P10：preflight ----
p = read("scripts/preflight_netease.py")
check("P10a 按 backend 分口径", "settings.r2t2_backend" in p and "probe_r2t2_interpreter" in p)
check("P10b 子进程探真实导入性", "-c" in p and "qwen_asr" in p)

# ---- 运行时段 ----
if "--runtime" in sys.argv:
    venv_py = os.path.join(ROOT, "netease", "r2t2-venv", "Scripts", "python.exe")
    if not os.path.exists(venv_py):
        check("R0 r2t2-venv 存在", False, venv_py)
    else:
        import subprocess

        def run(code, timeout=120):
            return subprocess.run([venv_py, "-c", code], capture_output=True, text=True, timeout=timeout)

        proc = run("import torch; print(torch.__version__, torch.cuda.is_available())")
        check("R1 torch CUDA", proc.returncode == 0 and "True" in proc.stdout, proc.stderr[-200:])
        proc = run("import qwen_asr, r2t2; print('imports ok')")
        check("R2 qwen_asr+r2t2 可导入", proc.returncode == 0, (proc.stderr or "").strip().splitlines()[-1][:200] if proc.returncode else proc.stdout)
        model_dir = os.path.join(ROOT, "netease", "models", "Confucius4-R2T2")
        needed = ["config.json", "model.safetensors", "tokenizer.json", "preprocessor_config.json", "chat_template.json"]
        missing = [f for f in needed if not os.path.exists(os.path.join(model_dir, f))]
        check("R3 权重文件齐", not missing, f"缺 {missing}" if missing else model_dir)
        # R4：协议冒烟（不 load，不占显存）
        worker = os.path.join(ROOT, "netease", "app", "r2t2_worker.py")
        import json
        import subprocess

        proc = subprocess.Popen(
            [venv_py, worker, "--model", model_dir, "--backend", "transformers"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, encoding="utf-8",
        )
        try:
            proc.stdin.write(json.dumps({"type": "ping", "id": "smoke1"}) + "\n")
            proc.stdin.flush()
            line = proc.stdout.readline()
            msg = json.loads(line) if line.strip() else {}
            check("R4 ping→pong 协议", msg.get("type") == "pong" and msg.get("id") == "smoke1", line[:120])
        finally:
            try:
                proc.stdin.write(json.dumps({"type": "shutdown", "id": "bye"}) + "\n")
                proc.stdin.flush()
                proc.wait(timeout=10)
            except Exception:
                proc.kill()

        # R5：load 期导入路径检查（10.24 实测坑：worker 按路径启动时脚本目录 netease/app/
        # 以 sys.path[0] 遮蔽 site-packages 的 r2t2 包 → `from r2t2 import ...` import 到自家
        # manager，报 relative ImportError。只有真 load 才会踩：探活与 ping 冒烟覆盖不到）。
        # 用坏模型路径触发真 load：导入若已修好，错误应是「模型/权重」语义而非 ImportError。
        proc = subprocess.Popen(
            [venv_py, worker, "--model", os.path.join(ROOT, "netease", "models", "__no_such_model__"),
             "--backend", "transformers"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, encoding="utf-8",
        )
        try:
            proc.stdin.write(json.dumps({"type": "load", "id": "r5"}) + "\n")
            proc.stdin.flush()
            # load 会先 emit log（「加载 R2T2 模型…」），要读到第一条 error/result 为止
            msg, deadline = {}, time.monotonic() + 120
            while time.monotonic() < deadline:
                line = proc.stdout.readline()
                if not line.strip():
                    break
                msg = json.loads(line)
                if msg.get("type") in {"error", "result"}:
                    break
            text_out = str(msg.get("message", ""))
            check("R5 load 导入路径无遮蔽（错误非 relative import）",
                  msg.get("type") == "error" and "relative import" not in text_out and "attempted relative" not in text_out,
                  text_out[:160])
        finally:
            try:
                proc.stdin.write(json.dumps({"type": "shutdown", "id": "bye"}) + "\n")
                proc.stdin.flush()
                proc.wait(timeout=10)
            except Exception:
                proc.kill()

print()
if failed:
    print("FAILED:", len(failed), failed)
    sys.exit(1)
print("ALL %d CHECKS PASSED" % passed)

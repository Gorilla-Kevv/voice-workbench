"""网易模块本地服务（Confucius4-TTS + Confucius4-R2T2）。

这是项目的**第二个 Python 运行时**：与 `trainer/`（py3.9 + torch 2.0/cu118）平级，
但要求 Python ≥ 3.10、torch ≥ 2.5、CUDA ≥ 12.6 —— 由上游模型决定，无法合并。

接入面刻意收窄：真正触碰上游 API 的只有两个薄文件，
- `app/tts_engine.py`   （import confuciustts）
- `app/r2t2_worker.py`  （import r2t2，跑在独立子进程里）

上游一旦升级漂移，只改这两处。
"""

__version__ = "0.1.0"

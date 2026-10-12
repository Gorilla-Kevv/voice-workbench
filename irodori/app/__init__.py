"""Irodori-TTS 本地服务（日语特化：零样本克隆 + Speaker Inversion 音色固化）。

与 `netease/`、`indextts/` 同一套形态：独立 venv + 独立进程 + FastAPI，
由网关的 RuntimeSupervisor 托管生命周期，前端经 `/api/irodori/*` 透传访问。
"""

__version__ = "0.1.0"

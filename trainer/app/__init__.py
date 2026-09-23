"""GPT-SoVITS 本地服务（trainer）。

分层约定：

    app/sovits/   与官方仓库的直连层：定位安装、加载推理管线、音色库、请求翻译
    app/training  训练流水线编排：对齐官方 WebUI 的六段式流程
    app/api.py    HTTP 契约层
    app/jobs.py   任务持久化
    app/queue.py  并发/配额调度

所有模块均兼容 Python 3.9（整合包自带解释器为 3.9），
因此禁止在会被运行时求值的位置使用 PEP 604 联合类型（`str | None`）——
Pydantic 模型会即时求值注解，在 3.9 上会直接抛 TypeError。
"""

__all__ = ["__version__"]

__version__ = "2.0.0"

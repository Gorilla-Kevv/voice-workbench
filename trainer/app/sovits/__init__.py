"""与 GPT-SoVITS 官方仓库的直连层。

这一层是本次重构的核心：服务不再通过子进程反复调用官方 CLI
（每次都要重新加载 4 个模型，单次冷启动 1 分钟以上），
而是直接 import 官方 `GPT_SoVITS.TTS_infer_pack.TTS`，
把模型常驻在内存里，并复用官方提供的权重热切换接口。

对外只暴露四个模块：

    bootstrap  安装定位、sys.path 注入、官方模块加载
    catalog    官方能力清单（语言/切分方式/版本/权重目录/预训练权重）
    pipeline   管线单例：设备、精度、权重、合成与流式
    voices     音色库：参考音频 + 提示文本的命名与持久化
    synth      统一请求 → 官方 inputs 的翻译
"""

__all__ = ["bootstrap", "catalog", "pipeline", "synth", "voices"]

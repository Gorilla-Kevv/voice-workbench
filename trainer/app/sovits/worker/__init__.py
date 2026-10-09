"""GPT-SoVITS 推理 worker 子进程。

存在的唯一理由：**把官方代码的 import 期副作用关在进程里**。

官方 `GPT_SoVITS/AR/modules/activation.py` 在 import 期执行：

    F.multi_head_attention_forward = multi_head_attention_forward_patched

`torch.nn.functional` 是模块级单例，这一句影响**整个进程**。而补丁版函数
被复制进来时 `__globals__` 里缺 `_in_projection`，于是 RVC 的 fairseq
`MultiheadAttention`（走 `use_separate_proj_weight=True` 分支）一调就
`NameError`。另外 `bootstrap.install()` 还会 `os.chdir(home)` 且**不恢复**。

这两条都是「进程级、不可恢复」的副作用 —— 唯一的根治办法是让它们
只发生在一个可以被随时丢弃的进程里。本包就是那个进程。

分层：

    protocol    消息信封编解码 + fd1 重定向（官方 print 的隔离）
    server      worker 侧：请求循环、interrupt 读线程、持有官方管线
    client      主进程侧：拉起 / 心跳 / 重启 / 关停 / 请求-响应配对
"""

__all__ = ["protocol", "server", "client"]

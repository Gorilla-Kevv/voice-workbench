"""路由分包。

本服务的路由主体仍在 `app/api.py`（一条路由一个函数，平铺装配），只有训练这块
因为端点多、且带后台工作线程，单独拆出来。`train.register(app, settings, store)`
由 `create_app` 调用 —— 不放模块级，避免 import 期就需要 settings。
"""

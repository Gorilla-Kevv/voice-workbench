# 架构与关键设计取舍

本文说明三层结构「为什么长这样」，以及几个看起来反常但必要的决定。

---

## 一、三层结构

```
浏览器 ──▶ Node 网关（:8787） ──▶ ┬─▶ MiMo 云端 API
                                  └─▶ GPT-SoVITS 本地服务（:9881） ──▶ 官方整合包
```

| 层 | 技术 | 职责 | 不做什么 |
| --- | --- | --- | --- |
| 前端 `app/` | React 19 + TS + Vite | 界面、音色库管理、结果回放与导出 | 不直接碰模型；不做音频编解码的重活 |
| 网关 `server/` | Node 18 + Express 4 | MiMo 封装、本地服务探活与反向代理、静态托管 | 不持有 Python 进程；不解析 GPT-SoVITS 的请求体 |
| 本地服务 `trainer/` | Python 3.9+ + FastAPI | 官方管线的常驻封装、音色库、批量合成、训练流水线 | 不重复实现官方算法，全部调用官方代码 |

---

## 二、为什么需要 Node 网关这一层

有人会问：本地工具直接把浏览器指向 Python 服务不就完了，为什么要多一层？

1. **同源**。前端只认一个地址，不需要第二套 CORS 配置，也不会出现
   「服务地址填错」这类最常见的求助。
2. **可观测**。Python 服务没起来时，浏览器只会看到
   `ERR_CONNECTION_REFUSED`；网关知道它为什么没起来（解释器找不到、torch 缺失、
   整合包不存在），并把这些信息变成一条带修复建议的错误。
3. **接入而非拥有**。`npm run dev` 并行启动三个进程（模型服务、网关、前端），
   但 Python 服务的生命周期归**启动编排器**（concurrently），不归网关 ——
   网关只负责探活与转发，外加「等它就绪」这一个异步动作。
4. **MiMo 仍需要一个服务端**（隐藏密钥、站点级限流）。既然它已经存在，
   复用它作为统一入口的成本低于再开一个端口。

### 为什么 Python 服务不归网关托管

最初的设计是「网关负责拉起 → 等就绪 → 关闭时回收」，一条命令跑通全链路，
看起来更内聚。但实测暴露了一个问题：

开发时网关由 `tsx watch` 托管，改一行后端代码就会重启一次网关；
而网关在退出时会回收自己拉起的 Python 服务 —— 于是**改一行代码要等 40 秒
重新加载模型**。这不是理论推演，是日志里能直接看到的：`[tsx] change in
./src/index.ts Restarting...` 之后紧跟一条「正在启动 GPT-SoVITS 本地服务」。

把 Python 交给 concurrently 之后：

| 场景 | 托管在网关 | 托管在编排器 |
| --- | --- | --- |
| 改后端代码触发网关重启 | Python 被回收后重新冷启动（20~40s） | **PID 不变**，服务持续可用 |
| Ctrl+C 停止 | 网关退出时回收 | concurrently 回收整组 |
| 单独跑 `npm run dev:server` | 网关自己拉起 | 需把 `SOVITS_AUTOSTART` 设为 true |

为了覆盖「两个任务同时启动、Python 慢几十秒」的竞态，网关在
`autostart=false` 时不会「探不到就放弃」，而是**等它就绪**再接管，
否则会出现「界面已就绪、但本地功能一直显示不可用」的假故障。

代理实现刻意用 `node:http` + `pipe`，而不是 `fetch`：
原始字节流（音频上传的 multipart、流式合成的 NDJSON）在 `pipe` 下不需要任何特殊处理，
而且天然无缓冲。

**挂载顺序很关键**：`/api/sovits` 必须挂在 `express.json()` **之前**。
一旦请求体被 body-parser 消费，multipart 与流式响应就透传不出去了。

---

## 三、为什么 Python 服务要「自举解释器」

torch 装在 GPT-SoVITS 整合包自带的 `runtime/` 里，而用户很可能是用系统 Python
敲的 `python server.py`。如果直接 `import torch`，得到的是一个
`ModuleNotFoundError` —— 这个错误对使用者毫无指导意义。

所以 `trainer/server.py` 在启动时做三件事：

1. 定位整合包（显式 `GPT_SOVITS_HOME` → 项目同级目录 → 常见位置浅层搜索）；
2. 判断当前解释器能否 `import torch`；
3. 不能，就用整合包自带的解释器 `os.execve` **重新执行自己**（带
   `TTS_SELF_BOOTSTRAPPED=1` 守卫，只重入一次）。

这样「一条命令跑起来」才成立，而不是要求用户先搞清楚该用哪个 Python。

`scripts/start.ps1` / `start.sh` 做的是同一件事的显式版本，
额外负责在必要时把 `fastapi` 等依赖装进那个解释器。

---

## 四、为什么 Python 服务直接 import 官方管线

官方仓库不是可 import 的库，而是一个「必须站在自己根目录下运行」的项目：
`TTS.py` 里 `now_dir = os.getcwd()` 并用它拼声码器路径，`sv.py` 在 import 期
就往 `sys.path` 里塞 `GPT_SoVITS/eres2net`。所以定位完成后必须：

- `sys.path` 同时加入**根目录**（`tools` 在这里）与 **`GPT_SoVITS/`**
  （`AR`、`text`、`sv`、`module` 在这里），且后者要排在更前面；
- `os.chdir(根目录)`。

旧的实现走的是「每次合成都 `subprocess` 调 `inference_cli.py`」，
等价于每次都要重新加载 4 个模型（约 1 分钟）。现在改为常驻管线：

| 场景 | 旧实现 | 现在 |
| --- | --- | --- |
| 首次合成 | ~70s | ~30~90s（一次性，可后台预加载） |
| 后续单条合成 | ~70s | 推理本身耗时（本机 4060 约 1~10s） |
| 切换权重 | 重启进程 | `init_t2s_weights` / `init_vits_weights` 热切换 |
| 切换设备/精度 | 重启进程 | `set_device` / `enable_half_precision` |

并发模型是**单卡串行**：所有推理走同一把锁。本地工具的正确性优先于吞吐，
两个请求同时抢显存只会一起 OOM。但「等待」有明确上限：

- 同步合等等 300 秒，超时返回「有另一个任务正在占用显卡」；
- 流式合成只等 5 秒 —— 流式的价值就是「马上听到」，
  排不上队就该立刻告诉用户，而不是让他等 5 分钟再听到第一声。

---

## 五、任务系统

只有两类任务是异步的，都走同一套任务系统（`jobs.py` + `queue.py`）：

- `infer`：批量合成。逐条串行、可取消、逐条失败可继续；
- `train`：训练流水线。长任务，带阶段进度与完整日志。

任务元数据落盘到 `trainer/.data/jobs/`，因此服务重启后历史任务仍可查 ——
这对训练尤其重要：跑了三小时的任务，不该因为重启就查不到日志了。

一个值得记下来的坑：`asyncio.Queue` 在 **Python 3.9 上于构造时绑定事件循环**。
调度器是在服务启动前（还没有 loop 时）装配的，如果那时就建好队列，
它会挂在一个永远不会运行的 loop 上，表现为「任务入队后状态永远是 `queued`」。
因此队列被延迟到 `Scheduler.start()`（在应用 lifespan 内）才创建。

---

## 六、前端的两条链路如何共存

前端有一个 Provider 抽象层（`app/src/lib/providers/`）：

```ts
interface TtsProvider {
  id: string; name: string; summary: string;
  languages: string[]; models: TtsModel[];
  capabilities: { preset: boolean; design: boolean; clone: boolean };
  synthesize(params, context): Promise<SynthesizeResponse>;
}
```

MiMo 与 GPT-SoVITS 都实现它，于是「切换模型」对上层页面是透明的。
但**能力差异必须在界面上体现**，否则用户会以为标签对本地模型也生效：

- 合成页在 Provider 为 GPT-SoVITS 时，把「预置音色 / 风格标签 / 音频标签 / 唱歌模式
  / 语气指令」整块换成本地音色选择器与切分方式 —— 因为这些提示词能力是 MiMo 独有的，
  对 GPT-SoVITS 只会被当成正文读出来；
- 音色设计页保持 MiMo 专属；若用户在本地模型下打开它，服务端会返回
  「GPT-SoVITS 不支持用文字描述生成音色」并给出替代路径。

音色库是 GPT-SoVITS 侧的核心概念：**它没有任何内置音色**，
一次克隆需要「3~10 秒参考音频 + 逐字转写」。把这两者绑定成可命名的实体并常驻本机，
是把模型变成工具的关键一步 —— 否则每次合成都得重新上传一遍。

---

## 七、观测与排障

三层都贯彻同一条原则：**失败时回答三个问题 —— 哪里坏了、该做什么、能不能重试**。

- Python 侧：`SovitsError` 携带 `hint`，`/health` 返回 `blockers` 与 `hints`
  （每一条都对应一个可执行的下一步）；
- 网关侧：`/api/health` 汇总 GPT-SoVITS 的 `reachable / installed / lastError`；
  若 Python 由网关自己拉起（`SOVITS_AUTOSTART=true`），还会把它最后 240 行输出
  留在内存里，供 `/api/sovits/*` 的 503 响应直接带回。
- 前端：错误统一渲染 `message` + `hint`，`retryable` 决定是否显示重试入口。

启动日志按进程分层，这也是刻意的：

| 前缀 | 内容 | 密度 |
| --- | --- | --- |
| `[sovits]` | 模型服务的原始输出：体检报告、模型加载进度 | 首次启动约 40 行 |
| `[server]` | 网关的叙事：就绪摘要、阻断项、新手引导 | 约 7 行 |
| `[app]` | Vite | 3 行 |

网关曾经把 Python 的每一行都转发成自己的 `debug` 日志，一次正常启动能刷满两屏，
真正要看的信息（服务是否就绪、有没有报错）反而找不到。现在逐行转发默认关闭、
只透出形如错误的行，完整输出用 `VERBOSE_LOG=true` 打开；而 Python 作为独立任务
运行时，它的输出本来就会带着 `[sovits]` 前缀直接出现在终端里 ——
需要时看得到，不需要时一眼扫过。

`npm run sovits:check` / `python server.py --check` 是一次性的体检入口，
退出码 0/1 可以直接用于脚本串联。

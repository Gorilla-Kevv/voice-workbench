# SAY CLI：给 Agent / 终端用的合成入口

> `scripts/say.mjs` 是**薄包装**，不引入新后端逻辑：
> - 单条 → 网关 Open API `POST /api/open/v1/audio/speech`
> - 批量 → trainer 透传 `POST /api/sovits/v1/tts/batch` + `GET /api/sovits/v1/jobs/:id`
>
> stdout 永远只有一段 JSON，进度/提示走 stderr，方便 Agent 直接解析。
> 契约细节见 `docs/OPEN-API.md`；面向外部 Agent 的总览（启动/显存/红线）见 `docs/AGENT-GUIDE.md`。

## 前置

- 网关在跑：`npm run dev:server`（或 `npm run dev`），默认 `http://127.0.0.1:8787`
- 对应运行时已启动且显存够用（CLI **不会**替你拉起模型服务）
- 显存互斥：单条请求可带 `--focus` 让网关先仲裁卸载其它引擎；批量需自己确认空闲显存

## 单条合成

```bash
# 推荐：直接调脚本（stdout 干净）
node scripts/say.mjs \
  --model gpt-sovits-v2proplus \
  --voice <音色库id> \
  --text "你好，世界。" \
  --out out.wav

# 用 npm 脚本时必须加 --silent，否则 npm 的 banner 会混进 stdout
npm run --silent say -- --model confucius4-tts --voice <id> --text "你好" --out out.wav
```

常用参数：

| 参数 | 说明 |
| --- | --- |
| `--model` | 能力 id（必填）：`gpt-sovits-v2proplus` / `confucius4-tts` / `indextts-2.5` / `irodori-tts` / `gpt-sovits-v5` / `mimo`，全集见 `/api/capabilities` |
| `--text` / `--text-file` | 合成文本；传 `-` 从 stdin 读取 |
| `--voice` / `--ref-path` | 音色库 id，或服务端绝对路径（二选一；裸路径还需 `--prompt-text`/`--prompt-lang`） |
| `--params '<json>'` | 引擎专属参数白名单透传（如 `{"version":"v2ProPlus"}`） |
| `--version` / `--gpt` / `--sovits` | GPT-SoVITS 权重快捷参数（等价于写进 `--params`） |
| `--lang` / `--text-lang` | 快捷语种 |
| `--out` | 输出文件；默认 `./say-<时间戳>.wav` |
| `--focus` | 先让网关仲裁卸载其它引擎再合成（单条专用） |
| `--timeout` | 请求超时（秒），默认 900 |

成功输出：

```json
{
  "ok": true,
  "model": "gpt-sovits-v2proplus",
  "out": "F:\\...\\out.wav",
  "bytes": 123456,
  "sample_rate": 32000,
  "duration_sec": 2.31,
  "elapsed_sec": 1.84
}
```

> MiMo 长文本自动分段时，其余段会写成 `<out>.part2.wav`、`<out>.part3.wav`，并在 `extra_files` 里列出。

## 批量合成（GPT-SoVITS）

```bash
# 先展开核对条数（不合成）
node scripts/say.mjs batch --plan --voice <id> --file lines.txt

# 异步提交 + 自动轮询 + 下载音频
node scripts/say.mjs batch \
  --voice <id> \
  --file lines.txt \
  --out-dir out/batch1 \
  --zip
```

输入三种方式（互斥）：

- `--text "第一行\n第二行"`：按非空行切分（bash 可用 `$'第一行\n第二行'`）
- `--file lines.txt` / `--text-file lines.txt`：同上，`-` 读 stdin
- `--items items.json`：需要逐条 key / 逐条参数时用，数组元素形如
  `{"text": "...", "key": "line-001", "params": {...}}`

常用参数：

| 参数 | 说明 |
| --- | --- |
| `--voice` / `--ref-path` + `--prompt-text`/`--prompt-lang` | 参考音色 |
| `--text-lang` / `--version` / `--gpt` / `--sovits` | 与 UI 批量页同义 |
| `--filename-template` | 默认 `{index:03d}-{key}` |
| `--no-zip` | 服务端不生成 ZIP |
| `--stop-on-error` | 单条失败即停止（默认继续） |
| `--sync` | 同步等待（默认异步 + 轮询） |
| `--out-dir` | 下载目录；默认 `./say-out/<job_id>`（同时保存 `manifest.json`） |
| `--no-download` | 只打印 JSON 清单，不下载音频/清单 |
| `--zip` | 额外下载服务端 ZIP（`<out-dir>/batch.zip`） |
| `--allow-failures` | 有条目失败时仍返回 0（默认返回 1） |
| `--poll-ms` / `--timeout` | 轮询间隔（默认 1200ms）/ 整批超时（默认 3600s） |

输出示例：

```json
{
  "ok": true,
  "job_id": "1a2b3c4d5e6f",
  "state": "succeeded",
  "total": 12,
  "succeeded": 12,
  "failed": 0,
  "out_dir": "F:\\...\\say-out\\1a2b3c4d5e6f",
  "files": [{ "index": 0, "filename": "000-line.wav", "path": "...", "bytes": 123456, "duration_s": 2.3 }],
  "manifest_path": "F:\\...\\say-out\\1a2b3c4d5e6f\\manifest.json",
  "failures": []
}
```

失败条目会进 `failures`（含 `error`/`hint`）；只要有任何失败且未加 `--allow-failures`，退出码为 1。

## 错误与退出码

- 所有失败都输出 `{ "ok": false, "error": { code, status, message, hint } }` 到 stdout
- 退出码：`0` 成功；`1` 请求/任务失败，或批量存在失败条目（`--allow-failures` 可覆盖后者）
- 网关没起：`GATEWAY_UNREACHABLE`，提示 `npm run dev:server`
- 运行时没起：上游 `OPEN_RUNTIME_UNREACHABLE` / `VRAM_INSUFFICIENT` / `WEIGHTS_MISSING` 原样透传

## 注意

- Git Bash 的 `curl` 会把 UTF-8 中文转 GBK（HANDOFF 坑 54）；本 CLI 用 Node `fetch`，不受影响。
- 批量任务会真实占用 GPU；Agent 调用前先看 `/api/capabilities` 的 `available`/`vram_free_mb`。
- 本 CLI 不负责启动/关闭服务，也不会自动下载权重。

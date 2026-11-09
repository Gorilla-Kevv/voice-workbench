# OPEN API：对外能力网关（阶段 43）

> 面向「别的任务 / Agent」的模型能力调用入口。**纯加法**：工作台 14 个页面继续走
> `/api/sovits|netease|indextts|irodori|gsv5|voicelib|models` 各自的透传，本层不改它们任何行为。
> 终端 / Agent 的现成封装见 `docs/CLI.md`（`node scripts/say.mjs`，单条 + 批量）；
> 面向外部 Agent 的总览（含启动/显存/红线）见 `docs/AGENT-GUIDE.md`。
>
> - 地址：`http://127.0.0.1:8787`（网关默认只听回环，无鉴权——与全站「纯本地部署」一致）
> - 风格：OpenAI 兼容路径 + 本仓错误契约
> - 能力发现：`GET /api/capabilities`（全量描述）与 `GET /api/open/v1/models`（OpenAI 形状清单）

## 能力清单（14 项）

| kind | id | 运行时 | 一句话 |
| --- | --- | --- | --- |
| tts | `gpt-sovits-v2proplus` | sovits :9881 | 零样本/自训权重，`params.version/gpt/sovits` 选权重 |
| tts | `confucius4-tts` | netease :9882 | 14 语种免转写克隆，`quality` 三档 |
| tts | `indextts-2.5` | indextts :9883 | 8 维情感向量 / 语速 |
| tts | `irodori-tts` | irodori :9884 | 仅日语 + emoji 情感 + 固化音色 |
| tts | `gpt-sovits-v5` | gsv5 :9885 | v5turbo（快）/ v5dev（高质） |
| tts | `cosyvoice3-tts` | cosyvoice :9886 | 9 语言 + 18 中文方言；`mode` ∈ zero_shot / cross_lingual / instruct2，24kHz |
| tts | `mimo` | 云端 | 需服务端密钥；不占显存 |
| asr | `paraformer-zh` | sovits | 中文逐字+标点首选 |
| asr | `sensevoice-small` | sovits | 中英日韩粤；无 size 概念、不挂 VAD（耳语友好）、逐字（不 ITN）；本地权重 + 独立 worker（`trainer/sensevoice-venv`，可 `SENSEVOICE_PYTHON` 覆盖）；`available` 需 weights_ready+runtime_ready（1536MB） |
| asr | `faster-whisper` | sovits | `params.size` ∈ medium/large-v3/large-v3-turbo |
| asr | `r2t2-offline` | netease | Qwen3-ASR 基座离线转写，长音频自动 240s 分段 |
| vc | `rvc-convert` | sovits | RVC 变声，`params.model` = 引擎 key |
| svc | `ddsp-svc-convert` | sovits | 歌声转换，`params.model` = .pt 绝对路径 |
| separation | `uvr5-separate` | sovits | 人声/伴奏分离 |

别名（如 `netease-tts`、`gsv5`、`rvc`）与 id 等价，大小写不敏感；全集见 capabilities 响应。

## 端点

### GET /api/capabilities

能力发现。每项：`id/label/kind/runtime/aliases/reference{voice_id_param,path_param}/audio_input_param/fixed_params/extra_params/endpoint/available/weights_ready/weights_source/runtime_ready/loaded/vram_required_mb/vram_source/hint`，外加全局面 `vram_free_mb`（nvidia-smi 口径，来自活着的运行时）。

`available` 的语义（阶段 44补2 起）：
- 无固定模型的能力 = 运行时可达；
- 固定了模型的 ASR 能力（`paraformer-zh` / `sensevoice-small`）= 运行时可达 **且** 服务端 `weights_ready=true` **且** `runtime_ready !== false`。权重/专用运行时缺失或状态未知一律 false，避免“看起来可用、调用才发现缺依赖”；
- `weights_ready`：`true/false/null`（null = 无固定模型或服务端未提供状态）；`weights_source`：`local/modelscope/missing/remote`；
- `runtime_ready`：SenseVoice 专用 FunASR venv 是否就绪（null = 无专用运行时要求）。

`loaded`=引擎当前是否常驻（取不到为 null）；**显存门槛数值一律转发自各服务端字段**（`vram_source` 标明出处），网关不硬编码。固定模型的 ASR 门槛来自 trainer `GET /v1/asr/readiness → resident_model_status[<model>].vram_required_mb`（Paraformer 2048 / SenseVoice 1536）；faster-whisper 无固定模型，`vram_required_mb` 是 `asr` 引擎的静态兜底，实际值随 `size/precision` 变，调用前用 `/v1/asr/plan`。

### GET /api/open/v1/models

OpenAI 形状：`{object:'list', data:[{id, object:'model', owned_by, kind, label, available}]}`。

### POST /api/open/v1/audio/speech（TTS 合成）

```jsonc
{
  "model": "confucius4-tts",          // 能力 id 或别名（必填）
  "text": "要合成的文本",              // 必填
  "voice_id": "abc123",               // 音色库 id；或
  "ref_path": "F:\\audio\\ref.wav",   // 服务端绝对路径（二选一；mimo 的 preset 模式可都不传）
  "lang": "zh",                       // 快捷语种；引擎专属字段用 params
  "format": "wav",                    // 默认 wav（裸字节 audio/wav）；'json' 返回 base64
  "focus": false,                     // true = 先跑资源仲裁器让位（默认不动其它引擎）
  "timeout_ms": 900000,               // 10s ~ 1800s，默认 900s
  "params": { "quality": "balanced" } // 按能力项的 extra_params 白名单透传
}
```

- 成功（默认）：`200 audio/wav` 裸字节，头 `X-Open-Capability`/`X-Open-Sample-Rate`。
- `format:"json"`：`{ok, model, runtime, audio_base64, content_type, sample_rate, duration_sec, elapsed_sec, ...引擎回显字段}`。
- **mimo**：`params.mode ∈ preset|design|clone`；`preset` 用 `params.voice`=预置音色 id；`clone` 传 data URI 样本；`design` 给 `params.instruction` 风格描述。长文本自动分段时 `format:"json"` 的 `extra_segments_base64` 携带其余段（wav 不能直接拼接）。

### POST /api/open/v1/audio/transcriptions（ASR）

`{model, audio_path | voice_id, language?, return_timestamps?, timeout_ms?, params?}` → `{ok, text, language, elapsed_sec, segments, timestamps, warning}`。`backend/size/precision/model` 由能力项固定（可被 `params` 覆盖）；显存准入按「模型×尺寸×精度」参数化（阶段 42）。

### POST /api/open/v1/audio/convert · /singing-convert · /separate

`{model, audio_path | voice_id, params?, format?: 'meta'|'audio', timeout_ms?}` → 默认 `meta`：`{ok, output_file, result:{...上游产物与 urls}}`；`format:"audio"` 回读产物文件字节。

- `rvc-convert`：`params.model` 必填 = 引擎 key（`GET /api/models?category=rvc` 主权重茎）；可选 `f0_up_key/f0_method/index_rate/...`。
- `ddsp-svc-convert`：`params.model` 必填 = `.pt` 绝对路径；整曲翻唱（分离+转换+混音）走既有 `/api/sovits/v1/svc/cover`。
- `uvr5-separate`：无 model；`params.preset` 默认 `vocal_fast`，响应 `paths/urls` 双份产物。

## 参考音频：各引擎怎么接（façade 已吸收的差异）

| 能力 | 原生认音色库 id | 认服务端路径 | 说明 |
| --- | --- | --- | --- |
| gpt-sovits-v2proplus | ✅ `voice` | ✅ `ref_audio_path` | voice_id 自带参考文本 |
| confucius4-tts / indextts-2.5 | ❌ | ✅ `ref_path` | 传 voice_id 时**网关折算成路径** |
| irodori-tts | ✅ `ref_voice` | ✅ `ref_path` | 另支持 `params.speaker_id` 固化音色 |
| gpt-sovits-v5 | ✅ `ref_voice` | ✅ `ref_audio_path` | 裸路径必须自带 `params.prompt_text/prompt_lang`；voice_id 自带 |
| mimo | `params.voice` | ❌ | preset id 或 data URI |

## 错误契约

统一 `{ok:false, error:{code, message, retryable, hint?, details?}}`（阶段 43 起 `hint` 进入全局契约）。

- **上游结构化错误原样透传**：引擎忙 409（irodori/netease）与 429/403（trainer）、显存不足 503 `VRAM_INSUFFICIENT`、参考缺失 400……状态码与 hint 都是各服务的语义，**不翻译**。
- 网关自有两类：`OPEN_RUNTIME_UNREACHABLE`（503，运行时没起/连不上，hint 指向设置页与 /api/capabilities）、`OPEN_UPSTREAM_ERROR`（上游响应形态异常）。
- ASR 固定模型权重未就绪：上游 trainer 返回 **503 `WEIGHTS_MISSING`**（在显存准入之前检查），hint 带下载命令 / 本地放置路径；`/api/capabilities` 的 `available=false`、`weights_ready=false` 与它一致。
- SenseVoice 专用运行时缺失：上游 trainer 返回 **503 `SENSEVOICE_RUNTIME_MISSING`**（同样在显存准入之前），hint 指向 `trainer/sensevoice-venv` / `SENSEVOICE_PYTHON`；capabilities 的 `runtime_ready=false` 与它一致。
- 校验失败（未知 model / 缺参考 / kind 不匹配 / 缺 params.model）→ 400 `INVALID_REQUEST`，`details.supported` 带受支持清单。

## 显存与互斥（外部调用方必读）

1. 本机常跑显存极限 **6GB**；多数引擎常驻 3~5.5GB，**同一时刻只容一个引擎**。
2. 默认**不让位**：撞卡会收到引擎原样的 `VRAM_INSUFFICIENT`（503）或 busy（409），hint 会说清该关什么。
3. 确要让位：请求带 `"focus": true`（网关先跑仲裁器卸载其它引擎并带 1h 心跳），响应/头里带 `arbiter` 记录。
4. 长任务（训练/批量）不进本 façade —— 用既有透传：`/api/sovits/v1/train`、`/v1/tts/batch`、`/api/irodori/v1/train` 等，任务轮询 `/api/sovits/v1/jobs/:id`。

## 示例

```bash
# 能力发现
curl http://127.0.0.1:8787/api/capabilities

# 合成（裸 wav 落盘）
curl -s -X POST http://127.0.0.1:8787/api/open/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"model":"confucius4-tts","text":"你好","voice_id":"<音色id>","focus":true}' \
  --output out.wav
```

```python
# ⚠️ Git Bash 的 curl 会把 UTF-8 中文转 GBK（HANDOFF 坑 54）——带中文的调用一律用 urllib
import json, urllib.request

def call(path, payload):
    req = urllib.request.Request(
        "http://127.0.0.1:8787" + path,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=900) as resp:
        ctype = resp.headers.get("Content-Type", "")
        return (json.load(resp), None) if "json" in ctype else (None, resp.read())

text, wav = call("/api/open/v1/audio/speech", {
    "model": "gpt-sovits-v2proplus", "text": "你好，世界。",
    "voice_id": "<音色id>", "format": "json",
})
if wav:
    open("out.wav", "wb").write(wav)

_, result = call("/api/open/v1/audio/transcriptions", {
    "model": "paraformer-zh", "audio_path": r"F:\audio\clip.wav",
})
print(result["text"])
```

## 排障

1. `GET /api/capabilities` 看 `available/loaded/vram_required_mb` 与 `vram_free_mb`；
2. 503 `OPEN_RUNTIME_UNREACHABLE` → 设置页开服务（netease/indextts/irodori/gsv5 默认按需启动）；
3. 引擎级错误看 `hint` —— 各服务端的 hint 都是给使用者的下一步动作；
4. 网关日志：`server/` 的控制台输出。

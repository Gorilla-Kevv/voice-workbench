# 全系统数据链路逐条测试清单（debug 模式）

> 交付文档。从 `HANDOFF.md` + 三端代码（前端 `app/`、网关 `server/`、Python 服务 `trainer/` `netease/` `indextts/`）逐条核实后穷举而成。
> 用途：把本清单交给任意模型或人工逐条测试；每条链路给出「操作 → 完整数据路径 → 检查点 → 预期」，测试者只需回填编号 + 现象。
> 链路里出现的坑编号（坑 N）指 `HANDOFF.md`「已知坑」章节，测试失败时先对照该坑是否复发。

## 使用说明（给测试者 / 其他模型）

1. **报告格式**：`编号 | 通过/失败/阻塞 | 现象一句话 | 浏览器控制台报错 / 网络请求的状态码+响应体`。响应体里必须带 `error.code`（全系统统一契约 `{ok:false,error:{code,message,retryable,hint}}`）。
2. 标注 **[前提]** 的条目依赖服务开关或权重，未满足时记「阻塞」而非「失败」。
3. 显存相关的失败先跑 `ENV-06` 记录当时 nvidia-smi 空闲，再下结论（坑 17/24/26：准入判定全部走 nvidia-smi 口径）。
4. 同一编号多次测试请标 `SYN-05#2`。

---

## 一、环境与前置检查（ENV）

| # | 检查项 | 链路 | 检查点 | 预期 |
|---|---|---|---|---|
| ENV-01 | 四进程启动 | `start.bat` 或 `npm run dev`（trainer 9881 默认**不起**、netease 9882 起、网关 8787、前端 5173） | 坑 1（bat 必须 GBK/ANSI）；`dev:netease` 缺 venv 时应安静跳过不崩窗格 | 各端口按 README 约定起停 |
| ENV-02 | 网关健康 | 浏览器 `GET http://127.0.0.1:8787/api/health` | 响应含 `host.ram_total_mb/ram_free_mb`（坑 19：内存只有网关看得到全貌）、`sovits/netease/indextts` 三段摘要 | `{ok:true}`，5s 缓存的上游探活状态正确 |
| ENV-03 | 三服务直连健康 | `:9881/health`、`:9882/health`、`:9883/health` 各 GET 一次 | netease/indextts 的 `/health` **永远 200**——模型可用性看 `engines.*.installed` / `cuda`，不看状态码 | 200 + 如实的 installed 字段 |
| ENV-04 | 显存读数 | `GET /api/preload/catalog` | `vram.source` 应为 nvidia-smi；与 `nvidia-smi --query-gpu=memory.free` 手测对比 | 两者接近（坑 17 修复口径） |
| ENV-05 | GPU 占用进程 | `GET /api/resources/gpu-processes` | WDDM 下只有进程名+实例数，无每进程显存数（不许编数） | 200，进程列表非空且不含无权限占位 |
| ENV-06 | 显存基线快照 | `nvidia-smi --query-gpu=memory.used,memory.free --format=csv` | 记录测试起点，事后归因用 | — |
| ENV-07 | 类型检查与构建 | `npm run typecheck`、`npm run build` | 验收标准 | 退出码 0 |

## 二、全局链路（G）

| # | 操作 | 数据链路 | 检查点 | 预期 |
|---|---|---|---|---|
| G-01 | 打开首页（默认落地=网易合成页） | App 挂载并发：`GET /api/sovits/health`、`/api/netease/health`、`/api/indextts/health`（均经网关反代） | 未就绪前 90s 内每 3s 快试、之后 30s/60s 稳态轮询；控制台无报错 | 侧栏状态卡如实显示 就绪/未就绪 |
| G-02 | 首次弹出预加载对话框 | `GET /api/preload/catalog` → 选模型+「记住」→ `PUT /api/preload/preference {model}` → `POST /api/preload {model}` →（内部：让位→nvidia-smi 检查→warmup→成功后 `arbiter.focus(model,3600)`） | **BUG-01（见末节）**：preference 白名单不含 `indextts-tts`；顺序必须 先让位→再检查→最后加载 | 加载成功返回 `{model,ok,released[],vram_free_mb}` |
| G-03 | 预加载对话框「暂不加载」 | `PUT /api/preload/preference {model:'none'}` | 落盘 `server/.data/preload.json` | 下次开机不再弹 |
| G-04 | 侧栏 14 个导航逐项点击 | 前端条件渲染（切页即卸载上一页组件） | 坑 18：各页结果必须活过切页（sessionStorage/模块级缓存） | 每页渲染无白屏、无 ErrorBoundary 卡 |
| G-05 | 侧栏底部状态卡点击 | `goSettingsSection(锚点)`：网易卡→`settings-service-netease`、sovits/rvc/svc/asr→`settings-service-sovits`、MiMo→`settings-cloud` | 滚动+2.6s 高亮；卡→锚点映射不串页 | 直达对应区块 |
| G-06 | 主题切换 | localStorage `mimo-voice:theme` | 刷新后保持 | 正常 |
| G-07 | FlowGuide 打勾/回退/「去这一页」 | localStorage `voice-workbench:guide-progress`；`markGuideEvent('netease:ref-ready'/'netease:first-synth')` 自动打勾 | 跨页导航正确 | 进度持久 |
| G-08 | 误拖文件到页面空白处 | AppShell 全局 `preventDefault` | 坑 25：浏览器默认会把整个 SPA 导航走、表单状态全丢 | 页面不跳转不丢状态 |
| G-09 | 制造渲染异常触发 ErrorBoundary | 「重新加载」；「重置本地配置后重载」删 `mimo-voice:settings`+`mimo-voice:sovits-url` 后 reload | 不应纯白页面 | 显示错误卡 |
| G-10 | 非本地页（synthesis/design/clone）无密钥 | KeyGate 横幅 + 「前往设置」 | 服务端公用密钥存在时不拦 | 有引导的拦截 |
| G-11 | 任意合成失败 | 全局 toast「合成失败」带 fullMessage（含 hint） | 坑 6：依赖必须写 `controller.error` 而非整个 controller 对象，否则计时器导致每秒弹一次 | 只弹一次、含 hint |

## 三、通用合成页 SYN（后端=MiMo 云端经网关，或 GPT-SoVITS 本地）

| # | 操作 | 数据链路 | 检查点 | 预期 |
|---|---|---|---|---|
| SYN-01 | 挂载（provider=mimo） | `GET /api/voices/presets`（网关常量） | 失败时兜底 FALLBACK_PRESET_VOICES | 音色列表 |
| SYN-02 | 挂载（provider=gpt-sovits） | `GET /api/sovits/v1/voices` + `GET /api/sovits/v1/catalog` | 坑 7 版本大小写归一 | 本地音色可选 |
| SYN-03 | 方言/风格/唱歌/音频标签按钮 | 纯前端拼接前缀进文本 | 标签互斥（方言）与多选（风格）逻辑 | 送出的 text 与 UI 一致 |
| SYN-04 | 开始合成（mimo） | `POST /api/tts/synthesize`（JSON，mode:'preset'）→ 网关 `services/mimo.ts` → MiMo `/chat/completions`（头 `api-key`+`Bearer`）→ 返回 base64 JSON 音频 | >600 字且 autoSegment → 后端分段（每段 320 字、≤12 段串行）；synthLimiter 20 次/60s | 结果栈新增一条，各段可播 |
| SYN-05 | 同上（provider=gpt-sovits） | `providers/gpt-sovits.ts` → `POST /api/sovits/v1/tts`（JSON，`inline_base64:true`，超时 0）→ 反代 pipe → trainer `/v1/tts` | 坑 20（multipart 之外 JSON 也走通）；训练进行中应得 429 `TRAINING_ACTIVE` | 音频可播 |
| SYN-06 | 播放/增益 | 前端 ObjectURL；playbackGain（WebAudio）；settings.autoPlay 自动播首段 | — | 有声、增益滑杆生效 |
| SYN-07 | 逐段下载 / 打包 ZIP / 删除 / 清空 | 全前端 Blob 操作（`zip.ts` 内存拼包） | 坑 18：只在淘汰/显删时 revoke | 均可用 |
| SYN-08 | 合成成功后刷新历史 | App `handleSuccess` → IndexedDB `mimo-voice-studio`（history+audio 两 store）+ `pruneRecords(historyLimit)` | — | 历史页可见 |
| SYN-09 | 错误卡「重试」 | `useSynthesis.retry` 重发上次 payload | — | 成功或再次如实报错 |
| SYN-10 | 无 Key 直接 POST（绕过 UI） | `POST /api/tts/synthesize` 不带 key | 应 401 `MISSING_API_KEY` | 结构化错误 |
| SYN-11 | 文本超长/空 | 同上 | 400；上限 maxTextLength 3000（网关） | 带 hint 的 400 |

## 四、批量合成页 BAT（全部走 GPT-SoVITS）

| # | 操作 | 数据链路 | 检查点 | 预期 |
|---|---|---|---|---|
| BAT-01 | 挂载 | `GET /api/sovits/v1/voices` | 服务未起 → 整页「本地服务不可用」卡 + 「直接开启」（`POST /api/sovits/service`）+「重新检测」 | 如实报错不静默 |
| BAT-02 | ResourceBudget 并发探测 | `GET /api/health` + `/api/sovits/v1/engines` + `/api/netease/health` + `/api/indextts/health` + `/api/indextts/v1/catalog` | 坑 19：门槛值来自服务端 | 预估卡显示正确 |
| BAT-03 | 显存不足→「只跑这一个模型」 | `POST /api/resources/focus {engine:'sovits'}` → arbiter 卸载其余两端 + 15s 心跳复检 | 卸载 sovits 端时 `/v1/engines/unload` 若合成在跑会等锁最多 300s（可能进 failed[]，arbiter 不重试——观察是否如实转述） | released/failed 如实 |
| BAT-04 | 「释放常驻显存」 | 按 loaded 标志逐个 `POST /api/indextts/v1/unload`、`/api/netease/v1/confucius/unload`、`/v1/r2t2/unload`、`/api/sovits/v1/engines/unload` | 404 视为无此端点不算失败 | 显存归还 |
| BAT-05 | 「关闭 GPT-SoVITS 服务」 | `POST /api/sovits/service {enabled:false}` → 网关先 POST `/v1/engines/unload`（15s）再 taskkill 自己拉起的进程树 | 外部终端起的实例杀不掉——应只卸模型并如实提示（hint 区分四种情形） | 不谎报已停 |
| BAT-06 | 导入 txt/csv/tsv（按钮+拖拽） | 前端 FileReader（CSV 取第一列去表头） | 坑 25（accept 过滤、input.files 回填、dragleave 深度计数） | 清单正确填充 |
| BAT-07 | 解析清单 | `POST /api/sovits/v1/tts/batch/plan` | 条数上限 500（超限 `BATCH_TOO_LARGE`）、空条目 `EMPTY_BATCH` | 条数/字数徽标 |
| BAT-08 | 试听首条 | `POST /api/sovits/v1/tts/batch`（wait:true, make_zip:false）→ 返回 `audio_url(/files/…)` → `resolveAudioUrl` 补 `/api/sovits` 前缀 → `<audio>.play()` | **音频地址映射**：不补前缀必 404（网关无 /files 自有路由） | 有声 |
| BAT-09 | 开始批量（job 模式） | 先 `POST /api/resources/focus`（失败静默继续！）→ `POST /v1/tts/batch`（wait:false）拿 job_id → 每 1.2s `GET /v1/jobs/{id}` 轮询至终态 | 页面刷新后 sessionStorage `mimo-voice:batch-session` 恢复并续轮询；结果栈 `batch-rounds`（存服务端 URL，刷新可恢复） | 状态连续 |
| BAT-10 | 批量取消 | `POST /v1/jobs/{id}/cancel`（body `{reason:'用户取消'}`）→ trainer 同时 `pipeline.stop()` 打断 torch | 取消后终态 cancelled | 真停，非 UI 假停 |
| BAT-11 | 批次结果 | 每条 `<audio src=/api/sovits/files/...>`、单条下载、ZIP `zip_url`、清单 `manifest_url` | 失败条目在 results[] 中状态如实；continue_on_error 开关行为 | 与 manifest 一致 |
| BAT-12 | 高级参数 | cut0-5 / speed_factor / temperature / repetition_penalty → 进 `params:Dict` 透传 trainer | 非法值应 422→`VALIDATION_ERROR` | 生效或明确报错 |
| BAT-13 | 队列满/并发 | 批量跑时再起一条试听（trainer 本地模式 infer 并发=1、队列 32） | `QUEUE_FULL` 429 retry_after 15s | 带 hint 的 429 |

## 五、音色设计 DES / 声音克隆 CLN（MiMo 云端）

| # | 操作 | 数据链路 | 检查点 | 预期 |
|---|---|---|---|---|
| DES-01 | 快捷描述按钮 / 描述文本 / 0-20-300 字三档提示 | 纯前端 | — | — |
| DES-02 | 生成音色并试听 | `POST /api/tts/synthesize`（mode:'design'，instruction=描述，optimizeTextPreview）→ MiMo `mimo-v2.5-tts-voicedesign` | 结果面板同 SYN-06~09 | 可播可存历史 |
| CLN-01 | 上传样本（点击/拖拽） | 前端校验 mp3/wav ≤10MB 后转 dataURI；**不走** `POST /api/voices/sample`（该端点已实现但页面未接——直接测它见 GW-05） | 超 10MB/错格式前端拦截；网关侧 magic bytes 校验是第二道 | 拦截提示正确 |
| CLN-02 | 麦克风录制 | getUserMedia，≤60s，转码 24kHz WAV（纯前端） | 权限拒绝时的引导文案 | 可录可试听 |
| CLN-03 | 克隆合成 | `POST /api/tts/synthesize`（mode:'clone'，voice=样本 dataURI） | 无样本时按钮 disabled；body 体积大（base64 样本）注意网关 `JSON_BODY_LIMIT` 20MB，超了 413 `PAYLOAD_TOO_LARGE` | 合成成功入结果栈 |

## 六、音色库 VLIB（GPT-SoVITS）

| # | 操作 | 数据链路 | 检查点 | 预期 |
|---|---|---|---|---|
| VLIB-01 | 挂载/刷新 | `GET /api/sovits/v1/voices` + `/v1/catalog` | exists=false 显示「音频文件已丢失」；warnings 标红 | 列表如实 |
| VLIB-02 | 试听 | `GET /api/sovits/v1/voices/{id}/audio`（FileResponse bytes） | **坑 21**：绝不可拿 `voice.audio_path`（磁盘路径）拼 URL——会 404；只允许试听端点这一条路 | 有声 |
| VLIB-03 | 导入（文件） | `POST /api/sovits/v1/voices`（multipart：name/prompt_text/prompt_lang/note/tags/audio） | 坑 8：`prompt_lang` 不得写入字符串 `"undefined"`（读写两端归一化，历史脏数据启动时自纠） | 保存成功、语种正确 |
| VLIB-04 | 导入（磁盘路径） | `POST /api/sovits/v1/voices/source`（JSON：name/prompt_text/prompt_lang/audio_path/note/tags） | 与文件方式互斥 UI；引用不复制 | 入库 exists=true |
| VLIB-05 | 一键智能转写 | `POST /api/sovits/v1/asr/transcribe`（multipart，超时 0）回填参考文本 | FunASR 仅 zh/yue（自动切换逻辑） | 文本回填 |
| VLIB-06 | 编辑元数据 | `PATCH /api/sovits/v1/voices/{id}` | — | 持久 |
| VLIB-07 | 替换音频 | `POST /api/sovits/v1/voices/{id}/audio`（multipart） | 坑 25 拖拽 | 试听变为新音频 |
| VLIB-08 | 删除 | confirm → `DELETE /api/sovits/v1/voices/{id}` | 删除后其它页引用该音色的下拉应刷新 | 列表移除 |

## 七、历史记录 HIS（纯本地）

| # | 操作 | 数据链路 | 检查点 | 预期 |
|---|---|---|---|---|
| HIS-01 | 模式 Tabs 筛选/关键词搜索 | 内存过滤 IndexedDB 记录 | — | 正确 |
| HIS-02 | 播放 | `getAudioBlobs` 读 IndexedDB audio store → ObjectURL | 卸载时 revoke 全部 ObjectURL；历史Limit 裁剪（10-200 滑杆设置） | 有声 |
| HIS-03 | 下载/ZIP | 前端拼 zip | — | 可用 |
| HIS-04 | 删除单条/清空 | IndexedDB 两 store 同步删 | 只删一个 store 会留孤儿 Blob（重点核对） | 无孤儿 |

## 八、模型训练 TRN（GPT-SoVITS，12 阶段）

| # | 操作 | 数据链路 | 检查点 | 预期 |
|---|---|---|---|---|
| TRN-01 | 挂载并发 | `GET /api/sovits/health`（看 `capabilities.training`）+ `/v1/catalog` + `/v1/train?limit=20` + `/v1/uvr/models` | 坑 9：BS-RoFormer `available=false`（缺 yaml）应如实不可选 | 阻断项如实列出 |
| TRN-02 | 语料上传（多选/拖文件夹递归） | `POST /api/sovits/v1/train/upload`（multipart，超时 0）→ 返回 `{dir,files[],rejected[]}` 回填 | 坑 25 目录 entry 分批读；>512MB 整批 413 `UPLOAD_TOO_LARGE`；无有效音频 400 `NO_VALID_FILE` | dir 回填、rejected 有原因 |
| TRN-03 | 预检计划 | `POST /v1/train/plan` | 展示 12 阶段命令；顺序 **s2→s1**（坑 11 已修，验证不复发） | 阶段列表与开关一致 |
| TRN-04 | 开始训练 | 先 `POST /api/resources/focus {engine:'training',holdSeconds:21600}` → `POST /v1/train` → 每 2s `GET /v1/jobs/{id}` | trainer 侧训练槽：`engines.acquire('train')`（门槛 6144MB）+ `pipeline.unload()`；训练期间推理应 429 `TRAINING_ACTIVE` | 进度按阶段加权推进 |
| TRN-05 | 会话持久化 | sessionStorage `mimo-voice:train-session`（防抖全量表单，jobDetails 除外） | 刷新后恢复；「清空」removeItem | 恢复正确 |
| TRN-06 | UVR5 子开关链 | uvr_model/agg(0-20)/format(wav/flac/mp3/m4a)/keep_vocal/keep_ins → TrainRequest | 错误码 `UVR_MODEL_MISSING/UVR_CONFIG_MISSING/UVR_MODEL_REQUIRED/UVR_NO_OUTPUT`；坑 3（vocal/ins 参数反）用关键字参数规避 | 各组合不崩 |
| TRN-07 | ASR 后端约束 | backend∈{funasr,fasterwhisper}；FunASR 限 zh/yue，非中英自动切 fasterwhisper；精度按后端钳制 | `ASR_LANGUAGE_UNSUPPORTED` | 前端钳制+后端兜底 |
| TRN-08 | 切分 8 滑杆 | slice:{threshold=-34,min_length=4000,...} | 边界值（0/负数/极大）行为 | 校验或生效 |
| TRN-09 | 标注校对 | `GET /v1/annotations/{jobId}` → 逐条试听（`/v1/annotations/audio?path=` 路径防穿越=`PATH_TRAVERSAL`）→ `PUT /v1/annotations/{jobId}`（items[{index,text,skip}]） | 无 list_file 任务应 400 `NO_LIST`；skip 条目丢弃；「用这份清单训练」→ listFileOverride + runAsr=false | 保存后重读一致 |
| TRN-10 | 切分结果面板 | job.artifacts 含 slice 阶段时的盘点报告（时长降序、>15s 高亮） | HANDOFF「下一步」高优项：现有历史任务无一含 slice，**需新任务验证** | 面板如实 |
| TRN-11 | 历史任务展开 | `GET /v1/jobs/{id}` 就地展开（阶段状态/产物/日志开关按 job id 记忆） | — | — |
| TRN-12 | 训练权重产物联动 | 训完 GPT/SoVITS 权重 → 设置页 WeightsPanel 可选可加载 | 本机 `GPT/SoVITS_weights_v2ProPlus/` 为空时下拉空态应引导而非空白 | 空态文案 |
| TRN-13 | 取消训练 | `POST /v1/jobs/{id}/cancel` | 子进程阶段真终止；终态 cancelled | GPU 释放 |

## 九、语音变声 RVC

| # | 操作 | 数据链路 | 检查点 | 预期 |
|---|---|---|---|---|
| RVC-01 | 挂载 | `GET /api/sovits/v1/vc/catalog` | 失败仅页内横幅+重试（不替换整页） | 引擎状态如实 |
| RVC-02 | 导入 .pth(+.index) | `POST /v1/vc/models/upload`（multipart，按钮+整卡拖拽） | — | 列表新增 |
| RVC-03 | 热加载 | `POST /v1/vc/models/load`（multipart，超时 0）→ trainer `engines.acquire('rvc')`（门槛 2560MB，互斥时先 force 请走当前引擎） | `VRAM_INSUFFICIENT` 应带「谁在占 GPU」（阶段26补4 链路） | 状态变 loaded |
| RVC-04 | 删除模型 | `DELETE /v1/vc/models?model={id}` | — | — |
| RVC-05 | 变声 | focus('rvc') → `POST /v1/vc/convert`（multipart：f0_up_key/f0_method/index_rate/protect/wait...，默认 wait:false）→ job 轮询 1.5s | 结果 `artifacts` 里 `/files/vc/<job>/x.wav` 经 resolveAudioUrl；ABPlayer 对比 | 产物可播 |
| RVC-06 | 音色融合 | `POST /v1/vc/merge`（JSON：多模型+权重+新名称） | — | 新音色入列表 |
| RVC-07 | LoRA 训练 | `POST /v1/vc/train`（JSON：底模/语料目录/轮数 5-80/rank 4-32）→ JobPanel | 走训练池；与推理互斥 `GPU_BUSY_TRAINING` | — |
| RVC-08 | 结果跨页 | sessionStorage `vc-results`（只存 URL）；源音频快照 ObjectURL 刷新即失效 | 坑 18 第三条 | 刷新后 URL 结果仍在、源音频标失效 |

## 十、歌声转换 SVC

| # | 操作 | 数据链路 | 检查点 | 预期 |
|---|---|---|---|---|
| SVC-01 | 挂载 | `GET /api/sovits/v1/svc/catalog` | 缺 config.yaml 的音色在下拉里禁用而非消失 | 如实 |
| SVC-02 | 翻唱全流程 | focus('svc') → `POST /v1/svc/cover`（multipart，wait:false）→ 内部串 UVR5 分离（preset/secondary/use_cache）+ SVC 推理 → job → artifacts{vocal,instrumental,mix} | F0 'auto' 哨兵映射空串；增益滑杆 -10~10/-20~10 dB；人声延迟补偿 ±500ms；`slice_segments` 长音频切分 | 三轨 AB 切换可播 |
| SVC-03 | 只做分离 | focus('uvr5') → `POST /v1/uvr/separate`（multipart **wait:true 同步**） | `GET /v1/uvr/cache` 命中 → cached 标记；坑 3/4（uvr_cli 相对导入、参数序） | 人声/伴奏 AB |
| SVC-04 | 会话持久 | `svc-cover-results`、`uvr-separate-results`（sessionStorage 存服务端相对路径） | — | 刷新恢复 |

## 十一、语音转文本 ASR

| # | 操作 | 数据链路 | 检查点 | 预期 |
|---|---|---|---|---|
| ASR-01 | 挂载 | `GET /api/sovits/v1/asr/catalog`（含 diagnostics.datasets） | 未定位整合包 → 提示设 `GPT_SOVITS_HOME` | 能力清单 |
| ASR-02 | 场景预设按钮 | 前端一键铺 backend/size/language/precision | 换后端时收敛其余三项的联动 | 参数合法组合 |
| ASR-03 | 单条转写 | focus('asr') → `POST /v1/asr/transcribe`（multipart：file 或 source 互斥、backend/size/language/precision/channel/use_cache，超时 0） | 优先通道 auto/resident/script 三条路径都要各测一次 | 文本入栈、可复制 |
| ASR-04 | 数据集上传 | `POST /v1/asr/upload`（multipart，拖文件夹） | — | — |
| ASR-05 | 训练转写 | `POST /v1/asr/train/plan`（显示通道/模型/stages/dataset_dir）→ `POST /v1/asr/train` → JobPanel → 完成回调刷新 `GET /v1/asr/datasets` | 走推理池（ASR_TRAIN→infer）；时长过滤 min/max | 数据集列表新增 |
| ASR-06 | 结果持久 | sessionStorage `asr-transcripts`（纯 JSON，刷新可恢复） | 复制走 clipboard API（非安全上下文失败率） | — |

## 十二、网易合成 NET（默认主服务）

| # | 操作 | 数据链路 | 检查点 | 预期 |
|---|---|---|---|---|
| NET-01 | 挂载 | `GET /api/netease/v1/netease/catalog` + `/v1/confucius/pipeline` | 失败页面保持可用、状态卡给原因（不整页崩） | 14 语种/档位/门槛如实 |
| NET-02 | 预热引擎 | focus('netease-tts') → `POST /v1/confucius/warmup`（超时 0）→ trainer `check_vram`（fp16=5120MB，nvidia-smi 口径；已 loaded 跳过——不，netease 侧冷路径才检查） | 坑 24：报 VRAM 不足时文案须区分「门槛拦截」与「其它进程占用」（torch_free 差>1GB 时点名）；preempted 提示（抢 ASR 引擎位） | 成功 loaded=true / 失败带 hint |
| NET-03 | 卸载引擎 | `POST /v1/confucius/unload` → del + empty_cache + lock.release | 卸载后 `/api/netease/health` 的 engine_lock.holder 应清空 | 显存归还 |
| NET-04 | 参考音频上传 | 前端 `<audio>` 预览 + markGuideEvent('netease:ref-ready') | — | 指引自动打勾 |
| NET-05 | 从音色库选参考 | `GET /api/sovits/v1/voices`（**跨到 GPT-SoVITS 侧！**）→ 合成时先 `fetch GET /api/sovits/v1/voices/{id}/audio` 取 Blob 再随 multipart 上传 | 坑 21 曾在这是 404 重灾区；GPT-SoVITS 未起时应给 SovitsServiceNotice+重新加载，而不是静默失败 | 全链路通 |
| NET-06 | 合成 | `POST /api/netease/v1/confucius/tts`（multipart：text/lang/file/ref_path/preempt/quality）→ 返回 **base64 JSON** → ObjectURL 入栈 | markGuideEvent('netease:first-synth')；preempted toast；lang 不在 14 种 → `UNSUPPORTED_LANGUAGE`；无参考 → `REF_AUDIO_REQUIRED` | 出声、结果卡 |
| NET-07 | 结果卡播放/下载 | 下载名 `confucius4-tts-{stamp}.wav`；sessionStorage `netease-tts-results` **无 serialize**（Blob 刷新即失效，只跨页面） | 坑 18 第二条——**HANDOFF 阶段23 唯一没验到的路径**（结果卡播放/下载），本轮必测 | 播放与下载真出声 |
| NET-08 | 显存不足错误卡 | error.code=VRAM_INSUFFICIENT → 页面给「改用 GPT-SoVITS 批量合成」fallback 按钮 | 不静默降级（非目标 3） | 跳转可用 |
| NET-09 | 档位（fast/balanced/quality） | 页面固定 balanced；**用 curl 直发 `quality=quality` / `num_beams=3&n_timesteps=25` 覆盖**测后端 | 裸 num_beams/n_timesteps 覆盖 preset；quality 应明显慢（~3x T2S 候选） | 三档 RTF 差异记录 |
| NET-10 | 引擎互斥抢占 | r2t2 已加载时 NET-06（preempt=true）→ `ENGINE_BUSY`(preempt=false) / 抢占后 `ctx.asr.unload()` | netease 单持有者锁 engine_lock | 抢占成功且对方真卸载 |

## 十三、网易转写 NET2（R2T2，Windows 预期不可用）

| # | 操作 | 数据链路 | 检查点 | 预期 |
|---|---|---|---|---|
| NET2-01 | 挂载 | `GET /api/netease/v1/netease/catalog` + `/v1/r2t2/pipeline` | `r2t2.installed=false` 时预热/转写按钮禁用——**这就是 Windows 上的预期表现**（坑 12），不是 bug | 禁用+说明 |
| NET2-02 | 快速转写（如有 WSL2/Docker 环境） | `POST /v1/r2t2/transcribe`（multipart stream:false，return_timestamps 复选） | `WORKER_INTERPRETER_MISSING`/`WORKER_NOT_RUNNING` 等 code 应带 hint | 文本+时间戳表 |
| NET2-03 | 流式转写 | `POST /v1/r2t2/transcribe`（stream:true, chunk_ms∈{80,160,320,640,2000}）→ **NDJSON**：start→多条 delta（整体替换实时文本）→result/error | 反代 pipe 保证流式（坑 20）；AbortController「取消」掐断 | 增量渲染流畅 |
| NET2-04 | 复制/下载 TXT/清空 | 前端 Blob；`netease-asr-results` serialize 全文（**刷新可恢复**——与 NET-07 相反，验证两种策略各归各位） | — | — |
| NET2-05 | r2t2 warmup 显存准入旁路 | `POST /v1/r2t2/warmup` **不查显存**（代码事实），而 transcribe 冷路径查 | 显存紧张时 warmup 可能放行、transcribe 才拦——测试确认报错不误导 | 报错口径一致可解释 |

## 十四、IndexTTS 合成 IDX

| # | 操作 | 数据链路 | 检查点 | 预期 |
|---|---|---|---|---|
| IDX-01 | 挂载 | `GET /api/indextts/v1/catalog` + `/v1/pipeline`；App 层 `GET /api/indextts/health` | 无 CUDA → incomplete 卡 | 门槛字段 `required_vram_mb`（真源服务端，坑 19/26） |
| IDX-02 | 服务未起→「启动服务」快捷入口 | `POST /api/indextts/service {enabled:true}` → 网关 RuntimeSupervisor spawn（`scripts/indextts.mjs`，复用外部实例）→ 成功后自动重取 catalog+pipeline | 阶段26补6 交付项；starting 状态应有进度反馈（坑 23 同款：enabled 落盘≠就绪） | 一键恢复卡片 |
| IDX-03 | 预热 | focus('indextts-tts',3600) → `POST /v1/warmup`（超时 0） | **首跑约 4 分钟**（上游 ModelScope→hf-mirror 网络探测超时，坑 26）——断网机更久；别误判卡死 | loaded=true |
| IDX-04 | 参考音频（上传/音色库） | 同 NET-05 跨服务取 `GET /api/sovits/v1/voices/{id}/audio` 转 File | 坑 21 同款 | — |
| IDX-05 | 合成（follow 情感） | `POST /api/indextts/v1/synth`（multipart：file/text/lang/duration_factor）→ base64 wav | lang∈{ZH,EN,JA,AR,ES}；duration_factor 引擎侧强制 clamp 0.5-2.0 | 出声 |
| IDX-06 | 合成（vector 情感） | 8 个 0-1 滑杆 → `emo_vector`（JSON 字符串）+ `emo_alpha` | 非 list→`BAD_EMO_VECTOR`；**全 0 应等同 follow**（前端约定）；引擎 clamp 0~1、维度序=喜/怒/哀/惧/厌恶/低落/惊喜/平静 | 情感差异可听 |
| IDX-07 | 合成（audio 情感参考） | `emo_file` 上传 + emo_alpha 滑杆（默认 0.65） | 与 emo_vector 同时传的优先级行为要记录 | — |
| IDX-08 | 已加载时再合成 | `_guard_vram` 应**跳过**（loaded 即放行） | 坑 26 「自己拦自己」bug 回归测试：模型加载后空闲必然低于 3072，若再拦即复发 | 不报 VRAM_INSUFFICIENT |
| IDX-09 | 卸载 | `POST /v1/unload` | 显存应归还约 5.3GB（坑 26 实测常驻，门槛 3072 偏低待拍板——顺手记录差值给决策） | nvidia-smi 回落 |
| IDX-10 | 不可达错误 | 服务停时合成 | 网关 503 `INDEXTTS_UNAVAILABLE` + hint `npm run dev:indextts`；错误卡附启动命令文案 | 引导明确 |

## 十五、设置页 SET

| # | 操作 | 数据链路 | 检查点 | 预期 |
|---|---|---|---|---|
| SET-01 | 模型与显存卡 | `GET /api/preload/catalog` → 点卡/「每次问我」/「不预加载」→ `PUT /api/preload/preference` | **BUG-01**：选 IndexTTS 大概率 400 `BAD_MODEL` | 见 BUG 节 |
| SET-02 | 网易服务开关 | `POST /api/netease/service {enabled}`（开无超时/关 90s）→ `GET /api/netease/service` 刷新 + 重探 sovits | 外部实例关不掉 → 先卸模型释放显存并如实 hint（releasedVram 分支）；坑 23：starting≠ready | 状态如实 |
| SET-03 | IndexTTS 开关 | 同 SET-02 形如 `/api/indextts/service` | 默认关 | — |
| SET-04 | GPT-SoVITS 开关 | `POST /api/sovits/service`（先落盘 `sovits-service.json` 再 ensureStarted，冷启动数十秒、进度条按 45s 假推进）+ 每 30s `GET` 复查 | 坑 23 重点回归：任何「见 enabled 即认为没事」的误判；`SovitsServiceNotice` 须同时看 starting | 等待期反馈正确 |
| SET-05 | 服务地址自定义 | Input →「保存」→ localStorage `mimo-voice:sovits-url`（此后前端**直连**如 `http://127.0.0.1:9881` 不走网关）→ 重探 `GET {base}/health`+`/v1/weights` | 填错地址的报错；非 127.0.0.1 时 arbiter 拒绝对其发卸载请求（硬边界，只回环） | 报错清晰 |
| SET-06 | WeightsPanel | `GET {base}/v1/weights` → Select → 「加载所选权重」`POST /v1/weights/load`（eager:true，超时 0） | **坑 22 回归**：default 与 pretrained 必须同口径绝对路径，否则下拉空白 | 加载成功、active 更新 |
| SET-07 | 默认模型版本/音色/语种、文件名模板、默认 ZIP | 写 localStorage `mimo-voice:settings`（providerFields['gpt-sovits']） | 坑 7 大小写；模板非法占位符的处理 | 各页读取生效 |
| SET-08 | MiMo 密钥保存 | 「保存」→ `POST /api/config/verify`（网关向 MiMo 做一次极短合成，45s 超时 0 重试）→ 通过才写 localStorage | 失败时「忽略校验，仍然保存」后门存在且明示；网络不通返回 `{ok:false}`→400 而非 500 | 校验语义正确 |
| SET-09 | Provider 切换 mimo/gpt-sovits/selfhosted | localStorage settings；selfhosted 预设按钮填 model+languages | 切到 gpt-sovits 后 SYN 页链路应整体换轨（SYN-05） | 全站一致 |
| SET-10 | 合成偏好 | 分段/润色/自动播放/增益(0.5-4)/历史条数(10-200)/恢复默认 | 恢复默认 confirm 后各页生效 | — |
| SET-11 | 站点信息「仅清除本地密钥与接口地址」 | 删 settings 中相关键 | 不应连带清掉其它设置 | 精确清除 |

## 十六、网关自有端点直测（GW，curl/浏览器均可）

| # | 端点 | 检查点 | 预期 |
|---|---|---|---|
| GW-01 | `GET /api/health` | 限流 120 次/60s/IP（`RATE_LIMITED` 429 带 retryAfterSec）；`/api/health` 自身不打访问日志 | 正常 JSON |
| GW-02 | `POST /api/tts/synthesize` 边界 | 20 次/60s synthLimiter；`NO_AUDIO_IN_RESPONSE` 502；MiMo 上游 5xx→重试 2 次指数退避 | 如实 |
| GW-03 | `GET /api/config` | hasServerKey/baseUrl/limits 与实际 env 一致 | — |
| GW-04 | `POST /api/voices/sample`（页面未接，直测） | 非 mp3/wav→`SAMPLE_FORMAT_UNSUPPORTED`；>10MB→413；<1KB 拒绝；magic bytes 嗅探（改扩展名的假 wav） | 结构化 4xx |
| GW-05 | `PUT /api/preload/preference` 非法值 | `{model:'garbage'}` → 400 `BAD_MODEL` 带 hint | — |
| GW-06 | `POST /api/preload` 并发两次 | 应共享同一 running promise，不双重加载 | 观察日志 |
| GW-07 | `POST /api/resources/focus` 非法 engine | 400 `BAD_ENGINE` | — |
| GW-08 | `GET /api/resources/focus` 心跳状态 | hold 期内 `{remainSec}` 递减；15s 心跳复检卸载 | 与 arbiter 日志对账 |
| GW-09 | `POST /api/resources/release` | 三服务全卸；`targetReachable:false` | — |
| GW-10 | 未知路径 | 任意 `GET /api/whatever/service` → 404 `NOT_FOUND`（service 路由只有 sovits/netease/indextts 三个实名挂载，无动态通配） | — |
| GW-11 | 非法 JSON body | 400 `INVALID_REQUEST`；>20MB → 413 `PAYLOAD_TOO_LARGE` | — |
| GW-12 | 客户端中途断开 | 合成进行中关页面/tab → 网关 `proxyReq.destroy()`，上游不应继续空转烧 GPU（观察 trainer 日志） | 真断 |

## 十七、后端契约与横切场景（BE / RX）

| # | 场景 | 链路 | 检查点 | 预期 |
|---|---|---|---|---|
| BE-01 | 统一错误契约三服务抽查 | 各造 3 种错（400/404/503） | 全部 `{ok:false,error:{code,message,retryable,hint}}`；422 被统一改写成 `VALIDATION_ERROR`；hint 面向使用者（前端必须展示 hint 而非只 message） | 契约无漏网 |
| BE-02 | NDJSON 流式回归 | `POST /api/sovits/v1/tts/stream`（**页面未接，直测**：start→meta→chunk(base64 PCM16)→done 落盘 outputs/；中途错→error 事件）+ NET2-03 | 坑 20：任何经 express.json 之后的路径必挂——回归确认挂载顺序 | 逐 chunk 到达 |
| BE-03 | trainer 模式差异 | local（并发 1/1、队列 32、无显存排队准入）vs public（2/1/200+日配额+`_wait_for_vram`+admin_token 头 `x-api-key`） | 训练端点在 public 无 token → 401 `UNAUTHORIZED`；配额 `QUOTA_EXCEEDED` 不可重试 | 按 mode 如实 |
| BE-04 | 音频地址映射全链路 | trainer 返回 `/files/...` 相对路径 → 前端 resolveAudioUrl 补 `/api/sovits` | BAT-08/RVC-05/SVC-02 已覆盖 UI 面；直测 `GET /api/sovits/files/<真实产物>` | 200 bytes |
| RX-01 | **双主服务显存对撞** | 已 preload 网易（4.9GB 常驻）→ 不经 focus 直接 `POST /api/sovits/v1/tts`（trainer 加载 pipeline ≈1.8GB+） | 8GB 卡必然挤压；观察是 OOM 崩溃还是被门槛拦住（trainer `/v1/tts` 本身**无显存准入**——只有引擎注册表路径有，这是已知的准入盲区，重点验证实际后果） | 不静默崩服务 |
| RX-02 | 训练期间一切推理 | 训练跑着 → 依次触发 SYN-05/BAT-09/RVC-05/ASR-03 | 应一律 429 `TRAINING_ACTIVE`/`GPU_BUSY_TRAINING` + hint，前端不得显示成未知错误 | 全拦截 |
| RX-03 | arbiter 心跳 vs 手动加载 | focus('netease-tts') 持有期内 → 手动去加载 RVC 模型（RVC-03） | 15s 心跳会把 rvc 引擎 force 掉——行为是否符合预期、UI 状态是否自洽（卡了个「刚加载又被卸」的观测） | 记录体验 |
| RX-04 | 服务开关抖动 | sovits 启动中（starting）连点两次开关 → 再 `POST /api/sovits/service {enabled:false}` | ensureStarted 幂等；shutdown 不残留孤儿 Python 进程（task 管理器核对） | 无孤儿 |
| RX-05 | tsx watch 重启连锁 | 改网关一行代码触发 dev 重启 | GPT-SoVITS 开关为开 → 子进程被回收后自动再拉起；关则不拉（决策已接受代价，验证不失控） | 自愈 |
| RX-06 | unload 撞合成 | 批量合成进行中 → `POST /api/sovits/v1/pipeline/unload` | 等锁 300s → BusyError（arbiter 计入 failed 不重试）——前端 ResourceBudget「释放」按钮此时表现 | 不损坏 job |

## 十八、代码走查已确认的疑似缺陷（BUG，优先验证）

| # | 疑似缺陷 | 位置 | 复现步骤 | 若确认 |
|---|---|---|---|---|
| **BUG-01** | 预加载偏好白名单漏 `indextts-tts`：账本与 catalog 有它、对话框/设置页可选它，但 `PUT /api/preload/preference` 与 `POST /api/preload` 的 MODELS 白名单只含 `netease-tts/sovits/none/ask` → 选 IndexTTS+记住 必 400 `BAD_MODEL`；即便跳过偏好直接 POST preload 同样被拒 | `server/src/routes/preload.ts:14,52` vs `server/src/services/preload.ts:19,60` | G-02 用 IndexTTS 卡走一遍 + SET-01 | 补白名单（一行改动） |
| BUG-02 | 批量「开始合成」前的 focus 失败被**静默吞掉**（前端设计如此），若 arbiter 500（如 SOVITS_URL 被 SET-05 改成非回环）用户不会看到任何提示，随后 batch 404/503 | 前端 BatchPage focusBeforeRun(focus 失败静默) | BAT-09 + 故意配错 | 评估是否该透 hint |
| BUG-03 | `indextts` 非受控异常走 FastAPI 默认 500（无 handler），响应**不带** `{ok,error,hint}` 契约，前端可能显示「什么都没发生」（坑 21 症状复发面） | `indextts/app/api.py` 仅注册 IndexTtsError handler | IDX-05 触发 torch 内部错（如 CUDA OOM） | 加兜底 handler |
| BUG-04 | `GET /api/netease/service` 路由注释「无 supervisor」已过时（实际阶段26补3 已托管）——纯文档漂移，顺手改 | `server/src/routes/netease.ts` 头注释 | 代码走查即证 | 改注释 |
| BUG-05 | preload 账本 indextts 门槛 3072MB vs 实测常驻 5.3GB（坑 26 遗留待拍板）——预加载「检查通过」后加载期间可能抖动挤爆 | `server/src/services/preload.ts:27` 注释自认 | G-02 选 IndexTTS（若 BUG-01 先修）后测首条合成 RTF | 提请用户拍板上调数值 |

## 十九、测试顺序建议

1. ENV 全部 → 2. G（含 BUG-01 优先）→ 3. 主链路一页一组：NET → IDX → SYN → VLIB → BAT → 4. 重资源：TRN/RVC/SVC/ASR → 5. GW/BE/RX 直测组 → 6. SET 收尾（会改全局状态）。
2. 每组测完把「失败条目 + 当时的 /api/health 响应 + Python 服务日志尾部」一起带回，进入逐条修复。

## 二十、测试结果回填记录

| # | 条目 | 现象 | 判定 | 处置 |
|---|---|---|---|---|
| 1 | SET-02 / RX-04（网易服务开关关闭） | 网关日志报「网易 Confucius4-TTS 异常退出（退出码 1），最后输出：confucius/unload 200 → r2t2/unload 200 → GET /health 200」 | **误报（假崩溃）**：unload 顺序与 `RuntimeSupervisor.shutdown()` 的 `releaseModels()` 完全吻合——是网关主动 `taskkill /f` 自己拉起的进程（强杀退出码必为 1），但 `exit` 处理器不区分主动杀与真崩溃，把正常关闭记成错误并写入 `lastError`（会经 `GET /api/netease/service` 显示到设置页）。`sovits.ts` 的 `SovitsSupervisor` 存在同款缺陷（误写「Python 服务意外退出」） | **已修**：两个 supervisor 增加 `stopping` 主动关闭标记（`server/src/services/runtime.ts`、`server/src/services/sovits.ts`），主动杀时静默退出不上报；带 10s 兜底复位防吞掉真实崩溃。typecheck 通过。**待回归**：重新关一次开关应只见「已按设置关闭」无红色报错；再手动杀一次 Python 进程（模拟真崩溃）应仍如实报「异常退出」 |

> 本清单生成时间：2026-10-08 [BY Qoder]，基于 commit 0378b14（feature/vc-svc）。

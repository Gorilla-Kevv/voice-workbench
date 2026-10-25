import type { FocusEngine } from './arbiter.js';
import type { RuntimeServiceId } from './serviceCatalog.js';

/**
 * 对外能力清单（阶段 43）：把「已部署模型能做什么」收敛成一份机器可读的真源表。
 *
 * 消费方有两个：
 * - `GET /api/capabilities` 与 `GET /api/open/v1/models` —— 外部任务/Agent 靠它做能力发现；
 * - `routes/open.ts` 的统一调用端点 —— 靠 `upstream` 与 `ref` 字段把「OpenAI 风格的
 *   `{model, text, voice_id}`」翻译成各运行时自己的请求形态。
 *
 * 边界（刻意为之，见 docs/OPEN-API.md）：
 * - 只登记**推理类**能力。训练 / 批量是异步 jobs，塞进同步 façade 只会把半天的任务
 *   挂死一个 HTTP 连接 —— 外部调用方继续走既有 `/api/sovits/v1/train` 等透传端点；
 * - 不改变任何现有端点：本表是**描述**，页面链路照旧走各自透传；
 * - 显存门槛的真源在各服务端（坑 19），这里只存「去哪个字段取」的指针（`vram_source`），
 *   网关绝不硬编码门槛数值。
 */

export type CapabilityKind = 'tts' | 'asr' | 'vc' | 'svc' | 'separation';

export type CapabilityRuntime = RuntimeServiceId | 'mimo';

export interface CapabilitySpec {
  /** 稳定 id：外部调用方的 `model` 参数就填它（或别名） */
  id: string;
  label: string;
  kind: CapabilityKind;
  runtime: CapabilityRuntime;
  aliases: string[];
  /** 参考音频如何送达该引擎：`voice_id_param` = 原生认音色库 id 的参数名；`path_param` = 认服务端绝对路径的参数名；两者都可为 null */
  ref: { voice_id_param: string | null; path_param: string | null };
  /** 上游端点（POST）。style=json 直接发 JSON body；style=form 转成 multipart 文本字段 */
  upstream: { path: string; style: 'json' | 'form' };
  /** ASR / 转换类的**主音频**参数名（区别于参考音频） */
  audio_input_param: string | null;
  /** 每个能力各自要透传给上游的固定参数（如 ASR 的 backend/size/model） */
  fixed_params: Record<string, string>;
  /** 调用方可额外传的参数白名单（docs/OPEN-API.md 逐项有说明） */
  extra_params: string[];
  /** focus:true 时仲裁器集中资源给谁；null = 无本地引擎（云端） */
  arbiter_engine: FocusEngine | null;
  /** 显存门槛从哪个服务端字段取（坑 19：网关不硬编码数字） */
  vram_source: string;
  hint: string;
  /** ASR 能力固定的权重模型 id（/v1/asr/catalog 的 resident_model_status 键）；null = 不按单模型判断 */
  weights_key?: string | null;
}

/** 服务端 `/v1/asr/catalog → resident_model_status` 的单模型状态 */
export interface ResidentModelStatus {
  weights_ready?: boolean | null;
  weights_source?: string;
  /** 专用运行时就绪（SenseVoice 需要独立 FunASR venv） */
  runtime_ready?: boolean | null;
  runtime_hint?: string;
  vram_required_mb?: number | null;
}

export interface CapabilityAvailability {
  available: boolean;
  weights_ready: boolean | null;
  runtime_ready: boolean | null;
  vram_required_mb: number | null;
  weights_source: string | null;
}

/**
 * 能力可用性：运行时可达 **且**（固定模型时）权重就绪，才算可用。
 *
 * 之前 `/api/capabilities` 与 `/api/open/v1/models` 都只看 runtime.reachable，
 * 于是 SenseVoice 权重缺失时也报 available=true。这里把权重状态作为第二道门：
 * 固定 model 的能力必须**明确 ready=true** 才算 available；状态缺失（null）
 * 也按不可用处理，宁可让调用方看到 false 并去查 weights_ready，不报假阳性。
 * 无固定 model 的能力（如 faster-whisper）仍按运行时可达判断。
 */
export function capabilityAvailability(
  spec: CapabilitySpec,
  reachable: boolean,
  models?: Record<string, ResidentModelStatus>,
  fallbackVram?: number | null,
  mimoReady?: boolean,
): CapabilityAvailability {
  if (spec.runtime === 'mimo') {
    return {
      available: Boolean(mimoReady),
      weights_ready: null,
      runtime_ready: null,
      vram_required_mb: fallbackVram ?? null,
      weights_source: null,
    };
  }
  const model = spec.weights_key ? models?.[spec.weights_key] : undefined;
  const weightsReady = typeof model?.weights_ready === 'boolean' ? model.weights_ready : null;
  const runtimeReady = typeof model?.runtime_ready === 'boolean' ? model.runtime_ready : null;
  return {
    available: reachable && (spec.weights_key ? weightsReady === true && runtimeReady !== false : true),
    weights_ready: weightsReady,
    runtime_ready: runtimeReady,
    vram_required_mb: model?.vram_required_mb ?? fallbackVram ?? null,
    weights_source: model?.weights_source ?? null,
  };
}

export const CAPABILITIES: CapabilitySpec[] = [
  // ------------------------------------------------------------------ TTS
  {
    id: 'gpt-sovits-v2proplus',
    label: 'GPT-SoVITS v2ProPlus（本地，零样本/微调权重）',
    kind: 'tts',
    runtime: 'sovits',
    aliases: ['gpt-sovits', 'sovits-tts'],
    ref: { voice_id_param: 'voice', path_param: 'ref_audio_path' },
    upstream: { path: '/v1/tts', style: 'json' },
    audio_input_param: null,
    fixed_params: {},
    extra_params: ['text_lang', 'prompt_text', 'prompt_lang', 'version', 'gpt', 'sovits', 'params'],
    arbiter_engine: 'sovits',
    vram_source: 'sovits GET /v1/engines → engines[name=sovits].required_mb',
    hint: '服务停用时需先在设置页开启（或由网关 supervisor 自动拉起）。weight 选择经 params.version/gpt/sovits。',
  },
  {
    id: 'confucius4-tts',
    label: '网易 Confucius4-TTS（本地，14 语种免转写克隆）',
    kind: 'tts',
    runtime: 'netease',
    aliases: ['netease-tts', 'confucius'],
    ref: { voice_id_param: null, path_param: 'ref_path' },
    upstream: { path: '/v1/confucius/tts', style: 'form' },
    audio_input_param: null,
    fixed_params: {},
    extra_params: ['lang', 'quality', 'num_beams', 'n_timesteps'],
    arbiter_engine: 'netease-tts',
    vram_source: 'netease GET /health → configuration.tts_required_vram_mb',
    hint: '参考音频只认服务端路径：传 voice_id 由网关折算，或直接给 ref_path。quality ∈ fast/balanced/quality。',
  },
  {
    id: 'indextts-2.5',
    label: 'IndexTTS-2.5（本地，8 维情感向量 / 拼音注音 / 语速）',
    kind: 'tts',
    runtime: 'indextts',
    aliases: ['indextts', 'index-tts'],
    ref: { voice_id_param: null, path_param: 'ref_path' },
    upstream: { path: '/v1/synth', style: 'form' },
    audio_input_param: null,
    fixed_params: {},
    extra_params: ['lang', 'duration_factor', 'emo_vector', 'emo_alpha'],
    arbiter_engine: 'indextts-tts',
    vram_source: 'indextts GET /v1/catalog → required_vram_mb',
    hint: 'emo_vector 是 8 个 0~1 的数字数组（喜/怒/哀/惧/厌恶/低落/惊喜/平静）。语速用 duration_factor（0.5~2.0）。',
  },
  {
    id: 'irodori-tts',
    label: 'Irodori-TTS（本地，日语特化 + emoji 情感）',
    kind: 'tts',
    runtime: 'irodori',
    aliases: ['irodori'],
    ref: { voice_id_param: 'ref_voice', path_param: 'ref_path' },
    upstream: { path: '/v1/synth', style: 'json' },
    audio_input_param: null,
    fixed_params: {},
    extra_params: ['caption', 'num_steps', 'schedule', 'seed', 'duration_scale', 'speaker_id'],
    arbiter_engine: 'irodori-tts',
    vram_source: 'irodori GET /health → configuration.required_vram_mb',
    hint: '仅日语（无假名会被上游拒绝）。参考三选一：ref_voice（音色库 id）/ ref_path / params.speaker_id（固化音色）。',
  },
  {
    id: 'gpt-sovits-v5',
    label: 'GPT-SoVITS v5（本地，v5turbo 4 步 / v5dev 32 步）',
    kind: 'tts',
    runtime: 'gsv5',
    aliases: ['gsv5', 'sovits-v5'],
    ref: { voice_id_param: 'ref_voice', path_param: 'ref_audio_path' },
    upstream: { path: '/v1/synth', style: 'json' },
    audio_input_param: null,
    fixed_params: {},
    extra_params: ['text_lang', 'prompt_text', 'prompt_lang', 'variant', 'sample_steps', 'speed_factor', 'seed'],
    arbiter_engine: 'gpt-sovits-v5',
    vram_source: 'gsv5 GET /v1/catalog → variants[].required_vram_mb',
    hint: 'variant ∈ v5turbo（默认，快）/ v5dev（高质）。裸 ref_audio_path 必须自带 prompt_text/prompt_lang；voice_id 自带。',
  },
  {
    id: 'mimo',
    label: '小米 MiMo（云端，需服务端密钥）',
    kind: 'tts',
    runtime: 'mimo',
    aliases: ['xiaomi-mimo'],
    ref: { voice_id_param: 'voice（preset 音色 id 或克隆样本 data URI）', path_param: null },
    upstream: { path: '(内部 services/mimo.synthesize)', style: 'json' },
    audio_input_param: null,
    fixed_params: {},
    extra_params: ['mode', 'voice', 'instruction', 'auto_segment'],
    arbiter_engine: null,
    vram_source: '（云端，不占本机显存）',
    hint: '不占显存、与本地引擎互不排斥。preset 音色 id 见 GET /api/capabilities 的 mimo 条目；克隆模式 voice 传 data URI。',
  },
  // ------------------------------------------------------------------ ASR
  {
    id: 'paraformer-zh',
    label: 'FunASR Paraformer-large（本地，中文逐字 + 标点）',
    kind: 'asr',
    runtime: 'sovits',
    aliases: ['funasr-paraformer', 'asr-paraformer'],
    ref: { voice_id_param: null, path_param: null },
    upstream: { path: '/v1/asr/transcribe', style: 'form' },
    audio_input_param: 'source',
    fixed_params: { backend: 'funasr', size: 'large', model: 'paraformer-zh' },
    extra_params: ['language', 'use_cache'],
    arbiter_engine: 'asr',
    vram_source: 'sovits GET /v1/asr/readiness → resident_model_status[paraformer-zh].vram_required_mb',
    hint: '中文转写首选。本地权重就绪时 available=true；显存门槛 2048MB。',
    weights_key: 'paraformer-zh',
  },
  {
    id: 'sensevoice-small',
    label: 'FunASR SenseVoice-Small（本地，中英日韩粤）',
    kind: 'asr',
    runtime: 'sovits',
    aliases: ['sensevoice'],
    ref: { voice_id_param: null, path_param: null },
    upstream: { path: '/v1/asr/transcribe', style: 'form' },
    audio_input_param: 'source',
    // SenseVoice 没有 size 概念；留空，由服务端的模型解析决定。
    fixed_params: { backend: 'funasr', model: 'iic/SenseVoiceSmall' },
    extra_params: ['use_cache'],
    arbiter_engine: 'asr',
    vram_source: 'sovits GET /v1/asr/readiness → resident_model_status[iic/SenseVoiceSmall].vram_required_mb',
    hint: '多语种轻量档（日/英/韩/粤都走它，不挂 VAD，适合耳语；worker 固定逐字、不做 ITN 标点）。权重未就绪 → available=false / WEIGHTS_MISSING；专用运行时缺失 → runtime_ready=false / SENSEVOICE_RUNTIME_MISSING（trainer/sensevoice-venv 或 SENSEVOICE_PYTHON）。显存门槛 1536MB（实测常驻约 1050MB）。',
    weights_key: 'iic/SenseVoiceSmall',
  },
  {
    id: 'faster-whisper',
    label: 'faster-whisper（本地，多语种，尺寸可选）',
    kind: 'asr',
    runtime: 'sovits',
    aliases: ['whisper'],
    ref: { voice_id_param: null, path_param: null },
    upstream: { path: '/v1/asr/transcribe', style: 'form' },
    audio_input_param: 'source',
    fixed_params: { backend: 'fasterwhisper' },
    extra_params: ['size', 'precision', 'language', 'use_cache'],
    arbiter_engine: 'asr',
    vram_source: 'sovits GET /v1/engines → engines[name=asr].required_mb（无固定 model；实际随 size/precision 变，调用前用 /v1/asr/plan）',
    hint: 'size ∈ medium/large-v3/large-v3-turbo；本机已缓存 small 与 large-v3-turbo，medium/large 首次使用下载。门槛随 size/precision 变（turbo fp16 3072 / int8 2560；large-v3 fp32 8192）。',
  },
  {
    id: 'r2t2-offline',
    label: 'Confucius4-R2T2 离线转写（本地，Qwen3-ASR 基座）',
    kind: 'asr',
    runtime: 'netease',
    aliases: ['r2t2', 'netease-asr'],
    ref: { voice_id_param: null, path_param: 'ref_path' },
    upstream: { path: '/v1/r2t2/transcribe', style: 'form' },
    audio_input_param: 'ref_path',
    fixed_params: { stream: 'false' },
    extra_params: ['language', 'return_timestamps'],
    arbiter_engine: 'netease-asr',
    vram_source: 'netease /v1/r2t2/transcribe 冷启动路径的 check_vram()（REQUIRED_VRAM_MB=6144）',
    hint: 'bf16 净占 ~5.5GB，与网易 TTS 引擎互斥。长音频服务端按 240s 自动分段。时间戳需 forced aligner，未接入。',
  },
  // ------------------------------------------------------ VC / SVC / 分离
  {
    id: 'rvc-convert',
    label: 'RVC 语音变声（本地，模型库 .pth）',
    kind: 'vc',
    runtime: 'sovits',
    aliases: ['rvc', 'voice-convert'],
    ref: { voice_id_param: null, path_param: null },
    upstream: { path: '/v1/vc/convert', style: 'form' },
    audio_input_param: 'source',
    fixed_params: { wait: 'true' },
    extra_params: ['model', 'f0_up_key', 'f0_method', 'index_rate', 'filter_radius', 'rms_mix_rate', 'protect', 'resample_sr'],
    arbiter_engine: 'rvc',
    vram_source: 'sovits GET /v1/engines → engines[name=rvc].required_mb',
    hint: 'model 传变声模型的引擎 key（GET /api/models?category=rvc 的主权重茎）。façade 强制同步（wait=true）。',
  },
  {
    id: 'ddsp-svc-convert',
    label: 'DDSP-SVC 歌声转换（本地）',
    kind: 'svc',
    runtime: 'sovits',
    aliases: ['ddsp-svc', 'singing-convert'],
    ref: { voice_id_param: null, path_param: null },
    upstream: { path: '/v1/svc/convert', style: 'form' },
    audio_input_param: 'source',
    fixed_params: { wait: 'true' },
    extra_params: ['model', 'key', 'spk_id', 'f0_method', 'quality', 'formant_shift', 'threshold_db'],
    arbiter_engine: 'svc',
    vram_source: 'sovits GET /v1/engines → engines[name=svc].required_mb',
    hint: 'model 传 .pt 主权重绝对路径（GET /api/models?category=ddsp-svc 的 required 角色）。整曲翻唱（分离+转换+混音）用既有 /api/sovits/v1/svc/cover 透传。',
  },
  {
    id: 'uvr5-separate',
    label: 'UVR5 音源分离（本地，人声/伴奏）',
    kind: 'separation',
    runtime: 'sovits',
    aliases: ['uvr5', 'separate'],
    ref: { voice_id_param: null, path_param: null },
    upstream: { path: '/v1/uvr/separate', style: 'form' },
    audio_input_param: 'source',
    fixed_params: { wait: 'true', format: 'wav' },
    extra_params: ['preset', 'secondary', 'agg', 'use_cache'],
    arbiter_engine: 'uvr5',
    vram_source: 'sovits GET /v1/engines → engines[name=uvr5].required_mb',
    hint: 'preset ∈ vocal_fast/vocal_hp2…（见 /v1/uvr/models）。响应带 paths/urls 两套产物路径。',
  },
];

/** 按 id 或别名查找（大小写不敏感）；找不到返回 null */
export function findCapability(idOrAlias: string): CapabilitySpec | null {
  const key = (idOrAlias || '').trim().toLowerCase();
  if (!key) return null;
  return (
    CAPABILITIES.find((item) => item.id === key || item.aliases.includes(key)) ?? null
  );
}

/** OpenAI 风格的模型清单项（GET /api/open/v1/models 的 data[]） */
export function toOpenAiModel(spec: CapabilitySpec, available: boolean): Record<string, unknown> {
  return {
    id: spec.id,
    object: 'model',
    owned_by: `voice-workbench/${spec.runtime}`,
    kind: spec.kind,
    label: spec.label,
    available,
  };
}

/**
 * 音色库（共享存储，网关侧实现）。
 *
 * 存储位置：仓库根 `voicelib/`（`voices.json` + `voices/<id>.<ext>`），
 * 与 trainer 的 `app/sovits/voices.py` 读写**同一份**索引 ——
 * 音色库从此不绑定 GPT-SoVITS 服务：网易 / IndexTTS / 任何运行时都能选音色。
 *
 * 记录形状与 Python 侧 `Voice.to_dict()` 一一对应（坑 21 的老契约），
 * 前端类型 `SovitsVoice` 不用改。跨进程一致性靠「每次操作前重读磁盘」保证：
 * 本地场景索引只有几十 KB，重读比维护缓存便宜且不会脏。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** server/src/services → 仓库根 */
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

/** 与 trainer 的 Settings.voices_lib_dir 同一默认值、同一环境变量 */
export const VOICE_LIB_DIR = (process.env.VOICES_LIB_DIR?.trim() || path.join(REPO_ROOT, 'voicelib')).replace(/[\\/]$/, '');
const INDEX_PATH = path.join(VOICE_LIB_DIR, 'voices.json');
const AUDIO_DIR = path.join(VOICE_LIB_DIR, 'voices');

/** 迁移前的老位置（音色库曾住在 trainer/.data 下） */
const LEGACY_DIR = path.join(REPO_ROOT, 'trainer', '.data');
const LEGACY_INDEX = path.join(LEGACY_DIR, 'voices.json');
const LEGACY_AUDIO_DIR = path.join(LEGACY_DIR, 'voices');

const ALLOWED_SUFFIXES = new Set(['.wav', '.mp3', '.flac', '.ogg', '.m4a', '.webm', '.aac', '.wma']);
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;
/** 与 trainer catalog.LANGUAGE_PRESETS 对齐 */
const SUPPORTED_LANGS = new Set(['zh', 'en', 'ja', 'ko', 'yue', 'auto']);
/** 官方对参考音频时长的硬约束（trainer catalog.REF_AUDIO_MIN/MAX_SEC 的镜像，仅用于 warnings） */
const REF_MIN_SEC = 3.0;
const REF_MAX_SEC = 10.0;
/**
 * 日语长参考（Irodori）的约束。与 Irodori 侧的 `max_ref_seconds`（120）对齐。
 * 注意这两组约束**故意不同**：GPT-SoVITS 只吃 3~10s 的单条主音频，
 * Irodori 要的是「多段短句拼起来的长参考」（官方建议 ~30s）。
 * 分流靠的是「谁读哪个字段」，不是靠校验 —— 见下方 ref_clips 的注释。
 */
const LONG_REF_MAX_SEC = 120;
const LONG_REF_SWEET_SPOT_SEC = 30;

/**
 * 日语长参考的一个片段。
 *
 * 为什么是**多片段**而不是一条长录音：官方训练/推理都建议多段短句拼接，
 * 单条长录音里的停顿与语气漂移会污染 speaker embedding。
 */
export interface RefClip {
  /** 绝对路径（托管上传时在 `voicelib/voices/` 下） */
  path: string;
  dur_s: number | null;
  sample_rate: number | null;
  /** 该片段的转写（Irodori 的 SI 训练要用；推理不需要） */
  text?: string;
  added_at?: number;
}

/** 固化的 speaker embedding（Speaker Inversion 产物，30-6 训练写入） */
export interface SpeakerEmbed {
  path: string;
  trained_at: number;
  steps?: number;
  batch?: number;
}

export interface VoiceRecord {
  id: string;
  name: string;
  audio_path: string;
  prompt_text: string;
  prompt_lang: string;
  note: string;
  tags: string[];
  origin: string;
  duration_s: number | null;
  sample_rate: number | null;
  size_bytes: number;
  created_at: number;
  updated_at: number;
  // ---- 以下三个是 30-4 新增的**可选**字段 ----
  //
  // ⚠️ 兼容铁律（改这段前先读）：
  // 1. **缺失时保持 `undefined`，不要默认成 `[]`** —— 否则每次改个 note 都会给
  //    磁盘上所有旧记录塞进空数组，几百条记录的索引被无意义地改写一遍；
  // 2. **Python 侧（`trainer/app/sovits/voices.py`）必须同步认这三个字段** ——
  //    那边 `_load()` 是显式列字段构造的，不认的字段会被丢掉，而它一旦
  //    触发「修复落盘」就把 Node 写的这些字段**抹掉**（方案 §5 点名的坑）；
  // 3. 三个字段都不是「引擎路由」的依据：GPT-SoVITS 继续只读 `audio_path`，
  //    Irodori 读 `ref_clips`（为空时回落 `audio_path`）。`engine_tags` 只是标注。
  /** 日语长参考多片段（Irodori 用；旧记录没有此字段） */
  ref_clips?: RefClip[];
  /** 适用引擎标签，如 `['gsv', 'irodori']`；空/缺失 = 未标注（所有引擎都可见） */
  engine_tags?: string[];
  /** 固化的 speaker embedding 列表（30-6 训练产物登记在这里） */
  speaker_embeds?: SpeakerEmbed[];
}

export interface VoiceView extends VoiceRecord {
  exists: boolean;
  warnings: string[];
  /** 长参考总时长（秒）；没有片段时是 0 */
  ref_clips_total_sec: number;
  /** 片段里有几个缺转写（SI 训练要用，UI 要提示） */
  ref_clips_missing_text: number;
}

export class VoiceLibraryError extends Error {
  readonly status: number;
  readonly code: string;
  readonly hint?: string;
  constructor(status: number, code: string, message: string, hint?: string) {
    super(message);
    this.name = 'VoiceLibraryError';
    this.status = status;
    this.code = code;
    this.hint = hint;
  }
}

function normalizePromptLang(value: string | undefined | null): string {
  const code = (value ?? '').trim().toLowerCase();
  return SUPPORTED_LANGS.has(code) ? code : 'zh';
}

function isFile(target: string): boolean {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

// --------------------------------------------------------------------------
// 一次性迁移：trainer/.data → voicelib/
// --------------------------------------------------------------------------

let migrationDone = false;

function migrateFromTrainerData(): void {
  if (migrationDone || isFile(INDEX_PATH) || !isFile(LEGACY_INDEX)) {
    migrationDone = true;
    return;
  }
  migrationDone = true;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(LEGACY_INDEX, 'utf-8'));
  } catch {
    return;
  }
  if (!Array.isArray(raw)) return;

  fs.mkdirSync(AUDIO_DIR, { recursive: true });
  const legacyAudioPrefix = LEGACY_AUDIO_DIR.toLowerCase();
  const migrated: VoiceRecord[] = [];
  for (const item of raw) {
    const record = item as Partial<VoiceRecord>;
    if (!record || typeof record.id !== 'string' || typeof record.audio_path !== 'string') continue;
    let audioPath = record.audio_path;
    // 托管在旧目录下的文件复制进新目录；external 引用原路径不动
    if (audioPath.toLowerCase().startsWith(legacyAudioPrefix)) {
      const target = path.join(AUDIO_DIR, path.basename(audioPath));
      if (isFile(audioPath) && !isFile(target)) {
        try {
          fs.copyFileSync(audioPath, target);
        } catch {
          continue; // 复制失败就跳过这条，绝不留下指向新目录的坏记录
        }
      }
      audioPath = target;
    }
    migrated.push({
      id: record.id,
      name: record.name ?? '',
      audio_path: audioPath,
      prompt_text: record.prompt_text ?? '',
      prompt_lang: normalizePromptLang(record.prompt_lang),
      note: record.note ?? '',
      tags: Array.isArray(record.tags) ? record.tags : [],
      origin: record.origin ?? 'managed',
      duration_s: record.duration_s ?? null,
      sample_rate: record.sample_rate ?? null,
      size_bytes: record.size_bytes ?? 0,
      created_at: record.created_at ?? 0,
      updated_at: record.updated_at ?? 0,
    });
  }
  writeIndex(migrated);
  // 旧索引改名保留（不删除）：trainer 已改读 voicelib/，留这份只会误导
  try {
    fs.renameSync(LEGACY_INDEX, `${LEGACY_INDEX}.migrated-to-voicelib`);
  } catch {
    // 改名失败不影响正确性（新索引已写好），下次启动还会再迁一遍，幂等
  }
}

// --------------------------------------------------------------------------
// 索引读写（每次操作前重读，跨进程不脏）
// --------------------------------------------------------------------------

function readIndex(): VoiceRecord[] {
  migrateFromTrainerData();
  if (!isFile(INDEX_PATH)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf-8'));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const items: VoiceRecord[] = [];
  for (const item of raw) {
    const record = item as Partial<VoiceRecord>;
    if (!record || typeof record.id !== 'string') continue;
    const voice: VoiceRecord = {
      id: record.id,
      name: record.name ?? '',
      audio_path: record.audio_path ?? '',
      prompt_text: record.prompt_text ?? '',
      prompt_lang: normalizePromptLang(record.prompt_lang),
      note: record.note ?? '',
      tags: Array.isArray(record.tags) ? record.tags : [],
      origin: record.origin ?? 'managed',
      duration_s: record.duration_s ?? null,
      sample_rate: record.sample_rate ?? null,
      size_bytes: record.size_bytes ?? 0,
      created_at: record.created_at ?? 0,
      updated_at: record.updated_at ?? 0,
    };
    // 30-4 的三个可选字段：**只在磁盘上真的有时才带上**（见 VoiceRecord 的兼容铁律 1）
    if (Array.isArray(record.ref_clips)) voice.ref_clips = normalizeRefClips(record.ref_clips);
    if (Array.isArray(record.engine_tags)) voice.engine_tags = normalizeEngineTags(record.engine_tags);
    if (Array.isArray(record.speaker_embeds)) voice.speaker_embeds = normalizeSpeakerEmbeds(record.speaker_embeds);
    items.push(voice);
  }
  return items;
}

function normalizeRefClips(raw: unknown[]): RefClip[] {
  const clips: RefClip[] = [];
  for (const item of raw) {
    const clip = item as Partial<RefClip>;
    if (!clip || typeof clip.path !== 'string' || !clip.path) continue;
    const next: RefClip = {
      path: clip.path,
      dur_s: typeof clip.dur_s === 'number' ? clip.dur_s : null,
      sample_rate: typeof clip.sample_rate === 'number' ? clip.sample_rate : null,
    };
    if (typeof clip.text === 'string' && clip.text.trim()) next.text = clip.text.trim();
    if (typeof clip.added_at === 'number') next.added_at = clip.added_at;
    clips.push(next);
  }
  return clips;
}

function normalizeEngineTags(raw: unknown[]): string[] {
  return [...new Set(raw.map((tag) => String(tag ?? '').trim().toLowerCase()).filter(Boolean))];
}

function normalizeSpeakerEmbeds(raw: unknown[]): SpeakerEmbed[] {
  const embeds: SpeakerEmbed[] = [];
  for (const item of raw) {
    const embed = item as Partial<SpeakerEmbed>;
    if (!embed || typeof embed.path !== 'string' || !embed.path) continue;
    const next: SpeakerEmbed = {
      path: embed.path,
      trained_at: typeof embed.trained_at === 'number' ? embed.trained_at : 0,
    };
    if (typeof embed.steps === 'number') next.steps = embed.steps;
    if (typeof embed.batch === 'number') next.batch = embed.batch;
    embeds.push(next);
  }
  return embeds;
}

function writeIndex(items: VoiceRecord[]): void {
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
  const tmp = `${INDEX_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(items, null, 2), 'utf-8');
  fs.renameSync(tmp, INDEX_PATH);
}

function toView(record: VoiceRecord): VoiceView {
  const exists = isFile(record.audio_path);
  const warnings: string[] = [];
  // 与 Python 侧 Voice.warnings() 同口径（3~10 秒、缺转写文本、文件丢失）
  if (!exists) {
    warnings.push('音频文件已不存在，请重新上传或修正路径');
  } else {
    if (!record.prompt_text.trim()) {
      warnings.push('缺少参考文本：v3/v4 模型会直接报错，其余版本音色相似度也会明显下降');
    }
    if (record.duration_s != null) {
      if (record.duration_s < REF_MIN_SEC) {
        warnings.push(`时长 ${record.duration_s.toFixed(1)} 秒，短于官方要求的 ${REF_MIN_SEC} 秒`);
      } else if (record.duration_s > REF_MAX_SEC) {
        warnings.push(`时长 ${record.duration_s.toFixed(1)} 秒，长于官方要求的 ${REF_MAX_SEC} 秒，请裁剪后再用`);
      }
    }
  }

  // ---- 日语长参考（30-4）----
  const clips = record.ref_clips ?? [];
  let total = 0;
  let missingText = 0;
  for (const clip of clips) {
    if (!isFile(clip.path)) {
      warnings.push(`日语长参考片段已丢失：${path.basename(clip.path)}`);
      continue;
    }
    if (clip.dur_s) total += clip.dur_s;
    if (!clip.text) missingText += 1;
  }
  if (clips.length > 0) {
    if (total > LONG_REF_MAX_SEC) {
      warnings.push(
        `日语长参考合计 ${total.toFixed(0)} 秒，超过上限 ${LONG_REF_MAX_SEC} 秒（服务端会截断到前 ${LONG_REF_MAX_SEC} 秒）`,
      );
    } else if (total < LONG_REF_SWEET_SPOT_SEC) {
      // 只是提示，不是错误：官方说 ~30s 已拿到大部分收益，不是硬门槛
      warnings.push(`日语长参考合计 ${total.toFixed(0)} 秒，官方建议 ~${LONG_REF_SWEET_SPOT_SEC} 秒（当前偏短）`);
    }
    if (missingText > 0) {
      warnings.push(`${missingText} 个日语长参考片段缺转写文本（Speaker Inversion 训练要用）`);
    }
  }

  return {
    ...record,
    exists,
    warnings,
    ref_clips_total_sec: Math.round(total * 10) / 10,
    ref_clips_missing_text: missingText,
  };
}

// --------------------------------------------------------------------------
// 对外操作
// --------------------------------------------------------------------------

export function listVoices(): VoiceView[] {
  return readIndex()
    .sort((a, b) => (b.updated_at || b.created_at) - (a.updated_at || a.created_at))
    .map(toView);
}

export function getVoice(id: string): VoiceView {
  const record = readIndex().find((item) => item.id === id);
  if (!record) {
    throw new VoiceLibraryError(404, 'VOICE_NOT_FOUND', `音色不存在：${id}`, '它可能已被删除，请刷新列表。');
  }
  return toView(record);
}

export function getVoiceAudioPath(id: string): string {
  const view = getVoice(id);
  if (!view.exists) {
    throw new VoiceLibraryError(404, 'VOICE_AUDIO_MISSING', `音色「${view.name}」的音频文件已丢失`, '请重新上传，或修正音色的音频路径。');
  }
  return view.audio_path;
}

export interface CreateVoiceInput {
  name: string;
  prompt_text?: string;
  prompt_lang?: string;
  note?: string;
  tags?: string[];
  /** 托管上传：音频字节 + 原始文件名 */
  content?: Buffer;
  filename?: string;
  /** 浏览器探测的音频元数据（Node 侧没有 soundfile，时长由前端解码后带上；可为空） */
  duration_s?: number | null;
  sample_rate?: number | null;
  /** 适用引擎标签（30-4）；不传则不写该字段（兼容铁律 1） */
  engine_tags?: string[];
}

/** 只在真的给了标签时才写 `engine_tags` 键（兼容铁律 1） */
function applyEngineTags(record: VoiceRecord, raw: string[] | undefined): void {
  if (!Array.isArray(raw)) return;
  const tags = normalizeEngineTags(raw);
  if (tags.length > 0) record.engine_tags = tags;
}

function newId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12);
}

export function createVoice(input: CreateVoiceInput): VoiceView {
  const name = (input.name ?? '').trim();
  if (!name) throw new VoiceLibraryError(400, 'VOICE_NAME_REQUIRED', '音色名称不能为空');
  const suffix = path.extname(input.filename ?? 'audio.wav').toLowerCase() || '.wav';
  if (!ALLOWED_SUFFIXES.has(suffix)) {
    throw new VoiceLibraryError(400, 'VOICE_FORMAT_UNSUPPORTED', `不支持的音频格式：${suffix}`, `可用格式：${[...ALLOWED_SUFFIXES].join('、')}`);
  }
  const content = input.content;
  if (!content || content.length === 0) {
    throw new VoiceLibraryError(400, 'VOICE_AUDIO_REQUIRED', '上传的音频内容为空');
  }
  if (content.length > MAX_UPLOAD_BYTES) {
    throw new VoiceLibraryError(400, 'VOICE_AUDIO_TOO_LARGE', `音频文件过大（${(content.length / 1024 / 1024).toFixed(1)} MB），上限 64 MB`);
  }
  const id = newId();
  const audioPath = path.join(AUDIO_DIR, `${id}${suffix}`);
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
  fs.writeFileSync(audioPath, content);

  const items = readIndex();
  const now = Date.now() / 1000;
  const record: VoiceRecord = {
    id,
    name,
    audio_path: audioPath,
    prompt_text: (input.prompt_text ?? '').trim(),
    prompt_lang: normalizePromptLang(input.prompt_lang),
    note: input.note ?? '',
    tags: input.tags ?? [],
    origin: 'managed',
    duration_s: input.duration_s ?? null,
    sample_rate: input.sample_rate ?? null,
    size_bytes: content.length,
    created_at: now,
    updated_at: now,
  };
  applyEngineTags(record, input.engine_tags);
  items.push(record);
  writeIndex(items);
  return toView(record);
}

/** 引用磁盘上已有的音频文件（不复制），与 trainer 的 /v1/voices/source 同语义 */
export function createVoiceFromPath(input: CreateVoiceInput & { audio_path: string }): VoiceView {
  const name = (input.name ?? '').trim();
  if (!name) throw new VoiceLibraryError(400, 'VOICE_NAME_REQUIRED', '音色名称不能为空');
  const source = input.audio_path.trim();
  if (!source || !isFile(source)) {
    throw new VoiceLibraryError(400, 'VOICE_PATH_MISSING', `指定的音频文件不存在：${source}`, '请填写本机绝对路径（相对路径不受支持）。');
  }
  const items = readIndex();
  const now = Date.now() / 1000;
  const record: VoiceRecord = {
    id: newId(),
    name,
    audio_path: source,
    prompt_text: (input.prompt_text ?? '').trim(),
    prompt_lang: normalizePromptLang(input.prompt_lang),
    note: input.note ?? '',
    tags: input.tags ?? [],
    origin: 'external',
    duration_s: input.duration_s ?? null,
    sample_rate: input.sample_rate ?? null,
    size_bytes: fs.statSync(source).size,
    created_at: now,
    updated_at: now,
  };
  applyEngineTags(record, input.engine_tags);
  items.push(record);
  writeIndex(items);
  return toView(record);
}

export interface UpdateVoicePatch {
  name?: string;
  prompt_text?: string;
  prompt_lang?: string;
  note?: string;
  tags?: string[];
  audio_path?: string;
  /** 适用引擎标签（30-4）。传空数组 = 清空标注 */
  engine_tags?: string[];
}

export function updateVoice(id: string, patch: UpdateVoicePatch): VoiceView {
  const items = readIndex();
  const record = items.find((item) => item.id === id);
  if (!record) {
    throw new VoiceLibraryError(404, 'VOICE_NOT_FOUND', `音色不存在：${id}`, '它可能已被删除，请刷新列表。');
  }
  if (patch.name != null && patch.name.trim()) record.name = patch.name.trim();
  if (patch.prompt_text != null) record.prompt_text = patch.prompt_text.trim();
  if (patch.prompt_lang != null) record.prompt_lang = normalizePromptLang(patch.prompt_lang);
  if (patch.note != null) record.note = patch.note;
  if (patch.tags != null) record.tags = patch.tags;
  if (patch.engine_tags != null) {
    const tags = normalizeEngineTags(patch.engine_tags);
    // 空数组 = 清空标注：**把键删掉**而不是留一个空数组（兼容铁律 1）
    if (tags.length > 0) record.engine_tags = tags;
    else delete record.engine_tags;
  }
  if (patch.audio_path != null) {
    if (!isFile(patch.audio_path)) {
      throw new VoiceLibraryError(400, 'VOICE_PATH_MISSING', `指定的音频文件不存在：${patch.audio_path}`);
    }
    record.audio_path = patch.audio_path;
    record.size_bytes = fs.statSync(patch.audio_path).size;
  }
  record.updated_at = Date.now() / 1000;
  writeIndex(items);
  return toView(record);
}

// --------------------------------------------------------------------------
// 日语长参考多片段（30-4）
// --------------------------------------------------------------------------

/** 片段数量上限：再多也不会被服务端全部用到（它按 max_ref_seconds 顺序截断） */
const MAX_REF_CLIPS = 24;

function loadVoiceForEdit(id: string): { items: VoiceRecord[]; record: VoiceRecord } {
  const items = readIndex();
  const record = items.find((item) => item.id === id);
  if (!record) {
    throw new VoiceLibraryError(404, 'VOICE_NOT_FOUND', `音色不存在：${id}`, '它可能已被删除，请刷新列表。');
  }
  return { items, record };
}

/**
 * 追加一个日语长参考片段。
 *
 * 为什么在这里**拒绝**超上限而不是像服务端那样截断：超过 `max_ref_seconds` 的片段
 * 永远不会被合成用到（Irodori 按顺序截断），存下来只是浪费磁盘 + 让 UI 显示的总时长
 * 与「实际生效的时长」不一致。宁可当场说清楚。
 */
export function addRefClip(
  id: string,
  content: Buffer,
  filename: string,
  probe: { duration_s?: number | null; sample_rate?: number | null; text?: string },
): VoiceView {
  if (!content || content.length === 0) {
    throw new VoiceLibraryError(400, 'REF_CLIP_EMPTY', '上传的片段内容为空');
  }
  if (content.length > MAX_UPLOAD_BYTES) {
    throw new VoiceLibraryError(400, 'REF_CLIP_TOO_LARGE', '片段文件过大，上限 64 MB');
  }
  const suffix = path.extname(filename || 'clip.wav').toLowerCase() || '.wav';
  if (!ALLOWED_SUFFIXES.has(suffix)) {
    throw new VoiceLibraryError(400, 'REF_CLIP_FORMAT_UNSUPPORTED', `不支持的音频格式：${suffix}`,
      `可用格式：${[...ALLOWED_SUFFIXES].join('、')}`);
  }
  const { items, record } = loadVoiceForEdit(id);
  const clips = record.ref_clips ?? [];
  if (clips.length >= MAX_REF_CLIPS) {
    throw new VoiceLibraryError(400, 'REF_CLIP_LIMIT', `片段数量已达上限 ${MAX_REF_CLIPS} 个`,
      '先删掉不用的片段再加；片段不是越多越好，官方建议合计 ~30 秒。');
  }
  const currentTotal = clips.reduce((sum, clip) => sum + (clip.dur_s ?? 0), 0);
  const incoming = probe.duration_s ?? 0;
  if (currentTotal + incoming > LONG_REF_MAX_SEC) {
    throw new VoiceLibraryError(
      400,
      'REF_CLIP_TOTAL_TOO_LONG',
      `加上这一片会达到 ${(currentTotal + incoming).toFixed(0)} 秒，超过上限 ${LONG_REF_MAX_SEC} 秒`,
      `官方建议合计 ~${LONG_REF_SWEET_SPOT_SEC} 秒（再多收益很小）；请先删掉一些片段或改用更短的素材。`,
    );
  }

  // 文件名带 voice id 前缀：一眼能看出归属，删除音色时也好一起清理
  let index = clips.length;
  let target = path.join(AUDIO_DIR, `${record.id}.ref${index}${suffix}`);
  while (isFile(target)) {
    index += 1;
    target = path.join(AUDIO_DIR, `${record.id}.ref${index}${suffix}`);
  }
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
  fs.writeFileSync(target, content);

  const clip: RefClip = {
    path: target,
    dur_s: probe.duration_s ?? null,
    sample_rate: probe.sample_rate ?? null,
    added_at: Date.now() / 1000,
  };
  const text = (probe.text ?? '').trim();
  if (text) clip.text = text;
  record.ref_clips = [...clips, clip];
  record.updated_at = Date.now() / 1000;
  writeIndex(items);
  return toView(record);
}

/** 改某片的转写文本（按索引，避免让调用方传路径） */
export function updateRefClip(id: string, index: number, patch: { text?: string }): VoiceView {
  const { items, record } = loadVoiceForEdit(id);
  const clips = record.ref_clips ?? [];
  if (!Number.isInteger(index) || index < 0 || index >= clips.length) {
    throw new VoiceLibraryError(404, 'REF_CLIP_NOT_FOUND', `片段序号越界：${index}（共 ${clips.length} 个）`);
  }
  const clip = clips[index];
  if (patch.text != null) {
    const text = patch.text.trim();
    // 清空转写 = 把键删掉（与 engine_tags 同一处理，保持磁盘干净）
    if (text) clip.text = text;
    else delete clip.text;
  }
  record.updated_at = Date.now() / 1000;
  writeIndex(items);
  return toView(record);
}

/** 删某片（同时删托管文件；外部路径只摘记录不动磁盘） */
export function removeRefClip(id: string, index: number): VoiceView {
  const { items, record } = loadVoiceForEdit(id);
  const clips = record.ref_clips ?? [];
  if (!Number.isInteger(index) || index < 0 || index >= clips.length) {
    throw new VoiceLibraryError(404, 'REF_CLIP_NOT_FOUND', `片段序号越界：${index}（共 ${clips.length} 个）`);
  }
  const [removed] = clips.splice(index, 1);
  if (clips.length > 0) record.ref_clips = clips;
  else delete record.ref_clips;
  record.updated_at = Date.now() / 1000;
  writeIndex(items);
  // 只删自己托管目录里的文件：用户通过 ref_path 引用的外部文件不碰
  if (removed && isFile(removed.path) && path.dirname(removed.path) === AUDIO_DIR) {
    try {
      fs.unlinkSync(removed.path);
    } catch {
      // 删不掉不影响正确性
    }
  }
  return toView(record);
}

/** 取某片的磁盘路径（试听用；越界或文件丢失都抛 404） */
export function getRefClipPath(id: string, index: number): string {
  const record = readIndex().find((item) => item.id === id);
  if (!record) {
    throw new VoiceLibraryError(404, 'VOICE_NOT_FOUND', `音色不存在：${id}`);
  }
  const clips = record.ref_clips ?? [];
  if (!Number.isInteger(index) || index < 0 || index >= clips.length) {
    throw new VoiceLibraryError(404, 'REF_CLIP_NOT_FOUND', `片段序号越界：${index}（共 ${clips.length} 个）`);
  }
  const clip = clips[index];
  if (!isFile(clip.path)) {
    throw new VoiceLibraryError(404, 'REF_CLIP_MISSING', `片段文件已丢失：${path.basename(clip.path)}`,
      '删掉这条片段记录，或重新上传。');
  }
  return clip.path;
}

export function replaceVoiceAudio(
  id: string,
  content: Buffer,
  filename: string,
  probe: { duration_s?: number | null; sample_rate?: number | null },
): VoiceView {
  if (!content || content.length === 0) {
    throw new VoiceLibraryError(400, 'VOICE_AUDIO_REQUIRED', '上传的音频内容为空');
  }
  if (content.length > MAX_UPLOAD_BYTES) {
    throw new VoiceLibraryError(400, 'VOICE_AUDIO_TOO_LARGE', '音频文件过大，上限 64 MB');
  }
  const suffix = path.extname(filename || 'audio.wav').toLowerCase() || '.wav';
  if (!ALLOWED_SUFFIXES.has(suffix)) {
    throw new VoiceLibraryError(400, 'VOICE_FORMAT_UNSUPPORTED', `不支持的音频格式：${suffix}`);
  }
  const items = readIndex();
  const record = items.find((item) => item.id === id);
  if (!record) {
    throw new VoiceLibraryError(404, 'VOICE_NOT_FOUND', `音色不存在：${id}`, '它可能已被删除，请刷新列表。');
  }
  const target = path.join(AUDIO_DIR, `${record.id}${suffix}`);
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
  fs.writeFileSync(target, content);
  const old = record.audio_path;
  record.audio_path = target;
  record.origin = 'managed';
  record.duration_s = probe.duration_s ?? null;
  record.sample_rate = probe.sample_rate ?? null;
  record.size_bytes = content.length;
  record.updated_at = Date.now() / 1000;
  writeIndex(items);
  // 旧的托管文件换名后就是垃圾（与 Python 侧 replace_audio 同规矩）
  if (old && old !== target && isFile(old)) {
    try {
      fs.unlinkSync(old);
    } catch {
      // 删不掉不影响正确性
    }
  }
  return toView(record);
}

export function deleteVoice(id: string): void {
  const items = readIndex();
  const index = items.findIndex((item) => item.id === id);
  if (index < 0) {
    throw new VoiceLibraryError(404, 'VOICE_NOT_FOUND', `音色不存在：${id}`, '它可能已被删除，请刷新列表。');
  }
  const [record] = items.splice(index, 1);
  writeIndex(items);
  if (record.origin === 'managed' && isFile(record.audio_path)) {
    try {
      fs.unlinkSync(record.audio_path);
    } catch {
      // 删不掉不影响正确性
    }
  }
  // 日语长参考片段：只删自己托管目录里的（30-4）
  for (const clip of record.ref_clips ?? []) {
    if (isFile(clip.path) && path.dirname(clip.path) === AUDIO_DIR) {
      try {
        fs.unlinkSync(clip.path);
      } catch {
        // 删不掉不影响正确性
      }
    }
  }
}

/** 存储位置摘要：给 /health 与设置页展示用 */
export function voiceLibSummary() {
  return {
    dir: VOICE_LIB_DIR,
    total: readIndex().length,
  };
}

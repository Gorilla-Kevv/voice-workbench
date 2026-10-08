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
}

export interface VoiceView extends VoiceRecord {
  exists: boolean;
  warnings: string[];
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
    items.push({
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
    });
  }
  return items;
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
  return { ...record, exists, warnings };
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
}

/** 存储位置摘要：给 /health 与设置页展示用 */
export function voiceLibSummary() {
  return {
    dir: VOICE_LIB_DIR,
    total: readIndex().length,
  };
}

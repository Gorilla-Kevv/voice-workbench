/**
 * 音色库「日语长参考多片段」验证（阶段 30-4，Node 侧）。
 *
 * 用法（必须在 server/ 目录下跑，express / tsx 在那里）：
 *     cd server && ./node_modules/.bin/tsx scripts/verify-voicelib.ts
 *
 * 设计取舍：
 * - **只挂 voicelibRouter 起一个最小 express**，不启真网关 —— 真网关会按
 *   RuntimeSupervisor 的 flag 连带拉起别的模型服务（坑 61），验证一个音色库
 *   接口不值得占显存；
 * - **音色库目录指向 `.tmp/voicelib-test/`**（在 import service 之前设
 *   `VOICES_LIB_DIR`，因为它在模块加载期求值）—— 绝不碰用户的真音色库。
 *
 * 覆盖：A 片段增删改查与校验 / B 磁盘形状兼容（旧记录不被塞新键）。
 * Python 侧的兼容断言在 `.tmp/verify_voicelib_py_compat.py`。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const TMP_LIB = path.join(REPO, '.tmp', 'voicelib-test');
const PORT = 18787;

// ⚠️ 必须在 import service 之前：VOICE_LIB_DIR 是模块级常量
process.env.VOICES_LIB_DIR = TMP_LIB;
fs.rmSync(TMP_LIB, { recursive: true, force: true });
fs.mkdirSync(path.join(TMP_LIB, 'voices'), { recursive: true });

const express = (await import('express')).default;
const { voicelibRouter } = await import('../src/routes/voicelib.js');

const INDEX = path.join(TMP_LIB, 'voices.json');
const AUDIO_DIR = path.join(TMP_LIB, 'voices');

let PASS = 0;
let FAIL = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    PASS += 1;
    console.log(`  ✓ ${name}`);
  } else {
    FAIL += 1;
    console.log(`  ✗ ${name}${detail ? `  <- ${detail}` : ''}`);
  }
}

/** 造一段静音 WAV（内容不重要，时长与格式是重点） */
function makeWav(seconds: number, sampleRate = 16000): Buffer {
  const frames = Math.round(seconds * sampleRate);
  const dataSize = frames * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

const app = express();
app.use('/api/voicelib', voicelibRouter);
const server = app.listen(PORT);
await new Promise((resolve) => server.once('listening', resolve));
const BASE = `http://127.0.0.1:${PORT}/api/voicelib`;

async function api(
  method: string,
  url: string,
  body?: Buffer | object,
  contentType = 'application/octet-stream',
): Promise<{ status: number; json: any; bytes: number }> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    if (Buffer.isBuffer(body)) {
      init.body = new Uint8Array(body);
      init.headers = { 'Content-Type': contentType };
    } else {
      init.body = JSON.stringify(body);
      init.headers = { 'Content-Type': 'application/json' };
    }
  }
  const res = await fetch(`${BASE}${url}`, init);
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, bytes: Buffer.byteLength(text) };
}

function readIndexRaw(): any[] {
  return JSON.parse(fs.readFileSync(INDEX, 'utf-8'));
}

function filesInAudioDir(): string[] {
  return fs.readdirSync(AUDIO_DIR).sort();
}

console.log('='.repeat(66));
console.log('A. 片段增删改查与校验（HTTP，最小 express）');
console.log('='.repeat(66));

const createRes = await api(
  'POST',
  '/?name=测试音色&filename=main.wav&duration_s=3.5&sample_rate=16000&prompt_text=あいうえお&prompt_lang=ja',
  makeWav(3.5),
);
check('A1 建音色 200', createRes.status === 200 && createRes.json?.ok === true, JSON.stringify(createRes.json)?.slice(0, 160));
const voiceId: string = createRes.json?.voice?.id ?? '';
check('A2 返回 id', typeof voiceId === 'string' && voiceId.length > 0, voiceId);
check('A3 旧形状：未传 engine_tags 就不带该键', createRes.json?.voice?.engine_tags === undefined,
  JSON.stringify(createRes.json?.voice?.engine_tags));
check('A4 新视图字段存在（总时长/缺转写数）',
  createRes.json?.voice?.ref_clips_total_sec === 0 && createRes.json?.voice?.ref_clips_missing_text === 0);

const clip1 = await api('POST', `/${voiceId}/ref-clips?filename=c1.wav&duration_s=10`, makeWav(10));
check('A5 追加片段 1 → 200', clip1.status === 200 && clip1.json?.ok === true, JSON.stringify(clip1.json)?.slice(0, 160));
check('A6 片段数 1 / 总时长 10', clip1.json?.voice?.ref_clips?.length === 1 && clip1.json?.voice?.ref_clips_total_sec === 10,
  JSON.stringify(clip1.json?.voice?.ref_clips_total_sec));

const clip2 = await api('POST', `/${voiceId}/ref-clips?filename=c2.wav&duration_s=15&text=こんにちは`, makeWav(15));
check('A7 追加片段 2（带转写）→ 长度 2', clip2.json?.voice?.ref_clips?.length === 2);
check('A8 总时长 25 秒', clip2.json?.voice?.ref_clips_total_sec === 25, String(clip2.json?.voice?.ref_clips_total_sec));
check('A9 缺转写计数 1（第一片没填）', clip2.json?.voice?.ref_clips_missing_text === 1,
  String(clip2.json?.voice?.ref_clips_missing_text));

const patchClip = await api('PATCH', `/${voiceId}/ref-clips/0`, { text: 'おはようございます' });
check('A10 改片段转写', patchClip.json?.voice?.ref_clips?.[0]?.text === 'おはようございます',
  JSON.stringify(patchClip.json?.voice?.ref_clips?.[0]));
check('A11 改完后缺转写计数 0', patchClip.json?.voice?.ref_clips_missing_text === 0);

const clipPath0: string = patchClip.json?.voice?.ref_clips?.[0]?.path ?? '';
const audioRes = await fetch(`${BASE}/${voiceId}/ref-clips/1/audio`);
const audioBuf = Buffer.from(await audioRes.arrayBuffer());
check('A12 试听片段 200 + 有字节', audioRes.status === 200 && audioBuf.length > 44,
  `status=${audioRes.status} bytes=${audioBuf.length}`);
check('A13 试听内容确是 WAV', audioBuf.subarray(0, 4).toString() === 'RIFF', audioBuf.subarray(0, 4).toString());

const oob = await api('GET', `/${voiceId}/ref-clips/9/audio`);
check('A14 越界片段 404', oob.status === 404, String(oob.status));

const tooLong = await api('POST', `/${voiceId}/ref-clips?filename=big.wav&duration_s=200`, makeWav(0.5));
check('A15 超总时长上限被拒 400', tooLong.status === 400, String(tooLong.status));
check('A16 错误码 REF_CLIP_TOTAL_TOO_LONG', tooLong.json?.error?.code === 'REF_CLIP_TOTAL_TOO_LONG',
  String(tooLong.json?.error?.code));
check('A17 被拒时不落文件（音频目录仍只有主音频 + 2 片）', filesInAudioDir().length === 3,
  JSON.stringify(filesInAudioDir()));

const delClip = await api('DELETE', `/${voiceId}/ref-clips/0`);
check('A18 删片段 → 长度 1', delClip.json?.voice?.ref_clips?.length === 1,
  String(delClip.json?.voice?.ref_clips?.length));
check('A19 被删片段的文件也从磁盘消失', !fs.existsSync(clipPath0), clipPath0);

const setTags = await api('PATCH', `/${voiceId}`, { engine_tags: ['Irodori', 'gsv', 'irodori'] });
check('A20 engine_tags 去重 + 小写化', JSON.stringify(setTags.json?.voice?.engine_tags) === JSON.stringify(['irodori', 'gsv']),
  JSON.stringify(setTags.json?.voice?.engine_tags));

const clearTags = await api('PATCH', `/${voiceId}`, { engine_tags: [] });
check('A21 清空 engine_tags → 键消失（不留空数组）', clearTags.json?.voice?.engine_tags === undefined,
  JSON.stringify(clearTags.json?.voice?.engine_tags));
const onDiskAfterClear = readIndexRaw().find((item) => item.id === voiceId);
check('A22 磁盘上该键也不存在', !('engine_tags' in onDiskAfterClear), JSON.stringify(Object.keys(onDiskAfterClear)));

const listed = await api('GET', '/');
const listedVoice = (listed.json?.voices ?? []).find((item: any) => item.id === voiceId);
check('A23 列表里带新视图字段', listedVoice?.ref_clips_total_sec === 15, String(listedVoice?.ref_clips_total_sec));

console.log();
console.log('='.repeat(66));
console.log('B. 磁盘形状兼容（旧记录不被塞新键）');
console.log('='.repeat(66));

// 造一条「30-4 之前」形状的记录：只有老字段
const legacyId = 'legacy000001';
const items = readIndexRaw();
items.push({
  id: legacyId,
  name: '旧记录',
  audio_path: path.join(AUDIO_DIR, 'legacy.wav'),
  prompt_text: 'てすと',
  prompt_lang: 'ja',
  note: '',
  tags: [],
  origin: 'managed',
  duration_s: 4,
  sample_rate: 16000,
  size_bytes: 100,
  created_at: 1,
  updated_at: 1,
});
fs.writeFileSync(path.join(AUDIO_DIR, 'legacy.wav'), makeWav(4));
fs.writeFileSync(INDEX, JSON.stringify(items, null, 2), 'utf-8');
const beforeKeys = Object.keys(readIndexRaw().find((item) => item.id === legacyId)!).sort();

const patchNote = await api('PATCH', `/${legacyId}`, { note: '改一下备注' });
check('B1 改旧记录的备注 → 200', patchNote.status === 200);
const afterKeys = Object.keys(readIndexRaw().find((item) => item.id === legacyId)!).sort();
check('B2 磁盘键集**完全不变**（没被塞 ref_clips/engine_tags/speaker_embeds）',
  JSON.stringify(beforeKeys) === JSON.stringify(afterKeys),
  `before=${JSON.stringify(beforeKeys)} after=${JSON.stringify(afterKeys)}`);
check('B3 备注确实写进去了', readIndexRaw().find((item) => item.id === legacyId)!.note === '改一下备注');

const legacyAddClip = await api('POST', `/${legacyId}/ref-clips?filename=lc.wav&duration_s=5`, makeWav(5));
check('B4 给旧记录加片段 → 只有 ref_clips 这一个新键',
  legacyAddClip.json?.voice?.ref_clips?.length === 1
  && JSON.stringify(Object.keys(readIndexRaw().find((item) => item.id === legacyId)!).sort())
    === JSON.stringify([...beforeKeys, 'ref_clips'].sort()),
  JSON.stringify(Object.keys(readIndexRaw().find((item) => item.id === legacyId)!).sort()));

console.log();
console.log('='.repeat(66));
console.log('C. 删除音色时清理片段');
console.log('='.repeat(66));

const clipPath = readIndexRaw().find((item) => item.id === voiceId)!.ref_clips[0].path;
check('C0 删除前片段文件在', fs.existsSync(clipPath), clipPath);
const del = await api('DELETE', `/${voiceId}`);
check('C1 删除音色 200', del.status === 200, String(del.status));
check('C2 主音频与片段文件都被清理', !fs.existsSync(clipPath) && !fs.existsSync(path.join(AUDIO_DIR, 'main.wav')),
  JSON.stringify(filesInAudioDir()));
check('C3 索引里不再有该音色', !readIndexRaw().some((item) => item.id === voiceId));

server.close();
await new Promise((resolve) => server.once('close', resolve));
fs.rmSync(TMP_LIB, { recursive: true, force: true });

console.log();
console.log('='.repeat(66));
console.log(`结果：${PASS} 通过 / ${FAIL} 失败`);
console.log('='.repeat(66));
process.exit(FAIL ? 1 : 0);

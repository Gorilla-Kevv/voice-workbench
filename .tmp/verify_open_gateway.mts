/**
 * 能力网关冒烟（阶段 43）：死端口 + 内置假上游，不吃显存、不碰真实服务。
 * 跑法：cd server && node_modules/.bin/tsx ../.tmp/verify_open_gateway.mts
 */
import http from 'node:http';
import assert from 'node:assert';

// 让 mimo 走「无密钥」分支，避免冒烟里真发出云端请求（dotenv 不会覆盖已设环境变量）
process.env.MIMO_API_KEY = '';

const { openRouter, capabilitiesHandler } = await import('../server/src/routes/open.js');
const { CAPABILITIES, capabilityAvailability, findCapability } = await import('../server/src/services/capabilityCatalog.js');
const { requestUpstream } = await import('../server/src/services/openClients.js');
// .tmp 在仓库根，包解析要显式锚到 server 的 node_modules
import { createRequire } from 'node:module';
const requireFromServer = createRequire(new URL('../server/package.json', import.meta.url));
const express = requireFromServer('express') as typeof import('express');

let ok = 0;
const failed: string[] = [];
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { ok++; console.log('PASS', name); } else { failed.push(name); console.log('FAIL', name, detail); }
}

// ---------------------------------------------------------------- 单元：能力表
// 新增能力（如阶段 48 的 cosyvoice3-tts）要同步这三个数：总数、tts 数、M1/P1 的数组长度。
const EXPECTED_TOTAL = 14;
const EXPECTED_TTS = 7;
check(`C1 能力项数量 = ${EXPECTED_TOTAL}`, CAPABILITIES.length === EXPECTED_TOTAL, String(CAPABILITIES.length));
const byKind = Object.groupBy(CAPABILITIES, (c) => c.kind) as Record<string, typeof CAPABILITIES>;
check(`C2 kind 覆盖 tts${EXPECTED_TTS}/asr4/vc1/svc1/separation1`,
  byKind.tts?.length === EXPECTED_TTS && byKind.asr?.length === 4 && byKind.vc?.length === 1 && byKind.svc?.length === 1 && byKind.separation?.length === 1);
const ids = new Set<string>();
const aliases = new Set<string>();
let collision = false;
for (const cap of CAPABILITIES) {
  if (ids.has(cap.id)) collision = true;
  ids.add(cap.id);
  for (const alias of cap.aliases) {
    if (aliases.has(alias) || ids.has(alias)) collision = true;
    aliases.add(alias);
  }
}
check('C3 id 与别名无冲突', !collision);
check('C4 findCapability 大小写不敏感 + 别名命中',
  findCapability('Confucius4-TTS')?.id === 'confucius4-tts' && findCapability('netease-tts')?.id === 'confucius4-tts');
check('C5 每个本地能力都有 arbiter_engine，mimo 为 null',
  CAPABILITIES.every((c) => (c.runtime === 'mimo') === (c.arbiter_engine === null)));

// ---- 能力可用性：运行时可达 + ASR 固定模型权重就绪（阶段 44补2）
const asrModels = {
  'paraformer-zh': { weights_ready: true, weights_source: 'local', runtime_ready: true, vram_required_mb: 2048 },
  'iic/SenseVoiceSmall': { weights_ready: false, weights_source: 'missing', runtime_ready: true, vram_required_mb: 1536 },
};
const senseSpec = CAPABILITIES.find((c) => c.id === 'sensevoice-small');
const paraSpec = CAPABILITIES.find((c) => c.id === 'paraformer-zh');
const whisperSpec = CAPABILITIES.find((c) => c.id === 'faster-whisper');
check('C6 SenseVoice 权重未就绪 → available=false / vram=1536',
  Boolean(senseSpec) && capabilityAvailability(senseSpec!, true, asrModels, 2048).available === false
    && capabilityAvailability(senseSpec!, true, asrModels, 2048).vram_required_mb === 1536
    && capabilityAvailability(senseSpec!, true, asrModels, 2048).weights_ready === false);
check('C7 Paraformer 权重就绪 → available=true / vram=2048',
  Boolean(paraSpec) && capabilityAvailability(paraSpec!, true, asrModels, 2048).available === true
    && capabilityAvailability(paraSpec!, true, asrModels, 2048).vram_required_mb === 2048);
check('C8 faster-whisper 无固定权重 → 仍按运行时可达（weights_ready=null）',
  Boolean(whisperSpec) && capabilityAvailability(whisperSpec!, true, {}, 2048).available === true
    && capabilityAvailability(whisperSpec!, true, {}, 2048).weights_ready === null);
check('C9 ASR 能力声明 weights_key / SenseVoice 不再固定 size',
  senseSpec?.weights_key === 'iic/SenseVoiceSmall'
    && paraSpec?.weights_key === 'paraformer-zh'
    && !('size' in (senseSpec?.fixed_params ?? {})));
check('C10 权重就绪但专用运行时缺失 → available=false',
  Boolean(senseSpec) && capabilityAvailability(
    senseSpec!,
    true,
    { 'iic/SenseVoiceSmall': { weights_ready: true, runtime_ready: false, vram_required_mb: 1536 } },
    2048,
  ).available === false);

// ---------------------------------------------------------------- 单元：上游客户端
const fakeUpstream = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk: Buffer) => { body += chunk.toString('utf8'); });
  req.on('end', () => {
    if (req.url === '/structured-fail') {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: { code: 'VRAM_INSUFFICIENT', message: '空闲显存不足', retryable: true, hint: '先关浏览器' } }));
      return;
    }
    if (req.url === '/plain-fail') {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('boom');
      return;
    }
    const contentType = String(req.headers['content-type'] ?? '');
    const isMultipart = contentType.startsWith('multipart/form-data; boundary=');
    const hasField = isMultipart && body.includes('name="ref_path"');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, saw_multipart: isMultipart, saw_field: hasField, saw_json: contentType === 'application/json' }));
  });
});
await new Promise<void>((resolve) => fakeUpstream.listen(0, '127.0.0.1', resolve));
const fakePort = (fakeUpstream.address() as { port: number }).port;
const fakeBase = `http://127.0.0.1:${fakePort}`;

const good = await requestUpstream(fakeBase, 'fake', { path: '/ok', json: { a: 1 } });
check('U1 JSON 请求成功解析', good.ok && good.data.saw_json === true);
const goodForm = await requestUpstream(fakeBase, 'fake', { path: '/ok', formFields: { ref_path: 'F:/x.wav', text: '你好' } });
check('U2 form 请求转 multipart 文本字段', goodForm.ok && goodForm.data.saw_multipart === true && goodForm.data.saw_field === true);
const structured = await requestUpstream(fakeBase, 'fake', { path: '/structured-fail' });
check('U3 结构化错误原样透传（含 hint）', !structured.ok && structured.status === 503 && structured.body.error.code === 'VRAM_INSUFFICIENT' && structured.body.error.hint === '先关浏览器');
const plain = await requestUpstream(fakeBase, 'fake', { path: '/plain-fail' });
check('U4 非结构化错误包 OPEN_UPSTREAM_ERROR', !plain.ok && plain.body.error.code === 'OPEN_UPSTREAM_ERROR');
let unreachable = false;
try { await requestUpstream('http://127.0.0.1:1', 'dead', { path: '/x', timeoutMs: 2000 }); } catch (error) { unreachable = String((error as Error).name) === 'RuntimeUnreachableError'; }
check('U5 死端口 → RuntimeUnreachableError', unreachable);
fakeUpstream.close();

// ---------------------------------------------------------------- 集成：挂在真实 express 上
const app = express();
app.use(express.json({ limit: '2mb' }));
app.get('/api/capabilities', capabilitiesHandler);
app.use('/api/open', openRouter);
app.use((await import('../server/src/middleware/errorHandler.js')).errorHandler);
const server = http.createServer(app);
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any; contentType: string }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const contentType = res.headers.get('content-type') ?? '';
  const json = contentType.includes('json') ? await res.json() : null;
  return { status: res.status, json, contentType };
}

// 五个本地运行时全部死端口（真实 config 指向 9881~9885，未启动）
const models = await call('GET', '/api/open/v1/models');
check('M1 models 形状 = OpenAI list', models.json?.object === 'list' && Array.isArray(models.json?.data) && models.json.data.length === EXPECTED_TOTAL);
check('M2 每项有 id/object/owned_by/kind/available',
  models.json.data.every((m: any) => m.id && m.object === 'model' && typeof m.owned_by === 'string' && m.kind && typeof m.available === 'boolean'));
check('M3 本地运行时未启动 → available=false', models.json.data.filter((m: any) => m.owned_by !== 'voice-workbench/mimo').every((m: any) => m.available === false));

const caps = await call('GET', '/api/capabilities');
check(`P1 capabilities ${EXPECTED_TOTAL} 项 + 端点指引`, caps.json?.ok === true && caps.json.capabilities.length === EXPECTED_TOTAL && caps.json.capabilities.every((c: any) => typeof c.endpoint === 'string' && c.endpoint.startsWith('POST /api/open/')));
check('P2 实时状态字段齐（available/weights_ready/loaded/vram_required_mb/vram_source/hint）',
  caps.json.capabilities.every((c: any) => typeof c.available === 'boolean'
    && (c.weights_ready === null || typeof c.weights_ready === 'boolean')
    && (c.weights_source === null || typeof c.weights_source === 'string')
    && (c.runtime_ready === null || typeof c.runtime_ready === 'boolean')
    && (c.loaded === null || typeof c.loaded === 'boolean')
    && (c.vram_required_mb === null || typeof c.vram_required_mb === 'number')
    && typeof c.vram_source === 'string' && typeof c.hint === 'string'));
check('P3 全部不可达时 vram_free_mb = null', caps.json.vram_free_mb === null);

const unknown = await call('POST', '/api/open/v1/audio/speech', { model: 'no-such', text: 'x' });
check('E1 未知模型 → 400 + 受支持清单', unknown.status === 400 && unknown.json.error.code === 'INVALID_REQUEST' && Array.isArray(unknown.json.error.details?.supported));

const noRef = await call('POST', '/api/open/v1/audio/speech', { model: 'confucius4-tts', text: '你好' });
check('E2 缺参考音频 → 400 + hint', noRef.status === 400 && noRef.json.error.code === 'INVALID_REQUEST' && typeof noRef.json.error.hint === 'string');

const deadEngine = await call('POST', '/api/open/v1/audio/speech', { model: 'confucius4-tts', text: '你好', ref_path: 'F:/nonexistent.wav' });
check('E3 引擎不可达 → 503 OPEN_RUNTIME_UNREACHABLE + hint', deadEngine.status === 503 && deadEngine.json.error.code === 'OPEN_RUNTIME_UNREACHABLE' && typeof deadEngine.json.error.hint === 'string');

const noVoice = await call('POST', '/api/open/v1/audio/speech', { model: 'gpt-sovits-v2proplus', text: '你好', voice_id: '__no_such_voice__' });
check('E4 voice_id 不存在 → 404 VOICE_NOT_FOUND（音色库结构化错误透传）', noVoice.status === 404 && noVoice.json.error.code === 'VOICE_NOT_FOUND');

const noModel = await call('POST', '/api/open/v1/audio/convert', { model: 'rvc-convert', audio_path: 'F:/x.wav' });
check('E5 RVC 缺 params.model → 400', noModel.status === 400 && noModel.json.error.code === 'INVALID_REQUEST' && noModel.json.error.message.includes('params.model'));

const uvrNoModel = await call('POST', '/api/open/v1/audio/separate', { model: 'uvr5-separate', audio_path: 'F:/x.wav' });
check('E6 UVR5 不需要 model → 走到上游（503 不可达而非 400）', uvrNoModel.status === 503 && uvrNoModel.json.error.code === 'OPEN_RUNTIME_UNREACHABLE');

const asr = await call('POST', '/api/open/v1/audio/transcriptions', { model: 'r2t2-offline', audio_path: 'F:/x.wav' });
check('E7 转写死端口 → 503 透传', asr.status === 503 && asr.json.error.code === 'OPEN_RUNTIME_UNREACHABLE');

const kindMismatch = await call('POST', '/api/open/v1/audio/speech', { model: 'rvc-convert', text: 'x' });
check('E8 kind 不匹配 → 400', kindMismatch.status === 400);

const mimo = await call('POST', '/api/open/v1/audio/speech', {
  model: 'mimo', text: '你好',
  // design 模式必须先过 instruction 校验，才会走到密钥检查（不传会被 400 VOICE_DESCRIPTION_REQUIRED 拦下）
  params: { mode: 'design', instruction: '温柔的声线' },
});
check('E9 mimo 无密钥 → MISSING_API_KEY（不发真实云端请求）', mimo.status === 401 && mimo.json.error.code === 'MISSING_API_KEY');

server.close();
console.log(failed.length === 0 ? `\nALL ${ok} CHECKS PASSED` : `\nFAILED ${failed.length}: ${failed.join(', ')}`);
process.exit(failed.length === 0 ? 0 : 1);

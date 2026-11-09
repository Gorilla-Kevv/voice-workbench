#!/usr/bin/env node
/**
 * say：给 Agent / 终端用的薄 CLI 包装。
 *
 *   node scripts/say.mjs --model gpt-sovits-v2proplus --voice <id> --text "你好" --out out.wav
 *   node scripts/say.mjs batch --voice <id> --file lines.txt --out-dir say-out
 *
 * 单条走网关 Open API（/api/open/v1/audio/speech），批量走 trainer 透传
 * （/api/sovits/v1/tts/batch + /v1/jobs/:id），不引入新的后端逻辑。
 *
 * 输出纪律：stdout 永远只有一段 JSON（方便 Agent 解析），进度/提示走 stderr。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_BASE_URL = process.env.SAY_BASE_URL || process.env.WORKBENCH_BASE_URL || 'http://127.0.0.1:8787';
const DEFAULT_TIMEOUT_SINGLE_SEC = 900;
const DEFAULT_TIMEOUT_BATCH_SEC = 3600;
const DEFAULT_POLL_MS = 1200;

const HELP = `say —— 本地语音工作台 CLI（单条 / 批量）

用法：
  node scripts/say.mjs [选项]                         单条合成（Open API）
  node scripts/say.mjs batch [选项]                   批量合成（GPT-SoVITS 批量接口）
  node scripts/say.mjs batch --plan [选项]            只展开条目，不合成

单条：
  --model <id>          能力 id（必填），如 gpt-sovits-v2proplus / confucius4-tts /
                        indextts-2.5 / irodori-tts / gpt-sovits-v5 / mimo
  --text <text>         合成文本；传 - 从 stdin 读取（--text-file 亦可）
  --voice <id>          音色库 id（推荐）
  --ref-path <path>     服务端绝对路径（与 --voice 二选一）
  --lang <code>         快捷语种（zh/ja/en...）
  --out <file>          输出文件，默认 ./say-<时间戳>.wav
  --params <json>       引擎专属参数（白名单透传），如 '{"version":"v2ProPlus"}'
  --prompt-text <text>  参考文本（裸路径时必需，按引擎要求）
  --prompt-lang <code>  参考文本语种
  --text-lang <code>    合成文本语种
  --version/--gpt/--sovits <value>  GPT-SoVITS 权重快捷参数
  --focus               true = 先让网关仲裁卸载其它引擎（单条专用）
  --timeout <秒>        请求超时，默认 ${DEFAULT_TIMEOUT_SINGLE_SEC}

批量：
  --text <text> / --text-file <file> / --file <file>   整段文本按非空行切分（- = stdin）
  --items <json>        直接给 [{index?,key?,text}] 数组（与 --file 互斥）
  --voice <id> / --ref-path <path> + --prompt-text/--prompt-lang
  --text-lang <code>
  --version/--gpt/--sovits <value>
  --filename-template <tpl>  默认 {index:03d}-{key}
  --no-zip              不生成 ZIP
  --stop-on-error       单条失败即停止（默认继续）
  --plan                只展开条目并打印，不提交合成
  --sync                同步等待（默认异步 + 轮询）
  --out-dir <dir>       下载目录，默认 ./say-out/<job_id>
  --no-download         只打印结果清单，不下载音频
  --zip                 额外下载服务端 ZIP
  --allow-failures      有条目失败也返回退出码 0
  --poll-ms <ms>        轮询间隔，默认 ${DEFAULT_POLL_MS}
  --timeout <秒>        整批超时，默认 ${DEFAULT_TIMEOUT_BATCH_SEC}

通用：
  --base-url <url>      网关地址，默认 ${DEFAULT_BASE_URL}
  --help                显示本帮助
`;

class CliError extends Error {
  constructor(message, { code = 'CLI_ERROR', status = 0, hint = '', details } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.hint = hint;
    this.details = details;
  }
}

function parseArgs(argv) {
  const result = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      result._.push(arg);
      continue;
    }
    let key = arg.slice(2);
    let value;
    const eq = key.indexOf('=');
    if (eq >= 0) {
      value = key.slice(eq + 1);
      key = key.slice(0, eq);
    }
    if (key.startsWith('no-')) {
      result[key.slice(3)] = false;
      continue;
    }
    if (value === undefined && i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      value = argv[++i];
    }
    result[key] = value === undefined ? true : value;
  }
  return result;
}

function str(args, key) {
  const value = args[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function num(args, key, fallback) {
  const value = str(args, key);
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new CliError(`--${key} 需要正数，收到：${value}`, { code: 'BAD_ARG' });
  }
  return parsed;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

async function readTextArg(args, inlineKey, ...fileKeys) {
  const inline = str(args, inlineKey);
  if (inline !== undefined) return inline === '-' ? readStdin() : inline;
  for (const fileKey of fileKeys) {
    const file = str(args, fileKey);
    if (file === undefined) continue;
    if (file === '-') return readStdin();
    if (!existsSync(file)) throw new CliError(`文件不存在：${file}`, { code: 'BAD_ARG' });
    return readFileSync(file, 'utf8');
  }
  return undefined;
}

function parseParams(raw) {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') throw new CliError('--params 需要 JSON 字符串', { code: 'BAD_ARG' });
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new CliError(`--params 不是合法 JSON：${error.message}`, { code: 'BAD_ARG' });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CliError('--params 必须是 JSON 对象', { code: 'BAD_ARG' });
  }
  return parsed;
}

function buildBaseUrl(raw) {
  return (raw || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function resolveArtifactUrl(baseUrl, url) {
  if (!url) return null;
  if (/^https?:/i.test(url) || url.startsWith('blob:') || url.startsWith('data:')) return url;
  if (url.startsWith('/api/')) return `${baseUrl}${url}`;
  return `${baseUrl}/api/sovits${url.startsWith('/') ? '' : '/'}${url}`;
}

async function requestJson(baseUrl, route, { method = 'GET', body, timeoutMs = 60_000, label = route } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(`${baseUrl}${route}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new CliError(`${label} 超时（${Math.round(timeoutMs / 1000)}s）`, {
        code: 'TIMEOUT',
        hint: '长任务请用批量异步模式，或调大 --timeout。',
      });
    }
    throw new CliError(`无法连接网关 ${baseUrl}：${error.message}`, {
      code: 'GATEWAY_UNREACHABLE',
      hint: '先运行 npm run dev:server（或 npm run dev），确认 http://127.0.0.1:8787 可访问。',
    });
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  if (!response.ok) {
    const detail = data?.error ?? data;
    throw new CliError(detail?.message || `${label} 返回 HTTP ${response.status}`, {
      code: detail?.code || `HTTP_${response.status}`,
      status: response.status,
      hint: detail?.hint || '',
      details: detail?.details,
    });
  }
  return data;
}

async function downloadFile(url, target) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new CliError(`下载失败 HTTP ${response.status}：${url}`, { code: 'DOWNLOAD_FAILED' });
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, buffer);
  return buffer.length;
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function pickErrorMessage(error) {
  if (error instanceof CliError) {
    return {
      ok: false,
      error: {
        code: error.code,
        status: error.status || undefined,
        message: error.message,
        hint: error.hint || undefined,
        details: error.details || undefined,
      },
    };
  }
  return { ok: false, error: { code: 'UNEXPECTED', message: String(error?.stack || error) } };
}

// ------------------------------------------------------------------ 单条

async function runSingle(args, baseUrl) {
  const model = str(args, 'model');
  if (!model) throw new CliError('缺少 --model', { code: 'BAD_ARG', hint: '示例：--model gpt-sovits-v2proplus' });

  let text = await readTextArg(args, 'text', 'text-file');
  if (!text || !text.trim()) throw new CliError('缺少 --text 或 --text-file', { code: 'BAD_ARG' });
  text = text.trim();

  const voice = str(args, 'voice');
  const refPath = str(args, 'ref-path');
  if (!voice && !refPath && model !== 'mimo') {
    throw new CliError('缺少 --voice 或 --ref-path', {
      code: 'BAD_ARG',
      hint: '推荐用音色库 id；裸路径需要同时给 --prompt-text/--prompt-lang（按引擎要求）。',
    });
  }

  const params = parseParams(args.params) ?? {};
  for (const [flag, key] of [
    ['prompt-text', 'prompt_text'],
    ['prompt-lang', 'prompt_lang'],
    ['text-lang', 'text_lang'],
    ['version', 'version'],
    ['gpt', 'gpt'],
    ['sovits', 'sovits'],
  ]) {
    const value = str(args, flag);
    if (value !== undefined && params[key] === undefined) params[key] = value;
  }

  const timeoutSec = num(args, 'timeout', DEFAULT_TIMEOUT_SINGLE_SEC);
  const out = str(args, 'out') || path.resolve(`say-${timestamp()}.wav`);

  const payload = {
    model,
    text,
    format: 'json',
    timeout_ms: Math.round(timeoutSec * 1000),
    ...(voice ? { voice_id: voice } : {}),
    ...(refPath ? { ref_path: refPath } : {}),
    ...(str(args, 'lang') ? { lang: str(args, 'lang') } : {}),
    ...(Object.keys(params).length ? { params } : {}),
    ...(args.focus === true ? { focus: true } : {}),
  };

  process.stderr.write(`[say] ${model} 合成中…\n`);
  const data = await requestJson(baseUrl, '/api/open/v1/audio/speech', {
    method: 'POST',
    body: payload,
    timeoutMs: (timeoutSec + 30) * 1000,
    label: '单条合成',
  });
  if (!data?.audio_base64) {
    throw new CliError('响应里没有 audio_base64', { code: 'EMPTY_AUDIO' });
  }

  const buffer = Buffer.from(data.audio_base64, 'base64');
  mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  writeFileSync(out, buffer);

  const extraFiles = [];
  if (Array.isArray(data.extra_segments_base64) && data.extra_segments_base64.length) {
    const parsed = path.parse(path.resolve(out));
    data.extra_segments_base64.forEach((segment, index) => {
      const extra = path.join(parsed.dir, `${parsed.name}.part${index + 2}.wav`);
      writeFileSync(extra, Buffer.from(segment, 'base64'));
      extraFiles.push(extra);
    });
  }

  printJson({
    ok: true,
    model: data.model ?? model,
    out: path.resolve(out),
    bytes: buffer.length,
    sample_rate: data.sample_rate ?? null,
    duration_sec: data.duration_sec ?? null,
    elapsed_sec: data.elapsed_sec ?? null,
    ...(extraFiles.length ? { extra_files: extraFiles } : {}),
  });
}

// ------------------------------------------------------------------ 批量

function buildBatchPayload(args, text) {
  const itemsRaw = str(args, 'items');
  let items;
  if (itemsRaw) {
    if (!existsSync(itemsRaw)) throw new CliError(`items 文件不存在：${itemsRaw}`, { code: 'BAD_ARG' });
    try {
      items = JSON.parse(readFileSync(itemsRaw, 'utf8'));
    } catch (error) {
      throw new CliError(`items JSON 解析失败：${error.message}`, { code: 'BAD_ARG' });
    }
    if (!Array.isArray(items)) throw new CliError('items JSON 必须是数组', { code: 'BAD_ARG' });
  }

  if (!items && !text?.trim()) {
    throw new CliError('缺少批量文本：--text / --text-file / --file / --items', { code: 'BAD_ARG' });
  }

  const payload = {
    ...(items ? { items } : { text }),
    ...(str(args, 'voice') ? { voice: str(args, 'voice') } : {}),
    ...(str(args, 'ref-path') ? { ref_audio_path: str(args, 'ref-path') } : {}),
    ...(str(args, 'prompt-text') ? { prompt_text: str(args, 'prompt-text') } : {}),
    ...(str(args, 'prompt-lang') ? { prompt_lang: str(args, 'prompt-lang') } : {}),
    ...(str(args, 'text-lang') ? { text_lang: str(args, 'text-lang') } : {}),
    ...(str(args, 'version') ? { version: str(args, 'version') } : {}),
    ...(str(args, 'gpt') ? { gpt: str(args, 'gpt') } : {}),
    ...(str(args, 'sovits') ? { sovits: str(args, 'sovits') } : {}),
    ...(str(args, 'filename-template') ? { filename_template: str(args, 'filename-template') } : {}),
    make_zip: args.zip !== false,
    continue_on_error: args['stop-on-error'] !== true,
  };
  const params = parseParams(args.params);
  if (params) payload.params = params;
  return payload;
}

async function pollJob(baseUrl, jobId, { pollMs, deadline }) {
  let lastLine = '';
  for (;;) {
    if (Date.now() > deadline) {
      throw new CliError(`任务 ${jobId} 等待超时`, {
        code: 'TIMEOUT',
        hint: `任务仍在服务端运行，可稍后用 GET /api/sovits/v1/jobs/${jobId} 查看。`,
      });
    }
    const data = await requestJson(baseUrl, `/api/sovits/v1/jobs/${jobId}`, {
      timeoutMs: 30_000,
      label: '任务轮询',
    });
    const job = data?.job ?? data;
    const state = job?.state ?? 'unknown';
    const progress = typeof job?.progress === 'number' ? Math.round(job.progress * 100) : null;
    const line = `[job ${jobId}] ${state}${progress === null ? '' : ` ${progress}%`}${job?.message ? ` · ${job.message}` : ''}`;
    if (line !== lastLine) {
      process.stderr.write(`${line}\n`);
      lastLine = line;
    }
    if (state === 'succeeded' || state === 'failed' || state === 'cancelled') return job;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

async function runBatch(args, baseUrl) {
  const text = await readTextArg(args, 'text', 'file', 'text-file');
  const payload = buildBatchPayload(args, text);

  if (args.plan === true) {
    const data = await requestJson(baseUrl, '/api/sovits/v1/tts/batch/plan', {
      method: 'POST',
      body: payload,
      timeoutMs: 60_000,
      label: '批量展开',
    });
    printJson({ ok: true, plan: true, total: data.total, items: data.items });
    return;
  }

  const timeoutSec = num(args, 'timeout', DEFAULT_TIMEOUT_BATCH_SEC);
  const deadline = Date.now() + Math.round(timeoutSec * 1000);
  const pollMs = num(args, 'poll-ms', DEFAULT_POLL_MS);
  const sync = args.sync === true;

  process.stderr.write(`[say] 提交批量合成…\n`);
  const submitted = await requestJson(baseUrl, '/api/sovits/v1/tts/batch', {
    method: 'POST',
    body: { ...payload, wait: sync },
    timeoutMs: sync ? Math.round(timeoutSec * 1000) : 120_000,
    label: '批量提交',
  });

  let jobId = submitted?.job_id;
  let artifacts;
  let state = submitted?.state ?? 'unknown';

  if (sync) {
    // 同步模式：响应本身就是 _batch_response（artifacts 已铺平）
    artifacts = submitted;
    jobId = jobId ?? 'sync';
  } else {
    if (!jobId) throw new CliError('批量提交没有返回 job_id', { code: 'BAD_RESPONSE' });
    const job = await pollJob(baseUrl, jobId, { pollMs, deadline });
    state = job.state;
    if (state === 'failed') {
      throw new CliError(job.error || '批量任务失败', {
        code: 'BATCH_FAILED',
        hint: `查看任务：GET /api/sovits/v1/jobs/${jobId}`,
      });
    }
    if (state === 'cancelled') {
      throw new CliError('批量任务已取消', { code: 'BATCH_CANCELLED' });
    }
    artifacts = job.artifacts ?? {};
  }

  const results = Array.isArray(artifacts.results) ? artifacts.results : [];
  const okRows = results.filter((item) => item.ok);
  const failedRows = results.filter((item) => !item.ok);

  const outDirArg = str(args, 'out-dir');
  const outDir = outDirArg ? path.resolve(outDirArg) : path.resolve('say-out', String(jobId));
  const files = [];
  let zipPath = null;
  let manifestPath = null;

  if (args.download !== false && okRows.length) {
    mkdirSync(outDir, { recursive: true });
    process.stderr.write(`[say] 下载 ${okRows.length} 条音频到 ${outDir}\n`);
    for (const item of okRows) {
      const url = resolveArtifactUrl(baseUrl, item.audio_url);
      if (!url) continue;
      const name = path.basename(item.filename || `item-${String(item.index + 1).padStart(3, '0')}.wav`);
      const target = path.join(outDir, name);
      const bytes = await downloadFile(url, target);
      files.push({
        index: item.index,
        filename: name,
        path: target,
        bytes,
        duration_s: item.duration_s ?? null,
      });
    }
  }

  if (args.download !== false && artifacts.manifest_url) {
    const url = resolveArtifactUrl(baseUrl, artifacts.manifest_url);
    manifestPath = path.join(outDir, 'manifest.json');
    await downloadFile(url, manifestPath);
  }

  if (args.zip === true && artifacts.zip_url) {
    const url = resolveArtifactUrl(baseUrl, artifacts.zip_url);
    zipPath = path.join(outDir, 'batch.zip');
    await downloadFile(url, zipPath);
  }

  const summary = {
    ok: failedRows.length === 0,
    job_id: jobId,
    state,
    total: results.length || artifacts.total || null,
    succeeded: okRows.length,
    failed: failedRows.length,
    out_dir: files.length || zipPath || manifestPath ? outDir : null,
    files,
    ...(manifestPath ? { manifest_path: manifestPath } : {}),
    ...(zipPath ? { zip_path: zipPath } : {}),
    failures: failedRows.map((item) => ({
      index: item.index,
      text: item.text,
      error: item.error,
      hint: item.hint,
    })),
  };
  printJson(summary);

  if (failedRows.length && args['allow-failures'] !== true) {
    process.exitCode = 1;
  }
}

// ------------------------------------------------------------------ 入口

async function main() {
  const argv = process.argv.slice(2);
  const mode = argv[0] === 'batch' ? 'batch' : 'single';
  const args = parseArgs(mode === 'batch' ? argv.slice(1) : argv);

  if (args.help === true || argv.includes('-h')) {
    process.stdout.write(HELP);
    return;
  }

  const baseUrl = buildBaseUrl(str(args, 'base-url'));
  if (mode === 'batch') await runBatch(args, baseUrl);
  else await runSingle(args, baseUrl);
}

main().catch((error) => {
  printJson(pickErrorMessage(error));
  if (error instanceof CliError && error.hint) process.stderr.write(`[say] ${error.hint}\n`);
  process.exitCode = 1;
});

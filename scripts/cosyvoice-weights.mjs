#!/usr/bin/env node
/**
 * 下载 Fun-CosyVoice3-0.5B 推理权重（走 ModelScope，支持限速/断点续传与字节数校验）。
 *
 * 为什么不用 huggingface：本机 hf-mirror 单连接只有 ~150KB/s，5.4GB 要跑几小时；
 * ModelScope 单连接实测约 3~5MB/s。
 *
 * 用法：
 *   node scripts/cosyvoice-weights.mjs                      # 默认并行 2、不限速
 *   node scripts/cosyvoice-weights.mjs --parallel 1 --limit-kbps 2500
 *                                                           # 礼貌模式：单连接 + 限速 2.5MB/s
 *   node scripts/cosyvoice-weights.mjs --force              # 重下已存在的文件
 *   node scripts/cosyvoice-weights.mjs --dry-run            # 只打印 URL 与大小
 *   node scripts/cosyvoice-weights.mjs --only llm           # 只下某一项
 *   node scripts/cosyvoice-weights.mjs --urls-only          # 只输出直链（用于手动/下载器接管）
 *
 * 说明：
 * - **断点续传**走 HTTP Range（ModelScope 的 resolve 会 302 到 CDN，跟随重定向后仍返回 206；
 *   2026-11-09 实测可用）。残件落 `<file>.part`，成功后原子改名，失败保留以便下次续。
 * - `--limit-kbps` 是**每连接**的字节限速（KB/s），用于避免把家用带宽打满。
 * - `--urls-only` 只打印每项的直链与期望大小，不落盘，便于手动下载或交给 aria2/IDM。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(ROOT, 'cosyvoice', 'weights.manifest.json');

const args = process.argv.slice(2);
const force = args.includes('--force');
const dryRun = args.includes('--dry-run');
const urlsOnly = args.includes('--urls-only');

function argValue(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
}

const only = argValue('--only');
const parallelArg = Number(argValue('--parallel') ?? 2);
const PARALLEL = Number.isFinite(parallelArg) && parallelArg > 0 ? Math.floor(parallelArg) : 2;
const limitKbps = Number(argValue('--limit-kbps') ?? 0);
const LIMIT_BPS = Number.isFinite(limitKbps) && limitKbps > 0 ? limitKbps * 1024 : 0;

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const entries = (manifest.entries ?? []).filter((entry) => !only || entry.id === only);
if (entries.length === 0) {
  console.error(`没有匹配的清单项（--only ${only ?? ''}）`);
  process.exit(1);
}

function targetPath(entry) {
  return path.join(ROOT, 'cosyvoice', entry.target);
}

function sizeOf(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function urlOf(entry) {
  const source = entry.source ?? {};
  if (source.type !== 'modelscope') throw new Error(`不支持的源：${source.type}`);
  return `https://modelscope.cn/models/${source.repo}/resolve/master/${source.path}`;
}

function human(bytes) {
  const mb = bytes / 1048576;
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
}

function humanSpeed(bps) {
  const mb = bps / 1048576;
  return mb >= 1 ? `${mb.toFixed(2)} MB/s` : `${(bps / 1024).toFixed(0)} KB/s`;
}

/** 每连接的简单令牌桶：按累计字节与墙钟的偏差补 sleep，避免把带宽打满。 */
function makeThrottle(limitBps) {
  let windowStart = Date.now();
  let windowBytes = 0;
  return async function throttle(chunkBytes) {
    if (!limitBps) return;
    windowBytes += chunkBytes;
    const elapsed = (Date.now() - windowStart) / 1000;
    const expected = windowBytes / limitBps;
    if (expected > elapsed) {
      const waitMs = Math.min(3000, Math.ceil((expected - elapsed) * 1000));
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    if (Date.now() - windowStart > 5000) {
      windowStart = Date.now();
      windowBytes = 0;
    }
  };
}

async function download(entry) {
  const file = targetPath(entry);
  const expected = Number(entry.sizeBytes ?? 0);
  if (!force && sizeOf(file) === expected && expected > 0) {
    console.log(`  [skip] ${entry.id}  ${human(expected)}`);
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  console.log(`  [get ] ${entry.id}  ${human(expected)}  ← ${urlOf(entry)}`);
  if (dryRun) return;

  const tmp = `${file}.part`;
  let received = force ? 0 : Math.min(sizeOf(tmp), Math.max(expected - 1, 0));
  const headers = received > 0 ? { Range: `bytes=${received}-` } : {};

  const response = await fetch(urlOf(entry), { headers });
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} ${entry.id}`);

  // 服务器不认 Range（返回 200）时老老实实从头写，别把新内容接在旧残件后面。
  // 注意：Node 的 WriteStream flags 只认 'w' / 'a'（不接受 'wb'，会抛 ERR_INVALID_ARG_VALUE）。
  let mode = 'w';
  if (received > 0) {
    if (response.status === 206) {
      mode = 'a';
      console.log(`         ${entry.id}: 续传，从 ${human(received)} 继续`);
    } else {
      console.log(`         ${entry.id}: 服务器未返回 206（${response.status}），从头下载`);
      received = 0;
    }
  }

  const out = fs.createWriteStream(tmp, { flags: mode });
  const throttle = makeThrottle(LIMIT_BPS);
  const startedAt = Date.now();
  const startedBytes = received;
  let lastLog = 0;
  try {
    for await (const chunk of response.body) {
      received += chunk.length;
      if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve));
      await throttle(chunk.length);
      const now = Date.now();
      if (now - lastLog > 5000) {
        lastLog = now;
        const pct = expected > 0 ? ((received / expected) * 100).toFixed(1) : '?';
        const speed = (received - startedBytes) / Math.max((now - startedAt) / 1000, 0.001);
        console.log(`         ${entry.id}: ${human(received)} / ${human(expected)} (${pct}%)  ${humanSpeed(speed)}`);
      }
    }
  } finally {
    await new Promise((resolve) => out.end(resolve));
  }
  const actual = sizeOf(tmp);
  if (expected > 0 && Math.abs(actual - expected) / expected > 0.005) {
    throw new Error(`${entry.id} 大小不符：实际 ${actual} / 期望 ${expected}（保留 .part 供续传）`);
  }
  fs.rmSync(file, { force: true });
  fs.renameSync(tmp, file);
  console.log(`  [ok  ] ${entry.id}  ${human(actual)}`);
}

async function main() {
  if (urlsOnly) {
    console.log(`CosyVoice3 权重直链（${entries.length} 项，共 ${human(Number(manifest.totalBytes?.inference ?? 0))}）：\n`);
    for (const entry of entries) {
      console.log(`${entry.id}\t${human(Number(entry.sizeBytes ?? 0))}\t${urlOf(entry)}`);
      console.log(`  → 保存到 ${targetPath(entry)}`);
    }
    return;
  }
  const limitNote = LIMIT_BPS ? `限速 ${(LIMIT_BPS / 1024).toFixed(0)} KB/s/连接` : '不限速';
  console.log(`CosyVoice3 权重下载：${entries.length} 项，并行 ${PARALLEL}，${limitNote}\n`);
  const queue = [...entries];
  const failures = [];
  async function worker() {
    while (queue.length > 0) {
      const entry = queue.shift();
      try {
        await download(entry);
      } catch (error) {
        failures.push({ id: entry.id, message: error instanceof Error ? error.message : String(error) });
        console.error(`  [fail] ${entry.id}: ${failures.at(-1).message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(PARALLEL, entries.length) }, worker));

  if (dryRun) {
    console.log('\n[dry-run] 未下载任何文件。');
    return;
  }
  const missing = entries.filter((entry) => {
    const expected = Number(entry.sizeBytes ?? 0);
    return expected > 0 && sizeOf(targetPath(entry)) !== expected;
  });
  if (failures.length > 0 || missing.length > 0) {
    console.error(`\n未完成：${failures.length} 个失败，${missing.length} 个大小不符。重跑本命令即可续传补齐。`);
    process.exit(1);
  }
  console.log('\n全部权重已就位。下一步：npm run cosyvoice:check');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

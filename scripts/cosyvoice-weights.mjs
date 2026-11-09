#!/usr/bin/env node
/**
 * 下载 Fun-CosyVoice3-0.5B 推理权重（走 ModelScope，支持并行与字节数校验）。
 *
 * 为什么不用 huggingface：本机 hf-mirror 单连接只有 ~150KB/s，5.4GB 要跑几小时；
 * ModelScope 单连接约 3MB/s，四个大文件并行足够。
 *
 * 用法：
 *   node scripts/cosyvoice-weights.mjs
 *   node scripts/cosyvoice-weights.mjs --force       # 重下已存在的文件
 *   node scripts/cosyvoice-weights.mjs --dry-run
 *   node scripts/cosyvoice-weights.mjs --only llm
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(ROOT, 'cosyvoice', 'weights.manifest.json');
const PARALLEL = 4;

const args = process.argv.slice(2);
const force = args.includes('--force');
const dryRun = args.includes('--dry-run');
const onlyIndex = args.indexOf('--only');
const only = onlyIndex >= 0 ? args[onlyIndex + 1] : null;

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

  const response = await fetch(urlOf(entry));
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} ${entry.id}`);
  const tmp = `${file}.part`;
  const out = fs.createWriteStream(tmp);
  let received = 0;
  let lastLog = 0;
  try {
    for await (const chunk of response.body) {
      received += chunk.length;
      if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve));
      const now = Date.now();
      if (now - lastLog > 5000) {
        lastLog = now;
        const pct = expected > 0 ? ((received / expected) * 100).toFixed(1) : '?';
        console.log(`         ${entry.id}: ${human(received)} / ${human(expected)} (${pct}%)`);
      }
    }
  } finally {
    await new Promise((resolve) => out.end(resolve));
  }
  const actual = sizeOf(tmp);
  if (expected > 0 && Math.abs(actual - expected) / expected > 0.005) {
    throw new Error(`${entry.id} 大小不符：实际 ${actual} / 期望 ${expected}`);
  }
  fs.rmSync(file, { force: true });
  fs.renameSync(tmp, file);
  console.log(`  [ok  ] ${entry.id}  ${human(actual)}`);
}

async function main() {
  console.log(`CosyVoice3 权重下载：${entries.length} 项，并行 ${PARALLEL}\n`);
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
    console.error(`\n未完成：${failures.length} 个失败，${missing.length} 个大小不符。重跑本命令即可补齐。`);
    process.exit(1);
  }
  console.log('\n全部权重已就位。下一步：npm run cosyvoice:check');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

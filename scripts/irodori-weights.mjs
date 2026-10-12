#!/usr/bin/env node
/**
 * Irodori-TTS 权重与上游代码下载器。
 *
 * 用法：
 *   node scripts/irodori-weights.mjs                  # 下载「推理档」（约 1.2 GB）
 *   node scripts/irodori-weights.mjs --training       # 连「训练档」一起（约 4.3 GB）
 *   node scripts/irodori-weights.mjs --code           # 只拉上游代码（Irodori-TTS + dacvae）
 *   node scripts/irodori-weights.mjs --check          # 只核对，不下载
 *   node scripts/irodori-weights.mjs --force          # 已就位也重下（修截断用）
 *   node scripts/irodori-weights.mjs --jobs 4         # 降低并发（默认 8）
 *
 * ## 为什么是 Node 而不是 Python
 * 下载必须能在**建 venv 之前**跑 —— 否则「先有鸡还是先有蛋」。所以不依赖任何 Python 包。
 *
 * ## 为什么必须逐文件校验字节数
 * 阶段 28 实测：镜像限速 + 单连接 ~120KB/s，用 `_bench/chunked_dl.sh` 的 8 路 Range 才到
 * ~3.5MB/s；而中断的下载**不会自己报错**，要等 `torch.load` 时才炸成
 * `PytorchStreamReader failed … central directory`。所以每个文件写完都要比对
 * 清单里的 `sizeBytes`，对不上直接删掉重下，绝不留一个「看起来在、其实坏了」的文件。
 *
 * ## 源站口径（本机实测连通性，2026-10-12）
 *   - huggingface.co / raw.githubusercontent.com：直连不通
 *   - modelscope.cn：通（两个 Irodori 模型仓都有镜像）
 *   - hf-mirror.com：通（DACVAE codec 权重只有 HF 有，走镜像）
 *   - codeload.github.com：通（上游代码走 tarball；github.com 直连不通）
 */

import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IRODORI_DIR = path.join(ROOT, 'irodori');
const MANIFEST = path.join(IRODORI_DIR, 'weights.manifest.json');

const args = new Set(process.argv.slice(2));
const WANT_TRAINING = args.has('--training');
const ONLY_CODE = args.has('--code');
const CHECK_ONLY = args.has('--check');
const FORCE = args.has('--force');
const JOBS = (() => {
  const raw = process.argv.find((a) => a.startsWith('--jobs'));
  const value = raw ? Number(raw.split('=')[1] ?? process.argv[process.argv.indexOf(raw) + 1]) : 8;
  return Number.isFinite(value) && value >= 1 && value <= 16 ? Math.floor(value) : 8;
})();

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));

function mb(bytes) {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function human(bytes) {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(2)} GB`;
  return mb(bytes);
}

/** 源站 URL：ModelScope / hf-mirror 的 resolve 路径都支持 Range。 */
function resolveUrl(source) {
  if (source.type === 'modelscope') {
    return `https://modelscope.cn/api/v1/models/${source.repo}/repo?Revision=master&FilePath=${encodeURIComponent(source.path)}`;
  }
  if (source.type === 'hf-mirror') {
    return `https://hf-mirror.com/${source.repo}/resolve/main/${source.path}`;
  }
  throw new Error(`未知的 source.type：${source.type}`);
}

/** 本地已就位判定：存在且字节数与清单一致（--force 时一律视为未就位）。 */
function localState(entry) {
  const target = path.join(IRODORI_DIR, entry.target);
  if (FORCE || !existsSync(target)) return { target, ok: false, actual: null };
  const actual = statSync(target).size;
  return { target, ok: actual === entry.sizeBytes, actual };
}

/**
 * 8 路 Range 并发下载单个文件。
 *
 * 先 HEAD 拿 Content-Length 与 Accept-Ranges：
 *   - 支持 Range → 分片并发（镜像单连接限速，这是唯一能跑满的办法）
 *   - 不支持 → 退回单流下载（不猜，直接照实做）
 * 分片写入 `<target>.part<i>`，全部完成后再合并成 `<target>.part`，
 * 最后校验字节数并 rename —— 中途任何失败都不会留下一个「像成品」的文件。
 */
async function downloadFile(entry) {
  const url = resolveUrl(entry.source);
  const target = path.join(IRODORI_DIR, entry.target);
  mkdirSync(path.dirname(target), { recursive: true });

  const head = await fetch(url, { method: 'HEAD', redirect: 'follow' });
  if (!head.ok) throw new Error(`HEAD ${head.status} ${url}`);
  const total = Number(head.headers.get('content-length') ?? 0);
  const acceptRanges = (head.headers.get('accept-ranges') ?? '').toLowerCase().includes('bytes');

  if (total && total !== entry.sizeBytes) {
    console.log(`    [!] 源站 Content-Length ${total} 与清单 ${entry.sizeBytes} 不一致，以源站为准（清单需更新）`);
  }
  const size = total || entry.sizeBytes;

  if (!acceptRanges || JOBS === 1 || size < 4 * 1048576) {
    // 小文件或源站不支持 Range：单流即可，分片反而添乱
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`GET ${res.status} ${url}`);
    const tmp = `${target}.part`;
    await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
    return finish(target, tmp, entry.sizeBytes);
  }

  const chunkSize = Math.ceil(size / JOBS);
  const parts = [];
  for (let i = 0; i < JOBS; i += 1) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize - 1, size - 1);
    if (start > end) break;
    parts.push({ index: i, start, end });
  }

  await Promise.all(
    parts.map(async (part) => {
      const partPath = `${target}.part${part.index}`;
      const res = await fetch(url, {
        headers: { Range: `bytes=${part.start}-${part.end}` },
        redirect: 'follow',
      });
      if (!res.ok || !res.body) throw new Error(`Range ${res.status} ${url} [${part.start}-${part.end}]`);
      await pipeline(Readable.fromWeb(res.body), createWriteStream(partPath));
      const got = statSync(partPath).size;
      const want = part.end - part.start + 1;
      if (got !== want) {
        throw new Error(`分片 ${part.index} 字节数不符：${got} / ${want}（${partPath}）`);
      }
    }),
  );

  // 按序合并分片：逐片 append，每片等 finish 再写下一片（顺序错了文件就废了）。
  // 不用 `pipeline(..., out, {end:false})`：那个 options 形态在各 Node 版本上行为不一致，
  // 这里宁可用最朴素的写法。
  const merged = `${target}.part`;
  rmSync(merged, { force: true });
  for (const part of parts) {
    const partPath = `${target}.part${part.index}`;
    await new Promise((resolve, reject) => {
      const source = createReadStream(partPath);
      const sink = createWriteStream(merged, { flags: 'a' });
      source.on('error', reject);
      sink.on('error', reject);
      sink.on('finish', resolve);
      source.pipe(sink);
    });
    rmSync(partPath, { force: true });
  }
  return finish(target, merged, entry.sizeBytes);
}

/**
 * 单个文件的下载重试。
 *
 * 存在的理由：实测在「8 路 Range + 同时装 torch」的满载情况下，镜像会偶发
 * `fetch failed`（瞬时连接重置 / DNS 抖动）—— 让一次网络抖动废掉整轮 1.2GB 下载
 * 是很不划算的，而重试的成本几乎为零（已完成的文件本来就会跳过）。
 * 只重试**网络类**错误；字节数校验失败不重试（那是源站或清单的问题，重试没用）。
 */
async function downloadWithRetry(entry, attempts = 3) {
  let lastError;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      return await downloadFile(entry);
    } catch (error) {
      lastError = error;
      const transient = /fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|terminated/i.test(
        `${error.message} ${error.cause?.message ?? ''}`,
      );
      if (!transient || i === attempts) break;
      const wait = 2000 * i;
      console.log(`      [!] 第 ${i} 次失败（${error.message}），${wait / 1000}s 后重试…`);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  throw lastError;
}

/** 校验字节数 → rename 成正式文件名。不符就删掉并抛错（绝不留下坏文件）。 */
function finish(target, tmpPath, expected) {
  const actual = statSync(tmpPath).size;
  if (expected && actual !== expected) {
    rmSync(tmpPath, { force: true });
    throw new Error(`字节数校验失败：实际 ${actual} / 期望 ${expected}（已删除残片，请重试）`);
  }
  rmSync(target, { force: true });
  renameSync(tmpPath, target);
  return actual;
}

/**
 * tarball 解包：先解到 `<parent>/.unpack-<id>/`，再把里面唯一的顶层目录改名成 target。
 *
 * ⚠️ 不能直接 `tar --strip-components=1 -C upstream/` —— 那样两个仓库的内容会**撒进同一个
 * `upstream/`** 并互相覆盖。官方 tarball 顶层目录名就是仓库名，所以「解到临时目录 + 改名」
 * 既安全又保住了目录边界。
 */

async function fetchTarballInto(entry) {
  const target = path.join(IRODORI_DIR, entry.target);
  const parent = path.dirname(target);
  mkdirSync(parent, { recursive: true });
  const tmpTar = path.join(parent, `.${entry.id}.tar.gz`);
  const tmpDir = path.join(parent, `.unpack-${entry.id}`);

  const res = await fetch(entry.source.url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`GET ${res.status} ${entry.source.url}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmpTar));

  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  const { execFile } = await import('node:child_process');
  await new Promise((resolve, reject) => {
    // ★ 关键：**只传相对路径 + 用 cwd**，绝不把 `F:\...` 这种带盘符的绝对路径交给 tar。
    // Git Bash 自带的是 GNU tar，它把 `F:/x.tar.gz` 当成 `主机:路径` 的远程归档语法，
    // 于是报 `Cannot connect to F: resolve failed`（实测踩过）。
    // 换 cwd + 相对名之后，GNU tar 与 Windows 自带的 bsdtar 都能正确解包。
    execFile(
      'tar',
      ['-xzf', path.basename(tmpTar), '-C', path.basename(tmpDir)],
      { cwd: parent },
      (error, _stdout, stderr) => {
        if (error) reject(new Error(`tar 解包失败：${stderr || error.message}`));
        else resolve();
      },
    );
  });

  const tops = readdirSync(tmpDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  if (tops.length !== 1) {
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(tmpTar, { force: true });
    throw new Error(`tarball 顶层目录数不是 1（${tops.length}），无法安全定位：${entry.id}`);
  }
  rmSync(target, { recursive: true, force: true });
  renameSync(path.join(tmpDir, tops[0].name), target);
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(tmpTar, { force: true });
  return target;
}

async function main() {
  const entries = (manifest.entries ?? []).filter((entry) => {
    if (ONLY_CODE) return false;
    if (entry.group === 'training' && !WANT_TRAINING) return false;
    return true;
  });
  const codes = manifest.code ?? [];

  const inferenceNeed = entries
    .filter((e) => e.group === 'inference')
    .reduce((sum, e) => sum + e.sizeBytes, 0);
  const trainingNeed = entries
    .filter((e) => e.group === 'training')
    .reduce((sum, e) => sum + e.sizeBytes, 0);

  console.log('  [irodori] 权重清单：', MANIFEST);
  console.log(
    `  [irodori] 本次目标：${entries.length} 个权重文件（${human(inferenceNeed + trainingNeed)}）`
      + `${codes.length ? ` + ${codes.length} 个代码仓` : ''}${WANT_TRAINING ? '（含训练档）' : '（推理档）'}`,
  );
  if (CHECK_ONLY) console.log('  [irodori] --check：只核对，不下载\n');

  const failed = [];
  const skipped = [];

  for (const entry of entries) {
    const state = localState(entry);
    if (state.ok) {
      console.log(`  [=] ${entry.target} 已就位（${mb(state.actual)}）`);
      skipped.push(entry.target);
      continue;
    }
    if (state.actual !== null) {
      console.log(`  [!] ${entry.target} 大小不符（${state.actual} / ${entry.sizeBytes}）→ 重下`);
    }
    if (CHECK_ONLY) {
      console.log(`  [x] ${entry.target} 缺失（${mb(entry.sizeBytes)}）`);
      failed.push(entry.target);
      continue;
    }
    console.log(`  [↓] ${entry.target}  ${mb(entry.sizeBytes)}  ← ${entry.source.type}`);
    try {
      const got = await downloadWithRetry(entry);
      console.log(`      ✓ 完成并校验通过（${mb(got)}）`);
    } catch (error) {
      console.error(`      ✗ 失败：${error.message}`);
      failed.push(entry.target);
    }
  }

  for (const entry of codes) {
    const target = path.join(IRODORI_DIR, entry.target);
    const marker = entry.id === 'upstream-irodori'
      ? path.join(target, 'pyproject.toml')
      : path.join(target, 'dacvae');
    if (existsSync(marker)) {
      console.log(`  [=] ${entry.target} 已就位`);
      skipped.push(entry.target);
      continue;
    }
    if (CHECK_ONLY) {
      console.log(`  [x] ${entry.target} 缺失`);
      failed.push(entry.target);
      continue;
    }
    console.log(`  [↓] ${entry.target}  ← codeload tarball`);
    try {
      await fetchTarballInto(entry);
      console.log('      ✓ 解包完成');
    } catch (error) {
      console.error(`      ✗ 失败：${error.message}`);
      failed.push(entry.target);
    }
  }

  console.log('');
  if (failed.length === 0) {
    const fresh = entries.length + codes.length - skipped.length;
    console.log(`  [✓] 全部就位（本次新下载 ${fresh} 项，已存在 ${skipped.length} 项）`);
    console.log('      下一步：npm run irodori:check');
    return 0;
  }
  console.error(`  [x] 有 ${failed.length} 项未就位：`);
  for (const item of failed) console.error(`      - ${item}`);
  console.error('      重试：node scripts/irodori-weights.mjs（已完成的会自动跳过）');
  return 1;
}

process.exit(await main());

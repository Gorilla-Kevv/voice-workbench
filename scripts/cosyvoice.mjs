#!/usr/bin/env node
/**
 * 跨平台启动 CosyVoice3 本地服务（cosyvoice/，第六个 Python 运行时）。
 *
 * 与 `irodori.mjs` 同一形态。解释器按优先级取：
 *   1. COSYVOICE_PYTHON 环境变量
 *   2. cosyvoice/.venv/Scripts/python.exe（存在即用）
 *   3. 系统 `python`
 *
 * 用法：
 *   node scripts/cosyvoice.mjs                  # 启动服务（默认 127.0.0.1:9886）
 *   node scripts/cosyvoice.mjs --check          # 只做环境体检
 *   node scripts/cosyvoice.mjs --weights        # 下载权重（ModelScope）
 *   node scripts/cosyvoice.mjs --skip-if-missing
 */

import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'cosyvoice', 'server.py');
const DOWNLOADER = path.join(ROOT, 'scripts', 'cosyvoice-weights.mjs');
const VENV_DIR = path.join(ROOT, 'cosyvoice', '.venv');
const IS_WINDOWS = process.platform === 'win32';

function resolvePython() {
  const venvPython = IS_WINDOWS
    ? path.join(VENV_DIR, 'Scripts', 'python.exe')
    : path.join(VENV_DIR, 'bin', 'python');
  if (process.env.COSYVOICE_PYTHON?.trim()) return process.env.COSYVOICE_PYTHON.trim();
  if (existsSync(venvPython)) return venvPython;
  return 'python';
}

const rawArgs = process.argv.slice(2);
const skipIfMissing = rawArgs.includes('--skip-if-missing');
const isWeights = rawArgs.includes('--weights');
const flags = new Set(['--weights', '--skip-if-missing']);
const passthrough = rawArgs.filter((arg) => !flags.has(arg));

if (isWeights) {
  const child = spawn(process.execPath, [DOWNLOADER, ...passthrough], { stdio: 'inherit', cwd: ROOT });
  child.on('exit', (code) => process.exit(code ?? 1));
} else {
  const python = resolvePython();

  const portInUse = (port) =>
    new Promise((resolve) => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      const done = (result) => {
        socket.destroy();
        resolve(result);
      };
      socket.setTimeout(600);
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false));
      socket.once('error', () => done(false));
    });

  const port = Number(process.env.COSYVOICE_PORT ?? 9886);

  if (skipIfMissing && !existsSync(VENV_DIR)) {
    console.log('  [cosyvoice] 未检测到 cosyvoice/.venv，跳过启动（侧栏会以「未启动」显示）');
    console.log('  [cosyvoice] 想启用它：按 cosyvoice/README.md 建 venv + npm run cosyvoice:weights，再跑 npm run cosyvoice:check');
    process.exit(0);
  }

  if (skipIfMissing && (await portInUse(port))) {
    console.log(`  [cosyvoice] ${port} 端口已有服务在跑（可能你手动起过），本次跳过启动`);
    process.exit(0);
  }

  console.log(`  [cosyvoice] 解释器：${python}`);
  console.log('  [cosyvoice] 若解释器不对（缺 torch / 版本不是 3.10），请设置 COSYVOICE_PYTHON 指向 cosyvoice/.venv');

  const child = spawn(python, [SERVER, ...passthrough], {
    stdio: 'inherit',
    cwd: ROOT,
    env: {
      ...process.env,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUNBUFFERED: '1',
    },
  });

  child.on('error', (error) => {
    console.error(`  [x] 无法启动 ${python}：${error.message}`);
    console.error('      请先按 cosyvoice/README.md 创建 venv，或设置 COSYVOICE_PYTHON 指向可用解释器。');
    process.exit(1);
  });

  child.on('exit', (code) => process.exit(code ?? 1));
}

#!/usr/bin/env node
/**
 * GPT-SoVITS v5 本地服务启动器（`gsv5/`，第五个 Python 运行时）。
 *
 *   node scripts/gsv5.mjs            # 启动服务（默认 127.0.0.1:9885）
 *   node scripts/gsv5.mjs --check    # 只做体检
 *   node scripts/gsv5.mjs --skip-if-missing  # 没建环境就安静跳过
 */

import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'gsv5', 'server.py');
const VENV = path.join(ROOT, 'gsv5', '.venv');
const IS_WINDOWS = process.platform === 'win32';
const PORT = Number(process.env.GSV5_PORT ?? 9885);

function resolvePython() {
  if (process.env.GSV5_PYTHON?.trim()) return process.env.GSV5_PYTHON.trim();
  const venvPython = IS_WINDOWS ? path.join(VENV, 'Scripts', 'python.exe') : path.join(VENV, 'bin', 'python');
  if (existsSync(venvPython)) return venvPython;
  return 'python';
}

function portInUse(port) {
  return new Promise((resolve) => {
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
}

const rawArgs = process.argv.slice(2);
const flags = new Set(['--skip-if-missing']);
const skipIfMissing = rawArgs.includes('--skip-if-missing');
const passthrough = rawArgs.filter((arg) => !flags.has(arg));

const python = resolvePython();
const venvMissing = !existsSync(IS_WINDOWS ? path.join(VENV, 'Scripts', 'python.exe') : path.join(VENV, 'bin', 'python'));

if (skipIfMissing && venvMissing) {
  console.log('  [gsv5] 未检测到 gsv5/.venv，跳过启动（页面会以「未启动」提示）');
  process.exit(0);
}

if (skipIfMissing && !passthrough.includes('--check') && (await portInUse(PORT))) {
  console.log(`  [gsv5] ${PORT} 端口已有服务在跑，本次跳过启动`);
  process.exit(0);
}

console.log(`  [gsv5] 解释器：${python}`);
const child = spawn(python, [SERVER, ...passthrough], {
  stdio: 'inherit',
  cwd: path.join(ROOT, 'gsv5'),
  env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
});

child.on('error', (error) => {
  console.error(`  [x] 无法启动 ${python}：${error.message}`);
  process.exit(1);
});
child.on('exit', (code) => process.exit(code ?? 1));

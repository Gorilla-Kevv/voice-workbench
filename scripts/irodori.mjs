#!/usr/bin/env node
/**
 * 跨平台启动 Irodori-TTS 本地服务（irodori/，第四个 Python 运行时）。
 *
 * 与 `netease.mjs` 同一形态。解释器按优先级取：
 *   1. IRODORI_PYTHON 环境变量（指向 irodori venv 的 python）
 *   2. irodori/.venv/ 下的解释器（存在即用）
 *   3. 系统 `python`
 *
 * 用法：
 *   node scripts/irodori.mjs                  # 启动服务（默认 127.0.0.1:9884）
 *   node scripts/irodori.mjs --check          # 只做环境体检
 *   node scripts/irodori.mjs --port 9884
 *   node scripts/irodori.mjs --weights [...]  # 下载权重（参数原样透传给下载脚本）
 *   node scripts/irodori.mjs --skip-if-missing  # 没建 venv 就安静跳过（给 npm run dev 用）
 *
 * `--skip-if-missing` 的存在理由与 netease 相同：Irodori 是**可选**的日语能力，
 * 没装 venv / 没下权重的机器上不该把整个 dev 链路拖崩 —— 那种情况下跳过启动，
 * 页面照常显示「未启动」，用户自己决定装不装。
 */

import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'irodori', 'server.py');
const DOWNLOADER = path.join(ROOT, 'scripts', 'irodori-weights.mjs');
const VENV_DIR = path.join(ROOT, 'irodori', '.venv');
const IS_WINDOWS = process.platform === 'win32';

function resolvePython() {
  const venvPython = IS_WINDOWS
    ? path.join(VENV_DIR, 'Scripts', 'python.exe')
    : path.join(VENV_DIR, 'bin', 'python');
  if (process.env.IRODORI_PYTHON?.trim()) return process.env.IRODORI_PYTHON.trim();
  if (existsSync(venvPython)) return venvPython;
  return 'python';
}

const rawArgs = process.argv.slice(2);
const skipIfMissing = rawArgs.includes('--skip-if-missing');
const isWeights = rawArgs.includes('--weights');
const flags = new Set(['--weights', '--skip-if-missing']);
const passthrough = rawArgs.filter((arg) => !flags.has(arg));

// 权重下载走 Node 脚本（不依赖 Python，理由见 irodori-weights.mjs 文件头）
if (isWeights) {
  const child = spawn(process.execPath, [DOWNLOADER, ...passthrough], { stdio: 'inherit', cwd: ROOT });
  child.on('exit', (code) => process.exit(code ?? 1));
} else {
  const python = resolvePython();

  /** 端口上已经有人应答就别再起一个（常见于用户先手动起过）。 */
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

  const port = Number(process.env.IRODORI_PORT ?? 9884);

  if (skipIfMissing && !existsSync(VENV_DIR)) {
    console.log('  [irodori] 未检测到 irodori/.venv，跳过启动（侧栏会以「未启动」显示）');
    console.log('  [irodori] 想启用它：按 irodori/README.md 建 venv + npm run irodori:weights，再跑 npm run irodori:check');
    process.exit(0);
  }

  if (skipIfMissing && (await portInUse(port))) {
    console.log(`  [irodori] ${port} 端口已有服务在跑（可能你手动起过），本次跳过启动`);
    process.exit(0);
  }

  console.log(`  [irodori] 解释器：${python}`);
  console.log('  [irodori] 若解释器不对（缺 torch / 版本低于 3.12），请设置 IRODORI_PYTHON 指向 irodori/.venv');

  const child = spawn(python, [SERVER, ...passthrough], {
    stdio: 'inherit',
    cwd: ROOT,
    env: {
      ...process.env,
      // 中文日志在 Windows 终端里会变乱码，与 sovits.mjs / netease.mjs 同一层保险
      PYTHONIOENCODING: 'utf-8',
      PYTHONUNBUFFERED: '1',
    },
  });

  child.on('error', (error) => {
    console.error(`  [x] 无法启动 ${python}：${error.message}`);
    console.error('      请先按 irodori/README.md 创建 venv，或设置 IRODORI_PYTHON 指向可用解释器。');
    process.exit(1);
  });

  child.on('exit', (code) => process.exit(code ?? 1));
}

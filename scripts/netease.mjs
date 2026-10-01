#!/usr/bin/env node
/**
 * 跨平台启动网易模块本地服务（netease/，第二个 Python 运行时）。
 *
 * 与 `sovits.mjs` 的差别：netease 没有 PowerShell/bash 的启动脚本变体，
 * 这里直接把解释器与参数递给 `netease/server.py`。解释器按优先级取：
 *   1. NETEASE_PYTHON 环境变量（指向 netease venv 的 python）
 *   2. netease/.venv/ 下的解释器（存在即用）
 *   3. 系统 `python`
 *
 * 用法：
 *   node scripts/netease.mjs                # 启动服务（默认 127.0.0.1:9882）
 *   node scripts/netease.mjs --check        # 只做环境体检
 *   node scripts/netease.mjs --port 9882
 *   node scripts/netease.mjs --weights      # 下载权重（其余参数原样透传给下载脚本）
 *   node scripts/netease.mjs --skip-if-missing   # 没建 venv 就安静跳过（给 npm run dev 用）
 *
 * `--skip-if-missing` 的存在理由：网易现在是**主服务**，`npm run dev` 会带上它，
 * 但没装权重 / 没建 venv 的机器上不该因此把整个 dev 链路拖崩 ——
 * 那种情况下跳过，页面照常给出「待补齐」提示，用户自己决定装不装。
 */

import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'netease', 'server.py');
const DOWNLOADER = path.join(ROOT, 'scripts', 'download_netease_weights.py');
const IS_WINDOWS = process.platform === 'win32';

function resolvePython() {
  const venvPython = IS_WINDOWS
    ? path.join(ROOT, 'netease', '.venv', 'Scripts', 'python.exe')
    : path.join(ROOT, 'netease', '.venv', 'bin', 'python');
  if (process.env.NETEASE_PYTHON?.trim()) return process.env.NETEASE_PYTHON.trim();
  if (existsSync(venvPython)) return venvPython;
  return 'python';
}

const python = resolvePython();
const rawArgs = process.argv.slice(2);
const flags = new Set(['--weights', '--skip-if-missing']);
const skipIfMissing = rawArgs.includes('--skip-if-missing');
const passthrough = rawArgs.filter((arg) => !flags.has(arg));
const isWeights = passthrough.includes('--weights');
const target = isWeights ? DOWNLOADER : SERVER;
const args = [target, ...passthrough.filter((arg) => arg !== '--weights')];

/**
 * 端口上已经有人应答就别再起一个：常见于用户先手动跑了 `npm run dev:netease`，
 * 再开 `npm run dev` —— 否则第二个实例会拿「address already in use」崩掉一个窗格。
 */
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

const port = Number(process.env.NETEASE_PORT ?? 9882);

// 没建 venv 就别硬起：主服务也要照顾「没装权重」的机器
if (skipIfMissing && !isWeights && !existsSync(path.join(ROOT, 'netease', '.venv'))) {
  console.log('  [netease] 未检测到 netease/.venv，跳过启动（主服务会以「待补齐」显示在侧栏）');
  console.log('  [netease] 想启用它：按 netease/README.md 建 venv + 下载权重，再跑 npm run netease:check');
  process.exit(0);
}

if (skipIfMissing && !isWeights && (await portInUse(port))) {
  console.log(`  [netease] ${port} 端口已有服务在跑（可能你手动起过），本次跳过启动`);
  process.exit(0);
}

console.log(`  [netease] 解释器：${python}`);
if (isWeights) {
  console.log(`  [netease] 下载权重：${DOWNLOADER}（可加 --proxy http://127.0.0.1:7890 / --include-r2t2）`);
} else {
  console.log(`  [netease] 若解释器不对（缺 torch / 版本低于 3.10），请设置 NETEASE_PYTHON 指向 netease/.venv`);
}

const child = spawn(python, args, {
  stdio: 'inherit',
  cwd: ROOT,
  env: {
    ...process.env,
    // 中文日志在 Windows 终端里会变乱码，与 sovits.mjs 同一层保险
    PYTHONIOENCODING: 'utf-8',
    PYTHONUNBUFFERED: '1',
  },
});

child.on('error', (error) => {
  console.error(`  [x] 无法启动 ${python}：${error.message}`);
  console.error(`      请先按 netease/README.md 创建 venv，或设置 NETEASE_PYTHON 指向可用解释器。`);
  process.exit(1);
});

child.on('exit', (code) => process.exit(code ?? 1));

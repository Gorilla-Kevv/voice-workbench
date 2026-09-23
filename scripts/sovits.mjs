#!/usr/bin/env node
/**
 * 跨平台启动 GPT-SoVITS 本地服务。
 *
 * `start.ps1` 与 `start.sh` 只差在参数风格上（PowerShell 要 `-Check`，bash 要 `--check`），
 * 与其让用户记住「在 Windows 上要换一种写法」，不如在这里做一次翻译。
 *
 * 用法：
 *   node scripts/sovits.mjs                # 本地模式启动
 *   node scripts/sovits.mjs --check        # 只做环境体检
 *   node scripts/sovits.mjs --home D:/GPT-SoVITS --port 9881
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IS_WINDOWS = process.platform === 'win32';

/** bash 风格 → PowerShell 参数名 */
const PS_FLAG_MAP = {
  '--check': '-Check',
  '--no-open': '-NoOpen',
  '--dry-run': '-DryRun',
  '--skip-install': '-SkipInstall',
  // PowerShell 的 $Home 是自动变量，参数名刻意避开了它
  '--home': '-SovitsHome',
  '--port': '-Port',
  '--device': '-Device',
  '--version': '-Version',
  '--mode': '-Mode',
};

const rawArgs = process.argv.slice(2);

const script = path.join(ROOT, 'scripts', IS_WINDOWS ? 'start.ps1' : 'start.sh');
const command = IS_WINDOWS ? 'powershell' : 'bash';

const scriptArgs = IS_WINDOWS
  ? [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      script,
      ...rawArgs.map((arg) => PS_FLAG_MAP[arg] ?? arg),
    ]
  : [script, ...rawArgs];

const result = spawnSync(command, scriptArgs, {
  stdio: 'inherit',
  cwd: ROOT,
  shell: false,
  env: {
    ...process.env,
    // Python 侧输出 UTF-8；不经这层传递的话，中文日志在 Windows 终端里会变成乱码
    PYTHONIOENCODING: 'utf-8',
    PYTHONUNBUFFERED: '1',
  },
});

if (result.error) {
  console.error(`  [x] 无法启动 ${command}：${result.error.message}`);
  console.error(`      请手动执行 ${path.relative(ROOT, script)}`);
  process.exit(1);
}

process.exit(result.status ?? 1);

import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 「这个端口上的进程是不是我们自己的」—— 用于**真正关掉服务**。
 *
 * ## 为什么需要这一层
 *
 * `RuntimeSupervisor.shutdown()` 原来只杀 `this.child`（本进程 spawn 的）。
 * 但服务的实际启动方式有三条：
 *   1. 网关 spawn（`this.child` 有值）；
 *   2. `npm run dev` 的 concurrently 起的；
 *   3. 用户/脚本自己 `node scripts/netease.mjs` 起的。
 *
 * 2 与 3 都让 `this.child === null`，于是**关不掉** —— 用户实测：
 * 网易开关已置 `enabled: false`，但 9882 端口仍 LISTENING，切 IndexTTS 时两个
 * 服务抢显存。所以必须能「按端口反查 PID」再判断归属。
 *
 * ## 归属判据（宁可漏杀，不可错杀）
 *
 * 只认**命令行里同时出现**下列特征的进程：
 *   * 脚本路径指向本项目的 `scripts/<name>.mjs`，或
 *   * 父进程/祖先是我们自己，或
 *   * 命令行里含本项目根目录**且**含该服务的标识（`netease` / `indextts`）。
 *
 * 换句话说：一个碰巧占了 9882 端口的陌生程序**不会**被杀。这是硬约束 ——
 * 停错别人的进程比「关不掉」严重得多。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..', '..', '..');

/** 跑一条命令，拿 stdout（失败返回空串） */
function run(file: string, args: string[], timeoutMs = 8_000): Promise<string> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      resolve(error && !stdout ? '' : stdout);
    });
  });
}

export interface PortOwner {
  pid: number;
  /** 进程名（如 python.exe / node.exe） */
  name: string;
  /** 命令行（截断到 400 字符，够判归属即可） */
  commandLine: string;
  /** 是否认定为本项目自己的服务进程 */
  ours: boolean;
  /** 判为本项目的依据（用于日志与界面提示，便于排障） */
  reason: string;
}

/** 按端口反查监听进程（Windows 用 netstat，类 Unix 用 lsof） */
export async function findPortOwners(port: number): Promise<number[]> {
  if (process.platform === 'win32') {
    const out = await run('netstat', ['-ano', '-p', 'TCP']);
    const pids = new Set<number>();
    for (const line of out.split(/\r?\n/)) {
      const cols = line.trim().split(/\s+/);
      // 形如：TCP  127.0.0.1:9882  0.0.0.0:0  LISTENING  16780
      if (cols.length < 5 || cols[0].toUpperCase() !== 'TCP') continue;
      if (cols[3].toUpperCase() !== 'LISTENING') continue;
      if (!cols[1].endsWith(`:${port}`)) continue;
      const pid = Number.parseInt(cols[4], 10);
      if (Number.isInteger(pid) && pid > 0) pids.add(pid);
    }
    return [...pids];
  }

  const out = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
  return out
    .split(/\r?\n/)
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

/** 读一批进程的命令行与进程名（Windows 走 WMIC/CIM，失败则退化为只看 pid 存在性） */
async function readProcessInfo(pids: number[]): Promise<Map<number, { name: string; commandLine: string }>> {
  const result = new Map<number, { name: string; commandLine: string }>();
  if (pids.length === 0) return result;

  if (process.platform === 'win32') {
    // PowerShell 的 Get-CimInstance 在 Win11 上 wmic 已被移除，优先它。
    // 输出 JSON 便于解析；用 -NoProfile 避免用户 profile 拖慢或污染输出。
    const filter = pids.map((pid) => `ProcessId=${pid}`).join(' OR ');
    const script =
      `Get-CimInstance Win32_Process -Filter "${filter}" | ` +
      `Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress`;
    const out = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], 12_000);
    if (out.trim()) {
      try {
        const parsed = JSON.parse(out.trim()) as
          | { ProcessId: number; Name?: string; CommandLine?: string }
          | Array<{ ProcessId: number; Name?: string; CommandLine?: string }>;
        for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
          result.set(item.ProcessId, { name: item.Name ?? '', commandLine: item.CommandLine ?? '' });
        }
      } catch {
        // JSON 解析失败：调用方会因拿不到命令行而判定「不是我们的」，安全侧
      }
    }
    return result;
  }

  const out = await run('ps', ['-o', 'pid=,comm=,args=', '-p', pids.join(',')]);
  for (const line of out.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\S+)\s*(.*)$/);
    if (!match) continue;
    result.set(Number.parseInt(match[1], 10), { name: match[2], commandLine: match[3] });
  }
  return result;
}

/** classify 的补充上下文：命令行之外的旁证 */
export interface ClassifyContext {
  /** 可执行文件路径（Win32_Process.ExecutablePath）—— 用于识别「解释器落在项目内」 */
  executablePath?: string;
  /** 该服务 /health 自报的 PID 列表里是否包含本进程 —— 最硬的判据 */
  selfReported?: boolean;
}

/**
 * 判断命令行是否属于本项目的某个运行时服务。
 *
 * `hints` 是该服务的标识词（`netease` / `indextts`）与脚本名。
 *
 * 判据按「可信度从高到低」排列，命中任一条即算 ours；
 * 全部不中则返回 ours=false（**宁可漏杀，不可错杀**）。
 */
function classify(
  commandLine: string,
  name: string,
  hints: string[],
  context: ClassifyContext = {},
): { ours: boolean; reason: string } {
  // ⓪ 最硬的判据：服务自己在 /health 里报了这个 PID
  //    进程命令行什么都看不出来时，这一条能把真实归属钉死。
  if (context.selfReported) {
    return { ours: true, reason: `服务 /health 自报 PID，归属确凿` };
  }

  if (!commandLine) return { ours: false, reason: '拿不到命令行（保守起见不动它）' };

  const lower = commandLine.toLowerCase();
  const normalized = lower.replace(/\\/g, '/');
  const rootNormalized = PROJECT_ROOT.toLowerCase().replace(/\\/g, '/');

  // ① 直接指向本项目 scripts/<name>.mjs（网关自己 spawn 的形态）
  if (normalized.includes(`${rootNormalized}/scripts/`)) {
    const hit = hints.find((hint) => lower.includes(hint));
    if (hit) return { ours: true, reason: `命令行指向本项目 scripts/ 下的 ${hit} 服务` };
  }

  // ② 本项目绝对根路径 + 服务标识词同时出现
  if (normalized.includes(rootNormalized)) {
    const hit = hints.find((hint) => lower.includes(hint));
    if (hit) return { ours: true, reason: `命令行含本项目路径与标识「${hit}」` };
  }

  // ③ **相对路径形态**：`python netease/server.py`
  //
  // 这个形态很常见（用户在项目根目录手动起、或 cwd 已切好的终端里起），
  // 命令行里既没有绝对路径也没有 scripts/，前面两条都命中不了 ——
  // 实测就是这样漏掉了一个真实进程（命令行 `python.exe netease/server.py`）。
  // 判据退一步：**入口脚本名 + 服务标识词**同时出现即可。
  // 脚本名必须精确到 `<hint>/server.py` 或 `server.py`，
  // 不能只凭 `server.py`（太泛，别的项目也可能叫这个）。
  const entry = normalized.match(/(?:^|[\s"])([^\s"]*server\.py)(?:[\s"]|$)/);
  if (entry) {
    const entryPath = entry[1];
    const hit = hints.find((hint) => entryPath.includes(hint) || lower.includes(`/${hint}/`));
    if (hit) {
      return { ours: true, reason: `入口脚本为 ${entryPath} 且命令行含标识「${hit}」` };
    }
  }

  // ④ **解释器落在项目内的 venv** —— `netease/.venv/Scripts/python.exe server.py`
  //
  // 用项目自带 venv 起的进程，解释器路径一定在项目根下；只要命令行里
  // 还能看到服务标识（哪怕是裸 `server.py` 之外的参数），就可以认定。
  const execNormalized = (context.executablePath ?? '').toLowerCase().replace(/\\/g, '/');
  if (execNormalized && execNormalized.includes(rootNormalized)) {
    const hit = hints.find((hint) => lower.includes(hint));
    if (hit) {
      return { ours: true, reason: `解释器在项目内且命令行含标识「${hit}」` };
    }
  }

  // ⑤ **解释器落在项目内 venv 且入口是相对 server.py** —— 兜底再宽一档：
  //    只要解释器路径在项目内、且入口脚本形如 `<hint>/server.py`，
  //    即便命令行里没有别的标识词也认定（项目内 venv 几乎不可能是别人起的）。
  if (execNormalized && execNormalized.includes(rootNormalized) && entry) {
    const entryPath = entry[1];
    if (hints.some((hint) => entryPath.includes(hint))) {
      return { ours: true, reason: `解释器在项目内且入口为 ${entryPath}` };
    }
  }

  return { ours: false, reason: `命令行与本项目无关（名字 ${name || '未知'}）` };
}

/** 读一批进程的**可执行文件路径**（用于 ④⑤ 判据；Windows 走 CIM，失败返回空表） */
async function readExecutablePaths(pids: number[]): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  if (pids.length === 0 || process.platform !== 'win32') return result;
  const filter = pids.map((pid) => `ProcessId=${pid}`).join(' OR ');
  const script =
    `Get-CimInstance Win32_Process -Filter "${filter}" | ` +
    `Select-Object ProcessId,ExecutablePath | ConvertTo-Json -Compress`;
  const out = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], 12_000);
  if (!out.trim()) return result;
  try {
    const parsed = JSON.parse(out.trim()) as
      | { ProcessId: number; ExecutablePath?: string }
      | Array<{ ProcessId: number; ExecutablePath?: string }>;
    for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
      if (item.ExecutablePath) result.set(item.ProcessId, item.ExecutablePath);
    }
  } catch {
    // 解析失败：调用方会因拿不到路径而退回命令行判据，安全侧
  }
  return result;
}

/**
 * 从服务 `/health` 里挖出它自报的 PID。
 *
 * 三个服务的字段名各不相同（实测）：
 *   * 网易 TTS / ASR → `pid`
 *   * IndexTTS       → `processor_id` / `worker_pid`
 * 所以按名字宽松匹配 `pid | process_id | worker_pid`（大小写不敏感）的**数值**字段。
 */
async function fetchSelfReportedPids(baseUrl: string | undefined, timeoutMs = 3_000): Promise<Set<number>> {
  const found = new Set<number>();
  if (!baseUrl) return found;
  const url = `${baseUrl.replace(/\/+$/, '')}/health`;
  let payload: unknown;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return found;
    payload = await response.json();
  } catch {
    return found; // 服务没起 / 端口不对 —— 拿不到自报 PID 就退回命令行判据
  }

  const FIELD = /^(pid|process_id|processor_id|worker_pid)$/i;
  const walk = (node: unknown, depth: number): void => {
    if (depth > 4 || node === null || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isInteger(value) && value > 0 && FIELD.test(key)) {
        found.add(value);
      } else if (typeof value === 'string' && FIELD.test(key) && /^\d+$/.test(value)) {
        found.add(Number.parseInt(value, 10));
      } else if (typeof value === 'object') {
        walk(value, depth + 1);
      }
    }
  };
  walk(payload, 0);
  return found;
}

/** 按端口找出「属于本项目的服务进程」 */
export async function findServiceProcesses(port: number, hints: string[], baseUrl?: string): Promise<PortOwner[]> {
  const pids = await findPortOwners(port);
  if (pids.length === 0) return [];

  const [info, execPaths, selfReported] = await Promise.all([
    readProcessInfo(pids),
    readExecutablePaths(pids),
    fetchSelfReportedPids(baseUrl),
  ]);

  return pids.map((pid) => {
    const detail = info.get(pid) ?? { name: '', commandLine: '' };
    const { ours, reason } = classify(detail.commandLine, detail.name, hints, {
      executablePath: execPaths.get(pid),
      selfReported: selfReported.has(pid),
    });
    return { pid, name: detail.name, commandLine: detail.commandLine.slice(0, 400), ours, reason };
  });
}

/**
 * 结束进程树。
 *
 * Windows 必须用 `taskkill /t /f`：`child.kill()` 杀不掉脚本再拉起的孙进程
 * （实测网易服务的真实监听者是 `python.exe ← python.exe ← node.exe` 的**第三代**，
 * 只杀 node 会留下两个孤儿 python 继续占着 9882 端口与显存）。
 */
export function killTree(pid: number, opts: { force?: boolean } = {}): void {
  if (process.platform === 'win32') {
    const args = ['/pid', String(pid), '/t'];
    if (opts.force !== false) args.push('/f');
    try {
      execFile('taskkill', args, { windowsHide: true, stdio: 'ignore' } as never, () => {
        // 结果不关心：调用方随后用端口探活复核
      });
      return;
    } catch {
      // 落回默认实现
    }
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // 进程可能已经退出
  }
}

/** 进程是否还活着 */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export { PROJECT_ROOT };

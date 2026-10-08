import { execFile } from 'node:child_process';

/**
 * 「谁在占 GPU」的进程清单与手动停止。
 *
 * 存在的理由：显存不足的报错让用户「关掉占显存的程序」，但用户根本不知道
 * 是谁在占 —— 8 GB 卡上跑着 30+ 个 GPU 进程，靠任务管理器一个个看并不现实。
 * 这里把 nvidia-smi 的进程表列出来（每个 pid 一行 + 按程序名聚合的视图），
 * 并允许用户在界面上**手动选中某个进程后停止**（阶段 26补9，用户明确要的能力）。
 *
 * 诚实约束：Windows WDDM 下 `used_memory` 经常报 N/A（拿不到每进程精确占用），
 * 拿不到就显示 null，界面标「未知」—— 宁可信息少，不能信息假。
 *
 * 停止进程的护栏（与 arbiter「不扫描、不主动 kill」的边界不冲突：
 * 这里只杀**用户在显存监控小窗里亲眼选中**的 pid，且必须出现在最近一次
 * nvidia-smi 快照里；系统关键进程与本网关自身一律拒绝）。
 */

export interface GpuProcessEntry {
  pid: number;
  /** 可执行文件名（不含路径） */
  name: string;
  /** 该进程占用的显存 MB；WDDM 下可能拿不到（null） */
  mem_mb: number | null;
}

export interface GpuProcessGroup {
  name: string;
  count: number;
  /** 该程序名下显存合计 MB；全部读不到时为 null */
  mem_mb: number | null;
  pids: number[];
}

const CACHE_TTL_MS = 10_000;
let cached: { at: number; entries: GpuProcessEntry[] } = { at: 0, entries: [] };

function baseName(raw: string): string {
  const trimmed = raw.trim();
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed;
}

function querySmi(): Promise<GpuProcessEntry[]> {
  return new Promise((resolve) => {
    execFile(
      'nvidia-smi',
      ['--query-compute-apps=pid,process_name,used_memory', '--format=csv,noheader,nounits'],
      { timeout: 5_000, windowsHide: true },
      (error, stdout) => {
        if (error) {
          // 读不到就空着，界面据此不显示这一段（不误导）
          resolve([]);
          return;
        }
        const entries: GpuProcessEntry[] = [];
        for (const line of stdout.split(/\r?\n/)) {
          if (!line.trim()) continue;
          // 逗号分隔：pid, 路径（Windows 路径不含逗号）, 显存MB
          const firstComma = line.indexOf(',');
          const lastComma = line.lastIndexOf(',');
          if (firstComma < 0 || lastComma <= firstComma) continue;
          const pid = Number(line.slice(0, firstComma).trim());
          const name = baseName(line.slice(firstComma + 1, lastComma));
          const memRaw = line.slice(lastComma + 1).trim();
          if (!Number.isFinite(pid) || pid <= 4) continue;
          // nvidia-smi 对无权限查看的进程打占位符，列出来只会干扰判断
          if (/insufficient permissions|^\[/.test(name)) continue;
          const mem = Number(memRaw);
          entries.push({ pid, name, mem_mb: Number.isFinite(mem) ? mem : null });
        }
        resolve(entries);
      },
    );
  });
}

/** 进程列表（10 秒缓存）。 */
export async function gpuProcessEntries(force = false): Promise<GpuProcessEntry[]> {
  const now = Date.now();
  if (!force && now - cached.at < CACHE_TTL_MS) return cached.entries;
  const entries = await querySmi();
  // nvidia-smi 偶发失败时不要把空表缓存住——下一次请求应当重试
  cached = { at: entries.length > 0 || !force ? now : 0, entries };
  return entries;
}

/** 按程序名聚合的视图（旧接口形状，补上显存合计）。 */
export async function gpuProcesses(): Promise<GpuProcessGroup[]> {
  const entries = await gpuProcessEntries();
  const map = new Map<string, GpuProcessGroup>();
  for (const entry of entries) {
    const group = map.get(entry.name) ?? { name: entry.name, count: 0, mem_mb: null, pids: [] };
    group.count += 1;
    group.pids.push(entry.pid);
    if (entry.mem_mb != null) group.mem_mb = (group.mem_mb ?? 0) + entry.mem_mb;
    map.set(entry.name, group);
  }
  return [...map.values()].sort(
    (a, b) => (b.mem_mb ?? -1) - (a.mem_mb ?? -1) || b.count - a.count || a.name.localeCompare(b.name),
  );
}

/** 绝不允许从这里杀掉的进程名（taskkill 真去动它们只会把系统搞崩） */
const PROTECTED_NAMES = new Set([
  'csrss.exe',
  'wininit.exe',
  'smss.exe',
  'services.exe',
  'lsass.exe',
  'svchost.exe',
  'dwm.exe',
  'explorer.exe',
  'winlogon.exe',
  'fontdrvhost.exe',
]);

export interface KillResult {
  killed: boolean;
  status: 'ok' | 'not_listed' | 'protected' | 'failed';
  message: string;
  hint?: string;
}

/**
 * 手动停止一个 GPU 进程。
 * 护栏：pid 必须在最近一次 nvidia-smi 快照里（强制刷新一次再核对）、
 * 不在保护名单里、不是本网关自己。满足才 taskkill /F /T。
 */
export async function killGpuProcess(pid: number): Promise<KillResult> {
  if (!Number.isFinite(pid) || pid <= 4) {
    return { killed: false, status: 'protected', message: `pid ${pid} 是系统进程，拒绝停止`, hint: '只停你在列表里看到的普通程序。' };
  }
  if (pid === process.pid) {
    return { killed: false, status: 'protected', message: '这是本工作台网关自己，不能从这里停', hint: '关工作台请用终端 Ctrl+C 或 start.bat 的窗口。' };
  }
  const entries = await gpuProcessEntries(true);
  const match = entries.find((entry) => entry.pid === pid);
  if (!match) {
    return {
      killed: false,
      status: 'not_listed',
      message: `pid ${pid} 当前不在 GPU 进程表里`,
      hint: '列表可能过期了（10 秒缓存），刷新小窗后再试；进程可能已经自己退出。',
    };
  }
  if (PROTECTED_NAMES.has(match.name.toLowerCase())) {
    return { killed: false, status: 'protected', message: `${match.name} 是系统关键进程，拒绝停止`, hint: '它占的显存通常是桌面合成，关不掉也不该关。' };
  }

  return new Promise((resolve) => {
    execFile('taskkill', ['/F', '/T', '/PID', String(pid)], { timeout: 10_000, windowsHide: true }, (error, _stdout, stderr) => {
      if (error) {
        resolve({
          killed: false,
          status: 'failed',
          message: `停止 ${match.name}（pid ${pid}）失败`,
          hint: (stderr || error.message).trim().slice(0, 200) || '可能权限不足：以管理员身份重开网关再试。',
        });
        return;
      }
      resolve({
        killed: true,
        status: 'ok',
        message: `已停止 ${match.name}（pid ${pid}）`,
        hint: match.mem_mb != null ? `归还显存约 ${(match.mem_mb / 1024).toFixed(1)} GB` : undefined,
      });
    });
  });
}

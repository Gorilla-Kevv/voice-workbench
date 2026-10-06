import { execFile } from 'node:child_process';

/**
 * 「谁在占 GPU」的进程清单。
 *
 * 存在的理由：显存不足的报错让用户「关掉占显存的程序」，但用户根本不知道
 * 是谁在占 —— 8 GB 卡上跑着 30+ 个 GPU 进程，靠任务管理器一个个看并不现实。
 * 这里把 nvidia-smi 的进程表按程序名聚合出来给界面展示。
 *
 * 注意 Windows WDDM 的局限：`used_memory` 常报 N/A（拿不到每进程精确占用），
 * 所以只报「谁在 + 几个实例」，不编造每进程的 MB 数 —— 宁可信息少，不能信息假。
 */

export interface GpuProcessGroup {
  /** 可执行文件名（不含路径） */
  name: string;
  /** 实例数（Electron 类应用常一开七8 个进程） */
  count: number;
}

const CACHE_TTL_MS = 10_000;
let cached: { at: number; groups: GpuProcessGroup[] } = { at: 0, groups: [] };

function baseName(raw: string): string {
  const trimmed = raw.trim();
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed;
}

export function gpuProcesses(): Promise<GpuProcessGroup[]> {
  const now = Date.now();
  if (now - cached.at < CACHE_TTL_MS) return Promise.resolve(cached.groups);

  return new Promise((resolve) => {
    execFile(
      'nvidia-smi',
      ['--query-compute-apps=process_name', '--format=csv,noheader'],
      { timeout: 5_000, windowsHide: true },
      (error, stdout) => {
        if (error) {
          // 读不到就空着，界面据此不显示这一段（不误导）
          cached = { at: now, groups: [] };
          resolve([]);
          return;
        }
        const counts = new Map<string, number>();
        for (const line of stdout.split(/\r?\n/)) {
          if (!line.trim()) continue;
          const name = baseName(line);
          // nvidia-smi 对无权限查看的进程打占位符，列出来只会干扰判断
          if (/insufficient permissions|^\[/.test(name)) continue;
          counts.set(name, (counts.get(name) ?? 0) + 1);
        }
        const groups = [...counts.entries()]
          .map(([name, count]) => ({ name, count }))
          .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
        cached = { at: now, groups };
        resolve(groups);
      },
    );
  });
}

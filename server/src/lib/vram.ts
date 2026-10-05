import { execFile } from 'node:child_process';

/**
 * 网关自己的显存读数。
 *
 * 为什么网关要会这一手：`/health` 的显存数字目前来自网易服务（它用 nvidia-smi），
 * 但**网易服务没启动时就没有这个数** —— 而「启动时要不要预加载模型」这个判断
 * 恰恰要在任何服务都还没起来的时候做。所以网关自己读一次。
 *
 * 取数与 `netease/app/hardware.py` 保持一致：**nvidia-smi 优先**（跨进程真实值）。
 * 不能用 torch —— Windows WDDM 下 torch 只看得到本进程视图（见 HANDOFF 坑 17）。
 */

const CACHE_TTL_MS = 3_000;
let cached: { at: number; free: number | null; total: number | null } = { at: 0, free: null, total: null };

export function vramMb(): Promise<{ free_mb: number | null; total_mb: number | null; source: string }> {
  const now = Date.now();
  if (now - cached.at < CACHE_TTL_MS) {
    return Promise.resolve({
      free_mb: cached.free,
      total_mb: cached.total,
      source: cached.free == null ? 'unavailable' : 'nvidia-smi',
    });
  }

  return new Promise((resolve) => {
    execFile(
      'nvidia-smi',
      ['--query-gpu=memory.free,memory.total', '--format=csv,noheader,nounits'],
      { timeout: 5_000, windowsHide: true },
      (error, stdout) => {
        if (error) {
          cached = { at: now, free: null, total: null };
          resolve({ free_mb: null, total_mb: null, source: 'unavailable' });
          return;
        }
        const first = stdout.trim().split(/\r?\n/)[0] ?? '';
        const [freeRaw, totalRaw] = first.split(',');
        const free = Number.parseFloat(freeRaw ?? '');
        const total = Number.parseFloat(totalRaw ?? '');
        cached = {
          at: now,
          free: Number.isFinite(free) ? Math.round(free) : null,
          total: Number.isFinite(total) ? Math.round(total) : null,
        };
        resolve({ free_mb: cached.free, total_mb: cached.total, source: 'nvidia-smi' });
      },
    );
  });
}

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from '../config/index.js';
import { logger } from '../lib/logger.js';
import { findServiceProcesses, killTree } from '../lib/processOwnership.js';

/**
 * 通用运行时服务托管器：网易（:9882）与 IndexTTS（:9883）。
 *
 * 与 `sovits.ts` 的 SovitsSupervisor 同一套行为契约，但刻意更薄：
 * - 启动走 `node scripts/<name>.mjs`（解释器探测 / venv 判断都留在脚本里，一份逻辑一个家）；
 * - 探活可达就**复用外部实例**（`npm run dev` 的 concurrently 起的也算），不重复拉起；
 * - 关闭 = 先卸模型（尽力归还显存）→ 再杀**我们自己拉起**的进程树；外部实例杀不掉，
 *   如实返回 managed=false，由界面提示用户去对应终端关。
 *
 * 为什么要给这两个服务加开关：服务进程本身（torch CUDA 上下文）也要占几百 MB 显存，
 * 而且「三个服务全在跑」对使用者来说看不出谁占了多少 —— 能在设置里一键关掉才有掌控感。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..', '..', '..');

export interface RuntimeSpec {
  /** 服务标识，同时决定 flag 文件名 */
  id: 'netease' | 'indextts';
  label: string;
  /** 网关侧读取的服务地址（config 里可被环境变量覆盖） */
  baseUrl: () => string;
  /** 启动脚本（相对项目根） */
  script: string;
  /** 关闭前要调用的模型卸载端点（尽力而为，404/连不上都算过） */
  unloadEndpoints: string[];
  /**
   * 进程归属判据词（小写）。
   *
   * 用于「按端口反查进程」时判断该进程是不是本项目的服务 ——
   * 只有命令行里确实出现这些词（且指向本项目路径）才会被杀。
   * **不要写得过泛**（例如只写 `python`），否则会误杀无关进程。
   */
  hints: string[];
  /** 默认是否启用：网易是主服务（true），IndexTTS 按需（false） */
  defaultEnabled: boolean;
  /** 等待就绪的上限 */
  readyTimeoutMs: number;
}

export interface RuntimeStatus {
  baseUrl: string;
  reachable: boolean;
  managed: boolean;
  starting: boolean;
  enabled: boolean;
  pid: number | null;
  lastError: string | null;
  /** 上次关闭时的补充说明（谁没杀掉 / 端口被谁占），供界面如实展示 */
  shutdownNote: string | null;
}

const IMPORTANT_LINE = /error|exception|traceback|failed|地址已被占用|port/i;

function readFlag(file: string, fallback: boolean): boolean {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { enabled?: boolean };
    return typeof raw.enabled === 'boolean' ? raw.enabled : fallback;
  } catch {
    return fallback;
  }
}

function writeFlag(file: string, enabled: boolean): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ enabled, updatedAt: Date.now() }, null, 2));
  } catch {
    // 写不进去只影响本次进程内的记忆
  }
}

/** 结束进程树。Windows 上 child.kill() 杀不掉脚本再拉起的孙进程。 */
function killTreeLocal(pid: number): void {
  killTree(pid);
}

export class RuntimeSupervisor {
  private readonly flagFile: string;
  private enabled: boolean;
  private child: ChildProcess | null = null;
  private starting: Promise<void> | null = null;
  private reachable = false;
  private lastError: string | null = null;
  private readonly logs: string[] = [];
  /** 主动关闭标记：shutdown 杀自己拉起的进程是预期行为，不能记成「异常退出」 */
  private stopping = false;
  /** 最近一次关闭时「谁被杀了 / 谁杀不掉」的说明，供界面如实展示 */
  private lastShutdownNote: string | null = null;

  constructor(private readonly spec: RuntimeSpec) {
    this.flagFile = path.join(PROJECT_ROOT, 'server', '.data', `${spec.id}-service.json`);
    this.enabled = readFlag(this.flagFile, spec.defaultEnabled);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** 服务监听端口（从 baseUrl 解析；拿不到返回 null） */
  private targetPort(): number | null {
    try {
      const url = new URL(this.spec.baseUrl());
      if (url.port) return Number(url.port);
      return url.protocol === 'https:' ? 443 : 80;
    } catch {
      return null;
    }
  }

  async probe(timeoutMs = 1_500): Promise<boolean> {
    try {
      const response = await fetch(`${this.spec.baseUrl()}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(timeoutMs),
      });
      this.reachable = response.ok;
    } catch {
      this.reachable = false;
    }
    return this.reachable;
  }

  /** 幂等启动：已可达就复用；enabled 关着就不动。 */
  async ensureStarted(): Promise<void> {
    if (this.starting) return this.starting;
    if (await this.probe()) return;
    if (!this.enabled) return;
    this.starting = this.spawnService().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async spawnService(): Promise<void> {
    const scriptPath = path.join(PROJECT_ROOT, this.spec.script);
    if (!fs.existsSync(scriptPath)) {
      this.lastError = `未找到启动脚本：${scriptPath}`;
      logger.warn(this.lastError);
      return;
    }
    logger.info(`正在启动 ${this.spec.label} 服务`, { script: this.spec.script });
    const child = spawn(process.execPath, [scriptPath], {
      cwd: PROJECT_ROOT,
      windowsHide: true,
      env: { ...process.env },
    });
    this.child = child;

    const absorb = (data: Buffer) => {
      for (const line of data.toString('utf-8').split(/\r?\n/).filter(Boolean)) {
        this.logs.push(line);
        if (this.logs.length > 200) this.logs.splice(0, this.logs.length - 200);
        if (IMPORTANT_LINE.test(line)) logger.warn(`[${this.spec.id}] ${line}`);
      }
    };
    child.stdout?.on('data', absorb);
    child.stderr?.on('data', absorb);
    child.on('error', (error: Error) => {
      this.lastError = `启动 ${this.spec.label} 失败：${error.message}`;
      logger.error(this.lastError);
    });
    child.on('exit', (code) => {
      this.child = null;
      this.reachable = false;
      if (this.stopping) {
        // shutdown() 主动 taskkill：退出码非 0 是强杀的正常表现，不记错误
        this.stopping = false;
        return;
      }
      if (code !== 0 && code !== null) {
        this.lastError = `${this.spec.label} 异常退出（退出码 ${code}），最后输出：${this.logs.slice(-3).join(' / ') || '(无)'}`;
        logger.error(this.lastError);
      }
    });

    // 轮询直到就绪或超时（脚本冷启动要 import torch，给足余量）
    const deadline = Date.now() + this.spec.readyTimeoutMs;
    while (Date.now() < deadline) {
      if (await this.probe()) {
        this.lastError = null;
        logger.info(`${this.spec.label} 服务已就绪`, { baseUrl: this.spec.baseUrl() });
        return;
      }
      if (this.child === null) return; // 已异常退出，错误信息在 lastError
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    this.lastError = this.lastError ?? `等待 ${this.spec.label} 就绪超时（${Math.round(this.spec.readyTimeoutMs / 1000)}s）`;
    logger.warn(this.lastError, { logs: this.logs.slice(-5) });
  }

  /** 卸掉该服务的常驻模型（不管进程归谁托管，先归还显存）。 */
  async releaseModels(): Promise<boolean> {
    let released = false;
    for (const endpoint of this.spec.unloadEndpoints) {
      try {
        await fetch(`${this.spec.baseUrl()}${endpoint}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
          signal: AbortSignal.timeout(15_000),
        });
        released = true;
      } catch {
        // 服务不在 / 没这个端点：无所谓
      }
    }
    return released;
  }

  /**
   * 关闭服务：**先卸模型（尽力归还显存）→ 再杀进程树**。
   *
   * 关键修复（2026-10 用户实测反馈「网易进程关不掉，想切换 IndexTTS 无法切换」）：
   * 原实现只杀 `this.child`，而服务的启动方式有三条 ——
   *   ① 网关 spawn（`this.child` 有值）→ 能杀；
   *   ② `npm run dev` 的 concurrently 起的 → `this.child === null` → **原来直接放弃**；
   *   ③ 用户自己 `node scripts/nettease.mjs` 起的 → 同上。
   *
   * 结果：用户在设置里关掉网易，flag 写成了 `enabled: false`，但 9882 端口仍然
   * LISTENING、显存照占，切 IndexTTS 时两个服务抢显存。
   *
   * 现在补上「**按端口反查监听进程 + 项目归属校验**」这条路径：
   *   * 归属判据见 `lib/processOwnership.ts` —— 只在命令行确实指向本项目
   *     `scripts/<name>.mjs`（或含本项目根路径 + 服务标识词）时才杀；
   *   * 判不了归属的一律不动（宁可提示用户手动关，也不误杀陌生进程）。
   *
   * 另外必须 `/t` 杀整棵树：网易服务的真实监听者是
   * `python.exe ← python.exe ← node.exe` 的第三代，只杀 node 会留下孤儿 python。
   */
  async shutdown(): Promise<{ stopped: boolean; releasedVram: boolean; managed: boolean; reachable: boolean }> {
    const releasedVram = await this.releaseModels();

    // ---- 第一路：本进程 spawn 的那个，直接杀 ----
    const child = this.child;
    if (child && child.pid !== undefined) {
      this.stopping = true;
      this.child = null;
      killTreeLocal(child.pid);
      // 兜底：强杀理论必死；万一没死，10s 后恢复错误上报，避免吞掉下一次真实崩溃
      setTimeout(() => {
        this.stopping = false;
      }, 10_000);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    // ---- 第二路：端口上还活着的（外部实例 / 上一路的孤儿孙进程）----
    const port = this.targetPort();
    if (port !== null) {
      const owners = await findServiceProcesses(port, this.spec.hints, this.spec.baseUrl());
      const ours = owners.filter((item) => item.ours);
      if (ours.length > 0) {
        for (const owner of ours) {
          logger.info(`正在关闭 ${this.spec.label} 服务（端口反查命中）`, {
            pid: owner.pid,
            name: owner.name,
            reason: owner.reason,
          });
          killTreeLocal(owner.pid);
        }
        // 给 taskkill 一点时间落地，然后复核端口是否真的空出来
        await new Promise((resolve) => setTimeout(resolve, 900));
      }
      const left = await findServiceProcesses(port, this.spec.hints, this.spec.baseUrl());
      const stubborn = left.filter((item) => item.ours);
      if (stubborn.length > 0) {
        // 杀不掉（权限不足 / 被保护）——如实说，不假装成功
        this.lastShutdownNote =
          `端口 ${port} 上仍有 ${stubborn.length} 个本服务进程未能结束` +
          `（PID ${stubborn.map((s) => s.pid).join('、')}）——可能权限不足，请用管理员身份重试或在任务管理器结束。`;
        this.lastError = this.lastShutdownNote;
        this.reachable = await this.probe();
        return { stopped: false, releasedVram, managed: true, reachable: this.reachable };
      }
      const strangers = left.filter((item) => !item.ours);
      if (strangers.length > 0 && ours.length === 0) {
        // 端口被别人的程序占着：不动它，但把实情告诉用户
        this.lastShutdownNote =
          `端口 ${port} 被其它程序占用（PID ${strangers.map((s) => s.pid).join('、')}），` +
          `不是本项目的服务，未做处理。`;
        this.reachable = await this.probe();
        return { stopped: false, releasedVram, managed: false, reachable: this.reachable };
      }
    }

    const stopped = child !== null || (port !== null && (await findServiceProcesses(port, this.spec.hints, this.spec.baseUrl())).length === 0);
    this.reachable = stopped ? false : await this.probe();
    this.lastShutdownNote = stopped ? null : this.lastShutdownNote;
    return { stopped, releasedVram, managed: true, reachable: this.reachable };
  }

  async setEnabled(next: boolean): Promise<{ enabled: boolean; reachable: boolean; stopped?: boolean; releasedVram?: boolean; managed?: boolean }> {
    this.enabled = next;
    writeFlag(this.flagFile, next);
    if (next) {
      await this.ensureStarted();
      return { enabled: true, reachable: (await this.probe()) || this.reachable };
    }
    const result = await this.shutdown();
    logger.info(`已按设置关闭 ${this.spec.label} 服务`, result);
    return { enabled: false, ...result };
  }

  /** 外部实例关不掉时的提示文案要区分得出来，这里把状态原样给路由层。 */
  status(): RuntimeStatus {
    return {
      baseUrl: this.spec.baseUrl(),
      reachable: this.reachable,
      managed: this.child !== null,
      starting: this.starting !== null,
      enabled: this.enabled,
      pid: this.child?.pid ?? null,
      lastError: this.lastError,
      shutdownNote: this.lastShutdownNote,
    };
  }
}

export const neteaseSupervisor = new RuntimeSupervisor({
  id: 'netease',
  label: '网易 Confucius4-TTS',
  baseUrl: () => config.netease.baseUrl,
  script: 'scripts/netease.mjs',
  unloadEndpoints: ['/v1/confucius/unload', '/v1/r2t2/unload'],
  // `netease` 足够特异（本项目目录名/脚本名都是它）；再带上 python 是为了覆盖
  // 「python 只继承了部分参数」的场景，但**必须与项目根路径同时出现**才生效
  hints: ['netease', 'confucius', 'r2t2'],
  defaultEnabled: true,
  readyTimeoutMs: 300_000,
});

export const indexttsSupervisor = new RuntimeSupervisor({
  id: 'indextts',
  label: 'IndexTTS',
  baseUrl: () => config.indextts.baseUrl,
  script: 'scripts/indextts.mjs',
  unloadEndpoints: ['/v1/unload'],
  hints: ['indextts', 'index-tts'],
  defaultEnabled: false,
  readyTimeoutMs: 300_000,
});

/** 网关自己的启动/退出钩子按这张表遍历，新增运行时只加实例 */
export const runtimeSupervisors: RuntimeSupervisor[] = [neteaseSupervisor, indexttsSupervisor];

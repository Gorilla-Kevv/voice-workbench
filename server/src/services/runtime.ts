import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from '../config/index.js';
import { logger } from '../lib/logger.js';

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
function killTree(pid: number): void {
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
      return;
    } catch {
      // 落回默认实现
    }
  }
  try {
    process.kill(pid);
  } catch {
    // 已退出
  }
}

export class RuntimeSupervisor {
  private readonly flagFile: string;
  private enabled: boolean;
  private child: ChildProcess | null = null;
  private starting: Promise<void> | null = null;
  private reachable = false;
  private lastError: string | null = null;
  private readonly logs: string[] = [];

  constructor(private readonly spec: RuntimeSpec) {
    this.flagFile = path.join(PROJECT_ROOT, 'server', '.data', `${spec.id}-service.json`);
    this.enabled = readFlag(this.flagFile, spec.defaultEnabled);
  }

  isEnabled(): boolean {
    return this.enabled;
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

  /** 只杀由本进程拉起的实例；外部实例不动（但模型会先卸掉）。 */
  async shutdown(): Promise<{ stopped: boolean; releasedVram: boolean; managed: boolean; reachable: boolean }> {
    const releasedVram = await this.releaseModels();
    const child = this.child;
    if (!child || child.pid === undefined) {
      return { stopped: false, releasedVram, managed: false, reachable: await this.probe() };
    }
    killTree(child.pid);
    this.child = null;
    this.reachable = false;
    await new Promise((resolve) => setTimeout(resolve, 400));
    return { stopped: true, releasedVram, managed: true, reachable: false };
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
    };
  }
}

export const neteaseSupervisor = new RuntimeSupervisor({
  id: 'netease',
  label: '网易 Confucius4-TTS',
  baseUrl: () => config.netease.baseUrl,
  script: 'scripts/netease.mjs',
  unloadEndpoints: ['/v1/confucius/unload', '/v1/r2t2/unload'],
  defaultEnabled: true,
  readyTimeoutMs: 300_000,
});

export const indexttsSupervisor = new RuntimeSupervisor({
  id: 'indextts',
  label: 'IndexTTS',
  baseUrl: () => config.indextts.baseUrl,
  script: 'scripts/indextts.mjs',
  unloadEndpoints: ['/v1/unload'],
  defaultEnabled: false,
  readyTimeoutMs: 300_000,
});

/** 网关自己的启动/退出钩子按这张表遍历，新增运行时只加实例 */
export const runtimeSupervisors: RuntimeSupervisor[] = [neteaseSupervisor, indexttsSupervisor];

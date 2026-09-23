/**
 * GPT-SoVITS 本地服务（trainer/）的托管与探活。
 *
 * 为什么由 Node 侧托管：本项目是**本地部署**，用户的心智模型是
 * 「跑一条命令，打开浏览器就能用」。让用户先开一个 Python 服务、
 * 再开一个 Node 服务、还要自己对齐端口与解释器，是把复杂度丢给了用户。
 *
 * 三件事让托管变得可靠：
 *
 * 1. **先探活再启动** —— 端口上已经有服务就不再拉起第二个（用户可能自己
 *    开着一个常驻的、带训练的实例）；重复启动只会抢显存。
 * 2. **解释器必须选对** —— torch 装在 GPT-SoVITS 整合包的 `runtime/` 里，
 *    用系统 Python 启动会因为 `import torch` 失败而什么都干不了。
 *    这里按 `runtime/python.exe` → `runtime/bin/python3` → PATH 的顺序探测。
 * 3. **日志留在内存里** —— 本地服务最常见的求助是「它没起来」，
 *    此时能在 `/api/health` 里直接看到 Python 侧的最后几行输出，
 *    比让用户去翻日志文件高效得多。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from '../config/index.js';
import { logger } from '../lib/logger.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** server/src/services → 项目根目录（dev 与 dist 两种布局的层级相同） */
const PROJECT_ROOT = path.resolve(HERE, '..', '..', '..');
const TRAINER_DIR = path.join(PROJECT_ROOT, 'trainer');

/** 内存中的日志环形缓冲，供诊断使用 */
const LOG_LIMIT = 240;

export interface SovitsStatus {
  /** Node 配置的目标地址 */
  baseUrl: string;
  /** 最近一次探活是否成功 */
  reachable: boolean;
  /** 是否由本进程拉起 */
  managed: boolean;
  /** 是否在项目目录下找到了 GPT-SoVITS 整合包 */
  installed: boolean;
  /** 子进程 pid（未托管时为 null） */
  pid: number | null;
  starting: boolean;
  lastError: string | null;
  lastCheckAt: number;
  /** 解析到的 GPT-SoVITS 根目录 */
  home: string | null;
  /** 启动时使用的解释器 */
  python: string | null;
  /** 子进程退出码，非 0 表示启动失败 */
  exitCode: number | null;
}

/** 探活超时。本地环回地址，5 秒足够 */
const PROBE_TIMEOUT_MS = 5_000;

function ringPush(buffer: string[], line: string): void {
  buffer.push(line);
  if (buffer.length > LOG_LIMIT) buffer.splice(0, buffer.length - LOG_LIMIT);
}

function splitLines(chunk: string): string[] {
  return chunk
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

/**
 * 判断 Python 侧的一行输出是否值得在默认（非 verbose）模式下透出到控制台。
 *
 * 这个过滤刻意只盯「明确的错误」，不包含 warning：
 * Python 生态里的 warning 噪音极大（torch 的 UserWarning、future warning 之类），
 * 一旦放进来就会把真正要看的东西淹掉。而服务真起不来时，
 * supervisor 自己会走 logger.warn / logger.error 的显式路径（就绪超时、退出码非 0），
 * 不会因为这里的过滤而漏报。
 */
const IMPORTANT_LINE =
  /\b(error|critical|traceback|exception|failed|failure|refused|denied|no such file|cannot|unable)\b/i;

/** `/health` 的响应形状（只声明本项目用到的字段，其余原样忽略） */
interface HealthPayload {
  installation?: { version_hint?: string };
  runtime?: { device_label?: string };
  pipeline?: { version?: string; loaded?: boolean };
  voices?: { total?: number };
  blockers?: string[];
}

/**
 * 设备名精简：`CUDA · NVIDIA GeForce RTX 4060 Laptop GPU 8187MB`
 * → `CUDA · RTX 4060 Laptop GPU 8187MB`。
 * 「NVIDIA GeForce」这七个字在每一行摘要里都是纯噪声。
 */
function compactDevice(label: string | undefined): string {
  if (!label) return '设备未知';
  return label.replace('NVIDIA GeForce ', '');
}

class SovitsSupervisor {
  private child: ChildProcess | null = null;
  private reachable = false;
  private starting: Promise<void> | null = null;
  private lastError: string | null = null;
  private lastCheckAt = 0;
  private exitCode: number | null = null;
  private home: string | null = null;
  private python: string | null = null;
  private health: HealthPayload | null = null;
  private readonly logs: string[] = [];

  // ------------------------------------------------------------------
  // 探测
  // ------------------------------------------------------------------

  /** 解析 GPT-SoVITS 根目录：显式配置优先，否则在项目根目录下找整合包。 */
  resolveHome(): string | null {
    if (this.home) return this.home;

    const candidates: string[] = [];
    if (config.sovits.home) candidates.push(config.sovits.home);

    try {
      for (const entry of fs.readdirSync(PROJECT_ROOT, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (!/^gpt[-_]?sovits/i.test(entry.name)) continue;
        candidates.push(path.join(PROJECT_ROOT, entry.name));
      }
    } catch {
      // 目录不可读时静默跳过，交给 Python 侧报错
    }

    for (const candidate of candidates) {
      if (this.looksLikeInstall(candidate)) {
        this.home = candidate;
        return candidate;
      }
    }
    return null;
  }

  private looksLikeInstall(dir: string): boolean {
    const markers = [
      path.join(dir, 'GPT_SoVITS', 'inference_webui.py'),
      path.join(dir, 'GPT_SoVITS', 'inference_cli.py'),
      path.join(dir, 'inference_webui.py'),
    ];
    return markers.some((marker) => fs.existsSync(marker));
  }

  /** 选择能 `import torch` 的解释器：整合包自带的优先。 */
  resolvePython(home: string | null): string {
    if (config.sovits.python) return config.sovits.python;
    if (this.python) return this.python;

    const bundled = home
      ? [
          path.join(home, 'runtime', 'python.exe'),
          path.join(home, 'runtime', 'python'),
          path.join(home, 'runtime', 'bin', 'python3'),
          path.join(home, 'runtime', 'bin', 'python'),
          path.join(home, 'venv', 'Scripts', 'python.exe'),
          path.join(home, 'venv', 'bin', 'python'),
        ].find((candidate) => fs.existsSync(candidate))
      : undefined;

    const resolved = bundled ?? (process.platform === 'win32' ? 'python' : 'python3');
    this.python = resolved;
    return resolved;
  }

  private targetPort(): number {
    try {
      const url = new URL(config.sovits.baseUrl);
      return Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
    } catch {
      return 9881;
    }
  }

  // ------------------------------------------------------------------
  // 探活
  // ------------------------------------------------------------------

  async probe(timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${config.sovits.baseUrl}/health`, {
        method: 'GET',
        signal: controller.signal,
      });
      // 只要服务在监听，就算就绪：/health 的 ready=false 是它自己的体检结论
      this.reachable = response.ok;
      // 顺手留下体检内容，供就绪时打一条浓缩摘要 —— 省掉一次额外请求。
      // 解析失败不影响探活结论：探活只关心「端口有没有人应答」。
      if (response.ok) {
        this.health = (await response.json().catch(() => null)) as HealthPayload | null;
      }
    } catch {
      this.reachable = false;
    } finally {
      clearTimeout(timer);
      this.lastCheckAt = Date.now();
    }
    return this.reachable;
  }

  // ------------------------------------------------------------------
  // 生命周期
  // ------------------------------------------------------------------

  /** 幂等启动。已就绪或正在启动时直接返回。 */
  async ensureStarted(): Promise<void> {
    if (this.starting) return this.starting;
    if (await this.probe()) {
      logger.info('已复用外部运行的 GPT-SoVITS 服务', { baseUrl: config.sovits.baseUrl });
      return;
    }
    if (!config.sovits.autostart) {
      // 由外部编排器（`npm run dev` 的 sovits 任务）负责启动。
      //
      // 这里不能「探不到就放弃」：两个任务由 concurrently 同时启动，
      // 而 Python 侧要 import torch 再加载模型，比 Node 慢几十秒。
      // 直接放弃会出现「界面已就绪，但本地功能一直显示不可用」的假故障。
      // 所以改成在这里等它就绪 —— 等到了就接管为「已接入外部服务」。
      const ready = await this.waitUntilReady(config.sovits.readyTimeoutMs);
      if (ready) {
        logger.info('已接入外部启动的 GPT-SoVITS 服务', { baseUrl: config.sovits.baseUrl });
      } else {
        this.lastError = `未检测到 GPT-SoVITS 服务（${config.sovits.baseUrl}），且已关闭自动启动`;
      }
      return;
    }

    this.starting = this.spawnService().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async spawnService(): Promise<void> {
    const home = this.resolveHome();
    const python = this.resolvePython(home);
    const port = this.targetPort();

    if (!fs.existsSync(path.join(TRAINER_DIR, 'server.py'))) {
      this.lastError = `未找到 Python 服务入口：${path.join(TRAINER_DIR, 'server.py')}`;
      logger.warn(this.lastError);
      return;
    }

    const args = [
      'server.py',
      '--no-open',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
    ];
    if (home && config.sovits.home) {
      // 只在用户显式指定时传 --home；否则让 Python 侧自己做多候选搜索
      args.push('--home', config.sovits.home);
    }

    logger.info('正在启动 GPT-SoVITS 本地服务', {
      python,
      home: home ?? '(自动搜索)',
      port,
    });

    const child = spawn(python, args, {
      cwd: TRAINER_DIR,
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUNBUFFERED: '1',
        PORT: String(port),
      },
      windowsHide: true,
    });
    this.child = child;
    this.exitCode = null;

    // Python 侧的 stdout / stderr 全部收进环形缓冲：
    // 用户问「它为什么没起来」时，答案通常就在最后这几行里，
    // 而且这些行会在 503 响应里被带出来，所以一条都不能丢。
    //
    // 但**不再逐行转发到控制台**。Python 启动时会打印 30 行体检横幅，
    // uvicorn 又逐条打访问日志，逐行包成 JSON debug 日志后是 45+ 行，
    // 反而把「服务是否就绪」「有没有报错」这些真正要看的信息淹没了
    // —— 这是实测出来的：一次正常启动刷满两屏，没人会去读。
    //
    // 现在的策略：默认只透出像错误的行，完整输出交给 VERBOSE_LOG=true。
    const absorb = (data: Buffer) => {
      for (const line of splitLines(data.toString('utf-8'))) {
        ringPush(this.logs, line);
        if (config.verboseLog) {
          logger.debug(`[sovits] ${line}`);
        } else if (IMPORTANT_LINE.test(line)) {
          // 兜底：即使不开详细日志，明显的错误也要让它出现在控制台
          logger.warn(`[sovits] ${line}`);
        }
      }
    };
    child.stdout?.on('data', absorb);
    child.stderr?.on('data', absorb);
    child.on('error', (error: Error) => {
      this.lastError = `启动 Python 服务失败：${error.message}`;
      logger.error(this.lastError);
    });
    child.on('exit', (code: number | null) => {
      this.exitCode = code;
      this.reachable = false;
      this.child = null;
      if (code !== 0 && code !== null) {
        this.lastError = `Python 服务意外退出（退出码 ${code}），最后输出：${
          this.logs.slice(-3).join(' / ') || '(无)'
        }`;
        logger.error(this.lastError);
      }
    });

    const ready = await this.waitUntilReady(config.sovits.readyTimeoutMs);
    if (!ready) {
      this.lastError =
        this.lastError ??
        `等待 GPT-SoVITS 服务就绪超时（${Math.round(config.sovits.readyTimeoutMs / 1000)}s）`;
      logger.warn(this.lastError, { logs: this.logs.slice(-5) });
      return;
    }
    // 就绪叙事统一由 announceReady() 负责（见 index.ts），这里不再单独打一行，
    // 否则「已复用外部实例」和「新拉起」两条路径的消息会重复且不一致。
  }

  /**
   * 打印一条**浓缩摘要**，替代原先被逐行转发的 30 行体检报告。
   *
   * 使用者在启动阶段真正需要知道的只有四件事：哪个版本、跑在什么设备上、
   * 音色库有几条、有没有阻断项。其余细节交给 `npm run sovits:check` 和
   * `GET /health` —— 按需查看，而不是每次启动都糊一脸。
   */
  announceReady(): void {
    const status = this.status();
    if (!status.reachable) {
      logger.warn('GPT-SoVITS 本地服务未就绪，相关功能暂不可用', {
        baseUrl: status.baseUrl,
        reason: status.lastError,
      });
      return;
    }

    const health = this.health;
    const version =
      health?.pipeline?.version ?? health?.installation?.version_hint ?? '未知版本';
    const device = compactDevice(health?.runtime?.device_label);
    const voiceCount = health?.voices?.total ?? 0;

    logger.info(`GPT-SoVITS 本地服务已就绪 · ${version} · ${device} · 音色 ${voiceCount} 条`, {
      baseUrl: status.baseUrl,
      home: status.home,
      managed: status.managed,
    });

    if (health?.blockers?.length) {
      logger.warn('本地模型服务存在阻断项，推理或训练可能不可用', { blockers: health.blockers });
    }
    if (voiceCount === 0) {
      // 这是新手最容易卡住的一步：GPT-SoVITS 没有内置音色，必须自己导入参考音频
      logger.info('音色库为空：请到「音色库」导入一段 3~10 秒的单人干净音频，再开始合成');
    }
  }

  private async waitUntilReady(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    // 首次冷启动要 import torch，约 10~20 秒；模型预加载在服务内部异步进行
    while (Date.now() < deadline) {
      if (this.child === null && this.exitCode !== null) return false;
      if (await this.probe(2_000)) return true;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    return false;
  }

  /** 只关闭由本进程拉起的服务；外部实例不动。 */
  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child || child.pid === undefined) return;
    logger.info('正在关闭 GPT-SoVITS 本地服务', { pid: child.pid });
    killTree(child.pid);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  // ------------------------------------------------------------------
  // 观测
  // ------------------------------------------------------------------

  status(): SovitsStatus {
    const home = this.resolveHome();
    return {
      baseUrl: config.sovits.baseUrl,
      reachable: this.reachable,
      managed: this.child !== null,
      installed: home !== null,
      pid: this.child?.pid ?? null,
      starting: this.starting !== null,
      lastError: this.lastError,
      lastCheckAt: this.lastCheckAt,
      home,
      python: this.python,
      exitCode: this.exitCode,
    };
  }

  recentLogs(limit = 40): string[] {
    return this.logs.slice(-limit);
  }

  get installed(): boolean {
    return this.resolveHome() !== null;
  }
}

/** 结束进程树。Windows 上 `child.kill()` 常常杀不掉 Python 拉起的子进程。 */
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
    process.kill(pid, 'SIGTERM');
  } catch {
    // 进程可能已经退出
  }
}

export const sovitsSupervisor = new SovitsSupervisor();
export { PROJECT_ROOT, TRAINER_DIR };

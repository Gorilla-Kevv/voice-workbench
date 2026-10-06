import { config } from '../config/index.js';
import { logger } from '../lib/logger.js';

/**
 * 资源仲裁：同一时刻只让**一个模型**留在本系统里，其余全部卸载并归还显存。
 *
 * ============================================================
 * 作用域的硬边界（这是本文件存在的第一前提）
 * ============================================================
 * 本系统 = 本项目自己拉起的三个 Python 服务：
 *   - GPT-SoVITS 本地服务（`config.sovits.baseUrl`，默认 127.0.0.1:9881）
 *   - 网易模块服务（`config.netease.baseUrl`，默认 127.0.0.1:9882）
 *   - IndexTTS 服务（`config.indextts.baseUrl`，默认 127.0.0.1:9883）
 * 仲裁器**只向这几个地址发请求**，而且发之前会校验目标是回环地址（见 `assertOwnService`）。
 * 它不扫描进程、不 taskkill 任何 PID、不认识也不触碰电脑上其它任何程序 ——
 * 浏览器、安卓模拟器、游戏占的显存一概不管（那部分由界面提示用户自己处理）。
 *
 * ============================================================
 * 为什么需要它
 * ============================================================
 * 两个服务各自都有「引擎互斥」（trainer 的 EngineRegistry、netease 的 engine_lock），
 * 但**跨进程看不见对方**：网易 TTS 常驻 4.9 GB 时，GPT-SoVITS 那边照样认为显存够用，
 * 结果就是两套模型互相挤，任务跑到一半 OOM，或者慢到 RTF 4.88。
 * 网关是唯一同时知道两边的地方，所以仲裁放在这里。
 */

/** 本系统内的引擎标识 → 它属于哪个服务 */
export type FocusEngine = 'netease-tts' | 'netease-asr' | 'indextts-tts' | 'sovits' | 'training' | 'rvc' | 'svc' | 'uvr5' | 'asr';

type ServiceName = 'sovits' | 'netease' | 'indextts';

const ALL_SERVICES: ServiceName[] = ['sovits', 'netease', 'indextts'];

/** 每个服务的「卸载自己全部模型」入口（POST），按优先级排列 */
const RELEASE_ENDPOINTS: Record<ServiceName, string[]> = {
  // 引擎注册表的 unload_all：把 SoVITS / RVC / SVC / ASR 等常驻模型全卸掉
  sovits: ['/v1/engines/unload', '/v1/pipeline/unload'],
  netease: ['/v1/confucius/unload', '/v1/r2t2/unload'],
  indextts: ['/v1/unload'],
};

function serviceOf(engine: FocusEngine): ServiceName {
  if (engine === 'netease-tts' || engine === 'netease-asr') return 'netease';
  if (engine === 'indextts-tts') return 'indextts';
  return 'sovits';
}

function baseUrlOf(service: ServiceName): string {
  if (service === 'netease') return config.netease.baseUrl;
  if (service === 'indextts') return config.indextts.baseUrl;
  return config.sovits.baseUrl;
}

/**
 * 作用域校验：只允许**回环地址**上的自有服务。
 *
 * 这不是防御性编程的花架子 —— 用户明确要求「绝不触及本系统之外的进程」。
 * 若有人把 `SOVITS_URL` 配成了局域网里另一台机器，仲裁器会在启动阶段就拒绝，
 * 而不是去卸载一台陌生机器上的模型。
 */
function assertOwnService(service: ServiceName): string {
  const base = baseUrlOf(service);
  let host = '';
  try {
    host = new URL(base).hostname;
  } catch {
    throw new Error(`服务地址不合法：${base}`);
  }
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
  if (!loopback) {
    throw new Error(
      `拒绝仲裁：${service} 服务地址 ${base} 不是本机回环地址。资源仲裁只作用于本项目自己拉起的服务。`,
    );
  }
  return base;
}

export interface FocusReport {
  engine: FocusEngine;
  service: ServiceName;
  /** 实际被卸载的服务（另一端） */
  released: string[];
  /** 卸载失败的项及原因（不抛出，交给调用方决定） */
  failed: { target: string; reason: string }[];
  /** 服务端是否可达 */
  targetReachable: boolean;
}

async function callRelease(base: string, path: string, timeoutMs = 30_000): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    // 404 = 该服务没这个端点（例如 netease 没开 ASR），不算失败
    if (!response.ok && response.status !== 404) {
      const text = (await response.text()).slice(0, 200);
      throw new Error(`HTTP ${response.status} ${text}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/** 卸载某个自有服务上的全部模型 */
async function releaseService(service: ServiceName): Promise<{ released: string[]; failed: FocusReport['failed'] }> {
  const base = assertOwnService(service);
  const released: string[] = [];
  const failed: FocusReport['failed'] = [];

  for (const path of RELEASE_ENDPOINTS[service]) {
    try {
      await callRelease(base, path);
      released.push(`${service}${path}`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // 服务没起 / 连不上：不算错误，只是「本来就没占着」
      if (/fetch failed|ECONNREFUSED|abort/i.test(reason)) {
        logger.debug('仲裁：服务未运行，无需卸载', { service, path });
        continue;
      }
      logger.warn('仲裁：卸载失败', { service, path, reason });
      failed.push({ target: `${service}${path}`, reason });
    }
  }
  return { released, failed };
}

interface FocusHold {
  engine: FocusEngine;
  service: ServiceName;
  /** 持有到什么时候（毫秒时间戳） */
  until: number;
  timer: NodeJS.Timeout | null;
}

const HEARTBEAT_MS = 15_000;

class ResourceArbiter {
  private hold: FocusHold | null = null;

  /**
   * 把资源集中给某个引擎：卸载**另一端**服务上的全部模型，
   * 并在持有期内周期性复检（防止对面又被别的请求拉起来）。
   */
  async focus(engine: FocusEngine, holdSeconds = 600): Promise<FocusReport> {
    const service = serviceOf(engine);
    const others = ALL_SERVICES.filter((s) => s !== service);

    const released: string[] = [];
    const failed: FocusReport['failed'] = [];
    for (const other of others) {
      const result = await releaseService(other);
      released.push(...result.released);
      failed.push(...result.failed);
    }

    // 目标服务内部也要排他：网易的 TTS / ASR 二选一（它的 engine_lock 在 acquire 时也会做，
    // 这里提前做一次，好让「另一端」彻底空出来）
    if (service === 'netease') {
      const inner = engine === 'netease-tts' ? '/v1/r2t2/unload' : '/v1/confucius/unload';
      try {
        await callRelease(assertOwnService('netease'), inner);
        released.push(`netease${inner}`);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (!/fetch failed|ECONNREFUSED|abort/i.test(reason)) {
          failed.push({ target: `netease${inner}`, reason });
        }
      }
    }

    const targetReachable = await this.ping(assertOwnService(service));

    this.arm(engine, service, holdSeconds);

    logger.info('资源仲裁：已把资源集中给单一模型', {
      engine,
      service,
      released,
      holdSeconds,
    });

    return { engine, service, released, failed, targetReachable };
  }

  /** 全停：所有自有服务的模型都卸掉（不留任何常驻） */
  async releaseAll(): Promise<FocusReport> {
    this.disarm();
    const released: string[] = [];
    const failed: FocusReport['failed'] = [];
    for (const service of ALL_SERVICES) {
      const result = await releaseService(service);
      released.push(...result.released);
      failed.push(...result.failed);
    }
    logger.info('资源仲裁：已释放本系统内全部常驻模型', { released });
    return { engine: 'sovits', service: 'sovits', released, failed, targetReachable: false };
  }

  status(): { engine: FocusEngine | null; service: ServiceName | null; remainSec: number } {
    if (!this.hold) return { engine: null, service: null, remainSec: 0 };
    return {
      engine: this.hold.engine,
      service: this.hold.service,
      remainSec: Math.max(0, Math.round((this.hold.until - Date.now()) / 1000)),
    };
  }

  // ------------------------------------------------------------------ 内部

  private arm(engine: FocusEngine, service: ServiceName, holdSeconds: number): void {
    this.disarm();
    if (holdSeconds <= 0) return;
    const until = Date.now() + holdSeconds * 1000;
    // 心跳：持有期内反复确认另一端没被重新拉起来。
    // 只调自有服务的卸载接口，不做任何进程级操作。
    const timer = setInterval(() => {
      if (Date.now() > until) {
        this.disarm();
        return;
      }
      const others = ALL_SERVICES.filter((s) => s !== service);
      void Promise.all(others.map((other) => releaseService(other))).catch(() => undefined);
    }, HEARTBEAT_MS);
    timer.unref?.();
    this.hold = { engine, service, until, timer };
  }

  private disarm(): void {
    if (!this.hold) return;
    if (this.hold.timer) clearInterval(this.hold.timer);
    this.hold = null;
  }

  private async ping(base: string): Promise<boolean> {
    try {
      const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3_000) });
      return response.ok;
    } catch {
      return false;
    }
  }
}

export const resourceArbiter = new ResourceArbiter();

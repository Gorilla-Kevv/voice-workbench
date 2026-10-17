import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from '../config/index.js';
import { logger } from '../lib/logger.js';
import { vramMb } from '../lib/vram.js';
import { resourceArbiter } from './arbiter.js';
import { sovitsSupervisor } from './sovits.js';

/**
 * 启动预加载：开网页时先把**一个**模型装进显存。
 *
 * 背景（用户 2026-10 的裁决）：IndexTTS 与网易谁当主力**由使用测试决定**，不做预设；
 * 因此先走「双轨 + 启动时选一个预加载」。磁盘不是瓶颈，**显存才是** ——
 * 8 GB 卡装不下两套常驻模型，所以预加载的第一件事是**把另一套让出去**。
 */

export type PreloadModel = 'netease-tts' | 'indextts-tts' | 'irodori-tts' | 'sovits' | 'none';

/**
 * 每个模型的显存账本。
 *
 * `vram_mb` 的来源写清楚，方便实测后校准，不要凭感觉填：
 * - netease-tts 6144 ← `netease/app/tts_engine.py::REQUIRED_VRAM_MB`（fp16 实测常驻 + 峰值 4.9 GB）
 * - sovits 3072 ← trainer 引擎注册表里 `sovits` 的 required_mb
 * - indextts-tts 3072 ← `indextts/app/indextts_engine.py::REQUIRED_VRAM_MB`
 *   （阶段 26 实测：加载后 nvidia-smi 空闲从 5548 → 281 MB，**实际常驻约 5.3 GB**，
 *   3072 是加载前的准入口径，偏低 —— 与 netease 不同它没有更大的门槛值可引，
 *   门槛本身待用户在合成实测中确认是否要上调）
 * - irodori-tts 4700 ← `irodori/app/config.py::REQUIRED_VRAM_MB['int4']`
 *   （阶段 28 实测净占 ~4.6 GB；`/health` 的 `required_vram_mb` 是唯一真源，
 *   这里只是预加载账本的**副本**，改门槛两处都要动）
 */
const MODELS: Record<Exclude<PreloadModel, 'none'>, {
  label: string;
  vram_mb: number;
  /** 预热动作：真正把模型装进显存 */
  warmup: () => Promise<void>;
  /** 让位动作：把它的常驻模型卸掉 */
  release: () => Promise<void>;
}> = {
  'netease-tts': {
    label: '网易 Confucius4-TTS',
    vram_mb: 6144,
    warmup: async () => {
      // 不传 signal = 真正的「不设超时」。别写 AbortSignal.timeout(0)：
      // 那是「0ms 后中止」，实测首装请求 99ms 就被打断（TimeoutError），预加载必失败。
      await fetch(`${config.netease.baseUrl}/v1/confucius/warmup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
    },
    release: async () => {
      await fetch(`${config.netease.baseUrl}/v1/confucius/unload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(30_000),
      }).catch(() => undefined);
    },
  },
  'indextts-tts': {
    label: 'IndexTTS-2.5',
    vram_mb: 3072,
    warmup: async () => {
      // 同上：不传 signal（首次装要跑辅助模型网络探测，实测约 4 分钟）
      await fetch(`${config.indextts.baseUrl}/v1/warmup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
    },
    release: async () => {
      await fetch(`${config.indextts.baseUrl}/v1/unload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(30_000),
      }).catch(() => undefined);
    },
  },
  'irodori-tts': {
    label: 'Irodori-TTS（日语）',
    vram_mb: 4700,
    warmup: async () => {
      // 同上：不传 signal（实测加载 ~20s）
      await fetch(`${config.irodori.baseUrl}/v1/warmup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
    },
    release: async () => {
      await fetch(`${config.irodori.baseUrl}/v1/unload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(30_000),
      }).catch(() => undefined);
    },
  },
  sovits: {
    label: 'GPT-SoVITS',
    vram_mb: 3072,
    // GPT-SoVITS 的权重是**推理时按需加载**的，预热能做的是把服务拉起来（import torch 那一段）
    warmup: async () => {
      if (!sovitsSupervisor.isEnabled()) {
        await sovitsSupervisor.setEnabled(true);
        return;
      }
      await sovitsSupervisor.ensureStarted();
    },
    release: async () => {
      await fetch(`${config.sovits.baseUrl}/v1/engines/unload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(30_000),
      }).catch(() => undefined);
    },
  },
};

// 注意：cwd 是 `server/` 目录（dev 与 dist 两种启动方式都是），
// 不能写成 path.join(process.cwd(), 'server', '.data') —— 那会落到 server/server/.data。
const HERE = path.dirname(fileURLToPath(import.meta.url));
/** server/src/services → 项目根目录 */
const PROJECT_ROOT = path.resolve(HERE, '..', '..', '..');
const FLAG_FILE = path.join(PROJECT_ROOT, 'server', '.data', 'preload.json');

interface Preference {
  /** 启动时要预加载的模型；'ask' = 每次启动问用户 */
  model: PreloadModel | 'ask';
  updatedAt: number;
}

function readPreference(): Preference {
  try {
    const parsed = JSON.parse(fs.readFileSync(FLAG_FILE, 'utf8')) as Partial<Preference>;
    if (parsed.model && ['netease-tts', 'indextts-tts', 'irodori-tts', 'sovits', 'none', 'ask'].includes(parsed.model)) {
      return { model: parsed.model as Preference['model'], updatedAt: parsed.updatedAt ?? 0 };
    }
  } catch {
    // 没存过 = 每次都问
  }
  return { model: 'ask', updatedAt: 0 };
}

function writePreference(preference: Preference): void {
  try {
    fs.mkdirSync(path.dirname(FLAG_FILE), { recursive: true });
    fs.writeFileSync(FLAG_FILE, JSON.stringify(preference, null, 2));
  } catch {
    // 写不进去就只在本次进程内生效
  }
}

class PreloadService {
  /** 当前预加载任务（同时只跑一个，重复调用返回同一个 promise） */
  private running: Promise<PreloadReport> | null = null;
  private last: PreloadReport | null = null;

  preference(): Preference {
    return readPreference();
  }

  setPreference(model: PreloadModel | 'ask'): Preference {
    const next = { model, updatedAt: Date.now() };
    writePreference(next);
    return next;
  }

  /** 给界面看的账本：每个模型要多少显存，现在有多少 */
  async catalog() {
    const vram = await vramMb();
    return {
      vram,
      models: Object.entries(MODELS).map(([id, meta]) => ({
        id,
        label: meta.label,
        vram_mb: meta.vram_mb,
        /** 当前显存够不够装它 */
        fits: vram.free_mb == null ? null : vram.free_mb >= meta.vram_mb,
      })),
    };
  }

  status(): PreloadReport | null {
    return this.last;
  }

  /**
   * 预加载一个模型。
   *
   * 顺序很讲究：**先让位，再检查，最后加载** ——
   * 反过来的话，另一套模型还占着显存，检查必然失败，而失败原因会误导用户（以为卡太小）。
   */
  async preload(model: PreloadModel): Promise<PreloadReport> {
    if (this.running) return this.running;
    this.running = this.doPreload(model).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async doPreload(model: PreloadModel): Promise<PreloadReport> {
    if (model === 'none') {
      this.last = { model, ok: true, released: [], vram_free_mb: null, message: '本次不预加载，用时再手动开启' };
      return this.last;
    }

    const meta = MODELS[model];
    // 1) 让位：把另一套的常驻模型卸掉
    const released: string[] = [];
    for (const [id, other] of Object.entries(MODELS)) {
      if (id === model) continue;
      try {
        await other.release();
        released.push(id);
      } catch {
        // 服务没起：本来就没占着
      }
    }

    // 2) 检查：现在够不够
    const vram = await vramMb();
    if (vram.free_mb != null && vram.free_mb < meta.vram_mb) {
      this.last = {
        model,
        ok: false,
        released,
        vram_free_mb: vram.free_mb,
        message: `显存不足：${meta.label} 需要约 ${meta.vram_mb} MB，当前仅 ${vram.free_mb} MB`,
      };
      logger.warn('预加载失败：显存不足', { ...this.last });
      return this.last;
    }

    // 3) 加载
    try {
      await meta.warmup();
      // 顺带把仲裁焦点给它，避免之后被别的请求拉起另一套
      await resourceArbiter.focus(model, 3600);
      this.last = {
        model,
        ok: true,
        released,
        vram_free_mb: (await vramMb()).free_mb,
        message: `${meta.label} 已预加载`,
      };
      logger.info('启动预加载完成', { ...this.last });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.last = { model, ok: false, released, vram_free_mb: vram.free_mb, message: `预加载失败：${message}` };
      logger.error('启动预加载失败', { ...this.last });
    }
    return this.last as PreloadReport;
  }
}

export interface PreloadReport {
  model: PreloadModel;
  ok: boolean;
  released: string[];
  vram_free_mb: number | null;
  message: string;
}

export const preloadService = new PreloadService();

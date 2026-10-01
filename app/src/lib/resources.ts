/**
 * 资源预估：跑之前先算清楚「这一发要吃掉多少显存/内存，现在还剩多少」。
 *
 * 为什么要有这一层：本机的模型都是**重量级**的 —— 网易 TTS 常驻就 4.9 GB 显存，
 * 训练要 6 GB，而显卡只有 8 GB，还得分给浏览器 / 模拟器 / GPT-SoVITS。
 * 让用户点下去之前就知道代价，比跑一半弹 OOM 友好得多。
 *
 * 数据来源（两条，各自权威）：
 * - **显存门槛**：优先取服务端认定值（trainer `/v1/engines` 的 `required_mb`、
 *   netease `/health` 的 `tts_required_vram_mb`），拿不到才退回下面的常量；
 * - **当前余量**：netease 的 nvidia-smi 口径（跨进程真实值，见 HANDOFF 坑 17）
 *   > trainer 的 `free_vram_mb` > 未知。
 * - **内存**：网关 `/api/health` 的 `host`（Node 的 os.freemem）。
 */

import { neteaseApi } from '@/lib/netease';
import { sovitsApi } from '@/lib/sovits';
import { api } from '@/lib/api';
import type { HealthInfo } from '@/types';

/** 资源型任务标识 */
export type ResourceTask = 'netease-tts' | 'netease-asr' | 'sovits' | 'batch' | 'training' | 'rvc' | 'svc' | 'uvr5' | 'asr';

/** 前端兜底常量：服务端没给数时用（单位 MB，标注来源，别凭感觉改） */
const FALLBACK_VRAM_MB: Record<ResourceTask, number> = {
  // 实测：fp16 常驻 + 推理峰值约 4.9 GB（RTX 4060 Laptop 8 GB）
  'netease-tts': 4915,
  // vLLM gpu_memory_utilization 默认 0.35 × 8 GB
  'netease-asr': 2865,
  // 与 trainer ENGINES 表一致
  sovits: 3072,
  batch: 3072,
  training: 6144,
  rvc: 2560,
  svc: 3072,
  uvr5: 4096,
  asr: 2048,
};

/** 内存粗估（MB）：加载权重与特征时的 RSS 量级，不是精确值 */
const FALLBACK_RAM_MB: Record<ResourceTask, number> = {
  'netease-tts': 3072,
  'netease-asr': 4096,
  sovits: 2048,
  batch: 3072,
  training: 6144,
  rvc: 2048,
  svc: 2048,
  uvr5: 3072,
  asr: 1536,
};

/** 引擎名 → 任务标识（trainer 注册表用的是引擎名） */
const ENGINE_TO_TASK: Record<string, ResourceTask> = {
  sovits: 'sovits',
  rvc: 'rvc',
  svc: 'svc',
  uvr5: 'uvr5',
  asr: 'asr',
  train: 'training',
};

export interface ResourceSnapshot {
  /** 显存总量（MB），未知为 null */
  vram_total_mb: number | null;
  /** 当前空闲显存（MB），未知为 null */
  vram_free_mb: number | null;
  /** 显存读数的来源，用于在 UI 里说明可信度 */
  vram_source: 'nvidia-smi' | 'torch' | 'unknown';
  ram_total_mb: number | null;
  ram_free_mb: number | null;
  /** 各引擎的服务端认定门槛（MB） */
  engine_required_mb: Record<string, number>;
  /** 网易 TTS 的门槛（服务端给的 REQUIRED_VRAM_MB） */
  netease_tts_required_mb: number | null;
  /** 当前谁在占着本地引擎（null = 空闲） */
  active_engine: string | null;
  fetched_at: number;
}

export interface ResourceEstimate {
  task: ResourceTask;
  vram_need_mb: number;
  ram_need_mb: number;
  vram_free_mb: number | null;
  ram_free_mb: number | null;
  /** ok = 够；tight = 够但没余量（≤1 GB）；insufficient = 不够；unknown = 拿不到数据 */
  verdict: 'ok' | 'tight' | 'insufficient' | 'unknown';
  /** 不够时差多少（MB） */
  gap_mb: number;
  /** 建议：降配置 / 释放资源 / 升硬件，按可执行程度排序 */
  suggestions: Suggestion[];
}

export interface Suggestion {
  kind: 'free' | 'lower' | 'upgrade';
  label: string;
  detail: string;
  /** 可一键执行的动作（kind === 'free' 时有） */
  action?: () => Promise<void>;
}

/** 各任务的「降配置」建议文案 */
const LOWER_TIPS: Record<ResourceTask, string> = {
  'netease-tts': '把长文本拆成多段分批合成，别一次塞整篇；fp16 已是低配，想更省只能换更小模型。',
  'netease-asr': '调低 R2T2 的 gpu_memory_utilization（默认 0.35），或改走 FunASR 轻量通道。',
  sovits: '切到更小的底模版本，或缩短单次合成文本（长文本会显著抬高显存峰值）。',
  batch: '减小并发条数 / 分段长度；批量任务逐条排队跑比一次铺开省显存。',
  training: '降 batch size、缩短单段音频上限（>15 秒的先切分），或改用更小的底模。',
  rvc: '把检索特征索引关掉（index_rate 设 0），能省掉索引常驻那部分显存。',
  svc: '分离预设选「快速 · HP2」而不是 HP5 / RoFormer；不勾选二次分离。',
  uvr5: '换轻量分离模型（HP2，约 1/3 显存），或先切短音频再分离。',
  asr: '用 faster-whisper 的 small/base 模型，别上 large。',
};

const UPGRADE_TIP =
  '8 GB 显存跑 1.3B 级模型本来就压线；要长期流畅，建议 ≥12 GB 显存 + 32 GB 内存（或换更大显存的卡 / 用云端方案）。';

/** 采一次资源快照：三个来源并发，任一失败都降级而不是整体失败 */
export async function fetchResourceSnapshot(): Promise<ResourceSnapshot> {
  const [health, engines, netease] = await Promise.all([
    api.health().catch(() => null),
    sovitsApi.engines().catch(() => null),
    neteaseApi.health().catch(() => null),
  ]);

  const engineRequired: Record<string, number> = {};
  for (const engine of engines?.engines ?? []) {
    engineRequired[engine.name] = engine.required_mb;
  }

  // 显存余量：netease 是 nvidia-smi 口径（跨进程真实值），优先；否则退回 trainer 的 torch 口径
  const neteaseVram = netease?.vram ?? null;
  const vram_free = neteaseVram?.free_mb ?? engines?.free_vram_mb ?? null;
  const vram_total = neteaseVram?.total_mb ?? null;
  const source: ResourceSnapshot['vram_source'] = neteaseVram
    ? neteaseVram.source === 'nvidia-smi'
      ? 'nvidia-smi'
      : 'torch'
    : engines?.free_vram_mb != null
      ? 'torch'
      : 'unknown';

  return {
    vram_total_mb: vram_total,
    vram_free_mb: vram_free,
    vram_source: source,
    ram_total_mb: (health as HealthInfo | null)?.host?.ram_total_mb ?? null,
    ram_free_mb: (health as HealthInfo | null)?.host?.ram_free_mb ?? null,
    engine_required_mb: engineRequired,
    netease_tts_required_mb: netease?.configuration?.tts_required_vram_mb ?? null,
    active_engine: engines?.active ?? null,
    fetched_at: Date.now(),
  };
}

/** 某个任务需要多少显存（服务端优先） */
function vramNeed(task: ResourceTask, snapshot: ResourceSnapshot): number {
  if (task === 'netease-tts') return snapshot.netease_tts_required_mb ?? FALLBACK_VRAM_MB[task];
  const engineName = task === 'training' ? 'train' : task;
  return snapshot.engine_required_mb[engineName] ?? FALLBACK_VRAM_MB[task];
}

/** 按当前快照估一次 */
export function estimateTask(task: ResourceTask, snapshot: ResourceSnapshot): ResourceEstimate {
  const vram_need_mb = vramNeed(task, snapshot);
  const ram_need_mb = FALLBACK_RAM_MB[task];
  const vram_free = snapshot.vram_free_mb;
  const ram_free = snapshot.ram_free_mb;

  let verdict: ResourceEstimate['verdict'] = 'ok';
  let gap_mb = 0;
  if (vram_free == null) {
    verdict = 'unknown';
  } else {
    const margin = vram_free - vram_need_mb;
    if (margin < 0) {
      verdict = 'insufficient';
      gap_mb = -margin;
    } else if (margin < 1024) {
      verdict = 'tight';
    }
  }
  // 内存不够也是不够（差得多时才提示，避免 8 GB 差值吓人）
  if (verdict === 'ok' && ram_free != null && ram_free < ram_need_mb * 0.5) {
    verdict = 'tight';
  }

  const suggestions: Suggestion[] = [];
  if (verdict !== 'ok') {
    suggestions.push({ kind: 'lower', label: '降低配置', detail: LOWER_TIPS[task] });
    suggestions.push({ kind: 'upgrade', label: '升级硬件', detail: UPGRADE_TIP });
  }

  return {
    task,
    vram_need_mb,
    ram_need_mb,
    vram_free_mb: vram_free,
    ram_free_mb: ram_free,
    verdict,
    gap_mb,
    suggestions,
  };
}

/** 释放常驻显存：网易引擎 + 本地引擎注册表，两个都试，失败不影响另一个 */
export async function releaseVram(handlers: {
  neteaseTtsLoaded: boolean;
  neteaseAsrLoaded: boolean;
}): Promise<string[]> {
  const done: string[] = [];
  if (handlers.neteaseTtsLoaded) {
    try {
      await neteaseApi.ttsUnload();
      done.push('网易 TTS 引擎已卸载');
    } catch {
      // 卸载失败不该挡住另一路
    }
  }
  if (handlers.neteaseAsrLoaded) {
    try {
      await neteaseApi.asrUnload();
      done.push('网易转写引擎已卸载');
    } catch {
      // 同上
    }
  }
  try {
    await sovitsApi.unloadEngines();
    done.push('本地引擎显存已释放');
  } catch {
    // 服务没起时必然失败，忽略
  }
  return done;
}

export const RESOURCE_TASK_LABEL: Record<ResourceTask, string> = {
  'netease-tts': '网易零样本合成',
  'netease-asr': '网易流式转写',
  sovits: 'GPT-SoVITS 推理',
  batch: '批量合成',
  training: '模型训练',
  rvc: '语音变声',
  svc: '歌声转换',
  uvr5: '音源分离',
  asr: '语音转文本',
};

export { ENGINE_TO_TASK };

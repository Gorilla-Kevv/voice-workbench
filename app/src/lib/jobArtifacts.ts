import { resolveAudioUrl } from '@/lib/sovits';
import type { SovitsJob } from '@/types';

/**
 * 任务产物解析（**公用**）。
 *
 * 为什么必须抽出来：8 种任务类型的 `artifacts` 形状并不统一 ——
 *   * `vc_infer`（变声）：路径在**顶层**（`output` + `urls.output`）；
 *   * `svc_infer`（翻唱）：路径嵌在 **`artifacts.artifacts`** 内层，而 `urls` 在外层。
 * 而且里面混着 `sample_rate` / `duration` / `stages` / `info` / `model`
 * 这类**会被误当成产物的元信息**。
 *
 * 这段解析最早只写在 `useVcRunHistory` 里（服务变声与翻唱两个板块），
 * 而产出记录页要覆盖**全部**任务类型 —— 必须共用同一份实现，
 * 否则同一个坑会以更大的面积再踩一次（方案 §8.2）。
 */

/** 产物逻辑名 → 中文标签。未列出的键直接原样显示 */
const TRACK_LABELS: Record<string, string> = {
  output: '转换结果',
  vocal: '新人声',
  instrumental: '伴奏',
  mix: '混音',
};

/** 单条产物：`url` 给播放器，`path` 给用户去资源管理器里定位 */
export interface JobTrack {
  key: string;
  label: string;
  url: string | null;
  path: string | null;
}

/** 盘符路径（`F:\...` / `C:/...`）在浏览器里必然取不到，不能当 URL 用 */
export function looksLikeDiskPath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value);
}

/** 单个产物在 job.artifacts 里可能是绝对值，也可能只写在 urls 里 */
interface ArtifactBag {
  output?: unknown;
  urls?: Record<string, unknown>;
  /**
   * 翻唱（`svc_infer`）的路径嵌在这一层。
   *
   * `cover.py::run_cover()` 返回 `{"artifacts": {vocal/instrumental/mix: 绝对路径}, ...}`，
   * `routers/svc.py` 的 runner 直接 `{"job_id": ..., **result, "urls": ...}` 抛给队列，
   * 于是落进 `job.artifacts` 的顶层就是这个嵌套形状 —— 路径在 `artifacts.artifacts` 里，
   * `urls` 却在外层。**只看顶层会拿到 url 却丢路径**，正是用户要的「也给出本地路径」。
   */
  artifacts?: Record<string, unknown>;
  [key: string]: unknown;
}

/** 逐个产物合成 { key, label, url, path } */
export function collectTracks(job: SovitsJob): JobTrack[] {
  const bag = (job.artifacts ?? {}) as ArtifactBag;
  const urls = (bag.urls ?? {}) as Record<string, unknown>;

  // 路径来源有两处：顶层（变声走这里）与内层 `artifacts`（翻唱走这里）。
  // 内层优先 —— 它才是「产物清单」，顶层同名键是元信息。
  const paths: Record<string, unknown> = { ...bag, ...((bag.artifacts ?? {}) as Record<string, unknown>) };
  delete (paths as Record<string, unknown>).urls;
  delete (paths as Record<string, unknown>).artifacts;

  const keys = new Set<string>(Object.keys(urls));
  for (const [key, value] of Object.entries(paths)) {
    // `artifacts` 本身、以及各种元信息（sample_rate / duration / info / stages / model …）
    // 都不该被当成产物：只接受「像路径或像 URL」的字符串值。
    if (key === 'job_id' || key === 'model') continue;
    if (typeof value === 'string' && (looksLikeDiskPath(value) || value.startsWith('/files/'))) keys.add(key);
  }

  const tracks: JobTrack[] = [];
  for (const key of keys) {
    const rawPath = paths[key];
    const rawUrl = urls[key];
    // `artifacts[key]` 只在是绝对路径时才当本机路径；Web 路径一律以 `urls` 为准
    const path = typeof rawPath === 'string' && looksLikeDiskPath(rawPath) ? rawPath : null;
    // `urls` 是**服务内相对路径**（`/files/...`），直接塞给播放器会 404 ——
    // 必须补上网关前缀（坑：变声页最早就是这么拿不到音频的）。
    const url = typeof rawUrl === 'string' && rawUrl ? resolveAudioUrl(rawUrl) : null;
    if (!path && !url) continue;
    tracks.push({
      key,
      label: TRACK_LABELS[key] ?? key,
      url,
      path,
    });
  }

  // `output` 排最前（用户最关心的总是最终成品）
  tracks.sort((a, b) => (a.key === 'output' ? -1 : b.key === 'output' ? 1 : a.key.localeCompare(b.key)));
  return tracks;
}

// --------------------------------------------------------------------------
// 任务类型 → 引擎 / 分组 / 状态（产出记录页的徽标与筛选都靠这三张表）
// --------------------------------------------------------------------------

/** 引擎 key → 中文名（模型类别与云端引擎共用同一套 key） */
export const ENGINE_LABELS: Record<string, string> = {
  rvc: 'RVC 变声',
  'ddsp-svc': 'DDSP-SVC',
  'gpt-sovits': 'GPT-SoVITS',
  netease: '网易',
  indextts: 'IndexTTS',
  uvr5: 'UVR5 分离',
  asr: 'ASR 转写',
  mimo: 'MiMo 云端',
};

/** 分组 key → 中文名 */
export const GROUP_LABELS: Record<string, string> = {
  infer: '生成结果',
  train: '训练产物',
  model: '模型文件',
  cloud: '云端合成',
};

/**
 * 任务类型 → 引擎。
 *
 * 注意 `asr_train` 名字里带 train，但它产出的是**训练数据集**而不是权重，
 * 服务端也把它归在推理池（`jobs.py::INFER_POOL`），所以这里归到 ASR 而不是训练。
 */
const KIND_ENGINES: Record<string, string> = {
  infer: 'gpt-sovits',
  train: 'gpt-sovits',
  separate: 'uvr5',
  vc_infer: 'rvc',
  vc_train: 'rvc',
  svc_infer: 'ddsp-svc',
  svc_train: 'ddsp-svc',
  asr_train: 'asr',
};

/** 训练池的任务类型（与服务端 `TRAIN_POOL` 对齐） */
const TRAIN_KINDS = new Set(['train', 'vc_train', 'svc_train']);

/** 任务类型 → 引擎 key；未知类型原样返回，界面显示原始 kind 好过显示空 */
export function jobEngineOf(kind: string): string {
  return KIND_ENGINES[kind] ?? kind;
}

/** 任务类型 → 分组（训练 vs 推理） */
export function jobGroupOf(kind: string): 'train' | 'infer' {
  return TRAIN_KINDS.has(kind) ? 'train' : 'infer';
}

/** 任务状态 → 中文 */
const STATE_LABELS: Record<string, string> = {
  succeeded: '成功',
  failed: '失败',
  cancelled: '已取消',
  running: '进行中',
  queued: '排队中',
};

export function jobStateLabel(state: string): string {
  return STATE_LABELS[state] ?? state;
}

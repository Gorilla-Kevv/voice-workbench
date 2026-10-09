import { useCallback, useEffect, useState } from 'react';
import { collectTracks } from '@/lib/jobArtifacts';
import { fetchJobs } from '@/lib/local';
import type { SovitsJob } from '@/types';
import type { VcRunRecord } from '@/types/vc';

/**
 * 运行记录：把服务端持久化的任务拉成「最近跑过的结果」列表。
 *
 * 与 `useVcTrainHistory` 同一个思路，也是同一个理由：结果如果只活在组件里，
 * 关页面/重启浏览器就「没了」（2026-10 用户反馈）。真相是产物一直在
 * `.data/outputs/<板块>/` 下、任务元信息也持久化在 `trainer/.data/jobs/`，
 * 缺的只是「读回来」这一步。
 *
 * 为什么不用页面里的 `useResultStack` 就够：那个栈用 sessionStorage，
 * **关掉浏览器标签就清空**，而且只记录本次会话点过的结果，
 * 看不到「上次打开时跑过什么」。
 *
 * ---
 *
 * 两个板块共用这个 hook：
 *   * 语音变声（`vc_infer`）—— 单产物，`output` 一条；
 *   * 歌声转换/翻唱（`svc_infer`）—— 多产物，`vocal`/`instrumental`/`mix` 若干条。
 *
 * 所以读取逻辑做成「**把 artifacts 里所有像路径的值都收进来**」，
 * 而不是写死 `output` 一个键 —— 后者在翻唱页只会显示 1/3 的结果。
 */

/**
 * 逐个产物合成 { label, url, path }。
 *
 * 实现放在 `@/lib/jobArtifacts` —— 产出记录页要覆盖全部任务类型，
 * 共用同一份解析才不会重踩「产物形状不一」的坑。
 */
function toRecord(job: SovitsJob): VcRunRecord {
  const bag = (job.artifacts ?? {}) as { model?: unknown; duration?: unknown; elapsed_s?: unknown };
  const tracks = collectTracks(job);
  return {
    jobId: job.id,
    name: job.name || job.id,
    // 后端的 model 是完整路径，这里只留文件名（显示用），路径另有各 track 的 path
    model: (typeof bag.model === 'string' ? bag.model : '').split(/[\\/]/).pop() || '',
    createdAt: job.created_at,
    finishedAt: job.finished_at,
    state: job.state,
    // 变声是 `duration`（音频时长），翻唱是 `elapsed_s`（跑批耗时）；都取秒
    duration:
      typeof bag.duration === 'number'
        ? bag.duration
        : typeof bag.elapsed_s === 'number'
          ? bag.elapsed_s
          : 0,
    tracks,
  };
}

export interface VcRunHistory {
  records: VcRunRecord[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * 一个极简的「有新的运行结果了」广播。
 *
 * 跑完一次就 `notifyVcRunChanged()`，结果面板订阅后刷新。
 * 为什么不把 `refresh` 当 prop 传下去：两者在页面里是**兄弟**关系，
 * 中间隔着页面组件，为一个刷新信号穿三层 props 不划算；
 * 而且将来若在别处也触发（例如批量），这个广播天然覆盖。
 */
/** 广播名。产出记录页也订阅它，所以导出为常量而不是散落的字符串 */
export const RUN_CHANGED = 'vc-run-changed';

export function notifyVcRunChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(RUN_CHANGED));
}

/** 任务种类：变声推理 / 歌声转换推理 */
export type VcRunKind = 'vc_infer' | 'svc_infer';

export function useVcRunHistory(kind: VcRunKind = 'vc_infer', limit = 30): VcRunHistory {
  const [records, setRecords] = useState<VcRunRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => {
    setLoading(true);
    setTick((n) => n + 1);
  }, []);

  // 别人跑完时自动刷新（不必让用户手点「刷新」）
  useEffect(() => {
    const handler = () => refresh();
    window.addEventListener(RUN_CHANGED, handler);
    return () => window.removeEventListener(RUN_CHANGED, handler);
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    // loading 的同步置位放在 refresh() 里，effect 体内只用异步任务收尾
    // （避免 react-hooks/set-state-in-effect 的级联渲染告警）。
    const load = async () => {
      try {
        const payload = await fetchJobs({ kind, limit });
        if (cancelled) return;
        setRecords((payload.jobs ?? []).map(toRecord));
        setError(null);
      } catch (cause) {
        if (!cancelled) setError((cause as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [kind, limit, tick]);

  return { records, loading, error, refresh };
}

import { useCallback, useEffect, useState } from 'react';
import { fetchJobs } from '@/lib/local';
import type { SovitsJob } from '@/types';
import type { VcTrainArtifact, VcTrainRecord } from '@/types/vc';

/**
 * 训练记录：把服务端持久化的训练任务拉成「最近训练结果」列表。
 *
 * 为什么不只靠组件 state：训练一次动辄几十分钟，用户会关页面、重启浏览器，
 * 甚至重启整个服务。结果如果只活在组件里，一刷新就「没了」。真相是**产物一直在
 * 磁盘上**，服务端也把任务元信息持久化到了 `trainer/.data/jobs/<id>.json`
 * —— 缺的只是「把它读回来」这一步。
 *
 * RVC（vc_train）与 DDSP-SVC（svc_train）共用这套读取逻辑，差异只在任务 kind、
 * 任务名前缀与 mode 的显示文案；面板由 `TrainResultCard` 统一渲染。
 */

export interface TrainHistoryOptions {
  kind: 'vc_train' | 'svc_train';
  /** 服务端任务名前缀，例如「变声训练：」 */
  namePrefix?: string;
  /** 产物里的 mode → 列表副标题 */
  modeLabels?: Record<string, string>;
  fallbackMode?: string;
}

export interface TrainHistory {
  records: VcTrainRecord[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

function readArtifacts(job: SovitsJob): VcTrainArtifact[] {
  const raw = (job.artifacts as { artifacts?: unknown } | null)?.artifacts;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const entry = item as Partial<VcTrainArtifact>;
    if (typeof entry.path !== 'string' || !entry.path) return [];
    return [
      {
        key: entry.key ?? 'artifact',
        label: entry.label ?? entry.path.split(/[\\/]/).pop() ?? entry.path,
        path: entry.path,
        size_mb: typeof entry.size_mb === 'number' ? entry.size_mb : 0,
        kind: entry.kind ?? 'artifact',
      },
    ];
  });
}

function readMode(job: SovitsJob, options: TrainHistoryOptions): string {
  const bag = job.artifacts as { mode?: string } | null;
  const mode = bag?.mode;
  if (mode && options.modeLabels?.[mode]) return options.modeLabels[mode];
  return mode || options.fallbackMode || '训练';
}

function readName(job: SovitsJob, options: TrainHistoryOptions): string {
  const prefix = options.namePrefix ?? '';
  return (prefix && job.name.startsWith(prefix) ? job.name.slice(prefix.length) : job.name) || job.id;
}

function toRecord(job: SovitsJob, options: TrainHistoryOptions): VcTrainRecord {
  return {
    jobId: job.id,
    name: readName(job, options),
    mode: readMode(job, options),
    createdAt: job.created_at,
    finishedAt: job.finished_at,
    state: job.state,
    error: job.error,
    artifacts: readArtifacts(job),
  };
}

export function useTrainHistory(options: TrainHistoryOptions, limit = 30): TrainHistory {
  const [records, setRecords] = useState<VcTrainRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => {
    setLoading(true);
    setTick((n) => n + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    // loading 不在 effect 体内同步置位（会触发级联渲染，且被 lint 拦）：
    // 放进异步任务里，首帧用「records 为空 + loading 初始 true」表达，效果一致。
    const load = async () => {
      try {
        const payload = await fetchJobs({ kind: options.kind, limit });
        if (cancelled) return;
        setRecords((payload.jobs ?? []).map((job) => toRecord(job, options)));
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
  }, [limit, options, tick]);

  return { records, loading, error, refresh };
}

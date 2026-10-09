import { useCallback, useEffect, useState } from 'react';
import { fetchJobs } from '@/lib/local';
import type { SovitsJob } from '@/types';
import type { VcTrainArtifact, VcTrainRecord } from '@/types/vc';

/**
 * 训练记录：把服务端持久化的 `vc_train` 任务拉成一份「最近训练结果」列表。
 *
 * 为什么不能只靠组件 state：训练一次动辄几十分钟，用户会关页面、重启浏览器，
 * 甚至重启整个服务。结果如果只活在组件里，一刷新就「没了」（2026-10 用户反馈）。
 * 真相是**产物一直在磁盘上**，服务端也把任务元信息持久化到了
 * `trainer/.data/jobs/<id>.json` —— 缺的只是「把它读回来」这一步。
 *
 * 所以这里不再另存一份到 localStorage（那是重复真相），而是**以服务端为准**：
 * 每次挂载都去 `/v1/jobs?kind=vc_train` 拉一遍。这样即使换台机器打开，
 * 只要连的是同一个服务，记录就还在。
 */

/** 服务端 artifacts 里的训练产物清单（`training.run()` 的返回） */
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

/** 从任务里读出训练模式（full / lora），用于列表副标题 */
function readMode(job: SovitsJob): string {
  const bag = job.artifacts as { mode?: string } | null;
  const mode = bag?.mode;
  if (mode === 'full') return '全量微调';
  if (mode === 'lora') return 'LoRA 微调';
  return mode || '训练';
}

function toRecord(job: SovitsJob): VcTrainRecord {
  return {
    jobId: job.id,
    name: job.name.replace(/^变声训练：/, '') || job.id,
    mode: readMode(job),
    createdAt: job.created_at,
    finishedAt: job.finished_at,
    state: job.state,
    artifacts: readArtifacts(job),
  };
}

export interface VcTrainHistory {
  records: VcTrainRecord[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useVcTrainHistory(limit = 30): VcTrainHistory {
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
        const payload = await fetchJobs({ kind: 'vc_train', limit });
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
  }, [limit, tick]);

  return { records, loading, error, refresh };
}

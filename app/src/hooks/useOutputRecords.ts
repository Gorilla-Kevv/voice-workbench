import { useCallback, useEffect, useMemo, useState } from 'react';
import { RUN_CHANGED } from '@/hooks/useVcRunHistory';
import { collectTracks, jobEngineOf, jobGroupOf } from '@/lib/jobArtifacts';
import { fetchJobs } from '@/lib/local';
import { modelsApi, type ModelEntry } from '@/lib/models';
import type { HistoryRecord, OutputRecord, SovitsJob } from '@/types';

/**
 * 产出记录：把**三个来源**合并成一份按时间倒序的列表。
 *
 * | 来源 | 端点 | 覆盖 |
 * | --- | --- | --- |
 * | 服务端任务 | `GET /v1/jobs`（不带 kind，limit=200） | 所有本地引擎的推理与训练 |
 * | 本地模型 | `GET /api/models/catalog` + `/api/models` | 训练产物与用户导入的权重 |
 * | 云端合成 | 浏览器 IndexedDB（`useHistory`） | MiMo（服务端没有） |
 *
 * 三源**各自独立取数、各自独立报错**：本地服务停着时只丢第一源，
 * 另外两源照常显示（模型由网关提供、云端记录在浏览器里）。
 */

/** 服务端上限（`trainer/app/api.py` 里 `min(limit, 200)`），界面要如实提示 */
export const OUTPUT_JOB_LIMIT = 200;

/** 配套文件角色 → 中文（模型产物没有 url，只有本机路径） */
const ROLE_LABELS: Record<string, string> = {
  primary: '主权重',
  companion: '配套',
  required: '必需',
};

function jobToRecord(job: SovitsJob): OutputRecord {
  return {
    id: job.id,
    source: 'job',
    group: jobGroupOf(job.kind),
    engine: jobEngineOf(job.kind),
    title: job.name || job.id,
    createdAt: job.created_at || job.started_at || 0,
    status: job.state,
    // 失败时把原因直接摆在记录上 —— 用户来这里就是想看「上次那次为什么没成」
    note: job.state === 'failed' ? job.error || job.message || undefined : job.message || undefined,
    artifacts: collectTracks(job).map((track) => ({
      key: track.key,
      label: track.label,
      url: track.url ?? undefined,
      path: track.path ?? undefined,
    })),
  };
}

function modelToRecord(entry: ModelEntry): OutputRecord {
  const notes: string[] = [];
  if (entry.incomplete && entry.missing.length > 0) notes.push(`缺少 ${entry.missing.join('、')}`);
  if (entry.duplicate_of) notes.push('疑似重复');
  return {
    id: `model:${entry.id}`,
    source: 'model',
    group: 'model',
    engine: entry.category,
    title: entry.name,
    createdAt: entry.updated_at,
    status: entry.incomplete ? '缺配套文件' : entry.legacy ? '旧位置' : undefined,
    note: notes.length > 0 ? notes.join(' · ') : undefined,
    artifacts: entry.files.map((file) => ({
      key: file.rel,
      label: ROLE_LABELS[file.role] ? `${file.name}（${ROLE_LABELS[file.role]}）` : file.name,
      path: file.abs,
      bytes: file.bytes,
    })),
  };
}

function cloudToRecord(record: HistoryRecord): OutputRecord {
  return {
    id: record.id,
    source: 'cloud',
    group: 'cloud',
    engine: 'mimo',
    title: record.text,
    createdAt: record.createdAt,
    note: record.voiceLabel,
    // 音频在 IndexedDB 里，展开时才读（一次几十 MB，全量预读会卡界面）
    artifacts: [],
    cloud: record,
  };
}

export interface OutputRecords {
  records: OutputRecord[];
  loading: boolean;
  /** 服务端任务读取失败（最常见的原因就是本地服务没起） */
  jobError: string | null;
  /** 模型清单读取失败（网关接口，正常不该失败） */
  modelError: string | null;
  /** 任务数已顶到服务端上限，界面要提示「只显示最近 N 条」 */
  jobTruncated: boolean;
  refresh: () => void;
}

export function useOutputRecords(cloudRecords: HistoryRecord[]): OutputRecords {
  const [jobs, setJobs] = useState<SovitsJob[]>([]);
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [jobError, setJobError] = useState<string | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [jobTruncated, setJobTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => {
    setLoading(true);
    setTick((n) => n + 1);
  }, []);

  // 别处跑完一次就刷新（变声/翻唱面板用的同一个广播）
  useEffect(() => {
    const handler = () => refresh();
    window.addEventListener(RUN_CHANGED, handler);
    return () => window.removeEventListener(RUN_CHANGED, handler);
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const payload = await fetchJobs({ limit: OUTPUT_JOB_LIMIT });
        if (cancelled) return;
        const list = payload.jobs ?? [];
        setJobs(list);
        setJobTruncated((payload.total ?? list.length) >= OUTPUT_JOB_LIMIT);
        setJobError(null);
      } catch (cause) {
        if (cancelled) return;
        setJobs([]);
        setJobTruncated(false);
        setJobError((cause as Error).message);
      }

      try {
        const catalog = await modelsApi.catalog();
        const lists = await Promise.all(
          catalog.categories.map((category) => modelsApi.list(category.key).catch(() => null)),
        );
        if (cancelled) return;
        setModels(lists.flatMap((list) => list?.models ?? []));
        setModelError(null);
      } catch (cause) {
        if (cancelled) return;
        setModels([]);
        setModelError((cause as Error).message);
      }

      if (!cancelled) setLoading(false);
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [tick]);

  const records = useMemo(
    () =>
      [...jobs.map(jobToRecord), ...models.map(modelToRecord), ...cloudRecords.map(cloudToRecord)].sort(
        (a, b) => b.createdAt - a.createdAt,
      ),
    [jobs, models, cloudRecords],
  );

  return { records, loading, jobError, modelError, jobTruncated, refresh };
}

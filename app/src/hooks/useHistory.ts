import { useCallback, useEffect, useRef, useState } from 'react';
import * as store from '@/lib/storage';
import type { HistoryRecord } from '@/types';

/**
 * 历史记录管理：元数据与音频 Blob 均持久化在 IndexedDB，
 * 支持刷新后继续试听、下载与删除。
 */
export function useHistory(limit: number) {
  const [records, setRecords] = useState<HistoryRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const limitRef = useRef(limit);
  limitRef.current = limit;

  const refresh = useCallback(async () => {
    const list = await store.listRecords();
    setRecords(list);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const add = useCallback(
    async (record: HistoryRecord, blobs: Blob[]) => {
      await store.saveRecord(record, blobs);
      await store.pruneRecords(limitRef.current);
      await refresh();
    },
    [refresh],
  );

  const remove = useCallback(
    async (id: string) => {
      await store.deleteRecord(id);
      await refresh();
    },
    [refresh],
  );

  const clear = useCallback(async () => {
    await store.clearRecords();
    await refresh();
  }, [refresh]);

  /** 取出全部分段音频，并生成对应的临时播放地址 */
  const loadAudio = useCallback(async (id: string): Promise<{ blobs: Blob[]; urls: string[] }> => {
    const blobs = await store.getAudioBlobs(id);
    return { blobs, urls: blobs.map((blob) => URL.createObjectURL(blob)) };
  }, []);

  return { records, loading, refresh, add, remove, clear, loadAudio };
}

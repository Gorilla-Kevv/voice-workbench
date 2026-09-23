import type { HistoryRecord } from '@/types';

const DB_NAME = 'mimo-voice-studio';
const DB_VERSION = 1;
const STORE_HISTORY = 'history';
const STORE_AUDIO = 'audio';

let dbPromise: Promise<IDBDatabase> | null = null;

/** 打开（或初始化）IndexedDB。音频以 Blob 存储，避免 localStorage 容量瓶颈。 */
function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_HISTORY)) {
        const store = db.createObjectStore(STORE_HISTORY, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains(STORE_AUDIO)) {
        db.createObjectStore(STORE_AUDIO, { keyPath: 'id' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('无法打开本地数据库'));
  });

  return dbPromise;
}

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('本地数据库操作失败'));
  });
}

/** 保存一条历史记录及其全部音频分段 */
export async function saveRecord(record: HistoryRecord, blobs: Blob[]): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([STORE_HISTORY, STORE_AUDIO], 'readwrite');
    tx.objectStore(STORE_HISTORY).put(record);
    tx.objectStore(STORE_AUDIO).put({ id: record.id, blobs });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('保存历史记录失败'));
  });
}

/** 读取历史记录（按时间倒序） */
export async function listRecords(): Promise<HistoryRecord[]> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_HISTORY, 'readonly');
    const all = await promisify(tx.objectStore(STORE_HISTORY).getAll() as IDBRequest<HistoryRecord[]>);
    return all.sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

/** 取出某条记录对应的全部分段音频 */
export async function getAudioBlobs(id: string): Promise<Blob[]> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_AUDIO, 'readonly');
    const result = await promisify(
      tx.objectStore(STORE_AUDIO).get(id) as IDBRequest<
        { id: string; blobs?: Blob[]; blob?: Blob } | undefined
      >,
    );
    if (!result) return [];
    // 兼容早期版本以单 blob 存储的记录
    if (Array.isArray(result.blobs)) return result.blobs;
    return result.blob ? [result.blob] : [];
  } catch {
    return [];
  }
}

/** 删除单条记录 */
export async function deleteRecord(id: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([STORE_HISTORY, STORE_AUDIO], 'readwrite');
    tx.objectStore(STORE_HISTORY).delete(id);
    tx.objectStore(STORE_AUDIO).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('删除历史记录失败'));
  });
}

/** 清空全部记录 */
export async function clearRecords(): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([STORE_HISTORY, STORE_AUDIO], 'readwrite');
    tx.objectStore(STORE_HISTORY).clear();
    tx.objectStore(STORE_AUDIO).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('清空历史记录失败'));
  });
}

/** 超出容量上限时裁剪最旧的记录 */
export async function pruneRecords(limit: number): Promise<void> {
  const records = await listRecords();
  if (records.length <= limit) return;
  const stale = records.slice(limit);
  await Promise.all(stale.map((record) => deleteRecord(record.id)));
}

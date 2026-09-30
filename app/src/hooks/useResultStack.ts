import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createId } from '@/hooks/useSynthesis';

/**
 * 一个页面内「多条结果」的容器：新结果进栈，旧的按原样留在列表里可回看，
 * 不再像单值 state 那样被下一条冲掉。
 *
 * 三层保留（按优先级）：
 * 1. **React state** —— 正常渲染用；
 * 2. **模块级内存缓存** —— `App.tsx` 是按导航键条件渲染页面的，切走就把页面卸载了，
 *    纯 state 会整页归零；这层保证「切到别的页面再切回来」结果还在（含 Blob 地址）；
 * 3. **sessionStorage（可选）** —— 刷新浏览器后仍能回看。只有结果是可 JSON 化的
 *    （服务端路径 / 文本 / 元数据）才能用，Blob 与 ObjectURL 刷新后必然失效，那种页面别传
 *    `serialize` / `deserialize`。
 */
export interface ResultEntry<T> {
  id: string;
  createdAt: number;
  item: T;
}

interface UseResultStackOptions<T> {
  /** 最多保留多少条，超出丢弃最旧的（并对丢弃项执行 onEvict） */
  limit?: number;
  /** 传了才启用 sessionStorage 持久化 */
  storageKey?: string;
  /** 结果 → 可 JSON 化的形状 */
  serialize?: (item: T) => unknown;
  /** 反解；解析不出来返回 null，该条会被丢弃 */
  deserialize?: (raw: unknown) => T | null;
  /** 丢弃 / 删除某条时的清理（例如 `URL.revokeObjectURL`） */
  onEvict?: (item: T) => void;
}

/** 模块级内存缓存：跨页面卸载保留 */
const MEMORY = new Map<string, ResultEntry<unknown>[]>();

export function useResultStack<T>(options: UseResultStackOptions<T> = {}) {
  const { limit = 12, storageKey, serialize, deserialize, onEvict } = options;
  // 模块级缓存的键位：给了 storageKey 就直接用它（稳定、跨重挂载可复现），
  // 否则退回 useId（同一位置的组件重挂载后仍然一致）
  const fallbackKey = useId();
  const cacheKey = storageKey ?? `stack:${fallbackKey}`;

  // 回调放 ref：调用方写内联箭头函数也不会让下面的持久化 effect 每次渲染都重跑
  const latest = useRef({ serialize, onEvict });
  useEffect(() => {
    latest.current = { serialize, onEvict };
  }, [serialize, onEvict]);

  const [entries, setEntries] = useState<ResultEntry<T>[]>(() => {
    const cached = MEMORY.get(cacheKey) as ResultEntry<T>[] | undefined;
    if (cached) return cached;
    if (storageKey && deserialize) {
      try {
        const raw = window.sessionStorage.getItem(storageKey);
        if (raw) {
          const parsed: unknown = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            return parsed.flatMap((entry) => {
              const record = entry as { id?: unknown; createdAt?: unknown; item?: unknown };
              const item = deserialize(record.item);
              if (!item) return [];
              return [
                {
                  id: typeof record.id === 'string' ? record.id : createId(),
                  createdAt: typeof record.createdAt === 'number' ? record.createdAt : Date.now(),
                  item,
                },
              ];
            });
          }
        }
      } catch {
        // 解析失败就当没有历史，不影响正常使用
      }
    }
    return [];
  });

  useEffect(() => {
    MEMORY.set(cacheKey, entries as ResultEntry<unknown>[]);
    const serializeItem = latest.current.serialize;
    if (!storageKey || !serializeItem) return;
    try {
      const payload = entries.map((entry) => ({
        id: entry.id,
        createdAt: entry.createdAt,
        item: serializeItem(entry.item) ?? null,
      }));
      window.sessionStorage.setItem(storageKey, JSON.stringify(payload));
    } catch {
      // 配额满或被禁用：放弃持久化，内存里的列表照常工作
    }
  }, [entries, cacheKey, storageKey]);

  /** 入栈一条新结果（放在最前），返回它的 id */
  const push = useCallback(
    (item: T) => {
      const entry: ResultEntry<T> = { id: createId(), createdAt: Date.now(), item };
      setEntries((prev) => {
        const next = [entry, ...prev];
        const dropped = next.slice(limit);
        dropped.forEach((entry) => latest.current.onEvict?.(entry.item));
        return next.slice(0, limit);
      });
      return entry.id;
    },
    [limit],
  );

  const remove = useCallback((id: string) => {
    setEntries((prev) => {
      const target = prev.find((entry) => entry.id === id);
      if (target) latest.current.onEvict?.(target.item);
      return prev.filter((entry) => entry.id !== id);
    });
  }, []);

  const clear = useCallback(() => {
    setEntries((prev) => {
      prev.forEach((entry) => latest.current.onEvict?.(entry.item));
      return [];
    });
  }, []);

  return { entries, push, remove, clear };
}

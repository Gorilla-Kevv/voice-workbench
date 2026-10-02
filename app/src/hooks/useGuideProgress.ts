import { useCallback, useEffect, useMemo, useState } from 'react';

import { GUIDES, type Guide } from '@/lib/guides';

/**
 * 指引进度：哪些步骤做完了。
 *
 * 三条设计：
 * 1. **按指引独立存**：不同指引的步骤各自记账，互不干扰；
 * 2. **可复习**：`reset()` 清掉一份指引的进度，用户能照着再走一遍；
 * 3. **能自动就自动**：页面在关键动作里调 `markGuideEvent('netease:ref-ready')`，
 *    对应步骤自己打勾 —— 用户不用记得回来点一下。
 *    自动打勾只做「真的能观测到」的几处，观测不到的仍可手动点圆形标识切换。
 */

const STORAGE_KEY = 'voice-workbench:guide-progress';

/** 指引 id → 已完成步骤 id 列表（模块级，页面切换不丢） */
let progressState: Record<string, string[]> = (() => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string[]>) : {};
  } catch {
    return {};
  }
})();

const listeners = new Set<() => void>();

function notify(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(progressState));
  } catch {
    // 隐私模式 / 配额不足：进度退化成「仅本次会话」
  }
  listeners.forEach((listener) => listener());
}

/**
 * 页面在关键动作里上报信号（例如「参考音频已选好」「第一条合成完成」）。
 * 上报后所有 `autoKey` 命中该信号的步骤自动变成已完成。
 */
export function markGuideEvent(key: string): void {
  let changed = false;
  const next: Record<string, string[]> = { ...progressState };
  for (const guide of GUIDES) {
    const done = new Set(next[guide.id] ?? []);
    for (const step of guide.steps) {
      if (step.autoKey === key && !done.has(step.id)) {
        done.add(step.id);
        changed = true;
      }
    }
    if (changed) next[guide.id] = [...done];
  }
  if (!changed) return;
  progressState = next;
  notify();
}

export function useGuideProgress(guide: Guide) {
  const [, force] = useState(0);

  useEffect(() => {
    const listener = () => force((value) => value + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const done = useMemo(() => new Set(progressState[guide.id] ?? []), [guide.id]);

  const toggle = useCallback(
    (stepId: string) => {
      const next = new Set(progressState[guide.id] ?? []);
      if (next.has(stepId)) next.delete(stepId);
      else next.add(stepId);
      progressState = { ...progressState, [guide.id]: [...next] };
      notify();
    },
    [guide.id],
  );

  /** 复习：清空这一份指引的进度，重新按步骤走一遍 */
  const reset = useCallback(() => {
    progressState = { ...progressState, [guide.id]: [] };
    notify();
  }, [guide.id]);

  return {
    isDone: (stepId: string) => done.has(stepId),
    toggle,
    reset,
    completed: guide.steps.filter((step) => done.has(step.id)).length,
    total: guide.steps.length,
  };
}

import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_SETTINGS, STORAGE_KEYS } from '@/lib/constants';
import type { AppSettings } from '@/types';

function readStored(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.settings);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/**
 * 应用设置持久化：API Key、分段策略、播放增益等存于 localStorage。
 * 密钥仅保存在浏览器本地，请求时随请求体转发给后端，不落盘到服务端。
 */
export function useSettings() {
  const [settings, setSettings] = useState<AppSettings>(() => readStored());
  const [version, setVersion] = useState(0);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(settings));
    } catch {
      // 隐私模式下写入失败时忽略
    }
    setVersion((prev) => prev + 1);
  }, [settings]);

  const update = useCallback(<K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  }, []);

  const patch = useCallback((partial: Partial<AppSettings>) => {
    setSettings((prev) => ({ ...prev, ...partial }));
  }, []);

  const reset = useCallback(() => setSettings(DEFAULT_SETTINGS), []);

  return { settings, update, patch, reset, version };
}

import { useCallback, useEffect, useState } from 'react';

export type ThemeMode = 'light' | 'dark' | 'system';

const THEME_KEY = 'mimo-voice:theme';

function resolve(mode: ThemeMode): 'light' | 'dark' {
  if (mode !== 'system') return mode;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** 亮色 / 暗色 / 跟随系统 三态主题切换 */
export function useTheme() {
  const [mode, setMode] = useState<ThemeMode>(() => {
    const stored = localStorage.getItem(THEME_KEY);
    return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
  });
  const [theme, setTheme] = useState<'light' | 'dark'>(() => resolve(mode));

  useEffect(() => {
    const apply = () => {
      const effective = resolve(mode);
      setTheme(effective);
      document.documentElement.classList.toggle('dark', effective === 'dark');
    };
    apply();
    localStorage.setItem(THEME_KEY, mode);

    if (mode !== 'system') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [mode]);

  const toggle = useCallback(() => {
    setMode((prev) => (resolve(prev) === 'dark' ? 'light' : 'dark'));
  }, []);

  return { mode, theme, setMode, toggle };
}

import { useSyncExternalStore } from 'react';

export const APPEARANCE_KEY = 'onboarding-agent:appearance';
export const THEMES = ['classic', 'vibrant', 'midnight'] as const;
export type Theme = typeof THEMES[number];
export function isTheme(value: unknown): value is Theme {
  return THEMES.some((theme) => theme === value);
}

const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function currentTheme(): Theme {
  const value = document.documentElement.dataset.controlTowerTheme;
  return isTheme(value) ? value : 'classic';
}

export function setTheme(theme: Theme) {
  const root = document.documentElement;
  // An absent attribute means the isolated candidate presentation.
  if (!root.hasAttribute('data-control-tower-theme') || !isTheme(theme)) return;
  root.dataset.controlTowerTheme = theme;
  root.style.colorScheme = theme === 'midnight' ? 'dark' : 'light';
  try { localStorage.setItem(APPEARANCE_KEY, theme); } catch { /* In-memory selection still works. */ }
  listeners.forEach((listener) => listener());
}

export function useAppearance() {
  return useSyncExternalStore(subscribe, currentTheme, () => 'classic' as Theme);
}

import { useLayoutEffect, useSyncExternalStore } from 'react';

import { buildFontStack } from '../fontUtils';
import {
  getAccentStyleProperties,
  resolveThemePreference,
  THEME_PRELOAD_STORAGE_KEY,
  type AppThemePreference,
} from './appearance';

const systemLightQuery = '(prefers-color-scheme: light)';
const interfaceFontFallbacks = [
  'Microsoft YaHei UI',
  'Microsoft YaHei',
  'PingFang SC',
  'Hiragino Sans GB',
  'Noto Sans CJK SC',
  'Source Han Sans SC',
  'Segoe UI Variable',
  'Segoe UI',
  'ui-sans-serif',
  'system-ui',
  '-apple-system',
  'BlinkMacSystemFont',
  'sans-serif',
] as const;

type RuntimeAppearanceOptions = {
  theme: AppThemePreference;
  accentColor: string;
  interfaceFont: string;
};

function getSystemPrefersLight() {
  try {
    return typeof window.matchMedia === 'function' && window.matchMedia(systemLightQuery).matches;
  } catch {
    return false;
  }
}

function subscribeToSystemAppearance(onStoreChange: () => void) {
  if (typeof window.matchMedia !== 'function') {
    return () => {};
  }

  try {
    const query = window.matchMedia(systemLightQuery);
    const handleChange = () => onStoreChange();

    query.addEventListener('change', handleChange);
    return () => query.removeEventListener('change', handleChange);
  } catch {
    return () => {};
  }
}

function getServerSystemPrefersLight() {
  return false;
}

export function useRuntimeAppearance({
  theme,
  accentColor,
  interfaceFont,
}: RuntimeAppearanceOptions) {
  const systemPrefersLight = useSyncExternalStore(
    subscribeToSystemAppearance,
    getSystemPrefersLight,
    getServerSystemPrefersLight,
  );
  const resolvedTheme = resolveThemePreference(theme, systemPrefersLight);

  useLayoutEffect(() => {
    const root = document.documentElement;
    const accentProperties = getAccentStyleProperties(accentColor, resolvedTheme);
    const interfaceFontFamily = buildFontStack(interfaceFont, interfaceFontFallbacks);

    root.setAttribute('data-theme', resolvedTheme);
    root.style.colorScheme = resolvedTheme;

    for (const [property, value] of Object.entries(accentProperties)) {
      root.style.setProperty(property, value);
    }

    root.style.setProperty('--interface-font-family', interfaceFontFamily);
    document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', resolvedTheme);

    try {
      window.localStorage.setItem(THEME_PRELOAD_STORAGE_KEY, theme);
    } catch {
      // Restricted WebViews may deny localStorage access.
    }
  }, [accentColor, interfaceFont, resolvedTheme, theme]);

  return resolvedTheme;
}

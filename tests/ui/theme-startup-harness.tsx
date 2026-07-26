import { useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import {
  THEME_PRELOAD_TOKENS,
  clearThemePreloadTokens,
  readThemePreference,
  type AppThemePreference,
} from '../../src/theme/appearance';
import { useRuntimeAppearance } from '../../src/theme/useRuntimeAppearance';
import '../../src/styles/critical.scss';

type ThemeTokenSnapshot = Record<(typeof THEME_PRELOAD_TOKENS)[number], string>;

interface ThemeSnapshot {
  theme: string | null;
  colorScheme: string;
  metaColorScheme: string | null;
  tokens: ThemeTokenSnapshot;
  inlineTokens: ThemeTokenSnapshot;
}

interface ThemeHarnessApi {
  preRuntime: ThemeSnapshot;
  snapshot: () => ThemeSnapshot;
}

declare global {
  interface Window {
    __shellDeskThemeHarness?: ThemeHarnessApi;
  }
}

function readTokens(readToken: (token: string) => string): ThemeTokenSnapshot {
  return Object.fromEntries(
    THEME_PRELOAD_TOKENS.map((token) => [token, readToken(token).trim()]),
  ) as ThemeTokenSnapshot;
}

function captureThemeSnapshot(): ThemeSnapshot {
  const root = document.documentElement;
  const computedStyle = getComputedStyle(root);

  return {
    theme: root.getAttribute('data-theme'),
    colorScheme: root.style.colorScheme || computedStyle.colorScheme,
    metaColorScheme: document.querySelector('meta[name="color-scheme"]')?.getAttribute('content') ?? null,
    tokens: readTokens((token) => computedStyle.getPropertyValue(token)),
    inlineTokens: readTokens((token) => root.style.getPropertyValue(token)),
  };
}

const storedPreference = window.localStorage.getItem('shelldesk:theme-preload');
const themePreference = readThemePreference(
  window.location.search,
  storedPreference,
) satisfies AppThemePreference;
const preRuntimeSnapshot = captureThemeSnapshot();

window.__shellDeskThemeHarness = {
  preRuntime: preRuntimeSnapshot,
  snapshot: captureThemeSnapshot,
};

clearThemePreloadTokens();

function ThemeStartupHarness({ theme }: { theme: AppThemePreference }) {
  const [ready, setReady] = useState(false);

  useRuntimeAppearance({
    theme,
    accentColor: '#0f6bff',
    interfaceFont: 'Microsoft YaHei UI',
  });

  useLayoutEffect(() => {
    setReady(true);
  }, []);

  return (
    <main
      id="theme-startup-harness"
      data-ready={ready ? 'true' : 'false'}
      data-preference={theme}
    >
      Theme startup harness
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <ThemeStartupHarness theme={themePreference} />,
);

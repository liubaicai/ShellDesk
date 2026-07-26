import { useSyncExternalStore } from 'react';

export type ShellDeskEditorTheme = 'light' | 'dark';

const themeSubscribers = new Set<() => void>();
let themeObserver: MutationObserver | null = null;

export function getShellDeskEditorTheme(): ShellDeskEditorTheme {
  if (typeof document === 'undefined') {
    return 'dark';
  }

  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

function notifyThemeSubscribers() {
  themeSubscribers.forEach((subscriber) => subscriber());
}

function startThemeObserver() {
  if (
    themeObserver
    || typeof document === 'undefined'
    || typeof MutationObserver === 'undefined'
  ) {
    return;
  }

  themeObserver = new MutationObserver(notifyThemeSubscribers);
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
}

function subscribeToShellDeskEditorTheme(subscriber: () => void) {
  themeSubscribers.add(subscriber);
  startThemeObserver();

  return () => {
    themeSubscribers.delete(subscriber);

    if (themeSubscribers.size === 0) {
      themeObserver?.disconnect();
      themeObserver = null;
    }
  };
}

export function useShellDeskEditorTheme(): ShellDeskEditorTheme {
  return useSyncExternalStore(
    subscribeToShellDeskEditorTheme,
    getShellDeskEditorTheme,
    () => 'dark',
  );
}

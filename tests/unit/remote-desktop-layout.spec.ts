import { expect, test } from '@playwright/test';

import {
  normalizeRemoteDesktopLayout,
  shouldPreserveCurrentDesktopLayout,
} from '../../src/remoteDesktopCatalog';
import {
  createDefaultRemoteDesktopLayout,
  desktopAppCatalogVersion,
} from '../../src/remoteDesktopLayout';

test('new profiles start with only the four core desktop apps', () => {
  const layout = createDefaultRemoteDesktopLayout();

  expect(layout.items.map((item) => item.type === 'app' ? item.appKey : item.id)).toEqual([
    'files',
    'terminal',
    'browser',
    'settings',
  ]);
  expect(layout.appCatalogVersion).toBe(desktopAppCatalogVersion);
  expect(layout.seenAppCatalogVersion).toBe(desktopAppCatalogVersion);
});

test('catalog upgrades preserve explicit layouts without pinning new apps', () => {
  const layout = normalizeRemoteDesktopLayout({
    appCatalogVersion: 14,
    sortMode: 'custom',
    items: [
      { id: 'app:files', type: 'app', appKey: 'files' },
      { id: 'app:terminal', type: 'app', appKey: 'terminal' },
      { id: 'app:browser', type: 'app', appKey: 'browser' },
      { id: 'app:settings', type: 'app', appKey: 'settings' },
    ],
    removedAppKeys: [],
  });

  expect(layout.items).toHaveLength(4);
  expect(layout.appCatalogVersion).toBe(desktopAppCatalogVersion);
  expect(layout.seenAppCatalogVersion).toBe(14);
});

test('stale snapshots cannot silently drop a current desktop app', () => {
  const current = {
    ...createDefaultRemoteDesktopLayout(),
    items: [
      ...createDefaultRemoteDesktopLayout().items,
      { id: 'app:git-manager', type: 'app' as const, appKey: 'git-manager' as const },
    ],
  };
  const stale = createDefaultRemoteDesktopLayout();
  const acknowledgedRemoval = {
    ...stale,
    removedAppKeys: ['git-manager' as const],
  };

  expect(shouldPreserveCurrentDesktopLayout(current, stale)).toBe(true);
  expect(shouldPreserveCurrentDesktopLayout(current, acknowledgedRemoval)).toBe(false);
});

export const desktopAppCatalogVersion = 20;

export const defaultDesktopAppKeys: ShellDeskDesktopAppKey[] = [
  'files',
  'terminal',
  'browser',
  'settings',
];

// Catalog upgrades make applications discoverable in Launchpad. They never pin
// applications to a user's desktop; explicit user layout remains authoritative.
export const appCatalogMigrationKeys: ShellDeskDesktopAppKey[] = [];
export const latestAppCatalogMigrationKeys: ShellDeskDesktopAppKey[] = [];

export function createDefaultRemoteDesktopLayout(): ShellDeskRemoteDesktopLayout {
  return {
    appCatalogVersion: desktopAppCatalogVersion,
    seenAppCatalogVersion: desktopAppCatalogVersion,
    sortMode: 'custom',
    items: defaultDesktopAppKeys.map((appKey) => ({
      id: `app:${appKey}`,
      type: 'app',
      appKey,
    })),
    removedAppKeys: [],
  };
}

export function getRemoteDesktopLayoutAppKeys(items: ShellDeskDesktopLayoutItem[]) {
  return new Set(items.flatMap((item) => (item.type === 'app' ? [item.appKey] : item.appKeys)));
}

export function getRemoteDesktopLayoutRemovedAppKeys(
  layout: Pick<ShellDeskRemoteDesktopLayout, 'removedAppKeys'>,
) {
  return new Set(layout.removedAppKeys ?? []);
}

export function shouldPreserveCurrentRemoteDesktopLayout(
  currentLayout: ShellDeskRemoteDesktopLayout,
  incomingLayout: ShellDeskRemoteDesktopLayout,
) {
  const currentAppKeys = getRemoteDesktopLayoutAppKeys(currentLayout.items);
  const incomingAppKeys = getRemoteDesktopLayoutAppKeys(incomingLayout.items);
  const currentRemovedAppKeys = getRemoteDesktopLayoutRemovedAppKeys(currentLayout);
  const incomingRemovedAppKeys = getRemoteDesktopLayoutRemovedAppKeys(incomingLayout);
  const shouldPreserveUserRemovedApps = [...currentRemovedAppKeys]
    .some((appKey) => !incomingRemovedAppKeys.has(appKey));
  const hasUnacknowledgedMissingApp = [...currentAppKeys]
    .some((appKey) => !incomingAppKeys.has(appKey) && !incomingRemovedAppKeys.has(appKey));

  return shouldPreserveUserRemovedApps || hasUnacknowledgedMissingApp;
}

export function acknowledgeDesktopAppCatalog(
  layout: ShellDeskRemoteDesktopLayout,
): ShellDeskRemoteDesktopLayout {
  if (layout.seenAppCatalogVersion >= desktopAppCatalogVersion) {
    return layout;
  }

  return {
    ...layout,
    seenAppCatalogVersion: desktopAppCatalogVersion,
  };
}

import {
  desktopAppCatalogVersion,
  shouldPreserveCurrentRemoteDesktopLayout,
} from './remoteDesktopLayout';

const remoteDesktopLayoutShadowStorageKey = 'shelldesk:remote-desktop-layout-shadow';
export const remoteDesktopLayoutShadowPreferenceKey = 'remoteDesktop.layoutShadow';

function isRemoteDesktopLayout(value: unknown): value is ShellDeskRemoteDesktopLayout {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const layout = value as Partial<ShellDeskRemoteDesktopLayout>;
  return (
    typeof layout.appCatalogVersion === 'number'
    && (layout.sortMode === 'custom' || layout.sortMode === 'name-asc' || layout.sortMode === 'name-desc')
    && Array.isArray(layout.items)
    && Array.isArray(layout.removedAppKeys)
  );
}

function normalizeStoredRemoteDesktopLayout(value: unknown): ShellDeskRemoteDesktopLayout | null {
  if (!isRemoteDesktopLayout(value)) return null;
  const seenAppCatalogVersion = Number(value.seenAppCatalogVersion);
  return {
    ...value,
    seenAppCatalogVersion: Number.isInteger(seenAppCatalogVersion) && seenAppCatalogVersion > 0
      ? Math.min(seenAppCatalogVersion, desktopAppCatalogVersion)
      : Math.min(value.appCatalogVersion, desktopAppCatalogVersion),
  };
}

export function readRemoteDesktopLayoutShadow() {
  try {
    const rawLayout = window.localStorage.getItem(remoteDesktopLayoutShadowStorageKey);
    if (!rawLayout) return null;
    return normalizeStoredRemoteDesktopLayout(JSON.parse(rawLayout) as unknown);
  } catch {
    return null;
  }
}

export function storeRemoteDesktopLayoutShadow(layout: ShellDeskRemoteDesktopLayout) {
  try {
    window.localStorage.setItem(remoteDesktopLayoutShadowStorageKey, JSON.stringify(layout));
  } catch {
    // Ignore localStorage write failures in restricted environments.
  }
}

export function persistRemoteDesktopLayoutShadow(layout: ShellDeskRemoteDesktopLayout) {
  storeRemoteDesktopLayoutShadow(layout);
  void window.guiSSH?.preferences?.set(remoteDesktopLayoutShadowPreferenceKey, layout).catch(() => undefined);
}

export async function readPersistedRemoteDesktopLayoutShadow() {
  try {
    const layout = await window.guiSSH?.preferences?.get(remoteDesktopLayoutShadowPreferenceKey);
    return normalizeStoredRemoteDesktopLayout(layout);
  } catch {
    return null;
  }
}

function protectRemoteDesktopLayoutFromStaleSnapshot(
  incomingSettings: ShellDeskAppSettings,
  currentSettings: ShellDeskAppSettings,
) {
  if (!shouldPreserveCurrentRemoteDesktopLayout(currentSettings.remoteDesktopLayout, incomingSettings.remoteDesktopLayout)) {
    const layoutShadow = readRemoteDesktopLayoutShadow();
    if (!layoutShadow || !shouldPreserveCurrentRemoteDesktopLayout(layoutShadow, incomingSettings.remoteDesktopLayout)) {
      return incomingSettings;
    }
    return { ...incomingSettings, remoteDesktopLayout: layoutShadow };
  }
  return { ...incomingSettings, remoteDesktopLayout: currentSettings.remoteDesktopLayout };
}

function readTerminalSnippetRevision(snippet: ShellDeskTerminalSnippet) {
  const updatedAt = Date.parse(snippet.updatedAt);
  const createdAt = Date.parse(snippet.createdAt);
  return Math.max(Number.isFinite(updatedAt) ? updatedAt : 0, Number.isFinite(createdAt) ? createdAt : 0);
}

function protectTerminalSnippetsFromStaleSnapshot(
  incomingSettings: ShellDeskAppSettings,
  currentSettings: ShellDeskAppSettings,
) {
  const incomingSnippets = incomingSettings.terminalSnippets ?? [];
  const currentSnippets = currentSettings.terminalSnippets ?? [];
  if (!currentSnippets.length) return incomingSettings;

  const incomingById = new Map(incomingSnippets.map((snippet) => [snippet.id, snippet]));
  const protectedSnippetIds = new Set<string>();
  for (const currentSnippet of currentSnippets) {
    const incomingSnippet = incomingById.get(currentSnippet.id);
    if (
      !incomingSnippet
      || readTerminalSnippetRevision(currentSnippet) > readTerminalSnippetRevision(incomingSnippet)
    ) {
      protectedSnippetIds.add(currentSnippet.id);
    }
  }
  if (!protectedSnippetIds.size) return incomingSettings;

  const nextSnippets: ShellDeskTerminalSnippet[] = [];
  const addedIds = new Set<string>();
  for (const currentSnippet of currentSnippets) {
    const nextSnippet = protectedSnippetIds.has(currentSnippet.id)
      ? currentSnippet
      : incomingById.get(currentSnippet.id);
    if (nextSnippet) {
      nextSnippets.push(nextSnippet);
      addedIds.add(nextSnippet.id);
    }
  }
  for (const incomingSnippet of incomingSnippets) {
    if (!addedIds.has(incomingSnippet.id)) nextSnippets.push(incomingSnippet);
  }
  return { ...incomingSettings, terminalSnippets: nextSnippets };
}

export function protectSettingsFromStaleSnapshot(
  incomingSettings: ShellDeskAppSettings,
  currentSettings: ShellDeskAppSettings,
) {
  const settings = protectTerminalSnippetsFromStaleSnapshot(
    protectRemoteDesktopLayoutFromStaleSnapshot(incomingSettings, currentSettings),
    currentSettings,
  );
  if (!currentSettings.minimizeToTrayPromptedOnClose || settings.minimizeToTrayPromptedOnClose) {
    return settings;
  }
  return {
    ...settings,
    minimizeToTrayOnClose: currentSettings.minimizeToTrayOnClose,
    minimizeToTrayPromptedOnClose: true,
  };
}

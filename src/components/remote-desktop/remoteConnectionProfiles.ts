import type { RemoteConnectionInfo } from './types';

type ProfileValue = string | number | boolean;
export type RemoteConnectionProfileValues = Record<string, ProfileValue>;

export function getRemoteConnectionProfileHostId(connection: RemoteConnectionInfo) {
  const host = connection.host;

  if (host.id) {
    return host.id;
  }

  return `${connection.kind ?? 'ssh'}:${host.username}@${host.address}:${host.port}`;
}

export async function loadRemoteConnectionProfile(hostId: string, appKey: ShellDeskDesktopAppKey) {
  if (!hostId || !window.guiSSH?.vault?.getRemoteConnectionProfile) {
    return null;
  }

  try {
    return await window.guiSSH.vault.getRemoteConnectionProfile(hostId, appKey);
  } catch {
    return null;
  }
}

export async function saveRemoteConnectionProfile(
  hostId: string,
  appKey: ShellDeskDesktopAppKey,
  values: RemoteConnectionProfileValues,
) {
  if (!hostId || !window.guiSSH?.vault?.saveRemoteConnectionProfile) {
    return null;
  }

  return window.guiSSH.vault.saveRemoteConnectionProfile(hostId, appKey, values);
}

export function readProfileString(profile: RemoteConnectionProfileValues | null | undefined, key: string, fallback: string) {
  const value = profile?.[key];
  return typeof value === 'string' ? value : fallback;
}

export function readProfileBoolean(profile: RemoteConnectionProfileValues | null | undefined, key: string, fallback: boolean) {
  const value = profile?.[key];
  return typeof value === 'boolean' ? value : fallback;
}

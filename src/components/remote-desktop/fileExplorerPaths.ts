import { powershellCommand } from './remoteSystem';

export const DEFAULT_REMOTE_PATH = '.';

const UNIX_HOME_DIRECTORY_COMMAND = `
home=\${HOME:-}
if [ -z "$home" ]; then
  user=$(id -un 2>/dev/null || whoami 2>/dev/null || printf '')
  if [ -n "$user" ] && command -v getent >/dev/null 2>&1; then
    home=$(getent passwd "$user" 2>/dev/null | cut -d: -f6 | head -n 1)
  fi
fi
if [ -z "$home" ]; then
  home=$(pwd 2>/dev/null || printf '')
fi
printf '%s\\n' "$home"
`;

const WINDOWS_HOME_DIRECTORY_COMMAND = powershellCommand(`
$homePath = [Environment]::GetFolderPath('UserProfile')
if ([string]::IsNullOrWhiteSpace($homePath)) {
  $homePath = $env:USERPROFILE
}
$homePath
`);

export function normalizeWindowsRemotePath(remotePath: string) {
  return remotePath.replace(/\\/g, '/');
}

export function normalizeUnixRemotePath(remotePath: string) {
  return remotePath.trim() || DEFAULT_REMOTE_PATH;
}

export function isWindowsDriveRoot(remotePath: string) {
  return /^\/?[a-z]:\/?$/i.test(remotePath.trim());
}

export const isDriveRoot = isWindowsDriveRoot;

export function getDriveRoot(remotePath: string) {
  const match = normalizeWindowsRemotePath(remotePath).match(/^\/?([a-z]:)\/?/i);
  return match ? `${match[1]}/` : '';
}

export function normalizeRemotePath(remotePath: string, isWindowsHost: boolean) {
  const trimmed = remotePath.trim() || DEFAULT_REMOTE_PATH;
  return isWindowsHost ? normalizeWindowsRemotePath(trimmed) : trimmed;
}

export async function resolveRemoteHomeDirectory(connectionId: string, isWindowsHost: boolean) {
  if (!window.guiSSH?.connections) {
    return '';
  }

  const command = isWindowsHost ? WINDOWS_HOME_DIRECTORY_COMMAND : UNIX_HOME_DIRECTORY_COMMAND;
  const result = await window.guiSSH.connections.runCommand(connectionId, command);
  const homePath = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);

  return homePath ? normalizeRemotePath(homePath, isWindowsHost) : '';
}

export function isRemoteHomeAlias(remotePath: string) {
  return remotePath === DEFAULT_REMOTE_PATH || remotePath === '~';
}

export function getExplicitInitialPath(initialPath: string | undefined, isWindowsHost: boolean) {
  const explicitPath = initialPath?.trim();
  return explicitPath ? normalizeRemotePath(explicitPath, isWindowsHost) : '';
}

export function joinRemotePath(basePath: string, entryName: string, isWindowsHost = false) {
  const base = normalizeRemotePath(basePath, isWindowsHost);

  if (isWindowsHost) {
    if (base === '/') {
      return /^[a-z]:$/i.test(entryName) ? `${entryName}/` : `/${entryName}`;
    }

    if (base === '.') {
      return entryName;
    }

    if (isWindowsDriveRoot(base)) {
      return `${base.replace(/\/?$/, '/')}${entryName}`;
    }

    return `${base.replace(/\/+$/, '')}/${entryName}`;
  }

  if (base === '/') {
    return `/${entryName}`;
  }

  if (base === '.') {
    return entryName;
  }

  return `${base.replace(/\/+$/, '')}/${entryName}`;
}

export function getParentRemotePath(remotePath: string, isWindowsHost = false) {
  const p = normalizeRemotePath(remotePath, isWindowsHost);

  if (p === '/') {
    return '/';
  }

  if (p === '.') {
    return '..';
  }

  if (isWindowsHost && isWindowsDriveRoot(p)) {
    return '/';
  }

  const normalized = p.replace(/\/+$/, '');

  if (isWindowsHost) {
    const driveChildMatch = normalized.match(/^(\/?[a-z]:)\/[^/]+$/i);

    if (driveChildMatch) {
      return `${driveChildMatch[1]}/`;
    }
  }

  const slashIndex = normalized.lastIndexOf('/');

  if (slashIndex < 0) {
    return '.';
  }

  if (slashIndex === 0) {
    return '/';
  }

  return normalized.slice(0, slashIndex);
}

export function getFileExtension(name: string) {
  const dotIndex = name.lastIndexOf('.');
  return dotIndex > 0 ? name.slice(dotIndex + 1).toLowerCase() : '';
}

export function getBaseName(path: string) {
  const normalized = normalizeWindowsRemotePath(path).replace(/\/+$/, '');
  const slashIndex = normalized.lastIndexOf('/');
  return slashIndex >= 0 ? normalized.slice(slashIndex + 1) : normalized;
}

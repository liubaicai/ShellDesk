import { getParentRemotePath, joinRemotePath } from '../remote-desktop/fileExplorerPaths';

export function isWindowsPlatform(platform: string | undefined) {
  return platform === 'win32';
}

export function joinLocalPath(basePath: string, name: string, windows: boolean) {
  if (!windows) {
    return basePath === '/' ? `/${name}` : `${basePath.replace(/\/+$/, '')}/${name}`;
  }
  if (basePath === '/') {
    return /^[a-z]:$/i.test(name) ? `${name}\\` : name;
  }
  const normalized = basePath.replace(/[\\/]+$/, '');
  return `${normalized}\\${name}`;
}

export function getParentLocalPath(path: string, windows: boolean) {
  if (!windows) {
    if (path === '/') return '/';
    const normalized = path.replace(/\/+$/, '');
    const index = normalized.lastIndexOf('/');
    return index <= 0 ? '/' : normalized.slice(0, index);
  }
  if (path === '/' || /^[a-z]:[\\/]?$/i.test(path)) return '/';
  const normalized = path.replace(/[\\/]+$/, '');
  const index = Math.max(normalized.lastIndexOf('\\'), normalized.lastIndexOf('/'));
  return index <= 2 ? `${normalized.slice(0, 2)}\\` : normalized.slice(0, index);
}

export function joinPanePath(kind: 'local' | 'remote', basePath: string, name: string, windows: boolean) {
  return kind === 'local' ? joinLocalPath(basePath, name, windows) : joinRemotePath(basePath, name);
}

export function getParentPanePath(kind: 'local' | 'remote', path: string, windows: boolean) {
  return kind === 'local' ? getParentLocalPath(path, windows) : getParentRemotePath(path);
}

export function getPathName(path: string) {
  const normalized = path.replace(/[\\/]+$/, '');
  return normalized.split(/[\\/]/).pop() || path;
}

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

export function normalizePaneTreePath(kind: 'local' | 'remote', path: string, windows: boolean) {
  const normalized = path.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  if (!normalized) return kind === 'remote' ? '.' : '/';
  if (kind === 'local' && windows) {
    const driveMatch = normalized.match(/^([a-z]:)(?:\/(.*))?$/i);
    if (!driveMatch) return normalized;
    const remainder = driveMatch[2]?.replace(/^\/+|\/+$/g, '') ?? '';
    return remainder ? `${driveMatch[1]}/${remainder}` : `${driveMatch[1]}/`;
  }
  if (normalized === '/') return '/';
  return normalized.replace(/\/+$/, '');
}

export function getPaneTreePathChain(kind: 'local' | 'remote', path: string, windows: boolean) {
  const normalized = normalizePaneTreePath(kind, path, windows);
  const root = '/';
  if (normalized === root) return [root];

  if (kind === 'local' && windows) {
    const driveMatch = normalized.match(/^([a-z]:)(?:\/(.*))?$/i);
    if (!driveMatch) return [root];
    const driveRoot = `${driveMatch[1]}/`;
    const remainder = driveMatch[2]?.split('/').filter(Boolean) ?? [];
    return remainder.reduce<string[]>((paths, segment) => {
      const parent = paths.at(-1) ?? driveRoot;
      paths.push(`${parent}${parent.endsWith('/') ? '' : '/'}${segment}`);
      return paths;
    }, [root, driveRoot]);
  }

  if (!normalized.startsWith('/')) return [root];
  return normalized.split('/').filter(Boolean).reduce<string[]>((paths, segment) => {
    const parent = paths.at(-1) ?? root;
    paths.push(parent === '/' ? `/${segment}` : `${parent}/${segment}`);
    return paths;
  }, [root]);
}

export function paneTreePathsEqual(kind: 'local' | 'remote', left: string, right: string, windows: boolean) {
  const normalizedLeft = normalizePaneTreePath(kind, left, windows);
  const normalizedRight = normalizePaneTreePath(kind, right, windows);
  return kind === 'local' && windows
    ? normalizedLeft.toLocaleLowerCase() === normalizedRight.toLocaleLowerCase()
    : normalizedLeft === normalizedRight;
}

export function getPathName(path: string) {
  const normalized = path.replace(/[\\/]+$/, '');
  return normalized.split(/[\\/]/).pop() || path;
}

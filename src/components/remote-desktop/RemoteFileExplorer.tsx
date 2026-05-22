import {
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import { formatDateTime, getErrorMessage } from './desktopUtils';
import { isWindowsSystem } from './remoteSystem';
import { isTextFile } from './RemoteNotepad';
import type { RemoteSystemType } from './types';

interface RemoteFileExplorerProps {
  connectionId: string;
  systemType?: RemoteSystemType;
  onOpenFile?: (filePath: string) => void;
  onOpenSqliteFile?: (filePath: string) => void;
  onOpenTerminal?: (directoryPath: string) => void;
}

interface RemoteFileEntry {
  name: string;
  longname: string;
  type: 'directory' | 'file' | 'symlink';
  size: number;
  modifiedAt: string;
}

interface RemoteDirectoryResult {
  path: string;
  entries: RemoteFileEntry[];
}

interface RemotePathStat {
  type: string;
  size: number;
  mode: number;
  owner: number;
  group: number;
  modifiedAt: string;
  accessedAt: string;
}

type SortField = 'name' | 'modifiedAt' | 'type' | 'size';
type SortDirection = 'asc' | 'desc';

interface ContextMenuState {
  x: number;
  y: number;
  targetEntry: RemoteFileEntry | null;
}

export function normalizeWindowsRemotePath(remotePath: string) {
  return remotePath.replace(/\\/g, '/');
}

export function isWindowsDriveRoot(remotePath: string) {
  return /^\/?[a-z]:\/?$/i.test(remotePath.trim());
}

export function normalizeRemotePath(remotePath: string, isWindowsHost: boolean) {
  const trimmed = remotePath.trim() || '.';
  return isWindowsHost ? normalizeWindowsRemotePath(trimmed) : trimmed;
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

function formatBytes(size: number) {
  if (!Number.isFinite(size) || size < 0) {
    return '-';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = size;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function getFileExtension(name: string) {
  const dotIndex = name.lastIndexOf('.');
  return dotIndex > 0 ? name.slice(dotIndex + 1).toLowerCase() : '';
}

function isArchiveFile(name: string) {
  const lower = name.toLowerCase();
  return lower.endsWith('.zip') || lower.endsWith('.tar') || lower.endsWith('.tar.gz') ||
    lower.endsWith('.tgz') || lower.endsWith('.tar.bz2') || lower.endsWith('.tbz2') ||
    lower.endsWith('.tar.xz') || lower.endsWith('.txz') || lower.endsWith('.7z') ||
    lower.endsWith('.gz') || lower.endsWith('.rar');
}

const SQLITE_EXTENSIONS = new Set(['db', 'sqlite', 'sqlite3', 's3db', 'sl3', 'sqlitedb']);

function isSqliteFile(name: string): boolean {
  return SQLITE_EXTENSIONS.has(getFileExtension(name));
}

function getDeleteEntriesLabel(entries: RemoteFileEntry[]) {
  const names = entries.map((entry) => entry.name).join('\u3001');

  return entries.length === 1
    ? `${entries[0].type === 'directory' ? '目录' : '文件'}\u300C${names}\u300D`
    : `${entries.length} 个项目（${names}）`;
}

function getFileIcon(entry: RemoteFileEntry) {
  if (entry.type === 'directory') {
    return '\u{1F4C1}';
  }

  if (entry.type === 'symlink') {
    return '\u{1F517}';
  }

  const ext = getFileExtension(entry.name);

  const iconMap: Record<string, string> = {
    js: '\u{1F4DC}', ts: '\u{1F4D8}', tsx: '\u{1F4D8}', jsx: '\u{1F4DC}',
    py: '\u{1F40D}', rb: '\u{1F48E}', go: '\u{1F535}', rs: '\u{1F980}',
    java: '\u2615', c: '\u{1F527}', cpp: '\u{1F527}', h: '\u{1F527}',
    html: '\u{1F310}', htm: '\u{1F310}', css: '\u{1F3A8}', scss: '\u{1F3A8}',
    json: '\u{1F4CB}', xml: '\u{1F4CB}', yaml: '\u{1F4CB}', yml: '\u{1F4CB}', toml: '\u{1F4CB}',
    md: '\u{1F4DD}', txt: '\u{1F4DD}', log: '\u{1F4DD}', csv: '\u{1F4CA}',
    sh: '\u2699\uFE0F', bash: '\u2699\uFE0F', zsh: '\u2699\uFE0F',
    png: '\u{1F5BC}\uFE0F', jpg: '\u{1F5BC}\uFE0F', jpeg: '\u{1F5BC}\uFE0F', gif: '\u{1F5BC}\uFE0F', svg: '\u{1F5BC}\uFE0F', webp: '\u{1F5BC}\uFE0F',
    mp3: '\u{1F3B5}', wav: '\u{1F3B5}', flac: '\u{1F3B5}',
    mp4: '\u{1F3AC}', avi: '\u{1F3AC}', mkv: '\u{1F3AC}', mov: '\u{1F3AC}',
    zip: '\u{1F4E6}', tar: '\u{1F4E6}', gz: '\u{1F4E6}', '7z': '\u{1F4E6}', rar: '\u{1F4E6}',
    pdf: '\u{1F4D5}', doc: '\u{1F4D8}', docx: '\u{1F4D8}',
    conf: '\u2699\uFE0F', cfg: '\u2699\uFE0F', ini: '\u2699\uFE0F', env: '\u2699\uFE0F',
    pem: '\u{1F511}', key: '\u{1F511}',
    sql: '\u{1F5C3}\uFE0F', db: '\u{1F5C3}\uFE0F',
  };

  return iconMap[ext] ?? '\u{1F4C4}';
}

function getFileTypeLabel(entry: RemoteFileEntry) {
  if (entry.type === 'directory') {
    return '文件夹';
  }

  if (entry.type === 'symlink') {
    return '快捷方式';
  }

  const ext = getFileExtension(entry.name);
  return ext ? `.${ext} 文件` : '文件';
}

function isHiddenEntry(entry: RemoteFileEntry) {
  return entry.name.startsWith('.') && entry.name !== '.' && entry.name !== '..';
}

function getOpenActionLabel(entry: RemoteFileEntry) {
  if (entry.type === 'directory') {
    return '打开目录';
  }

  if (entry.type === 'file' && isSqliteFile(entry.name)) {
    return '用 SQLite 打开';
  }

  if (entry.type === 'file' && isTextFile(entry.name)) {
    return '用记事本打开';
  }

  return '';
}

function formatMode(mode: number) {
  const perms = [
    (mode & 0o400) ? 'r' : '-',
    (mode & 0o200) ? 'w' : '-',
    (mode & 0o100) ? 'x' : '-',
    (mode & 0o040) ? 'r' : '-',
    (mode & 0o020) ? 'w' : '-',
    (mode & 0o010) ? 'x' : '-',
    (mode & 0o004) ? 'r' : '-',
    (mode & 0o002) ? 'w' : '-',
    (mode & 0o001) ? 'x' : '-',
  ];
  return perms.join('');
}

function isValidFileName(name: string, isWindowsHost = false) {
  if (!name.trim()) return false;
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) return false;
  if (isWindowsHost && /[<>:"|?*]/.test(name)) return false;
  if (name === '.' || name === '..') return false;
  return name.length <= 255;
}

function getSortValue(entry: RemoteFileEntry, field: SortField): string | number {
  switch (field) {
    case 'name': return entry.name.toLowerCase();
    case 'modifiedAt': return entry.modifiedAt || '';
    case 'type': return entry.type === 'directory' ? 0 : entry.type === 'symlink' ? 1 : 2;
    case 'size': return entry.type === 'directory' ? -1 : entry.size;
    default: return '';
  }
}

function RemoteFileExplorer({ connectionId, systemType, onOpenFile, onOpenSqliteFile, onOpenTerminal }: RemoteFileExplorerProps) {
  const isWindowsHost = isWindowsSystem(systemType);
  const [remotePath, setRemotePath] = useState('.');
  const [pathDraft, setPathDraft] = useState('.');
  const [fileSearchQuery, setFileSearchQuery] = useState('');
  const [fileEntries, setFileEntries] = useState<RemoteFileEntry[]>([]);
  const [selectedNames, setSelectedNames] = useState<Set<string>>(new Set());
  const [filesError, setFilesError] = useState('');
  const [isFilesLoading, setIsFilesLoading] = useState(false);
  const [filesRefreshToken, setFilesRefreshToken] = useState(0);
  const [sortField, setSortField] = useState<SortField>('name');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [showHiddenEntries, setShowHiddenEntries] = useState(false);
  const [isDetailsOpen, setIsDetailsOpen] = useState(true);
  const [favoritePaths, setFavoritePaths] = useState<string[]>([]);
  const [navigationHistory, setNavigationHistory] = useState<string[]>(['.']);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [renamingName, setRenamingName] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [isCreatingNew, setIsCreatingNew] = useState<'file' | 'folder' | null>(null);
  const [newItemDraft, setNewItemDraft] = useState('');
  const [propertiesEntry, setPropertiesEntry] = useState<RemoteFileEntry | null>(null);
  const [propertiesData, setPropertiesData] = useState<RemotePathStat | null>(null);
  const [propertiesLoading, setPropertiesLoading] = useState(false);
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const [lastClickedName, setLastClickedName] = useState<string | null>(null);
  const [deleteConfirmationEntries, setDeleteConfirmationEntries] = useState<RemoteFileEntry[] | null>(null);
  const [transferProgress, setTransferProgress] = useState<{ type: 'download' | 'upload'; fileName: string; transferred: number; total: number } | null>(null);

  const renameInputRef = useRef<HTMLInputElement>(null);
  const newItemInputRef = useRef<HTMLInputElement>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setPathDraft(remotePath);
  }, [remotePath]);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!window.guiSSH?.connections) {
      setFilesError('当前运行环境不支持 SFTP 文件浏览。');
      return;
    }

    let cancelled = false;

    const loadFiles = async () => {
      setIsFilesLoading(true);
      setFilesError('');
      setSelectedNames(new Set());
      setRenamingName(null);
      setIsCreatingNew(null);
      setContextMenu(null);

      try {
        const result: RemoteDirectoryResult = await window.guiSSH!.connections.listDirectory(connectionId, remotePath);

        if (!cancelled) {
          setFileEntries(result.entries);
          setRemotePath(result.path);
          setPathDraft(result.path);
          setNavigationHistory((history) => history.map((path, index) => (
            index === historyIndex ? result.path : path
          )));
        }
      } catch (error) {
        if (!cancelled) {
          setFileEntries([]);
          setFilesError(getErrorMessage(error));
        }
      } finally {
        if (!cancelled) {
          setIsFilesLoading(false);
        }
      }
    };

    void loadFiles();

    return () => {
      cancelled = true;
    };
  }, [connectionId, filesRefreshToken, historyIndex, remotePath]);

  useEffect(() => {
    if (renamingName && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingName]);

  useEffect(() => {
    if (isCreatingNew && newItemInputRef.current) {
      newItemInputRef.current.focus();
    }
  }, [isCreatingNew]);

  useEffect(() => {
    if (copiedPath) {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopiedPath(null), 2000);
    }
  }, [copiedPath]);

  useEffect(() => {
    const unsubscribe = window.guiSSH?.events.onTransferProgress((payload) => {
      setTransferProgress(payload);
    });
    const unsubEnd = window.guiSSH?.events.onTransferEnd(() => {
      setTransferProgress(null);
    });
    return () => { unsubscribe?.(); unsubEnd?.(); };
  }, []);

  const sortedEntries = useMemo(() => {
    const sorted = [...fileEntries].sort((a, b) => {
      const aVal = getSortValue(a, sortField);
      const bVal = getSortValue(b, sortField);
      let cmp = 0;

      if (typeof aVal === 'number' && typeof bVal === 'number') {
        cmp = aVal - bVal;
      } else {
        cmp = String(aVal).localeCompare(String(bVal), 'zh-CN');
      }

      return sortDirection === 'asc' ? cmp : -cmp;
    });

    return sorted;
  }, [fileEntries, sortField, sortDirection]);

  const displayedEntries = useMemo(() => {
    const query = fileSearchQuery.trim().toLowerCase();
    const visibleEntries = showHiddenEntries
      ? sortedEntries
      : sortedEntries.filter((entry) => !isHiddenEntry(entry));

    if (!query) {
      return visibleEntries;
    }

    return visibleEntries.filter((entry) => {
      const haystack = `${entry.name} ${getFileTypeLabel(entry)}`.toLowerCase();
      return haystack.includes(query);
    });
  }, [fileSearchQuery, showHiddenEntries, sortedEntries]);

  const selectedEntries = useMemo(
    () => sortedEntries.filter((entry) => selectedNames.has(entry.name)),
    [selectedNames, sortedEntries],
  );

  const selectedFileEntries = useMemo(
    () => selectedEntries.filter((entry) => entry.type === 'file'),
    [selectedEntries],
  );

  const primarySelectedEntry = useMemo(() => {
    if (lastClickedName) {
      const lastClickedEntry = selectedEntries.find((entry) => entry.name === lastClickedName);

      if (lastClickedEntry) {
        return lastClickedEntry;
      }
    }

    return selectedEntries[0] ?? null;
  }, [lastClickedName, selectedEntries]);

  const selectedFilesSize = useMemo(
    () => selectedFileEntries.reduce((totalSize, entry) => totalSize + Math.max(entry.size, 0), 0),
    [selectedFileEntries],
  );

  useEffect(() => {
    if (!isDetailsOpen || selectedEntries.length !== 1 || !primarySelectedEntry || !window.guiSSH?.connections) {
      setPropertiesData(null);
      setPropertiesLoading(false);
      return;
    }

    let cancelled = false;

    const loadSelectedEntryProperties = async () => {
      setPropertiesData(null);
      setPropertiesLoading(true);

      try {
        const entryPath = joinRemotePath(remotePath, primarySelectedEntry.name, isWindowsHost);
        const stat = await window.guiSSH!.connections.statPath(connectionId, entryPath);

        if (!cancelled) {
          setPropertiesData(stat ?? null);
        }
      } catch {
        if (!cancelled) {
          setPropertiesData(null);
        }
      } finally {
        if (!cancelled) {
          setPropertiesLoading(false);
        }
      }
    };

    void loadSelectedEntryProperties();

    return () => {
      cancelled = true;
    };
  }, [connectionId, isDetailsOpen, isWindowsHost, primarySelectedEntry, remotePath, selectedEntries.length]);

  const navigateToPath = useCallback((nextPath: string) => {
    const normalizedPath = normalizeRemotePath(nextPath, isWindowsHost);

    if (normalizedPath === remotePath) {
      return;
    }

    setNavigationHistory((history) => [...history.slice(0, historyIndex + 1), normalizedPath]);
    setHistoryIndex(historyIndex + 1);
    setRemotePath(normalizedPath);
  }, [historyIndex, isWindowsHost, remotePath]);

  const navigateBack = useCallback(() => {
    if (historyIndex <= 0) {
      return;
    }

    const nextIndex = historyIndex - 1;
    setHistoryIndex(nextIndex);
    setRemotePath(navigationHistory[nextIndex]);
  }, [historyIndex, navigationHistory]);

  const navigateForward = useCallback(() => {
    if (historyIndex >= navigationHistory.length - 1) {
      return;
    }

    const nextIndex = historyIndex + 1;
    setHistoryIndex(nextIndex);
    setRemotePath(navigationHistory[nextIndex]);
  }, [historyIndex, navigationHistory]);

  const navigateToParent = useCallback(() => {
    navigateToPath(getParentRemotePath(remotePath, isWindowsHost));
  }, [isWindowsHost, navigateToPath, remotePath]);

  const submitRemotePath = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    navigateToPath(pathDraft);
  }, [navigateToPath, pathDraft]);

  const toggleFavoritePath = useCallback(() => {
    setFavoritePaths((paths) => paths.includes(remotePath)
      ? paths.filter((path) => path !== remotePath)
      : [remotePath, ...paths].slice(0, 8));
  }, [remotePath]);

  const openFileEntry = useCallback((entry: RemoteFileEntry) => {
    if (entry.type === 'directory') {
      navigateToPath(joinRemotePath(remotePath, entry.name, isWindowsHost));
    } else if (entry.type === 'file' && isTextFile(entry.name) && onOpenFile) {
      onOpenFile(joinRemotePath(remotePath, entry.name, isWindowsHost));
    } else if (entry.type === 'file' && isSqliteFile(entry.name) && onOpenSqliteFile) {
      onOpenSqliteFile(joinRemotePath(remotePath, entry.name, isWindowsHost));
    }
  }, [isWindowsHost, navigateToPath, remotePath, onOpenFile, onOpenSqliteFile]);

  const refreshFiles = useCallback(() => {
    setFilesRefreshToken((currentToken) => currentToken + 1);
  }, []);

  const handleSort = useCallback((field: SortField) => {
    setSortField((prevField) => {
      if (prevField === field) {
        setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
        return prevField;
      }
      setSortDirection('asc');
      return field;
    });
  }, []);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  const handleRowClick = useCallback((entry: RemoteFileEntry, event: ReactMouseEvent) => {
    closeContextMenu();

    if (event.ctrlKey || event.metaKey) {
      setSelectedNames((prev) => {
        const next = new Set(prev);
        if (next.has(entry.name)) {
          next.delete(entry.name);
        } else {
          next.add(entry.name);
        }
        return next;
      });
    } else if (event.shiftKey && lastClickedName) {
      const names = displayedEntries.map((e) => e.name);
      const anchorIndex = names.indexOf(lastClickedName);
      const currentIndex = names.indexOf(entry.name);

      if (anchorIndex >= 0 && currentIndex >= 0) {
        const start = Math.min(anchorIndex, currentIndex);
        const end = Math.max(anchorIndex, currentIndex);
        const rangeNames = names.slice(start, end + 1);
        setSelectedNames(new Set(rangeNames));
      }
    } else {
      setSelectedNames(new Set([entry.name]));
    }

    setLastClickedName(entry.name);
  }, [closeContextMenu, displayedEntries, lastClickedName]);

  const handleRowDoubleClick = useCallback((entry: RemoteFileEntry) => {
    closeContextMenu();
    openFileEntry(entry);
  }, [closeContextMenu, openFileEntry]);

  const handleRowContextMenu = useCallback((entry: RemoteFileEntry, event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();

    if (!selectedNames.has(entry.name)) {
      setSelectedNames(new Set([entry.name]));
    }

    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      targetEntry: entry,
    });
  }, [selectedNames]);

  const handleBackgroundContextMenu = useCallback((event: ReactMouseEvent) => {
    event.preventDefault();
    closeContextMenu();

    if ((event.target as HTMLElement).closest('.explorer-row')) return;

    setSelectedNames(new Set());
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      targetEntry: null,
    });
  }, [closeContextMenu]);

  const deleteSelectedEntries = useCallback((entries?: RemoteFileEntry[]) => {
    const targets = entries ?? sortedEntries.filter((e) => selectedNames.has(e.name));

    if (!targets.length) return;

    closeContextMenu();
    setDeleteConfirmationEntries(targets);
  }, [closeContextMenu, selectedNames, sortedEntries]);

  const confirmDeleteSelectedEntries = useCallback(async () => {
    const targets = deleteConfirmationEntries;

    if (!targets?.length) return;

    try {
      setFilesError('');
      setDeleteConfirmationEntries(null);
      const errors: string[] = [];

      for (const entry of targets) {
        const entryPath = joinRemotePath(remotePath, entry.name, isWindowsHost);
        try {
          await window.guiSSH?.connections.deletePath(connectionId, entryPath, entry.type);
        } catch (error) {
          errors.push(`${entry.name}: ${getErrorMessage(error)}`);
        }
      }

      if (errors.length) {
        setFilesError(`删除部分项目失败：\n${errors.join('\n')}`);
      }

      refreshFiles();
    } catch (error) {
      setFilesError(getErrorMessage(error));
    }
  }, [connectionId, deleteConfirmationEntries, isWindowsHost, remotePath, refreshFiles]);

  const startRename = useCallback((entry: RemoteFileEntry) => {
    closeContextMenu();
    setRenamingName(entry.name);
    setRenameDraft(entry.name);
  }, [closeContextMenu]);

  const commitRename = useCallback(async () => {
    if (!renamingName) return;

    const trimmed = renameDraft.trim();

    if (!trimmed || trimmed === renamingName) {
      setRenamingName(null);
      return;
    }

    if (!isValidFileName(trimmed, isWindowsHost)) {
      setFilesError('文件名无效。');
      setRenamingName(null);
      return;
    }

    try {
      setFilesError('');
      const oldPath = joinRemotePath(remotePath, renamingName, isWindowsHost);
      const newPath = joinRemotePath(remotePath, trimmed, isWindowsHost);
      await window.guiSSH?.connections.renamePath(connectionId, oldPath, newPath);
      setRenamingName(null);
      refreshFiles();
    } catch (error) {
      setFilesError(getErrorMessage(error));
      setRenamingName(null);
    }
  }, [connectionId, isWindowsHost, remotePath, renamingName, renameDraft, refreshFiles]);

  const cancelRename = useCallback(() => {
    setRenamingName(null);
  }, []);

  const startNewItem = useCallback((type: 'file' | 'folder') => {
    closeContextMenu();
    setIsCreatingNew(type);
    setNewItemDraft(type === 'file' ? '新建文件.txt' : '新建文件夹');
  }, [closeContextMenu]);

  const commitNewItem = useCallback(async () => {
    if (!isCreatingNew) return;

    const trimmed = newItemDraft.trim();

    if (!trimmed) {
      setIsCreatingNew(null);
      return;
    }

    if (!isValidFileName(trimmed, isWindowsHost)) {
      setFilesError('名称无效。');
      setIsCreatingNew(null);
      return;
    }

    try {
      setFilesError('');
      if (isCreatingNew === 'folder') {
        await window.guiSSH?.connections.createDirectory(connectionId, joinRemotePath(remotePath, trimmed, isWindowsHost));
      } else {
        await window.guiSSH?.connections.createFile(connectionId, joinRemotePath(remotePath, trimmed, isWindowsHost));
      }
      setIsCreatingNew(null);
      refreshFiles();
    } catch (error) {
      setFilesError(getErrorMessage(error));
      setIsCreatingNew(null);
    }
  }, [connectionId, isWindowsHost, remotePath, isCreatingNew, newItemDraft, refreshFiles]);

  const cancelNewItem = useCallback(() => {
    setIsCreatingNew(null);
  }, []);

  const copyEntryPath = useCallback((entry: RemoteFileEntry) => {
    closeContextMenu();
    const fullPath = joinRemotePath(remotePath, entry.name, isWindowsHost);
    void navigator.clipboard?.writeText(fullPath);
    setCopiedPath(entry.name);
  }, [closeContextMenu, isWindowsHost, remotePath]);

  const showProperties = useCallback(async (entry: RemoteFileEntry) => {
    closeContextMenu();
    setPropertiesEntry(entry);
    setPropertiesData(null);
    setPropertiesLoading(true);

    try {
      const entryPath = joinRemotePath(remotePath, entry.name, isWindowsHost);
      const stat = await window.guiSSH?.connections.statPath(connectionId, entryPath);
      setPropertiesData(stat ?? null);
    } catch {
      setPropertiesData(null);
    } finally {
      setPropertiesLoading(false);
    }
  }, [closeContextMenu, connectionId, isWindowsHost, remotePath]);

  const downloadFile = useCallback(async (entry: RemoteFileEntry) => {
    closeContextMenu();
    try {
      setFilesError('');
      const entryPath = joinRemotePath(remotePath, entry.name, isWindowsHost);
      const result = await window.guiSSH?.connections.downloadFile(connectionId, entryPath);
      if (!result?.canceled && result?.filePath) {
        setFilesError('');
      }
    } catch (error) {
      setFilesError(getErrorMessage(error));
    }
  }, [closeContextMenu, connectionId, isWindowsHost, remotePath]);

  const downloadFiles = useCallback(async (entries: RemoteFileEntry[]) => {
    const files = entries.filter((entry) => entry.type === 'file');

    if (!files.length) {
      return;
    }

    for (const entry of files) {
      await downloadFile(entry);
    }
  }, [downloadFile]);

  const uploadFile = useCallback(async () => {
    closeContextMenu();
    try {
      setFilesError('');
      const result = await window.guiSSH?.connections.uploadFile(connectionId, remotePath);
      if (!result?.canceled) {
        refreshFiles();
      }
    } catch (error) {
      setFilesError(getErrorMessage(error));
    }
  }, [closeContextMenu, connectionId, remotePath, refreshFiles]);

  const cancelTransfer = useCallback(async () => {
    try {
      await window.guiSSH?.connections.cancelTransfer(connectionId);
    } catch { /* ignore */ }
  }, [connectionId]);

  const compressEntries = useCallback(async (entries: RemoteFileEntry[], format: string) => {
    closeContextMenu();
    if (!entries.length || !window.guiSSH?.connections) return;

    try {
      setFilesError('');
      const sourcePaths = entries.map((e) => joinRemotePath(remotePath, e.name, isWindowsHost));
      const baseName = entries.length === 1 ? entries[0].name : `${entries.length}_files`;
      const ext = format === 'zip' ? '.zip' : format === 'tar' ? '.tar' : format === 'tar.gz' ? '.tar.gz' : '.7z';
      const destPath = joinRemotePath(remotePath, `${baseName}${ext}`, isWindowsHost);
      await window.guiSSH.connections.compress(connectionId, sourcePaths, format, destPath);
      refreshFiles();
    } catch (error) {
      setFilesError(getErrorMessage(error));
    }
  }, [closeContextMenu, connectionId, isWindowsHost, remotePath, refreshFiles]);

  const decompressEntry = useCallback(async (entry: RemoteFileEntry) => {
    closeContextMenu();
    if (!window.guiSSH?.connections) return;

    try {
      setFilesError('');
      const archivePath = joinRemotePath(remotePath, entry.name, isWindowsHost);
      await window.guiSSH.connections.decompress(connectionId, archivePath, remotePath);
      refreshFiles();
    } catch (error) {
      setFilesError(getErrorMessage(error));
    }
  }, [closeContextMenu, connectionId, isWindowsHost, remotePath, refreshFiles]);

  const handleKeydown = useCallback((event: ReactKeyboardEvent) => {
    if (renamingName || isCreatingNew) return;

    switch (event.key) {
      case 'Delete': {
        event.preventDefault();
        void deleteSelectedEntries();
        break;
      }
      case 'F2': {
        event.preventDefault();
        const target = displayedEntries.find((e) => selectedNames.has(e.name));
        if (target) startRename(target);
        break;
      }
      case 'Enter': {
        event.preventDefault();
        const target = displayedEntries.find((e) => selectedNames.has(e.name));
        if (target) openFileEntry(target);
        break;
      }
      case 'a': {
        if (event.ctrlKey || event.metaKey) {
          event.preventDefault();
          setSelectedNames(new Set(fileEntries.map((e) => e.name)));
        }
        break;
      }
      case 'F5': {
        event.preventDefault();
        refreshFiles();
        break;
      }
    }
  }, [renamingName, isCreatingNew, deleteSelectedEntries, displayedEntries, selectedNames, startRename, openFileEntry, fileEntries, refreshFiles]);

  const breadcrumbSegments = useMemo(() => {
    const p = normalizeRemotePath(remotePath, isWindowsHost);
    if (p === '.' || p === '..') return [{ label: p, path: p }];
    if (p === '/') return [{ label: '/', path: '/' }];

    const parts = p.replace(/\/+$/, '').split('/').filter(Boolean);
    const rootPrefix = p.startsWith('/') ? '/' : '';
    return parts.map((part, index) => {
      const isDrive = isWindowsHost && index === 0 && /^[a-z]:$/i.test(part);
      const pathValue = `${rootPrefix}${parts.slice(0, index + 1).join('/')}`;
      return { label: part, path: isDrive ? `${rootPrefix}${part}/` : pathValue };
    });
  }, [isWindowsHost, remotePath]);

  const handleBreadcrumbClick = useCallback((pathValue: string) => {
    navigateToPath(pathValue);
  }, [navigateToPath]);

  const quickAccessPaths = useMemo(() => isWindowsHost
    ? [
        { label: 'Home', path: '.', icon: '⌂' },
        { label: '根目录', path: '/', icon: '⌂' },
        { label: 'C:/', path: 'C:/', icon: '□' },
        { label: 'C:/Users', path: 'C:/Users', icon: '□' },
        { label: 'C:/Program Files', path: 'C:/Program Files', icon: '□' },
        { label: 'C:/Windows', path: 'C:/Windows', icon: '□' },
        { label: 'C:/Temp', path: 'C:/Temp', icon: '□' },
      ]
    : [
        { label: 'Home', path: '.', icon: '⌂' },
        { label: '根目录', path: '/', icon: '⌂' },
        { label: '/home', path: '/home', icon: '□' },
        { label: '/tmp', path: '/tmp', icon: '□' },
        { label: '/var/log', path: '/var/log', icon: '□' },
        { label: '/etc', path: '/etc', icon: '□' },
        { label: '/opt', path: '/opt', icon: '□' },
        { label: '/usr/local', path: '/usr/local', icon: '□' },
      ], [isWindowsHost]);

  const isFavoritePath = favoritePaths.includes(remotePath);
  const selectedOpenActionLabel = selectedEntries.length === 1 && primarySelectedEntry
    ? getOpenActionLabel(primarySelectedEntry)
    : '';
  const selectedArchiveCanDecompress = selectedEntries.length === 1 &&
    primarySelectedEntry?.type === 'file' &&
    isArchiveFile(primarySelectedEntry.name) &&
    (!isWindowsHost || primarySelectedEntry.name.toLowerCase().endsWith('.zip'));

  const sortIndicator = useCallback((field: SortField) => {
    if (sortField !== field) return '';
    return sortDirection === 'asc' ? ' \u25B2' : ' \u25BC';
  }, [sortField, sortDirection]);

  return (
    <div className="file-pane explorer-pane" onKeyDown={handleKeydown} tabIndex={-1}>
      <form className="explorer-addressbar" onSubmit={submitRemotePath}>
        <div className="explorer-nav-buttons" aria-label="目录导航">
          <button type="button" onClick={navigateBack} disabled={historyIndex <= 0} aria-label="后退" title="后退">
            ←
          </button>
          <button type="button" onClick={navigateForward} disabled={historyIndex >= navigationHistory.length - 1} aria-label="前进" title="前进">
            →
          </button>
          <button type="button" onClick={navigateToParent} aria-label="返回上级目录" title="返回上级目录">
            ↑
          </button>
          <button type="button" onClick={() => navigateToPath(isWindowsHost ? '.' : '/home')} aria-label="打开 Home" title="Home">
            ⌂
          </button>
        </div>
        <div className="addressbar-breadcrumb-input">
          <div className="breadcrumb-trail">
            {breadcrumbSegments.map((segment, index) => (
              <span key={`${segment.path}-${index}`} className="breadcrumb-segment">
                {index > 0 && <span className="breadcrumb-sep">/</span>}
                <button
                  type="button"
                  className="breadcrumb-btn"
                  onClick={() => handleBreadcrumbClick(segment.path)}
                >
                  {segment.label}
                </button>
              </span>
            ))}
          </div>
          <input
            value={pathDraft}
            onChange={(event) => setPathDraft(event.target.value)}
            spellCheck={false}
            placeholder={isWindowsHost ? '输入路径，如 C:/Users 后按回车...' : '输入路径后按回车...'}
          />
        </div>
        <label className="explorer-search">
          <span aria-hidden="true">⌕</span>
          <input
            value={fileSearchQuery}
            onChange={(event) => setFileSearchQuery(event.target.value)}
            placeholder="搜索"
            spellCheck={false}
          />
        </label>
        <button type="submit" className="explorer-go-button">转到</button>
      </form>

      <div className="explorer-commandbar" aria-label="文件工具栏">
        <div className="explorer-command-group">
          <button type="button" onClick={refreshFiles} disabled={isFilesLoading} title="刷新当前目录">
            刷新
          </button>
          <button type="button" onClick={() => startNewItem('file')}>
            新建文件
          </button>
          <button type="button" onClick={() => startNewItem('folder')}>
            新建目录
          </button>
          <button type="button" onClick={() => void uploadFile()}>
            上传
          </button>
          <button type="button" onClick={() => void downloadFiles(selectedFileEntries)} disabled={!selectedFileEntries.length}>
            下载
          </button>
        </div>
        <div className="explorer-command-group explorer-command-group-end">
          {copiedPath ? <span className="ribbon-toast">已复制 {copiedPath} 路径</span> : null}
          {onOpenTerminal ? (
            <button type="button" onClick={() => onOpenTerminal(remotePath)} title="在终端中打开当前目录">
              终端
            </button>
          ) : null}
          <button type="button" className={showHiddenEntries ? 'active' : ''} aria-pressed={showHiddenEntries} onClick={() => setShowHiddenEntries((visible) => !visible)}>
            隐藏项
          </button>
          <button type="button" className={isFavoritePath ? 'active' : ''} aria-pressed={isFavoritePath} onClick={toggleFavoritePath}>
            {isFavoritePath ? '取消收藏' : '收藏'}
          </button>
          <button type="button" className={isDetailsOpen ? 'active' : ''} aria-pressed={isDetailsOpen} onClick={() => setIsDetailsOpen((open) => !open)}>
            详情
          </button>
        </div>
      </div>

      <div className={`explorer-layout ${isDetailsOpen ? 'with-details' : ''}`}>
        <aside className="explorer-sidebar" aria-label="快速访问">
          <div className="sidebar-section-title">快速访问</div>
          {quickAccessPaths.slice(0, 2).map((item) => (
            <button key={item.path} type="button" className={remotePath === item.path ? 'active' : ''} onClick={() => navigateToPath(item.path)}>
              <span aria-hidden="true">{item.icon}</span>{item.label}
            </button>
          ))}
          <div className="sidebar-section-title">常用目录</div>
          {quickAccessPaths.slice(2).map((item) => (
            <button key={item.path} type="button" className={remotePath === item.path ? 'active' : ''} onClick={() => navigateToPath(item.path)}>
              <span aria-hidden="true">{item.icon}</span>{item.label}
            </button>
          ))}
          <div className="sidebar-section-title">收藏路径</div>
          {favoritePaths.length ? favoritePaths.map((path) => (
            <button key={path} type="button" className={remotePath === path ? 'active' : ''} onClick={() => navigateToPath(path)} title={path}>
              <span aria-hidden="true">★</span>{path}
            </button>
          )) : (
            <div className="explorer-sidebar-note">暂无收藏路径</div>
          )}
          <div className="sidebar-section-title">传输</div>
          <div className={`explorer-transfer-card ${transferProgress ? 'running' : ''}`}>
            <strong>{transferProgress ? '正在传输' : '无活动传输'}</strong>
            <span>
              {transferProgress
                ? `${transferProgress.type === 'download' ? '下载' : '上传'} ${transferProgress.fileName}`
                : '暂无上传或下载任务'}
            </span>
          </div>
        </aside>

        <section
          className="explorer-main"
          aria-label="远程文件列表"
          onContextMenu={handleBackgroundContextMenu}
          onClick={(e) => {
            if (!(e.target as HTMLElement).closest('.explorer-row')) {
              setSelectedNames(new Set());
              closeContextMenu();
            }
          }}
        >
          {filesError ? <div className="error-banner">{filesError}</div> : null}

          {isCreatingNew ? (
            <div className="explorer-row new-item-row">
              <span className="explorer-name-cell">
                <b className={`file-kind-icon ${isCreatingNew === 'folder' ? 'directory' : 'file'}`}>
                  {isCreatingNew === 'folder' ? '\u{1F4C1}' : '\u{1F4C4}'}
                </b>
                <input
                  ref={newItemInputRef}
                  className="inline-rename-input"
                  value={newItemDraft}
                  onChange={(e) => setNewItemDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); void commitNewItem(); }
                    if (e.key === 'Escape') { e.preventDefault(); cancelNewItem(); }
                  }}
                  onBlur={() => void commitNewItem()}
                  spellCheck={false}
                />
              </span>
              <span />
              <span />
              <span />
            </div>
          ) : null}

          <div className="explorer-table" role="table" ref={tableRef}>
            <div className="explorer-row explorer-header" role="row">
              <button type="button" className="sort-header" onClick={() => handleSort('name')}>
                名称{sortIndicator('name')}
              </button>
              <button type="button" className="sort-header" onClick={() => handleSort('modifiedAt')}>
                修改日期{sortIndicator('modifiedAt')}
              </button>
              <button type="button" className="sort-header" onClick={() => handleSort('type')}>
                类型{sortIndicator('type')}
              </button>
              <button type="button" className="sort-header" onClick={() => handleSort('size')}>
                大小{sortIndicator('size')}
              </button>
            </div>
            {displayedEntries.map((entry) => {
              const isRenaming = renamingName === entry.name;

              return (
                <div
                  key={`${entry.type}:${entry.name}`}
                  className={`explorer-row ${selectedNames.has(entry.name) ? 'selected' : ''}`}
                  onClick={(e) => handleRowClick(entry, e)}
                  onDoubleClick={() => handleRowDoubleClick(entry)}
                  onContextMenu={(e) => handleRowContextMenu(entry, e)}
                  role="row"
                >
                  {isRenaming ? (
                    <span className="explorer-name-cell">
                      <b className={`file-kind-icon ${entry.type}`}>{getFileIcon(entry)}</b>
                      <input
                        ref={renameInputRef}
                        className="inline-rename-input"
                        value={renameDraft}
                        onChange={(e) => setRenameDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') { e.preventDefault(); void commitRename(); }
                          if (e.key === 'Escape') { e.preventDefault(); cancelRename(); }
                        }}
                        onBlur={() => void commitRename()}
                        onClick={(e) => e.stopPropagation()}
                        spellCheck={false}
                      />
                    </span>
                  ) : (
                    <span className="explorer-name-cell">
                      <b className={`file-kind-icon ${entry.type}`}>{getFileIcon(entry)}</b>
                      {entry.name}
                    </span>
                  )}
                  <span>{formatDateTime(entry.modifiedAt)}</span>
                  <span>{getFileTypeLabel(entry)}</span>
                  <span>{entry.type === 'directory' ? '' : formatBytes(entry.size)}</span>
                </div>
              );
            })}
          </div>

          {!isFilesLoading && !filesError && !displayedEntries.length ? (
            <div className="empty-inline">{fileEntries.length ? '没有匹配的文件。' : '该目录为空。'}</div>
          ) : null}
        </section>

        {isDetailsOpen ? (
          <aside className="explorer-details" aria-label="文件详情">
            <div className="explorer-details-header">
              <strong>详情</strong>
              <button type="button" onClick={() => setIsDetailsOpen(false)} aria-label="关闭详情面板" title="关闭详情">
                ×
              </button>
            </div>

            {primarySelectedEntry && selectedEntries.length === 1 ? (
              <>
                <div className="explorer-details-hero">
                  <b className={`file-kind-icon ${primarySelectedEntry.type}`}>{getFileIcon(primarySelectedEntry)}</b>
                  <div>
                    <strong>{primarySelectedEntry.name}</strong>
                    <span>{getFileTypeLabel(primarySelectedEntry)}</span>
                  </div>
                </div>
                <dl className="explorer-details-list">
                  <div>
                    <dt>路径</dt>
                    <dd title={joinRemotePath(remotePath, primarySelectedEntry.name, isWindowsHost)}>
                      {joinRemotePath(remotePath, primarySelectedEntry.name, isWindowsHost)}
                    </dd>
                  </div>
                  <div>
                    <dt>大小</dt>
                    <dd>{primarySelectedEntry.type === 'directory' ? '-' : formatBytes(primarySelectedEntry.size)}</dd>
                  </div>
                  <div>
                    <dt>修改时间</dt>
                    <dd>{formatDateTime(primarySelectedEntry.modifiedAt)}</dd>
                  </div>
                  {propertiesLoading ? (
                    <div>
                      <dt>属性</dt>
                      <dd>正在读取...</dd>
                    </div>
                  ) : null}
                  {propertiesData ? (
                    <>
                      <div>
                        <dt>权限</dt>
                        <dd><code>{formatMode(propertiesData.mode)}</code></dd>
                      </div>
                      <div>
                        <dt>所有者</dt>
                        <dd>UID {propertiesData.owner} / GID {propertiesData.group}</dd>
                      </div>
                      <div>
                        <dt>访问时间</dt>
                        <dd>{formatDateTime(propertiesData.accessedAt)}</dd>
                      </div>
                    </>
                  ) : null}
                </dl>
                <div className="explorer-details-actions">
                  {selectedOpenActionLabel ? (
                    <button type="button" onClick={() => openFileEntry(primarySelectedEntry)}>
                      {selectedOpenActionLabel}
                    </button>
                  ) : null}
                  {primarySelectedEntry.type === 'file' ? (
                    <button type="button" onClick={() => void downloadFile(primarySelectedEntry)}>
                      下载
                    </button>
                  ) : null}
                  {selectedArchiveCanDecompress ? (
                    <button type="button" onClick={() => void decompressEntry(primarySelectedEntry)}>
                      解压缩
                    </button>
                  ) : null}
                  {primarySelectedEntry.type === 'directory' && onOpenTerminal ? (
                    <button type="button" onClick={() => onOpenTerminal(joinRemotePath(remotePath, primarySelectedEntry.name, isWindowsHost))}>
                      在终端中打开
                    </button>
                  ) : null}
                </div>
              </>
            ) : selectedEntries.length > 1 ? (
              <div className="explorer-details-empty">
                <strong>{selectedEntries.length} 个项目已选</strong>
                <span>{selectedFileEntries.length ? `其中 ${selectedFileEntries.length} 个文件，合计 ${formatBytes(selectedFilesSize)}` : '当前选择不含普通文件。'}</span>
              </div>
            ) : (
              <div className="explorer-details-empty">
                <strong>当前目录</strong>
                <span title={remotePath}>{remotePath}</span>
                <small>{showHiddenEntries ? '隐藏项已显示' : '隐藏项已过滤'}</small>
              </div>
            )}
          </aside>
        ) : null}
      </div>

      <div className="explorer-statusbar">
        <span>{fileSearchQuery ? `${displayedEntries.length} / ${fileEntries.length} 个项目` : `${fileEntries.length} 个项目`}</span>
        <span>
          {selectedNames.size > 0
            ? `已选择 ${selectedNames.size} 个项目${selectedNames.size === 1 ? ` \u2014 ${sortedEntries.find((e) => selectedNames.has(e.name))?.name ?? ''}` : ''}`
            : '未选择项目'}
        </span>
      </div>

      {transferProgress ? (
        <div className="transfer-progress">
          <div className="transfer-progress-info">
            <span className="transfer-progress-label">
              <button type="button" className="transfer-cancel-btn" onClick={() => void cancelTransfer()} title="取消传输">&times;</button>
              {transferProgress.type === 'download' ? '下载' : '上传'} {transferProgress.fileName}
            </span>
            <span>
              {formatBytes(transferProgress.transferred)}
              {transferProgress.total > 0 ? ` / ${formatBytes(transferProgress.total)}` : ''}
            </span>
          </div>
          <div className="transfer-progress-bar">
            <div
              className="transfer-progress-fill"
              style={{
                width: transferProgress.total > 0
                  ? `${Math.round((transferProgress.transferred / transferProgress.total) * 100)}%`
                  : '10%',
              }}
            />
          </div>
        </div>
      ) : null}

      {contextMenu ? createPortal(
        <>
          <div className="context-menu-overlay" onClick={closeContextMenu} onContextMenu={(e) => { e.preventDefault(); closeContextMenu(); }} />
          <div
            className="context-menu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            role="menu"
          >
            {contextMenu.targetEntry ? (
              <>
                {contextMenu.targetEntry.type === 'directory' && (
                  <button type="button" role="menuitem" onClick={() => { closeContextMenu(); openFileEntry(contextMenu.targetEntry!); }}>
                    打开
                  </button>
                )}
                {contextMenu.targetEntry.type === 'directory' && onOpenTerminal ? (
                  <button type="button" role="menuitem" onClick={() => {
                    closeContextMenu();
                    onOpenTerminal(joinRemotePath(remotePath, contextMenu.targetEntry!.name, isWindowsHost));
                  }}>
                    在终端中打开
                  </button>
                ) : null}
                {contextMenu.targetEntry.type === 'file' && isTextFile(contextMenu.targetEntry.name) && onOpenFile && (
                  <button type="button" role="menuitem" onClick={() => {
                    closeContextMenu();
                    onOpenFile(joinRemotePath(remotePath, contextMenu.targetEntry!.name, isWindowsHost));
                  }}>
                    用记事本打开
                  </button>
                )}
                {contextMenu.targetEntry.type === 'file' && isSqliteFile(contextMenu.targetEntry.name) && onOpenSqliteFile && (
                  <button type="button" role="menuitem" onClick={() => {
                    closeContextMenu();
                    onOpenSqliteFile(joinRemotePath(remotePath, contextMenu.targetEntry!.name, isWindowsHost));
                  }}>
                    用 SQLite 打开
                  </button>
                )}
                <button type="button" role="menuitem" onClick={() => startRename(contextMenu.targetEntry!)}>
                  重命名
                </button>
                <button type="button" role="menuitem" onClick={() => copyEntryPath(contextMenu.targetEntry!)}>
                  复制路径
                </button>
                {contextMenu.targetEntry.type === 'file' && (
                  <button type="button" role="menuitem" onClick={() => void downloadFile(contextMenu.targetEntry!)}>
                    下载
                  </button>
                )}
                {isArchiveFile(contextMenu.targetEntry.name) && contextMenu.targetEntry.type === 'file' && (!isWindowsHost || contextMenu.targetEntry.name.toLowerCase().endsWith('.zip')) && (
                  <button type="button" role="menuitem" onClick={() => void decompressEntry(contextMenu.targetEntry!)}>
                    解压缩
                  </button>
                )}
                <div className="context-menu-item-has-submenu">
                  <button type="button" role="menuitem">
                    压缩为 ▸
                  </button>
                  <div className="context-submenu">
                    {(() => {
                      const targets = selectedNames.has(contextMenu.targetEntry!.name) && selectedNames.size > 1
                        ? sortedEntries.filter((e) => selectedNames.has(e.name))
                        : [contextMenu.targetEntry!];
                      return (
                        <>
                          <button type="button" role="menuitem" onClick={() => void compressEntries(targets, 'zip')}>ZIP (.zip)</button>
                          {!isWindowsHost ? (
                            <>
                              <button type="button" role="menuitem" onClick={() => void compressEntries(targets, 'tar.gz')}>TAR.GZ (.tar.gz)</button>
                              <button type="button" role="menuitem" onClick={() => void compressEntries(targets, 'tar')}>TAR (.tar)</button>
                              <button type="button" role="menuitem" onClick={() => void compressEntries(targets, '7z')}>7Z (.7z)</button>
                            </>
                          ) : null}
                        </>
                      );
                    })()}
                  </div>
                </div>
                <div className="context-menu-sep" />
                <button type="button" role="menuitem" className="danger-text" onClick={() => void deleteSelectedEntries(contextMenu.targetEntry ? [contextMenu.targetEntry] : undefined)}>
                  删除
                </button>
                <div className="context-menu-sep" />
                <button type="button" role="menuitem" onClick={() => void showProperties(contextMenu.targetEntry!)}>
                  属性
                </button>
              </>
            ) : (
              <>
                <button type="button" role="menuitem" onClick={refreshFiles}>
                  刷新
                </button>
                <div className="context-menu-sep" />
                <button type="button" role="menuitem" onClick={() => startNewItem('file')}>
                  新建文件
                </button>
                <button type="button" role="menuitem" onClick={() => startNewItem('folder')}>
                  新建文件夹
                </button>
                <div className="context-menu-sep" />
                <button type="button" role="menuitem" onClick={() => void uploadFile()}>
                  上传文件
                </button>
                {onOpenTerminal ? (
                  <button type="button" role="menuitem" onClick={() => { closeContextMenu(); onOpenTerminal(remotePath); }}>
                    在终端中打开
                  </button>
                ) : null}
              </>
            )}
          </div>
        </>,
        document.body,
      ) : null}

      {deleteConfirmationEntries ? createPortal(
        <div className="notepad-modal-overlay" role="presentation" onClick={() => setDeleteConfirmationEntries(null)}>
          <div
            className="notepad-modal"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="explorer-delete-confirm-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div id="explorer-delete-confirm-title" className="notepad-modal-title">确认删除</div>
            <div className="notepad-modal-message">
              确认删除远程{getDeleteEntriesLabel(deleteConfirmationEntries)}？此操作不可撤销。
            </div>
            <div className="notepad-modal-actions">
              <button type="button" className="notepad-modal-btn" onClick={() => setDeleteConfirmationEntries(null)}>取消</button>
              <button type="button" className="notepad-modal-btn danger" onClick={() => void confirmDeleteSelectedEntries()}>删除</button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}

      {propertiesEntry ? createPortal(
        <>
          <div className="context-menu-overlay" onClick={() => setPropertiesEntry(null)} />
          <div className="properties-dialog">
            <div className="properties-header">
              <strong>{propertiesEntry.name}</strong>
              <button type="button" onClick={() => setPropertiesEntry(null)}>&times;</button>
            </div>
            <div className="properties-body">
              {propertiesLoading ? (
                <div className="properties-loading">正在读取属性...</div>
              ) : (
                <table className="properties-table">
                  <tbody>
                    <tr><td>名称</td><td>{propertiesEntry.name}</td></tr>
                    <tr><td>类型</td><td>{getFileTypeLabel(propertiesEntry)}</td></tr>
                    <tr><td>大小</td><td>{propertiesEntry.type === 'directory' ? '-' : formatBytes(propertiesEntry.size)}</td></tr>
                    <tr><td>修改时间</td><td>{formatDateTime(propertiesEntry.modifiedAt)}</td></tr>
                    {propertiesData ? (
                      <>
                        <tr><td>权限</td><td><code>{formatMode(propertiesData.mode)}</code></td></tr>
                        <tr><td>所有者</td><td>UID {propertiesData.owner} / GID {propertiesData.group}</td></tr>
                        <tr><td>访问时间</td><td>{formatDateTime(propertiesData.accessedAt)}</td></tr>
                      </>
                    ) : null}
                  </tbody>
                </table>
              )}
            </div>
            <div className="properties-footer">
              <button type="button" className="properties-close-btn" onClick={() => setPropertiesEntry(null)}>确定</button>
            </div>
          </div>
        </>,
        document.body,
      ) : null}

    </div>
  );
}

export default RemoteFileExplorer;

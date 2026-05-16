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

import { formatDateTime, getErrorMessage } from './desktopUtils';

interface RemoteFileExplorerProps {
  connectionId: string;
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

function joinRemotePath(basePath: string, entryName: string) {
  const base = basePath.trim() || '.';

  if (base === '/') {
    return `/${entryName}`;
  }

  if (base === '.') {
    return entryName;
  }

  return `${base.replace(/\/+$/, '')}/${entryName}`;
}

function getParentRemotePath(remotePath: string) {
  const p = remotePath.trim() || '.';

  if (p === '/') {
    return '/';
  }

  if (p === '.') {
    return '..';
  }

  const normalized = p.replace(/\/+$/, '');
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

function isValidFileName(name: string) {
  if (!name.trim()) return false;
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) return false;
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

function RemoteFileExplorer({ connectionId }: RemoteFileExplorerProps) {
  const [remotePath, setRemotePath] = useState('.');
  const [pathDraft, setPathDraft] = useState('.');
  const [fileEntries, setFileEntries] = useState<RemoteFileEntry[]>([]);
  const [selectedNames, setSelectedNames] = useState<Set<string>>(new Set());
  const [filesError, setFilesError] = useState('');
  const [isFilesLoading, setIsFilesLoading] = useState(false);
  const [filesRefreshToken, setFilesRefreshToken] = useState(0);
  const [sortField, setSortField] = useState<SortField>('name');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
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
  }, [connectionId, filesRefreshToken, remotePath]);

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

  const navigateToPath = useCallback((nextPath: string) => {
    setRemotePath(nextPath.trim() || '.');
  }, []);

  const submitRemotePath = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    navigateToPath(pathDraft);
  }, [navigateToPath, pathDraft]);

  const openFileEntry = useCallback((entry: RemoteFileEntry) => {
    if (entry.type === 'directory') {
      navigateToPath(joinRemotePath(remotePath, entry.name));
    }
  }, [navigateToPath, remotePath]);

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
      const names = sortedEntries.map((e) => e.name);
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
  }, [closeContextMenu, lastClickedName, sortedEntries]);

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

  const deleteSelectedEntries = useCallback(async (entries?: RemoteFileEntry[]) => {
    const targets = entries ?? sortedEntries.filter((e) => selectedNames.has(e.name));

    if (!targets.length) return;

    const names = targets.map((e) => e.name).join('\u3001');
    const label = targets.length === 1
      ? `${targets[0].type === 'directory' ? '目录' : '文件'}\u300C${names}\u300D`
      : `${targets.length} 个项目（${names}）`;

    if (!window.confirm(`确认删除远程${label}？此操作不可撤销。`)) return;

    try {
      setFilesError('');
      const errors: string[] = [];

      for (const entry of targets) {
        const entryPath = joinRemotePath(remotePath, entry.name);
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
  }, [connectionId, remotePath, refreshFiles, selectedNames, sortedEntries]);

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

    if (!isValidFileName(trimmed)) {
      setFilesError('文件名无效。');
      setRenamingName(null);
      return;
    }

    try {
      setFilesError('');
      const oldPath = joinRemotePath(remotePath, renamingName);
      const newPath = joinRemotePath(remotePath, trimmed);
      await window.guiSSH?.connections.renamePath(connectionId, oldPath, newPath);
      setRenamingName(null);
      refreshFiles();
    } catch (error) {
      setFilesError(getErrorMessage(error));
      setRenamingName(null);
    }
  }, [connectionId, remotePath, renamingName, renameDraft, refreshFiles]);

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

    if (!isValidFileName(trimmed)) {
      setFilesError('名称无效。');
      setIsCreatingNew(null);
      return;
    }

    try {
      setFilesError('');
      if (isCreatingNew === 'folder') {
        await window.guiSSH?.connections.createDirectory(connectionId, joinRemotePath(remotePath, trimmed));
      } else {
        await window.guiSSH?.connections.createFile(connectionId, joinRemotePath(remotePath, trimmed));
      }
      setIsCreatingNew(null);
      refreshFiles();
    } catch (error) {
      setFilesError(getErrorMessage(error));
      setIsCreatingNew(null);
    }
  }, [connectionId, remotePath, isCreatingNew, newItemDraft, refreshFiles]);

  const cancelNewItem = useCallback(() => {
    setIsCreatingNew(null);
  }, []);

  const copyEntryPath = useCallback((entry: RemoteFileEntry) => {
    closeContextMenu();
    const fullPath = joinRemotePath(remotePath, entry.name);
    void navigator.clipboard?.writeText(fullPath);
    setCopiedPath(entry.name);
  }, [closeContextMenu, remotePath]);

  const showProperties = useCallback(async (entry: RemoteFileEntry) => {
    closeContextMenu();
    setPropertiesEntry(entry);
    setPropertiesData(null);
    setPropertiesLoading(true);

    try {
      const entryPath = joinRemotePath(remotePath, entry.name);
      const stat = await window.guiSSH?.connections.statPath(connectionId, entryPath);
      setPropertiesData(stat ?? null);
    } catch {
      setPropertiesData(null);
    } finally {
      setPropertiesLoading(false);
    }
  }, [closeContextMenu, connectionId, remotePath]);

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
        const target = sortedEntries.find((e) => selectedNames.has(e.name));
        if (target) startRename(target);
        break;
      }
      case 'Enter': {
        event.preventDefault();
        const target = sortedEntries.find((e) => selectedNames.has(e.name));
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
  }, [renamingName, isCreatingNew, deleteSelectedEntries, sortedEntries, selectedNames, startRename, openFileEntry, fileEntries, refreshFiles]);

  const breadcrumbSegments = useMemo(() => {
    const p = remotePath.trim();
    if (p === '.' || p === '..') return [p];
    if (p === '/') return ['/'];
    const parts = p.replace(/\/+$/, '').split('/').filter(Boolean);
    return parts;
  }, [remotePath]);

  const handleBreadcrumbClick = useCallback((segment: string, index: number, allSegments: string[]) => {
    if (index === 0 && (remotePath.startsWith('/') || remotePath === '/')) {
      navigateToPath('/');
    } else {
      navigateToPath(allSegments.slice(0, index + 1).join('/'));
    }
  }, [navigateToPath, remotePath]);

  const sortIndicator = useCallback((field: SortField) => {
    if (sortField !== field) return '';
    return sortDirection === 'asc' ? ' \u25B2' : ' \u25BC';
  }, [sortField, sortDirection]);

  return (
    <div className="file-pane explorer-pane" onKeyDown={handleKeydown} tabIndex={-1}>
      <div className="explorer-ribbon">
        <button type="button" onClick={() => navigateToPath(getParentRemotePath(remotePath))} title="返回上级目录">上级</button>
        <button type="button" onClick={refreshFiles} title="刷新 (F5)">刷新</button>
        <div className="ribbon-separator" />
        <button type="button" onClick={() => startNewItem('file')} title="新建文件">新建文件</button>
        <button type="button" onClick={() => startNewItem('folder')} title="新建文件夹">新建文件夹</button>
        <div className="ribbon-separator" />
        <button type="button" onClick={() => void deleteSelectedEntries()} disabled={!selectedNames.size} title="删除选中项目 (Delete)">删除</button>
        <button type="button" onClick={() => { const t = sortedEntries.find((e) => selectedNames.has(e.name)); if (t) startRename(t); }} disabled={selectedNames.size !== 1} title="重命名 (F2)">重命名</button>
        <div className="ribbon-spacer" />
        {copiedPath ? <span className="ribbon-toast">已复制: {copiedPath}</span> : null}
      </div>

      <form className="explorer-addressbar" onSubmit={submitRemotePath}>
        <span>路径</span>
        <div className="addressbar-breadcrumb-input">
          <div className="breadcrumb-trail">
            {breadcrumbSegments.map((segment, index) => (
              <span key={`${segment}-${index}`} className="breadcrumb-segment">
                {index > 0 && <span className="breadcrumb-sep">/</span>}
                <button
                  type="button"
                  className="breadcrumb-btn"
                  onClick={() => handleBreadcrumbClick(segment, index, breadcrumbSegments)}
                >
                  {segment}
                </button>
              </span>
            ))}
          </div>
          <input
            value={pathDraft}
            onChange={(event) => setPathDraft(event.target.value)}
            spellCheck={false}
            placeholder="输入路径后按回车..."
          />
        </div>
        <button type="submit">转到</button>
      </form>

      <div className="explorer-layout">
        <aside className="explorer-sidebar" aria-label="快速访问">
          <div className="sidebar-section-title">快速访问</div>
          <button type="button" className={remotePath === '.' ? 'active' : ''} onClick={() => navigateToPath('.')}>Home</button>
          <button type="button" className={remotePath === '/' ? 'active' : ''} onClick={() => navigateToPath('/')}>根目录</button>
          <div className="sidebar-section-title">常用目录</div>
          <button type="button" onClick={() => navigateToPath('/home')}>/home</button>
          <button type="button" onClick={() => navigateToPath('/tmp')}>/tmp</button>
          <button type="button" onClick={() => navigateToPath('/var/log')}>/var/log</button>
          <button type="button" onClick={() => navigateToPath('/etc')}>/etc</button>
          <button type="button" onClick={() => navigateToPath('/opt')}>/opt</button>
          <button type="button" onClick={() => navigateToPath('/usr/local')}>/usr/local</button>
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
                <b>{isCreatingNew === 'folder' ? '\u{1F4C1}' : '\u{1F4C4}'}</b>
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
            {sortedEntries.map((entry) => {
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
                      <b>{getFileIcon(entry)}</b>
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
                      <b>{getFileIcon(entry)}</b>
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

          {!isFilesLoading && !filesError && !fileEntries.length ? <div className="empty-inline">该目录为空。</div> : null}
        </section>
      </div>

      <div className="explorer-statusbar">
        <span>{fileEntries.length} 个项目</span>
        <span>
          {selectedNames.size > 0
            ? `已选择 ${selectedNames.size} 个项目${selectedNames.size === 1 ? ` \u2014 ${sortedEntries.find((e) => selectedNames.has(e.name))?.name ?? ''}` : ''}`
            : '未选择项目'}
        </span>
      </div>

      {contextMenu ? (
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
                <button type="button" role="menuitem" onClick={() => startRename(contextMenu.targetEntry!)}>
                  重命名
                </button>
                <button type="button" role="menuitem" onClick={() => copyEntryPath(contextMenu.targetEntry!)}>
                  复制路径
                </button>
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
              </>
            )}
          </div>
        </>
      ) : null}

      {propertiesEntry ? (
        <>
          <div className="context-menu-overlay" onClick={() => setPropertiesEntry(null)} />
          <div className="properties-dialog">
            <div className="properties-header">
              <strong>{propertiesEntry.name}</strong>
              <button type="button" onClick={() => setPropertiesEntry(null)}>\u2715</button>
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
        </>
      ) : null}
    </div>
  );
}

export default RemoteFileExplorer;

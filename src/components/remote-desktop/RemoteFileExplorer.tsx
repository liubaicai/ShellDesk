import { type FormEvent, useEffect, useState } from 'react';

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
  const path = remotePath.trim() || '.';

  if (path === '/') {
    return '/';
  }

  if (path === '.') {
    return '..';
  }

  const normalized = path.replace(/\/+$/, '');
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

function getFileIcon(entry: RemoteFileEntry) {
  if (entry.type === 'directory') {
    return '📁';
  }

  if (entry.type === 'symlink') {
    return '🔗';
  }

  return '📄';
}

function getFileTypeLabel(entry: RemoteFileEntry) {
  if (entry.type === 'directory') {
    return '文件夹';
  }

  if (entry.type === 'symlink') {
    return '快捷方式';
  }

  return '文件';
}

function RemoteFileExplorer({ connectionId }: RemoteFileExplorerProps) {
  const [remotePath, setRemotePath] = useState('.');
  const [pathDraft, setPathDraft] = useState('.');
  const [fileEntries, setFileEntries] = useState<RemoteFileEntry[]>([]);
  const [selectedEntryName, setSelectedEntryName] = useState('');
  const [filesError, setFilesError] = useState('');
  const [isFilesLoading, setIsFilesLoading] = useState(false);
  const [filesRefreshToken, setFilesRefreshToken] = useState(0);
  const selectedEntry = fileEntries.find((entry) => entry.name === selectedEntryName) ?? null;

  useEffect(() => {
    setPathDraft(remotePath);
  }, [remotePath]);

  useEffect(() => {
    if (!window.guiSSH?.connections) {
      setFilesError('当前运行环境不支持 SFTP 文件浏览。');
      return;
    }

    let cancelled = false;

    const loadFiles = async () => {
      setIsFilesLoading(true);
      setFilesError('');
      setSelectedEntryName('');

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

  const navigateToPath = (nextPath: string) => {
    setRemotePath(nextPath.trim() || '.');
  };

  const submitRemotePath = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    navigateToPath(pathDraft);
  };

  const openFileEntry = (entry: RemoteFileEntry) => {
    if (entry.type === 'directory') {
      navigateToPath(joinRemotePath(remotePath, entry.name));
    }
  };

  const refreshFiles = () => {
    setFilesRefreshToken((currentToken) => currentToken + 1);
  };

  const createDirectory = async () => {
    const directoryName = window.prompt('请输入要在当前目录下创建的目录名。');

    if (directoryName === null) {
      return;
    }

    const nextName = directoryName.trim();

    if (!nextName || nextName.includes('/') || nextName.includes('\\') || nextName.includes('\0')) {
      setFilesError('目录名无效。');
      return;
    }

    try {
      setFilesError('');
      await window.guiSSH?.connections.createDirectory(connectionId, joinRemotePath(remotePath, nextName));
      refreshFiles();
    } catch (error) {
      setFilesError(getErrorMessage(error));
    }
  };

  const deleteSelectedEntry = async () => {
    if (!selectedEntry) {
      return;
    }

    const remoteEntryPath = joinRemotePath(remotePath, selectedEntry.name);

    if (!window.confirm(`确认删除远程${selectedEntry.type === 'directory' ? '目录' : '文件'}「${remoteEntryPath}」？`)) {
      return;
    }

    try {
      setFilesError('');
      await window.guiSSH?.connections.deletePath(connectionId, remoteEntryPath, selectedEntry.type);
      refreshFiles();
    } catch (error) {
      setFilesError(getErrorMessage(error));
    }
  };

  return (
    <div className="file-pane explorer-pane">
      <div className="explorer-ribbon">
        <button type="button" onClick={() => navigateToPath(getParentRemotePath(remotePath))}>上级</button>
        <button type="button" onClick={refreshFiles}>刷新</button>
        <button type="button" onClick={createDirectory}>新建文件夹</button>
        <button type="button" onClick={deleteSelectedEntry} disabled={!selectedEntry}>删除</button>
      </div>

      <form className="explorer-addressbar" onSubmit={submitRemotePath}>
        <span>路径</span>
        <input value={pathDraft} onChange={(event) => setPathDraft(event.target.value)} spellCheck={false} />
        <button type="submit">转到</button>
      </form>

      <div className="explorer-layout">
        <aside className="explorer-sidebar" aria-label="快速访问">
          <button type="button" className={remotePath === '.' ? 'active' : ''} onClick={() => navigateToPath('.')}>快速访问</button>
          <button type="button" className={remotePath === '/' ? 'active' : ''} onClick={() => navigateToPath('/')}>此电脑</button>
          <button type="button" onClick={() => navigateToPath('/home')}>Home</button>
          <button type="button" onClick={() => navigateToPath('/tmp')}>临时文件</button>
          <button type="button" onClick={() => navigateToPath('/var')}>系统目录</button>
        </aside>

        <section className="explorer-main" aria-label="远程文件列表">
          {filesError ? <div className="error-banner">{filesError}</div> : null}
          {isFilesLoading ? <div className="empty-inline">正在读取远程目录...</div> : null}

          <div className="explorer-table" role="table">
            <div className="explorer-row explorer-header" role="row">
              <span>名称</span>
              <span>修改日期</span>
              <span>类型</span>
              <span>大小</span>
            </div>
            {fileEntries.map((entry) => (
              <button
                key={`${entry.type}:${entry.name}`}
                type="button"
                className={`explorer-row ${selectedEntryName === entry.name ? 'selected' : ''}`}
                onClick={() => setSelectedEntryName(entry.name)}
                onDoubleClick={() => openFileEntry(entry)}
              >
                <span className="explorer-name-cell"><b>{getFileIcon(entry)}</b>{entry.name}</span>
                <span>{formatDateTime(entry.modifiedAt)}</span>
                <span>{getFileTypeLabel(entry)}</span>
                <span>{entry.type === 'directory' ? '' : formatBytes(entry.size)}</span>
              </button>
            ))}
          </div>

          {!isFilesLoading && !filesError && !fileEntries.length ? <div className="empty-inline">该目录为空。</div> : null}
        </section>
      </div>

      <div className="explorer-statusbar">
        <span>{fileEntries.length} 个项目</span>
        <span>{selectedEntry ? `已选择：${selectedEntry.name}` : '未选择项目'}</span>
      </div>
    </div>
  );
}

export default RemoteFileExplorer;

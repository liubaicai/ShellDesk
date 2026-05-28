import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import { formatDateTime, getErrorMessage } from './desktopUtils';
import { isWindowsSystem } from './remoteSystem';
import type { RemoteSystemType } from './types';
import {
  normalizeRemotePath,
  joinRemotePath,
  getParentRemotePath,
  isWindowsDriveRoot,
} from './RemoteFileExplorer';

interface RemoteFileEntry {
  name: string;
  longname: string;
  type: 'directory' | 'file' | 'symlink';
  targetType?: 'directory' | 'file' | 'symlink' | 'unknown';
  size: number;
  modifiedAt: string;
}

export interface RemoteFilePickerProps {
  connectionId: string;
  systemType?: RemoteSystemType;
  mode: 'open' | 'save' | 'directory';
  title: string;
  visible: boolean;
  initialPath?: string;
  confirmLabel?: string;
  onConfirm: (filePath: string) => void;
  onCancel: () => void;
}

function formatBytes(size: number) {
  if (!Number.isFinite(size) || size < 0) return '-';
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
  if (isDirectoryEntry(entry)) return '\u{1F4C1}';
  if (entry.type === 'symlink') return '\u{1F517}';
  const ext = entry.name.slice(entry.name.lastIndexOf('.') + 1).toLowerCase();
  const iconMap: Record<string, string> = {
    js: '\u{1F4DC}', ts: '\u{1F4D8}', tsx: '\u{1F4D8}', jsx: '\u{1F4DC}',
    py: '\u{1F40D}', rb: '\u{1F48E}', go: '\u{1F535}', rs: '\u{1F980}',
    java: '\u2615', c: '\u{1F527}', cpp: '\u{1F527}', h: '\u{1F527}',
    html: '\u{1F310}', css: '\u{1F3A8}', scss: '\u{1F3A8}',
    json: '\u{1F4CB}', xml: '\u{1F4CB}', yaml: '\u{1F4CB}', yml: '\u{1F4CB}',
    md: '\u{1F4DD}', txt: '\u{1F4DD}', log: '\u{1F4DD}',
    sh: '\u2699\uFE0F', bash: '\u2699\uFE0F',
    png: '\u{1F5BC}\uFE0F', jpg: '\u{1F5BC}\uFE0F', jpeg: '\u{1F5BC}\uFE0F', gif: '\u{1F5BC}\uFE0F', svg: '\u{1F5BC}\uFE0F',
    zip: '\u{1F4E6}', tar: '\u{1F4E6}', gz: '\u{1F4E6}', '7z': '\u{1F4E6}', rar: '\u{1F4E6}',
    pdf: '\u{1F4D5}', doc: '\u{1F4D8}', docx: '\u{1F4D8}',
    conf: '\u2699\uFE0F', cfg: '\u2699\uFE0F', ini: '\u2699\uFE0F', env: '\u2699\uFE0F',
    pem: '\u{1F511}', key: '\u{1F511}',
    sql: '\u{1F5C3}\uFE0F', db: '\u{1F5C3}\uFE0F', sqlite: '\u{1F5C3}\uFE0F',
  };
  return iconMap[ext] ?? '\u{1F4C4}';
}

function getEffectiveEntryType(entry: RemoteFileEntry) {
  if (entry.type !== 'symlink') {
    return entry.type;
  }

  return entry.targetType === 'directory' || entry.targetType === 'file'
    ? entry.targetType
    : 'symlink';
}

function isDirectoryEntry(entry: RemoteFileEntry) {
  return getEffectiveEntryType(entry) === 'directory';
}

export default function RemoteFilePicker({
  connectionId,
  systemType,
  mode,
  title,
  visible,
  initialPath,
  confirmLabel,
  onConfirm,
  onCancel,
}: RemoteFilePickerProps) {
  const isWindowsHost = isWindowsSystem(systemType);
  const isDirectoryMode = mode === 'directory';
  const [remotePath, setRemotePath] = useState('.');
  const [entries, setEntries] = useState<RemoteFileEntry[]>([]);
  const [selectedName, setSelectedName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [fileName, setFileName] = useState('');
  const fileNameInputRef = useRef<HTMLInputElement>(null);
  const skipNavLoadRef = useRef(false);

  const loadDirectory = useCallback(async (dirPath: string) => {
    setLoading(true);
    setError('');
    try {
      const result = await window.guiSSH!.connections.listDirectory(connectionId, dirPath);
      setRemotePath(result.path);
      setEntries(result.entries);
    } catch (err) {
      setError(getErrorMessage(err));
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [connectionId]);

  // Initial load when picker becomes visible
  useEffect(() => {
    if (!visible) return;
    const path = initialPath?.trim() || (isWindowsHost ? '/' : '/');
    setFileName('');
    setSelectedName('');
    setError('');
    skipNavLoadRef.current = true;
    void loadDirectory(path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // Navigation load — skipped for the initial open to avoid double-loading
  useEffect(() => {
    if (!visible) return;
    if (skipNavLoadRef.current) {
      skipNavLoadRef.current = false;
      return;
    }
    void loadDirectory(remotePath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remotePath]);

  const navigateTo = useCallback((dirPath: string) => {
    setSelectedName('');
    setFileName('');
    setRemotePath(dirPath);
  }, []);

  const handleNavigateUp = useCallback(() => {
    const parent = getParentRemotePath(remotePath, isWindowsHost);
    navigateTo(parent);
  }, [remotePath, isWindowsHost, navigateTo]);

  const handleEntryClick = useCallback((entry: RemoteFileEntry) => {
    if (isDirectoryMode && !isDirectoryEntry(entry)) {
      setSelectedName('');
      return;
    }

    setSelectedName(entry.name);
    if (isDirectoryEntry(entry)) {
      setFileName('');
    } else if (mode === 'open') {
      setFileName(entry.name);
    } else {
      setFileName(entry.name);
    }
  }, [isDirectoryMode, mode]);

  const handleEntryDoubleClick = useCallback((entry: RemoteFileEntry) => {
    if (isDirectoryEntry(entry)) {
      const newPath = joinRemotePath(remotePath, entry.name, isWindowsHost);
      navigateTo(newPath);
      return;
    }
    if (mode === 'open') {
      const filePath = joinRemotePath(remotePath, entry.name, isWindowsHost);
      onConfirm(filePath);
    }
  }, [remotePath, isWindowsHost, mode, navigateTo, onConfirm]);

  const handleConfirm = useCallback(() => {
    if (mode === 'save') {
      const name = fileName.trim();
      if (!name) return;
      const filePath = joinRemotePath(remotePath, name, isWindowsHost);
      onConfirm(filePath);
    } else if (mode === 'directory') {
      const selectedEntry = entries.find((entry) => entry.name === selectedName);
      const directoryPath = selectedEntry && isDirectoryEntry(selectedEntry)
        ? joinRemotePath(remotePath, selectedEntry.name, isWindowsHost)
        : remotePath;
      onConfirm(directoryPath);
    } else {
      if (!selectedName) return;
      const filePath = joinRemotePath(remotePath, selectedName, isWindowsHost);
      onConfirm(filePath);
    }
  }, [entries, mode, remotePath, isWindowsHost, fileName, selectedName, onConfirm]);

  // Sort entries: directories first, then by name
  const sortedEntries = useMemo(() => {
    return [...entries].sort((a, b) => {
      if (isDirectoryEntry(a) && !isDirectoryEntry(b)) return -1;
      if (!isDirectoryEntry(a) && isDirectoryEntry(b)) return 1;
      return a.name.localeCompare(b.name);
    });
  }, [entries]);

  // Breadcrumbs
  const breadcrumbs = useMemo(() => {
    const parts: { label: string; path: string }[] = [];
    if (isWindowsHost) {
      const driveMatch = remotePath.match(/^(\/?[a-z]:)\//i);
      if (driveMatch) {
        const drive = driveMatch[1];
        parts.push({ label: drive, path: `${drive}/` });
        const rest = remotePath.slice(driveMatch[0].length);
        if (rest) {
          const segments = rest.split('/').filter(Boolean);
          let current = `${drive}/`;
          for (const seg of segments) {
            current = `${current}${seg}/`;
            parts.push({ label: seg, path: current });
          }
        }
      } else if (remotePath === '/') {
        parts.push({ label: '计算机', path: '/' });
      } else {
        parts.push({ label: remotePath, path: remotePath });
      }
    } else {
      parts.push({ label: '根目录', path: '/' });
      if (remotePath !== '/') {
        const segments = remotePath.split('/').filter(Boolean);
        let current = '';
        for (const seg of segments) {
          current = `${current}/${seg}`;
          parts.push({ label: seg, path: current });
        }
      }
    }
    return parts;
  }, [remotePath, isWindowsHost]);

  if (!visible) return null;

  return createPortal(
    <div className="file-picker-overlay" onClick={onCancel}>
      <div className="file-picker-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="file-picker-header">
          <span className="file-picker-title">{title}</span>
          <button type="button" className="file-picker-close-btn" onClick={onCancel}>&times;</button>
        </div>

        <div className="file-picker-body">
          <div className="file-picker-addressbar">
            <button
              type="button"
              className="file-picker-nav-btn"
              onClick={handleNavigateUp}
              title="向上一级"
              disabled={loading}
            >
              ↑ 向上
            </button>
            <div className="file-picker-breadcrumbs" title={remotePath}>
              {breadcrumbs.map((crumb, idx) => (
                <span key={crumb.path}>
                  {idx > 0 && <span className="file-picker-breadcrumb-sep"> / </span>}
                  <button
                    type="button"
                    className="file-picker-breadcrumb-btn"
                    onClick={() => navigateTo(crumb.path)}
                  >
                    {crumb.label}
                  </button>
                </span>
              ))}
            </div>
          </div>

          <div className="file-picker-list">
            {loading ? (
              <div className="file-picker-status">正在加载...</div>
            ) : error ? (
              <div className="file-picker-error">{error}</div>
            ) : sortedEntries.length === 0 ? (
              <div className="file-picker-status">此文件夹为空</div>
            ) : (
              <div className="file-picker-table">
                <div className="file-picker-table-header">
                  <span className="file-picker-col-name">名称</span>
                  <span className="file-picker-col-modified">修改日期</span>
                  <span className="file-picker-col-size">大小</span>
                </div>
                {sortedEntries.map((entry) => (
                  <button
                    key={entry.name}
                    type="button"
                    className={`file-picker-row ${selectedName === entry.name ? 'selected' : ''} ${isDirectoryMode && !isDirectoryEntry(entry) ? 'disabled' : ''}`}
                    onClick={() => handleEntryClick(entry)}
                    onDoubleClick={() => handleEntryDoubleClick(entry)}
                  >
                    <span className="file-picker-col-name">
                      <span className="file-picker-icon">{getFileIcon(entry)}</span>
                      {entry.name}
                    </span>
                    <span className="file-picker-col-modified">
                      {formatDateTime(entry.modifiedAt)}
                    </span>
                    <span className="file-picker-col-size">
                      {isDirectoryEntry(entry) ? '' : formatBytes(entry.size)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {mode === 'save' && (
            <div className="file-picker-filename-bar">
              <label className="file-picker-filename-label">文件名：</label>
              <input
                ref={fileNameInputRef}
                type="text"
                className="file-picker-filename-input"
                value={fileName}
                onChange={(e) => setFileName(e.target.value)}
                placeholder="输入文件名..."
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleConfirm();
                }}
                autoFocus
              />
            </div>
          )}
        </div>

        <div className="file-picker-footer">
          <button type="button" className="file-picker-btn" onClick={onCancel}>取消</button>
          <button
            type="button"
            className="file-picker-btn file-picker-btn-primary"
            onClick={handleConfirm}
            disabled={mode === 'open' ? !selectedName : mode === 'save' ? !fileName.trim() : loading}
          >
            {confirmLabel || (mode === 'open' ? '打开' : mode === 'directory' ? '选择文件夹' : '保存')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

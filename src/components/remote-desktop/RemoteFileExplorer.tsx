import {
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type UIEvent as ReactUIEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import { t, useCurrentAppLanguage, type AppLanguage, type MessageId } from '../../i18n';
import ContextMenuIcon from './ContextMenuIcon';
import { formatDateTime, getErrorMessage, getShellDeskLocale } from './desktopUtils';
import DismissibleAlert from './DismissibleAlert';
import { isWindowsSystem, powershellCommand } from './remoteSystem';
import { isTextFile } from './RemoteNotepad';
import { clearCachedSudoPassword, getCachedSudoOptions, setCachedSudoPassword } from './sudoPrompt';
import type { RemoteSystemType } from './types';

interface RemoteFileExplorerProps {
  connectionId: string;
  systemType?: RemoteSystemType;
  initialPath?: string;
  onOpenFile?: (filePath: string) => void;
  onOpenSqliteFile?: (filePath: string) => void;
  onOpenTerminal?: (directoryPath: string) => void;
}

type RemoteFileEntryType = 'directory' | 'file' | 'symlink';
type RemoteSymlinkTargetType = RemoteFileEntryType | 'unknown';

interface RemoteFileEntry {
  name: string;
  longname: string;
  type: RemoteFileEntryType;
  targetType?: RemoteSymlinkTargetType;
  targetPath?: string;
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

interface ExplorerSudoPrompt {
  operation: string;
  target: string;
  error: string;
  password: string;
}

type ExplorerTransferTaskStatus = 'queued' | 'running' | 'success' | 'error' | 'canceled' | 'skipped';
type ExplorerTransferTaskType = 'upload' | 'download';

interface ExplorerTransferTask {
  id: string;
  type: ExplorerTransferTaskType;
  label: string;
  detail: string;
  status: ExplorerTransferTaskStatus;
  createdAt: number;
  progress?: ShellDeskTransferProgress;
  error?: string;
  remotePaths?: string[];
  downloadFilePath?: string;
  uploadItems?: ShellDeskLocalUploadItem[];
  uploadTarget?: string;
}

interface ExplorerUploadConflictDialog {
  items: ShellDeskSelectedUploadItem[];
  conflicts: Array<{
    item: ShellDeskSelectedUploadItem;
    remotePath: string;
  }>;
}

type PermissionGroupKey = 'owner' | 'group' | 'others';
type PermissionActionKey = 'read' | 'write' | 'execute';

const PERMISSION_GROUPS: Array<{
  key: PermissionGroupKey;
  labelId: MessageId;
  bits: Record<PermissionActionKey, number>;
}> = [
  { key: 'owner', labelId: 'fileExplorer.permission.owner', bits: { read: 0o400, write: 0o200, execute: 0o100 } },
  { key: 'group', labelId: 'fileExplorer.permission.group', bits: { read: 0o040, write: 0o020, execute: 0o010 } },
  { key: 'others', labelId: 'fileExplorer.permission.others', bits: { read: 0o004, write: 0o002, execute: 0o001 } },
];

const PERMISSION_ACTIONS: Array<{ key: PermissionActionKey; labelId: MessageId }> = [
  { key: 'read', labelId: 'fileExplorer.permission.read' },
  { key: 'write', labelId: 'fileExplorer.permission.write' },
  { key: 'execute', labelId: 'fileExplorer.permission.execute' },
];

const EXPLORER_HEADER_HEIGHT = 44;
const EXPLORER_ROW_HEIGHT = 42;
const EXPLORER_ROW_OVERSCAN = 12;
const DEFAULT_REMOTE_PATH = '.';
const elevationErrorPrefixes = [
  'SHELLDESK_ELEVATION_REQUIRED:',
  'SHELLDESK_ELEVATION_AUTH_FAILED:',
];

function shouldPromptForSudoPassword(error: unknown) {
  const message = getErrorMessage(error);

  if (elevationErrorPrefixes.some((prefix) => message.startsWith(prefix))) {
    return true;
  }

  return /sudo.*password|password.*sudo|a password is required|authentication failure|sorry, try again/i.test(message);
}

function getPrivilegeErrorMessage(error: unknown) {
  const message = getErrorMessage(error);
  const prefix = elevationErrorPrefixes.find((candidate) => message.startsWith(candidate));

  return prefix ? message.slice(prefix.length).trim() || message : message;
}

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

type ExplorerSidebarIconType = 'home' | 'root' | 'folder' | 'drive' | 'favorite';

function ExplorerNavIcon({ icon }: { icon: 'back' | 'forward' | 'up' | 'home' }) {
  if (icon === 'home') {
    return (
      <svg className="explorer-nav-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M4.5 10.5 12 4.25l7.5 6.25" />
        <path d="M6.75 9.75v9.75h10.5V9.75" />
      </svg>
    );
  }

  if (icon === 'up') {
    return (
      <svg className="explorer-nav-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M12 19.25V4.75" />
        <path d="m6.5 10.25 5.5-5.5 5.5 5.5" />
      </svg>
    );
  }

  const isForward = icon === 'forward';

  return (
    <svg className="explorer-nav-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d={isForward ? 'M4.75 12h14.5' : 'M19.25 12H4.75'} />
      <path d={isForward ? 'M13.75 6.5 19.25 12l-5.5 5.5' : 'M10.25 6.5 4.75 12l5.5 5.5'} />
    </svg>
  );
}

function ExplorerSearchIcon() {
  return (
    <svg className="explorer-search-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle cx="10.75" cy="10.75" r="5.75" />
      <path d="m15.25 15.25 4.25 4.25" />
    </svg>
  );
}

function ExplorerSidebarIcon({ icon }: { icon: ExplorerSidebarIconType }) {
  if (icon === 'drive') {
    return (
      <span className="sidebar-path-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" focusable="false">
          <rect x="4.75" y="5.5" width="14.5" height="13" rx="2.25" />
          <path d="M7.75 15.75h8.5" />
          <path d="M16 9.25h.01" />
        </svg>
      </span>
    );
  }

  if (icon === 'folder') {
    return (
      <span className="sidebar-path-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" focusable="false">
          <path d="M4.5 8.25h6.35l1.55 2h7.1" />
          <path d="M4.5 7.5v9.75c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2v-7c0-1.1-.9-2-2-2h-6.4L9.55 6.5H6.5c-1.1 0-2 .9-2 2Z" />
        </svg>
      </span>
    );
  }

  if (icon === 'favorite') {
    return (
      <span className="sidebar-path-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" focusable="false">
          <path d="m12 4.75 2.2 4.45 4.9.7-3.55 3.46.84 4.89L12 15.95l-4.39 2.3.84-4.89L4.9 9.9l4.9-.7L12 4.75Z" />
        </svg>
      </span>
    );
  }

  if (icon === 'root') {
    return (
      <span className="sidebar-path-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" focusable="false">
          <path d="M12 4.75v14.5" />
          <path d="M7.5 9.25 12 4.75l4.5 4.5" />
          <path d="M6 19.25h12" />
        </svg>
      </span>
    );
  }

  return (
    <span className="sidebar-path-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" focusable="false">
        <path d="M4.5 10.5 12 4.25l7.5 6.25" />
        <path d="M6.75 9.75v9.75h10.5V9.75" />
      </svg>
    </span>
  );
}

export function normalizeWindowsRemotePath(remotePath: string) {
  return remotePath.replace(/\\/g, '/');
}

export function isWindowsDriveRoot(remotePath: string) {
  return /^\/?[a-z]:\/?$/i.test(remotePath.trim());
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

function isRemoteHomeAlias(remotePath: string) {
  return remotePath === DEFAULT_REMOTE_PATH || remotePath === '~';
}

function getExplicitInitialPath(initialPath: string | undefined, isWindowsHost: boolean) {
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

function getDeleteEntryTypeLabel(entry: RemoteFileEntry, language: AppLanguage) {
  if (entry.type === 'directory') {
    return t('fileExplorer.type.directory', language);
  }

  if (entry.type === 'symlink') {
    return t('fileExplorer.type.symlink', language);
  }

  return t('fileExplorer.type.file', language);
}

function getDeleteEntriesLabel(entries: RemoteFileEntry[], language: AppLanguage) {
  const names = entries.map((entry) => entry.name).join(language === 'zh-CN' ? '\u3001' : ', ');

  return entries.length === 1
    ? t('fileExplorer.delete.single', language, { type: getDeleteEntryTypeLabel(entries[0], language), name: names })
    : t('fileExplorer.delete.multiple', language, { count: entries.length, names });
}

function getEffectiveEntryType(entry: RemoteFileEntry): RemoteFileEntryType {
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

function isFileEntry(entry: RemoteFileEntry) {
  return getEffectiveEntryType(entry) === 'file';
}

function getFileIconClass(entry: RemoteFileEntry) {
  const effectiveType = getEffectiveEntryType(entry);
  return effectiveType === 'directory' ? 'directory' : effectiveType === 'file' ? 'file' : 'symlink';
}

function getFileIcon(entry: RemoteFileEntry) {
  if (isDirectoryEntry(entry)) {
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

function getFileTypeLabel(entry: RemoteFileEntry, language: AppLanguage) {
  if (entry.type === 'symlink') {
    if (entry.targetType === 'directory') {
      return t('fileExplorer.type.symlinkDirectory', language);
    }

    if (entry.targetType === 'file') {
      return t('fileExplorer.type.symlinkFile', language);
    }

    return t('fileExplorer.type.symlink', language);
  }

  if (entry.type === 'directory') {
    return t('fileExplorer.type.folder', language);
  }

  const ext = getFileExtension(entry.name);
  return ext ? t('fileExplorer.type.extFile', language, { ext }) : t('fileExplorer.type.file', language);
}

function isHiddenEntry(entry: RemoteFileEntry) {
  return entry.name.startsWith('.') && entry.name !== '.' && entry.name !== '..';
}

function getOpenActionLabel(entry: RemoteFileEntry, language: AppLanguage) {
  if (isDirectoryEntry(entry)) {
    return t('fileExplorer.open.directory', language);
  }

  if (isFileEntry(entry) && isSqliteFile(entry.name)) {
    return t('fileExplorer.open.sqlite', language);
  }

  if (isFileEntry(entry) && isTextFile(entry.name)) {
    return t('fileExplorer.open.notepad', language);
  }

  if (entry.type === 'symlink') {
    return t('fileExplorer.open.symlink', language);
  }

  return '';
}

function formatMode(mode: number) {
  const permissionMode = mode & 0o777;
  const perms = [
    (permissionMode & 0o400) ? 'r' : '-',
    (permissionMode & 0o200) ? 'w' : '-',
    (permissionMode & 0o100) ? 'x' : '-',
    (permissionMode & 0o040) ? 'r' : '-',
    (permissionMode & 0o020) ? 'w' : '-',
    (permissionMode & 0o010) ? 'x' : '-',
    (permissionMode & 0o004) ? 'r' : '-',
    (permissionMode & 0o002) ? 'w' : '-',
    (permissionMode & 0o001) ? 'x' : '-',
  ];
  return perms.join('');
}

function formatOctalMode(mode: number) {
  return (mode & 0o777).toString(8).padStart(3, '0');
}

function parseOctalModeDraft(draft: string) {
  return /^[0-7]{3}$/.test(draft) ? Number.parseInt(draft, 8) : null;
}

function isValidFileName(name: string, isWindowsHost = false) {
  if (!name.trim()) return false;
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) return false;
  if (isWindowsHost && /[<>:"|?*]/.test(name)) return false;
  if (name === '.' || name === '..') return false;
  return name.length <= 255;
}

function isRemotePathMissingError(error: unknown) {
  const message = getErrorMessage(error);
  return /no such file|not found|cannot find|does not exist|不存在|找不到/i.test(message);
}

function splitFileNameForDuplicate(name: string) {
  const dotIndex = name.lastIndexOf('.');

  if (dotIndex <= 0) {
    return { base: name, ext: '' };
  }

  return {
    base: name.slice(0, dotIndex),
    ext: name.slice(dotIndex),
  };
}

function getUploadTaskLabel(items: ShellDeskSelectedUploadItem[], language: AppLanguage) {
  if (items.length === 1) {
    return items[0].name;
  }

  return language === 'zh-CN' ? `${items.length} 个上传项目` : `${items.length} upload items`;
}

function getDownloadTaskLabel(entries: RemoteFileEntry[], language: AppLanguage) {
  if (entries.length === 1) {
    return entries[0].name;
  }

  return language === 'zh-CN' ? `${entries.length} 个下载项目` : `${entries.length} download items`;
}

function getTransferTaskStatusLabel(status: ExplorerTransferTaskStatus, language: AppLanguage) {
  if (language !== 'zh-CN') {
    return {
      queued: 'Queued',
      running: 'Running',
      success: 'Done',
      error: 'Failed',
      canceled: 'Canceled',
      skipped: 'Skipped',
    }[status];
  }

  return {
    queued: '排队中',
    running: '传输中',
    success: '已完成',
    error: '失败',
    canceled: '已取消',
    skipped: '已跳过',
  }[status];
}

function getSortValue(entry: RemoteFileEntry, field: SortField): string | number {
  switch (field) {
    case 'name': return entry.name;
    case 'modifiedAt': return entry.modifiedAt || '';
    case 'type': return isDirectoryEntry(entry) ? 0 : entry.type === 'symlink' ? 1 : 2;
    case 'size': return isDirectoryEntry(entry) ? -1 : entry.size;
    default: return '';
  }
}

function isEditableShortcutTarget(target: EventTarget | null) {
  return target instanceof HTMLElement && Boolean(target.closest(
    'input, textarea, select, button, [contenteditable="true"], [contenteditable=""]',
  ));
}

function getTrackedTableScrollTop(scrollTop: number) {
  if (scrollTop <= EXPLORER_HEADER_HEIGHT) {
    return 0;
  }

  const visibleRowIndex = Math.floor((scrollTop - EXPLORER_HEADER_HEIGHT) / EXPLORER_ROW_HEIGHT);
  return EXPLORER_HEADER_HEIGHT + visibleRowIndex * EXPLORER_ROW_HEIGHT;
}

function RemoteFileExplorer({ connectionId, systemType, initialPath, onOpenFile, onOpenSqliteFile, onOpenTerminal }: RemoteFileExplorerProps) {
  const language = useCurrentAppLanguage();
  const isWindowsHost = isWindowsSystem(systemType);
  const initialRemotePath = getExplicitInitialPath(initialPath, isWindowsHost) || DEFAULT_REMOTE_PATH;
  const [remotePath, setRemotePath] = useState(initialRemotePath);
  const [pathDraft, setPathDraft] = useState(initialRemotePath);
  const [fileSearchQuery, setFileSearchQuery] = useState('');
  const [fileEntries, setFileEntries] = useState<RemoteFileEntry[]>([]);
  const [selectedNames, setSelectedNames] = useState<Set<string>>(new Set());
  const [filesError, setFilesError] = useState('');
  const [isFilesLoading, setIsFilesLoading] = useState(false);
  const [filesRefreshToken, setFilesRefreshToken] = useState(0);
  const [sortField, setSortField] = useState<SortField>('name');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [showHiddenEntries, setShowHiddenEntries] = useState(false);
  const [isDetailsOpen, setIsDetailsOpen] = useState(false);
  const [favoritePaths, setFavoritePaths] = useState<string[]>([]);
  const [navigationHistory, setNavigationHistory] = useState<string[]>([initialPath || '.']);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [renamingName, setRenamingName] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [isCreatingNew, setIsCreatingNew] = useState<'file' | 'folder' | null>(null);
  const [newItemDraft, setNewItemDraft] = useState('');
  const [propertiesEntry, setPropertiesEntry] = useState<RemoteFileEntry | null>(null);
  const [propertiesData, setPropertiesData] = useState<RemotePathStat | null>(null);
  const [propertiesLoading, setPropertiesLoading] = useState(false);
  const [permissionDraft, setPermissionDraft] = useState('');
  const [permissionRecursive, setPermissionRecursive] = useState(false);
  const [propertiesSaving, setPropertiesSaving] = useState(false);
  const [propertiesError, setPropertiesError] = useState('');
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const [homePath, setHomePath] = useState('');
  const [isResolvingDefaultPath, setIsResolvingDefaultPath] = useState(!getExplicitInitialPath(initialPath, isWindowsHost));
  const [lastClickedName, setLastClickedName] = useState<string | null>(null);
  const [deleteConfirmationEntries, setDeleteConfirmationEntries] = useState<RemoteFileEntry[] | null>(null);
  const [transferProgress, setTransferProgress] = useState<ShellDeskTransferProgress | null>(null);
  const [transferQueue, setTransferQueue] = useState<ExplorerTransferTask[]>([]);
  const [uploadConflictDialog, setUploadConflictDialog] = useState<ExplorerUploadConflictDialog | null>(null);
  const [tableViewport, setTableViewport] = useState({ scrollTop: 0, height: 0 });
  const [sudoPrompt, setSudoPrompt] = useState<ExplorerSudoPrompt | null>(null);

  const renameInputRef = useRef<HTMLInputElement>(null);
  const newItemInputRef = useRef<HTMLInputElement>(null);
  const sudoPasswordInputRef = useRef<HTMLInputElement>(null);
  const sudoPromptResolverRef = useRef<((password: string | null) => void) | null>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialPathRef = useRef(initialRemotePath);
  const pendingDefaultPathRef = useRef(!getExplicitInitialPath(initialPath, isWindowsHost));
  const tableScrollFrameRef = useRef<number | null>(null);
  const transferQueueRef = useRef<ExplorerTransferTask[]>([]);
  const transferProcessingRef = useRef(false);
  const activeTransferTaskIdRef = useRef<string | null>(null);

  const updateTableViewport = useCallback((table: HTMLDivElement) => {
    setTableViewport((currentViewport) => {
      const nextViewport = {
        scrollTop: getTrackedTableScrollTop(table.scrollTop),
        height: table.clientHeight,
      };

      return currentViewport.scrollTop === nextViewport.scrollTop && currentViewport.height === nextViewport.height
        ? currentViewport
        : nextViewport;
    });
  }, []);

  const scheduleTableViewportUpdate = useCallback((table: HTMLDivElement) => {
    if (tableScrollFrameRef.current !== null) {
      return;
    }

    tableScrollFrameRef.current = window.requestAnimationFrame(() => {
      tableScrollFrameRef.current = null;
      updateTableViewport(table);
    });
  }, [updateTableViewport]);

  const requestSudoPassword = useCallback((
    operation: string,
    target: string,
    error: string,
  ) => new Promise<string | null>((resolve) => {
    sudoPromptResolverRef.current?.(null);
    sudoPromptResolverRef.current = resolve;
    setSudoPrompt({
      operation,
      target,
      error,
      password: '',
    });
  }), []);

  const resolveSudoPrompt = useCallback((password: string | null) => {
    sudoPromptResolverRef.current?.(password);
    sudoPromptResolverRef.current = null;
    setSudoPrompt(null);
  }, []);

  const runWithSudoRetry = useCallback(async <T,>(
    operation: string,
    target: string,
    run: (options?: ShellDeskSudoPasswordOptions) => Promise<T>,
  ): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      if (isWindowsHost || !shouldPromptForSudoPassword(error)) {
        throw error;
      }

      let lastError = getPrivilegeErrorMessage(error);
      const cachedOptions = getCachedSudoOptions(connectionId);

      if (cachedOptions) {
        try {
          return await run(cachedOptions);
        } catch (cachedError) {
          if (!shouldPromptForSudoPassword(cachedError)) {
            throw cachedError;
          }

          clearCachedSudoPassword(connectionId);
          lastError = getPrivilegeErrorMessage(cachedError);
        }
      }

      for (;;) {
        const sudoPassword = await requestSudoPassword(operation, target, lastError);

        if (sudoPassword === null) {
          throw new Error(lastError);
        }

        try {
          const result = await run({ sudoPassword });
          setCachedSudoPassword(connectionId, sudoPassword);
          return result;
        } catch (retryError) {
          if (!shouldPromptForSudoPassword(retryError)) {
            throw retryError;
          }

          clearCachedSudoPassword(connectionId);
          lastError = getPrivilegeErrorMessage(retryError);
        }
      }
    }
  }, [connectionId, isWindowsHost, requestSudoPassword]);

  useEffect(() => {
    setPathDraft(remotePath);
  }, [remotePath]);

  useEffect(() => {
    transferQueueRef.current = transferQueue;
  }, [transferQueue]);

  useEffect(() => {
    if (sudoPrompt) {
      sudoPasswordInputRef.current?.focus();
    }
  }, [sudoPrompt?.operation, sudoPrompt?.target]);

  useEffect(() => {
    const explicitPath = getExplicitInitialPath(initialPath, isWindowsHost);

    if (explicitPath) {
      setIsResolvingDefaultPath(false);
      pendingDefaultPathRef.current = false;

      if (explicitPath === initialPathRef.current) {
        return;
      }

      initialPathRef.current = explicitPath;
      setRemotePath(explicitPath);
      setPathDraft(explicitPath);
      setNavigationHistory([explicitPath]);
      setHistoryIndex(0);
      return;
    }

    let cancelled = false;
    setIsResolvingDefaultPath(true);
    pendingDefaultPathRef.current = true;

    void (async () => {
      let resolvedPath = DEFAULT_REMOTE_PATH;

      try {
        resolvedPath = await resolveRemoteHomeDirectory(connectionId, isWindowsHost) || DEFAULT_REMOTE_PATH;
      } catch {
        resolvedPath = DEFAULT_REMOTE_PATH;
      }

      if (cancelled) {
        return;
      }

      initialPathRef.current = resolvedPath;
      if (!isRemoteHomeAlias(resolvedPath)) {
        setHomePath(resolvedPath);
      }
      setRemotePath(resolvedPath);
      setPathDraft(resolvedPath);
      setNavigationHistory([resolvedPath]);
      setHistoryIndex(0);
      setIsResolvingDefaultPath(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [connectionId, initialPath, isWindowsHost]);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      sudoPromptResolverRef.current?.(null);
      sudoPromptResolverRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!window.guiSSH?.connections) {
      setFilesError(t('fileExplorer.error.sftpUnsupported', language));
      return;
    }

    if (isResolvingDefaultPath) {
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
        const result: RemoteDirectoryResult = await runWithSudoRetry(
          t('fileExplorer.sudo.operation.list', language),
          remotePath,
          (options) => window.guiSSH!.connections.listDirectory(connectionId, remotePath, options),
        );

        if (!cancelled) {
          pendingDefaultPathRef.current = false;
          setFileEntries(result.entries);
          setRemotePath(result.path);
          setPathDraft(result.path);
          setHomePath((currentHomePath) => currentHomePath || (
            isRemoteHomeAlias(remotePath) && result.path !== remotePath
              ? result.path
              : currentHomePath
          ));
          setNavigationHistory((history) => history.map((path, index) => (
            index === historyIndex ? result.path : path
          )));
        }
      } catch (error) {
        if (!cancelled) {
          if (pendingDefaultPathRef.current && remotePath !== DEFAULT_REMOTE_PATH) {
            pendingDefaultPathRef.current = false;
            setRemotePath(DEFAULT_REMOTE_PATH);
            setPathDraft(DEFAULT_REMOTE_PATH);
            setNavigationHistory((history) => history.map((path, index) => (
              index === historyIndex ? DEFAULT_REMOTE_PATH : path
            )));
            return;
          }

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
  }, [connectionId, filesRefreshToken, historyIndex, isResolvingDefaultPath, language, remotePath, runWithSudoRetry]);

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
    const table = tableRef.current;

    if (!table) {
      return;
    }

    const updateViewport = () => updateTableViewport(table);

    updateViewport();

    if (typeof ResizeObserver === 'undefined') {
      return () => {
        if (tableScrollFrameRef.current !== null) {
          window.cancelAnimationFrame(tableScrollFrameRef.current);
          tableScrollFrameRef.current = null;
        }
      };
    }

    const resizeObserver = new ResizeObserver(updateViewport);
    resizeObserver.observe(table);

    return () => {
      resizeObserver.disconnect();
      if (tableScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(tableScrollFrameRef.current);
        tableScrollFrameRef.current = null;
      }
    };
  }, [updateTableViewport]);

  useEffect(() => {
    const table = tableRef.current;

    if (!table) {
      return;
    }

    table.scrollTop = 0;
    setTableViewport((currentViewport) => ({
      scrollTop: 0,
      height: table.clientHeight || currentViewport.height,
    }));
  }, [fileSearchQuery, remotePath, showHiddenEntries, sortDirection, sortField]);

  useEffect(() => {
    const unsubscribe = window.guiSSH?.events.onTransferProgress((payload) => {
      if (payload.connectionId && payload.connectionId !== connectionId) {
        return;
      }

      const activeTaskId = activeTransferTaskIdRef.current;

      if (!payload.clientId) {
        setTransferProgress((currentProgress) => {
          if (currentProgress?.queueId && payload.queueId && currentProgress.queueId === payload.queueId) {
            return payload;
          }

          return currentProgress;
        });
        return;
      }

      if (payload.clientId && activeTaskId && payload.clientId !== activeTaskId) {
        return;
      }

      if (!activeTaskId) {
        setTransferProgress((currentProgress) => currentProgress?.clientId === payload.clientId ? payload : currentProgress);
        return;
      }

      setTransferProgress((currentProgress) => {
        if (currentProgress?.queueId && payload.queueId && currentProgress.queueId !== payload.queueId) {
          return currentProgress;
        }

        return payload;
      });

      setTransferQueue((tasks) => tasks.map((task) => task.id === payload.clientId
        ? { ...task, progress: payload }
        : task));
    });
    const unsubEnd = window.guiSSH?.events.onTransferEnd((payload) => {
      if (payload.connectionId && payload.connectionId !== connectionId) {
        return;
      }

      const activeTaskId = activeTransferTaskIdRef.current;

      if (!payload.clientId) {
        setTransferProgress((currentProgress) => {
          if (currentProgress?.queueId && payload.queueId && currentProgress.queueId === payload.queueId) {
            return null;
          }

          return currentProgress;
        });
        return;
      }

      if (payload.clientId && activeTaskId && payload.clientId !== activeTaskId) {
        return;
      }

      setTransferProgress((currentProgress) => {
        if (payload.clientId && currentProgress?.clientId && currentProgress.clientId !== payload.clientId) {
          return currentProgress;
        }

        if (currentProgress?.queueId && payload.queueId && currentProgress.queueId !== payload.queueId) {
          return currentProgress;
        }

        return null;
      });
    });
    return () => { unsubscribe?.(); unsubEnd?.(); };
  }, [connectionId]);

  const sortCollator = useMemo(() => (
    new Intl.Collator(getShellDeskLocale(), { numeric: true, sensitivity: 'base' })
  ), []);

  const sortedEntries = useMemo(() => {
    const sorted = [...fileEntries].sort((a, b) => {
      const aVal = getSortValue(a, sortField);
      const bVal = getSortValue(b, sortField);
      let cmp = 0;

      if (typeof aVal === 'number' && typeof bVal === 'number') {
        cmp = aVal - bVal;
      } else {
        cmp = sortCollator.compare(String(aVal), String(bVal));
      }

      return sortDirection === 'asc' ? cmp : -cmp;
    });

    return sorted;
  }, [fileEntries, sortCollator, sortField, sortDirection]);

  const displayedEntries = useMemo(() => {
    const query = fileSearchQuery.trim().toLowerCase();
    if (!query && showHiddenEntries) {
      return sortedEntries;
    }

    const entries: RemoteFileEntry[] = [];

    for (const entry of sortedEntries) {
      if (!showHiddenEntries && isHiddenEntry(entry)) {
        continue;
      }

      if (query) {
        const nameMatches = entry.name.toLowerCase().includes(query);
        const typeMatches = !nameMatches && getFileTypeLabel(entry, language).toLowerCase().includes(query);

        if (!nameMatches && !typeMatches) {
          continue;
        }
      }

      entries.push(entry);
    }

    return entries;
  }, [fileSearchQuery, language, showHiddenEntries, sortedEntries]);

  const virtualEntryWindow = useMemo(() => {
    const viewportHeight = Math.max(tableViewport.height - EXPLORER_HEADER_HEIGHT, EXPLORER_ROW_HEIGHT);
    const rowCapacity = Math.max(
      1,
      Math.ceil(viewportHeight / EXPLORER_ROW_HEIGHT) + EXPLORER_ROW_OVERSCAN * 2,
    );
    const maxStartIndex = Math.max(0, displayedEntries.length - rowCapacity);
    const rawStartIndex = Math.floor(
      Math.max(0, tableViewport.scrollTop - EXPLORER_HEADER_HEIGHT) / EXPLORER_ROW_HEIGHT,
    ) - EXPLORER_ROW_OVERSCAN;
    const startIndex = Math.min(maxStartIndex, Math.max(0, rawStartIndex));
    const endIndex = Math.min(displayedEntries.length, startIndex + rowCapacity);

    return {
      entries: displayedEntries.slice(startIndex, endIndex),
      offsetY: startIndex * EXPLORER_ROW_HEIGHT,
      totalHeight: displayedEntries.length * EXPLORER_ROW_HEIGHT,
    };
  }, [displayedEntries, tableViewport]);

  const entryByName = useMemo(() => {
    const entriesByName = new Map<string, RemoteFileEntry>();

    for (const entry of sortedEntries) {
      entriesByName.set(entry.name, entry);
    }

    return entriesByName;
  }, [sortedEntries]);

  const selectedEntries = useMemo(() => {
    const entries: RemoteFileEntry[] = [];

    selectedNames.forEach((name) => {
      const entry = entryByName.get(name);

      if (entry) {
        entries.push(entry);
      }
    });

    return entries;
  }, [entryByName, selectedNames]);

  const selectedFileEntries = useMemo(
    () => selectedEntries.filter(isFileEntry),
    [selectedEntries],
  );

  const primarySelectedEntry = useMemo(() => {
    if (lastClickedName && selectedNames.has(lastClickedName)) {
      const lastClickedEntry = entryByName.get(lastClickedName);

      if (lastClickedEntry) {
        return lastClickedEntry;
      }
    }

    return selectedEntries[0] ?? null;
  }, [entryByName, lastClickedName, selectedEntries, selectedNames]);

  const selectedFilesSize = useMemo(
    () => selectedFileEntries.reduce((totalSize, entry) => totalSize + Math.max(entry.size, 0), 0),
    [selectedFileEntries],
  );

  const selectedDirectoryCount = useMemo(
    () => selectedEntries.filter(isDirectoryEntry).length,
    [selectedEntries],
  );

  const transferProgressPercent = useMemo(() => {
    if (!transferProgress) {
      return 0;
    }

    if (transferProgress.total > 0) {
      return Math.max(1, Math.min(100, Math.round((transferProgress.transferred / transferProgress.total) * 100)));
    }

    if ((transferProgress.totalItems ?? 0) > 0) {
      return Math.max(1, Math.min(100, Math.round(((transferProgress.completedItems ?? 0) / (transferProgress.totalItems ?? 1)) * 100)));
    }

    return 10;
  }, [transferProgress]);

  const transferItemLabel = transferProgress
    ? t('fileExplorer.transfer.items', language, {
        completed: transferProgress.completedItems ?? 0,
        total: transferProgress.totalItems ? t('fileExplorer.transfer.totalSuffix', language, { total: transferProgress.totalItems }) : '',
      })
    : '';

  useEffect(() => {
    if (propertiesEntry) {
      return;
    }

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
  }, [connectionId, isDetailsOpen, isWindowsHost, primarySelectedEntry, propertiesEntry, remotePath, selectedEntries.length]);

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

  const openFileEntry = useCallback(async (entry: RemoteFileEntry) => {
    const entryPath = joinRemotePath(remotePath, entry.name, isWindowsHost);
    let effectiveType = getEffectiveEntryType(entry);
    let openPath = entry.type === 'symlink' && entry.targetPath ? entry.targetPath : entryPath;

    if (entry.type === 'symlink' && effectiveType === 'symlink' && window.guiSSH?.connections) {
      try {
        const stat = await window.guiSSH.connections.statPath(connectionId, entryPath);
        const resolvedType = stat?.type === 'directory' || stat?.type === 'file' ? stat.type : null;

        if (resolvedType) {
          effectiveType = resolvedType;
          setFileEntries((entries) => entries.map((currentEntry) => (
            currentEntry.name === entry.name
              ? { ...currentEntry, targetType: resolvedType }
              : currentEntry
          )));
        }
      } catch (error) {
        setFilesError(getErrorMessage(error));
        return;
      }
    }

    if (entry.type === 'symlink' && entry.targetPath && (effectiveType === 'symlink' || effectiveType === 'directory')) {
      effectiveType = 'directory';
      openPath = entry.targetPath;
    }

    if (effectiveType === 'directory') {
      navigateToPath(openPath);
    } else if (effectiveType === 'file' && isSqliteFile(entry.name) && onOpenSqliteFile) {
      onOpenSqliteFile(openPath);
    } else if (effectiveType === 'file' && isTextFile(entry.name) && onOpenFile) {
      onOpenFile(openPath);
    }
  }, [connectionId, isWindowsHost, navigateToPath, remotePath, onOpenFile, onOpenSqliteFile]);

  const refreshFiles = useCallback(() => {
    setFilesRefreshToken((currentToken) => currentToken + 1);
  }, []);

  const updateTransferTask = useCallback((
    taskId: string,
    update: (task: ExplorerTransferTask) => ExplorerTransferTask,
  ) => {
    setTransferQueue((tasks) => {
      const nextTasks = tasks.map((task) => task.id === taskId ? update(task) : task);
      transferQueueRef.current = nextTasks;
      return nextTasks;
    });
  }, []);

  const processTransferQueue = useCallback(async () => {
    if (transferProcessingRef.current) {
      return;
    }

    transferProcessingRef.current = true;

    try {
      for (;;) {
        const task = transferQueueRef.current.find((candidate) => candidate.status === 'queued');

        if (!task) {
          break;
        }

        activeTransferTaskIdRef.current = task.id;
        updateTransferTask(task.id, (currentTask) => ({
          ...currentTask,
          status: 'running',
          error: '',
        }));

        try {
          const withTransferClientId = (options?: ShellDeskSudoPasswordOptions): ShellDeskSudoPasswordOptions => ({
            ...(options ?? {}),
            transferClientId: task.id,
          });

          if (task.type === 'upload') {
            const uploadItems = task.uploadItems ?? [];

            if (!uploadItems.length || !task.uploadTarget) {
              throw new Error(language === 'zh-CN' ? '上传任务缺少本地项目。' : 'Upload task has no local items.');
            }

            const result = await runWithSudoRetry(
              t('fileExplorer.sudo.operation.upload', language),
              task.uploadTarget,
              (options) => window.guiSSH!.connections.uploadLocalPaths(connectionId, task.uploadTarget!, uploadItems, withTransferClientId(options)),
            );

            updateTransferTask(task.id, (currentTask) => ({
              ...currentTask,
              status: result?.canceled ? 'canceled' : 'success',
              progress: currentTask.progress,
            }));

            if (!result?.canceled) {
              refreshFiles();
            }
          } else {
            const remotePaths = task.remotePaths ?? [];

            if (task.downloadFilePath) {
              const result = await runWithSudoRetry(
                t('fileExplorer.sudo.operation.download', language),
                task.downloadFilePath,
                (options) => window.guiSSH!.connections.downloadFile(connectionId, task.downloadFilePath!, withTransferClientId(options)),
              );

              updateTransferTask(task.id, (currentTask) => ({
                ...currentTask,
                status: result?.canceled ? 'canceled' : 'success',
                progress: currentTask.progress,
              }));
            } else if (remotePaths.length) {
              const result = await runWithSudoRetry(
                t('fileExplorer.sudo.operation.download', language),
                remotePath,
                (options) => window.guiSSH!.connections.downloadPaths(connectionId, remotePaths, withTransferClientId(options)),
              );

              updateTransferTask(task.id, (currentTask) => ({
                ...currentTask,
                status: result?.canceled ? 'canceled' : 'success',
                progress: currentTask.progress,
              }));
            } else {
              throw new Error(language === 'zh-CN' ? '下载任务缺少远程路径。' : 'Download task has no remote paths.');
            }
          }
        } catch (error) {
          updateTransferTask(task.id, (currentTask) => ({
            ...currentTask,
            status: 'error',
            error: getErrorMessage(error),
          }));
        } finally {
          activeTransferTaskIdRef.current = null;
          setTransferProgress(null);
        }
      }
    } finally {
      transferProcessingRef.current = false;
    }
  }, [connectionId, language, refreshFiles, remotePath, runWithSudoRetry, updateTransferTask]);

  const enqueueTransferTasks = useCallback((tasks: ExplorerTransferTask[]) => {
    if (!tasks.length) {
      return;
    }

    setTransferQueue((currentTasks) => {
      const nextTasks = [...currentTasks, ...tasks];
      transferQueueRef.current = nextTasks;
      return nextTasks;
    });

    window.setTimeout(() => {
      void processTransferQueue();
    }, 0);
  }, [processTransferQueue]);

  const retryTransferTask = useCallback((taskId: string) => {
    updateTransferTask(taskId, (task) => ({
      ...task,
      status: 'queued',
      error: '',
      progress: undefined,
    }));
    window.setTimeout(() => {
      void processTransferQueue();
    }, 0);
  }, [processTransferQueue, updateTransferTask]);

  const clearFinishedTransferTasks = useCallback(() => {
    setTransferQueue((tasks) => {
      const nextTasks = tasks.filter((task) => task.status === 'queued' || task.status === 'running');
      transferQueueRef.current = nextTasks;
      return nextTasks;
    });
  }, []);

  useEffect(() => {
    const handleRemoteFileSaved = (event: Event) => {
      const detail = (event as CustomEvent<{ connectionId?: string; filePath?: string }>).detail;

      if (detail?.connectionId === connectionId) {
        refreshFiles();
      }
    };

    window.addEventListener('shelldesk:remote-file-saved', handleRemoteFileSaved);
    return () => window.removeEventListener('shelldesk:remote-file-saved', handleRemoteFileSaved);
  }, [connectionId, refreshFiles]);

  const enqueueUploadSelection = useCallback((
    items: ShellDeskSelectedUploadItem[],
    remoteNameByPath = new Map<string, string>(),
  ) => {
    if (!items.length) {
      return;
    }

    const uploadItems = items.map((item) => ({
      path: item.path,
      remoteName: remoteNameByPath.get(item.path),
    }));
    const taskId = `upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    enqueueTransferTasks([{
      id: taskId,
      type: 'upload',
      label: getUploadTaskLabel(items, language),
      detail: remotePath,
      status: 'queued',
      createdAt: Date.now(),
      uploadItems,
      uploadTarget: remotePath,
    }]);
  }, [enqueueTransferTasks, language, remotePath]);

  const findUploadConflicts = useCallback(async (items: ShellDeskSelectedUploadItem[]) => {
    const conflicts: ExplorerUploadConflictDialog['conflicts'] = [];

    for (const item of items) {
      const targetPath = joinRemotePath(remotePath, item.name, isWindowsHost);

      try {
        await window.guiSSH!.connections.statPath(connectionId, targetPath);
        conflicts.push({ item, remotePath: targetPath });
      } catch (error) {
        if (!isRemotePathMissingError(error)) {
          throw error;
        }
      }
    }

    return conflicts;
  }, [connectionId, isWindowsHost, remotePath]);

  const prepareUploadSelection = useCallback(async (items: ShellDeskSelectedUploadItem[]) => {
    if (!items.length) {
      return;
    }

    try {
      setFilesError('');
      const conflicts = await findUploadConflicts(items);

      if (conflicts.length) {
        setUploadConflictDialog({ items, conflicts });
        return;
      }

      enqueueUploadSelection(items);
    } catch (error) {
      setFilesError(getErrorMessage(error));
    }
  }, [enqueueUploadSelection, findUploadConflicts]);

  const resolveDuplicateRemoteName = useCallback(async (name: string) => {
    const { base, ext } = splitFileNameForDuplicate(name);

    for (let index = 1; index <= 100; index += 1) {
      const candidateName = index === 1 ? `${base} copy${ext}` : `${base} copy ${index}${ext}`;
      const candidatePath = joinRemotePath(remotePath, candidateName, isWindowsHost);

      try {
        await window.guiSSH!.connections.statPath(connectionId, candidatePath);
      } catch (error) {
        if (isRemotePathMissingError(error)) {
          return candidateName;
        }

        throw error;
      }
    }

    throw new Error(language === 'zh-CN' ? `无法为 ${name} 找到可用的新名称。` : `Could not find an available name for ${name}.`);
  }, [connectionId, isWindowsHost, language, remotePath]);

  const resolveUploadConflicts = useCallback(async (strategy: 'skip' | 'replace' | 'duplicate') => {
    const dialog = uploadConflictDialog;

    if (!dialog) {
      return;
    }

    setUploadConflictDialog(null);

    try {
      if (strategy === 'replace') {
        enqueueUploadSelection(dialog.items);
        return;
      }

      const conflictPathSet = new Set(dialog.conflicts.map((conflict) => conflict.item.path));

      if (strategy === 'skip') {
        const safeItems = dialog.items.filter((item) => !conflictPathSet.has(item.path));

        if (!safeItems.length) {
          enqueueTransferTasks([{
            id: `upload-skip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            type: 'upload',
            label: getUploadTaskLabel(dialog.items, language),
            detail: remotePath,
            status: 'skipped',
            createdAt: Date.now(),
          }]);
          return;
        }

        enqueueUploadSelection(safeItems);
        return;
      }

      const remoteNameByPath = new Map<string, string>();

      for (const conflict of dialog.conflicts) {
        remoteNameByPath.set(conflict.item.path, await resolveDuplicateRemoteName(conflict.item.name));
      }

      enqueueUploadSelection(dialog.items, remoteNameByPath);
    } catch (error) {
      setFilesError(getErrorMessage(error));
    }
  }, [
    enqueueTransferTasks,
    enqueueUploadSelection,
    language,
    remotePath,
    resolveDuplicateRemoteName,
    uploadConflictDialog,
  ]);

  const handleTableScroll = useCallback((event: ReactUIEvent<HTMLDivElement>) => {
    scheduleTableViewportUpdate(event.currentTarget);
  }, [scheduleTableViewportUpdate]);

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

  const closePropertiesDialog = useCallback(() => {
    if (propertiesSaving) {
      return;
    }

    setPropertiesEntry(null);
    setPropertiesError('');
    setPermissionDraft('');
    setPermissionRecursive(false);
  }, [propertiesSaving]);

  const updatePermissionBit = useCallback((bit: number, enabled: boolean) => {
    const baseMode = parseOctalModeDraft(permissionDraft) ?? (propertiesData?.mode ?? 0);
    const nextMode = enabled ? (baseMode | bit) : (baseMode & ~bit);
    setPermissionDraft(formatOctalMode(nextMode));
  }, [permissionDraft, propertiesData]);

  const toggleExecutableDraft = useCallback((enabled: boolean) => {
    const baseMode = parseOctalModeDraft(permissionDraft) ?? (propertiesData?.mode ?? 0);
    const nextMode = enabled ? (baseMode | 0o111) : (baseMode & ~0o111);
    setPermissionDraft(formatOctalMode(nextMode));
  }, [permissionDraft, propertiesData]);

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
      let anchorIndex = -1;
      let currentIndex = -1;

      for (let index = 0; index < displayedEntries.length; index += 1) {
        const currentName = displayedEntries[index].name;

        if (currentName === lastClickedName) {
          anchorIndex = index;
        }

        if (currentName === entry.name) {
          currentIndex = index;
        }

        if (anchorIndex >= 0 && currentIndex >= 0) {
          break;
        }
      }

      if (anchorIndex >= 0 && currentIndex >= 0) {
        const start = Math.min(anchorIndex, currentIndex);
        const end = Math.max(anchorIndex, currentIndex);
        const rangeNames = new Set<string>();

        for (let index = start; index <= end; index += 1) {
          rangeNames.add(displayedEntries[index].name);
        }

        setSelectedNames(rangeNames);
      }
    } else {
      setSelectedNames(new Set([entry.name]));
    }

    setLastClickedName(entry.name);
  }, [closeContextMenu, displayedEntries, lastClickedName]);

  const handleRowDoubleClick = useCallback((entry: RemoteFileEntry) => {
    closeContextMenu();
    void openFileEntry(entry);
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
          await runWithSudoRetry(
            t('fileExplorer.sudo.operation.delete', language),
            entryPath,
            (options) => window.guiSSH!.connections.deletePath(connectionId, entryPath, entry.type, options),
          );
        } catch (error) {
          errors.push(`${entry.name}: ${getErrorMessage(error)}`);
        }
      }

      if (errors.length) {
        setFilesError(t('fileExplorer.error.deletePartial', language, { errors: errors.join('\n') }));
      }

      refreshFiles();
    } catch (error) {
      setFilesError(getErrorMessage(error));
    }
  }, [connectionId, deleteConfirmationEntries, isWindowsHost, language, remotePath, refreshFiles, runWithSudoRetry]);

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
      setFilesError(t('fileExplorer.error.invalidFileName', language));
      setRenamingName(null);
      return;
    }

    try {
      setFilesError('');
      const oldPath = joinRemotePath(remotePath, renamingName, isWindowsHost);
      const newPath = joinRemotePath(remotePath, trimmed, isWindowsHost);
      await runWithSudoRetry(
        t('fileExplorer.sudo.operation.rename', language),
        oldPath,
        (options) => window.guiSSH!.connections.renamePath(connectionId, oldPath, newPath, options),
      );
      setRenamingName(null);
      refreshFiles();
    } catch (error) {
      setFilesError(getErrorMessage(error));
      setRenamingName(null);
    }
  }, [connectionId, isWindowsHost, language, remotePath, renamingName, renameDraft, refreshFiles, runWithSudoRetry]);

  const cancelRename = useCallback(() => {
    setRenamingName(null);
  }, []);

  const startNewItem = useCallback((type: 'file' | 'folder') => {
    closeContextMenu();
    setIsCreatingNew(type);
    setNewItemDraft(type === 'file' ? t('fileExplorer.new.fileName', language) : t('fileExplorer.new.folderName', language));
  }, [closeContextMenu, language]);

  const commitNewItem = useCallback(async () => {
    if (!isCreatingNew) return;

    const trimmed = newItemDraft.trim();

    if (!trimmed) {
      setIsCreatingNew(null);
      return;
    }

    if (!isValidFileName(trimmed, isWindowsHost)) {
      setFilesError(t('fileExplorer.error.invalidName', language));
      setIsCreatingNew(null);
      return;
    }

    try {
      setFilesError('');
      if (isCreatingNew === 'folder') {
        const targetPath = joinRemotePath(remotePath, trimmed, isWindowsHost);
        await runWithSudoRetry(
          t('fileExplorer.sudo.operation.createFolder', language),
          targetPath,
          (options) => window.guiSSH!.connections.createDirectory(connectionId, targetPath, options),
        );
      } else {
        const targetPath = joinRemotePath(remotePath, trimmed, isWindowsHost);
        await runWithSudoRetry(
          t('fileExplorer.sudo.operation.createFile', language),
          targetPath,
          (options) => window.guiSSH!.connections.createFile(connectionId, targetPath, options),
        );
      }
      setIsCreatingNew(null);
      refreshFiles();
    } catch (error) {
      setFilesError(getErrorMessage(error));
      setIsCreatingNew(null);
    }
  }, [connectionId, isWindowsHost, language, remotePath, isCreatingNew, newItemDraft, refreshFiles, runWithSudoRetry]);

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
    setPropertiesError('');
    setPermissionDraft('');
    setPermissionRecursive(false);
    setPropertiesLoading(true);

    try {
      const entryPath = joinRemotePath(remotePath, entry.name, isWindowsHost);
      const stat = await runWithSudoRetry(
        t('fileExplorer.sudo.operation.properties', language),
        entryPath,
        (options) => window.guiSSH!.connections.statPath(connectionId, entryPath, options),
      );
      setPropertiesData(stat ?? null);
      setPermissionDraft(stat ? formatOctalMode(stat.mode) : '');
    } catch (error) {
      setPropertiesData(null);
      setPropertiesError(getErrorMessage(error));
    } finally {
      setPropertiesLoading(false);
    }
  }, [closeContextMenu, connectionId, isWindowsHost, language, remotePath, runWithSudoRetry]);

  const submitPropertiesPermissions = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!propertiesEntry || !propertiesData || propertiesSaving) {
      return;
    }

    const nextMode = parseOctalModeDraft(permissionDraft);

    if (nextMode === null) {
      setPropertiesError(t('fileExplorer.error.permissionMode', language));
      return;
    }

    try {
      setPropertiesSaving(true);
      setPropertiesError('');
      const entryPath = joinRemotePath(remotePath, propertiesEntry.name, isWindowsHost);
      await runWithSudoRetry(
        t('fileExplorer.sudo.operation.permissions', language),
        entryPath,
        (options) => window.guiSSH!.connections.setPathPermissions(connectionId, entryPath, {
          mode: nextMode,
          recursive: propertiesEntry.type === 'directory' && permissionRecursive,
          ...options,
        }),
      );
      const stat = await runWithSudoRetry(
        t('fileExplorer.sudo.operation.properties', language),
        entryPath,
        (options) => window.guiSSH!.connections.statPath(connectionId, entryPath, options),
      );
      setPropertiesData(stat ?? null);
      setPermissionDraft(stat ? formatOctalMode(stat.mode) : formatOctalMode(nextMode));
      setPermissionRecursive(false);
      refreshFiles();
    } catch (error) {
      setPropertiesError(getErrorMessage(error));
    } finally {
      setPropertiesSaving(false);
    }
  }, [
    connectionId,
    isWindowsHost,
    permissionDraft,
    permissionRecursive,
    propertiesData,
    propertiesEntry,
    propertiesSaving,
    refreshFiles,
    remotePath,
    language,
    runWithSudoRetry,
  ]);

  const downloadFile = useCallback(async (entry: RemoteFileEntry) => {
    closeContextMenu();
    setFilesError('');
    const entryPath = joinRemotePath(remotePath, entry.name, isWindowsHost);

    enqueueTransferTasks([{
      id: `download-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: 'download',
      label: getDownloadTaskLabel([entry], language),
      detail: entryPath,
      status: 'queued',
      createdAt: Date.now(),
      downloadFilePath: entryPath,
    }]);
  }, [closeContextMenu, enqueueTransferTasks, isWindowsHost, language, remotePath]);

  const downloadEntries = useCallback(async (entries: RemoteFileEntry[]) => {
    closeContextMenu();

    if (!entries.length) {
      return;
    }

    if (entries.length === 1 && isFileEntry(entries[0])) {
      await downloadFile(entries[0]);
      return;
    }

    setFilesError('');
    const remotePaths = entries.map((entry) => joinRemotePath(remotePath, entry.name, isWindowsHost));

    enqueueTransferTasks([{
      id: `download-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: 'download',
      label: getDownloadTaskLabel(entries, language),
      detail: remotePath,
      status: 'queued',
      createdAt: Date.now(),
      remotePaths,
    }]);
  }, [closeContextMenu, downloadFile, enqueueTransferTasks, isWindowsHost, language, remotePath]);

  const uploadFiles = useCallback(async () => {
    closeContextMenu();
    try {
      setFilesError('');
      const result = await window.guiSSH?.connections.selectUploadFiles();
      if (result && !result.canceled) {
        await prepareUploadSelection(result.items);
      }
    } catch (error) {
      setFilesError(getErrorMessage(error));
    }
  }, [closeContextMenu, prepareUploadSelection]);

  const uploadFolders = useCallback(async () => {
    closeContextMenu();
    try {
      setFilesError('');
      const result = await window.guiSSH?.connections.selectUploadFolders();
      if (result && !result.canceled) {
        await prepareUploadSelection(result.items);
      }
    } catch (error) {
      setFilesError(getErrorMessage(error));
    }
  }, [closeContextMenu, prepareUploadSelection]);

  const cancelTransfer = useCallback(async () => {
    try {
      await window.guiSSH?.connections.cancelTransfer(connectionId, transferProgress?.queueId);
    } catch { /* ignore */ }
  }, [connectionId, transferProgress?.queueId]);

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
    if (isEditableShortcutTarget(event.target)) {
      return;
    }

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
        if (target) void openFileEntry(target);
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

  const homeQuickPath = homePath || DEFAULT_REMOTE_PATH;
  const quickAccessPaths = useMemo(() => isWindowsHost
    ? [
        { label: 'Home', path: homeQuickPath, icon: 'home' as const },
        { label: t('fileExplorer.quick.root', language), path: '/', icon: 'root' as const },
        { label: 'C:/', path: 'C:/', icon: 'drive' as const },
        { label: 'C:/Users', path: 'C:/Users', icon: 'folder' as const },
        { label: 'C:/Program Files', path: 'C:/Program Files', icon: 'folder' as const },
        { label: 'C:/Windows', path: 'C:/Windows', icon: 'folder' as const },
        { label: 'C:/Temp', path: 'C:/Temp', icon: 'folder' as const },
      ]
    : [
        { label: 'Home', path: homeQuickPath, icon: 'home' as const },
        { label: t('fileExplorer.quick.root', language), path: '/', icon: 'root' as const },
        { label: '/home', path: '/home', icon: 'folder' as const },
        { label: '/tmp', path: '/tmp', icon: 'folder' as const },
        { label: '/var/log', path: '/var/log', icon: 'folder' as const },
        { label: '/etc', path: '/etc', icon: 'folder' as const },
        { label: '/opt', path: '/opt', icon: 'folder' as const },
        { label: '/usr/local', path: '/usr/local', icon: 'folder' as const },
      ], [homeQuickPath, isWindowsHost, language]);

  const isFavoritePath = favoritePaths.includes(remotePath);
  const selectedOpenActionLabel = selectedEntries.length === 1 && primarySelectedEntry
    ? getOpenActionLabel(primarySelectedEntry, language)
    : '';
  const selectedArchiveCanDecompress = selectedEntries.length === 1 &&
    primarySelectedEntry !== null &&
    isFileEntry(primarySelectedEntry) &&
    isArchiveFile(primarySelectedEntry.name) &&
    (!isWindowsHost || primarySelectedEntry.name.toLowerCase().endsWith('.zip'));
  const permissionDraftMode = parseOctalModeDraft(permissionDraft);
  const originalPermissionMode = propertiesData ? (propertiesData.mode & 0o777) : null;
  const executableDraftChecked = permissionDraftMode !== null
    ? (permissionDraftMode & 0o111) !== 0
    : Boolean(propertiesData && (propertiesData.mode & 0o111));
  const canSaveProperties = Boolean(
    propertiesEntry &&
    propertiesData &&
    permissionDraftMode !== null &&
    !propertiesSaving &&
    (permissionDraftMode !== originalPermissionMode || (propertiesEntry.type === 'directory' && permissionRecursive)),
  );

  const sortIndicator = useCallback((field: SortField) => {
    if (sortField !== field) return '';
    return sortDirection === 'asc' ? ' \u25B2' : ' \u25BC';
  }, [sortField, sortDirection]);

  return (
    <div className="file-pane explorer-pane" onKeyDown={handleKeydown} tabIndex={-1}>
      <form className="explorer-addressbar" onSubmit={submitRemotePath}>
        <div className="explorer-nav-buttons" aria-label={t('fileExplorer.nav.aria', language)}>
          <button type="button" onClick={navigateBack} disabled={historyIndex <= 0} aria-label={t('fileExplorer.nav.back', language)} title={t('fileExplorer.nav.back', language)}>
            <ExplorerNavIcon icon="back" />
          </button>
          <button type="button" onClick={navigateForward} disabled={historyIndex >= navigationHistory.length - 1} aria-label={t('fileExplorer.nav.forward', language)} title={t('fileExplorer.nav.forward', language)}>
            <ExplorerNavIcon icon="forward" />
          </button>
          <button type="button" onClick={navigateToParent} aria-label={t('fileExplorer.nav.up', language)} title={t('fileExplorer.nav.up', language)}>
            <ExplorerNavIcon icon="up" />
          </button>
          <button type="button" onClick={() => navigateToPath(homeQuickPath)} aria-label={t('fileExplorer.nav.home', language)} title="Home">
            <ExplorerNavIcon icon="home" />
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
            placeholder={isWindowsHost ? t('fileExplorer.path.placeholder.windows', language) : t('fileExplorer.path.placeholder.default', language)}
          />
          <button type="submit" className="addressbar-go-button" aria-label={t('fileExplorer.path.go', language)} title={t('fileExplorer.path.go', language)}>
            <ExplorerNavIcon icon="forward" />
          </button>
        </div>
        <label className="explorer-search">
          <ExplorerSearchIcon />
          <input
            value={fileSearchQuery}
            onChange={(event) => setFileSearchQuery(event.target.value)}
            placeholder={t('fileExplorer.search.placeholder', language)}
            spellCheck={false}
          />
        </label>
      </form>

      <div className="explorer-commandbar" aria-label={t('fileExplorer.toolbar.aria', language)}>
        <div className="explorer-command-group">
          <button type="button" onClick={refreshFiles} disabled={isFilesLoading} title={t('fileExplorer.toolbar.refreshTitle', language)}>
            {t('fileExplorer.toolbar.refresh', language)}
          </button>
          <button type="button" onClick={() => startNewItem('file')}>
            {t('fileExplorer.toolbar.newFile', language)}
          </button>
          <button type="button" onClick={() => startNewItem('folder')}>
            {t('fileExplorer.toolbar.newFolder', language)}
          </button>
          <button type="button" onClick={() => void uploadFiles()}>
            {t('fileExplorer.toolbar.upload', language)}
          </button>
          <button type="button" onClick={() => void uploadFolders()}>
            {t('fileExplorer.toolbar.uploadFolder', language)}
          </button>
          <button type="button" onClick={() => void downloadEntries(selectedEntries)} disabled={!selectedEntries.length}>
            {t('fileExplorer.toolbar.download', language)}
          </button>
        </div>
        <div className="explorer-command-group explorer-command-group-end">
          {copiedPath ? <span className="ribbon-toast">{t('fileExplorer.toolbar.copiedPath', language, { path: copiedPath })}</span> : null}
          {onOpenTerminal ? (
            <button type="button" onClick={() => onOpenTerminal(remotePath)} title={t('fileExplorer.toolbar.openTerminalTitle', language)}>
              {t('fileExplorer.toolbar.terminal', language)}
            </button>
          ) : null}
          <button type="button" className={showHiddenEntries ? 'active' : ''} aria-pressed={showHiddenEntries} onClick={() => setShowHiddenEntries((visible) => !visible)}>
            {t('fileExplorer.toolbar.hiddenItems', language)}
          </button>
          <button type="button" className={isFavoritePath ? 'active' : ''} aria-pressed={isFavoritePath} onClick={toggleFavoritePath}>
            {isFavoritePath ? t('fileExplorer.toolbar.unfavorite', language) : t('fileExplorer.toolbar.favorite', language)}
          </button>
          <button type="button" className={isDetailsOpen ? 'active' : ''} aria-pressed={isDetailsOpen} onClick={() => setIsDetailsOpen((open) => !open)}>
            {t('fileExplorer.toolbar.details', language)}
          </button>
        </div>
      </div>

      <div className={`explorer-layout ${isDetailsOpen ? 'with-details' : ''}`}>
        <aside className="explorer-sidebar" aria-label={t('fileExplorer.sidebar.aria', language)}>
          <div className="sidebar-section-title">{t('fileExplorer.sidebar.quickAccess', language)}</div>
          {quickAccessPaths.slice(0, 2).map((item) => (
            <button key={`${item.label}-${item.path}`} type="button" className={remotePath === item.path ? 'active' : ''} onClick={() => navigateToPath(item.path)}>
              <ExplorerSidebarIcon icon={item.icon} />
              <span className="sidebar-path-label">{item.label}</span>
            </button>
          ))}
          <div className="sidebar-section-title">{t('fileExplorer.sidebar.commonDirs', language)}</div>
          {quickAccessPaths.slice(2).map((item) => (
            <button key={`${item.label}-${item.path}`} type="button" className={remotePath === item.path ? 'active' : ''} onClick={() => navigateToPath(item.path)}>
              <ExplorerSidebarIcon icon={item.icon} />
              <span className="sidebar-path-label">{item.label}</span>
            </button>
          ))}
          <div className="sidebar-section-title">{t('fileExplorer.sidebar.favorites', language)}</div>
          {favoritePaths.length ? favoritePaths.map((path) => (
            <button key={path} type="button" className={remotePath === path ? 'active' : ''} onClick={() => navigateToPath(path)} title={path}>
              <ExplorerSidebarIcon icon="favorite" />
              <span className="sidebar-path-label">{path}</span>
            </button>
          )) : (
            <div className="explorer-sidebar-note">{t('fileExplorer.sidebar.noFavorites', language)}</div>
          )}
          <div className="sidebar-section-title transfer-queue-title">
            <span>{t('fileExplorer.sidebar.transfer', language)}</span>
            {transferQueue.some((task) => task.status === 'success' || task.status === 'error' || task.status === 'canceled' || task.status === 'skipped') ? (
              <button type="button" onClick={clearFinishedTransferTasks}>
                {language === 'zh-CN' ? '清理' : 'Clear'}
              </button>
            ) : null}
          </div>
          <div className={`explorer-transfer-card ${transferProgress ? 'running' : ''}`}>
            <strong>{transferProgress ? t('fileExplorer.transfer.running', language) : t('fileExplorer.transfer.idle', language)}</strong>
            <span>
              {transferProgress
                ? `${transferProgress.type === 'download' ? t('fileExplorer.transfer.download', language) : t('fileExplorer.transfer.upload', language)} ${transferItemLabel} · ${transferProgress.fileName}`
                : t('fileExplorer.transfer.empty', language)}
            </span>
          </div>
          <div className="explorer-transfer-queue" aria-label={language === 'zh-CN' ? '传输队列' : 'Transfer queue'}>
            {transferQueue.length ? transferQueue.slice(0, 8).map((task) => {
              const progress = task.progress;
              const percent = progress
                ? progress.total > 0
                  ? Math.max(1, Math.min(100, Math.round((progress.transferred / progress.total) * 100)))
                  : (progress.totalItems ?? 0) > 0
                    ? Math.max(1, Math.min(100, Math.round(((progress.completedItems ?? 0) / (progress.totalItems ?? 1)) * 100)))
                    : 10
                : task.status === 'success'
                  ? 100
                  : 0;

              return (
                <div key={task.id} className={`transfer-queue-item ${task.status}`}>
                  <div className="transfer-queue-row">
                    <strong>{task.type === 'download' ? t('fileExplorer.transfer.download', language) : t('fileExplorer.transfer.upload', language)}</strong>
                    <span>{getTransferTaskStatusLabel(task.status, language)}</span>
                  </div>
                  <div className="transfer-queue-name" title={task.label}>{task.label}</div>
                  <div className="transfer-queue-detail" title={task.error || task.detail}>{task.error || task.detail}</div>
                  <div className="transfer-queue-bar">
                    <span style={{ width: `${percent}%` }} />
                  </div>
                  {task.status === 'error' ? (
                    <button type="button" className="transfer-queue-retry" onClick={() => retryTransferTask(task.id)}>
                      {language === 'zh-CN' ? '重试' : 'Retry'}
                    </button>
                  ) : null}
                </div>
              );
            }) : (
              <div className="explorer-sidebar-note">{language === 'zh-CN' ? '上传或下载任务会显示在这里。' : 'Upload and download tasks appear here.'}</div>
            )}
          </div>
        </aside>

        <section
          className="explorer-main"
          aria-label={t('fileExplorer.list.aria', language)}
          onContextMenu={handleBackgroundContextMenu}
          onClick={(e) => {
            if (!(e.target as HTMLElement).closest('.explorer-row')) {
              setSelectedNames(new Set());
              closeContextMenu();
            }
          }}
        >
          {filesError ? (
            <DismissibleAlert className="error-banner" onDismiss={() => setFilesError('')} role="alert">
              {filesError}
            </DismissibleAlert>
          ) : null}

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

          <div className="explorer-table" role="table" aria-busy={isFilesLoading} ref={tableRef} onScroll={handleTableScroll}>
            <div className="explorer-row explorer-header" role="row">
              <button type="button" className="sort-header" onClick={() => handleSort('name')}>
                {t('fileExplorer.table.name', language)}{sortIndicator('name')}
              </button>
              <button type="button" className="sort-header" onClick={() => handleSort('modifiedAt')}>
                {t('fileExplorer.table.modifiedAt', language)}{sortIndicator('modifiedAt')}
              </button>
              <button type="button" className="sort-header" onClick={() => handleSort('type')}>
                {t('fileExplorer.table.type', language)}{sortIndicator('type')}
              </button>
              <button type="button" className="sort-header" onClick={() => handleSort('size')}>
                {t('fileExplorer.table.size', language)}{sortIndicator('size')}
              </button>
            </div>
            <div className="explorer-virtual-body" style={{ height: virtualEntryWindow.totalHeight }}>
              <div
                className="explorer-virtual-window"
                style={{ transform: `translate3d(0, ${virtualEntryWindow.offsetY}px, 0)` }}
              >
                {virtualEntryWindow.entries.map((entry) => {
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
                          <b className={`file-kind-icon ${getFileIconClass(entry)}`}>{getFileIcon(entry)}</b>
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
                          <b className={`file-kind-icon ${getFileIconClass(entry)}`}>{getFileIcon(entry)}</b>
                          {entry.name}
                        </span>
                      )}
                      <span>{formatDateTime(entry.modifiedAt)}</span>
                      <span>{getFileTypeLabel(entry, language)}</span>
                      <span>{isDirectoryEntry(entry) ? '' : formatBytes(entry.size)}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {isFilesLoading ? (
            <div className="explorer-table-loading" role="status" aria-live="polite">
              <div className="explorer-loading-card">
                <span className="explorer-loading-spinner" aria-hidden="true" />
                <strong>{t('fileExplorer.loading.directory', language)}</strong>
                <span title={remotePath}>{remotePath}</span>
              </div>
            </div>
          ) : null}

          {!isFilesLoading && !filesError && !displayedEntries.length ? (
            <div className="empty-inline">{fileEntries.length ? t('fileExplorer.empty.noMatches', language) : t('fileExplorer.empty.directory', language)}</div>
          ) : null}
        </section>

        {isDetailsOpen ? (
          <aside className="explorer-details" aria-label={t('fileExplorer.details.aria', language)}>
            <div className="explorer-details-header">
              <strong>{t('fileExplorer.details.title', language)}</strong>
              <button type="button" onClick={() => setIsDetailsOpen(false)} aria-label={t('fileExplorer.details.closeAria', language)} title={t('fileExplorer.details.closeTitle', language)}>
                ×
              </button>
            </div>

            {primarySelectedEntry && selectedEntries.length === 1 ? (
              <>
                <div className="explorer-details-hero">
                  <b className={`file-kind-icon ${getFileIconClass(primarySelectedEntry)}`}>{getFileIcon(primarySelectedEntry)}</b>
                  <div>
                    <strong>{primarySelectedEntry.name}</strong>
                    <span>{getFileTypeLabel(primarySelectedEntry, language)}</span>
                  </div>
                </div>
                <dl className="explorer-details-list">
                  <div>
                    <dt>{t('fileExplorer.details.path', language)}</dt>
                    <dd title={joinRemotePath(remotePath, primarySelectedEntry.name, isWindowsHost)}>
                      {joinRemotePath(remotePath, primarySelectedEntry.name, isWindowsHost)}
                    </dd>
                  </div>
                  <div>
                    <dt>{t('fileExplorer.details.size', language)}</dt>
                    <dd>{isDirectoryEntry(primarySelectedEntry) ? '-' : formatBytes(primarySelectedEntry.size)}</dd>
                  </div>
                  <div>
                    <dt>{t('fileExplorer.details.modifiedAt', language)}</dt>
                    <dd>{formatDateTime(primarySelectedEntry.modifiedAt)}</dd>
                  </div>
                  {propertiesLoading ? (
                    <div>
                      <dt>{t('fileExplorer.details.properties', language)}</dt>
                      <dd>{t('fileExplorer.details.reading', language)}</dd>
                    </div>
                  ) : null}
                  {propertiesData ? (
                    <>
                      <div>
                        <dt>{t('fileExplorer.details.permissions', language)}</dt>
                        <dd><code>{formatMode(propertiesData.mode)} ({formatOctalMode(propertiesData.mode)})</code></dd>
                      </div>
                      <div>
                        <dt>{t('fileExplorer.details.owner', language)}</dt>
                        <dd>UID {propertiesData.owner} / GID {propertiesData.group}</dd>
                      </div>
                      <div>
                        <dt>{t('fileExplorer.details.accessedAt', language)}</dt>
                        <dd>{formatDateTime(propertiesData.accessedAt)}</dd>
                      </div>
                    </>
                  ) : null}
                </dl>
                <div className="explorer-details-actions">
                  {selectedOpenActionLabel ? (
                    <button type="button" onClick={() => void openFileEntry(primarySelectedEntry)}>
                      {selectedOpenActionLabel}
                    </button>
                  ) : null}
                  <button type="button" onClick={() => void downloadEntries([primarySelectedEntry])}>
                    {t('fileExplorer.toolbar.download', language)}
                  </button>
                  {selectedArchiveCanDecompress ? (
                    <button type="button" onClick={() => void decompressEntry(primarySelectedEntry)}>
                      {t('fileExplorer.details.decompress', language)}
                    </button>
                  ) : null}
                  {isDirectoryEntry(primarySelectedEntry) && onOpenTerminal ? (
                    <button type="button" onClick={() => onOpenTerminal(joinRemotePath(remotePath, primarySelectedEntry.name, isWindowsHost))}>
                      {t('fileExplorer.details.openInTerminal', language)}
                    </button>
                  ) : null}
                </div>
              </>
            ) : selectedEntries.length > 1 ? (
              <div className="explorer-details-empty">
                <strong>{t('fileExplorer.details.selectedCount', language, { count: selectedEntries.length })}</strong>
                <span>
                  {selectedFileEntries.length
                    ? t('fileExplorer.details.selectionFilesFolders', language, {
                        files: selectedFileEntries.length,
                        foldersText: selectedDirectoryCount ? t('fileExplorer.details.selectionFoldersSuffix', language, { count: selectedDirectoryCount }) : '',
                        size: formatBytes(selectedFilesSize),
                      })
                    : selectedDirectoryCount
                      ? t('fileExplorer.details.selectionFoldersOnly', language, { count: selectedDirectoryCount })
                      : t('fileExplorer.details.selectionNoFiles', language)}
                </span>
              </div>
            ) : (
              <div className="explorer-details-empty">
                <strong>{t('fileExplorer.details.currentDirectory', language)}</strong>
                <span title={remotePath}>{remotePath}</span>
                <small>{showHiddenEntries ? t('fileExplorer.details.hiddenShown', language) : t('fileExplorer.details.hiddenFiltered', language)}</small>
              </div>
            )}
          </aside>
        ) : null}
      </div>

      <div className="explorer-statusbar">
        <span>{fileSearchQuery ? t('fileExplorer.itemCountFiltered', language, { visible: displayedEntries.length, total: fileEntries.length }) : t('fileExplorer.itemCount', language, { count: fileEntries.length })}</span>
        <span>
          {selectedNames.size > 0
            ? t('fileExplorer.status.selected', language, {
                count: selectedNames.size,
                name: selectedNames.size === 1
                  ? t('fileExplorer.status.selectedName', language, { name: sortedEntries.find((e) => selectedNames.has(e.name))?.name ?? '' })
                  : '',
              })
            : t('fileExplorer.status.noneSelected', language)}
        </span>
      </div>

      {transferProgress ? (
        <div className="transfer-progress">
          <div className="transfer-progress-info">
            <span className="transfer-progress-label">
              <button type="button" className="transfer-cancel-btn" onClick={() => void cancelTransfer()} title={t('fileExplorer.transfer.cancel', language)}>&times;</button>
              <span className="transfer-progress-name">
                {transferProgress.type === 'download' ? t('fileExplorer.transfer.download', language) : t('fileExplorer.transfer.upload', language)} {transferProgress.fileName}
              </span>
            </span>
            <span className="transfer-progress-meta">
              {transferItemLabel ? `${transferItemLabel} · ` : ''}
              {formatBytes(transferProgress.transferred)}
              {transferProgress.total > 0 ? ` / ${formatBytes(transferProgress.total)}` : ''}
            </span>
          </div>
          <div className="transfer-progress-bar">
            <div
              className="transfer-progress-fill"
              style={{
                width: `${transferProgressPercent}%`,
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
                {(isDirectoryEntry(contextMenu.targetEntry) || (contextMenu.targetEntry.type === 'symlink' && !isFileEntry(contextMenu.targetEntry))) && (
                  <button type="button" role="menuitem" className="context-menu-icon-button" onClick={() => { closeContextMenu(); void openFileEntry(contextMenu.targetEntry!); }}>
                    <ContextMenuIcon name="open" />
                    {t('fileExplorer.context.open', language)}
                  </button>
                )}
                {isDirectoryEntry(contextMenu.targetEntry) && onOpenTerminal ? (
                  <button type="button" role="menuitem" className="context-menu-icon-button" onClick={() => {
                    closeContextMenu();
                    onOpenTerminal(joinRemotePath(remotePath, contextMenu.targetEntry!.name, isWindowsHost));
                  }}>
                    <ContextMenuIcon name="terminal" />
                    {t('fileExplorer.details.openInTerminal', language)}
                  </button>
                ) : null}
                {isFileEntry(contextMenu.targetEntry) && isTextFile(contextMenu.targetEntry.name) && onOpenFile && (
                  <button type="button" role="menuitem" className="context-menu-icon-button" onClick={() => {
                    closeContextMenu();
                    onOpenFile(joinRemotePath(remotePath, contextMenu.targetEntry!.name, isWindowsHost));
                  }}>
                    <ContextMenuIcon name="notepad" />
                    {t('fileExplorer.open.notepad', language)}
                  </button>
                )}
                {isFileEntry(contextMenu.targetEntry) && isSqliteFile(contextMenu.targetEntry.name) && onOpenSqliteFile && (
                  <button type="button" role="menuitem" className="context-menu-icon-button" onClick={() => {
                    closeContextMenu();
                    onOpenSqliteFile(joinRemotePath(remotePath, contextMenu.targetEntry!.name, isWindowsHost));
                  }}>
                    <ContextMenuIcon name="database" />
                    {t('fileExplorer.open.sqlite', language)}
                  </button>
                )}
                <button type="button" role="menuitem" className="context-menu-icon-button" onClick={() => startRename(contextMenu.targetEntry!)}>
                  <ContextMenuIcon name="rename" />
                  {t('fileExplorer.context.rename', language)}
                </button>
                <button type="button" role="menuitem" className="context-menu-icon-button" onClick={() => copyEntryPath(contextMenu.targetEntry!)}>
                  <ContextMenuIcon name="copy" />
                  {t('fileExplorer.context.copyPath', language)}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="context-menu-icon-button"
                  onClick={() => {
                    const targets = selectedNames.has(contextMenu.targetEntry!.name) && selectedNames.size > 1
                      ? sortedEntries.filter((entry) => selectedNames.has(entry.name))
                      : [contextMenu.targetEntry!];
                    void downloadEntries(targets);
                  }}
                >
                  <ContextMenuIcon name="download" />
                  {t('fileExplorer.toolbar.download', language)}
                </button>
                {isArchiveFile(contextMenu.targetEntry.name) && isFileEntry(contextMenu.targetEntry) && (!isWindowsHost || contextMenu.targetEntry.name.toLowerCase().endsWith('.zip')) && (
                  <button type="button" role="menuitem" className="context-menu-icon-button" onClick={() => void decompressEntry(contextMenu.targetEntry!)}>
                    <ContextMenuIcon name="archive" />
                    {t('fileExplorer.details.decompress', language)}
                  </button>
                )}
                <div className="context-menu-item-has-submenu">
                  <button type="button" role="menuitem" className="context-menu-icon-button" aria-haspopup="menu">
                    <ContextMenuIcon name="archive" />
                    {t('fileExplorer.context.compressAs', language)}
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
                <button type="button" role="menuitem" className="context-menu-icon-button danger-text" onClick={() => void deleteSelectedEntries(contextMenu.targetEntry ? [contextMenu.targetEntry] : undefined)}>
                  <ContextMenuIcon name="trash" />
                  {t('fileExplorer.context.delete', language)}
                </button>
                <div className="context-menu-sep" />
                <button type="button" role="menuitem" className="context-menu-icon-button" onClick={() => void showProperties(contextMenu.targetEntry!)}>
                  <ContextMenuIcon name="info" />
                  {t('fileExplorer.context.properties', language)}
                </button>
              </>
            ) : (
              <>
                <button type="button" role="menuitem" className="context-menu-icon-button" onClick={refreshFiles}>
                  <ContextMenuIcon name="refresh" />
                  {t('fileExplorer.toolbar.refresh', language)}
                </button>
                <div className="context-menu-sep" />
                <button type="button" role="menuitem" className="context-menu-icon-button" onClick={() => startNewItem('file')}>
                  <ContextMenuIcon name="new-file" />
                  {t('fileExplorer.toolbar.newFile', language)}
                </button>
                <button type="button" role="menuitem" className="context-menu-icon-button" onClick={() => startNewItem('folder')}>
                  <ContextMenuIcon name="new-folder" />
                  {t('fileExplorer.context.newFolder', language)}
                </button>
                <div className="context-menu-sep" />
                <button type="button" role="menuitem" className="context-menu-icon-button" onClick={() => void uploadFiles()}>
                  <ContextMenuIcon name="upload" />
                  {t('fileExplorer.context.uploadFiles', language)}
                </button>
                <button type="button" role="menuitem" className="context-menu-icon-button" onClick={() => void uploadFolders()}>
                  <ContextMenuIcon name="upload" />
                  {t('fileExplorer.context.uploadFolder', language)}
                </button>
                {onOpenTerminal ? (
                  <button type="button" role="menuitem" className="context-menu-icon-button" onClick={() => { closeContextMenu(); onOpenTerminal(remotePath); }}>
                    <ContextMenuIcon name="terminal" />
                    {t('fileExplorer.details.openInTerminal', language)}
                  </button>
                ) : null}
              </>
            )}
          </div>
        </>,
        document.body,
      ) : null}

      {uploadConflictDialog ? createPortal(
        <div className="notepad-modal-overlay" role="presentation" onClick={() => setUploadConflictDialog(null)}>
          <div
            className="notepad-modal explorer-conflict-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="explorer-upload-conflict-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div id="explorer-upload-conflict-title" className="notepad-modal-title">
              {language === 'zh-CN' ? '上传冲突' : 'Upload conflicts'}
            </div>
            <div className="notepad-modal-message">
              {language === 'zh-CN'
                ? `有 ${uploadConflictDialog.conflicts.length} 个目标已存在，请选择处理方式。`
                : `${uploadConflictDialog.conflicts.length} target item(s) already exist. Choose how to continue.`}
            </div>
            <div className="explorer-conflict-list">
              {uploadConflictDialog.conflicts.slice(0, 8).map((conflict) => (
                <div key={conflict.item.path} className="explorer-conflict-row">
                  <strong>{conflict.item.name}</strong>
                  <span title={conflict.remotePath}>{conflict.remotePath}</span>
                </div>
              ))}
              {uploadConflictDialog.conflicts.length > 8 ? (
                <div className="explorer-conflict-more">
                  {language === 'zh-CN'
                    ? `另有 ${uploadConflictDialog.conflicts.length - 8} 项未显示`
                    : `${uploadConflictDialog.conflicts.length - 8} more item(s) hidden`}
                </div>
              ) : null}
            </div>
            <div className="notepad-modal-actions">
              <button type="button" className="notepad-modal-btn" onClick={() => setUploadConflictDialog(null)}>{t('common.cancel', language)}</button>
              <button type="button" className="notepad-modal-btn" onClick={() => void resolveUploadConflicts('skip')}>
                {language === 'zh-CN' ? '跳过冲突' : 'Skip'}
              </button>
              <button type="button" className="notepad-modal-btn" onClick={() => void resolveUploadConflicts('duplicate')}>
                {language === 'zh-CN' ? '重命名上传' : 'Rename'}
              </button>
              <button type="button" className="notepad-modal-btn primary" onClick={() => void resolveUploadConflicts('replace')}>
                {language === 'zh-CN' ? '覆盖' : 'Replace'}
              </button>
            </div>
          </div>
        </div>,
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
            <div id="explorer-delete-confirm-title" className="notepad-modal-title">{t('fileExplorer.delete.title', language)}</div>
            <div className="notepad-modal-message">
              {t('fileExplorer.delete.message', language, { target: getDeleteEntriesLabel(deleteConfirmationEntries, language) })}
            </div>
            <div className="notepad-modal-actions">
              <button type="button" className="notepad-modal-btn" onClick={() => setDeleteConfirmationEntries(null)}>{t('common.cancel', language)}</button>
              <button type="button" className="notepad-modal-btn danger" onClick={() => void confirmDeleteSelectedEntries()}>{t('fileExplorer.context.delete', language)}</button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}

      {sudoPrompt ? createPortal(
        <div className="notepad-modal-overlay" role="presentation" onClick={() => resolveSudoPrompt(null)}>
          <form
            className="notepad-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="explorer-sudo-title"
            onSubmit={(event) => {
              event.preventDefault();
              resolveSudoPrompt(sudoPrompt.password);
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <div id="explorer-sudo-title" className="notepad-modal-title">{t('fileExplorer.sudo.title', language)}</div>
            <div className="notepad-modal-message">
              {t('fileExplorer.sudo.message', language, {
                operation: sudoPrompt.operation,
                target: sudoPrompt.target,
              })}
            </div>
            {sudoPrompt.error ? <div className="notepad-modal-message">{sudoPrompt.error}</div> : null}
            <label className="notepad-modal-field">
              <span>{t('fileExplorer.sudo.password', language)}</span>
              <input
                ref={sudoPasswordInputRef}
                className="notepad-modal-input"
                type="password"
                value={sudoPrompt.password}
                autoComplete="current-password"
                onChange={(event) => setSudoPrompt((current) => current ? { ...current, password: event.target.value } : current)}
              />
            </label>
            <div className="notepad-modal-actions">
              <button type="button" className="notepad-modal-btn" onClick={() => resolveSudoPrompt(null)}>{t('common.cancel', language)}</button>
              <button type="submit" className="notepad-modal-btn primary">{t('fileExplorer.sudo.continue', language)}</button>
            </div>
          </form>
        </div>,
        document.body,
      ) : null}

      {propertiesEntry ? createPortal(
        <div className="notepad-modal-overlay" role="presentation" onClick={closePropertiesDialog}>
          <form
            className="properties-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="explorer-properties-title"
            onSubmit={submitPropertiesPermissions}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="properties-header">
              <strong id="explorer-properties-title">{propertiesEntry.name}</strong>
              <button type="button" onClick={closePropertiesDialog} disabled={propertiesSaving}>&times;</button>
            </div>
            <div className="properties-body">
              {propertiesLoading ? (
                <div className="properties-loading">{t('fileExplorer.properties.loading', language)}</div>
              ) : (
                <>
                  <table className="properties-table">
                    <tbody>
                      <tr><td>{t('fileExplorer.properties.name', language)}</td><td>{propertiesEntry.name}</td></tr>
                      <tr><td>{t('fileExplorer.table.type', language)}</td><td>{getFileTypeLabel(propertiesEntry, language)}</td></tr>
                      <tr><td>{t('fileExplorer.table.size', language)}</td><td>{isDirectoryEntry(propertiesEntry) ? '-' : formatBytes(propertiesEntry.size)}</td></tr>
                      <tr><td>{t('fileExplorer.details.modifiedAt', language)}</td><td>{formatDateTime(propertiesEntry.modifiedAt)}</td></tr>
                      {propertiesData ? (
                        <>
                          <tr><td>{t('fileExplorer.details.permissions', language)}</td><td><code>{formatMode(propertiesData.mode)} ({formatOctalMode(propertiesData.mode)})</code></td></tr>
                          <tr><td>{t('fileExplorer.details.owner', language)}</td><td>UID {propertiesData.owner} / GID {propertiesData.group}</td></tr>
                          <tr><td>{t('fileExplorer.details.accessedAt', language)}</td><td>{formatDateTime(propertiesData.accessedAt)}</td></tr>
                        </>
                      ) : null}
                    </tbody>
                  </table>

                  {propertiesData ? (
                    <div className="properties-permission-editor">
                      <div className="properties-section-title">{t('fileExplorer.details.permissions', language)}</div>
                      <label className="permission-mode-field">
                        <span>{t('fileExplorer.properties.octal', language)}</span>
                        <input
                          value={permissionDraft}
                          maxLength={3}
                          inputMode="numeric"
                          pattern="[0-7]{3}"
                          onChange={(event) => setPermissionDraft(event.target.value.replace(/[^0-7]/g, '').slice(0, 3))}
                          disabled={propertiesSaving}
                          spellCheck={false}
                        />
                        <code>{permissionDraftMode !== null ? formatMode(permissionDraftMode) : '---------'}</code>
                      </label>
                      <div className="permission-grid" role="group" aria-label={t('fileExplorer.properties.bitsAria', language)}>
                        <span />
                        {PERMISSION_ACTIONS.map((action) => (
                          <span key={action.key}>{t(action.labelId, language)}</span>
                        ))}
                        {PERMISSION_GROUPS.map((group) => (
                          <div className="permission-grid-row" key={group.key}>
                            <strong>{t(group.labelId, language)}</strong>
                            {PERMISSION_ACTIONS.map((action) => {
                              const bit = group.bits[action.key];
                              const checked = permissionDraftMode !== null
                                ? Boolean(permissionDraftMode & bit)
                                : Boolean(propertiesData.mode & bit);

                              return (
                                <label
                                  key={action.key}
                                  className="permission-checkbox"
                                  aria-label={`${t(group.labelId, language)} ${t(action.labelId, language)}`}
                                  title={`${t(group.labelId, language)} ${t(action.labelId, language)}`}
                                >
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    onChange={(event) => updatePermissionBit(bit, event.target.checked)}
                                    disabled={propertiesSaving}
                                  />
                                </label>
                              );
                            })}
                          </div>
                        ))}
                      </div>
                      <label className="properties-toggle-row">
                        <input
                          type="checkbox"
                          checked={executableDraftChecked}
                          onChange={(event) => toggleExecutableDraft(event.target.checked)}
                          disabled={propertiesSaving}
                        />
                        <span>{t('fileExplorer.properties.executable', language)}</span>
                      </label>
                      {propertiesEntry.type === 'directory' ? (
                        <label className="properties-toggle-row">
                          <input
                            type="checkbox"
                            checked={permissionRecursive}
                            onChange={(event) => setPermissionRecursive(event.target.checked)}
                            disabled={propertiesSaving}
                          />
                          <span>{t('fileExplorer.properties.recursive', language)}</span>
                        </label>
                      ) : null}
                    </div>
                  ) : null}
                  {propertiesError ? <div className="properties-error">{propertiesError}</div> : null}
                </>
              )}
            </div>
            <div className="properties-footer">
              <button type="button" className="properties-close-btn" onClick={closePropertiesDialog} disabled={propertiesSaving}>{t('common.cancel', language)}</button>
              <button type="submit" className="properties-save-btn" disabled={!canSaveProperties}>
                {propertiesSaving ? t('fileExplorer.properties.saving', language) : t('fileExplorer.properties.savePermissions', language)}
              </button>
            </div>
          </form>
        </div>,
        document.body,
      ) : null}

    </div>
  );
}

export default RemoteFileExplorer;

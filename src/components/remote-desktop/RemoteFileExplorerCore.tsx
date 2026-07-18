import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronRight,
  Pencil,
  Trash2,
  X,
} from 'lucide-react';

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

import { t, useCurrentAppLanguage } from '../../i18n';
import FilePermissionDialog, { formatMode, formatOctalMode, parseOctalModeDraft } from './FilePermissionDialog';
import FileExplorerContextMenu from './FileExplorerContextMenu';
import FileExplorerSidebar from './FileExplorerSidebar';
import { FileIcon } from './FileIcon';
import { formatDateTime, getErrorMessage, getShellDeskLocale } from './desktopUtils';
import DismissibleAlert from './DismissibleAlert';
import {
  createDirectoryEntriesSignature,
  FILE_EXPLORER_DIRECTORY_WATCH_INTERVAL_MS,
} from './directoryWatchUtils';
import { isWindowsSystem } from './remoteSystem';
import { isTextFile } from './textFileUtils';
import { clearCachedSudoPassword, getCachedSudoOptions, setCachedSudoPassword } from './sudoPrompt';
import {
  DEFAULT_REMOTE_PATH,
  getExplicitInitialPath,
  getParentRemotePath,
  isRemoteHomeAlias,
  joinRemotePath,
  normalizeRemotePath,
  resolveRemoteHomeDirectory,
} from './fileExplorerPaths';
import {
  getEffectiveEntryType,
  getFileIconClass,
  getFileTypeLabel,
  getOpenActionLabel,
  isArchiveFile,
  isDirectoryEntry,
  isFileEntry,
  isSqliteFile,
} from './fileExplorerIcons';
import {
  formatBytes,
  getDeleteEntriesLabel,
  getDownloadTaskLabel,
  getSortValue,
  isEditableShortcutTarget,
  isHiddenEntry,
  isValidFileName,
} from './fileExplorerUtils';
import {
  getTransferItemLabel,
  getTransferProgressPercent,
  useFileExplorerTransfers,
} from './fileExplorerTransfer';
import {
  compressEntries as compressSftpEntries,
  createDirectory,
  createFile,
  deleteEntry,
  decompressEntry as decompressSftpEntry,
  listDirectory,
  renameEntry,
  setPathPermissions,
  statPath,
} from './fileExplorerSftp';
import type {
  ContextMenuState,
  ExplorerSudoPrompt,
  RemoteDirectoryResult,
  RemoteFileEntry,
  RemoteFileExplorerProps,
  RemotePathStat,
  SortDirection,
  SortField,
} from './fileExplorerTypes';

export {
  getParentRemotePath,
  joinRemotePath,
  normalizeRemotePath,
  resolveRemoteHomeDirectory,
} from './fileExplorerPaths';

const EXPLORER_HEADER_HEIGHT = 44;
const EXPLORER_ROW_HEIGHT = 42;
const EXPLORER_ROW_OVERSCAN = 12;
const newFileEntry: RemoteFileEntry = { name: '', longname: '', type: 'file', size: 0, modifiedAt: '' };
const newFolderEntry: RemoteFileEntry = { name: '', longname: '', type: 'directory', size: 0, modifiedAt: '' };
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

function ExplorerSortIndicator({ active, direction }: { active: boolean; direction: SortDirection }) {
  const Icon = active ? (direction === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown;
  return <Icon className="sort-indicator" size={14} aria-hidden="true" focusable="false" />;
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
  const [tableViewport, setTableViewport] = useState({ scrollTop: 0, height: 0 });
  const [sudoPrompt, setSudoPrompt] = useState<ExplorerSudoPrompt | null>(null);

  const renameInputRef = useRef<HTMLInputElement>(null);
  const newItemInputRef = useRef<HTMLInputElement>(null);
  const sudoPasswordInputRef = useRef<HTMLInputElement>(null);
  const sudoPromptResolverRef = useRef<((password: string | null) => void) | null>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileEntriesSignatureRef = useRef('');
  const initialPathRef = useRef(initialRemotePath);
  const isFilesLoadingRef = useRef(false);
  const pendingDefaultPathRef = useRef(!getExplicitInitialPath(initialPath, isWindowsHost));
  const tableScrollFrameRef = useRef<number | null>(null);

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

  const refreshFiles = useCallback(() => {
    setFilesRefreshToken((currentToken) => currentToken + 1);
  }, []);

  const {
    transferProgress,
    transferQueue,
    uploadConflictDialog,
    setUploadConflictDialog,
    enqueueTransferTasks,
    retryTransferTask,
    clearFinishedTransferTasks,
    prepareUploadSelection,
    resolveUploadConflicts,
    cancelTransfer,
  } = useFileExplorerTransfers({
    connectionId,
    remotePath,
    isWindowsHost,
    language,
    runWithSudoRetry,
    refreshFiles,
    setFilesError,
  });

  useEffect(() => {
    setPathDraft(remotePath);
  }, [remotePath]);

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
    isFilesLoadingRef.current = isFilesLoading;
  }, [isFilesLoading]);

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
          (options) => listDirectory(connectionId, remotePath, options),
        );

        if (!cancelled) {
          pendingDefaultPathRef.current = false;
          fileEntriesSignatureRef.current = createDirectoryEntriesSignature(result.entries);
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

          fileEntriesSignatureRef.current = '';
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
    if (!window.guiSSH?.connections || isResolvingDefaultPath) {
      return;
    }

    let cancelled = false;
    let polling = false;

    const pollCurrentDirectory = async () => {
      if (
        cancelled
        || polling
        || isFilesLoadingRef.current
        || renamingName
        || isCreatingNew
        || document.visibilityState === 'hidden'
      ) {
        return;
      }

      polling = true;

      try {
        const result = await listDirectory(connectionId, remotePath, getCachedSudoOptions(connectionId) ?? undefined);

        if (cancelled) {
          return;
        }

        const nextSignature = createDirectoryEntriesSignature(result.entries);

        if (nextSignature === fileEntriesSignatureRef.current && result.path === remotePath) {
          return;
        }

        const nextEntryNames = new Set(result.entries.map((entry) => entry.name));
        fileEntriesSignatureRef.current = nextSignature;
        pendingDefaultPathRef.current = false;
        setFileEntries(result.entries);
        setRemotePath(result.path);
        setPathDraft(result.path);
        setSelectedNames((currentNames) => {
          const nextNames = new Set([...currentNames].filter((name) => nextEntryNames.has(name)));
          return nextNames.size === currentNames.size ? currentNames : nextNames;
        });
      } catch {
        // Polling is best effort; manual refresh keeps surfacing actionable errors.
      } finally {
        polling = false;
      }
    };

    const intervalId = window.setInterval(() => {
      void pollCurrentDirectory();
    }, FILE_EXPLORER_DIRECTORY_WATCH_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [connectionId, isCreatingNew, isResolvingDefaultPath, remotePath, renamingName]);

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

  const transferProgressPercent = getTransferProgressPercent(transferProgress);
  const transferItemLabel = getTransferItemLabel(transferProgress, language);

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
        const stat = await statPath(connectionId, entryPath);

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
        const stat = await statPath(connectionId, entryPath);
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
            (options) => deleteEntry(connectionId, entryPath, entry.type, options),
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
        (options) => renameEntry(connectionId, oldPath, newPath, options),
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
          (options) => createDirectory(connectionId, targetPath, options),
        );
      } else {
        const targetPath = joinRemotePath(remotePath, trimmed, isWindowsHost);
        await runWithSudoRetry(
          t('fileExplorer.sudo.operation.createFile', language),
          targetPath,
          (options) => createFile(connectionId, targetPath, options),
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
        (options) => statPath(connectionId, entryPath, options),
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
        (options) => setPathPermissions(connectionId, entryPath, {
          mode: nextMode,
          recursive: propertiesEntry.type === 'directory' && permissionRecursive,
          ...options,
        }),
      );
      const stat = await runWithSudoRetry(
        t('fileExplorer.sudo.operation.properties', language),
        entryPath,
        (options) => statPath(connectionId, entryPath, options),
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

  const compressEntries = useCallback(async (entries: RemoteFileEntry[], format: string) => {
    closeContextMenu();
    if (!entries.length || !window.guiSSH?.connections) return;

    try {
      setFilesError('');
      const sourcePaths = entries.map((e) => joinRemotePath(remotePath, e.name, isWindowsHost));
      const baseName = entries.length === 1 ? entries[0].name : `${entries.length}_files`;
      const ext = format === 'zip' ? '.zip' : format === 'tar' ? '.tar' : format === 'tar.gz' ? '.tar.gz' : '.7z';
      const destPath = joinRemotePath(remotePath, `${baseName}${ext}`, isWindowsHost);
      await compressSftpEntries(connectionId, sourcePaths, format, destPath);
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
      await decompressSftpEntry(connectionId, archivePath, remotePath);
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
          <div className="breadcrumb-trail path-breadcrumb">
            {breadcrumbSegments.map((segment, index) => (
              <span key={`${segment.path}-${index}`} className="breadcrumb-segment">
                {index > 0 && <ChevronRight className="breadcrumb-sep path-breadcrumb-chevron" size={14} aria-hidden="true" focusable="false" />}
                <button
                  type="button"
                  className="breadcrumb-btn path-segment"
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
        <div className="explorer-search">
          <ExplorerSearchIcon />
          <input
            value={fileSearchQuery}
            onChange={(event) => setFileSearchQuery(event.target.value)}
            placeholder={t('fileExplorer.search.placeholder', language)}
            aria-label={t('fileExplorer.search.placeholder', language)}
            spellCheck={false}
          />
          {fileSearchQuery ? (
            <button
              type="button"
              className="search-clear-button"
              onClick={() => setFileSearchQuery('')}
              aria-label={t('fileExplorer.search.clear', language)}
              title={t('fileExplorer.search.clear', language)}
            >
              <X size={14} aria-hidden="true" focusable="false" />
            </button>
          ) : null}
        </div>
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
        <FileExplorerSidebar
          currentPath={remotePath}
          quickAccessPaths={quickAccessPaths}
          favorites={favoritePaths}
          language={language}
          transferProgress={transferProgress}
          transferItemLabel={transferItemLabel}
          transferQueue={transferQueue}
          onNavigate={navigateToPath}
          onClearFinishedTransferTasks={clearFinishedTransferTasks}
          onRetryTransferTask={retryTransferTask}
        />

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
            <DismissibleAlert className="error-banner" onDismiss={() => setFilesError('')} role="alert" source="RemoteFileExplorer">
              {filesError}
            </DismissibleAlert>
          ) : null}

          {isCreatingNew ? (
            <div className="explorer-row new-item-row">
              <span className="explorer-name-cell">
                <FileIcon entry={isCreatingNew === 'folder' ? newFolderEntry : newFileEntry} size={18} className="file-icon" />
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
              <button
                type="button"
                className="sort-header"
                onClick={() => handleSort('name')}
                aria-sort={sortField === 'name' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
              >
                <span>{t('fileExplorer.table.name', language)}</span>
                <ExplorerSortIndicator active={sortField === 'name'} direction={sortDirection} />
              </button>
              <button
                type="button"
                className="sort-header column-size"
                onClick={() => handleSort('size')}
                aria-sort={sortField === 'size' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
              >
                <span>{t('fileExplorer.table.size', language)}</span>
                <ExplorerSortIndicator active={sortField === 'size'} direction={sortDirection} />
              </button>
              <button
                type="button"
                className="sort-header column-modified"
                onClick={() => handleSort('modifiedAt')}
                aria-sort={sortField === 'modifiedAt' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
              >
                <span>{t('fileExplorer.table.modifiedAt', language)}</span>
                <ExplorerSortIndicator active={sortField === 'modifiedAt'} direction={sortDirection} />
              </button>
              <button
                type="button"
                className="sort-header"
                onClick={() => handleSort('type')}
                aria-sort={sortField === 'type' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
              >
                <span>{t('fileExplorer.table.type', language)}</span>
                <ExplorerSortIndicator active={sortField === 'type'} direction={sortDirection} />
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
                      className={`explorer-row ${isDirectoryEntry(entry) ? 'directory' : ''} ${selectedNames.has(entry.name) ? 'selected' : ''}`}
                      data-testid={`explorer-row-${entry.name}`}
                      onClick={(e) => handleRowClick(entry, e)}
                      onDoubleClick={() => handleRowDoubleClick(entry)}
                      onContextMenu={(e) => handleRowContextMenu(entry, e)}
                      role="row"
                    >
                      {isRenaming ? (
                        <span className="explorer-name-cell">
                          <FileIcon entry={entry} size={18} className={`file-icon ${getFileIconClass(entry)}`} />
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
                          <FileIcon entry={entry} size={18} className={`file-icon ${getFileIconClass(entry)}`} />
                          <span className="explorer-entry-name" title={entry.name}>{entry.name}</span>
                          <span className="row-actions">
                            <button
                              type="button"
                              onClick={(event) => { event.stopPropagation(); startRename(entry); }}
                              aria-label={t('fileExplorer.context.rename', language)}
                              title={t('fileExplorer.context.rename', language)}
                            >
                              <Pencil size={14} aria-hidden="true" focusable="false" />
                            </button>
                            <button
                              type="button"
                              className="row-action-delete"
                              onClick={(event) => { event.stopPropagation(); void deleteSelectedEntries([entry]); }}
                              aria-label={t('fileExplorer.context.delete', language)}
                              title={t('fileExplorer.context.delete', language)}
                            >
                              <Trash2 size={14} aria-hidden="true" focusable="false" />
                            </button>
                          </span>
                        </span>
                      )}
                      <span className="file-size-cell">{isDirectoryEntry(entry) ? '' : formatBytes(entry.size)}</span>
                      <span className="file-modified-cell">{formatDateTime(entry.modifiedAt)}</span>
                      <span className="file-type-cell">{getFileTypeLabel(entry, language)}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {isFilesLoading ? (
            <div className="explorer-table-loading">
              <div className="explorer-skeleton-list" role="status" aria-live="polite" aria-label={t('fileExplorer.loading.directory', language)}>
                <span className="visually-hidden">{t('fileExplorer.loading.directory', language)}</span>
                {Array.from({ length: 8 }, (_, index) => (
                  <div className="skeleton-row" key={index}>
                    <span className="skeleton-icon" />
                    <span className="skeleton-bar skeleton-name" />
                    <span className="skeleton-bar skeleton-size" />
                    <span className="skeleton-bar skeleton-date" />
                    <span className="skeleton-bar skeleton-type" />
                  </div>
                ))}
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
                  <FileIcon entry={primarySelectedEntry} size={24} className={`file-icon file-icon-detail ${getFileIconClass(primarySelectedEntry)}`} />
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

      <FileExplorerContextMenu
        contextMenu={contextMenu}
        language={language}
        remotePath={remotePath}
        isWindowsHost={isWindowsHost}
        selectedNames={selectedNames}
        sortedEntries={sortedEntries}
        onOpenFileEntry={(entry) => void openFileEntry(entry)}
        onOpenFile={onOpenFile}
        onOpenSqliteFile={onOpenSqliteFile}
        onOpenTerminal={onOpenTerminal}
        onStartRename={startRename}
        onCopyEntryPath={copyEntryPath}
        onDownloadEntries={(entries) => void downloadEntries(entries)}
        onDecompressEntry={(entry) => void decompressEntry(entry)}
        onCompressEntries={(entries, format) => void compressEntries(entries, format)}
        onDeleteSelectedEntries={(entries) => void deleteSelectedEntries(entries)}
        onShowProperties={(entry) => void showProperties(entry)}
        onRefresh={refreshFiles}
        onStartNewItem={startNewItem}
        onUploadFiles={() => void uploadFiles()}
        onUploadFolders={() => void uploadFolders()}
        onClose={closeContextMenu}
      />

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
            data-testid="explorer-delete-confirm-dialog"
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
            data-testid="explorer-sudo-dialog"
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
                data-testid="explorer-sudo-password"
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

      {propertiesEntry ? (
        <FilePermissionDialog
          entry={propertiesEntry}
          data={propertiesData}
          draft={permissionDraft}
          recursive={permissionRecursive}
          loading={propertiesLoading}
          saving={propertiesSaving}
          error={propertiesError}
          language={language}
          canSave={canSaveProperties}
          onClose={closePropertiesDialog}
          onDraftChange={setPermissionDraft}
          onRecursiveChange={setPermissionRecursive}
          onPermissionBitChange={updatePermissionBit}
          onExecutableChange={toggleExecutableDraft}
          onSubmit={submitPropertiesPermissions}
        />
      ) : null}

    </div>
  );
}

export default RemoteFileExplorer;

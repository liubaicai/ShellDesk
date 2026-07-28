import { type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import type { RemoteProcessManagerLaunchOptions } from './components/remote-desktop/RemoteProcessManager';
import type {
  RemoteTerminalChromePayload,
  RemoteTerminalCommandRequest,
  RemoteTerminalLaunchOptions,
  RemoteTerminalSessionEvent,
  RemoteTerminalSessionState,
  RemoteTerminalToolAction,
  RemoteTerminalToolRequest,
} from './components/remote-desktop/RemoteTerminal';
import type { SettingsTab } from './components/remote-desktop/settingsTypes';
import { getRemoteConnectionProfileHostId } from './components/remote-desktop/remoteConnectionProfiles';
import { getErrorMessage } from './components/remote-desktop/desktopUtils';
import { loadDesktopWallpaperPresetUrl } from './assets/desktopWallpapers';
import ContextMenuIcon from './components/remote-desktop/ContextMenuIcon';
import RemoteDesktopWindow from './components/remote-desktop/RemoteDesktopWindow';
import {
  addAppToFolder,
  acknowledgeDesktopAppCatalog,
  areRemoteDesktopLayoutsEqual,
  createUniqueFolderName,
  desktopAppGroupByKey,
  desktopApps,
  desktopSortOptions,
  getAppDescription,
  getAppCapability,
  getAppGroupLabel,
  getAppInfo,
  getAppLabel,
  getLayoutItemLabel,
  getSortedDesktopItems,
  hasDesktopApp,
  isDesktopAppKey,
  launchpadAnimationMs,
  markDesktopAppRemoved,
  moveAppToDesktop,
  moveTopLevelItem,
  normalizeDockPinnedApps,
  normalizeFolderName,
  normalizeRemoteDesktopLayout,
  readRemoteDesktopLayoutShadow,
  removeAppFromDesktopLayout,
  shouldPreserveCurrentDesktopLayout,
  storeRemoteDesktopLayoutShadow,
  type DesktopAppKey,
  type DesktopFolderLayoutItem,
  type DesktopLayoutItem,
} from './remoteDesktopCatalog';
import type { DesktopAppAvailabilityStatus } from './features/remote-desktop/desktopCapabilities';
import {
  focusFirstElement,
  handleModalKeyboardNavigation,
  handleRovingKeyboardNavigation,
  initializeRovingFocus,
} from './features/remote-desktop/desktopKeyboardNavigation';
import { useDesktopCapabilities } from './features/remote-desktop/useDesktopCapabilities';
import {
  RemoteAiChat,
  RemoteApacheManager,
  RemoteApiDebugger,
  RemoteBackupManager,
  RemoteBrowser,
  RemoteCaddyManager,
  RemoteCertManager,
  RemoteClickHouse,
  RemoteCodeEditor,
  RemoteContainerManager,
  RemoteDiskAnalyzer,
  RemoteDiskManager,
  RemoteFileExplorer,
  RemoteFirewallManager,
  RemoteFrpManager,
  RemoteFrpsManager,
  RemoteGitManager,
  RemoteIptablesManager,
  RemoteK8sManager,
  RemoteLogViewer,
  RemoteMessageQueuePanel,
  RemoteMonitor,
  RemoteMongo,
  RemoteMySQL,
  RemoteNetworkDiagnostics,
  RemoteNginxManager,
  RemoteNotepad,
  RemotePackageManager,
  RemotePortManager,
  RemotePostgres,
  RemoteProcessManager,
  RemoteRdpViewer,
  RemoteRedis,
  RemoteS3Browser,
  RemoteScheduledTasks,
  RemoteSearchCluster,
  RemoteSecurityAudit,
  RemoteServiceManager,
  RemoteSettings,
  RemoteSqlite,
  RemoteSupervisorManager,
  RemoteTerminal,
  RemoteVirtualMachineManager,
  RemoteVncViewer,
} from './features/remote-desktop/desktopAppLoaders';
import { AllAppsIcon, DesktopAppIcon } from './components/remote-desktop/RemoteDesktopAppIcon';
import {
  applyWindowFrameToElement,
  areWindowFramesEqual,
  clampWindowFrame,
  createDesktopWindow,
  createTmuxAvailabilityCommand,
  createTmuxLaunchOptions,
  createTmuxListCommand,
  createTmuxSessionName,
  createWallpaperObjectUrl,
  defaultTmuxSessionName,
  defaultWindowFrames,
  type DesktopAppContextMenuState,
  type DesktopConnectionGateState,
  type DesktopDragPayload,
  type DesktopFolderContextMenuState,
  type DesktopPointerDragPreviewState,
  type DesktopPointerDragSession,
  type DesktopSurfaceContextMenuState,
  type DesktopWindowInteractionMode,
  type DesktopWindowPointerState,
  type DesktopWindowState,
  type DesktopWindowTitlebarClickState,
  type FolderRenameDialogState,
  getDesktopWallpaperStyle,
  getMaximizedWindowFrame,
  getTerminalSnippetGroups,
  getTerminalSnippetPreview,
  getTopDesktopWindow,
  hasCustomDesktopWallpaper,
  hasTerminalLaunchOverrides,
  parseTmuxLaunchCommand,
  parseTmuxSessions,
  preventDesktopOpenSelection,
  quotePosixShellArg,
  type RemoteDesktopProps,
  type TerminalTitlebarMenuState,
  titlebarDoubleClickDelayMs,
  titlebarDoubleClickDistance,
  type TmuxMenuState,
} from './remoteDesktopWindowModel';
import { getAppLocale, t } from './i18n';
import { DesktopLaunchpad } from './components/remote-desktop/DesktopLaunchpad';

function RemoteDesktopShell({ connection, settings, onSettingsChange, onTerminalSessionEvent, initialAppKey }: RemoteDesktopProps) {
  const desktopSurfaceRef = useRef<HTMLElement | null>(null);
  const windowPointerStateRef = useRef<DesktopWindowPointerState | null>(null);
  const titlebarClickStateRef = useRef<DesktopWindowTitlebarClickState | null>(null);
  const desktopPointerDragSessionRef = useRef<DesktopPointerDragSession | null>(null);
  const suppressNextPointerClickRef = useRef(false);
  const windowSequenceRef = useRef(0);
  const terminalToolRequestSequenceRef = useRef(0);
  const terminalCommandRequestSequenceRef = useRef(0);
  const tmuxRefreshRequestRef = useRef(0);
  const connectionCheckSequenceRef = useRef(0);
  const zIndexRef = useRef(0);
  const openedInitialAppRef = useRef('');
  const openDesktopWindowRef = useRef<(appKey: DesktopAppKey) => boolean>(() => false);
  const launchpadCloseTimerRef = useRef<number | null>(null);
  const folderCloseTimerRef = useRef<number | null>(null);
  const launchpadButtonRef = useRef<HTMLButtonElement | null>(null);
  const folderPanelRef = useRef<HTMLElement | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const capabilityDialogRef = useRef<HTMLElement | null>(null);
  const capabilityPreviousFocusRef = useRef<HTMLElement | null>(null);
  const contextMenuPreviousFocusRef = useRef<HTMLElement | null>(null);
  const wasContextMenuOpenRef = useRef(false);
  const renameDialogRef = useRef<HTMLFormElement | null>(null);
  const [desktopWindows, setDesktopWindows] = useState<DesktopWindowState[]>([]);
  const desktopWindowsRef = useRef(desktopWindows);
  const [desktopLayout, setDesktopLayout] = useState<ShellDeskRemoteDesktopLayout>(() => {
    const normalizedLayout = normalizeRemoteDesktopLayout(settings.remoteDesktopLayout);
    const layoutShadow = readRemoteDesktopLayoutShadow();

    return layoutShadow && shouldPreserveCurrentDesktopLayout(layoutShadow, normalizedLayout)
      ? layoutShadow
      : normalizedLayout;
  });
  const desktopLayoutRef = useRef(desktopLayout);
  const [focusedWindowId, setFocusedWindowId] = useState('');
  const [isLaunchpadOpen, setIsLaunchpadOpen] = useState(false);
  const [isLaunchpadRendered, setIsLaunchpadRendered] = useState(false);
  const [launchpadSearch, setLaunchpadSearch] = useState('');
  const [launchpadCapabilityFilter, setLaunchpadCapabilityFilter] = useState<'all' | DesktopAppAvailabilityStatus>('all');
  const [capabilityNoticeAppKey, setCapabilityNoticeAppKey] = useState<DesktopAppKey | null>(null);
  const [appContextMenu, setAppContextMenu] = useState<DesktopAppContextMenuState | null>(null);
  const [folderContextMenu, setFolderContextMenu] = useState<DesktopFolderContextMenuState | null>(null);
  const [surfaceContextMenu, setSurfaceContextMenu] = useState<DesktopSurfaceContextMenuState | null>(null);
  const [openFolderId, setOpenFolderId] = useState('');
  const [focusedFolderAppKey, setFocusedFolderAppKey] = useState<DesktopAppKey | null>(null);
  const [isFolderOpen, setIsFolderOpen] = useState(false);
  const [renameFolderDialog, setRenameFolderDialog] = useState<FolderRenameDialogState | null>(null);
  const [desktopPointerDragPreview, setDesktopPointerDragPreview] = useState<DesktopPointerDragPreviewState | null>(null);
  const [terminalTitlebarMenu, setTerminalTitlebarMenu] = useState<TerminalTitlebarMenuState | null>(null);
  const [tmuxMenuState, setTmuxMenuState] = useState<TmuxMenuState>({ status: 'idle', sessions: [] });
  const [pendingCloseWindowId, setPendingCloseWindowId] = useState('');
  const [connectionGate, setConnectionGate] = useState<DesktopConnectionGateState>(() => (
    connection.kind === 'local'
      ? { status: 'ready', message: '' }
      : { status: 'checking', message: t('desktop.connection.checking', settings.language) }
  ));
  const [presetWallpaperUrl, setPresetWallpaperUrl] = useState('');
  const [customWallpaperUrl, setCustomWallpaperUrl] = useState('');
  const { snapshot: desktopCapabilitySnapshot, refresh: refreshDesktopCapabilities } = useDesktopCapabilities(
    connection.id,
    connection.host.systemType,
    connectionGate.status === 'ready',
  );
  const focusedWindow = desktopWindows.find((desktopWindow) => desktopWindow.id === focusedWindowId && !desktopWindow.isMinimized) ?? null;
  const terminalTitlebarMenuWindow = desktopWindows.find((desktopWindow) => desktopWindow.id === terminalTitlebarMenu?.windowId && desktopWindow.appKey === 'terminal') ?? null;
  const pendingCloseWindow = desktopWindows.find((desktopWindow) => desktopWindow.id === pendingCloseWindowId) ?? null;
  const desktopWallpaperStyle = getDesktopWallpaperStyle(settings, presetWallpaperUrl, customWallpaperUrl);
  const hasCustomWallpaper = hasCustomDesktopWallpaper(settings);
  const dockPosition = settings.remoteDesktopDockPosition;
  const dockSize = settings.remoteDesktopDockSize;
  const dockAutoHide = settings.remoteDesktopDockAutoHide;
  const hasMaximizedDesktopWindow = desktopWindows.some((desktopWindow) => desktopWindow.isMaximized && !desktopWindow.isMinimized);
  const shouldReserveDockSpace = (isMaximized: boolean) => (
    dockAutoHide === 'never' || (dockAutoHide === 'maximized' && !isMaximized)
  );
  const remoteConnectionProfileHostId = getRemoteConnectionProfileHostId(connection);
  const visibleDesktopItems = getSortedDesktopItems(desktopLayout, settings.language);
  const openFolder = desktopLayout.items.find((item): item is DesktopFolderLayoutItem => item.type === 'folder' && item.id === openFolderId) ?? null;
  const appLocale = getAppLocale(settings.language);
  const isConnectionGateBlocking = connectionGate.status !== 'ready';
  const connectionEndpointLabel = connection.kind === 'local'
    ? t('app.connection.localBadge', settings.language)
    : `${connection.host.username ? `${connection.host.username}@` : ''}${connection.host.address}:${connection.host.port}`;
  const launchpadSearchTerm = launchpadSearch.trim().toLocaleLowerCase(appLocale);
  const launchpadApps = [...desktopApps]
    .filter((app) => {
      const availability = desktopCapabilitySnapshot[app.key];
      if (
        launchpadCapabilityFilter !== 'all'
        && availability.status !== launchpadCapabilityFilter
        && !(launchpadCapabilityFilter === 'unknown' && availability.status === 'checking')
      ) {
        return false;
      }

      if (!launchpadSearchTerm) return true;
      const appGroup = desktopAppGroupByKey.get(app.group);
      const searchTarget = [
        app.key,
        getAppLabel(app, settings.language),
        getAppDescription(app, settings.language),
        appGroup ? getAppGroupLabel(appGroup, settings.language) : '',
      ].join(' ').toLocaleLowerCase(appLocale);
      return searchTarget.includes(launchpadSearchTerm);
    })
    .sort((firstApp, secondApp) => (
      getAppLabel(firstApp, settings.language).localeCompare(getAppLabel(secondApp, settings.language), appLocale)
    ));
  const dismissDesktopChromeForConnectionGate = useCallback(() => {
    if (launchpadCloseTimerRef.current !== null) {
      window.clearTimeout(launchpadCloseTimerRef.current);
      launchpadCloseTimerRef.current = null;
    }

    if (folderCloseTimerRef.current !== null) {
      window.clearTimeout(folderCloseTimerRef.current);
      folderCloseTimerRef.current = null;
    }

    setAppContextMenu(null);
    setFolderContextMenu(null);
    setSurfaceContextMenu(null);
    setTerminalTitlebarMenu(null);
    setRenameFolderDialog(null);
    setPendingCloseWindowId('');
    setIsLaunchpadOpen(false);
    setIsLaunchpadRendered(false);
    setOpenFolderId('');
    setIsFolderOpen(false);
  }, []);

  const checkDesktopConnection = useCallback(async () => {
    const requestId = connectionCheckSequenceRef.current + 1;
    connectionCheckSequenceRef.current = requestId;

    if (connection.kind === 'local') {
      setConnectionGate({ status: 'ready', message: '' });
      return;
    }

    const connections = window.guiSSH?.connections;

    setConnectionGate({ status: 'checking', message: t('desktop.connection.checking', settings.language) });
    dismissDesktopChromeForConnectionGate();

    if (!connections?.getStatus) {
      setConnectionGate({
        status: 'blocked',
        message: t('desktop.connection.unsupported', settings.language),
      });
      return;
    }

    try {
      await connections.getStatus(connection.id);

      if (connectionCheckSequenceRef.current === requestId) {
        setConnectionGate({ status: 'ready', message: '' });
      }
    } catch (error) {
      if (connectionCheckSequenceRef.current === requestId) {
        setConnectionGate({
          status: 'blocked',
          message: getErrorMessage(error),
        });
      }
    }
  }, [connection.id, connection.kind, dismissDesktopChromeForConnectionGate, settings.language]);

  const closeRemoteDesktop = useCallback(() => {
    dismissDesktopChromeForConnectionGate();
    const disconnectPromise = window.guiSSH?.connections?.disconnect?.(connection.id) ?? Promise.resolve(false);

    void disconnectPromise
      .catch(() => undefined)
      .finally(() => {
        void window.guiSSH?.window?.close();
      });
  }, [connection.id, dismissDesktopChromeForConnectionGate]);

  useEffect(() => {
    desktopWindowsRef.current = desktopWindows;
  }, [desktopWindows]);

  useEffect(() => {
    void checkDesktopConnection();
  }, [checkDesktopConnection]);

  useEffect(() => {
    if (!window.guiSSH?.events || connection.kind === 'local') {
      return undefined;
    }

    const removeClosed = window.guiSSH.events.onConnectionClosed((payload) => {
      if (payload.connectionId !== connection.id) {
        return;
      }

      connectionCheckSequenceRef.current += 1;
      dismissDesktopChromeForConnectionGate();
      setConnectionGate({
        status: 'blocked',
        message: payload.reason || t('desktop.connection.closed', settings.language),
      });
    });
    const removeReconnecting = window.guiSSH.events.onConnectionReconnecting((payload) => {
      if (payload.connectionId !== connection.id) {
        return;
      }

      dismissDesktopChromeForConnectionGate();
      setConnectionGate({
        status: 'checking',
        message: payload.reason || t('desktop.connection.reconnecting', settings.language),
      });
    });
    const removeRestored = window.guiSSH.events.onConnectionRestored((payload) => {
      if (payload.connectionId !== connection.id) {
        return;
      }

      connectionCheckSequenceRef.current += 1;
      setConnectionGate({ status: 'ready', message: '' });
    });

    return () => {
      removeClosed();
      removeReconnecting();
      removeRestored();
    };
  }, [connection.id, connection.kind, dismissDesktopChromeForConnectionGate, settings.language]);

  useEffect(() => {
    const logContext = {
      hostId: connection.host.id || connection.id,
      hostName: connection.host.name || connection.host.systemName || connection.host.address,
      hostAddress: connection.host.address,
    };

    window.__shellDeskLogContext = logContext;

    return () => {
      if (window.__shellDeskLogContext === logContext) {
        delete window.__shellDeskLogContext;
      }
    };
  }, [connection.id, connection.host.address, connection.host.id, connection.host.name, connection.host.systemName]);

  useEffect(() => {
    const normalizedLayout = normalizeRemoteDesktopLayout(settings.remoteDesktopLayout);
    const layoutShadow = readRemoteDesktopLayoutShadow();
    const currentLayout = desktopLayoutRef.current;
    const shouldUseLayoutShadow = Boolean(layoutShadow && shouldPreserveCurrentDesktopLayout(layoutShadow, normalizedLayout));
    const nextLayout = shouldUseLayoutShadow && layoutShadow
      ? layoutShadow
      : normalizedLayout;

    if (areRemoteDesktopLayoutsEqual(currentLayout, nextLayout)) {
      return;
    }

    if (!shouldUseLayoutShadow && shouldPreserveCurrentDesktopLayout(currentLayout, nextLayout)) {
      return;
    }

    desktopLayoutRef.current = nextLayout;
    setDesktopLayout(nextLayout);
  }, [settings.remoteDesktopLayout]);

  useEffect(() => {
    desktopLayoutRef.current = desktopLayout;
  }, [desktopLayout]);

  useEffect(() => {
    if (!hasCustomDesktopWallpaper(settings)) {
      setCustomWallpaperUrl('');
      return undefined;
    }

    let objectUrl = '';

    try {
      objectUrl = createWallpaperObjectUrl(settings.desktopWallpaperDataUrl);
      setCustomWallpaperUrl(objectUrl);
    } catch {
      setCustomWallpaperUrl('');
    }

    return () => {
      if (objectUrl) {
        window.URL.revokeObjectURL(objectUrl);
      }
    };
  }, [settings.desktopWallpaperMode, settings.desktopWallpaperDataUrl]);

  useEffect(() => {
    if (hasCustomDesktopWallpaper(settings)) {
      setPresetWallpaperUrl('');
      return undefined;
    }

    let isCurrent = true;
    loadDesktopWallpaperPresetUrl(settings.desktopWallpaperPresetId)
      .then((url) => {
        if (isCurrent) {
          setPresetWallpaperUrl(url);
        }
      })
      .catch(() => {
        if (isCurrent) {
          setPresetWallpaperUrl('');
        }
      });

    return () => {
      isCurrent = false;
    };
  }, [settings.desktopWallpaperMode, settings.desktopWallpaperPresetId, settings.desktopWallpaperDataUrl]);

  useEffect(() => () => {
    if (launchpadCloseTimerRef.current !== null) {
      window.clearTimeout(launchpadCloseTimerRef.current);
    }

    if (folderCloseTimerRef.current !== null) {
      window.clearTimeout(folderCloseTimerRef.current);
    }
  }, []);

  useEffect(() => {
    const surface = desktopSurfaceRef.current;

    if (!surface || typeof ResizeObserver === 'undefined') {
      return;
    }

    const resizeObserver = new ResizeObserver(([entry]) => {
      if (!entry) {
        return;
      }

      const { width, height } = entry.contentRect;
      setDesktopWindows((currentWindows) => currentWindows.map((desktopWindow) => {
        if (desktopWindow.isMaximized) {
          return {
            ...desktopWindow,
            frame: getMaximizedWindowFrame(width, height, dockPosition, dockSize, shouldReserveDockSpace(true)),
          };
        }

        return {
          ...desktopWindow,
          frame: clampWindowFrame(desktopWindow.frame, width, height, dockPosition, dockSize, shouldReserveDockSpace(false)),
        };
      }));
    });

    const surfaceRect = surface.getBoundingClientRect();
    setDesktopWindows((currentWindows) => currentWindows.map((desktopWindow) => {
      if (desktopWindow.isMaximized) {
        return {
          ...desktopWindow,
          frame: getMaximizedWindowFrame(surfaceRect.width, surfaceRect.height, dockPosition, dockSize, shouldReserveDockSpace(true)),
        };
      }

      return {
        ...desktopWindow,
        frame: clampWindowFrame(desktopWindow.frame, surfaceRect.width, surfaceRect.height, dockPosition, dockSize, shouldReserveDockSpace(false)),
      };
    }));

    resizeObserver.observe(surface);

    return () => resizeObserver.disconnect();
  }, [dockAutoHide, dockPosition, dockSize]);

  const commitDesktopLayout = (nextLayout: ShellDeskRemoteDesktopLayout) => {
    const normalizedLayout = normalizeRemoteDesktopLayout(nextLayout);
    desktopLayoutRef.current = normalizedLayout;
    storeRemoteDesktopLayoutShadow(normalizedLayout);
    setDesktopLayout(normalizedLayout);
    onSettingsChange?.({
      ...settings,
      remoteDesktopLayout: normalizedLayout,
    });
  };

  const updateDesktopLayout = (updater: (layout: ShellDeskRemoteDesktopLayout) => ShellDeskRemoteDesktopLayout) => {
    commitDesktopLayout(updater(desktopLayoutRef.current));
  };

  const closeDesktopMenus = () => {
    setAppContextMenu(null);
    setFolderContextMenu(null);
    setSurfaceContextMenu(null);
  };

  const openLaunchpad = () => {
    if (launchpadCloseTimerRef.current !== null) {
      window.clearTimeout(launchpadCloseTimerRef.current);
      launchpadCloseTimerRef.current = null;
    }

    setIsLaunchpadRendered(true);
    setIsLaunchpadOpen(true);
  };

  const closeLaunchpad = (restoreFocus = true) => {
    setIsLaunchpadOpen(false);
    setLaunchpadSearch('');
    setLaunchpadCapabilityFilter('all');

    const acknowledgedLayout = acknowledgeDesktopAppCatalog(desktopLayoutRef.current);
    if (!areRemoteDesktopLayoutsEqual(acknowledgedLayout, desktopLayoutRef.current)) {
      commitDesktopLayout(acknowledgedLayout);
    }

    if (launchpadCloseTimerRef.current !== null) {
      window.clearTimeout(launchpadCloseTimerRef.current);
    }

    launchpadCloseTimerRef.current = window.setTimeout(() => {
      setIsLaunchpadRendered(false);
      launchpadCloseTimerRef.current = null;
    }, launchpadAnimationMs);

    if (restoreFocus) {
      window.requestAnimationFrame(() => launchpadButtonRef.current?.focus({ preventScroll: true }));
    }
  };

  const toggleLaunchpad = () => {
    if (isLaunchpadOpen) {
      closeLaunchpad();
      return;
    }

    openLaunchpad();
  };

  const openDesktopFolder = (folderId: string) => {
    if (folderCloseTimerRef.current !== null) {
      window.clearTimeout(folderCloseTimerRef.current);
      folderCloseTimerRef.current = null;
    }

    setOpenFolderId(folderId);
    const folder = desktopLayoutRef.current.items.find((item): item is DesktopFolderLayoutItem => item.type === 'folder' && item.id === folderId);
    setFocusedFolderAppKey(folder?.appKeys[0] ?? null);
    setIsFolderOpen(true);
  };

  const closeDesktopFolder = (restoreFocus = true) => {
    const folderId = openFolderId;
    setIsFolderOpen(false);

    if (folderCloseTimerRef.current !== null) {
      window.clearTimeout(folderCloseTimerRef.current);
    }

    folderCloseTimerRef.current = window.setTimeout(() => {
      setOpenFolderId('');
      folderCloseTimerRef.current = null;
    }, launchpadAnimationMs);

    if (restoreFocus && folderId) {
      window.requestAnimationFrame(() => {
        desktopSurfaceRef.current
          ?.querySelector<HTMLElement>(`[data-layout-item-id="${CSS.escape(folderId)}"]`)
          ?.focus({ preventScroll: true });
      });
    }
  };

  useEffect(() => {
    if (isFolderOpen && openFolder) {
      focusFirstElement(folderPanelRef.current, '.desktop-folder-app-button, .desktop-folder-title');
    }
  }, [isFolderOpen, openFolder]);

  useEffect(() => {
    const isContextMenuOpen = Boolean(appContextMenu || folderContextMenu || surfaceContextMenu);
    if (isContextMenuOpen) {
      if (!wasContextMenuOpenRef.current) {
        contextMenuPreviousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      }
      initializeRovingFocus(contextMenuRef.current, '[role^="menuitem"]');
    } else if (!isContextMenuOpen && wasContextMenuOpenRef.current) {
      window.requestAnimationFrame(() => contextMenuPreviousFocusRef.current?.focus({ preventScroll: true }));
    }
    wasContextMenuOpenRef.current = isContextMenuOpen;
  }, [appContextMenu, folderContextMenu, surfaceContextMenu]);

  useEffect(() => {
    if (capabilityNoticeAppKey) {
      focusFirstElement(capabilityDialogRef.current);
    }
  }, [capabilityNoticeAppKey]);

  const closeCapabilityNotice = () => {
    setCapabilityNoticeAppKey(null);
    window.requestAnimationFrame(() => capabilityPreviousFocusRef.current?.focus({ preventScroll: true }));
  };

  const createFolder = () => {
    const folderName = createUniqueFolderName(desktopLayout.items, t('desktop.folder.defaultName', settings.language));
    const folderId = `folder:${Date.now().toString(36)}`;

    commitDesktopLayout({
      ...desktopLayout,
      sortMode: 'custom',
      items: [
        ...desktopLayout.items,
        {
          id: folderId,
          type: 'folder',
          name: folderName,
          appKeys: [],
        },
      ],
    });
    setRenameFolderDialog({ folderId, name: folderName });
  };

  const renameFolder = (folderId: string, name: string) => {
    updateDesktopLayout((layout) => ({
      ...layout,
      items: layout.items.map((item) => (
        item.type === 'folder' && item.id === folderId
          ? { ...item, name: normalizeFolderName(name) }
          : item
      )),
    }));
  };

  const deleteFolder = (folderId: string) => {
    updateDesktopLayout((layout) => ({
      ...layout,
      sortMode: 'custom',
      items: layout.items.filter((item) => item.id !== folderId),
    }));

    if (openFolderId === folderId) {
      if (folderCloseTimerRef.current !== null) {
        window.clearTimeout(folderCloseTimerRef.current);
        folderCloseTimerRef.current = null;
      }

      setIsFolderOpen(false);
      setOpenFolderId('');
    }
  };

  const handleSortModeChange = (sortMode: ShellDeskDesktopSortMode) => {
    updateDesktopLayout((layout) => ({
      ...layout,
      sortMode,
    }));
  };

  const activateRoleButton = (event: ReactKeyboardEvent<HTMLElement>, action: () => void) => {
    if (event.key !== 'Enter' && event.key !== ' ') {
      return;
    }

    event.preventDefault();
    action();
  };

  const applyDesktopDrop = (payload: DesktopDragPayload, targetItem?: DesktopLayoutItem) => {
    const payloadAppKey = 'appKey' in payload ? payload.appKey : undefined;

    if (targetItem?.type === 'folder' && payloadAppKey) {
      updateDesktopLayout((layout) => addAppToFolder(layout, targetItem.id, payloadAppKey));
      return;
    }

    if (payload.source === 'desktop') {
      updateDesktopLayout((layout) => moveTopLevelItem(layout, payload.itemId, targetItem?.id));
      return;
    }

    updateDesktopLayout((layout) => moveAppToDesktop(layout, payload.appKey, targetItem?.id));
  };

  const getPointerDragLabel = (payload: DesktopDragPayload) => {
    if ('appKey' in payload && payload.appKey) {
      return getAppLabel(getAppInfo(payload.appKey), settings.language);
    }

    const item = desktopLayoutRef.current.items.find((layoutItem) => layoutItem.id === payload.itemId);
    return item ? getLayoutItemLabel(item, settings.language) : '';
  };

  const applyPointerDrop = (payload: DesktopDragPayload, clientX: number, clientY: number) => {
    const target = document
      .elementFromPoint(clientX, clientY)
      ?.closest<HTMLElement>('[data-desktop-drop-kind]');

    if (!target) {
      return;
    }

    const dropKind = target.dataset.desktopDropKind;
    const payloadAppKey = 'appKey' in payload ? payload.appKey : undefined;

    if (dropKind === 'folder' || dropKind === 'folder-app') {
      const folderId = target.dataset.folderId;
      const targetAppKey = isDesktopAppKey(target.dataset.appKey) ? target.dataset.appKey : undefined;

      if (folderId && payloadAppKey) {
        updateDesktopLayout((layout) => addAppToFolder(layout, folderId, payloadAppKey, targetAppKey));
      }
      return;
    }

    if (dropKind === 'desktop-item') {
      const targetItemId = target.dataset.layoutItemId;
      const targetItem = desktopLayoutRef.current.items.find((layoutItem) => layoutItem.id === targetItemId);
      applyDesktopDrop(payload, targetItem);
      return;
    }

    if (dropKind === 'desktop') {
      applyDesktopDrop(payload);
    }
  };

  const consumeSuppressedPointerClick = (event: ReactMouseEvent<HTMLElement>) => {
    if (!suppressNextPointerClickRef.current) {
      return false;
    }

    suppressNextPointerClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
    return true;
  };

  const startPointerDrag = (event: ReactPointerEvent<HTMLElement>, payload: DesktopDragPayload) => {
    if (event.button !== 0) {
      return;
    }

    const session: DesktopPointerDragSession = {
      payload,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      isDragging: false,
    };

    desktopPointerDragSessionRef.current = session;

    const handlePointerMove = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId !== session.pointerId) {
        return;
      }

      const distance = Math.hypot(pointerEvent.clientX - session.startX, pointerEvent.clientY - session.startY);

      if (!session.isDragging && distance < 5) {
        return;
      }

      if (!session.isDragging) {
        session.isDragging = true;
        closeDesktopMenus();
      }

      pointerEvent.preventDefault();
      setDesktopPointerDragPreview({
        x: pointerEvent.clientX,
        y: pointerEvent.clientY,
        label: getPointerDragLabel(session.payload),
        appKey: 'appKey' in session.payload ? session.payload.appKey : undefined,
      });
    };

    const finishPointerDrag = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId !== session.pointerId) {
        return;
      }

      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', finishPointerDrag);
      window.removeEventListener('pointercancel', finishPointerDrag);
      desktopPointerDragSessionRef.current = null;
      setDesktopPointerDragPreview(null);

      if (!session.isDragging) {
        return;
      }

      pointerEvent.preventDefault();
      suppressNextPointerClickRef.current = true;
      window.setTimeout(() => {
        suppressNextPointerClickRef.current = false;
      }, 80);
      applyPointerDrop(session.payload, pointerEvent.clientX, pointerEvent.clientY);
    };

    window.addEventListener('pointermove', handlePointerMove, { passive: false });
    window.addEventListener('pointerup', finishPointerDrag);
    window.addEventListener('pointercancel', finishPointerDrag);
  };

  const handleSurfaceContextMenu = (event: ReactPointerEvent<HTMLElement> | ReactMouseEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;

    if (target.closest('.desktop-icon-button, .desktop-window, .mac-dock')) {
      return;
    }

    event.preventDefault();
    closeDesktopMenus();
    setSurfaceContextMenu({ x: event.clientX, y: event.clientY });
  };

  const sendAppToDesktop = (appKey: DesktopAppKey) => {
    if (hasDesktopApp(desktopLayout, appKey)) {
      return;
    }

    updateDesktopLayout((layout) => moveAppToDesktop(layout, appKey));
  };

  const moveFolderAppToDesktop = (appKey: DesktopAppKey) => {
    updateDesktopLayout((layout) => moveAppToDesktop(layout, appKey));
  };

  const deleteAppFromDesktop = (appKey: DesktopAppKey) => {
    updateDesktopLayout((layout) => ({
      ...markDesktopAppRemoved(removeAppFromDesktopLayout(layout, appKey), appKey),
      sortMode: 'custom',
    }));
  };

  const submitFolderRename = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!renameFolderDialog) {
      return;
    }

    renameFolder(renameFolderDialog.folderId, renameFolderDialog.name);
    setRenameFolderDialog(null);
  };

  const bringWindowToFront = useCallback((windowId: string) => {
    setFocusedWindowId(windowId);
    setDesktopWindows((currentWindows) => {
      const targetWindow = currentWindows.find((desktopWindow) => desktopWindow.id === windowId);

      if (!targetWindow) {
        return currentWindows;
      }

      const highestZIndex = currentWindows.reduce((highest, desktopWindow) => Math.max(highest, desktopWindow.zIndex), 0);
      const alreadyFront = !targetWindow.isMinimized && targetWindow.zIndex >= highestZIndex;

      if (alreadyFront) {
        return currentWindows;
      }

      zIndexRef.current = Math.max(zIndexRef.current, highestZIndex) + 1;
      const nextZIndex = zIndexRef.current;
      return currentWindows.map((desktopWindow) => (
        desktopWindow.id === windowId ? { ...desktopWindow, isMinimized: false, zIndex: nextZIndex } : desktopWindow
      ));
    });
  }, []);

  const appendDesktopWindow = (
    appKey: DesktopAppKey,
    configureWindow?: (desktopWindow: DesktopWindowState) => void,
  ) => {
    windowSequenceRef.current += 1;
    zIndexRef.current += 1;
    const nextWindow = createDesktopWindow(appKey, windowSequenceRef.current, zIndexRef.current, settings.language);
    const surface = desktopSurfaceRef.current;

    configureWindow?.(nextWindow);

    if (surface) {
      const surfaceRect = surface.getBoundingClientRect();
      nextWindow.frame = clampWindowFrame(
        nextWindow.frame,
        surfaceRect.width,
        surfaceRect.height,
        dockPosition,
        dockSize,
        shouldReserveDockSpace(false),
      );
    }

    setDesktopWindows((currentWindows) => [...currentWindows, nextWindow]);
    setFocusedWindowId(nextWindow.id);
    const app = getAppInfo(appKey);
    void window.guiSSH?.logs?.appendEntry({
      id: `desktop-app-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      timestamp: new Date().toISOString(),
      category: 'system',
      level: 'info',
      message: t('desktop.app.openLog', settings.language, { name: getAppLabel(app, settings.language) }),
      detail: `appKey: ${appKey}`,
      component: appKey,
      hostId: connection.host.id,
      hostName: connection.host.name,
      hostAddress: connection.host.address,
    }).catch(() => undefined);
  };

  const openBrowserWindow = (initialUrl?: string) => {
    appendDesktopWindow('browser', (desktopWindow) => {
      if (!initialUrl) {
        return;
      }

      desktopWindow.browserInitialUrl = initialUrl;
      desktopWindow.chromeTitle = initialUrl;
      desktopWindow.chromeStatus = t('desktop.browser.status.loading', settings.language);
      desktopWindow.chromeTone = 'loading';
    });
  };

  const openVncWindow = (target: { host: string; port: number }) => {
    appendDesktopWindow('vnc', (desktopWindow) => {
      desktopWindow.vncInitialTarget = target;
    });
  };

  const openSettingsWindow = (initialTab: SettingsTab = 'systeminfo') => {
    const existingSettingsWindow = desktopWindows.find((desktopWindow) => desktopWindow.appKey === 'settings');

    if (existingSettingsWindow) {
      setDesktopWindows((currentWindows) => currentWindows.map((desktopWindow) => (
        desktopWindow.id === existingSettingsWindow.id
          ? {
              ...desktopWindow,
              settingsInitialTab: initialTab,
              settingsTabRequestId: (desktopWindow.settingsTabRequestId ?? 0) + 1,
            }
          : desktopWindow
      )));
      bringWindowToFront(existingSettingsWindow.id);
      return;
    }

    appendDesktopWindow('settings', (nextWindow) => {
      nextWindow.settingsInitialTab = initialTab;
      nextWindow.settingsTabRequestId = 1;
    });
  };

  const resolveDefaultTerminalLaunchOptions = async () => {
    if (!settings.terminalPreferTmux || connection.host.systemType === 'windows') {
      return undefined;
    }

    const runCommand = window.guiSSH?.connections?.runCommand;

    if (!runCommand) {
      return undefined;
    }

    try {
      const result = await runCommand(connection.id, createTmuxAvailabilityCommand());
      return result.code === 0 ? createTmuxLaunchOptions(defaultTmuxSessionName, settings.language) : undefined;
    } catch {
      return undefined;
    }
  };

  const openTerminalWindow = async (launchOptions?: RemoteTerminalLaunchOptions) => {
    const resolvedLaunchOptions = hasTerminalLaunchOverrides(launchOptions)
      ? launchOptions
      : await resolveDefaultTerminalLaunchOptions();

    appendDesktopWindow('terminal', (nextWindow) => {
      nextWindow.terminalLaunchOptions = resolvedLaunchOptions;
    });
  };

  const openDesktopWindow = (appKey: DesktopAppKey) => {
    const availability = desktopCapabilitySnapshot[appKey];
    if (
      availability.status === 'unsupported'
      || availability.status === 'missing'
      || availability.status === 'checking'
    ) {
      capabilityPreviousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setCapabilityNoticeAppKey(appKey);
      return false;
    }
    if (appKey === 'terminal') {
      void openTerminalWindow();
      return true;
    }
    appendDesktopWindow(appKey);
    return true;
  };
  openDesktopWindowRef.current = openDesktopWindow;
  useEffect(() => {
    if (!initialAppKey || openedInitialAppRef.current === initialAppKey || !desktopApps.some((app) => app.key === initialAppKey)) {
      return;
    }
    const appKey = initialAppKey as DesktopAppKey;
    if (connectionGate.status !== 'ready' || desktopCapabilitySnapshot[appKey].status === 'checking') return;
    openedInitialAppRef.current = initialAppKey;
    openDesktopWindowRef.current(appKey);
  }, [connectionGate.status, desktopCapabilitySnapshot, initialAppKey]);
  useEffect(() => {
    const events = window.guiSSH?.events;
    if (!events?.onDesktopAppOpen) {
      return undefined;
    }

    return events.onDesktopAppOpen(({ appKey }) => {
      if (desktopApps.some((app) => app.key === appKey)) {
        openDesktopWindowRef.current(appKey as DesktopAppKey);
      }
    });
  }, []);

  const refreshTmuxSessions = useCallback(async () => {
    const requestId = tmuxRefreshRequestRef.current + 1;
    tmuxRefreshRequestRef.current = requestId;
    setTmuxMenuState((currentState) => ({ ...currentState, status: 'loading', error: undefined }));

    if (connection.host.systemType === 'windows') {
      setTmuxMenuState({
        status: 'error',
        sessions: [],
        error: t('terminal.tmux.unsupported', settings.language),
      });
      return;
    }

    const api = window.guiSSH?.connections;

    if (!api?.runCommand) {
      setTmuxMenuState({
        status: 'error',
        sessions: [],
        error: t('terminal.tmux.bridgeUnavailable', settings.language),
      });
      return;
    }

    try {
      const result = await api.runCommand(connection.id, createTmuxListCommand());

      if (tmuxRefreshRequestRef.current !== requestId) {
        return;
      }

      if (result.code === 127) {
        setTmuxMenuState({
          status: 'error',
          sessions: [],
          error: t('terminal.tmux.notInstalled', settings.language),
        });
        return;
      }

      if (result.code !== 0 && result.stderr.trim()) {
        setTmuxMenuState({
          status: 'error',
          sessions: [],
          error: result.stderr.trim(),
        });
        return;
      }

      setTmuxMenuState({
        status: 'ready',
        sessions: parseTmuxSessions(result.stdout),
      });
    } catch (error) {
      if (tmuxRefreshRequestRef.current !== requestId) {
        return;
      }

      setTmuxMenuState({
        status: 'error',
        sessions: [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [connection.host.systemType, connection.id, settings.language]);

  const rememberTmuxSession = (sessionName: string) => {
    setTmuxMenuState((currentState) => {
      if (currentState.sessions.some((session) => session.name === sessionName)) {
        return currentState;
      }

      return {
        status: currentState.status === 'idle' ? 'ready' : currentState.status,
        sessions: [
          {
            name: sessionName,
            windows: 1,
            attached: 0,
            createdAt: Math.floor(Date.now() / 1000),
            lastAttachedAt: Math.floor(Date.now() / 1000),
          },
          ...currentState.sessions,
        ],
        error: currentState.error,
      };
    });
  };

  const openTmuxTerminal = (sessionName: string, command: 'attach' | 'new' = 'attach') => {
    rememberTmuxSession(sessionName);
    void openTerminalWindow(createTmuxLaunchOptions(sessionName, settings.language, command));
    setTerminalTitlebarMenu(null);
    window.setTimeout(() => {
      void refreshTmuxSessions();
    }, 900);
  };

  const openNewTmuxTerminal = () => {
    openTmuxTerminal(createTmuxSessionName(), 'new');
  };

  const interceptTerminalCommand = (command: string) => {
    const tmuxLaunch = parseTmuxLaunchCommand(command);

    if (!tmuxLaunch) {
      return false;
    }

    openTmuxTerminal(tmuxLaunch.sessionName, tmuxLaunch.command);
    return true;
  };

  const killTmuxSession = async (desktopWindow: DesktopWindowState) => {
    const sessionName = desktopWindow.terminalLaunchOptions?.tmuxSessionName;

    if (!sessionName) {
      return;
    }

    setTerminalTitlebarMenu(null);
    try {
      await window.guiSSH?.connections?.runCommand(
        connection.id,
        `tmux kill-session -t ${quotePosixShellArg(sessionName)}`,
      );
    } finally {
      removeDesktopWindow(desktopWindow.id);
      window.setTimeout(() => {
        void refreshTmuxSessions();
      }, 300);
    }
  };

  const openNotepadFile = (filePath: string) => {
    const existingWindow = getTopDesktopWindow(desktopWindows, (desktopWindow) => desktopWindow.appKey === 'notepad');

    if (existingWindow) {
      zIndexRef.current += 1;
      const nextZIndex = zIndexRef.current;
      const requestId = `notepad-open-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      setFocusedWindowId(existingWindow.id);
      setDesktopWindows((currentWindows) => currentWindows.map((desktopWindow) => (
        desktopWindow.id === existingWindow.id
          ? {
              ...desktopWindow,
              isMinimized: false,
              zIndex: nextZIndex,
              notepadOpenRequest: { id: requestId, filePath },
            }
          : desktopWindow
      )));
      return;
    }

    appendDesktopWindow('notepad', (nextWindow) => {
      nextWindow.notepadInitialPath = filePath;
    });
  };

  const openSqliteFile = (filePath: string) => {
    appendDesktopWindow('sqlite', (nextWindow) => {
      nextWindow.notepadInitialPath = filePath;
    });
  };

  const openFileManagerAtPath = (directoryPath: string) => {
    const existingWindow = getTopDesktopWindow(desktopWindows, (desktopWindow) => desktopWindow.appKey === 'files');

    if (existingWindow) {
      zIndexRef.current += 1;
      const nextZIndex = zIndexRef.current;
      setFocusedWindowId(existingWindow.id);
      setDesktopWindows((currentWindows) => currentWindows.map((desktopWindow) => (
        desktopWindow.id === existingWindow.id
          ? { ...desktopWindow, isMinimized: false, zIndex: nextZIndex, fileExplorerInitialPath: directoryPath }
          : desktopWindow
      )));
      return;
    }

    appendDesktopWindow('files', (nextWindow) => {
      nextWindow.fileExplorerInitialPath = directoryPath;
    });
  };

  const openNotepadNote = (note: { title: string; content: string }) => {
    appendDesktopWindow('notepad', (nextWindow) => {
      nextWindow.notepadInitialContent = note.content;
      nextWindow.notepadInitialTitle = note.title;
    });
  };

  const openTerminalAtPath = (directoryPath: string) => {
    void openTerminalWindow({
      title: directoryPath,
      workingDirectory: directoryPath,
    });
  };

  const openProcessManager = (launchOptions?: RemoteProcessManagerLaunchOptions) => {
    const existingWindow = getTopDesktopWindow(desktopWindows, (desktopWindow) => desktopWindow.appKey === 'procmanager');

    if (existingWindow) {
      zIndexRef.current += 1;
      const nextZIndex = zIndexRef.current;

      setFocusedWindowId(existingWindow.id);
      setDesktopWindows((currentWindows) => currentWindows.map((desktopWindow) => (
        desktopWindow.id === existingWindow.id
          ? {
              ...desktopWindow,
              isMinimized: false,
              zIndex: nextZIndex,
              processManagerLaunchOptions: launchOptions ? { ...launchOptions } : desktopWindow.processManagerLaunchOptions,
            }
          : desktopWindow
      )));
      return;
    }

    appendDesktopWindow('procmanager', (nextWindow) => {
      nextWindow.processManagerLaunchOptions = launchOptions ? { ...launchOptions } : undefined;
    });
  };

  const removeDesktopWindow = useCallback((windowId: string) => {
    setDesktopWindows((currentWindows) => {
      const closedWindow = currentWindows.find((desktopWindow) => desktopWindow.id === windowId);
      const nextWindows = currentWindows.filter((desktopWindow) => desktopWindow.id !== windowId);
      const nextFocusedWindow = getTopDesktopWindow(nextWindows, (desktopWindow) => !desktopWindow.isMinimized);

      setFocusedWindowId(nextFocusedWindow?.id ?? '');
      if (!nextFocusedWindow) {
        window.requestAnimationFrame(() => {
          const dockButton = closedWindow
            ? desktopSurfaceRef.current?.querySelector<HTMLButtonElement>(`[data-dock-app-key="${closedWindow.appKey}"]`)
            : null;
          (dockButton ?? launchpadButtonRef.current)?.focus({ preventScroll: true });
        });
      }
      return nextWindows;
    });
  }, []);

  const closeDesktopWindow = useCallback((windowId: string) => {
    const desktopWindow = desktopWindowsRef.current.find((currentWindow) => currentWindow.id === windowId);

    if (
      desktopWindow?.appKey === 'terminal' &&
      desktopWindow.terminalLaunchOptions?.mode !== 'tmux' &&
      desktopWindow.terminalHasForegroundTask
    ) {
      setPendingCloseWindowId(windowId);
      return;
    }

    removeDesktopWindow(windowId);
  }, [removeDesktopWindow]);

  const minimizeDesktopWindow = useCallback((windowId: string) => {
    windowPointerStateRef.current = null;
    setDesktopWindows((currentWindows) => {
      const nextWindows = currentWindows.map((desktopWindow) => (
        desktopWindow.id === windowId ? { ...desktopWindow, isMinimized: true } : desktopWindow
      ));
      const nextFocusedWindow = getTopDesktopWindow(nextWindows, (desktopWindow) => !desktopWindow.isMinimized);

      setFocusedWindowId(nextFocusedWindow?.id ?? '');
      return nextWindows;
    });
  }, []);

  const activateDockApp = (appKey: DesktopAppKey) => {
    const appWindows = desktopWindows.filter((desktopWindow) => desktopWindow.appKey === appKey);
    const visibleWindow = getTopDesktopWindow(appWindows, (desktopWindow) => !desktopWindow.isMinimized);
    const minimizedWindow = getTopDesktopWindow(appWindows, (desktopWindow) => desktopWindow.isMinimized);
    const windowToActivate = visibleWindow ?? minimizedWindow;

    if (windowToActivate) {
      bringWindowToFront(windowToActivate.id);
      return;
    }

    openDesktopWindow(appKey);
  };

  const toggleWindowMaximize = useCallback((windowId: string) => {
    const surface = desktopSurfaceRef.current;

    if (!surface) {
      return;
    }

    const surfaceRect = surface.getBoundingClientRect();
    zIndexRef.current += 1;
    const nextZIndex = zIndexRef.current;
    setFocusedWindowId(windowId);
    setDesktopWindows((currentWindows) => currentWindows.map((desktopWindow) => {
      if (desktopWindow.id !== windowId) {
        return desktopWindow;
      }

      if (desktopWindow.isMaximized) {
        return {
          ...desktopWindow,
          frame: clampWindowFrame(
            desktopWindow.previousFrame ?? defaultWindowFrames[desktopWindow.appKey],
            surfaceRect.width,
            surfaceRect.height,
            dockPosition,
            dockSize,
            shouldReserveDockSpace(false),
          ),
          previousFrame: undefined,
          isMaximized: false,
          zIndex: nextZIndex,
        };
      }

      return {
        ...desktopWindow,
        previousFrame: desktopWindow.frame,
        frame: getMaximizedWindowFrame(surfaceRect.width, surfaceRect.height, dockPosition, dockSize, shouldReserveDockSpace(true)),
        isMaximized: true,
        zIndex: nextZIndex,
      };
    }));
  }, [dockAutoHide, dockPosition, dockSize]);

  const handleWindowKeyboardFrameChange = useCallback((
    windowId: string,
    mode: 'move' | 'resize',
    deltaX: number,
    deltaY: number,
  ) => {
    const surface = desktopSurfaceRef.current;

    if (!surface) {
      return;
    }

    const surfaceRect = surface.getBoundingClientRect();
    setFocusedWindowId(windowId);
    setDesktopWindows((currentWindows) => currentWindows.map((desktopWindow) => {
      if (desktopWindow.id !== windowId || desktopWindow.isMaximized || desktopWindow.isMinimized) {
        return desktopWindow;
      }

      const nextFrame = mode === 'move'
        ? {
            ...desktopWindow.frame,
            x: desktopWindow.frame.x + deltaX,
            y: desktopWindow.frame.y + deltaY,
          }
        : {
            ...desktopWindow.frame,
            width: desktopWindow.frame.width + deltaX,
            height: desktopWindow.frame.height + deltaY,
          };

      return {
        ...desktopWindow,
        frame: clampWindowFrame(
          nextFrame,
          surfaceRect.width,
          surfaceRect.height,
          dockPosition,
          dockSize,
          shouldReserveDockSpace(false),
        ),
      };
    }));
  }, [dockAutoHide, dockPosition, dockSize]);

  const startWindowInteraction = useCallback((event: ReactPointerEvent<HTMLElement>, windowId: string, mode: DesktopWindowInteractionMode) => {
    if (event.button !== 0) {
      return;
    }

    const surface = desktopSurfaceRef.current;
    const desktopWindow = desktopWindowsRef.current.find((currentWindow) => currentWindow.id === windowId);

    if (!surface || !desktopWindow || desktopWindow.isMaximized || desktopWindow.isMinimized) {
      return;
    }

    const surfaceRect = surface.getBoundingClientRect();
    const startFrame = clampWindowFrame(
      desktopWindow.frame,
      surfaceRect.width,
      surfaceRect.height,
      dockPosition,
      dockSize,
      shouldReserveDockSpace(false),
    );
    const windowElement = event.currentTarget.closest('.desktop-window') as HTMLElement | null;

    if (!windowElement) {
      return;
    }

    windowPointerStateRef.current = {
      pointerId: event.pointerId,
      windowId,
      mode,
      element: windowElement,
      originX: event.clientX,
      originY: event.clientY,
      startFrame,
      latestFrame: startFrame,
      surfaceWidth: surfaceRect.width,
      surfaceHeight: surfaceRect.height,
    };

    windowElement.classList.add('interacting', mode === 'move' ? 'moving' : 'resizing');
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }, [dockAutoHide, dockPosition, dockSize]);

  const handleWindowTitlebarPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>, windowId: string) => {
    if (event.button !== 0) {
      return;
    }

    const target = event.target instanceof HTMLElement ? event.target : null;

    if (target?.closest('.win-titlebar-controls')) {
      return;
    }

    const now = window.performance.now();
    const previousClick = titlebarClickStateRef.current;
    const isDoubleClick = Boolean(
      previousClick &&
      previousClick.windowId === windowId &&
      now - previousClick.timestamp <= titlebarDoubleClickDelayMs &&
      Math.hypot(event.clientX - previousClick.x, event.clientY - previousClick.y) <= titlebarDoubleClickDistance,
    );

    if (isDoubleClick) {
      titlebarClickStateRef.current = null;
      event.preventDefault();
      toggleWindowMaximize(windowId);
      return;
    }

    titlebarClickStateRef.current = {
      windowId,
      timestamp: now,
      x: event.clientX,
      y: event.clientY,
    };

    startWindowInteraction(event, windowId, 'move');
  }, [startWindowInteraction, toggleWindowMaximize]);

  const updateWindowInteraction = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const pointerState = windowPointerStateRef.current;

    if (!pointerState || pointerState.pointerId !== event.pointerId) {
      return;
    }

    const deltaX = event.clientX - pointerState.originX;
    const deltaY = event.clientY - pointerState.originY;

    if (pointerState.mode === 'move' && Math.hypot(deltaX, deltaY) > titlebarDoubleClickDistance) {
      titlebarClickStateRef.current = null;
    }

    const nextFrame = pointerState.mode === 'move'
      ? {
          ...pointerState.startFrame,
          x: pointerState.startFrame.x + deltaX,
          y: pointerState.startFrame.y + deltaY,
        }
      : {
          ...pointerState.startFrame,
          width: pointerState.startFrame.width + deltaX,
          height: pointerState.startFrame.height + deltaY,
        };
    const clampedFrame = clampWindowFrame(
      nextFrame,
      pointerState.surfaceWidth,
      pointerState.surfaceHeight,
      dockPosition,
      dockSize,
      shouldReserveDockSpace(false),
    );

    pointerState.latestFrame = clampedFrame;
    applyWindowFrameToElement(pointerState.element, clampedFrame);
    event.preventDefault();
  }, [dockAutoHide, dockPosition, dockSize]);

  const finishWindowInteraction = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const pointerState = windowPointerStateRef.current;

    if (!pointerState || pointerState.pointerId !== event.pointerId) {
      return;
    }

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    const finalFrame = pointerState.latestFrame;
    pointerState.element.classList.remove('interacting', 'moving', 'resizing');
    windowPointerStateRef.current = null;

    setDesktopWindows((currentWindows) => {
      let didChangeFrame = false;
      const nextWindows = currentWindows.map((desktopWindow) => {
        if (desktopWindow.id !== pointerState.windowId || areWindowFramesEqual(desktopWindow.frame, finalFrame)) {
          return desktopWindow;
        }

        didChangeFrame = true;
        return { ...desktopWindow, frame: finalFrame };
      });

      return didChangeFrame ? nextWindows : currentWindows;
    });
  }, []);

  const handleWindowResizePointerDown = useCallback((event: ReactPointerEvent<HTMLElement>, windowId: string) => {
    startWindowInteraction(event, windowId, 'resize');
  }, [startWindowInteraction]);

  const openTerminalTitlebarMenu = useCallback((windowId: string, buttonRect: DOMRect) => {
    if (terminalTitlebarMenu?.windowId === windowId) {
      setTerminalTitlebarMenu(null);
      return;
    }

    const menuWidth = 210;
    const menuEdgePadding = 8;
    setTerminalTitlebarMenu({
      windowId,
      x: Math.max(menuEdgePadding, Math.min(buttonRect.right - menuWidth, window.innerWidth - menuWidth - menuEdgePadding)),
      y: buttonRect.bottom + 5,
    });

    if (connection.host.systemType !== 'windows') {
      void refreshTmuxSessions();
    }
  }, [refreshTmuxSessions, terminalTitlebarMenu]);

  const updateWindowChrome = (
    windowId: string,
    payload: RemoteTerminalChromePayload,
  ) => {
    setDesktopWindows((currentWindows) => {
      const windowIndex = currentWindows.findIndex((desktopWindow) => desktopWindow.id === windowId);
      const desktopWindow = currentWindows[windowIndex];

      if (
        !desktopWindow ||
        (
          desktopWindow.chromeTitle === payload.title &&
          desktopWindow.chromeStatus === payload.status &&
          desktopWindow.chromeTone === payload.tone
        )
      ) {
        return currentWindows;
      }

      return currentWindows.map((currentWindow) => (
        currentWindow.id === windowId
          ? {
              ...currentWindow,
              chromeTitle: payload.title,
              chromeStatus: payload.status,
              chromeTone: payload.tone,
            }
          : currentWindow
      ));
    });
  };

  const updateTerminalSessionState = (windowId: string, payload: RemoteTerminalSessionState) => {
    setDesktopWindows((currentWindows) => {
      let didChangeTerminalState = false;
      const nextWindows = currentWindows.map((desktopWindow) => {
        if (
          desktopWindow.id !== windowId ||
          (
            desktopWindow.terminalStatus === payload.status &&
            desktopWindow.terminalHasForegroundTask === payload.hasForegroundTask
          )
        ) {
          return desktopWindow;
        }

        didChangeTerminalState = true;
        return {
          ...desktopWindow,
          terminalStatus: payload.status,
          terminalHasForegroundTask: payload.hasForegroundTask,
        };
      });

      return didChangeTerminalState ? nextWindows : currentWindows;
    });
  };

  const requestTerminalTool = (windowId: string, action: RemoteTerminalToolAction) => {
    terminalToolRequestSequenceRef.current += 1;
    const terminalToolRequest: RemoteTerminalToolRequest = {
      id: `terminal-tool-${terminalToolRequestSequenceRef.current}`,
      action,
    };

    setDesktopWindows((currentWindows) => currentWindows.map((desktopWindow) => (
      desktopWindow.id === windowId
        ? { ...desktopWindow, terminalToolRequest }
        : desktopWindow
    )));
    setTerminalTitlebarMenu(null);
  };

  const requestTerminalCommand = (windowId: string, command: string, source: RemoteTerminalCommandRequest['source'] = 'external') => {
    terminalCommandRequestSequenceRef.current += 1;
    const terminalCommandRequest: RemoteTerminalCommandRequest = {
      id: `terminal-command-${terminalCommandRequestSequenceRef.current}`,
      command,
      mode: 'insert',
      source,
    };

    setDesktopWindows((currentWindows) => currentWindows.map((desktopWindow) => (
      desktopWindow.id === windowId
        ? { ...desktopWindow, terminalCommandRequest }
        : desktopWindow
    )));
    setTerminalTitlebarMenu(null);
  };

  const completeTerminalToolRequest = (windowId: string, requestId: string) => {
    setDesktopWindows((currentWindows) => currentWindows.map((desktopWindow) => (
      desktopWindow.id === windowId && desktopWindow.terminalToolRequest?.id === requestId
        ? { ...desktopWindow, terminalToolRequest: undefined }
        : desktopWindow
    )));
  };

  const completeTerminalCommandRequest = (windowId: string, requestId: string) => {
    setDesktopWindows((currentWindows) => currentWindows.map((desktopWindow) => (
      desktopWindow.id === windowId && desktopWindow.terminalCommandRequest?.id === requestId
        ? { ...desktopWindow, terminalCommandRequest: undefined }
        : desktopWindow
    )));
  };

  const handleTerminalSessionEvent = (event: RemoteTerminalSessionEvent) => {
    onTerminalSessionEvent?.(event);
  };

  const renderWindowContent = (desktopWindow: DesktopWindowState) => {
    const openMainAiSettings = window.guiSSH?.app.openMainAiSettings;

    if (desktopWindow.appKey === 'terminal') {
      return (
        <RemoteTerminal
          connectionId={connection.id}
          terminalId={desktopWindow.terminalId ?? desktopWindow.id}
          settings={settings}
          connectionKind={connection.kind}
          systemType={connection.host.systemType}
          launchOptions={desktopWindow.terminalLaunchOptions}
          commandRequest={desktopWindow.terminalCommandRequest}
          toolRequest={desktopWindow.terminalToolRequest}
          onChromeChange={(payload) => updateWindowChrome(desktopWindow.id, payload)}
          onCommandRequestHandled={(requestId) => completeTerminalCommandRequest(desktopWindow.id, requestId)}
          onToolRequestHandled={(requestId) => completeTerminalToolRequest(desktopWindow.id, requestId)}
          onOpenTerminal={openTerminalWindow}
          onOpenNote={openNotepadNote}
          onCommandIntercept={interceptTerminalCommand}
          onSessionEvent={handleTerminalSessionEvent}
          onSessionStateChange={(payload) => updateTerminalSessionState(desktopWindow.id, payload)}
          onSettingsChange={onSettingsChange}
        />
      );
    }

    if (desktopWindow.appKey === 'browser') {
      return (
        <RemoteBrowser
          connectionId={connection.id}
          partition={connection.partition}
          bookmarkScope={`${connection.host.username}@${connection.host.address}:${connection.host.port}`}
          context={{
            name: connection.host.name,
            address: connection.host.address,
            port: connection.host.port,
            username: connection.host.username,
            proxyPort: connection.proxyPort,
          }}
          initialUrl={desktopWindow.browserInitialUrl}
          onChromeChange={(payload) => updateWindowChrome(desktopWindow.id, payload)}
        />
      );
    }

    if (desktopWindow.appKey === 'files') {
      return <RemoteFileExplorer connectionId={connection.id} systemType={connection.host.systemType} initialPath={desktopWindow.fileExplorerInitialPath} onOpenFile={openNotepadFile} onOpenSqliteFile={openSqliteFile} onOpenTerminal={openTerminalAtPath} />;
    }

    if (desktopWindow.appKey === 'notepad') {
      return <RemoteNotepad connectionId={connection.id} settings={settings} initialFilePath={desktopWindow.notepadInitialPath} initialContent={desktopWindow.notepadInitialContent} initialTitle={desktopWindow.notepadInitialTitle} openFileRequest={desktopWindow.notepadOpenRequest} systemType={connection.host.systemType} />;
    }

    if (desktopWindow.appKey === 'code-editor') {
      return (
        <RemoteCodeEditor
          connectionId={connection.id}
          connectionKind={connection.kind}
          hostId={remoteConnectionProfileHostId}
          settings={settings}
          systemType={connection.host.systemType}
          onSettingsChange={onSettingsChange}
        />
      );
    }

    if (desktopWindow.appKey === 'mysql') {
      return <RemoteMySQL connectionId={connection.id} hostId={remoteConnectionProfileHostId} />;
    }

    if (desktopWindow.appKey === 'clickhouse') {
      return <RemoteClickHouse connectionId={connection.id} hostId={remoteConnectionProfileHostId} />;
    }

    if (desktopWindow.appKey === 'redis') {
      return <RemoteRedis connectionId={connection.id} hostId={remoteConnectionProfileHostId} />;
    }

    if (desktopWindow.appKey === 'vnc') {
      return <RemoteVncViewer connectionId={connection.id} hostId={remoteConnectionProfileHostId} initialTarget={desktopWindow.vncInitialTarget} />;
    }

    if (desktopWindow.appKey === 'log-viewer') {
      return <RemoteLogViewer connectionId={connection.id} hostId={remoteConnectionProfileHostId} systemType={connection.host.systemType} />;
    }

    if (desktopWindow.appKey === 'monitor') {
      return <RemoteMonitor connectionId={connection.id} hostId={remoteConnectionProfileHostId} systemType={connection.host.systemType} onOpenProcessManager={openProcessManager} />;
    }

    if (desktopWindow.appKey === 'settings') {
      return (
        <RemoteSettings
          connectionId={connection.id}
          systemType={connection.host.systemType}
          initialTab={desktopWindow.settingsInitialTab}
          initialTabRequestId={desktopWindow.settingsTabRequestId}
          onOpenTerminal={openTerminalWindow}
        />
      );
    }

    if (desktopWindow.appKey === 'procmanager') {
      return <RemoteProcessManager connectionId={connection.id} settings={settings} systemType={connection.host.systemType} launchOptions={desktopWindow.processManagerLaunchOptions} />;
    }

    if (desktopWindow.appKey === 'service-manager') {
      return <RemoteServiceManager connectionId={connection.id} systemType={connection.host.systemType} />;
    }

    if (desktopWindow.appKey === 'supervisor-manager') {
      return <RemoteSupervisorManager connectionId={connection.id} systemType={connection.host.systemType} />;
    }

    if (desktopWindow.appKey === 'backup-manager') {
      return (
        <RemoteBackupManager
          connectionId={connection.id}
          hostId={remoteConnectionProfileHostId}
          systemType={connection.host.systemType}
          onOpenScheduledTasks={() => openDesktopWindow('scheduled-tasks')}
        />
      );
    }

    if (desktopWindow.appKey === 'rdp-viewer') {
      return (
        <RemoteRdpViewer
          connectionId={connection.id}
          hostId={remoteConnectionProfileHostId}
        />
      );
    }

    if (desktopWindow.appKey === 'container-manager') {
      return <RemoteContainerManager connectionId={connection.id} systemType={connection.host.systemType} />;
    }

    if (desktopWindow.appKey === 'k8s-manager') {
      return <RemoteK8sManager connectionId={connection.id} systemType={connection.host.systemType ?? 'unknown'} onOpenBrowser={openBrowserWindow} />;
    }

    if (desktopWindow.appKey === 'vm-manager') {
      return <RemoteVirtualMachineManager connectionId={connection.id} systemType={connection.host.systemType} onOpenTerminal={openTerminalWindow} onOpenVnc={openVncWindow} />;
    }

    if (desktopWindow.appKey === 'frp-manager') {
      return <RemoteFrpManager connectionId={connection.id} systemType={connection.host.systemType} />;
    }

    if (desktopWindow.appKey === 'frps-manager') {
      return <RemoteFrpsManager connectionId={connection.id} systemType={connection.host.systemType} />;
    }

    if (desktopWindow.appKey === 'port-manager') {
      return <RemotePortManager connectionId={connection.id} systemType={connection.host.systemType} onOpenProcessManager={openProcessManager} />;
    }

    if (desktopWindow.appKey === 'firewall-manager') {
      return <RemoteFirewallManager connectionId={connection.id} sshPort={connection.host.port} systemType={connection.host.systemType} />;
    }

    if (desktopWindow.appKey === 'iptables-manager') {
      return <RemoteIptablesManager connectionId={connection.id} systemType={connection.host.systemType} />;
    }

    if (desktopWindow.appKey === 'network-diagnostics') {
      return <RemoteNetworkDiagnostics connectionId={connection.id} systemType={connection.host.systemType} />;
    }

    if (desktopWindow.appKey === 'disk-analyzer') {
      return <RemoteDiskAnalyzer connectionId={connection.id} systemType={connection.host.systemType} onOpenFileManager={openFileManagerAtPath} />;
    }

    if (desktopWindow.appKey === 'disk-manager') {
      return <RemoteDiskManager connectionId={connection.id} systemType={connection.host.systemType} onOpenFileManager={openFileManagerAtPath} />;
    }

    if (desktopWindow.appKey === 'package-manager') {
      return (
        <RemotePackageManager
          connectionId={connection.id}
          systemType={connection.host.systemType}
          onOpenTerminal={openTerminalWindow}
          onOpenPackageSourcesSettings={() => openSettingsWindow('package-sources')}
        />
      );
    }

    if (desktopWindow.appKey === 'git-manager') {
      return <RemoteGitManager connectionId={connection.id} systemType={connection.host.systemType} />;
    }

    if (desktopWindow.appKey === 'cert-manager') {
      return <RemoteCertManager connectionId={connection.id} systemType={connection.host.systemType} />;
    }

    if (desktopWindow.appKey === 'nginx-manager') {
      return <RemoteNginxManager connectionId={connection.id} systemType={connection.host.systemType} />;
    }

    if (desktopWindow.appKey === 'caddy-manager') {
      return <RemoteCaddyManager connectionId={connection.id} systemType={connection.host.systemType} />;
    }

    if (desktopWindow.appKey === 'apache-manager') {
      return <RemoteApacheManager connectionId={connection.id} systemType={connection.host.systemType} />;
    }

    if (desktopWindow.appKey === 'scheduled-tasks') {
      return <RemoteScheduledTasks connectionId={connection.id} systemType={connection.host.systemType} />;
    }

    if (desktopWindow.appKey === 'postgres') {
      return <RemotePostgres connectionId={connection.id} hostId={remoteConnectionProfileHostId} />;
    }

    if (desktopWindow.appKey === 'mongo') {
      return <RemoteMongo connectionId={connection.id} hostId={remoteConnectionProfileHostId} />;
    }

    if (desktopWindow.appKey === 'search-cluster') {
      return <RemoteSearchCluster connectionId={connection.id} hostId={remoteConnectionProfileHostId} systemType={connection.host.systemType} />;
    }

    if (desktopWindow.appKey === 'message-queue') {
      return <RemoteMessageQueuePanel connectionId={connection.id} hostId={remoteConnectionProfileHostId} systemType={connection.host.systemType} />;
    }

    if (desktopWindow.appKey === 's3-browser') {
      return <RemoteS3Browser connectionId={connection.id} hostId={remoteConnectionProfileHostId} systemType={connection.host.systemType} />;
    }

    if (desktopWindow.appKey === 'security-audit') {
      return <RemoteSecurityAudit connectionId={connection.id} settings={settings} systemType={connection.host.systemType} hostLabel={connection.host.name} />;
    }

    if (desktopWindow.appKey === 'api-debugger') {
      return <RemoteApiDebugger connectionId={connection.id} systemType={connection.host.systemType} />;
    }

    if (desktopWindow.appKey === 'ai-chat') {
      return (
        <RemoteAiChat
          settings={settings}
          language={settings.language}
          connectionId={connection.id}
          systemType={connection.host.systemType}
          onOpenSettings={openMainAiSettings
            ? () => {
              void openMainAiSettings().catch((error) => {
                console.error('[shelldesk] failed to open main AI settings:', error);
              });
            }
            : undefined}
          onOpenApp={(appKey) => openDesktopWindow(appKey as DesktopAppKey)}
        />
      );
    }

    if (desktopWindow.appKey === 'sqlite') {
      return <RemoteSqlite connectionId={connection.id} initialFilePath={desktopWindow.notepadInitialPath} systemType={connection.host.systemType} />;
    }

    return <RemoteMonitor connectionId={connection.id} hostId={remoteConnectionProfileHostId} systemType={connection.host.systemType} onOpenProcessManager={openProcessManager} />;
  };

  return (
    <>
      <main className="remote-desktop-page">
        <section
          ref={desktopSurfaceRef}
          className={`remote-desktop-surface no-drag remote-desktop-dock-${dockPosition} remote-desktop-dock-size-${dockSize} remote-desktop-dock-auto-hide-${dockAutoHide} ${hasMaximizedDesktopWindow ? 'has-maximized-window' : ''} ${hasCustomWallpaper ? 'has-custom-wallpaper' : 'has-default-wallpaper'} ${isConnectionGateBlocking ? 'connection-locked' : ''}`}
          style={desktopWallpaperStyle}
          onContextMenu={handleSurfaceContextMenu}
          data-desktop-drop-kind="desktop"
          aria-busy={connectionGate.status === 'checking'}
        >
          <div className="desktop-icons" aria-label={t('desktop.icons.aria', settings.language)}>
            {visibleDesktopItems.map((item) => {
              if (item.type === 'folder') {
                return (
                  <div
                    key={item.id}
                    role="button"
                    tabIndex={0}
                    className={`desktop-icon-button desktop-folder-button ${openFolderId === item.id ? 'active' : ''}`}
                    draggable={false}
                    data-desktop-drop-kind="desktop-item"
                    data-layout-item-id={item.id}
                    onPointerDown={(event) => startPointerDrag(event, { source: 'desktop', itemId: item.id, itemType: 'folder' })}
                    onDragStart={(event) => event.preventDefault()}
                    onClick={(event) => {
                      if (consumeSuppressedPointerClick(event)) return;
                      openDesktopFolder(item.id);
                    }}
                    onKeyDown={(event) => activateRoleButton(event, () => openDesktopFolder(item.id))}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      closeDesktopMenus();
                      setFolderContextMenu({ x: event.clientX, y: event.clientY, folderId: item.id });
                    }}
                  >
                    <span className="desktop-folder-icon-shell">
                      <span className="desktop-folder-icon-grid">
                        {item.appKeys.slice(0, 4).map((appKey) => (
                          <span key={appKey} className={`desktop-folder-mini-icon desktop-app-icon-${appKey}`}>
                            <DesktopAppIcon appKey={appKey} />
                          </span>
                        ))}
                      </span>
                    </span>
                    <strong>{item.name}</strong>
                  </div>
                );
              }

              const app = getAppInfo(item.appKey);
              const appLabel = getAppLabel(app, settings.language);

              return (
                <div
                  key={item.id}
                  role="button"
                  tabIndex={0}
                  className={`desktop-icon-button ${focusedWindow?.appKey === item.appKey ? 'active' : ''}`}
                  draggable={false}
                  data-desktop-drop-kind="desktop-item"
                  data-layout-item-id={item.id}
                  onPointerDown={(event) => startPointerDrag(event, { source: 'desktop', itemId: item.id, itemType: 'app', appKey: item.appKey })}
                  onDragStart={(event) => event.preventDefault()}
                  onDoubleClick={(event) => {
                    if (consumeSuppressedPointerClick(event)) return;
                    preventDesktopOpenSelection(event);
                    openDesktopWindow(item.appKey);
                  }}
                  onKeyDown={(event) => activateRoleButton(event, () => openDesktopWindow(item.appKey))}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    closeDesktopMenus();
                    setAppContextMenu({ x: event.clientX, y: event.clientY, appKey: item.appKey, source: 'desktop' });
                  }}
                >
                  <span className={`desktop-app-icon-shell desktop-app-icon-${item.appKey}`}>
                    <DesktopAppIcon appKey={item.appKey} />
                  </span>
                  <strong>{appLabel}</strong>
                </div>
              );
            })}
          </div>

          {desktopPointerDragPreview ? (
            <div
              className="desktop-pointer-drag-preview"
              style={{
                left: desktopPointerDragPreview.x,
                top: desktopPointerDragPreview.y,
              }}
              aria-hidden="true"
            >
              {desktopPointerDragPreview.appKey ? (
                <span className={`desktop-app-icon-shell desktop-app-icon-${desktopPointerDragPreview.appKey}`}>
                  <DesktopAppIcon appKey={desktopPointerDragPreview.appKey} />
                </span>
              ) : null}
              <strong>{desktopPointerDragPreview.label}</strong>
            </div>
          ) : null}

        {desktopWindows.map((desktopWindow) => {
          const appInfo = getAppInfo(desktopWindow.appKey);
          const livePointerFrame = windowPointerStateRef.current?.windowId === desktopWindow.id
            ? windowPointerStateRef.current.latestFrame
            : null;

          return (
            <RemoteDesktopWindow
              key={desktopWindow.id}
              appLabel={getAppLabel(appInfo, settings.language)}
              desktopWindow={desktopWindow}
              isFocused={desktopWindow.id === focusedWindowId}
              isTerminalTitlebarMenuOpen={terminalTitlebarMenu?.windowId === desktopWindow.id}
              language={settings.language}
              livePointerFrame={livePointerFrame}
              renderSettings={settings}
              onBringToFront={bringWindowToFront}
              onClose={closeDesktopWindow}
              onFinishInteraction={finishWindowInteraction}
              onKeyboardFrameChange={handleWindowKeyboardFrameChange}
              onMinimize={minimizeDesktopWindow}
              onOpenTerminalTitlebarMenu={openTerminalTitlebarMenu}
              onResizePointerDown={handleWindowResizePointerDown}
              onTitlebarPointerDown={handleWindowTitlebarPointerDown}
              onToggleMaximize={toggleWindowMaximize}
              onUpdateInteraction={updateWindowInteraction}
              renderContent={renderWindowContent}
            />
          );
        })}

        <nav className="mac-dock" aria-label={t('desktop.dock.aria', settings.language)}>
          <button
            ref={launchpadButtonRef}
            type="button"
            className={`dock-launchpad-button ${isLaunchpadOpen ? 'active' : ''}`}
            onClick={toggleLaunchpad}
            aria-label={t('desktop.launchpad.allApps', settings.language)}
            title={t('desktop.launchpad.allApps', settings.language)}
          >
            <span className="dock-app-icon dock-all-apps">
              <AllAppsIcon />
            </span>
          </button>
          <span className="dock-separator" aria-hidden="true" />
          {(() => {
            const openAppKeys = new Set(desktopWindows.map((w) => w.appKey));
            const pinnedAppKeys = normalizeDockPinnedApps(settings.remoteDesktopDockPinnedApps);
            const dockApps = [
              ...desktopApps.filter((app) => pinnedAppKeys.includes(app.key as DesktopAppKey)),
              ...desktopApps.filter((app) => !pinnedAppKeys.includes(app.key as DesktopAppKey) && openAppKeys.has(app.key)),
            ];

            return dockApps.map((app) => {
              const appLabel = getAppLabel(app, settings.language);
              const appWindows = desktopWindows.filter((desktopWindow) => desktopWindow.appKey === app.key);
              const hasOpenWindows = appWindows.length > 0;
              const hasVisibleWindows = appWindows.some((desktopWindow) => !desktopWindow.isMinimized);
              const isMinimizedOnly = hasOpenWindows && !hasVisibleWindows;
              const dockButtonClassName = [
                focusedWindow?.appKey === app.key ? 'active' : '',
                hasOpenWindows ? 'open' : '',
                isMinimizedOnly ? 'minimized' : '',
              ].filter(Boolean).join(' ');
              const dockButtonLabel = isMinimizedOnly
                ? t('desktop.dock.restoreApp', settings.language, { app: appLabel })
                : hasOpenWindows
                  ? t('desktop.dock.switchToApp', settings.language, { app: appLabel })
                  : t('desktop.dock.openApp', settings.language, { app: appLabel });

              return (
                <button
                  key={app.key}
                  type="button"
                  data-dock-app-key={app.key}
                  className={dockButtonClassName}
                  onClick={() => activateDockApp(app.key)}
                  aria-label={dockButtonLabel}
                  title={dockButtonLabel}
                >
                  <span className={`dock-app-icon desktop-app-icon-${app.key}`}>
                    <DesktopAppIcon appKey={app.key} />
                  </span>
                </button>
              );
            });
          })()}
        </nav>
        {isConnectionGateBlocking ? (
          <div className="remote-desktop-connection-overlay" role="presentation">
            <section
              className={`remote-desktop-connection-dialog ${connectionGate.status}`}
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="desktop-connection-gate-title"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="remote-desktop-connection-mark" aria-hidden="true">
                {connectionGate.status === 'checking' ? <span /> : '!'}
              </div>
              <div className="remote-desktop-connection-copy">
                <strong id="desktop-connection-gate-title">
                  {connectionGate.status === 'checking'
                    ? t('desktop.connection.checkingTitle', settings.language)
                    : t('desktop.connection.blockedTitle', settings.language)}
                </strong>
                <span>{connectionEndpointLabel}</span>
                <p>{connectionGate.message}</p>
              </div>
              <div className="remote-desktop-connection-actions">
                <button
                  type="button"
                  className="notepad-modal-btn"
                  onClick={closeRemoteDesktop}
                >
                  {t('common.close', settings.language)}
                </button>
                <button
                  type="button"
                  className="notepad-modal-btn primary"
                  onClick={() => void checkDesktopConnection()}
                  disabled={connectionGate.status === 'checking'}
                >
                  {connectionGate.status === 'checking'
                    ? t('desktop.connection.retrying', settings.language)
                    : t('desktop.connection.retry', settings.language)}
                </button>
              </div>
            </section>
          </div>
        ) : null}
      </section>
    </main>

    {isLaunchpadRendered ? (
      <DesktopLaunchpad
        apps={launchpadApps}
        capabilityFilter={launchpadCapabilityFilter}
        capabilitySnapshot={desktopCapabilitySnapshot}
        isOpen={isLaunchpadOpen}
        language={settings.language}
        search={launchpadSearch}
        seenAppCatalogVersion={desktopLayout.seenAppCatalogVersion}
        onCapabilityFilterChange={setLaunchpadCapabilityFilter}
        onClose={closeLaunchpad}
        onContextMenu={(appKey, x, y) => {
          closeDesktopMenus();
          setAppContextMenu({ x, y, appKey, source: 'launchpad' });
        }}
        onOpenApp={openDesktopWindow}
        onPointerDown={(event, appKey) => startPointerDrag(event, { source: 'launchpad', appKey })}
        onRefreshCapabilities={() => void refreshDesktopCapabilities(true)}
        onSearchChange={setLaunchpadSearch}
      />
    ) : null}

    {openFolder ? createPortal(
      <div className={`desktop-folder-overlay ${isFolderOpen ? 'open' : 'closing'}`} role="presentation" onClick={() => closeDesktopFolder()}>
        <section
          ref={folderPanelRef}
          className="desktop-folder-panel"
          role="dialog"
          aria-modal="true"
          aria-label={openFolder.name}
          tabIndex={-1}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            handleModalKeyboardNavigation(event, event.currentTarget, () => closeDesktopFolder());
            handleRovingKeyboardNavigation(event, event.currentTarget, '.desktop-folder-app-button', 5);
          }}
          data-desktop-drop-kind="folder"
          data-folder-id={openFolder.id}
        >
          <header className="desktop-folder-header">
            <button
              type="button"
              className="desktop-folder-title"
              onClick={() => setRenameFolderDialog({ folderId: openFolder.id, name: openFolder.name })}
              title={t('desktop.folder.rename', settings.language)}
            >
              {openFolder.name}
            </button>
            <button type="button" className="launchpad-close" aria-label={t('desktop.folder.close', settings.language)} onClick={() => closeDesktopFolder()}>
              <svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                <line x1="2" y1="2" x2="10" y2="10" />
                <line x1="10" y1="2" x2="2" y2="10" />
              </svg>
            </button>
          </header>
          <div className={`desktop-folder-grid ${openFolder.appKeys.length ? '' : 'empty'}`}>
            {openFolder.appKeys.length ? openFolder.appKeys.map((appKey) => {
              const app = getAppInfo(appKey);
              const appLabel = getAppLabel(app, settings.language);

              return (
                <div
                  key={appKey}
                  role="button"
                  tabIndex={focusedFolderAppKey === appKey ? 0 : -1}
                  className="desktop-icon-button desktop-folder-app-button"
                  title={t('desktop.folder.openHint', settings.language)}
                  draggable={false}
                  data-desktop-drop-kind="folder-app"
                  data-folder-id={openFolder.id}
                  data-app-key={appKey}
                  onFocus={() => setFocusedFolderAppKey(appKey)}
                  onPointerDown={(event) => startPointerDrag(event, { source: 'folder', folderId: openFolder.id, appKey })}
                  onDragStart={(event) => event.preventDefault()}
                  onDoubleClick={(event) => {
                    if (consumeSuppressedPointerClick(event)) return;
                    preventDesktopOpenSelection(event);
                    if (openDesktopWindow(appKey)) {
                      closeDesktopFolder(false);
                    }
                  }}
                  onKeyDown={(event) => activateRoleButton(event, () => {
                    if (openDesktopWindow(appKey)) {
                      closeDesktopFolder(false);
                    }
                  })}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    closeDesktopMenus();
                    setAppContextMenu({ x: event.clientX, y: event.clientY, appKey, source: 'folder', folderId: openFolder.id });
                  }}
                >
                  <span className={`desktop-app-icon-shell desktop-app-icon-${appKey}`}>
                    <DesktopAppIcon appKey={appKey} />
                  </span>
                  <strong>{appLabel}</strong>
                </div>
              );
            }) : (
              <div className="desktop-folder-empty">{t('desktop.folder.empty', settings.language)}</div>
            )}
          </div>
        </section>
      </div>,
      document.body,
    ) : null}

    {appContextMenu ? createPortal(
      <>
        <div
          className="context-menu-overlay"
          onClick={() => setAppContextMenu(null)}
          onContextMenu={(event) => { event.preventDefault(); setAppContextMenu(null); }}
        />
        <div
          ref={contextMenuRef}
          className="context-menu"
          style={{ left: appContextMenu.x, top: appContextMenu.y }}
          role="menu"
          tabIndex={-1}
          onKeyDown={(event) => {
            handleModalKeyboardNavigation(event, event.currentTarget, () => setAppContextMenu(null));
            handleRovingKeyboardNavigation(event, event.currentTarget, '[role^="menuitem"]');
          }}
        >
          <button
            type="button"
            role="menuitem"
            className="context-menu-icon-button"
            onClick={() => {
              const { appKey, source } = appContextMenu;
              setAppContextMenu(null);
              if (source === 'launchpad') {
                closeLaunchpad(false);
              }
              if (source === 'folder') {
                closeDesktopFolder(false);
              }
              openDesktopWindow(appKey);
            }}
          >
            <ContextMenuIcon name="open" />
            {t('desktop.menu.open', settings.language)}
          </button>
          {appContextMenu.source === 'launchpad' ? (
            <button
              type="button"
              role="menuitem"
              className="context-menu-icon-button"
              disabled={hasDesktopApp(desktopLayout, appContextMenu.appKey)}
              onClick={() => {
                const { appKey } = appContextMenu;
                setAppContextMenu(null);
                sendAppToDesktop(appKey);
              }}
            >
              <ContextMenuIcon name="desktop" />
              {t('desktop.menu.sendToDesktop', settings.language)}
            </button>
          ) : appContextMenu.source === 'folder' ? (
            <>
              <button
                type="button"
                role="menuitem"
                className="context-menu-icon-button"
                onClick={() => {
                  const { appKey } = appContextMenu;
                  setAppContextMenu(null);
                  moveFolderAppToDesktop(appKey);
                }}
              >
                <ContextMenuIcon name="move-desktop" />
                {t('desktop.menu.moveToDesktop', settings.language)}
              </button>
              <button
                type="button"
                role="menuitem"
                className="context-menu-icon-button danger-text"
                onClick={() => {
                  const { appKey } = appContextMenu;
                  setAppContextMenu(null);
                  deleteAppFromDesktop(appKey);
                }}
              >
                <ContextMenuIcon name="trash" />
                {t('desktop.menu.delete', settings.language)}
              </button>
            </>
          ) : (
            <button
              type="button"
              role="menuitem"
              className="context-menu-icon-button danger-text"
              onClick={() => {
                const { appKey } = appContextMenu;
                setAppContextMenu(null);
                deleteAppFromDesktop(appKey);
              }}
            >
              <ContextMenuIcon name="trash" />
              {t('desktop.menu.delete', settings.language)}
            </button>
          )}
        </div>
      </>,
      document.body,
    ) : null}

    {folderContextMenu ? createPortal(
      <>
        <div
          className="context-menu-overlay"
          onClick={() => setFolderContextMenu(null)}
          onContextMenu={(event) => { event.preventDefault(); setFolderContextMenu(null); }}
        />
        <div
          ref={contextMenuRef}
          className="context-menu"
          style={{ left: folderContextMenu.x, top: folderContextMenu.y }}
          role="menu"
          tabIndex={-1}
          onKeyDown={(event) => {
            handleModalKeyboardNavigation(event, event.currentTarget, () => setFolderContextMenu(null));
            handleRovingKeyboardNavigation(event, event.currentTarget, '[role^="menuitem"]');
          }}
        >
          <button
            type="button"
            role="menuitem"
            className="context-menu-icon-button"
            onClick={() => {
              openDesktopFolder(folderContextMenu.folderId);
              setFolderContextMenu(null);
            }}
          >
            <ContextMenuIcon name="open" />
            {t('desktop.menu.open', settings.language)}
          </button>
          <button
            type="button"
            role="menuitem"
            className="context-menu-icon-button"
            onClick={() => {
              const folder = desktopLayout.items.find((item): item is DesktopFolderLayoutItem => item.type === 'folder' && item.id === folderContextMenu.folderId);
              setRenameFolderDialog({ folderId: folderContextMenu.folderId, name: folder?.name ?? t('desktop.folder.defaultName', settings.language) });
              setFolderContextMenu(null);
            }}
          >
            <ContextMenuIcon name="rename" />
            {t('desktop.menu.rename', settings.language)}
          </button>
          <button
            type="button"
            role="menuitem"
            className="context-menu-icon-button danger-text"
            onClick={() => {
              const { folderId } = folderContextMenu;
              setFolderContextMenu(null);
              deleteFolder(folderId);
            }}
          >
            <ContextMenuIcon name="trash" />
            {t('desktop.menu.deleteFolder', settings.language)}
          </button>
        </div>
      </>,
      document.body,
    ) : null}

    {surfaceContextMenu ? createPortal(
      <>
        <div
          className="context-menu-overlay"
          onClick={() => setSurfaceContextMenu(null)}
          onContextMenu={(event) => { event.preventDefault(); setSurfaceContextMenu(null); }}
        />
        <div
          ref={contextMenuRef}
          className="context-menu"
          style={{ left: surfaceContextMenu.x, top: surfaceContextMenu.y }}
          role="menu"
          tabIndex={-1}
          onKeyDown={(event) => {
            handleModalKeyboardNavigation(event, event.currentTarget, () => setSurfaceContextMenu(null));
            handleRovingKeyboardNavigation(event, event.currentTarget, '[role^="menuitem"]');
          }}
        >
          <button
            type="button"
            role="menuitem"
            className="context-menu-icon-button"
            onClick={() => {
              setSurfaceContextMenu(null);
              createFolder();
            }}
          >
            <ContextMenuIcon name="new-folder" />
            {t('desktop.menu.newFolder', settings.language)}
          </button>
          <div className="context-menu-item-has-submenu">
            <button type="button" role="menuitem" className="context-menu-icon-button" aria-haspopup="menu">
              <ContextMenuIcon name="sort" />
              {t('desktop.menu.sort', settings.language)}
            </button>
            <div className="context-submenu" role="menu" aria-label={t('desktop.menu.sortMode', settings.language)}>
              {desktopSortOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={desktopLayout.sortMode === option.value}
                  className={desktopLayout.sortMode === option.value ? 'checked' : ''}
                  onClick={() => {
                    setSurfaceContextMenu(null);
                    handleSortModeChange(option.value);
                  }}
                >
                  {t(option.labelId, settings.language)}
                </button>
              ))}
            </div>
          </div>
        </div>
      </>,
      document.body,
    ) : null}

    {capabilityNoticeAppKey ? createPortal(
      <div className="notepad-modal-overlay" role="presentation" onClick={closeCapabilityNotice}>
        <section
          ref={capabilityDialogRef}
          className="notepad-modal desktop-capability-dialog"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="desktop-capability-dialog-title"
          tabIndex={-1}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => handleModalKeyboardNavigation(
            event,
            event.currentTarget,
            closeCapabilityNotice,
          )}
        >
          <div id="desktop-capability-dialog-title" className="notepad-modal-title">
            {t('desktop.capability.dialogTitle', settings.language, {
              app: getAppLabel(getAppInfo(capabilityNoticeAppKey), settings.language),
            })}
          </div>
          <div className="notepad-modal-message">
            {desktopCapabilitySnapshot[capabilityNoticeAppKey].status === 'unsupported' ? (
              <p>{t('desktop.capability.unsupportedMessage', settings.language, {
                systems: getAppCapability(capabilityNoticeAppKey).supportedSystems.join(' / '),
              })}</p>
            ) : desktopCapabilitySnapshot[capabilityNoticeAppKey].status === 'missing' ? (
              <p>{t('desktop.capability.missingMessage', settings.language, {
                tools: desktopCapabilitySnapshot[capabilityNoticeAppKey].missingTools.join(', '),
              })}</p>
            ) : (
              <p>{t('desktop.capability.checkingMessage', settings.language)}</p>
            )}
          </div>
          <div className="notepad-modal-actions">
            <button type="button" className="notepad-modal-btn" onClick={closeCapabilityNotice}>
              {t('common.close', settings.language)}
            </button>
            {desktopCapabilitySnapshot[capabilityNoticeAppKey].status !== 'unsupported' ? (
              <button
                type="button"
                className="notepad-modal-btn primary"
                onClick={() => {
                  void refreshDesktopCapabilities(true).finally(closeCapabilityNotice);
                }}
              >
                {t('desktop.capability.refresh', settings.language)}
              </button>
            ) : null}
          </div>
        </section>
      </div>,
      document.body,
    ) : null}

    {renameFolderDialog ? createPortal(
      <div className="notepad-modal-overlay" role="presentation" onClick={() => setRenameFolderDialog(null)}>
        <form
          ref={renameDialogRef}
          className="notepad-modal desktop-folder-rename-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="desktop-folder-rename-title"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => handleModalKeyboardNavigation(
            event,
            event.currentTarget,
            () => setRenameFolderDialog(null),
          )}
          onSubmit={submitFolderRename}
        >
          <div id="desktop-folder-rename-title" className="notepad-modal-title">{t('desktop.folder.rename', settings.language)}</div>
          <input
            className="notepad-modal-input"
            value={renameFolderDialog.name}
            maxLength={40}
            autoFocus
            onChange={(event) => setRenameFolderDialog({ ...renameFolderDialog, name: event.target.value })}
          />
          <div className="notepad-modal-actions">
            <button type="button" className="notepad-modal-btn" onClick={() => setRenameFolderDialog(null)}>{t('common.cancel', settings.language)}</button>
            <button type="submit" className="notepad-modal-btn primary">{t('common.save', settings.language)}</button>
          </div>
        </form>
      </div>,
      document.body,
    ) : null}

    {terminalTitlebarMenu && terminalTitlebarMenuWindow ? createPortal(
      <>
        <div
          className="context-menu-overlay"
          onClick={() => setTerminalTitlebarMenu(null)}
          onContextMenu={(event) => {
            event.preventDefault();
            setTerminalTitlebarMenu(null);
          }}
        />
        <div
          className="context-menu terminal-titlebar-menu"
          style={{ left: terminalTitlebarMenu.x, top: terminalTitlebarMenu.y }}
          role="menu"
          aria-label={t('terminal.titlebar.tools', settings.language)}
        >
          <>
              <button type="button" role="menuitem" onClick={() => requestTerminalTool(terminalTitlebarMenuWindow.id, 'new-terminal')}>
                {t('terminal.titlebar.newWindow', settings.language)}
              </button>
              <button type="button" role="menuitem" onClick={() => requestTerminalTool(terminalTitlebarMenuWindow.id, 'search')}>
                {t('terminal.titlebar.searchOutput', settings.language)}
              </button>
              <button type="button" role="menuitem" onClick={() => requestTerminalTool(terminalTitlebarMenuWindow.id, 'clear')}>
                {t('terminal.titlebar.clear', settings.language)}
              </button>
              {connection.host.systemType !== 'windows' ? (
            <div className="context-menu-item-has-submenu terminal-titlebar-tmux-menu">
              <button type="button" role="menuitem" aria-haspopup="menu">
                {t('terminal.tmux.menu', settings.language)}
              </button>
              <div className="context-submenu terminal-titlebar-tmux-submenu" role="menu" aria-label={t('terminal.tmux.menu', settings.language)}>
                <button type="button" role="menuitem" onClick={openNewTmuxTerminal}>
                  {t('terminal.tmux.newSession', settings.language)}
                </button>
                <button type="button" role="menuitem" onClick={(event) => {
                  event.stopPropagation();
                  void refreshTmuxSessions();
                }}>
                  {t('terminal.tmux.refresh', settings.language)}
                </button>
                <div className="context-menu-sep" />
                {tmuxMenuState.status === 'loading' ? (
                  <button type="button" role="menuitem" disabled>
                    {t('terminal.tmux.loading', settings.language)}
                  </button>
                ) : null}
                {tmuxMenuState.status === 'error' ? (
                  <button type="button" role="menuitem" className="terminal-titlebar-tmux-message" disabled title={tmuxMenuState.error}>
                    {tmuxMenuState.error || t('terminal.tmux.notInstalled', settings.language)}
                  </button>
                ) : null}
                {tmuxMenuState.status === 'ready' && tmuxMenuState.sessions.length === 0 ? (
                  <button type="button" role="menuitem" disabled>
                    {t('terminal.tmux.empty', settings.language)}
                  </button>
                ) : null}
                {tmuxMenuState.sessions.map((session) => (
                  <button
                    key={session.name}
                    type="button"
                    role="menuitem"
                    className="terminal-titlebar-tmux-session-button"
                    title={t('terminal.tmux.attachSession', settings.language, { name: session.name })}
                    onClick={() => openTmuxTerminal(session.name, 'attach')}
                  >
                    <span className="terminal-titlebar-tmux-session-text">
                      <strong>{session.name}</strong>
                      <small>
                        {t('terminal.tmux.sessionMeta', settings.language, {
                          windows: String(session.windows),
                          attached: String(session.attached),
                        })}
                      </small>
                    </span>
                  </button>
                ))}
              </div>
            </div>
              ) : null}
              {(settings.terminalSnippets ?? []).length ? (
                <div className="context-menu-item-has-submenu terminal-titlebar-snippets-menu">
                  <button type="button" role="menuitem" aria-haspopup="menu">
                    {t('terminal.titlebar.snippets', settings.language)}
                  </button>
                  <div className="context-submenu terminal-titlebar-snippets-submenu" role="menu" aria-label={t('terminal.titlebar.snippets', settings.language)}>
                    {getTerminalSnippetGroups(settings.terminalSnippets ?? [], settings.language).map((group) => (
                      <div key={group.label} className="terminal-titlebar-snippet-group" role="presentation">
                        <div className="terminal-titlebar-snippet-group-label">{group.label}</div>
                        {group.snippets.map((snippet) => (
                          <button
                            key={snippet.id}
                            type="button"
                            role="menuitem"
                            className="terminal-titlebar-snippet-button"
                            title={snippet.command}
                            onClick={() => requestTerminalCommand(terminalTitlebarMenuWindow.id, snippet.command, 'snippet')}
                          >
                            <span className="terminal-titlebar-snippet-text">
                              <strong>{snippet.label}</strong>
                              <small>{getTerminalSnippetPreview(snippet)}</small>
                            </span>
                            {snippet.shortcut ? <kbd>{snippet.shortcut}</kbd> : null}
                          </button>
                        ))}
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <button type="button" role="menuitem" disabled>
                  {t('terminal.titlebar.noSnippets', settings.language)}
                </button>
              )}
              <div className="context-menu-sep" />
              <button type="button" role="menuitem" onClick={() => requestTerminalTool(terminalTitlebarMenuWindow.id, 'toggle-follow')}>
                {t('terminal.titlebar.toggleFollow', settings.language)}
              </button>
              <button type="button" role="menuitem" onClick={() => requestTerminalTool(terminalTitlebarMenuWindow.id, 'scroll-bottom')}>
                {t('terminal.titlebar.scrollBottom', settings.language)}
              </button>
              {terminalTitlebarMenuWindow.terminalStatus === 'exited' ? (
                <button type="button" role="menuitem" onClick={() => requestTerminalTool(terminalTitlebarMenuWindow.id, 'restart')}>
                  {t('terminal.titlebar.restartSession', settings.language)}
                </button>
              ) : null}
              {onSettingsChange ? (
                <>
                  <div className="context-menu-sep" />
                  <button type="button" role="menuitem" onClick={() => requestTerminalTool(terminalTitlebarMenuWindow.id, 'settings')}>
                    {t('terminal.titlebar.settings', settings.language)}
                  </button>
                </>
              ) : null}
              {terminalTitlebarMenuWindow.terminalLaunchOptions?.mode === 'tmux' ? (
                <>
                  <div className="context-menu-sep" />
                  <button
                    type="button"
                    role="menuitem"
                    className="danger-text"
                    onClick={() => void killTmuxSession(terminalTitlebarMenuWindow)}
                  >
                    {t('terminal.tmux.killCurrent', settings.language)}
                  </button>
                </>
              ) : null}
          </>
        </div>
      </>,
      document.body,
    ) : null}

    {pendingCloseWindow ? createPortal(
      <div className="notepad-modal-overlay" role="presentation" onClick={() => setPendingCloseWindowId('')}>
        <div
          className="notepad-modal"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="terminal-close-confirm-title"
          onClick={(event) => event.stopPropagation()}
        >
          <div id="terminal-close-confirm-title" className="notepad-modal-title">{t('terminal.closeConfirm.title', settings.language)}</div>
          <div className="notepad-modal-message">
            {t('terminal.closeConfirm.message', settings.language)}
          </div>
          <div className="notepad-modal-actions">
            <button type="button" className="notepad-modal-btn" onClick={() => setPendingCloseWindowId('')}>{t('common.cancel', settings.language)}</button>
            <button type="button" className="notepad-modal-btn danger" onClick={() => {
              const windowId = pendingCloseWindow.id;
              setPendingCloseWindowId('');
              removeDesktopWindow(windowId);
            }}>
              {t('common.close', settings.language)}
            </button>
          </div>
        </div>
      </div>,
      document.body,
    ) : null}
  </>
  );
}

export default RemoteDesktopShell;

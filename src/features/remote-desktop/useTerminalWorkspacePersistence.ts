import {
  type Dispatch,
  type MutableRefObject,
  type RefObject,
  type SetStateAction,
  useEffect,
  useRef,
} from 'react';

import {
  clampWindowFrame,
  createDesktopWindow,
  getMaximizedWindowFrame,
  type DesktopWindowState,
} from '../../remoteDesktopWindowModel';
import {
  createTerminalWorkspaceSnapshot,
  readTerminalWorkspace,
  terminalWorkspaceStorageKey,
  writeTerminalWorkspace,
} from '../../terminalWorkspace';
import type { RemoteConnectionInfo } from '../../components/remote-desktop/types';
import { t } from '../../i18n';

interface UseTerminalWorkspacePersistenceOptions {
  host: RemoteConnectionInfo['host'];
  language: ShellDeskAppSettings['language'];
  enabled: boolean;
  dockPosition: ShellDeskRemoteDesktopDockPosition;
  dockSize: ShellDeskRemoteDesktopDockSize;
  dockAutoHide: ShellDeskRemoteDesktopDockAutoHide;
  desktopSurfaceRef: RefObject<HTMLElement | null>;
  desktopWindows: DesktopWindowState[];
  windowSequenceRef: MutableRefObject<number>;
  zIndexRef: MutableRefObject<number>;
  setDesktopWindows: Dispatch<SetStateAction<DesktopWindowState[]>>;
  setFocusedWindowId: Dispatch<SetStateAction<string>>;
}

export function useTerminalWorkspacePersistence({
  host,
  language,
  enabled,
  dockPosition,
  dockSize,
  dockAutoHide,
  desktopSurfaceRef,
  desktopWindows,
  windowSequenceRef,
  zIndexRef,
  setDesktopWindows,
  setFocusedWindowId,
}: UseTerminalWorkspacePersistenceOptions) {
  const saveTimerRef = useRef<number | null>(null);
  const hydratedKeyRef = useRef('');
  const skipNextSaveRef = useRef(false);
  const storageKey = terminalWorkspaceStorageKey(host);
  const shouldReserveDockSpace = (isMaximized: boolean) => (
    dockAutoHide === 'never' || (dockAutoHide === 'maximized' && !isMaximized)
  );

  useEffect(() => {
    if (!enabled) {
      hydratedKeyRef.current = '';
      return;
    }
    if (hydratedKeyRef.current === storageKey) return;
    hydratedKeyRef.current = storageKey;
    skipNextSaveRef.current = true;
    const snapshot = readTerminalWorkspace(window.localStorage, storageKey);
    if (!snapshot?.windows.length) return;

    const surface = desktopSurfaceRef.current;
    setDesktopWindows((currentWindows) => {
      if (currentWindows.some((desktopWindow) => desktopWindow.appKey === 'terminal')) {
        return currentWindows;
      }
      const restoredWindows = snapshot.windows.map((entry) => {
        windowSequenceRef.current += 1;
        zIndexRef.current += 1;
        const restoredWindow = createDesktopWindow(
          'terminal',
          windowSequenceRef.current,
          zIndexRef.current,
          language,
        );
        const normalFrame = surface
          ? clampWindowFrame(
              entry.frame,
              surface.clientWidth,
              surface.clientHeight,
              dockPosition,
              dockSize,
              shouldReserveDockSpace(false),
            )
          : entry.frame;
        restoredWindow.frame = normalFrame;
        restoredWindow.isMinimized = entry.isMinimized;
        restoredWindow.terminalLaunchOptions = entry.launchOptions;
        restoredWindow.terminalRestorePending = true;
        restoredWindow.terminalStatus = 'disconnected';
        restoredWindow.chromeTitle = entry.launchOptions?.title
          || t('terminal.workspace.restoreTitle', language);
        restoredWindow.chromeStatus = t('terminal.status.disconnected', language);
        restoredWindow.chromeTone = 'idle';
        if (entry.isMaximized && surface) {
          restoredWindow.previousFrame = normalFrame;
          restoredWindow.frame = getMaximizedWindowFrame(
            surface.clientWidth,
            surface.clientHeight,
            dockPosition,
            dockSize,
            shouldReserveDockSpace(true),
          );
          restoredWindow.isMaximized = true;
        }
        return restoredWindow;
      });
      const visibleRestoredWindow = [...restoredWindows]
        .reverse()
        .find((desktopWindow) => !desktopWindow.isMinimized);
      setFocusedWindowId(visibleRestoredWindow?.id ?? '');
      return [...currentWindows, ...restoredWindows];
    });
  }, [
    desktopSurfaceRef,
    dockAutoHide,
    dockPosition,
    dockSize,
    enabled,
    language,
    setDesktopWindows,
    setFocusedWindowId,
    storageKey,
    windowSequenceRef,
    zIndexRef,
  ]);

  useEffect(() => {
    if (skipNextSaveRef.current) {
      skipNextSaveRef.current = false;
      return undefined;
    }
    if (!enabled) {
      writeTerminalWorkspace(
        window.localStorage,
        storageKey,
        createTerminalWorkspaceSnapshot([]),
      );
      return undefined;
    }
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      writeTerminalWorkspace(
        window.localStorage,
        storageKey,
        createTerminalWorkspaceSnapshot(desktopWindows),
      );
    }, 160);
    return () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, [desktopWindows, enabled, storageKey]);
}

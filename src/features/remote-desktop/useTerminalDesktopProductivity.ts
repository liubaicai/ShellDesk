import { useRef, useState, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from 'react';

import type { RemoteTerminalBroadcastRequest } from '../../components/remote-desktop/terminalTypes';
import {
  completeTerminalBroadcastRequest as removeTerminalBroadcastRequest,
  enqueueTerminalBroadcastRequest,
} from '../../components/remote-desktop/terminalBroadcast';
import {
  createDesktopWindow,
  getDesktopWindowWorkspace,
  getTopDesktopWindow,
  type DesktopWindowState,
  type TerminalTitlebarMenuState,
} from '../../remoteDesktopWindowModel';
import { createTerminalWorkspaceCloneEntries } from '../../terminalWorkspace';

interface TerminalDesktopProductivityOptions {
  language: ShellDeskAppSettings['language'];
  dockPosition: ShellDeskRemoteDesktopDockPosition;
  dockSize: ShellDeskRemoteDesktopDockSize;
  reserveDockSpace: boolean;
  sftpFollowCwd: boolean;
  desktopSurfaceRef: RefObject<HTMLElement | null>;
  desktopWindowsRef: MutableRefObject<DesktopWindowState[]>;
  windowSequenceRef: MutableRefObject<number>;
  zIndexRef: MutableRefObject<number>;
  setDesktopWindows: Dispatch<SetStateAction<DesktopWindowState[]>>;
  setFocusedWindowId: Dispatch<SetStateAction<string>>;
  setTerminalTitlebarMenu: Dispatch<SetStateAction<TerminalTitlebarMenuState | null>>;
}

export function useTerminalDesktopProductivity({
  language,
  dockPosition,
  dockSize,
  reserveDockSpace,
  sftpFollowCwd,
  desktopSurfaceRef,
  desktopWindowsRef,
  windowSequenceRef,
  zIndexRef,
  setDesktopWindows,
  setFocusedWindowId,
  setTerminalTitlebarMenu,
}: TerminalDesktopProductivityOptions) {
  const broadcastSequenceRef = useRef(0);
  const [terminalBroadcastEnabled, setTerminalBroadcastEnabled] = useState(false);

  const cloneTerminalWorkspace = () => {
    const surface = desktopSurfaceRef.current;
    if (!surface) return;
    const workspace = getDesktopWindowWorkspace(surface.clientWidth, surface.clientHeight, dockPosition, dockSize, reserveDockSpace);
    const entries = createTerminalWorkspaceCloneEntries(desktopWindowsRef.current, workspace);
    if (!entries.length) return;
    const clonedWindows = entries.map((entry) => {
      windowSequenceRef.current += 1;
      zIndexRef.current += 1;
      const window = createDesktopWindow('terminal', windowSequenceRef.current, zIndexRef.current, language);
      window.frame = entry.frame;
      window.terminalLaunchOptions = entry.launchOptions;
      window.terminalWorkingDirectory = entry.launchOptions?.workingDirectory;
      return window;
    });
    setDesktopWindows((current) => [...current, ...clonedWindows]);
    setFocusedWindowId(clonedWindows.at(-1)?.id ?? '');
    setTerminalTitlebarMenu(null);
  };

  const handleTerminalWorkingDirectoryChange = (windowId: string, directoryPath: string) => {
    const path = directoryPath.trim();
    if (!path) return;
    setDesktopWindows((current) => {
      const filesWindow = sftpFollowCwd
        ? getTopDesktopWindow(current, (window) => window.appKey === 'files')
        : null;
      return current.map((window) => {
        if (window.id === windowId && window.appKey === 'terminal') return { ...window, terminalWorkingDirectory: path };
        if (filesWindow && window.id === filesWindow.id) return { ...window, fileExplorerInitialPath: path };
        return window;
      });
    });
  };

  const broadcastTerminalInput = (sourceTerminalId: string, data: string) => {
    broadcastSequenceRef.current += 1;
    const baseId = `terminal-broadcast-${broadcastSequenceRef.current}`;
    setDesktopWindows((current) => current.map((window) => {
      const targetTerminalId = window.terminalId ?? window.id;
      if (window.appKey !== 'terminal' || targetTerminalId === sourceTerminalId || window.terminalRestorePending || window.terminalStatus !== 'running') return window;
      const terminalBroadcastRequest: RemoteTerminalBroadcastRequest = {
        id: `${baseId}-${window.id}`,
        sourceTerminalId,
        data,
      };
      const terminalBroadcastRequests = enqueueTerminalBroadcastRequest(
        window.terminalBroadcastRequests,
        terminalBroadcastRequest,
      );
      return terminalBroadcastRequests === window.terminalBroadcastRequests
        ? window
        : { ...window, terminalBroadcastRequests };
    }));
  };

  const completeTerminalBroadcastRequest = (windowId: string, requestId: string) => {
    setDesktopWindows((current) => current.map((window) => {
      if (window.id !== windowId) return window;
      const terminalBroadcastRequests = removeTerminalBroadcastRequest(
        window.terminalBroadcastRequests,
        requestId,
      );
      return terminalBroadcastRequests === window.terminalBroadcastRequests
        ? window
        : { ...window, terminalBroadcastRequests };
    }));
  };

  return {
    terminalBroadcastEnabled,
    setTerminalBroadcastEnabled,
    cloneTerminalWorkspace,
    handleTerminalWorkingDirectoryChange,
    broadcastTerminalInput,
    completeTerminalBroadcastRequest,
  };
}

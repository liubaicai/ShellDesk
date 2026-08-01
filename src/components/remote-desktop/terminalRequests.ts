import { useEffect, type MutableRefObject, type RefObject } from 'react';
import type { Terminal as XTerminal } from '@xterm/xterm';

import { isLikelyForegroundCommand } from './terminalCommands';
import type {
  ForegroundTaskSource,
  RemoteTerminalCommandRequest,
  RemoteTerminalSessionEventInput,
  RemoteTerminalSessionStatus,
  RemoteTerminalSplitDirection,
  RemoteTerminalToolRequest,
} from './terminalTypes';

interface TerminalExternalRequestsOptions {
  commandRequest?: RemoteTerminalCommandRequest | null;
  toolRequest?: RemoteTerminalToolRequest | null;
  sessionStatus: RemoteTerminalSessionStatus;
  terminalRef: RefObject<XTerminal | null>;
  sendInputRef: RefObject<((data: string) => void) | null>;
  foregroundTaskSourceRef: MutableRefObject<ForegroundTaskSource | null>;
  handledCommandRequestRef: MutableRefObject<string>;
  handledToolRequestRef: MutableRefObject<string>;
  setHasForegroundTask: (hasForegroundTask: boolean) => void;
  emitSessionEvent: (event: RemoteTerminalSessionEventInput) => void;
  onCommandRequestHandled?: (requestId: string) => void;
  onToolRequestHandled?: (requestId: string) => void;
  openLaunchDialog: () => void;
  clearTerminal: () => void;
  toggleFollowOutput: () => void;
  scrollTerminalToBottom: () => void;
  restartTerminal: () => void;
  openSettingsDialog: () => void;
  openSearch: () => void;
  toggleSessionLog: () => void;
  pasteClipboardImage: () => void;
  toggleCompose: () => void;
  resolveWorkingDirectory: () => Promise<string>;
  onSplitTerminal?: (direction: RemoteTerminalSplitDirection, workingDirectory: string) => void;
}

export function useTerminalExternalRequests({
  commandRequest,
  toolRequest,
  sessionStatus,
  terminalRef,
  sendInputRef,
  foregroundTaskSourceRef,
  handledCommandRequestRef,
  handledToolRequestRef,
  setHasForegroundTask,
  emitSessionEvent,
  onCommandRequestHandled,
  onToolRequestHandled,
  openLaunchDialog,
  clearTerminal,
  toggleFollowOutput,
  scrollTerminalToBottom,
  restartTerminal,
  openSettingsDialog,
  openSearch,
  toggleSessionLog,
  pasteClipboardImage,
  toggleCompose,
  resolveWorkingDirectory,
  onSplitTerminal,
}: TerminalExternalRequestsOptions) {
  useEffect(() => {
    if (!commandRequest || handledCommandRequestRef.current === commandRequest.id || sessionStatus !== 'running') {
      return;
    }

    const terminal = terminalRef.current;

    if (!terminal) {
      return;
    }

    handledCommandRequestRef.current = commandRequest.id;
    terminal.focus();

    if (commandRequest.mode === 'insert') {
      terminal.paste(commandRequest.command);
    } else {
      sendInputRef.current?.(`${commandRequest.command}\r`);

      if (isLikelyForegroundCommand(commandRequest.command)) {
        foregroundTaskSourceRef.current = 'command';
        setHasForegroundTask(true);
      }

      emitSessionEvent({
        type: 'terminal-command',
        command: commandRequest.command,
        source: commandRequest.source ?? 'external',
      });
    }

    onCommandRequestHandled?.(commandRequest.id);
  }, [
    commandRequest,
    emitSessionEvent,
    foregroundTaskSourceRef,
    handledCommandRequestRef,
    onCommandRequestHandled,
    sendInputRef,
    sessionStatus,
    setHasForegroundTask,
    terminalRef,
  ]);

  useEffect(() => {
    if (!toolRequest || handledToolRequestRef.current === toolRequest.id) {
      return;
    }

    handledToolRequestRef.current = toolRequest.id;

    switch (toolRequest.action) {
      case 'new-terminal':
        openLaunchDialog();
        break;
      case 'search':
        openSearch();
        break;
      case 'clear':
        clearTerminal();
        break;
      case 'toggle-follow':
        toggleFollowOutput();
        break;
      case 'scroll-bottom':
        scrollTerminalToBottom();
        break;
      case 'restart':
        restartTerminal();
        break;
      case 'toggle-log':
        toggleSessionLog();
        break;
      case 'paste-image':
        pasteClipboardImage();
        break;
      case 'compose':
        toggleCompose();
        break;
      case 'settings':
        openSettingsDialog();
        break;
      case 'split-right':
      case 'split-down': {
        const direction = toolRequest.action === 'split-right' ? 'right' : 'down';
        void resolveWorkingDirectory().then((workingDirectory) => {
          onSplitTerminal?.(direction, workingDirectory);
        });
        break;
      }
    }

    onToolRequestHandled?.(toolRequest.id);
  }, [
    clearTerminal,
    handledToolRequestRef,
    onToolRequestHandled,
    openLaunchDialog,
    openSearch,
    openSettingsDialog,
    pasteClipboardImage,
    onSplitTerminal,
    resolveWorkingDirectory,
    restartTerminal,
    scrollTerminalToBottom,
    toggleFollowOutput,
    toggleCompose,
    toggleSessionLog,
    toolRequest,
  ]);
}

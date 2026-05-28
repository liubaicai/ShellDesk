import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon, type ISearchOptions } from '@xterm/addon-search';
import { type ITerminalOptions, Terminal as XTerminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import {
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import { getErrorMessage, getShellDeskLocale } from './desktopUtils';
import { isWindowsSystem } from './remoteSystem';
import {
  buildTerminalFontStack,
  getTerminalTheme,
  terminalThemeChoices,
  toTerminalFontWeight,
} from './terminalPresets';
import type { RemoteSystemType } from './types';

export type RemoteTerminalSessionStatus = 'idle' | 'running' | 'exited' | 'disconnected';

export interface RemoteTerminalLaunchOptions {
  title?: string;
  shell?: string;
  initialCommand?: string;
  workingDirectory?: string;
}

export interface RemoteTerminalChromePayload {
  title: string;
  status: string;
  tone: 'idle' | 'loading' | 'error';
}

export interface RemoteTerminalSessionState {
  title: string;
  status: RemoteTerminalSessionStatus;
  lastExitCode: number | null;
}

export interface RemoteTerminalCommandRequest {
  id: string;
  command: string;
  mode: 'insert' | 'run';
  source?: 'snippet' | 'deployment' | 'external';
}

export type RemoteTerminalToolAction =
  | 'new-terminal'
  | 'search'
  | 'clear'
  | 'toggle-follow'
  | 'scroll-bottom'
  | 'restart'
  | 'settings';

export interface RemoteTerminalToolRequest {
  id: string;
  action: RemoteTerminalToolAction;
}

export type RemoteTerminalSessionEvent =
  | {
      type: 'terminal-command';
      terminalId: string;
      timestamp: string;
      title: string;
      command: string;
      source: 'keyboard' | 'snippet' | 'deployment' | 'external';
    }
  | {
      type: 'terminal-output';
      terminalId: string;
      timestamp: string;
      title: string;
      summary: string;
      truncated: boolean;
    };

type RemoteTerminalSessionEventInput =
  | Omit<Extract<RemoteTerminalSessionEvent, { type: 'terminal-command' }>, 'terminalId' | 'timestamp' | 'title'>
  | Omit<Extract<RemoteTerminalSessionEvent, { type: 'terminal-output' }>, 'terminalId' | 'timestamp' | 'title'>;

interface RemoteTerminalProps {
  connectionId: string;
  terminalId: string;
  settings: ShellDeskAppSettings;
  systemType?: RemoteSystemType;
  launchOptions?: RemoteTerminalLaunchOptions;
  commandRequest?: RemoteTerminalCommandRequest | null;
  toolRequest?: RemoteTerminalToolRequest | null;
  onChromeChange?: (payload: RemoteTerminalChromePayload) => void;
  onCommandRequestHandled?: (requestId: string) => void;
  onToolRequestHandled?: (requestId: string) => void;
  onOpenTerminal?: (options?: RemoteTerminalLaunchOptions) => void;
  onOpenNote?: (note: { title: string; content: string }) => void;
  onSessionEvent?: (event: RemoteTerminalSessionEvent) => void;
  onSessionStateChange?: (state: RemoteTerminalSessionState) => void;
  onSettingsChange?: (settings: ShellDeskAppSettings) => void;
}

interface TerminalContextMenuState {
  x: number;
  y: number;
  selection: string;
}

interface TerminalSearchResultState {
  index: number;
  count: number;
}

const outputSummaryLimit = 1200;
const terminalSearchOptions: ISearchOptions = {
  decorations: {
    matchBackground: '#2d5d76',
    matchOverviewRuler: '#43c7ff',
    activeMatchBackground: '#77f4c5',
    activeMatchColorOverviewRuler: '#77f4c5',
  },
};
const ansiOscPattern = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g;
const ansiCsiPattern = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const controlCharacterPattern = /[\x00-\x08\x0b-\x1f\x7f]/g;

function buildTerminalOptions(settings: ShellDeskAppSettings): ITerminalOptions {
  return {
    allowTransparency: true,
    altClickMovesCursor: settings.terminalAltClickMovesCursor,
    cursorBlink: settings.terminalCursorBlink,
    cursorInactiveStyle: settings.terminalCursorInactiveStyle,
    cursorStyle: settings.terminalCursorStyle,
    customGlyphs: true,
    fontFamily: buildTerminalFontStack(settings.terminalFontFamily),
    fontSize: settings.terminalFontSize,
    fontWeight: toTerminalFontWeight(settings.terminalFontWeight),
    fontWeightBold: toTerminalFontWeight(settings.terminalFontWeightBold),
    ignoreBracketedPasteMode: !settings.terminalBracketedPasteMode,
    lineHeight: settings.terminalLineHeight,
    minimumContrastRatio: settings.terminalMinimumContrastRatio,
    screenReaderMode: settings.terminalScreenReaderMode,
    scrollback: settings.terminalScrollback,
    scrollOnEraseInDisplay: settings.terminalScrollOnEraseInDisplay,
    scrollOnUserInput: settings.terminalScrollOnUserInput,
    scrollSensitivity: settings.terminalScrollSensitivity,
    fastScrollSensitivity: settings.terminalFastScrollSensitivity,
    theme: { ...getTerminalTheme(settings.terminalTheme) },
  };
}

function applyTerminalOptions(terminal: XTerminal, settings: ShellDeskAppSettings) {
  const { allowTransparency: _allowTransparency, ...terminalOptions } = buildTerminalOptions(settings);
  terminal.options = terminalOptions;
}

function getTerminalSessionTitle(terminalId: string, options?: RemoteTerminalLaunchOptions) {
  const configuredTitle = options?.title?.trim();

  if (configuredTitle) {
    return configuredTitle;
  }

  const workingDirectory = options?.workingDirectory?.trim();

  if (workingDirectory) {
    return workingDirectory;
  }

  return terminalId;
}

function getTerminalStatusLabel(status: RemoteTerminalSessionStatus, hasError: boolean) {
  if (status === 'running') {
    return '运行中';
  }

  if (status === 'disconnected') {
    return '已断开';
  }

  if (status === 'exited') {
    return hasError ? '启动失败' : '已结束';
  }

  return '启动中';
}

function getTerminalChromeTone(status: RemoteTerminalSessionStatus, hasError: boolean): RemoteTerminalChromePayload['tone'] {
  if (status === 'idle') {
    return 'loading';
  }

  if (status === 'running' && !hasError) {
    return 'idle';
  }

  return 'error';
}

function stripTerminalControlSequences(data: string) {
  return data
    .replace(ansiOscPattern, '')
    .replace(ansiCsiPattern, '')
    .replace(controlCharacterPattern, '')
    .replace(/\r/g, '');
}

function summarizeTerminalOutput(data: string) {
  const summary = stripTerminalControlSequences(data).trim();

  if (!summary) {
    return null;
  }

  if (summary.length <= outputSummaryLimit) {
    return { summary, truncated: false };
  }

  return {
    summary: summary.slice(-outputSummaryLimit),
    truncated: true,
  };
}

function formatTroubleshootingSnippet(selection: string) {
  return selection
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => (line.trim() ? `$ ${line}` : '$'))
    .join('\n');
}

function collectSubmittedCommands(currentBuffer: string, data: string) {
  if (data.includes('\x1b')) {
    return { buffer: currentBuffer, commands: [] as string[] };
  }

  let nextBuffer = currentBuffer;
  const commands: string[] = [];

  for (const character of data) {
    if (character === '\r' || character === '\n') {
      const command = nextBuffer.trim();

      if (command) {
        commands.push(command);
      }

      nextBuffer = '';
      continue;
    }

    if (character === '\x7f') {
      nextBuffer = nextBuffer.slice(0, -1);
      continue;
    }

    if (character === '\x03') {
      nextBuffer = '';
      continue;
    }

    if (character >= ' ') {
      nextBuffer += character;
    }
  }

  return { buffer: nextBuffer, commands };
}

function getShellChoices(systemType?: RemoteSystemType) {
  return isWindowsSystem(systemType)
    ? ['', 'powershell', 'pwsh', 'cmd']
    : ['', 'bash', 'zsh', 'fish', 'sh'];
}

function RemoteTerminal({
  connectionId,
  terminalId,
  settings,
  systemType,
  launchOptions,
  commandRequest,
  toolRequest,
  onChromeChange,
  onCommandRequestHandled,
  onToolRequestHandled,
  onOpenTerminal,
  onOpenNote,
  onSessionEvent,
  onSessionStateChange,
  onSettingsChange,
}: RemoteTerminalProps) {
  const terminalHostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<XTerminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const fitAndSyncSizeRef = useRef<(() => void) | null>(null);
  const restartTerminalRef = useRef<(() => void) | null>(null);
  const sendInputRef = useRef<((data: string) => void) | null>(null);
  const lastSizeRef = useRef({ columns: 0, rows: 0 });
  const isTerminalReadyRef = useRef(false);
  const useLegacyTerminalIpcRef = useRef(false);
  const settingsRef = useRef(settings);
  const launchOptionsRef = useRef(launchOptions);
  const followOutputRef = useRef(true);
  const commandBufferRef = useRef('');
  const handledCommandRequestRef = useRef('');
  const handledToolRequestRef = useRef('');
  const onSessionEventRef = useRef(onSessionEvent);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [sessionStatus, setSessionStatus] = useState<RemoteTerminalSessionStatus>('idle');
  const [sessionError, setSessionError] = useState('');
  const [lastExitCode, setLastExitCode] = useState<number | null>(null);
  const [followOutput, setFollowOutput] = useState(true);
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<TerminalSearchResultState>({ index: -1, count: 0 });
  const [contextMenu, setContextMenu] = useState<TerminalContextMenuState | null>(null);
  const [isLaunchDialogOpen, setIsLaunchDialogOpen] = useState(false);
  const [isSettingsDialogOpen, setIsSettingsDialogOpen] = useState(false);
  const [launchDraft, setLaunchDraft] = useState<Required<RemoteTerminalLaunchOptions>>({
    title: '',
    shell: '',
    initialCommand: '',
    workingDirectory: '',
  });
  const terminalTheme = getTerminalTheme(settings.terminalTheme);
  const sessionTitle = getTerminalSessionTitle(terminalId, launchOptions);
  const shellChoices = useMemo(() => getShellChoices(systemType), [systemType]);
  const terminalPaneStyle = useMemo(() => ({
    '--terminal-background': terminalTheme.background ?? '#181a24',
    '--terminal-font-feature-settings': settings.terminalFontLigatures ? '"calt" 1, "liga" 1' : '"calt" 0, "liga" 0',
    '--terminal-font-ligatures': settings.terminalFontLigatures ? 'normal' : 'none',
  }) as CSSProperties, [settings.terminalFontLigatures, settings.terminalTheme, terminalTheme.background]);

  const emitSessionEvent = useCallback((event: RemoteTerminalSessionEventInput) => {
    onSessionEventRef.current?.({
      ...event,
      terminalId,
      timestamp: new Date().toISOString(),
      title: sessionTitle,
    } as RemoteTerminalSessionEvent);
  }, [sessionTitle, terminalId]);

  const writeClipboardText = useCallback((text: string) => {
    if (!text) {
      return;
    }

    navigator.clipboard.writeText(text).catch((error: unknown) => {
      terminalRef.current?.writeln(`\r\n复制失败：${getErrorMessage(error)}`);
    });
  }, []);

  const focusTerminal = useCallback(() => {
    terminalRef.current?.focus();
  }, []);

  const scrollTerminalToBottom = useCallback(() => {
    terminalRef.current?.scrollToBottom();
    focusTerminal();
  }, [focusTerminal]);

  const clearTerminal = useCallback(() => {
    terminalRef.current?.clear();
    focusTerminal();
  }, [focusTerminal]);

  const toggleFollowOutput = useCallback(() => {
    setFollowOutput((currentFollowOutput) => {
      const nextFollowOutput = !currentFollowOutput;

      if (nextFollowOutput) {
        terminalRef.current?.scrollToBottom();
      }

      return nextFollowOutput;
    });
    focusTerminal();
  }, [focusTerminal]);

  const closeSearch = useCallback(() => {
    setShowSearch(false);
    setSearchQuery('');
    setSearchResults({ index: -1, count: 0 });
    searchAddonRef.current?.clearDecorations();
    focusTerminal();
  }, [focusTerminal]);

  const searchTerminal = useCallback((direction: 'next' | 'previous', query = searchQuery) => {
    const searchAddon = searchAddonRef.current;
    const term = query.trim();

    if (!searchAddon || !term) {
      return;
    }

    if (direction === 'previous') {
      searchAddon.findPrevious(term, terminalSearchOptions);
      return;
    }

    searchAddon.findNext(term, {
      ...terminalSearchOptions,
      incremental: true,
    });
  }, [searchQuery]);

  const openLaunchDialog = useCallback(() => {
    setLaunchDraft({
      title: '',
      shell: '',
      initialCommand: '',
      workingDirectory: launchOptions?.workingDirectory?.trim() ?? '',
    });
    setIsLaunchDialogOpen(true);
  }, [launchOptions?.workingDirectory]);

  const submitLaunchDialog = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    onOpenTerminal?.({
      title: launchDraft.title.trim() || undefined,
      shell: launchDraft.shell.trim() || undefined,
      initialCommand: launchDraft.initialCommand.trim() || undefined,
      workingDirectory: launchDraft.workingDirectory.trim() || undefined,
    });
    setIsLaunchDialogOpen(false);
  }, [launchDraft, onOpenTerminal]);

  const handleSearchKeyDown = useCallback((event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeSearch();
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      searchTerminal(event.shiftKey ? 'previous' : 'next');
    }
  }, [closeSearch, searchTerminal]);

  const updateTerminalSetting = useCallback(<Field extends keyof ShellDeskAppSettings>(
    field: Field,
    value: ShellDeskAppSettings[Field],
  ) => {
    onSettingsChange?.({
      ...settings,
      [field]: value,
    });
  }, [onSettingsChange, settings]);

  useEffect(() => {
    settingsRef.current = settings;
    const terminal = terminalRef.current;

    if (!terminal) {
      return undefined;
    }

    applyTerminalOptions(terminal, settings);
    const animationFrame = window.requestAnimationFrame(() => {
      fitAndSyncSizeRef.current?.();
    });

    return () => {
      window.cancelAnimationFrame(animationFrame);
    };
  }, [settings]);

  useEffect(() => {
    onSessionEventRef.current = onSessionEvent;
  }, [onSessionEvent]);

  useEffect(() => {
    launchOptionsRef.current = launchOptions;
  }, [launchOptions]);

  useEffect(() => {
    followOutputRef.current = followOutput;
  }, [followOutput]);

  useEffect(() => {
    if (showSearch) {
      window.requestAnimationFrame(() => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      });
    }
  }, [showSearch]);

  useEffect(() => {
    const status = getTerminalStatusLabel(sessionStatus, Boolean(sessionError));
    const payload = {
      title: sessionTitle,
      status,
      tone: getTerminalChromeTone(sessionStatus, Boolean(sessionError)),
    };

    onChromeChange?.(payload);
    onSessionStateChange?.({
      title: sessionTitle,
      status: sessionStatus,
      lastExitCode,
    });
  }, [lastExitCode, onChromeChange, onSessionStateChange, sessionError, sessionStatus, sessionTitle]);

  useEffect(() => {
    const host = terminalHostRef.current;
    const api = window.guiSSH;

    if (!host || !api?.connections || !api.events) {
      setSessionError('当前运行环境不支持终端。');
      setSessionStatus('exited');
      return;
    }

    let disposed = false;
    let animationFrame = 0;
    let startWarningTimer = 0;
    const supportsTerminalIpcOptions = typeof api.connections.getIpcCapabilities === 'function';
    const terminal = new XTerminal(buildTerminalOptions(settingsRef.current));
    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon({ highlightLimit: 500 });

    isTerminalReadyRef.current = false;
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    searchAddonRef.current = searchAddon;
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(searchAddon);
    terminal.open(host);
    terminal.focus();
    setSessionStatus('idle');
    setSessionError('');
    setLastExitCode(null);

    terminal.attachCustomKeyEventHandler((event) => {
      const shouldOpenSearch = event.type === 'keydown' &&
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === 'f';

      if (shouldOpenSearch) {
        setShowSearch(true);
        return false;
      }

      return true;
    });

    const handleTerminalContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      const selection = terminal.getSelection();

      if (selection) {
        setContextMenu({
          x: event.clientX,
          y: event.clientY,
          selection,
        });
        terminal.focus();
        return;
      }

      if (!isTerminalReadyRef.current || !settingsRef.current.terminalRightClickPaste) {
        terminal.focus();
        return;
      }

      navigator.clipboard
        .readText()
        .then((text) => {
          if (!text) {
            terminal.focus();
            return;
          }

          terminal.focus();
          terminal.paste(text);
        })
        .catch((error: unknown) => {
          terminal.writeln(`\r\n粘贴失败：${getErrorMessage(error)}`);
        });
    };

    host.addEventListener('contextmenu', handleTerminalContextMenu);

    const selectionDisposable = terminal.onSelectionChange(() => {
      if (!settingsRef.current.terminalCopyOnSelect || !terminal.hasSelection()) {
        return;
      }

      const selection = terminal.getSelection();

      if (selection) {
        navigator.clipboard.writeText(selection).catch(() => undefined);
      }
    });
    const searchResultDisposable = searchAddon.onDidChangeResults((payload) => {
      setSearchResults({
        index: payload.resultIndex,
        count: payload.resultCount,
      });
    });

    const getTerminalSize = () => {
      try {
        fitAddon.fit();
      } catch {
        return { columns: 100, rows: 30 };
      }

      return {
        columns: Math.min(Math.max(terminal.cols || 100, 20), 300),
        rows: Math.min(Math.max(terminal.rows || 30, 5), 120),
      };
    };

    const fitAndSyncSize = () => {
      if (disposed) {
        return;
      }

      const { columns, rows } = getTerminalSize();

      if (lastSizeRef.current.columns === columns && lastSizeRef.current.rows === rows) {
        return;
      }

      lastSizeRef.current = { columns, rows };

      if (supportsTerminalIpcOptions) {
        api.connections
          .resizeTerminal(connectionId, terminalId, columns, rows, { legacy: useLegacyTerminalIpcRef.current })
          .catch(() => undefined);
        return;
      }

      const resizeTerminal = api.connections.resizeTerminal as unknown as (
        nextConnectionId: string,
        nextColumns: number,
        nextRows: number,
      ) => Promise<boolean>;
      resizeTerminal(connectionId, columns, rows).catch(() => undefined);
    };

    const writeTerminalInput = (data: string) => {
      if (!isTerminalReadyRef.current) {
        return;
      }

      const writePromise = supportsTerminalIpcOptions
        ? api.connections.writeTerminal(connectionId, terminalId, data, { legacy: useLegacyTerminalIpcRef.current })
        : (api.connections.writeTerminal as unknown as (
            nextConnectionId: string,
            nextData: string,
          ) => Promise<boolean>)(connectionId, data);

      writePromise.catch((error: unknown) => {
        terminal.writeln(`\r\n发送失败：${getErrorMessage(error)}`);
      });
    };

    const startTerminalSession = async () => {
      setSessionStatus('idle');
      setSessionError('');
      setLastExitCode(null);
      isTerminalReadyRef.current = false;
      const { columns, rows } = getTerminalSize();

      lastSizeRef.current = { columns, rows };
      startWarningTimer = window.setTimeout(() => {
        if (!disposed && !isTerminalReadyRef.current) {
          terminal.writeln('\r\n终端仍在启动：远程服务器尚未返回 Shell，请检查服务器是否允许交互式登录。');
        }
      }, 12000);

      try {
        const capabilities = supportsTerminalIpcOptions
          ? await api.connections.getIpcCapabilities()
          : { terminalSessions: false };

        if (disposed) {
          return;
        }

        useLegacyTerminalIpcRef.current = !capabilities.terminalSessions;

        if (useLegacyTerminalIpcRef.current) {
          terminal.writeln('检测到旧版 Electron 主进程，使用单终端兼容模式。');
        }

        if (supportsTerminalIpcOptions) {
          await api.connections.startTerminal(connectionId, terminalId, columns, rows, {
            ...launchOptionsRef.current,
            legacy: useLegacyTerminalIpcRef.current,
          });
        } else {
          await (api.connections.startTerminal as unknown as (nextConnectionId: string) => Promise<boolean>)(connectionId);
        }

        window.clearTimeout(startWarningTimer);

        if (disposed) {
          return;
        }

        isTerminalReadyRef.current = true;
        setSessionStatus('running');
        fitAndSyncSize();
        terminal.focus();
      } catch (error) {
        window.clearTimeout(startWarningTimer);

        if (disposed) {
          return;
        }

        const message = getErrorMessage(error);
        setSessionError(message);
        setSessionStatus('exited');
        terminal.writeln(`\r\n终端启动失败：${message}`);
      }
    };

    fitAndSyncSizeRef.current = fitAndSyncSize;
    sendInputRef.current = writeTerminalInput;
    restartTerminalRef.current = () => {
      if (disposed) {
        return;
      }

      terminal.writeln('\r\n正在重新创建终端会话...\r\n');
      void startTerminalSession();
    };

    const removeTerminalData = api.events.onTerminalData((payload) => {
      if (payload.connectionId !== connectionId || (payload.terminalId !== terminalId && payload.terminalId)) {
        return;
      }

      if (!payload.terminalId) {
        useLegacyTerminalIpcRef.current = true;
      }

      const outputSummary = summarizeTerminalOutput(payload.data);

      if (outputSummary) {
        emitSessionEvent({
          type: 'terminal-output',
          summary: outputSummary.summary,
          truncated: outputSummary.truncated,
        });
      }

      terminal.write(payload.data, () => {
        if (followOutputRef.current) {
          terminal.scrollToBottom();
        }
      });

    });
    const removeTerminalExit = api.events.onTerminalExit((payload) => {
      if (payload.connectionId !== connectionId || (payload.terminalId !== terminalId && payload.terminalId)) {
        return;
      }

      isTerminalReadyRef.current = false;
      setLastExitCode(Number.isInteger(payload.code) ? payload.code ?? null : null);
      setSessionStatus('exited');
      terminal.writeln('\r\n终端会话已结束。');
    });
    const removeConnectionClosed = api.events.onConnectionClosed((payload) => {
      if (payload.connectionId !== connectionId) {
        return;
      }

      isTerminalReadyRef.current = false;
      setSessionError(payload.reason ?? '');
      setSessionStatus('disconnected');
      terminal.writeln(`\r\nSSH 连接已断开${payload.reason ? `：${payload.reason}` : '。'}`);
    });
    const inputDisposable = terminal.onData((data) => {
      if (!isTerminalReadyRef.current) {
        return;
      }

      writeTerminalInput(data);
      const commandState = collectSubmittedCommands(commandBufferRef.current, data);
      commandBufferRef.current = commandState.buffer;
      commandState.commands.forEach((command) => {
        emitSessionEvent({
          type: 'terminal-command',
          command,
          source: 'keyboard',
        });
      });
    });
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fitAndSyncSize);

    resizeObserver?.observe(host);
    animationFrame = window.requestAnimationFrame(() => {
      void startTerminalSession();
    });

    return () => {
      disposed = true;
      isTerminalReadyRef.current = false;
      window.clearTimeout(startWarningTimer);
      window.cancelAnimationFrame(animationFrame);
      resizeObserver?.disconnect();
      inputDisposable.dispose();
      selectionDisposable.dispose();
      searchResultDisposable.dispose();
      removeTerminalData();
      removeTerminalExit();
      removeConnectionClosed();

      if (supportsTerminalIpcOptions && !useLegacyTerminalIpcRef.current) {
        api.connections.closeTerminal(connectionId, terminalId).catch(() => undefined);
      }

      host.removeEventListener('contextmenu', handleTerminalContextMenu);
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      searchAddonRef.current = null;
      fitAndSyncSizeRef.current = null;
      restartTerminalRef.current = null;
      sendInputRef.current = null;
    };
  }, [connectionId, emitSessionEvent, terminalId]);

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
      emitSessionEvent({
        type: 'terminal-command',
        command: commandRequest.command,
        source: commandRequest.source ?? 'external',
      });
    }

    onCommandRequestHandled?.(commandRequest.id);
  }, [commandRequest, emitSessionEvent, onCommandRequestHandled, sessionStatus]);

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
        setShowSearch(true);
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
        restartTerminalRef.current?.();
        break;
      case 'settings':
        setIsSettingsDialogOpen(true);
        break;
    }

    onToolRequestHandled?.(toolRequest.id);
  }, [
    clearTerminal,
    onToolRequestHandled,
    openLaunchDialog,
    scrollTerminalToBottom,
    toggleFollowOutput,
    toolRequest,
  ]);

  return (
    <div className="terminal-pane xterm-terminal-pane" style={terminalPaneStyle}>
      {showSearch ? (
        <div className="terminal-searchbar">
          <input
            ref={searchInputRef}
            value={searchQuery}
            onChange={(event) => {
              setSearchQuery(event.target.value);
              searchTerminal('next', event.target.value);
            }}
            onKeyDown={handleSearchKeyDown}
            placeholder="搜索输出"
            spellCheck={false}
          />
          <span>{searchResults.count ? `${Math.max(searchResults.index + 1, 0)} / ${searchResults.count}` : '0 / 0'}</span>
          <button type="button" onClick={() => searchTerminal('previous')} aria-label="上一个匹配" title="上一个匹配">↑</button>
          <button type="button" onClick={() => searchTerminal('next')} aria-label="下一个匹配" title="下一个匹配">↓</button>
          <button type="button" onClick={closeSearch} aria-label="关闭搜索" title="关闭搜索">×</button>
        </div>
      ) : null}

      <div ref={terminalHostRef} className="terminal-host" />

      {contextMenu ? createPortal(
        <>
          <div className="context-menu-overlay" onClick={() => setContextMenu(null)} onContextMenu={(event) => { event.preventDefault(); setContextMenu(null); }} />
          <div className="context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} role="menu">
            <button type="button" role="menuitem" onClick={() => { writeClipboardText(contextMenu.selection); setContextMenu(null); }}>
              复制
            </button>
            <button type="button" role="menuitem" onClick={() => { writeClipboardText(formatTroubleshootingSnippet(contextMenu.selection)); setContextMenu(null); }}>
              复制为排障片段
            </button>
            {onOpenNote ? (
              <button type="button" role="menuitem" onClick={() => {
                onOpenNote({
                  title: `终端片段 ${new Date().toLocaleTimeString(getShellDeskLocale())}`,
                  content: contextMenu.selection,
                });
                setContextMenu(null);
              }}>
                发送到记事本
              </button>
            ) : null}
          </div>
        </>,
        document.body,
      ) : null}

      {isLaunchDialogOpen ? createPortal(
        <div className="notepad-modal-overlay" role="presentation" onClick={() => setIsLaunchDialogOpen(false)}>
          <form
            className="notepad-modal terminal-launch-dialog"
            onSubmit={submitLaunchDialog}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="notepad-modal-title">新建终端窗口</div>
            <label>
              <span>标题</span>
              <input
                className="notepad-modal-input"
                value={launchDraft.title}
                onChange={(event) => setLaunchDraft((currentDraft) => ({ ...currentDraft, title: event.target.value }))}
                placeholder="SSH Shell"
              />
            </label>
            <label>
              <span>Shell</span>
              <select
                className="notepad-modal-input"
                value={launchDraft.shell}
                onChange={(event) => setLaunchDraft((currentDraft) => ({ ...currentDraft, shell: event.target.value }))}
              >
                {shellChoices.map((shellChoice) => (
                  <option key={shellChoice || 'default'} value={shellChoice}>
                    {shellChoice || '默认'}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>工作目录</span>
              <input
                className="notepad-modal-input"
                value={launchDraft.workingDirectory}
                onChange={(event) => setLaunchDraft((currentDraft) => ({ ...currentDraft, workingDirectory: event.target.value }))}
                placeholder={isWindowsSystem(systemType) ? 'C:/Users' : '/srv/app'}
              />
            </label>
            <label>
              <span>初始命令</span>
              <textarea
                value={launchDraft.initialCommand}
                onChange={(event) => setLaunchDraft((currentDraft) => ({ ...currentDraft, initialCommand: event.target.value }))}
                placeholder="uname -a"
              />
            </label>
            <div className="notepad-modal-actions">
              <button type="button" className="notepad-modal-btn" onClick={() => setIsLaunchDialogOpen(false)}>取消</button>
              <button type="submit" className="notepad-modal-btn primary">打开</button>
            </div>
          </form>
        </div>,
        document.body,
      ) : null}

      {isSettingsDialogOpen ? createPortal(
        <div className="notepad-modal-overlay" role="presentation" onClick={() => setIsSettingsDialogOpen(false)}>
          <div className="notepad-modal terminal-settings-dialog" onClick={(event) => event.stopPropagation()}>
            <div className="notepad-modal-title">终端设置</div>
            <label>
              <span>颜色主题</span>
              <select
                className="notepad-modal-input"
                value={settings.terminalTheme}
                onChange={(event) => updateTerminalSetting('terminalTheme', event.target.value as ShellDeskAppSettings['terminalTheme'])}
              >
                {terminalThemeChoices.map((themeChoice) => (
                  <option key={themeChoice.key} value={themeChoice.key}>{themeChoice.label}</option>
                ))}
              </select>
            </label>
            <label>
              <span>字号</span>
              <select
                className="notepad-modal-input"
                value={settings.terminalFontSize}
                onChange={(event) => updateTerminalSetting('terminalFontSize', Number(event.target.value))}
              >
                {[11, 12, 13, 14, 15, 16, 18, 20].map((fontSize) => (
                  <option key={fontSize} value={fontSize}>{fontSize}px</option>
                ))}
              </select>
            </label>
            <div className="terminal-settings-toggles">
              <label>
                <span>选中即复制</span>
                <input
                  type="checkbox"
                  checked={settings.terminalCopyOnSelect}
                  onChange={(event) => updateTerminalSetting('terminalCopyOnSelect', event.target.checked)}
                />
              </label>
              <label>
                <span>右键粘贴</span>
                <input
                  type="checkbox"
                  checked={settings.terminalRightClickPaste}
                  onChange={(event) => updateTerminalSetting('terminalRightClickPaste', event.target.checked)}
                />
              </label>
              <label>
                <span>光标闪烁</span>
                <input
                  type="checkbox"
                  checked={settings.terminalCursorBlink}
                  onChange={(event) => updateTerminalSetting('terminalCursorBlink', event.target.checked)}
                />
              </label>
            </div>
            <div className="notepad-modal-actions">
              <button type="button" className="notepad-modal-btn primary" onClick={() => setIsSettingsDialogOpen(false)}>完成</button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}

export default RemoteTerminal;

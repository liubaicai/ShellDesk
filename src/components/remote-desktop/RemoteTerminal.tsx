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
import { t } from '../../i18n';

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
  hasForegroundTask: boolean;
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

type ForegroundTaskSource = 'alternate-screen' | 'command';

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
const alternateScreenPattern = /\x1b\[\?(?:47|1047|1049)([hl])/g;
const foregroundCommandPattern = /^(?:(?:sudo|doas)\s+)?(?:top(?!\s+-b(?:\s|$))|htop|btop|atop|watch|vim|vi|nvim|nano|less|more|man)(?:\s|$)/i;
const foregroundSequenceBufferLimit = 32;

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

function getTerminalStatusLabel(status: RemoteTerminalSessionStatus, hasError: boolean, language: ShellDeskAppSettings['language']) {
  if (status === 'running') {
    return t('terminal.status.running', language);
  }

  if (status === 'disconnected') {
    return t('terminal.status.disconnected', language);
  }

  if (status === 'exited') {
    return hasError ? t('terminal.status.startFailed', language) : t('terminal.status.exited', language);
  }

  return t('terminal.status.starting', language);
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

function readForegroundTaskSignal(previousBuffer: string, data: string) {
  const combinedData = `${previousBuffer}${data}`;
  let hasForegroundTask: boolean | null = null;
  alternateScreenPattern.lastIndex = 0;
  let match: RegExpExecArray | null = alternateScreenPattern.exec(combinedData);

  while (match) {
    hasForegroundTask = match[1] === 'h';
    match = alternateScreenPattern.exec(combinedData);
  }

  alternateScreenPattern.lastIndex = 0;

  return {
    buffer: combinedData.slice(-foregroundSequenceBufferLimit),
    hasForegroundTask,
  };
}

function isLikelyForegroundCommand(command: string) {
  const trimmedCommand = command.trim();

  if (!trimmedCommand || /[;&|]/.test(trimmedCommand)) {
    return false;
  }

  return foregroundCommandPattern.test(trimmedCommand);
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
  const foregroundSequenceBufferRef = useRef('');
  const foregroundTaskSourceRef = useRef<ForegroundTaskSource | null>(null);
  const handledCommandRequestRef = useRef('');
  const handledToolRequestRef = useRef('');
  const onChromeChangeRef = useRef(onChromeChange);
  const onSessionEventRef = useRef(onSessionEvent);
  const onSessionStateChangeRef = useRef(onSessionStateChange);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [sessionStatus, setSessionStatus] = useState<RemoteTerminalSessionStatus>('idle');
  const [sessionError, setSessionError] = useState('');
  const [lastExitCode, setLastExitCode] = useState<number | null>(null);
  const [hasForegroundTask, setHasForegroundTask] = useState(false);
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
      terminalRef.current?.writeln(`\r\n${t('terminal.error.copyFailed', settings.language, { error: getErrorMessage(error) })}`);
    });
  }, [settings.language]);

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
    onChromeChangeRef.current = onChromeChange;
  }, [onChromeChange]);

  useEffect(() => {
    onSessionStateChangeRef.current = onSessionStateChange;
  }, [onSessionStateChange]);

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
    const status = getTerminalStatusLabel(sessionStatus, Boolean(sessionError), settings.language);
    const payload = {
      title: sessionTitle,
      status,
      tone: getTerminalChromeTone(sessionStatus, Boolean(sessionError)),
    };

    onChromeChangeRef.current?.(payload);
    onSessionStateChangeRef.current?.({
      title: sessionTitle,
      status: sessionStatus,
      lastExitCode,
      hasForegroundTask,
    });
  }, [hasForegroundTask, lastExitCode, sessionError, sessionStatus, sessionTitle, settings.language]);

  useEffect(() => {
    const host = terminalHostRef.current;
    const api = window.guiSSH;

    if (!host || !api?.connections || !api.events) {
      setSessionError(t('terminal.error.unsupported', settings.language));
      setSessionStatus('exited');
      setHasForegroundTask(false);
      foregroundTaskSourceRef.current = null;
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
    setHasForegroundTask(false);
    foregroundSequenceBufferRef.current = '';
    foregroundTaskSourceRef.current = null;

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
          terminal.writeln(`\r\n${t('terminal.error.pasteFailed', settings.language, { error: getErrorMessage(error) })}`);
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
        terminal.writeln(`\r\n${t('terminal.error.sendFailed', settings.language, { error: getErrorMessage(error) })}`);
      });
    };

    const startTerminalSession = async () => {
      setSessionStatus('idle');
      setSessionError('');
      setLastExitCode(null);
      setHasForegroundTask(false);
      foregroundSequenceBufferRef.current = '';
      foregroundTaskSourceRef.current = null;
      isTerminalReadyRef.current = false;
      const { columns, rows } = getTerminalSize();

      lastSizeRef.current = { columns, rows };
      startWarningTimer = window.setTimeout(() => {
        if (!disposed && !isTerminalReadyRef.current) {
          terminal.writeln(`\r\n${t('terminal.message.startWarning', settings.language)}`);
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
          terminal.writeln(t('terminal.message.legacyMode', settings.language));
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
        terminal.writeln(`\r\n${t('terminal.message.startFailed', settings.language, { error: message })}`);
      }
    };

    fitAndSyncSizeRef.current = fitAndSyncSize;
    sendInputRef.current = writeTerminalInput;
    restartTerminalRef.current = () => {
      if (disposed) {
        return;
      }

      terminal.writeln(`\r\n${t('terminal.message.restarting', settings.language)}\r\n`);
      void startTerminalSession();
    };

    const removeTerminalData = api.events.onTerminalData((payload) => {
      if (payload.connectionId !== connectionId || (payload.terminalId !== terminalId && payload.terminalId)) {
        return;
      }

      if (!payload.terminalId) {
        useLegacyTerminalIpcRef.current = true;
      }

      const foregroundSignal = readForegroundTaskSignal(foregroundSequenceBufferRef.current, payload.data);
      foregroundSequenceBufferRef.current = foregroundSignal.buffer;

      if (foregroundSignal.hasForegroundTask !== null) {
        foregroundTaskSourceRef.current = foregroundSignal.hasForegroundTask ? 'alternate-screen' : null;
        setHasForegroundTask(foregroundSignal.hasForegroundTask);
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
      setHasForegroundTask(false);
      foregroundSequenceBufferRef.current = '';
      foregroundTaskSourceRef.current = null;
      setLastExitCode(Number.isInteger(payload.code) ? payload.code ?? null : null);
      setSessionStatus('exited');
      terminal.writeln(`\r\n${t('terminal.message.sessionEnded', settings.language)}`);
    });
    const removeConnectionClosed = api.events.onConnectionClosed((payload) => {
      if (payload.connectionId !== connectionId) {
        return;
      }

      isTerminalReadyRef.current = false;
      setHasForegroundTask(false);
      foregroundSequenceBufferRef.current = '';
      foregroundTaskSourceRef.current = null;
      setSessionError(payload.reason ?? '');
      setSessionStatus('disconnected');
      terminal.writeln(`\r\n${payload.reason ? t('terminal.message.connectionClosedWithReason', settings.language, { reason: payload.reason }) : t('terminal.message.connectionClosed', settings.language)}`);
    });
    const removeConnectionRestored = api.events.onConnectionRestored((payload) => {
      if (payload.connectionId !== connectionId || disposed) {
        return;
      }

      terminal.writeln(`\r\n${t('terminal.message.connectionRestored', settings.language)}\r\n`);
      void startTerminalSession();
    });
    const inputDisposable = terminal.onData((data) => {
      if (!isTerminalReadyRef.current) {
        return;
      }

      writeTerminalInput(data);
      if (
        data.includes('\x03') ||
        data.includes('\x04') ||
        (foregroundTaskSourceRef.current === 'command' && data === 'q')
      ) {
        foregroundTaskSourceRef.current = null;
        setHasForegroundTask(false);
      }

      const commandState = collectSubmittedCommands(commandBufferRef.current, data);
      commandBufferRef.current = commandState.buffer;
      commandState.commands.forEach((command) => {
        if (isLikelyForegroundCommand(command)) {
          foregroundTaskSourceRef.current = 'command';
          setHasForegroundTask(true);
        }

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
      removeConnectionRestored();

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
            placeholder={t('terminal.search.placeholder', settings.language)}
            spellCheck={false}
          />
          <span>{searchResults.count ? `${Math.max(searchResults.index + 1, 0)} / ${searchResults.count}` : '0 / 0'}</span>
          <button type="button" onClick={() => searchTerminal('previous')} aria-label={t('terminal.search.previous', settings.language)} title={t('terminal.search.previous', settings.language)}>↑</button>
          <button type="button" onClick={() => searchTerminal('next')} aria-label={t('terminal.search.next', settings.language)} title={t('terminal.search.next', settings.language)}>↓</button>
          <button type="button" onClick={closeSearch} aria-label={t('terminal.search.close', settings.language)} title={t('terminal.search.close', settings.language)}>×</button>
        </div>
      ) : null}

      <div ref={terminalHostRef} className="terminal-host" />

      {contextMenu ? createPortal(
        <>
          <div className="context-menu-overlay" onClick={() => setContextMenu(null)} onContextMenu={(event) => { event.preventDefault(); setContextMenu(null); }} />
          <div className="context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} role="menu">
            <button type="button" role="menuitem" onClick={() => { writeClipboardText(contextMenu.selection); setContextMenu(null); }}>
              {t('terminal.context.copy', settings.language)}
            </button>
            <button type="button" role="menuitem" onClick={() => { writeClipboardText(formatTroubleshootingSnippet(contextMenu.selection)); setContextMenu(null); }}>
              {t('terminal.context.copyTroubleshooting', settings.language)}
            </button>
            {onOpenNote ? (
              <button type="button" role="menuitem" onClick={() => {
                onOpenNote({
                  title: t('terminal.context.snippetTitle', settings.language, { time: new Date().toLocaleTimeString(getShellDeskLocale()) }),
                  content: contextMenu.selection,
                });
                setContextMenu(null);
              }}>
                {t('terminal.context.sendToNotepad', settings.language)}
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
            <div className="notepad-modal-title">{t('terminal.launch.title', settings.language)}</div>
            <label>
              <span>{t('terminal.launch.fieldTitle', settings.language)}</span>
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
                    {shellChoice || t('terminal.launch.defaultShell', settings.language)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>{t('terminal.launch.workingDirectory', settings.language)}</span>
              <input
                className="notepad-modal-input"
                value={launchDraft.workingDirectory}
                onChange={(event) => setLaunchDraft((currentDraft) => ({ ...currentDraft, workingDirectory: event.target.value }))}
                placeholder={isWindowsSystem(systemType) ? 'C:/Users' : '/srv/app'}
              />
            </label>
            <label>
              <span>{t('terminal.launch.initialCommand', settings.language)}</span>
              <textarea
                value={launchDraft.initialCommand}
                onChange={(event) => setLaunchDraft((currentDraft) => ({ ...currentDraft, initialCommand: event.target.value }))}
                placeholder="uname -a"
              />
            </label>
            <div className="notepad-modal-actions">
              <button type="button" className="notepad-modal-btn" onClick={() => setIsLaunchDialogOpen(false)}>{t('common.cancel', settings.language)}</button>
              <button type="submit" className="notepad-modal-btn primary">{t('common.open', settings.language)}</button>
            </div>
          </form>
        </div>,
        document.body,
      ) : null}

      {isSettingsDialogOpen ? createPortal(
        <div className="notepad-modal-overlay" role="presentation" onClick={() => setIsSettingsDialogOpen(false)}>
          <div className="notepad-modal terminal-settings-dialog" onClick={(event) => event.stopPropagation()}>
            <div className="notepad-modal-title">{t('terminal.settingsDialog.title', settings.language)}</div>
            <label>
              <span>{t('terminal.settingsDialog.colorTheme', settings.language)}</span>
              <select
                className="notepad-modal-input"
                value={settings.terminalTheme}
                onChange={(event) => updateTerminalSetting('terminalTheme', event.target.value as ShellDeskAppSettings['terminalTheme'])}
              >
                {terminalThemeChoices.map((themeChoice) => (
                  <option key={themeChoice.key} value={themeChoice.key}>{t(themeChoice.labelId, settings.language)}</option>
                ))}
              </select>
            </label>
            <label>
              <span>{t('terminal.settingsDialog.fontSize', settings.language)}</span>
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
                <span>{t('terminal.settingsDialog.copyOnSelect', settings.language)}</span>
                <input
                  type="checkbox"
                  checked={settings.terminalCopyOnSelect}
                  onChange={(event) => updateTerminalSetting('terminalCopyOnSelect', event.target.checked)}
                />
              </label>
              <label>
                <span>{t('terminal.settingsDialog.rightClickPaste', settings.language)}</span>
                <input
                  type="checkbox"
                  checked={settings.terminalRightClickPaste}
                  onChange={(event) => updateTerminalSetting('terminalRightClickPaste', event.target.checked)}
                />
              </label>
              <label>
                <span>{t('terminal.settingsDialog.cursorBlink', settings.language)}</span>
                <input
                  type="checkbox"
                  checked={settings.terminalCursorBlink}
                  onChange={(event) => updateTerminalSetting('terminalCursorBlink', event.target.checked)}
                />
              </label>
            </div>
            <div className="notepad-modal-actions">
              <button type="button" className="notepad-modal-btn primary" onClick={() => setIsSettingsDialogOpen(false)}>{t('terminal.settingsDialog.done', settings.language)}</button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}

export default RemoteTerminal;

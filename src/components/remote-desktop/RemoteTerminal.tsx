import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes';
import { Terminal as XTerminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import * as Zmodem from 'zmodem.js';
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

import { getErrorMessage } from './desktopUtils';
import { isWindowsSystem } from './remoteSystem';
import { collectSubmittedCommands, isLikelyForegroundCommand, readForegroundTaskSignal, summarizeTerminalOutput } from './terminalCommands';
import { applyTerminalOptions, buildTerminalOptions, getLocalWindowsPtyOption, getShellChoices, getTerminalChromeTone, getTerminalSessionTitle, getTerminalStatusLabel, sftpProbeCacheMs, terminalSearchOptions } from './terminalCore';
import { createTerminalCwdProbeController } from './terminalCwd';
import { createSftpProgressHandlers, createSftpTransferRunner } from './terminalTransfer';
import type { ForegroundTaskSource, RemoteTerminalProps, RemoteTerminalSessionEvent, RemoteTerminalSessionEventInput, RemoteTerminalSessionStatus, TerminalContextMenuState, TerminalCwdProbeState, TerminalLaunchDraft, TerminalSearchResultState } from './terminalTypes';
import { TerminalPaneView } from './TerminalPaneView';
import { createZmodemSentry, readSubmittedTransferCommand, readTerminalPayloadBytes, readVisibleSubmittedTransferCommand } from './terminalZmodem';
import { getTerminalTheme } from './terminalPresets';
import { attachTerminalInteractions } from './terminalInteractions';
import { useTerminalExternalRequests } from './terminalRequests';
import { t } from '../../i18n';

export type {
  RemoteTerminalChromePayload,
  RemoteTerminalCommandRequest,
  RemoteTerminalLaunchOptions,
  RemoteTerminalSessionEvent,
  RemoteTerminalSessionState,
  RemoteTerminalSessionStatus,
  RemoteTerminalToolAction,
  RemoteTerminalToolRequest,
} from './terminalTypes';

const RECONNECT_MAX_RETRIES = 5;
const RECONNECT_INITIAL_DELAY_MS = 3000;

function RemoteTerminal({
  connectionId,
  terminalId,
  settings,
  connectionKind,
  systemType,
  launchOptions,
  commandRequest,
  toolRequest,
  onChromeChange,
  onCommandRequestHandled,
  onToolRequestHandled,
  onOpenTerminal,
  onOpenNote,
  onCommandIntercept,
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
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectCountRef = useRef(0);
  const autoReconnectActiveRef = useRef(false);
  const autoReconnectTimerFiringRef = useRef(false);
  const lastSizeRef = useRef({ columns: 0, rows: 0 });
  const isTerminalReadyRef = useRef(false);
  const disconnectedRef = useRef(false);
  const useLegacyTerminalIpcRef = useRef(false);
  const sftpAvailabilityRef = useRef<{ available: boolean; checkedAt: number } | null>(null);
  const activeSftpTransferRef = useRef(false);
  const sftpTransferClientIdRef = useRef('');
  const sftpTransferQueueIdRef = useRef('');
  const sftpTransferEndedRef = useRef(false);
  const sftpProgressLineLengthRef = useRef(0);
  const terminalCwdProbeRef = useRef<TerminalCwdProbeState | null>(null);
  const zmodemSentryRef = useRef<Zmodem.Sentry | null>(null);
  const zmodemSessionRef = useRef<Zmodem.ZmodemSession | null>(null);
  const settingsRef = useRef(settings);
  const launchOptionsRef = useRef(launchOptions);
  const followOutputRef = useRef(true);
  const commandBufferRef = useRef('');
  const commandBufferUnsafeRef = useRef(false);
  const foregroundSequenceBufferRef = useRef('');
  const foregroundTaskSourceRef = useRef<ForegroundTaskSource | null>(null);
  const handledCommandRequestRef = useRef('');
  const handledToolRequestRef = useRef('');
  const onChromeChangeRef = useRef(onChromeChange);
  const onCommandInterceptRef = useRef(onCommandIntercept);
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
  const [launchDraft, setLaunchDraft] = useState<TerminalLaunchDraft>({
    title: '',
    shell: '',
    initialCommand: '',
    workingDirectory: '',
  });
  const terminalTheme = getTerminalTheme(settings.terminalTheme);
  const sessionTitle = getTerminalSessionTitle(terminalId, launchOptions);
  const shellChoices = useMemo(() => getShellChoices(systemType), [systemType]);
  const localWindowsPty = useMemo(
    () => getLocalWindowsPtyOption(connectionKind === 'local' && isWindowsSystem(systemType)),
    [connectionKind, systemType],
  );
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

    applyTerminalOptions(terminal, settings, localWindowsPty);
    const animationFrame = window.requestAnimationFrame(() => {
      fitAndSyncSizeRef.current?.();
    });

    return () => {
      window.cancelAnimationFrame(animationFrame);
    };
  }, [localWindowsPty, settings]);

  useEffect(() => {
    onSessionEventRef.current = onSessionEvent;
  }, [onSessionEvent]);

  useEffect(() => {
    onChromeChangeRef.current = onChromeChange;
  }, [onChromeChange]);

  useEffect(() => {
    onCommandInterceptRef.current = onCommandIntercept;
  }, [onCommandIntercept]);

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
    const terminal = new XTerminal(buildTerminalOptions(settingsRef.current, localWindowsPty));
    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon({ highlightLimit: 500 });
    const unicodeGraphemesAddon = new UnicodeGraphemesAddon();

    isTerminalReadyRef.current = false;
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    searchAddonRef.current = searchAddon;
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(searchAddon);
    terminal.loadAddon(unicodeGraphemesAddon);
    terminal.open(host);
    terminal.focus();
    setSessionStatus('idle');
    setSessionError('');
    setLastExitCode(null);
    setHasForegroundTask(false);
    foregroundSequenceBufferRef.current = '';
    foregroundTaskSourceRef.current = null;

    const detachTerminalInteractions = attachTerminalInteractions({
      host,
      terminal,
      searchAddon,
      settings,
      settingsRef,
      isTerminalReadyRef,
      setShowSearch,
      setContextMenu,
      setSearchResults,
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

    const writeTerminalInputAsync = (data: string) => {
      if (!isTerminalReadyRef.current) {
        return Promise.resolve(false);
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

      return writePromise;
    };

    const writeTerminalInput = (data: string) => {
      void writeTerminalInputAsync(data);
    };

    const writeTerminalNotice = (message: string) => {
      terminal.writeln(`\r\n${message}`);
      if (followOutputRef.current) {
        terminal.scrollToBottom();
      }
    };

    const clearReconnectTimer = () => {
      if (reconnectTimerRef.current) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };

    const resetAutoReconnect = () => {
      clearReconnectTimer();
      reconnectCountRef.current = 0;
      autoReconnectActiveRef.current = false;
      autoReconnectTimerFiringRef.current = false;
      disconnectedRef.current = false;
    };

    const cancelAutoReconnect = (notify: boolean) => {
      if (!autoReconnectActiveRef.current && !reconnectTimerRef.current) {
        return false;
      }

      resetAutoReconnect();

      if (notify) {
        writeTerminalNotice(t('terminal.message.autoReconnectCancelled', settingsRef.current.language));
      }

      return true;
    };

    const scheduleAutoReconnect = () => {
      if (disposed) {
        return;
      }

      clearReconnectTimer();

      const completedAttempts = reconnectCountRef.current;

      if (completedAttempts >= RECONNECT_MAX_RETRIES) {
        autoReconnectActiveRef.current = false;
        writeTerminalNotice(t('terminal.message.autoReconnectFailed', settingsRef.current.language));
        return;
      }

      const nextAttempt = completedAttempts + 1;
      const delayMs = RECONNECT_INITIAL_DELAY_MS * nextAttempt;
      const delaySeconds = Math.ceil(delayMs / 1000);

      autoReconnectActiveRef.current = true;

      if (completedAttempts === 0) {
        const language = settingsRef.current.language;
        const message = t('terminal.message.autoReconnect', language, { value0: delaySeconds });
        const hint = t('terminal.message.autoReconnectCancelHint', language);
        writeTerminalNotice(language === 'zh-CN' ? `${message}${hint}` : `${message} ${hint}`);
      } else {
        writeTerminalNotice(t('terminal.message.autoReconnectAttempt', settingsRef.current.language, {
          value0: completedAttempts,
          value1: delaySeconds,
        }));
      }

      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null;

        if (disposed || !autoReconnectActiveRef.current) {
          return;
        }

        reconnectCountRef.current = nextAttempt;
        autoReconnectTimerFiringRef.current = true;
        restartTerminalRef.current?.();
        autoReconnectTimerFiringRef.current = false;
      }, delayMs);
    };

    const writeSftpProgressLine = (text: string, endLine = false) => {
      const padding = ' '.repeat(Math.max(0, sftpProgressLineLengthRef.current - text.length));
      terminal.write(`\r${text}${padding}${endLine ? '\r\n' : ''}`, () => {
        if (followOutputRef.current) {
          terminal.scrollToBottom();
        }
      });
      sftpProgressLineLengthRef.current = endLine ? 0 : text.length;
    };

    const { renderSftpProgress, finishSftpProgress } = createSftpProgressHandlers({
      connectionId,
      settingsRef,
      activeSftpTransferRef,
      sftpTransferClientIdRef,
      sftpTransferQueueIdRef,
      sftpTransferEndedRef,
      writeSftpProgressLine,
    });

    const { processTerminalCwdProbeOutput, resolveTerminalWorkingDirectory } = createTerminalCwdProbeController({
      terminalCwdProbeRef,
      launchOptionsRef,
      isTerminalReadyRef,
      systemType,
      writeTerminalInputAsync,
    });

    const checkSftpAvailability = async () => {
      const cached = sftpAvailabilityRef.current;

      if (cached && Date.now() - cached.checkedAt < sftpProbeCacheMs) {
        return cached.available;
      }

      const result = await api.connections.checkSftp(connectionId);
      sftpAvailabilityRef.current = {
        available: Boolean(result.available),
        checkedAt: Date.now(),
      };

      return Boolean(result.available);
    };

    const runSftpTransferCommand = createSftpTransferRunner({
      api,
      connectionId,
      terminalId,
      systemType,
      settingsRef,
      activeSftpTransferRef,
      sftpTransferClientIdRef,
      sftpTransferQueueIdRef,
      sftpTransferEndedRef,
      sftpProgressLineLengthRef,
      sftpAvailabilityRef,
      checkSftpAvailability,
      resolveTerminalWorkingDirectory,
      writeTerminalInputAsync,
      writeTerminalNotice,
      writeSftpProgressLine,
      focusTerminal: () => terminal.focus(),
      isDisposed: () => disposed,
    });

    const zmodemSentry = createZmodemSentry({
      api,
      connectionId,
      terminalId,
      terminal,
      settingsRef,
      followOutputRef,
      zmodemSessionRef,
      isDisposed: () => disposed,
      writeTerminalNotice,
    });

    zmodemSentryRef.current = zmodemSentry;

    const startTerminalSession = async () => {
      setSessionStatus('idle');
      setSessionError('');
      setLastExitCode(null);
      setHasForegroundTask(false);
      foregroundSequenceBufferRef.current = '';
      foregroundTaskSourceRef.current = null;
      commandBufferRef.current = '';
      commandBufferUnsafeRef.current = false;
      activeSftpTransferRef.current = false;
      sftpTransferClientIdRef.current = '';
      sftpTransferQueueIdRef.current = '';
      sftpTransferEndedRef.current = false;
      sftpProgressLineLengthRef.current = 0;
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
        disconnectedRef.current = false;
        setSessionStatus('running');
        resetAutoReconnect();
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
        if (autoReconnectActiveRef.current) {
          scheduleAutoReconnect();
        }
      }
    };

    fitAndSyncSizeRef.current = fitAndSyncSize;
    sendInputRef.current = writeTerminalInput;
    restartTerminalRef.current = () => {
      if (disposed) {
        return;
      }

      if (!autoReconnectTimerFiringRef.current) {
        cancelAutoReconnect(false);
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

      const isCwdProbeOutput = processTerminalCwdProbeOutput(payload.data);

      if (isCwdProbeOutput) {
        return;
      }

      const foregroundSignal = readForegroundTaskSignal(foregroundSequenceBufferRef.current, payload.data);
      foregroundSequenceBufferRef.current = foregroundSignal.buffer;

      if (foregroundSignal.hasForegroundTask !== null) {
        foregroundTaskSourceRef.current = foregroundSignal.hasForegroundTask ? 'alternate-screen' : null;
        setHasForegroundTask(foregroundSignal.hasForegroundTask);
      }

      const outputSummary = zmodemSessionRef.current ? null : summarizeTerminalOutput(payload.data);

      if (outputSummary) {
        emitSessionEvent({
          type: 'terminal-output',
          summary: outputSummary.summary,
          truncated: outputSummary.truncated,
        });
      }

      try {
        zmodemSentry.consume(readTerminalPayloadBytes(payload));
      } catch (error) {
        writeTerminalNotice(t('terminal.transfer.zmodemFailed', settingsRef.current.language, {
          error: getErrorMessage(error),
        }));
        terminal.write(payload.data, () => {
          if (followOutputRef.current) {
            terminal.scrollToBottom();
          }
        });
      }

    });
    const removeTerminalExit = api.events.onTerminalExit((payload) => {
      if (payload.connectionId !== connectionId || (payload.terminalId !== terminalId && payload.terminalId)) {
        return;
      }

      isTerminalReadyRef.current = false;
      disconnectedRef.current = true;
      setHasForegroundTask(false);
      foregroundSequenceBufferRef.current = '';
      foregroundTaskSourceRef.current = null;
      commandBufferRef.current = '';
      commandBufferUnsafeRef.current = false;
      activeSftpTransferRef.current = false;
      sftpTransferClientIdRef.current = '';
      sftpTransferQueueIdRef.current = '';
      sftpTransferEndedRef.current = false;
      sftpProgressLineLengthRef.current = 0;
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
      commandBufferRef.current = '';
      commandBufferUnsafeRef.current = false;
      activeSftpTransferRef.current = false;
      sftpTransferClientIdRef.current = '';
      sftpTransferQueueIdRef.current = '';
      sftpTransferEndedRef.current = false;
      sftpProgressLineLengthRef.current = 0;
      setSessionError(payload.reason ?? '');
      setSessionStatus('disconnected');
      terminal.writeln(`\r\n${payload.reason ? t('terminal.message.connectionClosedWithReason', settings.language, { reason: payload.reason }) : t('terminal.message.connectionClosed', settings.language)}`);
      terminal.writeln(t('terminal.message.pressRToReconnect', settings.language));
      scheduleAutoReconnect();
    });
    const removeConnectionRestored = api.events.onConnectionRestored((payload) => {
      if (payload.connectionId !== connectionId || disposed) {
        return;
      }

      resetAutoReconnect();
      terminal.writeln(`\r\n${t('terminal.message.connectionRestored', settings.language)}\r\n`);
      void startTerminalSession();
    });
    const removeTransferProgress = api.events.onTransferProgress(renderSftpProgress);
    const removeTransferEnd = api.events.onTransferEnd(finishSftpProgress);
    const inputDisposable = terminal.onData((data) => {
      if (disconnectedRef.current && (data === 'r' || data === 'R')) {
        disconnectedRef.current = false;
        cancelAutoReconnect(false);
        restartTerminalRef.current?.();
        return;
      }

      if (autoReconnectActiveRef.current) {
        cancelAutoReconnect(true);
        return;
      }

      if (!isTerminalReadyRef.current) {
        return;
      }

      const hasCommandLineEditingInput = data.includes('\t') || data.includes('\x1b');
      const canReadVisibleCommand = commandBufferUnsafeRef.current && !hasCommandLineEditingInput;
      const transferCommand = zmodemSessionRef.current
        ? null
        : canReadVisibleCommand
          ? readVisibleSubmittedTransferCommand(terminal, data)
          : hasCommandLineEditingInput
            ? null
            : readSubmittedTransferCommand(commandBufferRef.current, data);

      if (transferCommand) {
        commandBufferRef.current = '';
        commandBufferUnsafeRef.current = false;
        emitSessionEvent({
          type: 'terminal-command',
          command: transferCommand.command,
          source: 'keyboard',
        });
        void runSftpTransferCommand(transferCommand);
        return;
      }

      if (hasCommandLineEditingInput) {
        commandBufferUnsafeRef.current = true;
      }

      if (!commandBufferUnsafeRef.current && launchOptionsRef.current?.mode !== 'tmux') {
        const commandState = collectSubmittedCommands(commandBufferRef.current, data);
        const interceptedCommand = commandState.commands.find((command) => onCommandInterceptRef.current?.(command));

        if (interceptedCommand) {
          commandBufferRef.current = commandState.buffer;
          commandBufferUnsafeRef.current = false;
          writeTerminalInput('\x15');
          emitSessionEvent({
            type: 'terminal-command',
            command: interceptedCommand,
            source: 'keyboard',
          });
          return;
        }
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

      if (commandBufferUnsafeRef.current && /[\r\n]/u.test(data)) {
        commandBufferRef.current = '';
        commandBufferUnsafeRef.current = false;
        return;
      }

      const commandState = collectSubmittedCommands(commandBufferRef.current, data);
      commandBufferRef.current = commandState.buffer;
      if (commandState.commands.length || data.includes('\x03') || data.includes('\x04')) {
        commandBufferUnsafeRef.current = false;
      }
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
      disconnectedRef.current = false;
      window.clearTimeout(startWarningTimer);
      resetAutoReconnect();
      window.cancelAnimationFrame(animationFrame);
      resizeObserver?.disconnect();
      inputDisposable.dispose();
      detachTerminalInteractions();
      removeTerminalData();
      removeTerminalExit();
      removeConnectionClosed();
      removeConnectionRestored();
      removeTransferProgress();
      removeTransferEnd();

      if (supportsTerminalIpcOptions && !useLegacyTerminalIpcRef.current) {
        api.connections.closeTerminal(connectionId, terminalId).catch(() => undefined);
      }

      if (terminalCwdProbeRef.current) {
        window.clearTimeout(terminalCwdProbeRef.current.timer);
        terminalCwdProbeRef.current.resolve('');
        terminalCwdProbeRef.current = null;
      }
      zmodemSessionRef.current?.abort?.();
      zmodemSessionRef.current = null;
      zmodemSentryRef.current = null;
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      searchAddonRef.current = null;
      fitAndSyncSizeRef.current = null;
      restartTerminalRef.current = null;
      sendInputRef.current = null;
    };
  }, [connectionId, emitSessionEvent, localWindowsPty, terminalId]);

  useTerminalExternalRequests({
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
    restartTerminal: () => restartTerminalRef.current?.(),
    openSettingsDialog: () => setIsSettingsDialogOpen(true),
    openSearch: () => setShowSearch(true),
  });

  return (
    <TerminalPaneView
      terminalPaneStyle={terminalPaneStyle}
      terminalHostRef={terminalHostRef}
      settings={settings}
      showSearch={showSearch}
      searchInputRef={searchInputRef}
      searchQuery={searchQuery}
      searchResults={searchResults}
      contextMenu={contextMenu}
      isLaunchDialogOpen={isLaunchDialogOpen}
      isSettingsDialogOpen={isSettingsDialogOpen}
      launchDraft={launchDraft}
      shellChoices={shellChoices}
      systemType={systemType}
      onSearchQueryChange={(query) => {
        setSearchQuery(query);
        searchTerminal('next', query);
      }}
      onSearchKeyDown={handleSearchKeyDown}
      onSearchPrevious={() => searchTerminal('previous')}
      onSearchNext={() => searchTerminal('next')}
      onSearchClose={closeSearch}
      onContextMenuClose={() => setContextMenu(null)}
      onContextMenuCopy={writeClipboardText}
      onOpenNote={onOpenNote}
      onLaunchDialogClose={() => setIsLaunchDialogOpen(false)}
      onLaunchSubmit={submitLaunchDialog}
      onLaunchDraftChange={setLaunchDraft}
      onSettingsDialogClose={() => setIsSettingsDialogOpen(false)}
      onSettingChange={updateTerminalSetting}
    />
  );
}

export default RemoteTerminal;

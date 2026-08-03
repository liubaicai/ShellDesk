import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes';
import { WebLinksAddon } from '@xterm/addon-web-links';
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
import { clearRuntimeTerminalCommandHistory, isSafeRuntimeTerminalCommand, listAllRuntimeTerminalCommands, listRuntimeTerminalCommands, rememberRuntimeTerminalCommand, suggestRuntimeTerminalCommand } from './terminalCommandHistory';
import {
  collectRemotePathCompletionCandidates,
  collectTerminalCompletionCandidates,
} from './terminalCompletionEngine';
import { normalizeSafeTerminalLink } from './terminalLinks';
import { createTerminalOutputDecorationController, type TerminalOutputDecorationController } from './terminalOutputDecorations';
import { createTerminalOutputFlowController, type TerminalOutputFlowController } from './terminalOutputFlow';
import { createTerminalHibernateRuntime, type TerminalHibernateRuntime } from './terminalHibernateRuntime';
import { createTerminalRendererRuntime, type TerminalRendererRuntime } from './terminalRendererRuntime';
import { attachTerminalDropUpload, pasteClipboardImageToTerminal } from './terminalDropUpload';
import { createTerminalSessionLogController, type TerminalSessionLogController } from './terminalSessionLog';
import { createTerminalKittyKeyboardRuntime } from './terminalKittyKeyboard';
import type { TerminalSelectionAiState } from './TerminalSelectionAiPortal';
import { createSftpProgressHandlers, createSftpTransferRunner } from './terminalTransfer';
import type { ForegroundTaskSource, RemoteTerminalProps, RemoteTerminalSessionEvent, RemoteTerminalSessionEventInput, RemoteTerminalSessionStatus, TerminalContextMenuState, TerminalCwdProbeState, TerminalLaunchDraft, TerminalSearchResultState } from './terminalTypes';
import { TerminalPaneView } from './TerminalPaneView';
import { TerminalCommandCenterPortal } from './TerminalCommandCenterPortal';
import { createTerminalUiStore } from './terminalUiStore';
import { createZmodemSentry, readSubmittedTransferCommand, readTerminalPayloadBytes, readVisibleSubmittedTransferCommand } from './terminalZmodem';
import { getTerminalTheme } from './terminalPresets';
import { attachTerminalInteractions } from './terminalInteractions';
import { canBroadcastTerminalInput, isSensitiveTerminalPrompt } from './terminalBroadcast';
import { useTerminalExternalRequests } from './terminalRequests';
import { TerminalCursorLineHighlighter } from './terminalCursorLine';
import { attachTerminalOsc52 } from './terminalOsc52';
import { TerminalOutputProtocolFilter } from './terminalOutputProtocol';
import { t } from '../../i18n';

export type {
  RemoteTerminalChromePayload,
  RemoteTerminalBroadcastRequest,
  RemoteTerminalCommandRequest,
  RemoteTerminalExitResult,
  RemoteTerminalLaunchOptions,
  RemoteTerminalSessionEvent,
  RemoteTerminalSessionState,
  RemoteTerminalSessionStatus,
  RemoteTerminalToolAction,
  RemoteTerminalToolRequest,
} from './terminalTypes';

const RECONNECT_MAX_RETRIES = 5;
const RECONNECT_INITIAL_DELAY_MS = 3000;

function matchesTerminalLinkModifier(event: MouseEvent, modifier: ShellDeskAppSettings['terminalLinkModifier']) {
  if (modifier === 'none') return true;
  if (modifier === 'ctrl') return event.ctrlKey;
  if (modifier === 'alt') return event.altKey;
  return event.metaKey;
}

function RemoteTerminal({
  connectionId,
  terminalId,
  settings,
  connectionKind,
  systemType,
  launchOptions,
  commandRequest,
  toolRequest,
  broadcastRequest,
  broadcastInputEnabled = false,
  isVisible = true,
  onChromeChange,
  onCommandRequestHandled,
  onToolRequestHandled,
  onBroadcastRequestHandled,
  onBroadcastInput,
  onSplitTerminal,
  onOpenTerminal,
  onOpenNote,
  onCommandIntercept,
  onSessionEvent,
  onSessionStateChange,
  onSessionExit,
  onWorkingDirectoryChange,
  onOpenFileManager,
  onSettingsChange,
}: RemoteTerminalProps) {
  const terminalHostRef = useRef<HTMLDivElement | null>(null);
  const timestampGutterRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<XTerminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const fitAndSyncSizeRef = useRef<(() => void) | null>(null);
  const restartTerminalRef = useRef<(() => void) | null>(null);
  const sendInputRef = useRef<((data: string) => void) | null>(null);
  const resolveWorkingDirectoryRef = useRef<(() => Promise<string>) | null>(null);
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
  const followOutputRef = useRef(settings.terminalScrollOnOutput);
  const commandBufferRef = useRef('');
  const commandBufferUnsafeRef = useRef(false);
  const commandSuggestionRef = useRef('');
  const terminalUiStoreRef = useRef<ReturnType<typeof createTerminalUiStore> | null>(null);
  terminalUiStoreRef.current ??= createTerminalUiStore();
  const terminalUiStore = terminalUiStoreRef.current;
  const acceptCompletionRef = useRef<((value: string) => void) | null>(null);
  const completionGenerationRef = useRef(0);
  const completionTimerRef = useRef<number | null>(null);
  const currentWorkingDirectoryRef = useRef(launchOptions?.workingDirectory?.trim() || '.');
  const foregroundSequenceBufferRef = useRef('');
  const foregroundTaskSourceRef = useRef<ForegroundTaskSource | null>(null);
  const handledCommandRequestRef = useRef('');
  const handledToolRequestRef = useRef('');
  const handledBroadcastRequestRef = useRef('');
  const sensitivePromptRef = useRef(false);
  const sensitivePromptBufferRef = useRef('');
  const commandRecordingRef = useRef(false);
  const recordedCommandsRef = useRef<string[]>([]);
  const broadcastInputEnabledRef = useRef(broadcastInputEnabled);
  const onBroadcastInputRef = useRef(onBroadcastInput);
  const onChromeChangeRef = useRef(onChromeChange);
  const onCommandInterceptRef = useRef(onCommandIntercept);
  const onSessionEventRef = useRef(onSessionEvent);
  const onSessionStateChangeRef = useRef(onSessionStateChange);
  const onSessionExitRef = useRef(onSessionExit);
  const onWorkingDirectoryChangeRef = useRef(onWorkingDirectoryChange);
  const outputDecorationControllerRef = useRef<TerminalOutputDecorationController | null>(null);
  const cursorLineHighlighterRef = useRef<TerminalCursorLineHighlighter | null>(null);
  const outputFlowControllerRef = useRef<TerminalOutputFlowController | null>(null);
  const rendererRuntimeRef = useRef<TerminalRendererRuntime | null>(null);
  const hibernateRuntimeRef = useRef<TerminalHibernateRuntime | null>(null);
  const sessionLogControllerRef = useRef<TerminalSessionLogController | null>(null);
  const toggleSessionLogRef = useRef<(() => void) | null>(null);
  const pasteClipboardImageRef = useRef<(() => void) | null>(null);
  const respondOsc52ReadRef = useRef<(() => void) | null>(null);
  const selectionAiGenerationRef = useRef(0);
  const selectionAiAbortRef = useRef<AbortController | null>(null);
  const isVisibleRef = useRef(isVisible);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [sessionStatus, setSessionStatus] = useState<RemoteTerminalSessionStatus>('idle');
  const [sessionError, setSessionError] = useState('');
  const [terminalReportedTitle, setTerminalReportedTitle] = useState('');
  const [lastExitCode, setLastExitCode] = useState<number | null>(null);
  const [hasForegroundTask, setHasForegroundTask] = useState(false);
  const [followOutput, setFollowOutput] = useState(settings.terminalScrollOnOutput);
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<TerminalSearchResultState>({ index: -1, count: 0 });
  const [contextMenu, setContextMenu] = useState<TerminalContextMenuState | null>(null);
  const [sessionLogRecording, setSessionLogRecording] = useState(false);
  const [selectionAiState, setSelectionAiState] = useState<TerminalSelectionAiState | null>(null);
  const [pendingTerminalLink, setPendingTerminalLink] = useState('');
  const [pendingOsc52Read, setPendingOsc52Read] = useState(false);
  const [showComposer, setShowComposer] = useState(false);
  const [composeText, setComposeText] = useState('');
  const [isLaunchDialogOpen, setIsLaunchDialogOpen] = useState(false);
  const [isSettingsDialogOpen, setIsSettingsDialogOpen] = useState(false);
  const [isCommandCenterOpen, setIsCommandCenterOpen] = useState(false);
  const [isCommandRecording, setIsCommandRecording] = useState(false);
  const [recordedCommands, setRecordedCommands] = useState<string[]>([]);
  const [, setCommandHistoryVersion] = useState(0);
  const [launchDraft, setLaunchDraft] = useState<TerminalLaunchDraft>({
    title: '',
    shell: '',
    initialCommand: '',
    workingDirectory: '',
  });
  const terminalTheme = getTerminalTheme(settings.terminalTheme);
  const sessionTitle = getTerminalSessionTitle(terminalId, launchOptions);
  const chromeTitle = terminalReportedTitle || sessionTitle;
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

  const pasteClipboardText = useCallback(() => {
    navigator.clipboard.readText().then((text) => {
      if (!text) return;
      terminalRef.current?.focus();
      terminalRef.current?.paste(text);
    }).catch(() => undefined);
  }, []);

  const requestSelectionAi = useCallback((selection: string, action: 'explain' | 'fix') => {
    const trimmedSelection = selection.trim().slice(0, 8_000);
    if (!trimmedSelection) return;
    const generation = selectionAiGenerationRef.current + 1;
    selectionAiGenerationRef.current = generation;
    selectionAiAbortRef.current?.abort();
    const abortController = new AbortController();
    selectionAiAbortRef.current = abortController;
    setSelectionAiState({ selection: trimmedSelection, action, result: '', error: '', loading: true });
    const systemPrompt = action === 'fix'
      ? t('terminal.selectionAi.fixPrompt', settings.language)
      : t('terminal.selectionAi.explainPrompt', settings.language);
    void import('../../ai').then(({ completeAiRequest, isAiConfigured }) => {
      if (!isAiConfigured(settings)) {
        throw new Error(t('terminal.selectionAi.notConfigured', settings.language));
      }
      return completeAiRequest(settings, {
        systemPrompt,
        messages: [{ role: 'user', content: trimmedSelection }],
        temperature: 0.1,
      }, { signal: abortController.signal, timeoutMs: 60_000, maxRetries: 1 });
    }).then((result) => {
      if (generation !== selectionAiGenerationRef.current) return;
      selectionAiAbortRef.current = null;
      setSelectionAiState((current) => current ? { ...current, loading: false, result: result.trim() } : current);
    }).catch((error: unknown) => {
      if (generation !== selectionAiGenerationRef.current) return;
      selectionAiAbortRef.current = null;
      setSelectionAiState((current) => current
        ? { ...current, loading: false, error: getErrorMessage(error) }
        : current);
    });
  }, [settings]);

  const openPendingTerminalLink = useCallback(() => {
    const link = normalizeSafeTerminalLink(pendingTerminalLink);
    setPendingTerminalLink('');
    if (!link) {
      return;
    }
    window.guiSSH?.app?.openExternal(link).catch((error: unknown) => {
      terminalRef.current?.writeln(`\r\n${t('terminal.error.openLinkFailed', settings.language, {
        error: getErrorMessage(error),
      })}`);
    });
  }, [pendingTerminalLink, settings.language]);

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

  const recordTerminalCommand = useCallback((command: string) => {
    if (!commandRecordingRef.current || !isSafeRuntimeTerminalCommand(command)) return;
    setRecordedCommands((current) => {
      const next = [...current, command].slice(-500);
      recordedCommandsRef.current = next;
      return next;
    });
  }, []);

  const runCommandCenterCommand = useCallback((command: string, mode: 'insert' | 'run') => {
    if (!isSafeRuntimeTerminalCommand(command)) return;
    if (mode === 'insert') {
      terminalRef.current?.focus();
      terminalRef.current?.paste(command);
    } else {
      sendInputRef.current?.(`${command}\r`);
      rememberRuntimeTerminalCommand(connectionId, command);
      emitSessionEvent({ type: 'terminal-command', command, source: 'external' });
      recordTerminalCommand(command);
    }
    setIsCommandCenterOpen(false);
  }, [connectionId, emitSessionEvent, recordTerminalCommand]);

  const saveCommandCenterSnippet = useCallback((command: string) => {
    if (!onSettingsChange || !isSafeRuntimeTerminalCommand(command)) return;
    const now = new Date().toISOString();
    const label = command.replace(/\s+/gu, ' ').slice(0, 56);
    onSettingsChange({
      ...settings,
      terminalSnippets: [
        ...(settings.terminalSnippets ?? []),
        {
          id: `history:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
          label,
          command,
          group: t('terminal.commandCenter.snippetGroup', settings.language),
          language: isWindowsSystem(systemType) ? 'powershell' : 'bash',
          shortcut: '',
          createdAt: now,
          updatedAt: now,
        },
      ],
    });
  }, [onSettingsChange, settings, systemType]);

  const exportRecordedCommandScript = useCallback(() => {
    const commands = recordedCommandsRef.current;
    const files = window.guiSSH?.files;
    if (!commands.length || !files) return;
    const windows = isWindowsSystem(systemType);
    const extension = windows ? 'ps1' : 'sh';
    const header = windows
      ? `# ShellDesk recorded commands\r\n# Exported ${new Date().toISOString()}\r\n\r\n`
      : `#!/usr/bin/env bash\nset -euo pipefail\n# ShellDesk recorded commands\n# Exported ${new Date().toISOString()}\n\n`;
    void files.saveTextFile({
      title: t('terminal.commandCenter.exportScript', settings.language),
      defaultFileName: `shelldesk-commands-${Date.now()}.${extension}`,
      content: `${header}${commands.join(windows ? '\r\n' : '\n')}${windows ? '\r\n' : '\n'}`,
      filters: [{ name: windows ? 'PowerShell' : 'Shell script', extensions: [extension] }],
    }).catch(() => undefined);
  }, [settings.language, systemType]);

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
    if (!settings.terminalCommandAutocompleteEnabled) {
      commandSuggestionRef.current = '';
      terminalUiStore.clearCompletion();
    }
    if (!settings.terminalSafeLinksEnabled) {
      setPendingTerminalLink('');
    }
    if (settings.terminalDynamicTitle === 'off' || (settings.terminalDynamicTitle === 'tmux' && launchOptionsRef.current?.mode !== 'tmux')) {
      setTerminalReportedTitle('');
    }
    if (settings.terminalOsc52Mode !== 'prompt') {
      respondOsc52ReadRef.current = null;
      setPendingOsc52Read(false);
    }
    outputFlowControllerRef.current?.setVisible(
      !settings.terminalSuspendRenderingWhenHidden
      || (isVisibleRef.current && (typeof document === 'undefined' || document.visibilityState !== 'hidden')),
    );
    rendererRuntimeRef.current?.update(settings.terminalRenderer, settings.terminalInlineImagesEnabled);
    hibernateRuntimeRef.current?.update(
      settings.terminalHibernateEnabled && settings.terminalSuspendRenderingWhenHidden,
      settings.terminalHibernateDelaySeconds,
    );
    outputDecorationControllerRef.current?.refresh();
    cursorLineHighlighterRef.current?.update(
      settings.terminalCursorLineHighlight,
      getTerminalTheme(settings.terminalTheme).selectionInactiveBackground ?? '#263449',
    );
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
    onSessionExitRef.current = onSessionExit;
  }, [onSessionExit]);

  useEffect(() => {
    broadcastInputEnabledRef.current = broadcastInputEnabled;
    onBroadcastInputRef.current = onBroadcastInput;
  }, [broadcastInputEnabled, onBroadcastInput]);

  useEffect(() => {
    onWorkingDirectoryChangeRef.current = onWorkingDirectoryChange;
  }, [onWorkingDirectoryChange]);

  useEffect(() => {
    launchOptionsRef.current = launchOptions;
  }, [launchOptions]);

  useEffect(() => {
    followOutputRef.current = followOutput;
  }, [followOutput]);

  useEffect(() => {
    isVisibleRef.current = isVisible;
    const visible = isVisible && (typeof document === 'undefined' || document.visibilityState !== 'hidden');
    outputFlowControllerRef.current?.setVisible(
      !settingsRef.current.terminalSuspendRenderingWhenHidden
      || visible,
    );
    rendererRuntimeRef.current?.setVisible(visible);
    hibernateRuntimeRef.current?.setVisible(visible);
  }, [isVisible]);

  useEffect(() => {
    if (showSearch) {
      window.requestAnimationFrame(() => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      });
    }
  }, [showSearch]);

  useEffect(() => {
    setTerminalReportedTitle('');
  }, [sessionTitle]);

  useEffect(() => {
    const status = getTerminalStatusLabel(sessionStatus, Boolean(sessionError), settings.language);
    const payload = {
      title: chromeTitle,
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
  }, [chromeTitle, hasForegroundTask, lastExitCode, sessionError, sessionStatus, sessionTitle, settings.language]);

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
    let supportsTerminalOutputFlow = false;
    const supportsTerminalIpcOptions = typeof api.connections.getIpcCapabilities === 'function';
    const terminal = new XTerminal(buildTerminalOptions(settingsRef.current, localWindowsPty));
    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon({ highlightLimit: 500 });
    const unicodeGraphemesAddon = new UnicodeGraphemesAddon();
    const requestSafeTerminalLink = (value: string, event?: MouseEvent) => {
      if (!settingsRef.current.terminalSafeLinksEnabled) {
        return;
      }
      if (event && !matchesTerminalLinkModifier(event, settingsRef.current.terminalLinkModifier)) return;
      const link = normalizeSafeTerminalLink(value);
      if (link) {
        setPendingTerminalLink(link);
      }
    };
    const webLinksAddon = new WebLinksAddon((event, uri) => requestSafeTerminalLink(uri, event));
    terminal.options.linkHandler = {
      allowNonHttpProtocols: false,
      activate: (event, text) => requestSafeTerminalLink(text, event),
    };

    isTerminalReadyRef.current = false;
    terminalRef.current = terminal;
    const titleDisposable = terminal.onTitleChange((title) => {
      const mode = settingsRef.current.terminalDynamicTitle;
      if (mode === 'all' || (mode === 'tmux' && launchOptionsRef.current?.mode === 'tmux')) {
        setTerminalReportedTitle(title.trim());
      }
    });
    const cwdDisposable = terminal.parser.registerOscHandler(7, (value) => {
      try {
        const parsed = new URL(value);
        if (parsed.protocol === 'file:') {
          const decoded = decodeURIComponent(parsed.pathname);
          const workingDirectory = isWindowsSystem(systemType)
            ? decoded.replace(/^\/([a-z]:)/iu, '$1').replace(/\//gu, '\\')
            : decoded || '/';
          currentWorkingDirectoryRef.current = workingDirectory;
          onWorkingDirectoryChangeRef.current?.(workingDirectory);
        }
      } catch {
        // Ignore malformed or non-URL OSC 7 payloads.
      }
      return true;
    });
    fitAddonRef.current = fitAddon;
    searchAddonRef.current = searchAddon;
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(searchAddon);
    terminal.loadAddon(unicodeGraphemesAddon);
    terminal.loadAddon(webLinksAddon);
    terminal.open(host);
    const cursorLineHighlighter = new TerminalCursorLineHighlighter(terminal);
    cursorLineHighlighter.update(
      settingsRef.current.terminalCursorLineHighlight,
      getTerminalTheme(settingsRef.current.terminalTheme).selectionInactiveBackground ?? '#263449',
    );
    cursorLineHighlighterRef.current = cursorLineHighlighter;
    const sessionLogController = createTerminalSessionLogController({
      api,
      title: sessionTitle,
      format: () => settingsRef.current.terminalSessionLogFormat,
    });
    sessionLogControllerRef.current = sessionLogController;
    const rendererRuntime = createTerminalRendererRuntime(
      terminal,
      settingsRef.current.terminalRenderer,
      settingsRef.current.terminalInlineImagesEnabled,
    );
    rendererRuntimeRef.current = rendererRuntime;
    rendererRuntime.setVisible(
      isVisibleRef.current && (typeof document === 'undefined' || document.visibilityState !== 'hidden'),
    );
    if (timestampGutterRef.current) {
      outputDecorationControllerRef.current = createTerminalOutputDecorationController(
        terminal,
        timestampGutterRef.current,
        settingsRef,
      );
    }
    terminal.focus();
    setSessionStatus('idle');
    setSessionError('');
    setLastExitCode(null);
    setHasForegroundTask(false);
    foregroundSequenceBufferRef.current = '';
    foregroundTaskSourceRef.current = null;

    const kittyKeyboardRuntime = createTerminalKittyKeyboardRuntime({
      terminal,
      enabled: () => settingsRef.current.terminalKittyKeyboardEnabled,
      writeInput: (data) => sendInputRef.current?.(data),
    });
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
      handleKittyKeyEvent: kittyKeyboardRuntime.handleKeyEvent,
      sendInput: (data) => sendInputRef.current?.(data),
      fitTerminal: () => fitAndSyncSizeRef.current?.(),
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

      outputFlowControllerRef.current?.prioritizeInput(data);

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

    setPendingOsc52Read(false);
    respondOsc52ReadRef.current = null;
    const osc52Disposable = attachTerminalOsc52({
      terminal,
      mode: () => settingsRef.current.terminalOsc52Mode,
      writeInput: writeTerminalInput,
      onReadRequest: (respond) => {
        respondOsc52ReadRef.current = respond;
        setPendingOsc52Read(true);
      },
    });

    toggleSessionLogRef.current = () => {
      if (sessionLogController.isRecording()) {
        setSessionLogRecording(false);
        void sessionLogController.stopAndSave().then((path) => {
          writeTerminalNotice(path
            ? t('terminal.sessionLog.saved', settingsRef.current.language, { path })
            : t('terminal.sessionLog.canceled', settingsRef.current.language));
        }).catch((error: unknown) => {
          writeTerminalNotice(t('terminal.sessionLog.failed', settingsRef.current.language, { error: getErrorMessage(error) }));
        });
        return;
      }
      sessionLogController.start();
      setSessionLogRecording(true);
      writeTerminalNotice(t('terminal.sessionLog.started', settingsRef.current.language));
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

    const { processTerminalCwdProbeOutput, resolveTerminalWorkingDirectory: probeTerminalWorkingDirectory } = createTerminalCwdProbeController({
      terminalCwdProbeRef,
      launchOptionsRef,
      isTerminalReadyRef,
      systemType,
      writeTerminalInputAsync,
    });
    const resolveTerminalWorkingDirectory = async () => {
      const directory = await probeTerminalWorkingDirectory();
      if (directory) {
        currentWorkingDirectoryRef.current = directory;
        onWorkingDirectoryChangeRef.current?.(directory);
      }
      return directory;
    };
    resolveWorkingDirectoryRef.current = resolveTerminalWorkingDirectory;
    pasteClipboardImageRef.current = () => {
      if (connectionKind === 'local') {
        writeTerminalNotice(t('terminal.clipboardImage.sshOnly', settingsRef.current.language));
        return;
      }
      void pasteClipboardImageToTerminal({
        api,
        connectionId,
        windows: isWindowsSystem(systemType),
        language: settingsRef.current.language,
        resolveWorkingDirectory: resolveTerminalWorkingDirectory,
        writeInput: writeTerminalInput,
      }).then((path) => {
        writeTerminalNotice(t('terminal.clipboardImage.uploaded', settingsRef.current.language, { path }));
      }).catch((error: unknown) => {
        writeTerminalNotice(t('terminal.clipboardImage.failedWithReason', settingsRef.current.language, { error: getErrorMessage(error) }));
      });
    };
    let detachDropUpload: (() => void) | null = null;
    void attachTerminalDropUpload({
      host,
      api,
      connectionId,
      connectionKind,
      windows: isWindowsSystem(systemType),
      settingsRef,
      resolveWorkingDirectory: resolveTerminalWorkingDirectory,
      writeInput: writeTerminalInput,
      writeNotice: writeTerminalNotice,
    }).then((detach) => {
      if (disposed) detach();
      else detachDropUpload = detach;
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

    const updateCommandSuggestion = (buffer: string) => {
      completionGenerationRef.current += 1;
      const generation = completionGenerationRef.current;
      if (completionTimerRef.current !== null) {
        window.clearTimeout(completionTimerRef.current);
        completionTimerRef.current = null;
      }
      const canComplete = settingsRef.current.terminalCommandAutocompleteEnabled
        && !commandBufferUnsafeRef.current
        && !foregroundTaskSourceRef.current
        && !zmodemSessionRef.current
        && launchOptionsRef.current?.mode !== 'tmux';
      const candidates = canComplete
        ? collectTerminalCompletionCandidates(connectionId, buffer, settingsRef.current.terminalSnippets ?? [])
        : [];
      const suggestion = candidates[0]?.value
        ?? (canComplete ? suggestRuntimeTerminalCommand(connectionId, buffer, settingsRef.current.terminalSnippets ?? []) : '');
      if (commandSuggestionRef.current === suggestion) {
        // The candidate details may still have changed.
      } else {
        commandSuggestionRef.current = suggestion;
      }
      terminalUiStore.setCompletion(suggestion, candidates);
      if (
        !canComplete
        || !settingsRef.current.terminalRemotePathAutocompleteEnabled
        || connectionKind === 'local'
        || !buffer.trim()
      ) {
        return;
      }
      completionTimerRef.current = window.setTimeout(() => {
        completionTimerRef.current = null;
        void collectRemotePathCompletionCandidates({
          api,
          connectionId,
          input: buffer,
          workingDirectory: currentWorkingDirectoryRef.current,
          windows: isWindowsSystem(systemType),
        }).then((pathCandidates) => {
          if (disposed || generation !== completionGenerationRef.current || !pathCandidates.length) {
            return;
          }
          const merged = [
            ...pathCandidates,
            ...candidates.filter((candidate) => !pathCandidates.some((pathCandidate) => pathCandidate.value === candidate.value)),
          ].slice(0, 12);
          commandSuggestionRef.current = merged[0]?.value ?? '';
          terminalUiStore.setCompletion(merged[0]?.value ?? '', merged);
        }).catch(() => undefined);
      }, 120);
    };

    const outputProtocolFilter = new TerminalOutputProtocolFilter(
      terminal,
      () => settingsRef.current.terminalClearWipesScrollback,
    );
    const outputFlowController = createTerminalOutputFlowController({
      initiallyVisible: !settingsRef.current.terminalSuspendRenderingWhenHidden
        || (isVisibleRef.current && document.visibilityState !== 'hidden'),
      acknowledge: (sequence, byteLength) => {
        if (!supportsTerminalOutputFlow || disposed) {
          return;
        }
        api.connections
          .acknowledgeTerminalOutput(connectionId, terminalId, sequence, byteLength)
          .catch(() => undefined);
      },
      onPressureChange: (pressure) => {
        outputDecorationControllerRef.current?.setPressure(pressure);
        host.dataset.outputPressure = pressure;
      },
      write: (data, done) => {
        sensitivePromptBufferRef.current = `${sensitivePromptBufferRef.current}${data}`.slice(-512);
        sensitivePromptRef.current = isSensitiveTerminalPrompt(sensitivePromptBufferRef.current);
        const displayData = zmodemSessionRef.current ? data : outputProtocolFilter.filter(data);
        const foregroundSignal = readForegroundTaskSignal(foregroundSequenceBufferRef.current, data);
        foregroundSequenceBufferRef.current = foregroundSignal.buffer;
        if (foregroundSignal.hasForegroundTask !== null) {
          foregroundTaskSourceRef.current = foregroundSignal.hasForegroundTask ? 'alternate-screen' : null;
          setHasForegroundTask(foregroundSignal.hasForegroundTask);
          outputFlowControllerRef.current?.setAlternateScreen(foregroundSignal.hasForegroundTask);
          if (foregroundSignal.hasForegroundTask) {
            updateCommandSuggestion('');
          }
        }

        const outputSummary = zmodemSessionRef.current ? null : summarizeTerminalOutput(data);
        if (outputSummary) {
          emitSessionEvent({
            type: 'terminal-output',
            summary: outputSummary.summary,
            truncated: outputSummary.truncated,
          });
        }

        try {
          zmodemSentry.consume(readTerminalPayloadBytes({ data: displayData }));
          terminal.write('', () => {
            if (followOutputRef.current) {
              terminal.scrollToBottom();
            }
            done();
          });
        } catch (error) {
          writeTerminalNotice(t('terminal.transfer.zmodemFailed', settingsRef.current.language, {
            error: getErrorMessage(error),
          }));
          terminal.write(displayData, () => {
            if (followOutputRef.current) {
              terminal.scrollToBottom();
            }
            done();
          });
        }
      },
    });
    outputFlowControllerRef.current = outputFlowController;
    const hibernateRuntime = createTerminalHibernateRuntime({
      terminal,
      renderer: rendererRuntime,
      enabled: settingsRef.current.terminalHibernateEnabled
        && settingsRef.current.terminalSuspendRenderingWhenHidden,
      delaySeconds: settingsRef.current.terminalHibernateDelaySeconds,
      canHibernate: () => !activeSftpTransferRef.current && outputFlowController.pendingBytes() === 0,
      onStateChange: (hibernated) => host.classList.toggle('terminal-host-hibernated', hibernated),
    });
    hibernateRuntimeRef.current = hibernateRuntime;
    hibernateRuntime.setVisible(
      isVisibleRef.current && document.visibilityState !== 'hidden',
    );
    const handleDocumentVisibility = () => {
      const visible = isVisibleRef.current && document.visibilityState !== 'hidden';
      outputFlowController.setVisible(!settingsRef.current.terminalSuspendRenderingWhenHidden || visible);
      rendererRuntime.setVisible(visible);
      hibernateRuntime.setVisible(visible);
    };
    document.addEventListener('visibilitychange', handleDocumentVisibility);

    const startTerminalSession = async () => {
      setSessionStatus('idle');
      setSessionError('');
      setLastExitCode(null);
      setHasForegroundTask(false);
      foregroundSequenceBufferRef.current = '';
      foregroundTaskSourceRef.current = null;
      commandBufferRef.current = '';
      commandBufferUnsafeRef.current = false;
      updateCommandSuggestion('');
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
        supportsTerminalOutputFlow = Boolean(capabilities.terminalOutputFlow);

        if (useLegacyTerminalIpcRef.current) {
          terminal.writeln(t('terminal.message.legacyMode', settings.language));
        }

        if (supportsTerminalIpcOptions) {
          await api.connections.startTerminal(connectionId, terminalId, columns, rows, {
            ...launchOptionsRef.current,
            term: settingsRef.current.terminalTermType,
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
    acceptCompletionRef.current = (value) => {
      const current = commandBufferRef.current;
      if (!value || commandBufferUnsafeRef.current) {
        return;
      }
      if (value.toLocaleLowerCase().startsWith(current.toLocaleLowerCase())) {
        writeTerminalInput(value.slice(current.length));
      } else {
        writeTerminalInput(`\x15${value}`);
      }
      commandBufferRef.current = value;
      updateCommandSuggestion('');
      terminal.focus();
    };
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
      if (!isCwdProbeOutput && !zmodemSessionRef.current) {
        sessionLogController.append(payload.data);
      }
      outputFlowController.enqueue({
        data: isCwdProbeOutput ? '' : payload.data,
        sequence: payload.sequence,
        byteLength: payload.byteLength,
      });
    });
    const removeTerminalExit = api.events.onTerminalExit((payload) => {
      if (payload.connectionId !== connectionId || (payload.terminalId !== terminalId && payload.terminalId)) {
        return;
      }

      const hasExitStatus = payload.code !== undefined && payload.code !== null;
      const hasExitSignal = typeof payload.signal === 'string' && payload.signal.trim() !== '';
      const isUnexpectedSshTerminalClose = connectionKind !== 'local' && !hasExitStatus && !hasExitSignal;
      const exitResult = {
        code: Number.isInteger(payload.code) ? payload.code ?? null : null,
        signal: hasExitSignal ? payload.signal?.trim() ?? null : null,
      };

      isTerminalReadyRef.current = false;
      respondOsc52ReadRef.current = null;
      setPendingOsc52Read(false);
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
      setLastExitCode(exitResult.code);

      if (isUnexpectedSshTerminalClose) {
        setSessionStatus('disconnected');
        scheduleAutoReconnect();
        outputFlowController.whenDrained(() => {
          if (disposed) {
            return;
          }
          terminal.writeln(`\r\n${t('terminal.message.connectionClosed', settings.language)}`);
          terminal.writeln(t('terminal.message.pressRToReconnect', settings.language));
        });
        return;
      }

      setSessionStatus('exited');
      outputFlowController.whenDrained(() => {
        if (disposed) {
          return;
        }
        terminal.writeln(`\r\n${t('terminal.message.sessionEnded', settings.language)}`);
        onSessionExitRef.current?.(exitResult);
      });
    });
    const removeConnectionClosed = api.events.onConnectionClosed((payload) => {
      if (payload.connectionId !== connectionId) {
        return;
      }

      isTerminalReadyRef.current = false;
      respondOsc52ReadRef.current = null;
      setPendingOsc52Read(false);
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

      const suggestion = commandSuggestionRef.current;
      const acceptsSuggestion = Boolean(suggestion && !commandBufferUnsafeRef.current && (
        data === '\t'
        || (data === '\x1b[C' && suggestion.toLocaleLowerCase().startsWith(commandBufferRef.current.toLocaleLowerCase()))
      ));
      if (acceptsSuggestion) {
        acceptCompletionRef.current?.(suggestion);
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
        rememberRuntimeTerminalCommand(connectionId, transferCommand.command);
        updateCommandSuggestion('');
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
        updateCommandSuggestion('');
      }

      if (!commandBufferUnsafeRef.current && launchOptionsRef.current?.mode !== 'tmux') {
        const commandState = collectSubmittedCommands(commandBufferRef.current, data);
        const interceptedCommand = commandState.commands.find((command) => onCommandInterceptRef.current?.(command));

        if (interceptedCommand) {
          commandBufferRef.current = commandState.buffer;
          commandBufferUnsafeRef.current = false;
          rememberRuntimeTerminalCommand(connectionId, interceptedCommand);
          updateCommandSuggestion(commandState.buffer);
          writeTerminalInput('\x15');
          emitSessionEvent({
            type: 'terminal-command',
            command: interceptedCommand,
            source: 'keyboard',
          });
          return;
        }
      }

      if (broadcastInputEnabledRef.current && canBroadcastTerminalInput(data, sensitivePromptRef.current).allowed) {
        onBroadcastInputRef.current?.(terminalId, data);
      }
      writeTerminalInput(data);
      if (sensitivePromptRef.current && /[\r\n]/u.test(data)) {
        sensitivePromptRef.current = false;
        sensitivePromptBufferRef.current = '';
      }
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
        updateCommandSuggestion('');
        return;
      }

      const commandState = collectSubmittedCommands(commandBufferRef.current, data);
      commandBufferRef.current = commandState.buffer;
      if (commandState.commands.length || data.includes('\x03') || data.includes('\x04')) {
        commandBufferUnsafeRef.current = false;
      }
      commandState.commands.forEach((command) => {
        rememberRuntimeTerminalCommand(connectionId, command);
        recordTerminalCommand(command);
        if (isLikelyForegroundCommand(command)) {
          foregroundTaskSourceRef.current = 'command';
          setHasForegroundTask(true);
        }

        emitSessionEvent({
          type: 'terminal-command',
          command,
          source: 'keyboard',
        });
        if (/^\s*(?:cd|pushd|popd)(?:\s|$)/iu.test(command)) {
          window.setTimeout(() => {
            if (!disposed && isTerminalReadyRef.current) {
              void resolveTerminalWorkingDirectory();
            }
          }, 350);
        }
      });
      updateCommandSuggestion(commandState.buffer);
    });
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fitAndSyncSize);

    resizeObserver?.observe(host);
    animationFrame = window.requestAnimationFrame(() => {
      void startTerminalSession();
    });

    return () => {
      disposed = true;
      selectionAiGenerationRef.current += 1;
      selectionAiAbortRef.current?.abort();
      selectionAiAbortRef.current = null;
      isTerminalReadyRef.current = false;
      disconnectedRef.current = false;
      window.clearTimeout(startWarningTimer);
      if (completionTimerRef.current !== null) {
        window.clearTimeout(completionTimerRef.current);
        completionTimerRef.current = null;
      }
      resetAutoReconnect();
      window.cancelAnimationFrame(animationFrame);
      resizeObserver?.disconnect();
      inputDisposable.dispose();
      detachTerminalInteractions();
      kittyKeyboardRuntime.dispose();
      detachDropUpload?.();
      removeTerminalData();
      removeTerminalExit();
      removeConnectionClosed();
      removeConnectionRestored();
      removeTransferProgress();
      removeTransferEnd();
      document.removeEventListener('visibilitychange', handleDocumentVisibility);
      outputFlowController.dispose();
      outputFlowControllerRef.current = null;
      hibernateRuntime.dispose();
      hibernateRuntimeRef.current = null;
      rendererRuntime.dispose();
      rendererRuntimeRef.current = null;
      sessionLogController.dispose();
      sessionLogControllerRef.current = null;

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
      outputDecorationControllerRef.current?.dispose();
      outputDecorationControllerRef.current = null;
      cursorLineHighlighter.dispose();
      cursorLineHighlighterRef.current = null;
      osc52Disposable.dispose();
      respondOsc52ReadRef.current = null;
      titleDisposable.dispose();
      cwdDisposable.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      searchAddonRef.current = null;
      fitAndSyncSizeRef.current = null;
      restartTerminalRef.current = null;
      sendInputRef.current = null;
      resolveWorkingDirectoryRef.current = null;
      acceptCompletionRef.current = null;
      toggleSessionLogRef.current = null;
      pasteClipboardImageRef.current = null;
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
    toggleSessionLog: () => toggleSessionLogRef.current?.(),
    pasteClipboardImage: () => pasteClipboardImageRef.current?.(),
    toggleCompose: () => setShowComposer((current) => !current),
    openCommandCenter: () => setIsCommandCenterOpen(true),
    resolveWorkingDirectory: () => resolveWorkingDirectoryRef.current?.() ?? Promise.resolve('.'),
    onOpenFileManager,
    onSplitTerminal,
  });

  useEffect(() => {
    if (
      !broadcastRequest
      || handledBroadcastRequestRef.current === broadcastRequest.id
      || sessionStatus !== 'running'
    ) return;
    handledBroadcastRequestRef.current = broadcastRequest.id;
    if (canBroadcastTerminalInput(broadcastRequest.data, sensitivePromptRef.current).allowed) {
      sendInputRef.current?.(broadcastRequest.data);
    }
    onBroadcastRequestHandled?.(broadcastRequest.id);
  }, [broadcastRequest, onBroadcastRequestHandled, sessionStatus]);

  return (
    <>
      <TerminalPaneView
      terminalPaneStyle={terminalPaneStyle}
      terminalHostRef={terminalHostRef}
      timestampGutterRef={timestampGutterRef}
      settings={settings}
      showSearch={showSearch}
      searchInputRef={searchInputRef}
      searchQuery={searchQuery}
      searchResults={searchResults}
      contextMenu={contextMenu}
      terminalUiStore={terminalUiStore}
      pendingTerminalLink={pendingTerminalLink}
      pendingOsc52Read={pendingOsc52Read}
      selectionAiState={selectionAiState}
      sessionLogRecording={sessionLogRecording}
      broadcastInputEnabled={broadcastInputEnabled}
      showComposer={showComposer}
      composeText={composeText}
      composeCanRun={sessionStatus === 'running'}
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
      onContextMenuPaste={pasteClipboardText}
      onSelectionAi={requestSelectionAi}
      onSelectionAiClose={() => {
        selectionAiGenerationRef.current += 1;
        selectionAiAbortRef.current?.abort();
        selectionAiAbortRef.current = null;
        setSelectionAiState(null);
      }}
      onCompletionAccept={(value) => acceptCompletionRef.current?.(value)}
      onTerminalLinkCancel={() => setPendingTerminalLink('')}
      onTerminalLinkOpen={openPendingTerminalLink}
      onOsc52ReadCancel={() => {
        respondOsc52ReadRef.current = null;
        setPendingOsc52Read(false);
      }}
      onOsc52ReadAllow={() => {
        const respond = respondOsc52ReadRef.current;
        respondOsc52ReadRef.current = null;
        setPendingOsc52Read(false);
        respond?.();
      }}
      onComposeTextChange={setComposeText}
      onComposeClose={() => {
        setShowComposer(false);
        focusTerminal();
      }}
      onComposeRun={() => {
        if (sessionStatus !== 'running' || !composeText.trim()) return;
        const command = composeText.replace(/\r?\n/gu, '\r');
        sendInputRef.current?.(`${command}\r`);
        commandBufferRef.current = '';
        commandBufferUnsafeRef.current = false;
        commandSuggestionRef.current = '';
        terminalUiStore.clearCompletion();
        rememberRuntimeTerminalCommand(connectionId, composeText);
        emitSessionEvent({ type: 'terminal-command', command: composeText, source: 'keyboard' });
        setComposeText('');
        setShowComposer(false);
        focusTerminal();
      }}
      onOpenNote={onOpenNote}
      onLaunchDialogClose={() => setIsLaunchDialogOpen(false)}
      onLaunchSubmit={submitLaunchDialog}
      onLaunchDraftChange={setLaunchDraft}
      onSettingsDialogClose={() => setIsSettingsDialogOpen(false)}
      onSettingChange={updateTerminalSetting}
      />
      <TerminalCommandCenterPortal
        open={isCommandCenterOpen}
        language={settings.language}
        currentScope={connectionId}
        currentCommands={listRuntimeTerminalCommands(connectionId)}
        allCommands={listAllRuntimeTerminalCommands()}
        recordedCommands={recordedCommands}
        recording={isCommandRecording}
        onClose={() => setIsCommandCenterOpen(false)}
        onInsert={(command) => runCommandCenterCommand(command, 'insert')}
        onRun={(command) => runCommandCenterCommand(command, 'run')}
        onSaveSnippet={saveCommandCenterSnippet}
        onClearHistory={() => {
          clearRuntimeTerminalCommandHistory();
          setCommandHistoryVersion((version) => version + 1);
        }}
        onToggleRecording={() => {
          const next = !commandRecordingRef.current;
          commandRecordingRef.current = next;
          setIsCommandRecording(next);
          if (next) {
            recordedCommandsRef.current = [];
            setRecordedCommands([]);
          }
        }}
        onExportScript={exportRecordedCommandScript}
      />
    </>
  );
}

export default RemoteTerminal;

import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon, type ISearchOptions } from '@xterm/addon-search';
import { type ITerminalOptions, Terminal as XTerminal } from '@xterm/xterm';
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
const sftpProbeCacheMs = 30000;
const terminalCwdProbeTimeoutMs = 6000;
const terminalCwdProbeBufferLimit = 12000;
const zmodemReadChunkSize = 64 * 1024;
const zmodemUploadCommands = new Set(['rz', 'lrz']);
const zmodemDownloadCommands = new Set(['sz', 'lsz']);
const szOptionsWithValue = new Set(['-B', '-L', '-l', '-w', '--bufsize', '--packetlen', '--framelen', '--window-size']);
const szUnsupportedOptions = new Set(['-i', '--command', '-X', '--xmodem', '-Y', '--ymodem']);
const terminalPayloadEncoder = new TextEncoder();

interface TerminalTransferCommand {
  action: 'rz' | 'sz';
  command: string;
  inputData: string;
  needsLineClear: boolean;
  remotePaths: string[];
}

interface TerminalCwdProbeState {
  beginMarker: string;
  endMarker: string;
  buffer: string;
  timer: number;
  resolve: (directory: string) => void;
}

interface TerminalBufferLineLike {
  isWrapped?: boolean;
  translateToString: (trimRight?: boolean) => string;
}

function getCommandBasename(commandPath: string) {
  return commandPath.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? '';
}

function pushShellWord(words: string[], word: string, hasWord: boolean) {
  if (hasWord) {
    words.push(word);
  }
}

function parseSimpleShellWords(command: string) {
  const words: string[] = [];
  let word = '';
  let quote: '"' | "'" | null = null;
  let hasWord = false;

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];

    if (quote === "'") {
      if (character === "'") {
        quote = null;
      } else {
        word += character;
        hasWord = true;
      }
      continue;
    }

    if (quote === '"') {
      if (character === '"') {
        quote = null;
        continue;
      }

      if (character === '$' || character === '`') {
        return null;
      }

      if (character === '\\') {
        index += 1;
        if (index >= command.length) {
          return null;
        }
        word += command[index];
        hasWord = true;
        continue;
      }

      word += character;
      hasWord = true;
      continue;
    }

    if (/\s/.test(character)) {
      pushShellWord(words, word, hasWord);
      word = '';
      hasWord = false;
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
      hasWord = true;
      continue;
    }

    if (/[;&|<>`$(){}]/.test(character)) {
      return null;
    }

    if (character === '\\') {
      index += 1;
      if (index >= command.length) {
        return null;
      }
      word += command[index];
      hasWord = true;
      continue;
    }

    word += character;
    hasWord = true;
  }

  if (quote) {
    return null;
  }

  pushShellWord(words, word, hasWord);
  return words;
}

function optionTakesSeparateValue(option: string) {
  if (szOptionsWithValue.has(option)) {
    return true;
  }

  return /^-[BLlw]$/u.test(option);
}

function optionIncludesValue(option: string) {
  return /^-[BLlw].+/u.test(option) || /^--(?:bufsize|packetlen|framelen|window-size)=/u.test(option);
}

function readSzRemotePaths(tokens: string[]) {
  const remotePaths: string[] = [];
  let stopParsingOptions = false;

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (!stopParsingOptions && token === '--') {
      stopParsingOptions = true;
      continue;
    }

    if (!stopParsingOptions && szUnsupportedOptions.has(token)) {
      return null;
    }

    if (!stopParsingOptions && optionTakesSeparateValue(token)) {
      index += 1;
      continue;
    }

    if (!stopParsingOptions && (optionIncludesValue(token) || (token.startsWith('-') && token.length > 1))) {
      continue;
    }

    remotePaths.push(token);
  }

  return remotePaths.length ? remotePaths : null;
}

function readTransferCommand(command: string, inputData: string, needsLineClear: boolean): TerminalTransferCommand | null {
  const tokens = parseSimpleShellWords(command);

  if (!tokens?.length) {
    return null;
  }

  const commandName = getCommandBasename(tokens[0]);

  if (zmodemUploadCommands.has(commandName)) {
    const hasUnexpectedArgument = tokens.slice(1).some((token) => token !== '--' && !token.startsWith('-'));

    return hasUnexpectedArgument
      ? null
      : { action: 'rz', command, inputData, needsLineClear, remotePaths: [] };
  }

  if (zmodemDownloadCommands.has(commandName)) {
    const remotePaths = readSzRemotePaths(tokens);

    return remotePaths
      ? { action: 'sz', command, inputData, needsLineClear, remotePaths }
      : null;
  }

  return null;
}

function readSubmittedTransferCommand(currentBuffer: string, data: string) {
  const commandState = collectSubmittedCommands(currentBuffer, data);

  if (commandState.commands.length !== 1 || commandState.buffer) {
    return null;
  }

  const command = commandState.commands[0];
  const needsLineClear = currentBuffer.trim().length > 0 && /^[\r\n]+$/u.test(data);

  return readTransferCommand(command, data, needsLineClear);
}

function readVisibleTerminalLine(terminal: XTerminal) {
  const terminalBuffer = (terminal as unknown as {
    buffer?: {
      active?: {
        baseY?: number;
        cursorY?: number;
        getLine?: (lineIndex: number) => TerminalBufferLineLike | undefined;
      };
    };
  }).buffer?.active;

  if (!terminalBuffer?.getLine) {
    return '';
  }

  let lineIndex = Number(terminalBuffer.baseY ?? 0) + Number(terminalBuffer.cursorY ?? 0);
  const parts: string[] = [];

  for (let wrappedLineCount = 0; wrappedLineCount < 8 && lineIndex >= 0; wrappedLineCount += 1) {
    const line = terminalBuffer.getLine(lineIndex);

    if (!line) {
      break;
    }

    parts.unshift(line.translateToString(true));

    if (!line.isWrapped) {
      break;
    }

    lineIndex -= 1;
  }

  return parts.join('').trimEnd();
}

function readVisibleSubmittedTransferCommand(terminal: XTerminal, data: string) {
  if (!/^[\r\n]+$/u.test(data)) {
    return null;
  }

  const line = readVisibleTerminalLine(terminal);

  if (!line.trim()) {
    return null;
  }

  const candidates = [line.trim()];
  const promptDelimiterPattern = /[#$>%]\s+/gu;
  let match: RegExpExecArray | null = promptDelimiterPattern.exec(line);
  let lastPromptEnd = -1;

  while (match) {
    lastPromptEnd = match.index + match[0].length;
    match = promptDelimiterPattern.exec(line);
  }

  if (lastPromptEnd >= 0) {
    candidates.unshift(line.slice(lastPromptEnd).trim());
  }

  for (const candidate of candidates) {
    const transferCommand = readTransferCommand(candidate, data, true);

    if (transferCommand) {
      return transferCommand;
    }
  }

  return null;
}

function isAbsoluteTransferPath(remotePath: string, isWindowsHost: boolean) {
  const normalizedPath = remotePath.replace(/\\/g, '/');

  if (normalizedPath.startsWith('~')) {
    return true;
  }

  if (isWindowsHost) {
    return /^\/?[a-z]:\//iu.test(normalizedPath) || normalizedPath.startsWith('/');
  }

  return normalizedPath.startsWith('/');
}

function joinTransferRemotePath(basePath: string, remotePath: string, isWindowsHost: boolean) {
  const normalizedRemotePath = isWindowsHost ? remotePath.replace(/\\/g, '/') : remotePath;

  if (isAbsoluteTransferPath(normalizedRemotePath, isWindowsHost)) {
    return normalizedRemotePath;
  }

  const normalizedBasePath = (isWindowsHost ? basePath.replace(/\\/g, '/') : basePath).trim() || '.';

  if (normalizedBasePath === '.') {
    return normalizedRemotePath;
  }

  if (normalizedBasePath === '/') {
    return `/${normalizedRemotePath.replace(/^\/+/u, '')}`;
  }

  if (isWindowsHost && /^\/?[a-z]:\/?$/iu.test(normalizedBasePath)) {
    return `${normalizedBasePath.replace(/\/?$/u, '/')}${normalizedRemotePath.replace(/^\/+/u, '')}`;
  }

  return `${normalizedBasePath.replace(/\/+$/u, '')}/${normalizedRemotePath.replace(/^\/+/u, '')}`;
}

function readTerminalPayloadBytes(payload: { data: string; bytes?: ArrayBuffer | ArrayBufferView | number[] }) {
  const { bytes } = payload;

  if (bytes instanceof ArrayBuffer) {
    return new Uint8Array(bytes);
  }

  if (ArrayBuffer.isView(bytes)) {
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  if (Array.isArray(bytes)) {
    return Uint8Array.from(bytes);
  }

  return terminalPayloadEncoder.encode(payload.data);
}

function mergeZmodemChunks(chunks: Uint8Array[]) {
  const totalBytes = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const merged = new Uint8Array(totalBytes);
  let offset = 0;

  chunks.forEach((chunk) => {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  });

  return merged;
}

function formatTransferBytes(size: number) {
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

function getTransferPercent(payload: Pick<ShellDeskTransferProgress, 'total' | 'transferred' | 'completedItems' | 'totalItems'>) {
  if (payload.total > 0) {
    return Math.max(0, Math.min(100, Math.round((payload.transferred / payload.total) * 100)));
  }

  if ((payload.totalItems ?? 0) > 0) {
    return Math.max(0, Math.min(100, Math.round(((payload.completedItems ?? 0) / (payload.totalItems ?? 1)) * 100)));
  }

  return 0;
}

function buildSftpProgressText(
  payload: ShellDeskTransferProgress | ShellDeskTransferEndPayload,
  language: ShellDeskAppSettings['language'],
  statusText = '',
) {
  const action = payload.type === 'download'
    ? t('fileExplorer.transfer.download', language)
    : t('fileExplorer.transfer.upload', language);
  const totalText = payload.total > 0 ? ` / ${formatTransferBytes(payload.total)}` : '';
  const itemText = (payload.totalItems ?? 0) > 0
    ? ` · ${t('fileExplorer.transfer.items', language, {
        completed: payload.completedItems ?? 0,
        total: t('fileExplorer.transfer.totalSuffix', language, { total: payload.totalItems ?? 0 }),
      })}`
    : '';
  const statusSuffix = statusText ? ` · ${statusText}` : '';

  return [
    `SFTP ${action}`,
    `${getTransferPercent(payload)}%`,
    `${formatTransferBytes(payload.transferred)}${totalText}`,
    payload.fileName,
  ].filter(Boolean).join(' · ') + itemText + statusSuffix;
}

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
  const sftpAvailabilityRef = useRef<{ available: boolean; checkedAt: number } | null>(null);
  const activeSftpTransferRef = useRef(false);
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

    const writeSftpProgressLine = (text: string, endLine = false) => {
      const padding = ' '.repeat(Math.max(0, sftpProgressLineLengthRef.current - text.length));
      terminal.write(`\r${text}${padding}${endLine ? '\r\n' : ''}`, () => {
        if (followOutputRef.current) {
          terminal.scrollToBottom();
        }
      });
      sftpProgressLineLengthRef.current = endLine ? 0 : text.length;
    };

    const renderSftpProgress = (payload: ShellDeskTransferProgress) => {
      if (!activeSftpTransferRef.current || payload.connectionId !== connectionId) {
        return;
      }

      if (sftpTransferQueueIdRef.current && payload.queueId && payload.queueId !== sftpTransferQueueIdRef.current) {
        return;
      }

      if (!sftpTransferQueueIdRef.current && payload.queueId) {
        sftpTransferQueueIdRef.current = payload.queueId;
      }

      writeSftpProgressLine(buildSftpProgressText(payload, settingsRef.current.language));
    };

    const finishSftpProgress = (payload: ShellDeskTransferEndPayload) => {
      if (!activeSftpTransferRef.current || payload.connectionId !== connectionId) {
        return;
      }

      if (sftpTransferQueueIdRef.current && payload.queueId && payload.queueId !== sftpTransferQueueIdRef.current) {
        return;
      }

      const statusText = payload.success
        ? t('terminal.transfer.sftpDone', settingsRef.current.language)
        : t('terminal.transfer.sftpFailed', settingsRef.current.language, { error: payload.error ?? '' });
      writeSftpProgressLine(buildSftpProgressText(payload, settingsRef.current.language, statusText), true);
      sftpTransferEndedRef.current = true;
      activeSftpTransferRef.current = false;
      sftpTransferQueueIdRef.current = '';
    };

    const settleTerminalCwdProbe = (directory: string) => {
      const probe = terminalCwdProbeRef.current;

      if (!probe) {
        return;
      }

      window.clearTimeout(probe.timer);
      terminalCwdProbeRef.current = null;
      probe.resolve(directory);
    };

    const processTerminalCwdProbeOutput = (data: string) => {
      const probe = terminalCwdProbeRef.current;

      if (!probe) {
        return;
      }

      probe.buffer = `${probe.buffer}${stripTerminalControlSequences(data).replace(/\r/g, '\n')}`.slice(-terminalCwdProbeBufferLimit);
      const lines = probe.buffer.split(/\n/u).map((line) => line.trim());
      const beginIndex = lines.findIndex((line) => line === probe.beginMarker);

      if (beginIndex < 0) {
        return;
      }

      const endIndex = lines.findIndex((line, index) => index > beginIndex && line === probe.endMarker);

      if (endIndex < 0) {
        return;
      }

      const directory = lines
        .slice(beginIndex + 1, endIndex)
        .find((line) => line && line !== probe.beginMarker && line !== probe.endMarker) ?? '';

      settleTerminalCwdProbe(directory);
    };

    const createTerminalCwdProbeCommand = (beginMarker: string, endMarker: string) => {
      const shell = launchOptionsRef.current?.shell?.toLowerCase() ?? '';

      if (isWindowsSystem(systemType)) {
        if (/\bcmd(?:\.exe)?\b/u.test(shell)) {
          return `echo ${beginMarker} & cd & echo ${endMarker}`;
        }

        return `Write-Output '${beginMarker}'; (Get-Location).Path; Write-Output '${endMarker}'`;
      }

      return `printf '%s\\n' '${beginMarker}'; pwd -P 2>/dev/null || pwd; printf '%s\\n' '${endMarker}'`;
    };

    const resolveTerminalWorkingDirectory = async () => {
      if (!isTerminalReadyRef.current) {
        return launchOptionsRef.current?.workingDirectory?.trim() || '.';
      }

      const sequence = Math.random().toString(36).slice(2, 10);
      const beginMarker = `__SHELLDESK_CWD_${sequence}_BEGIN__`;
      const endMarker = `__SHELLDESK_CWD_${sequence}_END__`;
      const previousProbe = terminalCwdProbeRef.current;

      if (previousProbe) {
        window.clearTimeout(previousProbe.timer);
        terminalCwdProbeRef.current = null;
        previousProbe.resolve('');
      }

      return new Promise<string>((resolve) => {
        const timer = window.setTimeout(() => {
          settleTerminalCwdProbe('');
        }, terminalCwdProbeTimeoutMs);

        terminalCwdProbeRef.current = {
          beginMarker,
          endMarker,
          buffer: '',
          timer,
          resolve,
        };

        void writeTerminalInputAsync(`${createTerminalCwdProbeCommand(beginMarker, endMarker)}\r`);
      }).then((directory) => directory || launchOptionsRef.current?.workingDirectory?.trim() || '.');
    };

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

    const runSftpTransferCommand = async (transferCommand: TerminalTransferCommand) => {
      let shouldRedrawPrompt = false;
      const beginSftpProgress = () => {
        activeSftpTransferRef.current = true;
        sftpTransferQueueIdRef.current = '';
        sftpTransferEndedRef.current = false;
        sftpProgressLineLengthRef.current = 0;
      };
      const cancelSftpProgress = () => {
        if (activeSftpTransferRef.current) {
          activeSftpTransferRef.current = false;
          sftpTransferQueueIdRef.current = '';
          sftpTransferEndedRef.current = false;
          sftpProgressLineLengthRef.current = 0;
        }
      };

      try {
        const isSftpAvailable = await checkSftpAvailability();

        if (disposed) {
          return;
        }

        if (!isSftpAvailable) {
          writeTerminalNotice(t('terminal.transfer.sftpFallback', settingsRef.current.language));
          await writeTerminalInputAsync(transferCommand.inputData);
          return;
        }

        shouldRedrawPrompt = true;
        if (transferCommand.needsLineClear) {
          await writeTerminalInputAsync('\x15');
        }

        const isWindowsHost = isWindowsSystem(systemType);
        const remoteDirectory = await resolveTerminalWorkingDirectory();

        if (disposed) {
          return;
        }

        if (transferCommand.action === 'rz') {
          writeTerminalNotice(t('terminal.transfer.sftpUpload', settingsRef.current.language, { path: remoteDirectory }));
          beginSftpProgress();
          const result = await api.connections.uploadFiles(connectionId, remoteDirectory);

          if (result.canceled) {
            cancelSftpProgress();
          }
          return;
        }

        const remotePaths = transferCommand.remotePaths.map((remotePath) =>
          joinTransferRemotePath(remoteDirectory, remotePath, isWindowsHost));

        writeTerminalNotice(t('terminal.transfer.sftpDownload', settingsRef.current.language, {
          count: String(remotePaths.length),
        }));

        beginSftpProgress();
        const result = remotePaths.length === 1
          ? await api.connections.downloadFile(connectionId, remotePaths[0])
          : await api.connections.downloadPaths(connectionId, remotePaths);

        if (result.canceled) {
          cancelSftpProgress();
        }
      } catch (error) {
        sftpAvailabilityRef.current = null;
        const isAlreadyReportedByProgress = sftpTransferEndedRef.current;
        if (sftpProgressLineLengthRef.current > 0) {
          writeSftpProgressLine('', true);
        }
        cancelSftpProgress();
        if (!isAlreadyReportedByProgress) {
          writeTerminalNotice(t('terminal.transfer.sftpFailed', settingsRef.current.language, {
            error: getErrorMessage(error),
          }));
        }
      } finally {
        if (shouldRedrawPrompt && !disposed && isTerminalReadyRef.current) {
          await writeTerminalInputAsync('\r');
        }
        terminal.focus();
      }
    };

    const sendZmodemBytes = (octets: number[] | Uint8Array) => {
      const bytes = octets instanceof Uint8Array ? octets : Uint8Array.from(octets);

      api.connections.writeTerminalBytes(connectionId, terminalId, bytes).catch((error: unknown) => {
        writeTerminalNotice(t('terminal.error.sendFailed', settingsRef.current.language, {
          error: getErrorMessage(error),
        }));
      });
    };

    const closeZmodemSession = async (session: Zmodem.ZmodemSession) => {
      try {
        await session.close();
      } catch {
        session.abort?.();
      }
    };

    const sendZmodemUploadFile = async (
      session: Zmodem.ZmodemSession,
      file: ShellDeskZmodemUploadFile,
      filesRemaining: number,
      bytesRemaining: number,
    ) => {
      const transfer = await session.send_offer({
        name: file.name,
        size: file.size,
        mtime: new Date(file.lastModified),
        files_remaining: filesRemaining,
        bytes_remaining: bytesRemaining,
      });

      if (!transfer) {
        return;
      }

      let offset = transfer.get_offset();

      if (file.size <= offset) {
        await transfer.end(new Uint8Array());
        return;
      }

      while (offset < file.size) {
        const chunkBuffer = await api.connections.readZmodemUploadFile(
          file.id,
          offset,
          Math.min(zmodemReadChunkSize, file.size - offset),
        );
        const chunk = new Uint8Array(chunkBuffer);

        if (!chunk.byteLength) {
          throw new Error('本地文件读取提前结束。');
        }

        offset += chunk.byteLength;

        if (offset >= file.size) {
          await transfer.end(chunk);
        } else {
          transfer.send(chunk);
        }
      }
    };

    const handleZmodemSendSession = async (session: Zmodem.ZmodemSession) => {
      let selectedFileIds: string[] = [];

      try {
        writeTerminalNotice(t('terminal.transfer.zmodemUploadPrompt', settingsRef.current.language));
        const selection = await api.connections.selectZmodemUploadFiles();

        if (disposed) {
          return;
        }

        if (selection.canceled || !selection.files.length) {
          writeTerminalNotice(t('terminal.transfer.zmodemCanceled', settingsRef.current.language));
          session.abort?.();
          return;
        }

        selectedFileIds = selection.files.map((file) => file.id);
        let bytesRemaining = selection.files.reduce((total, file) => total + file.size, 0);

        for (let index = 0; index < selection.files.length; index += 1) {
          const file = selection.files[index];

          await sendZmodemUploadFile(
            session,
            file,
            selection.files.length - index,
            bytesRemaining,
          );
          bytesRemaining -= file.size;
        }

        await closeZmodemSession(session);
        writeTerminalNotice(t('terminal.transfer.zmodemUploadDone', settingsRef.current.language));
      } catch (error) {
        session.abort?.();
        writeTerminalNotice(t('terminal.transfer.zmodemFailed', settingsRef.current.language, {
          error: getErrorMessage(error),
        }));
      } finally {
        if (selectedFileIds.length) {
          api.connections.releaseZmodemUploadFiles(selectedFileIds).catch(() => undefined);
        }
        terminal.focus();
      }
    };

    const handleZmodemOffer = (offer: Zmodem.Offer) => {
      void (async () => {
        const details = offer.get_details();
        const fileName = details.name || 'download';
        const chunks: Uint8Array[] = [];

        try {
          writeTerminalNotice(t('terminal.transfer.zmodemDownloadPrompt', settingsRef.current.language, { name: fileName }));
          await offer.accept({
            on_input: (chunk) => {
              chunks.push(Uint8Array.from(chunk));
            },
          });

          const merged = mergeZmodemChunks(chunks);
          const result = await api.connections.saveZmodemFile(fileName, merged);

          if (result.canceled) {
            writeTerminalNotice(t('terminal.transfer.zmodemCanceled', settingsRef.current.language));
            return;
          }

          writeTerminalNotice(t('terminal.transfer.zmodemDownloadSaved', settingsRef.current.language, { name: fileName }));
        } catch (error) {
          try {
            offer.skip();
          } catch {
            /* Ignore skip errors after an accepted transfer. */
          }
          writeTerminalNotice(t('terminal.transfer.zmodemFailed', settingsRef.current.language, {
            error: getErrorMessage(error),
          }));
        } finally {
          terminal.focus();
        }
      })();
    };

    const handleZmodemDetection = (detection: Zmodem.Detection) => {
      try {
        const session = detection.confirm();

        zmodemSessionRef.current = session;
        session.on('session_end', () => {
          if (zmodemSessionRef.current === session) {
            zmodemSessionRef.current = null;
          }
        });

        if (session.type === 'send') {
          void handleZmodemSendSession(session);
          return;
        }

        session.on('offer', (offer) => handleZmodemOffer(offer as Zmodem.Offer));
        session.start?.();
      } catch (error) {
        detection.deny();
        writeTerminalNotice(t('terminal.transfer.zmodemFailed', settingsRef.current.language, {
          error: getErrorMessage(error),
        }));
      }
    };

    const terminalOutputDecoder = new TextDecoder();
    const writeTerminalOutputBytes = (octets: number[]) => {
      const text = terminalOutputDecoder.decode(Uint8Array.from(octets), { stream: true });

      if (!text) {
        return;
      }

      terminal.write(text, () => {
        if (followOutputRef.current) {
          terminal.scrollToBottom();
        }
      });
    };

    const zmodemSentry = new Zmodem.Sentry({
      to_terminal: writeTerminalOutputBytes,
      sender: sendZmodemBytes,
      on_detect: handleZmodemDetection,
      on_retract: () => undefined,
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

      const isCwdProbeOutput = Boolean(terminalCwdProbeRef.current);
      processTerminalCwdProbeOutput(payload.data);

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
      setHasForegroundTask(false);
      foregroundSequenceBufferRef.current = '';
      foregroundTaskSourceRef.current = null;
      commandBufferRef.current = '';
      commandBufferUnsafeRef.current = false;
      activeSftpTransferRef.current = false;
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
      sftpTransferQueueIdRef.current = '';
      sftpTransferEndedRef.current = false;
      sftpProgressLineLengthRef.current = 0;
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
    const removeTransferProgress = api.events.onTransferProgress(renderSftpProgress);
    const removeTransferEnd = api.events.onTransferEnd(finishSftpProgress);
    const inputDisposable = terminal.onData((data) => {
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

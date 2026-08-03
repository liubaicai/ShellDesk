import type { CSSProperties, MouseEvent as ReactMouseEvent } from 'react';

import type { RemoteProcessManagerLaunchOptions } from './components/remote-desktop/RemoteProcessManager';
import type {
  RemoteTerminalCommandRequest,
  RemoteTerminalLaunchOptions,
  RemoteTerminalSessionEvent,
  RemoteTerminalSessionStatus,
  RemoteTerminalToolRequest,
} from './components/remote-desktop/RemoteTerminal';
import type { RemoteConnectionInfo } from './components/remote-desktop/types';
import type { SettingsTab } from './components/remote-desktop/settingsTypes';
import { t } from './i18n';
import type { DesktopAppKey } from './remoteDesktopCatalog';

export const defaultTmuxSessionName = 'sd-tmux';

export type DesktopDragPayload =
  | { source: 'desktop'; itemId: string; itemType: 'app' | 'folder'; appKey?: DesktopAppKey }
  | { source: 'launchpad'; appKey: DesktopAppKey }
  | { source: 'folder'; folderId: string; appKey: DesktopAppKey };

export interface DesktopPointerDragSession {
  payload: DesktopDragPayload;
  pointerId: number;
  startX: number;
  startY: number;
  isDragging: boolean;
}

export interface DesktopPointerDragPreviewState {
  x: number;
  y: number;
  label: string;
  appKey?: DesktopAppKey;
}

export interface DesktopAppContextMenuState {
  x: number;
  y: number;
  appKey: DesktopAppKey;
  source: 'desktop' | 'launchpad' | 'folder';
  folderId?: string;
}

export interface DesktopFolderContextMenuState {
  x: number;
  y: number;
  folderId: string;
}

export interface DesktopSurfaceContextMenuState {
  x: number;
  y: number;
}

export interface FolderRenameDialogState {
  folderId: string;
  name: string;
}

export interface LaunchpadTooltipState {
  description: string;
  x: number;
  y: number;
  placement: 'top' | 'bottom';
}

export interface RemoteDesktopProps {
  connection: RemoteConnectionInfo;
  settings: ShellDeskAppSettings;
  onSettingsChange?: (settings: ShellDeskAppSettings) => void;
  onTerminalSessionEvent?: (event: RemoteTerminalSessionEvent) => void;
  initialAppKey?: ShellDeskDesktopAppKey;
}

export function clearDesktopTextSelection() {
  window.getSelection()?.removeAllRanges();
}

export function preventDesktopOpenSelection(event: ReactMouseEvent<HTMLElement>) {
  event.preventDefault();
  clearDesktopTextSelection();
  window.requestAnimationFrame(clearDesktopTextSelection);
}

export interface DesktopWindowFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DesktopWindowState {
  id: string;
  appKey: DesktopAppKey;
  frame: DesktopWindowFrame;
  previousFrame?: DesktopWindowFrame;
  isMaximized: boolean;
  isMinimized: boolean;
  zIndex: number;
  terminalId?: string;
  terminalLaunchOptions?: RemoteTerminalLaunchOptions;
  terminalRestorePending?: boolean;
  terminalStatus?: RemoteTerminalSessionStatus;
  terminalHasForegroundTask?: boolean;
  terminalWorkingDirectory?: string;
  terminalToolRequest?: RemoteTerminalToolRequest;
  terminalCommandRequest?: RemoteTerminalCommandRequest;
  terminalBroadcastRequest?: import('./components/remote-desktop/terminalTypes').RemoteTerminalBroadcastRequest;
  chromeTitle?: string;
  chromeStatus?: string;
  chromeTone?: 'idle' | 'loading' | 'error';
  browserInitialUrl?: string;
  notepadInitialPath?: string;
  notepadInitialContent?: string;
  notepadInitialTitle?: string;
  notepadOpenRequest?: { id: string; filePath: string };
  processManagerLaunchOptions?: RemoteProcessManagerLaunchOptions;
  fileExplorerInitialPath?: string;
  settingsInitialTab?: SettingsTab;
  settingsTabRequestId?: number;
  vncInitialTarget?: { host: string; port: number };
}

export type DesktopWindowInteractionMode = 'move' | 'resize';

export interface DesktopWindowPointerState {
  pointerId: number;
  windowId: string;
  mode: DesktopWindowInteractionMode;
  element: HTMLElement;
  originX: number;
  originY: number;
  startFrame: DesktopWindowFrame;
  latestFrame: DesktopWindowFrame;
  surfaceWidth: number;
  surfaceHeight: number;
}

export interface TerminalTitlebarMenuState {
  windowId: string;
  x: number;
  y: number;
}

export interface TmuxSessionInfo {
  name: string;
  windows: number;
  attached: number;
  createdAt: number | null;
  lastAttachedAt: number | null;
}

export interface TmuxMenuState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  sessions: TmuxSessionInfo[];
  error?: string;
}

export interface TmuxLaunchRequest {
  sessionName: string;
  command: 'attach' | 'new';
}

export type DesktopConnectionGateStatus = 'checking' | 'ready' | 'blocked';

export interface DesktopConnectionGateState {
  status: DesktopConnectionGateStatus;
  message: string;
}

export interface DesktopWindowTitlebarClickState {
  windowId: string;
  timestamp: number;
  x: number;
  y: number;
}

export const windowEdgePadding = 14;
export const windowDockSafeAreas: Record<ShellDeskRemoteDesktopDockSize, number> = {
  small: 60,
  medium: 72,
  large: 88,
};
export const windowMinWidth = 360;
export const windowMinHeight = 260;
export const titlebarDoubleClickDelayMs = 500;
export const titlebarDoubleClickDistance = 8;

export const defaultWindowFrames: Record<DesktopAppKey, DesktopWindowFrame> = {
  files: { x: 132, y: 54, width: 980, height: 580 },
  terminal: { x: 206, y: 80, width: 780, height: 500 },
  notepad: { x: 140, y: 50, width: 860, height: 580 },
  'code-editor': { x: 74, y: 30, width: 1220, height: 720 },
  browser: { x: 150, y: 58, width: 1000, height: 600 },
  vnc: { x: 118, y: 46, width: 1040, height: 650 },
  'rdp-viewer': { x: 72, y: 30, width: 1220, height: 720 },
  'log-viewer': { x: 118, y: 46, width: 1080, height: 650 },
  monitor: { x: 224, y: 86, width: 820, height: 520 },
  mysql: { x: 100, y: 40, width: 1020, height: 620 },
  clickhouse: { x: 100, y: 40, width: 1080, height: 650 },
  redis: { x: 100, y: 40, width: 1020, height: 620 },
  'service-manager': { x: 110, y: 44, width: 1080, height: 650 },
  'supervisor-manager': { x: 96, y: 38, width: 1140, height: 680 },
  'backup-manager': { x: 84, y: 34, width: 1180, height: 700 },
  'container-manager': { x: 104, y: 42, width: 1100, height: 660 },
  'k8s-manager': { x: 104, y: 42, width: 1100, height: 660 },
  'vm-manager': { x: 72, y: 30, width: 1220, height: 720 },
  'frp-manager': { x: 104, y: 42, width: 1100, height: 660 },
  'frps-manager': { x: 104, y: 42, width: 1100, height: 660 },
  'port-manager': { x: 116, y: 48, width: 1120, height: 650 },
  'firewall-manager': { x: 118, y: 48, width: 1080, height: 650 },
  'iptables-manager': { x: 106, y: 44, width: 1160, height: 680 },
  'network-diagnostics': { x: 120, y: 52, width: 1060, height: 640 },
  'disk-analyzer': { x: 110, y: 46, width: 1120, height: 650 },
  'disk-manager': { x: 96, y: 38, width: 1180, height: 680 },
  'package-manager': { x: 116, y: 48, width: 1080, height: 650 },
  'git-manager': { x: 112, y: 46, width: 1120, height: 660 },
  'cert-manager': { x: 120, y: 48, width: 1000, height: 620 },
  'nginx-manager': { x: 120, y: 48, width: 1100, height: 680 },
  'caddy-manager': { x: 120, y: 48, width: 1100, height: 680 },
  'apache-manager': { x: 120, y: 48, width: 1100, height: 680 },
  'scheduled-tasks': { x: 118, y: 50, width: 1080, height: 650 },
  postgres: { x: 100, y: 40, width: 1080, height: 650 },
  mongo: { x: 96, y: 38, width: 1120, height: 660 },
  'search-cluster': { x: 106, y: 44, width: 1120, height: 650 },
  'message-queue': { x: 112, y: 46, width: 1120, height: 650 },
  's3-browser': { x: 106, y: 44, width: 1180, height: 680 },
  'security-audit': { x: 116, y: 48, width: 1080, height: 650 },
  'api-debugger': { x: 118, y: 46, width: 1080, height: 650 },
  procmanager: { x: 126, y: 54, width: 1100, height: 640 },
  'ai-chat': { x: 160, y: 55, width: 800, height: 640 },
  settings: { x: 160, y: 55, width: 960, height: 580 },
  sqlite: { x: 100, y: 40, width: 1020, height: 620 },
};

export interface DesktopWindowWorkspace {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function getDesktopWindowWorkspace(
  surfaceWidth: number,
  surfaceHeight: number,
  dockPosition: ShellDeskRemoteDesktopDockPosition,
  dockSize: ShellDeskRemoteDesktopDockSize,
  reserveDockSpace: boolean,
): DesktopWindowWorkspace {
  const dockSafeArea = reserveDockSpace ? windowDockSafeAreas[dockSize] : 0;
  const leftInset = dockPosition === 'left' ? dockSafeArea : 0;
  const rightInset = dockPosition === 'right' ? dockSafeArea : 0;
  const topInset = dockPosition === 'top' ? dockSafeArea : 0;
  const bottomInset = dockPosition === 'bottom' ? dockSafeArea : 0;

  return {
    x: leftInset,
    y: topInset,
    width: Math.max(windowMinWidth, surfaceWidth - leftInset - rightInset),
    height: Math.max(windowMinHeight, surfaceHeight - topInset - bottomInset),
  };
}

export function clampWindowFrame(
  frame: DesktopWindowFrame,
  surfaceWidth: number,
  surfaceHeight: number,
  dockPosition: ShellDeskRemoteDesktopDockPosition,
  dockSize: ShellDeskRemoteDesktopDockSize,
  reserveDockSpace: boolean,
): DesktopWindowFrame {
  const workspace = getDesktopWindowWorkspace(surfaceWidth, surfaceHeight, dockPosition, dockSize, reserveDockSpace);
  const minX = workspace.x + windowEdgePadding;
  const minY = workspace.y + windowEdgePadding;
  const maxWidth = Math.max(windowMinWidth, workspace.width - windowEdgePadding * 2);
  const maxHeight = Math.max(windowMinHeight, workspace.height - windowEdgePadding * 2);
  const width = Math.min(Math.max(frame.width, windowMinWidth), maxWidth);
  const height = Math.min(Math.max(frame.height, windowMinHeight), maxHeight);
  const maxX = Math.max(minX, workspace.x + workspace.width - windowEdgePadding - width);
  const maxY = Math.max(minY, workspace.y + workspace.height - windowEdgePadding - height);

  return {
    x: Math.min(Math.max(frame.x, minX), maxX),
    y: Math.min(Math.max(frame.y, minY), maxY),
    width,
    height,
  };
}

export function areWindowFramesEqual(firstFrame: DesktopWindowFrame, secondFrame: DesktopWindowFrame) {
  return firstFrame.x === secondFrame.x
    && firstFrame.y === secondFrame.y
    && firstFrame.width === secondFrame.width
    && firstFrame.height === secondFrame.height;
}

export function applyWindowFrameToElement(element: HTMLElement, frame: DesktopWindowFrame) {
  element.style.width = `${frame.width}px`;
  element.style.height = `${frame.height}px`;
  element.style.transform = `translate3d(${frame.x}px, ${frame.y}px, 0)`;
}

export function getMaximizedWindowFrame(
  surfaceWidth: number,
  surfaceHeight: number,
  dockPosition: ShellDeskRemoteDesktopDockPosition,
  dockSize: ShellDeskRemoteDesktopDockSize,
  reserveDockSpace: boolean,
) {
  const workspace = getDesktopWindowWorkspace(surfaceWidth, surfaceHeight, dockPosition, dockSize, reserveDockSpace);

  return {
    x: workspace.x,
    y: workspace.y,
    width: Math.max(windowMinWidth, workspace.width),
    height: Math.max(windowMinHeight, workspace.height),
  };
}

export function createDesktopWindow(appKey: DesktopAppKey, sequence: number, zIndex: number, language: ShellDeskAppSettings['language']): DesktopWindowState {
  const baseFrame = defaultWindowFrames[appKey];
  const offset = ((sequence - 1) % 7) * 28;
  const isBrowserWindow = appKey === 'browser';

  return {
    id: `${appKey}-${sequence}`,
    appKey,
    frame: {
      ...baseFrame,
      x: baseFrame.x + offset,
      y: baseFrame.y + offset,
    },
    isMaximized: false,
    isMinimized: false,
    zIndex,
    terminalId: appKey === 'terminal' ? `terminal-${sequence}` : undefined,
    terminalStatus: appKey === 'terminal' ? 'idle' : undefined,
    terminalHasForegroundTask: appKey === 'terminal' ? false : undefined,
    chromeTitle: isBrowserWindow ? '127.0.0.1' : undefined,
    chromeStatus: isBrowserWindow ? t('desktop.browser.status.ready', language) : undefined,
    chromeTone: isBrowserWindow ? 'idle' : undefined,
  };
}

export function getTopDesktopWindow(
  desktopWindows: DesktopWindowState[],
  predicate: (desktopWindow: DesktopWindowState) => boolean = () => true,
) {
  return desktopWindows.reduce<DesktopWindowState | null>((currentTopWindow, desktopWindow) => {
    if (!predicate(desktopWindow)) {
      return currentTopWindow;
    }

    if (!currentTopWindow || desktopWindow.zIndex > currentTopWindow.zIndex) {
      return desktopWindow;
    }

    return currentTopWindow;
  }, null);
}

export function hasCustomDesktopWallpaper(settings: ShellDeskAppSettings) {
  return settings.desktopWallpaperMode === 'custom' && Boolean(settings.desktopWallpaperDataUrl);
}

export function createWallpaperObjectUrl(dataUrl: string) {
  const match = /^data:(image\/(?:png|jpe?g|webp|gif));base64,([A-Za-z0-9+/=]+)$/i.exec(dataUrl);

  if (!match) {
    return '';
  }

  const [, mimeType, payload] = match;
  const binary = window.atob(payload);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return window.URL.createObjectURL(new Blob([bytes], { type: mimeType }));
}

export function getDesktopWallpaperStyle(
  settings: ShellDeskAppSettings,
  presetWallpaperUrl: string,
  customWallpaperUrl: string,
): CSSProperties {
  if (hasCustomDesktopWallpaper(settings)) {
    const wallpaperSource = customWallpaperUrl || settings.desktopWallpaperDataUrl;

    return {
      backgroundImage: wallpaperSource ? `url(${JSON.stringify(wallpaperSource)})` : 'none',
      backgroundPosition: 'center',
      backgroundRepeat: 'no-repeat',
      backgroundSize: 'cover',
    };
  }

  return {
    backgroundImage: presetWallpaperUrl
      ? `linear-gradient(180deg, var(--desktop-wallpaper-scrim-top), var(--desktop-wallpaper-scrim-bottom)), url(${JSON.stringify(presetWallpaperUrl)})`
      : 'linear-gradient(180deg, var(--desktop-wallpaper-scrim-top), var(--desktop-wallpaper-scrim-bottom))',
    backgroundPosition: 'center, center',
    backgroundRepeat: 'no-repeat, no-repeat',
    backgroundSize: 'cover, cover',
  };
}

export function getTerminalSnippetGroups(snippets: ShellDeskTerminalSnippet[], language: ShellDeskAppSettings['language']) {
  const groups = new Map<string, ShellDeskTerminalSnippet[]>();
  const ungroupedLabel = t('terminal.snippets.ungrouped', language);

  snippets.forEach((snippet) => {
    const groupLabel = snippet.group.trim() || ungroupedLabel;
    const groupSnippets = groups.get(groupLabel) ?? [];

    groupSnippets.push(snippet);
    groups.set(groupLabel, groupSnippets);
  });

  return Array.from(groups.entries()).map(([label, groupSnippets]) => ({
    label,
    snippets: groupSnippets,
  }));
}

export function getTerminalSnippetPreview(snippet: ShellDeskTerminalSnippet) {
  return snippet.command.split(/\r?\n/u)[0].trim();
}

export function quotePosixShellArg(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function createTmuxListCommand() {
  return [
    'if ! command -v tmux >/dev/null 2>&1; then exit 127; fi',
    `tmux list-sessions -F ${quotePosixShellArg('#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_created}\t#{session_last_attached}')} 2>/dev/null || true`,
  ].join('; ');
}

export function createTmuxAvailabilityCommand() {
  return 'command -v tmux >/dev/null 2>&1';
}

export function shouldResolveDefaultTmuxLaunch(
  desktopWindows: readonly Pick<DesktopWindowState, 'appKey'>[],
  hasPendingDefaultTerminal: boolean,
) {
  return !hasPendingDefaultTerminal
    && !desktopWindows.some((desktopWindow) => desktopWindow.appKey === 'terminal');
}

export function parseTmuxSessions(output: string): TmuxSessionInfo[] {
  return output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name = '', windows = '0', attached = '0', createdAt = '', lastAttachedAt = ''] = line.split('\t');
      return {
        name,
        windows: Number.parseInt(windows, 10) || 0,
        attached: Number.parseInt(attached, 10) || 0,
        createdAt: Number.isFinite(Number(createdAt)) ? Number(createdAt) : null,
        lastAttachedAt: Number.isFinite(Number(lastAttachedAt)) ? Number(lastAttachedAt) : null,
      };
    })
    .filter((session) => session.name.length > 0)
    .sort((first, second) => {
      const firstTime = first.lastAttachedAt ?? first.createdAt ?? 0;
      const secondTime = second.lastAttachedAt ?? second.createdAt ?? 0;
      return secondTime - firstTime || first.name.localeCompare(second.name);
    });
}

export function createTmuxSessionName() {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/u, '').replace('T', '-');
  return `shelldesk-${stamp}`;
}

export function createTmuxLaunchOptions(
  sessionName: string,
  language: ShellDeskAppSettings['language'],
  command: 'attach' | 'new' = 'attach',
): RemoteTerminalLaunchOptions {
  const quotedSessionName = quotePosixShellArg(sessionName);
  const windowLabel = language === 'zh-CN' ? '窗口' : 'Window';
  const startedLabel = language === 'zh-CN' ? '创建于' : 'Started';
  const quotedTitleFormat = quotePosixShellArg(`#S · ${windowLabel} #I:#W · ${startedLabel} #{t:session_created}`);
  const ensureSessionCommand = command === 'new'
    ? `tmux new-session -d -s ${quotedSessionName} 2>/dev/null || true`
    : `tmux has-session -t ${quotedSessionName} 2>/dev/null || tmux new-session -d -s ${quotedSessionName}`;

  return {
    mode: 'tmux',
    tmuxSessionName: sessionName,
    title: `tmux: ${sessionName}`,
    initialCommand: [
      ensureSessionCommand,
      `tmux set-option -t ${quotedSessionName} status off`,
      `tmux set-option -t ${quotedSessionName} mouse on`,
      `tmux set-option -t ${quotedSessionName} set-titles on`,
      `tmux set-option -t ${quotedSessionName} set-titles-string ${quotedTitleFormat}`,
      `tmux attach-session -t ${quotedSessionName}`,
    ].join('; '),
  };
}

export function hasTerminalLaunchOverrides(launchOptions?: RemoteTerminalLaunchOptions) {
  if (!launchOptions || launchOptions.mode === 'tmux') {
    return Boolean(launchOptions?.mode);
  }

  return [
    launchOptions.title,
    launchOptions.shell,
    launchOptions.initialCommand,
    launchOptions.workingDirectory,
  ].some((value) => Boolean(value?.trim()));
}

export function parseSimpleCommandWords(command: string) {
  const words: string[] = [];
  let word = '';
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];

    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        word += character;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }

    if (/\s/u.test(character)) {
      if (word) {
        words.push(word);
        word = '';
      }
      continue;
    }

    if (/[;&|<>`$(){}]/u.test(character)) {
      return null;
    }

    word += character;
  }

  if (quote) {
    return null;
  }

  if (word) {
    words.push(word);
  }

  return words;
}

export function getTmuxOptionValue(words: string[], optionNames: string[]) {
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];

    if (optionNames.includes(word)) {
      return words[index + 1] || '';
    }

    const matchedLongOption = optionNames
      .filter((optionName) => optionName.startsWith('--'))
      .find((optionName) => word.startsWith(`${optionName}=`));

    if (matchedLongOption) {
      return word.slice(matchedLongOption.length + 1);
    }
  }

  return '';
}

export function parseTmuxLaunchCommand(command: string): TmuxLaunchRequest | null {
  const words = parseSimpleCommandWords(command.trim());

  if (!words?.length || words[0] !== 'tmux') {
    return null;
  }

  let commandIndex = 1;
  while (commandIndex < words.length && words[commandIndex].startsWith('-')) {
    commandIndex += words[commandIndex] === '-L' || words[commandIndex] === '-S' || words[commandIndex] === '-f'
      ? 2
      : 1;
  }

  const tmuxCommand = words[commandIndex] ?? '';
  const commandArgs = words.slice(commandIndex + 1);

  if (!tmuxCommand || tmuxCommand === 'new' || tmuxCommand === 'new-session') {
    return {
      command: 'new',
      sessionName: getTmuxOptionValue(commandArgs, ['-s', '--session-name']) || createTmuxSessionName(),
    };
  }

  if (tmuxCommand === 'attach' || tmuxCommand === 'attach-session' || tmuxCommand === 'a') {
    const sessionName = getTmuxOptionValue(commandArgs, ['-t', '--target-session']);
    return sessionName ? { command: 'attach', sessionName } : null;
  }

  return null;
}

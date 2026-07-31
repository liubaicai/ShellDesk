import type { RemoteTerminalLaunchOptions } from './components/remote-desktop/RemoteTerminal';
import type { DesktopWindowFrame, DesktopWindowState, DesktopWindowWorkspace } from './remoteDesktopWindowModel';

const TERMINAL_WORKSPACE_VERSION = 1;
const TERMINAL_WORKSPACE_MAX_WINDOWS = 12;
const TERMINAL_SPLIT_GAP = 8;
const TERMINAL_SPLIT_MIN_WIDTH = 360;
const TERMINAL_SPLIT_MIN_HEIGHT = 260;
const MAX_METADATA_LENGTH = 1024;

export type TerminalWorkspaceSplitDirection = 'right' | 'down';

export interface TerminalWorkspaceEntry {
  frame: DesktopWindowFrame;
  isMaximized: boolean;
  isMinimized: boolean;
  launchOptions?: RemoteTerminalLaunchOptions;
}

export interface TerminalWorkspaceSnapshot {
  version: 1;
  updatedAt: string;
  windows: TerminalWorkspaceEntry[];
}

function finiteNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function boundedMetadata(value: unknown) {
  return typeof value === 'string' && value.trim()
    ? value.trim().slice(0, MAX_METADATA_LENGTH)
    : undefined;
}

export function sanitizeTerminalLaunchMetadata(
  launchOptions?: RemoteTerminalLaunchOptions,
): RemoteTerminalLaunchOptions | undefined {
  if (!launchOptions) return undefined;
  const mode = launchOptions.mode === 'tmux' ? 'tmux' : undefined;
  const sanitized: RemoteTerminalLaunchOptions = {
    title: boundedMetadata(launchOptions.title),
    shell: mode ? undefined : boundedMetadata(launchOptions.shell),
    workingDirectory: mode ? undefined : boundedMetadata(launchOptions.workingDirectory),
    mode,
    tmuxSessionName: mode ? boundedMetadata(launchOptions.tmuxSessionName) : undefined,
  };
  return Object.values(sanitized).some(Boolean) ? sanitized : undefined;
}

function parseFrame(value: unknown): DesktopWindowFrame | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const x = finiteNumber(candidate.x);
  const y = finiteNumber(candidate.y);
  const width = finiteNumber(candidate.width);
  const height = finiteNumber(candidate.height);
  if (x === null || y === null || width === null || height === null || width < 1 || height < 1) {
    return null;
  }
  return { x, y, width, height };
}

function parseLaunchOptions(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  return sanitizeTerminalLaunchMetadata({
    title: boundedMetadata(candidate.title),
    shell: boundedMetadata(candidate.shell),
    workingDirectory: boundedMetadata(candidate.workingDirectory),
    mode: candidate.mode === 'tmux' ? 'tmux' : undefined,
    tmuxSessionName: boundedMetadata(candidate.tmuxSessionName),
  });
}

export function parseTerminalWorkspaceSnapshot(value: unknown): TerminalWorkspaceSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== TERMINAL_WORKSPACE_VERSION || !Array.isArray(candidate.windows)) {
    return null;
  }
  const windows = candidate.windows
    .slice(0, TERMINAL_WORKSPACE_MAX_WINDOWS * 4)
    .map((entry): TerminalWorkspaceEntry | null => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
      const record = entry as Record<string, unknown>;
      const frame = parseFrame(record.frame);
      if (!frame) return null;
      return {
        frame,
        isMaximized: record.isMaximized === true,
        isMinimized: record.isMinimized === true,
        launchOptions: parseLaunchOptions(record.launchOptions),
      };
    })
    .filter((entry): entry is TerminalWorkspaceEntry => Boolean(entry))
    .slice(0, TERMINAL_WORKSPACE_MAX_WINDOWS);
  return {
    version: TERMINAL_WORKSPACE_VERSION,
    updatedAt: boundedMetadata(candidate.updatedAt) ?? new Date(0).toISOString(),
    windows,
  };
}

export function createTerminalWorkspaceSnapshot(
  desktopWindows: readonly DesktopWindowState[],
): TerminalWorkspaceSnapshot {
  return {
    version: TERMINAL_WORKSPACE_VERSION,
    updatedAt: new Date().toISOString(),
    windows: desktopWindows
      .filter((desktopWindow) => desktopWindow.appKey === 'terminal')
      .slice(0, TERMINAL_WORKSPACE_MAX_WINDOWS)
      .map((desktopWindow) => ({
        frame: { ...(desktopWindow.isMaximized ? desktopWindow.previousFrame ?? desktopWindow.frame : desktopWindow.frame) },
        isMaximized: desktopWindow.isMaximized,
        isMinimized: desktopWindow.isMinimized,
        launchOptions: sanitizeTerminalLaunchMetadata(desktopWindow.terminalLaunchOptions),
      })),
  };
}

export function terminalWorkspaceStorageKey(host: {
  id?: string;
  address: string;
  port: number;
  username: string;
}) {
  const identity = host.id?.trim() || `${host.username}@${host.address}:${host.port}`;
  return `shelldesk.terminal-workspace.v${TERMINAL_WORKSPACE_VERSION}.${encodeURIComponent(identity)}`;
}

export function readTerminalWorkspace(storage: Storage, key: string) {
  try {
    const value = storage.getItem(key);
    return value ? parseTerminalWorkspaceSnapshot(JSON.parse(value)) : null;
  } catch {
    return null;
  }
}

export function writeTerminalWorkspace(
  storage: Storage,
  key: string,
  snapshot: TerminalWorkspaceSnapshot,
) {
  try {
    if (snapshot.windows.length) {
      storage.setItem(key, JSON.stringify(snapshot));
    } else {
      storage.removeItem(key);
    }
  } catch {
    // Workspace persistence is best-effort in WebViews with restricted storage.
  }
}

export function splitTerminalWorkspaceFrame(
  frame: DesktopWindowFrame,
  workspace: DesktopWindowWorkspace,
  direction: TerminalWorkspaceSplitDirection,
): [DesktopWindowFrame, DesktopWindowFrame] | null {
  if (direction === 'right') {
    const availableWidth = workspace.x + workspace.width - frame.x;
    const totalWidth = Math.min(
      availableWidth,
      Math.max(frame.width, TERMINAL_SPLIT_MIN_WIDTH * 2 + TERMINAL_SPLIT_GAP),
    );
    if (totalWidth < TERMINAL_SPLIT_MIN_WIDTH * 2 + TERMINAL_SPLIT_GAP) return null;
    const firstWidth = Math.floor((totalWidth - TERMINAL_SPLIT_GAP) / 2);
    return [
      { ...frame, width: firstWidth },
      {
        x: frame.x + firstWidth + TERMINAL_SPLIT_GAP,
        y: frame.y,
        width: totalWidth - firstWidth - TERMINAL_SPLIT_GAP,
        height: frame.height,
      },
    ];
  }

  const availableHeight = workspace.y + workspace.height - frame.y;
  const totalHeight = Math.min(
    availableHeight,
    Math.max(frame.height, TERMINAL_SPLIT_MIN_HEIGHT * 2 + TERMINAL_SPLIT_GAP),
  );
  if (totalHeight < TERMINAL_SPLIT_MIN_HEIGHT * 2 + TERMINAL_SPLIT_GAP) return null;
  const firstHeight = Math.floor((totalHeight - TERMINAL_SPLIT_GAP) / 2);
  return [
    { ...frame, height: firstHeight },
    {
      x: frame.x,
      y: frame.y + firstHeight + TERMINAL_SPLIT_GAP,
      width: frame.width,
      height: totalHeight - firstHeight - TERMINAL_SPLIT_GAP,
    },
  ];
}

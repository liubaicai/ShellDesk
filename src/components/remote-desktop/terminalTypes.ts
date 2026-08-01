import type { RemoteSystemType } from './types';

export type RemoteTerminalSessionStatus = 'idle' | 'running' | 'exited' | 'disconnected';

export interface RemoteTerminalLaunchOptions {
  title?: string;
  shell?: string;
  initialCommand?: string;
  workingDirectory?: string;
  mode?: 'tmux';
  tmuxSessionName?: string;
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

export interface RemoteTerminalExitResult {
  code: number | null;
  signal: string | null;
}

export interface RemoteTerminalCommandRequest {
  id: string;
  command: string;
  mode: 'insert' | 'run';
  source?: 'snippet' | 'deployment' | 'external';
}

export type RemoteTerminalSplitDirection = 'right' | 'down';

export type RemoteTerminalToolAction =
  | 'new-terminal'
  | 'search'
  | 'clear'
  | 'toggle-follow'
  | 'scroll-bottom'
  | 'restart'
  | 'toggle-log'
  | 'paste-image'
  | 'compose'
  | 'settings'
  | 'split-right'
  | 'split-down';

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

export type RemoteTerminalSessionEventInput =
  | Omit<Extract<RemoteTerminalSessionEvent, { type: 'terminal-command' }>, 'terminalId' | 'timestamp' | 'title'>
  | Omit<Extract<RemoteTerminalSessionEvent, { type: 'terminal-output' }>, 'terminalId' | 'timestamp' | 'title'>;

export type ForegroundTaskSource = 'alternate-screen' | 'command';

export interface RemoteTerminalProps {
  connectionId: string;
  terminalId: string;
  settings: ShellDeskAppSettings;
  connectionKind?: 'ssh' | 'local';
  systemType?: RemoteSystemType;
  launchOptions?: RemoteTerminalLaunchOptions;
  commandRequest?: RemoteTerminalCommandRequest | null;
  toolRequest?: RemoteTerminalToolRequest | null;
  isVisible?: boolean;
  onChromeChange?: (payload: RemoteTerminalChromePayload) => void;
  onCommandRequestHandled?: (requestId: string) => void;
  onToolRequestHandled?: (requestId: string) => void;
  onSplitTerminal?: (direction: RemoteTerminalSplitDirection, workingDirectory: string) => void;
  onOpenTerminal?: (options?: RemoteTerminalLaunchOptions) => void;
  onOpenNote?: (note: { title: string; content: string }) => void;
  onCommandIntercept?: (command: string) => boolean;
  onSessionEvent?: (event: RemoteTerminalSessionEvent) => void;
  onSessionStateChange?: (state: RemoteTerminalSessionState) => void;
  onSessionExit?: (result: RemoteTerminalExitResult) => void;
  onSettingsChange?: (settings: ShellDeskAppSettings) => void;
}

export interface TerminalContextMenuState {
  x: number;
  y: number;
  selection: string;
}

export interface TerminalSearchResultState {
  index: number;
  count: number;
}

export type TerminalLaunchDraft = Required<Omit<RemoteTerminalLaunchOptions, 'mode' | 'tmuxSessionName'>>;

export interface TerminalTransferCommand {
  action: 'rz' | 'sz';
  command: string;
  inputData: string;
  needsLineClear: boolean;
  remotePaths: string[];
}

export interface TerminalCwdProbeState {
  beginMarker: string;
  endMarker: string;
  buffer: string;
  hasBeginMarker: boolean;
  timer: number;
  resolve: (directory: string) => void;
}

export interface TerminalBufferLineLike {
  isWrapped?: boolean;
  translateToString: (trimRight?: boolean) => string;
}

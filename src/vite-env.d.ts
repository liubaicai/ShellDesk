import type * as React from 'react';

type WebviewProps = React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
  src?: string;
  partition?: string;
  allowpopups?: string;
  webpreferences?: string;
};

interface GuiSshWindowControls {
  minimize: () => Promise<void>;
  toggleMaximize: () => Promise<boolean>;
  close: () => Promise<void>;
}

interface GuiSshFileControls {
  selectPrivateKeyFile: () => Promise<string>;
}

interface GuiSshHostConnectionRequest {
  name: string;
  address: string;
  port: number;
  username: string;
  authMethod: 'password' | 'key';
  password: string;
  keyPath: string;
  passphrase: string;
}

interface GuiSshConnectionInfo {
  id: string;
  partition: string;
  proxyPort: number;
  connectedAt: string;
  host: Pick<GuiSshHostConnectionRequest, 'name' | 'address' | 'port' | 'username' | 'authMethod'>;
}

interface GuiSshRemoteFileEntry {
  name: string;
  longname: string;
  type: 'directory' | 'file' | 'symlink';
  size: number;
  modifiedAt: string;
}

interface GuiSshRemoteDirectoryResult {
  path: string;
  entries: GuiSshRemoteFileEntry[];
}

interface GuiSshRemoteStatusReport {
  refreshedAt: string;
  items: Array<{
    key: string;
    label: string;
    value: string;
  }>;
}

interface GuiSshIpcCapabilities {
  terminalSessions: boolean;
}

interface GuiSshTerminalIpcOptions {
  legacy?: boolean;
}

interface GuiSshConnectionControls {
  connect: (host: GuiSshHostConnectionRequest) => Promise<GuiSshConnectionInfo>;
  disconnect: (connectionId: string) => Promise<boolean>;
  getIpcCapabilities: () => Promise<GuiSshIpcCapabilities>;
  startTerminal: (
    connectionId: string,
    terminalId: string,
    columns: number,
    rows: number,
    options?: GuiSshTerminalIpcOptions,
  ) => Promise<boolean>;
  writeTerminal: (
    connectionId: string,
    terminalId: string,
    data: string,
    options?: GuiSshTerminalIpcOptions,
  ) => Promise<boolean>;
  resizeTerminal: (
    connectionId: string,
    terminalId: string,
    columns: number,
    rows: number,
    options?: GuiSshTerminalIpcOptions,
  ) => Promise<boolean>;
  closeTerminal: (connectionId: string, terminalId: string) => Promise<boolean>;
  listDirectory: (connectionId: string, remotePath: string) => Promise<GuiSshRemoteDirectoryResult>;
  createDirectory: (connectionId: string, remotePath: string) => Promise<boolean>;
  deletePath: (connectionId: string, remotePath: string, entryType: 'directory' | 'file' | 'symlink') => Promise<boolean>;
  getStatus: (connectionId: string) => Promise<GuiSshRemoteStatusReport>;
}

interface GuiSshEventControls {
  onTerminalData: (callback: (payload: { connectionId: string; terminalId?: string; data: string }) => void) => () => void;
  onTerminalExit: (callback: (payload: { connectionId: string; terminalId?: string }) => void) => () => void;
  onConnectionClosed: (callback: (payload: { connectionId: string; reason?: string }) => void) => () => void;
}

interface GuiSshApi {
  appName: string;
  platform: NodeJS.Platform;
  window: GuiSshWindowControls;
  files: GuiSshFileControls;
  connections: GuiSshConnectionControls;
  events: GuiSshEventControls;
}

declare global {
  namespace JSX {
    interface IntrinsicElements {
      webview: WebviewProps;
    }
  }

  interface Window {
    guiSSH?: GuiSshApi;
  }
}

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      webview: WebviewProps;
    }
  }
}

export {};

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

interface GuiSshConnectionControls {
  connect: (host: GuiSshHostConnectionRequest) => Promise<GuiSshConnectionInfo>;
  disconnect: (connectionId: string) => Promise<boolean>;
  startTerminal: (connectionId: string) => Promise<boolean>;
  writeTerminal: (connectionId: string, data: string) => Promise<boolean>;
  resizeTerminal: (connectionId: string, columns: number, rows: number) => Promise<boolean>;
  listDirectory: (connectionId: string, remotePath: string) => Promise<GuiSshRemoteDirectoryResult>;
  createDirectory: (connectionId: string, remotePath: string) => Promise<boolean>;
  deletePath: (connectionId: string, remotePath: string, entryType: 'directory' | 'file' | 'symlink') => Promise<boolean>;
  getStatus: (connectionId: string) => Promise<GuiSshRemoteStatusReport>;
}

interface GuiSshEventControls {
  onTerminalData: (callback: (payload: { connectionId: string; data: string }) => void) => () => void;
  onTerminalExit: (callback: (payload: { connectionId: string }) => void) => () => void;
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

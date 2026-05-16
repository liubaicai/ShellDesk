import type * as React from 'react';

type WebviewProps = React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
  src?: string;
  partition?: string;
  allowpopups?: string;
  webpreferences?: string;
};

declare global {
interface GuiSshWindowControls {
  minimize: () => Promise<void>;
  toggleMaximize: () => Promise<boolean>;
  close: () => Promise<void>;
}

interface GuiSshFileControls {
  selectPrivateKeyFile: () => Promise<string>;
  selectPublicKeyFile: () => Promise<string>;
  importConfig: () => Promise<GuiSshConfigImportResult | null>;
  exportConfig: () => Promise<string>;
}

interface GuiSshAppSettings {
  language: 'zh-CN' | 'en-US';
  interfaceFont: 'Space Grotesk' | 'Segoe UI' | 'Inter';
  theme: 'light' | 'dark' | 'system';
  accentColor: string;
  defaultHostView: 'grid' | 'list';
  rememberPasswords: boolean;
  rememberKeyPassphrases: boolean;
  terminalFontSize: number;
  terminalCursorStyle: 'block' | 'bar' | 'underline';
  terminalScrollback: number;
  terminalCopyOnSelect: boolean;
}

interface GuiSshStoredKeyRecord {
  id: string;
  name: string;
  source: 'imported' | 'generated';
  algorithm: string;
  fingerprint: string;
  publicKey: string;
  passphrase: string;
  createdAt: string;
  updatedAt: string;
}

interface GuiSshStoredHostRecord {
  id: string;
  name: string;
  address: string;
  port: number;
  username: string;
  authMethod: 'password' | 'key';
  password: string;
  keyId: string;
  keyPath?: string;
  passphrase?: string;
  group: string;
  tags: string[];
  note: string;
  createdAt: string;
  updatedAt: string;
}

interface GuiSshBrowserBookmark {
  id: string;
  title: string;
  url: string;
  createdAt: string;
  updatedAt: string;
}

interface GuiSshBrowserBookmarkCollection {
  scope: string;
  bookmarks: GuiSshBrowserBookmark[];
  updatedAt: string;
}

interface GuiSshStorageInfo {
  path: string;
  protected: boolean;
  protectionLabel: string;
}

interface GuiSshVaultSnapshot {
  hosts: GuiSshStoredHostRecord[];
  sshKeys: GuiSshStoredKeyRecord[];
  settings: GuiSshAppSettings;
  browserBookmarks: GuiSshBrowserBookmarkCollection[];
  storage: GuiSshStorageInfo;
}

interface GuiSshConfigImportResult extends GuiSshVaultSnapshot {}

interface GuiSshVaultCollectionsPayload {
  hosts: GuiSshStoredHostRecord[];
  sshKeys: GuiSshStoredKeyRecord[];
  settings: GuiSshAppSettings;
}

interface GuiSshVaultControls {
  getSnapshot: () => Promise<GuiSshVaultSnapshot>;
  saveCollections: (payload: GuiSshVaultCollectionsPayload) => Promise<GuiSshVaultSnapshot>;
  migrateLegacyData: (payload: Partial<GuiSshVaultSnapshot>) => Promise<GuiSshVaultSnapshot>;
  importKeyPair: (payload: {
    name: string;
    privateKeyPath: string;
    publicKeyPath: string;
    passphrase: string;
  }) => Promise<{ snapshot: GuiSshVaultSnapshot; key: GuiSshStoredKeyRecord }>;
  generateRsaKeyPair: (payload: {
    name: string;
    passphrase: string;
    modulusLength: number;
  }) => Promise<{ snapshot: GuiSshVaultSnapshot; key: GuiSshStoredKeyRecord }>;
  getBookmarks: (scope: string) => Promise<GuiSshBrowserBookmark[]>;
  saveBookmarks: (scope: string, bookmarks: GuiSshBrowserBookmark[]) => Promise<GuiSshBrowserBookmark[]>;
}

interface GuiSshHostConnectionRequest {
  name: string;
  address: string;
  port: number;
  username: string;
  authMethod: 'password' | 'key';
  password: string;
  keyId: string;
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
  getInfo: (connectionId: string) => Promise<GuiSshConnectionInfo>;
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
  renamePath: (connectionId: string, oldPath: string, newPath: string) => Promise<boolean>;
  createFile: (connectionId: string, remotePath: string) => Promise<boolean>;
  readFile: (connectionId: string, remotePath: string) => Promise<string>;
  writeFile: (connectionId: string, remotePath: string, content: string) => Promise<boolean>;
  downloadFile: (connectionId: string, remotePath: string) => Promise<{ canceled: boolean; filePath?: string; size?: number }>;
  uploadFile: (connectionId: string, remotePath: string) => Promise<{ canceled: boolean; remotePath?: string; size?: number }>;
  compress: (connectionId: string, sourcePaths: string[], format: string, destPath: string) => Promise<{ format: string; destPath: string }>;
  decompress: (connectionId: string, archivePath: string, destDir?: string) => Promise<{ archivePath: string; destDir: string }>;
  statPath: (connectionId: string, remotePath: string) => Promise<{
    type: string;
    size: number;
    mode: number;
    owner: number;
    group: number;
    modifiedAt: string;
    accessedAt: string;
  }>;
  getStatus: (connectionId: string) => Promise<GuiSshRemoteStatusReport>;
  mysqlConnect: (connectionId: string, config: GuiSshMysqlConnectConfig) => Promise<{ mysqlId: string; alreadyConnected?: boolean }>;
  mysqlDisconnect: (connectionId: string, mysqlId: string) => Promise<boolean>;
  mysqlDatabases: (connectionId: string, mysqlId: string) => Promise<string[]>;
  mysqlTables: (connectionId: string, mysqlId: string, database: string) => Promise<string[]>;
  mysqlColumns: (connectionId: string, mysqlId: string, database: string, table: string) => Promise<GuiSshMysqlColumn[]>;
  mysqlQuery: (connectionId: string, mysqlId: string, sql: string, database?: string) => Promise<GuiSshMysqlQueryResult>;
  mysqlUpdateCell: (
    connectionId: string,
    mysqlId: string,
    database: string,
    table: string,
    pkColumn: string,
    pkValue: unknown,
    column: string,
    newValue: unknown,
    pkColumns?: string[],
    pkValues?: unknown[],
  ) => Promise<{ affectedRows: number }>;
}

interface GuiSshMysqlConnectConfig {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  mysqlId?: string;
}

interface GuiSshMysqlColumn {
  name: string;
  type: string;
  nullable: boolean;
  key: string;
  default: string | null;
  extra: string;
  comment: string;
}

interface GuiSshMysqlQueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  affectedRows?: number;
  insertId?: string;
}

interface GuiSshEventControls {
  onTerminalData: (callback: (payload: { connectionId: string; terminalId?: string; data: string }) => void) => () => void;
  onTerminalExit: (callback: (payload: { connectionId: string; terminalId?: string }) => void) => () => void;
  onConnectionClosed: (callback: (payload: { connectionId: string; reason?: string }) => void) => () => void;
  onVaultChanged: (callback: (payload: { kind: 'vault' | 'bookmarks'; scope?: string }) => void) => () => void;
}

interface GuiSshApi {
  appName: string;
  platform: NodeJS.Platform;
  window: GuiSshWindowControls;
  files: GuiSshFileControls;
  vault: GuiSshVaultControls;
  connections: GuiSshConnectionControls;
  events: GuiSshEventControls;
}
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

import type * as React from 'react';

declare module '*.png' {
  const src: string;
  export default src;
}

type WebviewProps = React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
  src?: string;
  partition?: string;
  allowpopups?: string;
  webpreferences?: string;
};

declare global {
interface ShellDeskWindowControls {
  minimize: () => Promise<void>;
  toggleMaximize: () => Promise<boolean>;
  close: () => Promise<void>;
}

interface ShellDeskFileControls {
  selectPrivateKeyFile: () => Promise<string>;
  selectPublicKeyFile: () => Promise<string>;
  importConfig: () => Promise<ShellDeskConfigImportResult | null>;
  exportConfig: () => Promise<string>;
}

interface ShellDeskAppSettings {
  language: 'zh-CN' | 'en-US';
  interfaceFont:
    | 'LXGW WenKai Mono'
    | 'Microsoft YaHei UI'
    | 'DengXian'
    | 'SimSun'
    | 'Arial'
    | 'Verdana'
    | 'Georgia'
    | 'Times New Roman';
  theme: 'light' | 'dark' | 'system';
  accentColor: string;
  defaultHostView: 'grid' | 'list';
  desktopWallpaperMode: 'default' | 'custom';
  desktopWallpaperDataUrl: string;
  desktopWallpaperName: string;
  rememberPasswords: boolean;
  rememberKeyPassphrases: boolean;
  terminalFontSize: number;
  terminalFontFamily:
    | 'Cascadia Mono'
    | 'JetBrains Mono'
    | 'Fira Code'
    | 'Consolas'
    | 'LXGW WenKai Mono'
    | 'Source Code Pro'
    | 'Hack'
    | 'Menlo'
    | 'Monaco'
    | 'Courier New';
  terminalFontWeight: number;
  terminalFontWeightBold: number;
  terminalFontLigatures: boolean;
  terminalLineHeight: number;
  terminalTheme:
    | 'shelldesk-dark'
    | 'netcatty-dark'
    | 'tokyo-night'
    | 'dracula'
    | 'monokai'
    | 'solarized-light'
    | 'netcatty-light'
    | 'hacker-green';
  terminalCursorBlink: boolean;
  terminalCursorStyle: 'block' | 'bar' | 'underline';
  terminalCursorInactiveStyle: 'outline' | 'block' | 'bar' | 'underline' | 'none';
  terminalScrollback: number;
  terminalScrollSensitivity: number;
  terminalFastScrollSensitivity: number;
  terminalScrollOnUserInput: boolean;
  terminalScrollOnEraseInDisplay: boolean;
  terminalCopyOnSelect: boolean;
  terminalRightClickPaste: boolean;
  terminalAltClickMovesCursor: boolean;
  terminalBracketedPasteMode: boolean;
  terminalMinimumContrastRatio: number;
  terminalScreenReaderMode: boolean;
}

interface ShellDeskStoredKeyRecord {
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

type ShellDeskHostSystemType =
  | 'unknown'
  | 'windows'
  | 'ubuntu'
  | 'debian'
  | 'redhat'
  | 'centos'
  | 'fedora'
  | 'rocky'
  | 'almalinux'
  | 'oracle'
  | 'amazon'
  | 'arch'
  | 'manjaro'
  | 'alpine'
  | 'opensuse'
  | 'linuxmint'
  | 'kali'
  | 'raspbian'
  | 'gentoo'
  | 'nixos'
  | 'popos'
  | 'elementary'
  | 'linux'
  | 'unix';

interface ShellDeskStoredHostRecord {
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
  systemType?: ShellDeskHostSystemType;
  systemName?: string;
  group: string;
  tags: string[];
  note: string;
  createdAt: string;
  updatedAt: string;
}

interface ShellDeskBrowserBookmark {
  id: string;
  title: string;
  url: string;
  createdAt: string;
  updatedAt: string;
}

interface ShellDeskBrowserBookmarkCollection {
  scope: string;
  bookmarks: ShellDeskBrowserBookmark[];
  updatedAt: string;
}

interface ShellDeskStorageInfo {
  path: string;
  protected: boolean;
  protectionLabel: string;
}

interface ShellDeskVaultSnapshot {
  hosts: ShellDeskStoredHostRecord[];
  sshKeys: ShellDeskStoredKeyRecord[];
  settings: ShellDeskAppSettings;
  browserBookmarks: ShellDeskBrowserBookmarkCollection[];
  storage: ShellDeskStorageInfo;
}

interface ShellDeskConfigImportResult extends ShellDeskVaultSnapshot {}

interface ShellDeskVaultCollectionsPayload {
  hosts: ShellDeskStoredHostRecord[];
  sshKeys: ShellDeskStoredKeyRecord[];
  settings: ShellDeskAppSettings;
}

interface ShellDeskVaultControls {
  getSnapshot: () => Promise<ShellDeskVaultSnapshot>;
  saveCollections: (payload: ShellDeskVaultCollectionsPayload) => Promise<ShellDeskVaultSnapshot>;
  migrateLegacyData: (payload: Partial<ShellDeskVaultSnapshot>) => Promise<ShellDeskVaultSnapshot>;
  importKeyPair: (payload: {
    name: string;
    privateKeyPath: string;
    publicKeyPath: string;
    passphrase: string;
  }) => Promise<{ snapshot: ShellDeskVaultSnapshot; key: ShellDeskStoredKeyRecord }>;
  generateRsaKeyPair: (payload: {
    name: string;
    passphrase: string;
    modulusLength: number;
  }) => Promise<{ snapshot: ShellDeskVaultSnapshot; key: ShellDeskStoredKeyRecord }>;
  getBookmarks: (scope: string) => Promise<ShellDeskBrowserBookmark[]>;
  saveBookmarks: (scope: string, bookmarks: ShellDeskBrowserBookmark[]) => Promise<ShellDeskBrowserBookmark[]>;
}

interface ShellDeskHostConnectionRequest {
  name: string;
  address: string;
  port: number;
  username: string;
  authMethod: 'password' | 'key' | 'agent';
  password: string;
  keyId: string;
  keyPath: string;
  passphrase: string;
  systemType?: ShellDeskHostSystemType;
  systemName?: string;
}

interface ShellDeskConnectionInfo {
  id: string;
  partition: string;
  proxyPort: number;
  connectedAt: string;
  host: Pick<ShellDeskHostConnectionRequest, 'name' | 'address' | 'port' | 'username' | 'authMethod' | 'systemType' | 'systemName'>;
}

interface ShellDeskRemoteFileEntry {
  name: string;
  longname: string;
  type: 'directory' | 'file' | 'symlink';
  size: number;
  modifiedAt: string;
}

interface ShellDeskRemoteDirectoryResult {
  path: string;
  entries: ShellDeskRemoteFileEntry[];
}

interface ShellDeskRemoteStatusReport {
  refreshedAt: string;
  items: Array<{
    key: string;
    label: string;
    value: string;
  }>;
}

interface ShellDeskRemoteSystemInfoReport {
  refreshedAt: string;
  items: Array<{
    key: string;
    label: string;
    icon: string;
    value: string;
  }>;
}

interface ShellDeskRemoteMetricsReport {
  refreshedAt: string;
  cpuPercent: number;
  memoryPercent: number;
  netRxBytes: number;
  netTxBytes: number;
}

interface ShellDeskIpcCapabilities {
  terminalSessions: boolean;
}

interface ShellDeskTerminalIpcOptions {
  legacy?: boolean;
  title?: string;
  shell?: string;
  initialCommand?: string;
  workingDirectory?: string;
}

interface ShellDeskConnectionControls {
  connect: (host: ShellDeskHostConnectionRequest) => Promise<ShellDeskConnectionInfo>;
  getInfo: (connectionId: string) => Promise<ShellDeskConnectionInfo>;
  disconnect: (connectionId: string) => Promise<boolean>;
  getIpcCapabilities: () => Promise<ShellDeskIpcCapabilities>;
  startTerminal: (
    connectionId: string,
    terminalId: string,
    columns: number,
    rows: number,
    options?: ShellDeskTerminalIpcOptions,
  ) => Promise<boolean>;
  writeTerminal: (
    connectionId: string,
    terminalId: string,
    data: string,
    options?: ShellDeskTerminalIpcOptions,
  ) => Promise<boolean>;
  resizeTerminal: (
    connectionId: string,
    terminalId: string,
    columns: number,
    rows: number,
    options?: ShellDeskTerminalIpcOptions,
  ) => Promise<boolean>;
  closeTerminal: (connectionId: string, terminalId: string) => Promise<boolean>;
  listDirectory: (connectionId: string, remotePath: string) => Promise<ShellDeskRemoteDirectoryResult>;
  createDirectory: (connectionId: string, remotePath: string) => Promise<boolean>;
  deletePath: (connectionId: string, remotePath: string, entryType: 'directory' | 'file' | 'symlink') => Promise<boolean>;
  renamePath: (connectionId: string, oldPath: string, newPath: string) => Promise<boolean>;
  createFile: (connectionId: string, remotePath: string) => Promise<boolean>;
  readFile: (connectionId: string, remotePath: string) => Promise<string>;
  writeFile: (connectionId: string, remotePath: string, content: string) => Promise<boolean>;
  downloadFile: (connectionId: string, remotePath: string) => Promise<{ canceled: boolean; filePath?: string; size?: number }>;
  uploadFile: (connectionId: string, remotePath: string) => Promise<{ canceled: boolean; remotePath?: string; size?: number }>;
  cancelTransfer: (connectionId: string) => Promise<void>;
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
  getStatus: (connectionId: string) => Promise<ShellDeskRemoteStatusReport>;
  getSystemInfo: (connectionId: string) => Promise<ShellDeskRemoteSystemInfoReport>;
  getMetrics: (connectionId: string) => Promise<ShellDeskRemoteMetricsReport>;
  runCommand: (connectionId: string, command: string) => Promise<{ stdout: string; stderr: string; code: number }>;
  mysqlConnect: (connectionId: string, config: ShellDeskMysqlConnectConfig) => Promise<{ mysqlId: string; alreadyConnected?: boolean }>;
  mysqlDisconnect: (connectionId: string, mysqlId: string) => Promise<boolean>;
  mysqlDatabases: (connectionId: string, mysqlId: string) => Promise<string[]>;
  mysqlTables: (connectionId: string, mysqlId: string, database: string) => Promise<string[]>;
  mysqlColumns: (connectionId: string, mysqlId: string, database: string, table: string) => Promise<ShellDeskMysqlColumn[]>;
  mysqlQuery: (connectionId: string, mysqlId: string, sql: string, database?: string) => Promise<ShellDeskMysqlQueryResult>;
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
  redisConnect: (connectionId: string, config: ShellDeskRedisConnectConfig) => Promise<{ redisId: string; alreadyConnected?: boolean }>;
  redisDisconnect: (connectionId: string, redisId: string) => Promise<boolean>;
  redisKeys: (connectionId: string, redisId: string, pattern?: string) => Promise<{ name: string; type: string; ttl: number }[]>;
  redisGetValue: (connectionId: string, redisId: string, key: string) => Promise<{ type: string; value: unknown }>;
  redisSetValue: (connectionId: string, redisId: string, key: string, value: unknown, type: string) => Promise<boolean>;
  redisDeleteKey: (connectionId: string, redisId: string, key: string) => Promise<boolean>;
  redisCommand: (connectionId: string, redisId: string, command: string, args: string[]) => Promise<unknown>;
  vncProbe: (connectionId: string, config: ShellDeskVncConnectConfig) => Promise<ShellDeskVncProbeResult>;
  vncStart: (connectionId: string, config: ShellDeskVncConnectConfig) => Promise<ShellDeskVncProxyInfo>;
  vncStop: (connectionId: string, vncId: string) => Promise<boolean>;
  sqliteOpen: (connectionId: string, filePath: string) => Promise<{ sqliteId: string; filePath: string }>;
  sqliteClose: (connectionId: string, sqliteId: string) => Promise<boolean>;
  sqliteTables: (connectionId: string, sqliteId: string) => Promise<string[]>;
  sqliteColumns: (connectionId: string, sqliteId: string, table: string) => Promise<ShellDeskSqliteColumn[]>;
  sqliteQuery: (connectionId: string, sqliteId: string, sql: string) => Promise<ShellDeskSqliteQueryResult>;
}

interface ShellDeskMysqlConnectConfig {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  mysqlId?: string;
}

interface ShellDeskMysqlColumn {
  name: string;
  type: string;
  nullable: boolean;
  key: string;
  default: string | null;
  extra: string;
  comment: string;
}

interface ShellDeskMysqlQueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  affectedRows?: number;
  insertId?: string;
}

interface ShellDeskSqliteColumn {
  name: string;
  type: string;
  nullable: boolean;
  pk: boolean;
  defaultValue: string | null;
}

interface ShellDeskSqliteQueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
}

interface ShellDeskRedisConnectConfig {
  host?: string;
  port?: number;
  password?: string;
  db?: number;
  redisId?: string;
}

interface ShellDeskVncConnectConfig {
  host?: string;
  port?: number;
  vncId?: string;
}

interface ShellDeskVncProxyInfo {
  vncId: string;
  host: string;
  port: number;
  webSocketUrl: string;
}

interface ShellDeskVncSecurityType {
  code: number;
  name: string;
}

interface ShellDeskVncProbeResult {
  host: string;
  port: number;
  banner: string;
  version: string;
  securityTypes: ShellDeskVncSecurityType[];
}

interface ShellDeskVncDiagnosticPayload {
  connectionId: string;
  vncId: string;
  stage: string;
  detail: string;
}

interface ShellDeskLogEntry {
  id: string;
  timestamp: string;
  category: 'connection' | 'host' | 'key' | 'config' | 'system';
  level: 'info' | 'success' | 'warning' | 'error';
  message: string;
  detail: string;
}

interface ShellDeskLogsControls {
  getEntries: () => Promise<ShellDeskLogEntry[]>;
  saveEntries: (entries: ShellDeskLogEntry[]) => Promise<ShellDeskLogEntry[]>;
}

interface ShellDeskTransferProgress {
  type: 'download' | 'upload';
  fileName: string;
  transferred: number;
  total: number;
}

interface ShellDeskTransferEndPayload {
  type: 'download' | 'upload';
  fileName: string;
  transferred: number;
  total: number;
  success: boolean;
  error?: string;
}

interface ShellDeskEventControls {
  onTerminalData: (callback: (payload: { connectionId: string; terminalId?: string; data: string }) => void) => () => void;
  onTerminalExit: (callback: (payload: { connectionId: string; terminalId?: string; code?: number | null; signal?: string | null }) => void) => () => void;
  onVncDiagnostic: (callback: (payload: ShellDeskVncDiagnosticPayload) => void) => () => void;
  onConnectionClosed: (callback: (payload: { connectionId: string; reason?: string }) => void) => () => void;
  onVaultChanged: (callback: (payload: { kind: 'vault' | 'bookmarks'; scope?: string }) => void) => () => void;
  onTransferProgress: (callback: (payload: ShellDeskTransferProgress) => void) => () => void;
  onTransferEnd: (callback: (payload: ShellDeskTransferEndPayload) => void) => () => void;
}

interface ShellDeskApi {
  appName: string;
  platform: NodeJS.Platform;
  window: ShellDeskWindowControls;
  files: ShellDeskFileControls;
  vault: ShellDeskVaultControls;
  logs: ShellDeskLogsControls;
  connections: ShellDeskConnectionControls;
  events: ShellDeskEventControls;
}
  namespace JSX {
    interface IntrinsicElements {
      webview: WebviewProps;
    }
  }

  interface Window {
    guiSSH?: ShellDeskApi;
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

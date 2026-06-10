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
  isMaximized: () => Promise<boolean>;
  close: () => Promise<void>;
}

interface ShellDeskAppInfo {
  name: string;
  productName: string;
  version: string;
  description: string;
  homepage: string;
  author: string;
  platform: NodeJS.Platform;
  arch: string;
  isPackaged: boolean;
}

interface ShellDeskTerminalSnippet {
  id: string;
  label: string;
  command: string;
  group: string;
  shortcut: string;
  createdAt: string;
  updatedAt: string;
}

type ShellDeskProxyType = 'http' | 'socks5' | 'command';

interface ShellDeskProxyConfig {
  type: ShellDeskProxyType;
  host: string;
  port: number;
  command?: string;
  username?: string;
  password?: string;
}

interface ShellDeskProxyProfile {
  id: string;
  label: string;
  config: ShellDeskProxyConfig;
  createdAt: string;
  updatedAt: string;
}

interface ShellDeskProxyTestTarget {
  kind?: 'http' | 'ssh';
  host?: string;
  port?: number;
  timeoutMs?: number;
}

interface ShellDeskProxyTestResult {
  ok: boolean;
  targetHost: string;
  targetPort: number;
  latencyMs: number;
  checkedAt: string;
  error: string;
}

interface ShellDeskKnownHost {
  id: string;
  hostname: string;
  port: number;
  keyType: string;
  publicKey: string;
  fingerprint: string;
  discoveredAt: string;
  lastSeen?: string;
  convertedToHostId?: string;
}

interface ShellDeskKnownHostsReadResult {
  content: string;
  paths: string[];
}

interface ShellDeskUpdateCheckResult {
  repository: string;
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  releaseName: string;
  releaseTag: string;
  releaseUrl: string;
  releaseDate: string | null;
  latestYmlUrl: string;
  downloadName: string;
  downloadUrl: string | null;
  downloadSize: number;
  checkedAt: string;
}

type ShellDeskUpdateStatusValue = 'idle' | 'available' | 'downloading' | 'ready' | 'error';

interface ShellDeskUpdateStatus {
  status: ShellDeskUpdateStatusValue;
  percent: number;
  error: string | null;
  version: string | null;
  releaseNotes: string;
  releaseDate: string | null;
  isChecking: boolean;
  supported: boolean;
  unsupportedReason: string;
  checkedAt: string | null;
}

interface ShellDeskAutoUpdateCheckResult {
  available: boolean;
  supported: boolean;
  checking?: boolean;
  downloading?: boolean;
  ready?: boolean;
  version?: string | null;
  releaseNotes?: string;
  releaseDate?: string | null;
  error?: string;
}

interface ShellDeskUpdateActionResult {
  success: boolean;
  error?: string;
}

interface ShellDeskUpdateDownloadProgress extends ShellDeskUpdateStatus {
  bytesPerSecond: number;
  transferred: number;
  total: number;
}

interface ShellDeskAppControls {
  getInfo: () => Promise<ShellDeskAppInfo>;
  checkForUpdates: () => Promise<ShellDeskUpdateCheckResult>;
  checkForUpdateDownload: () => Promise<ShellDeskAutoUpdateCheckResult>;
  downloadUpdate: () => Promise<ShellDeskUpdateActionResult>;
  installUpdate: () => Promise<boolean>;
  getUpdateStatus: () => Promise<ShellDeskUpdateStatus>;
  openExternal: (url: string) => Promise<boolean>;
}

interface ShellDeskFileControls {
  selectPrivateKeyFile: () => Promise<string>;
  selectPublicKeyFile: () => Promise<string>;
  importConfig: () => Promise<ShellDeskConfigImportResult | null>;
  exportConfig: () => Promise<string>;
  saveTextFile: (payload: { title?: string; defaultFileName?: string; content: string }) => Promise<string>;
}

type ShellDeskDesktopSortMode = 'custom' | 'name-asc' | 'name-desc';

type ShellDeskDesktopAppKey =
  | 'files'
  | 'terminal'
  | 'notepad'
  | 'browser'
  | 'vnc'
  | 'log-viewer'
  | 'monitor'
  | 'mysql'
  | 'clickhouse'
  | 'redis'
  | 'service-manager'
  | 'container-manager'
  | 'port-manager'
  | 'firewall-manager'
  | 'iptables-manager'
  | 'network-diagnostics'
  | 'disk-analyzer'
  | 'disk-manager'
  | 'package-manager'
  | 'git-manager'
  | 'web-server-manager'
  | 'scheduled-tasks'
  | 'postgres'
  | 'mongo'
  | 'search-cluster'
  | 'message-queue'
  | 's3-browser'
  | 'security-audit'
  | 'login-sessions'
  | 'api-debugger'
  | 'procmanager'
  | 'settings'
  | 'sqlite';

interface ShellDeskDesktopAppLayoutItem {
  id: string;
  type: 'app';
  appKey: ShellDeskDesktopAppKey;
}

interface ShellDeskDesktopFolderLayoutItem {
  id: string;
  type: 'folder';
  name: string;
  appKeys: ShellDeskDesktopAppKey[];
}

type ShellDeskDesktopLayoutItem = ShellDeskDesktopAppLayoutItem | ShellDeskDesktopFolderLayoutItem;

interface ShellDeskRemoteDesktopLayout {
  appCatalogVersion: number;
  sortMode: ShellDeskDesktopSortMode;
  items: ShellDeskDesktopLayoutItem[];
}

type ShellDeskAiProvider = 'openai' | 'anthropic' | 'openai-compatible' | 'custom';
type ShellDeskAiApiFormat = 'openai' | 'anthropic';

interface ShellDeskAiModelInfo {
  id: string;
  name: string;
  createdAt?: string;
  ownedBy?: string;
}

interface ShellDeskAiModelListRequest {
  provider: ShellDeskAiProvider;
  apiFormat: ShellDeskAiApiFormat;
  apiBaseUrl: string;
  apiKey: string;
}

interface ShellDeskAiModelListResult {
  endpoint: string;
  models: ShellDeskAiModelInfo[];
}

interface ShellDeskAiChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ShellDeskAiChatRequest {
  provider: ShellDeskAiProvider;
  apiFormat: ShellDeskAiApiFormat;
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  messages: ShellDeskAiChatMessage[];
  temperature?: number;
}

interface ShellDeskAiChatResult {
  endpoint: string;
  content: string;
}

interface ShellDeskAiChatStreamCallbacks {
  onChunk?: (chunk: string) => void;
}

interface ShellDeskAppSettings {
  language: 'zh-CN' | 'en-US';
  interfaceFont: string;
  theme: 'light' | 'dark' | 'system';
  accentColor: string;
  defaultHostView: 'grid' | 'list';
  minimizeToTrayOnClose: boolean;
  desktopWallpaperMode: 'preset' | 'custom';
  desktopWallpaperPresetId: string;
  desktopWallpaperDataUrl: string;
  desktopWallpaperName: string;
  remoteDesktopLayout: ShellDeskRemoteDesktopLayout;
  rememberPasswords: boolean;
  rememberKeyPassphrases: boolean;
  aiProvider: ShellDeskAiProvider;
  aiProviderName: string;
  aiApiFormat: ShellDeskAiApiFormat;
  aiApiBaseUrl: string;
  aiApiKey: string;
  aiModel: string;
  terminalFontSize: number;
  terminalFontFamily: string;
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
  terminalSnippets: ShellDeskTerminalSnippet[];
}

type ShellDeskRemoteConnectionProfileValue = string | number | boolean;
type ShellDeskRemoteConnectionProfileValues = Record<string, ShellDeskRemoteConnectionProfileValue>;

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
  | 'macos'
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

type ShellDeskPrivilegeMode = 'sudo' | 'su-root';

interface ShellDeskSudoPasswordOptions {
  sudoPassword?: string;
  transferClientId?: string;
}

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
  privilegeMode?: ShellDeskPrivilegeMode;
  rootPassword?: string;
  jumpHostId?: string;
  canBeJumpHost?: boolean;
  proxyProfileId?: string;
  systemType?: ShellDeskHostSystemType;
  systemName?: string;
  lastConnectionStatus?: 'unknown' | 'success' | 'failed';
  lastConnectionAt?: string;
  lastConnectionError?: string;
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
  configPath: string;
  vaultPath: string;
  protected: boolean;
  protectionLabel: string;
}

interface ShellDeskVaultSnapshot {
  hosts: ShellDeskStoredHostRecord[];
  sshKeys: ShellDeskStoredKeyRecord[];
  proxyProfiles: ShellDeskProxyProfile[];
  knownHosts: ShellDeskKnownHost[];
  settings: ShellDeskAppSettings;
  browserBookmarks: ShellDeskBrowserBookmarkCollection[];
  storage: ShellDeskStorageInfo;
}

interface ShellDeskConfigImportResult extends ShellDeskVaultSnapshot {}

interface ShellDeskVaultCollectionsPayload {
  hosts?: ShellDeskStoredHostRecord[];
  sshKeys?: ShellDeskStoredKeyRecord[];
  proxyProfiles?: ShellDeskProxyProfile[];
  knownHosts?: ShellDeskKnownHost[];
  settings?: ShellDeskAppSettings;
}

interface ShellDeskVaultControls {
  initialPublicSnapshot: ShellDeskVaultSnapshot | null;
  getPublicSnapshot: () => Promise<ShellDeskVaultSnapshot>;
  getSnapshot: () => Promise<ShellDeskVaultSnapshot>;
  saveCollections: (payload: ShellDeskVaultCollectionsPayload) => Promise<ShellDeskVaultSnapshot>;
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
  getRemoteConnectionProfile: (hostId: string, appKey: ShellDeskDesktopAppKey) => Promise<ShellDeskRemoteConnectionProfileValues | null>;
  saveRemoteConnectionProfile: (
    hostId: string,
    appKey: ShellDeskDesktopAppKey,
    values: ShellDeskRemoteConnectionProfileValues,
  ) => Promise<ShellDeskRemoteConnectionProfileValues>;
}

interface ShellDeskHostConnectionRequest {
  id?: string;
  name: string;
  address: string;
  port: number;
  username: string;
  authMethod: 'password' | 'key' | 'agent';
  password: string;
  keyId: string;
  keyPath: string;
  passphrase: string;
  privilegeMode?: ShellDeskPrivilegeMode;
  rootPassword?: string;
  jumpHostId?: string;
  proxyProfileId?: string;
  systemType?: ShellDeskHostSystemType;
  systemName?: string;
}

interface ShellDeskJumpHostConnectionInfo {
  id: string;
  name: string;
  address: string;
  port: number;
  username: string;
}

interface ShellDeskConnectionInfo {
  id: string;
  kind?: 'ssh' | 'local';
  partition: string;
  proxyPort: number;
  connectedAt: string;
  host: Pick<ShellDeskHostConnectionRequest, 'name' | 'address' | 'port' | 'username' | 'authMethod' | 'privilegeMode' | 'systemType' | 'systemName'> & {
    id?: string;
    jumpHost?: ShellDeskJumpHostConnectionInfo;
  };
}

interface ShellDeskRemoteFileEntry {
  name: string;
  longname: string;
  type: 'directory' | 'file' | 'symlink';
  targetType?: 'directory' | 'file' | 'symlink' | 'unknown';
  targetPath?: string;
  size: number;
  modifiedAt: string;
}

interface ShellDeskRemoteDirectoryResult {
  path: string;
  entries: ShellDeskRemoteFileEntry[];
}

interface ShellDeskRemotePathStat {
  type: string;
  size: number;
  mode: number;
  owner: number;
  group: number;
  modifiedAt: string;
  accessedAt: string;
}

interface ShellDeskRemotePathPermissionOptions extends ShellDeskSudoPasswordOptions {
  mode: number;
  recursive?: boolean;
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
  cpuPercent: number | null;
  memoryPercent: number | null;
  netRxBytes: number | null;
  netTxBytes: number | null;
}

interface ShellDeskIpcCapabilities {
  terminalSessions: boolean;
  terminalBinary?: boolean;
}

interface ShellDeskKeyboardInteractivePrompt {
  prompt: string;
  echo: boolean;
}

interface ShellDeskKeyboardInteractiveRequest {
  requestId: string;
  hostname: string;
  port: number;
  username: string;
  name: string;
  instructions: string;
  prompts: ShellDeskKeyboardInteractivePrompt[];
}

interface ShellDeskHostKeyVerificationRequest {
  requestId: string;
  hostname: string;
  port: number;
  username: string;
  status: 'unknown' | 'changed';
  keyType: string;
  fingerprint: string;
  publicKey?: string;
  knownHostId?: string;
  knownFingerprint?: string;
}

interface ShellDeskKeyboardInteractiveResponse {
  requestId: string;
  responses?: string[];
  cancel?: boolean;
}

interface ShellDeskHostKeyVerificationResponse {
  requestId: string;
  accept: boolean;
  addToKnownHosts?: boolean;
}

interface ShellDeskTerminalIpcOptions {
  legacy?: boolean;
  title?: string;
  shell?: string;
  initialCommand?: string;
  workingDirectory?: string;
}

interface ShellDeskRunCommandStreamCallbacks {
  onChunk?: (chunk: string, stream: 'stdout' | 'stderr') => void;
}

interface ShellDeskZmodemUploadFile {
  id: string;
  name: string;
  size: number;
  lastModified: number;
}

interface ShellDeskSelectedUploadItem {
  path: string;
  name: string;
  type: 'file' | 'directory';
  size: number;
  modifiedAt: string;
}

interface ShellDeskLocalUploadItem {
  path: string;
  remoteName?: string;
}

interface ShellDeskConnectionControls {
  connect: (host: ShellDeskHostConnectionRequest) => Promise<ShellDeskConnectionInfo>;
  openLocal: () => Promise<ShellDeskConnectionInfo>;
  respondKeyboardInteractive: (payload: ShellDeskKeyboardInteractiveResponse) => Promise<boolean>;
  respondHostKeyVerification: (payload: ShellDeskHostKeyVerificationResponse) => Promise<boolean>;
  getInfo: (connectionId: string) => Promise<ShellDeskConnectionInfo>;
  disconnect: (connectionId: string) => Promise<boolean>;
  getIpcCapabilities: () => Promise<ShellDeskIpcCapabilities>;
  trustBrowserCertificate: (partition: string, url: string) => Promise<{ origin: string }>;
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
  writeTerminalBytes: (
    connectionId: string,
    terminalId: string,
    data: ArrayBuffer | ArrayBufferView | number[],
  ) => Promise<boolean>;
  resizeTerminal: (
    connectionId: string,
    terminalId: string,
    columns: number,
    rows: number,
    options?: ShellDeskTerminalIpcOptions,
  ) => Promise<boolean>;
  closeTerminal: (connectionId: string, terminalId: string) => Promise<boolean>;
  listDirectory: (connectionId: string, remotePath: string, options?: ShellDeskSudoPasswordOptions) => Promise<ShellDeskRemoteDirectoryResult>;
  createDirectory: (connectionId: string, remotePath: string, options?: ShellDeskSudoPasswordOptions) => Promise<boolean>;
  deletePath: (connectionId: string, remotePath: string, entryType: 'directory' | 'file' | 'symlink', options?: ShellDeskSudoPasswordOptions) => Promise<boolean>;
  renamePath: (connectionId: string, oldPath: string, newPath: string, options?: ShellDeskSudoPasswordOptions) => Promise<boolean>;
  createFile: (connectionId: string, remotePath: string, options?: ShellDeskSudoPasswordOptions) => Promise<boolean>;
  readFile: (connectionId: string, remotePath: string, options?: ShellDeskSudoPasswordOptions) => Promise<string>;
  writeFile: (connectionId: string, remotePath: string, content: string, options?: ShellDeskSudoPasswordOptions) => Promise<boolean>;
  downloadFile: (connectionId: string, remotePath: string, options?: ShellDeskSudoPasswordOptions) => Promise<{ canceled: boolean; filePath?: string; size?: number }>;
  downloadPaths: (connectionId: string, remotePaths: string[], options?: ShellDeskSudoPasswordOptions) => Promise<{ canceled: boolean; directoryPath?: string; size?: number; fileCount?: number; itemCount?: number }>;
  selectUploadFiles: () => Promise<{ canceled: boolean; items: ShellDeskSelectedUploadItem[] }>;
  selectUploadFolders: () => Promise<{ canceled: boolean; items: ShellDeskSelectedUploadItem[] }>;
  uploadFile: (connectionId: string, remotePath: string, options?: ShellDeskSudoPasswordOptions) => Promise<{ canceled: boolean; remotePath?: string; remotePaths?: string[]; size?: number; fileCount?: number; itemCount?: number }>;
  uploadFiles: (connectionId: string, remotePath: string, options?: ShellDeskSudoPasswordOptions) => Promise<{ canceled: boolean; remotePath?: string; remotePaths?: string[]; size?: number; fileCount?: number; itemCount?: number }>;
  uploadPaths: (connectionId: string, remotePath: string, options?: ShellDeskSudoPasswordOptions) => Promise<{ canceled: boolean; remotePath?: string; remotePaths?: string[]; size?: number; fileCount?: number; itemCount?: number }>;
  uploadLocalPaths: (connectionId: string, remotePath: string, items: ShellDeskLocalUploadItem[], options?: ShellDeskSudoPasswordOptions) => Promise<{ canceled: boolean; remotePath?: string; remotePaths?: string[]; size?: number; fileCount?: number; itemCount?: number }>;
  cancelTransfer: (connectionId: string, queueId?: string) => Promise<boolean>;
  checkSftp: (connectionId: string) => Promise<{ available: boolean; error?: string }>;
  selectZmodemUploadFiles: () => Promise<{ canceled: boolean; files: ShellDeskZmodemUploadFile[] }>;
  readZmodemUploadFile: (fileId: string, offset: number, length: number) => Promise<ArrayBuffer>;
  releaseZmodemUploadFiles: (fileIds: string[]) => Promise<boolean>;
  saveZmodemFile: (fileName: string, content: ArrayBuffer | ArrayBufferView | number[]) => Promise<{ canceled: boolean; filePath?: string; size?: number }>;
  compress: (connectionId: string, sourcePaths: string[], format: string, destPath: string) => Promise<{ format: string; destPath: string }>;
  decompress: (connectionId: string, archivePath: string, destDir?: string) => Promise<{ archivePath: string; destDir: string }>;
  statPath: (connectionId: string, remotePath: string, options?: ShellDeskSudoPasswordOptions) => Promise<ShellDeskRemotePathStat>;
  setPathPermissions: (connectionId: string, remotePath: string, options: ShellDeskRemotePathPermissionOptions) => Promise<boolean>;
  getStatus: (connectionId: string) => Promise<ShellDeskRemoteStatusReport>;
  getSystemInfo: (connectionId: string) => Promise<ShellDeskRemoteSystemInfoReport>;
  getMetrics: (connectionId: string) => Promise<ShellDeskRemoteMetricsReport>;
  runCommand: (connectionId: string, command: string, stdin?: string, options?: { sudoPassword?: string }) => Promise<{ stdout: string; stderr: string; code: number }>;
  runCommandStream: (
    connectionId: string,
    command: string,
    stdin?: string,
    callbacks?: ShellDeskRunCommandStreamCallbacks,
    options?: { sudoPassword?: string },
  ) => Promise<{ stdout: string; stderr: string; code: number }>;
  mysqlConnect: (connectionId: string, config: ShellDeskMysqlConnectConfig) => Promise<ShellDeskMysqlConnectResult>;
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
  clickhouseConnect: (connectionId: string, config: ShellDeskClickHouseConnectConfig) => Promise<ShellDeskClickHouseConnectResult>;
  clickhouseDisconnect: (connectionId: string, clickhouseId: string) => Promise<boolean>;
  clickhouseDatabases: (connectionId: string, clickhouseId: string) => Promise<string[]>;
  clickhouseTables: (connectionId: string, clickhouseId: string, database: string) => Promise<ShellDeskClickHouseTable[]>;
  clickhouseColumns: (connectionId: string, clickhouseId: string, database: string, table: string) => Promise<ShellDeskClickHouseColumn[]>;
  clickhouseQuery: (connectionId: string, clickhouseId: string, sql: string, database?: string) => Promise<ShellDeskClickHouseQueryResult>;
  postgresConnect: (connectionId: string, config: ShellDeskPostgresConnectConfig) => Promise<{ postgresId: string; alreadyConnected?: boolean }>;
  postgresDisconnect: (connectionId: string, postgresId: string) => Promise<boolean>;
  postgresDatabases: (connectionId: string, postgresId: string) => Promise<string[]>;
  postgresSchemas: (connectionId: string, postgresId: string) => Promise<string[]>;
  postgresTables: (connectionId: string, postgresId: string, schema: string) => Promise<ShellDeskPostgresTable[]>;
  postgresColumns: (connectionId: string, postgresId: string, schema: string, table: string) => Promise<ShellDeskPostgresColumn[]>;
  postgresQuery: (connectionId: string, postgresId: string, sql: string) => Promise<ShellDeskPostgresQueryResult>;
  mongoConnect: (connectionId: string, config: ShellDeskMongoConnectConfig) => Promise<{ mongoId: string; alreadyConnected?: boolean }>;
  mongoDisconnect: (connectionId: string, mongoId: string) => Promise<boolean>;
  mongoDatabases: (connectionId: string, mongoId: string) => Promise<ShellDeskMongoDatabase[]>;
  mongoCollections: (connectionId: string, mongoId: string, database: string) => Promise<ShellDeskMongoCollection[]>;
  mongoIndexes: (connectionId: string, mongoId: string, database: string, collection: string) => Promise<ShellDeskMongoIndex[]>;
  mongoQuery: (connectionId: string, mongoId: string, request: ShellDeskMongoQueryRequest) => Promise<ShellDeskMongoQueryResult>;
  redisConnect: (connectionId: string, config: ShellDeskRedisConnectConfig) => Promise<{ redisId: string; alreadyConnected?: boolean }>;
  redisDisconnect: (connectionId: string, redisId: string) => Promise<boolean>;
  redisScan: (connectionId: string, redisId: string, options?: ShellDeskRedisScanOptions) => Promise<ShellDeskRedisScanResult>;
  redisKeys: (connectionId: string, redisId: string, pattern?: string) => Promise<{ name: string; type: string; ttl: number }[]>;
  redisGetValue: (connectionId: string, redisId: string, key: string) => Promise<ShellDeskRedisValueResult>;
  redisSetValue: (connectionId: string, redisId: string, key: string, value: unknown, type: string) => Promise<boolean>;
  redisDeleteKey: (connectionId: string, redisId: string, key: string) => Promise<boolean>;
  redisCommand: (connectionId: string, redisId: string, command: string, args: string[]) => Promise<unknown>;
  vncProbe: (connectionId: string, config: ShellDeskVncConnectConfig) => Promise<ShellDeskVncProbeResult>;
  vncStart: (connectionId: string, config: ShellDeskVncConnectConfig) => Promise<ShellDeskVncProxyInfo>;
  vncStop: (connectionId: string, vncId: string) => Promise<boolean>;
  sqliteOpen: (connectionId: string, filePath: string, options?: ShellDeskSudoPasswordOptions) => Promise<{ sqliteId: string; filePath: string }>;
  sqliteClose: (connectionId: string, sqliteId: string) => Promise<boolean>;
  sqliteTables: (connectionId: string, sqliteId: string, options?: ShellDeskSudoPasswordOptions) => Promise<string[]>;
  sqliteObjects: (connectionId: string, sqliteId: string, options?: ShellDeskSudoPasswordOptions) => Promise<ShellDeskSqliteObject[]>;
  sqliteColumns: (connectionId: string, sqliteId: string, table: string, options?: ShellDeskSudoPasswordOptions) => Promise<ShellDeskSqliteColumn[]>;
  sqliteSchema: (connectionId: string, sqliteId: string, objectType: string, objectName: string, options?: ShellDeskSudoPasswordOptions) => Promise<ShellDeskSqliteObject>;
  sqliteQuery: (connectionId: string, sqliteId: string, sql: string, options?: ShellDeskSudoPasswordOptions) => Promise<ShellDeskSqliteQueryResult>;
  sqliteUpdateCell: (
    connectionId: string,
    sqliteId: string,
    table: string,
    column: string,
    newValue: unknown,
    target: ShellDeskSqliteUpdateTarget,
    options?: ShellDeskSudoPasswordOptions,
  ) => Promise<{ affectedRows: number }>;
}

interface ShellDeskMysqlConnectConfig {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  mysqlId?: string;
}

type ShellDeskMysqlTransport = 'ssh-tunnel' | 'ssh-exec';

interface ShellDeskMysqlConnectResult {
  mysqlId: string;
  alreadyConnected?: boolean;
  transport?: ShellDeskMysqlTransport;
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

interface ShellDeskClickHouseConnectConfig {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  secure?: boolean;
  clickhouseId?: string;
}

type ShellDeskClickHouseTransport = 'ssh-tunnel' | 'ssh-exec';

interface ShellDeskClickHouseConnectResult {
  clickhouseId: string;
  alreadyConnected?: boolean;
  transport?: ShellDeskClickHouseTransport;
}

interface ShellDeskClickHouseTable {
  name: string;
  engine: string;
  totalRows?: number | null;
  totalBytes?: number | null;
}

interface ShellDeskClickHouseColumn {
  name: string;
  type: string;
  defaultKind: string;
  defaultExpression: string;
  comment: string;
  isPrimaryKey: boolean;
  isSortingKey: boolean;
}

interface ShellDeskClickHouseQueryStatistics {
  elapsed?: number;
  rowsRead?: number;
  bytesRead?: number;
}

interface ShellDeskClickHouseQueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount?: number;
  statistics?: ShellDeskClickHouseQueryStatistics;
}

interface ShellDeskPostgresConnectConfig {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  postgresId?: string;
}

interface ShellDeskPostgresTable {
  schema: string;
  name: string;
  type: string;
}

interface ShellDeskPostgresColumn {
  name: string;
  dataType: string;
  nullable: boolean;
  defaultValue?: string | null;
  isPrimaryKey?: boolean;
}

interface ShellDeskPostgresQueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount?: number;
}

interface ShellDeskMongoConnectConfig {
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  authSource?: string;
  mongoId?: string;
}

interface ShellDeskMongoDatabase {
  name: string;
  sizeOnDisk?: number;
  empty?: boolean;
}

interface ShellDeskMongoCollection {
  name: string;
  type: string;
}

interface ShellDeskMongoIndex {
  name: string;
  key: Record<string, unknown>;
  unique?: boolean;
  sparse?: boolean;
  expireAfterSeconds?: number;
}

interface ShellDeskMongoQueryRequest {
  database: string;
  collection: string;
  filter: string;
  projection?: string;
  sort?: string;
  limit: number;
}

interface ShellDeskMongoQueryResult {
  documents: Record<string, unknown>[];
  count: number;
  limit: number;
}

interface ShellDeskSqliteColumn {
  name: string;
  type: string;
  nullable: boolean;
  pk: boolean;
  defaultValue: string | null;
}

interface ShellDeskSqliteObject {
  type: 'table' | 'view' | 'index' | string;
  name: string;
  tableName: string;
  sql: string;
}

interface ShellDeskSqliteQueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
}

interface ShellDeskSqliteUpdateTarget {
  pkColumns?: string[];
  pkValues?: unknown[];
  rowid?: unknown;
}

interface ShellDeskRedisConnectConfig {
  host?: string;
  port?: number;
  password?: string;
  db?: number;
  redisId?: string;
}

interface ShellDeskRedisScanOptions {
  cursor?: string;
  pattern?: string;
  count?: number;
}

interface ShellDeskRedisKeySummary {
  name: string;
  type: string;
  ttl: number;
  size?: number;
  scannedAt: string;
}

interface ShellDeskRedisScanResult {
  cursor: string;
  complete: boolean;
  pattern: string;
  scannedAt: string;
  keys: ShellDeskRedisKeySummary[];
}

interface ShellDeskRedisValueResult {
  type: string;
  value: unknown;
  ttl?: number;
  size?: number;
  count?: number;
  previewLimit?: number;
  truncated?: boolean;
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
  clearEntries: () => Promise<ShellDeskLogEntry[]>;
  saveEntries: (entries: ShellDeskLogEntry[]) => Promise<ShellDeskLogEntry[]>;
  appendEntry: (entry: ShellDeskLogEntry) => Promise<ShellDeskLogEntry[]>;
}

interface ShellDeskPreferenceControls {
  get: (key: string) => Promise<unknown>;
  set: (key: string, value: unknown) => Promise<unknown>;
}

interface ShellDeskSystemControls {
  listFonts: () => Promise<string[]>;
  readKnownHosts: () => Promise<ShellDeskKnownHostsReadResult>;
  testProxy: (payload: { config: ShellDeskProxyConfig; target?: ShellDeskProxyTestTarget }) => Promise<ShellDeskProxyTestResult>;
}

interface ShellDeskAiControls {
  listModels: (request: ShellDeskAiModelListRequest) => Promise<ShellDeskAiModelListResult>;
  chat: (request: ShellDeskAiChatRequest) => Promise<ShellDeskAiChatResult>;
  chatStream?: (request: ShellDeskAiChatRequest, callbacks?: ShellDeskAiChatStreamCallbacks) => Promise<ShellDeskAiChatResult>;
}

type ShellDeskSyncStatus = 'idle' | 'success' | 'warning' | 'error';
type ShellDeskSyncConflictResolution = 'local' | 'remote';
type ShellDeskSyncEmptyVaultResolution = 'restoreRemote' | 'keepEmpty';
type ShellDeskSyncShrinkResolution = 'allow';
type ShellDeskSyncEntityType = 'host' | 'bookmark' | 'settings' | 'proxyProfile' | 'knownHost';

interface ShellDeskSyncPublicConfig {
  enabled: boolean;
  provider: 'webdav';
  webdavUrl: string;
  webdavUsername: string;
  webdavRemotePath: string;
  ignoreCertificateErrors: boolean;
  intervalMinutes: number;
  syncOnStartup: boolean;
  lastSyncAt: string;
  lastSyncStatus: ShellDeskSyncStatus;
  lastSyncMessage: string;
  lastConflictCount: number;
  deviceId: string;
  hasWebDavPassword: boolean;
  hasSyncPassphrase: boolean;
}

interface ShellDeskSyncConfigInput {
  enabled: boolean;
  webdavUrl: string;
  webdavUsername: string;
  webdavPassword: string;
  webdavRemotePath: string;
  ignoreCertificateErrors: boolean;
  syncPassphrase: string;
  intervalMinutes: number;
  syncOnStartup: boolean;
}

interface ShellDeskSyncRunInput extends Partial<ShellDeskSyncConfigInput> {
  conflictResolution?: ShellDeskSyncConflictResolution;
  emptyVaultResolution?: ShellDeskSyncEmptyVaultResolution;
  shrinkResolution?: ShellDeskSyncShrinkResolution;
}

interface ShellDeskSyncConflict {
  type: ShellDeskSyncEntityType;
  id: string;
  name: string;
  reason: string;
}

interface ShellDeskSyncConflictSummary {
  type: ShellDeskSyncEntityType;
  count: number;
}

interface ShellDeskSyncSummary {
  localRecords: number;
  remoteRecords: number;
  mergedRecords: number;
  tombstones: number;
  uploaded: number;
  downloaded: number;
  deleted: number;
  conflictCount: number;
  conflictsByType: ShellDeskSyncConflictSummary[];
  recordsByType: Partial<Record<ShellDeskSyncEntityType, number>>;
}

interface ShellDeskSyncEmptyVaultSummary {
  localRecords: number;
  remoteRecords: number;
  remoteRecordsByType: Partial<Record<ShellDeskSyncEntityType, number>>;
}

interface ShellDeskSyncShrinkSummary {
  baselineRecords: number;
  mergedRecords: number;
  lostRecords: number;
  previousRecords: number;
  localRecords: number;
  remoteRecords: number;
  lostByType: Partial<Record<ShellDeskSyncEntityType, number>>;
}

interface ShellDeskSyncResult {
  ok: boolean;
  needsResolution: boolean;
  needsEmptyVaultResolution: boolean;
  needsShrinkConfirmation: boolean;
  resolution: ShellDeskSyncConflictResolution | '';
  emptyVaultResolution: ShellDeskSyncEmptyVaultResolution | '';
  shrinkResolution: ShellDeskSyncShrinkResolution | '';
  syncedAt: string;
  uploaded: number;
  downloaded: number;
  deleted: number;
  conflictCount: number;
  conflicts: ShellDeskSyncConflict[];
  conflictSummary: ShellDeskSyncConflictSummary[];
  summary: ShellDeskSyncSummary;
  emptyVaultSummary: ShellDeskSyncEmptyVaultSummary | null;
  shrinkSummary: ShellDeskSyncShrinkSummary | null;
  snapshot: ShellDeskVaultSnapshot | null;
  config: ShellDeskSyncPublicConfig;
}

interface ShellDeskWebDavTestResult {
  ok: boolean;
  checkedAt: string;
  message: string;
}

interface ShellDeskSyncControls {
  getConfig: () => Promise<ShellDeskSyncPublicConfig>;
  saveConfig: (config: ShellDeskSyncConfigInput) => Promise<ShellDeskSyncPublicConfig>;
  testWebDav: (config: ShellDeskSyncConfigInput) => Promise<ShellDeskWebDavTestResult>;
  runNow: (config?: ShellDeskSyncRunInput) => Promise<ShellDeskSyncResult>;
}

interface ShellDeskTransferProgress {
  connectionId?: string;
  queueId?: string;
  clientId?: string;
  type: 'download' | 'upload';
  fileName: string;
  transferred: number;
  total: number;
  currentFileTransferred?: number;
  currentFileTotal?: number;
  completedFiles?: number;
  totalFiles?: number;
  completedItems?: number;
  totalItems?: number;
}

interface ShellDeskTransferEndPayload {
  connectionId?: string;
  queueId?: string;
  clientId?: string;
  type: 'download' | 'upload';
  fileName: string;
  transferred: number;
  total: number;
  currentFileTransferred?: number;
  currentFileTotal?: number;
  completedFiles?: number;
  totalFiles?: number;
  completedItems?: number;
  totalItems?: number;
  success: boolean;
  error?: string;
}

interface ShellDeskEventControls {
  onTerminalData: (callback: (payload: { connectionId: string; terminalId?: string; data: string; bytes?: ArrayBuffer | ArrayBufferView | number[] }) => void) => () => void;
  onTerminalExit: (callback: (payload: { connectionId: string; terminalId?: string; code?: number | null; signal?: string | null }) => void) => () => void;
  onVncDiagnostic: (callback: (payload: ShellDeskVncDiagnosticPayload) => void) => () => void;
  onConnectionClosed: (callback: (payload: { connectionId: string; reason?: string }) => void) => () => void;
  onConnectionReconnecting: (callback: (payload: { connectionId: string; reason?: string; startedAt?: string }) => void) => () => void;
  onConnectionRestored: (callback: (payload: { connectionId: string; restoredAt?: string }) => void) => () => void;
  onKeyboardInteractive: (callback: (payload: ShellDeskKeyboardInteractiveRequest) => void) => () => void;
  onHostKeyVerification: (callback: (payload: ShellDeskHostKeyVerificationRequest) => void) => () => void;
  onWindowMaximizedChange: (callback: (payload: { maximized: boolean }) => void) => () => void;
  onVaultChanged: (callback: (payload: { kind: 'vault' | 'bookmarks' | 'preference'; scope?: string; key?: string }) => void) => () => void;
  onSyncChanged: (callback: (payload: ShellDeskSyncResult) => void) => () => void;
  onTransferProgress: (callback: (payload: ShellDeskTransferProgress) => void) => () => void;
  onTransferEnd: (callback: (payload: ShellDeskTransferEndPayload) => void) => () => void;
  onUpdateAvailable: (callback: (payload: ShellDeskUpdateStatus) => void) => () => void;
  onUpdateNotAvailable: (callback: (payload: ShellDeskUpdateStatus) => void) => () => void;
  onUpdateDownloadProgress: (callback: (payload: ShellDeskUpdateDownloadProgress) => void) => () => void;
  onUpdateDownloaded: (callback: (payload: ShellDeskUpdateStatus) => void) => () => void;
  onUpdateError: (callback: (payload: ShellDeskUpdateStatus) => void) => () => void;
}

interface ShellDeskApi {
  appName: string;
  platform: NodeJS.Platform;
  app: ShellDeskAppControls;
  window: ShellDeskWindowControls;
  files: ShellDeskFileControls;
  vault: ShellDeskVaultControls;
  logs: ShellDeskLogsControls;
  preferences: ShellDeskPreferenceControls;
  system: ShellDeskSystemControls;
  ai: ShellDeskAiControls;
  sync: ShellDeskSyncControls;
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

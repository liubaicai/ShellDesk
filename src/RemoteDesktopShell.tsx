import { type CSSProperties, type DragEvent as ReactDragEvent, type FormEvent, lazy, memo, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import type { RemoteProcessManagerLaunchOptions } from './components/remote-desktop/RemoteProcessManager';
import type {
  RemoteTerminalChromePayload,
  RemoteTerminalCommandRequest,
  RemoteTerminalLaunchOptions,
  RemoteTerminalSessionEvent,
  RemoteTerminalSessionState,
  RemoteTerminalSessionStatus,
  RemoteTerminalToolAction,
  RemoteTerminalToolRequest,
} from './components/remote-desktop/RemoteTerminal';
import type { RemoteConnectionInfo } from './components/remote-desktop/types';
import { getRemoteConnectionProfileHostId } from './components/remote-desktop/remoteConnectionProfiles';
import { loadDesktopWallpaperPresetUrl } from './assets/desktopWallpapers';
import ContextMenuIcon from './components/remote-desktop/ContextMenuIcon';
import { getAppLocale, t, type MessageId } from './i18n';

const RemoteApiDebugger = lazy(() => import('./components/remote-desktop/RemoteApiDebugger'));
const RemoteBrowser = lazy(() => import('./components/remote-desktop/RemoteBrowser'));
const RemoteClickHouse = lazy(() => import('./components/remote-desktop/RemoteClickHouse'));
const RemoteContainerManager = lazy(() => import('./components/remote-desktop/RemoteContainerManager'));
const RemoteDiskAnalyzer = lazy(() => import('./components/remote-desktop/RemoteDiskAnalyzer'));
const RemoteDiskManager = lazy(() => import('./components/remote-desktop/RemoteDiskManager'));
const RemoteFileExplorer = lazy(() => import('./components/remote-desktop/RemoteFileExplorer'));
const RemoteFirewallManager = lazy(() => import('./components/remote-desktop/RemoteFirewallManager'));
const RemoteGitManager = lazy(() => import('./components/remote-desktop/RemoteGitManager'));
const RemoteIptablesManager = lazy(() => import('./components/remote-desktop/RemoteIptablesManager'));
const RemoteLoginSessions = lazy(() => import('./components/remote-desktop/RemoteLoginSessions'));
const RemoteLogViewer = lazy(() => import('./components/remote-desktop/RemoteLogViewer'));
const RemoteMessageQueuePanel = lazy(() => import('./components/remote-desktop/RemoteMessageQueuePanel'));
const RemoteMonitor = lazy(() => import('./components/remote-desktop/RemoteMonitor'));
const RemoteMongo = lazy(() => import('./components/remote-desktop/RemoteMongo'));
const RemoteMySQL = lazy(() => import('./components/remote-desktop/RemoteMySQL'));
const RemoteNetworkDiagnostics = lazy(() => import('./components/remote-desktop/RemoteNetworkDiagnostics'));
const RemoteNotepad = lazy(() => import('./components/remote-desktop/RemoteNotepad'));
const RemotePackageManager = lazy(() => import('./components/remote-desktop/RemotePackageManager'));
const RemotePortManager = lazy(() => import('./components/remote-desktop/RemotePortManager'));
const RemotePostgres = lazy(() => import('./components/remote-desktop/RemotePostgres'));
const RemoteProcessManager = lazy(() => import('./components/remote-desktop/RemoteProcessManager'));
const RemoteRedis = lazy(() => import('./components/remote-desktop/RemoteRedis'));
const RemoteS3Browser = lazy(() => import('./components/remote-desktop/RemoteS3Browser'));
const RemoteScheduledTasks = lazy(() => import('./components/remote-desktop/RemoteScheduledTasks'));
const RemoteSearchCluster = lazy(() => import('./components/remote-desktop/RemoteSearchCluster'));
const RemoteSecurityAudit = lazy(() => import('./components/remote-desktop/RemoteSecurityAudit'));
const RemoteServiceManager = lazy(() => import('./components/remote-desktop/RemoteServiceManager'));
const RemoteSettings = lazy(() => import('./components/remote-desktop/RemoteSettings'));
const RemoteSqlite = lazy(() => import('./components/remote-desktop/RemoteSqlite'));
const RemoteTerminal = lazy(() => import('./components/remote-desktop/RemoteTerminal'));
const RemoteVncViewer = lazy(() => import('./components/remote-desktop/RemoteVncViewer'));
const RemoteWebServerManager = lazy(() => import('./components/remote-desktop/RemoteWebServerManager'));

const desktopApps = [
  { key: 'files', labelId: 'desktop.app.files.label', descriptionId: 'desktop.app.files.description' },
  { key: 'terminal', labelId: 'desktop.app.terminal.label', descriptionId: 'desktop.app.terminal.description' },
  { key: 'notepad', labelId: 'desktop.app.notepad.label', descriptionId: 'desktop.app.notepad.description' },
  { key: 'browser', labelId: 'desktop.app.browser.label', descriptionId: 'desktop.app.browser.description' },
  { key: 'vnc', labelId: 'desktop.app.vnc.label', descriptionId: 'desktop.app.vnc.description' },
  { key: 'log-viewer', labelId: 'desktop.app.logViewer.label', descriptionId: 'desktop.app.logViewer.description' },
  { key: 'monitor', labelId: 'desktop.app.monitor.label', descriptionId: 'desktop.app.monitor.description' },
  { key: 'mysql', labelId: 'desktop.app.mysql.label', descriptionId: 'desktop.app.mysql.description' },
  { key: 'clickhouse', labelId: 'desktop.app.clickhouse.label', descriptionId: 'desktop.app.clickhouse.description' },
  { key: 'redis', labelId: 'desktop.app.redis.label', descriptionId: 'desktop.app.redis.description' },
  { key: 'service-manager', labelId: 'desktop.app.serviceManager.label', descriptionId: 'desktop.app.serviceManager.description' },
  { key: 'container-manager', labelId: 'desktop.app.containerManager.label', descriptionId: 'desktop.app.containerManager.description' },
  { key: 'port-manager', labelId: 'desktop.app.portManager.label', descriptionId: 'desktop.app.portManager.description' },
  { key: 'firewall-manager', labelId: 'desktop.app.firewallManager.label', descriptionId: 'desktop.app.firewallManager.description' },
  { key: 'iptables-manager', labelId: 'desktop.app.iptablesManager.label', descriptionId: 'desktop.app.iptablesManager.description' },
  { key: 'network-diagnostics', labelId: 'desktop.app.networkDiagnostics.label', descriptionId: 'desktop.app.networkDiagnostics.description' },
  { key: 'disk-analyzer', labelId: 'desktop.app.diskAnalyzer.label', descriptionId: 'desktop.app.diskAnalyzer.description' },
  { key: 'disk-manager', labelId: 'desktop.app.diskManager.label', descriptionId: 'desktop.app.diskManager.description' },
  { key: 'package-manager', labelId: 'desktop.app.packageManager.label', descriptionId: 'desktop.app.packageManager.description' },
  { key: 'git-manager', labelId: 'desktop.app.gitManager.label', descriptionId: 'desktop.app.gitManager.description' },
  { key: 'web-server-manager', labelId: 'desktop.app.webServerManager.label', descriptionId: 'desktop.app.webServerManager.description' },
  { key: 'scheduled-tasks', labelId: 'desktop.app.scheduledTasks.label', descriptionId: 'desktop.app.scheduledTasks.description' },
  { key: 'postgres', labelId: 'desktop.app.postgres.label', descriptionId: 'desktop.app.postgres.description' },
  { key: 'mongo', labelId: 'desktop.app.mongo.label', descriptionId: 'desktop.app.mongo.description' },
  { key: 'search-cluster', labelId: 'desktop.app.searchCluster.label', descriptionId: 'desktop.app.searchCluster.description' },
  { key: 'message-queue', labelId: 'desktop.app.messageQueue.label', descriptionId: 'desktop.app.messageQueue.description' },
  { key: 's3-browser', labelId: 'desktop.app.s3Browser.label', descriptionId: 'desktop.app.s3Browser.description' },
  { key: 'security-audit', labelId: 'desktop.app.securityAudit.label', descriptionId: 'desktop.app.securityAudit.description' },
  { key: 'login-sessions', labelId: 'desktop.app.loginSessions.label', descriptionId: 'desktop.app.loginSessions.description' },
  { key: 'api-debugger', labelId: 'desktop.app.apiDebugger.label', descriptionId: 'desktop.app.apiDebugger.description' },
  { key: 'procmanager', labelId: 'desktop.app.processManager.label', descriptionId: 'desktop.app.processManager.description' },
  { key: 'settings', labelId: 'desktop.app.settings.label', descriptionId: 'desktop.app.settings.description' },
  { key: 'sqlite', labelId: 'desktop.app.sqlite.label', descriptionId: 'desktop.app.sqlite.description' },
] as const satisfies ReadonlyArray<{ key: string; labelId: MessageId; descriptionId: MessageId }>;

/** Apps always pinned in the Dock. Other apps stay on the desktop and appear in the Dock only while open. */
const dockPinnedApps: DesktopAppKey[] = ['files', 'terminal', 'browser'];

type DesktopAppInfo = (typeof desktopApps)[number];
type DesktopAppKey = DesktopAppInfo['key'];

const desktopAppIconSources: Record<DesktopAppKey, string> = {
  files: new URL('./assets/desktop-icons/files.png', import.meta.url).href,
  terminal: new URL('./assets/desktop-icons/terminal.png', import.meta.url).href,
  notepad: new URL('./assets/desktop-icons/notepad.png', import.meta.url).href,
  browser: new URL('./assets/desktop-icons/browser.png', import.meta.url).href,
  vnc: new URL('./assets/desktop-icons/vnc.png', import.meta.url).href,
  'log-viewer': new URL('./assets/desktop-icons/log-viewer.png', import.meta.url).href,
  monitor: new URL('./assets/desktop-icons/monitor.png', import.meta.url).href,
  mysql: new URL('./assets/desktop-icons/mysql.png', import.meta.url).href,
  clickhouse: new URL('./assets/desktop-icons/clickhouse.png', import.meta.url).href,
  redis: new URL('./assets/desktop-icons/redis.png', import.meta.url).href,
  'service-manager': new URL('./assets/desktop-icons/service-manager.png', import.meta.url).href,
  'container-manager': new URL('./assets/desktop-icons/container-manager.png', import.meta.url).href,
  'port-manager': new URL('./assets/desktop-icons/port-manager.png', import.meta.url).href,
  'firewall-manager': new URL('./assets/desktop-icons/firewall-manager.png', import.meta.url).href,
  'iptables-manager': new URL('./assets/desktop-icons/iptables-manager.png', import.meta.url).href,
  'network-diagnostics': new URL('./assets/desktop-icons/network-diagnostics.png', import.meta.url).href,
  'disk-analyzer': new URL('./assets/desktop-icons/disk-analyzer.png', import.meta.url).href,
  'disk-manager': new URL('./assets/desktop-icons/disk-manager.png', import.meta.url).href,
  'package-manager': new URL('./assets/desktop-icons/package-manager.png', import.meta.url).href,
  'git-manager': new URL('./assets/desktop-icons/git-manager.png', import.meta.url).href,
  'web-server-manager': new URL('./assets/desktop-icons/web-server-manager.png', import.meta.url).href,
  'scheduled-tasks': new URL('./assets/desktop-icons/scheduled-tasks.png', import.meta.url).href,
  postgres: new URL('./assets/desktop-icons/postgres.png', import.meta.url).href,
  mongo: new URL('./assets/desktop-icons/mongo.png', import.meta.url).href,
  'search-cluster': new URL('./assets/desktop-icons/search-cluster.png', import.meta.url).href,
  'message-queue': new URL('./assets/desktop-icons/message-queue.png', import.meta.url).href,
  's3-browser': new URL('./assets/desktop-icons/s3-browser.png', import.meta.url).href,
  'security-audit': new URL('./assets/desktop-icons/security-audit.png', import.meta.url).href,
  'login-sessions': new URL('./assets/desktop-icons/login-sessions.png', import.meta.url).href,
  'api-debugger': new URL('./assets/desktop-icons/api-debugger.png', import.meta.url).href,
  procmanager: new URL('./assets/desktop-icons/procmanager.png', import.meta.url).href,
  settings: new URL('./assets/desktop-icons/settings.png', import.meta.url).href,
  sqlite: new URL('./assets/desktop-icons/sqlite.png', import.meta.url).href,
};

const desktopDragMimeType = 'application/x-shelldesk-desktop-item';
const launchpadAnimationMs = 180;
const desktopAppCatalogVersion = 4;
const defaultDesktopAppKeys: DesktopAppKey[] = ['files', 'terminal', 'browser', 'settings'];
const appCatalogMigrationKeys: DesktopAppKey[] = [
  'git-manager',
  'web-server-manager',
  'mongo',
  'search-cluster',
  'message-queue',
  's3-browser',
  'disk-manager',
  'clickhouse',
];
const legacyAllDesktopAppKeys = desktopApps
  .map((app) => app.key)
  .filter((appKey): appKey is DesktopAppKey => !appCatalogMigrationKeys.includes(appKey as DesktopAppKey));
const desktopAppKeySet = new Set<DesktopAppKey>(desktopApps.map((app) => app.key));
const desktopSortOptions: Array<{ value: ShellDeskDesktopSortMode; labelId: MessageId }> = [
  { value: 'custom', labelId: 'desktop.sort.custom' },
  { value: 'name-asc', labelId: 'desktop.sort.nameAsc' },
  { value: 'name-desc', labelId: 'desktop.sort.nameDesc' },
];

type DesktopLayoutItem = ShellDeskDesktopLayoutItem;
type DesktopFolderLayoutItem = ShellDeskDesktopFolderLayoutItem;

type DesktopDragPayload =
  | { source: 'desktop'; itemId: string; itemType: 'app' | 'folder'; appKey?: DesktopAppKey }
  | { source: 'launchpad'; appKey: DesktopAppKey }
  | { source: 'folder'; folderId: string; appKey: DesktopAppKey };

interface DesktopAppContextMenuState {
  x: number;
  y: number;
  appKey: DesktopAppKey;
  source: 'desktop' | 'launchpad' | 'folder';
  folderId?: string;
}

interface DesktopFolderContextMenuState {
  x: number;
  y: number;
  folderId: string;
}

interface DesktopSurfaceContextMenuState {
  x: number;
  y: number;
}

interface FolderRenameDialogState {
  folderId: string;
  name: string;
}

interface LaunchpadTooltipState {
  description: string;
  x: number;
  y: number;
  placement: 'top' | 'bottom';
}

interface RemoteDesktopProps {
  connection: RemoteConnectionInfo;
  settings: ShellDeskAppSettings;
  onSettingsChange?: (settings: ShellDeskAppSettings) => void;
  onTerminalSessionEvent?: (event: RemoteTerminalSessionEvent) => void;
}

interface DesktopWindowFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface DesktopWindowState {
  id: string;
  appKey: DesktopAppKey;
  frame: DesktopWindowFrame;
  previousFrame?: DesktopWindowFrame;
  isMaximized: boolean;
  isMinimized: boolean;
  zIndex: number;
  terminalId?: string;
  terminalLaunchOptions?: RemoteTerminalLaunchOptions;
  terminalStatus?: RemoteTerminalSessionStatus;
  terminalHasForegroundTask?: boolean;
  terminalToolRequest?: RemoteTerminalToolRequest;
  terminalCommandRequest?: RemoteTerminalCommandRequest;
  chromeTitle?: string;
  chromeStatus?: string;
  chromeTone?: 'idle' | 'loading' | 'error';
  notepadInitialPath?: string;
  notepadInitialContent?: string;
  notepadInitialTitle?: string;
  notepadOpenRequest?: { id: string; filePath: string };
  processManagerLaunchOptions?: RemoteProcessManagerLaunchOptions;
  fileExplorerInitialPath?: string;
}

type DesktopWindowInteractionMode = 'move' | 'resize';

interface DesktopWindowPointerState {
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

interface TerminalTitlebarMenuState {
  windowId: string;
  x: number;
  y: number;
}

interface TmuxSessionInfo {
  name: string;
  windows: number;
  attached: number;
  createdAt: number | null;
  lastAttachedAt: number | null;
}

interface TmuxMenuState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  sessions: TmuxSessionInfo[];
  error?: string;
}

interface TmuxLaunchRequest {
  sessionName: string;
  command: 'attach' | 'new';
}

interface DesktopWindowTitlebarClickState {
  windowId: string;
  timestamp: number;
  x: number;
  y: number;
}

const windowEdgePadding = 14;
const windowDockSafeArea = 72;
const windowMinWidth = 360;
const windowMinHeight = 260;
const titlebarDoubleClickDelayMs = 500;
const titlebarDoubleClickDistance = 8;

const defaultWindowFrames: Record<DesktopAppKey, DesktopWindowFrame> = {
  files: { x: 132, y: 54, width: 980, height: 580 },
  terminal: { x: 206, y: 80, width: 780, height: 500 },
  notepad: { x: 140, y: 50, width: 860, height: 580 },
  browser: { x: 150, y: 58, width: 1000, height: 600 },
  vnc: { x: 118, y: 46, width: 1040, height: 650 },
  'log-viewer': { x: 118, y: 46, width: 1080, height: 650 },
  monitor: { x: 224, y: 86, width: 820, height: 520 },
  mysql: { x: 100, y: 40, width: 1020, height: 620 },
  clickhouse: { x: 100, y: 40, width: 1080, height: 650 },
  redis: { x: 100, y: 40, width: 1020, height: 620 },
  'service-manager': { x: 110, y: 44, width: 1080, height: 650 },
  'container-manager': { x: 104, y: 42, width: 1100, height: 660 },
  'port-manager': { x: 116, y: 48, width: 1120, height: 650 },
  'firewall-manager': { x: 118, y: 48, width: 1080, height: 650 },
  'iptables-manager': { x: 106, y: 44, width: 1160, height: 680 },
  'network-diagnostics': { x: 120, y: 52, width: 1060, height: 640 },
  'disk-analyzer': { x: 110, y: 46, width: 1120, height: 650 },
  'disk-manager': { x: 96, y: 38, width: 1180, height: 680 },
  'package-manager': { x: 116, y: 48, width: 1080, height: 650 },
  'git-manager': { x: 112, y: 46, width: 1120, height: 660 },
  'web-server-manager': { x: 112, y: 46, width: 1120, height: 660 },
  'scheduled-tasks': { x: 118, y: 50, width: 1080, height: 650 },
  postgres: { x: 100, y: 40, width: 1080, height: 650 },
  mongo: { x: 96, y: 38, width: 1120, height: 660 },
  'search-cluster': { x: 106, y: 44, width: 1120, height: 650 },
  'message-queue': { x: 112, y: 46, width: 1120, height: 650 },
  's3-browser': { x: 106, y: 44, width: 1180, height: 680 },
  'security-audit': { x: 116, y: 48, width: 1080, height: 650 },
  'login-sessions': { x: 124, y: 52, width: 1080, height: 640 },
  'api-debugger': { x: 118, y: 46, width: 1080, height: 650 },
  procmanager: { x: 126, y: 54, width: 1100, height: 640 },
  settings: { x: 160, y: 55, width: 960, height: 580 },
  sqlite: { x: 100, y: 40, width: 1020, height: 620 },
};

function clampWindowFrame(frame: DesktopWindowFrame, surfaceWidth: number, surfaceHeight: number): DesktopWindowFrame {
  const maxWidth = Math.max(windowMinWidth, surfaceWidth - windowEdgePadding * 2);
  const maxHeight = Math.max(windowMinHeight, surfaceHeight - windowEdgePadding - windowDockSafeArea);
  const width = Math.min(Math.max(frame.width, windowMinWidth), maxWidth);
  const height = Math.min(Math.max(frame.height, windowMinHeight), maxHeight);
  const maxX = Math.max(windowEdgePadding, surfaceWidth - windowEdgePadding - width);
  const maxY = Math.max(windowEdgePadding, surfaceHeight - windowDockSafeArea - height);

  return {
    x: Math.min(Math.max(frame.x, windowEdgePadding), maxX),
    y: Math.min(Math.max(frame.y, windowEdgePadding), maxY),
    width,
    height,
  };
}

function areWindowFramesEqual(firstFrame: DesktopWindowFrame, secondFrame: DesktopWindowFrame) {
  return firstFrame.x === secondFrame.x
    && firstFrame.y === secondFrame.y
    && firstFrame.width === secondFrame.width
    && firstFrame.height === secondFrame.height;
}

function applyWindowFrameToElement(element: HTMLElement, frame: DesktopWindowFrame) {
  element.style.width = `${frame.width}px`;
  element.style.height = `${frame.height}px`;
  element.style.transform = `translate3d(${frame.x}px, ${frame.y}px, 0)`;
}

function getMaximizedWindowFrame(surfaceWidth: number, surfaceHeight: number) {
  return {
    x: 0,
    y: 0,
    width: Math.max(windowMinWidth, surfaceWidth),
    height: Math.max(windowMinHeight, surfaceHeight - windowDockSafeArea),
  };
}

function createDesktopWindow(appKey: DesktopAppKey, sequence: number, zIndex: number, language: ShellDeskAppSettings['language']): DesktopWindowState {
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

function getAppInfo(appKey: DesktopAppKey) {
  return desktopApps.find((app) => app.key === appKey) ?? desktopApps[0];
}

function getAppLabel(app: DesktopAppInfo, language: ShellDeskAppSettings['language']) {
  return t(app.labelId, language);
}

function getAppDescription(app: DesktopAppInfo, language: ShellDeskAppSettings['language']) {
  return t(app.descriptionId, language);
}

function isDesktopAppKey(value: unknown): value is DesktopAppKey {
  return typeof value === 'string' && desktopAppKeySet.has(value as DesktopAppKey);
}

function createDefaultRemoteDesktopLayout(): ShellDeskRemoteDesktopLayout {
  return {
    appCatalogVersion: desktopAppCatalogVersion,
    sortMode: 'custom',
    items: defaultDesktopAppKeys.map((appKey) => ({
      id: `app:${appKey}`,
      type: 'app',
      appKey,
    })),
  };
}

function normalizeFolderName(value: unknown) {
  const name = typeof value === 'string' ? value.trim().slice(0, 40) : '';
  return name || t('desktop.folder.defaultName', 'zh-CN');
}

function getLayoutAppKeys(items: DesktopLayoutItem[]) {
  return new Set(items.flatMap((item) => (item.type === 'app' ? [item.appKey] : item.appKeys)));
}

function areRemoteDesktopLayoutsEqual(firstLayout: ShellDeskRemoteDesktopLayout, secondLayout: ShellDeskRemoteDesktopLayout) {
  return JSON.stringify(firstLayout) === JSON.stringify(secondLayout);
}

function shouldPreserveCurrentDesktopLayout(
  currentLayout: ShellDeskRemoteDesktopLayout,
  incomingLayout: ShellDeskRemoteDesktopLayout,
) {
  const currentAppKeys = getLayoutAppKeys(currentLayout.items);
  const incomingAppKeys = getLayoutAppKeys(incomingLayout.items);

  return appCatalogMigrationKeys.some((appKey) => currentAppKeys.has(appKey) && !incomingAppKeys.has(appKey));
}

function migrateLegacyAllAppsLayout(items: DesktopLayoutItem[], appCatalogVersion: number) {
  if (appCatalogVersion >= desktopAppCatalogVersion) {
    return items;
  }

  const appKeys = getLayoutAppKeys(items);
  const shouldAppendNewApps = legacyAllDesktopAppKeys.every((appKey) => appKeys.has(appKey));

  if (!shouldAppendNewApps) {
    return items;
  }

  return [
    ...items,
    ...appCatalogMigrationKeys
      .filter((appKey) => !appKeys.has(appKey))
      .map((appKey): DesktopLayoutItem => ({
        id: `app:${appKey}`,
        type: 'app',
        appKey,
      })),
  ];
}

function normalizeRemoteDesktopLayout(rawLayout: unknown): ShellDeskRemoteDesktopLayout {
  const defaultLayout = createDefaultRemoteDesktopLayout();

  if (!rawLayout || typeof rawLayout !== 'object' || Array.isArray(rawLayout)) {
    return defaultLayout;
  }

  const layout = rawLayout as Partial<ShellDeskRemoteDesktopLayout>;
  const rawAppCatalogVersion = Number(layout.appCatalogVersion);
  const appCatalogVersion = Number.isInteger(rawAppCatalogVersion) && rawAppCatalogVersion > 0
    ? rawAppCatalogVersion
    : 1;
  const sortMode = layout.sortMode === 'name-asc' || layout.sortMode === 'name-desc'
    ? layout.sortMode
    : 'custom';

  if (!Array.isArray(layout.items)) {
    return { ...defaultLayout, sortMode };
  }

  const seenAppKeys = new Set<DesktopAppKey>();
  const items: DesktopLayoutItem[] = [];

  layout.items.slice(0, desktopApps.length + 12).forEach((item, index) => {
    if (!item || typeof item !== 'object') {
      return;
    }

    if (item.type === 'app') {
      if (!isDesktopAppKey(item.appKey) || seenAppKeys.has(item.appKey)) {
        return;
      }

      seenAppKeys.add(item.appKey);
      items.push({
        id: `app:${item.appKey}`,
        type: 'app',
        appKey: item.appKey,
      });
      return;
    }

    if (item.type === 'folder') {
      const appKeys = Array.isArray(item.appKeys)
        ? item.appKeys.filter((appKey): appKey is DesktopAppKey => {
            if (!isDesktopAppKey(appKey) || seenAppKeys.has(appKey)) {
              return false;
            }

            seenAppKeys.add(appKey);
            return true;
          })
        : [];
      const id = typeof item.id === 'string' && item.id.trim()
        ? item.id.trim().slice(0, 128)
        : `folder:${index + 1}`;

      items.push({
        id,
        type: 'folder',
        name: normalizeFolderName(item.name),
        appKeys,
      });
    }
  });

  return {
    appCatalogVersion: desktopAppCatalogVersion,
    sortMode,
    items: migrateLegacyAllAppsLayout(items, appCatalogVersion),
  };
}

function getLayoutItemLabel(item: DesktopLayoutItem, language: ShellDeskAppSettings['language']) {
  return item.type === 'app' ? getAppLabel(getAppInfo(item.appKey), language) : item.name;
}

function compareLayoutItemsByName(
  firstItem: DesktopLayoutItem,
  secondItem: DesktopLayoutItem,
  language: ShellDeskAppSettings['language'],
) {
  return getLayoutItemLabel(firstItem, language).localeCompare(getLayoutItemLabel(secondItem, language), getAppLocale(language));
}

function getSortedDesktopItems(layout: ShellDeskRemoteDesktopLayout, language: ShellDeskAppSettings['language']) {
  if (layout.sortMode === 'custom') {
    return layout.items;
  }

  const sortedItems = [...layout.items].sort((firstItem, secondItem) => compareLayoutItemsByName(firstItem, secondItem, language));
  return layout.sortMode === 'name-desc' ? sortedItems.reverse() : sortedItems;
}

function hasDesktopApp(layout: ShellDeskRemoteDesktopLayout, appKey: DesktopAppKey) {
  return layout.items.some((item) => (
    item.type === 'app'
      ? item.appKey === appKey
      : item.appKeys.includes(appKey)
  ));
}

function removeAppFromDesktopLayout(layout: ShellDeskRemoteDesktopLayout, appKey: DesktopAppKey): ShellDeskRemoteDesktopLayout {
  return {
    ...layout,
    items: layout.items
      .map((item): DesktopLayoutItem | null => {
        if (item.type === 'app') {
          return item.appKey === appKey ? null : item;
        }

        return {
          ...item,
          appKeys: item.appKeys.filter((currentAppKey) => currentAppKey !== appKey),
        };
      })
      .filter((item): item is DesktopLayoutItem => Boolean(item)),
  };
}

function removeTopLevelItem(items: DesktopLayoutItem[], itemId: string) {
  return items.filter((item) => item.id !== itemId);
}

function insertTopLevelItem(items: DesktopLayoutItem[], nextItem: DesktopLayoutItem, targetItemId?: string) {
  const cleanItems = items.filter((item) => item.id !== nextItem.id);
  const targetIndex = targetItemId ? cleanItems.findIndex((item) => item.id === targetItemId) : -1;

  if (targetIndex < 0) {
    return [...cleanItems, nextItem];
  }

  return [
    ...cleanItems.slice(0, targetIndex),
    nextItem,
    ...cleanItems.slice(targetIndex),
  ];
}

function addAppToFolder(layout: ShellDeskRemoteDesktopLayout, folderId: string, appKey: DesktopAppKey, targetAppKey?: DesktopAppKey): ShellDeskRemoteDesktopLayout {
  const withoutApp = removeAppFromDesktopLayout(layout, appKey);

  return {
    ...withoutApp,
    sortMode: 'custom',
    items: withoutApp.items.map((item) => {
      if (item.type !== 'folder' || item.id !== folderId) {
        return item;
      }

      const appKeys = item.appKeys.filter((currentAppKey) => currentAppKey !== appKey);
      const targetIndex = targetAppKey ? appKeys.indexOf(targetAppKey) : -1;
      const nextAppKeys = targetIndex >= 0
        ? [...appKeys.slice(0, targetIndex), appKey, ...appKeys.slice(targetIndex)]
        : [...appKeys, appKey];

      return {
        ...item,
        appKeys: nextAppKeys,
      };
    }),
  };
}

function moveAppToDesktop(layout: ShellDeskRemoteDesktopLayout, appKey: DesktopAppKey, targetItemId?: string): ShellDeskRemoteDesktopLayout {
  const withoutApp = removeAppFromDesktopLayout(layout, appKey);
  return {
    ...withoutApp,
    sortMode: 'custom',
    items: insertTopLevelItem(withoutApp.items, {
      id: `app:${appKey}`,
      type: 'app',
      appKey,
    }, targetItemId),
  };
}

function moveTopLevelItem(layout: ShellDeskRemoteDesktopLayout, itemId: string, targetItemId?: string): ShellDeskRemoteDesktopLayout {
  const item = layout.items.find((currentItem) => currentItem.id === itemId);

  if (!item || item.id === targetItemId) {
    return layout;
  }

  return {
    ...layout,
    sortMode: 'custom',
    items: insertTopLevelItem(removeTopLevelItem(layout.items, itemId), item, targetItemId),
  };
}

function createUniqueFolderName(items: DesktopLayoutItem[], baseName: string) {
  const existingNames = new Set(items.filter((item) => item.type === 'folder').map((item) => item.name));
  let name = baseName;
  let index = 2;

  while (existingNames.has(name)) {
    name = `${baseName} ${index}`;
    index += 1;
  }

  return name;
}

function getDragPayload(event: ReactDragEvent<HTMLElement>, fallbackPayload: DesktopDragPayload | null) {
  if (fallbackPayload) {
    return fallbackPayload;
  }

  try {
    const rawPayload = event.dataTransfer.getData(desktopDragMimeType);
    const payload = rawPayload ? JSON.parse(rawPayload) as Partial<DesktopDragPayload> : null;

    if (payload?.source === 'launchpad' && isDesktopAppKey(payload.appKey)) {
      return { source: 'launchpad', appKey: payload.appKey } satisfies DesktopDragPayload;
    }

    if (payload?.source === 'folder' && typeof payload.folderId === 'string' && isDesktopAppKey(payload.appKey)) {
      return { source: 'folder', folderId: payload.folderId, appKey: payload.appKey } satisfies DesktopDragPayload;
    }

    if (payload?.source === 'desktop' && typeof payload.itemId === 'string' && (payload.itemType === 'app' || payload.itemType === 'folder')) {
      return {
        source: 'desktop',
        itemId: payload.itemId,
        itemType: payload.itemType,
        appKey: isDesktopAppKey(payload.appKey) ? payload.appKey : undefined,
      } satisfies DesktopDragPayload;
    }
  } catch {
    return null;
  }

  return null;
}

function AllAppsIcon() {
  return (
    <svg className="dock-all-apps-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4" y="4" width="6" height="6" rx="1.6" />
      <rect x="14" y="4" width="6" height="6" rx="1.6" />
      <rect x="4" y="14" width="6" height="6" rx="1.6" />
      <rect x="14" y="14" width="6" height="6" rx="1.6" />
    </svg>
  );
}

function DesktopAppIcon({ appKey }: { appKey: DesktopAppKey }) {
  const iconSource = desktopAppIconSources[appKey];

  if (iconSource) {
    return (
      <img
        className="desktop-app-icon"
        src={iconSource}
        alt=""
        aria-hidden="true"
        draggable={false}
      />
    );
  }

  const iconProps = {
    className: 'desktop-app-icon',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.75,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };

  if (appKey === 'files') {
    return (
      <svg {...iconProps}>
        <path d="M3.5 6.75A2.25 2.25 0 0 1 5.75 4.5h4.05l1.7 2h6.75a2.25 2.25 0 0 1 2.25 2.25v8a2.75 2.75 0 0 1-2.75 2.75H6.25a2.75 2.75 0 0 1-2.75-2.75v-10Z" />
        <path d="M4 9h16" />
      </svg>
    );
  }

  if (appKey === 'terminal') {
    return (
      <svg {...iconProps}>
        <rect x="3.5" y="5" width="17" height="14" rx="2.5" />
        <path d="m7.25 9 2.8 2.5-2.8 2.5" />
        <path d="M12.25 14.25h4.5" />
      </svg>
    );
  }

  if (appKey === 'notepad') {
    return (
      <svg {...iconProps}>
        <path d="M6 3.75h8.25L18 7.5v12.75H6V3.75Z" />
        <path d="M14 4v4h4" />
        <path d="M8.75 10.5h5.5M8.75 14h6.5M8.75 17.5h3.5" />
      </svg>
    );
  }

  if (appKey === 'browser') {
    return (
      <svg {...iconProps}>
        <circle cx="12" cy="12" r="8.5" />
        <path d="M3.75 12h16.5" />
        <path d="M12 3.5c2.2 2.35 3.3 5.18 3.3 8.5s-1.1 6.15-3.3 8.5c-2.2-2.35-3.3-5.18-3.3-8.5S9.8 5.85 12 3.5Z" />
      </svg>
    );
  }

  if (appKey === 'vnc') {
    return (
      <svg {...iconProps}>
        <rect x="3.5" y="5" width="17" height="11.5" rx="2.25" />
        <path d="M8.5 20h7M12 16.5V20" />
        <path d="M7.25 9.5h9.5M7.25 12.5h4.5" />
      </svg>
    );
  }

  if (appKey === 'log-viewer') {
    return (
      <svg {...iconProps}>
        <path d="M6 3.75h8.25L18 7.5v12.75H6V3.75Z" />
        <path d="M14 4v4h4" />
        <path d="M8.75 11h6.5M8.75 14.25h6.5M8.75 17.5h4" />
        <circle cx="17.5" cy="17.5" r="2.25" />
      </svg>
    );
  }

  if (appKey === 'monitor') {
    return (
      <svg {...iconProps}>
        <path d="M4.25 18.75V5.25" />
        <path d="M4.25 18.75h15.5" />
        <path d="m7 15 3.15-3.4 2.75 2.25 4.45-5.2" />
        <path d="M16.75 8.65h2.1v2.1" />
      </svg>
    );
  }

  if (appKey === 'mysql') {
    return (
      <svg {...iconProps}>
        <ellipse cx="12" cy="5.75" rx="6.75" ry="2.75" />
        <path d="M5.25 5.75v8.5C5.25 15.77 8.27 17 12 17s6.75-1.23 6.75-2.75v-8.5" />
        <path d="M5.25 10c0 1.52 3.02 2.75 6.75 2.75S18.75 11.52 18.75 10" />
        <path d="M9.25 20.25h5.5" />
      </svg>
    );
  }

  if (appKey === 'redis') {
    return (
      <svg {...iconProps}>
        <path d="m12 3.75 7 3.4-7 3.35-7-3.35 7-3.4Z" />
        <path d="m5 11 7 3.35L19 11" />
        <path d="m5 14.9 7 3.35 7-3.35" />
      </svg>
    );
  }

  if (appKey === 'service-manager') {
    return (
      <svg {...iconProps}>
        <path d="M5 7h14M5 12h14M5 17h14" />
        <circle cx="9" cy="7" r="1.75" fill="currentColor" stroke="none" />
        <circle cx="15" cy="12" r="1.75" fill="currentColor" stroke="none" />
        <circle cx="11.5" cy="17" r="1.75" fill="currentColor" stroke="none" />
      </svg>
    );
  }

  if (appKey === 'container-manager') {
    return (
      <svg {...iconProps}>
        <path d="M5 8.5h14v8.25H5V8.5Z" />
        <path d="M8.5 8.5v8.25M12 8.5v8.25M15.5 8.5v8.25" />
        <path d="M7 5h10v3.5H7V5Z" />
        <path d="M6.25 19h11.5" />
      </svg>
    );
  }

  if (appKey === 'port-manager') {
    return (
      <svg {...iconProps}>
        <path d="M4.25 7.5h5.25l2.5 4.5h7.75" />
        <path d="M4.25 16.5h5.25l2.5-4.5" />
        <circle cx="4.25" cy="7.5" r="1.75" />
        <circle cx="4.25" cy="16.5" r="1.75" />
        <circle cx="19.75" cy="12" r="1.75" />
        <path d="M13.25 7.5h2.75M15.75 16.5h2.25" />
      </svg>
    );
  }

  if (appKey === 'firewall-manager') {
    return (
      <svg {...iconProps}>
        <path d="M12 3.5 18.75 6v5.3c0 4.05-2.58 7.35-6.75 9.2-4.17-1.85-6.75-5.15-6.75-9.2V6L12 3.5Z" />
        <path d="M8.5 11.5h7" />
        <path d="M10 8.75v5.5M14 8.75v5.5" />
        <path d="M9.25 16.25h5.5" />
      </svg>
    );
  }

  if (appKey === 'network-diagnostics') {
    return (
      <svg {...iconProps}>
        <path d="M4.5 12a7.5 7.5 0 0 1 15 0" />
        <path d="M7.25 12a4.75 4.75 0 0 1 9.5 0" />
        <path d="M10 12a2 2 0 0 1 4 0" />
        <path d="M12 14.25v5" />
        <path d="M8.5 19.25h7" />
        <circle cx="12" cy="4.75" r="1.5" />
      </svg>
    );
  }

  if (appKey === 'disk-analyzer') {
    return (
      <svg {...iconProps}>
        <ellipse cx="12" cy="6" rx="6.5" ry="2.75" />
        <path d="M5.5 6v8.5c0 1.52 2.91 2.75 6.5 2.75s6.5-1.23 6.5-2.75V6" />
        <path d="M5.5 10.25C5.5 11.77 8.41 13 12 13s6.5-1.23 6.5-2.75" />
        <path d="M8.5 20h7" />
        <path d="M15.75 16.75 18.5 20" />
      </svg>
    );
  }

  if (appKey === 'disk-manager') {
    return (
      <svg {...iconProps}>
        <ellipse cx="12" cy="5.75" rx="6.25" ry="2.5" />
        <path d="M5.75 5.75v7.5c0 1.38 2.8 2.5 6.25 2.5s6.25-1.12 6.25-2.5v-7.5" />
        <path d="M5.75 9.5C5.75 10.88 8.55 12 12 12s6.25-1.12 6.25-2.5" />
        <path d="M8.5 19.25h7" />
        <path d="M12 16v5.5" />
        <path d="M15.25 18.25 17 20l2.75-3" />
      </svg>
    );
  }

  if (appKey === 'package-manager') {
    return (
      <svg {...iconProps}>
        <path d="m12 3.75 6.75 3.4v6.95L12 20.25 5.25 14.1V7.15L12 3.75Z" />
        <path d="m5.55 7.35 6.45 3.3 6.45-3.3" />
        <path d="M12 10.75v9" />
        <path d="m8.5 5.6 6.55 3.35" />
      </svg>
    );
  }

  if (appKey === 'scheduled-tasks') {
    return (
      <svg {...iconProps}>
        <rect x="4.25" y="5" width="15.5" height="14.75" rx="2.25" />
        <path d="M7.5 3.75v3M16.5 3.75v3M4.75 9h14.5" />
        <path d="M8 12.25h2.5M13 12.25h3M8 15.5h2.5" />
        <path d="m14.25 16 1.1 1.1 2.15-2.45" />
      </svg>
    );
  }

  if (appKey === 'postgres') {
    return (
      <svg {...iconProps}>
        <ellipse cx="12" cy="5.75" rx="6.75" ry="2.75" />
        <path d="M5.25 5.75v8.5C5.25 15.77 8.27 17 12 17s6.75-1.23 6.75-2.75v-8.5" />
        <path d="M5.25 10c0 1.52 3.02 2.75 6.75 2.75S18.75 11.52 18.75 10" />
        <path d="M8.25 20.25h7.5" />
        <path d="M9.25 15.75 7.75 19M14.75 15.75 16.25 19" />
      </svg>
    );
  }

  if (appKey === 'security-audit') {
    return (
      <svg {...iconProps}>
        <path d="M12 3.5 18.25 6v5.2c0 3.65-2.32 6.72-6.25 8.45-3.93-1.73-6.25-4.8-6.25-8.45V6L12 3.5Z" />
        <path d="m8.75 11.8 2.1 2.1 4.4-5" />
        <path d="M8.5 16.5h7" />
      </svg>
    );
  }

  if (appKey === 'login-sessions') {
    return (
      <svg {...iconProps}>
        <path d="M8.5 10.75a3 3 0 1 1 0-6 3 3 0 0 1 0 6Z" />
        <path d="M3.75 19.25c.5-3.25 2.15-5 4.75-5s4.25 1.75 4.75 5" />
        <path d="M16 8.5h4.25" />
        <path d="m18.25 6.5 2 2-2 2" />
        <path d="M15.5 14.5h4.75" />
      </svg>
    );
  }

  if (appKey === 'api-debugger') {
    return (
      <svg {...iconProps}>
        <path d="m8.25 8-4 4 4 4" />
        <path d="m15.75 8 4 4-4 4" />
        <path d="m13.25 5.75-2.5 12.5" />
        <path d="M7.25 20.25h9.5" />
      </svg>
    );
  }

  if (appKey === 'procmanager') {
    return (
      <svg {...iconProps}>
        <rect x="7" y="7" width="10" height="10" rx="2" />
        <path d="M10 3.75v2.5M14 3.75v2.5M10 17.75v2.5M14 17.75v2.5M3.75 10h2.5M3.75 14h2.5M17.75 10h2.5M17.75 14h2.5" />
        <path d="M9.75 12h1.7l1.05-2.2 1.35 4.4.95-2.2h1.45" />
      </svg>
    );
  }

  if (appKey === 'settings') {
    return (
      <svg {...iconProps}>
        <path d="M12 8.75a3.25 3.25 0 1 1 0 6.5 3.25 3.25 0 0 1 0-6.5Z" />
        <path d="m18.65 13.5 1.85 1.38-1.75 3.03-2.18-.9a7.18 7.18 0 0 1-1.65.95l-.3 2.29h-3.5l-.3-2.29a7.18 7.18 0 0 1-1.65-.95l-2.18.9-1.75-3.03L7.35 13.5a7.55 7.55 0 0 1 0-1.9L5.5 10.12l1.75-3.03 2.18.9c.5-.39 1.05-.7 1.65-.95l.3-2.29h3.5l.3 2.29c.6.25 1.15.56 1.65.95l2.18-.9 1.75 3.03-1.85 1.48c.08.62.08 1.27 0 1.9Z" />
      </svg>
    );
  }

  return (
    <svg {...iconProps}>
      <path d="M6.25 4.25h9l2.5 2.5v13H6.25V4.25Z" />
      <path d="M15 4.5V7h2.5" />
      <ellipse cx="12" cy="10" rx="4" ry="1.7" />
      <path d="M8 10v5.25c0 .94 1.8 1.7 4 1.7s4-.76 4-1.7V10" />
      <path d="M8 12.75c0 .94 1.8 1.7 4 1.7s4-.76 4-1.7" />
    </svg>
  );
}

function getTopDesktopWindow(
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

function hasCustomDesktopWallpaper(settings: ShellDeskAppSettings) {
  return settings.desktopWallpaperMode === 'custom' && Boolean(settings.desktopWallpaperDataUrl);
}

function getDesktopWallpaperStyle(settings: ShellDeskAppSettings, presetWallpaperUrl: string): CSSProperties {
  const wallpaperSource = hasCustomDesktopWallpaper(settings)
    ? settings.desktopWallpaperDataUrl
    : presetWallpaperUrl;
  const wallpaperImage = wallpaperSource
    ? `, url(${JSON.stringify(wallpaperSource)})`
    : '';

  return {
    backgroundImage: `linear-gradient(180deg, var(--desktop-wallpaper-scrim-top), var(--desktop-wallpaper-scrim-bottom))${wallpaperImage}`,
    backgroundPosition: 'center, center',
    backgroundRepeat: 'no-repeat, no-repeat',
    backgroundSize: 'cover, cover',
  };
}

function getTerminalSnippetGroups(snippets: ShellDeskTerminalSnippet[], language: ShellDeskAppSettings['language']) {
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

function getTerminalSnippetPreview(snippet: ShellDeskTerminalSnippet) {
  return snippet.command.split(/\r?\n/u)[0].trim();
}

function quotePosixShellArg(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function createTmuxListCommand() {
  return [
    'if ! command -v tmux >/dev/null 2>&1; then exit 127; fi',
    `tmux list-sessions -F ${quotePosixShellArg('#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_created}\t#{session_last_attached}')} 2>/dev/null || true`,
  ].join('; ');
}

function parseTmuxSessions(output: string): TmuxSessionInfo[] {
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

function createTmuxSessionName() {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/u, '').replace('T', '-');
  return `shelldesk-${stamp}`;
}

function createTmuxLaunchOptions(sessionName: string, command: 'attach' | 'new' = 'attach'): RemoteTerminalLaunchOptions {
  const quotedSessionName = quotePosixShellArg(sessionName);
  return {
    mode: 'tmux',
    tmuxSessionName: sessionName,
    title: `tmux: ${sessionName}`,
    initialCommand: command === 'new'
      ? `tmux new-session -A -s ${quotedSessionName}`
      : `tmux attach-session -t ${quotedSessionName} || tmux new-session -A -s ${quotedSessionName}`,
  };
}

function parseSimpleCommandWords(command: string) {
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

function getTmuxOptionValue(words: string[], optionNames: string[]) {
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

function parseTmuxLaunchCommand(command: string): TmuxLaunchRequest | null {
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

interface DesktopWindowProps {
  appLabel: string;
  desktopWindow: DesktopWindowState;
  isFocused: boolean;
  isTerminalTitlebarMenuOpen: boolean;
  language: ShellDeskAppSettings['language'];
  livePointerFrame: DesktopWindowFrame | null;
  renderSettings: ShellDeskAppSettings;
  onBringToFront: (windowId: string) => void;
  onClose: (windowId: string) => void;
  onFinishInteraction: (event: ReactPointerEvent<HTMLElement>) => void;
  onMinimize: (windowId: string) => void;
  onOpenTerminalTitlebarMenu: (windowId: string, buttonRect: DOMRect) => void;
  onResizePointerDown: (event: ReactPointerEvent<HTMLElement>, windowId: string) => void;
  onTitlebarPointerDown: (event: ReactPointerEvent<HTMLElement>, windowId: string) => void;
  onToggleMaximize: (windowId: string) => void;
  onUpdateInteraction: (event: ReactPointerEvent<HTMLElement>) => void;
  renderContent: (desktopWindow: DesktopWindowState) => ReactNode;
}

const DesktopWindow = memo(function DesktopWindow({
  appLabel,
  desktopWindow,
  isFocused,
  isTerminalTitlebarMenuOpen,
  language,
  livePointerFrame,
  onBringToFront,
  onClose,
  onFinishInteraction,
  onMinimize,
  onOpenTerminalTitlebarMenu,
  onResizePointerDown,
  onTitlebarPointerDown,
  onToggleMaximize,
  onUpdateInteraction,
  renderContent,
}: DesktopWindowProps) {
  const renderedFrame = livePointerFrame ?? desktopWindow.frame;
  const desktopWindowStyle: CSSProperties = {
    width: renderedFrame.width,
    height: renderedFrame.height,
    transform: `translate3d(${renderedFrame.x}px, ${renderedFrame.y}px, 0)`,
    zIndex: 10 + desktopWindow.zIndex,
  };

  return (
    <section
      className={`desktop-window desktop-window-${desktopWindow.appKey} ${isFocused ? 'focused' : ''} ${desktopWindow.isMaximized ? 'maximized' : ''} ${desktopWindow.isMinimized ? 'minimized' : ''}`}
      aria-label={appLabel}
      aria-hidden={desktopWindow.isMinimized}
      style={desktopWindowStyle}
      onPointerDownCapture={() => onBringToFront(desktopWindow.id)}
    >
      <header
        className="desktop-window-titlebar"
        onPointerDown={(event) => onTitlebarPointerDown(event, desktopWindow.id)}
        onPointerMove={onUpdateInteraction}
        onPointerUp={onFinishInteraction}
        onPointerCancel={onFinishInteraction}
      >
        <div className="desktop-window-title">
          <span className={`desktop-title-icon desktop-app-icon-${desktopWindow.appKey}`}>
            <DesktopAppIcon appKey={desktopWindow.appKey} />
          </span>
          {desktopWindow.appKey === 'browser' || desktopWindow.appKey === 'terminal' ? (
            <>
              <span className="desktop-window-kicker">{appLabel}</span>
              {desktopWindow.chromeTitle ? (
                <strong title={desktopWindow.chromeTitle}>
                  {desktopWindow.chromeTitle}
                </strong>
              ) : null}
              {desktopWindow.chromeStatus ? (
                <span className={`desktop-window-state-pill ${desktopWindow.chromeTone || 'idle'}`}>
                  {desktopWindow.chromeStatus}
                </span>
              ) : null}
            </>
          ) : (
            <strong>{appLabel}</strong>
          )}
        </div>
        <div className="win-titlebar-controls" aria-label={t('desktop.window.controls', language)} onPointerDown={(event) => event.stopPropagation()}>
          {desktopWindow.appKey === 'terminal' ? (
            <button
              type="button"
              className={`win-btn terminal-tools ${isTerminalTitlebarMenuOpen ? 'active' : ''}`}
              aria-label={t('terminal.titlebar.tools', language)}
              aria-haspopup="menu"
              aria-expanded={isTerminalTitlebarMenuOpen}
              title={t('terminal.titlebar.tools', language)}
              onClick={(event) => onOpenTerminalTitlebarMenu(desktopWindow.id, event.currentTarget.getBoundingClientRect())}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                <circle cx="2" cy="6" r="1.2" fill="currentColor" />
                <circle cx="6" cy="6" r="1.2" fill="currentColor" />
                <circle cx="10" cy="6" r="1.2" fill="currentColor" />
              </svg>
            </button>
          ) : null}
          <button type="button" className="win-btn minimize" aria-label={t('desktop.window.minimize', language)} title={t('desktop.window.minimizeTitle', language)} onClick={() => onMinimize(desktopWindow.id)}>
            <svg width="10" height="1" viewBox="0 0 10 1"><rect width="10" height="1" fill="currentColor" /></svg>
          </button>
          <button
            type="button"
            className="win-btn maximize"
            aria-label={desktopWindow.isMaximized ? t('desktop.window.restoreWindow', language) : t('desktop.window.maximizeWindow', language)}
            title={desktopWindow.isMaximized ? t('desktop.window.restoreTitle', language) : t('desktop.window.maximizeTitle', language)}
            onClick={() => onToggleMaximize(desktopWindow.id)}
          >
            {desktopWindow.isMaximized ? (
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
                <rect x="0.5" y="2.5" width="7" height="7" rx="0.5" />
                <path d="M2.5 2.5V0.5H9.5V7.5H7.5" />
              </svg>
            ) : (
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
                <rect x="0.5" y="0.5" width="9" height="9" rx="0.5" />
              </svg>
            )}
          </button>
          <button type="button" className="win-btn close" aria-label={t('desktop.window.close', language)} title={t('desktop.window.closeTitle', language)} onClick={() => onClose(desktopWindow.id)}>
            <svg width="10" height="10" viewBox="0 0 10 10" stroke="currentColor" strokeWidth="1.2">
              <line x1="1" y1="1" x2="9" y2="9" />
              <line x1="9" y1="1" x2="1" y2="9" />
            </svg>
          </button>
        </div>
      </header>
      <div className="desktop-window-body">
        <Suspense fallback={<div className="desktop-window-loading">{t('desktop.window.loading', language)}</div>}>
          {renderContent(desktopWindow)}
        </Suspense>
      </div>
      {!desktopWindow.isMaximized ? (
        <div
          className="desktop-window-resize-handle"
          onPointerDown={(event) => onResizePointerDown(event, desktopWindow.id)}
          onPointerMove={onUpdateInteraction}
          onPointerUp={onFinishInteraction}
          onPointerCancel={onFinishInteraction}
          aria-hidden="true"
        />
      ) : null}
    </section>
  );
}, (previousProps, nextProps) => (
  previousProps.desktopWindow === nextProps.desktopWindow &&
  previousProps.isFocused === nextProps.isFocused &&
  previousProps.isTerminalTitlebarMenuOpen === nextProps.isTerminalTitlebarMenuOpen &&
  previousProps.language === nextProps.language &&
  previousProps.livePointerFrame === nextProps.livePointerFrame &&
  previousProps.renderSettings === nextProps.renderSettings &&
  previousProps.appLabel === nextProps.appLabel
));

function RemoteDesktopShell({ connection, settings, onSettingsChange, onTerminalSessionEvent }: RemoteDesktopProps) {
  const desktopSurfaceRef = useRef<HTMLElement | null>(null);
  const windowPointerStateRef = useRef<DesktopWindowPointerState | null>(null);
  const titlebarClickStateRef = useRef<DesktopWindowTitlebarClickState | null>(null);
  const desktopDragPayloadRef = useRef<DesktopDragPayload | null>(null);
  const windowSequenceRef = useRef(0);
  const terminalToolRequestSequenceRef = useRef(0);
  const terminalCommandRequestSequenceRef = useRef(0);
  const tmuxRefreshRequestRef = useRef(0);
  const zIndexRef = useRef(0);
  const launchpadCloseTimerRef = useRef<number | null>(null);
  const folderCloseTimerRef = useRef<number | null>(null);
  const [desktopWindows, setDesktopWindows] = useState<DesktopWindowState[]>([]);
  const desktopWindowsRef = useRef(desktopWindows);
  const [desktopLayout, setDesktopLayout] = useState<ShellDeskRemoteDesktopLayout>(() => normalizeRemoteDesktopLayout(settings.remoteDesktopLayout));
  const desktopLayoutRef = useRef(desktopLayout);
  const [focusedWindowId, setFocusedWindowId] = useState('');
  const [isLaunchpadOpen, setIsLaunchpadOpen] = useState(false);
  const [isLaunchpadRendered, setIsLaunchpadRendered] = useState(false);
  const [appContextMenu, setAppContextMenu] = useState<DesktopAppContextMenuState | null>(null);
  const [folderContextMenu, setFolderContextMenu] = useState<DesktopFolderContextMenuState | null>(null);
  const [surfaceContextMenu, setSurfaceContextMenu] = useState<DesktopSurfaceContextMenuState | null>(null);
  const [openFolderId, setOpenFolderId] = useState('');
  const [isFolderOpen, setIsFolderOpen] = useState(false);
  const [renameFolderDialog, setRenameFolderDialog] = useState<FolderRenameDialogState | null>(null);
  const [launchpadTooltip, setLaunchpadTooltip] = useState<LaunchpadTooltipState | null>(null);
  const [terminalTitlebarMenu, setTerminalTitlebarMenu] = useState<TerminalTitlebarMenuState | null>(null);
  const [tmuxMenuState, setTmuxMenuState] = useState<TmuxMenuState>({ status: 'idle', sessions: [] });
  const [pendingCloseWindowId, setPendingCloseWindowId] = useState('');
  const [presetWallpaperUrl, setPresetWallpaperUrl] = useState('');
  const focusedWindow = desktopWindows.find((desktopWindow) => desktopWindow.id === focusedWindowId && !desktopWindow.isMinimized) ?? null;
  const terminalTitlebarMenuWindow = desktopWindows.find((desktopWindow) => desktopWindow.id === terminalTitlebarMenu?.windowId && desktopWindow.appKey === 'terminal') ?? null;
  const pendingCloseWindow = desktopWindows.find((desktopWindow) => desktopWindow.id === pendingCloseWindowId) ?? null;
  const desktopWallpaperStyle = getDesktopWallpaperStyle(settings, presetWallpaperUrl);
  const hasCustomWallpaper = hasCustomDesktopWallpaper(settings);
  const remoteConnectionProfileHostId = getRemoteConnectionProfileHostId(connection);
  const visibleDesktopItems = getSortedDesktopItems(desktopLayout, settings.language);
  const openFolder = desktopLayout.items.find((item): item is DesktopFolderLayoutItem => item.type === 'folder' && item.id === openFolderId) ?? null;
  const appLocale = getAppLocale(settings.language);
  const launchpadApps = [...desktopApps].sort((firstApp, secondApp) => (
    getAppLabel(firstApp, settings.language).localeCompare(getAppLabel(secondApp, settings.language), appLocale)
  ));

  useEffect(() => {
    desktopWindowsRef.current = desktopWindows;
  }, [desktopWindows]);

  useEffect(() => {
    const logContext = {
      hostId: connection.host.id || connection.id,
      hostName: connection.host.name || connection.host.systemName || connection.host.address,
      hostAddress: connection.host.address,
    };

    window.__shellDeskLogContext = logContext;

    return () => {
      if (window.__shellDeskLogContext === logContext) {
        delete window.__shellDeskLogContext;
      }
    };
  }, [connection.id, connection.host.address, connection.host.id, connection.host.name, connection.host.systemName]);

  useEffect(() => {
    const normalizedLayout = normalizeRemoteDesktopLayout(settings.remoteDesktopLayout);
    const currentLayout = desktopLayoutRef.current;

    if (areRemoteDesktopLayoutsEqual(currentLayout, normalizedLayout)) {
      return;
    }

    if (shouldPreserveCurrentDesktopLayout(currentLayout, normalizedLayout)) {
      return;
    }

    desktopLayoutRef.current = normalizedLayout;
    setDesktopLayout(normalizedLayout);
  }, [settings.remoteDesktopLayout]);

  useEffect(() => {
    desktopLayoutRef.current = desktopLayout;
  }, [desktopLayout]);

  useEffect(() => {
    if (hasCustomDesktopWallpaper(settings)) {
      setPresetWallpaperUrl('');
      return undefined;
    }

    let isCurrent = true;
    loadDesktopWallpaperPresetUrl(settings.desktopWallpaperPresetId)
      .then((url) => {
        if (isCurrent) {
          setPresetWallpaperUrl(url);
        }
      })
      .catch(() => {
        if (isCurrent) {
          setPresetWallpaperUrl('');
        }
      });

    return () => {
      isCurrent = false;
    };
  }, [settings.desktopWallpaperMode, settings.desktopWallpaperPresetId, settings.desktopWallpaperDataUrl]);

  useEffect(() => () => {
    if (launchpadCloseTimerRef.current !== null) {
      window.clearTimeout(launchpadCloseTimerRef.current);
    }

    if (folderCloseTimerRef.current !== null) {
      window.clearTimeout(folderCloseTimerRef.current);
    }
  }, []);

  useEffect(() => {
    const surface = desktopSurfaceRef.current;

    if (!surface || typeof ResizeObserver === 'undefined') {
      return;
    }

    const resizeObserver = new ResizeObserver(([entry]) => {
      if (!entry) {
        return;
      }

      const { width, height } = entry.contentRect;
      setDesktopWindows((currentWindows) => currentWindows.map((desktopWindow) => {
        if (desktopWindow.isMaximized) {
          return { ...desktopWindow, frame: getMaximizedWindowFrame(width, height) };
        }

        return { ...desktopWindow, frame: clampWindowFrame(desktopWindow.frame, width, height) };
      }));
    });

    resizeObserver.observe(surface);

    return () => resizeObserver.disconnect();
  }, []);

  const commitDesktopLayout = (nextLayout: ShellDeskRemoteDesktopLayout) => {
    const normalizedLayout = normalizeRemoteDesktopLayout(nextLayout);
    desktopLayoutRef.current = normalizedLayout;
    setDesktopLayout(normalizedLayout);
    onSettingsChange?.({
      ...settings,
      remoteDesktopLayout: normalizedLayout,
    });
  };

  const updateDesktopLayout = (updater: (layout: ShellDeskRemoteDesktopLayout) => ShellDeskRemoteDesktopLayout) => {
    commitDesktopLayout(updater(desktopLayoutRef.current));
  };

  const closeDesktopMenus = () => {
    setAppContextMenu(null);
    setFolderContextMenu(null);
    setSurfaceContextMenu(null);
  };

  const openLaunchpad = () => {
    if (launchpadCloseTimerRef.current !== null) {
      window.clearTimeout(launchpadCloseTimerRef.current);
      launchpadCloseTimerRef.current = null;
    }

    setIsLaunchpadRendered(true);
    setIsLaunchpadOpen(true);
  };

  const closeLaunchpad = () => {
    setIsLaunchpadOpen(false);
    setLaunchpadTooltip(null);

    if (launchpadCloseTimerRef.current !== null) {
      window.clearTimeout(launchpadCloseTimerRef.current);
    }

    launchpadCloseTimerRef.current = window.setTimeout(() => {
      setIsLaunchpadRendered(false);
      launchpadCloseTimerRef.current = null;
    }, launchpadAnimationMs);
  };

  const toggleLaunchpad = () => {
    if (isLaunchpadOpen) {
      closeLaunchpad();
      return;
    }

    openLaunchpad();
  };

  const openDesktopFolder = (folderId: string) => {
    if (folderCloseTimerRef.current !== null) {
      window.clearTimeout(folderCloseTimerRef.current);
      folderCloseTimerRef.current = null;
    }

    setOpenFolderId(folderId);
    setIsFolderOpen(true);
  };

  const closeDesktopFolder = () => {
    setIsFolderOpen(false);

    if (folderCloseTimerRef.current !== null) {
      window.clearTimeout(folderCloseTimerRef.current);
    }

    folderCloseTimerRef.current = window.setTimeout(() => {
      setOpenFolderId('');
      folderCloseTimerRef.current = null;
    }, launchpadAnimationMs);
  };

  const createFolder = () => {
    const folderName = createUniqueFolderName(desktopLayout.items, t('desktop.folder.defaultName', settings.language));
    const folderId = `folder:${Date.now().toString(36)}`;

    commitDesktopLayout({
      ...desktopLayout,
      sortMode: 'custom',
      items: [
        ...desktopLayout.items,
        {
          id: folderId,
          type: 'folder',
          name: folderName,
          appKeys: [],
        },
      ],
    });
    setRenameFolderDialog({ folderId, name: folderName });
  };

  const renameFolder = (folderId: string, name: string) => {
    updateDesktopLayout((layout) => ({
      ...layout,
      items: layout.items.map((item) => (
        item.type === 'folder' && item.id === folderId
          ? { ...item, name: normalizeFolderName(name) }
          : item
      )),
    }));
  };

  const deleteFolder = (folderId: string) => {
    updateDesktopLayout((layout) => ({
      ...layout,
      sortMode: 'custom',
      items: layout.items.filter((item) => item.id !== folderId),
    }));

    if (openFolderId === folderId) {
      if (folderCloseTimerRef.current !== null) {
        window.clearTimeout(folderCloseTimerRef.current);
        folderCloseTimerRef.current = null;
      }

      setIsFolderOpen(false);
      setOpenFolderId('');
    }
  };

  const handleSortModeChange = (sortMode: ShellDeskDesktopSortMode) => {
    updateDesktopLayout((layout) => ({
      ...layout,
      sortMode,
    }));
  };

  const showLaunchpadTooltip = (element: HTMLElement, description: string) => {
    const rect = element.getBoundingClientRect();
    const tooltipHeight = 56;
    const placement = rect.bottom + tooltipHeight + 12 > window.innerHeight ? 'top' : 'bottom';

    setLaunchpadTooltip({
      description,
      x: rect.left + rect.width / 2,
      y: placement === 'bottom' ? rect.bottom + 10 : rect.top - 10,
      placement,
    });
  };

  const handleDragStart = (event: ReactDragEvent<HTMLElement>, payload: DesktopDragPayload) => {
    desktopDragPayloadRef.current = payload;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(desktopDragMimeType, JSON.stringify(payload));
  };

  const handleDragEnd = () => {
    desktopDragPayloadRef.current = null;
  };

  const handleDragOver = (event: ReactDragEvent<HTMLElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  };

  const applyDesktopDrop = (payload: DesktopDragPayload, targetItem?: DesktopLayoutItem) => {
    const payloadAppKey = 'appKey' in payload ? payload.appKey : undefined;

    if (targetItem?.type === 'folder' && payloadAppKey) {
      updateDesktopLayout((layout) => addAppToFolder(layout, targetItem.id, payloadAppKey));
      return;
    }

    if (payload.source === 'desktop') {
      updateDesktopLayout((layout) => moveTopLevelItem(layout, payload.itemId, targetItem?.id));
      return;
    }

    updateDesktopLayout((layout) => moveAppToDesktop(layout, payload.appKey, targetItem?.id));
  };

  const handleDesktopDrop = (event: ReactDragEvent<HTMLElement>, targetItem?: DesktopLayoutItem) => {
    event.preventDefault();
    event.stopPropagation();
    const payload = getDragPayload(event, desktopDragPayloadRef.current);
    desktopDragPayloadRef.current = null;

    if (!payload) {
      return;
    }

    applyDesktopDrop(payload, targetItem);
  };

  const handleFolderDrop = (event: ReactDragEvent<HTMLElement>, folderId: string, targetAppKey?: DesktopAppKey) => {
    event.preventDefault();
    event.stopPropagation();
    const payload = getDragPayload(event, desktopDragPayloadRef.current);
    desktopDragPayloadRef.current = null;

    const payloadAppKey = payload && 'appKey' in payload ? payload.appKey : undefined;

    if (!payloadAppKey) {
      return;
    }

    updateDesktopLayout((layout) => addAppToFolder(layout, folderId, payloadAppKey, targetAppKey));
  };

  const handleSurfaceContextMenu = (event: ReactPointerEvent<HTMLElement> | ReactMouseEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;

    if (target.closest('.desktop-icon-button, .desktop-window, .mac-dock')) {
      return;
    }

    event.preventDefault();
    closeDesktopMenus();
    setSurfaceContextMenu({ x: event.clientX, y: event.clientY });
  };

  const sendAppToDesktop = (appKey: DesktopAppKey) => {
    if (hasDesktopApp(desktopLayout, appKey)) {
      return;
    }

    updateDesktopLayout((layout) => moveAppToDesktop(layout, appKey));
  };

  const moveFolderAppToDesktop = (appKey: DesktopAppKey) => {
    updateDesktopLayout((layout) => moveAppToDesktop(layout, appKey));
  };

  const deleteAppFromDesktop = (appKey: DesktopAppKey) => {
    updateDesktopLayout((layout) => ({
      ...removeAppFromDesktopLayout(layout, appKey),
      sortMode: 'custom',
    }));
  };

  const submitFolderRename = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!renameFolderDialog) {
      return;
    }

    renameFolder(renameFolderDialog.folderId, renameFolderDialog.name);
    setRenameFolderDialog(null);
  };

  const bringWindowToFront = useCallback((windowId: string) => {
    setFocusedWindowId(windowId);
    setDesktopWindows((currentWindows) => {
      const targetWindow = currentWindows.find((desktopWindow) => desktopWindow.id === windowId);

      if (!targetWindow) {
        return currentWindows;
      }

      const highestZIndex = currentWindows.reduce((highest, desktopWindow) => Math.max(highest, desktopWindow.zIndex), 0);
      const alreadyFront = !targetWindow.isMinimized && targetWindow.zIndex >= highestZIndex;

      if (alreadyFront) {
        return currentWindows;
      }

      zIndexRef.current = Math.max(zIndexRef.current, highestZIndex) + 1;
      const nextZIndex = zIndexRef.current;
      return currentWindows.map((desktopWindow) => (
        desktopWindow.id === windowId ? { ...desktopWindow, isMinimized: false, zIndex: nextZIndex } : desktopWindow
      ));
    });
  }, []);

  const appendDesktopWindow = (
    appKey: DesktopAppKey,
    configureWindow?: (desktopWindow: DesktopWindowState) => void,
  ) => {
    windowSequenceRef.current += 1;
    zIndexRef.current += 1;
    const nextWindow = createDesktopWindow(appKey, windowSequenceRef.current, zIndexRef.current, settings.language);
    const surface = desktopSurfaceRef.current;

    configureWindow?.(nextWindow);

    if (surface) {
      const surfaceRect = surface.getBoundingClientRect();
      nextWindow.frame = clampWindowFrame(nextWindow.frame, surfaceRect.width, surfaceRect.height);
    }

    setDesktopWindows((currentWindows) => [...currentWindows, nextWindow]);
    setFocusedWindowId(nextWindow.id);
  };

  const openDesktopWindow = (appKey: DesktopAppKey) => {
    appendDesktopWindow(appKey);
  };

  const openTerminalWindow = (launchOptions?: RemoteTerminalLaunchOptions) => {
    appendDesktopWindow('terminal', (nextWindow) => {
      nextWindow.terminalLaunchOptions = launchOptions;
    });
  };

  const refreshTmuxSessions = useCallback(async () => {
    const requestId = tmuxRefreshRequestRef.current + 1;
    tmuxRefreshRequestRef.current = requestId;
    setTmuxMenuState((currentState) => ({ ...currentState, status: 'loading', error: undefined }));

    if (connection.host.systemType === 'windows') {
      setTmuxMenuState({
        status: 'error',
        sessions: [],
        error: t('terminal.tmux.unsupported', settings.language),
      });
      return;
    }

    const api = window.guiSSH?.connections;

    if (!api?.runCommand) {
      setTmuxMenuState({
        status: 'error',
        sessions: [],
        error: t('terminal.tmux.bridgeUnavailable', settings.language),
      });
      return;
    }

    try {
      const result = await api.runCommand(connection.id, createTmuxListCommand());

      if (tmuxRefreshRequestRef.current !== requestId) {
        return;
      }

      if (result.code === 127) {
        setTmuxMenuState({
          status: 'error',
          sessions: [],
          error: t('terminal.tmux.notInstalled', settings.language),
        });
        return;
      }

      if (result.code !== 0 && result.stderr.trim()) {
        setTmuxMenuState({
          status: 'error',
          sessions: [],
          error: result.stderr.trim(),
        });
        return;
      }

      setTmuxMenuState({
        status: 'ready',
        sessions: parseTmuxSessions(result.stdout),
      });
    } catch (error) {
      if (tmuxRefreshRequestRef.current !== requestId) {
        return;
      }

      setTmuxMenuState({
        status: 'error',
        sessions: [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [connection.host.systemType, connection.id, settings.language]);

  const rememberTmuxSession = (sessionName: string) => {
    setTmuxMenuState((currentState) => {
      if (currentState.sessions.some((session) => session.name === sessionName)) {
        return currentState;
      }

      return {
        status: currentState.status === 'idle' ? 'ready' : currentState.status,
        sessions: [
          {
            name: sessionName,
            windows: 1,
            attached: 0,
            createdAt: Math.floor(Date.now() / 1000),
            lastAttachedAt: Math.floor(Date.now() / 1000),
          },
          ...currentState.sessions,
        ],
        error: currentState.error,
      };
    });
  };

  const openTmuxTerminal = (sessionName: string, command: 'attach' | 'new' = 'attach') => {
    rememberTmuxSession(sessionName);
    openTerminalWindow(createTmuxLaunchOptions(sessionName, command));
    setTerminalTitlebarMenu(null);
    window.setTimeout(() => {
      void refreshTmuxSessions();
    }, 900);
  };

  const openNewTmuxTerminal = () => {
    openTmuxTerminal(createTmuxSessionName(), 'new');
  };

  const interceptTerminalCommand = (command: string) => {
    const tmuxLaunch = parseTmuxLaunchCommand(command);

    if (!tmuxLaunch) {
      return false;
    }

    openTmuxTerminal(tmuxLaunch.sessionName, tmuxLaunch.command);
    return true;
  };

  const killTmuxSession = async (desktopWindow: DesktopWindowState) => {
    const sessionName = desktopWindow.terminalLaunchOptions?.tmuxSessionName;

    if (!sessionName) {
      return;
    }

    setTerminalTitlebarMenu(null);
    try {
      await window.guiSSH?.connections?.runCommand(
        connection.id,
        `tmux kill-session -t ${quotePosixShellArg(sessionName)}`,
      );
    } finally {
      removeDesktopWindow(desktopWindow.id);
      window.setTimeout(() => {
        void refreshTmuxSessions();
      }, 300);
    }
  };

  const openNotepadFile = (filePath: string) => {
    const existingWindow = getTopDesktopWindow(desktopWindows, (desktopWindow) => desktopWindow.appKey === 'notepad');

    if (existingWindow) {
      zIndexRef.current += 1;
      const nextZIndex = zIndexRef.current;
      const requestId = `notepad-open-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      setFocusedWindowId(existingWindow.id);
      setDesktopWindows((currentWindows) => currentWindows.map((desktopWindow) => (
        desktopWindow.id === existingWindow.id
          ? {
              ...desktopWindow,
              isMinimized: false,
              zIndex: nextZIndex,
              notepadOpenRequest: { id: requestId, filePath },
            }
          : desktopWindow
      )));
      return;
    }

    appendDesktopWindow('notepad', (nextWindow) => {
      nextWindow.notepadInitialPath = filePath;
    });
  };

  const openSqliteFile = (filePath: string) => {
    appendDesktopWindow('sqlite', (nextWindow) => {
      nextWindow.notepadInitialPath = filePath;
    });
  };

  const openFileManagerAtPath = (directoryPath: string) => {
    const existingWindow = getTopDesktopWindow(desktopWindows, (desktopWindow) => desktopWindow.appKey === 'files');

    if (existingWindow) {
      zIndexRef.current += 1;
      const nextZIndex = zIndexRef.current;
      setFocusedWindowId(existingWindow.id);
      setDesktopWindows((currentWindows) => currentWindows.map((desktopWindow) => (
        desktopWindow.id === existingWindow.id
          ? { ...desktopWindow, isMinimized: false, zIndex: nextZIndex, fileExplorerInitialPath: directoryPath }
          : desktopWindow
      )));
      return;
    }

    appendDesktopWindow('files', (nextWindow) => {
      nextWindow.fileExplorerInitialPath = directoryPath;
    });
  };

  const openNotepadNote = (note: { title: string; content: string }) => {
    appendDesktopWindow('notepad', (nextWindow) => {
      nextWindow.notepadInitialContent = note.content;
      nextWindow.notepadInitialTitle = note.title;
    });
  };

  const openTerminalAtPath = (directoryPath: string) => {
    openTerminalWindow({
      title: directoryPath,
      workingDirectory: directoryPath,
    });
  };

  const openProcessManager = (launchOptions?: RemoteProcessManagerLaunchOptions) => {
    const existingWindow = getTopDesktopWindow(desktopWindows, (desktopWindow) => desktopWindow.appKey === 'procmanager');

    if (existingWindow) {
      zIndexRef.current += 1;
      const nextZIndex = zIndexRef.current;

      setFocusedWindowId(existingWindow.id);
      setDesktopWindows((currentWindows) => currentWindows.map((desktopWindow) => (
        desktopWindow.id === existingWindow.id
          ? {
              ...desktopWindow,
              isMinimized: false,
              zIndex: nextZIndex,
              processManagerLaunchOptions: launchOptions ? { ...launchOptions } : desktopWindow.processManagerLaunchOptions,
            }
          : desktopWindow
      )));
      return;
    }

    appendDesktopWindow('procmanager', (nextWindow) => {
      nextWindow.processManagerLaunchOptions = launchOptions ? { ...launchOptions } : undefined;
    });
  };

  const removeDesktopWindow = useCallback((windowId: string) => {
    setDesktopWindows((currentWindows) => {
      const nextWindows = currentWindows.filter((desktopWindow) => desktopWindow.id !== windowId);
      const nextFocusedWindow = getTopDesktopWindow(nextWindows, (desktopWindow) => !desktopWindow.isMinimized);

      setFocusedWindowId(nextFocusedWindow?.id ?? '');
      return nextWindows;
    });
  }, []);

  const closeDesktopWindow = useCallback((windowId: string) => {
    const desktopWindow = desktopWindowsRef.current.find((currentWindow) => currentWindow.id === windowId);

    if (
      desktopWindow?.appKey === 'terminal' &&
      desktopWindow.terminalLaunchOptions?.mode !== 'tmux' &&
      desktopWindow.terminalHasForegroundTask
    ) {
      setPendingCloseWindowId(windowId);
      return;
    }

    removeDesktopWindow(windowId);
  }, [removeDesktopWindow]);

  const minimizeDesktopWindow = useCallback((windowId: string) => {
    windowPointerStateRef.current = null;
    setDesktopWindows((currentWindows) => {
      const nextWindows = currentWindows.map((desktopWindow) => (
        desktopWindow.id === windowId ? { ...desktopWindow, isMinimized: true } : desktopWindow
      ));
      const nextFocusedWindow = getTopDesktopWindow(nextWindows, (desktopWindow) => !desktopWindow.isMinimized);

      setFocusedWindowId(nextFocusedWindow?.id ?? '');
      return nextWindows;
    });
  }, []);

  const activateDockApp = (appKey: DesktopAppKey) => {
    const appWindows = desktopWindows.filter((desktopWindow) => desktopWindow.appKey === appKey);
    const visibleWindow = getTopDesktopWindow(appWindows, (desktopWindow) => !desktopWindow.isMinimized);
    const minimizedWindow = getTopDesktopWindow(appWindows, (desktopWindow) => desktopWindow.isMinimized);
    const windowToActivate = visibleWindow ?? minimizedWindow;

    if (windowToActivate) {
      bringWindowToFront(windowToActivate.id);
      return;
    }

    openDesktopWindow(appKey);
  };

  const toggleWindowMaximize = useCallback((windowId: string) => {
    const surface = desktopSurfaceRef.current;

    if (!surface) {
      return;
    }

    const surfaceRect = surface.getBoundingClientRect();
    zIndexRef.current += 1;
    const nextZIndex = zIndexRef.current;
    setFocusedWindowId(windowId);
    setDesktopWindows((currentWindows) => currentWindows.map((desktopWindow) => {
      if (desktopWindow.id !== windowId) {
        return desktopWindow;
      }

      if (desktopWindow.isMaximized) {
        return {
          ...desktopWindow,
          frame: clampWindowFrame(desktopWindow.previousFrame ?? defaultWindowFrames[desktopWindow.appKey], surfaceRect.width, surfaceRect.height),
          previousFrame: undefined,
          isMaximized: false,
          zIndex: nextZIndex,
        };
      }

      return {
        ...desktopWindow,
        previousFrame: desktopWindow.frame,
        frame: getMaximizedWindowFrame(surfaceRect.width, surfaceRect.height),
        isMaximized: true,
        zIndex: nextZIndex,
      };
    }));
  }, []);

  const startWindowInteraction = useCallback((event: ReactPointerEvent<HTMLElement>, windowId: string, mode: DesktopWindowInteractionMode) => {
    if (event.button !== 0) {
      return;
    }

    const surface = desktopSurfaceRef.current;
    const desktopWindow = desktopWindowsRef.current.find((currentWindow) => currentWindow.id === windowId);

    if (!surface || !desktopWindow || desktopWindow.isMaximized || desktopWindow.isMinimized) {
      return;
    }

    const surfaceRect = surface.getBoundingClientRect();
    const startFrame = clampWindowFrame(desktopWindow.frame, surfaceRect.width, surfaceRect.height);
    const windowElement = event.currentTarget.closest('.desktop-window') as HTMLElement | null;

    if (!windowElement) {
      return;
    }

    windowPointerStateRef.current = {
      pointerId: event.pointerId,
      windowId,
      mode,
      element: windowElement,
      originX: event.clientX,
      originY: event.clientY,
      startFrame,
      latestFrame: startFrame,
      surfaceWidth: surfaceRect.width,
      surfaceHeight: surfaceRect.height,
    };

    windowElement.classList.add('interacting', mode === 'move' ? 'moving' : 'resizing');
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }, []);

  const handleWindowTitlebarPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>, windowId: string) => {
    if (event.button !== 0) {
      return;
    }

    const target = event.target instanceof HTMLElement ? event.target : null;

    if (target?.closest('.win-titlebar-controls')) {
      return;
    }

    const now = window.performance.now();
    const previousClick = titlebarClickStateRef.current;
    const isDoubleClick = Boolean(
      previousClick &&
      previousClick.windowId === windowId &&
      now - previousClick.timestamp <= titlebarDoubleClickDelayMs &&
      Math.hypot(event.clientX - previousClick.x, event.clientY - previousClick.y) <= titlebarDoubleClickDistance,
    );

    if (isDoubleClick) {
      titlebarClickStateRef.current = null;
      event.preventDefault();
      toggleWindowMaximize(windowId);
      return;
    }

    titlebarClickStateRef.current = {
      windowId,
      timestamp: now,
      x: event.clientX,
      y: event.clientY,
    };

    startWindowInteraction(event, windowId, 'move');
  }, [startWindowInteraction, toggleWindowMaximize]);

  const updateWindowInteraction = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const pointerState = windowPointerStateRef.current;

    if (!pointerState || pointerState.pointerId !== event.pointerId) {
      return;
    }

    const deltaX = event.clientX - pointerState.originX;
    const deltaY = event.clientY - pointerState.originY;

    if (pointerState.mode === 'move' && Math.hypot(deltaX, deltaY) > titlebarDoubleClickDistance) {
      titlebarClickStateRef.current = null;
    }

    const nextFrame = pointerState.mode === 'move'
      ? {
          ...pointerState.startFrame,
          x: pointerState.startFrame.x + deltaX,
          y: pointerState.startFrame.y + deltaY,
        }
      : {
          ...pointerState.startFrame,
          width: pointerState.startFrame.width + deltaX,
          height: pointerState.startFrame.height + deltaY,
        };
    const clampedFrame = clampWindowFrame(nextFrame, pointerState.surfaceWidth, pointerState.surfaceHeight);

    pointerState.latestFrame = clampedFrame;
    applyWindowFrameToElement(pointerState.element, clampedFrame);
    event.preventDefault();
  }, []);

  const finishWindowInteraction = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const pointerState = windowPointerStateRef.current;

    if (!pointerState || pointerState.pointerId !== event.pointerId) {
      return;
    }

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    const finalFrame = pointerState.latestFrame;
    pointerState.element.classList.remove('interacting', 'moving', 'resizing');
    windowPointerStateRef.current = null;

    setDesktopWindows((currentWindows) => {
      let didChangeFrame = false;
      const nextWindows = currentWindows.map((desktopWindow) => {
        if (desktopWindow.id !== pointerState.windowId || areWindowFramesEqual(desktopWindow.frame, finalFrame)) {
          return desktopWindow;
        }

        didChangeFrame = true;
        return { ...desktopWindow, frame: finalFrame };
      });

      return didChangeFrame ? nextWindows : currentWindows;
    });
  }, []);

  const handleWindowResizePointerDown = useCallback((event: ReactPointerEvent<HTMLElement>, windowId: string) => {
    startWindowInteraction(event, windowId, 'resize');
  }, [startWindowInteraction]);

  const openTerminalTitlebarMenu = useCallback((windowId: string, buttonRect: DOMRect) => {
    if (terminalTitlebarMenu?.windowId === windowId) {
      setTerminalTitlebarMenu(null);
      return;
    }

    const menuWidth = 210;
    const menuEdgePadding = 8;
    setTerminalTitlebarMenu({
      windowId,
      x: Math.max(menuEdgePadding, Math.min(buttonRect.right - menuWidth, window.innerWidth - menuWidth - menuEdgePadding)),
      y: buttonRect.bottom + 5,
    });

    const desktopWindow = desktopWindowsRef.current.find((currentWindow) => currentWindow.id === windowId);
    if (desktopWindow?.terminalLaunchOptions?.mode !== 'tmux') {
      void refreshTmuxSessions();
    }
  }, [refreshTmuxSessions, terminalTitlebarMenu]);

  const updateWindowChrome = (
    windowId: string,
    payload: RemoteTerminalChromePayload,
  ) => {
    setDesktopWindows((currentWindows) => {
      const windowIndex = currentWindows.findIndex((desktopWindow) => desktopWindow.id === windowId);
      const desktopWindow = currentWindows[windowIndex];

      if (
        !desktopWindow ||
        (
          desktopWindow.chromeTitle === payload.title &&
          desktopWindow.chromeStatus === payload.status &&
          desktopWindow.chromeTone === payload.tone
        )
      ) {
        return currentWindows;
      }

      return currentWindows.map((currentWindow) => (
        currentWindow.id === windowId
          ? {
              ...currentWindow,
              chromeTitle: payload.title,
              chromeStatus: payload.status,
              chromeTone: payload.tone,
            }
          : currentWindow
      ));
    });
  };

  const updateTerminalSessionState = (windowId: string, payload: RemoteTerminalSessionState) => {
    setDesktopWindows((currentWindows) => {
      let didChangeTerminalState = false;
      const nextWindows = currentWindows.map((desktopWindow) => {
        if (
          desktopWindow.id !== windowId ||
          (
            desktopWindow.terminalStatus === payload.status &&
            desktopWindow.terminalHasForegroundTask === payload.hasForegroundTask
          )
        ) {
          return desktopWindow;
        }

        didChangeTerminalState = true;
        return {
          ...desktopWindow,
          terminalStatus: payload.status,
          terminalHasForegroundTask: payload.hasForegroundTask,
        };
      });

      return didChangeTerminalState ? nextWindows : currentWindows;
    });
  };

  const requestTerminalTool = (windowId: string, action: RemoteTerminalToolAction) => {
    terminalToolRequestSequenceRef.current += 1;
    const terminalToolRequest: RemoteTerminalToolRequest = {
      id: `terminal-tool-${terminalToolRequestSequenceRef.current}`,
      action,
    };

    setDesktopWindows((currentWindows) => currentWindows.map((desktopWindow) => (
      desktopWindow.id === windowId
        ? { ...desktopWindow, terminalToolRequest }
        : desktopWindow
    )));
    setTerminalTitlebarMenu(null);
  };

  const requestTerminalCommand = (windowId: string, command: string, source: RemoteTerminalCommandRequest['source'] = 'external') => {
    terminalCommandRequestSequenceRef.current += 1;
    const terminalCommandRequest: RemoteTerminalCommandRequest = {
      id: `terminal-command-${terminalCommandRequestSequenceRef.current}`,
      command,
      mode: 'insert',
      source,
    };

    setDesktopWindows((currentWindows) => currentWindows.map((desktopWindow) => (
      desktopWindow.id === windowId
        ? { ...desktopWindow, terminalCommandRequest }
        : desktopWindow
    )));
    setTerminalTitlebarMenu(null);
  };

  const completeTerminalToolRequest = (windowId: string, requestId: string) => {
    setDesktopWindows((currentWindows) => currentWindows.map((desktopWindow) => (
      desktopWindow.id === windowId && desktopWindow.terminalToolRequest?.id === requestId
        ? { ...desktopWindow, terminalToolRequest: undefined }
        : desktopWindow
    )));
  };

  const completeTerminalCommandRequest = (windowId: string, requestId: string) => {
    setDesktopWindows((currentWindows) => currentWindows.map((desktopWindow) => (
      desktopWindow.id === windowId && desktopWindow.terminalCommandRequest?.id === requestId
        ? { ...desktopWindow, terminalCommandRequest: undefined }
        : desktopWindow
    )));
  };

  const handleTerminalSessionEvent = (event: RemoteTerminalSessionEvent) => {
    onTerminalSessionEvent?.(event);
  };

  const renderWindowContent = (desktopWindow: DesktopWindowState) => {
    if (desktopWindow.appKey === 'terminal') {
      return (
        <RemoteTerminal
          connectionId={connection.id}
          terminalId={desktopWindow.terminalId ?? desktopWindow.id}
          settings={settings}
          connectionKind={connection.kind}
          systemType={connection.host.systemType}
          launchOptions={desktopWindow.terminalLaunchOptions}
          commandRequest={desktopWindow.terminalCommandRequest}
          toolRequest={desktopWindow.terminalToolRequest}
          onChromeChange={(payload) => updateWindowChrome(desktopWindow.id, payload)}
          onCommandRequestHandled={(requestId) => completeTerminalCommandRequest(desktopWindow.id, requestId)}
          onToolRequestHandled={(requestId) => completeTerminalToolRequest(desktopWindow.id, requestId)}
          onOpenTerminal={openTerminalWindow}
          onOpenNote={openNotepadNote}
          onCommandIntercept={interceptTerminalCommand}
          onSessionEvent={handleTerminalSessionEvent}
          onSessionStateChange={(payload) => updateTerminalSessionState(desktopWindow.id, payload)}
          onSettingsChange={onSettingsChange}
        />
      );
    }

    if (desktopWindow.appKey === 'browser') {
      return (
        <RemoteBrowser
          connectionId={connection.id}
          partition={connection.partition}
          bookmarkScope={`${connection.host.username}@${connection.host.address}:${connection.host.port}`}
          context={{
            name: connection.host.name,
            address: connection.host.address,
            port: connection.host.port,
            username: connection.host.username,
            proxyPort: connection.proxyPort,
          }}
          onChromeChange={(payload) => updateWindowChrome(desktopWindow.id, payload)}
        />
      );
    }

    if (desktopWindow.appKey === 'files') {
      return <RemoteFileExplorer connectionId={connection.id} systemType={connection.host.systemType} initialPath={desktopWindow.fileExplorerInitialPath} onOpenFile={openNotepadFile} onOpenSqliteFile={openSqliteFile} onOpenTerminal={openTerminalAtPath} />;
    }

    if (desktopWindow.appKey === 'notepad') {
      return <RemoteNotepad connectionId={connection.id} settings={settings} initialFilePath={desktopWindow.notepadInitialPath} initialContent={desktopWindow.notepadInitialContent} initialTitle={desktopWindow.notepadInitialTitle} openFileRequest={desktopWindow.notepadOpenRequest} systemType={connection.host.systemType} />;
    }

    if (desktopWindow.appKey === 'mysql') {
      return <RemoteMySQL connectionId={connection.id} hostId={remoteConnectionProfileHostId} />;
    }

    if (desktopWindow.appKey === 'clickhouse') {
      return <RemoteClickHouse connectionId={connection.id} hostId={remoteConnectionProfileHostId} />;
    }

    if (desktopWindow.appKey === 'redis') {
      return <RemoteRedis connectionId={connection.id} hostId={remoteConnectionProfileHostId} />;
    }

    if (desktopWindow.appKey === 'vnc') {
      return <RemoteVncViewer connectionId={connection.id} hostId={remoteConnectionProfileHostId} />;
    }

    if (desktopWindow.appKey === 'log-viewer') {
      return <RemoteLogViewer connectionId={connection.id} systemType={connection.host.systemType} />;
    }

    if (desktopWindow.appKey === 'settings') {
      return <RemoteSettings connectionId={connection.id} systemType={connection.host.systemType} />;
    }

    if (desktopWindow.appKey === 'procmanager') {
      return <RemoteProcessManager connectionId={connection.id} settings={settings} systemType={connection.host.systemType} launchOptions={desktopWindow.processManagerLaunchOptions} />;
    }

    if (desktopWindow.appKey === 'service-manager') {
      return <RemoteServiceManager connectionId={connection.id} systemType={connection.host.systemType} />;
    }

    if (desktopWindow.appKey === 'container-manager') {
      return <RemoteContainerManager connectionId={connection.id} systemType={connection.host.systemType} />;
    }

    if (desktopWindow.appKey === 'port-manager') {
      return <RemotePortManager connectionId={connection.id} systemType={connection.host.systemType} onOpenProcessManager={openProcessManager} />;
    }

    if (desktopWindow.appKey === 'firewall-manager') {
      return <RemoteFirewallManager connectionId={connection.id} sshPort={connection.host.port} systemType={connection.host.systemType} />;
    }

    if (desktopWindow.appKey === 'iptables-manager') {
      return <RemoteIptablesManager connectionId={connection.id} systemType={connection.host.systemType} />;
    }

    if (desktopWindow.appKey === 'network-diagnostics') {
      return <RemoteNetworkDiagnostics connectionId={connection.id} systemType={connection.host.systemType} />;
    }

    if (desktopWindow.appKey === 'disk-analyzer') {
      return <RemoteDiskAnalyzer connectionId={connection.id} systemType={connection.host.systemType} onOpenFileManager={openFileManagerAtPath} />;
    }

    if (desktopWindow.appKey === 'disk-manager') {
      return <RemoteDiskManager connectionId={connection.id} systemType={connection.host.systemType} onOpenFileManager={openFileManagerAtPath} />;
    }

    if (desktopWindow.appKey === 'package-manager') {
      return <RemotePackageManager connectionId={connection.id} systemType={connection.host.systemType} onOpenTerminal={openTerminalWindow} />;
    }

    if (desktopWindow.appKey === 'git-manager') {
      return <RemoteGitManager connectionId={connection.id} systemType={connection.host.systemType} />;
    }

    if (desktopWindow.appKey === 'web-server-manager') {
      return <RemoteWebServerManager connectionId={connection.id} systemType={connection.host.systemType} onOpenConfigFile={openNotepadFile} />;
    }

    if (desktopWindow.appKey === 'scheduled-tasks') {
      return <RemoteScheduledTasks connectionId={connection.id} systemType={connection.host.systemType} />;
    }

    if (desktopWindow.appKey === 'postgres') {
      return <RemotePostgres connectionId={connection.id} hostId={remoteConnectionProfileHostId} />;
    }

    if (desktopWindow.appKey === 'mongo') {
      return <RemoteMongo connectionId={connection.id} hostId={remoteConnectionProfileHostId} />;
    }

    if (desktopWindow.appKey === 'search-cluster') {
      return <RemoteSearchCluster connectionId={connection.id} hostId={remoteConnectionProfileHostId} systemType={connection.host.systemType} />;
    }

    if (desktopWindow.appKey === 'message-queue') {
      return <RemoteMessageQueuePanel connectionId={connection.id} hostId={remoteConnectionProfileHostId} systemType={connection.host.systemType} />;
    }

    if (desktopWindow.appKey === 's3-browser') {
      return <RemoteS3Browser connectionId={connection.id} hostId={remoteConnectionProfileHostId} systemType={connection.host.systemType} />;
    }

    if (desktopWindow.appKey === 'security-audit') {
      return <RemoteSecurityAudit connectionId={connection.id} settings={settings} systemType={connection.host.systemType} hostLabel={connection.host.name} />;
    }

    if (desktopWindow.appKey === 'login-sessions') {
      return <RemoteLoginSessions connectionId={connection.id} systemType={connection.host.systemType} onOpenSecurityAudit={() => openDesktopWindow('security-audit')} />;
    }

    if (desktopWindow.appKey === 'api-debugger') {
      return <RemoteApiDebugger connectionId={connection.id} systemType={connection.host.systemType} />;
    }

    if (desktopWindow.appKey === 'sqlite') {
      return <RemoteSqlite connectionId={connection.id} initialFilePath={desktopWindow.notepadInitialPath} systemType={connection.host.systemType} />;
    }

    return <RemoteMonitor connectionId={connection.id} systemType={connection.host.systemType} onOpenProcessManager={openProcessManager} />;
  };

  return (
    <>
      <main className="remote-desktop-page">
        <section
          ref={desktopSurfaceRef}
          className={`remote-desktop-surface no-drag ${hasCustomWallpaper ? 'has-custom-wallpaper' : 'has-default-wallpaper'}`}
          style={desktopWallpaperStyle}
          onContextMenu={handleSurfaceContextMenu}
          onDragOver={handleDragOver}
          onDrop={(event) => handleDesktopDrop(event)}
        >
          <div className="desktop-icons" aria-label={t('desktop.icons.aria', settings.language)}>
            {visibleDesktopItems.map((item) => {
              if (item.type === 'folder') {
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={`desktop-icon-button desktop-folder-button ${openFolderId === item.id ? 'active' : ''}`}
                    draggable
                    onDragStart={(event) => handleDragStart(event, { source: 'desktop', itemId: item.id, itemType: 'folder' })}
                    onDragEnd={handleDragEnd}
                    onDragOver={handleDragOver}
                    onDrop={(event) => handleDesktopDrop(event, item)}
                    onClick={() => openDesktopFolder(item.id)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      closeDesktopMenus();
                      setFolderContextMenu({ x: event.clientX, y: event.clientY, folderId: item.id });
                    }}
                  >
                    <span className="desktop-folder-icon-shell">
                      <span className="desktop-folder-icon-grid">
                        {item.appKeys.slice(0, 4).map((appKey) => (
                          <span key={appKey} className={`desktop-folder-mini-icon desktop-app-icon-${appKey}`}>
                            <DesktopAppIcon appKey={appKey} />
                          </span>
                        ))}
                      </span>
                    </span>
                    <strong>{item.name}</strong>
                  </button>
                );
              }

              const app = getAppInfo(item.appKey);
              const appLabel = getAppLabel(app, settings.language);

              return (
                <button
                  key={item.id}
                  type="button"
                  className={`desktop-icon-button ${focusedWindow?.appKey === item.appKey ? 'active' : ''}`}
                  draggable
                  onDragStart={(event) => handleDragStart(event, { source: 'desktop', itemId: item.id, itemType: 'app', appKey: item.appKey })}
                  onDragEnd={handleDragEnd}
                  onDragOver={handleDragOver}
                  onDrop={(event) => handleDesktopDrop(event, item)}
                  onDoubleClick={() => openDesktopWindow(item.appKey)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    closeDesktopMenus();
                    setAppContextMenu({ x: event.clientX, y: event.clientY, appKey: item.appKey, source: 'desktop' });
                  }}
                >
                  <span className={`desktop-app-icon-shell desktop-app-icon-${item.appKey}`}>
                    <DesktopAppIcon appKey={item.appKey} />
                  </span>
                  <strong>{appLabel}</strong>
                </button>
              );
            })}
          </div>

        {desktopWindows.map((desktopWindow) => {
          const appInfo = getAppInfo(desktopWindow.appKey);
          const livePointerFrame = windowPointerStateRef.current?.windowId === desktopWindow.id
            ? windowPointerStateRef.current.latestFrame
            : null;

          return (
            <DesktopWindow
              key={desktopWindow.id}
              appLabel={getAppLabel(appInfo, settings.language)}
              desktopWindow={desktopWindow}
              isFocused={desktopWindow.id === focusedWindowId}
              isTerminalTitlebarMenuOpen={terminalTitlebarMenu?.windowId === desktopWindow.id}
              language={settings.language}
              livePointerFrame={livePointerFrame}
              renderSettings={settings}
              onBringToFront={bringWindowToFront}
              onClose={closeDesktopWindow}
              onFinishInteraction={finishWindowInteraction}
              onMinimize={minimizeDesktopWindow}
              onOpenTerminalTitlebarMenu={openTerminalTitlebarMenu}
              onResizePointerDown={handleWindowResizePointerDown}
              onTitlebarPointerDown={handleWindowTitlebarPointerDown}
              onToggleMaximize={toggleWindowMaximize}
              onUpdateInteraction={updateWindowInteraction}
              renderContent={renderWindowContent}
            />
          );
        })}

        <nav className="mac-dock" aria-label={t('desktop.dock.aria', settings.language)}>
          <button
            type="button"
            className={`dock-launchpad-button ${isLaunchpadOpen ? 'active' : ''}`}
            onClick={toggleLaunchpad}
            aria-label={t('desktop.launchpad.allApps', settings.language)}
            title={t('desktop.launchpad.allApps', settings.language)}
          >
            <span className="dock-app-icon dock-all-apps">
              <AllAppsIcon />
            </span>
          </button>
          <span className="dock-separator" aria-hidden="true" />
          {(() => {
            const openAppKeys = new Set(desktopWindows.map((w) => w.appKey));
            const dockApps = [
              ...desktopApps.filter((app) => dockPinnedApps.includes(app.key as DesktopAppKey)),
              ...desktopApps.filter((app) => !dockPinnedApps.includes(app.key as DesktopAppKey) && openAppKeys.has(app.key)),
            ];

            return dockApps.map((app) => {
              const appLabel = getAppLabel(app, settings.language);
              const appWindows = desktopWindows.filter((desktopWindow) => desktopWindow.appKey === app.key);
              const hasOpenWindows = appWindows.length > 0;
              const hasVisibleWindows = appWindows.some((desktopWindow) => !desktopWindow.isMinimized);
              const isMinimizedOnly = hasOpenWindows && !hasVisibleWindows;
              const dockButtonClassName = [
                focusedWindow?.appKey === app.key ? 'active' : '',
                hasOpenWindows ? 'open' : '',
                isMinimizedOnly ? 'minimized' : '',
              ].filter(Boolean).join(' ');
              const dockButtonLabel = isMinimizedOnly
                ? t('desktop.dock.restoreApp', settings.language, { app: appLabel })
                : hasOpenWindows
                  ? t('desktop.dock.switchToApp', settings.language, { app: appLabel })
                  : t('desktop.dock.openApp', settings.language, { app: appLabel });

              return (
                <button
                  key={app.key}
                  type="button"
                  className={dockButtonClassName}
                  onClick={() => activateDockApp(app.key)}
                  aria-label={dockButtonLabel}
                  title={dockButtonLabel}
                >
                  <span className={`dock-app-icon desktop-app-icon-${app.key}`}>
                    <DesktopAppIcon appKey={app.key} />
                  </span>
                </button>
              );
            });
          })()}
        </nav>
      </section>
    </main>

    {isLaunchpadRendered ? createPortal(
      <div className={`launchpad-overlay ${isLaunchpadOpen ? 'open' : 'closing'}`} role="presentation" onClick={closeLaunchpad}>
        <section className="launchpad-panel" aria-label={t('desktop.launchpad.allApps', settings.language)} onClick={(event) => event.stopPropagation()}>
          <header className="launchpad-header">
            <div>
              <span>{t('desktop.launchpad.allApps', settings.language)}</span>
              <strong>{t('desktop.launchpad.componentCount', settings.language, { count: launchpadApps.length })}</strong>
            </div>
            <button type="button" className="launchpad-close" aria-label={t('desktop.launchpad.close', settings.language)} onClick={closeLaunchpad}>
              <svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                <line x1="2" y1="2" x2="10" y2="10" />
                <line x1="10" y1="2" x2="2" y2="10" />
              </svg>
            </button>
          </header>
          <div className="launchpad-grid">
            {launchpadApps.map((app) => {
              const appLabel = getAppLabel(app, settings.language);
              const appDescription = getAppDescription(app, settings.language);

              return (
                <button
                  key={app.key}
                  type="button"
                  className="launchpad-app-button"
                  draggable
                  onDragStart={(event) => handleDragStart(event, { source: 'launchpad', appKey: app.key })}
                  onDragEnd={handleDragEnd}
                  onMouseEnter={(event) => showLaunchpadTooltip(event.currentTarget, appDescription)}
                  onMouseLeave={() => setLaunchpadTooltip(null)}
                  onFocus={(event) => showLaunchpadTooltip(event.currentTarget, appDescription)}
                  onBlur={() => setLaunchpadTooltip(null)}
                  onClick={() => {
                    closeLaunchpad();
                    openDesktopWindow(app.key);
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    closeDesktopMenus();
                    setAppContextMenu({ x: event.clientX, y: event.clientY, appKey: app.key, source: 'launchpad' });
                  }}
                >
                  <span className={`desktop-app-icon-shell desktop-app-icon-${app.key}`}>
                    <DesktopAppIcon appKey={app.key} />
                  </span>
                  <strong>{appLabel}</strong>
                </button>
              );
            })}
          </div>
        </section>
      </div>,
      document.body,
    ) : null}

    {launchpadTooltip ? createPortal(
      <div
        className={`launchpad-tooltip ${launchpadTooltip.placement}`}
        style={{ left: launchpadTooltip.x, top: launchpadTooltip.y }}
        role="tooltip"
      >
        {launchpadTooltip.description}
      </div>,
      document.body,
    ) : null}

    {openFolder ? createPortal(
      <div className={`desktop-folder-overlay ${isFolderOpen ? 'open' : 'closing'}`} role="presentation" onClick={closeDesktopFolder}>
        <section
          className="desktop-folder-panel"
          aria-label={openFolder.name}
          onClick={(event) => event.stopPropagation()}
          onDragOver={handleDragOver}
          onDrop={(event) => handleFolderDrop(event, openFolder.id)}
        >
          <header className="desktop-folder-header">
            <button
              type="button"
              className="desktop-folder-title"
              onClick={() => setRenameFolderDialog({ folderId: openFolder.id, name: openFolder.name })}
              title={t('desktop.folder.rename', settings.language)}
            >
              {openFolder.name}
            </button>
            <button type="button" className="launchpad-close" aria-label={t('desktop.folder.close', settings.language)} onClick={closeDesktopFolder}>
              <svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                <line x1="2" y1="2" x2="10" y2="10" />
                <line x1="10" y1="2" x2="2" y2="10" />
              </svg>
            </button>
          </header>
          <div className={`desktop-folder-grid ${openFolder.appKeys.length ? '' : 'empty'}`}>
            {openFolder.appKeys.length ? openFolder.appKeys.map((appKey) => {
              const app = getAppInfo(appKey);
              const appLabel = getAppLabel(app, settings.language);

              return (
                <button
                  key={appKey}
                  type="button"
                  className="desktop-icon-button desktop-folder-app-button"
                  title={t('desktop.folder.openHint', settings.language)}
                  draggable
                  onDragStart={(event) => handleDragStart(event, { source: 'folder', folderId: openFolder.id, appKey })}
                  onDragEnd={handleDragEnd}
                  onDragOver={handleDragOver}
                  onDrop={(event) => handleFolderDrop(event, openFolder.id, appKey)}
                  onDoubleClick={() => {
                    openDesktopWindow(appKey);
                    closeDesktopFolder();
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    closeDesktopMenus();
                    setAppContextMenu({ x: event.clientX, y: event.clientY, appKey, source: 'folder', folderId: openFolder.id });
                  }}
                >
                  <span className={`desktop-app-icon-shell desktop-app-icon-${appKey}`}>
                    <DesktopAppIcon appKey={appKey} />
                  </span>
                  <strong>{appLabel}</strong>
                </button>
              );
            }) : (
              <div className="desktop-folder-empty">{t('desktop.folder.empty', settings.language)}</div>
            )}
          </div>
        </section>
      </div>,
      document.body,
    ) : null}

    {appContextMenu ? createPortal(
      <>
        <div
          className="context-menu-overlay"
          onClick={() => setAppContextMenu(null)}
          onContextMenu={(event) => { event.preventDefault(); setAppContextMenu(null); }}
        />
        <div
          className="context-menu"
          style={{ left: appContextMenu.x, top: appContextMenu.y }}
          role="menu"
        >
          <button
            type="button"
            role="menuitem"
            className="context-menu-icon-button"
            onClick={() => {
              const { appKey, source } = appContextMenu;
              setAppContextMenu(null);
              if (source === 'launchpad') {
                closeLaunchpad();
              }
              if (source === 'folder') {
                closeDesktopFolder();
              }
              openDesktopWindow(appKey);
            }}
          >
            <ContextMenuIcon name="open" />
            {t('desktop.menu.open', settings.language)}
          </button>
          {appContextMenu.source === 'launchpad' ? (
            <button
              type="button"
              role="menuitem"
              className="context-menu-icon-button"
              disabled={hasDesktopApp(desktopLayout, appContextMenu.appKey)}
              onClick={() => {
                const { appKey } = appContextMenu;
                setAppContextMenu(null);
                sendAppToDesktop(appKey);
              }}
            >
              <ContextMenuIcon name="desktop" />
              {t('desktop.menu.sendToDesktop', settings.language)}
            </button>
          ) : appContextMenu.source === 'folder' ? (
            <>
              <button
                type="button"
                role="menuitem"
                className="context-menu-icon-button"
                onClick={() => {
                  const { appKey } = appContextMenu;
                  setAppContextMenu(null);
                  moveFolderAppToDesktop(appKey);
                }}
              >
                <ContextMenuIcon name="move-desktop" />
                {t('desktop.menu.moveToDesktop', settings.language)}
              </button>
              <button
                type="button"
                role="menuitem"
                className="context-menu-icon-button danger-text"
                onClick={() => {
                  const { appKey } = appContextMenu;
                  setAppContextMenu(null);
                  deleteAppFromDesktop(appKey);
                }}
              >
                <ContextMenuIcon name="trash" />
                {t('desktop.menu.delete', settings.language)}
              </button>
            </>
          ) : (
            <button
              type="button"
              role="menuitem"
              className="context-menu-icon-button danger-text"
              onClick={() => {
                const { appKey } = appContextMenu;
                setAppContextMenu(null);
                deleteAppFromDesktop(appKey);
              }}
            >
              <ContextMenuIcon name="trash" />
              {t('desktop.menu.delete', settings.language)}
            </button>
          )}
        </div>
      </>,
      document.body,
    ) : null}

    {folderContextMenu ? createPortal(
      <>
        <div
          className="context-menu-overlay"
          onClick={() => setFolderContextMenu(null)}
          onContextMenu={(event) => { event.preventDefault(); setFolderContextMenu(null); }}
        />
        <div
          className="context-menu"
          style={{ left: folderContextMenu.x, top: folderContextMenu.y }}
          role="menu"
        >
          <button
            type="button"
            role="menuitem"
            className="context-menu-icon-button"
            onClick={() => {
              openDesktopFolder(folderContextMenu.folderId);
              setFolderContextMenu(null);
            }}
          >
            <ContextMenuIcon name="open" />
            {t('desktop.menu.open', settings.language)}
          </button>
          <button
            type="button"
            role="menuitem"
            className="context-menu-icon-button"
            onClick={() => {
              const folder = desktopLayout.items.find((item): item is DesktopFolderLayoutItem => item.type === 'folder' && item.id === folderContextMenu.folderId);
              setRenameFolderDialog({ folderId: folderContextMenu.folderId, name: folder?.name ?? t('desktop.folder.defaultName', settings.language) });
              setFolderContextMenu(null);
            }}
          >
            <ContextMenuIcon name="rename" />
            {t('desktop.menu.rename', settings.language)}
          </button>
          <button
            type="button"
            role="menuitem"
            className="context-menu-icon-button danger-text"
            onClick={() => {
              const { folderId } = folderContextMenu;
              setFolderContextMenu(null);
              deleteFolder(folderId);
            }}
          >
            <ContextMenuIcon name="trash" />
            {t('desktop.menu.deleteFolder', settings.language)}
          </button>
        </div>
      </>,
      document.body,
    ) : null}

    {surfaceContextMenu ? createPortal(
      <>
        <div
          className="context-menu-overlay"
          onClick={() => setSurfaceContextMenu(null)}
          onContextMenu={(event) => { event.preventDefault(); setSurfaceContextMenu(null); }}
        />
        <div
          className="context-menu"
          style={{ left: surfaceContextMenu.x, top: surfaceContextMenu.y }}
          role="menu"
        >
          <button
            type="button"
            role="menuitem"
            className="context-menu-icon-button"
            onClick={() => {
              setSurfaceContextMenu(null);
              createFolder();
            }}
          >
            <ContextMenuIcon name="new-folder" />
            {t('desktop.menu.newFolder', settings.language)}
          </button>
          <div className="context-menu-item-has-submenu">
            <button type="button" role="menuitem" className="context-menu-icon-button" aria-haspopup="menu">
              <ContextMenuIcon name="sort" />
              {t('desktop.menu.sort', settings.language)}
            </button>
            <div className="context-submenu" role="menu" aria-label={t('desktop.menu.sortMode', settings.language)}>
              {desktopSortOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={desktopLayout.sortMode === option.value}
                  className={desktopLayout.sortMode === option.value ? 'checked' : ''}
                  onClick={() => {
                    setSurfaceContextMenu(null);
                    handleSortModeChange(option.value);
                  }}
                >
                  {t(option.labelId, settings.language)}
                </button>
              ))}
            </div>
          </div>
        </div>
      </>,
      document.body,
    ) : null}

    {renameFolderDialog ? createPortal(
      <div className="notepad-modal-overlay" role="presentation" onClick={() => setRenameFolderDialog(null)}>
        <form
          className="notepad-modal desktop-folder-rename-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="desktop-folder-rename-title"
          onClick={(event) => event.stopPropagation()}
          onSubmit={submitFolderRename}
        >
          <div id="desktop-folder-rename-title" className="notepad-modal-title">{t('desktop.folder.rename', settings.language)}</div>
          <input
            className="notepad-modal-input"
            value={renameFolderDialog.name}
            maxLength={40}
            autoFocus
            onChange={(event) => setRenameFolderDialog({ ...renameFolderDialog, name: event.target.value })}
          />
          <div className="notepad-modal-actions">
            <button type="button" className="notepad-modal-btn" onClick={() => setRenameFolderDialog(null)}>{t('common.cancel', settings.language)}</button>
            <button type="submit" className="notepad-modal-btn primary">{t('common.save', settings.language)}</button>
          </div>
        </form>
      </div>,
      document.body,
    ) : null}

    {terminalTitlebarMenu && terminalTitlebarMenuWindow ? createPortal(
      <>
        <div
          className="context-menu-overlay"
          onClick={() => setTerminalTitlebarMenu(null)}
          onContextMenu={(event) => {
            event.preventDefault();
            setTerminalTitlebarMenu(null);
          }}
        />
        <div
          className="context-menu terminal-titlebar-menu"
          style={{ left: terminalTitlebarMenu.x, top: terminalTitlebarMenu.y }}
          role="menu"
          aria-label={t('terminal.titlebar.tools', settings.language)}
        >
          {terminalTitlebarMenuWindow.terminalLaunchOptions?.mode === 'tmux' ? (
            <button
              type="button"
              role="menuitem"
              className="danger-text"
              onClick={() => void killTmuxSession(terminalTitlebarMenuWindow)}
            >
              {t('terminal.tmux.killCurrent', settings.language)}
            </button>
          ) : (
            <>
              <button type="button" role="menuitem" onClick={() => requestTerminalTool(terminalTitlebarMenuWindow.id, 'new-terminal')}>
                {t('terminal.titlebar.newWindow', settings.language)}
              </button>
              <button type="button" role="menuitem" onClick={() => requestTerminalTool(terminalTitlebarMenuWindow.id, 'search')}>
                {t('terminal.titlebar.searchOutput', settings.language)}
              </button>
              <button type="button" role="menuitem" onClick={() => requestTerminalTool(terminalTitlebarMenuWindow.id, 'clear')}>
                {t('terminal.titlebar.clear', settings.language)}
              </button>
              {connection.host.systemType !== 'windows' ? (
            <div className="context-menu-item-has-submenu terminal-titlebar-tmux-menu">
              <button type="button" role="menuitem" aria-haspopup="menu">
                {t('terminal.tmux.menu', settings.language)}
              </button>
              <div className="context-submenu terminal-titlebar-tmux-submenu" role="menu" aria-label={t('terminal.tmux.menu', settings.language)}>
                <button type="button" role="menuitem" onClick={openNewTmuxTerminal}>
                  {t('terminal.tmux.newSession', settings.language)}
                </button>
                <button type="button" role="menuitem" onClick={(event) => {
                  event.stopPropagation();
                  void refreshTmuxSessions();
                }}>
                  {t('terminal.tmux.refresh', settings.language)}
                </button>
                <div className="context-menu-sep" />
                {tmuxMenuState.status === 'loading' ? (
                  <button type="button" role="menuitem" disabled>
                    {t('terminal.tmux.loading', settings.language)}
                  </button>
                ) : null}
                {tmuxMenuState.status === 'error' ? (
                  <button type="button" role="menuitem" className="terminal-titlebar-tmux-message" disabled title={tmuxMenuState.error}>
                    {tmuxMenuState.error || t('terminal.tmux.notInstalled', settings.language)}
                  </button>
                ) : null}
                {tmuxMenuState.status === 'ready' && tmuxMenuState.sessions.length === 0 ? (
                  <button type="button" role="menuitem" disabled>
                    {t('terminal.tmux.empty', settings.language)}
                  </button>
                ) : null}
                {tmuxMenuState.sessions.map((session) => (
                  <button
                    key={session.name}
                    type="button"
                    role="menuitem"
                    className="terminal-titlebar-tmux-session-button"
                    title={t('terminal.tmux.attachSession', settings.language, { name: session.name })}
                    onClick={() => openTmuxTerminal(session.name, 'attach')}
                  >
                    <span className="terminal-titlebar-tmux-session-text">
                      <strong>{session.name}</strong>
                      <small>
                        {t('terminal.tmux.sessionMeta', settings.language, {
                          windows: String(session.windows),
                          attached: String(session.attached),
                        })}
                      </small>
                    </span>
                  </button>
                ))}
              </div>
            </div>
              ) : null}
              {(settings.terminalSnippets ?? []).length ? (
                <div className="context-menu-item-has-submenu terminal-titlebar-snippets-menu">
                  <button type="button" role="menuitem" aria-haspopup="menu">
                    {t('terminal.titlebar.snippets', settings.language)}
                  </button>
                  <div className="context-submenu terminal-titlebar-snippets-submenu" role="menu" aria-label={t('terminal.titlebar.snippets', settings.language)}>
                    {getTerminalSnippetGroups(settings.terminalSnippets ?? [], settings.language).map((group) => (
                      <div key={group.label} className="terminal-titlebar-snippet-group" role="presentation">
                        <div className="terminal-titlebar-snippet-group-label">{group.label}</div>
                        {group.snippets.map((snippet) => (
                          <button
                            key={snippet.id}
                            type="button"
                            role="menuitem"
                            className="terminal-titlebar-snippet-button"
                            title={snippet.command}
                            onClick={() => requestTerminalCommand(terminalTitlebarMenuWindow.id, snippet.command, 'snippet')}
                          >
                            <span className="terminal-titlebar-snippet-text">
                              <strong>{snippet.label}</strong>
                              <small>{getTerminalSnippetPreview(snippet)}</small>
                            </span>
                            {snippet.shortcut ? <kbd>{snippet.shortcut}</kbd> : null}
                          </button>
                        ))}
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <button type="button" role="menuitem" disabled>
                  {t('terminal.titlebar.noSnippets', settings.language)}
                </button>
              )}
              <div className="context-menu-sep" />
              <button type="button" role="menuitem" onClick={() => requestTerminalTool(terminalTitlebarMenuWindow.id, 'toggle-follow')}>
                {t('terminal.titlebar.toggleFollow', settings.language)}
              </button>
              <button type="button" role="menuitem" onClick={() => requestTerminalTool(terminalTitlebarMenuWindow.id, 'scroll-bottom')}>
                {t('terminal.titlebar.scrollBottom', settings.language)}
              </button>
              {terminalTitlebarMenuWindow.terminalStatus === 'exited' ? (
                <button type="button" role="menuitem" onClick={() => requestTerminalTool(terminalTitlebarMenuWindow.id, 'restart')}>
                  {t('terminal.titlebar.restartSession', settings.language)}
                </button>
              ) : null}
              {onSettingsChange ? (
                <>
                  <div className="context-menu-sep" />
                  <button type="button" role="menuitem" onClick={() => requestTerminalTool(terminalTitlebarMenuWindow.id, 'settings')}>
                    {t('terminal.titlebar.settings', settings.language)}
                  </button>
                </>
              ) : null}
            </>
          )}
        </div>
      </>,
      document.body,
    ) : null}

    {pendingCloseWindow ? createPortal(
      <div className="notepad-modal-overlay" role="presentation" onClick={() => setPendingCloseWindowId('')}>
        <div
          className="notepad-modal"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="terminal-close-confirm-title"
          onClick={(event) => event.stopPropagation()}
        >
          <div id="terminal-close-confirm-title" className="notepad-modal-title">{t('terminal.closeConfirm.title', settings.language)}</div>
          <div className="notepad-modal-message">
            {t('terminal.closeConfirm.message', settings.language)}
          </div>
          <div className="notepad-modal-actions">
            <button type="button" className="notepad-modal-btn" onClick={() => setPendingCloseWindowId('')}>{t('common.cancel', settings.language)}</button>
            <button type="button" className="notepad-modal-btn danger" onClick={() => {
              const windowId = pendingCloseWindow.id;
              setPendingCloseWindowId('');
              removeDesktopWindow(windowId);
            }}>
              {t('common.close', settings.language)}
            </button>
          </div>
        </div>
      </div>,
      document.body,
    ) : null}
  </>
  );
}

export default RemoteDesktopShell;

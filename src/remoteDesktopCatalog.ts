import { getAppLocale, t, type MessageId } from './i18n';
import type { RemoteSystemType } from './components/remote-desktop/types';
import {
  acknowledgeDesktopAppCatalog,
  appCatalogMigrationKeys,
  createDefaultRemoteDesktopLayout,
  defaultDesktopAppKeys,
  desktopAppCatalogVersion,
  getRemoteDesktopLayoutAppKeys,
  getRemoteDesktopLayoutRemovedAppKeys,
  latestAppCatalogMigrationKeys,
  shouldPreserveCurrentRemoteDesktopLayout,
} from './remoteDesktopLayout';

export {
  acknowledgeDesktopAppCatalog,
  appCatalogMigrationKeys,
  createDefaultRemoteDesktopLayout,
  defaultDesktopAppKeys,
  desktopAppCatalogVersion,
  latestAppCatalogMigrationKeys,
};

const remoteDesktopLayoutShadowPreferenceKey = 'remoteDesktop.layoutShadow';

export type DesktopAppGroupKey =
  | 'basic'
  | 'operations'
  | 'data'
  | 'network-security'
  | 'web-services'
  | 'development';

export const desktopAppGroups = [
  { key: 'basic', labelId: 'desktop.launchpad.group.basic' },
  { key: 'operations', labelId: 'desktop.launchpad.group.operations' },
  { key: 'data', labelId: 'desktop.launchpad.group.data' },
  { key: 'network-security', labelId: 'desktop.launchpad.group.networkSecurity' },
  { key: 'web-services', labelId: 'desktop.launchpad.group.webServices' },
  { key: 'development', labelId: 'desktop.launchpad.group.development' },
] as const satisfies ReadonlyArray<{ key: DesktopAppGroupKey; labelId: MessageId }>;

export const desktopAppGroupByKey = new Map<DesktopAppGroupKey, (typeof desktopAppGroups)[number]>(
  desktopAppGroups.map((group) => [group.key, group]),
);

export const desktopApps = [
  { key: 'files', group: 'basic', labelId: 'desktop.app.files.label', descriptionId: 'desktop.app.files.description' },
  { key: 'terminal', group: 'basic', labelId: 'desktop.app.terminal.label', descriptionId: 'desktop.app.terminal.description' },
  { key: 'notepad', group: 'basic', labelId: 'desktop.app.notepad.label', descriptionId: 'desktop.app.notepad.description' },
  { key: 'code-editor', group: 'development', labelId: 'desktop.app.codeEditor.label', descriptionId: 'desktop.app.codeEditor.description' },
  { key: 'browser', group: 'basic', labelId: 'desktop.app.browser.label', descriptionId: 'desktop.app.browser.description' },
  { key: 'vnc', group: 'operations', labelId: 'desktop.app.vnc.label', descriptionId: 'desktop.app.vnc.description' },
  { key: 'rdp-viewer', group: 'operations', labelId: 'desktop.app.rdpViewer.label', descriptionId: 'desktop.app.rdpViewer.description' },
  { key: 'log-viewer', group: 'operations', labelId: 'desktop.app.logViewer.label', descriptionId: 'desktop.app.logViewer.description' },
  { key: 'monitor', group: 'operations', labelId: 'desktop.app.monitor.label', descriptionId: 'desktop.app.monitor.description' },
  { key: 'mysql', group: 'data', labelId: 'desktop.app.mysql.label', descriptionId: 'desktop.app.mysql.description' },
  { key: 'clickhouse', group: 'data', labelId: 'desktop.app.clickhouse.label', descriptionId: 'desktop.app.clickhouse.description' },
  { key: 'redis', group: 'data', labelId: 'desktop.app.redis.label', descriptionId: 'desktop.app.redis.description' },
  { key: 'service-manager', group: 'basic', labelId: 'desktop.app.serviceManager.label', descriptionId: 'desktop.app.serviceManager.description' },
  { key: 'supervisor-manager', group: 'operations', labelId: 'desktop.app.supervisorManager.label', descriptionId: 'desktop.app.supervisorManager.description' },
  { key: 'backup-manager', group: 'operations', labelId: 'desktop.app.backupManager.label', descriptionId: 'desktop.app.backupManager.description' },
  { key: 'container-manager', group: 'development', labelId: 'desktop.app.containerManager.label', descriptionId: 'desktop.app.containerManager.description' },
  { key: 'k8s-manager', group: 'development', labelId: 'desktop.app.k8sManager.label', descriptionId: 'desktop.app.k8sManager.description' },
  { key: 'vm-manager', group: 'operations', labelId: 'desktop.app.vmManager.label', descriptionId: 'desktop.app.vmManager.description' },
  { key: 'port-manager', group: 'network-security', labelId: 'desktop.app.portManager.label', descriptionId: 'desktop.app.portManager.description' },
  { key: 'firewall-manager', group: 'network-security', labelId: 'desktop.app.firewallManager.label', descriptionId: 'desktop.app.firewallManager.description' },
  { key: 'iptables-manager', group: 'network-security', labelId: 'desktop.app.iptablesManager.label', descriptionId: 'desktop.app.iptablesManager.description' },
  { key: 'network-diagnostics', group: 'network-security', labelId: 'desktop.app.networkDiagnostics.label', descriptionId: 'desktop.app.networkDiagnostics.description' },
  { key: 'disk-analyzer', group: 'operations', labelId: 'desktop.app.diskAnalyzer.label', descriptionId: 'desktop.app.diskAnalyzer.description' },
  { key: 'disk-manager', group: 'operations', labelId: 'desktop.app.diskManager.label', descriptionId: 'desktop.app.diskManager.description' },
  { key: 'package-manager', group: 'operations', labelId: 'desktop.app.packageManager.label', descriptionId: 'desktop.app.packageManager.description' },
  { key: 'git-manager', group: 'development', labelId: 'desktop.app.gitManager.label', descriptionId: 'desktop.app.gitManager.description' },
  { key: 'cert-manager', group: 'web-services', labelId: 'desktop.app.certManager.label', descriptionId: 'desktop.app.certManager.description' },
  { key: 'nginx-manager', group: 'web-services', labelId: 'desktop.app.nginxManager.label', descriptionId: 'desktop.app.nginxManager.description' },
  { key: 'caddy-manager', group: 'web-services', labelId: 'desktop.app.caddyManager.label', descriptionId: 'desktop.app.caddyManager.description' },
  { key: 'apache-manager', group: 'web-services', labelId: 'desktop.app.apacheManager.label', descriptionId: 'desktop.app.apacheManager.description' },
  { key: 'scheduled-tasks', group: 'operations', labelId: 'desktop.app.scheduledTasks.label', descriptionId: 'desktop.app.scheduledTasks.description' },
  { key: 'postgres', group: 'data', labelId: 'desktop.app.postgres.label', descriptionId: 'desktop.app.postgres.description' },
  { key: 'mongo', group: 'data', labelId: 'desktop.app.mongo.label', descriptionId: 'desktop.app.mongo.description' },
  { key: 'search-cluster', group: 'data', labelId: 'desktop.app.searchCluster.label', descriptionId: 'desktop.app.searchCluster.description' },
  { key: 'message-queue', group: 'data', labelId: 'desktop.app.messageQueue.label', descriptionId: 'desktop.app.messageQueue.description' },
  { key: 's3-browser', group: 'data', labelId: 'desktop.app.s3Browser.label', descriptionId: 'desktop.app.s3Browser.description' },
  { key: 'frp-manager', group: 'network-security', labelId: 'desktop.app.frpManager.label', descriptionId: 'desktop.app.frpManager.description' },
  { key: 'frps-manager', group: 'network-security', labelId: 'desktop.app.frpsManager.label', descriptionId: 'desktop.app.frpsManager.description' },
  { key: 'security-audit', group: 'operations', labelId: 'desktop.app.securityAudit.label', descriptionId: 'desktop.app.securityAudit.description' },
  { key: 'api-debugger', group: 'development', labelId: 'desktop.app.apiDebugger.label', descriptionId: 'desktop.app.apiDebugger.description' },
  { key: 'procmanager', group: 'basic', labelId: 'desktop.app.processManager.label', descriptionId: 'desktop.app.processManager.description' },
  { key: 'ai-chat', group: 'basic', labelId: 'desktop.app.aiChat.label', descriptionId: 'desktop.app.aiChat.description' },
  { key: 'settings', group: 'basic', labelId: 'desktop.app.settings.label', descriptionId: 'desktop.app.settings.description' },
  { key: 'sqlite', group: 'data', labelId: 'desktop.app.sqlite.label', descriptionId: 'desktop.app.sqlite.description' },
] as const satisfies ReadonlyArray<{ key: string; group: DesktopAppGroupKey; labelId: MessageId; descriptionId: MessageId }>;

export type DesktopAppInfo = (typeof desktopApps)[number];
export type DesktopAppKey = DesktopAppInfo['key'];

export type DesktopSystemFamily = 'linux' | 'windows' | 'macos';
export type DesktopAppMode = 'workspace' | 'read-only' | 'management' | 'network-client';
export type DesktopAppPermission = 'user' | 'sudo-optional' | 'sudo-required';
export type DesktopToolRequirement = string | readonly string[];

export interface DesktopAppCapability {
  supportedSystems: readonly DesktopSystemFamily[];
  requiredTools: readonly DesktopToolRequirement[];
  requiredToolsBySystem?: Partial<Record<DesktopSystemFamily, readonly DesktopToolRequirement[]>>;
  mode: DesktopAppMode;
  permission: DesktopAppPermission;
  capabilityProbe: 'none' | 'required-tools';
  introducedInVersion: number;
}

const allDesktopSystems = ['linux', 'windows', 'macos'] as const;
const posixDesktopSystems = ['linux', 'macos'] as const;
const linuxDesktopSystems = ['linux'] as const;

export const desktopAppCapabilities = {
  files: { supportedSystems: allDesktopSystems, requiredTools: [], mode: 'workspace', permission: 'user', capabilityProbe: 'none', introducedInVersion: 1 },
  terminal: { supportedSystems: allDesktopSystems, requiredTools: [], mode: 'workspace', permission: 'user', capabilityProbe: 'none', introducedInVersion: 1 },
  notepad: { supportedSystems: allDesktopSystems, requiredTools: [], mode: 'workspace', permission: 'user', capabilityProbe: 'none', introducedInVersion: 1 },
  'code-editor': { supportedSystems: allDesktopSystems, requiredTools: [], mode: 'workspace', permission: 'user', capabilityProbe: 'none', introducedInVersion: 16 },
  browser: { supportedSystems: allDesktopSystems, requiredTools: [], mode: 'network-client', permission: 'user', capabilityProbe: 'none', introducedInVersion: 1 },
  vnc: { supportedSystems: allDesktopSystems, requiredTools: [], mode: 'network-client', permission: 'user', capabilityProbe: 'none', introducedInVersion: 1 },
  'rdp-viewer': { supportedSystems: allDesktopSystems, requiredTools: [], mode: 'network-client', permission: 'user', capabilityProbe: 'none', introducedInVersion: 19 },
  'log-viewer': { supportedSystems: allDesktopSystems, requiredTools: [], mode: 'read-only', permission: 'sudo-optional', capabilityProbe: 'none', introducedInVersion: 1 },
  monitor: { supportedSystems: allDesktopSystems, requiredTools: [], mode: 'read-only', permission: 'user', capabilityProbe: 'none', introducedInVersion: 1 },
  mysql: { supportedSystems: allDesktopSystems, requiredTools: [], mode: 'network-client', permission: 'user', capabilityProbe: 'none', introducedInVersion: 1 },
  clickhouse: { supportedSystems: allDesktopSystems, requiredTools: [], mode: 'network-client', permission: 'user', capabilityProbe: 'none', introducedInVersion: 14 },
  redis: { supportedSystems: allDesktopSystems, requiredTools: [], mode: 'network-client', permission: 'user', capabilityProbe: 'none', introducedInVersion: 1 },
  'service-manager': { supportedSystems: allDesktopSystems, requiredTools: [], requiredToolsBySystem: { linux: ['systemctl'], windows: ['sc.exe'], macos: ['launchctl'] }, mode: 'management', permission: 'sudo-required', capabilityProbe: 'required-tools', introducedInVersion: 1 },
  'supervisor-manager': { supportedSystems: posixDesktopSystems, requiredTools: ['supervisorctl'], mode: 'management', permission: 'sudo-optional', capabilityProbe: 'required-tools', introducedInVersion: 19 },
  'backup-manager': { supportedSystems: allDesktopSystems, requiredTools: [], mode: 'management', permission: 'sudo-optional', capabilityProbe: 'none', introducedInVersion: 19 },
  'container-manager': { supportedSystems: allDesktopSystems, requiredTools: [['docker', 'podman']], mode: 'management', permission: 'sudo-optional', capabilityProbe: 'required-tools', introducedInVersion: 1 },
  'k8s-manager': { supportedSystems: allDesktopSystems, requiredTools: ['kubectl'], mode: 'management', permission: 'user', capabilityProbe: 'required-tools', introducedInVersion: 17 },
  'vm-manager': { supportedSystems: linuxDesktopSystems, requiredTools: ['virsh'], mode: 'management', permission: 'sudo-optional', capabilityProbe: 'required-tools', introducedInVersion: 18 },
  'port-manager': { supportedSystems: allDesktopSystems, requiredTools: [], mode: 'management', permission: 'sudo-optional', capabilityProbe: 'none', introducedInVersion: 1 },
  'firewall-manager': { supportedSystems: allDesktopSystems, requiredTools: [], mode: 'management', permission: 'sudo-required', capabilityProbe: 'none', introducedInVersion: 1 },
  'iptables-manager': { supportedSystems: linuxDesktopSystems, requiredTools: ['iptables'], mode: 'management', permission: 'sudo-required', capabilityProbe: 'required-tools', introducedInVersion: 1 },
  'network-diagnostics': { supportedSystems: allDesktopSystems, requiredTools: [], mode: 'read-only', permission: 'user', capabilityProbe: 'none', introducedInVersion: 1 },
  'disk-analyzer': { supportedSystems: allDesktopSystems, requiredTools: [], mode: 'read-only', permission: 'sudo-optional', capabilityProbe: 'none', introducedInVersion: 1 },
  'disk-manager': { supportedSystems: allDesktopSystems, requiredTools: [], mode: 'management', permission: 'sudo-required', capabilityProbe: 'none', introducedInVersion: 14 },
  'package-manager': { supportedSystems: allDesktopSystems, requiredTools: [], mode: 'management', permission: 'sudo-required', capabilityProbe: 'none', introducedInVersion: 1 },
  'git-manager': { supportedSystems: allDesktopSystems, requiredTools: ['git'], mode: 'management', permission: 'user', capabilityProbe: 'required-tools', introducedInVersion: 14 },
  'cert-manager': { supportedSystems: allDesktopSystems, requiredTools: ['openssl'], mode: 'management', permission: 'sudo-optional', capabilityProbe: 'required-tools', introducedInVersion: 14 },
  'nginx-manager': { supportedSystems: allDesktopSystems, requiredTools: ['nginx'], mode: 'management', permission: 'sudo-required', capabilityProbe: 'required-tools', introducedInVersion: 14 },
  'caddy-manager': { supportedSystems: allDesktopSystems, requiredTools: ['caddy'], mode: 'management', permission: 'sudo-required', capabilityProbe: 'required-tools', introducedInVersion: 14 },
  'apache-manager': { supportedSystems: allDesktopSystems, requiredTools: [['apache2', 'httpd']], mode: 'management', permission: 'sudo-required', capabilityProbe: 'required-tools', introducedInVersion: 14 },
  'scheduled-tasks': { supportedSystems: allDesktopSystems, requiredTools: [], requiredToolsBySystem: { linux: ['crontab'], windows: ['schtasks.exe'], macos: ['launchctl'] }, mode: 'management', permission: 'sudo-optional', capabilityProbe: 'required-tools', introducedInVersion: 1 },
  postgres: { supportedSystems: allDesktopSystems, requiredTools: [], mode: 'network-client', permission: 'user', capabilityProbe: 'none', introducedInVersion: 1 },
  mongo: { supportedSystems: allDesktopSystems, requiredTools: [], mode: 'network-client', permission: 'user', capabilityProbe: 'none', introducedInVersion: 14 },
  'search-cluster': { supportedSystems: allDesktopSystems, requiredTools: [], mode: 'network-client', permission: 'user', capabilityProbe: 'none', introducedInVersion: 14 },
  'message-queue': { supportedSystems: allDesktopSystems, requiredTools: [], mode: 'network-client', permission: 'user', capabilityProbe: 'none', introducedInVersion: 14 },
  's3-browser': { supportedSystems: allDesktopSystems, requiredTools: [], mode: 'network-client', permission: 'user', capabilityProbe: 'none', introducedInVersion: 14 },
  'frp-manager': { supportedSystems: allDesktopSystems, requiredTools: ['frpc'], mode: 'management', permission: 'sudo-optional', capabilityProbe: 'required-tools', introducedInVersion: 14 },
  'frps-manager': { supportedSystems: allDesktopSystems, requiredTools: ['frps'], mode: 'management', permission: 'sudo-optional', capabilityProbe: 'required-tools', introducedInVersion: 14 },
  'security-audit': { supportedSystems: allDesktopSystems, requiredTools: [], mode: 'read-only', permission: 'sudo-optional', capabilityProbe: 'none', introducedInVersion: 1 },
  'api-debugger': { supportedSystems: allDesktopSystems, requiredTools: [], mode: 'network-client', permission: 'user', capabilityProbe: 'none', introducedInVersion: 1 },
  procmanager: { supportedSystems: allDesktopSystems, requiredTools: [], mode: 'management', permission: 'sudo-optional', capabilityProbe: 'none', introducedInVersion: 1 },
  'ai-chat': { supportedSystems: allDesktopSystems, requiredTools: [], mode: 'workspace', permission: 'user', capabilityProbe: 'none', introducedInVersion: 15 },
  settings: { supportedSystems: allDesktopSystems, requiredTools: [], mode: 'management', permission: 'sudo-optional', capabilityProbe: 'none', introducedInVersion: 1 },
  sqlite: { supportedSystems: allDesktopSystems, requiredTools: [], mode: 'workspace', permission: 'user', capabilityProbe: 'none', introducedInVersion: 1 },
} as const satisfies Record<DesktopAppKey, DesktopAppCapability>;

export const defaultDockPinnedApps: DesktopAppKey[] = ['files', 'terminal', 'browser'];

export const desktopAppIconSources: Record<DesktopAppKey, string> = {
  files: new URL('./assets/desktop-icons/files.png', import.meta.url).href,
  terminal: new URL('./assets/desktop-icons/terminal.png', import.meta.url).href,
  notepad: new URL('./assets/desktop-icons/notepad.png', import.meta.url).href,
  'code-editor': new URL('./assets/desktop-icons/code-editor.png', import.meta.url).href,
  browser: new URL('./assets/desktop-icons/browser.png', import.meta.url).href,
  vnc: new URL('./assets/desktop-icons/vnc.png', import.meta.url).href,
  'rdp-viewer': new URL('./assets/desktop-icons/rdp-viewer.png', import.meta.url).href,
  'log-viewer': new URL('./assets/desktop-icons/log-viewer.png', import.meta.url).href,
  monitor: new URL('./assets/desktop-icons/monitor.png', import.meta.url).href,
  mysql: new URL('./assets/desktop-icons/mysql.png', import.meta.url).href,
  clickhouse: new URL('./assets/desktop-icons/clickhouse.png', import.meta.url).href,
  redis: new URL('./assets/desktop-icons/redis.png', import.meta.url).href,
  'service-manager': new URL('./assets/desktop-icons/service-manager.png', import.meta.url).href,
  'supervisor-manager': new URL('./assets/desktop-icons/supervisor-manager.png', import.meta.url).href,
  'backup-manager': new URL('./assets/desktop-icons/backup-manager.png', import.meta.url).href,
  'container-manager': new URL('./assets/desktop-icons/container-manager.png', import.meta.url).href,
  'k8s-manager': new URL('./assets/desktop-icons/k8s-manager.png', import.meta.url).href,
  'vm-manager': new URL('./assets/desktop-icons/vm-manager.png', import.meta.url).href,
  'port-manager': new URL('./assets/desktop-icons/port-manager.png', import.meta.url).href,
  'firewall-manager': new URL('./assets/desktop-icons/firewall-manager.png', import.meta.url).href,
  'iptables-manager': new URL('./assets/desktop-icons/iptables-manager.png', import.meta.url).href,
  'network-diagnostics': new URL('./assets/desktop-icons/network-diagnostics.png', import.meta.url).href,
  'disk-analyzer': new URL('./assets/desktop-icons/disk-analyzer.png', import.meta.url).href,
  'disk-manager': new URL('./assets/desktop-icons/disk-manager.png', import.meta.url).href,
  'package-manager': new URL('./assets/desktop-icons/package-manager.png', import.meta.url).href,
  'git-manager': new URL('./assets/desktop-icons/git-manager.png', import.meta.url).href,
  'cert-manager': new URL('./assets/desktop-icons/cert-manager.png', import.meta.url).href,
  'nginx-manager': new URL('./assets/desktop-icons/nginx-manager.png', import.meta.url).href,
  'caddy-manager': new URL('./assets/desktop-icons/caddy-manager.png', import.meta.url).href,
  'apache-manager': new URL('./assets/desktop-icons/apache-manager.png', import.meta.url).href,
  'scheduled-tasks': new URL('./assets/desktop-icons/scheduled-tasks.png', import.meta.url).href,
  postgres: new URL('./assets/desktop-icons/postgres.png', import.meta.url).href,
  mongo: new URL('./assets/desktop-icons/mongo.png', import.meta.url).href,
  'search-cluster': new URL('./assets/desktop-icons/search-cluster.png', import.meta.url).href,
  'message-queue': new URL('./assets/desktop-icons/message-queue.png', import.meta.url).href,
  's3-browser': new URL('./assets/desktop-icons/s3-browser.png', import.meta.url).href,
  'frp-manager': new URL('./assets/desktop-icons/frp-manager.png', import.meta.url).href,
  'frps-manager': new URL('./assets/desktop-icons/frps-manager.png', import.meta.url).href,
  'security-audit': new URL('./assets/desktop-icons/security-audit.png', import.meta.url).href,
  'api-debugger': new URL('./assets/desktop-icons/api-debugger.png', import.meta.url).href,
  procmanager: new URL('./assets/desktop-icons/procmanager.png', import.meta.url).href,
  'ai-chat': new URL('./assets/desktop-icons/ai-chat.png', import.meta.url).href,
  settings: new URL('./assets/desktop-icons/settings.png', import.meta.url).href,
  sqlite: new URL('./assets/desktop-icons/sqlite.png', import.meta.url).href,
};

export const remoteDesktopLayoutShadowStorageKey = 'shelldesk:remote-desktop-layout-shadow';
export const launchpadAnimationMs = 180;
export const desktopAppKeySet = new Set<DesktopAppKey>(desktopApps.map((app) => app.key));
export const desktopSortOptions: Array<{ value: ShellDeskDesktopSortMode; labelId: MessageId }> = [
  { value: 'custom', labelId: 'desktop.sort.custom' },
  { value: 'name-asc', labelId: 'desktop.sort.nameAsc' },
  { value: 'name-desc', labelId: 'desktop.sort.nameDesc' },
];

export type DesktopLayoutItem = ShellDeskDesktopLayoutItem;
export type DesktopFolderLayoutItem = ShellDeskDesktopFolderLayoutItem;

export function getAppInfo(appKey: DesktopAppKey) {
  return desktopApps.find((app) => app.key === appKey) ?? desktopApps[0];
}

export function getAppCapability(appKey: DesktopAppKey): DesktopAppCapability {
  return desktopAppCapabilities[appKey];
}

export function getDesktopSystemFamily(systemType?: RemoteSystemType): DesktopSystemFamily | 'unknown' {
  if (systemType === 'windows') return 'windows';
  if (systemType === 'macos') return 'macos';
  if (!systemType || systemType === 'unknown') return 'unknown';
  return 'linux';
}

export function getDesktopAppToolRequirements(appKey: DesktopAppKey, systemFamily: DesktopSystemFamily) {
  const capability = getAppCapability(appKey);
  return capability.requiredToolsBySystem?.[systemFamily] ?? capability.requiredTools;
}

export function normalizeDockPinnedApps(appKeys: ShellDeskDesktopAppKey[] | undefined): DesktopAppKey[] {
  const nextAppKeys = (appKeys && appKeys.length > 0 ? appKeys : defaultDockPinnedApps)
    .filter((appKey): appKey is DesktopAppKey => desktopAppKeySet.has(appKey as DesktopAppKey))
    .filter((appKey, index, allAppKeys) => allAppKeys.indexOf(appKey) === index);

  return nextAppKeys.length > 0 ? nextAppKeys : defaultDockPinnedApps;
}

export function getAppLabel(app: DesktopAppInfo, language: ShellDeskAppSettings['language']) {
  return t(app.labelId, language);
}

export function getAppDescription(app: DesktopAppInfo, language: ShellDeskAppSettings['language']) {
  return t(app.descriptionId, language);
}

export function getAppGroupLabel(group: (typeof desktopAppGroups)[number], language: ShellDeskAppSettings['language']) {
  return t(group.labelId, language);
}

export function isDesktopAppKey(value: unknown): value is DesktopAppKey {
  return typeof value === 'string' && desktopAppKeySet.has(value as DesktopAppKey);
}

export function normalizeFolderName(value: unknown) {
  const name = typeof value === 'string' ? value.trim().slice(0, 40) : '';
  return name || t('desktop.folder.defaultName', 'zh-CN');
}

export function getLayoutAppKeys(items: DesktopLayoutItem[]) {
  return getRemoteDesktopLayoutAppKeys(items) as Set<DesktopAppKey>;
}

export function getLayoutRemovedAppKeys(layout: Pick<ShellDeskRemoteDesktopLayout, 'removedAppKeys'>) {
  return getRemoteDesktopLayoutRemovedAppKeys(layout) as Set<DesktopAppKey>;
}

export function areRemoteDesktopLayoutsEqual(firstLayout: ShellDeskRemoteDesktopLayout, secondLayout: ShellDeskRemoteDesktopLayout) {
  return JSON.stringify(firstLayout) === JSON.stringify(secondLayout);
}

export function shouldPreserveCurrentDesktopLayout(
  currentLayout: ShellDeskRemoteDesktopLayout,
  incomingLayout: ShellDeskRemoteDesktopLayout,
) {
  return shouldPreserveCurrentRemoteDesktopLayout(currentLayout, incomingLayout);
}

export function migrateLegacyAllAppsLayout(items: DesktopLayoutItem[], appCatalogVersion: number, removedAppKeys: Set<DesktopAppKey>) {
  void appCatalogVersion;
  void removedAppKeys;
  return items;
}

export function normalizeRemoteDesktopLayout(rawLayout: unknown): ShellDeskRemoteDesktopLayout {
  const defaultLayout = createDefaultRemoteDesktopLayout();

  if (!rawLayout || typeof rawLayout !== 'object' || Array.isArray(rawLayout)) {
    return defaultLayout;
  }

  const layout = rawLayout as Partial<ShellDeskRemoteDesktopLayout>;
  const rawAppCatalogVersion = Number(layout.appCatalogVersion);
  const appCatalogVersion = Number.isInteger(rawAppCatalogVersion) && rawAppCatalogVersion > 0
    ? rawAppCatalogVersion
    : 1;
  const rawSeenAppCatalogVersion = Number(layout.seenAppCatalogVersion);
  const seenAppCatalogVersion = Number.isInteger(rawSeenAppCatalogVersion) && rawSeenAppCatalogVersion > 0
    ? Math.min(rawSeenAppCatalogVersion, desktopAppCatalogVersion)
    : Math.min(appCatalogVersion, desktopAppCatalogVersion);
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

  const layoutAppKeys = getLayoutAppKeys(items);
  const removedAppKeys = new Set<DesktopAppKey>();
  if (Array.isArray(layout.removedAppKeys)) {
    layout.removedAppKeys.forEach((appKey) => {
      if (isDesktopAppKey(appKey) && !layoutAppKeys.has(appKey)) {
        removedAppKeys.add(appKey);
      }
    });
  }
  const migratedItems = migrateLegacyAllAppsLayout(items, appCatalogVersion, removedAppKeys);
  const migratedAppKeys = getLayoutAppKeys(migratedItems);

  return {
    appCatalogVersion: desktopAppCatalogVersion,
    seenAppCatalogVersion,
    sortMode,
    items: migratedItems,
    removedAppKeys: [...removedAppKeys].filter((appKey) => !migratedAppKeys.has(appKey)),
  };
}

export function readRemoteDesktopLayoutShadow() {
  try {
    const rawLayout = window.localStorage.getItem(remoteDesktopLayoutShadowStorageKey);

    if (!rawLayout) {
      return null;
    }

    const parsedLayout: unknown = JSON.parse(rawLayout);

    if (!parsedLayout || typeof parsedLayout !== 'object' || Array.isArray(parsedLayout)) {
      return null;
    }

    return normalizeRemoteDesktopLayout(parsedLayout);
  } catch {
    return null;
  }
}

export function storeRemoteDesktopLayoutShadow(layout: ShellDeskRemoteDesktopLayout) {
  try {
    window.localStorage.setItem(remoteDesktopLayoutShadowStorageKey, JSON.stringify(layout));
  } catch {
    // Ignore localStorage write failures in restricted environments.
  }
  void window.guiSSH?.preferences?.set(remoteDesktopLayoutShadowPreferenceKey, layout).catch(() => undefined);
}

export function getLayoutItemLabel(item: DesktopLayoutItem, language: ShellDeskAppSettings['language']) {
  return item.type === 'app' ? getAppLabel(getAppInfo(item.appKey), language) : item.name;
}

export function compareLayoutItemsByName(
  firstItem: DesktopLayoutItem,
  secondItem: DesktopLayoutItem,
  language: ShellDeskAppSettings['language'],
) {
  return getLayoutItemLabel(firstItem, language).localeCompare(getLayoutItemLabel(secondItem, language), getAppLocale(language));
}

export function getSortedDesktopItems(layout: ShellDeskRemoteDesktopLayout, language: ShellDeskAppSettings['language']) {
  if (layout.sortMode === 'custom') {
    return layout.items;
  }

  const sortedItems = [...layout.items].sort((firstItem, secondItem) => compareLayoutItemsByName(firstItem, secondItem, language));
  return layout.sortMode === 'name-desc' ? sortedItems.reverse() : sortedItems;
}

export function hasDesktopApp(layout: ShellDeskRemoteDesktopLayout, appKey: DesktopAppKey) {
  return layout.items.some((item) => (
    item.type === 'app'
      ? item.appKey === appKey
      : item.appKeys.includes(appKey)
  ));
}

export function removeAppFromDesktopLayout(layout: ShellDeskRemoteDesktopLayout, appKey: DesktopAppKey): ShellDeskRemoteDesktopLayout {
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

export function markDesktopAppRemoved(layout: ShellDeskRemoteDesktopLayout, appKey: DesktopAppKey): ShellDeskRemoteDesktopLayout {
  if (layout.removedAppKeys.includes(appKey)) {
    return layout;
  }

  return {
    ...layout,
    removedAppKeys: [...layout.removedAppKeys, appKey],
  };
}

export function clearDesktopAppRemoved(layout: ShellDeskRemoteDesktopLayout, appKey: DesktopAppKey): ShellDeskRemoteDesktopLayout {
  if (!layout.removedAppKeys.includes(appKey)) {
    return layout;
  }

  return {
    ...layout,
    removedAppKeys: layout.removedAppKeys.filter((currentAppKey) => currentAppKey !== appKey),
  };
}

export function removeTopLevelItem(items: DesktopLayoutItem[], itemId: string) {
  return items.filter((item) => item.id !== itemId);
}

export function insertTopLevelItem(items: DesktopLayoutItem[], nextItem: DesktopLayoutItem, targetItemId?: string) {
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

export function addAppToFolder(layout: ShellDeskRemoteDesktopLayout, folderId: string, appKey: DesktopAppKey, targetAppKey?: DesktopAppKey): ShellDeskRemoteDesktopLayout {
  const withoutApp = clearDesktopAppRemoved(removeAppFromDesktopLayout(layout, appKey), appKey);

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

export function moveAppToDesktop(layout: ShellDeskRemoteDesktopLayout, appKey: DesktopAppKey, targetItemId?: string): ShellDeskRemoteDesktopLayout {
  const withoutApp = clearDesktopAppRemoved(removeAppFromDesktopLayout(layout, appKey), appKey);
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

export function moveTopLevelItem(layout: ShellDeskRemoteDesktopLayout, itemId: string, targetItemId?: string): ShellDeskRemoteDesktopLayout {
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

export function createUniqueFolderName(items: DesktopLayoutItem[], baseName: string) {
  const existingNames = new Set(items.filter((item) => item.type === 'folder').map((item) => item.name));
  let name = baseName;
  let index = 2;

  while (existingNames.has(name)) {
    name = `${baseName} ${index}`;
    index += 1;
  }

  return name;
}

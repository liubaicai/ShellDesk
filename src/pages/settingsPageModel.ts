import { builtinModels } from '@earendil-works/pi-ai/providers/all';

import { getCurrentAppLocale, t, type MessageId } from '../i18n';

export const settingsSections = [
  { key: 'general', labelId: 'settings.section.general.label', summaryId: 'settings.section.general.summary' },
  { key: 'appearance', labelId: 'settings.section.appearance.label', summaryId: 'settings.section.appearance.summary' },
  { key: 'desktop', labelId: 'settings.section.desktop.label', summaryId: 'settings.section.desktop.summary' },
  { key: 'terminal', labelId: 'settings.section.terminal.label', summaryId: 'settings.section.terminal.summary' },
  { key: 'ai', labelId: 'settings.section.ai.label', summaryId: 'settings.section.ai.summary' },
  { key: 'security', labelId: 'settings.section.security.label', summaryId: 'settings.section.security.summary' },
  { key: 'backup', labelId: 'settings.section.backup.label', summaryId: 'settings.section.backup.summary' },
  { key: 'about', labelId: 'settings.section.about.label', summaryId: 'settings.section.about.summary' },
] as const satisfies ReadonlyArray<{ key: string; labelId: MessageId; summaryId: MessageId }>;

export const accentColorChoices = ['#43c7ff', '#77f4c5', '#ffb347', '#ff7b9c', '#9f8cff', '#8bd3ff', '#ff8c42'];
export const terminalLineHeightChoices = [1, 1.1, 1.2, 1.3, 1.4];
export const terminalScrollSensitivityChoices = [0.5, 1, 1.5, 2, 3, 5];
export const terminalFastScrollSensitivityChoices = [2, 5, 8, 10, 15, 20];
export const fallbackSystemFontChoices = [
  'Microsoft YaHei UI',
  'Microsoft YaHei',
  'PingFang SC',
  'Hiragino Sans GB',
  'Noto Sans CJK SC',
  'Source Han Sans SC',
  'Segoe UI Variable',
  'Segoe UI',
  'Arial',
  'Verdana',
  'Georgia',
  'Times New Roman',
  'DengXian',
  'SimSun',
  'Cascadia Mono',
  'JetBrains Mono',
  'Fira Code',
  'Consolas',
  'Source Code Pro',
  'Hack',
  'Menlo',
  'Monaco',
  'Courier New',
];
export const interfacePreferredFontChoices = [
  'Microsoft YaHei UI',
  'Microsoft YaHei',
  'PingFang SC',
  'Hiragino Sans GB',
  'Noto Sans CJK SC',
  'Source Han Sans SC',
  'Segoe UI Variable',
  'Segoe UI',
];
export const terminalPreferredFontChoices = [
  'Cascadia Mono',
  'JetBrains Mono',
  'Fira Code',
  'Consolas',
  'Source Code Pro',
  'Hack',
  'Menlo',
  'Monaco',
  'Courier New',
];
export const maxWallpaperImageBytes = 2 * 1024 * 1024;
export const defaultMcpServerEndpoint = 'http://127.0.0.1:38471/mcp';
export const mcpCallExample = `{
  "mcpServers": {
    "shelldesk": {
      "type": "streamable-http",
      "url": "${defaultMcpServerEndpoint}"
    }
  }
}

Prompt example:
Use the ShellDesk MCP tools to list my saved hosts, then run "uname -a" on the host I select.`;
export const skillCallExample = `1. Import shelldesk-remote-hosts.zip into the AI platform.
2. Keep ShellDesk running and enable System Settings > AI > MCP Service.
3. Invoke the skill with a prompt such as:

Use $shelldesk-remote-hosts to list my saved hosts and inspect disk usage on the host I select.

Fallback without native MCP support:
python scripts/shelldesk_mcp_client.py list-hosts
python scripts/shelldesk_mcp_client.py run-command <host-id> "df -h"`;
export const acceptedWallpaperTypes = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif']);
export const wallpaperExtensionPattern = /\.(png|jpe?g|webp|gif)$/i;
export const wallpaperDataUrlPattern = /^data:image\/(?:png|jpe?g|webp|gif);base64,/i;
export const terminalContrastChoices = [
  { value: 1, labelId: 'settings.terminal.minimumContrast.off' },
  { value: 4.5, labelId: 'settings.terminal.minimumContrast.aa45' },
  { value: 7, labelId: 'settings.terminal.minimumContrast.aaa7' },
] as const satisfies ReadonlyArray<{ value: number; labelId: MessageId }>;
export const desktopDockPositionChoices = [
  { value: 'bottom', labelId: 'settings.desktop.dock.position.bottom' },
  { value: 'left', labelId: 'settings.desktop.dock.position.left' },
  { value: 'right', labelId: 'settings.desktop.dock.position.right' },
  { value: 'top', labelId: 'settings.desktop.dock.position.top' },
] as const satisfies ReadonlyArray<{ value: ShellDeskRemoteDesktopDockPosition; labelId: MessageId }>;
export const desktopDockSizeChoices = [
  { value: 'small', labelId: 'settings.desktop.dock.size.small' },
  { value: 'medium', labelId: 'settings.desktop.dock.size.medium' },
  { value: 'large', labelId: 'settings.desktop.dock.size.large' },
] as const satisfies ReadonlyArray<{ value: ShellDeskRemoteDesktopDockSize; labelId: MessageId }>;
export const desktopDockAutoHideChoices = [
  { value: 'never', labelId: 'settings.desktop.dock.autoHide.never' },
  { value: 'always', labelId: 'settings.desktop.dock.autoHide.always' },
  { value: 'maximized', labelId: 'settings.desktop.dock.autoHide.maximized' },
] as const satisfies ReadonlyArray<{ value: ShellDeskRemoteDesktopDockAutoHide; labelId: MessageId }>;
export const desktopDockPinnedAppChoices = [
  { key: 'files', labelId: 'desktop.app.files.label' },
  { key: 'terminal', labelId: 'desktop.app.terminal.label' },
  { key: 'browser', labelId: 'desktop.app.browser.label' },
  { key: 'notepad', labelId: 'desktop.app.notepad.label' },
  { key: 'code-editor', labelId: 'desktop.app.codeEditor.label' },
  { key: 'monitor', labelId: 'desktop.app.monitor.label' },
  { key: 'procmanager', labelId: 'desktop.app.processManager.label' },
  { key: 'settings', labelId: 'desktop.app.settings.label' },
  { key: 'service-manager', labelId: 'desktop.app.serviceManager.label' },
  { key: 'supervisor-manager', labelId: 'desktop.app.supervisorManager.label' },
  { key: 'backup-manager', labelId: 'desktop.app.backupManager.label' },
  { key: 'container-manager', labelId: 'desktop.app.containerManager.label' },
  { key: 'disk-analyzer', labelId: 'desktop.app.diskAnalyzer.label' },
  { key: 'disk-manager', labelId: 'desktop.app.diskManager.label' },
  { key: 'package-manager', labelId: 'desktop.app.packageManager.label' },
  { key: 'git-manager', labelId: 'desktop.app.gitManager.label' },
  { key: 'scheduled-tasks', labelId: 'desktop.app.scheduledTasks.label' },
  { key: 'mysql', labelId: 'desktop.app.mysql.label' },
  { key: 'postgres', labelId: 'desktop.app.postgres.label' },
  { key: 'redis', labelId: 'desktop.app.redis.label' },
  { key: 'sqlite', labelId: 'desktop.app.sqlite.label' },
  { key: 'mongo', labelId: 'desktop.app.mongo.label' },
  { key: 'clickhouse', labelId: 'desktop.app.clickhouse.label' },
  { key: 'search-cluster', labelId: 'desktop.app.searchCluster.label' },
  { key: 'message-queue', labelId: 'desktop.app.messageQueue.label' },
  { key: 's3-browser', labelId: 'desktop.app.s3Browser.label' },
  { key: 'vnc', labelId: 'desktop.app.vnc.label' },
  { key: 'log-viewer', labelId: 'desktop.app.logViewer.label' },
  { key: 'network-diagnostics', labelId: 'desktop.app.networkDiagnostics.label' },
  { key: 'port-manager', labelId: 'desktop.app.portManager.label' },
  { key: 'firewall-manager', labelId: 'desktop.app.firewallManager.label' },
  { key: 'iptables-manager', labelId: 'desktop.app.iptablesManager.label' },
  { key: 'cert-manager', labelId: 'desktop.app.certManager.label' },
  { key: 'nginx-manager', labelId: 'desktop.app.nginxManager.label' },
  { key: 'caddy-manager', labelId: 'desktop.app.caddyManager.label' },
  { key: 'apache-manager', labelId: 'desktop.app.apacheManager.label' },
  { key: 'frp-manager', labelId: 'desktop.app.frpManager.label' },
  { key: 'frps-manager', labelId: 'desktop.app.frpsManager.label' },
  { key: 'security-audit', labelId: 'desktop.app.securityAudit.label' },
  { key: 'api-debugger', labelId: 'desktop.app.apiDebugger.label' },
  { key: 'ai-chat', labelId: 'desktop.app.aiChat.label' },
] as const satisfies ReadonlyArray<{ key: ShellDeskDesktopAppKey; labelId: MessageId }>;
export const aiProviderChoices: Array<{
  value: ShellDeskAiProvider;
  labelId: MessageId;
  summaryId: MessageId;
  apiFormat: ShellDeskAiApiFormat;
  defaultApiBaseUrl: string;
}> = [
  {
    value: 'openai',
    labelId: 'settings.ai.provider.openai.label',
    summaryId: 'settings.ai.provider.openai.summary',
    apiFormat: 'openai',
    defaultApiBaseUrl: 'https://api.openai.com/v1',
  },
  {
    value: 'anthropic',
    labelId: 'settings.ai.provider.anthropic.label',
    summaryId: 'settings.ai.provider.anthropic.summary',
    apiFormat: 'anthropic',
    defaultApiBaseUrl: 'https://api.anthropic.com',
  },
  {
    value: 'custom',
    labelId: 'settings.ai.provider.custom.label',
    summaryId: 'settings.ai.provider.custom.summary',
    apiFormat: 'openai',
    defaultApiBaseUrl: '',
  },
];
export const webSearchProviderChoices: Array<{
  value: ShellDeskWebSearchProvider;
  label: string;
  summaryId: MessageId;
  defaultApiBaseUrl: string;
}> = [
  {
    value: 'tavily',
    label: 'Tavily',
    summaryId: 'settings.ai.webSearch.provider.tavily.summary',
    defaultApiBaseUrl: 'https://api.tavily.com',
  },
  {
    value: 'exa',
    label: 'Exa',
    summaryId: 'settings.ai.webSearch.provider.exa.summary',
    defaultApiBaseUrl: 'https://api.exa.ai',
  },
  {
    value: 'zhipu',
    label: 'Zhipu',
    summaryId: 'settings.ai.webSearch.provider.zhipu.summary',
    defaultApiBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  },
];
export const shellDeskRepositoryUrl = 'https://github.com/liubaicai/ShellDesk';
export const shellDeskReleasesUrl = `${shellDeskRepositoryUrl}/releases`;
export const defaultSyncRemotePath = '/ShellDesk/shelldesk-sync.json';
export const syncIntervalChoices = [5, 15, 30, 60, 120, 360];

export function isCustomAiProvider(provider: ShellDeskAiProvider) {
  return provider === 'custom' || provider === 'openai-compatible';
}

export function createDefaultUpdateStatus(): ShellDeskUpdateStatus {
  return {
    status: 'idle',
    percent: 0,
    error: null,
    version: null,
    releaseNotes: '',
    releaseDate: null,
    isChecking: false,
    supported: true,
    unsupportedReason: '',
    checkedAt: null,
  };
}

export function createDefaultSyncForm(): ShellDeskSyncConfigInput {
  return {
    enabled: false,
    webdavUrl: '',
    webdavUsername: '',
    webdavPassword: '',
    webdavRemotePath: defaultSyncRemotePath,
    ignoreCertificateErrors: false,
    syncPassphrase: '',
    intervalMinutes: 15,
    syncOnStartup: true,
  };
}

export function createSyncFormFromConfig(config: ShellDeskSyncPublicConfig | null): ShellDeskSyncConfigInput {
  if (!config) {
    return createDefaultSyncForm();
  }

  return {
    enabled: config.enabled,
    webdavUrl: config.webdavUrl,
    webdavUsername: config.webdavUsername,
    webdavPassword: '',
    webdavRemotePath: config.webdavRemotePath || defaultSyncRemotePath,
    ignoreCertificateErrors: config.ignoreCertificateErrors,
    syncPassphrase: '',
    intervalMinutes: config.intervalMinutes,
    syncOnStartup: config.syncOnStartup,
  };
}

export function formatFileSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '';
  }

  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

export function formatDateTime(value: string | null | undefined) {
  if (!value) {
    return '';
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString(getCurrentAppLocale(), {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function getSettingsSectionNavClass(sectionKey: (typeof settingsSections)[number]['key'], activeSection: (typeof settingsSections)[number]['key']) {
  return [
    'settings-section-nav-item',
    sectionKey === 'about' ? 'settings-section-nav-about' : '',
    activeSection === sectionKey ? 'active' : '',
  ].filter(Boolean).join(' ');
}

export function readFileAsDataUrl(file: File, language: ShellDeskAppSettings['language']) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
        return;
      }

      reject(new Error(t('settings.error.imageReadFailed', language)));
    };

    reader.onerror = () => reject(new Error(t('settings.error.imageReadFailed', language)));
    reader.readAsDataURL(file);
  });
}

export function normalizeFontChoice(value: unknown) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.replace(/\s+/g, ' ').trim();
}

export function normalizeFontChoices(values: readonly unknown[]) {
  const fontMap = new Map<string, string>();

  for (const value of values) {
    const fontChoice = normalizeFontChoice(value);

    if (!fontChoice) {
      continue;
    }

    const key = fontChoice.toLocaleLowerCase();

    if (!fontMap.has(key)) {
      fontMap.set(key, fontChoice);
    }
  }

  return Array.from(fontMap.values());
}

export function createFontOptions(systemFonts: readonly string[], selectedFont: string, preferredFonts: readonly string[]) {
  const availableFonts = new Set(systemFonts.map((font) => font.toLocaleLowerCase()));
  const preferredAvailableFonts = preferredFonts.filter((font) => availableFonts.has(font.toLocaleLowerCase()));

  return normalizeFontChoices([
    selectedFont,
    ...preferredAvailableFonts,
    ...systemFonts,
  ]);
}

export function getFontListErrorMessage(error: unknown, language: ShellDeskAppSettings['language']) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return t('settings.error.fontListFailed', language);
}

export function getUpdateCheckErrorMessage(error: unknown, language: ShellDeskAppSettings['language']) {
  if (error instanceof Error && error.message) {
    return error.message.replace(/^Error invoking remote method '[^']+': Error: /, '');
  }

  if (typeof error === 'string' && error.trim()) {
    return error.trim();
  }

  return t('settings.error.updateCheckFailed', language);
}

export function getSettingsErrorMessage(error: unknown, language: ShellDeskAppSettings['language']) {
  if (error instanceof Error && error.message) {
    return error.message.replace(/^Error invoking remote method '[^']+': Error: /, '');
  }

  if (typeof error === 'string' && error.trim()) {
    return error.trim();
  }

  return t('settings.error.operationFailed', language);
}

export function getSyncStatusClassName(status: ShellDeskSyncStatus | undefined, hasError: boolean) {
  if (hasError) {
    return 'error';
  }

  if (status === 'success' || status === 'warning' || status === 'error') {
    return status;
  }

  return '';
}

export function getAiModelDisplayName(model: ShellDeskAiModelInfo) {
  return model.name && model.name !== model.id ? model.name : model.id;
}

export function getAiModelDetail(model: ShellDeskAiModelInfo) {
  const details = [
    model.name && model.name !== model.id ? model.id : '',
    model.ownedBy ? `by ${model.ownedBy}` : '',
  ].filter(Boolean);

  return details.join(' · ');
}

export function getPiProviderId(settings: ShellDeskAppSettings) {
  if (isCustomAiProvider(settings.aiProvider)) {
    return '';
  }

  if (settings.aiProvider === 'anthropic' || settings.aiApiFormat === 'anthropic') {
    return 'anthropic';
  }

  if (settings.aiProvider === 'openai') {
    return 'openai';
  }

  return '';
}

export function piModelToShellDeskModelInfo(model: { id: string; name?: string; provider?: string }): ShellDeskAiModelInfo {
  return {
    id: model.id,
    name: model.name || model.id,
    ownedBy: model.provider,
  };
}

export async function fetchRemoteAiModels(settings: ShellDeskAppSettings): Promise<ShellDeskAiModelInfo[]> {
  const listModels = window.guiSSH?.ai?.listModels;

  if (!listModels) {
    throw new Error(t('settings.ai.model.error.noApi', settings.language));
  }

  const result = await listModels({
    provider: settings.aiProvider,
    apiFormat: settings.aiApiFormat,
    apiBaseUrl: settings.aiApiBaseUrl,
    apiKey: settings.aiApiKey,
  });

  return result.models;
}

export function getBuiltinAiModels(settings: ShellDeskAppSettings): ShellDeskAiModelInfo[] {
  const providerId = getPiProviderId(settings);

  return builtinModels()
    .getModels(providerId || undefined)
    .map(piModelToShellDeskModelInfo);
}

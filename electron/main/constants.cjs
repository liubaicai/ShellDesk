const configBundleFormat = 'shelldesk-config';
const configBundleVersion = 2;
const maxConfigImportBytes = 20 * 1024 * 1024;
const maxPrivateKeyBytes = 1024 * 1024;
const maxRemoteTextFileBytes = 5 * 1024 * 1024;
const maxRemoteTextWriteBytes = 10 * 1024 * 1024;
const maxRemoteCommandLength = 64 * 1024;
const maxRemoteCommandInputLength = 512 * 1024;
const maxVaultBytes = 25 * 1024 * 1024;
const maxConfigStoreBytes = 25 * 1024 * 1024;
const maxDesktopWallpaperBytes = 5 * 1024 * 1024;
const maxDesktopWallpaperDataUrlLength = Math.ceil(maxDesktopWallpaperBytes * 1.4) + 128;
const configFileName = 'config.json';
const vaultFileName = 'vault.json';
const configStoreFormat = 'shelldesk-config-store';
const vaultFormat = 'shelldesk-vault';
const vaultSchemaVersion = 1;
const bookmarkScopePrefix = 'shelldesk:browser-bookmarks:';
const logFileName = 'logs.json';
const maxLogEntries = 500;
const accentColorChoices = ['#43c7ff', '#77f4c5', '#ffb347', '#ff7b9c', '#9f8cff', '#8bd3ff', '#ff8c42'];
const terminalThemeChoices = [
  'shelldesk-dark',
  'netcatty-dark',
  'tokyo-night',
  'dracula',
  'monokai',
  'solarized-light',
  'netcatty-light',
  'hacker-green',
];
const terminalCursorInactiveStyleChoices = ['outline', 'block', 'bar', 'underline', 'none'];
const aiProviderChoices = ['openai', 'anthropic', 'openai-compatible', 'custom'];
const aiApiFormatChoices = ['openai', 'anthropic'];
const defaultAiApiBaseUrls = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  'openai-compatible': '',
  custom: '',
};
const maxAiApiBaseUrlLength = 2048;
const maxAiApiKeyLength = 8192;
const maxAiModelNameLength = 200;
const maxAiProviderNameLength = 80;
const remoteDesktopAppCatalogVersion = 2;
const remoteDesktopAppKeys = [
  'files',
  'terminal',
  'notepad',
  'browser',
  'vnc',
  'log-viewer',
  'monitor',
  'mysql',
  'redis',
  'service-manager',
  'container-manager',
  'port-manager',
  'firewall-manager',
  'iptables-manager',
  'network-diagnostics',
  'disk-analyzer',
  'package-manager',
  'git-manager',
  'web-server-manager',
  'scheduled-tasks',
  'postgres',
  'mongo',
  'search-cluster',
  'message-queue',
  's3-browser',
  'security-audit',
  'login-sessions',
  'api-debugger',
  'procmanager',
  'settings',
  'sqlite',
];
const remoteDesktopAppKeySet = new Set(remoteDesktopAppKeys);
const remoteDesktopAppCatalogMigrationKeys = [
  'git-manager',
  'web-server-manager',
  'mongo',
  'search-cluster',
  'message-queue',
  's3-browser',
];
const remoteDesktopSortModes = new Set(['custom', 'name-asc', 'name-desc']);
const defaultIdentityFileNames = ['id_ed25519', 'id_ecdsa', 'id_rsa', 'id_dsa'];
const remoteSystemTypeChoices = new Set([
  'unknown',
  'windows',
  'macos',
  'ubuntu',
  'debian',
  'redhat',
  'centos',
  'fedora',
  'rocky',
  'almalinux',
  'oracle',
  'amazon',
  'arch',
  'manjaro',
  'alpine',
  'opensuse',
  'linuxmint',
  'kali',
  'raspbian',
  'gentoo',
  'nixos',
  'popos',
  'elementary',
  'linux',
  'unix',
]);
module.exports = {
  accentColorChoices,
  aiApiFormatChoices,
  aiProviderChoices,
  bookmarkScopePrefix,
  configBundleFormat,
  configBundleVersion,
  configFileName,
  configStoreFormat,
  defaultAiApiBaseUrls,
  defaultIdentityFileNames,
  logFileName,
  maxAiApiBaseUrlLength,
  maxAiApiKeyLength,
  maxAiModelNameLength,
  maxAiProviderNameLength,
  maxConfigImportBytes,
  maxConfigStoreBytes,
  maxDesktopWallpaperBytes,
  maxDesktopWallpaperDataUrlLength,
  maxLogEntries,
  maxPrivateKeyBytes,
  maxRemoteCommandInputLength,
  maxRemoteCommandLength,
  maxRemoteTextFileBytes,
  maxRemoteTextWriteBytes,
  maxVaultBytes,
  remoteDesktopAppCatalogMigrationKeys,
  remoteDesktopAppCatalogVersion,
  remoteDesktopAppKeys,
  remoteDesktopAppKeySet,
  remoteDesktopSortModes,
  remoteSystemTypeChoices,
  terminalCursorInactiveStyleChoices,
  terminalThemeChoices,
  vaultFileName,
  vaultFormat,
  vaultSchemaVersion,
};

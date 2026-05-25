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
const terminalFontFamilyChoices = [
  'Cascadia Mono',
  'JetBrains Mono',
  'Fira Code',
  'Consolas',
  'LXGW WenKai Mono',
  'Source Code Pro',
  'Hack',
  'Menlo',
  'Monaco',
  'Courier New',
];
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
  'network-diagnostics',
  'disk-analyzer',
  'package-manager',
  'scheduled-tasks',
  'postgres',
  'security-audit',
  'login-sessions',
  'api-debugger',
  'procmanager',
  'settings',
  'sqlite',
];
const remoteDesktopAppKeySet = new Set(remoteDesktopAppKeys);
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
const uiFontChoices = [
  'LXGW WenKai Mono',
  'Microsoft YaHei UI',
  'DengXian',
  'SimSun',
  'Arial',
  'Verdana',
  'Georgia',
  'Times New Roman',
];

module.exports = {
  accentColorChoices,
  bookmarkScopePrefix,
  configBundleFormat,
  configBundleVersion,
  configFileName,
  configStoreFormat,
  defaultIdentityFileNames,
  logFileName,
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
  remoteDesktopAppKeys,
  remoteDesktopAppKeySet,
  remoteDesktopSortModes,
  remoteSystemTypeChoices,
  terminalCursorInactiveStyleChoices,
  terminalFontFamilyChoices,
  terminalThemeChoices,
  uiFontChoices,
  vaultFileName,
  vaultFormat,
  vaultSchemaVersion,
};

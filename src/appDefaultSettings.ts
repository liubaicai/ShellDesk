import { getSystemLanguage, type AppLanguage } from './i18n';
import { createDefaultRemoteDesktopLayout } from './remoteDesktopLayout';
import { cloneDefaultTerminalHighlightRules } from './terminalHighlightRules';
import { readPreloadThemePreference } from './theme/appearance';

function createDefaultTerminalSnippets(language: AppLanguage): ShellDeskTerminalSnippet[] {
  const isChinese = language === 'zh-CN';
  const timestamp = '2026-01-01T00:00:00.000Z';
  const group = isChinese ? '常用巡检' : 'Common Checks';
  const snippets = isChinese
    ? [
        ['system-overview', '系统概览', 'uname -a && uptime'],
        ['disk-usage', '磁盘占用', 'df -h'],
        ['memory-usage', '内存占用', 'free -h'],
        ['listening-ports', '监听端口', 'ss -tulpen || netstat -tulpen'],
        ['recent-logins', '最近登录', 'last -a | head -20'],
      ]
    : [
        ['system-overview', 'System overview', 'uname -a && uptime'],
        ['disk-usage', 'Disk usage', 'df -h'],
        ['memory-usage', 'Memory usage', 'free -h'],
        ['listening-ports', 'Listening ports', 'ss -tulpen || netstat -tulpen'],
        ['recent-logins', 'Recent logins', 'last -a | head -20'],
      ];

  return snippets.map(([id, label, command]) => ({
    id: `builtin:${id}`,
    label,
    command,
    group,
    language: 'bash',
    shortcut: '',
    createdAt: timestamp,
    updatedAt: timestamp,
  }));
}

const defaultAppLanguage = getSystemLanguage();

// Rust vault.rs::default_settings() is authoritative. This is the synchronized
// preview/startup fallback checked by scripts/check-default-settings-parity.cjs.
export const defaultAppSettings: ShellDeskAppSettings = {
  language: defaultAppLanguage,
  interfaceFont: 'Microsoft YaHei UI',
  theme: 'dark',
  accentColor: '#0f6bff',
  defaultHostView: 'grid',
  minimizeToTrayOnClose: false,
  minimizeToTrayPromptedOnClose: false,
  autoUpdateEnabled: true,
  desktopWallpaperMode: 'preset',
  desktopWallpaperPresetId: 'default',
  desktopWallpaperDataUrl: '',
  desktopWallpaperName: '',
  remoteDesktopDockPosition: 'bottom',
  remoteDesktopDockSize: 'medium',
  remoteDesktopDockAutoHide: 'never',
  remoteDesktopDockPinnedApps: ['files', 'terminal', 'browser'],
  remoteDesktopLayout: createDefaultRemoteDesktopLayout(),
  rememberPasswords: true,
  rememberKeyPassphrases: true,
  sshConnectTimeoutSeconds: 15,
  sftpDefaultLocalDirectory: '/',
  sftpDefaultRemoteDirectory: '.',
  sftpLocalColumns: ['name', 'size', 'type', 'modifiedAt'],
  sftpRemoteColumns: ['name', 'size', 'permissions', 'modifiedAt'],
  aiProvider: 'openai',
  aiProviderName: 'OpenAI',
  aiApiFormat: 'openai',
  aiApiBaseUrl: 'https://api.openai.com/v1',
  aiApiKey: '',
  aiModel: '',
  mcpServerEnabled: false,
  webSearchEnabled: false,
  webSearchProvider: 'tavily',
  webSearchApiKey: '',
  webSearchApiBaseUrl: 'https://api.tavily.com',
  webSearchMaxResults: 5,
  terminalFontSize: 13,
  terminalTermType: 'xterm-256color',
  terminalFontFamily: 'Cascadia Mono',
  terminalFontWeight: 400,
  terminalFontWeightBold: 700,
  terminalLigatures: true,
  terminalFontLigatures: true,
  terminalLineHeight: 1.2,
  terminalTheme: 'shelldesk-dark',
  terminalCursorBlink: true,
  terminalCursorStyle: 'block',
  terminalCursorInactiveStyle: 'outline',
  terminalDrawBoldInBrightColors: true,
  terminalCursorLineHighlight: false,
  terminalScrollback: 10000,
  terminalSmoothScrolling: true,
  terminalScrollOnOutput: true,
  terminalScrollSensitivity: 1,
  terminalFastScrollSensitivity: 5,
  terminalScrollOnUserInput: true,
  terminalScrollOnEraseInDisplay: true,
  terminalCopyOnSelect: true,
  terminalRightClickPaste: true,
  terminalAltClickMovesCursor: true,
  terminalBracketedPasteMode: true,
  terminalWordSeparators: ' ()[]{}\'"`,;:@$=<>|&',
  terminalLinkModifier: 'ctrl',
  terminalOptionArrowWordJump: true,
  terminalShiftEnterNewlineEnabled: true,
  terminalShiftEnterNewlineText: '\\n',
  terminalMiddleClickBehavior: 'paste',
  terminalNormalizeCopiedText: true,
  terminalMinimumContrastRatio: 1,
  terminalScreenReaderMode: false,
  terminalPreferTmux: false,
  terminalRestoreWorkspace: true,
  terminalExitPolicy: 'keep-open',
  terminalDynamicTitle: 'tmux',
  terminalLineTimestamps: false,
  terminalKeywordHighlightEnabled: false,
  terminalHighlightKeywords: 'error,warning,failed,denied,exception',
  terminalHighlightRules: cloneDefaultTerminalHighlightRules(),
  terminalCommandAutocompleteEnabled: true,
  terminalRemotePathAutocompleteEnabled: true,
  terminalSftpFollowCwd: false,
  terminalContextMenuInAlternateScreen: false,
  terminalSafeLinksEnabled: true,
  terminalOsc52Mode: 'off',
  terminalClearWipesScrollback: false,
  terminalSuspendRenderingWhenHidden: true,
  terminalRenderer: 'auto',
  terminalHibernateEnabled: true,
  terminalHibernateDelaySeconds: 120,
  terminalDropUploadEnabled: true,
  terminalKittyKeyboardEnabled: true,
  terminalInlineImagesEnabled: false,
  terminalSessionLogFormat: 'text',
  terminalSnippets: createDefaultTerminalSnippets(defaultAppLanguage),
};

export function createInitialAppSettings(): ShellDeskAppSettings {
  return {
    ...defaultAppSettings,
    theme: readPreloadThemePreference(),
  };
}

export async function fetchBackendDefaults(): Promise<Partial<ShellDeskAppSettings>> {
  try {
    const result = await window.guiSSH?.vault.getDefaultSettings();
    return result && typeof result === 'object' && !Array.isArray(result) ? result : {};
  } catch {
    return {};
  }
}

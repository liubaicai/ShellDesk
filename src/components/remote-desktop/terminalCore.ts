import { type ISearchOptions } from '@xterm/addon-search';
import { type ITerminalOptions, type IWindowsPty, Terminal as XTerminal } from '@xterm/xterm';

import { isWindowsSystem } from './remoteSystem';
import {
  buildTerminalFontStack,
  getTerminalTheme,
  toTerminalFontWeight,
} from './terminalPresets';
import type { RemoteTerminalChromePayload, RemoteTerminalLaunchOptions, RemoteTerminalSessionStatus } from './terminalTypes';
import type { RemoteSystemType } from './types';
import { t } from '../../i18n';

export const terminalSearchOptions: ISearchOptions = {
  decorations: {
    matchBackground: '#2d5d76',
    matchOverviewRuler: '#43c7ff',
    activeMatchBackground: '#77f4c5',
    activeMatchColorOverviewRuler: '#77f4c5',
  },
};

export const sftpProbeCacheMs = 30000;
export const terminalCwdProbeTimeoutMs = 6000;
export const terminalCwdProbeBufferLimit = 12000;

export function isWindowsClientPlatform() {
  if (typeof navigator === 'undefined') {
    return false;
  }

  return /windows|win32|win64/i.test(navigator.userAgent || navigator.platform || '');
}

export function getLocalWindowsPtyOption(enabled: boolean): IWindowsPty | undefined {
  return enabled && isWindowsClientPlatform() ? { backend: 'conpty' } : undefined;
}

export function buildTerminalOptions(settings: ShellDeskAppSettings, windowsPty?: IWindowsPty): ITerminalOptions {
  return {
    allowProposedApi: true,
    allowTransparency: true,
    altClickMovesCursor: settings.terminalAltClickMovesCursor,
    cursorBlink: settings.terminalCursorBlink,
    cursorInactiveStyle: settings.terminalCursorInactiveStyle,
    cursorStyle: settings.terminalCursorStyle,
    customGlyphs: true,
    drawBoldTextInBrightColors: settings.terminalDrawBoldInBrightColors,
    fontFamily: buildTerminalFontStack(settings.terminalFontFamily),
    fontSize: settings.terminalFontSize,
    fontWeight: toTerminalFontWeight(settings.terminalFontWeight),
    fontWeightBold: toTerminalFontWeight(settings.terminalFontWeightBold),
    ignoreBracketedPasteMode: !settings.terminalBracketedPasteMode,
    lineHeight: settings.terminalLineHeight,
    minimumContrastRatio: settings.terminalMinimumContrastRatio,
    rescaleOverlappingGlyphs: true,
    screenReaderMode: settings.terminalScreenReaderMode,
    smoothScrollDuration: settings.terminalSmoothScrolling ? 100 : 0,
    scrollback: settings.terminalScrollback,
    scrollOnEraseInDisplay: settings.terminalScrollOnEraseInDisplay,
    scrollOnUserInput: settings.terminalScrollOnUserInput,
    scrollSensitivity: settings.terminalScrollSensitivity,
    fastScrollSensitivity: settings.terminalFastScrollSensitivity,
    wordSeparator: settings.terminalWordSeparators,
    ...(windowsPty ? { windowsPty } : {}),
    theme: { ...getTerminalTheme(settings.terminalTheme) },
  };
}

export function applyTerminalOptions(terminal: XTerminal, settings: ShellDeskAppSettings, windowsPty?: IWindowsPty) {
  const { allowTransparency: _allowTransparency, ...terminalOptions } = buildTerminalOptions(settings, windowsPty);
  terminal.options = terminalOptions;
}

export function getTerminalSessionTitle(terminalId: string, options?: RemoteTerminalLaunchOptions) {
  const configuredTitle = options?.title?.trim();

  if (configuredTitle) {
    return configuredTitle;
  }

  const workingDirectory = options?.workingDirectory?.trim();

  if (workingDirectory) {
    return workingDirectory;
  }

  return terminalId;
}

export function getTerminalStatusLabel(
  status: RemoteTerminalSessionStatus,
  hasError: boolean,
  language: ShellDeskAppSettings['language'],
) {
  if (status === 'running') {
    return t('terminal.status.running', language);
  }

  if (status === 'disconnected') {
    return t('terminal.status.disconnected', language);
  }

  if (status === 'exited') {
    return hasError ? t('terminal.status.startFailed', language) : t('terminal.status.exited', language);
  }

  return t('terminal.status.starting', language);
}

export function getTerminalChromeTone(
  status: RemoteTerminalSessionStatus,
  hasError: boolean,
): RemoteTerminalChromePayload['tone'] {
  if (status === 'idle') {
    return 'loading';
  }

  if (status === 'running' && !hasError) {
    return 'idle';
  }

  return 'error';
}

export function getShellChoices(systemType?: RemoteSystemType) {
  return isWindowsSystem(systemType)
    ? ['', 'powershell', 'pwsh', 'cmd']
    : ['', 'bash', 'zsh', 'fish', 'sh'];
}

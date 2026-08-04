import type { MessageId } from '../../i18n';

export type TerminalQuickBooleanField = {
  [Field in keyof ShellDeskAppSettings]: ShellDeskAppSettings[Field] extends boolean ? Field : never
}[keyof ShellDeskAppSettings];

export interface TerminalQuickSettingItem {
  field: TerminalQuickBooleanField;
  labelId: MessageId;
  summaryId: MessageId;
  dependsOn?: TerminalQuickBooleanField;
  action?: 'highlight-rules';
}

export interface TerminalQuickSettingGroup {
  id: 'quick' | 'features' | 'performance';
  labelId: MessageId;
  summaryId: MessageId;
  items: readonly TerminalQuickSettingItem[];
}

export const terminalQuickSettingGroups: readonly TerminalQuickSettingGroup[] = [
  {
    id: 'quick',
    labelId: 'terminal.settingsDialog.group.quick',
    summaryId: 'terminal.settingsDialog.group.quick.summary',
    items: [
      { field: 'terminalCopyOnSelect', labelId: 'settings.terminal.copyOnSelect.label', summaryId: 'settings.terminal.copyOnSelect.summary' },
      { field: 'terminalRightClickPaste', labelId: 'settings.terminal.rightClickPaste.label', summaryId: 'settings.terminal.rightClickPaste.summary' },
      { field: 'terminalCursorBlink', labelId: 'settings.terminal.cursorBlink.label', summaryId: 'settings.terminal.cursorBlink.summary' },
      { field: 'terminalLineTimestamps', labelId: 'settings.terminal.timestamps.label', summaryId: 'settings.terminal.timestamps.summary' },
    ],
  },
  {
    id: 'features',
    labelId: 'terminal.settingsDialog.group.features',
    summaryId: 'terminal.settingsDialog.group.features.summary',
    items: [
      { field: 'terminalKeywordHighlightEnabled', labelId: 'settings.terminal.keywordHighlight.label', summaryId: 'settings.terminal.keywordHighlight.summary', action: 'highlight-rules' },
      { field: 'terminalSafeLinksEnabled', labelId: 'settings.terminal.safeLinks.label', summaryId: 'settings.terminal.safeLinks.summary' },
      { field: 'terminalDropUploadEnabled', labelId: 'settings.terminal.dropUpload.label', summaryId: 'settings.terminal.dropUpload.summary' },
      { field: 'terminalSftpFollowCwd', labelId: 'settings.terminal.sftpFollowCwd.label', summaryId: 'settings.terminal.sftpFollowCwd.summary' },
    ],
  },
  {
    id: 'performance',
    labelId: 'terminal.settingsDialog.group.performance',
    summaryId: 'terminal.settingsDialog.group.performance.summary',
    items: [
      { field: 'terminalSuspendRenderingWhenHidden', labelId: 'settings.terminal.suspendHidden.label', summaryId: 'settings.terminal.suspendHidden.summary' },
      { field: 'terminalHibernateEnabled', labelId: 'settings.terminal.hibernate.label', summaryId: 'settings.terminal.hibernate.summary', dependsOn: 'terminalSuspendRenderingWhenHidden' },
      { field: 'terminalContextMenuInAlternateScreen', labelId: 'settings.terminal.fullscreenContextMenu.label', summaryId: 'settings.terminal.fullscreenContextMenu.summary' },
      { field: 'terminalKittyKeyboardEnabled', labelId: 'settings.terminal.kittyKeyboard.label', summaryId: 'settings.terminal.kittyKeyboard.summary' },
      { field: 'terminalInlineImagesEnabled', labelId: 'settings.terminal.inlineImages.label', summaryId: 'settings.terminal.inlineImages.summary' },
    ],
  },
] as const;

import type { FormEvent } from 'react';
import { createPortal } from 'react-dom';

import { getShellDeskLocale } from './desktopUtils';
import { isWindowsSystem } from './remoteSystem';
import { formatTroubleshootingSnippet } from './terminalCommands';
import { terminalThemeChoices } from './terminalPresets';
import type { TerminalContextMenuState, TerminalLaunchDraft } from './terminalTypes';
import type { RemoteSystemType } from './types';
import { t } from '../../i18n';

interface TerminalContextMenuPortalProps {
  contextMenu: TerminalContextMenuState | null;
  language: ShellDeskAppSettings['language'];
  onClose: () => void;
  onCopy: (text: string) => void;
  onOpenNote?: (note: { title: string; content: string }) => void;
}

export function TerminalContextMenuPortal({
  contextMenu,
  language,
  onClose,
  onCopy,
  onOpenNote,
}: TerminalContextMenuPortalProps) {
  if (!contextMenu) {
    return null;
  }

  return createPortal(
    <>
      <div className="context-menu-overlay" onClick={onClose} onContextMenu={(event) => { event.preventDefault(); onClose(); }} />
      <div className="context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} role="menu">
        <button type="button" role="menuitem" onClick={() => { onCopy(contextMenu.selection); onClose(); }}>
          {t('terminal.context.copy', language)}
        </button>
        <button type="button" role="menuitem" onClick={() => { onCopy(formatTroubleshootingSnippet(contextMenu.selection)); onClose(); }}>
          {t('terminal.context.copyTroubleshooting', language)}
        </button>
        {onOpenNote ? (
          <button type="button" role="menuitem" onClick={() => {
            onOpenNote({
              title: t('terminal.context.snippetTitle', language, { time: new Date().toLocaleTimeString(getShellDeskLocale()) }),
              content: contextMenu.selection,
            });
            onClose();
          }}>
            {t('terminal.context.sendToNotepad', language)}
          </button>
        ) : null}
      </div>
    </>,
    document.body,
  );
}

interface TerminalLaunchDialogPortalProps {
  isOpen: boolean;
  settings: ShellDeskAppSettings;
  launchDraft: TerminalLaunchDraft;
  shellChoices: string[];
  systemType?: RemoteSystemType;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onDraftChange: (draft: TerminalLaunchDraft) => void;
}

export function TerminalLaunchDialogPortal({
  isOpen,
  settings,
  launchDraft,
  shellChoices,
  systemType,
  onClose,
  onSubmit,
  onDraftChange,
}: TerminalLaunchDialogPortalProps) {
  if (!isOpen) {
    return null;
  }

  return createPortal(
    <div className="notepad-modal-overlay" role="presentation" onClick={onClose}>
      <form className="notepad-modal terminal-launch-dialog" onSubmit={onSubmit} onClick={(event) => event.stopPropagation()}>
        <div className="notepad-modal-title">{t('terminal.launch.title', settings.language)}</div>
        <label>
          <span>{t('terminal.launch.fieldTitle', settings.language)}</span>
          <input
            className="notepad-modal-input"
            value={launchDraft.title}
            onChange={(event) => onDraftChange({ ...launchDraft, title: event.target.value })}
            placeholder="SSH Shell"
          />
        </label>
        <label>
          <span>Shell</span>
          <select
            className="notepad-modal-input"
            value={launchDraft.shell}
            onChange={(event) => onDraftChange({ ...launchDraft, shell: event.target.value })}
          >
            {shellChoices.map((shellChoice) => (
              <option key={shellChoice || 'default'} value={shellChoice}>
                {shellChoice || t('terminal.launch.defaultShell', settings.language)}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>{t('terminal.launch.workingDirectory', settings.language)}</span>
          <input
            className="notepad-modal-input"
            value={launchDraft.workingDirectory}
            onChange={(event) => onDraftChange({ ...launchDraft, workingDirectory: event.target.value })}
            placeholder={isWindowsSystem(systemType) ? 'C:/Users' : '/srv/app'}
          />
        </label>
        <label>
          <span>{t('terminal.launch.initialCommand', settings.language)}</span>
          <textarea
            value={launchDraft.initialCommand}
            onChange={(event) => onDraftChange({ ...launchDraft, initialCommand: event.target.value })}
            placeholder="uname -a"
          />
        </label>
        <div className="notepad-modal-actions">
          <button type="button" className="notepad-modal-btn" onClick={onClose}>{t('common.cancel', settings.language)}</button>
          <button type="submit" className="notepad-modal-btn primary">{t('common.open', settings.language)}</button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

interface TerminalSettingsDialogPortalProps {
  isOpen: boolean;
  settings: ShellDeskAppSettings;
  onClose: () => void;
  onSettingChange: <Field extends keyof ShellDeskAppSettings>(field: Field, value: ShellDeskAppSettings[Field]) => void;
}

export function TerminalSettingsDialogPortal({
  isOpen,
  settings,
  onClose,
  onSettingChange,
}: TerminalSettingsDialogPortalProps) {
  if (!isOpen) {
    return null;
  }

  return createPortal(
    <div className="notepad-modal-overlay" role="presentation" onClick={onClose}>
      <div className="notepad-modal terminal-settings-dialog" onClick={(event) => event.stopPropagation()}>
        <div className="notepad-modal-title">{t('terminal.settingsDialog.title', settings.language)}</div>
        <label>
          <span>{t('terminal.settingsDialog.colorTheme', settings.language)}</span>
          <select
            className="notepad-modal-input"
            value={settings.terminalTheme}
            onChange={(event) => onSettingChange('terminalTheme', event.target.value as ShellDeskAppSettings['terminalTheme'])}
          >
            {terminalThemeChoices.map((themeChoice) => (
              <option key={themeChoice.key} value={themeChoice.key}>{t(themeChoice.labelId, settings.language)}</option>
            ))}
          </select>
        </label>
        <label>
          <span>{t('terminal.settingsDialog.fontSize', settings.language)}</span>
          <select
            className="notepad-modal-input"
            value={settings.terminalFontSize}
            onChange={(event) => onSettingChange('terminalFontSize', Number(event.target.value))}
          >
            {[11, 12, 13, 14, 15, 16, 18, 20].map((fontSize) => (
              <option key={fontSize} value={fontSize}>{fontSize}px</option>
            ))}
          </select>
        </label>
        <div className="terminal-settings-toggles">
          <label>
            <span>{t('terminal.settingsDialog.copyOnSelect', settings.language)}</span>
            <input
              type="checkbox"
              checked={settings.terminalCopyOnSelect}
              onChange={(event) => onSettingChange('terminalCopyOnSelect', event.target.checked)}
            />
          </label>
          <label>
            <span>{t('terminal.settingsDialog.rightClickPaste', settings.language)}</span>
            <input
              type="checkbox"
              checked={settings.terminalRightClickPaste}
              onChange={(event) => onSettingChange('terminalRightClickPaste', event.target.checked)}
            />
          </label>
          <label>
            <span>{t('terminal.settingsDialog.cursorBlink', settings.language)}</span>
            <input
              type="checkbox"
              checked={settings.terminalCursorBlink}
              onChange={(event) => onSettingChange('terminalCursorBlink', event.target.checked)}
            />
          </label>
          <label>
            <span>{t('settings.terminal.timestamps.label', settings.language)}</span>
            <input
              type="checkbox"
              checked={settings.terminalLineTimestamps}
              onChange={(event) => onSettingChange('terminalLineTimestamps', event.target.checked)}
            />
          </label>
          <label>
            <span>{t('settings.terminal.keywordHighlight.label', settings.language)}</span>
            <input
              type="checkbox"
              checked={settings.terminalKeywordHighlightEnabled}
              onChange={(event) => onSettingChange('terminalKeywordHighlightEnabled', event.target.checked)}
            />
          </label>
        </div>
        <label>
          <span>{t('settings.terminal.highlightKeywords.label', settings.language)}</span>
          <input
            className="notepad-modal-input"
            value={settings.terminalHighlightKeywords}
            disabled={!settings.terminalKeywordHighlightEnabled}
            onChange={(event) => onSettingChange('terminalHighlightKeywords', event.target.value)}
          />
        </label>
        <div className="notepad-modal-actions">
          <button type="button" className="notepad-modal-btn primary" onClick={onClose}>{t('terminal.settingsDialog.done', settings.language)}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

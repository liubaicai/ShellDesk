import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';

import { getShellDeskLocale } from './desktopUtils';
import { isWindowsSystem } from './remoteSystem';
import { formatTroubleshootingSnippet } from './terminalCommands';
import { terminalThemeChoices } from './terminalPresets';
import { terminalQuickSettingGroups, type TerminalQuickBooleanField } from './terminalQuickSettings';
import type { TerminalContextMenuState, TerminalLaunchDraft } from './terminalTypes';
import type { RemoteSystemType } from './types';
import { isSafeTerminalHighlightPattern } from '../../terminalHighlightRules';
import { t } from '../../i18n';

interface TerminalContextMenuPortalProps {
  contextMenu: TerminalContextMenuState | null;
  language: ShellDeskAppSettings['language'];
  onClose: () => void;
  onCopy: (text: string) => void;
  onPaste: () => void;
  onSelectionAi?: (selection: string, action: 'explain' | 'fix') => void;
  onOpenNote?: (note: { title: string; content: string }) => void;
}

export function TerminalContextMenuPortal({
  contextMenu,
  language,
  onClose,
  onCopy,
  onPaste,
  onSelectionAi,
  onOpenNote,
}: TerminalContextMenuPortalProps) {
  if (!contextMenu) {
    return null;
  }

  return createPortal(
    <>
      <div className="context-menu-overlay" onClick={onClose} onContextMenu={(event) => { event.preventDefault(); onClose(); }} />
      <div className="context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} role="menu">
        {contextMenu.selection ? (
          <>
            <button type="button" role="menuitem" onClick={() => { onCopy(contextMenu.selection); onClose(); }}>
              {t('terminal.context.copy', language)}
            </button>
            <button type="button" role="menuitem" onClick={() => { onCopy(formatTroubleshootingSnippet(contextMenu.selection)); onClose(); }}>
              {t('terminal.context.copyTroubleshooting', language)}
            </button>
          </>
        ) : (
          <button type="button" role="menuitem" onClick={() => { onPaste(); onClose(); }}>
            {t('terminal.context.paste', language)}
          </button>
        )}
        {onOpenNote && contextMenu.selection ? (
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
        {onSelectionAi && contextMenu.selection ? (
          <>
            <div className="context-menu-sep" />
            <button type="button" role="menuitem" onClick={() => { onSelectionAi(contextMenu.selection, 'explain'); onClose(); }}>
              {t('terminal.context.explainWithAi', language)}
            </button>
            <button type="button" role="menuitem" onClick={() => { onSelectionAi(contextMenu.selection, 'fix'); onClose(); }}>
              {t('terminal.context.fixWithAi', language)}
            </button>
          </>
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
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({
    quick: true,
    features: true,
    performance: false,
  });
  const [showHighlightRules, setShowHighlightRules] = useState(false);

  useEffect(() => {
    if (!isOpen) return undefined;
    const animationFrame = window.requestAnimationFrame(() => {
      dialogRef.current?.querySelector<HTMLElement>('button, select, input')?.focus();
    });
    return () => window.cancelAnimationFrame(animationFrame);
  }, [isOpen]);

  if (!isOpen) {
    return null;
  }

  const updateBooleanSetting = (field: TerminalQuickBooleanField, value: boolean) => {
    onSettingChange(field, value as ShellDeskAppSettings[typeof field]);
  };
  const updateHighlightRule = (ruleId: string, patch: Partial<ShellDeskTerminalHighlightRule>) => {
    onSettingChange('terminalHighlightRules', settings.terminalHighlightRules.map((rule) => (
      rule.id === ruleId ? { ...rule, ...patch, builtin: false } : rule
    )));
  };
  const removeHighlightRule = (ruleId: string) => {
    onSettingChange('terminalHighlightRules', settings.terminalHighlightRules.filter((rule) => rule.id !== ruleId));
  };
  const addHighlightRule = () => {
    const id = `rule:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    onSettingChange('terminalHighlightRules', [
      ...settings.terminalHighlightRules,
      {
        id,
        label: t('terminal.settingsDialog.rules.newRule', settings.language),
        pattern: 'keyword',
        mode: 'literal',
        foreground: '#fff2a8',
        background: '#6a4f12',
        enabled: true,
      },
    ]);
    setShowHighlightRules(true);
  };
  const handleDialogKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab' || !dialogRef.current) return;
    const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(
      'button:not([disabled]), select:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )].filter((element) => !element.hasAttribute('hidden'));
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div className="notepad-modal-overlay terminal-settings-overlay" role="presentation" onClick={onClose}>
      <div
        ref={dialogRef}
        className="notepad-modal terminal-settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="terminal-settings-dialog-title"
        onKeyDown={handleDialogKeyDown}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="terminal-settings-header">
          <span>
            <strong id="terminal-settings-dialog-title">{t('terminal.settingsDialog.title', settings.language)}</strong>
            <small>{t('terminal.settingsDialog.summary', settings.language)}</small>
          </span>
          <button type="button" aria-label={t('common.close', settings.language)} onClick={onClose}>×</button>
        </header>
        <div className="terminal-settings-scroll">
          <section className="terminal-settings-section is-open">
            <div className="terminal-settings-section-title">
              <span>
                <strong>{t('terminal.settingsDialog.appearance', settings.language)}</strong>
                <small>{t('terminal.settingsDialog.appearance.summary', settings.language)}</small>
              </span>
            </div>
            <div className="terminal-settings-select-grid">
              <label>
                <span>{t('terminal.settingsDialog.colorTheme', settings.language)}</span>
                <select value={settings.terminalTheme} onChange={(event) => onSettingChange('terminalTheme', event.target.value as ShellDeskAppSettings['terminalTheme'])}>
                  {terminalThemeChoices.map((themeChoice) => (
                    <option key={themeChoice.key} value={themeChoice.key}>{t(themeChoice.labelId, settings.language)}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>{t('terminal.settingsDialog.fontSize', settings.language)}</span>
                <select value={settings.terminalFontSize} onChange={(event) => onSettingChange('terminalFontSize', Number(event.target.value))}>
                  {[11, 12, 13, 14, 15, 16, 18, 20].map((fontSize) => (
                    <option key={fontSize} value={fontSize}>{fontSize}px</option>
                  ))}
                </select>
              </label>
            </div>
          </section>

          {terminalQuickSettingGroups.map((group) => {
            const expanded = expandedGroups[group.id] !== false;
            return (
              <section key={group.id} className={`terminal-settings-section ${expanded ? 'is-open' : ''}`}>
                <button
                  type="button"
                  className="terminal-settings-section-title"
                  aria-expanded={expanded}
                  onClick={() => setExpandedGroups((current) => ({ ...current, [group.id]: !expanded }))}
                >
                  <span>
                    <strong>{t(group.labelId, settings.language)}</strong>
                    <small>{t(group.summaryId, settings.language)}</small>
                  </span>
                  <span aria-hidden="true">⌄</span>
                </button>
                {expanded ? (
                  <div className="terminal-settings-rows">
                    {group.id === 'performance' ? (
                      <label className="terminal-settings-row terminal-settings-select-row">
                        <span>
                          <strong>{t('settings.terminal.renderer.label', settings.language)}</strong>
                          <small>{t('settings.terminal.renderer.summary', settings.language)}</small>
                        </span>
                        <select value={settings.terminalRenderer} onChange={(event) => onSettingChange('terminalRenderer', event.target.value as ShellDeskAppSettings['terminalRenderer'])}>
                          <option value="auto">{t('settings.terminal.renderer.auto', settings.language)}</option>
                          <option value="dom">{t('settings.terminal.renderer.dom', settings.language)}</option>
                          <option value="webgl">WebGL</option>
                        </select>
                      </label>
                    ) : null}
                    {group.items.map((item) => {
                      const disabled = item.dependsOn ? !settings[item.dependsOn] : false;
                      return (
                        <div key={item.field} className={`terminal-settings-row ${item.dependsOn ? 'is-dependent' : ''} ${disabled ? 'is-disabled' : ''}`}>
                          <span>
                            <strong>{t(item.labelId, settings.language)}</strong>
                            <small>{t(item.summaryId, settings.language)}</small>
                            {item.action === 'highlight-rules' && settings.terminalKeywordHighlightEnabled ? (
                              <button type="button" className="terminal-settings-inline-action" onClick={() => setShowHighlightRules((current) => !current)}>
                                {t('terminal.settingsDialog.rules.manage', settings.language, { count: settings.terminalHighlightRules.length })}
                              </button>
                            ) : null}
                          </span>
                          <button
                            type="button"
                            className={`terminal-settings-switch ${settings[item.field] ? 'is-on' : ''}`}
                            role="switch"
                            aria-checked={Boolean(settings[item.field])}
                            aria-label={t(item.labelId, settings.language)}
                            disabled={disabled}
                            onClick={() => updateBooleanSetting(item.field, !settings[item.field])}
                          >
                            <span />
                          </button>
                        </div>
                      );
                    })}
                    {group.id === 'features' && showHighlightRules && settings.terminalKeywordHighlightEnabled ? (
                      <div className="terminal-highlight-rule-editor">
                        {settings.terminalHighlightRules.map((rule) => {
                          const validPattern = isSafeTerminalHighlightPattern(rule.pattern, rule.mode);
                          return <div key={rule.id} className="terminal-highlight-rule">
                            <button
                              type="button"
                              className={`terminal-settings-switch ${rule.enabled ? 'is-on' : ''}`}
                              role="switch"
                              aria-checked={rule.enabled}
                              aria-label={rule.label}
                              onClick={() => updateHighlightRule(rule.id, { enabled: !rule.enabled })}
                            ><span /></button>
                            <input value={rule.label} maxLength={80} aria-label={t('terminal.settingsDialog.rules.name', settings.language)} onChange={(event) => updateHighlightRule(rule.id, { label: event.target.value })} />
                            <select value={rule.mode} aria-label={t('terminal.settingsDialog.rules.mode', settings.language)} onChange={(event) => updateHighlightRule(rule.id, { mode: event.target.value as ShellDeskTerminalHighlightRule['mode'] })}>
                              <option value="literal">{t('terminal.settingsDialog.rules.literal', settings.language)}</option>
                              <option value="regex">Regex</option>
                            </select>
                            <input className="terminal-highlight-rule-pattern" value={rule.pattern} maxLength={512} spellCheck={false} aria-invalid={!validPattern} title={validPattern ? undefined : t('terminal.settingsDialog.rules.invalid', settings.language)} aria-label={t('terminal.settingsDialog.rules.pattern', settings.language)} onChange={(event) => updateHighlightRule(rule.id, { pattern: event.target.value })} />
                            <input type="color" value={rule.foreground} aria-label={t('terminal.settingsDialog.rules.foreground', settings.language)} onChange={(event) => updateHighlightRule(rule.id, { foreground: event.target.value })} />
                            <input type="color" value={rule.background} aria-label={t('terminal.settingsDialog.rules.background', settings.language)} onChange={(event) => updateHighlightRule(rule.id, { background: event.target.value })} />
                            <button type="button" className="terminal-highlight-rule-remove" aria-label={t('common.delete', settings.language)} onClick={() => removeHighlightRule(rule.id)}>×</button>
                          </div>
                        })}
                        <button type="button" className="terminal-settings-add-rule" onClick={addHighlightRule}>{t('terminal.settingsDialog.rules.add', settings.language)}</button>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </section>
            );
          })}
        </div>
        <div className="terminal-settings-footer">
          <small>{t('terminal.settingsDialog.savedAutomatically', settings.language)}</small>
          <button type="button" className="notepad-modal-btn primary" onClick={onClose}>{t('terminal.settingsDialog.done', settings.language)}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function TerminalLinkDialogPortal({
  link,
  language,
  onCancel,
  onOpen,
}: {
  link: string;
  language: ShellDeskAppSettings['language'];
  onCancel: () => void;
  onOpen: () => void;
}) {
  if (!link) {
    return null;
  }

  return createPortal(
    <div className="notepad-modal-overlay" role="presentation" onClick={onCancel}>
      <div
        className="notepad-modal terminal-link-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="terminal-link-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id="terminal-link-dialog-title">{t('terminal.linkDialog.title', language)}</h3>
        <p>{t('terminal.linkDialog.summary', language)}</p>
        <code className="terminal-link-dialog-url">{link}</code>
        <div className="notepad-modal-actions">
          <button type="button" className="notepad-modal-btn" onClick={onCancel}>
            {t('common.cancel', language)}
          </button>
          <button type="button" className="notepad-modal-btn primary" onClick={onOpen}>
            {t('terminal.linkDialog.open', language)}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function TerminalOsc52ReadDialogPortal({
  open,
  language,
  onCancel,
  onAllow,
}: {
  open: boolean;
  language: ShellDeskAppSettings['language'];
  onCancel: () => void;
  onAllow: () => void;
}) {
  if (!open) return null;
  return createPortal(
    <div className="notepad-modal-overlay" role="presentation" onClick={onCancel}>
      <div className="notepad-modal terminal-link-dialog" role="alertdialog" aria-modal="true" aria-labelledby="terminal-osc52-dialog-title" onClick={(event) => event.stopPropagation()}>
        <h3 id="terminal-osc52-dialog-title">{t('terminal.osc52Dialog.title', language)}</h3>
        <p>{t('terminal.osc52Dialog.summary', language)}</p>
        <div className="notepad-modal-actions">
          <button type="button" className="notepad-modal-btn" onClick={onCancel}>{t('common.cancel', language)}</button>
          <button type="button" className="notepad-modal-btn primary" onClick={onAllow}>{t('terminal.osc52Dialog.allow', language)}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

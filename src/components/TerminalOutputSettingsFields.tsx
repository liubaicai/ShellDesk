import { t } from '../i18n';
import { isSafeTerminalHighlightPattern } from '../terminalHighlightRules';

interface TerminalOutputSettingsFieldsProps {
  settings: Pick<
    ShellDeskAppSettings,
    | 'language'
    | 'terminalSftpFollowCwd'
    | 'terminalContextMenuInAlternateScreen'
    | 'terminalHighlightKeywords'
    | 'terminalHighlightRules'
    | 'terminalKeywordHighlightEnabled'
    | 'terminalLineTimestamps'
    | 'terminalSafeLinksEnabled'
    | 'terminalSuspendRenderingWhenHidden'
    | 'terminalRenderer'
    | 'terminalHibernateEnabled'
    | 'terminalHibernateDelaySeconds'
    | 'terminalDropUploadEnabled'
    | 'terminalKittyKeyboardEnabled'
    | 'terminalInlineImagesEnabled'
    | 'terminalSessionLogFormat'
  >;
  onChange: (patch: Partial<ShellDeskAppSettings>) => void;
}

export function TerminalOutputSettingsFields({ settings, onChange }: TerminalOutputSettingsFieldsProps) {
  return (
    <section className="settings-section">
      <h2>{t('settings.terminal.output.title', settings.language)}</h2>
      <div className="settings-card">
        <label className="settings-row">
          <span>
            <strong>{t('settings.terminal.timestamps.label', settings.language)}</strong>
            <small>{t('settings.terminal.timestamps.summary', settings.language)}</small>
          </span>
          <input
            className="settings-toggle"
            type="checkbox"
            checked={settings.terminalLineTimestamps}
            onChange={(event) => onChange({ terminalLineTimestamps: event.target.checked })}
          />
        </label>
        <label className="settings-row">
          <span>
            <strong>{t('settings.terminal.renderer.label', settings.language)}</strong>
            <small>{t('settings.terminal.renderer.summary', settings.language)}</small>
          </span>
          <select value={settings.terminalRenderer} onChange={(event) => onChange({ terminalRenderer: event.target.value as ShellDeskAppSettings['terminalRenderer'] })}>
            <option value="auto">{t('settings.terminal.renderer.auto', settings.language)}</option>
            <option value="dom">{t('settings.terminal.renderer.dom', settings.language)}</option>
            <option value="webgl">WebGL</option>
          </select>
        </label>
        <label className="settings-row">
          <span>
            <strong>{t('settings.terminal.sftpFollowCwd.label', settings.language)}</strong>
            <small>{t('settings.terminal.sftpFollowCwd.summary', settings.language)}</small>
          </span>
          <input className="settings-toggle" type="checkbox" checked={settings.terminalSftpFollowCwd} onChange={(event) => onChange({ terminalSftpFollowCwd: event.target.checked })} />
        </label>
        <label className="settings-row">
          <span>
            <strong>{t('settings.terminal.hibernate.label', settings.language)}</strong>
            <small>{t('settings.terminal.hibernate.summary', settings.language)}</small>
          </span>
          <input className="settings-toggle" type="checkbox" checked={settings.terminalHibernateEnabled} disabled={!settings.terminalSuspendRenderingWhenHidden} onChange={(event) => onChange({ terminalHibernateEnabled: event.target.checked })} />
        </label>
        <label className="settings-row">
          <span>
            <strong>{t('settings.terminal.hibernateDelay.label', settings.language)}</strong>
            <small>{t('settings.terminal.hibernateDelay.summary', settings.language)}</small>
          </span>
          <select disabled={!settings.terminalSuspendRenderingWhenHidden || !settings.terminalHibernateEnabled} value={settings.terminalHibernateDelaySeconds} onChange={(event) => onChange({ terminalHibernateDelaySeconds: Number(event.target.value) })}>
            {[30, 60, 120, 300, 600].map((seconds) => <option key={seconds} value={seconds}>{seconds}s</option>)}
          </select>
        </label>
        <label className="settings-row">
          <span>
            <strong>{t('settings.terminal.dropUpload.label', settings.language)}</strong>
            <small>{t('settings.terminal.dropUpload.summary', settings.language)}</small>
          </span>
          <input className="settings-toggle" type="checkbox" checked={settings.terminalDropUploadEnabled} onChange={(event) => onChange({ terminalDropUploadEnabled: event.target.checked })} />
        </label>
        <label className="settings-row">
          <span>
            <strong>{t('settings.terminal.kittyKeyboard.label', settings.language)}</strong>
            <small>{t('settings.terminal.kittyKeyboard.summary', settings.language)}</small>
          </span>
          <input className="settings-toggle" type="checkbox" checked={settings.terminalKittyKeyboardEnabled} onChange={(event) => onChange({ terminalKittyKeyboardEnabled: event.target.checked })} />
        </label>
        <label className="settings-row">
          <span>
            <strong>{t('settings.terminal.inlineImages.label', settings.language)}</strong>
            <small>{t('settings.terminal.inlineImages.summary', settings.language)}</small>
          </span>
          <input className="settings-toggle" type="checkbox" checked={settings.terminalInlineImagesEnabled} onChange={(event) => onChange({ terminalInlineImagesEnabled: event.target.checked })} />
        </label>
        <label className="settings-row">
          <span>
            <strong>{t('settings.terminal.sessionLogFormat.label', settings.language)}</strong>
            <small>{t('settings.terminal.sessionLogFormat.summary', settings.language)}</small>
          </span>
          <select value={settings.terminalSessionLogFormat} onChange={(event) => onChange({ terminalSessionLogFormat: event.target.value as ShellDeskAppSettings['terminalSessionLogFormat'] })}>
            <option value="text">{t('settings.terminal.sessionLogFormat.text', settings.language)}</option>
            <option value="ansi">ANSI</option>
          </select>
        </label>
        <label className="settings-row">
          <span>
            <strong>{t('settings.terminal.safeLinks.label', settings.language)}</strong>
            <small>{t('settings.terminal.safeLinks.summary', settings.language)}</small>
          </span>
          <input
            className="settings-toggle"
            type="checkbox"
            checked={settings.terminalSafeLinksEnabled}
            onChange={(event) => onChange({ terminalSafeLinksEnabled: event.target.checked })}
          />
        </label>
        <label className="settings-row">
          <span>
            <strong>{t('settings.terminal.suspendHidden.label', settings.language)}</strong>
            <small>{t('settings.terminal.suspendHidden.summary', settings.language)}</small>
          </span>
          <input
            className="settings-toggle"
            type="checkbox"
            checked={settings.terminalSuspendRenderingWhenHidden}
            onChange={(event) => onChange({ terminalSuspendRenderingWhenHidden: event.target.checked })}
          />
        </label>
        <label className="settings-row">
          <span>
            <strong>{t('settings.terminal.keywordHighlight.label', settings.language)}</strong>
            <small>{t('settings.terminal.keywordHighlight.summary', settings.language)}</small>
          </span>
          <input
            className="settings-toggle"
            type="checkbox"
            checked={settings.terminalKeywordHighlightEnabled}
            onChange={(event) => onChange({ terminalKeywordHighlightEnabled: event.target.checked })}
          />
        </label>
        <label className="settings-row">
          <span>
            <strong>{t('settings.terminal.fullscreenContextMenu.label', settings.language)}</strong>
            <small>{t('settings.terminal.fullscreenContextMenu.summary', settings.language)}</small>
          </span>
          <input className="settings-toggle" type="checkbox" checked={settings.terminalContextMenuInAlternateScreen} onChange={(event) => onChange({ terminalContextMenuInAlternateScreen: event.target.checked })} />
        </label>
        <div className="settings-row settings-terminal-highlight-rules-row">
          <span>
            <strong>{t('terminal.settingsDialog.rules.manage', settings.language, { count: settings.terminalHighlightRules.length })}</strong>
            <small>{t('settings.terminal.highlightKeywords.summary', settings.language)}</small>
          </span>
          <div className="settings-terminal-highlight-rules">
            {settings.terminalHighlightRules.map((rule) => {
              const validPattern = isSafeTerminalHighlightPattern(rule.pattern, rule.mode);
              return <div key={rule.id}>
                <input type="checkbox" checked={rule.enabled} disabled={!settings.terminalKeywordHighlightEnabled} aria-label={rule.label} onChange={(event) => onChange({ terminalHighlightRules: settings.terminalHighlightRules.map((candidate) => candidate.id === rule.id ? { ...candidate, enabled: event.target.checked } : candidate) })} />
                <input value={rule.label} maxLength={80} disabled={!settings.terminalKeywordHighlightEnabled} aria-label={t('terminal.settingsDialog.rules.name', settings.language)} onChange={(event) => onChange({ terminalHighlightRules: settings.terminalHighlightRules.map((candidate) => candidate.id === rule.id ? { ...candidate, label: event.target.value, builtin: false } : candidate) })} />
                <select value={rule.mode} disabled={!settings.terminalKeywordHighlightEnabled} aria-label={t('terminal.settingsDialog.rules.mode', settings.language)} onChange={(event) => onChange({ terminalHighlightRules: settings.terminalHighlightRules.map((candidate) => candidate.id === rule.id ? { ...candidate, mode: event.target.value as ShellDeskTerminalHighlightRule['mode'], builtin: false } : candidate) })}>
                  <option value="literal">{t('terminal.settingsDialog.rules.literal', settings.language)}</option>
                  <option value="regex">Regex</option>
                </select>
                <input value={rule.pattern} maxLength={512} disabled={!settings.terminalKeywordHighlightEnabled} spellCheck={false} aria-invalid={!validPattern} title={validPattern ? undefined : t('terminal.settingsDialog.rules.invalid', settings.language)} aria-label={t('terminal.settingsDialog.rules.pattern', settings.language)} onChange={(event) => onChange({ terminalHighlightRules: settings.terminalHighlightRules.map((candidate) => candidate.id === rule.id ? { ...candidate, pattern: event.target.value, builtin: false } : candidate) })} />
                <input type="color" value={rule.foreground} disabled={!settings.terminalKeywordHighlightEnabled} aria-label={t('terminal.settingsDialog.rules.foreground', settings.language)} onChange={(event) => onChange({ terminalHighlightRules: settings.terminalHighlightRules.map((candidate) => candidate.id === rule.id ? { ...candidate, foreground: event.target.value, builtin: false } : candidate) })} />
                <input type="color" value={rule.background} disabled={!settings.terminalKeywordHighlightEnabled} aria-label={t('terminal.settingsDialog.rules.background', settings.language)} onChange={(event) => onChange({ terminalHighlightRules: settings.terminalHighlightRules.map((candidate) => candidate.id === rule.id ? { ...candidate, background: event.target.value, builtin: false } : candidate) })} />
                <button type="button" disabled={!settings.terminalKeywordHighlightEnabled} aria-label={t('common.delete', settings.language)} onClick={() => onChange({ terminalHighlightRules: settings.terminalHighlightRules.filter((candidate) => candidate.id !== rule.id) })}>×</button>
              </div>
            })}
            <button type="button" disabled={!settings.terminalKeywordHighlightEnabled} onClick={() => onChange({ terminalHighlightRules: [...settings.terminalHighlightRules, { id: `rule:${Date.now().toString(36)}`, label: t('terminal.settingsDialog.rules.newRule', settings.language), pattern: 'keyword', mode: 'literal', foreground: '#fff2a8', background: '#6a4f12', enabled: true }] })}>{t('terminal.settingsDialog.rules.add', settings.language)}</button>
          </div>
        </div>
      </div>
    </section>
  );
}

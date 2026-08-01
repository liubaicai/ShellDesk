import { t } from '../i18n';

interface TerminalOutputSettingsFieldsProps {
  settings: Pick<
    ShellDeskAppSettings,
    | 'language'
    | 'terminalCommandAutocompleteEnabled'
    | 'terminalRemotePathAutocompleteEnabled'
    | 'terminalHighlightKeywords'
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
            <strong>{t('settings.terminal.autocomplete.label', settings.language)}</strong>
            <small>{t('settings.terminal.autocomplete.summary', settings.language)}</small>
          </span>
          <input
            className="settings-toggle"
            type="checkbox"
            checked={settings.terminalCommandAutocompleteEnabled}
            onChange={(event) => onChange({ terminalCommandAutocompleteEnabled: event.target.checked })}
          />
        </label>
        <label className="settings-row">
          <span>
            <strong>{t('settings.terminal.remotePathAutocomplete.label', settings.language)}</strong>
            <small>{t('settings.terminal.remotePathAutocomplete.summary', settings.language)}</small>
          </span>
          <input
            className="settings-toggle"
            type="checkbox"
            checked={settings.terminalRemotePathAutocompleteEnabled}
            disabled={!settings.terminalCommandAutocompleteEnabled}
            onChange={(event) => onChange({ terminalRemotePathAutocompleteEnabled: event.target.checked })}
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
            <strong>{t('settings.terminal.highlightKeywords.label', settings.language)}</strong>
            <small>{t('settings.terminal.highlightKeywords.summary', settings.language)}</small>
          </span>
          <input
            className="settings-text-input"
            value={settings.terminalHighlightKeywords}
            disabled={!settings.terminalKeywordHighlightEnabled}
            onChange={(event) => onChange({ terminalHighlightKeywords: event.target.value })}
          />
        </label>
      </div>
    </section>
  );
}

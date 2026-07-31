import { t } from '../i18n';

interface TerminalOutputSettingsFieldsProps {
  settings: Pick<
    ShellDeskAppSettings,
    | 'language'
    | 'terminalCommandAutocompleteEnabled'
    | 'terminalHighlightKeywords'
    | 'terminalKeywordHighlightEnabled'
    | 'terminalLineTimestamps'
    | 'terminalSafeLinksEnabled'
    | 'terminalSuspendRenderingWhenHidden'
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

import { t } from '../i18n';

interface TerminalSessionSettingsFieldsProps {
  settings: Pick<
    ShellDeskAppSettings,
    'language' | 'terminalExitPolicy' | 'terminalPreferTmux' | 'terminalRestoreWorkspace'
  >;
  onChange: (patch: Partial<ShellDeskAppSettings>) => void;
}

export function TerminalSessionSettingsFields({ settings, onChange }: TerminalSessionSettingsFieldsProps) {
  return (
    <section className="settings-section">
      <h2>{t('settings.terminal.session.title', settings.language)}</h2>
      <div className="settings-card">
        <label className="settings-row">
          <span>
            <strong>{t('settings.terminal.preferTmux.label', settings.language)}</strong>
            <small>{t('settings.terminal.preferTmux.summary', settings.language)}</small>
          </span>
          <input
            className="settings-toggle"
            type="checkbox"
            checked={settings.terminalPreferTmux}
            onChange={(event) => onChange({ terminalPreferTmux: event.target.checked })}
          />
        </label>
        <label className="settings-row">
          <span>
            <strong>{t('settings.terminal.restoreWorkspace.label', settings.language)}</strong>
            <small>{t('settings.terminal.restoreWorkspace.summary', settings.language)}</small>
          </span>
          <input
            className="settings-toggle"
            type="checkbox"
            checked={settings.terminalRestoreWorkspace}
            onChange={(event) => onChange({ terminalRestoreWorkspace: event.target.checked })}
          />
        </label>
        <label className="settings-row">
          <span>
            <strong>{t('settings.terminal.exitPolicy.label', settings.language)}</strong>
            <small>{t('settings.terminal.exitPolicy.summary', settings.language)}</small>
          </span>
          <select
            value={settings.terminalExitPolicy}
            onChange={(event) => onChange({
              terminalExitPolicy: event.target.value as ShellDeskAppSettings['terminalExitPolicy'],
            })}
          >
            <option value="keep-open">{t('settings.terminal.exitPolicy.keepOpen', settings.language)}</option>
            <option value="close-success">{t('settings.terminal.exitPolicy.closeSuccess', settings.language)}</option>
            <option value="close-always">{t('settings.terminal.exitPolicy.closeAlways', settings.language)}</option>
          </select>
        </label>
      </div>
    </section>
  );
}

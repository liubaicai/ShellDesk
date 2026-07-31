import { t } from '../i18n';

interface SftpSettingsFieldsProps {
  settings: Pick<
    ShellDeskAppSettings,
    'language' | 'sftpDefaultLocalDirectory' | 'sftpDefaultRemoteDirectory'
  >;
  onChange: (patch: Pick<ShellDeskAppSettings, 'sftpDefaultLocalDirectory' | 'sftpDefaultRemoteDirectory'>) => void;
}

export function SftpSettingsFields({ settings, onChange }: SftpSettingsFieldsProps) {
  return (
    <section className="settings-section">
      <h2>{t('settings.general.sftp.title', settings.language)}</h2>
      <div className="settings-card">
        <label className="settings-row">
          <span>
            <strong>{t('settings.general.sftp.local.label', settings.language)}</strong>
            <small>{t('settings.general.sftp.local.summary', settings.language)}</small>
          </span>
          <input
            className="settings-text-input"
            value={settings.sftpDefaultLocalDirectory}
            aria-label={t('settings.general.sftp.local.label', settings.language)}
            onChange={(event) => onChange({
              sftpDefaultLocalDirectory: event.target.value,
              sftpDefaultRemoteDirectory: settings.sftpDefaultRemoteDirectory,
            })}
          />
        </label>
        <label className="settings-row">
          <span>
            <strong>{t('settings.general.sftp.remote.label', settings.language)}</strong>
            <small>{t('settings.general.sftp.remote.summary', settings.language)}</small>
          </span>
          <input
            className="settings-text-input"
            value={settings.sftpDefaultRemoteDirectory}
            aria-label={t('settings.general.sftp.remote.label', settings.language)}
            onChange={(event) => onChange({
              sftpDefaultLocalDirectory: settings.sftpDefaultLocalDirectory,
              sftpDefaultRemoteDirectory: event.target.value,
            })}
          />
        </label>
      </div>
    </section>
  );
}

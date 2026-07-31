import { t } from '../i18n';
import {
  localSftpColumnChoices,
  remoteSftpColumnChoices,
  toggleSftpColumn,
} from './sftp-transfer/columns';

interface SftpSettingsFieldsProps {
  settings: Pick<
    ShellDeskAppSettings,
    | 'language'
    | 'sftpDefaultLocalDirectory'
    | 'sftpDefaultRemoteDirectory'
    | 'sftpLocalColumns'
    | 'sftpRemoteColumns'
  >;
  onChange: (patch: Partial<ShellDeskAppSettings>) => void;
}

export function SftpSettingsFields({ settings, onChange }: SftpSettingsFieldsProps) {
  const renderColumnChoices = (
    kind: 'local' | 'remote',
    columns: ShellDeskSftpFileColumn[],
    choices: ShellDeskSftpFileColumn[],
  ) => (
    <div className="settings-column-picker" role="group" aria-label={t(`settings.general.sftp.columns.${kind}.label`, settings.language)}>
      {choices.map((column) => (
        <label key={column} className={columns.includes(column) ? 'selected' : ''}>
          <input
            type="checkbox"
            checked={columns.includes(column)}
            disabled={column === 'name'}
            onChange={(event) => onChange({
              [kind === 'local' ? 'sftpLocalColumns' : 'sftpRemoteColumns']:
                toggleSftpColumn(kind, columns, column, event.target.checked),
            })}
          />
          <span>{t(`settings.general.sftp.column.${column}`, settings.language)}</span>
        </label>
      ))}
    </div>
  );

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
              sftpDefaultRemoteDirectory: event.target.value,
            })}
          />
        </label>
        <div className="settings-row">
          <span>
            <strong>{t('settings.general.sftp.columns.local.label', settings.language)}</strong>
            <small>{t('settings.general.sftp.columns.local.summary', settings.language)}</small>
          </span>
          {renderColumnChoices('local', settings.sftpLocalColumns, localSftpColumnChoices)}
        </div>
        <div className="settings-row">
          <span>
            <strong>{t('settings.general.sftp.columns.remote.label', settings.language)}</strong>
            <small>{t('settings.general.sftp.columns.remote.summary', settings.language)}</small>
          </span>
          {renderColumnChoices('remote', settings.sftpRemoteColumns, remoteSftpColumnChoices)}
        </div>
      </div>
    </section>
  );
}

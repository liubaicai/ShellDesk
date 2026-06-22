import { useCallback, useEffect, useState } from 'react';

import { getErrorMessage } from './desktopUtils';
import DismissibleAlert from './DismissibleAlert';
import { t, useCurrentAppLanguage } from '../../i18n';
import { createUnixDiskSummaryCommand, useRemoteSettingsCommand } from './settingsShared';

export default function SettingsDiskPanel() {
  const language = useCurrentAppLanguage();
  const runCommand = useRemoteSettingsCommand();
  const [diskInfo, setDiskInfo] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const diskResult = await runCommand(createUnixDiskSummaryCommand(language));
      setDiskInfo(diskResult.stdout || diskResult.stderr);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [language, runCommand]);

  useEffect(() => { void refresh(); }, [refresh]);

  return (
    <div className="settings-panel-content">
      <div className="settings-panel-header">
        <div>
          <h3>{t('remoteSettings.disk.title', language)}</h3>
          <p>{t('remoteSettings.disk.description', language)}</p>
        </div>
        <button type="button" className="settings-action-btn" onClick={refresh} disabled={loading}>
          {loading ? t('remoteSettings.common.loading', language) : t('remoteSettings.common.refresh', language)}
        </button>
      </div>
      {error ? (
        <DismissibleAlert className="error-banner" source="RemoteSettings" onDismiss={() => setError('')} role="alert">
          {error}
        </DismissibleAlert>
      ) : null}
      <div className="settings-section">
        <h4>{t('remoteSettings.disk.usage', language)}</h4>
        <pre className="settings-output">{diskInfo || t('remoteSettings.common.loading', language)}</pre>
      </div>
    </div>
  );
}

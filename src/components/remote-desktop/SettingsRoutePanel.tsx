import { useCallback, useEffect, useState } from 'react';

import { getErrorMessage } from './desktopUtils';
import DismissibleAlert from './DismissibleAlert';
import { t, useCurrentAppLanguage } from '../../i18n';
import type { SettingsConfirmDialogConfig } from './settingsTypes';
import { SettingsConfirmDialog, shellQuote, useRemoteSettingsCommand, withLinuxPrivilege } from './settingsShared';

export default function SettingsRoutePanel() {
  const language = useCurrentAppLanguage();
  const runCommand = useRemoteSettingsCommand();
  const [routes, setRoutes] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [addDest, setAddDest] = useState('');
  const [addGateway, setAddGateway] = useState('');
  const [addDev, setAddDev] = useState('');
  const [delDest, setDelDest] = useState('');
  const [confirmDialog, setConfirmDialog] = useState<SettingsConfirmDialogConfig | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await runCommand(`ip route show 2>/dev/null || route -n 2>/dev/null || echo ${shellQuote(t('remoteSettings.route.unsupported', language))}`);
      setRoutes(result.stdout || result.stderr || t('remoteSettings.route.unavailable', language));
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [language, runCommand]);

  useEffect(() => { void refresh(); }, [refresh]);

  const applyAddRoute = async (command: string, destination: string) => {
    try {
      setError('');
      setSuccess('');
      const result = await runCommand(withLinuxPrivilege(command));
      if (result.code !== 0) {
        throw new Error(result.stderr || t('remoteSettings.route.addFailed', language));
      }
      setSuccess(t('remoteSettings.route.added', language, { destination }));
      setAddDest('');
      setAddGateway('');
      setAddDev('');
      await refresh();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  };

  const requestAddRoute = () => {
    const destination = addDest.trim();
    if (!destination) {
      setError(t('remoteSettings.route.destinationRequired', language));
      return;
    }

    let command = `ip route add ${shellQuote(destination)}`;
    if (addGateway.trim()) command += ` via ${shellQuote(addGateway.trim())}`;
    if (addDev.trim()) command += ` dev ${shellQuote(addDev.trim())}`;

    setConfirmDialog({
      title: t('remoteSettings.route.addTitle', language),
      message: t('remoteSettings.route.addMessage', language, { destination }),
      detail: t('remoteSettings.route.addDetail', language),
      preview: command,
      confirmLabel: t('remoteSettings.route.addConfirm', language),
      tone: 'warning',
      onConfirm: () => applyAddRoute(command, destination),
    });
  };

  const applyDeleteRoute = async (command: string, destination: string) => {
    try {
      setError('');
      setSuccess('');
      const result = await runCommand(withLinuxPrivilege(command));
      if (result.code !== 0) {
        throw new Error(result.stderr || t('remoteSettings.route.deleteFailed', language));
      }
      setSuccess(t('remoteSettings.route.deleted', language, { destination }));
      setDelDest('');
      await refresh();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  };

  const requestDeleteRoute = () => {
    const destination = delDest.trim();
    if (!destination) {
      setError(t('remoteSettings.route.deleteDestinationRequired', language));
      return;
    }

    const command = `ip route del ${shellQuote(destination)} 2>&1`;
    setConfirmDialog({
      title: t('remoteSettings.route.deleteTitle', language),
      message: t('remoteSettings.route.deleteMessage', language, { destination }),
      detail: t('remoteSettings.route.deleteDetail', language),
      preview: command,
      confirmLabel: t('remoteSettings.route.deleteConfirm', language),
      tone: 'danger',
      onConfirm: () => applyDeleteRoute(command, destination),
    });
  };

  return (
    <div className="settings-panel-content">
      <div className="settings-panel-header">
        <div>
          <h3>{t('remoteSettings.route.title', language)}</h3>
          <p>{t('remoteSettings.route.description', language)}</p>
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
      {success ? (
        <DismissibleAlert className="settings-success-banner" onDismiss={() => setSuccess('')}>
          {success}
        </DismissibleAlert>
      ) : null}
      <div className="settings-section">
        <h4>{t('remoteSettings.route.addSection', language)}</h4>
        <div className="settings-inline-form">
          <input type="text" className="settings-input" placeholder={t('remoteSettings.route.destinationPlaceholder', language)} value={addDest} onChange={(e) => setAddDest(e.target.value)} />
          <input type="text" className="settings-input" placeholder={t('remoteSettings.route.gatewayPlaceholder', language)} value={addGateway} onChange={(e) => setAddGateway(e.target.value)} />
          <input type="text" className="settings-input" placeholder={t('remoteSettings.route.interfacePlaceholder', language)} value={addDev} onChange={(e) => setAddDev(e.target.value)} />
          <button type="button" className="settings-action-btn primary" onClick={requestAddRoute}>{t('remoteSettings.route.previewAdd', language)}</button>
        </div>
      </div>
      <div className="settings-section">
        <h4>{t('remoteSettings.route.deleteSection', language)}</h4>
        <div className="settings-inline-form">
          <input type="text" className="settings-input" placeholder={t('remoteSettings.route.destinationPlaceholder', language)} value={delDest} onChange={(e) => setDelDest(e.target.value)} />
          <button type="button" className="settings-action-btn danger" onClick={requestDeleteRoute}>{t('remoteSettings.route.previewDelete', language)}</button>
        </div>
      </div>
      <div className="settings-section">
        <h4>{t('remoteSettings.route.tableTitle', language)}</h4>
        <pre className="settings-output">{routes || t('remoteSettings.common.loading', language)}</pre>
      </div>
      {confirmDialog ? <SettingsConfirmDialog config={confirmDialog} onClose={() => setConfirmDialog(null)} /> : null}
    </div>
  );
}

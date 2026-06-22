import { useCallback, useEffect, useState } from 'react';

import { getErrorMessage } from './desktopUtils';
import DismissibleAlert from './DismissibleAlert';
import { t, useCurrentAppLanguage } from '../../i18n';
import type { SettingsConfirmDialogConfig } from './settingsTypes';
import { createLineChangePreview, isSafeHostname, isSafeNameserver, SettingsCommandPreview, SettingsConfirmDialog, shellQuote, useRemoteSettingsCommand, withLinuxPrivilege } from './settingsShared';

export default function SettingsHostsPanel() {
  const language = useCurrentAppLanguage();
  const runCommand = useRemoteSettingsCommand();
  const [hostsContent, setHostsContent] = useState('');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [addIp, setAddIp] = useState('');
  const [addHostname, setAddHostname] = useState('');
  const [confirmDialog, setConfirmDialog] = useState<SettingsConfirmDialogConfig | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await runCommand('cat /etc/hosts 2>/dev/null');
      setHostsContent(result.stdout || '# /etc/hosts');
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [runCommand]);

  useEffect(() => { void refresh(); }, [refresh]);

  const saveHosts = async () => {
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const result = await runCommand(withLinuxPrivilege(`printf '%s' ${shellQuote(draft)} > /etc/hosts`));
      if (result.code !== 0) {
        throw new Error(result.stderr || t('remoteSettings.hosts.writeFailed', language));
      }
      setSuccess(t('remoteSettings.hosts.saved', language));
      setEditing(false);
      await refresh();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const requestSaveHosts = () => {
    if (draft === hostsContent) {
      setSuccess(t('remoteSettings.hosts.noDraftChanges', language));
      return;
    }

    setConfirmDialog({
      title: t('remoteSettings.hosts.saveTitle', language),
      message: t('remoteSettings.hosts.saveMessage', language),
      detail: t('remoteSettings.hosts.saveDetail', language),
      preview: createLineChangePreview(hostsContent, draft, language),
      confirmLabel: t('remoteSettings.hosts.saveConfirm', language),
      tone: 'warning',
      onConfirm: saveHosts,
    });
  };

  const addHostEntry = async () => {
    if (!addIp.trim() || !addHostname.trim()) {
      setError(t('remoteSettings.hosts.ipHostRequired', language));
      return;
    }
    if (!isSafeNameserver(addIp.trim()) || !isSafeHostname(addHostname.trim())) {
      setError(t('remoteSettings.hosts.ipHostInvalid', language));
      return;
    }
    setError('');
    setSuccess('');
    try {
      const line = `${addIp.trim()} ${addHostname.trim()}`;
      const result = await runCommand(withLinuxPrivilege(`printf '%s\n' ${shellQuote(line)} >> /etc/hosts`));
      if (result.code !== 0) {
        throw new Error(result.stderr || t('remoteSettings.hosts.appendFailed', language));
      }
      setSuccess(t('remoteSettings.hosts.added', language, { line }));
      setAddIp('');
      setAddHostname('');
      await refresh();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  };

  return (
    <div className="settings-panel-content">
      <div className="settings-panel-header">
        <div>
          <h3>{t('remoteSettings.hosts.title', language)}</h3>
          <p>{t('remoteSettings.hosts.description', language)}</p>
        </div>
        <div className="settings-header-actions">
          {editing ? (
            <>
              <button type="button" className="settings-action-btn" onClick={() => { setEditing(false); setError(''); }} disabled={saving}>{t('remoteSettings.common.cancel', language)}</button>
              <button type="button" className="settings-action-btn primary" onClick={requestSaveHosts} disabled={saving}>{saving ? t('remoteSettings.hosts.saving', language) : t('remoteSettings.hosts.previewSave', language)}</button>
            </>
          ) : (
            <>
              <button type="button" className="settings-action-btn" onClick={refresh} disabled={loading}>{loading ? t('remoteSettings.common.loading', language) : t('remoteSettings.common.refresh', language)}</button>
              <button type="button" className="settings-action-btn primary" onClick={() => { setDraft(hostsContent); setEditing(true); setSuccess(''); }}>{t('remoteSettings.common.edit', language)}</button>
            </>
          )}
        </div>
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
      {!editing ? (
        <>
          <div className="settings-section">
            <h4>{t('remoteSettings.hosts.quickAdd', language)}</h4>
            <div className="settings-inline-form">
              <input
                type="text"
                className="settings-input"
                placeholder={t('remoteSettings.hosts.ipPlaceholder', language)}
                value={addIp}
                onChange={(e) => setAddIp(e.target.value)}
              />
              <input
                type="text"
                className="settings-input"
                placeholder={t('remoteSettings.hosts.hostnamePlaceholder', language)}
                value={addHostname}
                onChange={(e) => setAddHostname(e.target.value)}
              />
              <button type="button" className="settings-action-btn primary" onClick={addHostEntry}>{t('remoteSettings.hosts.add', language)}</button>
            </div>
          </div>
          <div className="settings-section">
            <h4>{t('remoteSettings.hosts.contentTitle', language)}</h4>
            <pre className="settings-output">{hostsContent || t('remoteSettings.common.loading', language)}</pre>
          </div>
        </>
      ) : (
        <div className="settings-section">
          <h4>{t('remoteSettings.hosts.editTitle', language)}</h4>
          <textarea
            className="settings-textarea"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={16}
            spellCheck={false}
          />
          <SettingsCommandPreview label={t('remoteSettings.hosts.changePreview', language)} content={createLineChangePreview(hostsContent, draft, language)} />
        </div>
      )}
      {confirmDialog ? <SettingsConfirmDialog config={confirmDialog} onClose={() => setConfirmDialog(null)} /> : null}
    </div>
  );
}

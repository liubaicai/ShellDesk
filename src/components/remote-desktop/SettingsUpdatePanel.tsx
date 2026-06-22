import { useCallback, useEffect, useRef, useState } from 'react';

import { getErrorMessage } from './desktopUtils';
import DismissibleAlert from './DismissibleAlert';
import { t, useCurrentAppLanguage } from '../../i18n';
import type { SettingsConfirmDialogConfig } from './settingsTypes';
import { SettingsConfirmDialog, useRemoteSettingsCommand, withLinuxPrivilege } from './settingsShared';

export default function SettingsUpdatePanel() {
  const language = useCurrentAppLanguage();
  const runCommand = useRemoteSettingsCommand();
  const [distroType, setDistroType] = useState<'debian' | 'redhat' | 'unknown'>('unknown');
  const [updateOutput, setUpdateOutput] = useState('');
  const [upgradable, setUpgradable] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [confirmDialog, setConfirmDialog] = useState<SettingsConfirmDialogConfig | null>(null);
  const outputRef = useRef<HTMLPreElement>(null);

  const detectPkgManager = useCallback(async () => {
    try {
      const result = await runCommand('command -v apt-get >/dev/null 2>&1 && echo "debian" || (command -v yum >/dev/null 2>&1 && echo "redhat" || echo "unknown")');
      setDistroType(result.stdout.trim() as 'debian' | 'redhat' | 'unknown');
    } catch {
      setDistroType('unknown');
    }
  }, [runCommand]);

  useEffect(() => { void detectPkgManager(); }, [detectPkgManager]);

  const checkUpdates = async () => {
    setRunning(true);
    setError('');
    setSuccess('');
    setUpdateOutput('');
    setUpgradable('');
    try {
      if (distroType === 'debian') {
        setUpdateOutput(t('remoteSettings.update.updatingApt', language));
        const updateResult = await runCommand(withLinuxPrivilege('apt-get update 2>&1'));
        setUpdateOutput((prev) => prev + updateResult.stdout + (updateResult.stderr ? '\n' + updateResult.stderr : ''));
        const listResult = await runCommand('apt list --upgradable 2>/dev/null | head -50');
        setUpgradable(listResult.stdout || t('remoteSettings.update.noUpdates', language));
        setSuccess(t('remoteSettings.update.indexDone', language));
      } else if (distroType === 'redhat') {
        setUpdateOutput(t('remoteSettings.update.checkingYum', language));
        const checkResult = await runCommand(withLinuxPrivilege('yum check-update 2>&1 || true'));
        setUpdateOutput((prev) => prev + checkResult.stdout + (checkResult.stderr ? '\n' + checkResult.stderr : ''));
        setUpgradable(checkResult.stdout || t('remoteSettings.update.noUpdates', language));
        setSuccess(t('remoteSettings.update.checkDone', language));
      } else {
        setError(t('remoteSettings.update.unknownManager', language));
      }
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setRunning(false);
    }
  };

  const applyUpdates = async () => {
    setRunning(true);
    setError('');
    setSuccess('');
    setUpdateOutput('');
    try {
      if (distroType === 'debian') {
        setUpdateOutput(t('remoteSettings.update.upgradingApt', language));
        const result = await runCommand(withLinuxPrivilege('DEBIAN_FRONTEND=noninteractive apt-get upgrade -y 2>&1'));
        setUpdateOutput((prev) => prev + result.stdout + (result.stderr ? '\n' + result.stderr : ''));
        setSuccess(result.code === 0 ? t('remoteSettings.update.upgradeDone', language) : t('remoteSettings.update.upgradeWarning', language));
      } else if (distroType === 'redhat') {
        setUpdateOutput(t('remoteSettings.update.upgradingYum', language));
        const result = await runCommand(withLinuxPrivilege('yum update -y 2>&1'));
        setUpdateOutput((prev) => prev + result.stdout + (result.stderr ? '\n' + result.stderr : ''));
        setSuccess(result.code === 0 ? t('remoteSettings.update.upgradeDone', language) : t('remoteSettings.update.upgradeWarning', language));
      }
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setRunning(false);
    }
  };

  const requestApplyUpdates = () => {
    const preview = distroType === 'debian'
      ? 'DEBIAN_FRONTEND=noninteractive apt-get upgrade -y'
      : distroType === 'redhat'
        ? 'yum update -y'
        : '';

    if (!preview) {
      setError(t('remoteSettings.update.unknownManager', language));
      return;
    }

    setConfirmDialog({
      title: t('remoteSettings.update.confirmTitle', language),
      message: t('remoteSettings.update.confirmMessage', language),
      detail: t('remoteSettings.update.confirmDetail', language),
      preview,
      confirmLabel: t('remoteSettings.update.confirmLabel', language),
      tone: 'danger',
      onConfirm: applyUpdates,
    });
  };

  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [updateOutput]);

  return (
    <div className="settings-panel-content">
      <div className="settings-panel-header">
        <div>
          <h3>{t('remoteSettings.update.title', language)}</h3>
          <p>{t('remoteSettings.update.description', language)}</p>
        </div>
        <div className="settings-header-actions">
          <button type="button" className="settings-action-btn" onClick={checkUpdates} disabled={running}>
            {running ? t('remoteSettings.update.running', language) : t('remoteSettings.update.checkButton', language)}
          </button>
          <button type="button" className="settings-action-btn primary" onClick={requestApplyUpdates} disabled={running}>
            {running ? t('remoteSettings.update.running', language) : t('remoteSettings.update.upgradeButton', language)}
          </button>
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
      {upgradable ? (
        <div className="settings-section">
          <h4>{t('remoteSettings.update.upgradableTitle', language)}</h4>
          <pre className="settings-output">{upgradable}</pre>
        </div>
      ) : null}
      {updateOutput ? (
        <div className="settings-section">
          <h4>{t('remoteSettings.update.outputTitle', language)}</h4>
          <pre className="settings-output settings-output-scroll" ref={outputRef}>{updateOutput}</pre>
        </div>
      ) : null}
      {!updateOutput && !upgradable ? (
        <div className="settings-section">
          <p className="settings-hint">{t('remoteSettings.update.emptyHint', language)}</p>
        </div>
      ) : null}
      {confirmDialog ? <SettingsConfirmDialog config={confirmDialog} onClose={() => setConfirmDialog(null)} /> : null}
    </div>
  );
}

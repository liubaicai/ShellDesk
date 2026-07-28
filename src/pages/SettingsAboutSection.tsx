import appIconUrl from '../assets/images/icon.png';
import { t } from '../i18n';
import {
  formatDateTime,
  formatFileSize,
  shellDeskReleasesUrl,
  shellDeskRepositoryUrl,
} from './settingsPageModel';

interface SettingsAboutSectionProps {
  appDisplayName: string;
  appPlatform: string;
  appVersion: string;
  canManualDownloadUpdate: boolean;
  canOpenUpdateRelease: boolean;
  isCheckingForUpdates: boolean;
  isUpdateDownloading: boolean;
  isUpdateReady: boolean;
  language: ShellDeskAppSettings['language'];
  autoUpdateEnabled: boolean;
  updateCheckResult: ShellDeskUpdateCheckResult | null;
  updateProgressPercent: number;
  updateStatus: ShellDeskUpdateStatus;
  updateStatusClassName: string;
  updateStatusText: string;
  onAutoUpdateChange: (enabled: boolean) => void;
  onCheckForUpdates: () => void;
  onDownloadUpdate: () => void;
  onInstallUpdate: () => void;
  onOpenExternalLink: (url: string) => void;
}

export function SettingsAboutSection({
  appDisplayName,
  appPlatform,
  appVersion,
  canManualDownloadUpdate,
  canOpenUpdateRelease,
  isCheckingForUpdates,
  isUpdateDownloading,
  isUpdateReady,
  language,
  autoUpdateEnabled,
  updateCheckResult,
  updateProgressPercent,
  updateStatus,
  updateStatusClassName,
  updateStatusText,
  onAutoUpdateChange,
  onCheckForUpdates,
  onDownloadUpdate,
  onInstallUpdate,
  onOpenExternalLink,
}: SettingsAboutSectionProps) {
  return (
    <div className="settings-about-grid">
      <section className="settings-section settings-about-section">
        <div className="settings-about-hero">
          <img src={appIconUrl} alt="" draggable={false} />
          <span>
            <strong>{appDisplayName}</strong>
            <small>{t('settings.about.intro', language)}</small>
          </span>
        </div>
      </section>

      <section className="settings-section settings-about-info-section">
        <h2>{t('settings.about.appInfo.title', language)}</h2>
        <div className="settings-card">
          <div className="settings-row">
            <span>
              <strong>{t('settings.about.version.label', language)}</strong>
              <small>{appPlatform}</small>
            </span>
            <code className="settings-inline-code">v{appVersion}</code>
          </div>
          <div className="settings-row">
            <span>
              <strong>GitHub</strong>
              <small>{t('settings.about.repository.summary', language)}</small>
            </span>
            <button type="button" className="settings-link-button" onClick={() => onOpenExternalLink(shellDeskRepositoryUrl)}>
              liubaicai/ShellDesk
            </button>
          </div>
        </div>
      </section>

      <section className="settings-section settings-update-section">
        <h2>{t('settings.update.title', language)}</h2>
        <div className="settings-card">
          <div className="settings-row">
            <span>
              <strong>{t('settings.update.auto.label', language)}</strong>
              <small>{t('settings.update.auto.summary', language)}</small>
            </span>
            <input
              type="checkbox"
              className="settings-toggle"
              checked={autoUpdateEnabled}
              onChange={(event) => onAutoUpdateChange(event.target.checked)}
              aria-label={t('settings.update.auto.label', language)}
            />
          </div>
          <div className="settings-row">
            <span>
              <strong>{t('settings.update.status.label', language)}</strong>
              <small className={updateStatusClassName ? `settings-update-status ${updateStatusClassName}` : 'settings-update-status'}>
                {updateStatusText}
              </small>
            </span>
            <div className="settings-update-actions">
              <button
                type="button"
                className="command-button"
                onClick={onCheckForUpdates}
                disabled={isCheckingForUpdates || updateStatus.isChecking || isUpdateDownloading || isUpdateReady}
              >
                {isCheckingForUpdates || updateStatus.isChecking
                  ? t('settings.update.checkingButton', language)
                  : t('settings.update.checkButton', language)}
              </button>
              {isUpdateReady ? (
                <button type="button" className="command-button" onClick={onInstallUpdate}>
                  {t('settings.update.installButton', language)}
                </button>
              ) : null}
            </div>
          </div>
          <div className="settings-row">
            <span>
              <strong>{t('settings.update.latest.label', language)}</strong>
              <small>
                {updateCheckResult
                  ? [updateCheckResult.releaseName, formatDateTime(updateCheckResult.releaseDate)].filter(Boolean).join(' · ')
                  : updateStatus.version
                    ? t('settings.update.latest.autoDetected', language, { version: updateStatus.version })
                    : t('settings.update.latest.clickToCheck', language)}
              </small>
            </span>
            <code className="settings-inline-code">{updateCheckResult?.latestVersion ?? updateStatus.version ?? t('settings.update.latest.notChecked', language)}</code>
          </div>
          {isUpdateDownloading ? (
            <div className="settings-row settings-update-progress-row">
              <span>
                <strong>{t('settings.update.download.progress', language)}</strong>
                <small>{autoUpdateEnabled
                  ? t('settings.update.download.auto', language)
                  : t('settings.update.download.manualOnly', language)}</small>
              </span>
              <div className="settings-update-progress" aria-label={t('settings.update.download.progress', language)}>
                <span style={{ width: `${updateProgressPercent}%` }} />
              </div>
            </div>
          ) : null}
          {updateCheckResult?.updateAvailable || updateStatus.status === 'available' || updateStatus.status === 'error' || isUpdateReady ? (
            <div className="settings-row">
              <span>
                <strong>{t('settings.update.download.title', language)}</strong>
                <small>
                  {!autoUpdateEnabled
                    ? t('settings.update.download.manualOnly', language)
                    : updateStatus.supported === false
                      ? updateStatus.unsupportedReason || t('settings.update.download.manual', language)
                      : [updateCheckResult?.downloadName || t('settings.update.download.defaultName', language), formatFileSize(updateCheckResult?.downloadSize ?? 0)].filter(Boolean).join(' · ')}
                </small>
              </span>
              <div className="settings-update-actions">
                {canManualDownloadUpdate ? (
                  <button type="button" className="command-button" onClick={onDownloadUpdate}>
                    {t('settings.update.downloadButton', language)}
                  </button>
                ) : null}
                {canOpenUpdateRelease ? (
                  <button
                    type="button"
                    className="command-button"
                    onClick={() => onOpenExternalLink(updateCheckResult?.downloadUrl ?? updateCheckResult?.releaseUrl ?? shellDeskReleasesUrl)}
                  >
                    {t('settings.update.download.open', language)}
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}

import { createContext, useContext, useState } from 'react';
import { createPortal } from 'react-dom';

import { t, getCurrentAppLanguage, useCurrentAppLanguage, type AppLanguage } from '../../i18n';
import { getErrorMessage } from './desktopUtils';
import { powershellCommand, powershellSingleQuote } from './remoteSystem';
import type { RemoteSystemType } from './types';
import type { RemoteSettingsCommandContext as RemoteSettingsCommandContextType, SettingsConfirmDialogConfig, SysInfoItem } from './settingsTypes';
import { parseDiskInfoSummary } from './settingsParsers';

export const SYSTEM_TYPE_LABELS: Record<RemoteSystemType, string> = {
  unknown: '',
  windows: 'Windows',
  macos: 'macOS',
  ubuntu: 'Ubuntu',
  debian: 'Debian',
  redhat: 'Red Hat',
  centos: 'CentOS',
  fedora: 'Fedora',
  rocky: 'Rocky Linux',
  almalinux: 'AlmaLinux',
  oracle: 'Oracle Linux',
  amazon: 'Amazon Linux',
  arch: 'Arch Linux',
  manjaro: 'Manjaro',
  alpine: 'Alpine Linux',
  opensuse: 'openSUSE',
  linuxmint: 'Linux Mint',
  kali: 'Kali Linux',
  raspbian: 'Raspberry Pi OS',
  gentoo: 'Gentoo',
  nixos: 'NixOS',
  popos: 'Pop!_OS',
  elementary: 'elementary OS',
  linux: 'Linux',
  unix: 'Unix',
};



export const RemoteSettingsCommandContext = createContext<RemoteSettingsCommandContextType | null>(null);

export function useRemoteSettingsCommand() {
  const runCommand = useContext(RemoteSettingsCommandContext);

  if (!runCommand) {
    throw new Error(t('remoteSettings.command.unsupported', getCurrentAppLanguage()));
  }

  return runCommand;
}



export async function getSystemInfoItems(connectionId: string): Promise<SysInfoItem[]> {
  if (!window.guiSSH?.connections) {
    throw new Error(t('remoteSettings.systemInfo.unsupported', getCurrentAppLanguage()));
  }

  const report = await window.guiSSH.connections.getSystemInfo(connectionId);
  return report.items;
}

export function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function createUnixDiskSummaryCommand(language: AppLanguage) {
  const availableLabel = shellQuote(t('remoteSettings.disk.available', language));
  const totalLabel = shellQuote(t('remoteSettings.disk.total', language));
  const unsupportedLabel = shellQuote(t('remoteSettings.disk.unsupported', language));

  return `
available_label=${availableLabel}
total_label=${totalLabel}
format_disk_summary_bytes() {
  awk -v available_label="$available_label" -v total_label="$total_label" '
    NR > 1 && $2 ~ /^[0-9]+$/ && $3 ~ /^[0-9]+$/ && !seen[$1]++ {
      total += $2
      available += $3
    }
    END {
      if (total > 0) {
        printf "%s: %.1f GB\\n%s: %.1f GB\\n", available_label, available / 1024 / 1024 / 1024, total_label, total / 1024 / 1024 / 1024
      } else {
        exit 1
      }
    }
  '
}
format_disk_summary_kb() {
  awk -v available_label="$available_label" -v total_label="$total_label" '
    NR > 1 && $2 ~ /^[0-9]+$/ && $4 ~ /^[0-9]+$/ && !seen[$1]++ {
      total += $2 * 1024
      available += $4 * 1024
    }
    END {
      if (total > 0) {
        printf "%s: %.1f GB\\n%s: %.1f GB\\n", available_label, available / 1024 / 1024 / 1024, total_label, total / 1024 / 1024 / 1024
      } else {
        exit 1
      }
    }
  '
}
df -B1 -x tmpfs -x devtmpfs -x squashfs --output=source,size,avail 2>/dev/null | format_disk_summary_bytes ||
df -Pk -x tmpfs -x devtmpfs -x squashfs 2>/dev/null | format_disk_summary_kb ||
df -Pk 2>/dev/null | format_disk_summary_kb ||
printf '%s\\n' ${unsupportedLabel}
`;
}

export function createWindowsDiskSummaryCommand(language: AppLanguage) {
  const availableLabel = powershellSingleQuote(t('remoteSettings.disk.available', language));
  const totalLabel = powershellSingleQuote(t('remoteSettings.disk.total', language));
  const unsupportedLabel = powershellSingleQuote(t('remoteSettings.disk.unsupported', language));

  return powershellCommand(`
$availableLabel = ${availableLabel}
$totalLabel = ${totalLabel}
$unsupportedLabel = ${unsupportedLabel}
$drives = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' -ErrorAction SilentlyContinue)
$totalBytes = ($drives | Measure-Object -Property Size -Sum).Sum
$availableBytes = ($drives | Measure-Object -Property FreeSpace -Sum).Sum
if ($null -ne $totalBytes -and [double]$totalBytes -gt 0) {
  "{0}: {1} GB" -f $availableLabel, [math]::Round(([double]$availableBytes / 1GB), 1)
  "{0}: {1} GB" -f $totalLabel, [math]::Round(([double]$totalBytes / 1GB), 1)
} else {
  $unsupportedLabel
}
`);
}

export function withLinuxPrivilege(command: string) {
  return `if [ "$(id -u 2>/dev/null)" = "0" ]; then
${command}
else
sudo -n sh -c ${shellQuote(command)}
fi`;
}

export function isSafeHostname(value: string) {
  return /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(value);
}

export function isSafeNameserver(value: string) {
  return /^[0-9A-Fa-f:.]{2,45}$/.test(value);
}

export function getSystemTypeLabel(systemType: RemoteSystemType | undefined, language: AppLanguage) {
  return SYSTEM_TYPE_LABELS[systemType ?? 'unknown'] || t('remoteSettings.system.unknown', language);
}



export function createLineChangePreview(current: string, draft: string, language: AppLanguage = getCurrentAppLanguage()) {
  if (current === draft) {
    return t('remoteSettings.common.noChanges', language);
  }

  const currentLines = current.split(/\r?\n/);
  const draftLines = draft.split(/\r?\n/);
  const currentLineSet = new Set(currentLines);
  const draftLineSet = new Set(draftLines);
  const removed = currentLines.filter((line) => line.trim() && !draftLineSet.has(line)).slice(0, 10);
  const added = draftLines.filter((line) => line.trim() && !currentLineSet.has(line)).slice(0, 10);
  const previewLines = [
    t('remoteSettings.common.originalLines', language, { count: String(currentLines.length) }),
    t('remoteSettings.common.draftLines', language, { count: String(draftLines.length) }),
    '',
    t('remoteSettings.common.added', language),
    ...(added.length ? added.map((line) => `+ ${line}`) : [t('remoteSettings.common.none', language)]),
    '',
    t('remoteSettings.common.removed', language),
    ...(removed.length ? removed.map((line) => `- ${line}`) : [t('remoteSettings.common.none', language)]),
  ];

  if (added.length >= 10 || removed.length >= 10) {
    previewLines.push('', t('remoteSettings.common.truncatedPreview', language));
  }

  return previewLines.join('\n');
}


const hiddenSystemInfoItemKeys = new Set(['cpuCores', 'memoryTotal', 'diskTotal']);

export function isVisibleSystemInfoItem(item: SysInfoItem) {
  return !hiddenSystemInfoItemKeys.has(item.key)
    && item.key !== 'hostname'
    && item.key !== 'os'
    && item.key !== 'user';
}

export function renderDiskInfoSummary(raw: string, language: AppLanguage) {
  const summary = parseDiskInfoSummary(raw);

  if (!summary) {
    return <pre className="sysinfo-card-value">{raw}</pre>;
  }

  return (
    <div className="sysinfo-feature-block">
      <div className="sysinfo-metric-grid">
        <div className="sysinfo-metric">
          <span>{t('remoteSettings.disk.available', language)}</span>
          <strong>{summary.available || '--'}</strong>
        </div>
        <div className="sysinfo-metric">
          <span>{t('remoteSettings.disk.total', language)}</span>
          <strong>{summary.total || '--'}</strong>
        </div>
      </div>
    </div>
  );
}

export function SettingsCommandPreview({ label, content }: { label: string; content: string }) {
  return (
    <div className="settings-command-preview">
      <div className="settings-command-preview-label">{label}</div>
      <pre>{content}</pre>
    </div>
  );
}

export function SettingsConfirmDialog({
  config,
  onClose,
}: {
  config: SettingsConfirmDialogConfig;
  onClose: () => void;
}) {
  const [isApplying, setIsApplying] = useState(false);
  const [applyError, setApplyError] = useState('');
  const language = useCurrentAppLanguage();
  const tone = config.tone ?? 'primary';

  const handleConfirm = async () => {
    setIsApplying(true);
    setApplyError('');
    try {
      await config.onConfirm();
      onClose();
    } catch (error) {
      setApplyError(getErrorMessage(error));
    } finally {
      setIsApplying(false);
    }
  };

  return createPortal(
    <div className="settings-modal-overlay" role="presentation" onClick={onClose}>
      <div
        className={`settings-modal ${tone}`}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="settings-confirm-title"
        data-testid="settings-confirm-dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <div id="settings-confirm-title" className="settings-modal-title">{config.title}</div>
        <div className="settings-modal-message">
          <p>{config.message}</p>
          {config.detail ? <small>{config.detail}</small> : null}
        </div>
        {config.preview ? <SettingsCommandPreview label={t('remoteSettings.common.preview', language)} content={config.preview} /> : null}
        {applyError ? <div className="settings-modal-error" role="alert" data-testid="settings-confirm-error">{applyError}</div> : null}
        <div className="settings-modal-actions">
          <button type="button" className="settings-modal-btn" onClick={onClose} disabled={isApplying}>{t('remoteSettings.common.cancel', language)}</button>
          <button
            type="button"
            className={`settings-modal-btn ${tone === 'danger' ? 'danger' : 'primary'}`}
            onClick={() => void handleConfirm()}
            disabled={isApplying}
          >
            {isApplying ? t('remoteSettings.common.applying', language) : config.confirmLabel ?? t('remoteSettings.common.confirm', language)}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

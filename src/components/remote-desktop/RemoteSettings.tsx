import { useCallback, useEffect, useState } from 'react';

import { getErrorMessage } from './desktopUtils';
import { isWindowsSystem, powershellCommand } from './remoteSystem';
import { useSudoCommand } from './sudoPrompt';
import { t, useCurrentAppLanguage, type AppLanguage } from '../../i18n';
import type { RemoteSystemType } from './types';
import type { RemoteSettingsProps, SettingsGroup, SettingsHostStatus, SettingsTab } from './settingsTypes';
import { parseKeyValueOutput } from './settingsParsers';
import { getSystemTypeLabel, RemoteSettingsCommandContext } from './settingsShared';
import SettingsHostsPanel from './SettingsHostsPanel';
import SettingsLoginSessionsPanel from './SettingsLoginSessionsPanel';
import SettingsNetworkPanel from './SettingsNetworkPanel';
import PackageSourcesPanel from './PackageSourcesPanel';
import SettingsRoutePanel from './SettingsRoutePanel';
import SettingsSystemInfoPanel from './SettingsSystemInfoPanel';
import SettingsUpdatePanel from './SettingsUpdatePanel';
import SettingsUserManagerPanel from './SettingsUserManagerPanel';
import { WindowsHostsPanel, WindowsNetworkPanel, WindowsRoutePanel, WindowsSystemInfoPanel } from './SettingsWindowsPanels';

const SETTINGS_GROUPS: SettingsGroup[] = [
  {
    labelId: 'remoteSettings.group.system',
    tabs: [
      { key: 'systeminfo', labelId: 'remoteSettings.tab.systemInfo.label', icon: '\u{1F4BB}', descriptionId: 'remoteSettings.tab.systemInfo.description' },
      { key: 'update', labelId: 'remoteSettings.tab.update.label', icon: '\u{1F504}', descriptionId: 'remoteSettings.tab.update.description' },
      { key: 'package-sources', labelId: 'remoteSettings.tab.packageSources.label', icon: '\u{1F5C4}', descriptionId: 'remoteSettings.tab.packageSources.description' },
    ],
  },
  {
    labelId: 'remoteSettings.group.accounts',
    tabs: [
      { key: 'users', labelId: 'remoteSettings.tab.users.label', icon: '\u{1F465}', descriptionId: 'remoteSettings.tab.users.description' },
      { key: 'loginsessions', labelId: 'remoteSettings.tab.loginsessions.label', icon: '\u{1F512}', descriptionId: 'remoteSettings.tab.loginsessions.description' },
    ],
  },
  {
    labelId: 'remoteSettings.group.network',
    tabs: [
      { key: 'network', labelId: 'remoteSettings.tab.network.label', icon: '\u{1F310}', descriptionId: 'remoteSettings.tab.network.description' },
      { key: 'hosts', labelId: 'remoteSettings.tab.hosts.label', icon: '\u{1F4CB}', descriptionId: 'remoteSettings.tab.hosts.description' },
      { key: 'route', labelId: 'remoteSettings.tab.route.label', icon: '\u{1F6E3}\uFE0F', descriptionId: 'remoteSettings.tab.route.description' },
    ],
  },
];

const WINDOWS_SETTINGS_GROUPS: SettingsGroup[] = [
  {
    labelId: 'remoteSettings.group.system',
    tabs: [
      { key: 'systeminfo', labelId: 'remoteSettings.tab.systemInfo.label', icon: '\u{1F4BB}', descriptionId: 'remoteSettings.tab.systemInfo.windowsDescription' },
      { key: 'loginsessions', labelId: 'remoteSettings.tab.loginsessions.label', icon: '\u{1F512}', descriptionId: 'remoteSettings.tab.loginsessions.description' },
    ],
  },
  {
    labelId: 'remoteSettings.group.network',
    tabs: [
      { key: 'network', labelId: 'remoteSettings.tab.network.windowsLabel', icon: '\u{1F310}', descriptionId: 'remoteSettings.tab.network.windowsDescription' },
      { key: 'hosts', labelId: 'remoteSettings.tab.hosts.label', icon: '\u{1F4CB}', descriptionId: 'remoteSettings.tab.hosts.windowsDescription' },
      { key: 'route', labelId: 'remoteSettings.tab.route.windowsLabel', icon: '\u{1F6E3}\uFE0F', descriptionId: 'remoteSettings.tab.route.windowsDescription' },
    ],
  },
];

function createInitialHostStatus(systemType: RemoteSystemType | undefined, language: AppLanguage): SettingsHostStatus {
  return {
    systemLabel: getSystemTypeLabel(systemType, language),
    userLabel: t('remoteSettings.status.detecting', language),
    privilegeLabel: t('remoteSettings.status.detecting', language),
    privilegeTone: 'unknown',
    hint: t('remoteSettings.status.loadingRemotePrivilege', language),
  };
}

function mapPrivilegeStatus(systemType: RemoteSystemType | undefined, values: Map<string, string>, language: AppLanguage): SettingsHostStatus {
  const privilege = values.get('PRIV') ?? 'unknown';
  const user = values.get('USER') || t('remoteSettings.status.userUnknown', language);
  const isWindowsHost = isWindowsSystem(systemType);

  if (privilege === 'root') {
    return {
      systemLabel: getSystemTypeLabel(systemType, language),
      userLabel: user,
      privilegeLabel: t('remoteSettings.status.root', language),
      privilegeTone: 'ready',
      hint: t('remoteSettings.status.rootHint', language),
    };
  }

  if (privilege === 'sudo') {
    return {
      systemLabel: getSystemTypeLabel(systemType, language),
      userLabel: user,
      privilegeLabel: t('remoteSettings.status.sudo', language),
      privilegeTone: 'ready',
      hint: t('remoteSettings.status.sudoHint', language),
    };
  }

  if (privilege === 'admin') {
    return {
      systemLabel: getSystemTypeLabel(systemType, language),
      userLabel: user,
      privilegeLabel: t('remoteSettings.status.admin', language),
      privilegeTone: 'ready',
      hint: t('remoteSettings.status.windowsAdminHint', language),
    };
  }

  return {
    systemLabel: getSystemTypeLabel(systemType, language),
    userLabel: user,
    privilegeLabel: isWindowsHost ? t('remoteSettings.status.regularUser', language) : t('remoteSettings.status.noRootSudo', language),
    privilegeTone: 'warning',
    hint: isWindowsHost ? t('remoteSettings.status.windowsUserHint', language) : t('remoteSettings.status.linuxUserHint', language),
  };
}

function SettingsStatusStrip({
  status,
  loading,
  language,
  onRefresh,
}: {
  status: SettingsHostStatus;
  loading: boolean;
  language: AppLanguage;
  onRefresh: () => void;
}) {
  return (
    <div className="settings-status-strip">
      <div className="settings-status-item">
        <span>{t('remoteSettings.status.system', language)}</span>
        <strong>{status.systemLabel}</strong>
      </div>
      <div className="settings-status-item">
        <span>{t('remoteSettings.status.user', language)}</span>
        <strong>{status.userLabel}</strong>
      </div>
      <div className={`settings-status-pill ${status.privilegeTone}`}>
        {status.privilegeLabel}
      </div>
      <div className="settings-status-hint">{status.hint}</div>
      <button type="button" className="settings-action-btn" onClick={onRefresh} disabled={loading}>
        {loading ? t('remoteSettings.status.detecting', language) : t('remoteSettings.status.detectPrivilege', language)}
      </button>
    </div>
  );
}

/* ─── Main Component ──────────────────────────────────────────────────────── */

function RemoteSettings({ connectionId, systemType, initialTab = 'systeminfo', initialTabRequestId = 0, onOpenTerminal }: RemoteSettingsProps) {
  const language = useCurrentAppLanguage();
  const isWindowsHost = isWindowsSystem(systemType);
  const { runCommand, sudoPrompt } = useSudoCommand(connectionId, systemType);
  const settingsGroups = isWindowsHost ? WINDOWS_SETTINGS_GROUPS : SETTINGS_GROUPS;
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);
  const [hostStatus, setHostStatus] = useState<SettingsHostStatus>(() => createInitialHostStatus(systemType, language));
  const [hostStatusLoading, setHostStatusLoading] = useState(false);

  const refreshHostStatus = useCallback(async () => {
    setHostStatusLoading(true);
    setHostStatus((currentStatus) => ({
      ...currentStatus,
      systemLabel: getSystemTypeLabel(systemType, language),
      hint: t('remoteSettings.status.loadingRemotePrivilege', language),
    }));

    try {
      const command = isWindowsHost
        ? powershellCommand(`
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$privilege = if ($isAdmin) { 'admin' } else { 'user' }
Write-Output ("USER=" + $identity.Name)
Write-Output ("PRIV=" + $privilege)
`)
        : `user="$(id -un 2>/dev/null || whoami 2>/dev/null || printf unknown)"; uid="$(id -u 2>/dev/null || printf '')"; if [ "$uid" = "0" ]; then priv=root; elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then priv=sudo; else priv=user; fi; printf 'USER=%s\\nUID=%s\\nPRIV=%s\\n' "$user" "$uid" "$priv"`;
      const result = await runCommand(command);
      setHostStatus(mapPrivilegeStatus(systemType, parseKeyValueOutput(result.stdout || result.stderr || ''), language));
    } catch (err) {
      setHostStatus({
        systemLabel: getSystemTypeLabel(systemType, language),
        userLabel: t('remoteSettings.status.userUnknown', language),
        privilegeLabel: t('remoteSettings.status.detectFailed', language),
        privilegeTone: 'danger',
        hint: getErrorMessage(err),
      });
    } finally {
      setHostStatusLoading(false);
    }
  }, [isWindowsHost, language, runCommand, systemType]);

  useEffect(() => {
    if (!settingsGroups.some((group) => group.tabs.some((tab) => tab.key === activeTab))) {
      setActiveTab('systeminfo');
    }
  }, [activeTab, settingsGroups]);

  useEffect(() => {
    if (settingsGroups.some((group) => group.tabs.some((tab) => tab.key === initialTab))) {
      setActiveTab(initialTab);
    }
  }, [initialTab, initialTabRequestId, settingsGroups]);

  useEffect(() => { void refreshHostStatus(); }, [refreshHostStatus]);

  const renderPanel = () => {
    if (isWindowsHost) {
      switch (activeTab) {
        case 'systeminfo': return <WindowsSystemInfoPanel connectionId={connectionId} />;
        case 'network': return <WindowsNetworkPanel />;
        case 'hosts': return <WindowsHostsPanel connectionId={connectionId} />;
        case 'route': return <WindowsRoutePanel />;
        case 'loginsessions': return <SettingsLoginSessionsPanel connectionId={connectionId} systemType={systemType} />;
        default: return <WindowsSystemInfoPanel connectionId={connectionId} />;
      }
    }

    switch (activeTab) {
      case 'systeminfo': return <SettingsSystemInfoPanel connectionId={connectionId} />;
      case 'network': return <SettingsNetworkPanel />;
      case 'update': return <SettingsUpdatePanel />;
      case 'package-sources': return <PackageSourcesPanel connectionId={connectionId} systemType={systemType} onOpenTerminal={onOpenTerminal} />;
      case 'hosts': return <SettingsHostsPanel />;
      case 'route': return <SettingsRoutePanel />;
      case 'users': return <SettingsUserManagerPanel />;
      case 'loginsessions': return <SettingsLoginSessionsPanel connectionId={connectionId} systemType={systemType} />;
      default: return null;
    }
  };

  return (
    <RemoteSettingsCommandContext.Provider value={runCommand}>
      <div className="settings-pane">
        <nav className="settings-sidebar" aria-label={t('remoteSettings.nav.aria', language)}>
          {settingsGroups.map((group) => (
            <div key={group.labelId}>
              <div className="settings-sidebar-group-label">{t(group.labelId, language)}</div>
              {group.tabs.map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  className={`settings-nav-item ${activeTab === tab.key ? 'active' : ''}`}
                  onClick={() => setActiveTab(tab.key)}
                >
                  <span className="settings-nav-icon">{tab.icon}</span>
                  <div className="settings-nav-text">
                    <strong>{t(tab.labelId, language)}</strong>
                    <small>{t(tab.descriptionId, language)}</small>
                  </div>
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="settings-main">
          <SettingsStatusStrip status={hostStatus} loading={hostStatusLoading} language={language} onRefresh={() => void refreshHostStatus()} />
          <div className="settings-panel-shell">
            {renderPanel()}
          </div>
        </div>
      </div>
      {sudoPrompt}
    </RemoteSettingsCommandContext.Provider>
  );
}

export default RemoteSettings;

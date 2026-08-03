import { type ComponentType, lazy } from 'react';

function lazyWithStyle<T extends ComponentType<any>>(
  componentLoader: () => Promise<{ default: T }>,
  styleLoader: () => Promise<unknown>,
) {
  return lazy(() => Promise.all([componentLoader(), styleLoader()]).then(([componentModule]) => componentModule));
}

export const RemoteApiDebugger = lazyWithStyle(() => import('../../components/remote-desktop/RemoteApiDebugger'), () => import('../../styles/remote-desktop/_api-debugger.scss'));
export const RemoteAiChat = lazyWithStyle(() => import('../../components/remote-desktop/RemoteAiChat'), () => import('../../styles/remote-desktop/_ai-chat.scss'));
export const RemoteApacheManager = lazyWithStyle(() => import('../../components/remote-desktop/RemoteApacheManager'), () => import('../../styles/remote-desktop/_apache-manager.scss'));
export const RemoteBrowser = lazyWithStyle(() => import('../../components/remote-desktop/RemoteBrowser'), () => import('../../styles/remote-desktop/_browser.scss'));
export const RemoteCertManager = lazyWithStyle(() => import('../../components/remote-desktop/RemoteCertManager'), () => import('../../styles/remote-desktop/_cert-manager.scss'));
export const RemoteCaddyManager = lazyWithStyle(() => import('../../components/remote-desktop/RemoteCaddyManager'), () => import('../../styles/remote-desktop/_caddy-manager.scss'));
export const RemoteClickHouse = lazyWithStyle(() => import('../../components/remote-desktop/RemoteClickHouse'), () => import('../../styles/remote-desktop/_clickhouse.scss'));
export const RemoteCodeEditor = lazyWithStyle(() => import('../../components/remote-desktop/RemoteCodeEditor'), () => import('../../styles/remote-desktop/_code-editor.scss'));
export const RemoteContainerManager = lazyWithStyle(() => import('../../components/remote-desktop/RemoteContainerManager'), () => import('../../styles/remote-desktop/_container-manager.scss'));
export const RemoteDiskAnalyzer = lazyWithStyle(() => import('../../components/remote-desktop/RemoteDiskAnalyzer'), () => import('../../styles/remote-desktop/_disk-analyzer.scss'));
export const RemoteDiskManager = lazyWithStyle(() => import('../../components/remote-desktop/RemoteDiskManager'), () => import('../../styles/remote-desktop/_disk-manager.scss'));
export const RemoteFileExplorer = lazyWithStyle(() => import('../../components/remote-desktop/RemoteFileExplorer'), () => import('../../styles/remote-desktop/_file-explorer.scss'));
export const RemoteFirewallManager = lazyWithStyle(() => import('../../components/remote-desktop/RemoteFirewallManager'), () => import('../../styles/remote-desktop/_firewall-manager.scss'));
export const RemoteFrpManager = lazy(() => import('../../components/remote-desktop/RemoteFrpManager'));
export const RemoteFrpsManager = lazy(() => import('../../components/remote-desktop/RemoteFrpsManager'));
export const RemoteGitManager = lazyWithStyle(() => import('../../components/remote-desktop/RemoteGitManager'), () => import('../../styles/remote-desktop/_git-manager.scss'));
export const RemoteIptablesManager = lazyWithStyle(() => import('../../components/remote-desktop/RemoteIptablesManager'), () => import('../../styles/remote-desktop/_iptables-manager.scss'));
export const RemoteK8sManager = lazyWithStyle(() => import('../../components/remote-desktop/RemoteK8sManager'), () => import('../../styles/remote-desktop/_k8s-manager.scss'));
export const RemoteVirtualMachineManager = lazyWithStyle(
  () => import('../../components/remote-desktop/RemoteVirtualMachineManager'),
  () => Promise.all([
    import('../../styles/remote-desktop/_vm-manager.scss'),
    import('../../styles/remote-desktop/_vm-manager-management.scss'),
  ]),
);
export const RemoteLogViewer = lazyWithStyle(() => import('../../components/remote-desktop/RemoteLogViewer'), () => import('../../styles/remote-desktop/_log-viewer.scss'));
export const RemoteMessageQueuePanel = lazyWithStyle(() => import('../../components/remote-desktop/RemoteMessageQueuePanel'), () => import('../../styles/remote-desktop/_message-queue.scss'));
export const RemoteMonitor = lazyWithStyle(() => import('../../components/remote-desktop/RemoteMonitor'), () => import('../../styles/remote-desktop/_monitor.scss'));
export const RemoteMongo = lazyWithStyle(() => import('../../components/remote-desktop/RemoteMongo'), () => import('../../styles/remote-desktop/_mongo.scss'));
export const RemoteMySQL = lazyWithStyle(() => import('../../components/remote-desktop/RemoteMySQL'), () => import('../../styles/remote-desktop/_mysql.scss'));
export const RemoteNetworkDiagnostics = lazyWithStyle(() => import('../../components/remote-desktop/RemoteNetworkDiagnostics'), () => import('../../styles/remote-desktop/_network-diagnostics.scss'));
export const RemoteNginxManager = lazyWithStyle(() => import('../../components/remote-desktop/RemoteNginxManager'), () => import('../../styles/remote-desktop/_nginx-manager.scss'));
export const RemoteNotepad = lazyWithStyle(() => import('../../components/remote-desktop/RemoteNotepad'), () => import('../../styles/remote-desktop/_notepad.scss'));
export const RemotePackageManager = lazyWithStyle(() => import('../../components/remote-desktop/RemotePackageManager'), () => import('../../styles/remote-desktop/_package-manager.scss'));
export const RemotePortManager = lazyWithStyle(() => import('../../components/remote-desktop/RemotePortManager'), () => import('../../styles/remote-desktop/_port-manager.scss'));
export const RemotePostgres = lazyWithStyle(() => import('../../components/remote-desktop/RemotePostgres'), () => import('../../styles/remote-desktop/_postgres.scss'));
export const RemoteProcessManager = lazyWithStyle(() => import('../../components/remote-desktop/RemoteProcessManager'), () => import('../../styles/remote-desktop/_process-manager.scss'));
export const RemoteRedis = lazyWithStyle(() => import('../../components/remote-desktop/RemoteRedis'), () => import('../../styles/remote-desktop/_redis.scss'));
export const RemoteS3Browser = lazyWithStyle(() => import('../../components/remote-desktop/RemoteS3Browser'), () => import('../../styles/remote-desktop/_s3-browser.scss'));
export const RemoteScheduledTasks = lazyWithStyle(() => import('../../components/remote-desktop/RemoteScheduledTasks'), () => import('../../styles/remote-desktop/_scheduled-tasks.scss'));
export const RemoteSearchCluster = lazyWithStyle(() => import('../../components/remote-desktop/RemoteSearchCluster'), () => import('../../styles/remote-desktop/_search-cluster.scss'));
export const RemoteSecurityAudit = lazyWithStyle(() => import('../../components/remote-desktop/RemoteSecurityAudit'), () => import('../../styles/remote-desktop/_security-audit.scss'));
export const RemoteServiceManager = lazyWithStyle(() => import('../../components/remote-desktop/RemoteServiceManager'), () => import('../../styles/remote-desktop/_service-manager.scss'));
export const RemoteSupervisorManager = lazyWithStyle(() => import('../../components/remote-desktop/RemoteSupervisorManager'), () => import('../../styles/remote-desktop/_supervisor-manager.scss'));
export const RemoteBackupManager = lazyWithStyle(() => import('../../components/remote-desktop/RemoteBackupManager'), () => import('../../styles/remote-desktop/_backup-manager.scss'));
export const RemoteSettings = lazyWithStyle(() => import('../../components/remote-desktop/RemoteSettings'), () => import('../../styles/remote-desktop/_settings.scss'));
export const RemoteSqlite = lazyWithStyle(() => import('../../components/remote-desktop/RemoteSqlite'), () => import('../../styles/remote-desktop/_sqlite.scss'));
export const RemoteTerminal = lazyWithStyle(() => import('../../components/remote-desktop/RemoteTerminal'), () => import('../../styles/remote-desktop/_terminal.scss'));
export const TerminalRestorePlaceholder = lazyWithStyle(
  () => import('../../components/remote-desktop/TerminalRestorePlaceholder').then((module) => ({ default: module.TerminalRestorePlaceholder })),
  () => import('../../styles/remote-desktop/_terminal.scss'),
);
export const RemoteVncViewer = lazyWithStyle(() => import('../../components/remote-desktop/RemoteVncViewer'), () => import('../../styles/remote-desktop/_vnc.scss'));
export const RemoteRdpViewer = lazyWithStyle(() => import('../../components/remote-desktop/RemoteRdpViewer'), () => import('../../styles/remote-desktop/_rdp-viewer.scss'));

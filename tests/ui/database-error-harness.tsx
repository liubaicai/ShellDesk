import React from 'react';
import { createRoot } from 'react-dom/client';

import HostListPanel from '../../src/components/HostListPanel';
import RemoteBrowser from '../../src/components/remote-desktop/RemoteBrowser';
import RemoteBackupManager from '../../src/components/remote-desktop/RemoteBackupManager';
import { DesktopAppIcon } from '../../src/components/remote-desktop/RemoteDesktopAppIcon';
import RemoteFileExplorer from '../../src/components/remote-desktop/RemoteFileExplorer';
import RemoteMySQL from '../../src/components/remote-desktop/RemoteMySQL';
import RemoteMonitor from '../../src/components/remote-desktop/RemoteMonitor';
import RemoteRedis from '../../src/components/remote-desktop/RemoteRedis';
import RemoteRdpViewer from '../../src/components/remote-desktop/RemoteRdpViewer';
import RemoteSettings from '../../src/components/remote-desktop/RemoteSettings';
import RemoteSupervisorManager from '../../src/components/remote-desktop/RemoteSupervisorManager';
import RemoteVirtualMachineManager from '../../src/components/remote-desktop/RemoteVirtualMachineManager';
import { useShellDeskEditorTheme } from '../../src/components/remote-desktop/useShellDeskEditorTheme';
import SftpTransferWindow from '../../src/components/sftp-transfer/SftpTransferWindow';
import { loadFullMessageCatalog } from '../../src/i18n';
import type { DesktopAppKey } from '../../src/remoteDesktopCatalog';
import '../../src/styles/critical.scss';
import '../../src/styles/deferred.scss';
import '../../src/styles/remote-desktop/_backup-manager.scss';
import '../../src/styles/remote-desktop/_browser.scss';
import '../../src/styles/remote-desktop/_file-explorer.scss';
import '../../src/styles/remote-desktop/_monitor.scss';
import '../../src/styles/remote-desktop/_mysql.scss';
import '../../src/styles/remote-desktop/_rdp-viewer.scss';
import '../../src/styles/remote-desktop/_redis.scss';
import '../../src/styles/remote-desktop/_settings.scss';
import '../../src/styles/remote-desktop/_supervisor-manager.scss';
import '../../src/styles/remote-desktop/_vm-manager-management.scss';
import '../../src/styles/remote-desktop/_vm-manager.scss';

const LazyRemoteFrpManager = React.lazy(() => import('../../src/components/remote-desktop/RemoteFrpManager'));
const LazyRemoteFrpsManager = React.lazy(() => import('../../src/components/remote-desktop/RemoteFrpsManager'));

const harnessTheme = new URLSearchParams(window.location.search).get('theme');
if (harnessTheme === 'light' || harnessTheme === 'dark') {
  document.documentElement.setAttribute('data-theme', harnessTheme);
}

const connectionId = 'ui-test-connection';
const hostId = 'ui-test-host';
const now = new Date('2026-01-01T00:00:00Z').toISOString();
const hostListFixtures = [
  {
    id: 'host-wrapped-tags',
    name: '192.168.2.230',
    address: '192.168.2.230',
    port: 22,
    username: 'root',
    group: 'CYZ',
    tags: ['MiniPC', 'AI'],
    note: '',
    jumpHostId: '',
    canBeJumpHost: false,
    proxyProfileId: '',
    systemName: 'Debian GNU/Linux',
    systemType: 'debian',
    lastConnectionStatus: 'success',
    lastConnectionAt: now,
    lastConnectionError: '',
  },
  {
    id: 'host-single-tag',
    name: 'console.big.example',
    address: '82.156.143.27',
    port: 22,
    username: 'root',
    group: 'Cloud',
    tags: ['腾讯云'],
    note: '',
    jumpHostId: '',
    canBeJumpHost: false,
    proxyProfileId: '',
    systemName: 'Debian GNU/Linux',
    systemType: 'debian',
    lastConnectionStatus: 'success',
    lastConnectionAt: now,
    lastConnectionError: '',
  },
];
const emptyProxyProfiles = new Map<string, ShellDeskProxyProfile>();

function createSftpEntries(prefix: string) {
  return [
    { name: 'shared-folder', longname: 'drwxr-xr-x shared-folder', type: 'directory' as const, size: 0, modifiedAt: now },
    ...Array.from({ length: 72 }, (_, index) => ({
      name: `${prefix}-${String(index + 1).padStart(2, '0')}.txt`,
      longname: `-rw-r--r-- ${prefix}-${String(index + 1).padStart(2, '0')}.txt`,
      type: 'file' as const,
      size: index + 1,
      modifiedAt: now,
    })),
  ];
}

function createNestedSftpEntries(prefix: string) {
  return [
    { name: `${prefix}-nested-folder`, longname: `drwxr-xr-x ${prefix}-nested-folder`, type: 'directory' as const, size: 0, modifiedAt: now },
    { name: `${prefix}-nested-file.txt`, longname: `-rw-r--r-- ${prefix}-nested-file.txt`, type: 'file' as const, size: 12, modifiedAt: now },
  ];
}

function createMysqlResult(columns: string[], rows: Record<string, unknown>[]) {
  return {
    columns,
    rows,
    rowCount: rows.length,
    affectedRows: 0,
  };
}

function createCommandResult(stdout = '', stderr = '', code = 0) {
  return { stdout, stderr, code };
}

const virshSection = '__SHELLDESK_VIRSH_SECTION__=';

function createVirshOverview() {
  const domains = [
    ['web-01', 'running', '2', '4194304', 'yes', '192.168.122.101'],
    ['db-01', 'running', '4', '8388608', 'yes', '192.168.122.102'],
    ['app-01', 'running', '2', '4194304', 'yes', '192.168.122.103'],
    ['cache-01', 'shut off', '2', '2097152', 'no', ''],
    ['jumpserver', 'shut off', '1', '1048576', 'no', ''],
    ['backup-01', 'paused', '2', '4194304', 'yes', '192.168.122.120'],
    ['test-win10', 'shut off', '4', '8388608', 'no', ''],
    ['old-centos7', 'shut off', '2', '4194304', 'no', ''],
  ];
  return [
    `${virshSection}meta`,
    'virshVersion=11.3.0',
    'uri=qemu:///system',
    'hostname=home-ldev.example.com',
    'hypervisor=QEMU 10.0.1',
    'cpuModel=x86_64',
    'cpuCount=96',
    'memoryKiB=67108864',
    ...domains.flatMap(([name, state, vcpus, memory, autostart, ip], index) => [
      `${virshSection}domain`,
      `uuid=00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      `name=${name}`,
      `state=${state}`,
      `id=${state === 'running' ? index + 1 : '-'}`,
      `vcpus=${vcpus}`,
      `maxMemoryKiB=${memory}`,
      `usedMemoryKiB=${memory}`,
      'persistent=yes',
      `autostart=${autostart}`,
      'managedSave=no',
      `ipAddresses=${ip}`,
    ]),
  ].join('\n');
}

function createVirshResources() {
  return [
    `${virshSection}network`,
    'uuid=10000000-0000-4000-8000-000000000001',
    'name=default',
    'active=yes',
    'persistent=yes',
    'autostart=yes',
    'bridge=virbr0',
    `${virshSection}pool`,
    'uuid=20000000-0000-4000-8000-000000000001',
    'name=default',
    'state=running',
    'persistent=yes',
    'autostart=yes',
    'capacityBytes=2.8 TiB',
    'allocationBytes=1.2 TiB',
    'availableBytes=1.6 TiB',
  ].join('\n');
}

function createVirshDetail() {
  return [
    `${virshSection}xml`,
    '<domain type="kvm"><name>db-01</name><uuid>00000000-0000-4000-8000-000000000002</uuid><os><type arch="x86_64" machine="pc-q35-10.0">hvm</type><boot dev="hd"/></os><vcpu current="4">4</vcpu><memory unit="KiB">8388608</memory><currentMemory unit="KiB">8388608</currentMemory><devices><emulator>/usr/bin/qemu-system-x86_64</emulator><disk type="file" device="disk"><driver type="qcow2"/><source file="/var/lib/libvirt/images/db-01.qcow2"/><target dev="vda" bus="virtio"/></disk><interface type="network"><mac address="52:54:00:ab:cd:ef"/><source network="default"/><model type="virtio"/><target dev="vnet1"/></interface></devices></domain>',
    `${virshSection}stats`,
    'cpu.time=7200000000000',
    'balloon.current=8388608',
    `${virshSection}addresses`,
    'vnet1 52:54:00:ab:cd:ef ipv4 192.168.122.102/24',
    `${virshSection}display`,
    'vnc://192.168.122.1:5902',
    `${virshSection}snapshots`,
  ].join('\n');
}

function createUserSnapshot() {
  return [
    '__SHELLDESK_PASSWD__',
    'root:x:0:0:root:/root:/bin/bash',
    'demo:x:1000:1000:Demo User:/home/demo:/bin/bash',
    '__SHELLDESK_GROUP__',
    'root:x:0:',
    'demo:x:1000:',
    'sudo:x:27:demo',
    '__SHELLDESK_PASSWD_STATUS__',
    'root L',
    'demo P',
    '__SHELLDESK_SUDOERS__',
    '%sudo ALL=(ALL:ALL) ALL',
    '',
  ].join('\n');
}

function createUserDetail() {
  return [
    '__SHELLDESK_DETAIL_GROUPS__',
    'demo sudo',
    '__SHELLDESK_DETAIL_SSH_KEYS__',
    '1',
    '__SHELLDESK_DETAIL_LASTLOG__',
    'demo pts/0 192.0.2.10 Mon Jan 1 00:00:00 +0000 2026',
    '__SHELLDESK_DETAIL_CHAGE__',
    'Password expires : never',
    '',
  ].join('\n');
}

function installGuiSshMock() {
  const params = new URLSearchParams(window.location.search);
  const scenario = params.get('scenario') ?? '';
  const mysqlColumns = [
    { name: 'id', type: 'INT', nullable: false, key: 'PRI', default: null },
    { name: 'name', type: 'VARCHAR(64)', nullable: true, key: '', default: null },
  ];
  const redisKey = {
    name: 'demo:key',
    type: 'string',
    ttl: -1,
    size: 5,
    scannedAt: now,
  };
  let sudoPromptShown = false;
  let monitorEnabled = false;
  let monitorConfigured = false;
  let monitorThresholds = { cpu: 90, memory: 90, disk: 85 };
  let metricsCounter = 1_000_000;
  let metricsRequestCount = 0;
  let virshRequestCount = 0;
  let lastVirshCommand = '';
  let lastVirshStdin = '';
  let lastSftpTransferOptions: ShellDeskSftpTransferOptions | undefined;
  let lastSupervisorActionCommand = '';
  let backupCreated = false;
  let backupPlanSaved = false;
  let lastBackupCommand = '';
  let lastBackupStdin = '';
  let lastBackupPlanStdin = '';
  let lastBackupDownloadPath = '';
  let lastBackupS3Command = '';
  let lastBackupS3Stdin = '';
  let rdpDiagnosticListener: ((payload: ShellDeskRdpDiagnosticPayload) => void) | undefined;

  window.localStorage.removeItem('shelldesk.monitor.persistencePrompt.v1.ui-test-host');
  Object.defineProperty(window, '__shellDeskUiHarnessMetricsRequestCount', {
    configurable: true,
    get: () => metricsRequestCount,
  });
  Object.defineProperty(window, '__shellDeskUiHarnessVirshRequestCount', {
    configurable: true,
    get: () => virshRequestCount,
  });
  Object.defineProperty(window, '__shellDeskUiHarnessLastVirshCommand', { configurable: true, get: () => lastVirshCommand });
  Object.defineProperty(window, '__shellDeskUiHarnessLastVirshStdin', { configurable: true, get: () => lastVirshStdin });
  Object.defineProperty(window, '__shellDeskUiHarnessLastSftpTransferOptions', { configurable: true, get: () => lastSftpTransferOptions });
  Object.defineProperty(window, '__shellDeskUiHarnessLastSupervisorActionCommand', { configurable: true, get: () => lastSupervisorActionCommand });
  Object.defineProperty(window, '__shellDeskUiHarnessLastBackupCommand', { configurable: true, get: () => lastBackupCommand });
  Object.defineProperty(window, '__shellDeskUiHarnessLastBackupStdin', { configurable: true, get: () => lastBackupStdin });
  Object.defineProperty(window, '__shellDeskUiHarnessLastBackupPlanStdin', { configurable: true, get: () => lastBackupPlanStdin });
  Object.defineProperty(window, '__shellDeskUiHarnessLastBackupDownloadPath', { configurable: true, get: () => lastBackupDownloadPath });
  Object.defineProperty(window, '__shellDeskUiHarnessLastBackupS3Command', { configurable: true, get: () => lastBackupS3Command });
  Object.defineProperty(window, '__shellDeskUiHarnessLastBackupS3Stdin', { configurable: true, get: () => lastBackupS3Stdin });

  (window as any).guiSSH = {
    platform: 'win32',
    files: {
      listLocalDirectory: async (path: string) => {
        const normalizedPath = path.replaceAll('\\', '/');
        if (normalizedPath === '/') {
          return { path: '/', entries: [{ name: 'D:', longname: 'drwxr-xr-x D:', type: 'directory' as const, size: 0, modifiedAt: now }] };
        }
        if (/^[a-z]:\/?$/i.test(normalizedPath)) {
          return { path: 'D:/', entries: [{ name: 'ui-test', longname: 'drwxr-xr-x ui-test', type: 'directory' as const, size: 0, modifiedAt: now }] };
        }
        if (normalizedPath.endsWith('/local-nested-folder')) {
          return { path: normalizedPath, entries: [{ name: 'local-deep-folder', longname: 'drwxr-xr-x local-deep-folder', type: 'directory' as const, size: 0, modifiedAt: now }] };
        }
        if (normalizedPath.endsWith('/shared-folder')) return { path: 'D:/ui-test/shared-folder', entries: createNestedSftpEntries('local') };
        return { path: 'D:/ui-test', entries: createSftpEntries('local') };
      },
      statLocalPath: async () => ({ type: 'file', size: 1, mode: 0o644, owner: 0, group: 0, modifiedAt: now, accessedAt: now }),
      createLocalDirectory: async () => true,
      createLocalFile: async () => true,
      deleteLocalPath: async () => true,
      renameLocalPath: async () => true,
    },
    connections: {
      runCommand: async (_connectionId: string, command: string, stdin?: string, options?: { sudoPassword?: string }) => {
        if (command === 'sh -s' && stdin?.includes('for tool in') && stdin.includes('mysqldump')) {
          return createCommandResult('tar\ngzip\nmysqldump\nmysql\npg_dump\npg_restore\nmongodump\nmongorestore\nsqlite3\naws\nmc\ncrontab\n');
        }
        if (command === 'sh -s' && stdin?.includes('__SHELLDESK_BACKUP_ITEM__')) {
          const rows = [
            '__SHELLDESK_BACKUP_ITEM__\tshelldesk-files-assets-20260101-020000.tar.gz\t/home/demo/backups/shelldesk-files-assets-20260101-020000.tar.gz\t4096\t1767232800',
            '__SHELLDESK_BACKUP_ITEM__\tshelldesk-postgres-app-20260101-010000.dump\t/home/demo/backups/shelldesk-postgres-app-20260101-010000.dump\t8192\t1767229200',
          ];
          if (backupCreated) {
            rows.unshift('__SHELLDESK_BACKUP_ITEM__\tshelldesk-mysql-production-20260101-030000.sql.gz\t/home/demo/backups/shelldesk-mysql-production-20260101-030000.sql.gz\t12288\t1767236400');
          }
          return createCommandResult(rows.join('\n'));
        }
        if (command === 'sh -s' && stdin?.trim() === 'crontab -l 2>/dev/null || true') {
          return createCommandResult(backupPlanSaved
            ? '# SHELLDESK_BACKUP:mysql-production|mysql|production|~/.config/shelldesk/backup-plans/mysql-production.sh\n0 2 * * * "$HOME/.config/shelldesk/backup-plans/mysql-production.sh"'
            : '');
        }
        if (command === 'sh -s' && stdin?.includes('__SHELLDESK_BACKUP_VALIDATION__')) {
          return createCommandResult('__SHELLDESK_BACKUP_VALIDATION__\tabcdef0123456789\tgzip stream valid');
        }
        if (command === 'sh -s' && stdin?.includes('# SHELLDESK_BACKUP:mysql-production|')) {
          backupPlanSaved = true;
          lastBackupPlanStdin = stdin;
          return createCommandResult('');
        }
        if (command === 'sh -s' && stdin?.includes('MC_HOST_shelldesk=')) {
          lastBackupS3Command = command;
          lastBackupS3Stdin = stdin;
          return createCommandResult('');
        }
        if (command.includes('SHELLDESK_VIRSH_URI=')) {
          virshRequestCount += 1;
          if (command.includes('\nset -e\n')) {
            lastVirshCommand = command;
            lastVirshStdin = stdin ?? '';
          }
        }
        if (scenario === 'sudo-prompt' && !sudoPromptShown && !options?.sudoPassword) {
          sudoPromptShown = true;
          return createCommandResult('', 'sudo: a password is required', 1);
        }
        if (command.includes('command -v supervisorctl')) {
          return createCommandResult([
            'installed=true',
            'executable=/usr/bin/supervisorctl',
            'version=4.2.5',
            'running=true',
            'statusMessage=',
            'config=/etc/supervisor/supervisord.conf',
            'config=/etc/supervisor/conf.d/web.conf',
          ].join('\n'));
        }
        if (command.trim() === 'supervisorctl status 2>&1') {
          return createCommandResult([
            'web                             RUNNING   pid 1801, uptime 2:14:32',
            'queue:worker                    RUNNING   pid 1804, uptime 2:14:30',
            'scheduler                       STOPPED   Not started',
            'legacy                          BACKOFF   Exited too quickly (process log may have details)',
          ].join('\n'));
        }
        if (command.startsWith('head -n 600 ')) {
          return createCommandResult(command.includes('web.conf')
            ? '[program:web]\ncommand=gunicorn app:application\nautostart=true'
            : '[supervisord]\nlogfile=/var/log/supervisor/supervisord.log');
        }
        if (command.startsWith('supervisorctl tail ')) {
          const stream = command.includes(' stderr ') ? 'stderr' : 'stdout';
          return createCommandResult(`web ${stream} line 1\nweb ${stream} line 2`);
        }
        if (/^supervisorctl (?:start|stop|restart|reload)\b/.test(command.trim())) {
          lastSupervisorActionCommand = command.trim();
          return createCommandResult('ok');
        }
        if (command.includes('__SHELLDESK_PASSWD__')) {
          return createCommandResult(createUserSnapshot());
        }
        if (command.includes('shelldesk_virsh nodeinfo')) {
          return createCommandResult(createVirshOverview());
        }
        if (command.includes('network_uuids=')) {
          return createCommandResult(createVirshResources());
        }
        if (command.includes('shelldesk_virsh dumpxml')) {
          return createCommandResult(createVirshDetail());
        }
        if (command.includes('__SHELLDESK_DETAIL_GROUPS__')) {
          return createCommandResult(createUserDetail());
        }
        if (/userdel\b/.test(command)) {
          return createCommandResult('', 'mock delete user failure', 1);
        }
        if (/^w\s+-h\b/.test(command.trim())) {
          return createCommandResult('demo pts/0 192.0.2.10 00:00 1:23 0.01s 0.01s bash\n');
        }
        if (command.includes('PRIV=')) {
          return createCommandResult('USER=demo\nUID=1000\nPRIV=user\n');
        }
        return createCommandResult('');
      },
      runCommandStream: async (
        _connectionId: string,
        command: string,
        stdin?: string,
        callbacks?: ShellDeskRunCommandStreamCallbacks,
      ) => {
        if (command === 'sh -s' && stdin?.includes('__SHELLDESK_BACKUP_CREATED__')) {
          backupCreated = true;
          lastBackupCommand = command;
          lastBackupStdin = stdin;
          callbacks?.onChunk?.('Creating protected backup...\n', 'stdout');
          return createCommandResult('__SHELLDESK_BACKUP_CREATED__\t/home/demo/backups/shelldesk-mysql-production-20260101-030000.sql.gz');
        }
        if (command === 'sh -s' && stdin?.includes('backup_path=')) {
          callbacks?.onChunk?.('Restore completed.\n', 'stdout');
          return createCommandResult('');
        }
        return createCommandResult('');
      },
      resolveBrowserUrl: async (_connectionId: string, url: string) => {
        if (url.includes('badcert')) {
          throw new Error('CERT_AUTHORITY_INVALID mock certificate failure');
        }
        if (url.includes('proxy-fail')) {
          throw new Error('PROXY_TUNNEL_FAILED mock proxy failure');
        }
        return { browserUrl: url };
      },
      trustBrowserCertificate: async () => true,
      listDirectory: async () => ({
        path: '/tmp',
        entries: [
          {
            name: 'secure.txt',
            longname: '-rw-r--r-- 1 demo demo 12 Jan 1 00:00 secure.txt',
            type: 'file',
            size: 12,
            modifiedAt: now,
          },
        ],
      }),
      statPath: async () => ({
        type: 'file',
        size: 12,
        mode: 0o644,
        owner: 1000,
        group: 1000,
        modifiedAt: now,
        accessedAt: now,
      }),
      setPathPermissions: async () => {
        throw new Error('mock chmod permission failure');
      },
      deletePath: async () => {
        throw new Error('mock delete failure');
      },
      createDirectory: async () => true,
      createFile: async () => true,
      renamePath: async () => true,
      downloadFile: async (_connectionId: string, remotePath: string) => {
        lastBackupDownloadPath = remotePath;
        return { canceled: false, path: 'secure.txt' };
      },
      downloadPaths: async () => ({ path: 'secure.zip' }),
      uploadLocalPaths: async () => true,
      selectUploadFiles: async () => null,
      selectUploadFolders: async () => null,
      cancelTransfer: async () => true,
      sftpListDirectory: async (_connectionId: string, path: string) => {
        if (path === '/') {
          return { path: '/', entries: [{ name: 'root', longname: 'drwxr-xr-x root', type: 'directory' as const, size: 0, modifiedAt: now }] };
        }
        if (path.endsWith('/remote-nested-folder')) {
          return { path, entries: [{ name: 'remote-deep-folder', longname: 'drwxr-xr-x remote-deep-folder', type: 'directory' as const, size: 0, modifiedAt: now }] };
        }
        if (path.endsWith('/shared-folder')) return { path: '/root/shared-folder', entries: createNestedSftpEntries('remote') };
        return { path: '/root', entries: createSftpEntries('remote') };
      },
      sftpStatPath: async () => ({ type: 'file', size: 1, mode: 0o644, owner: 0, group: 0, modifiedAt: now, accessedAt: now }),
      sftpCreateDirectory: async () => true,
      sftpCreateFile: async () => true,
      sftpDeletePath: async () => true,
      sftpRenamePath: async () => true,
      sftpSetPathPermissions: async () => true,
      sftpCompareDirectories: async () => ({ localDifferences: [], remoteDifferences: [], transferItems: [], differenceCount: 0 }),
      sftpUploadLocalPaths: async (_connectionId: string, _remotePath: string, _items: unknown[], options?: ShellDeskSftpTransferOptions) => {
        lastSftpTransferOptions = options;
        return { canceled: false, size: 0, fileCount: 0, itemCount: 1, skippedCount: 1 };
      },
      sftpDownloadPaths: async (_connectionId: string, _remotePaths: string[], _localPath: string, options?: ShellDeskSftpTransferOptions) => {
        lastSftpTransferOptions = options;
        return { canceled: false, size: 0, fileCount: 0, itemCount: 1, skippedCount: 1 };
      },
      compress: async () => true,
      decompress: async () => true,
      getSystemInfo: async () => ({
        items: [
          { key: 'hostname', label: 'Hostname', value: 'ui-test-host', icon: 'H' },
          { key: 'os', label: 'OS', value: 'Ubuntu 24.04', icon: 'O' },
        ],
      }),
      getMetrics: async () => {
        metricsRequestCount += 1;
        metricsCounter += 12_000;
        return {
          refreshedAt: new Date().toISOString(),
          cpuPercent: 31,
          memoryPercent: 57,
          netRxBytes: metricsCounter,
          netTxBytes: metricsCounter / 2,
        };
      },
      getMonitorPersistenceStatus: async () => ({
        configured: monitorConfigured,
        enabled: monitorEnabled,
        databasePath: monitorConfigured ? '/home/demo/.shelldesk/monitor/monitor.sqlite3' : null,
        sampleCount: monitorConfigured ? 288 : 0,
        lastSampleAt: monitorConfigured ? Date.now() : null,
        intervalMinutes: 5,
        retentionDays: 30,
        thresholds: monitorThresholds,
      }),
      setMonitorPersistenceEnabled: async (_connectionId: string, enabled: boolean) => {
        monitorEnabled = enabled;
        monitorConfigured = true;
        return {
          configured: true,
          enabled,
          databasePath: '/home/demo/.shelldesk/monitor/monitor.sqlite3',
          sampleCount: 288,
          lastSampleAt: Date.now(),
          intervalMinutes: 5,
          retentionDays: 30,
          thresholds: monitorThresholds,
        };
      },
      getMonitorHistory: async () => ({
        samples: Array.from({ length: 24 }, (_, index) => ({
          timestamp: Date.now() - (23 - index) * 5 * 60 * 1000,
          cpuPercent: 28 + index * 0.8,
          memoryPercent: 52 + index * 0.25,
          diskPercent: 63,
          netRxBytesPerSec: 24_000 + index * 500,
          netTxBytesPerSec: 12_000 + index * 300,
          serviceStatus: 'healthy',
          serviceFailedCount: 0,
          serviceDetails: [],
        })),
        alerts: [{
          id: 1,
          metric: 'cpu',
          startedAt: Date.now() - 60 * 60 * 1000,
          endedAt: Date.now() - 45 * 60 * 1000,
          threshold: 90,
          peakValue: 94.2,
        }],
        thresholds: monitorThresholds,
      }),
      setMonitorThresholds: async (_connectionId: string, thresholds: typeof monitorThresholds) => {
        monitorThresholds = thresholds;
        return { ok: true, thresholds };
      },
      mysqlConnect: async () => ({ mysqlId: 'mysql-ui-test', transport: 'tunnel' }),
      mysqlDisconnect: async () => true,
      mysqlDatabases: async () => ['test'],
      mysqlTables: async () => ['users'],
      mysqlColumns: async () => mysqlColumns,
      mysqlQuery: async (_connectionId: string, _mysqlId: string, sql: string) => {
        if (/^CREATE\s+TABLE/i.test(sql.trim())) {
          throw new Error('mock create table failure');
        }
        return createMysqlResult(['id', 'name'], [{ id: 1, name: 'Alice' }]);
      },
      mysqlUpdateCell: async () => {
        throw new Error('mock cell update failure');
      },

      redisConnect: async () => ({ redisId: 'redis-ui-test', transport: 'tunnel' }),
      redisDisconnect: async () => true,
      redisScan: async () => ({
        cursor: '0',
        complete: true,
        pattern: '*',
        scannedAt: now,
        keys: [redisKey],
      }),
      redisGetValue: async () => ({
        type: 'string',
        value: 'hello',
        ttl: -1,
        size: 5,
      }),
      redisSetValue: async () => true,
      redisDeleteKey: async () => {
        throw new Error('mock redis delete failure');
      },
      redisRemoveListItem: async () => true,
      redisCommand: async () => 'OK',
      rdpProbe: async (connectionId: string, config: ShellDeskRdpConnectConfig) => {
        const host = config.host ?? '127.0.0.1';
        const port = config.port ?? 3389;
        const rdpId = config.rdpId ?? '';
        rdpDiagnosticListener?.({
          connectionId,
          rdpId,
          stage: 'probe',
          detail: `Checking RDP target ${host}:${port}`,
        });
        rdpDiagnosticListener?.({
          connectionId,
          rdpId,
          stage: 'probe-ready',
          detail: 'RDP negotiation completed.',
        });
        return {
          host,
          port,
          protocol: 'RDP' as const,
          securityProtocol: 'CredSSP Extended',
        };
      },
      rdpStart: async () => {
        throw new Error('mock RDP sessions are not started by the component harness');
      },
      rdpStop: async () => true,
    },
    vault: {
      getRemoteConnectionProfile: async () => null,
      saveRemoteConnectionProfile: async () => null,
      getBookmarks: async () => [],
      saveBookmarks: async (_scope: string, bookmarks: unknown[]) => bookmarks,
    },
    events: {
      onDatabaseTunnelIdleTimeout: () => () => undefined,
      onVaultChanged: () => () => undefined,
      onTransferProgress: () => () => undefined,
      onTransferEnd: () => () => undefined,
      onRdpDiagnostic: (callback: (payload: ShellDeskRdpDiagnosticPayload) => void) => {
        rdpDiagnosticListener = callback;
        return () => {
          if (rdpDiagnosticListener === callback) {
            rdpDiagnosticListener = undefined;
          }
        };
      },
      onConnectionClosed: () => () => undefined,
    },
  };
}

function EditorThemeSubscriber({ id, initialContent }: { id: string; initialContent: string }) {
  const editorTheme = useShellDeskEditorTheme();
  const [content, setContent] = React.useState(initialContent);

  return (
    <label data-testid={`editor-theme-${id}`} data-editor-theme={editorTheme}>
      <span>{id}</span>
      <textarea
        aria-label={`${id} editor content`}
        value={content}
        onChange={(event) => setContent(event.currentTarget.value)}
      />
    </label>
  );
}

function EditorThemeSubscribersHarness() {
  const [showEditors, setShowEditors] = React.useState(true);

  return (
    <React.StrictMode>
      <main>
        <button
          type="button"
          onClick={() => document.documentElement.setAttribute('data-theme', 'light')}
        >
          Switch to light theme
        </button>
        <button
          type="button"
          onClick={() => document.documentElement.setAttribute('data-theme', 'dark')}
        >
          Switch to dark theme
        </button>
        <button type="button" onClick={() => setShowEditors((current) => !current)}>
          {showEditors ? 'Hide all editors' : 'Show all editors'}
        </button>
        {showEditors ? (
          <>
            <EditorThemeSubscriber id="first" initialContent="SELECT 1;" />
            <EditorThemeSubscriber id="second" initialContent={'{\n  "enabled": true\n}'} />
          </>
        ) : null}
      </main>
    </React.StrictMode>
  );
}

function App() {
  const params = new URLSearchParams(window.location.search);
  const component = params.get('component') ?? 'mysql';

  if (component === 'desktop-icons') {
    const icons = [
      { appKey: 'notepad', label: '记事本' },
      { appKey: 'code-editor', label: '代码编辑器' },
      { appKey: 'browser', label: '浏览器' },
      { appKey: 'supervisor-manager', label: 'Supervisor 管理' },
      { appKey: 'backup-manager', label: '备份管理' },
      { appKey: 'rdp-viewer', label: 'RDP 远程桌面' },
    ] satisfies ReadonlyArray<{ appKey: DesktopAppKey; label: string }>;

    return (
      <main className="remote-desktop-page" style={{ width: 280, height: 400 }}>
        <section className="remote-desktop-surface remote-desktop-dock-bottom" style={{ background: '#0b2938' }}>
          <div className="desktop-icons" aria-label="桌面图标布局" style={{ height: 276 }}>
            {icons.map(({ appKey, label }) => (
              <div key={appKey} role="button" className="desktop-icon-button" data-app-key={appKey}>
                <span className={`desktop-app-icon-shell desktop-app-icon-${appKey}`}>
                  <DesktopAppIcon appKey={appKey} />
                </span>
                <strong>{label}</strong>
              </div>
            ))}
          </div>
        </section>
      </main>
    );
  }

  if (component === 'editor-theme-subscribers') {
    return <EditorThemeSubscribersHarness />;
  }

  if (component === 'vm-manager') {
    return (
      <div style={{ width: '100vw', height: '100vh', overflow: 'hidden' }}>
        <RemoteVirtualMachineManager connectionId={connectionId} systemType="ubuntu" onOpenTerminal={() => undefined} onOpenVnc={() => undefined} />
      </div>
    );
  }

  if (component === 'supervisor-manager') {
    return (
      <div style={{ width: '100vw', height: '100vh', overflow: 'hidden' }}>
        <RemoteSupervisorManager connectionId={connectionId} systemType="ubuntu" />
      </div>
    );
  }

  if (component === 'backup-manager') {
    return (
      <div style={{ width: '100vw', height: '100vh', overflow: 'hidden' }}>
        <RemoteBackupManager connectionId={connectionId} hostId={hostId} systemType="ubuntu" onOpenScheduledTasks={() => undefined} />
      </div>
    );
  }

  if (component === 'rdp-viewer') {
    return (
      <div style={{ width: '100vw', height: '100vh', overflow: 'hidden' }}>
        <RemoteRdpViewer connectionId={connectionId} hostId={hostId} />
      </div>
    );
  }

  if (component === 'host-list') {
    return (
      <div style={{ width: 900, height: 320, padding: 24 }}>
        <HostListPanel
          hosts={hostListFixtures}
          filteredHosts={hostListFixtures}
          pagedHosts={hostListFixtures}
          isVaultReady
          appLanguage="zh-CN"
          hostViewMode="list"
          selectedHostId={null}
          onSelectHost={() => undefined}
          onOpenHost={() => undefined}
          onOpenSftp={() => undefined}
          onDeleteHost={() => undefined}
          onEditHost={() => undefined}
          onQuickAssignGroup={() => undefined}
          onQuickAddTag={() => undefined}
          groupOptions={[]}
          tagOptions={[]}
          hostPage={1}
          hostPageCount={1}
          hostPageNumbers={[1]}
          hostPageSize={10}
          hostPageSizeOptions={[10]}
          onPageSizeChange={() => undefined}
          onPageChange={() => undefined}
          isHostConnecting={() => false}
          proxyProfileById={emptyProxyProfiles}
          closeHostCardMenu={() => undefined}
          formatRelativeTime={() => '刚刚'}
          getHostChipClassName={(kind) => `host-chip ${kind}-chip tone-1`}
          getHostConnectionStateView={() => ({ className: '', title: '已连接' })}
          getHostSystemLabel={() => 'Debian GNU/Linux'}
          getProxyConfigTypeLabel={() => ''}
          renderHostSystemIcon={() => <span className="host-avatar host-system-icon host-system-unknown">D</span>}
        />
      </div>
    );
  }

  if (component === 'sftp-transfer') {
    return (
      <div style={{ display: 'flex', width: '100vw', height: '100vh', overflow: 'hidden' }}>
        <SftpTransferWindow
          connection={{
            id: connectionId,
            kind: 'ssh',
            partition: 'persist:ui-test',
            proxyPort: 0,
            connectedAt: now,
            host: { name: 'UI Test Host', address: '127.0.0.1', port: 22, username: 'demo', authMethod: 'password' },
          }}
          language="zh-CN"
        />
      </div>
    );
  }

  if (component === 'host-table-scroll') {
    return (
      <div style={{ display: 'grid', width: '420px', height: '320px', padding: '24px' }}>
        <div className="host-table-frame table-mode">
          <div className="host-table-scroll">
            <div style={{ width: '900px', height: '640px' }} />
          </div>
          <div className="host-table-pagination" />
        </div>
      </div>
    );
  }

  if (component === 'redis') {
    return <RemoteRedis connectionId={connectionId} hostId={hostId} />;
  }

  if (component === 'frp-manager') {
    return (
      <div style={{ display: 'grid', width: '100vw', height: '100vh', overflow: 'hidden' }}>
        <React.Suspense fallback={<div data-testid="frp-manager-loading">Loading FRP client…</div>}>
          <LazyRemoteFrpManager connectionId={connectionId} systemType="ubuntu" />
        </React.Suspense>
      </div>
    );
  }

  if (component === 'frps-manager') {
    return (
      <div style={{ display: 'grid', width: '100vw', height: '100vh', overflow: 'hidden' }}>
        <React.Suspense fallback={<div data-testid="frps-manager-loading">Loading FRP server…</div>}>
          <LazyRemoteFrpsManager connectionId={connectionId} systemType="ubuntu" />
        </React.Suspense>
      </div>
    );
  }

  if (component === 'file-explorer') {
    return <RemoteFileExplorer connectionId={connectionId} systemType="ubuntu" initialPath="/tmp" />;
  }

  if (component === 'browser') {
    return (
      <RemoteBrowser
        connectionId={connectionId}
        partition="persist:ui-test"
        bookmarkScope="ui-test"
        context={{
          name: 'UI Test Host',
          address: '127.0.0.1',
          port: 22,
          username: 'demo',
          proxyPort: 0,
        }}
      />
    );
  }

  if (component === 'settings-users') {
    return <RemoteSettings connectionId={connectionId} systemType="ubuntu" initialTab="users" />;
  }

  if (component === 'settings-loginsessions') {
    return <RemoteSettings connectionId={connectionId} systemType="ubuntu" initialTab="loginsessions" />;
  }

  if (component === 'settings-sudo') {
    return <RemoteSettings connectionId={connectionId} systemType="ubuntu" initialTab="systeminfo" />;
  }

  if (component === 'monitor') {
    return (
      <div style={{ display: 'grid', width: '100vw', height: '100vh', overflow: 'hidden' }}>
        <RemoteMonitor connectionId={connectionId} hostId={hostId} systemType="ubuntu" />
      </div>
    );
  }

  return <RemoteMySQL connectionId={connectionId} hostId={hostId} />;
}

installGuiSshMock();
document.documentElement.setAttribute('data-language', 'zh-CN');
await loadFullMessageCatalog();

const harnessWindow = window as typeof window & { __shellDeskUiHarnessRoot?: ReturnType<typeof createRoot> };
const harnessRoot = harnessWindow.__shellDeskUiHarnessRoot ?? createRoot(document.getElementById('root')!);
harnessWindow.__shellDeskUiHarnessRoot = harnessRoot;
harnessRoot.render(<App />);

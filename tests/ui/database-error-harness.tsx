import React from 'react';
import { createRoot } from 'react-dom/client';

import RemoteBrowser from '../../src/components/remote-desktop/RemoteBrowser';
import RemoteFileExplorer from '../../src/components/remote-desktop/RemoteFileExplorer';
import RemoteMySQL from '../../src/components/remote-desktop/RemoteMySQL';
import RemoteMonitor from '../../src/components/remote-desktop/RemoteMonitor';
import RemoteRedis from '../../src/components/remote-desktop/RemoteRedis';
import RemoteSettings from '../../src/components/remote-desktop/RemoteSettings';
import RemoteVirtualMachineManager from '../../src/components/remote-desktop/RemoteVirtualMachineManager';
import { loadFullMessageCatalog } from '../../src/i18n';
import '../../src/styles/index.scss';

const connectionId = 'ui-test-connection';
const hostId = 'ui-test-host';
const now = new Date('2026-01-01T00:00:00Z').toISOString();

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

  window.localStorage.removeItem('shelldesk.monitor.persistencePrompt.v1.ui-test-host');
  Object.defineProperty(window, '__shellDeskUiHarnessMetricsRequestCount', {
    configurable: true,
    get: () => metricsRequestCount,
  });

  (window as any).guiSSH = {
    connections: {
      runCommand: async (_connectionId: string, command: string, _stdin?: string, options?: { sudoPassword?: string }) => {
        if (scenario === 'sudo-prompt' && !sudoPromptShown && !options?.sudoPassword) {
          sudoPromptShown = true;
          return createCommandResult('', 'sudo: a password is required', 1);
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
      downloadFile: async () => ({ path: 'secure.txt' }),
      downloadPaths: async () => ({ path: 'secure.zip' }),
      uploadLocalPaths: async () => true,
      selectUploadFiles: async () => null,
      selectUploadFolders: async () => null,
      cancelTransfer: async () => true,
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
    },
  };
}

function App() {
  const params = new URLSearchParams(window.location.search);
  const component = params.get('component') ?? 'mysql';

  if (component === 'vm-manager') {
    return (
      <div style={{ width: '100vw', height: '100vh', overflow: 'hidden' }}>
        <RemoteVirtualMachineManager connectionId={connectionId} systemType="ubuntu" onOpenTerminal={() => undefined} onOpenVnc={() => undefined} />
      </div>
    );
  }

  if (component === 'redis') {
    return <RemoteRedis connectionId={connectionId} hostId={hostId} />;
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

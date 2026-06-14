import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { getErrorMessage } from './desktopUtils';
import DismissibleAlert from './DismissibleAlert';
import { isWindowsSystem, powershellCommand, powershellSingleQuote } from './remoteSystem';
import { useSudoCommand } from './sudoPrompt';
import type { RemoteSystemType } from './types';
import { getCurrentAppLanguage, t, translateStructuredText, useCurrentAppLanguage, type AppLanguage, type MessageId } from '../../i18n';

interface RemoteSettingsProps {
  connectionId: string;
  systemType?: RemoteSystemType;
}

type SettingsTab = 'systeminfo' | 'network' | 'update' | 'hosts' | 'route';

interface SettingsTabDef {
  key: SettingsTab;
  labelId: MessageId;
  icon: string;
  descriptionId: MessageId;
}

interface SettingsGroup {
  labelId: MessageId;
  tabs: SettingsTabDef[];
}

interface RemoteSettingsSectionState<T> {
  loaded: boolean;
  loading: boolean;
  current?: T;
  draft?: T;
  error?: string;
  success?: string;
}

interface SettingsConfirmDialogConfig {
  title: string;
  message: string;
  detail?: string;
  preview?: string;
  confirmLabel?: string;
  tone?: 'primary' | 'warning' | 'danger';
  onConfirm: () => void | Promise<void>;
}

interface SettingsHostStatus {
  systemLabel: string;
  userLabel: string;
  privilegeLabel: string;
  privilegeTone: 'ready' | 'warning' | 'danger' | 'unknown';
  hint: string;
}

const SYSTEM_TYPE_LABELS: Record<RemoteSystemType, string> = {
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

const SETTINGS_GROUPS: SettingsGroup[] = [
  {
    labelId: 'remoteSettings.group.system',
    tabs: [
      { key: 'systeminfo', labelId: 'remoteSettings.tab.systemInfo.label', icon: '\u{1F4BB}', descriptionId: 'remoteSettings.tab.systemInfo.description' },
      { key: 'update', labelId: 'remoteSettings.tab.update.label', icon: '\u{1F504}', descriptionId: 'remoteSettings.tab.update.description' },
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

interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

type SettingsRunCommand = (command: string) => Promise<CommandResult>;

const RemoteSettingsCommandContext = createContext<SettingsRunCommand | null>(null);

function useRemoteSettingsCommand() {
  const runCommand = useContext(RemoteSettingsCommandContext);

  if (!runCommand) {
    throw new Error(t('remoteSettings.command.unsupported', getCurrentAppLanguage()));
  }

  return runCommand;
}

async function getSystemInfoItems(connectionId: string): Promise<SysInfoItem[]> {
  if (!window.guiSSH?.connections) {
    throw new Error(t('remoteSettings.systemInfo.unsupported', getCurrentAppLanguage()));
  }

  const report = await window.guiSSH.connections.getSystemInfo(connectionId);
  return report.items;
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function createUnixDiskSummaryCommand(language: AppLanguage) {
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

function createWindowsDiskSummaryCommand(language: AppLanguage) {
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

function withLinuxPrivilege(command: string) {
  return `if [ "$(id -u 2>/dev/null)" = "0" ]; then
${command}
else
sudo -n sh -c ${shellQuote(command)}
fi`;
}

function isSafeHostname(value: string) {
  return /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(value);
}

function isSafeNameserver(value: string) {
  return /^[0-9A-Fa-f:.]{2,45}$/.test(value);
}

function getSystemTypeLabel(systemType: RemoteSystemType | undefined, language: AppLanguage) {
  return SYSTEM_TYPE_LABELS[systemType ?? 'unknown'] || t('remoteSettings.system.unknown', language);
}

function parseKeyValueOutput(stdout: string) {
  const values = new Map<string, string>();

  for (const line of stdout.split(/\r?\n/)) {
    const separatorIndex = line.indexOf('=');

    if (separatorIndex <= 0) {
      continue;
    }

    values.set(line.slice(0, separatorIndex).trim(), line.slice(separatorIndex + 1).trim());
  }

  return values;
}

function netmaskToPrefix(netmask: string) {
  const octets = netmask.split('.').map((part) => Number.parseInt(part, 10));

  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return null;
  }

  const bits = octets.map((octet) => octet.toString(2).padStart(8, '0')).join('');

  if (!/^1*0*$/.test(bits)) {
    return null;
  }

  const firstZeroIndex = bits.indexOf('0');
  return firstZeroIndex === -1 ? 32 : firstZeroIndex;
}

function createLineChangePreview(current: string, draft: string, language: AppLanguage = getCurrentAppLanguage()) {
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

function SettingsCommandPreview({ label, content }: { label: string; content: string }) {
  return (
    <div className="settings-command-preview">
      <div className="settings-command-preview-label">{label}</div>
      <pre>{content}</pre>
    </div>
  );
}

function SettingsConfirmDialog({
  config,
  onClose,
}: {
  config: SettingsConfirmDialogConfig;
  onClose: () => void;
}) {
  const [isApplying, setIsApplying] = useState(false);
  const language = useCurrentAppLanguage();
  const tone = config.tone ?? 'primary';

  const handleConfirm = async () => {
    setIsApplying(true);
    try {
      await config.onConfirm();
      onClose();
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
        onClick={(event) => event.stopPropagation()}
      >
        <div id="settings-confirm-title" className="settings-modal-title">{config.title}</div>
        <div className="settings-modal-message">
          <p>{config.message}</p>
          {config.detail ? <small>{config.detail}</small> : null}
        </div>
        {config.preview ? <SettingsCommandPreview label={t('remoteSettings.common.preview', language)} content={config.preview} /> : null}
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

/* ─── Network ─────────────────────────────────────────────────────────────── */

interface NetIface {
  name: string;
  state: 'UP' | 'DOWN';
  mac: string;
  mtu: number;
  addresses: Array<{ addr: string; family: 'inet' | 'inet6'; prefixLen: number }>;
  raw: string;
}

function parseIpAddr(stdout: string): NetIface[] {
  const blocks = stdout.split(/(?=^\d+: )/m).filter((b) => b.trim());
  const ifaces: NetIface[] = [];

  for (const block of blocks) {
    const headerMatch = block.match(/^(\d+):\s+(\S+?)(@[^:]+)?:\s+<([^>]*)>.*mtu\s+(\d+)/);
    if (!headerMatch) continue;

    const name = headerMatch[2];
    const flags = headerMatch[4];
    const mtu = Number.parseInt(headerMatch[5], 10);
    const state = flags.includes('UP') ? 'UP' as const : 'DOWN' as const;

    const macMatch = block.match(/link\/ether\s+([0-9a-fA-F:]+)/);
    const mac = macMatch?.[1] ?? '';

    const addresses: NetIface['addresses'] = [];
    const inetRegex = /inet\s+(\d+\.\d+\.\d+\.\d+)\/(\d+)/g;
    let m: RegExpExecArray | null;
    while ((m = inetRegex.exec(block)) !== null) {
      addresses.push({ addr: m[1], family: 'inet', prefixLen: Number.parseInt(m[2], 10) });
    }
    const inet6Regex = /inet6\s+([0-9a-fA-F:]+)\/(\d+)/g;
    while ((m = inet6Regex.exec(block)) !== null) {
      addresses.push({ addr: m[1], family: 'inet6', prefixLen: Number.parseInt(m[2], 10) });
    }

    if (name !== 'lo') {
      ifaces.push({ name, state, mac, mtu, addresses, raw: block.trim() });
    }
  }

  return ifaces;
}

function prefixToNetmask(prefix: number): string {
  if (prefix <= 0) return '0.0.0.0';
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return [24, 16, 8, 0].map((s) => ((mask >>> s) & 0xff).toString()).join('.');
}

interface IfaceEditState {
  method: 'static' | 'dhcp';
  address: string;
  netmask: string;
  gateway: string;
}

interface DnsConfig {
  servers: string[];
  search: string;
  raw: string;
}

const EMPTY_DNS_CONFIG: DnsConfig = {
  servers: [],
  search: '',
  raw: '',
};

function parseResolvConf(stdout: string): DnsConfig {
  const resolvLines = stdout.split(/\r?\n/);
  const servers = resolvLines
    .filter((line) => /^\s*nameserver\s/.test(line))
    .map((line) => line.replace(/^\s*nameserver\s+/, '').trim())
    .filter(Boolean);
  const search = resolvLines
    .find((line) => /^\s*search\s/.test(line))
    ?.replace(/^\s*search\s+/, '')
    .trim() ?? '';

  return {
    servers,
    search,
    raw: stdout,
  };
}

function areDnsConfigsEqual(left: DnsConfig, right: DnsConfig) {
  return left.search === right.search
    && left.servers.length === right.servers.length
    && left.servers.every((server, index) => server === right.servers[index]);
}

function buildResolvConfContent(originalContent: string, config: DnsConfig) {
  const preservedLines = originalContent
    .split(/\r?\n/)
    .filter((line) => !/^\s*(nameserver|search)\b/.test(line))
    .join('\n')
    .trimEnd();
  const generatedLines = [
    '# Managed by ShellDesk system settings',
    ...config.servers.map((server) => `nameserver ${server}`),
    config.search ? `search ${config.search}` : '',
  ].filter(Boolean);

  return [preservedLines, generatedLines.join('\n')].filter(Boolean).join('\n') + '\n';
}

function createDnsConfigPreview(current: DnsConfig, draft: DnsConfig, language: AppLanguage) {
  const emptyValue = t('remoteSettings.network.noValue', language);

  return [
    t('remoteSettings.network.currentDns', language),
    ...(current.servers.length ? current.servers.map((server) => `  ${server}`) : [`  ${emptyValue}`]),
    t('remoteSettings.network.currentSearch', language, { value: current.search || emptyValue }),
    '',
    t('remoteSettings.network.draftDns', language),
    ...(draft.servers.length ? draft.servers.map((server) => `  ${server}`) : [`  ${emptyValue}`]),
    t('remoteSettings.network.draftSearch', language, { value: draft.search || emptyValue }),
    '',
    t('remoteSettings.network.backupResolv', language),
  ].join('\n');
}

function NetworkPanel() {
  const language = useCurrentAppLanguage();
  const runCommand = useRemoteSettingsCommand();
  const [ifaces, setIfaces] = useState<NetIface[]>([]);
  const [dnsState, setDnsState] = useState<RemoteSettingsSectionState<DnsConfig>>({
    loaded: false,
    loading: false,
    current: EMPTY_DNS_CONFIG,
    draft: EMPTY_DNS_CONFIG,
  });
  const [hostname, setHostname] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [editingIface, setEditingIface] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<IfaceEditState>({ method: 'dhcp', address: '', netmask: '', gateway: '' });
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [newDns, setNewDns] = useState('');
  const [isHostnameDialogOpen, setIsHostnameDialogOpen] = useState(false);
  const [hostnameDraft, setHostnameDraft] = useState('');
  const [confirmDialog, setConfirmDialog] = useState<SettingsConfirmDialogConfig | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setDnsState((currentState) => ({ ...currentState, loading: true, error: undefined }));
    setError('');
    try {
      const [ifResult, dnsResult, hostResult] = await Promise.all([
        runCommand('ip addr show 2>/dev/null || ifconfig -a 2>/dev/null'),
        runCommand('cat /etc/resolv.conf 2>/dev/null'),
        runCommand('hostname -f 2>/dev/null || hostname'),
      ]);

      setIfaces(parseIpAddr(ifResult.stdout || ''));
      const dnsConfig = parseResolvConf(dnsResult.stdout || '');
      setDnsState({
        loaded: true,
        loading: false,
        current: dnsConfig,
        draft: dnsConfig,
      });
      setHostname((hostResult.stdout || '').trim());
    } catch (err) {
      const message = getErrorMessage(err);
      setError(message);
      setDnsState((currentState) => ({ ...currentState, loading: false, error: message }));
    } finally {
      setLoading(false);
      setDnsState((currentState) => ({ ...currentState, loading: false }));
    }
  }, [runCommand]);

  useEffect(() => { void refresh(); }, [refresh]);

  const applyIfacePowerState = async (ifaceName: string, bringUp: boolean) => {
    setActionLoading(ifaceName);
    setError('');
    setSuccess('');
    try {
      const result = await runCommand(withLinuxPrivilege(`ip link set ${shellQuote(ifaceName)} ${bringUp ? 'up' : 'down'} 2>&1`));
      if (result.code !== 0) throw new Error(result.stderr || t('remoteSettings.common.operationFailedRoot', language));
      setSuccess(t('remoteSettings.network.ifacePowerSuccess', language, {
        name: ifaceName,
        state: t(bringUp ? 'remoteSettings.network.enabled' : 'remoteSettings.network.disabled', language),
      }));
      await refresh();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setActionLoading(null);
    }
  };

  const requestToggleIface = (ifaceName: string, bringUp: boolean) => {
    setConfirmDialog({
      title: t(bringUp ? 'remoteSettings.network.enableIfaceTitle' : 'remoteSettings.network.disableIfaceTitle', language),
      message: bringUp
        ? t('remoteSettings.network.enableIfaceMessage', language, { name: ifaceName })
        : t('remoteSettings.network.disableIfaceMessage', language, { name: ifaceName }),
      detail: t('remoteSettings.network.ifacePowerDetail', language),
      preview: `ip link set ${shellQuote(ifaceName)} ${bringUp ? 'up' : 'down'}`,
      confirmLabel: t(bringUp ? 'remoteSettings.network.enableIfaceConfirm' : 'remoteSettings.network.disableIfaceConfirm', language),
      tone: bringUp ? 'warning' : 'danger',
      onConfirm: () => applyIfacePowerState(ifaceName, bringUp),
    });
  };

  const startEditIface = (iface: NetIface) => {
    setEditingIface(iface.name);
    setSuccess('');
    setError('');
    const ipv4 = iface.addresses.find((a) => a.family === 'inet');
    setEditForm({
      method: 'static',
      address: ipv4?.addr ?? '',
      netmask: ipv4 ? prefixToNetmask(ipv4.prefixLen) : '255.255.255.0',
      gateway: '',
    });
  };

  const buildIfaceConfigPlan = (ifaceName: string, form: IfaceEditState) => {
    const ifaceArg = shellQuote(ifaceName);

    if (form.method === 'dhcp') {
      return {
        command: `dhclient -r ${ifaceArg} 2>/dev/null; ip -4 addr flush dev ${ifaceArg} scope global 2>&1 && dhclient ${ifaceArg} 2>&1 || echo ${shellQuote(t('remoteSettings.network.dhclientUnavailable', language))}`,
        preview: [`dhclient -r ${ifaceArg}`, `ip -4 addr flush dev ${ifaceArg} scope global`, `dhclient ${ifaceArg}`].join('\n'),
      };
    }

    if (!form.address.trim()) {
      throw new Error(t('remoteSettings.network.ipRequired', language));
    }

    if (!isSafeNameserver(form.address.trim())) {
      throw new Error(t('remoteSettings.network.ipInvalid', language));
    }

    if (form.gateway.trim() && !isSafeNameserver(form.gateway.trim())) {
      throw new Error(t('remoteSettings.network.gatewayInvalid', language));
    }

    const prefix = form.netmask.trim() ? netmaskToPrefix(form.netmask.trim()) : 24;

    if (prefix === null) {
      throw new Error(t('remoteSettings.network.netmaskInvalid', language));
    }

    const cidr = `${form.address.trim()}/${prefix}`;
    let command = `ip -4 addr flush dev ${ifaceArg} scope global 2>&1 && ip addr add ${shellQuote(cidr)} dev ${ifaceArg} 2>&1 && ip link set ${ifaceArg} up 2>&1`;
    const previewLines = [
      `ip -4 addr flush dev ${ifaceArg} scope global`,
      `ip addr add ${shellQuote(cidr)} dev ${ifaceArg}`,
      `ip link set ${ifaceArg} up`,
    ];

    if (form.gateway.trim()) {
      command += ` && ip route replace default via ${shellQuote(form.gateway.trim())} dev ${ifaceArg} 2>&1`;
      previewLines.push(`ip route replace default via ${shellQuote(form.gateway.trim())} dev ${ifaceArg}`);
    }

    return {
      command,
      preview: previewLines.join('\n'),
    };
  };

  const applyIfaceConfig = async (ifaceName: string, command: string) => {
    setActionLoading(ifaceName);
    setError('');
    setSuccess('');
    try {
      const result = await runCommand(withLinuxPrivilege(command));
      if (result.code !== 0 && !result.stdout.includes('dhclient')) {
        throw new Error(result.stderr || result.stdout || t('remoteSettings.common.configFailedRoot', language));
      }
      setSuccess(t('remoteSettings.network.ifaceConfigSuccess', language, { name: ifaceName }));
      setEditingIface(null);
      await refresh();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setActionLoading(null);
    }
  };

  const requestApplyIfaceConfig = () => {
    if (!editingIface) return;

    try {
      const plan = buildIfaceConfigPlan(editingIface, editForm);

      setConfirmDialog({
        title: t('remoteSettings.network.applyIfaceTitle', language),
        message: t('remoteSettings.network.applyIfaceMessage', language, { name: editingIface }),
        detail: t('remoteSettings.network.applyIfaceDetail', language),
        preview: plan.preview,
        confirmLabel: t('remoteSettings.common.applyConfig', language),
        tone: 'danger',
        onConfirm: () => applyIfaceConfig(editingIface, plan.command),
      });
    } catch (err) {
      setError(getErrorMessage(err));
    }
  };

  const openHostnameDialog = () => {
    setHostnameDraft(hostname);
    setError('');
    setIsHostnameDialogOpen(true);
  };

  const setHostnameCmd = async () => {
    const name = hostnameDraft.trim();
    if (!name) {
      setError(t('remoteSettings.network.hostnameRequired', language));
      return;
    }
    if (!isSafeHostname(name)) {
      setError(t('remoteSettings.network.hostnameInvalid', language));
      return;
    }
    setIsHostnameDialogOpen(false);
    setActionLoading('hostname');
    setError('');
    setSuccess('');
    try {
      const quotedName = shellQuote(name);
      const result = await runCommand(withLinuxPrivilege(`hostnamectl set-hostname ${quotedName} 2>&1 || hostname ${quotedName} 2>&1`));
      if (result.code !== 0) throw new Error(result.stderr || t('remoteSettings.network.hostnameFailed', language));
      setSuccess(t('remoteSettings.network.hostnameSuccess', language, { name }));
      setHostname(name);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setActionLoading(null);
    }
  };

  const currentDnsConfig = dnsState.current ?? EMPTY_DNS_CONFIG;
  const dnsDraftConfig = dnsState.draft ?? currentDnsConfig;
  const isDnsDirty = !areDnsConfigsEqual(currentDnsConfig, dnsDraftConfig);

  const addDnsServer = () => {
    const server = newDns.trim();
    if (!server) return;
    if (!isSafeNameserver(server)) {
      setError(t('remoteSettings.network.dnsInvalid', language));
      return;
    }
    if (dnsDraftConfig.servers.includes(server)) {
      setSuccess(t('remoteSettings.network.dnsAlreadyInDraft', language, { server }));
      setNewDns('');
      return;
    }
    setError('');
    setSuccess('');
    setDnsState((currentState) => ({
      ...currentState,
      draft: {
        ...(currentState.draft ?? EMPTY_DNS_CONFIG),
        servers: [...(currentState.draft?.servers ?? []), server],
      },
      success: t('remoteSettings.network.dnsAddedDraft', language, { server }),
    }));
    setNewDns('');
  };

  const removeDnsServer = (server: string) => {
    setError('');
    setSuccess('');
    setDnsState((currentState) => ({
      ...currentState,
      draft: {
        ...(currentState.draft ?? EMPTY_DNS_CONFIG),
        servers: (currentState.draft?.servers ?? []).filter((item) => item !== server),
      },
      success: t('remoteSettings.network.dnsRemovedDraft', language, { server }),
    }));
  };

  const applyDnsDraft = async (nextContent: string, draft: DnsConfig) => {
    setActionLoading('dns');
    setError('');
    setSuccess('');
    try {
      const result = await runCommand(withLinuxPrivilege(`cp /etc/resolv.conf /etc/resolv.conf.bak.$(date +%s) 2>/dev/null; printf '%s' ${shellQuote(nextContent)} > /etc/resolv.conf`));
      if (result.code !== 0) {
        throw new Error(result.stderr || result.stdout || t('remoteSettings.network.dnsWriteFailed', language));
      }
      setDnsState((currentState) => ({
        ...currentState,
        current: { ...draft, raw: nextContent },
        draft: { ...draft, raw: nextContent },
        success: t('remoteSettings.network.dnsApplied', language),
      }));
      setSuccess(t('remoteSettings.network.dnsApplied', language));
      await refresh();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setActionLoading(null);
    }
  };

  const requestApplyDnsDraft = () => {
    if (!isDnsDirty) return;

    const nextContent = buildResolvConfContent(currentDnsConfig.raw, dnsDraftConfig);
    setConfirmDialog({
      title: t('remoteSettings.network.applyDnsTitle', language),
      message: t('remoteSettings.network.applyDnsMessage', language),
      detail: t('remoteSettings.network.applyDnsDetail', language),
      preview: createDnsConfigPreview(currentDnsConfig, dnsDraftConfig, language),
      confirmLabel: t('remoteSettings.network.applyDnsConfirm', language),
      tone: 'warning',
      onConfirm: () => applyDnsDraft(nextContent, dnsDraftConfig),
    });
  };

  return (
    <div className="settings-panel-content">
      <div className="settings-panel-header">
        <div>
          <h3>{t('remoteSettings.network.title', language)}</h3>
          <p>{t('remoteSettings.network.description', language)}</p>
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
      <div className="settings-warning-banner">
        {t('remoteSettings.network.warning', language)}
      </div>

      {/* Hostname */}
      <div className="settings-info-card">
        <div className="settings-info-row">
          <span className="settings-info-label">{t('remoteSettings.network.hostname', language)}</span>
          <strong className="settings-info-value">{hostname || '...'}</strong>
        </div>
        <button type="button" className="settings-action-btn" onClick={openHostnameDialog} disabled={actionLoading === 'hostname'}>
          {actionLoading === 'hostname' ? '...' : t('remoteSettings.network.change', language)}
        </button>
      </div>

      {/* Interface Cards */}
      <div className="settings-section">
        <h4>{t('remoteSettings.network.interfaces', language, { count: String(ifaces.length) })}</h4>
        <div className="net-iface-grid">
          {ifaces.map((iface) => {
            const ipv4 = iface.addresses.filter((a) => a.family === 'inet');
            const ipv6 = iface.addresses.filter((a) => a.family === 'inet6');
            const isEditing = editingIface === iface.name;
            const isBusy = actionLoading === iface.name;

            return (
              <article key={iface.name} className={`net-iface-card ${iface.state === 'UP' ? 'up' : 'down'}`}>
                <div className="net-iface-header">
                  <div className="net-iface-title">
                    <span className={`net-iface-state-dot ${iface.state === 'UP' ? 'up' : 'down'}`} />
                    <strong>{iface.name}</strong>
                    <span className={`net-iface-state-tag ${iface.state === 'UP' ? 'up' : 'down'}`}>{iface.state}</span>
                  </div>
                  <div className="net-iface-actions">
                    {iface.state === 'UP' ? (
                      <button type="button" className="settings-action-btn danger" onClick={() => requestToggleIface(iface.name, false)} disabled={isBusy}>
                        {isBusy ? '...' : t('remoteSettings.network.disable', language)}
                      </button>
                    ) : (
                      <button type="button" className="settings-action-btn primary" onClick={() => requestToggleIface(iface.name, true)} disabled={isBusy}>
                        {isBusy ? '...' : t('remoteSettings.network.enable', language)}
                      </button>
                    )}
                    <button type="button" className="settings-action-btn" onClick={() => startEditIface(iface)} disabled={isBusy}>
                      {t('remoteSettings.common.edit', language)}
                    </button>
                  </div>
                </div>

                <div className="net-iface-info">
                  {iface.mac ? <span className="net-iface-meta"><em>MAC</em>{iface.mac}</span> : null}
                  <span className="net-iface-meta"><em>MTU</em>{iface.mtu}</span>
                  {ipv4.map((a) => (
                    <span key={a.addr} className="net-iface-meta ipv4">
                      <em>IPv4</em>{a.addr} / {a.prefixLen}
                      <small>({prefixToNetmask(a.prefixLen)})</small>
                    </span>
                  ))}
                  {ipv6.map((a) => (
                    <span key={a.addr} className="net-iface-meta ipv6">
                      <em>IPv6</em>{a.addr} / {a.prefixLen}
                    </span>
                  ))}
                  {ipv4.length === 0 && ipv6.length === 0 ? (
                    <span className="net-iface-meta no-addr">{t('remoteSettings.network.noAddress', language)}</span>
                  ) : null}
                </div>

                {/* Inline Edit Form */}
                {isEditing ? (
                  <div className="net-iface-edit">
                    <div className="net-edit-row">
                      <label>
                        <span>{t('remoteSettings.network.configMethod', language)}</span>
                        <select
                          value={editForm.method}
                          onChange={(e) => setEditForm({ ...editForm, method: e.target.value as 'static' | 'dhcp' })}
                          className="settings-select"
                        >
                          <option value="static">{t('remoteSettings.network.staticIp', language)}</option>
                          <option value="dhcp">{t('remoteSettings.network.dhcpAuto', language)}</option>
                        </select>
                      </label>
                    </div>
                    {editForm.method === 'static' ? (
                      <>
                        <div className="net-edit-row">
                          <label>
                            <span>{t('remoteSettings.network.ipAddress', language)}</span>
                            <input type="text" className="settings-input" placeholder="192.168.1.100" value={editForm.address} onChange={(e) => setEditForm({ ...editForm, address: e.target.value })} />
                          </label>
                          <label>
                            <span>{t('remoteSettings.network.netmask', language)}</span>
                            <input type="text" className="settings-input" placeholder="255.255.255.0" value={editForm.netmask} onChange={(e) => setEditForm({ ...editForm, netmask: e.target.value })} />
                          </label>
                        </div>
                        <div className="net-edit-row">
                          <label>
                            <span>{t('remoteSettings.network.gatewayOptional', language)}</span>
                            <input type="text" className="settings-input" placeholder="192.168.1.1" value={editForm.gateway} onChange={(e) => setEditForm({ ...editForm, gateway: e.target.value })} />
                          </label>
                        </div>
                      </>
                    ) : null}
                    <div className="net-edit-footer">
                      <button type="button" className="settings-action-btn" onClick={() => setEditingIface(null)}>{t('remoteSettings.common.cancel', language)}</button>
                      <button type="button" className="settings-action-btn primary" onClick={requestApplyIfaceConfig} disabled={isBusy}>
                        {isBusy ? t('remoteSettings.common.applyingConfig', language) : t('remoteSettings.common.applyConfig', language)}
                      </button>
                    </div>
                  </div>
                ) : null}
              </article>
            );
          })}
          {ifaces.length === 0 ? <p className="settings-hint">{loading ? t('remoteSettings.network.interfacesLoading', language) : t('remoteSettings.network.noInterfaces', language)}</p> : null}
        </div>
      </div>

      {/* DNS Configuration */}
      <div className="settings-section">
        <h4>{t('remoteSettings.network.dnsServers', language)}</h4>
        <div className="dns-server-list">
          {dnsDraftConfig.servers.map((server) => (
            <div key={server} className="dns-server-item">
              <span className="dns-server-addr">{server}</span>
              <button type="button" className="settings-action-btn danger" onClick={() => removeDnsServer(server)}>{t('remoteSettings.common.remove', language)}</button>
            </div>
          ))}
          {dnsDraftConfig.servers.length === 0 ? <p className="settings-hint">{dnsState.loading ? t('remoteSettings.network.dnsLoading', language) : t('remoteSettings.network.dnsEmpty', language)}</p> : null}
        </div>
        <div className="settings-inline-form">
          <input type="text" className="settings-input" placeholder={t('remoteSettings.network.addDnsPlaceholder', language)} value={newDns} onChange={(e) => setNewDns(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void addDnsServer(); }} />
          <button type="button" className="settings-action-btn primary" onClick={addDnsServer}>{t('remoteSettings.network.addDraft', language)}</button>
        </div>
        <label className="settings-field">
          <span>{t('remoteSettings.network.searchDomain', language)}</span>
          <input
            type="text"
            className="settings-input"
            placeholder="example.com corp.local"
            value={dnsDraftConfig.search}
            onChange={(event) => {
              const search = event.target.value;
              setDnsState((currentState) => ({
                ...currentState,
                draft: {
                  ...(currentState.draft ?? EMPTY_DNS_CONFIG),
                  search,
                },
              }));
            }}
          />
        </label>
        {isDnsDirty ? (
          <div className="settings-draft-footer">
            <span>{t('remoteSettings.network.dnsDraftPending', language)}</span>
            <div className="settings-header-actions">
              <button type="button" className="settings-action-btn" onClick={() => setDnsState((currentState) => ({ ...currentState, draft: currentState.current }))}>
                {t('remoteSettings.network.rollbackDraft', language)}
              </button>
              <button type="button" className="settings-action-btn primary" onClick={requestApplyDnsDraft} disabled={actionLoading === 'dns'}>
                {actionLoading === 'dns' ? t('remoteSettings.common.applyingConfig', language) : t('remoteSettings.network.previewApply', language)}
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {isHostnameDialogOpen ? createPortal(
        <div className="notepad-modal-overlay" role="presentation" onClick={() => setIsHostnameDialogOpen(false)}>
          <div
            className="notepad-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="hostname-dialog-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div id="hostname-dialog-title" className="notepad-modal-title">{t('remoteSettings.network.hostnameDialogTitle', language)}</div>
            <input
              className="notepad-modal-input"
              value={hostnameDraft}
              onChange={(event) => setHostnameDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void setHostnameCmd();
                }
                if (event.key === 'Escape') {
                  event.preventDefault();
                  setIsHostnameDialogOpen(false);
                }
              }}
              autoFocus
              placeholder={t('remoteSettings.network.hostnamePlaceholder', language)}
            />
            {hostnameDraft.trim() ? (
              <SettingsCommandPreview
                label={t('remoteSettings.common.preview', language)}
                content={[
                  `hostnamectl set-hostname ${shellQuote(hostnameDraft.trim())}`,
                  `hostname ${shellQuote(hostnameDraft.trim())}`,
                ].join('\n')}
              />
            ) : null}
            <div className="notepad-modal-actions">
              <button type="button" className="notepad-modal-btn" onClick={() => setIsHostnameDialogOpen(false)}>{t('remoteSettings.common.cancel', language)}</button>
              <button type="button" className="notepad-modal-btn primary" onClick={() => void setHostnameCmd()}>{t('remoteSettings.common.save', language)}</button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
      {confirmDialog ? <SettingsConfirmDialog config={confirmDialog} onClose={() => setConfirmDialog(null)} /> : null}
    </div>
  );
}

/* ─── Mirrors ─────────────────────────────────────────────────────────────── */

const MIRROR_PRESETS = {
  ubuntu: [
    { labelId: 'remoteSettings.mirrors.aliyun', url: 'mirrors.aliyun.com' },
    { labelId: 'remoteSettings.mirrors.tuna', url: 'mirrors.tuna.tsinghua.edu.cn' },
    { labelId: 'remoteSettings.mirrors.ustc', url: 'mirrors.ustc.edu.cn' },
    { labelId: 'remoteSettings.mirrors.huawei', url: 'mirrors.huaweicloud.com' },
    { labelId: 'remoteSettings.mirrors.official', url: 'archive.ubuntu.com' },
  ],
  debian: [
    { labelId: 'remoteSettings.mirrors.aliyun', url: 'mirrors.aliyun.com' },
    { labelId: 'remoteSettings.mirrors.tuna', url: 'mirrors.tuna.tsinghua.edu.cn' },
    { labelId: 'remoteSettings.mirrors.ustc', url: 'mirrors.ustc.edu.cn' },
    { labelId: 'remoteSettings.mirrors.huawei', url: 'mirrors.huaweicloud.com' },
    { labelId: 'remoteSettings.mirrors.official', url: 'deb.debian.org' },
  ],
  redhat: [
    { labelId: 'remoteSettings.mirrors.aliyun', url: 'mirrors.aliyun.com' },
    { labelId: 'remoteSettings.mirrors.tuna', url: 'mirrors.tuna.tsinghua.edu.cn' },
    { labelId: 'remoteSettings.mirrors.ustc', url: 'mirrors.ustc.edu.cn' },
    { labelId: 'remoteSettings.mirrors.huawei', url: 'mirrors.huaweicloud.com' },
  ],
} as const satisfies Record<AptMirrorFlavor | 'redhat', ReadonlyArray<{ labelId: MessageId; url: string }>>;

type MirrorDistroType = 'debian' | 'redhat' | 'rhel' | 'unknown';
type AptSourceFormat = 'legacy' | 'deb822';
type AptMirrorFlavor = 'ubuntu' | 'debian';

interface AptSourceTarget {
  path: string;
  format: AptSourceFormat;
  flavor: AptMirrorFlavor;
}

const APT_SOURCE_CONTENT_MARKER = 'SHELLDESK_APT_SOURCE_CONTENT';
const LEGACY_APT_SOURCE_PATH = '/etc/apt/sources.list';
const UBUNTU_DEB822_SOURCE_PATH = '/etc/apt/sources.list.d/ubuntu.sources';
const DEBIAN_DEB822_SOURCE_PATH = '/etc/apt/sources.list.d/debian.sources';
const YUM_REPO_CONTENT_MARKER = 'SHELLDESK_YUM_REPO_CONTENT';

function createAptSourceInspectionCommand() {
  return [
    'if [ -f /etc/os-release ]; then',
    '  . /etc/os-release',
    'fi',
    'apt_source_path=',
    'apt_source_format=legacy',
    `if [ "\${ID:-}" = "ubuntu" ] && [ -f ${UBUNTU_DEB822_SOURCE_PATH} ]; then`,
    `  apt_source_path=${UBUNTU_DEB822_SOURCE_PATH}`,
    '  apt_source_format=deb822',
    `elif [ "\${ID:-}" = "debian" ] && [ -f ${DEBIAN_DEB822_SOURCE_PATH} ]; then`,
    `  apt_source_path=${DEBIAN_DEB822_SOURCE_PATH}`,
    '  apt_source_format=deb822',
    `elif [ -f ${UBUNTU_DEB822_SOURCE_PATH} ]; then`,
    `  apt_source_path=${UBUNTU_DEB822_SOURCE_PATH}`,
    '  apt_source_format=deb822',
    `elif [ -f ${DEBIAN_DEB822_SOURCE_PATH} ]; then`,
    `  apt_source_path=${DEBIAN_DEB822_SOURCE_PATH}`,
    '  apt_source_format=deb822',
    'elif [ -f /etc/apt/sources.list ]; then',
    '  apt_source_path=/etc/apt/sources.list',
    '  apt_source_format=legacy',
    'elif [ "${ID:-}" = "ubuntu" ]; then',
    `  apt_source_path=${UBUNTU_DEB822_SOURCE_PATH}`,
    '  apt_source_format=deb822',
    'else',
    '  apt_source_path=/etc/apt/sources.list',
    '  apt_source_format=legacy',
    'fi',
    'printf "APT_SOURCE_PATH=%s\\n" "$apt_source_path"',
    'printf "APT_SOURCE_FORMAT=%s\\n" "$apt_source_format"',
    `printf '%s\\n' '${APT_SOURCE_CONTENT_MARKER}'`,
    'if [ -n "$apt_source_path" ] && [ -f "$apt_source_path" ]; then',
    '  sed -n "1,160p" "$apt_source_path" 2>/dev/null',
    'fi',
  ].join('\n');
}

function getAptFlavorFromDistroOutput(output: string): AptMirrorFlavor {
  const values = parseKeyValueOutput(output);
  const id = (values.get('ID') ?? '').toLowerCase();
  const idLike = (values.get('ID_LIKE') ?? '').toLowerCase();

  if (['ubuntu', 'linuxmint', 'pop', 'elementary'].includes(id) || /(^|[\s,])ubuntu(?=$|[\s,])/.test(idLike)) {
    return 'ubuntu';
  }

  return 'debian';
}

function getDefaultAptSourceTarget(flavor: AptMirrorFlavor): AptSourceTarget {
  if (flavor === 'ubuntu') {
    return { path: UBUNTU_DEB822_SOURCE_PATH, format: 'deb822', flavor };
  }

  return { path: LEGACY_APT_SOURCE_PATH, format: 'legacy', flavor };
}

function parseAptSourceInspection(stdout: string, flavor: AptMirrorFlavor, language: AppLanguage = getCurrentAppLanguage()) {
  const lines = stdout.split(/\r?\n/);
  const markerIndex = lines.findIndex((line) => line.trim() === APT_SOURCE_CONTENT_MARKER);
  const metadataLines = markerIndex >= 0 ? lines.slice(0, markerIndex) : lines;
  const contentLines = markerIndex >= 0 ? lines.slice(markerIndex + 1) : [];
  const values = parseKeyValueOutput(metadataLines.join('\n'));
  const fallbackTarget = getDefaultAptSourceTarget(flavor);
  const path = values.get('APT_SOURCE_PATH') || fallbackTarget.path;
  const format: AptSourceFormat = values.get('APT_SOURCE_FORMAT') === 'deb822' || path.endsWith('.sources') ? 'deb822' : 'legacy';
  const target: AptSourceTarget = { path, format, flavor };
  const content = contentLines.join('\n').trimEnd();
  const display = [
    t('remoteSettings.mirrors.configFile', language, { path }),
    t('remoteSettings.mirrors.format', language, { format: format === 'deb822' ? 'deb822 (.sources)' : 'legacy sources.list' }),
    '',
    content || t('remoteSettings.mirrors.unreadableCreate', language),
  ].join('\n');

  return { target, display };
}

function createYumRepoInspectionCommand() {
  return [
    'repo_dir=/etc/yum.repos.d',
    'printf "YUM_REPO_DIR=%s\\n" "$repo_dir"',
    `printf '%s\\n' '${YUM_REPO_CONTENT_MARKER}'`,
    'found=0',
    'if ls "$repo_dir"/*.repo >/dev/null 2>&1; then',
    '  for repo_file in "$repo_dir"/*.repo; do',
    '    [ -f "$repo_file" ] || continue',
    '    found=1',
    '    printf "\\n# %s\\n" "$repo_file"',
    `    awk '
      /^[[:space:]]*\\[[^]]+\\][[:space:]]*$/ { print; next }
      /^[[:space:]]*#?[[:space:]]*(name|baseurl|mirrorlist|metalink|enabled)[[:space:]]*=/ { print; next }
    ' "$repo_file"`,
    '  done',
    'fi',
    'if [ "$found" -eq 0 ]; then',
    '  printf "No repo files found under %s\\n" "$repo_dir"',
    'fi',
  ].join('\n');
}

function parseYumRepoInspection(stdout: string, language: AppLanguage = getCurrentAppLanguage()) {
  const lines = stdout.split(/\r?\n/);
  const markerIndex = lines.findIndex((line) => line.trim() === YUM_REPO_CONTENT_MARKER);
  const metadataLines = markerIndex >= 0 ? lines.slice(0, markerIndex) : [];
  const contentLines = markerIndex >= 0 ? lines.slice(markerIndex + 1) : lines;
  const values = parseKeyValueOutput(metadataLines.join('\n'));
  const repoDir = values.get('YUM_REPO_DIR') || '/etc/yum.repos.d';
  const content = contentLines.join('\n').trimEnd();

  return [
    t('remoteSettings.mirrors.configDir', language, { path: repoDir }),
    '',
    content || t('remoteSettings.mirrors.repoUnreadable', language, { path: repoDir }),
  ].join('\n');
}

function isOfficialRhelDistro(values: Map<string, string>) {
  const id = (values.get('ID') ?? '').toLowerCase();
  const name = (values.get('NAME') ?? '').toLowerCase();

  return id === 'rhel' || id === 'redhat' || /\bred hat enterprise linux\b/.test(name);
}

function normalizeAptCodename(rawCodename: string | undefined, flavor: AptMirrorFlavor) {
  const fallback = flavor === 'ubuntu' ? 'noble' : 'bookworm';
  const codename = (rawCodename ?? '').trim();
  return /^[A-Za-z0-9._-]+$/.test(codename) ? codename : fallback;
}

function buildUbuntuLegacySources(mirrorUrl: string, codename: string) {
  const components = 'main restricted universe multiverse';
  const archiveUri = `http://${mirrorUrl}/ubuntu/`;
  const securityUri = mirrorUrl === 'archive.ubuntu.com' ? 'http://security.ubuntu.com/ubuntu/' : archiveUri;

  return [
    `deb ${archiveUri} ${codename} ${components}`,
    `deb ${archiveUri} ${codename}-updates ${components}`,
    `deb ${archiveUri} ${codename}-backports ${components}`,
    `deb ${securityUri} ${codename}-security ${components}`,
  ].join('\n');
}

function buildDebianLegacySources(mirrorUrl: string, codename: string) {
  const components = 'main contrib non-free non-free-firmware';

  return [
    `deb http://${mirrorUrl}/debian/ ${codename} ${components}`,
    `deb http://${mirrorUrl}/debian/ ${codename}-updates ${components}`,
    `deb http://${mirrorUrl}/debian/ ${codename}-backports ${components}`,
    `deb http://${mirrorUrl}/debian-security ${codename}-security ${components}`,
  ].join('\n');
}

function buildUbuntuDeb822Sources(mirrorUrl: string, codename: string) {
  const components = 'main restricted universe multiverse';
  const signedBy = '/usr/share/keyrings/ubuntu-archive-keyring.gpg';
  const archiveUri = `http://${mirrorUrl}/ubuntu/`;
  const securityUri = mirrorUrl === 'archive.ubuntu.com' ? 'http://security.ubuntu.com/ubuntu/' : archiveUri;

  if (securityUri === archiveUri) {
    return [
      'Types: deb',
      `URIs: ${archiveUri}`,
      `Suites: ${codename} ${codename}-updates ${codename}-backports ${codename}-security`,
      `Components: ${components}`,
      `Signed-By: ${signedBy}`,
    ].join('\n');
  }

  return [
    [
      'Types: deb',
      `URIs: ${archiveUri}`,
      `Suites: ${codename} ${codename}-updates ${codename}-backports`,
      `Components: ${components}`,
      `Signed-By: ${signedBy}`,
    ].join('\n'),
    [
      'Types: deb',
      `URIs: ${securityUri}`,
      `Suites: ${codename}-security`,
      `Components: ${components}`,
      `Signed-By: ${signedBy}`,
    ].join('\n'),
  ].join('\n\n');
}

function buildDebianDeb822Sources(mirrorUrl: string, codename: string) {
  const components = 'main contrib non-free non-free-firmware';
  const signedBy = '/usr/share/keyrings/debian-archive-keyring.gpg';

  return [
    [
      'Types: deb',
      `URIs: http://${mirrorUrl}/debian/`,
      `Suites: ${codename} ${codename}-updates ${codename}-backports`,
      `Components: ${components}`,
      `Signed-By: ${signedBy}`,
    ].join('\n'),
    [
      'Types: deb',
      `URIs: http://${mirrorUrl}/debian-security`,
      `Suites: ${codename}-security`,
      `Components: ${components}`,
      `Signed-By: ${signedBy}`,
    ].join('\n'),
  ].join('\n\n');
}

function buildAptSourcesContent(mirrorUrl: string, target: AptSourceTarget, codename: string) {
  if (target.format === 'deb822') {
    return target.flavor === 'ubuntu'
      ? buildUbuntuDeb822Sources(mirrorUrl, codename)
      : buildDebianDeb822Sources(mirrorUrl, codename);
  }

  return target.flavor === 'ubuntu'
    ? buildUbuntuLegacySources(mirrorUrl, codename)
    : buildDebianLegacySources(mirrorUrl, codename);
}

function MirrorsPanel() {
  const language = useCurrentAppLanguage();
  const runCommand = useRemoteSettingsCommand();
  const [distroType, setDistroType] = useState<MirrorDistroType>('unknown');
  const [distroName, setDistroName] = useState('');
  const [aptSourceTarget, setAptSourceTarget] = useState<AptSourceTarget | null>(null);
  const [currentMirror, setCurrentMirror] = useState('');
  const [mirrorDraft, setMirrorDraft] = useState('');
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [confirmDialog, setConfirmDialog] = useState<SettingsConfirmDialogConfig | null>(null);

  const detectDistro = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const detectResult = await runCommand(`
        if [ -f /etc/os-release ]; then
          . /etc/os-release
          echo "ID=$ID"
          echo "ID_LIKE=$ID_LIKE"
          echo "VERSION_CODENAME=$VERSION_CODENAME"
          echo "NAME=$NAME"
        elif command -v apt-get >/dev/null 2>&1; then
          echo "TYPE=debian"
        elif command -v dnf >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; then
          echo "TYPE=redhat"
        else
          echo "TYPE=unknown"
        fi
      `);
      const output = detectResult.stdout;
      const distroValues = parseKeyValueOutput(output);
      const distroId = (distroValues.get('ID') ?? '').toLowerCase();
      const distroLike = (distroValues.get('ID_LIKE') ?? '').toLowerCase();
      setDistroName(output);

      if (
        ['ubuntu', 'debian', 'kali', 'linuxmint', 'pop', 'elementary', 'raspbian'].includes(distroId)
        || /(^|[\s,])(ubuntu|debian)(?=$|[\s,])/.test(distroLike)
        || /TYPE=debian/i.test(output)
      ) {
        setDistroType('debian');
        const flavor = getAptFlavorFromDistroOutput(output);
        const mirrorResult = await runCommand(createAptSourceInspectionCommand());
        const sourceInspection = parseAptSourceInspection(mirrorResult.stdout, flavor, language);
        setAptSourceTarget(sourceInspection.target);
        setCurrentMirror(sourceInspection.display);
      } else if (
        ['centos', 'rhel', 'fedora', 'rocky', 'alma', 'almalinux', 'ol', 'amzn'].includes(distroId)
        || /(^|[\s,])(rhel|fedora|centos)(?=$|[\s,])/.test(distroLike)
      ) {
        setDistroType(isOfficialRhelDistro(distroValues) ? 'rhel' : 'redhat');
        setAptSourceTarget(null);
        const mirrorResult = await runCommand(createYumRepoInspectionCommand());
        setCurrentMirror(parseYumRepoInspection(mirrorResult.stdout || mirrorResult.stderr || '', language));
      } else {
        setDistroType('unknown');
        setAptSourceTarget(null);
        setCurrentMirror('');
      }
      setMirrorDraft('');
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [language, runCommand]);

  useEffect(() => { void detectDistro(); }, [detectDistro]);

  const getMirrorPlan = (mirrorUrl: string) => {
    if (!isSafeHostname(mirrorUrl)) {
      throw new Error(t('remoteSettings.mirrors.invalidDomain', language));
    }

    if (distroType === 'debian') {
      const versionMatch = distroName.match(/VERSION_CODENAME=(\S+)/);
      const flavor = aptSourceTarget?.flavor ?? getAptFlavorFromDistroOutput(distroName);
      const target = aptSourceTarget ?? getDefaultAptSourceTarget(flavor);
      const codename = normalizeAptCodename(versionMatch?.[1], flavor);
      const pathArg = shellQuote(target.path);
      const content = buildAptSourcesContent(mirrorUrl, target, codename);
      const backupCommand = `if [ -f ${pathArg} ]; then cp ${pathArg} ${pathArg}.bak.$(date +%s); fi`;
      const prepareCommand = target.format === 'deb822' ? 'mkdir -p /etc/apt/sources.list.d' : '';
      const writeCommand = `${prepareCommand ? `${prepareCommand}\n` : ''}cat > ${pathArg} << 'MIRROR_EOF'
${content}
MIRROR_EOF`;

      return {
        backupCommand,
        writeCommand,
        preview: `${backupCommand}\n${writeCommand}`,
        successMessage: t('remoteSettings.mirrors.switchAptSuccess', language, { path: target.path, mirror: mirrorUrl }),
      };
    }

    if (distroType === 'redhat') {
      const backupCommand = `cp -r /etc/yum.repos.d /etc/yum.repos.d.bak.$(date +%s) 2>/dev/null`;
      const writeCommand = `sed -i 's|^mirrorlist=|#mirrorlist=|g; s|^#\\(baseurl=.*\\)baseurl|\\1baseurl|g; s|baseurl=.*://[^/]*|baseurl=http://${mirrorUrl}|g' /etc/yum.repos.d/*.repo 2>/dev/null`;

      return {
        backupCommand,
        writeCommand,
        preview: `${backupCommand}\n${writeCommand}`,
        successMessage: t('remoteSettings.mirrors.switchYumSuccess', language, { mirror: mirrorUrl }),
      };
    }

    throw new Error(t('remoteSettings.mirrors.unknownDistro', language));
  };

  const applyMirror = async (mirrorUrl: string) => {
    setApplying(true);
    setError('');
    setSuccess('');
    try {
      const plan = getMirrorPlan(mirrorUrl);
      const backupResult = await runCommand(withLinuxPrivilege(plan.backupCommand));
      const writeResult = await runCommand(withLinuxPrivilege(plan.writeCommand));

      if (writeResult.code !== 0) {
        throw new Error(writeResult.stderr || writeResult.stdout || t('remoteSettings.mirrors.writeFailed', language));
      }
      setSuccess(backupResult.code === 0 ? plan.successMessage : t('remoteSettings.mirrors.backupMaybeFailed', language, { message: plan.successMessage }));
      setMirrorDraft('');
      await detectDistro();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setApplying(false);
    }
  };

  const requestApplyMirror = () => {
    if (!mirrorDraft) return;

    try {
      const plan = getMirrorPlan(mirrorDraft);

      setConfirmDialog({
        title: t('remoteSettings.mirrors.switchTitle', language),
        message: t('remoteSettings.mirrors.switchMessage', language, { mirror: mirrorDraft }),
        detail: t('remoteSettings.mirrors.switchDetail', language),
        preview: plan.preview,
        confirmLabel: t('remoteSettings.mirrors.switchConfirm', language),
        tone: 'warning',
        onConfirm: () => applyMirror(mirrorDraft),
      });
    } catch (err) {
      setError(getErrorMessage(err));
    }
  };

  const aptFlavor = aptSourceTarget?.flavor ?? getAptFlavorFromDistroOutput(distroName);
  const presets = distroType === 'debian'
    ? MIRROR_PRESETS[aptFlavor]
    : distroType === 'redhat'
      ? MIRROR_PRESETS.redhat
      : [];
  const canQuickSwitchMirror = distroType !== 'rhel';

  return (
    <div className="settings-panel-content">
      <div className="settings-panel-header">
        <div>
          <h3>{t('remoteSettings.mirrors.title', language)}</h3>
          <p>{t('remoteSettings.mirrors.description', language)}</p>
        </div>
        <button type="button" className="settings-action-btn" onClick={detectDistro} disabled={loading}>
          {loading ? t('remoteSettings.mirrors.detecting', language) : t('remoteSettings.mirrors.redetect', language)}
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
      <div className="settings-info-card">
        <span className="settings-info-label">{t('remoteSettings.mirrors.distro', language)}</span>
        <strong className="settings-info-value">{distroName.split('\n').filter(l => l.startsWith('NAME=')).map(l => l.replace('NAME=', '')).join('') || t('remoteSettings.mirrors.detecting', language)}</strong>
      </div>
      {distroType !== 'unknown' ? (
        <>
          <div className="settings-section">
            <h4>{t('remoteSettings.mirrors.current', language)}</h4>
            <pre className="settings-output">{currentMirror || t('remoteSettings.common.loading', language)}</pre>
          </div>
          {canQuickSwitchMirror ? (
            <div className="settings-section">
              <h4>{t('remoteSettings.mirrors.quickSwitch', language)}</h4>
              <div className="settings-mirror-grid">
                {presets.map((preset) => (
                  <button
                    key={preset.url}
                    type="button"
                    className={`settings-mirror-btn ${mirrorDraft === preset.url ? 'selected' : ''}`}
                    onClick={() => { setMirrorDraft(preset.url); setSuccess(''); setError(''); }}
                    disabled={applying}
                  >
                    <strong>{t(preset.labelId, language)}</strong>
                    <small>{preset.url}</small>
                  </button>
                ))}
              </div>
              {mirrorDraft ? (
                <div className="settings-preview-card">
                  <div>
                    <strong>{t('remoteSettings.mirrors.pending', language)}</strong>
                    <span>{mirrorDraft}</span>
                  </div>
                  <SettingsCommandPreview label={t('remoteSettings.mirrors.commandPreview', language)} content={getMirrorPlan(mirrorDraft).preview} />
                  <div className="settings-preview-actions">
                    <button type="button" className="settings-action-btn" onClick={() => setMirrorDraft('')} disabled={applying}>{t('remoteSettings.mirrors.clearDraft', language)}</button>
                    <button type="button" className="settings-action-btn primary" onClick={requestApplyMirror} disabled={applying}>
                      {applying ? t('remoteSettings.common.applyingConfig', language) : t('remoteSettings.network.previewApply', language)}
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="settings-section">
              <h4>{t('remoteSettings.mirrors.quickUnavailable', language)}</h4>
              <p className="settings-hint">
                {t('remoteSettings.mirrors.rhelHint', language)}
              </p>
            </div>
          )}
        </>
      ) : (
        <div className="settings-section">
          <p className="settings-hint">{t('remoteSettings.mirrors.unknownHint', language)}</p>
        </div>
      )}
      {confirmDialog ? <SettingsConfirmDialog config={confirmDialog} onClose={() => setConfirmDialog(null)} /> : null}
    </div>
  );
}

/* ─── System Update ───────────────────────────────────────────────────────── */

function UpdatePanel() {
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

/* ─── Hosts ───────────────────────────────────────────────────────────────── */

function HostsPanel() {
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

/* ─── Route ───────────────────────────────────────────────────────────────── */

function RoutePanel() {
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

/* ─── Disk ────────────────────────────────────────────────────────────────── */

function DiskPanel() {
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

/* ─── System Info ─────────────────────────────────────────────────────────── */

interface SysInfoItem {
  key: string;
  label: string;
  icon: string;
  value: string;
  detail?: string;
}

const hiddenSystemInfoItemKeys = new Set(['cpuCores', 'memoryTotal', 'diskTotal']);

function isVisibleSystemInfoItem(item: SysInfoItem) {
  return !hiddenSystemInfoItemKeys.has(item.key)
    && item.key !== 'hostname'
    && item.key !== 'os'
    && item.key !== 'user';
}

interface CpuInfoSummary {
  model: string;
  logicalCpus: string;
  physicalCores: string;
  threadsPerCore: string;
  sockets: string;
}

interface MemoryInfoSummary {
  total: string;
  used: string;
  free: string;
  shared: string;
  cache: string;
  available: string;
  usagePercent: number | null;
}

interface DiskInfoSummary {
  total: string;
  available: string;
}

function parseColonSeparatedBlock(raw: string) {
  const values = new Map<string, string>();

  for (const line of raw.split(/\r?\n/)) {
    const separatorIndex = line.indexOf(':');

    if (separatorIndex < 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();

    if (key && value) {
      values.set(key, value);
    }
  }

  return values;
}

function multiplyNumericStrings(left: string, right: string) {
  const leftValue = Number.parseInt(left, 10);
  const rightValue = Number.parseInt(right, 10);

  if (!Number.isFinite(leftValue) || !Number.isFinite(rightValue)) {
    return '';
  }

  return String(leftValue * rightValue);
}

function parseHumanReadableBytes(raw: string) {
  const match = raw.trim().match(/^([\d.]+)\s*([kmgtp]?i?)?b?$/i);

  if (!match) {
    return null;
  }

  const value = Number.parseFloat(match[1]);

  if (!Number.isFinite(value)) {
    return null;
  }

  const unit = (match[2] || '').toLowerCase();
  const multipliers: Record<string, number> = {
    '': 1,
    k: 1024,
    ki: 1024,
    m: 1024 ** 2,
    mi: 1024 ** 2,
    g: 1024 ** 3,
    gi: 1024 ** 3,
    t: 1024 ** 4,
    ti: 1024 ** 4,
    p: 1024 ** 5,
    pi: 1024 ** 5,
  };

  return value * (multipliers[unit] ?? 1);
}

function formatSysInfoDiskBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const precision = value >= 10 || unitIndex === 0 ? 0 : 1;
  return `${Number(value.toFixed(precision))} ${units[unitIndex]}`;
}

function parseLabeledDiskInfoSummary(raw: string): DiskInfoSummary | null {
  const values = parseColonSeparatedBlock(raw);
  const total = values.get('总量') ?? values.get('总计') ?? values.get('Total') ?? '';
  const available = values.get('可用') ?? values.get('空闲') ?? values.get('Available') ?? values.get('Free') ?? '';

  if (!total || !available) {
    return null;
  }

  return {
    total,
    available,
  };
}

function parseDfDiskInfoSummary(raw: string): DiskInfoSummary | null {
  let totalBytes = 0;
  let availableBytes = 0;
  const seenFilesystems = new Set<string>();
  const ignoredFilesystems = /^(tmpfs|devtmpfs|overlay|udev|shm|none|cgroup2?|proc|sysfs)$/i;

  for (const line of raw.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);

    if (parts.length < 5 || /^filesystem$/i.test(parts[0]) || ignoredFilesystems.test(parts[0])) {
      continue;
    }

    const useIndex = parts.findIndex((part, index) => index > 0 && /^\d+%$/.test(part));
    const size = useIndex >= 3 ? parseHumanReadableBytes(parts[useIndex - 3]) : null;
    const available = useIndex >= 3 ? parseHumanReadableBytes(parts[useIndex - 1]) : null;

    if (!size || !available || seenFilesystems.has(parts[0])) {
      continue;
    }

    seenFilesystems.add(parts[0]);
    totalBytes += size;
    availableBytes += available;
  }

  if (totalBytes <= 0) {
    return null;
  }

  return {
    total: formatSysInfoDiskBytes(totalBytes),
    available: formatSysInfoDiskBytes(availableBytes),
  };
}

function parseWindowsDiskInfoSummary(raw: string): DiskInfoSummary | null {
  let totalBytes = 0;
  let availableBytes = 0;

  for (const line of raw.split(/\r?\n/)) {
    const trimmedLine = line.trim();

    if (!trimmedLine || /^[-\s]+$/.test(trimmedLine) || /^DeviceID\b/i.test(trimmedLine)) {
      continue;
    }

    const match = trimmedLine.match(/([\d.]+)\s+([\d.]+)\s*$/);

    if (!match) {
      continue;
    }

    const sizeGb = Number.parseFloat(match[1]);
    const freeGb = Number.parseFloat(match[2]);

    if (!Number.isFinite(sizeGb) || !Number.isFinite(freeGb) || sizeGb <= 0) {
      continue;
    }

    totalBytes += sizeGb * 1024 ** 3;
    availableBytes += freeGb * 1024 ** 3;
  }

  if (totalBytes <= 0) {
    return null;
  }

  return {
    total: formatSysInfoDiskBytes(totalBytes),
    available: formatSysInfoDiskBytes(availableBytes),
  };
}

function parseDiskInfoSummary(raw: string): DiskInfoSummary | null {
  return parseLabeledDiskInfoSummary(raw)
    ?? parseDfDiskInfoSummary(raw)
    ?? parseWindowsDiskInfoSummary(raw);
}

function renderDiskInfoSummary(raw: string, language: AppLanguage) {
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

function parseCpuInfoSummary(raw: string): CpuInfoSummary | null {
  const values = parseColonSeparatedBlock(raw);
  const model = values.get('Model name') ?? raw.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? '';
  const logicalCpus = values.get('CPU(s)') ?? '';
  const sockets = values.get('Socket(s)') ?? '';
  const coresPerSocket = values.get('Core(s) per socket') ?? '';
  const threadsPerCore = values.get('Thread(s) per core') ?? '';
  const physicalCores = multiplyNumericStrings(sockets, coresPerSocket);

  if (!model && !logicalCpus && !physicalCores && !threadsPerCore && !sockets) {
    return null;
  }

  return {
    model,
    logicalCpus,
    physicalCores,
    threadsPerCore,
    sockets,
  };
}

function parseMemoryInfoSummary(raw: string): MemoryInfoSummary | null {
  const memLine = raw.split(/\r?\n/).find((line) => /^Mem:\s+/i.test(line.trim()));

  if (!memLine) {
    return null;
  }

  const parts = memLine.trim().split(/\s+/);

  if (parts.length < 7) {
    return null;
  }

  const total = parts[1] ?? '';
  const used = parts[2] ?? '';
  const free = parts[3] ?? '';
  const shared = parts[4] ?? '';
  const cache = parts[5] ?? '';
  const available = parts[6] ?? '';
  const totalBytes = parseHumanReadableBytes(total);
  const usedBytes = parseHumanReadableBytes(used);
  const usagePercent = totalBytes && usedBytes ? Math.round((usedBytes / totalBytes) * 100) : null;

  return {
    total,
    used,
    free,
    shared,
    cache,
    available,
    usagePercent,
  };
}

function SystemInfoPanel({ connectionId }: { connectionId: string }) {
  const language = useCurrentAppLanguage();
  const [items, setItems] = useState<SysInfoItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setItems(await getSystemInfoItems(connectionId));
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [connectionId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const hostnameItem = items.find((i) => i.key === 'hostname');
  const osItem = items.find((i) => i.key === 'os');

  const parseOsName = (raw: string) => {
    const pretty = raw.match(/PRETTY_NAME="([^"]+)"/);
    if (pretty) return pretty[1];
    const name = raw.match(/^NAME=(.+)/m)?.[1]?.replace(/"/g, '');
    const version = raw.match(/^VERSION=(.+)/m)?.[1]?.replace(/"/g, '');
    return [name, version].filter(Boolean).join(' ') || raw.split('\n')[0] || t('remoteSettings.systemInfo.unknown', language);
  };

  const renderStructuredSysInfoValue = (item: SysInfoItem) => {
    if (item.key === 'cpu') {
      const summary = parseCpuInfoSummary(item.value);

      if (!summary) {
        return <pre className="sysinfo-card-value">{item.value}</pre>;
      }

      return (
        <div className="sysinfo-feature-block">
          <div className="sysinfo-feature-title">{summary.model || t('remoteSettings.systemInfo.cpuInfo', language)}</div>
          <div className="sysinfo-metric-grid">
            <div className="sysinfo-metric">
              <span>{t('remoteSettings.systemInfo.logicalCpu', language)}</span>
              <strong>{summary.logicalCpus || '--'}</strong>
            </div>
            <div className="sysinfo-metric">
              <span>{t('remoteSettings.systemInfo.physicalCores', language)}</span>
              <strong>{summary.physicalCores || '--'}</strong>
            </div>
            <div className="sysinfo-metric">
              <span>{t('remoteSettings.systemInfo.threadsPerCore', language)}</span>
              <strong>{summary.threadsPerCore || '--'}</strong>
            </div>
            <div className="sysinfo-metric">
              <span>{t('remoteSettings.systemInfo.cpuSockets', language)}</span>
              <strong>{summary.sockets || '--'}</strong>
            </div>
          </div>
        </div>
      );
    }

    if (item.key === 'memory') {
      const summary = parseMemoryInfoSummary(item.value);

      if (!summary) {
        return <pre className="sysinfo-card-value">{item.value}</pre>;
      }

      return (
        <div className="sysinfo-feature-block">
          <div className="sysinfo-memory-headline">
            <strong>{summary.used}</strong>
            <span>/ {summary.total}</span>
          </div>
          <div className="sysinfo-memory-caption">
            {summary.usagePercent !== null ? t('remoteSettings.systemInfo.usedPercent', language, { percent: String(summary.usagePercent) }) : t('remoteSettings.systemInfo.memoryUsage', language)}
          </div>
          {summary.usagePercent !== null ? (
            <div className="sysinfo-memory-bar" aria-hidden="true">
              <span className="sysinfo-memory-bar-fill" style={{ width: `${Math.max(6, Math.min(summary.usagePercent, 100))}%` }} />
            </div>
          ) : null}
          <div className="sysinfo-metric-grid">
            <div className="sysinfo-metric">
              <span>{t('remoteSettings.systemInfo.available', language)}</span>
              <strong>{summary.available || '--'}</strong>
            </div>
            <div className="sysinfo-metric">
              <span>{t('remoteSettings.systemInfo.free', language)}</span>
              <strong>{summary.free || '--'}</strong>
            </div>
            <div className="sysinfo-metric">
              <span>{t('remoteSettings.systemInfo.cache', language)}</span>
              <strong>{summary.cache || '--'}</strong>
            </div>
            <div className="sysinfo-metric">
              <span>{t('remoteSettings.systemInfo.shared', language)}</span>
              <strong>{summary.shared || '--'}</strong>
            </div>
          </div>
        </div>
      );
    }

    if (item.key === 'disk') {
      return renderDiskInfoSummary(item.value, language);
    }

    return <pre className="sysinfo-card-value">{item.value}</pre>;
  };

  const hostLabel = hostnameItem?.value || t('remoteSettings.systemInfo.remoteHost', language);
  const osLabel = osItem ? parseOsName(osItem.value) : t('remoteSettings.systemInfo.description', language);

  return (
    <div className="settings-panel-content">
      <div className="settings-panel-header">
        <div>
          <h3>{hostLabel}</h3>
          <p>{osLabel}</p>
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

      <div className="sysinfo-grid">
        {items.filter(isVisibleSystemInfoItem).map((item) => (
          <article key={item.key} className="sysinfo-card">
            <div className="sysinfo-card-head">
              <span className="sysinfo-card-icon">{item.icon}</span>
              <span className="sysinfo-card-label">{translateStructuredText(item.label, language)}</span>
            </div>
            {renderStructuredSysInfoValue(item)}
          </article>
        ))}
      </div>
    </div>
  );
}

/* ─── Windows Panels ──────────────────────────────────────────────────────── */

const windowsHostsPath = 'C:/Windows/System32/drivers/etc/hosts';

function WindowsSystemInfoPanel({ connectionId }: { connectionId: string }) {
  const language = useCurrentAppLanguage();
  const [items, setItems] = useState<SysInfoItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setItems(await getSystemInfoItems(connectionId));
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [connectionId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const hostnameItem = items.find((i) => i.key === 'hostname');
  const osItem = items.find((i) => i.key === 'os');
  const hostLabel = hostnameItem?.value || t('remoteSettings.windows.host', language);
  const osLabel = osItem?.value || t('remoteSettings.windows.systemDescription', language);

  return (
    <div className="settings-panel-content">
      <div className="settings-panel-header">
        <div>
          <h3>{hostLabel}</h3>
          <p>{osLabel}</p>
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
      <div className="sysinfo-grid">
        {items.filter(isVisibleSystemInfoItem).map((item) => (
          <article key={item.key} className="sysinfo-card">
            <div className="sysinfo-card-head">
              <span className="sysinfo-card-icon">{item.icon}</span>
              <span className="sysinfo-card-label">{translateStructuredText(item.label, language)}</span>
            </div>
            {item.key === 'disk' ? renderDiskInfoSummary(item.value, language) : <pre className="sysinfo-card-value">{item.value}</pre>}
          </article>
        ))}
      </div>
    </div>
  );
}

function WindowsNetworkPanel() {
  const language = useCurrentAppLanguage();
  const runCommand = useRemoteSettingsCommand();
  const [hostname, setHostname] = useState('');
  const [networkInfo, setNetworkInfo] = useState('');
  const [dnsInfo, setDnsInfo] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [hostResult, ipResult, dnsResult] = await Promise.all([
        runCommand(powershellCommand('[System.Net.Dns]::GetHostName()')),
        runCommand(powershellCommand('Get-NetIPConfiguration | Format-List | Out-String -Width 220')),
        runCommand(powershellCommand('Get-DnsClientServerAddress -AddressFamily IPv4,IPv6 | Format-Table -AutoSize | Out-String -Width 200')),
      ]);
      setHostname(hostResult.stdout || hostResult.stderr);
      setNetworkInfo(ipResult.stdout || ipResult.stderr);
      setDnsInfo(dnsResult.stdout || dnsResult.stderr);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [runCommand]);

  useEffect(() => { void refresh(); }, [refresh]);

  return (
    <div className="settings-panel-content">
      <div className="settings-panel-header">
        <div>
          <h3>{t('remoteSettings.windows.networkTitle', language)}</h3>
          <p>{t('remoteSettings.windows.networkDescription', language)}</p>
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
      <div className="settings-info-card">
        <div className="settings-info-row">
          <span className="settings-info-label">{t('remoteSettings.network.hostname', language)}</span>
          <strong className="settings-info-value">{hostname || '...'}</strong>
        </div>
      </div>
      <div className="settings-section">
        <h4>{t('remoteSettings.windows.adapters', language)}</h4>
        <pre className="settings-output">{networkInfo || t('remoteSettings.common.loading', language)}</pre>
      </div>
      <div className="settings-section">
        <h4>{t('remoteSettings.windows.dnsConfig', language)}</h4>
        <pre className="settings-output">{dnsInfo || t('remoteSettings.common.loading', language)}</pre>
      </div>
    </div>
  );
}

function WindowsHostsPanel({ connectionId }: { connectionId: string }) {
  const language = useCurrentAppLanguage();
  const [content, setContent] = useState('');
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [newIp, setNewIp] = useState('');
  const [newHost, setNewHost] = useState('');
  const [confirmDialog, setConfirmDialog] = useState<SettingsConfirmDialogConfig | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const text = await window.guiSSH!.connections.readFile(connectionId, windowsHostsPath);
      setContent(text);
      setDraft(text);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [connectionId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const saveHosts = async () => {
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      await window.guiSSH!.connections.writeFile(connectionId, windowsHostsPath, draft);
      setContent(draft);
      setSuccess(t('remoteSettings.windows.hostsSaved', language));
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const requestSaveHosts = () => {
    if (draft === content) {
      setSuccess(t('remoteSettings.windows.hostsNoDraftChanges', language));
      return;
    }

    setConfirmDialog({
      title: t('remoteSettings.windows.hostsSaveTitle', language),
      message: t('remoteSettings.windows.hostsSaveMessage', language, { path: windowsHostsPath }),
      detail: t('remoteSettings.windows.hostsSaveDetail', language),
      preview: createLineChangePreview(content, draft, language),
      confirmLabel: t('remoteSettings.hosts.saveConfirm', language),
      tone: 'warning',
      onConfirm: saveHosts,
    });
  };

  const addEntry = async () => {
    const ip = newIp.trim();
    const host = newHost.trim();
    if (!ip || !host) {
      setError(t('remoteSettings.windows.hostsIpHostRequired', language));
      return;
    }
    if (!isSafeNameserver(ip) || !isSafeHostname(host)) {
      setError(t('remoteSettings.windows.hostsIpHostInvalid', language));
      return;
    }
    const line = `${ip}\t${host}`;
    const nextDraft = `${draft.trimEnd()}\r\n${line}\r\n`;
    setDraft(nextDraft);
    setNewIp('');
    setNewHost('');
    setSuccess(t('remoteSettings.windows.hostsAddedDraft', language, { host }));
  };

  return (
    <div className="settings-panel-content">
      <div className="settings-panel-header">
        <div>
          <h3>{t('remoteSettings.hosts.title', language)}</h3>
          <p>{windowsHostsPath}</p>
        </div>
        <div className="settings-header-actions">
          <button type="button" className="settings-action-btn" onClick={refresh} disabled={loading}>{loading ? t('remoteSettings.common.loading', language) : t('remoteSettings.common.refresh', language)}</button>
          <button type="button" className="settings-action-btn primary" onClick={requestSaveHosts} disabled={saving || draft === content}>
            {saving ? t('remoteSettings.hosts.saving', language) : t('remoteSettings.hosts.previewSave', language)}
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
      <div className="settings-section">
        <h4>{t('remoteSettings.windows.hostsAddSection', language)}</h4>
        <div className="settings-inline-form">
          <input className="settings-input" placeholder={t('remoteSettings.hosts.ipPlaceholder', language)} value={newIp} onChange={(e) => setNewIp(e.target.value)} />
          <input className="settings-input" placeholder={t('remoteSettings.hosts.hostnamePlaceholder', language)} value={newHost} onChange={(e) => setNewHost(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void addEntry(); }} />
          <button type="button" className="settings-action-btn primary" onClick={addEntry}>{t('remoteSettings.hosts.add', language)}</button>
        </div>
      </div>
      <div className="settings-section">
        <h4>{t('remoteSettings.windows.hostsEditTitle', language)}</h4>
        <textarea
          className="settings-textarea"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={18}
          spellCheck={false}
        />
        <SettingsCommandPreview label={t('remoteSettings.hosts.changePreview', language)} content={createLineChangePreview(content, draft, language)} />
      </div>
      {confirmDialog ? <SettingsConfirmDialog config={confirmDialog} onClose={() => setConfirmDialog(null)} /> : null}
    </div>
  );
}

function WindowsRoutePanel() {
  const language = useCurrentAppLanguage();
  const runCommand = useRemoteSettingsCommand();
  const [routes, setRoutes] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await runCommand(powershellCommand('Get-NetRoute | Sort-Object -Property DestinationPrefix, RouteMetric | Format-Table -AutoSize | Out-String -Width 260'));
      setRoutes(result.stdout || result.stderr || t('remoteSettings.route.unavailable', language));
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
          <h3>{t('remoteSettings.route.tableTitle', language)}</h3>
          <p>{t('remoteSettings.windows.routeDescription', language)}</p>
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
        <h4>{t('remoteSettings.route.tableTitle', language)}</h4>
        <pre className="settings-output">{routes || t('remoteSettings.common.loading', language)}</pre>
      </div>
    </div>
  );
}

function WindowsDiskPanel() {
  const language = useCurrentAppLanguage();
  const runCommand = useRemoteSettingsCommand();
  const [diskInfo, setDiskInfo] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const diskResult = await runCommand(createWindowsDiskSummaryCommand(language));
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
          <h3>{t('remoteSettings.windows.diskTitle', language)}</h3>
          <p>{t('remoteSettings.windows.diskDescription', language)}</p>
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
        <h4>{t('remoteSettings.windows.localDisks', language)}</h4>
        <pre className="settings-output">{diskInfo || t('remoteSettings.common.loading', language)}</pre>
      </div>
    </div>
  );
}

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

function RemoteSettings({ connectionId, systemType }: RemoteSettingsProps) {
  const language = useCurrentAppLanguage();
  const isWindowsHost = isWindowsSystem(systemType);
  const { runCommand, sudoPrompt } = useSudoCommand(connectionId, systemType);
  const settingsGroups = isWindowsHost ? WINDOWS_SETTINGS_GROUPS : SETTINGS_GROUPS;
  const [activeTab, setActiveTab] = useState<SettingsTab>('systeminfo');
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

  useEffect(() => { void refreshHostStatus(); }, [refreshHostStatus]);

  const renderPanel = () => {
    if (isWindowsHost) {
      switch (activeTab) {
        case 'systeminfo': return <WindowsSystemInfoPanel connectionId={connectionId} />;
        case 'network': return <WindowsNetworkPanel />;
        case 'hosts': return <WindowsHostsPanel connectionId={connectionId} />;
        case 'route': return <WindowsRoutePanel />;
        default: return <WindowsSystemInfoPanel connectionId={connectionId} />;
      }
    }

    switch (activeTab) {
      case 'systeminfo': return <SystemInfoPanel connectionId={connectionId} />;
      case 'network': return <NetworkPanel />;
      case 'update': return <UpdatePanel />;
      case 'hosts': return <HostsPanel />;
      case 'route': return <RoutePanel />;
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

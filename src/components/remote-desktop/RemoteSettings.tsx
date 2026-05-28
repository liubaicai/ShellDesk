import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { getErrorMessage } from './desktopUtils';
import { isWindowsSystem, powershellCommand } from './remoteSystem';
import type { RemoteSystemType } from './types';

interface RemoteSettingsProps {
  connectionId: string;
  systemType?: RemoteSystemType;
}

type SettingsTab = 'systeminfo' | 'network' | 'mirrors' | 'update' | 'hosts' | 'route' | 'disk';

interface SettingsTabDef {
  key: SettingsTab;
  label: string;
  icon: string;
  description: string;
}

interface SettingsGroup {
  label: string;
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
  unknown: '未知系统',
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
    label: '系统',
    tabs: [
      { key: 'systeminfo', label: '系统信息', icon: '\u{1F4BB}', description: '硬件和软件系统概况' },
      { key: 'update', label: '系统更新', icon: '\u{1F504}', description: '系统软件包更新与升级' },
    ],
  },
  {
    label: '网络',
    tabs: [
      { key: 'network', label: '网络和网卡', icon: '\u{1F310}', description: '网络接口、IP 地址、DNS 配置' },
      { key: 'hosts', label: 'Hosts 管理', icon: '\u{1F4CB}', description: '管理 /etc/hosts 主机映射' },
      { key: 'route', label: '路由管理', icon: '\u{1F6E3}\uFE0F', description: '查看和管理路由表' },
    ],
  },
  {
    label: '软件',
    tabs: [
      { key: 'mirrors', label: '镜像源', icon: '\u{1F3EA}', description: 'APT / YUM 软件包镜像源配置' },
    ],
  },
  {
    label: '存储',
    tabs: [
      { key: 'disk', label: '磁盘和挂载点', icon: '\u{1F4BD}', description: '磁盘分区、挂载点、使用情况' },
    ],
  },
];

const WINDOWS_SETTINGS_GROUPS: SettingsGroup[] = [
  {
    label: '系统',
    tabs: [
      { key: 'systeminfo', label: '系统信息', icon: '\u{1F4BB}', description: 'Windows 主机概况' },
    ],
  },
  {
    label: '网络',
    tabs: [
      { key: 'network', label: '网络信息', icon: '\u{1F310}', description: 'IP、DNS 和适配器信息' },
      { key: 'hosts', label: 'Hosts 管理', icon: '\u{1F4CB}', description: '管理 Windows hosts 文件' },
      { key: 'route', label: '路由表', icon: '\u{1F6E3}\uFE0F', description: '查看 Windows 路由表' },
    ],
  },
  {
    label: '存储',
    tabs: [
      { key: 'disk', label: '磁盘和卷', icon: '\u{1F4BD}', description: '查看本地磁盘、卷和空间' },
    ],
  },
];

interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

async function runCmd(connectionId: string, command: string): Promise<CommandResult> {
  if (!window.guiSSH?.connections) {
    throw new Error('当前运行环境不支持远程命令执行。');
  }
  return window.guiSSH.connections.runCommand(connectionId, command);
}

async function getSystemInfoItems(connectionId: string): Promise<SysInfoItem[]> {
  if (!window.guiSSH?.connections) {
    throw new Error('当前运行环境不支持系统信息读取。');
  }

  const report = await window.guiSSH.connections.getSystemInfo(connectionId);
  return report.items;
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
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

function getSystemTypeLabel(systemType?: RemoteSystemType) {
  return SYSTEM_TYPE_LABELS[systemType ?? 'unknown'] ?? '未知系统';
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

function createLineChangePreview(current: string, draft: string) {
  if (current === draft) {
    return '无变更。';
  }

  const currentLines = current.split(/\r?\n/);
  const draftLines = draft.split(/\r?\n/);
  const currentLineSet = new Set(currentLines);
  const draftLineSet = new Set(draftLines);
  const removed = currentLines.filter((line) => line.trim() && !draftLineSet.has(line)).slice(0, 10);
  const added = draftLines.filter((line) => line.trim() && !currentLineSet.has(line)).slice(0, 10);
  const previewLines = [
    `原始行数：${currentLines.length}`,
    `草稿行数：${draftLines.length}`,
    '',
    '新增：',
    ...(added.length ? added.map((line) => `+ ${line}`) : ['(无)']),
    '',
    '移除：',
    ...(removed.length ? removed.map((line) => `- ${line}`) : ['(无)']),
  ];

  if (added.length >= 10 || removed.length >= 10) {
    previewLines.push('', '仅显示前 10 条变更。');
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
        {config.preview ? <SettingsCommandPreview label="执行预览" content={config.preview} /> : null}
        <div className="settings-modal-actions">
          <button type="button" className="settings-modal-btn" onClick={onClose} disabled={isApplying}>取消</button>
          <button
            type="button"
            className={`settings-modal-btn ${tone === 'danger' ? 'danger' : 'primary'}`}
            onClick={() => void handleConfirm()}
            disabled={isApplying}
          >
            {isApplying ? '执行中...' : config.confirmLabel ?? '确认'}
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

function createDnsConfigPreview(current: DnsConfig, draft: DnsConfig) {
  return [
    '当前 DNS：',
    ...(current.servers.length ? current.servers.map((server) => `  ${server}`) : ['  (无)']),
    current.search ? `当前搜索域：${current.search}` : '当前搜索域：(无)',
    '',
    '草稿 DNS：',
    ...(draft.servers.length ? draft.servers.map((server) => `  ${server}`) : ['  (无)']),
    draft.search ? `草稿搜索域：${draft.search}` : '草稿搜索域：(无)',
    '',
    '将备份 /etc/resolv.conf 后写入草稿配置。',
  ].join('\n');
}

function NetworkPanel({ connectionId }: { connectionId: string }) {
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
        runCmd(connectionId, 'ip addr show 2>/dev/null || ifconfig -a 2>/dev/null'),
        runCmd(connectionId, 'cat /etc/resolv.conf 2>/dev/null'),
        runCmd(connectionId, 'hostname -f 2>/dev/null || hostname'),
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
  }, [connectionId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const applyIfacePowerState = async (ifaceName: string, bringUp: boolean) => {
    setActionLoading(ifaceName);
    setError('');
    setSuccess('');
    try {
      const result = await runCmd(connectionId, withLinuxPrivilege(`ip link set ${shellQuote(ifaceName)} ${bringUp ? 'up' : 'down'} 2>&1`));
      if (result.code !== 0) throw new Error(result.stderr || '操作失败，可能需要 root 权限。');
      setSuccess(`接口 ${ifaceName} 已${bringUp ? '启用' : '禁用'}。`);
      await refresh();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setActionLoading(null);
    }
  };

  const requestToggleIface = (ifaceName: string, bringUp: boolean) => {
    setConfirmDialog({
      title: bringUp ? '启用网络接口' : '禁用网络接口',
      message: bringUp
        ? `将启用 ${ifaceName}。如果该接口存在冲突配置，可能改变当前网络路径。`
        : `将禁用 ${ifaceName}。如果 SSH 正通过该接口连接，远程会话可能立即断开。`,
      detail: '建议在确认有带外访问或备用连接后执行网络接口变更。',
      preview: `ip link set ${shellQuote(ifaceName)} ${bringUp ? 'up' : 'down'}`,
      confirmLabel: bringUp ? '启用接口' : '禁用接口',
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
        command: `dhclient -r ${ifaceArg} 2>/dev/null; dhclient ${ifaceArg} 2>&1 || echo "dhclient 不可用，请确认已安装"`,
        preview: [`dhclient -r ${ifaceArg}`, `dhclient ${ifaceArg}`].join('\n'),
      };
    }

    if (!form.address.trim()) {
      throw new Error('请输入 IP 地址。');
    }

    if (!isSafeNameserver(form.address.trim())) {
      throw new Error('IP 地址格式无效。');
    }

    if (form.gateway.trim() && !isSafeNameserver(form.gateway.trim())) {
      throw new Error('默认网关格式无效。');
    }

    const prefix = form.netmask.trim() ? netmaskToPrefix(form.netmask.trim()) : 24;

    if (prefix === null) {
      throw new Error('子网掩码格式无效。');
    }

    const cidr = `${form.address.trim()}/${prefix}`;
    let command = `ip addr flush dev ${ifaceArg} 2>/dev/null; ip addr add ${shellQuote(cidr)} dev ${ifaceArg} 2>&1`;
    const previewLines = [
      `ip addr flush dev ${ifaceArg}`,
      `ip addr add ${shellQuote(cidr)} dev ${ifaceArg}`,
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
      const result = await runCmd(connectionId, withLinuxPrivilege(command));
      if (result.code !== 0 && !result.stdout.includes('dhclient')) {
        throw new Error(result.stderr || result.stdout || '配置失败，可能需要 root 权限。');
      }
      setSuccess(`接口 ${ifaceName} 配置已应用。`);
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
        title: '应用网络接口配置',
        message: `将修改接口 ${editingIface} 的地址配置。`,
        detail: '这类变更可能导致 SSH 连接中断；执行前请确认网关、网段和当前连接路径。',
        preview: plan.preview,
        confirmLabel: '应用配置',
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
      setError('请输入新的主机名。');
      return;
    }
    if (!isSafeHostname(name)) {
      setError('主机名只能包含字母、数字、点和短横线，且不能以点或短横线结尾。');
      return;
    }
    setIsHostnameDialogOpen(false);
    setActionLoading('hostname');
    setError('');
    setSuccess('');
    try {
      const quotedName = shellQuote(name);
      const result = await runCmd(connectionId, withLinuxPrivilege(`hostnamectl set-hostname ${quotedName} 2>&1 || hostname ${quotedName} 2>&1`));
      if (result.code !== 0) throw new Error(result.stderr || '设置主机名失败。');
      setSuccess(`主机名已设置为 ${name}。`);
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
      setError('DNS 服务器必须是 IPv4 或 IPv6 地址。');
      return;
    }
    if (dnsDraftConfig.servers.includes(server)) {
      setSuccess(`${server} 已在 DNS 草稿中。`);
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
      success: `已加入草稿：${server}`,
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
      success: `已从草稿移除：${server}`,
    }));
  };

  const applyDnsDraft = async (nextContent: string, draft: DnsConfig) => {
    setActionLoading('dns');
    setError('');
    setSuccess('');
    try {
      const result = await runCmd(connectionId, withLinuxPrivilege(`cp /etc/resolv.conf /etc/resolv.conf.bak.$(date +%s) 2>/dev/null; printf '%s' ${shellQuote(nextContent)} > /etc/resolv.conf`));
      if (result.code !== 0) {
        throw new Error(result.stderr || result.stdout || '写入 DNS 配置失败，可能需要 root 权限。');
      }
      setDnsState((currentState) => ({
        ...currentState,
        current: { ...draft, raw: nextContent },
        draft: { ...draft, raw: nextContent },
        success: 'DNS 配置已应用。',
      }));
      setSuccess('DNS 配置已应用。');
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
      title: '应用 DNS 配置',
      message: '将备份并重写 /etc/resolv.conf 中的 DNS 配置。',
      detail: 'DNS 变更可能影响包管理、域名访问和远程服务解析。',
      preview: createDnsConfigPreview(currentDnsConfig, dnsDraftConfig),
      confirmLabel: '应用 DNS',
      tone: 'warning',
      onConfirm: () => applyDnsDraft(nextContent, dnsDraftConfig),
    });
  };

  return (
    <div className="settings-panel-content">
      <div className="settings-panel-header">
        <div>
          <h3>网络和网卡</h3>
          <p>查看和配置网络接口、IP 地址和 DNS</p>
        </div>
        <button type="button" className="settings-action-btn" onClick={refresh} disabled={loading}>
          {loading ? '加载中...' : '刷新'}
        </button>
      </div>
      {error ? <div className="error-banner">{error}</div> : null}
      {success ? <div className="settings-success-banner">{success}</div> : null}
      <div className="settings-warning-banner">
        网络接口、默认路由和 DNS 变更可能让当前 SSH 会话失联。应用前请确认你有备用连接路径。
      </div>

      {/* Hostname */}
      <div className="settings-info-card">
        <div className="settings-info-row">
          <span className="settings-info-label">主机名</span>
          <strong className="settings-info-value">{hostname || '...'}</strong>
        </div>
        <button type="button" className="settings-action-btn" onClick={openHostnameDialog} disabled={actionLoading === 'hostname'}>
          {actionLoading === 'hostname' ? '...' : '修改'}
        </button>
      </div>

      {/* Interface Cards */}
      <div className="settings-section">
        <h4>网络接口 ({ifaces.length})</h4>
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
                        {isBusy ? '...' : '禁用'}
                      </button>
                    ) : (
                      <button type="button" className="settings-action-btn primary" onClick={() => requestToggleIface(iface.name, true)} disabled={isBusy}>
                        {isBusy ? '...' : '启用'}
                      </button>
                    )}
                    <button type="button" className="settings-action-btn" onClick={() => startEditIface(iface)} disabled={isBusy}>
                      编辑
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
                    <span className="net-iface-meta no-addr">无 IP 地址</span>
                  ) : null}
                </div>

                {/* Inline Edit Form */}
                {isEditing ? (
                  <div className="net-iface-edit">
                    <div className="net-edit-row">
                      <label>
                        <span>配置方式</span>
                        <select
                          value={editForm.method}
                          onChange={(e) => setEditForm({ ...editForm, method: e.target.value as 'static' | 'dhcp' })}
                          className="settings-select"
                        >
                          <option value="static">静态 IP</option>
                          <option value="dhcp">DHCP 自动</option>
                        </select>
                      </label>
                    </div>
                    {editForm.method === 'static' ? (
                      <>
                        <div className="net-edit-row">
                          <label>
                            <span>IP 地址</span>
                            <input type="text" className="settings-input" placeholder="192.168.1.100" value={editForm.address} onChange={(e) => setEditForm({ ...editForm, address: e.target.value })} />
                          </label>
                          <label>
                            <span>子网掩码</span>
                            <input type="text" className="settings-input" placeholder="255.255.255.0" value={editForm.netmask} onChange={(e) => setEditForm({ ...editForm, netmask: e.target.value })} />
                          </label>
                        </div>
                        <div className="net-edit-row">
                          <label>
                            <span>默认网关 (可选)</span>
                            <input type="text" className="settings-input" placeholder="192.168.1.1" value={editForm.gateway} onChange={(e) => setEditForm({ ...editForm, gateway: e.target.value })} />
                          </label>
                        </div>
                      </>
                    ) : null}
                    <div className="net-edit-footer">
                      <button type="button" className="settings-action-btn" onClick={() => setEditingIface(null)}>取消</button>
                      <button type="button" className="settings-action-btn primary" onClick={requestApplyIfaceConfig} disabled={isBusy}>
                        {isBusy ? '应用中...' : '应用配置'}
                      </button>
                    </div>
                  </div>
                ) : null}
              </article>
            );
          })}
          {ifaces.length === 0 ? <p className="settings-hint">{loading ? '正在加载接口信息...' : '未检测到网络接口。'}</p> : null}
        </div>
      </div>

      {/* DNS Configuration */}
      <div className="settings-section">
        <h4>DNS 服务器</h4>
        <div className="dns-server-list">
          {dnsDraftConfig.servers.map((server) => (
            <div key={server} className="dns-server-item">
              <span className="dns-server-addr">{server}</span>
              <button type="button" className="settings-action-btn danger" onClick={() => removeDnsServer(server)}>移除</button>
            </div>
          ))}
          {dnsDraftConfig.servers.length === 0 ? <p className="settings-hint">{dnsState.loading ? '正在加载 DNS 配置...' : '无已配置的 DNS 服务器。'}</p> : null}
        </div>
        <div className="settings-inline-form">
          <input type="text" className="settings-input" placeholder="添加 DNS 服务器 (如 8.8.8.8)" value={newDns} onChange={(e) => setNewDns(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void addDnsServer(); }} />
          <button type="button" className="settings-action-btn primary" onClick={addDnsServer}>加入草稿</button>
        </div>
        <label className="settings-field">
          <span>搜索域</span>
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
            <span>DNS 草稿尚未应用。</span>
            <div className="settings-header-actions">
              <button type="button" className="settings-action-btn" onClick={() => setDnsState((currentState) => ({ ...currentState, draft: currentState.current }))}>
                回滚草稿
              </button>
              <button type="button" className="settings-action-btn primary" onClick={requestApplyDnsDraft} disabled={actionLoading === 'dns'}>
                {actionLoading === 'dns' ? '应用中...' : '预览并应用'}
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
            <div id="hostname-dialog-title" className="notepad-modal-title">修改主机名</div>
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
              placeholder="例如 server-01"
            />
            {hostnameDraft.trim() ? (
              <SettingsCommandPreview
                label="执行预览"
                content={[
                  `hostnamectl set-hostname ${shellQuote(hostnameDraft.trim())}`,
                  `hostname ${shellQuote(hostnameDraft.trim())}`,
                ].join('\n')}
              />
            ) : null}
            <div className="notepad-modal-actions">
              <button type="button" className="notepad-modal-btn" onClick={() => setIsHostnameDialogOpen(false)}>取消</button>
              <button type="button" className="notepad-modal-btn primary" onClick={() => void setHostnameCmd()}>保存</button>
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
    { label: '阿里云', url: 'mirrors.aliyun.com' },
    { label: '清华 TUNA', url: 'mirrors.tuna.tsinghua.edu.cn' },
    { label: '中科大 USTC', url: 'mirrors.ustc.edu.cn' },
    { label: '华为云', url: 'mirrors.huaweicloud.com' },
    { label: '官方源', url: 'archive.ubuntu.com' },
  ],
  debian: [
    { label: '阿里云', url: 'mirrors.aliyun.com' },
    { label: '清华 TUNA', url: 'mirrors.tuna.tsinghua.edu.cn' },
    { label: '中科大 USTC', url: 'mirrors.ustc.edu.cn' },
    { label: '华为云', url: 'mirrors.huaweicloud.com' },
    { label: '官方源', url: 'deb.debian.org' },
  ],
  redhat: [
    { label: '阿里云', url: 'mirrors.aliyun.com' },
    { label: '清华 TUNA', url: 'mirrors.tuna.tsinghua.edu.cn' },
    { label: '中科大 USTC', url: 'mirrors.ustc.edu.cn' },
    { label: '华为云', url: 'mirrors.huaweicloud.com' },
  ],
};

type MirrorDistroType = 'debian' | 'redhat' | 'unknown';
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

function createAptSourceInspectionCommand() {
  return [
    'if [ -f /etc/os-release ]; then',
    '  . /etc/os-release',
    'fi',
    'apt_source_path=',
    'apt_source_format=legacy',
    'if [ "${ID:-}" = "ubuntu" ] && [ -f /etc/apt/sources.list.d/ubuntu.sources ]; then',
    '  apt_source_path=/etc/apt/sources.list.d/ubuntu.sources',
    '  apt_source_format=deb822',
    'elif [ "${ID:-}" = "debian" ] && [ -f /etc/apt/sources.list.d/debian.sources ]; then',
    '  apt_source_path=/etc/apt/sources.list.d/debian.sources',
    '  apt_source_format=deb822',
    'elif [ -f /etc/apt/sources.list.d/ubuntu.sources ]; then',
    '  apt_source_path=/etc/apt/sources.list.d/ubuntu.sources',
    '  apt_source_format=deb822',
    'elif [ -f /etc/apt/sources.list.d/debian.sources ]; then',
    '  apt_source_path=/etc/apt/sources.list.d/debian.sources',
    '  apt_source_format=deb822',
    'elif [ -f /etc/apt/sources.list ]; then',
    '  apt_source_path=/etc/apt/sources.list',
    '  apt_source_format=legacy',
    'elif [ "${ID:-}" = "ubuntu" ]; then',
    '  apt_source_path=/etc/apt/sources.list.d/ubuntu.sources',
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

function parseAptSourceInspection(stdout: string, flavor: AptMirrorFlavor) {
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
    `配置文件：${path}`,
    `格式：${format === 'deb822' ? 'deb822 (.sources)' : 'legacy sources.list'}`,
    '',
    content || '无法读取，应用镜像源时将创建该文件。',
  ].join('\n');

  return { target, display };
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

function MirrorsPanel({ connectionId }: { connectionId: string }) {
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
      const detectResult = await runCmd(connectionId, `
        if [ -f /etc/os-release ]; then
          . /etc/os-release
          echo "ID=$ID"
          echo "ID_LIKE=$ID_LIKE"
          echo "VERSION_CODENAME=$VERSION_CODENAME"
          echo "NAME=$NAME"
        elif command -v apt-get >/dev/null 2>&1; then
          echo "TYPE=debian"
        elif command -v yum >/dev/null 2>&1; then
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
        const mirrorResult = await runCmd(connectionId, createAptSourceInspectionCommand());
        const sourceInspection = parseAptSourceInspection(mirrorResult.stdout, flavor);
        setAptSourceTarget(sourceInspection.target);
        setCurrentMirror(sourceInspection.display);
      } else if (
        ['centos', 'rhel', 'fedora', 'rocky', 'alma', 'almalinux', 'ol', 'amzn'].includes(distroId)
        || /(^|[\s,])(rhel|fedora|centos)(?=$|[\s,])/.test(distroLike)
      ) {
        setDistroType('redhat');
        setAptSourceTarget(null);
        const mirrorResult = await runCmd(connectionId, 'cat /etc/yum.repos.d/*.repo 2>/dev/null | grep -E "^baseurl|^mirrorlist" | head -20');
        setCurrentMirror(mirrorResult.stdout || '无法读取');
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
  }, [connectionId]);

  useEffect(() => { void detectDistro(); }, [detectDistro]);

  const getMirrorPlan = (mirrorUrl: string) => {
    if (!isSafeHostname(mirrorUrl)) {
      throw new Error('镜像源域名无效。');
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
        successMessage: `已切换 ${target.path} 到 ${mirrorUrl}，请前往「系统更新」刷新软件包索引。`,
      };
    }

    if (distroType === 'redhat') {
      const backupCommand = `cp -r /etc/yum.repos.d /etc/yum.repos.d.bak.$(date +%s) 2>/dev/null`;
      const writeCommand = `sed -i 's|^mirrorlist=|#mirrorlist=|g; s|^#\\(baseurl=.*\\)baseurl|\\1baseurl|g; s|baseurl=.*://[^/]*|baseurl=http://${mirrorUrl}|g' /etc/yum.repos.d/*.repo 2>/dev/null`;

      return {
        backupCommand,
        writeCommand,
        preview: `${backupCommand}\n${writeCommand}`,
        successMessage: `已切换到 ${mirrorUrl}。`,
      };
    }

    throw new Error('无法识别的发行版类型，请手动修改镜像源配置。');
  };

  const applyMirror = async (mirrorUrl: string) => {
    setApplying(true);
    setError('');
    setSuccess('');
    try {
      const plan = getMirrorPlan(mirrorUrl);
      const backupResult = await runCmd(connectionId, withLinuxPrivilege(plan.backupCommand));
      const writeResult = await runCmd(connectionId, withLinuxPrivilege(plan.writeCommand));

      if (writeResult.code !== 0) {
        throw new Error(writeResult.stderr || writeResult.stdout || '写入镜像源失败，可能需要 root 权限。');
      }
      setSuccess(backupResult.code === 0 ? plan.successMessage : `${plan.successMessage}（备份命令可能未执行成功，请确认权限。）`);
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
        title: '切换软件镜像源',
        message: `将把软件源切换到 ${mirrorDraft}。`,
        detail: '系统会先尝试创建备份，再写入新的源配置。失败时请查看回显并手动检查源文件。',
        preview: plan.preview,
        confirmLabel: '切换镜像源',
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

  return (
    <div className="settings-panel-content">
      <div className="settings-panel-header">
        <div>
          <h3>镜像源配置</h3>
          <p>管理 APT / YUM 软件包镜像源</p>
        </div>
        <button type="button" className="settings-action-btn" onClick={detectDistro} disabled={loading}>
          {loading ? '检测中...' : '重新检测'}
        </button>
      </div>
      {error ? <div className="error-banner">{error}</div> : null}
      {success ? <div className="settings-success-banner">{success}</div> : null}
      <div className="settings-info-card">
        <span className="settings-info-label">发行版</span>
        <strong className="settings-info-value">{distroName.split('\n').filter(l => l.startsWith('NAME=')).map(l => l.replace('NAME=', '')).join('') || '检测中...'}</strong>
      </div>
      {distroType !== 'unknown' ? (
        <>
          <div className="settings-section">
            <h4>当前镜像源</h4>
            <pre className="settings-output">{currentMirror || '加载中...'}</pre>
          </div>
          <div className="settings-section">
            <h4>快速切换</h4>
            <div className="settings-mirror-grid">
              {presets.map((preset) => (
                <button
                  key={preset.url}
                  type="button"
                  className={`settings-mirror-btn ${mirrorDraft === preset.url ? 'selected' : ''}`}
                  onClick={() => { setMirrorDraft(preset.url); setSuccess(''); setError(''); }}
                  disabled={applying}
                >
                  <strong>{preset.label}</strong>
                  <small>{preset.url}</small>
                </button>
              ))}
            </div>
            {mirrorDraft ? (
              <div className="settings-preview-card">
                <div>
                  <strong>待应用镜像源</strong>
                  <span>{mirrorDraft}</span>
                </div>
                <SettingsCommandPreview label="命令预览" content={getMirrorPlan(mirrorDraft).preview} />
                <div className="settings-preview-actions">
                  <button type="button" className="settings-action-btn" onClick={() => setMirrorDraft('')} disabled={applying}>清除草稿</button>
                  <button type="button" className="settings-action-btn primary" onClick={requestApplyMirror} disabled={applying}>
                    {applying ? '应用中...' : '预览并应用'}
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </>
      ) : (
        <div className="settings-section">
          <p className="settings-hint">无法自动识别发行版类型，请手动编辑镜像源配置文件。</p>
        </div>
      )}
      {confirmDialog ? <SettingsConfirmDialog config={confirmDialog} onClose={() => setConfirmDialog(null)} /> : null}
    </div>
  );
}

/* ─── System Update ───────────────────────────────────────────────────────── */

function UpdatePanel({ connectionId }: { connectionId: string }) {
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
      const result = await runCmd(connectionId, 'command -v apt-get >/dev/null 2>&1 && echo "debian" || (command -v yum >/dev/null 2>&1 && echo "redhat" || echo "unknown")');
      setDistroType(result.stdout.trim() as 'debian' | 'redhat' | 'unknown');
    } catch {
      setDistroType('unknown');
    }
  }, [connectionId]);

  useEffect(() => { void detectPkgManager(); }, [detectPkgManager]);

  const checkUpdates = async () => {
    setRunning(true);
    setError('');
    setSuccess('');
    setUpdateOutput('');
    setUpgradable('');
    try {
      if (distroType === 'debian') {
        setUpdateOutput('正在更新软件包索引...\n');
        const updateResult = await runCmd(connectionId, withLinuxPrivilege('apt-get update 2>&1'));
        setUpdateOutput((prev) => prev + updateResult.stdout + (updateResult.stderr ? '\n' + updateResult.stderr : ''));
        const listResult = await runCmd(connectionId, 'apt list --upgradable 2>/dev/null | head -50');
        setUpgradable(listResult.stdout || '所有软件包已是最新版本。');
        setSuccess('软件包索引更新完成。');
      } else if (distroType === 'redhat') {
        setUpdateOutput('正在检查可用更新...\n');
        const checkResult = await runCmd(connectionId, withLinuxPrivilege('yum check-update 2>&1 || true'));
        setUpdateOutput((prev) => prev + checkResult.stdout + (checkResult.stderr ? '\n' + checkResult.stderr : ''));
        setUpgradable(checkResult.stdout || '所有软件包已是最新版本。');
        setSuccess('更新检查完成。');
      } else {
        setError('无法识别的包管理器。');
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
        setUpdateOutput('正在升级所有软件包（apt-get upgrade -y）...\n');
        const result = await runCmd(connectionId, withLinuxPrivilege('DEBIAN_FRONTEND=noninteractive apt-get upgrade -y 2>&1'));
        setUpdateOutput((prev) => prev + result.stdout + (result.stderr ? '\n' + result.stderr : ''));
        setSuccess(result.code === 0 ? '系统升级完成。' : '升级过程中可能存在警告，请查看输出。');
      } else if (distroType === 'redhat') {
        setUpdateOutput('正在升级所有软件包（yum update -y）...\n');
        const result = await runCmd(connectionId, withLinuxPrivilege('yum update -y 2>&1'));
        setUpdateOutput((prev) => prev + result.stdout + (result.stderr ? '\n' + result.stderr : ''));
        setSuccess(result.code === 0 ? '系统升级完成。' : '升级过程中可能存在警告，请查看输出。');
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
      setError('无法识别的包管理器。');
      return;
    }

    setConfirmDialog({
      title: '升级系统软件包',
      message: '将安装所有可用的软件包升级。',
      detail: '系统升级可能重启服务、替换配置文件或短暂影响远程服务；建议先检查可升级列表。',
      preview,
      confirmLabel: '开始升级',
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
          <h3>系统更新</h3>
          <p>检查并安装系统软件包更新</p>
        </div>
        <div className="settings-header-actions">
          <button type="button" className="settings-action-btn" onClick={checkUpdates} disabled={running}>
            {running ? '执行中...' : '检查更新'}
          </button>
          <button type="button" className="settings-action-btn primary" onClick={requestApplyUpdates} disabled={running}>
            {running ? '执行中...' : '一键升级'}
          </button>
        </div>
      </div>
      {error ? <div className="error-banner">{error}</div> : null}
      {success ? <div className="settings-success-banner">{success}</div> : null}
      <div className="settings-warning-banner">
        设置页只执行系统级更新；包安装、卸载和锁定建议交给包管理中心处理。
      </div>
      {upgradable ? (
        <div className="settings-section">
          <h4>可升级软件包</h4>
          <pre className="settings-output">{upgradable}</pre>
        </div>
      ) : null}
      {updateOutput ? (
        <div className="settings-section">
          <h4>执行输出</h4>
          <pre className="settings-output settings-output-scroll" ref={outputRef}>{updateOutput}</pre>
        </div>
      ) : null}
      {!updateOutput && !upgradable ? (
        <div className="settings-section">
          <p className="settings-hint">点击「检查更新」查看可用更新，或点击「一键升级」立即升级所有软件包。</p>
        </div>
      ) : null}
      {confirmDialog ? <SettingsConfirmDialog config={confirmDialog} onClose={() => setConfirmDialog(null)} /> : null}
    </div>
  );
}

/* ─── Hosts ───────────────────────────────────────────────────────────────── */

function HostsPanel({ connectionId }: { connectionId: string }) {
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
      const result = await runCmd(connectionId, 'cat /etc/hosts 2>/dev/null');
      setHostsContent(result.stdout || '# /etc/hosts');
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
      const result = await runCmd(connectionId, withLinuxPrivilege(`printf '%s' ${shellQuote(draft)} > /etc/hosts`));
      if (result.code !== 0) {
        throw new Error(result.stderr || '写入失败，可能需要 root 权限。');
      }
      setSuccess('hosts 文件已保存。');
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
      setSuccess('hosts 草稿没有变更。');
      return;
    }

    setConfirmDialog({
      title: '保存 hosts 文件',
      message: '将重写 /etc/hosts。',
      detail: '错误的 hosts 映射可能影响登录、包管理和服务发现。',
      preview: createLineChangePreview(hostsContent, draft),
      confirmLabel: '保存 hosts',
      tone: 'warning',
      onConfirm: saveHosts,
    });
  };

  const addHostEntry = async () => {
    if (!addIp.trim() || !addHostname.trim()) {
      setError('请输入 IP 地址和主机名。');
      return;
    }
    if (!isSafeNameserver(addIp.trim()) || !isSafeHostname(addHostname.trim())) {
      setError('请输入有效的 IP 地址和主机名。');
      return;
    }
    setError('');
    setSuccess('');
    try {
      const line = `${addIp.trim()} ${addHostname.trim()}`;
      const result = await runCmd(connectionId, withLinuxPrivilege(`printf '%s\n' ${shellQuote(line)} >> /etc/hosts`));
      if (result.code !== 0) {
        throw new Error(result.stderr || '追加失败，可能需要 root 权限。');
      }
      setSuccess(`已添加：${line}`);
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
          <h3>Hosts 管理</h3>
          <p>管理 /etc/hosts 主机名映射</p>
        </div>
        <div className="settings-header-actions">
          {editing ? (
            <>
              <button type="button" className="settings-action-btn" onClick={() => { setEditing(false); setError(''); }} disabled={saving}>取消</button>
              <button type="button" className="settings-action-btn primary" onClick={requestSaveHosts} disabled={saving}>{saving ? '保存中...' : '预览并保存'}</button>
            </>
          ) : (
            <>
              <button type="button" className="settings-action-btn" onClick={refresh} disabled={loading}>{loading ? '加载中...' : '刷新'}</button>
              <button type="button" className="settings-action-btn primary" onClick={() => { setDraft(hostsContent); setEditing(true); setSuccess(''); }}>编辑</button>
            </>
          )}
        </div>
      </div>
      {error ? <div className="error-banner">{error}</div> : null}
      {success ? <div className="settings-success-banner">{success}</div> : null}
      {!editing ? (
        <>
          <div className="settings-section">
            <h4>快速添加</h4>
            <div className="settings-inline-form">
              <input
                type="text"
                className="settings-input"
                placeholder="IP 地址"
                value={addIp}
                onChange={(e) => setAddIp(e.target.value)}
              />
              <input
                type="text"
                className="settings-input"
                placeholder="主机名"
                value={addHostname}
                onChange={(e) => setAddHostname(e.target.value)}
              />
              <button type="button" className="settings-action-btn primary" onClick={addHostEntry}>添加</button>
            </div>
          </div>
          <div className="settings-section">
            <h4>/etc/hosts 内容</h4>
            <pre className="settings-output">{hostsContent || '加载中...'}</pre>
          </div>
        </>
      ) : (
        <div className="settings-section">
          <h4>编辑 /etc/hosts</h4>
          <textarea
            className="settings-textarea"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={16}
            spellCheck={false}
          />
          <SettingsCommandPreview label="变更预览" content={createLineChangePreview(hostsContent, draft)} />
        </div>
      )}
      {confirmDialog ? <SettingsConfirmDialog config={confirmDialog} onClose={() => setConfirmDialog(null)} /> : null}
    </div>
  );
}

/* ─── Route ───────────────────────────────────────────────────────────────── */

function RoutePanel({ connectionId }: { connectionId: string }) {
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
      const result = await runCmd(connectionId, 'ip route show 2>/dev/null || route -n 2>/dev/null || echo "不支持"');
      setRoutes(result.stdout || result.stderr || '无法获取路由表');
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [connectionId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const applyAddRoute = async (command: string, destination: string) => {
    try {
      setError('');
      setSuccess('');
      const result = await runCmd(connectionId, withLinuxPrivilege(command));
      if (result.code !== 0) {
        throw new Error(result.stderr || '添加路由失败，可能需要 root 权限。');
      }
      setSuccess(`已添加路由：${destination}`);
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
      setError('请输入目标网段。');
      return;
    }

    let command = `ip route add ${shellQuote(destination)}`;
    if (addGateway.trim()) command += ` via ${shellQuote(addGateway.trim())}`;
    if (addDev.trim()) command += ` dev ${shellQuote(addDev.trim())}`;

    setConfirmDialog({
      title: '添加系统路由',
      message: `将添加路由 ${destination}。`,
      detail: '路由变更可能改变 SSH 返回路径；请确认目标网段和网关无误。',
      preview: command,
      confirmLabel: '添加路由',
      tone: 'warning',
      onConfirm: () => applyAddRoute(command, destination),
    });
  };

  const applyDeleteRoute = async (command: string, destination: string) => {
    try {
      setError('');
      setSuccess('');
      const result = await runCmd(connectionId, withLinuxPrivilege(command));
      if (result.code !== 0) {
        throw new Error(result.stderr || '删除路由失败，可能需要 root 权限。');
      }
      setSuccess(`已删除路由：${destination}`);
      setDelDest('');
      await refresh();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  };

  const requestDeleteRoute = () => {
    const destination = delDest.trim();
    if (!destination) {
      setError('请输入要删除的目标网段。');
      return;
    }

    const command = `ip route del ${shellQuote(destination)} 2>&1`;
    setConfirmDialog({
      title: '删除系统路由',
      message: `将删除路由 ${destination}。`,
      detail: '删除默认路由或当前连接路径上的路由会让远程会话失联。',
      preview: command,
      confirmLabel: '删除路由',
      tone: 'danger',
      onConfirm: () => applyDeleteRoute(command, destination),
    });
  };

  return (
    <div className="settings-panel-content">
      <div className="settings-panel-header">
        <div>
          <h3>路由管理</h3>
          <p>查看和管理系统路由表</p>
        </div>
        <button type="button" className="settings-action-btn" onClick={refresh} disabled={loading}>
          {loading ? '加载中...' : '刷新'}
        </button>
      </div>
      {error ? <div className="error-banner">{error}</div> : null}
      {success ? <div className="settings-success-banner">{success}</div> : null}
      <div className="settings-section">
        <h4>添加路由</h4>
        <div className="settings-inline-form">
          <input type="text" className="settings-input" placeholder="目标网段 (如 10.0.0.0/8)" value={addDest} onChange={(e) => setAddDest(e.target.value)} />
          <input type="text" className="settings-input" placeholder="网关 (可选)" value={addGateway} onChange={(e) => setAddGateway(e.target.value)} />
          <input type="text" className="settings-input" placeholder="接口 (可选)" value={addDev} onChange={(e) => setAddDev(e.target.value)} />
          <button type="button" className="settings-action-btn primary" onClick={requestAddRoute}>预览添加</button>
        </div>
      </div>
      <div className="settings-section">
        <h4>删除路由</h4>
        <div className="settings-inline-form">
          <input type="text" className="settings-input" placeholder="目标网段 (如 10.0.0.0/8)" value={delDest} onChange={(e) => setDelDest(e.target.value)} />
          <button type="button" className="settings-action-btn danger" onClick={requestDeleteRoute}>预览删除</button>
        </div>
      </div>
      <div className="settings-section">
        <h4>路由表</h4>
        <pre className="settings-output">{routes || '加载中...'}</pre>
      </div>
      {confirmDialog ? <SettingsConfirmDialog config={confirmDialog} onClose={() => setConfirmDialog(null)} /> : null}
    </div>
  );
}

/* ─── Disk ────────────────────────────────────────────────────────────────── */

function DiskPanel({ connectionId }: { connectionId: string }) {
  const [diskInfo, setDiskInfo] = useState('');
  const [mountInfo, setMountInfo] = useState('');
  const [blkInfo, setBlkInfo] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [diskResult, mountResult, blkResult] = await Promise.all([
        runCmd(connectionId, 'df -hT 2>/dev/null || df -h'),
        runCmd(connectionId, 'mount | column -t 2>/dev/null || mount'),
        runCmd(connectionId, 'lsblk -f 2>/dev/null || lsblk 2>/dev/null || echo "不支持"'),
      ]);
      setDiskInfo(diskResult.stdout || diskResult.stderr);
      setMountInfo(mountResult.stdout || mountResult.stderr);
      setBlkInfo(blkResult.stdout || blkResult.stderr);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [connectionId]);

  useEffect(() => { void refresh(); }, [refresh]);

  return (
    <div className="settings-panel-content">
      <div className="settings-panel-header">
        <div>
          <h3>磁盘和挂载点</h3>
          <p>查看磁盘分区、文件系统和挂载信息</p>
        </div>
        <button type="button" className="settings-action-btn" onClick={refresh} disabled={loading}>
          {loading ? '加载中...' : '刷新'}
        </button>
      </div>
      {error ? <div className="error-banner">{error}</div> : null}
      <div className="settings-section">
        <h4>磁盘使用情况</h4>
        <pre className="settings-output">{diskInfo || '加载中...'}</pre>
      </div>
      <div className="settings-section">
        <h4>块设备信息</h4>
        <pre className="settings-output">{blkInfo || '加载中...'}</pre>
      </div>
      <div className="settings-section">
        <h4>挂载点</h4>
        <pre className="settings-output">{mountInfo || '加载中...'}</pre>
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
    return [name, version].filter(Boolean).join(' ') || raw.split('\n')[0] || '未知';
  };

  const renderStructuredSysInfoValue = (item: SysInfoItem) => {
    if (item.key === 'cpu') {
      const summary = parseCpuInfoSummary(item.value);

      if (!summary) {
        return <pre className="sysinfo-card-value">{item.value}</pre>;
      }

      return (
        <div className="sysinfo-feature-block">
          <div className="sysinfo-feature-title">{summary.model || 'CPU 信息'}</div>
          <div className="sysinfo-metric-grid">
            <div className="sysinfo-metric">
              <span>逻辑 CPU</span>
              <strong>{summary.logicalCpus || '--'}</strong>
            </div>
            <div className="sysinfo-metric">
              <span>物理核心</span>
              <strong>{summary.physicalCores || '--'}</strong>
            </div>
            <div className="sysinfo-metric">
              <span>线程 / 核心</span>
              <strong>{summary.threadsPerCore || '--'}</strong>
            </div>
            <div className="sysinfo-metric">
              <span>CPU 插槽</span>
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
            {summary.usagePercent !== null ? `已用 ${summary.usagePercent}%` : '内存用量'}
          </div>
          {summary.usagePercent !== null ? (
            <div className="sysinfo-memory-bar" aria-hidden="true">
              <span className="sysinfo-memory-bar-fill" style={{ width: `${Math.max(6, Math.min(summary.usagePercent, 100))}%` }} />
            </div>
          ) : null}
          <div className="sysinfo-metric-grid">
            <div className="sysinfo-metric">
              <span>可用</span>
              <strong>{summary.available || '--'}</strong>
            </div>
            <div className="sysinfo-metric">
              <span>空闲</span>
              <strong>{summary.free || '--'}</strong>
            </div>
            <div className="sysinfo-metric">
              <span>缓存</span>
              <strong>{summary.cache || '--'}</strong>
            </div>
            <div className="sysinfo-metric">
              <span>共享</span>
              <strong>{summary.shared || '--'}</strong>
            </div>
          </div>
        </div>
      );
    }

    return <pre className="sysinfo-card-value">{item.value}</pre>;
  };

  return (
    <div className="settings-panel-content">
      <div className="settings-panel-header">
        <div>
          <h3>系统信息</h3>
          <p>远程主机硬件和软件概览</p>
        </div>
        <button type="button" className="settings-action-btn" onClick={refresh} disabled={loading}>
          {loading ? '加载中...' : '刷新'}
        </button>
      </div>
      {error ? <div className="error-banner">{error}</div> : null}

      {/* Hero Card */}
      {osItem ? (
        <div className="sysinfo-hero">
          <div className="sysinfo-hero-icon">{'\u{1F4BB}'}</div>
          <div className="sysinfo-hero-text">
            <strong>{hostnameItem?.value || '远程主机'}</strong>
            <span>{parseOsName(osItem.value)}</span>
          </div>
        </div>
      ) : null}

      {/* Info Grid */}
      <div className="sysinfo-grid">
        {items.filter((i) => i.key !== 'hostname' && i.key !== 'os').map((item) => (
          <article key={item.key} className="sysinfo-card">
            <div className="sysinfo-card-head">
              <span className="sysinfo-card-icon">{item.icon}</span>
              <span className="sysinfo-card-label">{item.label}</span>
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

  return (
    <div className="settings-panel-content">
      <div className="settings-panel-header">
        <div>
          <h3>系统信息</h3>
          <p>Windows 主机硬件和软件概览</p>
        </div>
        <button type="button" className="settings-action-btn" onClick={refresh} disabled={loading}>
          {loading ? '加载中...' : '刷新'}
        </button>
      </div>
      {error ? <div className="error-banner">{error}</div> : null}
      {osItem ? (
        <div className="sysinfo-hero">
          <div className="sysinfo-hero-icon">{'\u{1F5A5}\uFE0F'}</div>
          <div className="sysinfo-hero-text">
            <strong>{hostnameItem?.value || 'Windows 主机'}</strong>
            <span>{osItem.value}</span>
          </div>
        </div>
      ) : null}
      <div className="sysinfo-grid">
        {items.filter((i) => i.key !== 'hostname' && i.key !== 'os').map((item) => (
          <article key={item.key} className="sysinfo-card">
            <div className="sysinfo-card-head">
              <span className="sysinfo-card-icon">{item.icon}</span>
              <span className="sysinfo-card-label">{item.label}</span>
            </div>
            <pre className="sysinfo-card-value">{item.value}</pre>
          </article>
        ))}
      </div>
    </div>
  );
}

function WindowsNetworkPanel({ connectionId }: { connectionId: string }) {
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
        runCmd(connectionId, powershellCommand('[System.Net.Dns]::GetHostName()')),
        runCmd(connectionId, powershellCommand('Get-NetIPConfiguration | Format-List | Out-String -Width 220')),
        runCmd(connectionId, powershellCommand('Get-DnsClientServerAddress -AddressFamily IPv4,IPv6 | Format-Table -AutoSize | Out-String -Width 200')),
      ]);
      setHostname(hostResult.stdout || hostResult.stderr);
      setNetworkInfo(ipResult.stdout || ipResult.stderr);
      setDnsInfo(dnsResult.stdout || dnsResult.stderr);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [connectionId]);

  useEffect(() => { void refresh(); }, [refresh]);

  return (
    <div className="settings-panel-content">
      <div className="settings-panel-header">
        <div>
          <h3>网络信息</h3>
          <p>查看 Windows 网络适配器、IP 和 DNS</p>
        </div>
        <button type="button" className="settings-action-btn" onClick={refresh} disabled={loading}>
          {loading ? '加载中...' : '刷新'}
        </button>
      </div>
      {error ? <div className="error-banner">{error}</div> : null}
      <div className="settings-info-card">
        <div className="settings-info-row">
          <span className="settings-info-label">主机名</span>
          <strong className="settings-info-value">{hostname || '...'}</strong>
        </div>
      </div>
      <div className="settings-section">
        <h4>网络适配器</h4>
        <pre className="settings-output">{networkInfo || '加载中...'}</pre>
      </div>
      <div className="settings-section">
        <h4>DNS 配置</h4>
        <pre className="settings-output">{dnsInfo || '加载中...'}</pre>
      </div>
    </div>
  );
}

function WindowsHostsPanel({ connectionId }: { connectionId: string }) {
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
      setSuccess('Hosts 文件已保存。');
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const requestSaveHosts = () => {
    if (draft === content) {
      setSuccess('Hosts 草稿没有变更。');
      return;
    }

    setConfirmDialog({
      title: '保存 Windows hosts',
      message: `将重写 ${windowsHostsPath}。`,
      detail: '需要管理员权限；错误映射可能影响远程服务解析。',
      preview: createLineChangePreview(content, draft),
      confirmLabel: '保存 hosts',
      tone: 'warning',
      onConfirm: saveHosts,
    });
  };

  const addEntry = async () => {
    const ip = newIp.trim();
    const host = newHost.trim();
    if (!ip || !host) {
      setError('请输入 IP 和主机名。');
      return;
    }
    if (!isSafeNameserver(ip) || !isSafeHostname(host)) {
      setError('IP 或主机名格式无效。');
      return;
    }
    const line = `${ip}\t${host}`;
    const nextDraft = `${draft.trimEnd()}\r\n${line}\r\n`;
    setDraft(nextDraft);
    setNewIp('');
    setNewHost('');
    setSuccess(`已添加 ${host}，点击保存后生效。`);
  };

  return (
    <div className="settings-panel-content">
      <div className="settings-panel-header">
        <div>
          <h3>Hosts 管理</h3>
          <p>{windowsHostsPath}</p>
        </div>
        <div className="settings-header-actions">
          <button type="button" className="settings-action-btn" onClick={refresh} disabled={loading}>刷新</button>
          <button type="button" className="settings-action-btn primary" onClick={requestSaveHosts} disabled={saving || draft === content}>
            {saving ? '保存中...' : '预览并保存'}
          </button>
        </div>
      </div>
      {error ? <div className="error-banner">{error}</div> : null}
      {success ? <div className="settings-success-banner">{success}</div> : null}
      <div className="settings-section">
        <h4>新增映射</h4>
        <div className="settings-inline-form">
          <input className="settings-input" placeholder="IP 地址" value={newIp} onChange={(e) => setNewIp(e.target.value)} />
          <input className="settings-input" placeholder="主机名" value={newHost} onChange={(e) => setNewHost(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void addEntry(); }} />
          <button type="button" className="settings-action-btn primary" onClick={addEntry}>添加</button>
        </div>
      </div>
      <div className="settings-section">
        <h4>编辑 hosts</h4>
        <textarea
          className="settings-textarea"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={18}
          spellCheck={false}
        />
        <SettingsCommandPreview label="变更预览" content={createLineChangePreview(content, draft)} />
      </div>
      {confirmDialog ? <SettingsConfirmDialog config={confirmDialog} onClose={() => setConfirmDialog(null)} /> : null}
    </div>
  );
}

function WindowsRoutePanel({ connectionId }: { connectionId: string }) {
  const [routes, setRoutes] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await runCmd(connectionId, powershellCommand('Get-NetRoute | Sort-Object -Property DestinationPrefix, RouteMetric | Format-Table -AutoSize | Out-String -Width 260'));
      setRoutes(result.stdout || result.stderr || '无法获取路由表');
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [connectionId]);

  useEffect(() => { void refresh(); }, [refresh]);

  return (
    <div className="settings-panel-content">
      <div className="settings-panel-header">
        <div>
          <h3>路由表</h3>
          <p>查看 Windows IPv4 / IPv6 路由</p>
        </div>
        <button type="button" className="settings-action-btn" onClick={refresh} disabled={loading}>
          {loading ? '加载中...' : '刷新'}
        </button>
      </div>
      {error ? <div className="error-banner">{error}</div> : null}
      <div className="settings-section">
        <h4>路由表</h4>
        <pre className="settings-output">{routes || '加载中...'}</pre>
      </div>
    </div>
  );
}

function WindowsDiskPanel({ connectionId }: { connectionId: string }) {
  const [diskInfo, setDiskInfo] = useState('');
  const [volumeInfo, setVolumeInfo] = useState('');
  const [driveInfo, setDriveInfo] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [diskResult, volumeResult, driveResult] = await Promise.all([
        runCmd(connectionId, powershellCommand("Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object DeviceID, VolumeName, FileSystem, @{Name='SizeGB'; Expression={[math]::Round($_.Size / 1GB, 2)}}, @{Name='FreeGB'; Expression={[math]::Round($_.FreeSpace / 1GB, 2)}} | Format-Table -AutoSize | Out-String -Width 200")),
        runCmd(connectionId, powershellCommand('Get-Volume | Select-Object DriveLetter, FileSystemLabel, FileSystem, HealthStatus, SizeRemaining, Size | Format-Table -AutoSize | Out-String -Width 220')),
        runCmd(connectionId, powershellCommand('Get-PSDrive -PSProvider FileSystem | Format-Table -AutoSize | Out-String -Width 200')),
      ]);
      setDiskInfo(diskResult.stdout || diskResult.stderr);
      setVolumeInfo(volumeResult.stdout || volumeResult.stderr);
      setDriveInfo(driveResult.stdout || driveResult.stderr);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [connectionId]);

  useEffect(() => { void refresh(); }, [refresh]);

  return (
    <div className="settings-panel-content">
      <div className="settings-panel-header">
        <div>
          <h3>磁盘和卷</h3>
          <p>查看 Windows 本地磁盘、卷和文件系统空间</p>
        </div>
        <button type="button" className="settings-action-btn" onClick={refresh} disabled={loading}>
          {loading ? '加载中...' : '刷新'}
        </button>
      </div>
      {error ? <div className="error-banner">{error}</div> : null}
      <div className="settings-section">
        <h4>本地磁盘</h4>
        <pre className="settings-output">{diskInfo || '加载中...'}</pre>
      </div>
      <div className="settings-section">
        <h4>卷信息</h4>
        <pre className="settings-output">{volumeInfo || '加载中...'}</pre>
      </div>
      <div className="settings-section">
        <h4>PSDrive</h4>
        <pre className="settings-output">{driveInfo || '加载中...'}</pre>
      </div>
    </div>
  );
}

function createInitialHostStatus(systemType?: RemoteSystemType): SettingsHostStatus {
  return {
    systemLabel: getSystemTypeLabel(systemType),
    userLabel: '检测中',
    privilegeLabel: '检测中',
    privilegeTone: 'unknown',
    hint: '正在读取远程权限状态',
  };
}

function mapPrivilegeStatus(systemType: RemoteSystemType | undefined, values: Map<string, string>): SettingsHostStatus {
  const privilege = values.get('PRIV') ?? 'unknown';
  const user = values.get('USER') || '未知用户';
  const isWindowsHost = isWindowsSystem(systemType);

  if (privilege === 'root') {
    return {
      systemLabel: getSystemTypeLabel(systemType),
      userLabel: user,
      privilegeLabel: 'root',
      privilegeTone: 'ready',
      hint: '具备系统级写入权限',
    };
  }

  if (privilege === 'sudo') {
    return {
      systemLabel: getSystemTypeLabel(systemType),
      userLabel: user,
      privilegeLabel: 'sudo 可用',
      privilegeTone: 'ready',
      hint: '可执行需要提权的配置命令',
    };
  }

  if (privilege === 'admin') {
    return {
      systemLabel: getSystemTypeLabel(systemType),
      userLabel: user,
      privilegeLabel: '管理员',
      privilegeTone: 'ready',
      hint: '具备 Windows 管理员权限',
    };
  }

  return {
    systemLabel: getSystemTypeLabel(systemType),
    userLabel: user,
    privilegeLabel: isWindowsHost ? '普通用户' : '未检测到 root/sudo',
    privilegeTone: 'warning',
    hint: isWindowsHost ? '部分系统配置可能需要管理员权限' : '写入网络、镜像源、hosts 等配置可能失败',
  };
}

function SettingsStatusStrip({
  status,
  loading,
  onRefresh,
}: {
  status: SettingsHostStatus;
  loading: boolean;
  onRefresh: () => void;
}) {
  return (
    <div className="settings-status-strip">
      <div className="settings-status-item">
        <span>系统</span>
        <strong>{status.systemLabel}</strong>
      </div>
      <div className="settings-status-item">
        <span>用户</span>
        <strong>{status.userLabel}</strong>
      </div>
      <div className={`settings-status-pill ${status.privilegeTone}`}>
        {status.privilegeLabel}
      </div>
      <div className="settings-status-hint">{status.hint}</div>
      <button type="button" className="settings-action-btn" onClick={onRefresh} disabled={loading}>
        {loading ? '检测中...' : '检测权限'}
      </button>
    </div>
  );
}

/* ─── Main Component ──────────────────────────────────────────────────────── */

function RemoteSettings({ connectionId, systemType }: RemoteSettingsProps) {
  const isWindowsHost = isWindowsSystem(systemType);
  const settingsGroups = isWindowsHost ? WINDOWS_SETTINGS_GROUPS : SETTINGS_GROUPS;
  const [activeTab, setActiveTab] = useState<SettingsTab>('systeminfo');
  const [hostStatus, setHostStatus] = useState<SettingsHostStatus>(() => createInitialHostStatus(systemType));
  const [hostStatusLoading, setHostStatusLoading] = useState(false);

  const refreshHostStatus = useCallback(async () => {
    setHostStatusLoading(true);
    setHostStatus((currentStatus) => ({
      ...currentStatus,
      systemLabel: getSystemTypeLabel(systemType),
      hint: '正在读取远程权限状态',
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
      const result = await runCmd(connectionId, command);
      setHostStatus(mapPrivilegeStatus(systemType, parseKeyValueOutput(result.stdout || result.stderr || '')));
    } catch (err) {
      setHostStatus({
        systemLabel: getSystemTypeLabel(systemType),
        userLabel: '未知',
        privilegeLabel: '检测失败',
        privilegeTone: 'danger',
        hint: getErrorMessage(err),
      });
    } finally {
      setHostStatusLoading(false);
    }
  }, [connectionId, isWindowsHost, systemType]);

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
        case 'network': return <WindowsNetworkPanel connectionId={connectionId} />;
        case 'hosts': return <WindowsHostsPanel connectionId={connectionId} />;
        case 'route': return <WindowsRoutePanel connectionId={connectionId} />;
        case 'disk': return <WindowsDiskPanel connectionId={connectionId} />;
        default: return <WindowsSystemInfoPanel connectionId={connectionId} />;
      }
    }

    switch (activeTab) {
      case 'systeminfo': return <SystemInfoPanel connectionId={connectionId} />;
      case 'network': return <NetworkPanel connectionId={connectionId} />;
      case 'mirrors': return <MirrorsPanel connectionId={connectionId} />;
      case 'update': return <UpdatePanel connectionId={connectionId} />;
      case 'hosts': return <HostsPanel connectionId={connectionId} />;
      case 'route': return <RoutePanel connectionId={connectionId} />;
      case 'disk': return <DiskPanel connectionId={connectionId} />;
      default: return null;
    }
  };

  return (
    <div className="settings-pane">
      <nav className="settings-sidebar" aria-label="设置导航">
        {settingsGroups.map((group) => (
          <div key={group.label}>
            <div className="settings-sidebar-group-label">{group.label}</div>
            {group.tabs.map((tab) => (
              <button
                key={tab.key}
                type="button"
                className={`settings-nav-item ${activeTab === tab.key ? 'active' : ''}`}
                onClick={() => setActiveTab(tab.key)}
              >
                <span className="settings-nav-icon">{tab.icon}</span>
                <div className="settings-nav-text">
                  <strong>{tab.label}</strong>
                  <small>{tab.description}</small>
                </div>
              </button>
            ))}
          </div>
        ))}
      </nav>
      <div className="settings-main">
        <SettingsStatusStrip status={hostStatus} loading={hostStatusLoading} onRefresh={() => void refreshHostStatus()} />
        <div className="settings-panel-shell">
          {renderPanel()}
        </div>
      </div>
    </div>
  );
}

export default RemoteSettings;

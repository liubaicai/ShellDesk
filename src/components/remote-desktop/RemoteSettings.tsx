import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { getErrorMessage } from './desktopUtils';

interface RemoteSettingsProps {
  connectionId: string;
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

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function isSafeHostname(value: string) {
  return /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(value);
}

function isSafeNameserver(value: string) {
  return /^[0-9A-Fa-f:.]{2,45}$/.test(value);
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

function NetworkPanel({ connectionId }: { connectionId: string }) {
  const [ifaces, setIfaces] = useState<NetIface[]>([]);
  const [dnsServers, setDnsServers] = useState<string[]>([]);
  const [dnsSearch, setDnsSearch] = useState('');
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

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [ifResult, dnsResult, hostResult] = await Promise.all([
        runCmd(connectionId, 'ip addr show 2>/dev/null || ifconfig -a 2>/dev/null'),
        runCmd(connectionId, 'cat /etc/resolv.conf 2>/dev/null'),
        runCmd(connectionId, 'hostname -f 2>/dev/null || hostname'),
      ]);

      setIfaces(parseIpAddr(ifResult.stdout || ''));

      const resolvLines = (dnsResult.stdout || '').split('\n');
      const servers = resolvLines
        .filter((l) => /^\s*nameserver\s/.test(l))
        .map((l) => l.replace(/^\s*nameserver\s+/, '').trim())
        .filter(Boolean);
      const search = resolvLines
        .find((l) => /^\s*search\s/.test(l))
        ?.replace(/^\s*search\s+/, '')
        .trim() ?? '';
      setDnsServers(servers);
      setDnsSearch(search);
      setHostname((hostResult.stdout || '').trim());
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [connectionId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const toggleIface = async (ifaceName: string, bringUp: boolean) => {
    setActionLoading(ifaceName);
    setError('');
    setSuccess('');
    try {
      const result = await runCmd(connectionId, `ip link set ${shellQuote(ifaceName)} ${bringUp ? 'up' : 'down'} 2>&1`);
      if (result.code !== 0) throw new Error(result.stderr || '操作失败，可能需要 root 权限。');
      setSuccess(`接口 ${ifaceName} 已${bringUp ? '启用' : '禁用'}。`);
      await refresh();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setActionLoading(null);
    }
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

  const applyIfaceConfig = async () => {
    if (!editingIface) return;
    setActionLoading(editingIface);
    setError('');
    setSuccess('');
    try {
      let cmd: string;
      const ifaceArg = shellQuote(editingIface);
      if (editForm.method === 'dhcp') {
        cmd = `dhclient -r ${ifaceArg} 2>/dev/null; dhclient ${ifaceArg} 2>&1 || echo "dhclient 不可用，请确认已安装"`;
      } else {
        if (!editForm.address) { setError('请输入 IP 地址。'); setActionLoading(null); return; }
        const prefix = editForm.netmask
          ? editForm.netmask.split('.').map((o) => Number.parseInt(o, 10)).reduce((p, oct) => p + (oct >>> 0).toString(2).replace(/0/g, '').length, 0)
          : 24;
        cmd = `ip addr flush dev ${ifaceArg} 2>/dev/null; ip addr add ${shellQuote(`${editForm.address}/${prefix}`)} dev ${ifaceArg} 2>&1`;
        if (editForm.gateway) {
          cmd += ` && ip route replace default via ${shellQuote(editForm.gateway)} dev ${ifaceArg} 2>&1`;
        }
      }
      const result = await runCmd(connectionId, cmd);
      if (result.code !== 0 && !result.stdout.includes('dhclient')) {
        throw new Error(result.stderr || result.stdout || '配置失败，可能需要 root 权限。');
      }
      setSuccess(`接口 ${editingIface} 配置已应用。`);
      setEditingIface(null);
      await refresh();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setActionLoading(null);
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
      const result = await runCmd(connectionId, `hostnamectl set-hostname ${quotedName} 2>&1 || hostname ${quotedName} 2>&1`);
      if (result.code !== 0) throw new Error(result.stderr || '设置主机名失败。');
      setSuccess(`主机名已设置为 ${name}。`);
      setHostname(name);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setActionLoading(null);
    }
  };

  const addDnsServer = async () => {
    const server = newDns.trim();
    if (!server) return;
    if (!isSafeNameserver(server)) {
      setError('DNS 服务器必须是 IPv4 或 IPv6 地址。');
      return;
    }
    setError('');
    setSuccess('');
    try {
      const line = `nameserver ${server}`;
      const result = await runCmd(connectionId, `grep -Fxq ${shellQuote(line)} /etc/resolv.conf 2>/dev/null && echo EXISTS || printf '%s\n' ${shellQuote(line)} >> /etc/resolv.conf`);
      if (result.stdout.trim() === 'EXISTS') {
        setSuccess(`${server} 已存在。`);
      } else {
        setSuccess(`已添加 DNS 服务器 ${server}。`);
      }
      setNewDns('');
      await refresh();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  };

  const removeDnsServer = async (server: string) => {
    setError('');
    setSuccess('');
    try {
      const line = `nameserver ${server}`;
      await runCmd(connectionId, `tmp=$(mktemp) && grep -Fxv ${shellQuote(line)} /etc/resolv.conf > "$tmp"; rc=$?; if [ "$rc" -le 1 ]; then cat "$tmp" > /etc/resolv.conf; rc=0; fi; rm -f "$tmp"; exit "$rc"`);
      setSuccess(`已移除 DNS 服务器 ${server}。`);
      await refresh();
    } catch (err) {
      setError(getErrorMessage(err));
    }
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
                      <button type="button" className="settings-action-btn danger" onClick={() => void toggleIface(iface.name, false)} disabled={isBusy}>
                        {isBusy ? '...' : '禁用'}
                      </button>
                    ) : (
                      <button type="button" className="settings-action-btn primary" onClick={() => void toggleIface(iface.name, true)} disabled={isBusy}>
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
                      <button type="button" className="settings-action-btn primary" onClick={() => void applyIfaceConfig()} disabled={isBusy}>
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
          {dnsServers.map((server) => (
            <div key={server} className="dns-server-item">
              <span className="dns-server-addr">{server}</span>
              <button type="button" className="settings-action-btn danger" onClick={() => void removeDnsServer(server)}>移除</button>
            </div>
          ))}
          {dnsServers.length === 0 ? <p className="settings-hint">无已配置的 DNS 服务器。</p> : null}
        </div>
        <div className="settings-inline-form">
          <input type="text" className="settings-input" placeholder="添加 DNS 服务器 (如 8.8.8.8)" value={newDns} onChange={(e) => setNewDns(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void addDnsServer(); }} />
          <button type="button" className="settings-action-btn primary" onClick={addDnsServer}>添加</button>
        </div>
        {dnsSearch ? (
          <div className="net-iface-meta"><em>搜索域</em>{dnsSearch}</div>
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
            <div className="notepad-modal-actions">
              <button type="button" className="notepad-modal-btn" onClick={() => setIsHostnameDialogOpen(false)}>取消</button>
              <button type="button" className="notepad-modal-btn primary" onClick={() => void setHostnameCmd()}>保存</button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}

/* ─── Mirrors ─────────────────────────────────────────────────────────────── */

const MIRROR_PRESETS = {
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

function MirrorsPanel({ connectionId }: { connectionId: string }) {
  const [distroType, setDistroType] = useState<'debian' | 'redhat' | 'unknown'>('unknown');
  const [distroName, setDistroName] = useState('');
  const [currentMirror, setCurrentMirror] = useState('');
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const detectDistro = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const detectResult = await runCmd(connectionId, `
        if [ -f /etc/os-release ]; then
          . /etc/os-release
          echo "ID=$ID"
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
      setDistroName(output);

      if (/ID=ubuntu|ID=debian|ID=kali|ID=linuxmint|ID=pop/i.test(output)) {
        setDistroType('debian');
        const mirrorResult = await runCmd(connectionId, 'cat /etc/apt/sources.list 2>/dev/null | head -20');
        setCurrentMirror(mirrorResult.stdout || '无法读取');
      } else if (/ID=centos|ID=rhel|ID=fedora|ID=rocky|ID=alma|ID=ol|ID=amzn/i.test(output)) {
        setDistroType('redhat');
        const mirrorResult = await runCmd(connectionId, 'cat /etc/yum.repos.d/*.repo 2>/dev/null | grep -E "^baseurl|^mirrorlist" | head -20');
        setCurrentMirror(mirrorResult.stdout || '无法读取');
      } else {
        setDistroType('unknown');
        setCurrentMirror('');
      }
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [connectionId]);

  useEffect(() => { void detectDistro(); }, [detectDistro]);

  const applyMirror = async (mirrorUrl: string) => {
    setApplying(true);
    setError('');
    setSuccess('');
    try {
      if (distroType === 'debian') {
        const versionMatch = distroName.match(/VERSION_CODENAME=(\S+)/);
        const codename = versionMatch?.[1] || 'bookworm';
        const backupCmd = `cp /etc/apt/sources.list /etc/apt/sources.list.bak.$(date +%s) 2>/dev/null`;
        const writeCmd = `cat > /etc/apt/sources.list << 'MIRROR_EOF'
deb http://${mirrorUrl}/debian/ ${codename} main contrib non-free non-free-firmware
deb http://${mirrorUrl}/debian/ ${codename}-updates main contrib non-free non-free-firmware
deb http://${mirrorUrl}/debian/ ${codename}-backports main contrib non-free non-free-firmware
deb http://${mirrorUrl}/debian-security ${codename}-security main contrib non-free non-free-firmware
MIRROR_EOF`;
        await runCmd(connectionId, backupCmd);
        await runCmd(connectionId, writeCmd);
        setSuccess(`已切换到 ${mirrorUrl}，请前往「系统更新」刷新软件包索引。`);
      } else if (distroType === 'redhat') {
        const backupCmd = `cp -r /etc/yum.repos.d /etc/yum.repos.d.bak.$(date +%s) 2>/dev/null`;
        const sedCmd = `sed -i 's|^mirrorlist=|#mirrorlist=|g; s|^#\\(baseurl=.*\\)baseurl|\\1baseurl|g; s|baseurl=.*://[^/]*|baseurl=http://${mirrorUrl}|g' /etc/yum.repos.d/*.repo 2>/dev/null`;
        await runCmd(connectionId, backupCmd);
        await runCmd(connectionId, sedCmd);
        setSuccess(`已切换到 ${mirrorUrl}。`);
      } else {
        setError('无法识别的发行版类型，请手动修改镜像源配置。');
      }
      await detectDistro();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setApplying(false);
    }
  };

  const presets = distroType === 'debian' ? MIRROR_PRESETS.debian : distroType === 'redhat' ? MIRROR_PRESETS.redhat : [];

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
                  className="settings-mirror-btn"
                  onClick={() => void applyMirror(preset.url)}
                  disabled={applying}
                >
                  <strong>{preset.label}</strong>
                  <small>{preset.url}</small>
                </button>
              ))}
            </div>
          </div>
        </>
      ) : (
        <div className="settings-section">
          <p className="settings-hint">无法自动识别发行版类型，请手动编辑镜像源配置文件。</p>
        </div>
      )}
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
        const updateResult = await runCmd(connectionId, 'apt-get update 2>&1');
        setUpdateOutput((prev) => prev + updateResult.stdout + (updateResult.stderr ? '\n' + updateResult.stderr : ''));
        const listResult = await runCmd(connectionId, 'apt list --upgradable 2>/dev/null | head -50');
        setUpgradable(listResult.stdout || '所有软件包已是最新版本。');
        setSuccess('软件包索引更新完成。');
      } else if (distroType === 'redhat') {
        setUpdateOutput('正在检查可用更新...\n');
        const checkResult = await runCmd(connectionId, 'yum check-update 2>&1 || true');
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
        const result = await runCmd(connectionId, 'DEBIAN_FRONTEND=noninteractive apt-get upgrade -y 2>&1');
        setUpdateOutput((prev) => prev + result.stdout + (result.stderr ? '\n' + result.stderr : ''));
        setSuccess(result.code === 0 ? '系统升级完成。' : '升级过程中可能存在警告，请查看输出。');
      } else if (distroType === 'redhat') {
        setUpdateOutput('正在升级所有软件包（yum update -y）...\n');
        const result = await runCmd(connectionId, 'yum update -y 2>&1');
        setUpdateOutput((prev) => prev + result.stdout + (result.stderr ? '\n' + result.stderr : ''));
        setSuccess(result.code === 0 ? '系统升级完成。' : '升级过程中可能存在警告，请查看输出。');
      }
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setRunning(false);
    }
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
          <button type="button" className="settings-action-btn primary" onClick={applyUpdates} disabled={running}>
            {running ? '执行中...' : '一键升级'}
          </button>
        </div>
      </div>
      {error ? <div className="error-banner">{error}</div> : null}
      {success ? <div className="settings-success-banner">{success}</div> : null}
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
      const result = await runCmd(connectionId, `printf '%s' ${shellQuote(draft)} > /etc/hosts`);
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
      const result = await runCmd(connectionId, `printf '%s\n' ${shellQuote(line)} >> /etc/hosts`);
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
              <button type="button" className="settings-action-btn primary" onClick={saveHosts} disabled={saving}>{saving ? '保存中...' : '保存'}</button>
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
        </div>
      )}
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

  const addRoute = async () => {
    if (!addDest.trim()) {
      setError('请输入目标网段。');
      return;
    }
    setError('');
    setSuccess('');
    try {
      let cmd = `ip route add ${shellQuote(addDest.trim())}`;
      if (addGateway.trim()) cmd += ` via ${shellQuote(addGateway.trim())}`;
      if (addDev.trim()) cmd += ` dev ${shellQuote(addDev.trim())}`;
      const result = await runCmd(connectionId, cmd);
      if (result.code !== 0) {
        throw new Error(result.stderr || '添加路由失败，可能需要 root 权限。');
      }
      setSuccess(`已添加路由：${addDest.trim()}`);
      setAddDest('');
      setAddGateway('');
      setAddDev('');
      await refresh();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  };

  const deleteRoute = async () => {
    if (!delDest.trim()) {
      setError('请输入要删除的目标网段。');
      return;
    }
    setError('');
    setSuccess('');
    try {
      const result = await runCmd(connectionId, `ip route del ${shellQuote(delDest.trim())} 2>&1`);
      if (result.code !== 0) {
        throw new Error(result.stderr || '删除路由失败，可能需要 root 权限。');
      }
      setSuccess(`已删除路由：${delDest.trim()}`);
      setDelDest('');
      await refresh();
    } catch (err) {
      setError(getErrorMessage(err));
    }
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
          <button type="button" className="settings-action-btn primary" onClick={addRoute}>添加</button>
        </div>
      </div>
      <div className="settings-section">
        <h4>删除路由</h4>
        <div className="settings-inline-form">
          <input type="text" className="settings-input" placeholder="目标网段 (如 10.0.0.0/8)" value={delDest} onChange={(e) => setDelDest(e.target.value)} />
          <button type="button" className="settings-action-btn danger" onClick={deleteRoute}>删除</button>
        </div>
      </div>
      <div className="settings-section">
        <h4>路由表</h4>
        <pre className="settings-output">{routes || '加载中...'}</pre>
      </div>
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

function SystemInfoPanel({ connectionId }: { connectionId: string }) {
  const [items, setItems] = useState<SysInfoItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const cmds = [
        { key: 'os', label: '操作系统', icon: '\u{1F5A5}\uFE0F', cmd: 'cat /etc/os-release 2>/dev/null | grep -E "^PRETTY_NAME|^NAME|^VERSION" | head -5 || uname -s' },
        { key: 'kernel', label: '内核版本', icon: '\u2699\uFE0F', cmd: 'uname -r' },
        { key: 'hostname', label: '主机名', icon: '\u{1F3E0}', cmd: 'hostname -f 2>/dev/null || hostname' },
        { key: 'arch', label: '系统架构', icon: '\u{1F9E9}', cmd: 'uname -m' },
        { key: 'cpu', label: 'CPU', icon: '\u{1F4BB}', cmd: 'lscpu 2>/dev/null | grep -E "^Model name|^Socket|^Core|^Thread|^CPU\\(s\\):" | head -6 || cat /proc/cpuinfo 2>/dev/null | grep "model name" | head -1' },
        { key: 'memory', label: '内存', icon: '\u{1F9E0}', cmd: 'free -h 2>/dev/null | grep "^Mem:" || vm_stat 2>/dev/null | head -5' },
        { key: 'uptime', label: '运行时间', icon: '\u23F1\uFE0F', cmd: 'uptime -p 2>/dev/null || uptime' },
        { key: 'load', label: '系统负载', icon: '\u26A1', cmd: 'cat /proc/loadavg 2>/dev/null || uptime | sed "s/.*load average: //"' },
        { key: 'shell', label: '默认 Shell', icon: '\u{1F41A}', cmd: 'echo $SHELL' },
        { key: 'user', label: '当前用户', icon: '\u{1F464}', cmd: 'whoami 2>/dev/null || id -un' },
        { key: 'locale', label: '系统语言', icon: '\u{1F30D}', cmd: 'locale 2>/dev/null | grep LANG= | head -1 || echo $LANG' },
        { key: 'timezone', label: '时区', icon: '\u{1F30D}', cmd: 'timedatectl 2>/dev/null | grep "Time zone" || cat /etc/timezone 2>/dev/null || date +"%Z"' },
        { key: 'gpu', label: 'GPU', icon: '\u{1F3AE}', cmd: 'lspci 2>/dev/null | grep -i "vga\|3d\|display" | head -3 || echo "未检测到"' },
        { key: 'virt', label: '虚拟化', icon: '\u{1F4EB}', cmd: 'systemd-detect-virt 2>/dev/null || cat /proc/cpuinfo 2>/dev/null | grep -c "hypervisor" | awk \'{if($1>0) print "虚拟化环境"; else print "物理机或未识别"}\' || echo "未识别"' },
        { key: 'boot', label: '启动模式', icon: '\u{1F504}', cmd: '[ -d /sys/firmware/efi ] && echo "UEFI" || echo "BIOS (Legacy)"' },
      ];

      const results: SysInfoItem[] = [];

      // 串行执行，避免一次性打开过多 SSH channel 导致后面的检测项随机失败。
      for (const { key, label, icon, cmd } of cmds) {
        try {
          const r = await runCmd(connectionId, cmd);
          results.push({ key, label, icon, value: (r.stdout || r.stderr || '无输出').trim() });
        } catch {
          results.push({ key, label, icon, value: '获取失败' });
        }
      }

      setItems(results);
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
            <pre className="sysinfo-card-value">{item.value}</pre>
          </article>
        ))}
      </div>
    </div>
  );
}

/* ─── Main Component ──────────────────────────────────────────────────────── */

function RemoteSettings({ connectionId }: RemoteSettingsProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>('systeminfo');

  const renderPanel = () => {
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
        {SETTINGS_GROUPS.map((group) => (
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
        {renderPanel()}
      </div>
    </div>
  );
}

export default RemoteSettings;

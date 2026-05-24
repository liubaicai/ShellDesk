import { useCallback, useEffect, useMemo, useState } from 'react';

import { getErrorMessage } from './desktopUtils';
import { isWindowsSystem, powershellCommand, powershellStdinCommand, type RemoteCommandInput } from './remoteSystem';
import type { RemoteProcessManagerLaunchOptions } from './RemoteProcessManager';
import type { RemoteSystemType } from './types';

interface RemotePortManagerProps {
  connectionId: string;
  systemType?: RemoteSystemType;
  onOpenProcessManager?: (launchOptions?: RemoteProcessManagerLaunchOptions) => void;
}

type PortProtocol = 'tcp' | 'udp' | 'tcp6' | 'udp6' | 'unknown';
type ProtocolFilter = 'all' | 'tcp' | 'udp';
type StateFilter = 'all' | 'listen' | 'established' | 'udp' | 'other';

interface PortListenerEntry {
  id: string;
  protocol: PortProtocol;
  state: string;
  localAddress: string;
  localPort: number | null;
  remoteAddress: string;
  remotePort: number | null;
  pid?: number;
  processName?: string;
  command?: string;
  source: 'ss' | 'netstat' | 'powershell' | 'unknown';
}

interface EndpointParts {
  address: string;
  port: number | null;
}

const portToolMarker = '__SHELLDESK_PORT_TOOL__';

function runCmd(connectionId: string, command: string | RemoteCommandInput) {
  const api = window.guiSSH?.connections;

  if (!api) {
    throw new Error('ShellDesk IPC 未就绪。');
  }

  if (typeof command === 'string') {
    return api.runCommand(connectionId, command);
  }

  return api.runCommand(connectionId, command.command, command.stdin);
}

function shellSingleQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function parseMaybeNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  if (typeof value !== 'string' || !value.trim()) {
    return undefined;
  }

  const parsedValue = Number.parseInt(value, 10);
  return Number.isFinite(parsedValue) ? parsedValue : undefined;
}

function normalizeProtocol(value: string): PortProtocol {
  const normalizedValue = value.trim().toLowerCase();

  if (normalizedValue === 'tcp' || normalizedValue === 'udp' || normalizedValue === 'tcp6' || normalizedValue === 'udp6') {
    return normalizedValue;
  }

  return 'unknown';
}

function parseEndpoint(rawEndpoint: string): EndpointParts {
  let endpoint = rawEndpoint.trim();

  if (!endpoint || endpoint === '*' || endpoint === '*:*') {
    return { address: '*', port: null };
  }

  endpoint = endpoint.replace(/^\[|\]$/g, '');

  const bracketMatch = rawEndpoint.match(/^\[(.*)]:(\*|\d+)$/);
  if (bracketMatch) {
    return {
      address: bracketMatch[1] || '*',
      port: bracketMatch[2] === '*' ? null : Number.parseInt(bracketMatch[2], 10),
    };
  }

  const lastColonIndex = endpoint.lastIndexOf(':');
  if (lastColonIndex < 0) {
    return { address: endpoint, port: null };
  }

  const portText = endpoint.slice(lastColonIndex + 1);
  const address = endpoint.slice(0, lastColonIndex).replace(/^\[|\]$/g, '') || '*';

  return {
    address,
    port: /^\d+$/.test(portText) ? Number.parseInt(portText, 10) : null,
  };
}

function parseProcessText(text: string): { pid?: number; processName?: string; command?: string } {
  const pidMatch = text.match(/pid=(\d+)/);
  const quotedNameMatch = text.match(/"([^"]+)"/);
  const slashProcessMatch = text.match(/\s(\d+)\/([^\s]+)$/);

  if (pidMatch) {
    return {
      pid: Number.parseInt(pidMatch[1], 10),
      processName: quotedNameMatch?.[1],
      command: text,
    };
  }

  if (slashProcessMatch) {
    return {
      pid: Number.parseInt(slashProcessMatch[1], 10),
      processName: slashProcessMatch[2],
      command: text,
    };
  }

  return { command: text.trim() || undefined };
}

function createEntryId(entry: Omit<PortListenerEntry, 'id'>, index: number) {
  return [
    entry.protocol,
    entry.state,
    entry.localAddress,
    entry.localPort ?? '*',
    entry.remoteAddress,
    entry.remotePort ?? '*',
    entry.pid ?? 'nopid',
    index,
  ].join(':');
}

function parseSsLine(line: string, index: number): PortListenerEntry | null {
  const parts = line.trim().split(/\s+/);

  if (parts.length < 5) {
    return null;
  }

  const protocol = normalizeProtocol(parts[0]);
  const state = parts[1] || (protocol.startsWith('udp') ? 'UNCONN' : 'UNKNOWN');
  const local = parseEndpoint(parts[4] ?? '');
  const remote = parseEndpoint(parts[5] ?? '');
  const process = parseProcessText(parts.slice(6).join(' '));
  const entry: Omit<PortListenerEntry, 'id'> = {
    protocol,
    state,
    localAddress: local.address,
    localPort: local.port,
    remoteAddress: remote.address,
    remotePort: remote.port,
    pid: process.pid,
    processName: process.processName,
    command: process.command,
    source: 'ss',
  };

  return { ...entry, id: createEntryId(entry, index) };
}

function parseNetstatLine(line: string, index: number): PortListenerEntry | null {
  const parts = line.trim().split(/\s+/);
  const protocol = normalizeProtocol(parts[0] ?? '');

  if (protocol === 'unknown' || parts.length < 4) {
    return null;
  }

  const local = parseEndpoint(parts[3] ?? '');
  const remote = parseEndpoint(parts[4] ?? '');
  const stateIndex = protocol.startsWith('udp') ? 5 : 5;
  const pidIndex = protocol.startsWith('udp') ? 5 : 6;
  const state = protocol.startsWith('udp') ? 'UNCONN' : (parts[stateIndex] || 'UNKNOWN');
  const processText = protocol.startsWith('udp') ? parts.slice(pidIndex).join(' ') : parts.slice(pidIndex).join(' ');
  const process = parseProcessText(processText);
  const entry: Omit<PortListenerEntry, 'id'> = {
    protocol,
    state,
    localAddress: local.address,
    localPort: local.port,
    remoteAddress: remote.address,
    remotePort: remote.port,
    pid: process.pid,
    processName: process.processName,
    command: process.command,
    source: 'netstat',
  };

  return { ...entry, id: createEntryId(entry, index) };
}

function parseUnixPorts(stdout: string): PortListenerEntry[] {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const markerLine = lines.find((line) => line.startsWith(portToolMarker));
  const source = markerLine?.includes('netstat') ? 'netstat' : markerLine?.includes('ss') ? 'ss' : 'unknown';

  return lines
    .filter((line) => !line.startsWith(portToolMarker))
    .filter((line) => !/^(Active|Proto|Netid)\b/i.test(line))
    .map((line, index) => (source === 'netstat' ? parseNetstatLine(line, index) : parseSsLine(line, index)))
    .filter((entry): entry is PortListenerEntry => Boolean(entry));
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return undefined;
}

function readText(record: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = record[key];

    if (typeof value === 'string') {
      return value.trim();
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
  }

  return '';
}

function parseWindowsPorts(stdout: string): PortListenerEntry[] {
  const trimmedText = stdout.trim();

  if (!trimmedText) {
    return [];
  }

  try {
    const parsedJson = JSON.parse(trimmedText) as unknown;
    const rows = Array.isArray(parsedJson) ? parsedJson : [parsedJson];

    return rows
      .map(toRecord)
      .filter((record): record is Record<string, unknown> => Boolean(record))
      .map((record, index) => {
        const protocol = normalizeProtocol(readText(record, 'Protocol'));
        const localPort = parseMaybeNumber(record.LocalPort) ?? null;
        const remotePort = parseMaybeNumber(record.RemotePort) ?? null;
        const pid = parseMaybeNumber(record.Pid);
        const entry: Omit<PortListenerEntry, 'id'> = {
          protocol,
          state: readText(record, 'State') || (protocol === 'udp' ? 'UNCONN' : 'UNKNOWN'),
          localAddress: readText(record, 'LocalAddress') || '*',
          localPort,
          remoteAddress: readText(record, 'RemoteAddress') || '*',
          remotePort,
          pid,
          processName: readText(record, 'ProcessName') || undefined,
          command: readText(record, 'CommandLine') || undefined,
          source: 'powershell',
        };

        return { ...entry, id: createEntryId(entry, index) };
      });
  } catch {
    return trimmedText
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .map((line, index) => {
        const parts = line.split('\t');

        if (parts[0] !== 'PORT') {
          return null;
        }

        const protocol = normalizeProtocol(parts[1] ?? '');
        const localPort = parseMaybeNumber(parts[4]) ?? null;
        const remotePort = parseMaybeNumber(parts[6]) ?? null;
        const pid = parseMaybeNumber(parts[7]);
        const entry: Omit<PortListenerEntry, 'id'> = {
          protocol,
          state: parts[2] || (protocol === 'udp' ? 'UNCONN' : 'UNKNOWN'),
          localAddress: parts[3] || '*',
          localPort,
          remoteAddress: parts[5] || '*',
          remotePort,
          pid,
          processName: parts[8] || undefined,
          command: parts[9] || undefined,
          source: 'powershell',
        };

        return { ...entry, id: createEntryId(entry, index) };
      })
      .filter((entry): entry is PortListenerEntry => Boolean(entry));
  }
}

function createUnixPortCommand() {
  return [
    `if command -v ss >/dev/null 2>&1; then echo ${portToolMarker}\\tss; ss -H -tunap 2>/dev/null || ss -H -tunp 2>/dev/null;`,
    `elif command -v netstat >/dev/null 2>&1; then echo ${portToolMarker}\\tnetstat; netstat -tunap 2>/dev/null || netstat -tunp 2>/dev/null;`,
    `else echo ${portToolMarker}\\tnone; echo '缺少 ss 或 netstat，无法读取端口列表。' >&2; exit 127; fi`,
  ].join(' ');
}

function createWindowsPortCommand() {
  return powershellStdinCommand(`
$ErrorActionPreference = 'SilentlyContinue'
$tab = [char]9

function Clean-Field($value) {
  if ($null -eq $value) { return '' }
  return ([string]$value) -replace "[\`r\`n\`t]", ' '
}

function Is-Blank($value) {
  if ($null -eq $value) { return $true }
  return ([string]$value).Trim().Length -eq 0
}

function Get-ProcessRecords {
  try {
    return @(Get-CimInstance Win32_Process -ErrorAction Stop)
  } catch {
    try {
      return @(Get-WmiObject Win32_Process -ErrorAction Stop)
    } catch {
      return @()
    }
  }
}

$processInfo = @{}
$processNames = @{}
Get-ProcessRecords | ForEach-Object {
  if ($null -ne $_.ProcessId) { $processInfo[[int]$_.ProcessId] = $_ }
}
try {
  Get-Process -ErrorAction SilentlyContinue | ForEach-Object {
    $processNames[[int]$_.Id] = $_.ProcessName
  }
} catch {}

function Normalize-Int($value) {
  if ((Is-Blank $value) -or [string]$value -eq '*') { return $null }
  try { return [int]$value } catch { return $null }
}

function Get-ProcessNameByPid($processIdValue) {
  $id = Normalize-Int $processIdValue
  if ($null -eq $id) { return '' }
  if ($processInfo.ContainsKey($id) -and $processInfo[$id].Name) { return [string]$processInfo[$id].Name }
  if ($processNames.ContainsKey($id)) { return [string]$processNames[$id] }
  return ''
}

function Get-CommandLineByPid($processIdValue) {
  $id = Normalize-Int $processIdValue
  if ($null -eq $id) { return '' }
  if ($processInfo.ContainsKey($id) -and $processInfo[$id].CommandLine) { return [string]$processInfo[$id].CommandLine }
  return ''
}

function New-PortRow($protocol, $state, $localAddress, $localPort, $remoteAddress, $remotePort, $processIdValue) {
  $normalizedPid = Normalize-Int $processIdValue
  $fields = @(
    'PORT',
    $protocol,
    $state,
    $localAddress,
    (Normalize-Int $localPort),
    $remoteAddress,
    (Normalize-Int $remotePort),
    $normalizedPid,
    (Get-ProcessNameByPid $normalizedPid),
    (Get-CommandLineByPid $normalizedPid)
  )
  ($fields | ForEach-Object { Clean-Field $_ }) -join $tab
}

function Split-NetstatEndpoint($endpoint) {
  $raw = ([string]$endpoint).Trim()
  if ((Is-Blank $raw) -or $raw -eq '*' -or $raw -eq '*:*') {
    return @{ Address = '*'; Port = $null }
  }

  if ($raw -match '^\\[(.*)\\]:(\\d+|\\*)$') {
    return @{ Address = $matches[1]; Port = Normalize-Int $matches[2] }
  }

  if ($raw -match '^(.*):(\\d+|\\*)$') {
    $address = $matches[1]
    if (Is-Blank $address) { $address = '*' }
    return @{ Address = $address; Port = Normalize-Int $matches[2] }
  }

  return @{ Address = $raw; Port = $null }
}

$rowsWritten = 0

if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
  try {
    Get-NetTCPConnection -ErrorAction Stop | ForEach-Object {
      if ($rowsWritten -lt 1500) {
        $rowsWritten += 1
      New-PortRow 'tcp' $_.State $_.LocalAddress $_.LocalPort $_.RemoteAddress $_.RemotePort $_.OwningProcess
      }
    }
  } catch {}
}

if (Get-Command Get-NetUDPEndpoint -ErrorAction SilentlyContinue) {
  try {
    Get-NetUDPEndpoint -ErrorAction Stop | ForEach-Object {
      if ($rowsWritten -lt 1500) {
        $rowsWritten += 1
        New-PortRow 'udp' 'UNCONN' $_.LocalAddress $_.LocalPort '' $null $_.OwningProcess
      }
    }
  } catch {}
}

if ($rowsWritten -eq 0) {
  try {
    foreach ($line in @(netstat -ano)) {
      if ($rowsWritten -ge 1500) { break }
      $text = $line.Trim()
      if ($text -notmatch '^(TCP|UDP)\\s+') { continue }

      $parts = $text -split '\\s+'
      if ($parts[0] -eq 'TCP' -and $parts.Count -ge 5) {
        $local = Split-NetstatEndpoint $parts[1]
        $remote = Split-NetstatEndpoint $parts[2]
        $rowsWritten += 1
        New-PortRow 'tcp' $parts[3] $local.Address $local.Port $remote.Address $remote.Port $parts[4]
      } elseif ($parts[0] -eq 'UDP' -and $parts.Count -ge 4) {
        $local = Split-NetstatEndpoint $parts[1]
        $remote = Split-NetstatEndpoint $parts[2]
        $rowsWritten += 1
        New-PortRow 'udp' 'UNCONN' $local.Address $local.Port $remote.Address $remote.Port $parts[$parts.Count - 1]
      }
    }
  } catch {}
}
`);
}

function getStateFilter(entry: PortListenerEntry): StateFilter {
  const state = entry.state.toLowerCase();

  if (state.includes('listen')) return 'listen';
  if (state.includes('estab')) return 'established';
  if (entry.protocol.startsWith('udp')) return 'udp';
  return 'other';
}

function getStateLabel(state: string) {
  const normalizedState = state.toLowerCase();

  if (normalizedState.includes('listen')) return '监听';
  if (normalizedState.includes('estab')) return '已连接';
  if (normalizedState.includes('time-wait')) return 'TIME_WAIT';
  if (normalizedState.includes('close')) return '关闭中';
  if (normalizedState.includes('unconn')) return 'UDP';
  return state || '未知';
}

function getStateTone(entry: PortListenerEntry) {
  const filter = getStateFilter(entry);

  if (filter === 'listen') return 'listen';
  if (filter === 'established') return 'established';
  if (filter === 'udp') return 'udp';
  return 'other';
}

function formatEndpoint(address: string, port: number | null) {
  return `${address || '*'}:${port ?? '*'}`;
}

function formatRowInfo(entry: PortListenerEntry) {
  return [
    `${entry.protocol.toUpperCase()} ${entry.state}`,
    `本地 ${formatEndpoint(entry.localAddress, entry.localPort)}`,
    `远端 ${formatEndpoint(entry.remoteAddress, entry.remotePort)}`,
    entry.pid ? `PID ${entry.pid}` : 'PID -',
    entry.processName ? `进程 ${entry.processName}` : '',
    entry.command ? `命令 ${entry.command}` : '',
  ].filter(Boolean).join('\n');
}

function createUnixProcessDetailCommand(pid: number) {
  return `ps -p ${pid} -o pid=,ppid=,user=,comm=,args= 2>/dev/null || true`;
}

function createWindowsProcessDetailCommand(pid: number) {
  return powershellStdinCommand(`
$process = $null
try { $process = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction Stop } catch {
  try { $process = Get-WmiObject Win32_Process -Filter "ProcessId=${pid}" -ErrorAction Stop } catch {}
}
if ($process) {
  "ProcessId: $($process.ProcessId)"
  "ParentProcessId: $($process.ParentProcessId)"
  "Name: $($process.Name)"
  "ExecutablePath: $($process.ExecutablePath)"
  "CommandLine: $($process.CommandLine)"
} else {
  try {
    $psProcess = Get-Process -Id ${pid} -ErrorAction Stop
    "ProcessId: $($psProcess.Id)"
    "Name: $($psProcess.ProcessName)"
    "ExecutablePath: $($psProcess.Path)"
  } catch {}
}
`);
}

function RemotePortManager({ connectionId, systemType, onOpenProcessManager }: RemotePortManagerProps) {
  const isWindowsHost = isWindowsSystem(systemType);
  const [entries, setEntries] = useState<PortListenerEntry[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [search, setSearch] = useState('');
  const [protocolFilter, setProtocolFilter] = useState<ProtocolFilter>('all');
  const [stateFilter, setStateFilter] = useState<StateFilter>('all');
  const [listenOnly, setListenOnly] = useState(true);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [processDetail, setProcessDetail] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [refreshedAt, setRefreshedAt] = useState('');

  const selectedEntry = useMemo(() => {
    return entries.find((entry) => entry.id === selectedId) ?? entries[0] ?? null;
  }, [entries, selectedId]);

  const filteredEntries = useMemo(() => {
    const keyword = search.trim().toLowerCase();

    return entries.filter((entry) => {
      if (listenOnly && getStateFilter(entry) !== 'listen' && !entry.protocol.startsWith('udp')) {
        return false;
      }

      if (protocolFilter !== 'all' && !entry.protocol.startsWith(protocolFilter)) {
        return false;
      }

      if (stateFilter !== 'all' && getStateFilter(entry) !== stateFilter) {
        return false;
      }

      if (!keyword) {
        return true;
      }

      return [
        entry.protocol,
        entry.state,
        entry.localAddress,
        entry.localPort,
        entry.remoteAddress,
        entry.remotePort,
        entry.pid,
        entry.processName,
        entry.command,
      ].some((value) => String(value ?? '').toLowerCase().includes(keyword));
    });
  }, [entries, listenOnly, protocolFilter, search, stateFilter]);

  const listeningCount = useMemo(() => {
    return entries.filter((entry) => getStateFilter(entry) === 'listen' || entry.protocol.startsWith('udp')).length;
  }, [entries]);

  const refreshPorts = useCallback(async () => {
    setLoading(true);
    setError('');
    setNotice('');

    try {
      const result = await runCmd(connectionId, isWindowsHost ? createWindowsPortCommand() : createUnixPortCommand());

      if (result.code !== 0 && !result.stdout.trim()) {
        throw new Error(result.stderr || '读取端口列表失败。');
      }

      const nextEntries = isWindowsHost ? parseWindowsPorts(result.stdout) : parseUnixPorts(result.stdout);
      setEntries(nextEntries);
      setSelectedId((currentId) => (nextEntries.some((entry) => entry.id === currentId) ? currentId : nextEntries[0]?.id ?? ''));
      setRefreshedAt(new Date().toLocaleTimeString('zh-CN'));
      if (result.stderr.trim()) {
        setNotice(result.stderr.trim());
      }
    } catch (error) {
      setError(getErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [connectionId, isWindowsHost]);

  useEffect(() => {
    void refreshPorts();
  }, [refreshPorts]);

  useEffect(() => {
    let disposed = false;

    if (!selectedEntry?.pid) {
      setProcessDetail('');
      return () => {
        disposed = true;
      };
    }

    const loadDetail = async () => {
      setDetailLoading(true);
      try {
        const result = await runCmd(
          connectionId,
          isWindowsHost ? createWindowsProcessDetailCommand(selectedEntry.pid!) : createUnixProcessDetailCommand(selectedEntry.pid!),
        );

        if (!disposed) {
          setProcessDetail(result.stdout || result.stderr || '未读取到进程详情。');
        }
      } catch (error) {
        if (!disposed) {
          setProcessDetail(getErrorMessage(error));
        }
      } finally {
        if (!disposed) {
          setDetailLoading(false);
        }
      }
    };

    void loadDetail();

    return () => {
      disposed = true;
    };
  }, [connectionId, isWindowsHost, selectedEntry?.pid]);

  const copySelectedEntry = async () => {
    if (!selectedEntry) {
      return;
    }

    await navigator.clipboard.writeText(formatRowInfo(selectedEntry));
    setNotice('已复制端口诊断信息。');
  };

  return (
    <section className="port-manager">
      <header className="port-toolbar">
        <div className="port-toolbar-left">
          <button type="button" className="port-tool-button primary" onClick={refreshPorts} disabled={loading}>
            {loading ? '刷新中' : '刷新'}
          </button>
          <input
            className="port-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索端口、PID、进程"
          />
          <select className="port-select" value={protocolFilter} onChange={(event) => setProtocolFilter(event.target.value as ProtocolFilter)}>
            <option value="all">全部协议</option>
            <option value="tcp">TCP</option>
            <option value="udp">UDP</option>
          </select>
          <select className="port-select" value={stateFilter} onChange={(event) => setStateFilter(event.target.value as StateFilter)}>
            <option value="all">全部状态</option>
            <option value="listen">监听</option>
            <option value="established">已连接</option>
            <option value="udp">UDP</option>
            <option value="other">其他</option>
          </select>
          <label className="port-toggle">
            <input type="checkbox" checked={listenOnly} onChange={(event) => setListenOnly(event.target.checked)} />
            仅监听
          </label>
        </div>
        <div className="port-toolbar-right">
          <span className="port-summary">
            <strong>{filteredEntries.length}</strong> / {entries.length} 条 · 监听 {listeningCount}
            {refreshedAt ? ` · ${refreshedAt}` : ''}
          </span>
        </div>
      </header>

      {error ? <div className="port-alert danger">{error}</div> : null}
      {notice ? <div className="port-alert info">{notice}</div> : null}

      <div className="port-layout">
        <div className="port-table-panel">
          <div className="port-table-wrap">
            <table className="port-table">
              <thead>
                <tr>
                  <th>协议</th>
                  <th>状态</th>
                  <th>本地地址</th>
                  <th>端口</th>
                  <th>远端</th>
                  <th>PID</th>
                  <th>进程</th>
                </tr>
              </thead>
              <tbody>
                {filteredEntries.map((entry) => (
                  <tr
                    key={entry.id}
                    className={selectedEntry?.id === entry.id ? 'selected' : ''}
                    onClick={() => setSelectedId(entry.id)}
                  >
                    <td><span className={`port-protocol ${entry.protocol.startsWith('udp') ? 'udp' : 'tcp'}`}>{entry.protocol.toUpperCase()}</span></td>
                    <td><span className={`port-state ${getStateTone(entry)}`}>{getStateLabel(entry.state)}</span></td>
                    <td title={entry.localAddress}>{entry.localAddress}</td>
                    <td className="port-number">{entry.localPort ?? '-'}</td>
                    <td title={formatEndpoint(entry.remoteAddress, entry.remotePort)}>{formatEndpoint(entry.remoteAddress, entry.remotePort)}</td>
                    <td className="port-number">{entry.pid ?? '-'}</td>
                    <td title={entry.command || entry.processName || ''}>{entry.processName || '-'}</td>
                  </tr>
                ))}
                {!loading && filteredEntries.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="port-empty">没有符合条件的连接。</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>

        <aside className="port-detail-panel">
          {selectedEntry ? (
            <>
              <div className="port-detail-header">
                <div>
                  <span>当前连接</span>
                  <strong>{formatEndpoint(selectedEntry.localAddress, selectedEntry.localPort)}</strong>
                </div>
                <span className={`port-state ${getStateTone(selectedEntry)}`}>{getStateLabel(selectedEntry.state)}</span>
              </div>

              <dl className="port-detail-list">
                <div>
                  <dt>协议</dt>
                  <dd>{selectedEntry.protocol.toUpperCase()}</dd>
                </div>
                <div>
                  <dt>远端</dt>
                  <dd>{formatEndpoint(selectedEntry.remoteAddress, selectedEntry.remotePort)}</dd>
                </div>
                <div>
                  <dt>PID</dt>
                  <dd>{selectedEntry.pid ?? '-'}</dd>
                </div>
                <div>
                  <dt>进程</dt>
                  <dd>{selectedEntry.processName || '-'}</dd>
                </div>
              </dl>

              <div className="port-detail-actions">
                <button type="button" onClick={copySelectedEntry}>复制信息</button>
                <button
                  type="button"
                  disabled={!selectedEntry.pid || !onOpenProcessManager}
                  onClick={() => onOpenProcessManager?.({ pid: selectedEntry.pid, search: selectedEntry.processName || String(selectedEntry.pid), sortKey: 'pid', sortDir: 'asc' })}
                >
                  打开进程
                </button>
              </div>

              <section className="port-diagnostic">
                <h3>进程详情</h3>
                <pre>{detailLoading ? '读取中...' : processDetail || selectedEntry.command || '该连接没有进程详情。'}</pre>
              </section>

              <section className="port-diagnostic">
                <h3>建议命令</h3>
                <pre>{selectedEntry.pid
                  ? isWindowsHost
                    ? `Get-NetTCPConnection -OwningProcess ${selectedEntry.pid}\nGet-Process -Id ${selectedEntry.pid}`
                    : `ss -tunlp | grep ${shellSingleQuote(String(selectedEntry.localPort ?? selectedEntry.pid))}\nps -fp ${selectedEntry.pid}`
                  : isWindowsHost
                    ? 'Get-NetTCPConnection | Sort-Object LocalPort'
                    : 'ss -tunlp'}</pre>
              </section>
            </>
          ) : (
            <div className="port-empty-panel">选择一条端口记录查看详情。</div>
          )}
        </aside>
      </div>
    </section>
  );
}

export default RemotePortManager;

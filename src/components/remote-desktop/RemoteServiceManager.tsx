import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { getErrorMessage, getShellDeskLocale } from './desktopUtils';
import { isWindowsSystem, powershellCommand, powershellSingleQuote } from './remoteSystem';
import type { RemoteSystemType } from './types';

export type RemoteServiceActiveState = 'active' | 'inactive' | 'failed' | 'activating' | 'deactivating' | 'unknown';
export type RemoteServiceEnabledState = 'enabled' | 'disabled' | 'static' | 'masked' | 'unknown';

export interface RemoteServiceSummary {
  name: string;
  displayName: string;
  description: string;
  loadState?: string;
  activeState: RemoteServiceActiveState;
  subState?: string;
  enabledState?: RemoteServiceEnabledState;
  pid?: number;
}

export interface RemoteServiceDetail extends RemoteServiceSummary {
  unitFilePath?: string;
  memory?: string;
  startedAt?: string;
  statusText: string;
  recentLogs: string;
  unitFileText?: string;
}

interface RemoteServiceManagerProps {
  connectionId: string;
  systemType?: RemoteSystemType;
}

type ServiceFilter = 'all' | 'active' | 'failed' | 'inactive' | 'enabled' | 'disabled';
type ServiceTab = 'status' | 'logs' | 'unit';
type ServiceAction = 'start' | 'stop' | 'restart' | 'reload' | 'enable' | 'disable';

interface PendingServiceAction {
  action: ServiceAction;
  service: RemoteServiceSummary;
}

interface ServiceListParseResult {
  services: RemoteServiceSummary[];
  error?: string;
}

type ServiceDetailSection = 'props' | 'status' | 'logs' | 'unit';

const SERVICE_LIST_ERROR_PREFIX = '__SHELLDESK_SERVICE_ERROR__\t';
const SERVICE_LIST_UNITS_MARKER = '__SHELLDESK_SERVICE_UNITS__';
const SERVICE_LIST_UNIT_FILES_MARKER = '__SHELLDESK_SERVICE_UNIT_FILES__';
const SERVICE_DETAIL_PROPS_MARKER = '__SHELLDESK_SERVICE_PROPS__';
const SERVICE_DETAIL_STATUS_MARKER = '__SHELLDESK_SERVICE_STATUS__';
const SERVICE_DETAIL_LOGS_MARKER = '__SHELLDESK_SERVICE_LOGS__';
const SERVICE_DETAIL_UNIT_MARKER = '__SHELLDESK_SERVICE_UNIT__';

const serviceFilters: Array<{ key: ServiceFilter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'active', label: '运行中' },
  { key: 'failed', label: '失败' },
  { key: 'inactive', label: '已停止' },
  { key: 'enabled', label: '已启用' },
  { key: 'disabled', label: '已禁用' },
];

const actionDefinitions: Record<ServiceAction, { label: string; success: string; danger?: boolean; confirm?: boolean; primary?: boolean }> = {
  start: { label: '启动', success: '已启动', primary: true },
  stop: { label: '停止', success: '已停止', danger: true, confirm: true },
  restart: { label: '重启', success: '已重启', danger: true, confirm: true },
  reload: { label: 'Reload', success: '已重新加载' },
  enable: { label: '启用自启', success: '已启用开机自启' },
  disable: { label: '禁用自启', success: '已禁用开机自启' },
};

const activeStateOrder: Record<RemoteServiceActiveState, number> = {
  failed: 0,
  active: 1,
  activating: 2,
  deactivating: 3,
  inactive: 4,
  unknown: 5,
};

function runCmd(connectionId: string, command: string) {
  const api = window.guiSSH?.connections;

  if (!api) {
    throw new Error('ShellDesk IPC 未就绪。');
  }

  return api.runCommand(connectionId, command);
}

function shellSingleQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function stripServiceSuffix(name: string) {
  return name.endsWith('.service') ? name.slice(0, -8) : name;
}

function readInteger(value: unknown) {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value;
  }

  if (typeof value !== 'string' || !value.trim()) {
    return undefined;
  }

  const parsedValue = Number.parseInt(value, 10);
  return Number.isInteger(parsedValue) ? parsedValue : undefined;
}

function readString(record: Record<string, unknown>, ...keys: string[]) {
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

function normalizeActiveState(value: unknown): RemoteServiceActiveState {
  const normalizedValue = String(value ?? '').trim().toLowerCase();

  if (normalizedValue === 'active' || normalizedValue === 'running') {
    return 'active';
  }

  if (normalizedValue === 'failed') {
    return 'failed';
  }

  if (normalizedValue === 'inactive' || normalizedValue === 'dead' || normalizedValue === 'stopped' || normalizedValue === 'paused') {
    return 'inactive';
  }

  if (normalizedValue.includes('start') || normalizedValue.includes('activating')) {
    return 'activating';
  }

  if (normalizedValue.includes('stop') || normalizedValue.includes('deactivating')) {
    return 'deactivating';
  }

  return 'unknown';
}

function normalizeEnabledState(value: unknown): RemoteServiceEnabledState {
  const normalizedValue = String(value ?? '').trim().toLowerCase();

  if (normalizedValue.startsWith('enabled') || normalizedValue === 'auto' || normalizedValue === 'automatic' || normalizedValue === 'boot' || normalizedValue === 'system') {
    return 'enabled';
  }

  if (normalizedValue.startsWith('disabled')) {
    return 'disabled';
  }

  if (normalizedValue.startsWith('masked')) {
    return 'masked';
  }

  if (
    normalizedValue === 'static' ||
    normalizedValue === 'manual' ||
    normalizedValue === 'demand' ||
    normalizedValue === 'delayed-auto' ||
    normalizedValue === 'indirect' ||
    normalizedValue === 'generated' ||
    normalizedValue === 'transient'
  ) {
    return 'static';
  }

  return 'unknown';
}

function getActiveStateLabel(state?: RemoteServiceActiveState) {
  if (state === 'active') return '运行中';
  if (state === 'failed') return '失败';
  if (state === 'inactive') return '已停止';
  if (state === 'activating') return '启动中';
  if (state === 'deactivating') return '停止中';
  return '未知';
}

function getEnabledStateLabel(state?: RemoteServiceEnabledState) {
  if (state === 'enabled') return '已启用';
  if (state === 'disabled') return '已禁用';
  if (state === 'static') return '手动/静态';
  if (state === 'masked') return '已屏蔽';
  return '未知';
}

function getActiveStateTone(state?: RemoteServiceActiveState) {
  if (state === 'active') return 'running';
  if (state === 'failed') return 'failed';
  if (state === 'activating' || state === 'deactivating') return 'working';
  if (state === 'inactive') return 'stopped';
  return 'unknown';
}

function getEnabledStateTone(state?: RemoteServiceEnabledState) {
  if (state === 'enabled') return 'enabled';
  if (state === 'disabled' || state === 'masked') return 'disabled';
  if (state === 'static') return 'static';
  return 'unknown';
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return undefined;
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let nextValue = value;
  let unitIndex = 0;

  while (nextValue >= 1024 && unitIndex < units.length - 1) {
    nextValue /= 1024;
    unitIndex += 1;
  }

  const precision = nextValue >= 100 ? 0 : nextValue >= 10 ? 1 : 2;
  return `${nextValue.toFixed(precision).replace(/\.0+$/, '')} ${units[unitIndex]}`;
}

function formatSystemdMemory(value: string | undefined) {
  if (!value || value === '[not set]') {
    return undefined;
  }

  const bytes = Number.parseInt(value, 10);

  if (!Number.isFinite(bytes) || bytes <= 0 || bytes > Number.MAX_SAFE_INTEGER) {
    return undefined;
  }

  return formatBytes(bytes);
}

function cleanTimestamp(value: string | undefined) {
  if (!value || value === 'n/a' || value === '[not set]') {
    return undefined;
  }

  return value;
}

function parseJsonRecords(stdout: string): Record<string, unknown>[] {
  const text = stdout.trim();

  if (!text) {
    return [];
  }

  const parsedJson = JSON.parse(text) as unknown;
  const records = Array.isArray(parsedJson) ? parsedJson : [parsedJson];

  return records.filter((record): record is Record<string, unknown> => Boolean(record) && typeof record === 'object' && !Array.isArray(record));
}

function compareServices(first: RemoteServiceSummary, second: RemoteServiceSummary) {
  const stateCompare = activeStateOrder[first.activeState] - activeStateOrder[second.activeState];

  if (stateCompare !== 0) {
    return stateCompare;
  }

  return first.name.localeCompare(second.name, getShellDeskLocale());
}

function parseLinuxServiceListOutput(stdout: string): ServiceListParseResult {
  const servicesByName = new Map<string, RemoteServiceSummary>();
  const enabledByName = new Map<string, RemoteServiceEnabledState>();
  let section: 'units' | 'unit-files' | null = null;
  let remoteError = '';

  stdout.split(/\r?\n/).forEach((rawLine) => {
    const line = rawLine.trimEnd();

    if (!line) {
      return;
    }

    if (line === SERVICE_LIST_UNITS_MARKER) {
      section = 'units';
      return;
    }

    if (line === SERVICE_LIST_UNIT_FILES_MARKER) {
      section = 'unit-files';
      return;
    }

    if (line.startsWith(SERVICE_LIST_ERROR_PREFIX)) {
      remoteError = line.slice(SERVICE_LIST_ERROR_PREFIX.length).trim();
      return;
    }

    if (section === 'units') {
      const [name, loadState, activeState, subState, ...descriptionParts] = line.split('\t');

      if (!name) {
        return;
      }

      servicesByName.set(name, {
        name,
        displayName: stripServiceSuffix(name),
        description: descriptionParts.join('\t').trim(),
        loadState: loadState || undefined,
        activeState: normalizeActiveState(activeState),
        subState: subState || undefined,
        enabledState: 'unknown',
      });
      return;
    }

    if (section === 'unit-files') {
      const [name, state] = line.split('\t');

      if (name) {
        enabledByName.set(name, normalizeEnabledState(state));
      }
    }
  });

  enabledByName.forEach((enabledState, name) => {
    const existingService = servicesByName.get(name);

    if (existingService) {
      servicesByName.set(name, { ...existingService, enabledState });
      return;
    }

    servicesByName.set(name, {
      name,
      displayName: stripServiceSuffix(name),
      description: '',
      activeState: 'inactive',
      enabledState,
    });
  });

  return {
    services: [...servicesByName.values()].sort(compareServices),
    error: remoteError || undefined,
  };
}

function parseWindowsServiceListOutput(stdout: string): RemoteServiceSummary[] {
  return parseJsonRecords(stdout)
    .map<RemoteServiceSummary | null>((record) => {
      const name = readString(record, 'name', 'Name');

      if (!name) {
        return null;
      }

      const pid = readInteger(record.pid ?? record.ProcessId);

      return {
        name,
        displayName: readString(record, 'displayName', 'DisplayName') || name,
        description: readString(record, 'description', 'Description'),
        loadState: 'loaded',
        activeState: normalizeActiveState(readString(record, 'status', 'State', 'Status')),
        subState: readString(record, 'status', 'State', 'Status') || undefined,
        enabledState: normalizeEnabledState(readString(record, 'startType', 'StartMode')),
        pid: pid && pid > 0 ? pid : undefined,
      };
    })
    .filter((service): service is RemoteServiceSummary => Boolean(service))
    .sort(compareServices);
}

function parseKeyValueLines(text: string) {
  const values: Record<string, string> = {};

  text.split(/\r?\n/).forEach((line) => {
    const separatorIndex = line.indexOf('=');

    if (separatorIndex <= 0) {
      return;
    }

    values[line.slice(0, separatorIndex)] = line.slice(separatorIndex + 1).trim();
  });

  return values;
}

function splitServiceDetailSections(stdout: string) {
  const sections: Record<ServiceDetailSection, string[]> = {
    props: [],
    status: [],
    logs: [],
    unit: [],
  };
  let section: ServiceDetailSection | null = null;
  const markerSections: Record<string, ServiceDetailSection> = {
    [SERVICE_DETAIL_PROPS_MARKER]: 'props',
    [SERVICE_DETAIL_STATUS_MARKER]: 'status',
    [SERVICE_DETAIL_LOGS_MARKER]: 'logs',
    [SERVICE_DETAIL_UNIT_MARKER]: 'unit',
  };

  stdout.split(/\r?\n/).forEach((rawLine) => {
    const line = rawLine.trimEnd();
    const nextSection = markerSections[line.trim()];

    if (nextSection) {
      section = nextSection;
      return;
    }

    if (section) {
      sections[section].push(line);
    }
  });

  return {
    props: sections.props.join('\n').trim(),
    status: sections.status.join('\n').trim(),
    logs: sections.logs.join('\n').trim(),
    unit: sections.unit.join('\n').trim(),
  };
}

function parseLinuxServiceDetailOutput(stdout: string, serviceName: string, fallback?: RemoteServiceSummary): RemoteServiceDetail {
  const sections = splitServiceDetailSections(stdout);
  const props = parseKeyValueLines(sections.props);
  const name = props.Id || serviceName;
  const pid = readInteger(props.MainPID);

  return {
    name,
    displayName: fallback?.displayName || stripServiceSuffix(name),
    description: props.Description || fallback?.description || '',
    loadState: props.LoadState || fallback?.loadState,
    activeState: normalizeActiveState(props.ActiveState || fallback?.activeState),
    subState: props.SubState || fallback?.subState,
    enabledState: normalizeEnabledState(props.UnitFileState || fallback?.enabledState),
    pid: pid && pid > 0 ? pid : undefined,
    unitFilePath: props.FragmentPath || undefined,
    memory: formatSystemdMemory(props.MemoryCurrent),
    startedAt: cleanTimestamp(props.ActiveEnterTimestamp) || cleanTimestamp(props.ExecMainStartTimestamp),
    statusText: sections.status,
    recentLogs: sections.logs,
    unitFileText: sections.unit,
  };
}

function parseWindowsServiceDetailOutput(stdout: string, serviceName: string, fallback?: RemoteServiceSummary): RemoteServiceDetail {
  const sections = splitServiceDetailSections(stdout);
  const records = parseJsonRecords(sections.props);
  const record = records[0] ?? {};
  const name = readString(record, 'name', 'Name') || serviceName;
  const pid = readInteger(record.pid ?? record.ProcessId);
  const status = readString(record, 'status', 'State', 'Status') || fallback?.subState || '';

  return {
    name,
    displayName: readString(record, 'displayName', 'DisplayName') || fallback?.displayName || name,
    description: readString(record, 'description', 'Description') || fallback?.description || '',
    loadState: 'loaded',
    activeState: normalizeActiveState(status || fallback?.activeState),
    subState: status || undefined,
    enabledState: normalizeEnabledState(readString(record, 'startType', 'StartMode') || fallback?.enabledState),
    pid: pid && pid > 0 ? pid : undefined,
    unitFilePath: readString(record, 'pathName', 'PathName') || undefined,
    startedAt: readString(record, 'started', 'Started') || undefined,
    statusText: sections.status,
    recentLogs: sections.logs,
    unitFileText: sections.unit,
  };
}

function getLinuxServiceListCommand() {
  return `
if ! command -v systemctl >/dev/null 2>&1; then
  printf '${SERVICE_LIST_ERROR_PREFIX}systemctl 未安装或当前 PATH 不可用。\\n'
  exit 0
fi
printf '${SERVICE_LIST_UNITS_MARKER}\\n'
systemctl list-units --type=service --all --no-pager --plain --no-legend 2>/dev/null | awk 'BEGIN{OFS="\\t"} NF >= 4 { unit=$1; load=$2; active=$3; sub=$4; desc=""; for (i=5; i<=NF; i++) desc=desc (i>5?" ":"") $i; print unit, load, active, sub, desc }'
printf '${SERVICE_LIST_UNIT_FILES_MARKER}\\n'
systemctl list-unit-files --type=service --no-pager --plain --no-legend 2>/dev/null | awk 'BEGIN{OFS="\\t"} NF >= 2 { print $1, $2 }'
`;
}

function getLinuxServiceDetailCommand(serviceName: string) {
  const unit = shellSingleQuote(serviceName);

  return `
if ! command -v systemctl >/dev/null 2>&1; then
  printf '${SERVICE_LIST_ERROR_PREFIX}systemctl 未安装或当前 PATH 不可用。\\n'
  exit 127
fi
printf '${SERVICE_DETAIL_PROPS_MARKER}\\n'
systemctl show ${unit} --no-pager -p Id -p Description -p LoadState -p ActiveState -p SubState -p UnitFileState -p MainPID -p MemoryCurrent -p FragmentPath -p ActiveEnterTimestamp -p ExecMainStartTimestamp 2>&1 || true
printf '${SERVICE_DETAIL_STATUS_MARKER}\\n'
systemctl status ${unit} --no-pager --lines=80 2>&1 || true
printf '${SERVICE_DETAIL_LOGS_MARKER}\\n'
if command -v journalctl >/dev/null 2>&1; then
  journalctl -u ${unit} -n 100 --no-pager --output=short-iso 2>&1 || true
else
  printf 'journalctl 不可用。\\n'
fi
printf '${SERVICE_DETAIL_UNIT_MARKER}\\n'
systemctl cat ${unit} --no-pager 2>&1 || true
`;
}

function getLinuxServiceActionCommand(action: ServiceAction, serviceName: string) {
  const unit = shellSingleQuote(serviceName);
  return `
if ! command -v systemctl >/dev/null 2>&1; then
  printf 'systemctl 未安装或当前 PATH 不可用。\\n'
  exit 127
fi
if [ "$(id -u 2>/dev/null)" = "0" ]; then
  systemctl ${action} ${unit} 2>&1
elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
  sudo -n systemctl ${action} ${unit} 2>&1
else
  systemctl ${action} ${unit} 2>&1
fi
`;
}

function getWindowsServiceListCommand() {
  return powershellCommand(`
$services = Get-CimInstance Win32_Service -ErrorAction Stop | Sort-Object Name | ForEach-Object {
  [pscustomobject]@{
    name = [string]$_.Name
    displayName = [string]$_.DisplayName
    description = [string]$_.Description
    status = [string]$_.State
    startType = [string]$_.StartMode
    pid = if ($null -ne $_.ProcessId -and [int]$_.ProcessId -gt 0) { [int]$_.ProcessId } else { $null }
  }
}
$services | ConvertTo-Json -Compress -Depth 4
`);
}

function getWindowsServiceDetailCommand(serviceName: string) {
  const nameLiteral = powershellSingleQuote(serviceName);

  return powershellCommand(`
$serviceName = ${nameLiteral}
$service = Get-CimInstance Win32_Service -ErrorAction Stop | Where-Object { $_.Name -eq $serviceName } | Select-Object -First 1
if (-not $service) { throw "服务不存在：$serviceName" }
$detail = [pscustomobject]@{
  name = [string]$service.Name
  displayName = [string]$service.DisplayName
  description = [string]$service.Description
  status = [string]$service.State
  startType = [string]$service.StartMode
  pid = if ($null -ne $service.ProcessId -and [int]$service.ProcessId -gt 0) { [int]$service.ProcessId } else { $null }
  pathName = [string]$service.PathName
  serviceType = [string]$service.ServiceType
  startName = [string]$service.StartName
  exitCode = [string]$service.ExitCode
  serviceSpecificExitCode = [string]$service.ServiceSpecificExitCode
}
"${SERVICE_DETAIL_PROPS_MARKER}"
$detail | ConvertTo-Json -Compress -Depth 4
"${SERVICE_DETAIL_STATUS_MARKER}"
$detail | Format-List | Out-String
"${SERVICE_DETAIL_LOGS_MARKER}"
try {
  $displayName = [string]$service.DisplayName
  $events = Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Service Control Manager'; StartTime = (Get-Date).AddDays(-14) } -MaxEvents 240 -ErrorAction SilentlyContinue |
    Where-Object { $_.Message -like "*$serviceName*" -or (-not [string]::IsNullOrWhiteSpace($displayName) -and $_.Message -like "*$displayName*") } |
    Select-Object -First 100
  if ($events) {
    $events | ForEach-Object {
      $message = ($_.Message -replace "\\s+", " ").Trim()
      "{0:u} [{1}] {2}" -f $_.TimeCreated, $_.LevelDisplayName, $message
    }
  } else {
    "未找到最近服务控制事件。"
  }
} catch {
  "无法读取系统事件日志：$($_.Exception.Message)"
}
"${SERVICE_DETAIL_UNIT_MARKER}"
"Name: $($service.Name)"
"DisplayName: $($service.DisplayName)"
"StartMode: $($service.StartMode)"
"StartName: $($service.StartName)"
"PathName: $($service.PathName)"
"ServiceType: $($service.ServiceType)"
`);
}

function getWindowsServiceActionCommand(action: ServiceAction, serviceName: string) {
  const nameLiteral = powershellSingleQuote(serviceName);
  let command = '';

  if (action === 'start') {
    command = 'Start-Service -Name $serviceName -ErrorAction Stop';
  } else if (action === 'stop') {
    command = 'Stop-Service -Name $serviceName -ErrorAction Stop';
  } else if (action === 'restart') {
    command = 'Restart-Service -Name $serviceName -Force -ErrorAction Stop';
  } else if (action === 'enable') {
    command = 'Set-Service -Name $serviceName -StartupType Automatic -ErrorAction Stop';
  } else if (action === 'disable') {
    command = 'Set-Service -Name $serviceName -StartupType Disabled -ErrorAction Stop';
  } else {
    throw new Error('Windows Services 不支持 reload 操作。');
  }

  return powershellCommand(`
$serviceName = ${nameLiteral}
${command}
"OK"
`);
}

function matchesQuery(service: RemoteServiceSummary, query: string) {
  if (!query) {
    return true;
  }

  const normalizedQuery = query.toLowerCase();
  const searchableText = [
    service.name,
    service.displayName,
    service.description,
    service.loadState,
    service.activeState,
    service.subState,
    service.enabledState,
    service.pid,
  ].filter((value) => value !== undefined && value !== null).join(' ').toLowerCase();

  return searchableText.includes(normalizedQuery);
}

function matchesFilter(service: RemoteServiceSummary, filter: ServiceFilter) {
  if (filter === 'all') return true;
  if (filter === 'enabled') return service.enabledState === 'enabled';
  if (filter === 'disabled') return service.enabledState === 'disabled';
  return service.activeState === filter;
}

function buildDiagnostics(detail: RemoteServiceDetail) {
  return [
    `服务：${detail.name}`,
    `描述：${detail.description || '-'}`,
    `运行状态：${getActiveStateLabel(detail.activeState)} / ${detail.subState || '-'}`,
    `启用状态：${getEnabledStateLabel(detail.enabledState)}`,
    `PID：${detail.pid ?? '-'}`,
    `内存：${detail.memory || '-'}`,
    `启动时间：${detail.startedAt || '-'}`,
    `单元/路径：${detail.unitFilePath || '-'}`,
    '',
    '--- status ---',
    detail.statusText || '无状态输出',
    '',
    '--- logs ---',
    detail.recentLogs || '无最近日志',
  ].join('\n');
}

function ServiceManager({ connectionId, systemType }: RemoteServiceManagerProps) {
  const isWindowsHost = isWindowsSystem(systemType);
  const isMountedRef = useRef(true);
  const isRefreshingRef = useRef(false);
  const selectedServiceNameRef = useRef('');
  const detailRequestIdRef = useRef(0);
  const [services, setServices] = useState<RemoteServiceSummary[]>([]);
  const [selectedServiceName, setSelectedServiceName] = useState('');
  const [detail, setDetail] = useState<RemoteServiceDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [actingAction, setActingAction] = useState<ServiceAction | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ServiceFilter>('all');
  const [tab, setTab] = useState<ServiceTab>('status');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [success, setSuccess] = useState('');
  const [pendingAction, setPendingAction] = useState<PendingServiceAction | null>(null);

  useEffect(() => {
    selectedServiceNameRef.current = selectedServiceName;
  }, [selectedServiceName]);

  const refreshServices = useCallback(async (options?: { silent?: boolean; preferredServiceName?: string }) => {
    if (isRefreshingRef.current) {
      return selectedServiceNameRef.current;
    }

    isRefreshingRef.current = true;

    if (!options?.silent) {
      setLoading(true);
    }

    setError('');
    setNotice('');

    try {
      const result = await runCmd(
        connectionId,
        isWindowsHost ? getWindowsServiceListCommand() : getLinuxServiceListCommand(),
      );
      const parseResult = isWindowsHost
        ? { services: parseWindowsServiceListOutput(result.stdout || '') }
        : parseLinuxServiceListOutput(result.stdout || '');
      const nextServices = parseResult.services;

      if (!isMountedRef.current) {
        return selectedServiceNameRef.current;
      }

      setServices(nextServices);

      if (parseResult.error) {
        setNotice(parseResult.error);
      }

      if (result.code !== 0 && nextServices.length === 0) {
        setError(result.stderr || result.stdout || '无法读取远程服务列表。');
      }

      const preferredServiceName = options?.preferredServiceName || selectedServiceNameRef.current;
      const nextSelectedName = preferredServiceName && nextServices.some((service) => service.name === preferredServiceName)
        ? preferredServiceName
        : nextServices[0]?.name ?? '';

      setSelectedServiceName(nextSelectedName);
      return nextSelectedName;
    } catch (err) {
      if (isMountedRef.current) {
        setError(getErrorMessage(err));
      }

      return selectedServiceNameRef.current;
    } finally {
      isRefreshingRef.current = false;

      if (isMountedRef.current && !options?.silent) {
        setLoading(false);
      }
    }
  }, [connectionId, isWindowsHost]);

  const loadServiceDetail = useCallback(async (serviceName: string) => {
    if (!serviceName) {
      setDetail(null);
      return;
    }

    const requestId = detailRequestIdRef.current + 1;
    detailRequestIdRef.current = requestId;
    setDetailLoading(true);
    setDetail(null);
    setError('');

    try {
      const result = await runCmd(
        connectionId,
        isWindowsHost ? getWindowsServiceDetailCommand(serviceName) : getLinuxServiceDetailCommand(serviceName),
      );
      const fallback = services.find((service) => service.name === serviceName);
      const nextDetail = isWindowsHost
        ? parseWindowsServiceDetailOutput(result.stdout || '', serviceName, fallback)
        : parseLinuxServiceDetailOutput(result.stdout || '', serviceName, fallback);

      if (result.code !== 0 && !nextDetail.statusText) {
        throw new Error(result.stderr || result.stdout || '无法读取服务详情。');
      }

      if (isMountedRef.current && requestId === detailRequestIdRef.current) {
        setDetail(nextDetail);
      }
    } catch (err) {
      if (isMountedRef.current && requestId === detailRequestIdRef.current) {
        setError(getErrorMessage(err));
      }
    } finally {
      if (isMountedRef.current && requestId === detailRequestIdRef.current) {
        setDetailLoading(false);
      }
    }
  }, [connectionId, isWindowsHost, services]);

  useEffect(() => {
    isMountedRef.current = true;
    void refreshServices();

    return () => {
      isMountedRef.current = false;
    };
  }, [refreshServices]);

  useEffect(() => {
    if (selectedServiceName) {
      void loadServiceDetail(selectedServiceName);
    } else {
      setDetail(null);
    }
  }, [loadServiceDetail, selectedServiceName]);

  const selectedService = useMemo(
    () => services.find((service) => service.name === selectedServiceName) ?? null,
    [selectedServiceName, services],
  );

  const currentDetail = detail && detail.name === selectedServiceName ? detail : null;
  const selectedDetail = currentDetail ?? selectedService;

  const visibleServices = useMemo(() => {
    const trimmedQuery = query.trim();

    return services.filter((service) => matchesFilter(service, filter) && matchesQuery(service, trimmedQuery));
  }, [filter, query, services]);

  const serviceStats = useMemo(() => ({
    active: services.filter((service) => service.activeState === 'active').length,
    failed: services.filter((service) => service.activeState === 'failed').length,
    inactive: services.filter((service) => service.activeState === 'inactive').length,
    enabled: services.filter((service) => service.enabledState === 'enabled').length,
    disabled: services.filter((service) => service.enabledState === 'disabled').length,
  }), [services]);

  const copyToClipboard = async (value: string, label: string) => {
    setError('');
    setSuccess('');

    try {
      await navigator.clipboard.writeText(value);
      setSuccess(`已复制${label}。`);
    } catch (err) {
      setError(`复制失败：${getErrorMessage(err)}`);
    }
  };

  const executeServiceAction = async (action: ServiceAction, service: RemoteServiceSummary) => {
    setActingAction(action);
    setError('');
    setNotice('');
    setSuccess('');

    try {
      const command = isWindowsHost
        ? getWindowsServiceActionCommand(action, service.name)
        : getLinuxServiceActionCommand(action, service.name);
      const result = await runCmd(connectionId, command);

      if (result.code !== 0) {
        throw new Error(result.stderr || result.stdout || '服务操作失败，可能需要更高权限。');
      }

      setSuccess(`${actionDefinitions[action].success}：${service.name}`);
      await refreshServices({ silent: true, preferredServiceName: service.name });
      await loadServiceDetail(service.name);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      if (isMountedRef.current) {
        setActingAction(null);
        setPendingAction(null);
      }
    }
  };

  const requestServiceAction = (action: ServiceAction) => {
    if (!selectedService) {
      return;
    }

    if (actionDefinitions[action].confirm) {
      setPendingAction({ action, service: selectedService });
      return;
    }

    void executeServiceAction(action, selectedService);
  };

  const refreshCurrentService = async () => {
    const nextSelectedName = await refreshServices({ silent: true, preferredServiceName: selectedServiceName });

    if (nextSelectedName) {
      await loadServiceDetail(nextSelectedName);
    }
  };

  const isActionDisabled = (action: ServiceAction) => {
    if (!selectedService || !selectedDetail || actingAction !== null) {
      return true;
    }

    if (isWindowsHost && action === 'reload') {
      return true;
    }

    if (action === 'start') {
      return selectedDetail.activeState === 'active' || selectedDetail.activeState === 'activating';
    }

    if (action === 'stop') {
      return selectedDetail.activeState === 'inactive' || selectedDetail.activeState === 'deactivating';
    }

    if (action === 'enable') {
      return selectedDetail.enabledState === 'enabled';
    }

    if (action === 'disable') {
      return selectedDetail.enabledState === 'disabled' || selectedDetail.enabledState === 'masked';
    }

    return false;
  };

  const renderActionButton = (action: ServiceAction) => {
    const definition = actionDefinitions[action];
    const disabled = isActionDisabled(action);
    const className = [
      'service-action-btn',
      definition.primary ? 'primary' : '',
      definition.danger ? 'danger' : '',
    ].filter(Boolean).join(' ');

    return (
      <button
        key={action}
        type="button"
        className={className}
        disabled={disabled}
        title={isWindowsHost && action === 'reload' ? 'Windows Services 不支持 reload' : definition.label}
        onClick={() => requestServiceAction(action)}
      >
        {actingAction === action ? '处理中' : definition.label}
      </button>
    );
  };

  const renderServiceListItem = (service: RemoteServiceSummary) => {
    const isSelected = service.name === selectedServiceName;

    return (
      <button
        key={service.name}
        type="button"
        className={`service-list-item ${isSelected ? 'selected' : ''}`}
        onClick={() => setSelectedServiceName(service.name)}
      >
        <span className={`service-state-dot ${getActiveStateTone(service.activeState)}`} />
        <span className="service-list-main">
          <strong title={service.name}>{service.displayName || service.name}</strong>
          <small title={service.description || service.name}>{service.description || service.name}</small>
        </span>
        <span className={`service-enabled-tag ${getEnabledStateTone(service.enabledState)}`}>
          {getEnabledStateLabel(service.enabledState)}
        </span>
      </button>
    );
  };

  return (
    <div className="service-manager">
      <div className="service-toolbar">
        <div className="service-toolbar-left">
          <button type="button" className="service-tool-button primary" onClick={() => void refreshServices()} disabled={loading}>
            {loading ? '刷新中' : '刷新'}
          </button>
          <button type="button" className="service-tool-button" onClick={() => void refreshCurrentService()} disabled={!selectedService || detailLoading}>
            {detailLoading ? '读取中' : '刷新当前'}
          </button>
          <span className="service-system-pill">{isWindowsHost ? 'Windows Services' : 'systemd'}</span>
          <span className="service-summary">
            <strong>{visibleServices.length}</strong> / {services.length}
          </span>
        </div>

        <div className="service-toolbar-right">
          <select
            className="service-select"
            value={filter}
            onChange={(event) => setFilter(event.target.value as ServiceFilter)}
            aria-label="按服务状态筛选"
          >
            {serviceFilters.map((item) => (
              <option key={item.key} value={item.key}>{item.label}</option>
            ))}
          </select>
          <input
            type="search"
            className="service-search"
            placeholder="搜索服务名、描述..."
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      </div>

      {error ? <div className="service-alert danger">{error}</div> : null}
      {notice ? <div className="service-alert info">{notice}</div> : null}
      {success ? <div className="service-alert success">{success}</div> : null}

      <div className="service-content">
        <aside className="service-list-panel" aria-label="服务列表">
          <div className="service-stats">
            <span><strong>{serviceStats.active}</strong> 运行</span>
            <span><strong>{serviceStats.failed}</strong> 失败</span>
            <span><strong>{serviceStats.inactive}</strong> 停止</span>
            <span><strong>{serviceStats.enabled}</strong> 自启</span>
            <span><strong>{serviceStats.disabled}</strong> 禁用</span>
          </div>

          <div className="service-list">
            {visibleServices.length === 0 ? (
              <div className="service-empty">{loading ? '正在加载服务列表...' : '暂无匹配的服务。'}</div>
            ) : (
              visibleServices.map(renderServiceListItem)
            )}
          </div>
        </aside>

        <section className="service-detail-panel" aria-label="服务详情">
          {selectedDetail ? (
            <>
              <header className="service-detail-header">
                <div>
                  <span>服务</span>
                  <strong title={selectedDetail.name}>{selectedDetail.displayName || selectedDetail.name}</strong>
                  <code title={selectedDetail.name}>{selectedDetail.name}</code>
                  {selectedDetail.description ? <p title={selectedDetail.description}>{selectedDetail.description}</p> : null}
                </div>
                <button
                  type="button"
                  className="service-copy-btn"
                  disabled={!currentDetail}
                  onClick={() => currentDetail ? void copyToClipboard(buildDiagnostics(currentDetail), '诊断信息') : undefined}
                >
                  复制诊断
                </button>
              </header>

              <div className="service-overview">
                <div>
                  <span>运行状态</span>
                  <strong className={`service-state-tag ${getActiveStateTone(selectedDetail.activeState)}`}>
                    {getActiveStateLabel(selectedDetail.activeState)}
                  </strong>
                  <small>{selectedDetail.subState || '-'}</small>
                </div>
                <div>
                  <span>自启状态</span>
                  <strong className={`service-enabled-tag ${getEnabledStateTone(selectedDetail.enabledState)}`}>
                    {getEnabledStateLabel(selectedDetail.enabledState)}
                  </strong>
                  <small>{selectedDetail.loadState || '-'}</small>
                </div>
                <div>
                  <span>主 PID</span>
                  <strong>{selectedDetail.pid ?? '-'}</strong>
                  <small>{currentDetail?.memory || '内存未知'}</small>
                </div>
                <div>
                  <span>启动时间</span>
                  <strong title={currentDetail?.startedAt}>{currentDetail?.startedAt || '-'}</strong>
                  <small title={currentDetail?.unitFilePath}>{currentDetail?.unitFilePath || '-'}</small>
                </div>
              </div>

              <div className="service-action-bar" aria-label="服务操作">
                {(['start', 'stop', 'restart', 'reload', 'enable', 'disable'] as ServiceAction[]).map(renderActionButton)}
              </div>

              <div className="service-tabs" role="tablist" aria-label="服务详情标签">
                <button type="button" role="tab" className={tab === 'status' ? 'active' : ''} onClick={() => setTab('status')}>状态</button>
                <button type="button" role="tab" className={tab === 'logs' ? 'active' : ''} onClick={() => setTab('logs')}>日志</button>
                <button type="button" role="tab" className={tab === 'unit' ? 'active' : ''} onClick={() => setTab('unit')}>{isWindowsHost ? '配置' : '单元文件'}</button>
              </div>

              <div className="service-tab-panel">
                {detailLoading && !currentDetail ? <div className="service-empty">正在读取服务详情...</div> : null}
                {!detailLoading || currentDetail ? (
                  <>
                    {tab === 'status' ? (
                      <pre>{currentDetail?.statusText || '暂无状态输出。'}</pre>
                    ) : null}
                    {tab === 'logs' ? (
                      <pre>{currentDetail?.recentLogs || '暂无最近日志。'}</pre>
                    ) : null}
                    {tab === 'unit' ? (
                      <pre>{currentDetail?.unitFileText || '暂无配置内容。'}</pre>
                    ) : null}
                  </>
                ) : null}
              </div>
            </>
          ) : (
            <div className="service-detail-empty">
              <strong>{loading ? '正在加载服务' : '未选中服务'}</strong>
              <span>{loading ? '等待远程服务列表返回。' : '暂无服务详情。'}</span>
            </div>
          )}
        </section>
      </div>

      {pendingAction ? createPortal(
        <div className="service-modal-overlay" role="presentation" onClick={() => setPendingAction(null)}>
          <div
            className="service-modal"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="service-action-confirm-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div id="service-action-confirm-title" className="service-modal-title">
              {actionDefinitions[pendingAction.action].label}服务
            </div>
            <div className="service-modal-message">
              <p>目标服务：<strong>{pendingAction.service.name}</strong></p>
              <p>该操作可能影响远程连接、业务请求或正在执行的后台任务。</p>
              <code>{pendingAction.service.description || pendingAction.service.displayName}</code>
            </div>
            <div className="service-modal-actions">
              <button type="button" className="service-modal-btn" onClick={() => setPendingAction(null)}>取消</button>
              <button type="button" className="service-modal-btn danger" onClick={() => void executeServiceAction(pendingAction.action, pendingAction.service)}>
                确认执行
              </button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}

export default ServiceManager;

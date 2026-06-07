import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import DismissibleAlert from './DismissibleAlert';
import { useSudoCommand } from './sudoPrompt';

import { getErrorMessage, getShellDeskLocale } from './desktopUtils';
import { isWindowsSystem, powershellCommand, powershellSingleQuote } from './remoteSystem';
import type { RemoteSystemType } from './types';
import { tCurrent } from '../../i18n';

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
  { key: 'all', label: tCurrent('auto.remoteServiceManager.q6w6ul') },
  { key: 'active', label: tCurrent('auto.remoteServiceManager.1bywqik') },
  { key: 'failed', label: tCurrent('auto.remoteServiceManager.12db3qz') },
  { key: 'inactive', label: tCurrent('auto.remoteServiceManager.1gqawiz') },
  { key: 'enabled', label: tCurrent('auto.remoteServiceManager.1w2s4cy') },
  { key: 'disabled', label: tCurrent('auto.remoteServiceManager.z0vsqk') },
];

const actionDefinitions: Record<ServiceAction, { label: string; success: string; danger?: boolean; confirm?: boolean; primary?: boolean }> = {
  start: { label: tCurrent('auto.remoteServiceManager.155xe0y'), success: tCurrent('auto.remoteServiceManager.whsqz6'), primary: true },
  stop: { label: tCurrent('auto.remoteServiceManager.1pnni9n'), success: tCurrent('auto.remoteServiceManager.1gqawiz2'), danger: true, confirm: true },
  restart: { label: tCurrent('auto.remoteServiceManager.1fa8wet'), success: tCurrent('auto.remoteServiceManager.18bkm3p'), danger: true, confirm: true },
  reload: { label: 'Reload', success: tCurrent('auto.remoteServiceManager.jqtxq7') },
  enable: { label: tCurrent('auto.remoteServiceManager.15qofhx'), success: tCurrent('auto.remoteServiceManager.1hpotpb') },
  disable: { label: tCurrent('auto.remoteServiceManager.1o6i0tj'), success: tCurrent('auto.remoteServiceManager.1hxu1y5') },
};

const activeStateOrder: Record<RemoteServiceActiveState, number> = {
  failed: 0,
  active: 1,
  activating: 2,
  deactivating: 3,
  inactive: 4,
  unknown: 5,
};

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
  if (state === 'active') return tCurrent('auto.remoteServiceManager.1bywqik2');
  if (state === 'failed') return tCurrent('auto.remoteServiceManager.12db3qz2');
  if (state === 'inactive') return tCurrent('auto.remoteServiceManager.1gqawiz3');
  if (state === 'activating') return tCurrent('auto.remoteServiceManager.1y1d41p');
  if (state === 'deactivating') return tCurrent('auto.remoteServiceManager.1rzrzxe');
  return tCurrent('auto.remoteServiceManager.1lpnuh4');
}

function getEnabledStateLabel(state?: RemoteServiceEnabledState) {
  if (state === 'enabled') return tCurrent('auto.remoteServiceManager.1w2s4cy2');
  if (state === 'disabled') return tCurrent('auto.remoteServiceManager.z0vsqk2');
  if (state === 'static') return tCurrent('auto.remoteServiceManager.sb4a45');
  if (state === 'masked') return tCurrent('auto.remoteServiceManager.15rk3jd');
  return tCurrent('auto.remoteServiceManager.1lpnuh42');
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
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  printf '${SERVICE_LIST_UNITS_MARKER}\\n'
  systemctl list-units --type=service --all --no-pager --plain --no-legend 2>/dev/null | awk 'BEGIN{OFS="\\t"} NF >= 4 { unit=$1; load=$2; active=$3; sub=$4; desc=""; for (i=5; i<=NF; i++) desc=desc (i>5?" ":"") $i; print unit, load, active, sub, desc }'
  printf '${SERVICE_LIST_UNIT_FILES_MARKER}\\n'
  systemctl list-unit-files --type=service --no-pager --plain --no-legend 2>/dev/null | awk 'BEGIN{OFS="\\t"} NF >= 2 { print $1, $2 }'
  exit 0
fi

if command -v rc-service >/dev/null 2>&1 && [ -d /etc/init.d ]; then
  shelldesk_openrc_state() {
    state_text="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
    case "$state_text" in
      *crashed*|*failed*|*error*) printf 'failed\\tfailed' ;;
      *starting*) printf 'activating\\tstarting' ;;
      *stopping*) printf 'deactivating\\tstopping' ;;
      *started*|*running*) printf 'active\\trunning' ;;
      *stopped*|*inactive*) printf 'inactive\\tstopped' ;;
      *) printf 'unknown\\tunknown' ;;
    esac
  }

  enabled_services="$(
    if command -v rc-update >/dev/null 2>&1; then
      rc-update show 2>/dev/null | awk -F'|' 'NF >= 2 { name=$1; gsub(/^[[:space:]]+|[[:space:]]+$/, "", name); if (name != "") print name }' | sort -u
    fi
  )"

  printf '${SERVICE_LIST_UNITS_MARKER}\\n'
  for script in /etc/init.d/*; do
    [ -f "$script" ] || continue
    name="\${script##*/}"
    [ -n "$name" ] || continue
    status_output="$(rc-service "$name" status 2>&1 || true)"
    state_pair="$(shelldesk_openrc_state "$status_output")"
    active_state="\${state_pair%%	*}"
    sub_state="\${state_pair#*	}"
    description="$(awk -F= '/^[[:space:]]*description=/ { value=$0; sub(/^[^=]*=/, "", value); gsub(/^[[:space:]]+|[[:space:]]+$/, "", value); gsub(/^"/, "", value); gsub(/"$/, "", value); print value; exit }' "$script" 2>/dev/null)"
    printf '%s\\topenrc\\t%s\\t%s\\t%s\\n' "$name" "$active_state" "$sub_state" "$description"
  done | sort

  printf '${SERVICE_LIST_UNIT_FILES_MARKER}\\n'
  for script in /etc/init.d/*; do
    [ -f "$script" ] || continue
    name="\${script##*/}"
    [ -n "$name" ] || continue
    enabled_state="disabled"
    if printf '%s\\n' "$enabled_services" | grep -Fxq "$name" 2>/dev/null; then
      enabled_state="enabled"
    fi
    printf '%s\\t%s\\n' "$name" "$enabled_state"
  done | sort
  exit 0
fi

printf '${SERVICE_LIST_ERROR_PREFIX}%s\\n' 'systemctl / OpenRC rc-service 未安装或当前 PATH 不可用。'
exit 0
`;
}

function getLinuxServiceDetailCommand(serviceName: string) {
  const unit = shellSingleQuote(serviceName);

  return `
unit=${unit}
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  printf '${SERVICE_DETAIL_PROPS_MARKER}\\n'
  systemctl show "$unit" --no-pager -p Id -p Description -p LoadState -p ActiveState -p SubState -p UnitFileState -p MainPID -p MemoryCurrent -p FragmentPath -p ActiveEnterTimestamp -p ExecMainStartTimestamp 2>&1 || true
  printf '${SERVICE_DETAIL_STATUS_MARKER}\\n'
  systemctl status "$unit" --no-pager --lines=80 2>&1 || true
  printf '${SERVICE_DETAIL_LOGS_MARKER}\\n'
  if command -v journalctl >/dev/null 2>&1; then
    journalctl -u "$unit" -n 100 --no-pager --output=short-iso 2>&1 || true
  else
    printf 'journalctl 不可用。\\n'
  fi
  printf '${SERVICE_DETAIL_UNIT_MARKER}\\n'
  systemctl cat "$unit" --no-pager 2>&1 || true
  exit 0
fi

if command -v rc-service >/dev/null 2>&1 && [ -d /etc/init.d ]; then
  service_name="\${unit%.service}"
  script_path="/etc/init.d/$service_name"
  status_output="$(rc-service "$service_name" status 2>&1 || true)"
  state_text="$(printf '%s' "$status_output" | tr '[:upper:]' '[:lower:]')"
  active_state="unknown"
  sub_state="unknown"
  case "$state_text" in
    *crashed*|*failed*|*error*) active_state="failed"; sub_state="failed" ;;
    *starting*) active_state="activating"; sub_state="starting" ;;
    *stopping*) active_state="deactivating"; sub_state="stopping" ;;
    *started*|*running*) active_state="active"; sub_state="running" ;;
    *stopped*|*inactive*) active_state="inactive"; sub_state="stopped" ;;
  esac
  enabled_state="disabled"
  enabled_runlevels="$(
    if command -v rc-update >/dev/null 2>&1; then
      rc-update show 2>/dev/null | awk -F'|' -v svc="$service_name" 'NF >= 2 { name=$1; runlevel=$2; gsub(/^[[:space:]]+|[[:space:]]+$/, "", name); gsub(/^[[:space:]]+|[[:space:]]+$/, "", runlevel); if (name == svc && runlevel != "") print runlevel }'
    fi
  )"
  if [ -n "$enabled_runlevels" ]; then
    enabled_state="enabled"
  fi
  description=""
  if [ -f "$script_path" ]; then
    description="$(awk -F= '/^[[:space:]]*description=/ { value=$0; sub(/^[^=]*=/, "", value); gsub(/^[[:space:]]+|[[:space:]]+$/, "", value); gsub(/^"/, "", value); gsub(/"$/, "", value); print value; exit }' "$script_path" 2>/dev/null)"
  fi

  printf '${SERVICE_DETAIL_PROPS_MARKER}\\n'
  printf 'Id=%s\\n' "$service_name"
  printf 'Description=%s\\n' "$description"
  printf 'LoadState=openrc\\n'
  printf 'ActiveState=%s\\n' "$active_state"
  printf 'SubState=%s\\n' "$sub_state"
  printf 'UnitFileState=%s\\n' "$enabled_state"
  printf 'MainPID=0\\n'
  printf 'MemoryCurrent=\\n'
  printf 'FragmentPath=%s\\n' "$script_path"
  printf 'ActiveEnterTimestamp=\\n'
  printf 'ExecMainStartTimestamp=\\n'
  printf 'OpenRCRunlevels=%s\\n' "$(printf '%s' "$enabled_runlevels" | tr '\\n' ' ')"

  printf '${SERVICE_DETAIL_STATUS_MARKER}\\n'
  printf '%s\\n' "$status_output"
  if command -v rc-status >/dev/null 2>&1; then
    printf '\\n-- rc-status --\\n'
    rc-status -a 2>&1 | grep -i "$service_name" || true
  fi

  printf '${SERVICE_DETAIL_LOGS_MARKER}\\n'
  if [ -f "/var/log/$service_name.log" ]; then
    tail -n 100 "/var/log/$service_name.log" 2>&1 || true
  elif [ -f /var/log/messages ]; then
    grep -i "$service_name" /var/log/messages 2>/dev/null | tail -n 100 || true
  elif command -v logread >/dev/null 2>&1; then
    logread 2>/dev/null | grep -i "$service_name" | tail -n 100 || true
  else
    printf 'OpenRC 未提供 journalctl；可查看 /var/log/messages 或服务自己的日志文件。\\n'
  fi

  printf '${SERVICE_DETAIL_UNIT_MARKER}\\n'
  if [ -f "$script_path" ]; then
    sed -n '1,240p' "$script_path" 2>&1 || true
  else
    printf '未找到 OpenRC 脚本：%s\\n' "$script_path"
  fi
  exit 0
fi

printf '${SERVICE_LIST_ERROR_PREFIX}%s\\n' 'systemctl / OpenRC rc-service 未安装或当前 PATH 不可用。'
exit 127
`;
}

function getLinuxServiceActionCommand(action: ServiceAction, serviceName: string) {
  const unit = shellSingleQuote(serviceName);
  const actionName = shellSingleQuote(action);

  return `
unit=${unit}
service_action=${actionName}

run_maybe_sudo() {
  if [ "$(id -u 2>/dev/null)" = "0" ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    sudo -n "$@"
  else
    "$@"
  fi
}

if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  run_maybe_sudo systemctl "$service_action" "$unit" 2>&1
  exit $?
fi

if command -v rc-service >/dev/null 2>&1; then
  service_name="\${unit%.service}"
  case "$service_action" in
    start|stop|restart|reload)
      run_maybe_sudo rc-service "$service_name" "$service_action" 2>&1
      exit $?
      ;;
    enable)
      if ! command -v rc-update >/dev/null 2>&1; then
        printf 'rc-update 未安装，无法设置 OpenRC 开机自启。\\n' >&2
        exit 127
      fi
      run_maybe_sudo rc-update add "$service_name" default 2>&1
      exit $?
      ;;
    disable)
      if ! command -v rc-update >/dev/null 2>&1; then
        printf 'rc-update 未安装，无法关闭 OpenRC 开机自启。\\n' >&2
        exit 127
      fi
      runlevels="$(rc-update show 2>/dev/null | awk -F'|' -v svc="$service_name" 'NF >= 2 { name=$1; runlevel=$2; gsub(/^[[:space:]]+|[[:space:]]+$/, "", name); gsub(/^[[:space:]]+|[[:space:]]+$/, "", runlevel); if (name == svc && runlevel != "") print runlevel }')"
      if [ -z "$runlevels" ]; then
        runlevels="default"
      fi
      status=0
      for runlevel in $runlevels; do
        run_maybe_sudo rc-update del "$service_name" "$runlevel" 2>&1 || status=$?
      done
      exit "$status"
      ;;
  esac
fi

printf 'systemctl / OpenRC rc-service 未安装或当前 PATH 不可用。\\n' >&2
exit 127
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

  return powershellCommand(tCurrent('auto.remoteServiceManager.1lwtgdd', { value0: nameLiteral, value1: SERVICE_DETAIL_PROPS_MARKER, value2: SERVICE_DETAIL_STATUS_MARKER, value3: SERVICE_DETAIL_LOGS_MARKER, value4: SERVICE_DETAIL_UNIT_MARKER }));
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
    throw new Error(tCurrent('auto.remoteServiceManager.i10mpj'));
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
    tCurrent('auto.remoteServiceManager.xu4exe', { value0: detail.name }),
    tCurrent('auto.remoteServiceManager.19zuh6d', { value0: detail.description || '-' }),
    tCurrent('auto.remoteServiceManager.63g5ui', { value0: getActiveStateLabel(detail.activeState), value1: detail.subState || '-' }),
    tCurrent('auto.remoteServiceManager.gmr5v2', { value0: getEnabledStateLabel(detail.enabledState) }),
    `PID：${detail.pid ?? '-'}`,
    tCurrent('auto.remoteServiceManager.1kz76i3', { value0: detail.memory || '-' }),
    tCurrent('auto.remoteServiceManager.1funla3', { value0: detail.startedAt || '-' }),
    tCurrent('auto.remoteServiceManager.1yhlo60', { value0: detail.unitFilePath || '-' }),
    '',
    '--- status ---',
    detail.statusText || tCurrent('auto.remoteServiceManager.plwf7b'),
    '',
    '--- logs ---',
    detail.recentLogs || tCurrent('auto.remoteServiceManager.1trc75o'),
  ].join('\n');
}

function ServiceManager({ connectionId, systemType }: RemoteServiceManagerProps) {
  const isWindowsHost = isWindowsSystem(systemType);
  const { runCommand, sudoPrompt } = useSudoCommand(connectionId, systemType);
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
      const result = await runCommand(isWindowsHost ? getWindowsServiceListCommand() : getLinuxServiceListCommand());
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
        setError(result.stderr || result.stdout || tCurrent('auto.remoteServiceManager.9ku5cr'));
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
  }, [isWindowsHost, runCommand]);

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
      const result = await runCommand(isWindowsHost ? getWindowsServiceDetailCommand(serviceName) : getLinuxServiceDetailCommand(serviceName));
      const fallback = services.find((service) => service.name === serviceName);
      const nextDetail = isWindowsHost
        ? parseWindowsServiceDetailOutput(result.stdout || '', serviceName, fallback)
        : parseLinuxServiceDetailOutput(result.stdout || '', serviceName, fallback);

      if (result.code !== 0 && !nextDetail.statusText) {
        throw new Error(result.stderr || result.stdout || tCurrent('auto.remoteServiceManager.50a08u'));
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
  }, [isWindowsHost, runCommand, services]);

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
  const serviceBackendLabel = isWindowsHost
    ? 'Windows Services'
    : services.some((service) => service.loadState === 'openrc') || currentDetail?.loadState === 'openrc'
      ? 'OpenRC'
      : 'systemd';

  const copyToClipboard = async (value: string, label: string) => {
    setError('');
    setSuccess('');

    try {
      await navigator.clipboard.writeText(value);
      setSuccess(tCurrent('auto.remoteServiceManager.1wvs77j', { value0: label }));
    } catch (err) {
      setError(tCurrent('auto.remoteServiceManager.cd1xgf', { value0: getErrorMessage(err) }));
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
      const result = await runCommand(command);

      if (result.code !== 0) {
        throw new Error(result.stderr || result.stdout || tCurrent('auto.remoteServiceManager.pbnt82'));
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
        title={isWindowsHost && action === 'reload' ? tCurrent('auto.remoteServiceManager.bl36ui') : definition.label}
        onClick={() => requestServiceAction(action)}
      >
        {actingAction === action ? tCurrent('auto.remoteServiceManager.1h3kna') : definition.label}
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
            {loading ? tCurrent('auto.remoteServiceManager.1taxqz1') : tCurrent('auto.remoteServiceManager.12qo56a')}
          </button>
          <button type="button" className="service-tool-button" onClick={() => void refreshCurrentService()} disabled={!selectedService || detailLoading}>
            {detailLoading ? tCurrent('auto.remoteServiceManager.10y5j8r') : tCurrent('auto.remoteServiceManager.146hdy2')}
          </button>
          <span className="service-system-pill">{serviceBackendLabel}</span>
          <span className="service-summary">
            <strong>{visibleServices.length}</strong> / {services.length}
          </span>
        </div>

        <div className="service-toolbar-right">
          <select
            className="service-select"
            value={filter}
            onChange={(event) => setFilter(event.target.value as ServiceFilter)}
            aria-label={tCurrent('auto.remoteServiceManager.jw61qj')}
          >
            {serviceFilters.map((item) => (
              <option key={item.key} value={item.key}>{item.label}</option>
            ))}
          </select>
          <input
            type="search"
            className="service-search"
            placeholder={tCurrent('auto.remoteServiceManager.11xkl8e')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      </div>

      {error ? <DismissibleAlert className="service-alert danger" onDismiss={() => setError('')} role="alert">{error}</DismissibleAlert> : null}
      {notice ? <DismissibleAlert className="service-alert info" onDismiss={() => setNotice('')}>{notice}</DismissibleAlert> : null}
      {success ? <DismissibleAlert className="service-alert success" onDismiss={() => setSuccess('')}>{success}</DismissibleAlert> : null}

      <div className="service-content">
        <aside className="service-list-panel" aria-label={tCurrent('auto.remoteServiceManager.yphmo4')}>
          <div className="service-stats">
            <span><strong>{serviceStats.active}</strong> {tCurrent('auto.remoteServiceManager.1kn0p6h')}</span>
            <span><strong>{serviceStats.failed}</strong> {tCurrent('auto.remoteServiceManager.12db3qz3')}</span>
            <span><strong>{serviceStats.inactive}</strong> {tCurrent('auto.remoteServiceManager.1pnni9n2')}</span>
            <span><strong>{serviceStats.enabled}</strong> {tCurrent('auto.remoteServiceManager.qv0fiu')}</span>
            <span><strong>{serviceStats.disabled}</strong> {tCurrent('auto.remoteServiceManager.1dcdrxo')}</span>
          </div>

          <div className="service-list">
            {visibleServices.length === 0 ? (
              <div className="service-empty">{loading ? tCurrent('auto.remoteServiceManager.xfi9sa') : tCurrent('auto.remoteServiceManager.1eh7d0x')}</div>
            ) : (
              visibleServices.map(renderServiceListItem)
            )}
          </div>
        </aside>

        <section className="service-detail-panel" aria-label={tCurrent('auto.remoteServiceManager.y5zpae')}>
          {selectedDetail ? (
            <>
              <header className="service-detail-header">
                <span className="service-detail-header-label">{tCurrent('auto.remoteServiceManager.2yn6uz')}</span>
                <strong title={selectedDetail.name}>{selectedDetail.displayName || selectedDetail.name}</strong>
                {selectedDetail.displayName && selectedDetail.displayName !== selectedDetail.name ? (
                  <code title={selectedDetail.name}>{selectedDetail.name}</code>
                ) : null}
                {selectedDetail.description ? <small className="service-detail-header-desc" title={selectedDetail.description}>{selectedDetail.description}</small> : null}
                <button
                  type="button"
                  className="service-copy-btn"
                  disabled={!currentDetail}
                  onClick={() => currentDetail ? void copyToClipboard(buildDiagnostics(currentDetail), tCurrent('auto.remoteServiceManager.i62n38')) : undefined}
                >
                  {tCurrent('auto.remoteServiceManager.4zl8tz')}</button>
              </header>

              <div className="service-overview">
                <div>
                  <span>{tCurrent('auto.remoteServiceManager.1ihgm6s')}</span>
                  <strong className={`service-state-tag ${getActiveStateTone(selectedDetail.activeState)}`}>
                    {getActiveStateLabel(selectedDetail.activeState)}
                  </strong>
                  <small>{selectedDetail.subState || '-'}</small>
                </div>
                <div>
                  <span>{tCurrent('auto.remoteServiceManager.cp1ltf')}</span>
                  <strong className={`service-enabled-tag ${getEnabledStateTone(selectedDetail.enabledState)}`}>
                    {getEnabledStateLabel(selectedDetail.enabledState)}
                  </strong>
                  <small>{selectedDetail.loadState || '-'}</small>
                </div>
                <div>
                  <span>{tCurrent('auto.remoteServiceManager.1yaznnb')}</span>
                  <strong>{selectedDetail.pid ?? '-'}</strong>
                  <small>{currentDetail?.memory || tCurrent('auto.remoteServiceManager.1h7wyah')}</small>
                </div>
                <div>
                  <span>{tCurrent('auto.remoteServiceManager.vosj20')}</span>
                  <strong title={currentDetail?.startedAt}>{currentDetail?.startedAt || '-'}</strong>
                  <small title={currentDetail?.unitFilePath}>{currentDetail?.unitFilePath || '-'}</small>
                </div>
              </div>

              <div className="service-action-bar" aria-label={tCurrent('auto.remoteServiceManager.1s14vay')}>
                {(['start', 'stop', 'restart', 'reload', 'enable', 'disable'] as ServiceAction[]).map(renderActionButton)}
              </div>

              <div className="service-tabs" role="tablist" aria-label={tCurrent('auto.remoteServiceManager.ldcehj')}>
                <button type="button" role="tab" className={tab === 'status' ? 'active' : ''} onClick={() => setTab('status')}>{tCurrent('auto.remoteServiceManager.1ccx4t4')}</button>
                <button type="button" role="tab" className={tab === 'logs' ? 'active' : ''} onClick={() => setTab('logs')}>{tCurrent('auto.remoteServiceManager.1k863h1')}</button>
                <button type="button" role="tab" className={tab === 'unit' ? 'active' : ''} onClick={() => setTab('unit')}>{isWindowsHost ? tCurrent('auto.remoteServiceManager.1x99t4y') : tCurrent('auto.remoteServiceManager.1v8qcac')}</button>
              </div>

              <div className="service-tab-panel">
                {detailLoading && !currentDetail ? <div className="service-empty">{tCurrent('auto.remoteServiceManager.1u5wcce')}</div> : null}
                {!detailLoading || currentDetail ? (
                  <>
                    {tab === 'status' ? (
                      <pre>{currentDetail?.statusText || tCurrent('auto.remoteServiceManager.1om6ffz')}</pre>
                    ) : null}
                    {tab === 'logs' ? (
                      <pre>{currentDetail?.recentLogs || tCurrent('auto.remoteServiceManager.m9goey')}</pre>
                    ) : null}
                    {tab === 'unit' ? (
                      <pre>{currentDetail?.unitFileText || tCurrent('auto.remoteServiceManager.1tjd2jc')}</pre>
                    ) : null}
                  </>
                ) : null}
              </div>
            </>
          ) : (
            <div className="service-detail-empty">
              <strong>{loading ? tCurrent('auto.remoteServiceManager.10xzg2z') : tCurrent('auto.remoteServiceManager.1wyr1zl')}</strong>
              <span>{loading ? tCurrent('auto.remoteServiceManager.1apozs9') : tCurrent('auto.remoteServiceManager.7yu0aa')}</span>
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
              {actionDefinitions[pendingAction.action].label}{tCurrent('auto.remoteServiceManager.2yn6uz2')}</div>
            <div className="service-modal-message">
              <p>{tCurrent('auto.remoteServiceManager.g66cve')}<strong>{pendingAction.service.name}</strong></p>
              <p>{tCurrent('auto.remoteServiceManager.1b1spgs')}</p>
              <code>{pendingAction.service.description || pendingAction.service.displayName}</code>
            </div>
            <div className="service-modal-actions">
              <button type="button" className="service-modal-btn" onClick={() => setPendingAction(null)}>{tCurrent('auto.remoteServiceManager.1589w37')}</button>
              <button type="button" className="service-modal-btn danger" onClick={() => void executeServiceAction(pendingAction.action, pendingAction.service)}>
                {tCurrent('auto.remoteServiceManager.1lw0tr0')}</button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
      {sudoPrompt}
    </div>
  );
}

export default ServiceManager;

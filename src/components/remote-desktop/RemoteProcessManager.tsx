import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import DismissibleAlert from './DismissibleAlert';

import { t, translateStructuredText, type AppLanguage, type MessageId } from '../../i18n';
import { getErrorMessage, getShellDeskLocale } from './desktopUtils';
import MarkdownReport from './MarkdownReport';
import { isWindowsSystem, powershellCommand, powershellStdinCommand } from './remoteSystem';
import { useSudoCommand } from './sudoPrompt';
import type { RemoteSystemType } from './types';

export type RemoteProcessManagerSortKey =
  | 'pid'
  | 'ppid'
  | 'user'
  | 'cpu'
  | 'memory'
  | 'state'
  | 'startTime'
  | 'runtime'
  | 'command';

export type RemoteProcessManagerViewMode = 'table' | 'tree';

export interface RemoteProcessManagerLaunchOptions {
  pid?: number;
  search?: string;
  user?: string;
  sortKey?: RemoteProcessManagerSortKey;
  sortDir?: SortDir;
  viewMode?: RemoteProcessManagerViewMode;
}

interface RemoteProcessManagerProps {
  connectionId: string;
  settings: ShellDeskAppSettings;
  systemType?: RemoteSystemType;
  launchOptions?: RemoteProcessManagerLaunchOptions;
}

export interface RemoteProcessEntry {
  pid: number;
  ppid?: number;
  user?: string;
  cpuPercent?: number;
  cpuSeconds?: number;
  memoryPercent?: number;
  memoryMb?: number;
  state?: string;
  startTime?: string;
  runtime?: string;
  cpuTime?: string;
  tty?: string;
  vszKb?: number;
  rssKb?: number;
  command: string;
  executablePath?: string;
}

interface ProcessDetail {
  pid: number;
  cwd?: string;
  executablePath?: string;
  ports: string[];
  loadedAt: number;
  error?: string;
}

interface ProcessRow {
  process: RemoteProcessEntry;
  depth: number;
}

type SortDir = 'asc' | 'desc';

interface SignalDefinition {
  value: string;
  name: string;
  label: string;
  descriptionId: MessageId;
}

interface PendingSignal {
  pid: number;
  command: string;
  signal: SignalDefinition;
}

interface ProcessContextMenuState {
  x: number;
  y: number;
  process: RemoteProcessEntry;
}

type ProcessAiReportPhase = 'idle' | 'preparing' | 'requesting' | 'streaming' | 'done' | 'error';

interface ProcessAiSnapshot {
  text: string;
  includedCount: number;
  omittedCount: number;
}

interface ProcessAiInsight {
  pid: number;
  content: string;
  error?: string;
}

const SIGNALS: SignalDefinition[] = [
  {
    value: '15',
    name: 'TERM',
    label: 'TERM',
    descriptionId: 'process.signal.term.description',
  },
  {
    value: '9',
    name: 'KILL',
    label: 'KILL',
    descriptionId: 'process.signal.kill.description',
  },
  {
    value: '2',
    name: 'INT',
    label: 'INT',
    descriptionId: 'process.signal.int.description',
  },
  {
    value: '1',
    name: 'HUP',
    label: 'HUP',
    descriptionId: 'process.signal.hup.description',
  },
];

const AUTO_REFRESH_OPTIONS = [3000, 5000, 10000] as const;
const DEFAULT_AUTO_REFRESH_MS = 5000;
const DEFAULT_SIGNAL = SIGNALS[0];
const PROCESS_AI_SNAPSHOT_CHAR_LIMIT = 100000;
const PROCESS_AI_FIELD_CHAR_LIMIT = 260;

function getProcessContextMenuPosition(clientX: number, clientY: number) {
  const menuWidth = 184;
  const menuHeight = 172;
  const edgePadding = 8;
  const maxX = Math.max(edgePadding, window.innerWidth - menuWidth - edgePadding);
  const maxY = Math.max(edgePadding, window.innerHeight - menuHeight - edgePadding);

  return {
    x: Math.min(Math.max(edgePadding, clientX), maxX),
    y: Math.min(Math.max(edgePadding, clientY), maxY),
  };
}

function readInteger(value: string | number | undefined | null) {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value;
  }

  if (typeof value !== 'string') {
    return undefined;
  }

  const parsedValue = Number.parseInt(value, 10);
  return Number.isInteger(parsedValue) ? parsedValue : undefined;
}

function readNumber(value: string | number | undefined | null) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value !== 'string' || !value.trim() || value === '-') {
    return undefined;
  }

  const parsedValue = Number.parseFloat(value);
  return Number.isFinite(parsedValue) ? parsedValue : undefined;
}

function clampPercent(value: number | undefined) {
  if (value === undefined) {
    return 0;
  }

  return Math.min(Math.max(value, 0), 100);
}

function formatMetric(value: number | undefined, suffix = '') {
  if (value === undefined || !Number.isFinite(value)) {
    return '-';
  }

  const formattedValue = value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2);
  return `${formattedValue.replace(/\.00$/, '').replace(/(\.\d)0$/, '$1')}${suffix}`;
}

function formatMemory(process: RemoteProcessEntry, isWindowsHost: boolean) {
  if (isWindowsHost) {
    return formatMetric(process.memoryMb, ' MB');
  }

  return formatMetric(process.memoryPercent, '%');
}

function formatCpu(process: RemoteProcessEntry, isWindowsHost: boolean) {
  if (isWindowsHost) {
    return formatMetric(process.cpuSeconds, 's');
  }

  return formatMetric(process.cpuPercent, '%');
}

function getCpuValue(process: RemoteProcessEntry, isWindowsHost: boolean) {
  return isWindowsHost ? process.cpuSeconds ?? 0 : process.cpuPercent ?? 0;
}

function getMemoryValue(process: RemoteProcessEntry, isWindowsHost: boolean) {
  return isWindowsHost ? process.memoryMb ?? 0 : process.memoryPercent ?? 0;
}

function compactAiField(value: string | number | undefined | null, maxLength = PROCESS_AI_FIELD_CHAR_LIMIT) {
  if (value === undefined || value === null || value === '') {
    return '-';
  }

  const normalizedValue = String(value).replace(/\s+/g, ' ').trim();

  if (normalizedValue.length <= maxLength) {
    return normalizedValue || '-';
  }

  return `${normalizedValue.slice(0, maxLength)}...`;
}

function getAiReadinessError(settings: ShellDeskAppSettings, language: AppLanguage) {
  const aiControls = window.guiSSH?.ai;

  if (!aiControls?.chat && !aiControls?.chatStream) {
    return t('process.error.noAiChat', language);
  }

  if (
    !settings.aiApiBaseUrl.trim() ||
    (settings.aiApiFormat === 'anthropic' && !settings.aiApiKey.trim()) ||
    !settings.aiModel.trim()
  ) {
    return t('process.error.aiConfigRequired', language);
  }

  return '';
}

function createAiChatRequest(
  settings: ShellDeskAppSettings,
  messages: ShellDeskAiChatMessage[],
  temperature = 0.2,
): ShellDeskAiChatRequest {
  return {
    provider: settings.aiProvider,
    apiFormat: settings.aiApiFormat,
    apiBaseUrl: settings.aiApiBaseUrl,
    apiKey: settings.aiApiKey,
    model: settings.aiModel,
    temperature,
    messages: messages.map((message) => ({
      ...message,
      content: translateStructuredText(message.content, settings.language),
    })),
  };
}

function formatProcessAiLine(process: RemoteProcessEntry, isWindowsHost: boolean, index: number) {
  return [
    `#${index + 1}`,
    `pid=${process.pid}`,
    `ppid=${process.ppid ?? '-'}`,
    `user=${compactAiField(process.user)}`,
    `cpu=${compactAiField(formatCpu(process, isWindowsHost))}`,
    `memory=${compactAiField(formatMemory(process, isWindowsHost))}`,
    `state=${compactAiField(process.state)}`,
    `start=${compactAiField(process.startTime)}`,
    `runtime=${compactAiField(process.runtime || process.cpuTime)}`,
    `tty=${compactAiField(process.tty)}`,
    `path=${compactAiField(process.executablePath)}`,
    `command=${compactAiField(process.command)}`,
  ].join('\t');
}

function createProcessAiSnapshot(processes: RemoteProcessEntry[], isWindowsHost: boolean, language: AppLanguage): ProcessAiSnapshot {
  const header = [
    `system=${isWindowsHost ? 'Windows' : 'Linux/Unix'}`,
    `processCount=${processes.length}`,
    `snapshotAt=${new Date().toISOString()}`,
    'fields=index, pid, ppid, user, cpu, memory, state, start, runtime, tty, path, command',
  ].join('\n');
  let text = `${header}\n`;
  let includedCount = 0;

  for (const [index, process] of processes.entries()) {
    const line = formatProcessAiLine(process, isWindowsHost, index);

    if (text.length + line.length + 1 > PROCESS_AI_SNAPSHOT_CHAR_LIMIT) {
      break;
    }

    text += `${line}\n`;
    includedCount += 1;
  }

  const omittedCount = Math.max(0, processes.length - includedCount);

  if (omittedCount > 0) {
    text += `\n${t('process.ai.snapshotOmitted', language, { count: omittedCount })}\n`;
  }

  return {
    text,
    includedCount,
    omittedCount,
  };
}

function formatProcessContextForAi(
  process: RemoteProcessEntry,
  isWindowsHost: boolean,
  detail: ProcessDetail | null,
  parent: RemoteProcessEntry | null,
  children: RemoteProcessEntry[],
  language: AppLanguage,
) {
  return [
    t('process.ai.context.system', language, { system: isWindowsHost ? 'Windows' : 'Linux/Unix' }),
    `PID：${process.pid}`,
    `PPID：${process.ppid ?? '-'}`,
    t('process.ai.context.user', language, { user: compactAiField(process.user) }),
    `CPU：${formatCpu(process, isWindowsHost)}`,
    t('process.ai.context.memory', language, { memory: formatMemory(process, isWindowsHost) }),
    t('process.ai.context.state', language, { state: compactAiField(process.state) }),
    t('process.ai.context.start', language, { start: compactAiField(process.startTime) }),
    t('process.ai.context.runtime', language, { runtime: compactAiField(process.runtime || process.cpuTime) }),
    `TTY：${compactAiField(process.tty)}`,
    t('process.ai.context.path', language, { path: compactAiField(detail?.executablePath || process.executablePath, 500) }),
    t('process.ai.context.cwd', language, { cwd: compactAiField(detail?.cwd, 500) }),
    t('process.ai.context.command', language, { command: compactAiField(process.command, 900) }),
    t('process.ai.context.parent', language, { parent: parent ? `${parent.pid} ${compactAiField(parent.command, 300)}` : '-' }),
    t('process.ai.context.children', language, {
      children: children.length ? children.slice(0, 8).map((child) => `${child.pid} ${compactAiField(child.command, 180)}`).join(' | ') : '-',
    }),
    t('process.ai.context.ports', language, {
      ports: detail?.ports.length ? detail.ports.slice(0, 12).map((port) => compactAiField(port, 180)).join(' | ') : '-',
    }),
  ].join('\n');
}

function getAiReportPhaseLabel(phase: ProcessAiReportPhase, language: AppLanguage) {
  if (phase === 'preparing') return t('process.ai.phase.preparing', language);
  if (phase === 'requesting') return t('process.ai.phase.requesting', language);
  if (phase === 'streaming') return t('process.ai.phase.streaming', language);
  if (phase === 'done') return t('process.ai.phase.done', language);
  if (phase === 'error') return t('process.ai.phase.error', language);
  return t('process.ai.phase.idle', language);
}

function createAiReportDocument(report: string, generatedAt: string, snapshotNote: string, language: AppLanguage) {
  return [
    t('process.ai.report.documentTitle', language),
    generatedAt ? t('process.ai.report.generatedAt', language, { time: generatedAt }) : '',
    snapshotNote,
    '',
    report.trim(),
  ].filter(Boolean).join('\n');
}

function createAiReportFileName() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `shelldesk-process-ai-report-${timestamp}.md`;
}

function createStreamedTextUpdater(setText: (value: string) => void, fallbackText: string) {
  let nextText = '';
  let timerId: number | undefined;

  const doFlush = () => {
    timerId = undefined;
    setText(nextText || fallbackText);
  };

  return {
    append(chunk: string) {
      nextText += chunk;

      if (timerId !== undefined) {
        return;
      }

      timerId = window.setTimeout(doFlush, 250);
    },
    cancel() {
      if (timerId !== undefined) {
        window.clearTimeout(timerId);
        timerId = undefined;
      }
    },
    flush() {
      if (timerId !== undefined) {
        window.clearTimeout(timerId);
      }

      doFlush();
    },
  };
}

function getSignalByValue(value: string) {
  return SIGNALS.find((signal) => signal.value === value) ?? DEFAULT_SIGNAL;
}

function getVisibleProcessSortKey(sortKey: RemoteProcessManagerSortKey | undefined): RemoteProcessManagerSortKey {
  if (sortKey && sortKey !== 'state' && sortKey !== 'startTime' && sortKey !== 'runtime') {
    return sortKey;
  }

  return 'cpu';
}

function getLinuxSignalCommand(signalValue: string, pid: number) {
  const signal = getSignalByValue(signalValue).value;

  return `
if [ "$(id -u 2>/dev/null)" = "0" ]; then
  kill -${signal} ${pid} 2>&1
elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
  sudo -n kill -${signal} ${pid} 2>&1
else
  kill -${signal} ${pid} 2>&1
fi
`;
}

function parseLinuxProcessLine(line: string, language: AppLanguage): RemoteProcessEntry | null {
  const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s*(.*)$/);

  if (!match) {
    return null;
  }

  const pid = readInteger(match[1]);

  if (pid === undefined) {
    return null;
  }

  return {
    pid,
    ppid: readInteger(match[2]),
    user: match[3] || '-',
    cpuPercent: readNumber(match[4]),
    memoryPercent: readNumber(match[5]),
    vszKb: readInteger(match[6]),
    rssKb: readInteger(match[7]),
    tty: match[8],
    state: match[9],
    startTime: match[10],
    runtime: match[11],
    cpuTime: match[12],
    command: match[13]?.trim() || t('process.placeholder.noCommand', language),
  };
}

function parsePsAuxLine(line: string, language: AppLanguage): RemoteProcessEntry | null {
  const parts = line.trim().split(/\s+/);

  if (parts.length < 11 || parts[0].toUpperCase() === 'USER') {
    return null;
  }

  const pid = readInteger(parts[1]);

  if (pid === undefined) {
    return null;
  }

  return {
    pid,
    user: parts[0],
    cpuPercent: readNumber(parts[2]),
    memoryPercent: readNumber(parts[3]),
    vszKb: readInteger(parts[4]),
    rssKb: readInteger(parts[5]),
    tty: parts[6],
    state: parts[7],
    startTime: parts[8],
    cpuTime: parts[9],
    command: parts.slice(10).join(' ') || t('process.placeholder.noCommand', language),
  };
}

function readProcFsStatusValue(statusText: string, key: string) {
  const match = statusText.match(new RegExp(`(?:^|\\s)${key}=([^\\s]+)`));
  const value = match?.[1];

  return value && value !== '-' ? value : '';
}

function parseProcFsLinuxProcessLine(line: string, language: AppLanguage): RemoteProcessEntry | null {
  const parts = line.split('\t');

  if (parts[0] !== 'PROCFS' || parts.length < 4) {
    return null;
  }

  const pid = readInteger(parts[1]);

  if (pid === undefined) {
    return null;
  }

  const statusText = parts[2] || '';
  const uid = readProcFsStatusValue(statusText, 'uid');
  const cpuPercent = readNumber(readProcFsStatusValue(statusText, 'cpu'));
  const memoryPercent = readNumber(readProcFsStatusValue(statusText, 'mem'));

  return {
    pid,
    ppid: readInteger(readProcFsStatusValue(statusText, 'ppid')),
    user: uid ? `uid:${uid}` : '-',
    cpuPercent,
    memoryPercent,
    vszKb: readInteger(readProcFsStatusValue(statusText, 'vsz')),
    rssKb: readInteger(readProcFsStatusValue(statusText, 'rss')),
    tty: '-',
    state: readProcFsStatusValue(statusText, 'state') || '-',
    startTime: '-',
    runtime: '',
    cpuTime: '',
    command: parts.slice(3).join('\t').trim() || t('process.placeholder.noCommand', language),
  };
}

function parseDelimitedLinuxProcessLine(line: string, language: AppLanguage): RemoteProcessEntry | null {
  const parts = line.split('\t');

  if (parts[0] !== 'PROC' || parts.length < 13) {
    return null;
  }

  const pid = readInteger(parts[1]);

  if (pid === undefined) {
    return null;
  }

  return {
    pid,
    ppid: readInteger(parts[2]),
    user: parts[3] || '-',
    cpuPercent: readNumber(parts[4]),
    memoryPercent: readNumber(parts[5]),
    vszKb: readInteger(parts[6]),
    rssKb: readInteger(parts[7]),
    tty: parts[8] || '-',
    state: parts[9] || '-',
    startTime: parts[10] || '-',
    runtime: parts[11] || '',
    cpuTime: parts[12] || '',
    command: parts.slice(13).join('\t').trim() || t('process.placeholder.noCommand', language),
  };
}

function parseLinuxProcessOutput(stdout: string, language: AppLanguage): RemoteProcessEntry[] {
  return stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => (
      parseProcFsLinuxProcessLine(line, language)
      ?? parseDelimitedLinuxProcessLine(line, language)
      ?? parseLinuxProcessLine(line, language)
      ?? parsePsAuxLine(line, language)
    ))
    .filter((process): process is RemoteProcessEntry => Boolean(process));
}

function parseWindowsProcessOutput(stdout: string): RemoteProcessEntry[] {
  const text = stdout.trim();

  if (!text) {
    return [];
  }

  try {
    const parsedJson = JSON.parse(text) as unknown;
    const records = Array.isArray(parsedJson) ? parsedJson : [parsedJson];

    return records
      .map<RemoteProcessEntry | null>((record) => {
        if (!record || typeof record !== 'object') {
          return null;
        }

        const item = record as Record<string, unknown>;
        const pid = readInteger(item.pid as string | number | undefined);

        if (pid === undefined) {
          return null;
        }

        const process: RemoteProcessEntry = {
          pid,
          ppid: readInteger(item.ppid as string | number | undefined),
          user: typeof item.user === 'string' && item.user.trim() ? item.user : '-',
          cpuSeconds: readNumber(item.cpuSeconds as string | number | undefined),
          memoryMb: readNumber(item.memoryMb as string | number | undefined),
          state: typeof item.state === 'string' ? item.state : 'Running',
          startTime: typeof item.startTime === 'string' ? item.startTime : '',
          runtime: typeof item.runtime === 'string' ? item.runtime : '',
          cpuTime: typeof item.cpuTime === 'string' ? item.cpuTime : '',
          command: typeof item.command === 'string' && item.command.trim() ? item.command : `PID ${pid}`,
          executablePath: typeof item.executablePath === 'string' ? item.executablePath : undefined,
        };

        return process;
      })
      .filter((process): process is RemoteProcessEntry => Boolean(process));
  } catch {
    return text
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .map<RemoteProcessEntry | null>((line) => {
        const parts = line.split('\t');

        if (parts[0] !== 'PROC') {
          return null;
        }

        const pid = readInteger(parts[1]);

        if (pid === undefined) {
          return null;
        }

        return {
          pid,
          ppid: readInteger(parts[2]),
          user: parts[3] || '-',
          cpuSeconds: readNumber(parts[4]),
          memoryMb: readNumber(parts[5]),
          state: parts[6] || 'Running',
          startTime: parts[7] || '',
          runtime: parts[8] || '',
          cpuTime: parts[9] || '',
          command: parts[10]?.trim() || `PID ${pid}`,
          executablePath: parts[11]?.trim() || undefined,
        };
      })
      .filter((process): process is RemoteProcessEntry => Boolean(process));
  }
}

function getLinuxProcessListCommand(language: AppLanguage) {
  const noCommand = t('process.placeholder.noCommand', language);
  const noDataMessage = t('process.error.noProcessData', language);

  return `
format='pid=,ppid=,user=,pcpu=,pmem=,vsz=,rss=,tty=,stat=,start=,etime=,time=,args='
output="$(ps -eo "$format" 2>/dev/null || true)"
if [ -z "$output" ]; then
  output="$(ps -eo pid=,ppid=,user=,pcpu=,pmem=,vsz=,rss=,tty=,stat=,start=,etime=,time=,command= 2>/dev/null || true)"
fi
if [ -z "$output" ]; then
  output="$(ps aux 2>/dev/null || true)"
fi
if [ -n "$output" ]; then
  if printf '%s\\n' "$output" | head -n 800 | awk '
    BEGIN { OFS = "\\t"; count = 0 }
    /^[[:space:]]*USER[[:space:]]+PID[[:space:]]+/ { next }
    {
      if ($1 ~ /^[0-9]+$/ && $2 ~ /^[0-9]+$/ && $4 ~ /^[0-9.]+$/ && $5 ~ /^[0-9.]+$/) {
        command = ""
        for (i = 13; i <= NF; i++) command = command (i == 13 ? "" : " ") $i
        print "PROC", $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, command
        count += 1
        next
      }
      if ($2 ~ /^[0-9]+$/ && $3 ~ /^[0-9.]+$/ && $4 ~ /^[0-9.]+$/) {
        command = ""
        for (i = 11; i <= NF; i++) command = command (i == 11 ? "" : " ") $i
        print "PROC", $2, "", $1, $3, $4, $5, $6, $7, $8, $9, "", $10, command
        count += 1
      }
    }
    END { exit count > 0 ? 0 : 1 }
  '; then
    exit 0
  fi
fi

if [ -d /proc ]; then
  mem_total_kb="$(awk '/^MemTotal:/ { print $2; exit }' /proc/meminfo 2>/dev/null)"
  case "$mem_total_kb" in ''|*[!0-9]*) mem_total_kb=0 ;; esac
  uptime_seconds="$(awk '{ print $1; exit }' /proc/uptime 2>/dev/null)"
  clk_tck="$(getconf CLK_TCK 2>/dev/null || printf '100')"
  page_size_bytes="$(getconf PAGESIZE 2>/dev/null || getconf PAGE_SIZE 2>/dev/null || printf '4096')"
  case "$clk_tck" in ''|*[!0-9]*) clk_tck=100 ;; esac
  case "$page_size_bytes" in ''|*[!0-9]*) page_size_bytes=4096 ;; esac
  page_size_kb=$((page_size_bytes / 1024))
  [ "$page_size_kb" -gt 0 ] || page_size_kb=4
  count=0
  for d in /proc/[0-9]*; do
    [ -d "$d" ] || continue
    pid="\${d##*/}"
    stat_line=""
    [ -r "$d/stat" ] && stat_line="$(cat "$d/stat" 2>/dev/null || true)"
    stat_values=""
    if [ -n "$stat_line" ]; then
      stat_values="$(printf '%s\\n' "$stat_line" | sed 's/^.*) //' | awk -v uptime="$uptime_seconds" -v hz="$clk_tck" -v page_kb="$page_size_kb" -v mem_total="$mem_total_kb" '
        {
          utime = $12 + 0
          stime = $13 + 0
          start_ticks = $20 + 0
          rss_pages = $22 + 0
          cpu = "-"
          mem = "-"
          rss_from_stat = rss_pages * page_kb
          if (uptime > 0 && hz > 0 && start_ticks > 0) {
            elapsed = uptime - (start_ticks / hz)
            if (elapsed > 0) cpu = sprintf("%.2f", ((utime + stime) / hz) / elapsed * 100)
          }
          if (mem_total > 0 && rss_from_stat > 0) {
            mem = sprintf("%.2f", rss_from_stat / mem_total * 100)
          }
          printf " cpu=%s mem=%s rss_stat=%s", cpu, mem, rss_from_stat
        }
      ' 2>/dev/null || true)"
    fi
    status="$(awk '
      /^PPid:/ { ppid = $2 }
      /^Uid:/ { uid = $2 }
      /^State:/ { state = $2 }
      /^VmSize:/ { vsz = $2 }
      /^VmRSS:/ { rss = $2 }
      END {
        if (ppid == "") ppid = "-"
        if (uid == "") uid = "-"
        if (state == "") state = "-"
        if (vsz == "") vsz = "-"
        if (rss == "") rss = "-"
        printf "ppid=%s uid=%s state=%s vsz=%s rss=%s", ppid, uid, state, vsz, rss
      }
    ' "$d/status" 2>/dev/null || true)"
    [ -n "$status" ] || continue
    status="\${status}\${stat_values}"

    command=""
    if [ -r "$d/cmdline" ]; then
      command="$(tr '\\000' ' ' < "$d/cmdline" 2>/dev/null | sed 's/[[:space:]]*$//')"
    fi
    if [ -z "$command" ] && [ -r "$d/comm" ]; then
      comm="$(cat "$d/comm" 2>/dev/null | head -n 1)"
      [ -n "$comm" ] && command="[$comm]"
    fi
    [ -n "$command" ] || command="${noCommand}"

    printf 'PROCFS\\t%s\\t%s\\t%s\\n' "$pid" "$status" "$command"
    count=$((count + 1))
    [ "$count" -ge 800 ] && break
  done
  [ "$count" -gt 0 ] && exit 0
fi

printf '%s\\n' '${noDataMessage}' >&2
exit 1
`;
}

function getWindowsProcessListCommand(language: AppLanguage) {
  const readFailedMessage = t('process.error.listReadFailed', language);

  return powershellStdinCommand(`
$tab = [char]9

function Clean-Field($value) {
  if ($null -eq $value) { return '' }
  return ([string]$value) -replace "[\`r\`n\`t]", ' '
}

function Is-Blank($value) {
  if ($null -eq $value) { return $true }
  return ([string]$value).Trim().Length -eq 0
}

function Write-ProcessRow($processIdValue, $parentProcessIdValue, $owner, $cpuSeconds, $memoryMb, $state, $startTime, $runtime, $cpuTime, $command, $path) {
  $fields = @(
    'PROC',
    $processIdValue,
    $parentProcessIdValue,
    $owner,
    $cpuSeconds,
    $memoryMb,
    $state,
    $startTime,
    $runtime,
    $cpuTime,
    $command,
    $path
  )
  ($fields | ForEach-Object { Clean-Field $_ }) -join $tab
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

function Get-ProcessOwnerText($processEntry) {
  if ($null -eq $processEntry) { return '-' }
  try {
    $userNameProperty = $processEntry.PSObject.Properties['UserName']
    if ($userNameProperty -and -not (Is-Blank $userNameProperty.Value)) {
      return [string]$userNameProperty.Value
    }
  } catch {}

  return '-'
}

function Format-ProcessDate($value) {
  if ($null -eq $value) { return '' }
  try {
    if ($value -is [datetime]) { return $value.ToString('yyyy-MM-dd HH:mm') }
    return ([Management.ManagementDateTimeConverter]::ToDateTime([string]$value)).ToString('yyyy-MM-dd HH:mm')
  } catch {
    try { return ([datetime]$value).ToString('yyyy-MM-dd HH:mm') } catch { return [string]$value }
  }
}

$processById = @{}
try {
  Get-Process -ErrorAction SilentlyContinue | ForEach-Object {
    $processById[[int]$_.Id] = $_
  }
} catch {}

$processRecords = Get-ProcessRecords
$rowCount = 0

if (@($processRecords).Count -gt 0) {
foreach ($record in @($processRecords)) {
  if ($rowCount -ge 800) { break }
  $rowCount += 1

  $_ = $record
  $proc = $processById[[int]$_.ProcessId]
  $owner = Get-ProcessOwnerText $proc

  $cpuSeconds = $null
  if ($proc -and $null -ne $proc.CPU) { $cpuSeconds = [double][math]::Round($proc.CPU, 1) }

  $memoryMb = $null
  if ($null -ne $_.WorkingSetSize) {
    $memoryMb = [double][math]::Round(([double]$_.WorkingSetSize / 1MB), 1)
  } elseif ($proc -and $null -ne $proc.WorkingSet64) {
    $memoryMb = [double][math]::Round(([double]$proc.WorkingSet64 / 1MB), 1)
  }

  $startTime = Format-ProcessDate $_.CreationDate

  $state = 'Running'
  if ($proc -and $proc.Responding -eq $false) { $state = 'NotResponding' }

  $command = $_.CommandLine
  if (Is-Blank $command) { $command = $_.Name }

  $parentPid = $null
  if ($null -ne $_.ParentProcessId) { $parentPid = [int]$_.ParentProcessId }

  $cpuTime = ''
  if ($null -ne $cpuSeconds) { $cpuTime = "$cpuSeconds s" }

  Write-ProcessRow ([int]$_.ProcessId) $parentPid $owner $cpuSeconds $memoryMb $state $startTime '' $cpuTime $command $_.ExecutablePath
}
} elseif ($processById.Count -gt 0) {
  foreach ($processEntry in @($processById.Values)) {
    if ($rowCount -ge 800) { break }
    $rowCount += 1
    $_ = $processEntry
    $cpuSeconds = $null
    if ($null -ne $_.CPU) { $cpuSeconds = [double][math]::Round($_.CPU, 1) }
    $memoryMb = $null
    if ($null -ne $_.WorkingSet64) { $memoryMb = [double][math]::Round(([double]$_.WorkingSet64 / 1MB), 1) }
    $startTime = ''
    try { if ($_.StartTime) { $startTime = $_.StartTime.ToString('yyyy-MM-dd HH:mm') } } catch {}
    $state = 'Running'
    if ($_.Responding -eq $false) { $state = 'NotResponding' }
    $cpuTime = ''
    if ($null -ne $cpuSeconds) { $cpuTime = "$cpuSeconds s" }
    $path = $null
    try { $path = $_.Path } catch {}

    Write-ProcessRow ([int]$_.Id) '' '-' $cpuSeconds $memoryMb $state $startTime '' $cpuTime $_.ProcessName $path
  }
}

if ($rowCount -eq 0) {
  [Console]::Error.WriteLine("${readFailedMessage}")
  exit 1
}
`);
}

function parseProcessDetailOutput(stdout: string, pid: number): ProcessDetail {
  const detail: ProcessDetail = {
    pid,
    ports: [],
    loadedAt: Date.now(),
  };

  stdout.split(/\r?\n/).forEach((line) => {
    const [kind, ...rest] = line.split('\t');
    const value = rest.join('\t').trim();

    if (!value) {
      return;
    }

    if (kind === 'CWD') {
      detail.cwd = value;
    } else if (kind === 'PATH') {
      detail.executablePath = value;
    } else if (kind === 'PORT') {
      detail.ports.push(value);
    }
  });

  return detail;
}

function getLinuxProcessDetailCommand(pid: number) {
  return `
{ pwdx ${pid} 2>/dev/null | sed 's/^[^:]*:[[:space:]]*/CWD\\t/'; } || true
if command -v ss >/dev/null 2>&1; then
  ss -Htunlp 2>/dev/null | awk -v pid='pid=${pid},' 'index($0, pid) { print "PORT\\t" $0 }'
elif command -v netstat >/dev/null 2>&1; then
  netstat -tunlp 2>/dev/null | awk -v pid='${pid}/' 'index($0, pid) { print "PORT\\t" $0 }'
fi
`;
}

function getWindowsProcessDetailCommand(pid: number) {
  return powershellStdinCommand(`
$tab = [char]9
$foundPort = $false
$proc = $null
try { $proc = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction Stop } catch {
  try { $proc = Get-WmiObject Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction Stop } catch {}
}
if ($proc -and $proc.ExecutablePath) {
  "PATH" + $tab + $proc.ExecutablePath
} else {
  try {
    $psProc = Get-Process -Id ${pid} -ErrorAction Stop
    if ($psProc.Path) { "PATH" + $tab + $psProc.Path }
  } catch {}
}
try {
  if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
    Get-NetTCPConnection -OwningProcess ${pid} -ErrorAction Stop | ForEach-Object {
      $foundPort = $true
      "PORT" + $tab + "TCP $($_.LocalAddress):$($_.LocalPort) -> $($_.RemoteAddress):$($_.RemotePort) $($_.State)"
    }
  }
} catch {}
try {
  if (Get-Command Get-NetUDPEndpoint -ErrorAction SilentlyContinue) {
    Get-NetUDPEndpoint -OwningProcess ${pid} -ErrorAction Stop | ForEach-Object {
      $foundPort = $true
      "PORT" + $tab + "UDP $($_.LocalAddress):$($_.LocalPort)"
    }
  }
} catch {}
if (-not $foundPort) {
  try {
    netstat -ano | ForEach-Object {
      $line = $_.Trim()
      if ($line -match '^(TCP|UDP)\\s+' -and $line -match '\\s+${pid}$') {
        "PORT" + $tab + $line
      }
    }
  } catch {}
}
`);
}

function getStateTone(state?: string) {
  if (!state) {
    return 'idle';
  }

  const normalizedState = state.toUpperCase();

  if (normalizedState.startsWith('R')) {
    return 'running';
  }

  if (normalizedState.startsWith('D') || normalizedState.includes('NOTRESPONDING')) {
    return 'blocked';
  }

  if (normalizedState.startsWith('Z')) {
    return 'zombie';
  }

  return 'idle';
}

function compareProcesses(
  first: RemoteProcessEntry,
  second: RemoteProcessEntry,
  sortKey: RemoteProcessManagerSortKey,
  sortDir: SortDir,
  isWindowsHost: boolean,
) {
  const direction = sortDir === 'asc' ? 1 : -1;

  const readSortValue = (process: RemoteProcessEntry) => {
    if (sortKey === 'pid') return process.pid;
    if (sortKey === 'ppid') return process.ppid ?? -1;
    if (sortKey === 'cpu') return getCpuValue(process, isWindowsHost);
    if (sortKey === 'memory') return getMemoryValue(process, isWindowsHost);
    if (sortKey === 'user') return process.user ?? '';
    if (sortKey === 'state') return process.state ?? '';
    if (sortKey === 'startTime') return process.startTime ?? '';
    if (sortKey === 'runtime') return process.runtime ?? '';
    return process.command;
  };

  const firstValue = readSortValue(first);
  const secondValue = readSortValue(second);

  if (typeof firstValue === 'number' && typeof secondValue === 'number') {
    return (firstValue - secondValue) * direction;
  }

  return String(firstValue).localeCompare(String(secondValue), getShellDeskLocale()) * direction;
}

function matchesQuery(process: RemoteProcessEntry, query: string) {
  if (!query) {
    return true;
  }

  const normalizedQuery = query.toLowerCase();
  const searchableText = [
    process.pid,
    process.ppid,
    process.user,
    process.state,
    process.command,
    process.executablePath,
  ].filter((value) => value !== undefined && value !== null).join(' ').toLowerCase();

  return searchableText.includes(normalizedQuery);
}

function flattenProcessTree(
  processes: RemoteProcessEntry[],
  visiblePids: Set<number>,
  compare: (first: RemoteProcessEntry, second: RemoteProcessEntry) => number,
) {
  const processByPid = new Map(processes.map((process) => [process.pid, process]));
  const childrenByPid = new Map<number, RemoteProcessEntry[]>();

  processes.forEach((process) => {
    if (!visiblePids.has(process.pid)) {
      return;
    }

    const parentPid = process.ppid;

    if (parentPid === undefined || !visiblePids.has(parentPid)) {
      return;
    }

    const children = childrenByPid.get(parentPid) ?? [];
    children.push(process);
    childrenByPid.set(parentPid, children);
  });

  childrenByPid.forEach((children) => children.sort(compare));

  const roots = processes
    .filter((process) => visiblePids.has(process.pid))
    .filter((process) => process.ppid === undefined || !processByPid.has(process.ppid) || !visiblePids.has(process.ppid))
    .sort(compare);
  const rows: ProcessRow[] = [];
  const walkedPids = new Set<number>();

  const walk = (process: RemoteProcessEntry, depth: number) => {
    if (walkedPids.has(process.pid)) {
      return;
    }

    walkedPids.add(process.pid);
    rows.push({ process, depth });
    (childrenByPid.get(process.pid) ?? []).forEach((child) => walk(child, depth + 1));
  };

  roots.forEach((process) => walk(process, 0));

  processes
    .filter((process) => visiblePids.has(process.pid) && !walkedPids.has(process.pid))
    .sort(compare)
    .forEach((process) => rows.push({ process, depth: 0 }));

  return rows;
}

function ProcessManager({ connectionId, settings, systemType, launchOptions }: RemoteProcessManagerProps) {
  const language = settings.language;
  const isWindowsHost = isWindowsSystem(systemType);
  const { runCommand, sudoPrompt } = useSudoCommand(connectionId, systemType);
  const isMountedRef = useRef(true);
  const isRefreshingRef = useRef(false);
  const missingPidNoticeRef = useRef<number | null>(null);
  const [processes, setProcesses] = useState<RemoteProcessEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [signalingPid, setSignalingPid] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [success, setSuccess] = useState('');
  const [search, setSearch] = useState(launchOptions?.search ?? '');
  const [userFilter, setUserFilter] = useState(launchOptions?.user ?? 'all');
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [autoRefreshMs, setAutoRefreshMs] = useState<(typeof AUTO_REFRESH_OPTIONS)[number]>(DEFAULT_AUTO_REFRESH_MS);
  const [sortKey, setSortKey] = useState<RemoteProcessManagerSortKey>(getVisibleProcessSortKey(launchOptions?.sortKey));
  const [sortDir, setSortDir] = useState<SortDir>(launchOptions?.sortDir ?? 'desc');
  const [viewMode, setViewMode] = useState<RemoteProcessManagerViewMode>(launchOptions?.viewMode ?? 'table');
  const [selectedSignalValue, setSelectedSignalValue] = useState(DEFAULT_SIGNAL.value);
  const [selectedPid, setSelectedPid] = useState<number | null>(launchOptions?.pid ?? null);
  const [processDetail, setProcessDetail] = useState<ProcessDetail | null>(null);
  const [pendingSignal, setPendingSignal] = useState<PendingSignal | null>(null);
  const [aiReportOpen, setAiReportOpen] = useState(false);
  const [aiReportPhase, setAiReportPhase] = useState<ProcessAiReportPhase>('idle');
  const [aiReportText, setAiReportText] = useState('');
  const [aiReportError, setAiReportError] = useState('');
  const [aiReportNotice, setAiReportNotice] = useState('');
  const [aiReportGeneratedAt, setAiReportGeneratedAt] = useState('');
  const [aiReportSnapshotNote, setAiReportSnapshotNote] = useState('');
  const [processInsight, setProcessInsight] = useState<ProcessAiInsight | null>(null);
  const [processInsightLoadingPid, setProcessInsightLoadingPid] = useState<number | null>(null);
  const [contextMenu, setContextMenu] = useState<ProcessContextMenuState | null>(null);

  const selectedSignal = getSignalByValue(selectedSignalValue);
  const isAiReportBusy = aiReportPhase === 'preparing' || aiReportPhase === 'requesting' || aiReportPhase === 'streaming';

  const refresh = useCallback(async (options?: { silent?: boolean }) => {
    if (isRefreshingRef.current) {
      return;
    }

    isRefreshingRef.current = true;

    if (!options?.silent) {
      setLoading(true);
    }

    setError('');

    try {
      const result = await runCommand(isWindowsHost ? getWindowsProcessListCommand(language) : getLinuxProcessListCommand(language));
      const stdout = result.stdout || '';
      const nextProcesses = isWindowsHost
        ? parseWindowsProcessOutput(stdout)
        : parseLinuxProcessOutput(stdout, language);

      if (!isMountedRef.current) {
        return;
      }

      setProcesses(nextProcesses);

      if (result.code !== 0 && !nextProcesses.length) {
        setError(result.stderr || t('process.error.listReadFailed', language));
      } else if (!nextProcesses.length && stdout.trim()) {
        setError(t('process.error.listUnparseable', language, { output: compactAiField(stdout, 200) }));
      } else if (!nextProcesses.length) {
        setError(result.stderr || t('process.error.noProcessData', language));
      }
    } catch (err) {
      if (isMountedRef.current) {
        setError(getErrorMessage(err));
      }
    } finally {
      isRefreshingRef.current = false;

      if (isMountedRef.current && !options?.silent) {
        setLoading(false);
      }
    }
  }, [isWindowsHost, language, runCommand]);

  const loadProcessDetails = useCallback(async (pid: number) => {
    if (!Number.isInteger(pid) || pid <= 0) {
      return;
    }

    setDetailLoading(true);

    try {
      const result = await runCommand(isWindowsHost ? getWindowsProcessDetailCommand(pid) : getLinuxProcessDetailCommand(pid));
      const nextDetail = parseProcessDetailOutput(result.stdout || '', pid);

      if (result.code !== 0) {
        nextDetail.error = result.stderr || t('process.error.detailReadFailed', language);
      }

      if (isMountedRef.current) {
        setProcessDetail(nextDetail);
      }
    } catch (err) {
      if (isMountedRef.current) {
        setProcessDetail({
          pid,
          ports: [],
          loadedAt: Date.now(),
          error: getErrorMessage(err),
        });
      }
    } finally {
      if (isMountedRef.current) {
        setDetailLoading(false);
      }
    }
  }, [isWindowsHost, language, runCommand]);

  useEffect(() => {
    isMountedRef.current = true;
    void refresh();

    return () => {
      isMountedRef.current = false;
      isRefreshingRef.current = false;
    };
  }, [refresh]);

  useEffect(() => {
    if (!launchOptions) {
      return;
    }

    if (typeof launchOptions.search === 'string') {
      setSearch(launchOptions.search);
    }

    if (typeof launchOptions.user === 'string') {
      setUserFilter(launchOptions.user);
    }

    if (launchOptions.sortKey) {
      setSortKey(getVisibleProcessSortKey(launchOptions.sortKey));
    }

    if (launchOptions.sortDir) {
      setSortDir(launchOptions.sortDir);
    }

    if (launchOptions.viewMode) {
      setViewMode(launchOptions.viewMode);
    }

    if (Number.isInteger(launchOptions.pid) && launchOptions.pid! > 0) {
      setSelectedPid(launchOptions.pid!);
    }
  }, [launchOptions]);

  useEffect(() => {
    if (!autoRefresh) {
      return undefined;
    }

    let canceled = false;
    let timerId: number | undefined;

    const scheduleTick = () => {
      if (canceled) {
        return;
      }

      timerId = window.setTimeout(async () => {
        if (!pendingSignal && signalingPid === null) {
          await refresh({ silent: true });
        }

        scheduleTick();
      }, autoRefreshMs);
    };

    scheduleTick();

    return () => {
      canceled = true;

      if (timerId !== undefined) {
        window.clearTimeout(timerId);
      }
    };
  }, [autoRefresh, autoRefreshMs, pendingSignal, refresh, signalingPid]);

  useEffect(() => {
    if (selectedPid === null) {
      setProcessDetail(null);
      return;
    }

    void loadProcessDetails(selectedPid);
  }, [loadProcessDetails, selectedPid]);

  useEffect(() => {
    if (!contextMenu) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setContextMenu(null);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [contextMenu]);

  const compare = useCallback((first: RemoteProcessEntry, second: RemoteProcessEntry) => (
    compareProcesses(first, second, sortKey, sortDir, isWindowsHost)
  ), [isWindowsHost, sortDir, sortKey]);

  const users = useMemo(() => {
    const uniqueUsers = new Set(
      processes
        .map((process) => process.user?.trim())
        .filter((user): user is string => Boolean(user && user !== '-')),
    );

    return [...uniqueUsers].sort((first, second) => first.localeCompare(second, getShellDeskLocale()));
  }, [processes]);

  const baseFilteredProcesses = useMemo(() => {
    const normalizedSearch = search.trim();

    return processes.filter((process) => {
      const matchesUser = userFilter === 'all' || process.user === userFilter;
      return matchesUser && matchesQuery(process, normalizedSearch);
    });
  }, [processes, search, userFilter]);

  const processRows = useMemo<ProcessRow[]>(() => {
    const basePids = new Set(baseFilteredProcesses.map((process) => process.pid));
    const normalizedSearch = search.trim();

    if (viewMode === 'table') {
      return [...baseFilteredProcesses]
        .sort(compare)
        .map((process) => ({ process, depth: 0 }));
    }

    if (normalizedSearch) {
      const processByPid = new Map(processes.map((process) => [process.pid, process]));

      baseFilteredProcesses.forEach((process) => {
        let parentPid = process.ppid;
        let guard = 0;

        while (parentPid !== undefined && guard < 64) {
          const parent = processByPid.get(parentPid);

          if (!parent) {
            break;
          }

          basePids.add(parent.pid);
          parentPid = parent.ppid;
          guard += 1;
        }

        processes
          .filter((candidate) => candidate.ppid === process.pid)
          .forEach((child) => basePids.add(child.pid));
      });
    }

    return flattenProcessTree(processes, basePids, compare);
  }, [baseFilteredProcesses, compare, processes, search, viewMode]);

  const selectedProcess = useMemo(() => {
    if (selectedPid === null) {
      return null;
    }

    return processes.find((process) => process.pid === selectedPid) ?? null;
  }, [processes, selectedPid]);

  const selectedParent = useMemo(() => {
    if (!selectedProcess?.ppid) {
      return null;
    }

    return processes.find((process) => process.pid === selectedProcess.ppid) ?? null;
  }, [processes, selectedProcess]);

  const selectedChildren = useMemo(() => {
    if (!selectedProcess) {
      return [];
    }

    return processes
      .filter((process) => process.ppid === selectedProcess.pid)
      .sort(compare);
  }, [compare, processes, selectedProcess]);

  const maxCpuValue = useMemo(() => Math.max(1, ...processes.map((process) => getCpuValue(process, isWindowsHost))), [isWindowsHost, processes]);
  const maxMemoryValue = useMemo(() => Math.max(1, ...processes.map((process) => getMemoryValue(process, isWindowsHost))), [isWindowsHost, processes]);

  useEffect(() => {
    if (selectedPid !== null && processes.some((process) => process.pid === selectedPid)) {
      missingPidNoticeRef.current = null;
      setNotice('');
      return;
    }

    if (selectedPid !== null && processes.length > 0 && !loading && missingPidNoticeRef.current !== selectedPid) {
      missingPidNoticeRef.current = selectedPid;
      setNotice(t('process.notice.pidMissing', language, { pid: selectedPid }));
    }

    if (selectedPid === null && processRows.length > 0) {
      setSelectedPid(processRows[0].process.pid);
    }
  }, [language, loading, processRows, processes, selectedPid]);

  const toggleSort = (key: RemoteProcessManagerSortKey) => {
    if (sortKey === key) {
      setSortDir((currentDir) => (currentDir === 'asc' ? 'desc' : 'asc'));
      return;
    }

    setSortKey(key);
    setSortDir(key === 'user' || key === 'command' || key === 'state' ? 'asc' : 'desc');
  };

  const sortIndicator = (key: RemoteProcessManagerSortKey) => {
    if (sortKey !== key) {
      return <span className="proc-sort-icon" aria-hidden="true" />;
    }

    return <span className="proc-sort-icon" aria-hidden="true">{sortDir === 'asc' ? '▲' : '▼'}</span>;
  };

  const closeContextMenu = () => setContextMenu(null);

  const openProcessContextMenu = (event: MouseEvent<HTMLTableRowElement>, process: RemoteProcessEntry) => {
    event.preventDefault();
    event.stopPropagation();
    setSelectedPid(process.pid);
    const position = getProcessContextMenuPosition(event.clientX, event.clientY);
    setContextMenu({ ...position, process });
  };

  const copyToClipboard = async (value: string, label: string) => {
    setError('');
    setNotice('');
    setSuccess('');

    try {
      await navigator.clipboard.writeText(value);
      setSuccess(t('process.message.copied', language, { label }));
    } catch (err) {
      setError(t('process.error.copyFailed', language, { error: getErrorMessage(err) }));
    }
  };

  const requestSignal = (process: RemoteProcessEntry) => {
    setPendingSignal({
      pid: process.pid,
      command: process.command,
      signal: isWindowsHost
        ? {
            value: 'win-kill',
            name: 'Stop-Process',
            label: t('process.signal.windowsKill.label', language),
            descriptionId: 'process.signal.windowsKill.description',
          }
        : selectedSignal,
    });
  };

  const sendSignal = async (pending: PendingSignal) => {
    if (!Number.isInteger(pending.pid) || pending.pid <= 0) {
      setError(t('process.error.invalidPid', language));
      return;
    }

    setSignalingPid(pending.pid);
    setError('');
    setNotice('');
    setSuccess('');

    try {
      const command = isWindowsHost
        ? powershellCommand(`Stop-Process -Id ${pending.pid} -Force -ErrorAction Stop`)
        : getLinuxSignalCommand(pending.signal.value, pending.pid);
      const result = await runCommand(command);

      if (result.code !== 0) {
        throw new Error(result.stderr || result.stdout || t('process.error.operationFailed', language));
      }

      setSuccess(isWindowsHost
        ? t('process.success.ended', language, { pid: pending.pid })
        : t('process.success.signalSent', language, { pid: pending.pid, signal: pending.signal.name }));
      await refresh();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSignalingPid(null);
      setPendingSignal(null);
    }
  };

  const requestAiReport = useCallback(async () => {
    if (isAiReportBusy) {
      setAiReportOpen(true);
      return;
    }

    setAiReportOpen(true);
    setAiReportPhase('preparing');
    setAiReportText('');
    setAiReportError('');
    setAiReportNotice('');
    setAiReportGeneratedAt('');
    setAiReportSnapshotNote('');

    if (!processes.length) {
      setAiReportPhase('error');
      setAiReportError(t('process.ai.noSnapshot', language));
      return;
    }

    const readinessError = getAiReadinessError(settings, language);

    if (readinessError) {
      setAiReportPhase('error');
      setAiReportError(readinessError);
      return;
    }

    const aiControls = window.guiSSH?.ai;
    const snapshot = createProcessAiSnapshot(processes, isWindowsHost, language);
    const snapshotNote = snapshot.omittedCount > 0
      ? t('process.ai.snapshotNotePartial', language, { included: snapshot.includedCount, total: processes.length, omitted: snapshot.omittedCount })
      : t('process.ai.snapshotNoteAll', language, { included: snapshot.includedCount });
    const messages: ShellDeskAiChatMessage[] = [
      {
        role: 'system',
        content: t('ai.process.report.systemPrompt', language),
      },
      {
        role: 'user',
        content: [
          t('process.ai.report.userPrompt', language),
          '',
          snapshot.text,
        ].join('\n'),
      },
    ];
    const request = createAiChatRequest(settings, messages, 0.1);
    let streamedContent = '';
    const streamedTextUpdater = createStreamedTextUpdater(setAiReportText, t('process.ai.report.generating', language));

    setAiReportSnapshotNote(snapshotNote);
    setAiReportPhase(aiControls?.chatStream ? 'streaming' : 'requesting');

    try {
      let resultContent = '';

      if (aiControls?.chatStream) {
        try {
          const result = await aiControls.chatStream(request, {
            onChunk: (chunk) => {
              streamedContent += chunk;
              streamedTextUpdater.append(chunk);
            },
          });
          streamedTextUpdater.flush();
          resultContent = result.content || streamedContent;
        } catch (streamError) {
          streamedTextUpdater.cancel();

          if (streamedContent || !aiControls.chat) {
            throw streamError;
          }

          setAiReportPhase('requesting');
          const result = await aiControls.chat(request);
          resultContent = result.content;
        }
      } else if (aiControls?.chat) {
        const result = await aiControls.chat(request);
        resultContent = result.content;
      }

      setAiReportText(resultContent || t('process.ai.report.empty', language));
      setAiReportGeneratedAt(new Date().toLocaleString(getShellDeskLocale()));
      setAiReportPhase('done');
    } catch (err) {
      setAiReportPhase('error');
      setAiReportError(t('process.ai.requestFailed', language, { error: getErrorMessage(err) }));
    }
  }, [isAiReportBusy, isWindowsHost, language, processes, settings]);

  const requestProcessInsight = useCallback(async () => {
    if (!selectedProcess || processInsightLoadingPid !== null) {
      return;
    }

    const readinessError = getAiReadinessError(settings, language);

    if (readinessError) {
      setProcessInsight({
        pid: selectedProcess.pid,
        content: '',
        error: readinessError,
      });
      return;
    }

    const aiControls = window.guiSSH?.ai;
    const detail = processDetail?.pid === selectedProcess.pid ? processDetail : null;
    const messages: ShellDeskAiChatMessage[] = [
      {
        role: 'system',
        content: t('ai.process.insight.systemPrompt', language),
      },
      {
        role: 'user',
        content: [
          t('process.ai.insight.userPrompt', language),
          '',
          formatProcessContextForAi(selectedProcess, isWindowsHost, detail, selectedParent, selectedChildren, language),
        ].join('\n'),
      },
    ];
    const request = createAiChatRequest(settings, messages, 0.2);
    let streamedContent = '';

    setProcessInsightLoadingPid(selectedProcess.pid);
    setProcessInsight({
      pid: selectedProcess.pid,
      content: t('process.ai.insight.loading', language),
    });

    try {
      let resultContent = '';

      if (aiControls?.chatStream) {
        try {
          const result = await aiControls.chatStream(request, {
            onChunk: (chunk) => {
              streamedContent += chunk;
              setProcessInsight({
                pid: selectedProcess.pid,
                content: streamedContent || t('process.ai.insight.loading', language),
              });
            },
          });
          resultContent = result.content || streamedContent;
        } catch (streamError) {
          if (streamedContent || !aiControls.chat) {
            throw streamError;
          }

          const result = await aiControls.chat(request);
          resultContent = result.content;
        }
      } else if (aiControls?.chat) {
        const result = await aiControls.chat(request);
        resultContent = result.content;
      }

      setProcessInsight({
        pid: selectedProcess.pid,
        content: resultContent || t('process.ai.insight.empty', language),
      });
    } catch (err) {
      setProcessInsight({
        pid: selectedProcess.pid,
        content: '',
        error: t('process.ai.requestFailed', language, { error: getErrorMessage(err) }),
      });
    } finally {
      setProcessInsightLoadingPid(null);
    }
  }, [
    isWindowsHost,
    language,
    processDetail,
    processInsightLoadingPid,
    selectedChildren,
    selectedParent,
    selectedProcess,
    settings,
  ]);

  const copyAiReport = async () => {
    if (!aiReportText.trim()) {
      return;
    }

    setAiReportNotice('');
    setAiReportError('');

    try {
      await navigator.clipboard.writeText(createAiReportDocument(aiReportText, aiReportGeneratedAt, aiReportSnapshotNote, language));
      setAiReportNotice(t('process.ai.report.copied', language));
    } catch (err) {
      setAiReportError(t('process.error.copyFailed', language, { error: getErrorMessage(err) }));
    }
  };

  const exportAiReport = async () => {
    if (!aiReportText.trim()) {
      return;
    }

    const saveTextFile = window.guiSSH?.files?.saveTextFile;

    if (!saveTextFile) {
      setAiReportError(t('process.ai.exportUnsupported', language));
      return;
    }

    setAiReportNotice('');
    setAiReportError('');

    try {
      const filePath = await saveTextFile({
        title: t('process.ai.exportTitle', language),
        defaultFileName: createAiReportFileName(),
        content: createAiReportDocument(aiReportText, aiReportGeneratedAt, aiReportSnapshotNote, language),
      });

      if (filePath) {
        setAiReportNotice(t('process.ai.exported', language, { path: filePath }));
      }
    } catch (err) {
      setAiReportError(t('process.ai.exportFailed', language, { error: getErrorMessage(err) }));
    }
  };

  const renderSortHeader = (key: RemoteProcessManagerSortKey, label: string, className: string) => (
    <th className={className}>
      <button type="button" className="proc-sort-button" onClick={() => toggleSort(key)}>
        <span>{label}</span>
        {sortIndicator(key)}
      </button>
    </th>
  );

  const renderProcessRow = ({ process, depth }: ProcessRow) => {
    const isSelected = selectedPid === process.pid;
    const stateTone = getStateTone(process.state);
    const cpuValue = getCpuValue(process, isWindowsHost);
    const memoryValue = getMemoryValue(process, isWindowsHost);
    const cpuWidth = isWindowsHost ? (cpuValue / maxCpuValue) * 100 : clampPercent(cpuValue);
    const memoryWidth = isWindowsHost ? (memoryValue / maxMemoryValue) * 100 : clampPercent(memoryValue);

    return (
      <tr
        key={process.pid}
        className={`proc-row ${isSelected ? 'selected' : ''} ${stateTone === 'zombie' ? 'proc-zombie' : ''}`}
        onClick={() => setSelectedPid(process.pid)}
        onContextMenu={(event) => openProcessContextMenu(event, process)}
      >
        <td className="proc-pid">{process.pid}</td>
        <td className="proc-ppid">{process.ppid ?? '-'}</td>
        <td className="proc-user" title={process.user}>{process.user || '-'}</td>
        <td className="proc-cpu">
          <div className="proc-bar-wrap">
            <div className="proc-bar proc-bar-cpu" style={{ width: `${cpuWidth}%` }} />
            <span>{formatCpu(process, isWindowsHost)}</span>
          </div>
        </td>
        <td className="proc-mem">
          <div className="proc-bar-wrap">
            <div className="proc-bar proc-bar-mem" style={{ width: `${memoryWidth}%` }} />
            <span>{formatMemory(process, isWindowsHost)}</span>
          </div>
        </td>
        <td className="proc-command" title={process.command}>
          {viewMode === 'tree' ? <span className="proc-tree-indent" style={{ width: depth * 14 }} /> : null}
          {viewMode === 'tree' && depth > 0 ? <span className="proc-tree-branch" aria-hidden="true">└</span> : null}
          <span>{process.command}</span>
        </td>
      </tr>
    );
  };

  return (
    <div className="proc-manager">
      <div className="proc-toolbar">
        <div className="proc-toolbar-left">
          <button
            type="button"
            className="proc-tool-button ai"
            onClick={() => void requestAiReport()}
            disabled={loading || (!processes.length && !isAiReportBusy)}
          >
            {isAiReportBusy ? t('process.ui.aiAnalyzing', language) : t('process.ui.aiAnalyze', language)}
          </button>

          <button type="button" className="proc-tool-button primary" onClick={() => void refresh()} disabled={loading}>
            {loading ? t('process.ui.refreshing', language) : t('process.ui.refresh', language)}
          </button>

          <div className="proc-segmented" aria-label={t('process.ui.viewMode', language)}>
            <button type="button" className={viewMode === 'table' ? 'active' : ''} onClick={() => setViewMode('table')}>
              {t('process.ui.table', language)}
            </button>
            <button type="button" className={viewMode === 'tree' ? 'active' : ''} onClick={() => setViewMode('tree')}>
              {t('process.ui.tree', language)}
            </button>
          </div>

          <label className="proc-check-label">
            <input type="checkbox" checked={autoRefresh} onChange={(event) => setAutoRefresh(event.target.checked)} />
            {t('process.ui.autoRefresh', language)}
          </label>

          <select
            className="proc-select proc-refresh-select"
            value={autoRefreshMs}
            onChange={(event) => setAutoRefreshMs(Number(event.target.value) as (typeof AUTO_REFRESH_OPTIONS)[number])}
            disabled={!autoRefresh}
            aria-label={t('process.ui.autoRefreshInterval', language)}
          >
            {AUTO_REFRESH_OPTIONS.map((interval) => (
              <option key={interval} value={interval}>{interval / 1000}s</option>
            ))}
          </select>

          <span className="proc-summary">
            <strong>{processRows.length}</strong> / {processes.length}
          </span>
        </div>

        <div className="proc-toolbar-right">
          <select
            className="proc-select proc-user-filter"
            value={userFilter}
            onChange={(event) => setUserFilter(event.target.value)}
            aria-label={t('process.ui.filterByUser', language)}
          >
            <option value="all">{t('process.ui.allUsers', language)}</option>
            {users.map((user) => (
              <option key={user} value={user}>{user}</option>
            ))}
          </select>

          <input
            type="search"
            className="proc-search"
            placeholder={t('process.ui.searchPlaceholder', language)}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
      </div>

      {error ? <DismissibleAlert className="proc-alert danger" onDismiss={() => setError('')} role="alert">{error}</DismissibleAlert> : null}
      {notice ? <DismissibleAlert className="proc-alert info" onDismiss={() => setNotice('')}>{notice}</DismissibleAlert> : null}
      {success ? <DismissibleAlert className="proc-alert success" onDismiss={() => setSuccess('')}>{success}</DismissibleAlert> : null}

      <div className="proc-content">
        <section className="proc-table-panel" aria-label={t('process.ui.listAria', language)}>
          <div className="proc-table-wrap">
            <table className="proc-table">
              <thead>
                <tr>
                  {renderSortHeader('pid', 'PID', 'proc-col-pid')}
                  {renderSortHeader('ppid', 'PPID', 'proc-col-ppid')}
                  {renderSortHeader('user', t('process.ui.user', language), 'proc-col-user')}
                  {renderSortHeader('cpu', isWindowsHost ? 'CPU(s)' : 'CPU%', 'proc-col-cpu')}
                  {renderSortHeader('memory', isWindowsHost ? t('process.ui.memoryMb', language) : 'MEM%', 'proc-col-mem')}
                  {renderSortHeader('command', t('process.ui.command', language), 'proc-col-command')}
                </tr>
              </thead>
              <tbody>
                {processRows.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="proc-empty">
                      {loading ? t('process.ui.loadingList', language) : t('process.ui.noMatches', language)}
                    </td>
                  </tr>
                ) : (
                  processRows.map(renderProcessRow)
                )}
              </tbody>
            </table>
          </div>
        </section>

        <aside className="proc-detail-panel" aria-label={t('process.ui.detailAria', language)}>
          {selectedProcess ? (
            <>
              <header className="proc-detail-header">
                <span>PID</span>
                <strong>{selectedProcess.pid}</strong>
                <div className="proc-detail-header-actions">
                  <button
                    type="button"
                    onClick={() => void requestProcessInsight()}
                    disabled={processInsightLoadingPid !== null}
                    title={t('process.ui.aiIntro', language)}
                  >
                    {processInsightLoadingPid === selectedProcess.pid ? t('process.ui.analyzing', language) : 'AI'}
                  </button>
                  <button type="button" onClick={() => void copyToClipboard(String(selectedProcess.pid), ' PID')}>
                    {t('process.ui.copy', language)}
                  </button>
                </div>
              </header>

              <div className="proc-detail-metrics">
                <div>
                  <span>{isWindowsHost ? t('process.ui.cpuAccumulated', language) : 'CPU'}</span>
                  <strong>{formatCpu(selectedProcess, isWindowsHost)}</strong>
                </div>
                <div>
                  <span>{isWindowsHost ? t('process.ui.workingSet', language) : t('process.ui.memory', language)}</span>
                  <strong>{formatMemory(selectedProcess, isWindowsHost)}</strong>
                </div>
              </div>

              <dl className="proc-detail-list">
                <div>
                  <dt>PPID</dt>
                  <dd>{selectedProcess.ppid ?? '-'}</dd>
                </div>
                <div>
                  <dt>{t('process.ui.user', language)}</dt>
                  <dd title={selectedProcess.user}>{selectedProcess.user || '-'}</dd>
                </div>
                <div>
                  <dt>{t('process.ui.status', language)}</dt>
                  <dd><span className={`proc-stat-tag ${getStateTone(selectedProcess.state)}`}>{selectedProcess.state || '-'}</span></dd>
                </div>
                <div>
                  <dt>{t('process.ui.start', language)}</dt>
                  <dd>{selectedProcess.startTime || '-'}</dd>
                </div>
                <div>
                  <dt>{isWindowsHost ? t('process.ui.cpuTime', language) : t('process.ui.runtime', language)}</dt>
                  <dd>{selectedProcess.runtime || selectedProcess.cpuTime || '-'}</dd>
                </div>
                <div>
                  <dt>TTY</dt>
                  <dd>{selectedProcess.tty || '-'}</dd>
                </div>
              </dl>

              {processInsight?.pid === selectedProcess.pid ? (
                <section className={`proc-ai-insight ${processInsight.error ? 'danger' : ''}`} aria-label={t('process.ui.aiIntro', language)}>
                  <strong>{t('process.ui.aiIntro', language)}</strong>
                  {processInsight.error ? (
                    <span>{processInsight.error}</span>
                  ) : (
                    <p data-i18n-skip>{processInsight.content}</p>
                  )}
                </section>
              ) : null}

              <section className="proc-detail-section">
                <div className="proc-section-title">
                  <strong>{t('process.ui.commandLine', language)}</strong>
                  <button type="button" onClick={() => void copyToClipboard(selectedProcess.command, t('process.ui.commandLine', language))}>
                    {t('process.ui.copy', language)}
                  </button>
                </div>
                <pre className="proc-command-box">{selectedProcess.command}</pre>
                {(processDetail?.cwd || processDetail?.executablePath || selectedProcess.executablePath) ? (
                  <div className="proc-path-list">
                    {processDetail?.cwd ? <span title={processDetail.cwd}>cwd: {processDetail.cwd}</span> : null}
                    {processDetail?.executablePath || selectedProcess.executablePath ? (
                      <span title={processDetail?.executablePath || selectedProcess.executablePath}>
                        path: {processDetail?.executablePath || selectedProcess.executablePath}
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </section>

              <section className="proc-detail-section">
                <div className="proc-section-title">
                  <strong>{t('process.ui.parentChild', language)}</strong>
                  <span>{t('process.ui.childCount', language, { count: selectedChildren.length })}</span>
                </div>
                <div className="proc-relation-list">
                  {selectedParent ? (
                    <button type="button" onClick={() => setSelectedPid(selectedParent.pid)}>
                      <span>{t('process.ui.parentProcess', language)}</span>
                      <strong>{selectedParent.pid}</strong>
                      <em>{selectedParent.command}</em>
                    </button>
                  ) : (
                    <div className="proc-relation-empty">{t('process.ui.noParent', language)}</div>
                  )}
                  {selectedChildren.slice(0, 8).map((child) => (
                    <button key={child.pid} type="button" onClick={() => setSelectedPid(child.pid)}>
                      <span>{t('process.ui.childProcess', language)}</span>
                      <strong>{child.pid}</strong>
                      <em>{child.command}</em>
                    </button>
                  ))}
                  {selectedChildren.length > 8 ? (
                    <div className="proc-relation-empty">{t('process.ui.moreChildren', language, { count: selectedChildren.length - 8 })}</div>
                  ) : null}
                </div>
              </section>

              <section className="proc-detail-section">
                <div className="proc-section-title">
                  <strong>{t('process.ui.portOwnership', language)}</strong>
                  <button type="button" onClick={() => void loadProcessDetails(selectedProcess.pid)} disabled={detailLoading}>
                    {detailLoading ? t('process.ui.reading', language) : t('process.ui.reread', language)}
                  </button>
                </div>
                {processDetail?.error ? <div className="proc-detail-warning">{processDetail.error}</div> : null}
                {processDetail?.ports.length ? (
                  <div className="proc-port-list">
                    {processDetail.ports.slice(0, 6).map((port) => <code key={port}>{port}</code>)}
                    {processDetail.ports.length > 6 ? <span>{t('process.ui.morePorts', language, { count: processDetail.ports.length - 6 })}</span> : null}
                  </div>
                ) : (
                  <div className="proc-relation-empty">{detailLoading ? t('process.ui.readingPorts', language) : t('process.ui.noPorts', language)}</div>
                )}
              </section>

              <section className="proc-detail-section danger-zone">
                <div className="proc-section-title">
                  <strong>{isWindowsHost ? t('process.ui.endTask', language) : t('process.ui.sendSignal', language)}</strong>
                </div>
                {!isWindowsHost ? (
                  <>
                    <select className="proc-select" value={selectedSignalValue} onChange={(event) => setSelectedSignalValue(event.target.value)}>
                      {SIGNALS.map((signal) => (
                        <option key={signal.value} value={signal.value}>{signal.label}</option>
                      ))}
                    </select>
                    <p>{t(selectedSignal.descriptionId, language)}</p>
                  </>
                ) : (
                  <p>{t('process.ui.stopProcessHint', language)}</p>
                )}
                <button
                  type="button"
                  className="proc-danger-button"
                  disabled={signalingPid === selectedProcess.pid}
                  onClick={() => requestSignal(selectedProcess)}
                >
                  {signalingPid === selectedProcess.pid
                    ? t('process.ui.processing', language)
                    : isWindowsHost
                      ? t('process.ui.endProcess', language)
                      : t('process.ui.sendSignalButton', language, { signal: selectedSignal.name })}
                </button>
              </section>
            </>
          ) : (
            <div className="proc-detail-empty">
              <strong>{selectedPid === null ? t('process.ui.noSelected', language) : t('process.ui.pidMissingTitle', language, { pid: selectedPid })}</strong>
              <span>{selectedPid === null ? t('process.ui.selectPid', language) : t('process.ui.pidUnavailable', language)}</span>
            </div>
          )}
        </aside>
      </div>

      {contextMenu ? createPortal(
        <>
          <div
            className="proc-context-menu-overlay"
            onClick={closeContextMenu}
            onContextMenu={(event) => {
              event.preventDefault();
              closeContextMenu();
            }}
          />
          <div
            className="proc-context-menu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            role="menu"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="proc-context-menu-title">
              <strong>PID {contextMenu.process.pid}</strong>
              <span title={contextMenu.process.command}>{contextMenu.process.command}</span>
            </div>
            <button
              type="button"
              role="menuitem"
              className="danger-text"
              disabled={signalingPid === contextMenu.process.pid}
              onClick={() => {
                const targetProcess = contextMenu.process;
                closeContextMenu();
                requestSignal(targetProcess);
              }}
            >
              {signalingPid === contextMenu.process.pid
                ? t('process.ui.processing', language)
                : isWindowsHost
                  ? t('process.ui.endProcess', language)
                  : t('process.ui.terminateWithSignal', language, { signal: selectedSignal.name })}
            </button>
            <div className="proc-context-menu-sep" />
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const targetPid = contextMenu.process.pid;
                closeContextMenu();
                void copyToClipboard(String(targetPid), ' PID');
              }}
            >
              {t('process.ui.copyPid', language)}
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const targetCommand = contextMenu.process.command;
                closeContextMenu();
                void copyToClipboard(targetCommand, t('process.ui.commandLine', language));
              }}
            >
              {t('process.ui.copyCommandLine', language)}
            </button>
          </div>
        </>,
        document.body,
      ) : null}

      {aiReportOpen ? createPortal(
        <div className="proc-modal-overlay" role="presentation" onClick={() => setAiReportOpen(false)}>
          <div
            className="proc-modal proc-ai-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="proc-ai-report-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="proc-ai-modal-header">
              <div>
                <span>SD-Agent</span>
                <strong id="proc-ai-report-title">{t('process.ai.report.title', language)}</strong>
              </div>
              <button type="button" className="proc-ai-close" onClick={() => setAiReportOpen(false)} aria-label={t('process.ai.report.closeAria', language)}>×</button>
            </div>

            <div className={`proc-ai-progress ${aiReportPhase}`}>
              <div className="proc-ai-progress-bar" aria-hidden="true">
                <span />
              </div>
              <strong>{getAiReportPhaseLabel(aiReportPhase, language)}</strong>
              <em>{aiReportSnapshotNote || t('process.ai.report.snapshotIntro', language)}</em>
            </div>

            {aiReportError ? <DismissibleAlert className="proc-alert danger" onDismiss={() => setAiReportError('')} role="alert">{aiReportError}</DismissibleAlert> : null}
            {aiReportNotice ? <DismissibleAlert className="proc-alert success" onDismiss={() => setAiReportNotice('')}>{aiReportNotice}</DismissibleAlert> : null}

            <MarkdownReport
              className="proc-ai-report"
              content={aiReportText}
              placeholder={isAiReportBusy ? t('process.ai.report.placeholderGenerating', language) : t('process.ai.report.placeholderEmpty', language)}
              renderMarkdown={!isAiReportBusy}
              stickToBottom={isAiReportBusy}
            />

            <div className="proc-modal-actions proc-ai-modal-actions">
              <button type="button" className="proc-modal-btn" onClick={() => setAiReportOpen(false)}>{t('common.close', language)}</button>
              <button type="button" className="proc-modal-btn" onClick={() => void copyAiReport()} disabled={!aiReportText.trim()}>
                {t('process.ai.report.copy', language)}
              </button>
              <button type="button" className="proc-modal-btn primary" onClick={() => void exportAiReport()} disabled={!aiReportText.trim()}>
                {t('process.ai.report.export', language)}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}

      {pendingSignal ? createPortal(
        <div className="proc-modal-overlay" role="presentation" onClick={() => setPendingSignal(null)}>
          <div
            className="proc-modal"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="proc-signal-confirm-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div id="proc-signal-confirm-title" className="proc-modal-title">
              {isWindowsHost ? t('process.ui.endProcess', language) : t('process.ui.sendSignalButton', language, { signal: pendingSignal.signal.name })}
            </div>
            <div className="proc-modal-message">
              <p>{t('process.modal.targetPid', language)}<strong>{pendingSignal.pid}</strong></p>
              <p>{t(pendingSignal.signal.descriptionId, language)}</p>
              <code>{pendingSignal.command}</code>
            </div>
            <div className="proc-modal-actions">
              <button type="button" className="proc-modal-btn" onClick={() => setPendingSignal(null)}>{t('common.cancel', language)}</button>
              <button type="button" className="proc-modal-btn danger" onClick={() => void sendSignal(pendingSignal)}>
                {t('process.modal.confirmExecute', language)}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
      {sudoPrompt}
    </div>
  );
}

export default ProcessManager;

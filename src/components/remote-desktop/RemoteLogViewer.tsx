import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import DismissibleAlert from './DismissibleAlert';

import { getErrorMessage, getShellDeskLocale } from './desktopUtils';
import { isWindowsSystem, powershellCommand, powershellSingleQuote } from './remoteSystem';
import type { RemoteSystemType } from './types';
import { tCurrent } from '../../i18n';

type LogSourceType = 'journal' | 'file' | 'windows-event';
type LogLevelFilter = 'all' | 'error' | 'warning' | 'info';
type TimeRangePreset = 'all' | '15m' | '1h' | '24h' | 'custom';
type LogLineLevel = 'error' | 'warning' | 'info' | 'debug' | 'unknown';

interface RemoteLogViewerProps {
  connectionId: string;
  systemType?: RemoteSystemType;
}

interface LogSource {
  id: string;
  type: LogSourceType;
  label: string;
  value: string;
  description?: string;
  size?: number;
  modifiedAt?: string;
}

interface LogSourceGroup {
  id: string;
  label: string;
  sources: LogSource[];
}

interface LogQuery {
  keyword: string;
  level: LogLevelFilter;
  timeRange: TimeRangePreset;
  since: string;
  until: string;
  lines: number;
}

interface LogLine {
  id: string;
  timestamp?: string;
  level: LogLineLevel;
  service?: string;
  message: string;
  raw: string;
}

interface WindowsEventRecord {
  timeCreated?: unknown;
  level?: unknown;
  providerName?: unknown;
  eventId?: unknown;
  message?: unknown;
  raw?: unknown;
}

const defaultLines = 300;
const maxLines = 2000;
const pageSize = 300;

const levelOptions: Array<{ value: LogLevelFilter; label: string }> = [
  { value: 'all', label: tCurrent('auto.remoteLogViewer.12ej1cf') },
  { value: 'error', label: tCurrent('auto.remoteLogViewer.v9pftt') },
  { value: 'warning', label: tCurrent('auto.remoteLogViewer.1uwa1ih') },
  { value: 'info', label: tCurrent('auto.remoteLogViewer.1ieau49') },
];

const timeRangeOptions: Array<{ value: TimeRangePreset; label: string }> = [
  { value: 'all', label: tCurrent('auto.remoteLogViewer.sgku7j') },
  { value: '15m', label: tCurrent('auto.remoteLogViewer.9dfcbz') },
  { value: '1h', label: tCurrent('auto.remoteLogViewer.i1rszu') },
  { value: '24h', label: tCurrent('auto.remoteLogViewer.11z4msh') },
  { value: 'custom', label: tCurrent('auto.remoteLogViewer.ougzyc') },
];

const serviceShortcuts = [
  'sshd.service',
  'ssh.service',
  'nginx.service',
  'docker.service',
  'mysql.service',
  'redis.service',
];

const fileLevelPatterns: Record<Exclude<LogLevelFilter, 'all'>, string> = {
  error: 'error|err|fatal|panic|critical|crit|alert|emerg|exception|failed|failure|denied',
  warning: 'warn|warning|deprecated|timeout|retry|slow|unreachable',
  info: 'info|notice|started|stopped|listening|accepted|connected|success',
};

const errorPattern = /\b(error|err|fatal|panic|critical|crit|alert|emerg|exception|failed|failure|denied)\b/i;
const warningPattern = /\b(warn|warning|deprecated|timeout|retry|slow|unreachable)\b/i;
const debugPattern = /\b(debug|trace|verbose)\b/i;

function runCmd(connectionId: string, command: string) {
  const api = window.guiSSH?.connections;

  if (!api) {
    throw new Error(tCurrent('auto.remoteLogViewer.g77vf3'));
  }

  return api.runCommand(connectionId, command);
}

function shellSingleQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function sanitizeSingleLine(value: string) {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

function clampLines(value: number) {
  if (!Number.isFinite(value)) {
    return defaultLines;
  }

  return Math.min(Math.max(Math.round(value), 20), maxLines);
}

function readString(value: unknown) {
  if (typeof value === 'string') {
    return value.trim();
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  return '';
}

function formatBytes(value: number | undefined) {
  if (!value || !Number.isFinite(value) || value <= 0) {
    return '';
  }

  const units = ['B', 'KB', 'MB', 'GB'];
  let nextValue = value;
  let unitIndex = 0;

  while (nextValue >= 1024 && unitIndex < units.length - 1) {
    nextValue /= 1024;
    unitIndex += 1;
  }

  const precision = nextValue >= 100 ? 0 : nextValue >= 10 ? 1 : 2;
  return `${nextValue.toFixed(precision).replace(/\.0+$/, '')} ${units[unitIndex]}`;
}

function formatLoadedAt(value: number | null) {
  if (!value) {
    return tCurrent('auto.remoteLogViewer.snxhdy');
  }

  return new Intl.DateTimeFormat(getShellDeskLocale(), {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(value));
}

function normalizeDateTimeInput(value: string) {
  return sanitizeSingleLine(value).replace('T', ' ');
}

function parseTimestampToMs(value: string | undefined) {
  if (!value) {
    return undefined;
  }

  const normalizedValue = value.trim();
  const directDate = new Date(normalizedValue);

  if (!Number.isNaN(directDate.getTime())) {
    return directDate.getTime();
  }

  const syslogMatch = normalizedValue.match(/^([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})$/);

  if (!syslogMatch) {
    return undefined;
  }

  const year = new Date().getFullYear();
  const syslogDate = new Date(`${syslogMatch[1]} ${syslogMatch[2]}, ${year} ${syslogMatch[3]}:${syslogMatch[4]}:${syslogMatch[5]}`);

  if (Number.isNaN(syslogDate.getTime())) {
    return undefined;
  }

  return syslogDate.getTime();
}

function getTimeRangeBounds(query: LogQuery) {
  const now = Date.now();

  if (query.timeRange === '15m') {
    return { since: now - 15 * 60 * 1000, until: undefined };
  }

  if (query.timeRange === '1h') {
    return { since: now - 60 * 60 * 1000, until: undefined };
  }

  if (query.timeRange === '24h') {
    return { since: now - 24 * 60 * 60 * 1000, until: undefined };
  }

  if (query.timeRange !== 'custom') {
    return { since: undefined, until: undefined };
  }

  const sinceMs = query.since ? new Date(query.since).getTime() : Number.NaN;
  const untilMs = query.until ? new Date(query.until).getTime() : Number.NaN;

  return {
    since: Number.isNaN(sinceMs) ? undefined : sinceMs,
    until: Number.isNaN(untilMs) ? undefined : untilMs,
  };
}

function filterLinesByTimeRange(lines: LogLine[], query: LogQuery) {
  if (query.timeRange === 'all') {
    return lines;
  }

  const { since: sinceMs, until: untilMs } = getTimeRangeBounds(query);

  if (sinceMs === undefined && untilMs === undefined) {
    return lines;
  }

  let lastTimestampMs: number | undefined;

  return lines.filter((line) => {
    const timestampMs = parseTimestampToMs(line.timestamp);

    if (timestampMs !== undefined) {
      lastTimestampMs = timestampMs;
    }

    const effectiveTimestampMs = timestampMs ?? lastTimestampMs;

    if (effectiveTimestampMs === undefined) {
      return true;
    }

    if (sinceMs !== undefined && effectiveTimestampMs < sinceMs) {
      return false;
    }

    if (untilMs !== undefined && effectiveTimestampMs > untilMs) {
      return false;
    }

    return true;
  });
}

function normalizeLogLevel(levelValue: string, raw: string): LogLineLevel {
  const combined = `${levelValue} ${raw}`.toLowerCase();

  if (combined.includes('critical') || combined.includes('error') || /\berr\b/.test(combined) || errorPattern.test(combined)) {
    return 'error';
  }

  if (combined.includes('warning') || /\bwarn\b/.test(combined) || warningPattern.test(combined)) {
    return 'warning';
  }

  if (debugPattern.test(combined)) {
    return 'debug';
  }

  if (combined.includes('information') || combined.includes('info') || combined.includes('notice')) {
    return 'info';
  }

  return 'unknown';
}

function getLevelLabel(level: LogLineLevel) {
  if (level === 'error') return tCurrent('auto.remoteLogViewer.v9pftt2');
  if (level === 'warning') return tCurrent('auto.remoteLogViewer.1uwa1ih2');
  if (level === 'info') return tCurrent('auto.remoteLogViewer.1ieau492');
  if (level === 'debug') return tCurrent('auto.remoteLogViewer.14582sl');
  return tCurrent('auto.remoteLogViewer.1k863h1');
}

function parseLinuxLogLine(raw: string, index: number): LogLine {
  const trimmedRaw = raw.trimEnd();
  const isoMatch = trimmedRaw.match(/^(\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\s+(.*)$/);
  const syslogMatch = trimmedRaw.match(/^([A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})\s+(.*)$/);
  const timestamp = isoMatch?.[1] ?? syslogMatch?.[1];
  const body = isoMatch?.[2] ?? syslogMatch?.[2] ?? trimmedRaw;
  const serviceMatch = body.match(/(?:^|\s)([A-Za-z0-9_.@:/-]+)(?:\[\d+\])?:\s+(.*)$/);
  const service = serviceMatch?.[1];
  const message = serviceMatch?.[2] ?? body;

  return {
    id: `log-${index}-${trimmedRaw.slice(0, 32)}`,
    timestamp,
    level: normalizeLogLevel('', trimmedRaw),
    service,
    message,
    raw: trimmedRaw,
  };
}

function parseLinuxLogOutput(stdout: string): LogLine[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map(parseLinuxLogLine);
}

function parseWindowsEventOutput(stdout: string): LogLine[] {
  const text = stdout.trim();

  if (!text) {
    return [];
  }

  const parsedJson = JSON.parse(text) as unknown;
  const records = Array.isArray(parsedJson) ? parsedJson : [parsedJson];

  return records
    .map<LogLine | null>((record, index) => {
      if (!record || typeof record !== 'object') {
        return null;
      }

      const eventRecord = record as WindowsEventRecord;
      const timestamp = readString(eventRecord.timeCreated);
      const levelValue = readString(eventRecord.level);
      const service = readString(eventRecord.providerName);
      const eventId = readString(eventRecord.eventId);
      const message = readString(eventRecord.message);
      const raw = readString(eventRecord.raw) || [timestamp, levelValue ? `[${levelValue}]` : '', service, eventId ? `#${eventId}` : '', message]
        .filter(Boolean)
        .join(' ');

      return {
        id: `event-${index}-${timestamp}-${eventId}`,
        timestamp,
        level: normalizeLogLevel(levelValue, raw),
        service,
        message,
        raw,
      };
    })
    .filter((line): line is LogLine => Boolean(line));
}

function parseLogFiles(stdout: string): LogSource[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map<LogSource | null>((line) => {
      const [pathValue, sizeValue, modifiedAt] = line.split('\t');
      const path = pathValue?.trim();

      if (!path) {
        return null;
      }

      const size = Number.parseInt(sizeValue ?? '', 10);

      return {
        id: `file:${path}`,
        type: 'file',
        label: path.replace(/^\/var\/log\/?/, '') || path,
        value: path,
        description: [Number.isFinite(size) ? formatBytes(size) : '', modifiedAt].filter(Boolean).join(' · '),
        size: Number.isFinite(size) ? size : undefined,
        modifiedAt: modifiedAt || undefined,
      };
    })
    .filter((source): source is LogSource => Boolean(source));
}

function getLinuxLogFilesCommand() {
  return `
if [ ! -d /var/log ]; then
  exit 0
fi
find /var/log -maxdepth 2 -type f 2>/dev/null | while IFS= read -r file; do
  case "$file" in
    *.gz|*.xz|*.bz2|*.zip|*.zst|*.lz4) continue ;;
  esac
  [ -r "$file" ] || continue
  size=$(wc -c < "$file" 2>/dev/null || printf 0)
  modified=$(date -r "$file" '+%Y-%m-%d %H:%M' 2>/dev/null || printf '')
  printf '%s\\t%s\\t%s\\n' "$file" "$size" "$modified"
done | sort | head -n 160
`;
}

function getLinuxTimeArgs(query: LogQuery) {
  if (query.timeRange === '15m') {
    return "--since '15 minutes ago'";
  }

  if (query.timeRange === '1h') {
    return "--since '1 hour ago'";
  }

  if (query.timeRange === '24h') {
    return "--since '24 hours ago'";
  }

  if (query.timeRange !== 'custom') {
    return '';
  }

  const args: string[] = [];
  const since = normalizeDateTimeInput(query.since);
  const until = normalizeDateTimeInput(query.until);

  if (since) {
    args.push(`--since ${shellSingleQuote(since)}`);
  }

  if (until) {
    args.push(`--until ${shellSingleQuote(until)}`);
  }

  return args.join(' ');
}

function getJournalPriorityArg(level: LogLevelFilter) {
  if (level === 'error') {
    return '-p err';
  }

  if (level === 'warning') {
    return '-p warning';
  }

  if (level === 'info') {
    return '-p info';
  }

  return '';
}

function getLinuxJournalCommand(serviceName: string, query: LogQuery) {
  const lines = clampLines(query.lines);
  const keyword = sanitizeSingleLine(query.keyword);
  const fetchLines = keyword ? Math.min(lines * 8, 8000) : lines;
  const unitArg = serviceName ? `-u ${shellSingleQuote(serviceName)}` : '';
  const timeArgs = getLinuxTimeArgs(query);
  const priorityArg = getJournalPriorityArg(query.level);
  const grepArg = keyword ? ` | grep -ai -- ${shellSingleQuote(keyword)}` : '';

  return tCurrent('auto.remoteLogViewer.1ezlp1g', { value0: fetchLines, value1: unitArg, value2: timeArgs, value3: priorityArg, value4: grepArg, value5: lines });
}

function getLinuxFileLogCommand(filePath: string, query: LogQuery) {
  const lines = clampLines(query.lines);
  const keyword = sanitizeSingleLine(query.keyword);
  const fetchLines = keyword || query.level !== 'all' || query.timeRange !== 'all' ? Math.min(lines * 10, 10000) : lines;
  const pipelineParts = [`tail -n ${fetchLines} -- "$log_file" 2>&1`];

  if (query.level !== 'all') {
    pipelineParts.push(`grep -aiE -- ${shellSingleQuote(fileLevelPatterns[query.level])}`);
  }

  if (keyword) {
    pipelineParts.push(`grep -ai -- ${shellSingleQuote(keyword)}`);
  }

  pipelineParts.push(`tail -n ${lines}`);

  return tCurrent('auto.remoteLogViewer.1mrqfba', { value0: shellSingleQuote(filePath), value1: pipelineParts.join(' | ') });
}

function getWindowsTimeScript(query: LogQuery) {
  if (query.timeRange === '15m') {
    return '$filter.StartTime = (Get-Date).AddMinutes(-15)';
  }

  if (query.timeRange === '1h') {
    return '$filter.StartTime = (Get-Date).AddHours(-1)';
  }

  if (query.timeRange === '24h') {
    return '$filter.StartTime = (Get-Date).AddDays(-1)';
  }

  if (query.timeRange !== 'custom') {
    return '';
  }

  const lines: string[] = [];
  const since = sanitizeSingleLine(query.since);
  const until = sanitizeSingleLine(query.until);

  if (since) {
    lines.push(`$filter.StartTime = [datetime]${powershellSingleQuote(since)}`);
  }

  if (until) {
    lines.push(`$filter.EndTime = [datetime]${powershellSingleQuote(until)}`);
  }

  return lines.join('\n');
}

function getWindowsLevelScript(level: LogLevelFilter) {
  if (level === 'error') {
    return '$items = $items | Where-Object { $_.level -match "Critical|Error|^1$|^2$" }';
  }

  if (level === 'warning') {
    return '$items = $items | Where-Object { $_.level -match "Warning|^3$" }';
  }

  if (level === 'info') {
    return '$items = $items | Where-Object { $_.level -match "Information|Info|^4$" }';
  }

  return '';
}

function getWindowsEventCommand(logName: string, query: LogQuery) {
  const lines = clampLines(query.lines);
  const keyword = sanitizeSingleLine(query.keyword);
  const fetchLimit = keyword || query.level !== 'all' ? Math.min(lines * 8, 4000) : lines;
  const keywordScript = keyword ? `
$needle = ${powershellSingleQuote(keyword)}
$items = $items | Where-Object {
  ([string]$_.message).IndexOf($needle, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -or
  ([string]$_.providerName).IndexOf($needle, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -or
  ([string]$_.eventId).IndexOf($needle, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
}
` : '';

  return powershellCommand(`
$logName = ${powershellSingleQuote(logName || 'System')}
$filter = @{ LogName = $logName }
${getWindowsTimeScript(query)}

function Format-ShellDeskEventTime($value) {
  if (-not $value) { return "" }
  try { return $value.ToString("yyyy-MM-dd HH:mm:ss") } catch { return [string]$value }
}

function Get-ShellDeskEventMessage($event) {
  try {
    $text = [string]$event.Message
    if ($text) { return ($text -replace "\\s+", " ").Trim() }
  } catch {}

  return ""
}

function Convert-ShellDeskWinEvent($event) {
  $message = Get-ShellDeskEventMessage $event
  $level = [string]$event.LevelDisplayName
  if (-not $level) { $level = [string]$event.Level }

  [pscustomobject]@{
    timeCreated = Format-ShellDeskEventTime $event.TimeCreated
    level = $level
    providerName = [string]$event.ProviderName
    eventId = [int]$event.Id
    message = $message
    raw = "{0} [{1}] {2} #{3} {4}" -f (Format-ShellDeskEventTime $event.TimeCreated), $level, $event.ProviderName, $event.Id, $message
  }
}

function Convert-ShellDeskEventLogEntry($event) {
  $message = ""
  try {
    $message = ([string]$event.Message -replace "\\s+", " ").Trim()
  } catch {}

  [pscustomobject]@{
    timeCreated = Format-ShellDeskEventTime $event.TimeGenerated
    level = [string]$event.EntryType
    providerName = [string]$event.Source
    eventId = [int]$event.EventID
    message = $message
    raw = "{0} [{1}] {2} #{3} {4}" -f (Format-ShellDeskEventTime $event.TimeGenerated), $event.EntryType, $event.Source, $event.EventID, $message
  }
}

try {
  $events = @(Get-WinEvent -FilterHashtable $filter -MaxEvents ${fetchLimit} -ErrorAction SilentlyContinue)
} catch {
  $events = @()
}
$items = @($events | ForEach-Object { Convert-ShellDeskWinEvent $_ })

if ($items.Count -eq 0 -and (Get-Command Get-EventLog -ErrorAction SilentlyContinue)) {
  $fallbackArgs = @{ LogName = $logName; Newest = ${fetchLimit}; ErrorAction = 'SilentlyContinue' }
  if ($filter.StartTime) { $fallbackArgs.After = $filter.StartTime }
  if ($filter.EndTime) { $fallbackArgs.Before = $filter.EndTime }
  try {
    $fallbackEvents = @(Get-EventLog @fallbackArgs)
  } catch {
    $fallbackEvents = @()
  }
  $items = @($fallbackEvents | ForEach-Object { Convert-ShellDeskEventLogEntry $_ })
}

${getWindowsLevelScript(query.level)}
${keywordScript}
$items = @($items | Select-Object -First ${lines})

if ($items.Count -eq 0) {
  "[]"
} else {
  ConvertTo-Json -InputObject $items -Compress -Depth 4
}
`);
}

function getSelectedLineText(lines: LogLine[], selectedLineIds: Set<string>) {
  return lines
    .filter((line) => selectedLineIds.has(line.id))
    .map((line) => line.raw)
    .join('\n');
}

function renderHighlightedText(text: string, keyword: string) {
  const query = keyword.trim();

  if (!query) {
    return text;
  }

  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const parts: ReactNode[] = [];
  let cursor = 0;
  let matchIndex = lowerText.indexOf(lowerQuery, cursor);
  let key = 0;

  while (matchIndex !== -1 && key < 200) {
    if (matchIndex > cursor) {
      parts.push(text.slice(cursor, matchIndex));
    }

    parts.push(<mark key={`hit-${key}`}>{text.slice(matchIndex, matchIndex + query.length)}</mark>);
    cursor = matchIndex + query.length;
    matchIndex = lowerText.indexOf(lowerQuery, cursor);
    key += 1;
  }

  if (cursor < text.length) {
    parts.push(text.slice(cursor));
  }

  return parts.length ? parts : text;
}

function RemoteLogViewer({ connectionId, systemType }: RemoteLogViewerProps) {
  const isWindowsHost = isWindowsSystem(systemType);
  const defaultSourceId = isWindowsHost ? 'event:System' : 'journal:system';
  const isMountedRef = useRef(true);
  const queryRequestIdRef = useRef(0);
  const initialQueryKeyRef = useRef('');
  const [logFiles, setLogFiles] = useState<LogSource[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState(defaultSourceId);
  const [serviceName, setServiceName] = useState('nginx.service');
  const [filePath, setFilePath] = useState('/var/log/syslog');
  const [keyword, setKeyword] = useState('');
  const [level, setLevel] = useState<LogLevelFilter>('all');
  const [timeRange, setTimeRange] = useState<TimeRangePreset>('24h');
  const [since, setSince] = useState('');
  const [until, setUntil] = useState('');
  const [lines, setLines] = useState(defaultLines);
  const [logLines, setLogLines] = useState<LogLine[]>([]);
  const [selectedLineIds, setSelectedLineIds] = useState<Set<string>>(() => new Set());
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [filesLoading, setFilesLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [success, setSuccess] = useState('');
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [loadedSourceLabel, setLoadedSourceLabel] = useState('');

  const sourceGroups = useMemo<LogSourceGroup[]>(() => {
    if (isWindowsHost) {
      return [
        {
          id: 'windows-events',
          label: 'Windows Event Log',
          sources: [
            { id: 'event:System', type: 'windows-event', label: 'System', value: 'System', description: tCurrent('auto.remoteLogViewer.8pjb5q') },
            { id: 'event:Application', type: 'windows-event', label: 'Application', value: 'Application', description: tCurrent('auto.remoteLogViewer.qfh8h4') },
          ],
        },
      ];
    }

    return [
      {
        id: 'journal',
        label: 'Journal',
        sources: [
          { id: 'journal:system', type: 'journal', label: tCurrent('auto.remoteLogViewer.u4rwyj'), value: '', description: 'journalctl' },
          ...serviceShortcuts.map((service) => ({
            id: `journal:${service}`,
            type: 'journal' as const,
            label: service.replace(/\.service$/, ''),
            value: service,
            description: service,
          })),
        ],
      },
      {
        id: 'files',
        label: '/var/log',
        sources: [
          ...logFiles,
        ],
      },
    ];
  }, [isWindowsHost, logFiles]);

  const hiddenCustomSources = useMemo<LogSource[]>(() => (
    isWindowsHost ? [] : [
      { id: 'journal:service-custom', type: 'journal', label: tCurrent('auto.remoteLogViewer.1cvisgn'), value: '__service__', description: serviceName || tCurrent('auto.remoteLogViewer.1j7v06k') },
      { id: 'file:custom', type: 'file', label: tCurrent('auto.remoteLogViewer.54ua59'), value: '', description: filePath || tCurrent('auto.remoteLogViewer.14l3w5a') },
    ]
  ), [filePath, isWindowsHost, serviceName]);

  const allSources = useMemo(
    () => [...sourceGroups.flatMap((group) => group.sources), ...hiddenCustomSources],
    [hiddenCustomSources, sourceGroups],
  );
  const selectedSource = allSources.find((source) => source.id === selectedSourceId) ?? allSources[0];

  const resolvedSource = useMemo<LogSource>(() => {
    if (!selectedSource) {
      return isWindowsHost
        ? { id: 'event:System', type: 'windows-event', label: 'System', value: 'System' }
        : { id: 'journal:system', type: 'journal', label: tCurrent('auto.remoteLogViewer.u4rwyj2'), value: '' };
    }

    if (selectedSource.id === 'journal:service-custom') {
      const unit = sanitizeSingleLine(serviceName);
      return {
        ...selectedSource,
        label: unit || selectedSource.label,
        value: unit,
      };
    }

    if (selectedSource.id === 'file:custom') {
      const path = sanitizeSingleLine(filePath);
      return {
        ...selectedSource,
        label: path || selectedSource.label,
        value: path,
      };
    }

    return selectedSource;
  }, [filePath, isWindowsHost, selectedSource, serviceName]);

  const query = useMemo<LogQuery>(() => ({
    keyword,
    level,
    timeRange,
    since,
    until,
    lines: clampLines(lines),
  }), [keyword, level, lines, since, timeRange, until]);

  const pageCount = Math.max(1, Math.ceil(logLines.length / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const pageLines = logLines.slice(currentPage * pageSize, currentPage * pageSize + pageSize);
  const selectedText = useMemo(() => getSelectedLineText(logLines, selectedLineIds), [logLines, selectedLineIds]);
  const stats = useMemo(() => ({
    error: logLines.filter((line) => line.level === 'error').length,
    warning: logLines.filter((line) => line.level === 'warning').length,
    info: logLines.filter((line) => line.level === 'info').length,
    debug: logLines.filter((line) => line.level === 'debug').length,
  }), [logLines]);

  const loadLogFiles = useCallback(async () => {
    if (isWindowsHost) {
      return;
    }

    setFilesLoading(true);
    setNotice('');

    try {
      const result = await runCmd(connectionId, getLinuxLogFilesCommand());
      const nextFiles = parseLogFiles(result.stdout || '');

      if (!isMountedRef.current) {
        return;
      }

      setLogFiles(nextFiles);

      if (result.code !== 0 && nextFiles.length === 0) {
        setNotice(result.stderr || result.stdout || tCurrent('auto.remoteLogViewer.1vw7iqm'));
      }
    } catch (err) {
      if (isMountedRef.current) {
        setNotice(tCurrent('auto.remoteLogViewer.okpgji', { value0: getErrorMessage(err) }));
      }
    } finally {
      if (isMountedRef.current) {
        setFilesLoading(false);
      }
    }
  }, [connectionId, isWindowsHost]);

  const executeQuery = useCallback(async (sourceOverride?: LogSource) => {
    const querySource = sourceOverride ?? resolvedSource;
    const requestId = queryRequestIdRef.current + 1;
    queryRequestIdRef.current = requestId;
    setLoading(true);
    setError('');
    setNotice('');
    setSuccess('');
    setSelectedLineIds(new Set());

    try {
      if (querySource.type === 'journal' && querySource.id !== 'journal:system' && !querySource.value) {
        throw new Error(tCurrent('auto.remoteLogViewer.3pqh09'));
      }

      if (querySource.type === 'file' && !querySource.value) {
        throw new Error(tCurrent('auto.remoteLogViewer.103hc1q'));
      }

      const command = isWindowsHost
        ? getWindowsEventCommand(querySource.value || 'System', query)
        : querySource.type === 'file'
          ? getLinuxFileLogCommand(querySource.value, query)
          : getLinuxJournalCommand(querySource.value, query);
      const result = await runCmd(connectionId, command);
      const parsedLines = isWindowsHost
        ? parseWindowsEventOutput(result.stdout || '')
        : parseLinuxLogOutput(result.stdout || '');
      const nextLines = !isWindowsHost && querySource.type === 'file'
        ? filterLinesByTimeRange(parsedLines, query)
        : parsedLines;

      if (result.code !== 0 && nextLines.length === 0) {
        throw new Error(result.stderr || result.stdout || tCurrent('auto.remoteLogViewer.1amadvq'));
      }

      if (!isMountedRef.current || requestId !== queryRequestIdRef.current) {
        return;
      }

      setLogLines(nextLines);
      setPage(0);
      setLoadedAt(Date.now());
      setLoadedSourceLabel(querySource.label);

      if (result.code !== 0) {
        setNotice(result.stderr || tCurrent('auto.remoteLogViewer.1wn95my'));
      }
    } catch (err) {
      if (isMountedRef.current && requestId === queryRequestIdRef.current) {
        setError(getErrorMessage(err));
        setLogLines([]);
        setLoadedAt(Date.now());
        setLoadedSourceLabel(querySource.label);
      }
    } finally {
      if (isMountedRef.current && requestId === queryRequestIdRef.current) {
        setLoading(false);
      }
    }
  }, [connectionId, isWindowsHost, query, resolvedSource]);

  useEffect(() => {
    isMountedRef.current = true;

    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    initialQueryKeyRef.current = '';
    setSelectedSourceId(defaultSourceId);
    setLogLines([]);
    setSelectedLineIds(new Set());
    setLoadedAt(null);
    setLoadedSourceLabel('');
  }, [connectionId, defaultSourceId]);

  useEffect(() => {
    void loadLogFiles();
  }, [loadLogFiles]);

  useEffect(() => {
    if (selectedSourceId !== defaultSourceId) {
      return;
    }

    const key = `${connectionId}:${defaultSourceId}`;

    if (initialQueryKeyRef.current === key) {
      return;
    }

    initialQueryKeyRef.current = key;
    void executeQuery();
  }, [connectionId, defaultSourceId, executeQuery, selectedSourceId]);

  useEffect(() => {
    setPage(0);
  }, [logLines.length]);

  const selectSource = (source: LogSource) => {
    setSelectedSourceId(source.id);
    setError('');
    setSuccess('');
    let nextSource = source;

    if (source.type === 'journal' && source.value && source.value !== '__service__') {
      setServiceName(source.value);
    }

    if (source.type === 'file' && source.value) {
      setFilePath(source.value);
    }

    if (source.id === 'journal:service-custom') {
      const unit = sanitizeSingleLine(serviceName);
      nextSource = {
        ...source,
        label: unit || source.label,
        value: unit,
      };
    } else if (source.id === 'file:custom') {
      const path = sanitizeSingleLine(filePath);
      nextSource = {
        ...source,
        label: path || source.label,
        value: path,
      };
    }

    void executeQuery(nextSource);
  };

  const toggleLineSelection = (lineId: string) => {
    setSelectedLineIds((current) => {
      const next = new Set(current);

      if (next.has(lineId)) {
        next.delete(lineId);
      } else {
        next.add(lineId);
      }

      return next;
    });
  };

  const toggleCurrentPageSelection = () => {
    setSelectedLineIds((current) => {
      const next = new Set(current);
      const allSelected = pageLines.length > 0 && pageLines.every((line) => next.has(line.id));

      pageLines.forEach((line) => {
        if (allSelected) {
          next.delete(line.id);
        } else {
          next.add(line.id);
        }
      });

      return next;
    });
  };

  const copyToClipboard = async (value: string, label: string) => {
    setError('');
    setSuccess('');

    try {
      await navigator.clipboard.writeText(value);
      setSuccess(tCurrent('auto.remoteLogViewer.1wvs77j', { value0: label }));
    } catch (err) {
      setError(tCurrent('auto.remoteLogViewer.cd1xgf', { value0: getErrorMessage(err) }));
    }
  };

  const clearResults = () => {
    setLogLines([]);
    setSelectedLineIds(new Set());
    setError('');
    setNotice('');
    setSuccess('');
    setLoadedAt(null);
    setLoadedSourceLabel('');
  };

  const renderSourceButton = (source: LogSource) => {
    const isSelected = source.id === selectedSourceId;

    return (
      <button
        key={source.id}
        type="button"
        className={`log-source-item ${isSelected ? 'selected' : ''}`}
        onClick={() => selectSource(source)}
      >
        <span className={`log-source-kind ${source.type}`}>{source.type === 'file' ? 'FILE' : source.type === 'windows-event' ? 'EVT' : 'JNL'}</span>
        <span className="log-source-main">
          <strong title={source.value || source.label}>{source.label}</strong>
          {source.description ? <small title={source.description}>{source.description}</small> : null}
        </span>
      </button>
    );
  };

  return (
    <div className="log-viewer">
      <div className="log-toolbar">
        <div className="log-toolbar-left">
          <button type="button" className="log-tool-button primary" onClick={() => void executeQuery()} disabled={loading}>
            {loading ? tCurrent('auto.remoteLogViewer.q3j9w1') : tCurrent('auto.remoteLogViewer.16mfmhy')}
          </button>
          <button type="button" className="log-tool-button" onClick={() => void executeQuery()} disabled={loading}>
            {tCurrent('auto.remoteLogViewer.12qo56a')}</button>
          <button type="button" className="log-tool-button" onClick={clearResults} disabled={!logLines.length && !error}>
            {tCurrent('auto.remoteLogViewer.9mbwb2')}</button>
          {!isWindowsHost ? (
            <button type="button" className="log-tool-button" onClick={() => void loadLogFiles()} disabled={filesLoading}>
              {filesLoading ? tCurrent('auto.remoteLogViewer.15wbj2u') : tCurrent('auto.remoteLogViewer.1dovqdy')}
            </button>
          ) : null}
          <span className="log-system-pill">{isWindowsHost ? 'Windows Event Log' : tCurrent('auto.remoteLogViewer.1rlrh2l')}</span>
        </div>

        <div className="log-toolbar-right">
          <select className="log-select" value={level} onChange={(event) => setLevel(event.target.value as LogLevelFilter)} aria-label={tCurrent('auto.remoteLogViewer.1e9o6nb')}>
            {levelOptions.map((item) => (
              <option key={item.value} value={item.value}>{item.label}</option>
            ))}
          </select>
          <select className="log-select log-time-select" value={timeRange} onChange={(event) => setTimeRange(event.target.value as TimeRangePreset)} aria-label={tCurrent('auto.remoteLogViewer.1jsn57s')}>
            {timeRangeOptions.map((item) => (
              <option key={item.value} value={item.value}>{item.label}</option>
            ))}
          </select>
          <input
            type="number"
            className="log-lines-input"
            min={20}
            max={maxLines}
            step={20}
            value={lines}
            onChange={(event) => setLines(clampLines(Number(event.target.value)))}
            aria-label={tCurrent('auto.remoteLogViewer.rcdahk')}
          />
        </div>
      </div>

      <div className="log-query-row">
        {resolvedSource.type === 'journal' && resolvedSource.id !== 'journal:system' ? (
          <input
            type="text"
            className="log-source-input"
            value={serviceName}
            onChange={(event) => {
              setSelectedSourceId('journal:service-custom');
              setServiceName(event.target.value);
            }}
            placeholder={tCurrent('auto.remoteLogViewer.cysdly')}
            aria-label={tCurrent('auto.remoteLogViewer.j60ypu')}
          />
        ) : null}
        {resolvedSource.type === 'file' ? (
          <input
            type="text"
            className="log-source-input"
            value={filePath}
            onChange={(event) => {
              setSelectedSourceId('file:custom');
              setFilePath(event.target.value);
            }}
            placeholder="/var/log/nginx/error.log"
            aria-label={tCurrent('auto.remoteLogViewer.1w847h7')}
          />
        ) : null}
        <input
          type="search"
          className="log-keyword-input"
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder={tCurrent('auto.remoteLogViewer.73rkrv')}
          aria-label={tCurrent('auto.remoteLogViewer.kzmopb')}
        />
        {timeRange === 'custom' ? (
          <>
            <input
              type="datetime-local"
              className="log-date-input"
              value={since}
              onChange={(event) => setSince(event.target.value)}
              aria-label={tCurrent('auto.remoteLogViewer.j6x7pa')}
            />
            <input
              type="datetime-local"
              className="log-date-input"
              value={until}
              onChange={(event) => setUntil(event.target.value)}
              aria-label={tCurrent('auto.remoteLogViewer.9uebcl')}
            />
          </>
        ) : null}
      </div>

      {error ? <DismissibleAlert className="log-alert danger" onDismiss={() => setError('')} role="alert">{error}</DismissibleAlert> : null}
      {notice ? <DismissibleAlert className="log-alert info" onDismiss={() => setNotice('')}>{notice}</DismissibleAlert> : null}
      {success ? <DismissibleAlert className="log-alert success" onDismiss={() => setSuccess('')}>{success}</DismissibleAlert> : null}

      <div className="log-content">
        <aside className="log-source-panel" aria-label={tCurrent('auto.remoteLogViewer.1bgbscg')}>
          {sourceGroups.map((group) => (
            <section key={group.id} className="log-source-section">
              <header>
                <strong>{group.label}</strong>
                <span>{group.sources.length}</span>
              </header>
              <div className="log-source-list">
                {group.sources.map(renderSourceButton)}
              </div>
            </section>
          ))}
        </aside>

        <section className="log-result-panel" aria-label={tCurrent('auto.remoteLogViewer.io11t6')}>
          <header className="log-result-header">
            <div>
              <span>{loadedSourceLabel || resolvedSource.label}</span>
              <strong>{logLines.length} {tCurrent('auto.remoteLogViewer.1jjui7f')}</strong>
              <small>{formatLoadedAt(loadedAt)}</small>
            </div>
            <div className="log-result-actions">
              <button type="button" onClick={toggleCurrentPageSelection} disabled={!pageLines.length}>
                {pageLines.length && pageLines.every((line) => selectedLineIds.has(line.id)) ? tCurrent('auto.remoteLogViewer.rgejoo') : tCurrent('auto.remoteLogViewer.dzux0c')}
              </button>
              <button type="button" onClick={() => void copyToClipboard(selectedText, tCurrent('auto.remoteLogViewer.7c0mqv'))} disabled={!selectedText}>
                {tCurrent('auto.remoteLogViewer.xgwaxo')}</button>
              <button type="button" onClick={() => void copyToClipboard(logLines.map((line) => line.raw).join('\n'), tCurrent('auto.remoteLogViewer.ocy7fh'))} disabled={!logLines.length}>
                {tCurrent('auto.remoteLogViewer.jxtocq')}</button>
            </div>
          </header>

          <div className="log-stats">
            <span><strong>{stats.error}</strong> {tCurrent('auto.remoteLogViewer.v9pftt3')}</span>
            <span><strong>{stats.warning}</strong> {tCurrent('auto.remoteLogViewer.1uwa1ih3')}</span>
            <span><strong>{stats.info}</strong> {tCurrent('auto.remoteLogViewer.1ieau493')}</span>
            <span><strong>{stats.debug}</strong> {tCurrent('auto.remoteLogViewer.14582sl2')}</span>
          </div>

          <div className="log-lines" role="list">
            {loading ? (
              <div className="log-empty">{tCurrent('auto.remoteLogViewer.1bxngjg')}</div>
            ) : pageLines.length ? (
              pageLines.map((line, index) => {
                const absoluteIndex = currentPage * pageSize + index + 1;
                const isSelected = selectedLineIds.has(line.id);

                return (
                  <label key={line.id} className={`log-line log-line-${line.level} ${isSelected ? 'selected' : ''}`} role="listitem">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleLineSelection(line.id)}
                      aria-label={tCurrent('auto.remoteLogViewer.1e8zp72', { value0: absoluteIndex })}
                    />
                    <span className="log-line-no">{absoluteIndex}</span>
                    <span className="log-line-time" title={line.timestamp}>{line.timestamp || '-'}</span>
                    <span className={`log-line-level ${line.level}`}>{getLevelLabel(line.level)}</span>
                    <span className="log-line-service" title={line.service}>{line.service || '-'}</span>
                    <code title={line.message}>{renderHighlightedText(line.raw, keyword)}</code>
                  </label>
                );
              })
            ) : (
              <div className="log-empty">
                <strong>{loadedAt ? tCurrent('auto.remoteLogViewer.1wb29af') : tCurrent('auto.remoteLogViewer.1y6932i')}</strong>
                <span>{loadedAt ? tCurrent('auto.remoteLogViewer.11yxpbb') : tCurrent('auto.remoteLogViewer.1k1ceur')}</span>
              </div>
            )}
          </div>

          <footer className="log-pagination">
            <span>
              {tCurrent('auto.remoteLogViewer.biig97')}<strong>{logLines.length ? currentPage + 1 : 0}</strong> / {logLines.length ? pageCount : 0} {tCurrent('auto.remoteLogViewer.1ucfmkw')}</span>
            <div>
              <button type="button" onClick={() => setPage(0)} disabled={!logLines.length || currentPage === 0}>{tCurrent('auto.remoteLogViewer.1ow5v10')}</button>
              <button type="button" onClick={() => setPage((current) => Math.max(0, current - 1))} disabled={!logLines.length || currentPage === 0}>{tCurrent('auto.remoteLogViewer.mtyn6e')}</button>
              <button type="button" onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))} disabled={!logLines.length || currentPage >= pageCount - 1}>{tCurrent('auto.remoteLogViewer.1yw313l')}</button>
            </div>
          </footer>
        </section>
      </div>
    </div>
  );
}

export default RemoteLogViewer;

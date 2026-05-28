import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { getErrorMessage, getShellDeskLocale } from './desktopUtils';
import { isWindowsSystem, powershellCommand, powershellSingleQuote } from './remoteSystem';
import type { RemoteSystemType } from './types';

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
  { value: 'all', label: '全部级别' },
  { value: 'error', label: '错误' },
  { value: 'warning', label: '警告' },
  { value: 'info', label: '信息' },
];

const timeRangeOptions: Array<{ value: TimeRangePreset; label: string }> = [
  { value: 'all', label: '全部时间' },
  { value: '15m', label: '最近 15 分钟' },
  { value: '1h', label: '最近 1 小时' },
  { value: '24h', label: '最近 24 小时' },
  { value: 'custom', label: '自定义' },
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
    throw new Error('ShellDesk IPC 未就绪。');
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
    return '尚未查询';
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
  if (level === 'error') return '错误';
  if (level === 'warning') return '警告';
  if (level === 'info') return '信息';
  if (level === 'debug') return '调试';
  return '日志';
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

  return `
if ! command -v journalctl >/dev/null 2>&1; then
  printf 'journalctl 未安装或当前 PATH 不可用。\\n'
  exit 127
fi
journalctl -n ${fetchLines} --no-pager --output=short-iso ${unitArg} ${timeArgs} ${priorityArg} 2>&1${grepArg} | tail -n ${lines}
`;
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

  return `
log_file=${shellSingleQuote(filePath)}
if [ ! -f "$log_file" ]; then
  printf '文件不存在：%s\\n' "$log_file"
  exit 1
fi
if [ ! -r "$log_file" ]; then
  printf '文件不可读取，可能需要更高权限：%s\\n' "$log_file"
  exit 1
fi
${pipelineParts.join(' | ')}
`;
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
    return '$events = $events | Where-Object { $_.Level -in 1, 2 -or $_.LevelDisplayName -match "Critical|Error" }';
  }

  if (level === 'warning') {
    return '$events = $events | Where-Object { $_.Level -eq 3 -or $_.LevelDisplayName -match "Warning" }';
  }

  if (level === 'info') {
    return '$events = $events | Where-Object { $_.Level -eq 4 -or $_.LevelDisplayName -match "Information|Info" }';
  }

  return '';
}

function getWindowsEventCommand(logName: string, query: LogQuery) {
  const lines = clampLines(query.lines);
  const keyword = sanitizeSingleLine(query.keyword);
  const fetchLimit = keyword || query.level !== 'all' ? Math.min(lines * 8, 4000) : lines;
  const keywordScript = keyword ? `
$needle = ${powershellSingleQuote(keyword)}
$events = $events | Where-Object {
  ([string]$_.Message).IndexOf($needle, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -or
  ([string]$_.ProviderName).IndexOf($needle, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -or
  ([string]$_.Id).IndexOf($needle, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
}
` : '';

  return powershellCommand(`
$filter = @{ LogName = ${powershellSingleQuote(logName || 'System')} }
${getWindowsTimeScript(query)}
$events = Get-WinEvent -FilterHashtable $filter -MaxEvents ${fetchLimit} -ErrorAction Stop
${getWindowsLevelScript(query.level)}
${keywordScript}
$items = @($events | Select-Object -First ${lines} | ForEach-Object {
  $message = ([string]$_.Message -replace "\\s+", " ").Trim()
  [pscustomobject]@{
    timeCreated = if ($_.TimeCreated) { $_.TimeCreated.ToString("yyyy-MM-dd HH:mm:ss") } else { "" }
    level = [string]$_.LevelDisplayName
    providerName = [string]$_.ProviderName
    eventId = [int]$_.Id
    message = $message
    raw = "{0:u} [{1}] {2} #{3} {4}" -f $_.TimeCreated, $_.LevelDisplayName, $_.ProviderName, $_.Id, $message
  }
})
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
            { id: 'event:System', type: 'windows-event', label: 'System', value: 'System', description: '系统事件' },
            { id: 'event:Application', type: 'windows-event', label: 'Application', value: 'Application', description: '应用事件' },
          ],
        },
      ];
    }

    return [
      {
        id: 'journal',
        label: 'Journal',
        sources: [
          { id: 'journal:system', type: 'journal', label: '系统日志', value: '', description: 'journalctl' },
          { id: 'journal:service-custom', type: 'journal', label: '服务日志', value: '__service__', description: serviceName || '输入 systemd unit' },
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
          { id: 'file:custom', type: 'file', label: '自定义文件', value: '', description: filePath || '输入日志路径' },
          ...logFiles,
        ],
      },
    ];
  }, [filePath, isWindowsHost, logFiles, serviceName]);

  const allSources = useMemo(() => sourceGroups.flatMap((group) => group.sources), [sourceGroups]);
  const selectedSource = allSources.find((source) => source.id === selectedSourceId) ?? allSources[0];

  const resolvedSource = useMemo<LogSource>(() => {
    if (!selectedSource) {
      return isWindowsHost
        ? { id: 'event:System', type: 'windows-event', label: 'System', value: 'System' }
        : { id: 'journal:system', type: 'journal', label: '系统日志', value: '' };
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
        setNotice(result.stderr || result.stdout || '无法读取 /var/log 文件列表。');
      }
    } catch (err) {
      if (isMountedRef.current) {
        setNotice(`日志文件发现失败：${getErrorMessage(err)}`);
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
        throw new Error('请输入服务名，例如 nginx.service。');
      }

      if (querySource.type === 'file' && !querySource.value) {
        throw new Error('请输入日志文件路径。');
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
        throw new Error(result.stderr || result.stdout || '日志查询失败。');
      }

      if (!isMountedRef.current || requestId !== queryRequestIdRef.current) {
        return;
      }

      setLogLines(nextLines);
      setPage(0);
      setLoadedAt(Date.now());
      setLoadedSourceLabel(querySource.label);

      if (result.code !== 0) {
        setNotice(result.stderr || '命令返回非零状态，但仍解析到了日志输出。');
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
      setSuccess(`已复制${label}。`);
    } catch (err) {
      setError(`复制失败：${getErrorMessage(err)}`);
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
            {loading ? '查询中' : '查询'}
          </button>
          <button type="button" className="log-tool-button" onClick={() => void executeQuery()} disabled={loading}>
            刷新
          </button>
          <button type="button" className="log-tool-button" onClick={clearResults} disabled={!logLines.length && !error}>
            清空
          </button>
          {!isWindowsHost ? (
            <button type="button" className="log-tool-button" onClick={() => void loadLogFiles()} disabled={filesLoading}>
              {filesLoading ? '扫描中' : '扫描 /var/log'}
            </button>
          ) : null}
          <span className="log-system-pill">{isWindowsHost ? 'Windows Event Log' : 'journalctl / 文件'}</span>
        </div>

        <div className="log-toolbar-right">
          <select className="log-select" value={level} onChange={(event) => setLevel(event.target.value as LogLevelFilter)} aria-label="日志级别">
            {levelOptions.map((item) => (
              <option key={item.value} value={item.value}>{item.label}</option>
            ))}
          </select>
          <select className="log-select log-time-select" value={timeRange} onChange={(event) => setTimeRange(event.target.value as TimeRangePreset)} aria-label="时间范围">
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
            aria-label="读取行数"
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
            placeholder="systemd unit，例如 nginx.service"
            aria-label="服务名"
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
            aria-label="日志文件路径"
          />
        ) : null}
        <input
          type="search"
          className="log-keyword-input"
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder="搜索关键字..."
          aria-label="搜索关键字"
        />
        {timeRange === 'custom' ? (
          <>
            <input
              type="datetime-local"
              className="log-date-input"
              value={since}
              onChange={(event) => setSince(event.target.value)}
              aria-label="开始时间"
            />
            <input
              type="datetime-local"
              className="log-date-input"
              value={until}
              onChange={(event) => setUntil(event.target.value)}
              aria-label="结束时间"
            />
          </>
        ) : null}
      </div>

      {error ? <div className="log-alert danger">{error}</div> : null}
      {notice ? <div className="log-alert info">{notice}</div> : null}
      {success ? <div className="log-alert success">{success}</div> : null}

      <div className="log-content">
        <aside className="log-source-panel" aria-label="日志来源">
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

        <section className="log-result-panel" aria-label="日志结果">
          <header className="log-result-header">
            <div>
              <span>{loadedSourceLabel || resolvedSource.label}</span>
              <strong>{logLines.length} 行</strong>
              <small>{formatLoadedAt(loadedAt)}</small>
            </div>
            <div className="log-result-actions">
              <button type="button" onClick={toggleCurrentPageSelection} disabled={!pageLines.length}>
                {pageLines.length && pageLines.every((line) => selectedLineIds.has(line.id)) ? '取消本页' : '选择本页'}
              </button>
              <button type="button" onClick={() => void copyToClipboard(selectedText, '选中日志')} disabled={!selectedText}>
                复制选中
              </button>
              <button type="button" onClick={() => void copyToClipboard(logLines.map((line) => line.raw).join('\n'), '全部日志')} disabled={!logLines.length}>
                复制全部
              </button>
            </div>
          </header>

          <div className="log-stats">
            <span><strong>{stats.error}</strong> 错误</span>
            <span><strong>{stats.warning}</strong> 警告</span>
            <span><strong>{stats.info}</strong> 信息</span>
            <span><strong>{stats.debug}</strong> 调试</span>
          </div>

          <div className="log-lines" role="list">
            {loading ? (
              <div className="log-empty">正在读取远程日志...</div>
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
                      aria-label={`选择第 ${absoluteIndex} 行`}
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
                <strong>{loadedAt ? '没有匹配的日志' : '尚未加载日志'}</strong>
                <span>{loadedAt ? '可以调整来源、级别、时间或关键字后重新查询。' : '选择来源后点击查询。'}</span>
              </div>
            )}
          </div>

          <footer className="log-pagination">
            <span>
              第 <strong>{logLines.length ? currentPage + 1 : 0}</strong> / {logLines.length ? pageCount : 0} 页
            </span>
            <div>
              <button type="button" onClick={() => setPage(0)} disabled={!logLines.length || currentPage === 0}>首页</button>
              <button type="button" onClick={() => setPage((current) => Math.max(0, current - 1))} disabled={!logLines.length || currentPage === 0}>上一页</button>
              <button type="button" onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))} disabled={!logLines.length || currentPage >= pageCount - 1}>下一页</button>
            </div>
          </footer>
        </section>
      </div>
    </div>
  );
}

export default RemoteLogViewer;

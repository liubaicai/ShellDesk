import { powershellCommand } from './remoteSystem';

export type LoginSessionTab = 'current' | 'history' | 'failed';

export interface LoginSessionEntry {
  id: string;
  user: string;
  tty?: string;
  source?: string;
  loginAt?: string;
  idle?: string;
  command?: string;
  raw: string;
}

export interface LoginHistoryEntry {
  id: string;
  user: string;
  source?: string;
  startedAt?: string;
  endedAt?: string;
  duration?: string;
  success: boolean;
  raw: string;
}

export interface LoginSourceAggregate {
  source: string;
  count: number;
}

function createId(prefix: string, index: number, raw: string) {
  return `${prefix}:${index}:${raw.slice(0, 40)}`;
}

function splitLines(stdout: string) {
  return stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function looksLikeSource(value: string | undefined) {
  return Boolean(value && (/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(value) || /^[\w.-]+$/.test(value) && value !== 'still'));
}

export function createCurrentSessionsCommand(isWindowsHost: boolean) {
  if (isWindowsHost) {
    return powershellCommand(`
try {
  query user
} catch {
  whoami
}
`);
  }

  return 'w -h 2>/dev/null || who 2>/dev/null || true';
}

export function createLoginHistoryCommand(isWindowsHost: boolean) {
  if (isWindowsHost) {
    return powershellCommand(`
Get-WinEvent -FilterHashtable @{LogName='Security'; Id=4624; StartTime=(Get-Date).AddDays(-14)} -MaxEvents 100 -ErrorAction SilentlyContinue |
  ForEach-Object {
    $message = ($_.Message -replace "\\s+", " ").Trim()
    "{0:u} {1}" -f $_.TimeCreated, $message
  }
`);
  }

  return 'last -n 100 -F 2>&1 || true';
}

export function createFailedLoginCommand(isWindowsHost: boolean) {
  if (isWindowsHost) {
    return powershellCommand(`
Get-WinEvent -FilterHashtable @{LogName='Security'; Id=4625; StartTime=(Get-Date).AddDays(-14)} -MaxEvents 100 -ErrorAction SilentlyContinue |
  ForEach-Object {
    $message = ($_.Message -replace "\\s+", " ").Trim()
    "{0:u} {1}" -f $_.TimeCreated, $message
  }
`);
  }

  return `
if command -v lastb >/dev/null 2>&1; then
  lastb -n 100 -F 2>&1 || true
elif command -v journalctl >/dev/null 2>&1; then
  journalctl -u ssh -u sshd -n 500 --no-pager 2>/dev/null | grep -Ei 'Failed password|Invalid user|authentication failure' | tail -n 100 || true
else
  printf '缺少 lastb 或 journalctl。\\n'
fi
`;
}

export function parseCurrentSessions(stdout: string, isWindowsHost: boolean): LoginSessionEntry[] {
  return splitLines(stdout)
    .filter((line) => !/^(USER|USERNAME)\s+/i.test(line))
    .map<LoginSessionEntry>((line, index) => {
      if (isWindowsHost) {
        const activeMarker = line.startsWith('>') ? line.slice(1).trim() : line;
        const parts = activeMarker.split(/\s+/);
        return {
          id: createId('current', index, line),
          user: parts[0] || 'unknown',
          tty: parts[1],
          source: parts[2],
          loginAt: parts.slice(5, 8).join(' ') || undefined,
          idle: parts[4],
          raw: line,
        };
      }

      const parts = line.split(/\s+/);
      const user = parts[0] || 'unknown';
      const tty = parts[1];
      const source = parts[2] && parts[2] !== '-' ? parts[2] : undefined;
      const loginAt = parts[3];
      const idle = parts[4];
      const command = parts.slice(7).join(' ') || parts.slice(5).join(' ');

      return {
        id: createId('current', index, line),
        user,
        tty,
        source,
        loginAt,
        idle,
        command,
        raw: line,
      };
    });
}

function parseLastLine(line: string, index: number, success: boolean): LoginHistoryEntry | null {
  if (/^(wtmp|btmp)\s+begins/i.test(line) || /^reboot\s|^shutdown\s/i.test(line)) {
    return null;
  }

  const user = line.slice(0, 10).trim() || line.split(/\s+/)[0] || 'unknown';
  const rest = line.slice(10).trim();
  const parts = rest.split(/\s+/);
  const tty = parts[0];
  let cursor = 1;
  let source: string | undefined;

  if (looksLikeSource(parts[cursor])) {
    source = parts[cursor];
    cursor += 1;
  }

  const startedParts = parts.slice(cursor, cursor + 6);
  const dashIndex = parts.indexOf('-', cursor);
  const durationMatch = line.match(/\(([^)]+)\)\s*$/);
  const endedAt = dashIndex >= 0 ? parts.slice(dashIndex + 1, Math.min(parts.length, dashIndex + 7)).join(' ') : undefined;

  return {
    id: createId(success ? 'history' : 'failed', index, line),
    user,
    source,
    startedAt: startedParts.join(' ') || undefined,
    endedAt: /still logged in/i.test(line) ? '仍在线' : endedAt,
    duration: durationMatch?.[1],
    success,
    raw: tty ? line : line,
  };
}

function parseWindowsEventLine(line: string, index: number, success: boolean): LoginHistoryEntry {
  const source = line.match(/Source Network Address:\s*([^\s]+)/i)?.[1]
    ?? line.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/)?.[0];
  const user = line.match(/Account Name:\s*([^\s]+)/i)?.[1]
    ?? line.match(/TargetUserName=([^\s]+)/i)?.[1]
    ?? '事件记录';
  const timestamp = line.match(/^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/)?.[1];

  return {
    id: createId(success ? 'history' : 'failed', index, line),
    user,
    source,
    startedAt: timestamp,
    success,
    raw: line,
  };
}

export function parseLoginHistory(stdout: string, success: boolean, isWindowsHost: boolean): LoginHistoryEntry[] {
  return splitLines(stdout)
    .map((line, index) => (isWindowsHost ? parseWindowsEventLine(line, index, success) : parseLastLine(line, index, success)))
    .filter((entry): entry is LoginHistoryEntry => Boolean(entry));
}

export function aggregateLoginSources(entries: LoginHistoryEntry[]): LoginSourceAggregate[] {
  const counts = new Map<string, number>();

  entries.forEach((entry) => {
    const source = entry.source?.trim();
    if (!source || source === '-' || source === '::1') return;
    counts.set(source, (counts.get(source) ?? 0) + 1);
  });

  return [...counts.entries()]
    .map(([source, count]) => ({ source, count }))
    .sort((first, second) => second.count - first.count || first.source.localeCompare(second.source, 'zh-CN'));
}

export function formatLoginRecord(entry: LoginSessionEntry | LoginHistoryEntry) {
  if ('success' in entry) {
    return [
      `用户：${entry.user}`,
      `来源：${entry.source || '-'}`,
      `开始：${entry.startedAt || '-'}`,
      `结束：${entry.endedAt || '-'}`,
      `持续：${entry.duration || '-'}`,
      `结果：${entry.success ? '成功' : '失败'}`,
      '',
      entry.raw,
    ].join('\n');
  }

  return [
    `用户：${entry.user}`,
    `TTY：${entry.tty || '-'}`,
    `来源：${entry.source || '-'}`,
    `登录：${entry.loginAt || '-'}`,
    `空闲：${entry.idle || '-'}`,
    `命令：${entry.command || '-'}`,
    '',
    entry.raw,
  ].join('\n');
}

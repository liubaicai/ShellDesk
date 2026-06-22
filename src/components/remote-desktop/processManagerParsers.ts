import { t, type AppLanguage } from '../../i18n';
import { readInteger, readNumber } from './parseUtils';
import type { ProcessDetail, RemoteProcessEntry } from './processManagerTypes';

const PROCESS_AI_FIELD_CHAR_LIMIT = 260;

export function formatMetric(value: number | undefined, suffix = '') {
  if (value === undefined || !Number.isFinite(value)) {
    return '-';
  }

  const formattedValue = value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2);
  return `${formattedValue.replace(/\.00$/, '').replace(/(\.\d)0$/, '$1')}${suffix}`;
}

export function formatMemory(process: RemoteProcessEntry, isWindowsHost: boolean) {
  if (isWindowsHost) {
    return formatMetric(process.memoryMb, ' MB');
  }

  return formatMetric(process.memoryPercent, '%');
}

export function formatCpu(process: RemoteProcessEntry, isWindowsHost: boolean) {
  if (isWindowsHost) {
    return formatMetric(process.cpuSeconds, 's');
  }

  return formatMetric(process.cpuPercent, '%');
}

export function getCpuValue(process: RemoteProcessEntry, isWindowsHost: boolean) {
  return isWindowsHost ? process.cpuSeconds ?? 0 : process.cpuPercent ?? 0;
}

export function getMemoryValue(process: RemoteProcessEntry, isWindowsHost: boolean) {
  return isWindowsHost ? process.memoryMb ?? 0 : process.memoryPercent ?? 0;
}

export function compactAiField(value: string | number | undefined | null, maxLength = PROCESS_AI_FIELD_CHAR_LIMIT) {
  if (value === undefined || value === null || value === '') {
    return '-';
  }

  const normalizedValue = String(value).replace(/\s+/g, ' ').trim();

  if (normalizedValue.length <= maxLength) {
    return normalizedValue || '-';
  }

  return `${normalizedValue.slice(0, maxLength)}...`;
}

export function parseLinuxProcessLine(line: string, language: AppLanguage): RemoteProcessEntry | null {
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

export function parsePsAuxLine(line: string, language: AppLanguage): RemoteProcessEntry | null {
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

export function parseProcFsLinuxProcessLine(line: string, language: AppLanguage): RemoteProcessEntry | null {
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

export function parseDelimitedLinuxProcessLine(line: string, language: AppLanguage): RemoteProcessEntry | null {
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

export function parseLinuxProcessOutput(stdout: string, language: AppLanguage): RemoteProcessEntry[] {
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

export function parseWindowsProcessOutput(stdout: string): RemoteProcessEntry[] {
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

        return {
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

export function parseProcessDetailOutput(stdout: string, pid: number): ProcessDetail {
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

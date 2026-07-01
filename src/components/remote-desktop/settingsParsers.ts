import { t, type AppLanguage } from '../../i18n';
import type { CpuInfoSummary, DiskInfoSummary, DnsConfig, MemoryInfoSummary, NetworkInterface, RouteEntry } from './settingsTypes';

export function parseKeyValueOutput(stdout: string) {
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

export function netmaskToPrefix(netmask: string) {
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

export function parseIpAddr(stdout: string): NetworkInterface[] {
  const blocks = stdout.split(/(?=^\d+: )/m).filter((b) => b.trim());
  const ifaces: NetworkInterface[] = [];

  for (const block of blocks) {
    const headerMatch = block.match(/^(\d+):\s+(\S+?)(@[^:]+)?:\s+<([^>]*)>.*mtu\s+(\d+)/);
    if (!headerMatch) continue;

    const name = headerMatch[2];
    const flags = headerMatch[4];
    const mtu = Number.parseInt(headerMatch[5], 10);
    const state = flags.includes('UP') ? 'UP' as const : 'DOWN' as const;

    const macMatch = block.match(/link\/ether\s+([0-9a-fA-F:]+)/);
    const mac = macMatch?.[1] ?? '';

    const addresses: NetworkInterface['addresses'] = [];
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

export function prefixToNetmask(prefix: number): string {
  if (prefix <= 0) return '0.0.0.0';
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return [24, 16, 8, 0].map((s) => ((mask >>> s) & 0xff).toString()).join('.');
}

export function parseResolvConf(stdout: string): DnsConfig {
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

export function areDnsConfigsEqual(left: DnsConfig, right: DnsConfig) {
  return left.search === right.search
    && left.servers.length === right.servers.length
    && left.servers.every((server, index) => server === right.servers[index]);
}

export function buildResolvConfContent(originalContent: string, config: DnsConfig) {
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

export function createDnsConfigPreview(current: DnsConfig, draft: DnsConfig, language: AppLanguage) {
  const emptyValue = t('remoteSettings.network.noValue', language);

  return [
    t('remoteSettings.network.currentDns', language),
    ...(current.servers.length ? current.servers.map((server) => `  ${server}`) : [`  ${emptyValue}`]),
    t('remoteSettings.network.currentSearch', language, { value: current.search || emptyValue }),
    '',
    t('remoteSettings.network.draftDns', language),
    ...(draft.servers.length ? draft.servers.map((server) => `  ${server}`) : [`  ${emptyValue}`]),
    t('remoteSettings.network.draftSearch', language, { value: draft.search || emptyValue }),
    '',
    t('remoteSettings.network.backupResolv', language),
  ].join('\n');
}

export function parseColonSeparatedBlock(raw: string) {
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

export function multiplyNumericStrings(left: string, right: string) {
  const leftValue = Number.parseInt(left, 10);
  const rightValue = Number.parseInt(right, 10);

  if (!Number.isFinite(leftValue) || !Number.isFinite(rightValue)) {
    return '';
  }

  return String(leftValue * rightValue);
}

export function parseHumanReadableBytes(raw: string) {
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

export function formatSysInfoDiskBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const precision = value >= 10 || unitIndex === 0 ? 0 : 1;
  return `${Number(value.toFixed(precision))} ${units[unitIndex]}`;
}

export function parseLabeledDiskInfoSummary(raw: string): DiskInfoSummary | null {
  const values = parseColonSeparatedBlock(raw);
  const total = values.get('总量') ?? values.get('总计') ?? values.get('Total') ?? '';
  const available = values.get('可用') ?? values.get('空闲') ?? values.get('Available') ?? values.get('Free') ?? '';

  if (!total || !available) {
    return null;
  }

  return {
    total,
    available,
  };
}

export function parseDfDiskInfoSummary(raw: string): DiskInfoSummary | null {
  let totalBytes = 0;
  let availableBytes = 0;
  const seenFilesystems = new Set<string>();
  const ignoredFilesystems = /^(tmpfs|devtmpfs|overlay|udev|shm|none|cgroup2?|proc|sysfs)$/i;

  for (const line of raw.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);

    if (parts.length < 5 || /^filesystem$/i.test(parts[0]) || ignoredFilesystems.test(parts[0])) {
      continue;
    }

    const useIndex = parts.findIndex((part, index) => index > 0 && /^\d+%$/.test(part));
    const size = useIndex >= 3 ? parseHumanReadableBytes(parts[useIndex - 3]) : null;
    const available = useIndex >= 3 ? parseHumanReadableBytes(parts[useIndex - 1]) : null;

    if (!size || !available || seenFilesystems.has(parts[0])) {
      continue;
    }

    seenFilesystems.add(parts[0]);
    totalBytes += size;
    availableBytes += available;
  }

  if (totalBytes <= 0) {
    return null;
  }

  return {
    total: formatSysInfoDiskBytes(totalBytes),
    available: formatSysInfoDiskBytes(availableBytes),
  };
}

export function parseWindowsDiskInfoSummary(raw: string): DiskInfoSummary | null {
  let totalBytes = 0;
  let availableBytes = 0;

  for (const line of raw.split(/\r?\n/)) {
    const trimmedLine = line.trim();

    if (!trimmedLine || /^[-\s]+$/.test(trimmedLine) || /^DeviceID\b/i.test(trimmedLine)) {
      continue;
    }

    const match = trimmedLine.match(/([\d.]+)\s+([\d.]+)\s*$/);

    if (!match) {
      continue;
    }

    const sizeGb = Number.parseFloat(match[1]);
    const freeGb = Number.parseFloat(match[2]);

    if (!Number.isFinite(sizeGb) || !Number.isFinite(freeGb) || sizeGb <= 0) {
      continue;
    }

    totalBytes += sizeGb * 1024 ** 3;
    availableBytes += freeGb * 1024 ** 3;
  }

  if (totalBytes <= 0) {
    return null;
  }

  return {
    total: formatSysInfoDiskBytes(totalBytes),
    available: formatSysInfoDiskBytes(availableBytes),
  };
}

export function parseDiskInfoSummary(raw: string): DiskInfoSummary | null {
  return parseLabeledDiskInfoSummary(raw)
    ?? parseDfDiskInfoSummary(raw)
    ?? parseWindowsDiskInfoSummary(raw);
}


export function parseCpuInfoSummary(raw: string): CpuInfoSummary | null {
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

export function parseMemoryInfoSummary(raw: string): MemoryInfoSummary | null {
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


export function parseOsName(raw: string, language: AppLanguage) {
  const pretty = raw.match(/PRETTY_NAME="([^"]+)"/);
  if (pretty) return pretty[1];
  const name = raw.match(/^NAME=(.+)/m)?.[1]?.replace(/"/g, '');
  const version = raw.match(/^VERSION=(.+)/m)?.[1]?.replace(/"/g, '');
  return [name, version].filter(Boolean).join(' ') || raw.split('\n')[0] || t('remoteSettings.systemInfo.unknown', language);
}


export function parseIpRoute(stdout: string): RouteEntry[] {
  return stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const parts = line.split(/\s+/);
    const viaIndex = parts.indexOf('via');
    const devIndex = parts.indexOf('dev');
    return {
      destination: parts[0] ?? '',
      gateway: viaIndex >= 0 ? parts[viaIndex + 1] : undefined,
      dev: devIndex >= 0 ? parts[devIndex + 1] : undefined,
      raw: line,
    };
  });
}

export const parseRouteTable = parseIpRoute;
export const parseDnsResolvConf = parseResolvConf;

import { t, type AppLanguage } from '../../i18n';
import { readNumber, readString } from './parseUtils';
import type { ComposeProjectSummary, ContainerDetail, ContainerNetworkSummary, ContainerRuntimeConfig, ContainerState, ContainerStats, ContainerSummary, ContainerVolumeSummary, ImageSummary, RestartPolicy } from './containerTypes';
const CONTAINER_INSPECT_MARKER = '__SHELLDESK_CONTAINER_INSPECT__';
const CONTAINER_STATS_MARKER = '__SHELLDESK_CONTAINER_STATS__';
const CONTAINER_LOGS_MARKER = '__SHELLDESK_CONTAINER_LOGS__';
export function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}
export function formatInspectValue(value: unknown) {
  if (value === undefined || value === null || value === '') {
    return '-';
  }
  if (Array.isArray(value)) {
    return value.map((item) => String(item)).filter(Boolean).join(' ') || '-';
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}
function readFirstValue(record: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null && value !== '') {
      return value;
    }
  }
  return undefined;
}
function formatPortWithProtocol(port: string, protocol: string) {
  const portText = port.trim();
  const protocolText = protocol.trim().replace(/^\//u, '');
  if (!portText) {
    return '';
  }
  if (!protocolText || portText.includes('/')) {
    return portText;
  }
  return `${portText}/${protocolText}`;
}
function formatPortRange(port: string, range: number | undefined) {
  const portText = port.trim();
  if (!portText || !range || range <= 1 || !/^\d+$/u.test(portText)) {
    return portText;
  }
  return `${portText}-${Number(portText) + range - 1}`;
}
function formatPortBinding(containerPort: string, hostIp: string, hostPort: string, protocol: string) {
  const containerPortText = formatPortWithProtocol(containerPort, protocol);
  if (hostPort && containerPortText) {
    return `${hostIp ? `${hostIp}:` : ''}${hostPort}->${containerPortText}`;
  }
  if (containerPortText) {
    return containerPortText;
  }
  return hostPort ? `${hostIp ? `${hostIp}:` : ''}${hostPort}` : '';
}
function formatPortRecord(record: Record<string, unknown>) {
  const containerPort = readString(
    record,
    'container_port',
    'ContainerPort',
    'PrivatePort',
    'private_port',
    'target',
    'TargetPort',
  );
  const hostPortText = readString(
    record,
    'host_port',
    'HostPort',
    'PublicPort',
    'public_port',
    'published',
    'PublishedPort',
  );
  const range = readNumber(record, 'range', 'Range');
  const rangedContainerPort = formatPortRange(containerPort, range);
  const hostPort = formatPortRange(hostPortText === '0' ? '' : hostPortText, range);
  const hostIp = readString(record, 'host_ip', 'HostIp', 'HostIP', 'hostIP', 'IP', 'ip');
  const protocol = readString(record, 'protocol', 'Protocol', 'type', 'Type') || 'tcp';
  const directMapping = formatPortBinding(rangedContainerPort, hostIp, hostPort, protocol);
  if (directMapping) {
    return directMapping;
  }

  const networkPorts = Object.entries(record).flatMap(([mappedContainerPort, bindings]) => {
    if (!/^\d+(?:-\d+)?\/[a-z0-9]+$/iu.test(mappedContainerPort)) {
      return [] as string[];
    }
    if (bindings === null) {
      return [mappedContainerPort];
    }
    if (!Array.isArray(bindings)) {
      return [];
    }
    const formattedBindings = bindings
      .map(toRecord)
      .filter((bindingRecord): bindingRecord is Record<string, unknown> => Boolean(bindingRecord))
      .map((bindingRecord) => formatPortBinding(
        mappedContainerPort,
        readString(bindingRecord, 'HostIp', 'host_ip', 'HostIP', 'hostIP') || '0.0.0.0',
        readString(bindingRecord, 'HostPort', 'host_port', 'PublicPort', 'public_port'),
        '',
      ))
      .filter(Boolean);
    return formattedBindings.length ? formattedBindings : [mappedContainerPort];
  });
  if (networkPorts.length) {
    return networkPorts.join(', ');
  }

  return formatInspectValue(record);
}
function formatContainerPorts(value: unknown): string {
  if (value === undefined || value === null || value === '') {
    return '';
  }
  if (typeof value === 'string') {
    return value.trim();
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === 'string') return item.trim();
        if (typeof item === 'number' || typeof item === 'boolean') return String(item);
        const itemRecord = toRecord(item);
        return itemRecord ? formatPortRecord(itemRecord) : '';
      })
      .filter(Boolean)
      .join(', ');
  }
  const record = toRecord(value);
  return record ? formatPortRecord(record) : '';
}
function readContainerSummaryPorts(record: Record<string, unknown>) {
  return formatContainerPorts(readFirstValue(record, 'Ports', 'ports', 'PortMappings', 'portMappings')) || '-';
}
export function formatByteLimit(value: number | undefined) {
  if (!value || value <= 0) {
    return '';
  }
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let nextValue = value;
  let unitIndex = 0;
  while (nextValue >= 1024 && unitIndex < units.length - 1) {
    nextValue /= 1024;
    unitIndex += 1;
  }
  const digits = nextValue >= 10 || unitIndex === 0 ? 0 : 1;
  return `${nextValue.toFixed(digits)} ${units[unitIndex]}`;
}
export function normalizeRestartPolicy(value: string): RestartPolicy {
  const normalizedValue = value.trim().toLowerCase();
  if (normalizedValue === 'always') return 'always';
  if (normalizedValue === 'unless-stopped') return 'unless-stopped';
  if (normalizedValue.startsWith('on-failure')) return 'on-failure';
  return 'no';
}
export function parseJsonDocument(text: string): unknown[] {
  const trimmedText = text.trim();
  if (!trimmedText) {
    return [];
  }
  const parsedJson = JSON.parse(trimmedText) as unknown;
  return Array.isArray(parsedJson) ? parsedJson : [parsedJson];
}
export function parseJsonLines(stdout: string) {
  const text = stdout.trim();
  if (!text) {
    return [] as Record<string, unknown>[];
  }
  if (text.startsWith('[')) {
    try {
      return parseJsonDocument(text).map(toRecord).filter((record): record is Record<string, unknown> => Boolean(record));
    } catch {
      return [];
    }
  }
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return toRecord(JSON.parse(line) as unknown);
      } catch {
        return undefined;
      }
    })
    .filter((record): record is Record<string, unknown> => Boolean(record));
}
export function normalizeContainerName(name: string) {
  return name.replace(/^\//, '').trim();
}
export function normalizeContainerState(value: string): ContainerState {
  const normalizedValue = value.trim().toLowerCase();
  if (!normalizedValue) {
    return 'unknown';
  }
  if (normalizedValue === 'running' || normalizedValue.startsWith('up ') || normalizedValue === 'up') {
    return 'running';
  }
  if (
    normalizedValue === 'exited' ||
    normalizedValue === 'stopped' ||
    normalizedValue === 'dead' ||
    normalizedValue.startsWith('exited ') ||
    normalizedValue.includes('exited')
  ) {
    return 'exited';
  }
  if (normalizedValue === 'paused' || normalizedValue.includes('paused')) {
    return 'paused';
  }
  if (normalizedValue === 'created' || normalizedValue.includes('created')) {
    return 'created';
  }
  return 'unknown';
}
export function getStateLabel(state: ContainerState, language: AppLanguage) {
  if (state === 'running') return t('container.state.running', language);
  if (state === 'exited') return t('container.state.exited', language);
  if (state === 'paused') return t('container.state.paused', language);
  if (state === 'created') return t('container.state.created', language);
  return t('container.state.unknown', language);
}
export function formatShortId(id: string) {
  return id.replace(/^sha256:/, '').slice(0, 12) || '-';
}
export function parseContainerSummary(record: Record<string, unknown>): ContainerSummary | null {
  const id = readString(record, 'ID', 'Id', 'IDShort', 'ContainerID', 'ContainerId').replace(/^sha256:/, '');
  const rawName = readString(record, 'Names', 'Name', 'names', 'name');
  const name = normalizeContainerName(rawName) || formatShortId(id);
  const image = readString(record, 'Image', 'image') || '-';
  const status = readString(record, 'Status', 'status') || readString(record, 'State', 'state') || '-';
  const state = normalizeContainerState(readString(record, 'State', 'state') || status);
  if (!id && !name) {
    return null;
  }
  return {
    id: id || name,
    name,
    image,
    command: readString(record, 'Command', 'command') || undefined,
    status,
    state,
    ports: readContainerSummaryPorts(record),
    createdAt: readString(record, 'CreatedAt', 'Created', 'createdAt', 'created') || undefined,
    runningFor: readString(record, 'RunningFor', 'RunningForHuman', 'runningFor') || undefined,
  };
}
export function parseImageSummary(record: Record<string, unknown>): ImageSummary | null {
  const id = readString(record, 'ID', 'Id', 'id').replace(/^sha256:/, '');
  const repository = readString(record, 'Repository', 'repository', 'RepoTags') || '<none>';
  const tag = readString(record, 'Tag', 'tag') || '<none>';
  if (!id && repository === '<none>') {
    return null;
  }
  return {
    id: id || `${repository}:${tag}`,
    repository,
    tag,
    size: readString(record, 'Size', 'size', 'VirtualSize') || '-',
    createdAt: readString(record, 'CreatedAt', 'CreatedSince', 'Created', 'createdAt') || undefined,
  };
}
function readLabel(record: Record<string, unknown>, ...keys: string[]) {
  const labels = record.Labels ?? record.labels ?? record.Label ?? record.label;
  if (!labels) {
    return '';
  }
  if (typeof labels === 'object' && !Array.isArray(labels)) {
    const labelRecord = labels as Record<string, unknown>;
    for (const key of keys) {
      const value = labelRecord[key];
      if (value !== undefined && value !== null) {
        const text = String(value).trim();
        if (text) return text;
      }
    }
    return '';
  }
  const labelText = Array.isArray(labels) ? labels.join(',') : String(labels);
  for (const entry of labelText.split(/,(?=[^,=]+=)/u)) {
    const separatorIndex = entry.indexOf('=');
    if (separatorIndex < 0) continue;
    const key = entry.slice(0, separatorIndex).trim();
    const value = entry.slice(separatorIndex + 1).trim();
    if (keys.includes(key) && value) {
      return value;
    }
  }
  return '';
}
export function parseComposeProjectSummary(record: Record<string, unknown>, index: number): ComposeProjectSummary | null {
  const name = readString(record, 'Name', 'name') || readLabel(
    record,
    'com.docker.compose.project',
    'io.podman.compose.project',
    'io.podman.compose.project.name',
  );
  if (!name) {
    return null;
  }
  return {
    id: name || `compose-${index}`,
    name,
    status: readString(record, 'Status', 'status', 'State', 'state') || '-',
    configFiles: readString(record, 'ConfigFiles', 'ConfigFilesList', 'config_files', 'Config') || readLabel(
      record,
      'com.docker.compose.project.config_files',
      'io.podman.compose.project.config_files',
      'io.podman.compose.config_files',
    ) || '-',
    workingDir: readString(record, 'WorkingDir', 'working_dir', 'ProjectDirectory') || readLabel(
      record,
      'com.docker.compose.project.working_dir',
      'io.podman.compose.project.working_dir',
      'io.podman.compose.working_dir',
    ) || '-',
  };
}
export function parseContainerNetworkSummary(record: Record<string, unknown>): ContainerNetworkSummary | null {
  const id = readString(record, 'ID', 'Id', 'id').replace(/^sha256:/, '');
  const name = readString(record, 'Name', 'name');
  if (!id && !name) {
    return null;
  }
  return {
    id: id || name,
    name: name || formatShortId(id),
    driver: readString(record, 'Driver', 'driver') || '-',
    scope: readString(record, 'Scope', 'scope') || '-',
    internal: readString(record, 'Internal', 'internal') || '-',
    ipv6: readString(record, 'IPv6', 'EnableIPv6', 'ipv6') || '-',
    labels: readString(record, 'Labels', 'labels') || '-',
  };
}
export function parseContainerVolumeSummary(record: Record<string, unknown>): ContainerVolumeSummary | null {
  const name = readString(record, 'Name', 'name');
  if (!name) {
    return null;
  }
  return {
    name,
    driver: readString(record, 'Driver', 'driver') || '-',
    mountpoint: readString(record, 'Mountpoint', 'MountPoint', 'mountpoint') || '-',
    scope: readString(record, 'Scope', 'scope') || '-',
    labels: readString(record, 'Labels', 'labels') || '-',
  };
}
export function splitContainerDetailSections(stdout: string) {
  const sections = {
    inspect: [] as string[],
    stats: [] as string[],
    logs: [] as string[],
  };
  let section: keyof typeof sections | null = null;
  stdout.split(/\r?\n/).forEach((rawLine) => {
    const line = rawLine.trimEnd();
    if (line.trim() === CONTAINER_INSPECT_MARKER) {
      section = 'inspect';
      return;
    }
    if (line.trim() === CONTAINER_STATS_MARKER) {
      section = 'stats';
      return;
    }
    if (line.trim() === CONTAINER_LOGS_MARKER) {
      section = 'logs';
      return;
    }
    if (section) {
      sections[section].push(line);
    }
  });
  return {
    inspect: sections.inspect.join('\n').trim(),
    stats: sections.stats.join('\n').trim(),
    logs: sections.logs.join('\n').trim(),
  };
}
export function extractPorts(inspectRecord: Record<string, unknown> | undefined, fallbackPorts: string, language: AppLanguage) {
  const networkSettings = toRecord(inspectRecord?.NetworkSettings);
  const portsRecord = toRecord(networkSettings?.Ports);
  if (!portsRecord) {
    return fallbackPorts && fallbackPorts !== '-' ? [fallbackPorts] : [];
  }
  const ports = Object.entries(portsRecord).flatMap(([containerPort, bindings]) => {
    if (Array.isArray(bindings) && bindings.length > 0) {
      return bindings
        .map((binding) => {
          const bindingRecord = toRecord(binding);
          const hostIp = readString(bindingRecord, 'HostIp') || '0.0.0.0';
          const hostPort = readString(bindingRecord, 'HostPort');
          return hostPort ? `${hostIp}:${hostPort} -> ${containerPort}` : containerPort;
        })
        .filter(Boolean);
    }
    return [`${containerPort} -> ${t('container.port.unpublished', language)}`];
  });
  return ports.filter(Boolean);
}
export function extractMounts(inspectRecord: Record<string, unknown> | undefined) {
  const mounts = inspectRecord?.Mounts;
  if (!Array.isArray(mounts)) {
    return [];
  }
  return mounts
    .map((mount) => {
      const mountRecord = toRecord(mount);
      const type = readString(mountRecord, 'Type') || 'mount';
      const source = readString(mountRecord, 'Source', 'Name') || '-';
      const destination = readString(mountRecord, 'Destination') || '-';
      const rw = readString(mountRecord, 'RW') === 'false' ? 'ro' : 'rw';
      return `${type}: ${source} -> ${destination} (${rw})`;
    })
    .filter(Boolean);
}
export function extractEnv(inspectRecord: Record<string, unknown> | undefined) {
  const config = toRecord(inspectRecord?.Config);
  const env = config?.Env;
  if (!Array.isArray(env)) {
    return [];
  }
  return env
    .map((item) => (typeof item === 'string' ? item : ''))
    .filter(Boolean);
}
export function extractContainerRuntimeConfig(inspectRecord: Record<string, unknown> | undefined): ContainerRuntimeConfig {
  const config = toRecord(inspectRecord?.Config);
  const hostConfig = toRecord(inspectRecord?.HostConfig);
  const restartPolicyRecord = toRecord(hostConfig?.RestartPolicy);
  const restartPolicyName = normalizeRestartPolicy(readString(restartPolicyRecord, 'Name'));
  const restartPolicyRetryCount = readNumber(restartPolicyRecord, 'MaximumRetryCount');
  const labelsRecord = toRecord(config?.Labels);
  const labels = labelsRecord
    ? Object.entries(labelsRecord).map(([key, value]) => `${key}=${formatInspectValue(value)}`)
    : [];
  const resources: Array<{ label: string; value: string }> = [];
  const nanoCpus = readNumber(hostConfig, 'NanoCpus');
  const cpuQuota = readNumber(hostConfig, 'CpuQuota');
  const cpuPeriod = readNumber(hostConfig, 'CpuPeriod');
  const memory = readNumber(hostConfig, 'Memory');
  const memorySwap = readNumber(hostConfig, 'MemorySwap');
  if (nanoCpus && nanoCpus > 0) {
    resources.push({ label: 'CPU', value: `${Number((nanoCpus / 1_000_000_000).toFixed(3))}` });
  } else if (cpuQuota && cpuQuota > 0 && cpuPeriod && cpuPeriod > 0) {
    resources.push({ label: 'CPU', value: `${Number((cpuQuota / cpuPeriod).toFixed(3))}` });
  }
  if (memory && memory > 0) {
    resources.push({ label: 'Memory', value: formatByteLimit(memory) });
  }
  if (memorySwap && memorySwap > 0) {
    resources.push({ label: 'Swap', value: formatByteLimit(memorySwap) });
  }
  return {
    restartPolicy: restartPolicyName,
    restartPolicyText: restartPolicyRetryCount && restartPolicyRetryCount > 0
      ? `${restartPolicyName}:${restartPolicyRetryCount}`
      : restartPolicyName,
    networkMode: readString(hostConfig, 'NetworkMode') || '-',
    privileged: readString(hostConfig, 'Privileged') || '-',
    hostname: readString(config, 'Hostname') || '-',
    user: readString(config, 'User') || '-',
    workingDir: readString(config, 'WorkingDir') || '-',
    entrypoint: formatInspectValue(config?.Entrypoint),
    command: formatInspectValue(config?.Cmd),
    labels,
    resources,
  };
}
export function parseContainerStats(statsText: string): ContainerStats | undefined {
  if (!statsText) {
    return undefined;
  }
  const record = parseJsonLines(statsText)[0];
  if (!record) {
    return {
      cpu: '-',
      memory: '-',
      memoryPercent: '-',
      netIO: '-',
      blockIO: '-',
      pids: '-',
      raw: statsText,
      error: statsText,
    };
  }
  return {
    cpu: readString(record, 'CPUPerc', 'CPU%', 'CPU') || '-',
    memory: readString(record, 'MemUsage', 'MEM USAGE', 'Mem') || '-',
    memoryPercent: readString(record, 'MemPerc', 'MEM %', 'MemPercent') || '-',
    netIO: readString(record, 'NetIO', 'NET IO') || '-',
    blockIO: readString(record, 'BlockIO', 'BLOCK IO') || '-',
    pids: readString(record, 'PIDs', 'PIDS') || '-',
    raw: statsText,
  };
}
export function parseContainerDetailOutput(stdout: string, fallback: ContainerSummary, language: AppLanguage): ContainerDetail {
  const sections = splitContainerDetailSections(stdout);
  let inspectRecord: Record<string, unknown> | undefined;
  let inspectError = '';
  try {
    inspectRecord = parseJsonDocument(sections.inspect).map(toRecord).find(Boolean);
  } catch {
    inspectError = sections.inspect;
  }
  const config = toRecord(inspectRecord?.Config);
  const stateRecord = toRecord(inspectRecord?.State);
  const name = normalizeContainerName(readString(inspectRecord, 'Name')) || fallback.name;
  const image = readString(config, 'Image') || fallback.image;
  const status = readString(stateRecord, 'Status') || fallback.status;
  const state = normalizeContainerState(status || fallback.state);
  return {
    id: fallback.id,
    name,
    image,
    status,
    state,
    createdAt: readString(inspectRecord, 'Created') || fallback.createdAt,
    ports: extractPorts(inspectRecord, fallback.ports, language),
    mounts: extractMounts(inspectRecord),
    env: extractEnv(inspectRecord),
    logs: sections.logs,
    inspectText: sections.inspect,
    statsText: sections.stats,
    stats: parseContainerStats(sections.stats),
    config: extractContainerRuntimeConfig(inspectRecord),
    inspectError: inspectError || undefined,
  };
}

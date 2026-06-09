import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import DismissibleAlert from './DismissibleAlert';

import { t, useCurrentAppLanguage, type AppLanguage, type MessageId } from '../../i18n';
import { getErrorMessage, getShellDeskLocale } from './desktopUtils';
import { isWindowsSystem, powershellCommand, powershellSingleQuote } from './remoteSystem';
import { useSudoCommand } from './sudoPrompt';
import type { RemoteSystemType } from './types';

export type ContainerRuntime = 'docker' | 'podman';
export type ContainerState = 'running' | 'exited' | 'paused' | 'created' | 'unknown';

export interface ContainerSummary {
  id: string;
  name: string;
  image: string;
  command?: string;
  status: string;
  state: ContainerState;
  ports: string;
  createdAt?: string;
  runningFor?: string;
}

export interface ImageSummary {
  id: string;
  repository: string;
  tag: string;
  size: string;
  createdAt?: string;
}

interface RemoteContainerManagerProps {
  connectionId: string;
  systemType?: RemoteSystemType;
}

interface ContainerStats {
  cpu: string;
  memory: string;
  memoryPercent: string;
  netIO: string;
  blockIO: string;
  pids: string;
  raw: string;
  error?: string;
}

type RestartPolicy = 'no' | 'on-failure' | 'unless-stopped' | 'always';
type RunNetworkMode = 'default' | 'bridge' | 'host' | 'none' | 'custom';

interface ContainerRuntimeConfig {
  restartPolicy: RestartPolicy;
  restartPolicyText: string;
  networkMode: string;
  privileged: string;
  hostname: string;
  user: string;
  workingDir: string;
  entrypoint: string;
  command: string;
  labels: string[];
  resources: Array<{ label: string; value: string }>;
}

interface ContainerDetail {
  id: string;
  name: string;
  image: string;
  status: string;
  state: ContainerState;
  createdAt?: string;
  ports: string[];
  mounts: string[];
  env: string[];
  logs: string;
  inspectText: string;
  statsText: string;
  stats?: ContainerStats;
  config: ContainerRuntimeConfig;
  inspectError?: string;
}

interface ContainerTroubleshooting {
  title: string;
  message: string;
  commands: string;
  rawOutput: string;
}

interface ContainerRunForm {
  image: string;
  name: string;
  ports: string;
  volumes: string;
  environment: string;
  restartPolicy: RestartPolicy;
  networkMode: RunNetworkMode;
  network: string;
  hostname: string;
  workdir: string;
  user: string;
  command: string;
  extraArgs: string;
  createOnly: boolean;
  removeWhenStopped: boolean;
}

interface ContainerConfigForm {
  name: string;
  restartPolicy: RestartPolicy;
  cpuLimit: string;
  memoryLimit: string;
}

type ManagerTab = 'containers' | 'images';
type ContainerFilter = 'all' | ContainerState;
type DetailTab = 'summary' | 'config' | 'logs' | 'inspect' | 'exec';
type ContainerAction = 'start' | 'stop' | 'restart' | 'pause' | 'unpause' | 'kill' | 'remove';
type ImagePruneMode = 'dangling' | 'unused';

type PendingAction =
  | { kind: 'container'; action: 'remove'; container: ContainerSummary }
  | { kind: 'image'; action: 'remove'; image: ImageSummary };

const CONTAINER_INSPECT_MARKER = '__SHELLDESK_CONTAINER_INSPECT__';
const CONTAINER_STATS_MARKER = '__SHELLDESK_CONTAINER_STATS__';
const CONTAINER_LOGS_MARKER = '__SHELLDESK_CONTAINER_LOGS__';

const managerTabs: Array<{ key: ManagerTab; labelId: MessageId }> = [
  { key: 'containers', labelId: 'container.tab.containers' },
  { key: 'images', labelId: 'container.tab.images' },
];

const containerFilters: Array<{ key: ContainerFilter; labelId: MessageId }> = [
  { key: 'all', labelId: 'container.filter.all' },
  { key: 'running', labelId: 'container.state.running' },
  { key: 'exited', labelId: 'container.state.exited' },
  { key: 'paused', labelId: 'container.state.paused' },
  { key: 'created', labelId: 'container.state.created' },
  { key: 'unknown', labelId: 'container.state.unknown' },
];

const containerActionLabels: Record<ContainerAction, { labelId: MessageId; successId: MessageId; danger?: boolean; primary?: boolean }> = {
  start: { labelId: 'container.action.start', successId: 'container.action.success.start', primary: true },
  stop: { labelId: 'container.action.stop', successId: 'container.action.success.stop', danger: true },
  restart: { labelId: 'container.action.restart', successId: 'container.action.success.restart' },
  pause: { labelId: 'container.action.pause', successId: 'container.action.success.pause' },
  unpause: { labelId: 'container.action.unpause', successId: 'container.action.success.unpause', primary: true },
  kill: { labelId: 'container.action.kill', successId: 'container.action.success.kill', danger: true },
  remove: { labelId: 'container.action.remove', successId: 'container.action.success.remove', danger: true },
};

const restartPolicyOptions: Array<{ value: RestartPolicy; labelId: MessageId }> = [
  { value: 'no', labelId: 'container.restartPolicy.no' },
  { value: 'on-failure', labelId: 'container.restartPolicy.onFailure' },
  { value: 'unless-stopped', labelId: 'container.restartPolicy.unlessStopped' },
  { value: 'always', labelId: 'container.restartPolicy.always' },
];

const runNetworkModeOptions: Array<{ value: RunNetworkMode; labelId: MessageId }> = [
  { value: 'default', labelId: 'container.network.default' },
  { value: 'bridge', labelId: 'container.network.bridge' },
  { value: 'host', labelId: 'container.network.host' },
  { value: 'none', labelId: 'container.network.none' },
  { value: 'custom', labelId: 'container.network.custom' },
];

const imagePruneOptions: Array<{ value: ImagePruneMode; labelId: MessageId; descriptionId: MessageId }> = [
  { value: 'dangling', labelId: 'container.prune.dangling', descriptionId: 'container.prune.danglingDescription' },
  { value: 'unused', labelId: 'container.prune.unused', descriptionId: 'container.prune.unusedDescription' },
];

function createDefaultRunForm(image = ''): ContainerRunForm {
  return {
    image,
    name: image ? createContainerNameSuggestion(image) : '',
    ports: '',
    volumes: '',
    environment: '',
    restartPolicy: 'unless-stopped',
    networkMode: 'default',
    network: '',
    hostname: '',
    workdir: '',
    user: '',
    command: '',
    extraArgs: '',
    createOnly: false,
    removeWhenStopped: false,
  };
}

function createDefaultConfigForm(): ContainerConfigForm {
  return {
    name: '',
    restartPolicy: 'no',
    cpuLimit: '',
    memoryLimit: '',
  };
}

function shellSingleQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function readString(record: Record<string, unknown> | undefined, ...keys: string[]) {
  if (!record) {
    return '';
  }

  for (const key of keys) {
    const value = record[key];

    if (typeof value === 'string') {
      return value.trim();
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }

    if (Array.isArray(value)) {
      return value
        .filter((item) => item !== undefined && item !== null)
        .map((item) => String(item).trim())
        .filter(Boolean)
        .join(', ');
    }
  }

  return '';
}

function readNumber(record: Record<string, unknown> | undefined, ...keys: string[]) {
  if (!record) {
    return undefined;
  }

  for (const key of keys) {
    const value = record[key];

    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === 'string') {
      const parsedValue = Number(value);

      if (Number.isFinite(parsedValue)) {
        return parsedValue;
      }
    }
  }

  return undefined;
}

function formatInspectValue(value: unknown) {
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

function formatByteLimit(value: number | undefined) {
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

function normalizeRestartPolicy(value: string): RestartPolicy {
  const normalizedValue = value.trim().toLowerCase();

  if (normalizedValue === 'always') return 'always';
  if (normalizedValue === 'unless-stopped') return 'unless-stopped';
  if (normalizedValue.startsWith('on-failure')) return 'on-failure';
  return 'no';
}

function createContainerNameSuggestion(imageRef: string) {
  const imageName = imageRef
    .replace(/^sha256:/, '')
    .split('@')[0]
    .replace(/:[^/:]+$/u, '')
    .split('/')
    .filter(Boolean)
    .pop() || '';
  const normalizedName = imageName
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/gu, '-')
    .replace(/^-+|-+$/gu, '');

  return normalizedName ? `${normalizedName}-app` : '';
}

function parseMultilineValues(value: string) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseContainerCliTokens(value: string, fieldLabel: string, language: AppLanguage) {
  const tokens: string[] = [];
  let currentToken = '';
  let quote: '"' | "'" | null = null;
  let escaping = false;

  for (const char of value.trim()) {
    if (escaping) {
      currentToken += char;
      escaping = false;
      continue;
    }

    if (char === '\\' && quote !== "'") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        currentToken += char;
      }

      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/u.test(char)) {
      if (currentToken) {
        tokens.push(currentToken);
        currentToken = '';
      }

      continue;
    }

    currentToken += char;
  }

  if (escaping) {
    currentToken += '\\';
  }

  if (quote) {
    throw new Error(t('container.error.unclosedQuote', language, { field: fieldLabel }));
  }

  if (currentToken) {
    tokens.push(currentToken);
  }

  return tokens;
}

function formatRuntimeCommand(runtime: ContainerRuntime, args: string[]) {
  return `${runtime} ${args.map(shellSingleQuote).join(' ')}`;
}

function getRuntimeCliCommand(runtime: ContainerRuntime, args: string[], isWindowsHost: boolean) {
  if (isWindowsHost) {
    const powershellArgs = args.map(powershellSingleQuote).join(', ');

    return powershellCommand(`
$runtime = ${powershellSingleQuote(runtime)}
$containerArgs = @(${powershellArgs})
& $runtime @containerArgs 2>&1 | ForEach-Object { $_.ToString() }
$exitCode = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } else { 0 }
exit $exitCode
`);
  }

  return `${formatRuntimeCommand(runtime, args)} 2>&1`;
}

function parseJsonDocument(text: string): unknown[] {
  const trimmedText = text.trim();

  if (!trimmedText) {
    return [];
  }

  const parsedJson = JSON.parse(trimmedText) as unknown;
  return Array.isArray(parsedJson) ? parsedJson : [parsedJson];
}

function parseJsonLines(stdout: string) {
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

function normalizeContainerName(name: string) {
  return name.replace(/^\//, '').trim();
}

function normalizeContainerState(value: string): ContainerState {
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

function getStateLabel(state: ContainerState, language: AppLanguage) {
  if (state === 'running') return t('container.state.running', language);
  if (state === 'exited') return t('container.state.exited', language);
  if (state === 'paused') return t('container.state.paused', language);
  if (state === 'created') return t('container.state.created', language);
  return t('container.state.unknown', language);
}

function getRuntimeLabel(runtime: ContainerRuntime | null, language: AppLanguage) {
  if (runtime === 'docker') return 'Docker';
  if (runtime === 'podman') return 'Podman';
  return t('container.runtime.notDetected', language);
}

function formatShortId(id: string) {
  return id.replace(/^sha256:/, '').slice(0, 12) || '-';
}

function getImageReference(image: ImageSummary) {
  const hasRepository = image.repository && image.repository !== '<none>';
  const hasTag = image.tag && image.tag !== '<none>';

  if (hasRepository && hasTag) {
    return `${image.repository}:${image.tag}`;
  }

  if (hasRepository) {
    return image.repository;
  }

  return image.id;
}

function parseContainerSummary(record: Record<string, unknown>): ContainerSummary | null {
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
    ports: readString(record, 'Ports', 'ports') || '-',
    createdAt: readString(record, 'CreatedAt', 'Created', 'createdAt', 'created') || undefined,
    runningFor: readString(record, 'RunningFor', 'RunningForHuman', 'runningFor') || undefined,
  };
}

function parseImageSummary(record: Record<string, unknown>): ImageSummary | null {
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

function splitContainerDetailSections(stdout: string) {
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

function extractPorts(inspectRecord: Record<string, unknown> | undefined, fallbackPorts: string, language: AppLanguage) {
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

function extractMounts(inspectRecord: Record<string, unknown> | undefined) {
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

function extractEnv(inspectRecord: Record<string, unknown> | undefined) {
  const config = toRecord(inspectRecord?.Config);
  const env = config?.Env;

  if (!Array.isArray(env)) {
    return [];
  }

  return env
    .map((item) => (typeof item === 'string' ? item : ''))
    .filter(Boolean);
}

function extractContainerRuntimeConfig(inspectRecord: Record<string, unknown> | undefined): ContainerRuntimeConfig {
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

function parseContainerStats(statsText: string): ContainerStats | undefined {
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

function parseContainerDetailOutput(stdout: string, fallback: ContainerSummary, language: AppLanguage): ContainerDetail {
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

function getDetectRuntimeCommand(isWindowsHost: boolean, language: AppLanguage) {
  const noRuntime = t('container.error.noRuntime', language);

  if (isWindowsHost) {
    return powershellCommand(`
$docker = Get-Command docker -ErrorAction SilentlyContinue | Select-Object -First 1
if ($docker) { "docker"; exit 0 }
$podman = Get-Command podman -ErrorAction SilentlyContinue | Select-Object -First 1
if ($podman) { "podman"; exit 0 }
Write-Error "${noRuntime}"
exit 127
`);
  }

  return `
if command -v docker >/dev/null 2>&1; then
  printf 'docker\\n'
  exit 0
fi
if command -v podman >/dev/null 2>&1; then
  printf 'podman\\n'
  exit 0
fi
printf '${noRuntime}\\n' >&2
exit 127
`;
}

function getContainerListCommand(runtime: ContainerRuntime, isWindowsHost: boolean) {
  if (isWindowsHost) {
    return powershellCommand(`
$runtime = ${powershellSingleQuote(runtime)}
& $runtime ps -a --format '{{json .}}' 2>&1 | ForEach-Object { $_.ToString() }
$exitCode = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } else { 0 }
exit $exitCode
`);
  }

  return `${runtime} ps -a --format '{{json .}}' 2>&1`;
}

function getImageListCommand(runtime: ContainerRuntime, isWindowsHost: boolean) {
  if (isWindowsHost) {
    return powershellCommand(`
$runtime = ${powershellSingleQuote(runtime)}
& $runtime images --format '{{json .}}' 2>&1 | ForEach-Object { $_.ToString() }
$exitCode = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } else { 0 }
exit $exitCode
`);
  }

  return `${runtime} images --format '{{json .}}' 2>&1`;
}

function getContainerDetailCommand(runtime: ContainerRuntime, containerId: string, isWindowsHost: boolean) {
  if (isWindowsHost) {
    return powershellCommand(`
$runtime = ${powershellSingleQuote(runtime)}
$target = ${powershellSingleQuote(containerId)}
"${CONTAINER_INSPECT_MARKER}"
& $runtime inspect $target 2>&1 | ForEach-Object { $_.ToString() }
"${CONTAINER_STATS_MARKER}"
& $runtime stats --no-stream --format '{{json .}}' $target 2>&1 | ForEach-Object { $_.ToString() }
"${CONTAINER_LOGS_MARKER}"
& $runtime logs --tail 200 $target 2>&1 | ForEach-Object { $_.ToString() }
exit 0
`);
  }

  return `
target=${shellSingleQuote(containerId)}
printf '${CONTAINER_INSPECT_MARKER}\\n'
${runtime} inspect "$target" 2>&1 || true
printf '${CONTAINER_STATS_MARKER}\\n'
${runtime} stats --no-stream --format '{{json .}}' "$target" 2>&1 || true
printf '${CONTAINER_LOGS_MARKER}\\n'
${runtime} logs --tail 200 "$target" 2>&1 || true
`;
}

function getContainerActionCommand(runtime: ContainerRuntime, action: ContainerAction, containerId: string, isWindowsHost: boolean) {
  const runtimeAction = action === 'remove' ? 'rm' : action;

  if (isWindowsHost) {
    return powershellCommand(`
$runtime = ${powershellSingleQuote(runtime)}
$target = ${powershellSingleQuote(containerId)}
& $runtime ${runtimeAction} $target 2>&1 | ForEach-Object { $_.ToString() }
$exitCode = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } else { 0 }
exit $exitCode
`);
  }

  return `${runtime} ${runtimeAction} ${shellSingleQuote(containerId)} 2>&1`;
}

function buildContainerRunArgs(form: ContainerRunForm, language: AppLanguage) {
  const image = form.image.trim();

  if (!image) {
    throw new Error(t('container.error.imageRequired', language));
  }

  const args = [form.createOnly ? 'create' : 'run'];
  const name = form.name.trim();
  const network = form.networkMode === 'custom' ? form.network.trim() : form.networkMode === 'default' ? '' : form.networkMode;
  const hostname = form.hostname.trim();
  const workdir = form.workdir.trim();
  const user = form.user.trim();

  if (form.networkMode === 'custom' && !network) {
    throw new Error(t('container.error.customNetworkRequired', language));
  }

  if (!form.createOnly) {
    args.push('-d');
  }

  if (!form.createOnly && form.removeWhenStopped) {
    args.push('--rm');
  }

  if (name) {
    args.push('--name', name);
  }

  if (form.restartPolicy !== 'no' && (form.createOnly || !form.removeWhenStopped)) {
    args.push('--restart', form.restartPolicy);
  }

  if (network) {
    args.push('--network', network);
  }

  if (hostname) {
    args.push('--hostname', hostname);
  }

  if (workdir) {
    args.push('-w', workdir);
  }

  if (user) {
    args.push('-u', user);
  }

  parseMultilineValues(form.ports).forEach((port) => args.push('-p', port));
  parseMultilineValues(form.volumes).forEach((volume) => args.push('-v', volume));
  parseMultilineValues(form.environment).forEach((env) => args.push('-e', env));
  args.push(...parseContainerCliTokens(form.extraArgs, t('container.ui.extraArgs', language), language));
  args.push(image);
  args.push(...parseContainerCliTokens(form.command, t('container.ui.command', language), language));

  return args;
}

function buildImagePruneArgs(mode: ImagePruneMode) {
  const args = ['image', 'prune', '--force'];

  if (mode === 'unused') {
    args.push('--all');
  }

  return args;
}

function buildContainerConfigCommandGroups(containerId: string, form: ContainerConfigForm, detail: ContainerDetail, language: AppLanguage) {
  const groups: string[][] = [];
  const nextName = form.name.trim();
  const cpuLimit = form.cpuLimit.trim();
  const memoryLimit = form.memoryLimit.trim();
  const currentRestartPolicy = detail.config.restartPolicy;
  const updateArgs = ['update'];

  if (nextName && nextName !== detail.name) {
    if (/\s/u.test(nextName)) {
      throw new Error(t('container.error.invalidContainerName', language));
    }

    groups.push(['rename', containerId, nextName]);
  }

  if (form.restartPolicy !== currentRestartPolicy) {
    updateArgs.push('--restart', form.restartPolicy);
  }

  if (cpuLimit) {
    updateArgs.push('--cpus', cpuLimit);
  }

  if (memoryLimit) {
    updateArgs.push('--memory', memoryLimit);
  }

  if (updateArgs.length > 1) {
    updateArgs.push(containerId);
    groups.push(updateArgs);
  }

  if (groups.length === 0) {
    throw new Error(t('container.error.noConfigChange', language));
  }

  return groups;
}

function getContainerConfigUpdateCommand(runtime: ContainerRuntime, commandGroups: string[][], isWindowsHost: boolean) {
  if (isWindowsHost) {
    const powershellGroups = commandGroups
      .map((group) => `, @(${group.map(powershellSingleQuote).join(', ')})`)
      .join('\n');

    return powershellCommand(`
$runtime = ${powershellSingleQuote(runtime)}
$commandGroups = @(
${powershellGroups}
)
foreach ($containerArgs in $commandGroups) {
  & $runtime @containerArgs 2>&1 | ForEach-Object { $_.ToString() }
  $exitCode = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } else { 0 }
  if ($exitCode -ne 0) { exit $exitCode }
}
exit 0
`);
  }

  return [
    'set -e',
    ...commandGroups.map((args) => `${formatRuntimeCommand(runtime, args)} 2>&1`),
  ].join('\n');
}

function getImagePullCommand(runtime: ContainerRuntime, imageName: string, isWindowsHost: boolean) {
  if (isWindowsHost) {
    return powershellCommand(`
$runtime = ${powershellSingleQuote(runtime)}
$image = ${powershellSingleQuote(imageName)}
& $runtime pull $image 2>&1 | ForEach-Object { $_.ToString() }
$exitCode = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } else { 0 }
exit $exitCode
`);
  }

  return `${runtime} pull ${shellSingleQuote(imageName)} 2>&1`;
}

function getImageRemoveCommand(runtime: ContainerRuntime, imageRef: string, isWindowsHost: boolean) {
  if (isWindowsHost) {
    return powershellCommand(`
$runtime = ${powershellSingleQuote(runtime)}
$image = ${powershellSingleQuote(imageRef)}
& $runtime rmi $image 2>&1 | ForEach-Object { $_.ToString() }
$exitCode = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } else { 0 }
exit $exitCode
`);
  }

  return `${runtime} rmi ${shellSingleQuote(imageRef)} 2>&1`;
}

function getContainerExecCommand(runtime: ContainerRuntime, containerId: string, command: string, isWindowsHost: boolean) {
  if (isWindowsHost) {
    return powershellCommand(`
$runtime = ${powershellSingleQuote(runtime)}
$target = ${powershellSingleQuote(containerId)}
$execCommand = ${powershellSingleQuote(command)}
& $runtime exec $target sh -lc $execCommand 2>&1 | ForEach-Object { $_.ToString() }
$exitCode = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } else { 0 }
exit $exitCode
`);
  }

  return `${runtime} exec ${shellSingleQuote(containerId)} sh -lc ${shellSingleQuote(command)} 2>&1`;
}

function matchesContainerQuery(container: ContainerSummary, query: string) {
  if (!query) {
    return true;
  }

  const normalizedQuery = query.toLowerCase();
  const searchableText = [
    container.id,
    container.name,
    container.image,
    container.command,
    container.status,
    container.ports,
  ].filter(Boolean).join(' ').toLowerCase();

  return searchableText.includes(normalizedQuery);
}

function matchesImageQuery(image: ImageSummary, query: string) {
  if (!query) {
    return true;
  }

  const normalizedQuery = query.toLowerCase();
  return [image.id, image.repository, image.tag, image.size, image.createdAt]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .includes(normalizedQuery);
}

function buildContainerDiagnostics(detail: ContainerDetail, language: AppLanguage) {
  return [
    t('container.diagnostics.container', language, { name: detail.name }),
    `ID：${detail.id}`,
    t('container.diagnostics.image', language, { image: detail.image }),
    t('container.diagnostics.status', language, { state: getStateLabel(detail.state, language), status: detail.status || '-' }),
    t('container.diagnostics.created', language, { created: detail.createdAt || '-' }),
    `CPU：${detail.stats?.cpu || '-'}`,
    t('container.diagnostics.memory', language, { memory: detail.stats?.memory || '-', percent: detail.stats?.memoryPercent || '-' }),
    '',
    '--- ports ---',
    detail.ports.join('\n') || t('container.diagnostics.noPorts', language),
    '',
    '--- mounts ---',
    detail.mounts.join('\n') || t('container.diagnostics.noMounts', language),
    '',
    '--- logs ---',
    detail.logs || t('container.diagnostics.noLogs', language),
  ].join('\n');
}

function buildDockerDaemonRestartCommand(language: AppLanguage) {
  return [
    t('container.restart.warning', language),
    'set -e',
    'if command -v systemctl >/dev/null 2>&1; then',
    '  if [ "$(id -u)" -eq 0 ]; then',
    '    systemctl restart docker',
    '  else',
    '    sudo systemctl restart docker',
    '  fi',
    'else',
    '  if [ "$(id -u)" -eq 0 ]; then',
    '    service docker restart',
    '  else',
    '    sudo service docker restart',
    '  fi',
    'fi',
  ].join('\n');
}

function buildDockerRestartCommand(containerId: string, language: AppLanguage) {
  const target = shellSingleQuote(containerId);

  return [
    buildDockerDaemonRestartCommand(language),
    `docker start ${target}`,
  ].join('\n');
}

function isDockerNetworkTrouble(output: string, runtime: ContainerRuntime) {
  return (
    runtime === 'docker' &&
    /iptables/i.test(output) &&
    /\bDOCKER\b/.test(output) &&
    /No chain\/target\/match by that name/i.test(output)
  );
}

function createDockerNetworkTroubleshooting(output: string, commands: string, language: AppLanguage): ContainerTroubleshooting {
  return {
    title: t('container.troubleshooting.title', language),
    message: t('container.troubleshooting.message', language),
    commands,
    rawOutput: output,
  };
}

function createContainerTroubleshooting(
  output: string,
  runtime: ContainerRuntime,
  action: ContainerAction,
  container: ContainerSummary,
  language: AppLanguage,
): ContainerTroubleshooting | null {
  if ((action !== 'start' && action !== 'restart') || !isDockerNetworkTrouble(output, runtime)) {
    return null;
  }

  return createDockerNetworkTroubleshooting(output, buildDockerRestartCommand(container.id, language), language);
}

function RemoteContainerManager({ connectionId, systemType }: RemoteContainerManagerProps) {
  const language = useCurrentAppLanguage();
  const isWindowsHost = isWindowsSystem(systemType);
  const { runCommand, sudoPrompt } = useSudoCommand(connectionId, systemType);
  const runtimeRef = useRef<ContainerRuntime | null>(null);
  const isMountedRef = useRef(true);
  const selectedContainerIdRef = useRef('');
  const detailRequestIdRef = useRef(0);
  const [runtime, setRuntimeState] = useState<ContainerRuntime | null>(null);
  const [activeTab, setActiveTab] = useState<ManagerTab>('containers');
  const [containers, setContainers] = useState<ContainerSummary[]>([]);
  const [images, setImages] = useState<ImageSummary[]>([]);
  const [selectedContainerId, setSelectedContainerId] = useState('');
  const [detail, setDetail] = useState<ContainerDetail | null>(null);
  const [detailTab, setDetailTab] = useState<DetailTab>('summary');
  const [containerSearch, setContainerSearch] = useState('');
  const [containerFilter, setContainerFilter] = useState<ContainerFilter>('all');
  const [imageSearch, setImageSearch] = useState('');
  const [pullImageName, setPullImageName] = useState('');
  const [imagePruneMode, setImagePruneMode] = useState<ImagePruneMode>('dangling');
  const [imagePruneDialogOpen, setImagePruneDialogOpen] = useState(false);
  const [imagePruneError, setImagePruneError] = useState('');
  const [execCommand, setExecCommand] = useState('id && uname -a');
  const [execOutput, setExecOutput] = useState('');
  const [runPanelOpen, setRunPanelOpen] = useState(false);
  const [runForm, setRunForm] = useState<ContainerRunForm>(() => createDefaultRunForm());
  const [configForm, setConfigForm] = useState<ContainerConfigForm>(() => createDefaultConfigForm());
  const [runtimeLoading, setRuntimeLoading] = useState(false);
  const [containersLoading, setContainersLoading] = useState(false);
  const [imagesLoading, setImagesLoading] = useState(false);
  const [imagesLoaded, setImagesLoaded] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [actingKey, setActingKey] = useState('');
  const [pulling, setPulling] = useState(false);
  const [pruningImages, setPruningImages] = useState(false);
  const [runningContainer, setRunningContainer] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);
  const [execRunning, setExecRunning] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [success, setSuccess] = useState('');
  const [troubleshooting, setTroubleshooting] = useState<ContainerTroubleshooting | null>(null);
  const [runError, setRunError] = useState('');
  const [runTroubleshooting, setRunTroubleshooting] = useState<ContainerTroubleshooting | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);

  const setRuntimeValue = useCallback((value: ContainerRuntime | null) => {
    runtimeRef.current = value;
    setRuntimeState(value);
  }, []);

  useEffect(() => {
    selectedContainerIdRef.current = selectedContainerId;
  }, [selectedContainerId]);

  const detectRuntime = useCallback(async (options?: { suppressGlobalError?: boolean }) => {
    if (runtimeRef.current) {
      return runtimeRef.current;
    }

    setRuntimeLoading(true);
    setError('');
    setNotice('');
    setTroubleshooting(null);

    try {
      const result = await runCommand(getDetectRuntimeCommand(isWindowsHost, language));
      const detectedRuntime = (result.stdout || '').split(/\r?\n/).map((line) => line.trim()).find((line) => line === 'docker' || line === 'podman') as ContainerRuntime | undefined;

      if (!detectedRuntime) {
        throw new Error(result.stderr || result.stdout || t('container.error.noRuntime', language));
      }

      if (isMountedRef.current) {
        setRuntimeValue(detectedRuntime);
      }

      return detectedRuntime;
    } catch (err) {
      if (isMountedRef.current) {
        setRuntimeValue(null);
        if (!options?.suppressGlobalError) {
          setError(getErrorMessage(err));
        }
      }

      throw err;
    } finally {
      if (isMountedRef.current) {
        setRuntimeLoading(false);
      }
    }
  }, [isWindowsHost, language, runCommand, setRuntimeValue]);

  const refreshContainers = useCallback(async (options?: { runtimeOverride?: ContainerRuntime; silent?: boolean; preferredContainerId?: string; preferredContainerName?: string }) => {
    if (!options?.silent) {
      setContainersLoading(true);
    }

    setError('');
    setNotice('');
    setTroubleshooting(null);

    try {
      const activeRuntime = options?.runtimeOverride ?? await detectRuntime();
      const result = await runCommand(getContainerListCommand(activeRuntime, isWindowsHost));
      const nextContainers = parseJsonLines(result.stdout || '')
        .map(parseContainerSummary)
        .filter((container): container is ContainerSummary => Boolean(container))
        .sort((first, second) => {
          const firstWeight = first.state === 'running' ? 0 : first.state === 'exited' ? 2 : 1;
          const secondWeight = second.state === 'running' ? 0 : second.state === 'exited' ? 2 : 1;

          if (firstWeight !== secondWeight) {
            return firstWeight - secondWeight;
          }

          return first.name.localeCompare(second.name, getShellDeskLocale());
        });

      if (result.code !== 0 && nextContainers.length === 0) {
        throw new Error(result.stderr || result.stdout || t('container.error.listContainers', language));
      }

      if (!isMountedRef.current) {
        return selectedContainerIdRef.current;
      }

      setContainers(nextContainers);

      if (result.code !== 0) {
        setNotice(result.stderr || t('container.notice.partialContainers', language));
      }

      const preferredContainerId = options?.preferredContainerId ?? selectedContainerIdRef.current;
      const preferredContainerName = options?.preferredContainerName?.trim();
      const preferredContainer = nextContainers.find((container) => (
        (preferredContainerId && (container.id === preferredContainerId || preferredContainerId.startsWith(container.id) || container.id.startsWith(preferredContainerId))) ||
        (preferredContainerName && container.name === preferredContainerName)
      ));
      const nextSelectedContainerId = preferredContainer?.id ?? nextContainers[0]?.id ?? '';

      setSelectedContainerId(nextSelectedContainerId);
      return nextSelectedContainerId;
    } catch (err) {
      if (isMountedRef.current) {
        setError(getErrorMessage(err));
      }

      return selectedContainerIdRef.current;
    } finally {
      if (isMountedRef.current && !options?.silent) {
        setContainersLoading(false);
      }
    }
  }, [detectRuntime, isWindowsHost, language, runCommand]);

  const refreshImages = useCallback(async (options?: { runtimeOverride?: ContainerRuntime; silent?: boolean }) => {
    if (!options?.silent) {
      setImagesLoading(true);
    }

    setError('');
    setNotice('');
    setTroubleshooting(null);

    try {
      const activeRuntime = options?.runtimeOverride ?? await detectRuntime();
      const result = await runCommand(getImageListCommand(activeRuntime, isWindowsHost));
      const nextImages = parseJsonLines(result.stdout || '')
        .map(parseImageSummary)
        .filter((image): image is ImageSummary => Boolean(image))
        .sort((first, second) => getImageReference(first).localeCompare(getImageReference(second), getShellDeskLocale()));

      if (result.code !== 0 && nextImages.length === 0) {
        throw new Error(result.stderr || result.stdout || t('container.error.listImages', language));
      }

      if (!isMountedRef.current) {
        return;
      }

      setImages(nextImages);
      setImagesLoaded(true);

      if (result.code !== 0) {
        setNotice(result.stderr || t('container.notice.partialImages', language));
      }
    } catch (err) {
      if (isMountedRef.current) {
        setImagesLoaded(true);
        setError(getErrorMessage(err));
      }
    } finally {
      if (isMountedRef.current && !options?.silent) {
        setImagesLoading(false);
      }
    }
  }, [detectRuntime, isWindowsHost, language, runCommand]);

  const loadContainerDetail = useCallback(async (containerId: string) => {
    const fallback = containers.find((container) => container.id === containerId);

    if (!fallback) {
      setDetail(null);
      return;
    }

    const requestId = detailRequestIdRef.current + 1;
    detailRequestIdRef.current = requestId;
    setDetailLoading(true);
    setError('');
    setTroubleshooting(null);

    try {
      const activeRuntime = await detectRuntime();
      const result = await runCommand(getContainerDetailCommand(activeRuntime, containerId, isWindowsHost));
      const nextDetail = parseContainerDetailOutput(result.stdout || '', fallback, language);

      if (result.code !== 0 && !nextDetail.inspectText) {
        throw new Error(result.stderr || result.stdout || t('container.error.detail', language));
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
  }, [containers, detectRuntime, isWindowsHost, language, runCommand]);

  useEffect(() => {
    isMountedRef.current = true;
    setRuntimeValue(null);
    setContainers([]);
    setImages([]);
    setImagesLoaded(false);
    setDetail(null);
    setSelectedContainerId('');
    setExecOutput('');
    setRunForm(createDefaultRunForm());
    setConfigForm(createDefaultConfigForm());
    setRunError('');
    setRunTroubleshooting(null);
    setRunPanelOpen(false);
    setImagePruneMode('dangling');
    setImagePruneDialogOpen(false);
    setImagePruneError('');
    void refreshContainers();

    return () => {
      isMountedRef.current = false;
    };
  }, [connectionId, refreshContainers, setRuntimeValue]);

  useEffect(() => {
    if (!selectedContainerId) {
      setDetail(null);
      return;
    }

    void loadContainerDetail(selectedContainerId);
  }, [loadContainerDetail, selectedContainerId]);

  useEffect(() => {
    if (activeTab === 'images' && !imagesLoaded && !imagesLoading) {
      void refreshImages();
    }
  }, [activeTab, imagesLoaded, imagesLoading, refreshImages]);

  const selectedContainer = useMemo(
    () => containers.find((container) => container.id === selectedContainerId) ?? null,
    [containers, selectedContainerId],
  );

  const selectedDetail = detail?.id === selectedContainerId ? detail : null;

  useEffect(() => {
    if (!selectedDetail) {
      setConfigForm(createDefaultConfigForm());
      return;
    }

    setConfigForm({
      name: selectedDetail.name,
      restartPolicy: selectedDetail.config.restartPolicy,
      cpuLimit: '',
      memoryLimit: '',
    });
  }, [selectedDetail?.id, selectedDetail?.name, selectedDetail?.config.restartPolicy]);

  const visibleContainers = useMemo(() => {
    const query = containerSearch.trim();

    return containers.filter((container) => (
      (containerFilter === 'all' || container.state === containerFilter) &&
      matchesContainerQuery(container, query)
    ));
  }, [containerFilter, containerSearch, containers]);

  const visibleImages = useMemo(() => {
    const query = imageSearch.trim();
    return images.filter((image) => matchesImageQuery(image, query));
  }, [imageSearch, images]);

  const containerStats = useMemo(() => ({
    running: containers.filter((container) => container.state === 'running').length,
    exited: containers.filter((container) => container.state === 'exited').length,
    paused: containers.filter((container) => container.state === 'paused').length,
    created: containers.filter((container) => container.state === 'created').length,
  }), [containers]);

  const copyToClipboard = async (value: string, label: string) => {
    setError('');
    setSuccess('');

    try {
      await navigator.clipboard.writeText(value);
      setSuccess(t('container.message.copied', language, { label }));
    } catch (err) {
      setError(t('container.error.copyFailed', language, { error: getErrorMessage(err) }));
    }
  };

  const updateRunForm = <Key extends keyof ContainerRunForm>(key: Key, value: ContainerRunForm[Key]) => {
    setRunForm((currentForm) => ({ ...currentForm, [key]: value }));
  };

  const updateConfigForm = <Key extends keyof ContainerConfigForm>(key: Key, value: ContainerConfigForm[Key]) => {
    setConfigForm((currentForm) => ({ ...currentForm, [key]: value }));
  };

  const runCommandPreview = useMemo(() => {
    try {
      if (!runForm.image.trim()) {
        return '';
      }

      return formatRuntimeCommand(runtime ?? 'docker', buildContainerRunArgs(runForm, language));
    } catch {
      return '';
    }
  }, [language, runForm, runtime]);

  const imagePruneCommandPreview = useMemo(
    () => formatRuntimeCommand(runtime ?? 'docker', buildImagePruneArgs(imagePruneMode)),
    [imagePruneMode, runtime],
  );

  const prepareRunFromImage = (image: ImageSummary) => {
    const imageRef = getImageReference(image);

    setRunError('');
    setRunTroubleshooting(null);
    setRunForm((currentForm) => ({
      ...currentForm,
      image: imageRef,
      name: createContainerNameSuggestion(imageRef),
    }));
    setActiveTab('containers');
    setRunPanelOpen(true);
  };

  const openRunDialog = () => {
    setActiveTab('containers');
    setRunError('');
    setRunTroubleshooting(null);
    setRunPanelOpen(true);
  };

  const resetRunDialog = () => {
    setRunError('');
    setRunTroubleshooting(null);
    setRunForm(createDefaultRunForm());
  };

  const openImagePruneDialog = () => {
    setImagePruneError('');
    setPendingAction(null);
    setImagePruneDialogOpen(true);
  };

  const executeRunContainer = async () => {
    let args: string[];

    try {
      args = buildContainerRunArgs(runForm, language);
    } catch (err) {
      setRunError(getErrorMessage(err));
      setRunTroubleshooting(null);
      return;
    }

    setRunningContainer(true);
    setRunError('');
    setNotice('');
    setSuccess('');
    setRunTroubleshooting(null);

    try {
      const activeRuntime = await detectRuntime({ suppressGlobalError: true });
      const result = await runCommand(getRuntimeCliCommand(activeRuntime, args, isWindowsHost));
      const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();

      if (result.code !== 0) {
        if (isDockerNetworkTrouble(output, activeRuntime)) {
          const repairCommand = [
            buildDockerDaemonRestartCommand(language),
            formatRuntimeCommand(activeRuntime, args),
          ].join('\n');
          setRunTroubleshooting(createDockerNetworkTroubleshooting(output, repairCommand, language));
          throw new Error(t('container.error.dockerNetworkTrouble', language));
        }

        throw new Error(output || t('container.error.runFailed', language));
      }

      const preferredContainerName = runForm.name.trim();
      setSuccess(t(runForm.createOnly ? 'container.success.containerCreated' : 'container.success.containerStarted', language, {
        name: preferredContainerName || formatShortId(output),
      }));
      setActiveTab('containers');
      setRunPanelOpen(false);
      const nextSelectedContainerId = await refreshContainers({
        runtimeOverride: activeRuntime,
        silent: true,
        preferredContainerId: output,
        preferredContainerName,
      });

      if (nextSelectedContainerId) {
        setSelectedContainerId(nextSelectedContainerId);
        setDetailTab('summary');
        await loadContainerDetail(nextSelectedContainerId);
      }
    } catch (err) {
      setRunError(getErrorMessage(err));
    } finally {
      if (isMountedRef.current) {
        setRunningContainer(false);
      }
    }
  };

  const executeConfigUpdate = async () => {
    if (!selectedContainer || !selectedDetail) {
      setError(t('container.error.selectContainer', language));
      return;
    }

    let commandGroups: string[][];

    try {
      commandGroups = buildContainerConfigCommandGroups(selectedContainer.id, configForm, selectedDetail, language);
    } catch (err) {
      setError(getErrorMessage(err));
      return;
    }

    setSavingConfig(true);
    setError('');
    setNotice('');
    setSuccess('');
    setTroubleshooting(null);

    try {
      const activeRuntime = await detectRuntime();
      const result = await runCommand(getContainerConfigUpdateCommand(activeRuntime, commandGroups, isWindowsHost));
      const output = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();

      if (result.code !== 0) {
        throw new Error(output || t('container.error.configFailed', language));
      }

      const preferredContainerName = configForm.name.trim();
      setSuccess(t('container.success.configSaved', language, { name: preferredContainerName || selectedContainer.name }));
      const nextSelectedContainerId = await refreshContainers({
        runtimeOverride: activeRuntime,
        silent: true,
        preferredContainerId: selectedContainer.id,
        preferredContainerName,
      });

      if (nextSelectedContainerId) {
        await loadContainerDetail(nextSelectedContainerId);
      }
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      if (isMountedRef.current) {
        setSavingConfig(false);
      }
    }
  };

  const executeContainerAction = async (action: ContainerAction, container: ContainerSummary) => {
    setActingKey(`${action}:${container.id}`);
    setError('');
    setNotice('');
    setSuccess('');
    setTroubleshooting(null);

    try {
      const activeRuntime = await detectRuntime();
      const result = await runCommand(getContainerActionCommand(activeRuntime, action, container.id, isWindowsHost));

      if (result.code !== 0) {
        const output = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
        const nextTroubleshooting = createContainerTroubleshooting(output, activeRuntime, action, container, language);

        if (nextTroubleshooting) {
          setTroubleshooting(nextTroubleshooting);
          throw new Error(t('container.error.dockerNetworkTrouble', language));
        }

        throw new Error(output || t('container.error.operationFailed', language));
      }

      setSuccess(`${t(containerActionLabels[action].successId, language)}: ${container.name}`);
      const nextSelectedContainerId = await refreshContainers({
        runtimeOverride: activeRuntime,
        silent: true,
        preferredContainerId: action === 'remove' ? '' : container.id,
      });

      if (action !== 'remove' && nextSelectedContainerId) {
        await loadContainerDetail(nextSelectedContainerId);
      }
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      if (isMountedRef.current) {
        setActingKey('');
        setPendingAction(null);
      }
    }
  };

  const executeImagePull = async () => {
    const imageName = pullImageName.trim();

    if (!imageName) {
      setError(t('container.error.imageRequired', language));
      return;
    }

    setPulling(true);
    setError('');
    setNotice('');
    setSuccess('');
    setTroubleshooting(null);

    try {
      const activeRuntime = await detectRuntime();
      const result = await runCommand(getImagePullCommand(activeRuntime, imageName, isWindowsHost));

      if (result.code !== 0) {
        throw new Error(result.stderr || result.stdout || t('container.error.pullFailed', language));
      }

      setSuccess(t('container.success.imagePulled', language, { image: imageName }));
      setPullImageName('');
      await refreshImages({ runtimeOverride: activeRuntime, silent: true });
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      if (isMountedRef.current) {
        setPulling(false);
      }
    }
  };

  const executeImagePrune = async () => {
    setPruningImages(true);
    setImagePruneError('');
    setError('');
    setNotice('');
    setSuccess('');
    setTroubleshooting(null);

    try {
      const activeRuntime = await detectRuntime({ suppressGlobalError: true });
      const result = await runCommand(getRuntimeCliCommand(activeRuntime, buildImagePruneArgs(imagePruneMode), isWindowsHost));
      const output = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();

      if (result.code !== 0) {
        throw new Error(output || t('container.error.pruneImagesFailed', language));
      }

      const selectedPruneOption = imagePruneOptions.find((option) => option.value === imagePruneMode) ?? imagePruneOptions[0];
      setSuccess(t('container.success.imagesPruned', language, { scope: t(selectedPruneOption.labelId, language) }));
      setImagePruneDialogOpen(false);
      await refreshImages({ runtimeOverride: activeRuntime, silent: true });
    } catch (err) {
      if (isMountedRef.current) {
        setImagePruneError(getErrorMessage(err));
      }
    } finally {
      if (isMountedRef.current) {
        setPruningImages(false);
      }
    }
  };

  const executeImageRemove = async (image: ImageSummary) => {
    const imageRef = getImageReference(image);
    setActingKey(`image-remove:${image.id}`);
    setError('');
    setNotice('');
    setSuccess('');
    setTroubleshooting(null);

    try {
      const activeRuntime = await detectRuntime();
      const result = await runCommand(getImageRemoveCommand(activeRuntime, imageRef, isWindowsHost));

      if (result.code !== 0) {
        throw new Error(result.stderr || result.stdout || t('container.error.removeImageFailed', language));
      }

      setSuccess(t('container.success.imageRemoved', language, { image: imageRef }));
      await refreshImages({ runtimeOverride: activeRuntime, silent: true });
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      if (isMountedRef.current) {
        setActingKey('');
        setPendingAction(null);
      }
    }
  };

  const executeContainerExec = async () => {
    const command = execCommand.trim();

    if (!selectedContainer || !command) {
      setError(selectedContainer ? t('container.error.execRequired', language) : t('container.error.selectContainer', language));
      return;
    }

    setExecRunning(true);
    setError('');
    setNotice('');
    setSuccess('');
    setTroubleshooting(null);
    setExecOutput('');

    try {
      const activeRuntime = await detectRuntime();
      const result = await runCommand(getContainerExecCommand(activeRuntime, selectedContainer.id, command, isWindowsHost));
      const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();

      setExecOutput(output || t('container.exec.exit', language, { code: result.code }));

      if (result.code !== 0) {
        setNotice(t('container.exec.noticeExit', language, { code: result.code }));
      } else {
        setSuccess(t('container.exec.success', language, { name: selectedContainer.name }));
      }
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      if (isMountedRef.current) {
        setExecRunning(false);
      }
    }
  };

  const refreshCurrentContainer = async () => {
    const nextSelectedContainerId = await refreshContainers({ silent: true, preferredContainerId: selectedContainerId });

    if (nextSelectedContainerId) {
      await loadContainerDetail(nextSelectedContainerId);
    }
  };

  const isContainerActionDisabled = (action: ContainerAction) => {
    if (!selectedContainer || Boolean(actingKey)) {
      return true;
    }

    if (action === 'start') {
      return selectedContainer.state === 'running';
    }

    if (action === 'stop' || action === 'restart' || action === 'kill') {
      return selectedContainer.state !== 'running' && selectedContainer.state !== 'paused';
    }

    if (action === 'pause') {
      return selectedContainer.state !== 'running';
    }

    if (action === 'unpause') {
      return selectedContainer.state !== 'paused';
    }

    return false;
  };

  const requestContainerAction = (action: ContainerAction) => {
    if (!selectedContainer) {
      return;
    }

    if (action === 'remove') {
      setPendingAction({ kind: 'container', action, container: selectedContainer });
      return;
    }

    void executeContainerAction(action, selectedContainer);
  };

  const renderContainerActionButton = (action: ContainerAction) => {
    const definition = containerActionLabels[action];
    const disabled = isContainerActionDisabled(action);
    const className = [
      'container-action-btn',
      definition.primary ? 'primary' : '',
      definition.danger ? 'danger' : '',
    ].filter(Boolean).join(' ');
    const key = selectedContainer ? `${action}:${selectedContainer.id}` : action;

    return (
      <button
        key={action}
        type="button"
        className={className}
        disabled={disabled}
        onClick={() => requestContainerAction(action)}
      >
        {actingKey === key ? t('container.ui.processing', language) : t(definition.labelId, language)}
      </button>
    );
  };

  const renderContainerListItem = (container: ContainerSummary) => {
    const isSelected = container.id === selectedContainerId;

    return (
      <button
        key={container.id}
        type="button"
        className={`container-list-item ${isSelected ? 'selected' : ''}`}
        onClick={() => {
          setSelectedContainerId(container.id);
          setDetailTab('summary');
          setExecOutput('');
        }}
      >
        <span className={`container-state-dot ${container.state}`} />
        <span className="container-list-main">
          <strong title={container.name}>{container.name}</strong>
          <small title={container.image}>{container.image}</small>
        </span>
        <span className={`container-state-tag ${container.state}`}>{getStateLabel(container.state, language)}</span>
      </button>
    );
  };

  const renderToolbarRight = () => {
    if (activeTab === 'images') {
      return (
        <>
          <input
            type="search"
            className="container-search"
            placeholder={t('container.ui.searchImages', language)}
            value={imageSearch}
            onChange={(event) => setImageSearch(event.target.value)}
          />
          <input
            type="text"
            className="container-pull-input"
            placeholder="nginx:latest"
            value={pullImageName}
            onChange={(event) => setPullImageName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                void executeImagePull();
              }
            }}
            aria-label={t('container.ui.pullImageAria', language)}
          />
          <button type="button" className="container-tool-button primary" onClick={() => void executeImagePull()} disabled={pulling}>
            {pulling ? t('container.ui.pulling', language) : 'Pull'}
          </button>
          <button type="button" className="container-tool-button danger" onClick={openImagePruneDialog} disabled={pruningImages}>
            {pruningImages ? t('container.ui.pruning', language) : t('container.ui.pruneImages', language)}
          </button>
        </>
      );
    }

    return (
      <>
        <select
          className="container-select"
          value={containerFilter}
          onChange={(event) => setContainerFilter(event.target.value as ContainerFilter)}
          aria-label={t('container.ui.filterAria', language)}
        >
          {containerFilters.map((item) => (
            <option key={item.key} value={item.key}>{t(item.labelId, language)}</option>
          ))}
        </select>
        <input
          type="search"
          className="container-search"
          placeholder={t('container.ui.searchContainers', language)}
          value={containerSearch}
          onChange={(event) => setContainerSearch(event.target.value)}
        />
      </>
    );
  };

  const renderRunWorkbench = () => createPortal(
    <div
      className="container-run-modal-overlay"
      role="presentation"
      onClick={() => {
        if (!runningContainer) {
          setRunPanelOpen(false);
        }
      }}
    >
      <section
        className="container-run-dialog container-run-workbench"
        role="dialog"
        aria-modal="true"
        aria-label={t('container.ui.runWorkbenchAria', language)}
        onClick={(event) => event.stopPropagation()}
      >
      <header className="container-workbench-header">
        <div>
          <strong>{t('container.ui.runWorkbench', language)}</strong>
          <span>{runtime ? getRuntimeLabel(runtime, language) : t('container.runtime.notDetected', language)}</span>
        </div>
        <div>
          <button type="button" className="container-tool-button" onClick={resetRunDialog}>
            {t('container.ui.reset', language)}
          </button>
          <button type="button" className="container-tool-button" onClick={() => setRunPanelOpen(false)} disabled={runningContainer}>
            {t('common.close', language)}
          </button>
        </div>
      </header>
      {runError ? <DismissibleAlert className="container-alert danger container-run-alert" onDismiss={() => setRunError('')} role="alert">{runError}</DismissibleAlert> : null}
      {runTroubleshooting ? (
        <section className="container-troubleshooting container-run-troubleshooting" aria-label={t('container.ui.troubleshootingAria', language)}>
          <div>
            <strong>{runTroubleshooting.title}</strong>
            <p>{runTroubleshooting.message}</p>
          </div>
          <div className="container-troubleshooting-actions">
            <button type="button" className="container-tool-button" onClick={() => void copyToClipboard(runTroubleshooting.commands, t('container.ui.copyFixCommandLabel', language))}>
              {t('container.ui.copyFixCommand', language)}
            </button>
            <button type="button" className="container-tool-button" onClick={() => void copyToClipboard(runTroubleshooting.rawOutput, t('container.ui.copyRawErrorLabel', language))}>
              {t('container.ui.copyRawError', language)}
            </button>
          </div>
          <pre>{runTroubleshooting.commands}</pre>
        </section>
      ) : null}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void executeRunContainer();
        }}
      >
        <div className="container-run-grid">
          <label className="wide">
            <span>{t('container.ui.image', language)}</span>
            <input
              type="text"
              value={runForm.image}
              onChange={(event) => updateRunForm('image', event.target.value)}
              placeholder="nginx:latest"
            />
          </label>
          <label>
            <span>{t('container.ui.name', language)}</span>
            <input
              type="text"
              value={runForm.name}
              onChange={(event) => updateRunForm('name', event.target.value)}
              placeholder="web-1"
            />
          </label>
          <label>
            <span>{t('container.ui.restartPolicy', language)}</span>
            <select value={runForm.restartPolicy} onChange={(event) => updateRunForm('restartPolicy', event.target.value as RestartPolicy)}>
              {restartPolicyOptions.map((option) => (
                <option key={option.value} value={option.value}>{t(option.labelId, language)}</option>
              ))}
            </select>
          </label>
          <label>
            <span>{t('container.ui.network', language)}</span>
            <select
              value={runForm.networkMode}
              onChange={(event) => {
                const nextMode = event.target.value as RunNetworkMode;
                setRunForm((currentForm) => ({
                  ...currentForm,
                  networkMode: nextMode,
                  network: nextMode === 'custom' ? currentForm.network : '',
                }));
              }}
            >
              {runNetworkModeOptions.map((option) => (
                <option key={option.value} value={option.value}>{t(option.labelId, language)}</option>
              ))}
            </select>
          </label>
          {runForm.networkMode === 'custom' ? (
            <label>
              <span>{t('container.ui.customNetwork', language)}</span>
              <input
                type="text"
                value={runForm.network}
                onChange={(event) => updateRunForm('network', event.target.value)}
                placeholder="app-net"
              />
            </label>
          ) : null}
          <label>
            <span>{t('container.ui.hostname', language)}</span>
            <input
              type="text"
              value={runForm.hostname}
              onChange={(event) => updateRunForm('hostname', event.target.value)}
              placeholder="app"
            />
          </label>
          <label>
            <span>{t('container.ui.workdir', language)}</span>
            <input
              type="text"
              value={runForm.workdir}
              onChange={(event) => updateRunForm('workdir', event.target.value)}
              placeholder="/app"
            />
          </label>
          <label>
            <span>{t('container.ui.user', language)}</span>
            <input
              type="text"
              value={runForm.user}
              onChange={(event) => updateRunForm('user', event.target.value)}
              placeholder="1000:1000"
            />
          </label>
          <label className="stack">
            <span>{t('container.ui.portMappings', language)}</span>
            <textarea
              value={runForm.ports}
              onChange={(event) => updateRunForm('ports', event.target.value)}
              placeholder="8080:80"
              rows={3}
            />
          </label>
          <label className="stack">
            <span>{t('container.ui.volumeMappings', language)}</span>
            <textarea
              value={runForm.volumes}
              onChange={(event) => updateRunForm('volumes', event.target.value)}
              placeholder="/host/data:/data"
              rows={3}
            />
          </label>
          <label className="stack">
            <span>{t('container.ui.environment', language)}</span>
            <textarea
              value={runForm.environment}
              onChange={(event) => updateRunForm('environment', event.target.value)}
              placeholder="NODE_ENV=production"
              rows={3}
            />
          </label>
          <label className="wide">
            <span>{t('container.ui.command', language)}</span>
            <input
              type="text"
              value={runForm.command}
              onChange={(event) => updateRunForm('command', event.target.value)}
              placeholder={'sh -c "npm start"'}
            />
          </label>
          <label className="wide">
            <span>{t('container.ui.extraArgs', language)}</span>
            <input
              type="text"
              value={runForm.extraArgs}
              onChange={(event) => updateRunForm('extraArgs', event.target.value)}
              placeholder="--add-host app.local:127.0.0.1"
            />
          </label>
        </div>
        <div className="container-run-options">
          <label>
            <input
              type="checkbox"
              checked={runForm.createOnly}
              onChange={(event) => updateRunForm('createOnly', event.target.checked)}
            />
            <span>{t('container.ui.createOnly', language)}</span>
          </label>
          <label>
            <input
              type="checkbox"
              checked={!runForm.createOnly && runForm.removeWhenStopped}
              disabled={runForm.createOnly}
              onChange={(event) => updateRunForm('removeWhenStopped', event.target.checked)}
            />
            <span>{t('container.ui.removeWhenStopped', language)}</span>
          </label>
        </div>
        {runCommandPreview ? (
          <div className="container-command-preview">
            <header>
              <span>{t('container.ui.commandPreview', language)}</span>
              <button type="button" className="container-copy-btn" onClick={() => void copyToClipboard(runCommandPreview, t('container.ui.commandPreview', language))}>
                {t('container.ui.copy', language)}
              </button>
            </header>
            <pre>{runCommandPreview}</pre>
          </div>
        ) : null}
        <div className="container-workbench-actions">
          <button type="submit" className="container-action-btn primary" disabled={runningContainer}>
            {runningContainer ? t('container.ui.processing', language) : t(runForm.createOnly ? 'container.ui.createContainer' : 'container.ui.runContainer', language)}
          </button>
        </div>
      </form>
      </section>
    </div>,
    document.body,
  );

  const renderImagePruneDialog = () => createPortal(
    <div
      className="container-modal-overlay"
      role="presentation"
      onClick={() => {
        if (!pruningImages) {
          setImagePruneDialogOpen(false);
        }
      }}
    >
      <div
        className="container-modal container-prune-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="container-image-prune-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div id="container-image-prune-title" className="container-modal-title">
          {t('container.modal.pruneImages', language)}
        </div>
        <div className="container-modal-message">
          <p>{t('container.modal.pruneImagesDescription', language)}</p>
        </div>
        {imagePruneError ? (
          <DismissibleAlert className="container-alert danger container-prune-alert" onDismiss={() => setImagePruneError('')} role="alert">
            {imagePruneError}
          </DismissibleAlert>
        ) : null}
        <div className="container-prune-options" role="radiogroup" aria-label={t('container.modal.pruneImages', language)}>
          {imagePruneOptions.map((option) => (
            <label key={option.value} className={`container-prune-option ${imagePruneMode === option.value ? 'selected' : ''}`}>
              <input
                type="radio"
                name="container-image-prune-mode"
                value={option.value}
                checked={imagePruneMode === option.value}
                disabled={pruningImages}
                onChange={() => {
                  setImagePruneError('');
                  setImagePruneMode(option.value);
                }}
              />
              <span>
                <strong>{t(option.labelId, language)}</strong>
                <small>{t(option.descriptionId, language)}</small>
              </span>
            </label>
          ))}
        </div>
        <div className="container-command-preview container-prune-preview">
          <header>
            <span>{t('container.ui.commandPreview', language)}</span>
            <button type="button" className="container-copy-btn" onClick={() => void copyToClipboard(imagePruneCommandPreview, t('container.ui.commandPreview', language))}>
              {t('container.ui.copy', language)}
            </button>
          </header>
          <pre>{imagePruneCommandPreview}</pre>
        </div>
        <div className="container-modal-actions">
          <button type="button" className="container-modal-btn" onClick={() => setImagePruneDialogOpen(false)} disabled={pruningImages}>{t('common.cancel', language)}</button>
          <button type="button" className="container-modal-btn danger" onClick={() => void executeImagePrune()} disabled={pruningImages}>
            {pruningImages ? t('container.ui.pruning', language) : t('container.modal.confirmPrune', language)}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );

  const renderContainerConfig = () => {
    if (!selectedDetail) {
      return <div className="container-empty">{detailLoading ? t('container.ui.loadingDetail', language) : t('container.ui.noDetail', language)}</div>;
    }

    const configItems = [
      { label: t('container.ui.restartPolicy', language), value: selectedDetail.config.restartPolicyText },
      { label: t('container.ui.network', language), value: selectedDetail.config.networkMode },
      { label: t('container.ui.privileged', language), value: selectedDetail.config.privileged },
      { label: t('container.ui.hostname', language), value: selectedDetail.config.hostname },
      { label: t('container.ui.user', language), value: selectedDetail.config.user },
      { label: t('container.ui.workdir', language), value: selectedDetail.config.workingDir },
      { label: t('container.ui.entrypoint', language), value: selectedDetail.config.entrypoint },
      { label: t('container.ui.command', language), value: selectedDetail.config.command },
    ];

    return (
      <div className="container-config-workbench">
        <section className="container-config-current">
          <header>
            <strong>{t('container.ui.currentConfig', language)}</strong>
            <button type="button" className="container-copy-btn" onClick={() => void copyToClipboard(selectedDetail.inspectText, 'inspect')}>
              {t('container.ui.copyInspect', language)}
            </button>
          </header>
          <div className="container-config-grid">
            {configItems.map((item) => (
              <div key={item.label}>
                <span>{item.label}</span>
                <strong title={item.value}>{item.value || '-'}</strong>
              </div>
            ))}
          </div>
          <div className="container-config-lists">
            <section>
              <header>
                <strong>{t('container.ui.resourceLimits', language)}</strong>
                <span>{selectedDetail.config.resources.length}</span>
              </header>
              <div className="container-chip-list">
                {selectedDetail.config.resources.length ? selectedDetail.config.resources.map((item) => <code key={`${item.label}:${item.value}`}>{item.label}: {item.value}</code>) : <span>{t('container.ui.noResourceLimits', language)}</span>}
              </div>
            </section>
            <section>
              <header>
                <strong>Labels</strong>
                <span>{selectedDetail.config.labels.length}</span>
              </header>
              <div className="container-chip-list">
                {selectedDetail.config.labels.length ? selectedDetail.config.labels.slice(0, 18).map((label) => <code key={label}>{label}</code>) : <span>{t('container.ui.noLabels', language)}</span>}
                {selectedDetail.config.labels.length > 18 ? <span>{t('container.ui.moreItems', language, { count: selectedDetail.config.labels.length - 18 })}</span> : null}
              </div>
            </section>
          </div>
        </section>
        <form
          className="container-config-form"
          onSubmit={(event) => {
            event.preventDefault();
            void executeConfigUpdate();
          }}
        >
          <header>
            <strong>{t('container.ui.dynamicConfig', language)}</strong>
            <span>{t('container.ui.dynamicConfigHint', language)}</span>
          </header>
          <div className="container-config-fields">
            <label>
              <span>{t('container.ui.name', language)}</span>
              <input type="text" value={configForm.name} onChange={(event) => updateConfigForm('name', event.target.value)} />
            </label>
            <label>
              <span>{t('container.ui.restartPolicy', language)}</span>
              <select value={configForm.restartPolicy} onChange={(event) => updateConfigForm('restartPolicy', event.target.value as RestartPolicy)}>
                {restartPolicyOptions.map((option) => (
                  <option key={option.value} value={option.value}>{t(option.labelId, language)}</option>
                ))}
              </select>
            </label>
            <label>
              <span>CPU</span>
              <input type="text" value={configForm.cpuLimit} onChange={(event) => updateConfigForm('cpuLimit', event.target.value)} placeholder="0.50" />
            </label>
            <label>
              <span>{t('container.ui.memory', language)}</span>
              <input type="text" value={configForm.memoryLimit} onChange={(event) => updateConfigForm('memoryLimit', event.target.value)} placeholder="512m" />
            </label>
          </div>
          <div className="container-inline-warning">{t('container.ui.recreateHint', language)}</div>
          <div className="container-workbench-actions">
            <button type="submit" className="container-action-btn primary" disabled={savingConfig}>
              {savingConfig ? t('container.ui.processing', language) : t('container.ui.saveConfig', language)}
            </button>
          </div>
        </form>
      </div>
    );
  };

  const renderDetailSummary = () => (
    <>
      <div className="container-overview">
        <div>
          <span>CPU</span>
          <strong>{selectedDetail?.stats?.cpu || '-'}</strong>
          <small>{selectedDetail?.stats?.error ? t('container.ui.statsUnavailable', language) : 'no-stream'}</small>
        </div>
        <div>
          <span>{t('container.ui.memory', language)}</span>
          <strong>{selectedDetail?.stats?.memory || '-'}</strong>
          <small>{selectedDetail?.stats?.memoryPercent || '-'}</small>
        </div>
        <div>
          <span>{t('container.ui.networkIo', language)}</span>
          <strong>{selectedDetail?.stats?.netIO || '-'}</strong>
          <small>Block {selectedDetail?.stats?.blockIO || '-'}</small>
        </div>
        <div>
          <span>PIDs</span>
          <strong>{selectedDetail?.stats?.pids || '-'}</strong>
          <small>{selectedDetail?.createdAt || selectedContainer?.createdAt || '-'}</small>
        </div>
      </div>

      {selectedDetail?.stats?.error ? <div className="container-inline-warning">{selectedDetail.stats.error}</div> : null}
      {selectedDetail?.inspectError ? <div className="container-inline-warning">{selectedDetail.inspectError}</div> : null}

      <div className="container-summary-sections">
        <section>
          <header>
            <strong>{t('container.ui.ports', language)}</strong>
            <span>{selectedDetail?.ports.length ?? 0}</span>
          </header>
          <div className="container-chip-list">
            {selectedDetail?.ports.length ? selectedDetail.ports.map((port) => <code key={port}>{port}</code>) : <span>{t('container.diagnostics.noPorts', language)}</span>}
          </div>
        </section>
        <section>
          <header>
            <strong>{t('container.ui.mounts', language)}</strong>
            <span>{selectedDetail?.mounts.length ?? 0}</span>
          </header>
          <div className="container-chip-list">
            {selectedDetail?.mounts.length ? selectedDetail.mounts.map((mount) => <code key={mount}>{mount}</code>) : <span>{t('container.diagnostics.noMounts', language)}</span>}
          </div>
        </section>
        <section>
          <header>
            <strong>{t('container.ui.env', language)}</strong>
            <span>{selectedDetail?.env.length ?? 0}</span>
          </header>
          <div className="container-chip-list">
            {selectedDetail?.env.length ? selectedDetail.env.slice(0, 24).map((item) => <code key={item}>{item}</code>) : <span>{t('container.ui.noEnv', language)}</span>}
            {selectedDetail && selectedDetail.env.length > 24 ? <span>{t('container.ui.moreItems', language, { count: selectedDetail.env.length - 24 })}</span> : null}
          </div>
        </section>
      </div>
    </>
  );

  return (
    <div className="container-manager">
      <div className="container-toolbar">
        <div className="container-toolbar-left">
          <button
            type="button"
            className="container-tool-button primary"
            onClick={() => activeTab === 'images' ? void refreshImages() : void refreshContainers()}
            disabled={runtimeLoading || containersLoading || imagesLoading}
          >
            {runtimeLoading || containersLoading || imagesLoading ? t('container.ui.refreshing', language) : t('container.ui.refresh', language)}
          </button>
          <button type="button" className="container-tool-button" onClick={() => void refreshCurrentContainer()} disabled={!selectedContainer || detailLoading}>
            {detailLoading ? t('container.ui.reading', language) : t('container.ui.refreshCurrent', language)}
          </button>
          <button type="button" className="container-tool-button primary" onClick={openRunDialog}>
            {t('container.ui.newContainer', language)}
          </button>
          <span className="container-runtime-pill">{getRuntimeLabel(runtime, language)}</span>
          <span className="container-summary">
            <strong>{activeTab === 'images' ? visibleImages.length : visibleContainers.length}</strong> / {activeTab === 'images' ? images.length : containers.length}
          </span>
        </div>

        <div className="container-tabs" role="tablist" aria-label={t('container.ui.tabsAria', language)}>
          {managerTabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              className={activeTab === tab.key ? 'active' : ''}
              title={t(tab.labelId, language)}
              onClick={() => setActiveTab(tab.key)}
            >
              {t(tab.labelId, language)}
            </button>
          ))}
        </div>

        <div className="container-toolbar-right">
          {renderToolbarRight()}
        </div>
      </div>

      {error ? <DismissibleAlert className="container-alert danger" onDismiss={() => setError('')} role="alert">{error}</DismissibleAlert> : null}
      {notice ? <DismissibleAlert className="container-alert info" onDismiss={() => setNotice('')}>{notice}</DismissibleAlert> : null}
      {success ? <DismissibleAlert className="container-alert success" onDismiss={() => setSuccess('')}>{success}</DismissibleAlert> : null}
      {troubleshooting ? (
        <section className="container-troubleshooting" aria-label={t('container.ui.troubleshootingAria', language)}>
          <div>
            <strong>{troubleshooting.title}</strong>
            <p>{troubleshooting.message}</p>
          </div>
          <div className="container-troubleshooting-actions">
            <button type="button" className="container-tool-button" onClick={() => void copyToClipboard(troubleshooting.commands, t('container.ui.copyFixCommandLabel', language))}>
              {t('container.ui.copyFixCommand', language)}
            </button>
            <button type="button" className="container-tool-button" onClick={() => void copyToClipboard(troubleshooting.rawOutput, t('container.ui.copyRawErrorLabel', language))}>
              {t('container.ui.copyRawError', language)}
            </button>
          </div>
          <pre>{troubleshooting.commands}</pre>
        </section>
      ) : null}
      {activeTab === 'containers' && runPanelOpen ? renderRunWorkbench() : null}

      {activeTab === 'containers' ? (
        <div className="container-content">
          <aside className="container-list-panel" aria-label={t('container.ui.containerListAria', language)}>
            <div className="container-stats">
              <span><strong>{containerStats.running}</strong> {t('container.ui.runningCount', language)}</span>
              <span><strong>{containerStats.exited}</strong> {t('container.ui.exitedCount', language)}</span>
              <span><strong>{containerStats.paused}</strong> {t('container.ui.pausedCount', language)}</span>
              <span><strong>{containerStats.created}</strong> {t('container.ui.createdCount', language)}</span>
            </div>

            <div className="container-list">
              {visibleContainers.length === 0 ? (
                <div className="container-empty">{containersLoading ? t('container.ui.loadingContainers', language) : t('container.ui.noContainers', language)}</div>
              ) : (
                visibleContainers.map(renderContainerListItem)
              )}
            </div>
          </aside>

          <section className="container-detail-panel" aria-label={t('container.ui.detailAria', language)}>
            {selectedContainer ? (
              <>
                <header className="container-detail-header">
                  <div>
                    <span>{t('container.ui.container', language)}</span>
                    <strong title={selectedContainer.name}>{selectedDetail?.name || selectedContainer.name}</strong>
                    <code title={selectedContainer.id}>{formatShortId(selectedContainer.id)}</code>
                    <p title={selectedDetail?.image || selectedContainer.image}>{selectedDetail?.image || selectedContainer.image}</p>
                  </div>
                  <button
                    type="button"
                    className="container-copy-btn"
                    disabled={!selectedDetail}
                    onClick={() => selectedDetail ? void copyToClipboard(buildContainerDiagnostics(selectedDetail, language), t('container.ui.diagnosticsLabel', language)) : undefined}
                  >
                    {t('container.ui.copyDiagnostics', language)}
                  </button>
                </header>

                <div className="container-status-row">
                  <span className={`container-state-tag ${selectedDetail?.state || selectedContainer.state}`}>
                    {getStateLabel(selectedDetail?.state || selectedContainer.state, language)}
                  </span>
                  <strong title={selectedDetail?.status || selectedContainer.status}>{selectedDetail?.status || selectedContainer.status}</strong>
                  <small title={selectedContainer.ports}>{selectedContainer.ports}</small>
                </div>

                <div className="container-action-bar" aria-label={t('container.ui.actionsAria', language)}>
                  {(['start', 'stop', 'restart', 'pause', 'unpause', 'kill', 'remove'] as ContainerAction[]).map(renderContainerActionButton)}
                  <button type="button" className="container-action-btn" onClick={() => { setDetailTab('logs'); void loadContainerDetail(selectedContainer.id); }}>
                    {t('container.ui.viewLogs', language)}
                  </button>
                  <button type="button" className="container-action-btn" onClick={() => setDetailTab('exec')}>
                    Exec
                  </button>
                </div>

                <div className="container-detail-tabs" role="tablist" aria-label={t('container.ui.detailTabsAria', language)}>
                  <button type="button" role="tab" className={detailTab === 'summary' ? 'active' : ''} onClick={() => setDetailTab('summary')}>{t('container.ui.summary', language)}</button>
                  <button type="button" role="tab" className={detailTab === 'config' ? 'active' : ''} onClick={() => setDetailTab('config')}>{t('container.ui.config', language)}</button>
                  <button type="button" role="tab" className={detailTab === 'logs' ? 'active' : ''} onClick={() => setDetailTab('logs')}>{t('container.ui.logs', language)}</button>
                  <button type="button" role="tab" className={detailTab === 'inspect' ? 'active' : ''} onClick={() => setDetailTab('inspect')}>Inspect</button>
                  <button type="button" role="tab" className={detailTab === 'exec' ? 'active' : ''} onClick={() => setDetailTab('exec')}>Exec</button>
                </div>

                <div className="container-detail-body">
                  {detailLoading && !selectedDetail ? <div className="container-empty">{t('container.ui.loadingDetail', language)}</div> : null}
                  {selectedDetail || !detailLoading ? (
                    <>
                      {detailTab === 'summary' ? renderDetailSummary() : null}
                      {detailTab === 'config' ? renderContainerConfig() : null}
                      {detailTab === 'logs' ? (
                        <pre>{selectedDetail?.logs || t('container.ui.noRecentLogs', language)}</pre>
                      ) : null}
                      {detailTab === 'inspect' ? (
                        <pre>{selectedDetail?.inspectText || t('container.ui.noInspect', language)}</pre>
                      ) : null}
                      {detailTab === 'exec' ? (
                        <div className="container-exec-panel">
                          <form
                            onSubmit={(event) => {
                              event.preventDefault();
                              void executeContainerExec();
                            }}
                          >
                            <input
                              type="text"
                              value={execCommand}
                              onChange={(event) => setExecCommand(event.target.value)}
                              placeholder={t('container.ui.execPlaceholder', language)}
                              aria-label={t('container.ui.execAria', language)}
                            />
                            <button type="submit" className="container-action-btn primary" disabled={execRunning || selectedContainer.state !== 'running'}>
                              {execRunning ? t('container.ui.execRunning', language) : t('container.ui.run', language)}
                            </button>
                          </form>
                          <pre>{execOutput || (selectedContainer.state !== 'running' ? t('container.ui.execNotRunning', language) : t('container.ui.execPrompt', language))}</pre>
                        </div>
                      ) : null}
                    </>
                  ) : null}
                </div>
              </>
            ) : (
              <div className="container-detail-empty">
                <strong>{containersLoading ? t('container.ui.loadingContainer', language) : t('container.ui.noContainerSelected', language)}</strong>
                <span>{containersLoading ? t('container.ui.waitRuntime', language) : t('container.ui.noDetail', language)}</span>
              </div>
            )}
          </section>
        </div>
      ) : null}

      {activeTab === 'images' ? (
        <div className="container-images-panel" aria-label={t('container.ui.imageListAria', language)}>
          <div className="container-image-table-wrap">
            <table className="container-image-table">
              <thead>
                <tr>
                  <th className="container-image-repo">{t('container.ui.repository', language)}</th>
                  <th className="container-image-tag">{t('container.ui.tag', language)}</th>
                  <th className="container-image-id">ID</th>
                  <th className="container-image-size">{t('container.ui.size', language)}</th>
                  <th className="container-image-created">{t('container.ui.createdAt', language)}</th>
                  <th className="container-image-actions">{t('container.ui.operations', language)}</th>
                </tr>
              </thead>
              <tbody>
                {visibleImages.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="container-table-empty">
                      {imagesLoading ? t('container.ui.loadingImages', language) : t('container.ui.noImages', language)}
                    </td>
                  </tr>
                ) : (
                  visibleImages.map((image) => (
                    <tr key={`${image.id}:${image.repository}:${image.tag}`}>
                      <td title={image.repository}>{image.repository}</td>
                      <td title={image.tag}>{image.tag}</td>
                      <td title={image.id}><code>{formatShortId(image.id)}</code></td>
                      <td>{image.size}</td>
                      <td title={image.createdAt}>{image.createdAt || '-'}</td>
                      <td>
                        <div className="container-image-actions-cell">
                          <button
                            type="button"
                            className="container-table-action"
                            onClick={() => prepareRunFromImage(image)}
                          >
                            {t('container.ui.run', language)}
                          </button>
                        <button
                          type="button"
                          className="container-table-danger"
                          disabled={Boolean(actingKey)}
                          onClick={() => setPendingAction({ kind: 'image', action: 'remove', image })}
                        >
                          {actingKey === `image-remove:${image.id}` ? t('container.ui.removing', language) : t('container.action.remove', language)}
                        </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {imagePruneDialogOpen ? renderImagePruneDialog() : null}

      {pendingAction ? createPortal(
        <div className="container-modal-overlay" role="presentation" onClick={() => setPendingAction(null)}>
          <div
            className="container-modal"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="container-action-confirm-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div id="container-action-confirm-title" className="container-modal-title">
              {pendingAction.kind === 'container' ? t('container.modal.removeContainer', language) : t('container.modal.removeImage', language)}
            </div>
            <div className="container-modal-message">
              {pendingAction.kind === 'container' ? (
                <>
                  <p>{t('container.modal.targetContainer', language)}<strong>{pendingAction.container.name}</strong></p>
                  <p>{t('container.modal.containerDeleteWarning', language)}</p>
                  <code>{pendingAction.container.id}</code>
                </>
              ) : (
                <>
                  <p>{t('container.modal.targetImage', language)}<strong>{getImageReference(pendingAction.image)}</strong></p>
                  <p>{t('container.modal.imageDeleteWarning', language)}</p>
                  <code>{pendingAction.image.id}</code>
                </>
              )}
            </div>
            <div className="container-modal-actions">
              <button type="button" className="container-modal-btn" onClick={() => setPendingAction(null)}>{t('common.cancel', language)}</button>
              <button
                type="button"
                className="container-modal-btn danger"
                onClick={() => {
                  if (pendingAction.kind === 'container') {
                    void executeContainerAction(pendingAction.action, pendingAction.container);
                    return;
                  }

                  void executeImageRemove(pendingAction.image);
                }}
              >
                {t('container.modal.confirmRemove', language)}
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

export default RemoteContainerManager;

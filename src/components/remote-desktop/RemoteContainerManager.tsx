import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { getErrorMessage, getShellDeskLocale } from './desktopUtils';
import { isWindowsSystem, powershellCommand, powershellSingleQuote } from './remoteSystem';
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
  inspectError?: string;
}

interface ContainerTroubleshooting {
  title: string;
  message: string;
  commands: string;
  rawOutput: string;
}

type ManagerTab = 'containers' | 'images';
type ContainerFilter = 'all' | ContainerState;
type DetailTab = 'summary' | 'logs' | 'inspect' | 'exec';
type ContainerAction = 'start' | 'stop' | 'restart' | 'remove';

type PendingAction =
  | { kind: 'container'; action: 'remove'; container: ContainerSummary }
  | { kind: 'image'; action: 'remove'; image: ImageSummary };

const CONTAINER_INSPECT_MARKER = '__SHELLDESK_CONTAINER_INSPECT__';
const CONTAINER_STATS_MARKER = '__SHELLDESK_CONTAINER_STATS__';
const CONTAINER_LOGS_MARKER = '__SHELLDESK_CONTAINER_LOGS__';

const managerTabs: Array<{ key: ManagerTab; label: string }> = [
  { key: 'containers', label: '容器' },
  { key: 'images', label: '镜像' },
];

const containerFilters: Array<{ key: ContainerFilter; label: string }> = [
  { key: 'all', label: '全部状态' },
  { key: 'running', label: '运行中' },
  { key: 'exited', label: '已停止' },
  { key: 'paused', label: '已暂停' },
  { key: 'created', label: '已创建' },
  { key: 'unknown', label: '未知' },
];

const containerActionLabels: Record<ContainerAction, { label: string; success: string; danger?: boolean; primary?: boolean }> = {
  start: { label: '启动', success: '已启动', primary: true },
  stop: { label: '停止', success: '已停止', danger: true },
  restart: { label: '重启', success: '已重启' },
  remove: { label: '删除', success: '已删除', danger: true },
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

function getStateLabel(state: ContainerState) {
  if (state === 'running') return '运行中';
  if (state === 'exited') return '已停止';
  if (state === 'paused') return '已暂停';
  if (state === 'created') return '已创建';
  return '未知';
}

function getRuntimeLabel(runtime: ContainerRuntime | null) {
  if (runtime === 'docker') return 'Docker';
  if (runtime === 'podman') return 'Podman';
  return '未检测';
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

function extractPorts(inspectRecord: Record<string, unknown> | undefined, fallbackPorts: string) {
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

    return [`${containerPort} -> 未发布`];
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

function parseContainerDetailOutput(stdout: string, fallback: ContainerSummary): ContainerDetail {
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
    ports: extractPorts(inspectRecord, fallback.ports),
    mounts: extractMounts(inspectRecord),
    env: extractEnv(inspectRecord),
    logs: sections.logs,
    inspectText: sections.inspect,
    statsText: sections.stats,
    stats: parseContainerStats(sections.stats),
    inspectError: inspectError || undefined,
  };
}

function getDetectRuntimeCommand(isWindowsHost: boolean) {
  if (isWindowsHost) {
    return powershellCommand(`
$docker = Get-Command docker -ErrorAction SilentlyContinue | Select-Object -First 1
if ($docker) { "docker"; exit 0 }
$podman = Get-Command podman -ErrorAction SilentlyContinue | Select-Object -First 1
if ($podman) { "podman"; exit 0 }
Write-Error "未检测到 Docker 或 Podman CLI。"
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
printf '未检测到 Docker 或 Podman CLI。\\n' >&2
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

function buildContainerDiagnostics(detail: ContainerDetail) {
  return [
    `容器：${detail.name}`,
    `ID：${detail.id}`,
    `镜像：${detail.image}`,
    `状态：${getStateLabel(detail.state)} / ${detail.status || '-'}`,
    `创建：${detail.createdAt || '-'}`,
    `CPU：${detail.stats?.cpu || '-'}`,
    `内存：${detail.stats?.memory || '-'} (${detail.stats?.memoryPercent || '-'})`,
    '',
    '--- ports ---',
    detail.ports.join('\n') || '无端口映射',
    '',
    '--- mounts ---',
    detail.mounts.join('\n') || '无挂载',
    '',
    '--- logs ---',
    detail.logs || '无最近日志',
  ].join('\n');
}

function buildDockerRestartCommand(containerId: string) {
  const target = shellSingleQuote(containerId);

  return [
    '# 会重启 Docker daemon，请先确认这台主机上的运行中容器可短暂中断。',
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
    `docker start ${target}`,
  ].join('\n');
}

function createContainerTroubleshooting(
  output: string,
  runtime: ContainerRuntime,
  action: ContainerAction,
  container: ContainerSummary,
): ContainerTroubleshooting | null {
  if (
    runtime !== 'docker' ||
    (action !== 'start' && action !== 'restart') ||
    !/iptables/i.test(output) ||
    !/\bDOCKER\b/.test(output) ||
    !/No chain\/target\/match by that name/i.test(output)
  ) {
    return null;
  }

  return {
    title: 'Docker NAT 规则链缺失',
    message: [
      'Docker 在发布端口时找不到 iptables nat 表里的 DOCKER 链。',
      '这通常发生在 firewalld、iptables 或 nftables 规则被 reload/flush 后，Docker daemon 还没重建自己的链。',
      '一般处理方式是重启 Docker daemon，然后重新启动该容器。',
    ].join(' '),
    commands: buildDockerRestartCommand(container.id),
    rawOutput: output,
  };
}

function RemoteContainerManager({ connectionId, systemType }: RemoteContainerManagerProps) {
  const isWindowsHost = isWindowsSystem(systemType);
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
  const [execCommand, setExecCommand] = useState('id && uname -a');
  const [execOutput, setExecOutput] = useState('');
  const [runtimeLoading, setRuntimeLoading] = useState(false);
  const [containersLoading, setContainersLoading] = useState(false);
  const [imagesLoading, setImagesLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [actingKey, setActingKey] = useState('');
  const [pulling, setPulling] = useState(false);
  const [execRunning, setExecRunning] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [success, setSuccess] = useState('');
  const [troubleshooting, setTroubleshooting] = useState<ContainerTroubleshooting | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);

  const setRuntimeValue = useCallback((value: ContainerRuntime | null) => {
    runtimeRef.current = value;
    setRuntimeState(value);
  }, []);

  useEffect(() => {
    selectedContainerIdRef.current = selectedContainerId;
  }, [selectedContainerId]);

  const detectRuntime = useCallback(async () => {
    if (runtimeRef.current) {
      return runtimeRef.current;
    }

    setRuntimeLoading(true);
    setError('');
    setNotice('');
    setTroubleshooting(null);

    try {
      const result = await runCmd(connectionId, getDetectRuntimeCommand(isWindowsHost));
      const detectedRuntime = (result.stdout || '').split(/\r?\n/).map((line) => line.trim()).find((line) => line === 'docker' || line === 'podman') as ContainerRuntime | undefined;

      if (!detectedRuntime) {
        throw new Error(result.stderr || result.stdout || '未检测到 Docker 或 Podman CLI。');
      }

      if (isMountedRef.current) {
        setRuntimeValue(detectedRuntime);
      }

      return detectedRuntime;
    } catch (err) {
      if (isMountedRef.current) {
        setRuntimeValue(null);
        setError(getErrorMessage(err));
      }

      throw err;
    } finally {
      if (isMountedRef.current) {
        setRuntimeLoading(false);
      }
    }
  }, [connectionId, isWindowsHost, setRuntimeValue]);

  const refreshContainers = useCallback(async (options?: { runtimeOverride?: ContainerRuntime; silent?: boolean; preferredContainerId?: string }) => {
    if (!options?.silent) {
      setContainersLoading(true);
    }

    setError('');
    setNotice('');
    setTroubleshooting(null);

    try {
      const activeRuntime = options?.runtimeOverride ?? await detectRuntime();
      const result = await runCmd(connectionId, getContainerListCommand(activeRuntime, isWindowsHost));
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
        throw new Error(result.stderr || result.stdout || '无法读取容器列表，可能 Docker daemon 未运行或当前用户权限不足。');
      }

      if (!isMountedRef.current) {
        return selectedContainerIdRef.current;
      }

      setContainers(nextContainers);

      if (result.code !== 0) {
        setNotice(result.stderr || '命令返回非零状态，但仍解析到了容器列表。');
      }

      const preferredContainerId = options?.preferredContainerId ?? selectedContainerIdRef.current;
      const nextSelectedContainerId = preferredContainerId && nextContainers.some((container) => container.id === preferredContainerId)
        ? preferredContainerId
        : nextContainers[0]?.id ?? '';

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
  }, [connectionId, detectRuntime, isWindowsHost]);

  const refreshImages = useCallback(async (options?: { runtimeOverride?: ContainerRuntime; silent?: boolean }) => {
    if (!options?.silent) {
      setImagesLoading(true);
    }

    setError('');
    setNotice('');
    setTroubleshooting(null);

    try {
      const activeRuntime = options?.runtimeOverride ?? await detectRuntime();
      const result = await runCmd(connectionId, getImageListCommand(activeRuntime, isWindowsHost));
      const nextImages = parseJsonLines(result.stdout || '')
        .map(parseImageSummary)
        .filter((image): image is ImageSummary => Boolean(image))
        .sort((first, second) => getImageReference(first).localeCompare(getImageReference(second), getShellDeskLocale()));

      if (result.code !== 0 && nextImages.length === 0) {
        throw new Error(result.stderr || result.stdout || '无法读取镜像列表。');
      }

      if (!isMountedRef.current) {
        return;
      }

      setImages(nextImages);

      if (result.code !== 0) {
        setNotice(result.stderr || '命令返回非零状态，但仍解析到了镜像列表。');
      }
    } catch (err) {
      if (isMountedRef.current) {
        setError(getErrorMessage(err));
      }
    } finally {
      if (isMountedRef.current && !options?.silent) {
        setImagesLoading(false);
      }
    }
  }, [connectionId, detectRuntime, isWindowsHost]);

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
      const result = await runCmd(connectionId, getContainerDetailCommand(activeRuntime, containerId, isWindowsHost));
      const nextDetail = parseContainerDetailOutput(result.stdout || '', fallback);

      if (result.code !== 0 && !nextDetail.inspectText) {
        throw new Error(result.stderr || result.stdout || '无法读取容器详情。');
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
  }, [connectionId, containers, detectRuntime, isWindowsHost]);

  useEffect(() => {
    isMountedRef.current = true;
    setRuntimeValue(null);
    setContainers([]);
    setImages([]);
    setDetail(null);
    setSelectedContainerId('');
    setExecOutput('');
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
    if (activeTab === 'images' && images.length === 0 && !imagesLoading) {
      void refreshImages();
    }
  }, [activeTab, images.length, imagesLoading, refreshImages]);

  const selectedContainer = useMemo(
    () => containers.find((container) => container.id === selectedContainerId) ?? null,
    [containers, selectedContainerId],
  );

  const selectedDetail = detail?.id === selectedContainerId ? detail : null;

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
      setSuccess(`已复制${label}。`);
    } catch (err) {
      setError(`复制失败：${getErrorMessage(err)}`);
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
      const result = await runCmd(connectionId, getContainerActionCommand(activeRuntime, action, container.id, isWindowsHost));

      if (result.code !== 0) {
        const output = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
        const nextTroubleshooting = createContainerTroubleshooting(output, activeRuntime, action, container);

        if (nextTroubleshooting) {
          setTroubleshooting(nextTroubleshooting);
          throw new Error('容器启动失败：Docker 网络规则异常，已生成诊断与修复命令。');
        }

        throw new Error(output || '容器操作失败，可能需要更高权限。');
      }

      setSuccess(`${containerActionLabels[action].success}：${container.name}`);
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
      setError('请输入镜像名，例如 nginx:latest。');
      return;
    }

    setPulling(true);
    setError('');
    setNotice('');
    setSuccess('');
    setTroubleshooting(null);

    try {
      const activeRuntime = await detectRuntime();
      const result = await runCmd(connectionId, getImagePullCommand(activeRuntime, imageName, isWindowsHost));

      if (result.code !== 0) {
        throw new Error(result.stderr || result.stdout || '拉取镜像失败。');
      }

      setSuccess(`已拉取镜像：${imageName}`);
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

  const executeImageRemove = async (image: ImageSummary) => {
    const imageRef = getImageReference(image);
    setActingKey(`image-remove:${image.id}`);
    setError('');
    setNotice('');
    setSuccess('');
    setTroubleshooting(null);

    try {
      const activeRuntime = await detectRuntime();
      const result = await runCmd(connectionId, getImageRemoveCommand(activeRuntime, imageRef, isWindowsHost));

      if (result.code !== 0) {
        throw new Error(result.stderr || result.stdout || '删除镜像失败，可能仍有容器引用该镜像。');
      }

      setSuccess(`已删除镜像：${imageRef}`);
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
      setError(selectedContainer ? '请输入要执行的命令。' : '请先选择一个容器。');
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
      const result = await runCmd(connectionId, getContainerExecCommand(activeRuntime, selectedContainer.id, command, isWindowsHost));
      const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();

      setExecOutput(output || `命令已结束，退出码 ${result.code}。`);

      if (result.code !== 0) {
        setNotice(`命令返回退出码 ${result.code}。`);
      } else {
        setSuccess(`命令执行完成：${selectedContainer.name}`);
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

    if (action === 'stop' || action === 'restart') {
      return selectedContainer.state !== 'running';
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
        {actingKey === key ? '处理中' : definition.label}
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
        <span className={`container-state-tag ${container.state}`}>{getStateLabel(container.state)}</span>
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
            placeholder="搜索镜像..."
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
            aria-label="拉取镜像名"
          />
          <button type="button" className="container-tool-button primary" onClick={() => void executeImagePull()} disabled={pulling}>
            {pulling ? '拉取中' : 'Pull'}
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
          aria-label="按容器状态筛选"
        >
          {containerFilters.map((item) => (
            <option key={item.key} value={item.key}>{item.label}</option>
          ))}
        </select>
        <input
          type="search"
          className="container-search"
          placeholder="搜索容器、镜像、端口..."
          value={containerSearch}
          onChange={(event) => setContainerSearch(event.target.value)}
        />
      </>
    );
  };

  const renderDetailSummary = () => (
    <>
      <div className="container-overview">
        <div>
          <span>CPU</span>
          <strong>{selectedDetail?.stats?.cpu || '-'}</strong>
          <small>{selectedDetail?.stats?.error ? 'stats 不可用' : 'no-stream'}</small>
        </div>
        <div>
          <span>内存</span>
          <strong>{selectedDetail?.stats?.memory || '-'}</strong>
          <small>{selectedDetail?.stats?.memoryPercent || '-'}</small>
        </div>
        <div>
          <span>网络 IO</span>
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
            <strong>端口映射</strong>
            <span>{selectedDetail?.ports.length ?? 0}</span>
          </header>
          <div className="container-chip-list">
            {selectedDetail?.ports.length ? selectedDetail.ports.map((port) => <code key={port}>{port}</code>) : <span>无端口映射</span>}
          </div>
        </section>
        <section>
          <header>
            <strong>挂载</strong>
            <span>{selectedDetail?.mounts.length ?? 0}</span>
          </header>
          <div className="container-chip-list">
            {selectedDetail?.mounts.length ? selectedDetail.mounts.map((mount) => <code key={mount}>{mount}</code>) : <span>无挂载</span>}
          </div>
        </section>
        <section>
          <header>
            <strong>环境变量</strong>
            <span>{selectedDetail?.env.length ?? 0}</span>
          </header>
          <div className="container-chip-list">
            {selectedDetail?.env.length ? selectedDetail.env.slice(0, 24).map((item) => <code key={item}>{item}</code>) : <span>无环境变量</span>}
            {selectedDetail && selectedDetail.env.length > 24 ? <span>还有 {selectedDetail.env.length - 24} 项。</span> : null}
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
            {runtimeLoading || containersLoading || imagesLoading ? '刷新中' : '刷新'}
          </button>
          <button type="button" className="container-tool-button" onClick={() => void refreshCurrentContainer()} disabled={!selectedContainer || detailLoading}>
            {detailLoading ? '读取中' : '刷新当前'}
          </button>
          <span className="container-runtime-pill">{getRuntimeLabel(runtime)}</span>
          <span className="container-summary">
            <strong>{activeTab === 'images' ? visibleImages.length : visibleContainers.length}</strong> / {activeTab === 'images' ? images.length : containers.length}
          </span>
        </div>

        <div className="container-tabs" role="tablist" aria-label="容器管理标签">
          {managerTabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              className={activeTab === tab.key ? 'active' : ''}
              title={tab.label}
              onClick={() => setActiveTab(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="container-toolbar-right">
          {renderToolbarRight()}
        </div>
      </div>

      {error ? <div className="container-alert danger">{error}</div> : null}
      {notice ? <div className="container-alert info">{notice}</div> : null}
      {success ? <div className="container-alert success">{success}</div> : null}
      {troubleshooting ? (
        <section className="container-troubleshooting" aria-label="容器故障诊断">
          <div>
            <strong>{troubleshooting.title}</strong>
            <p>{troubleshooting.message}</p>
          </div>
          <div className="container-troubleshooting-actions">
            <button type="button" className="container-tool-button" onClick={() => void copyToClipboard(troubleshooting.commands, '修复命令')}>
              复制修复命令
            </button>
            <button type="button" className="container-tool-button" onClick={() => void copyToClipboard(troubleshooting.rawOutput, '原始错误')}>
              复制原始错误
            </button>
          </div>
          <pre>{troubleshooting.commands}</pre>
        </section>
      ) : null}

      {activeTab === 'containers' ? (
        <div className="container-content">
          <aside className="container-list-panel" aria-label="容器列表">
            <div className="container-stats">
              <span><strong>{containerStats.running}</strong> 运行</span>
              <span><strong>{containerStats.exited}</strong> 停止</span>
              <span><strong>{containerStats.paused}</strong> 暂停</span>
              <span><strong>{containerStats.created}</strong> 创建</span>
            </div>

            <div className="container-list">
              {visibleContainers.length === 0 ? (
                <div className="container-empty">{containersLoading ? '正在加载容器列表...' : '暂无匹配的容器。'}</div>
              ) : (
                visibleContainers.map(renderContainerListItem)
              )}
            </div>
          </aside>

          <section className="container-detail-panel" aria-label="容器详情">
            {selectedContainer ? (
              <>
                <header className="container-detail-header">
                  <div>
                    <span>容器</span>
                    <strong title={selectedContainer.name}>{selectedDetail?.name || selectedContainer.name}</strong>
                    <code title={selectedContainer.id}>{formatShortId(selectedContainer.id)}</code>
                    <p title={selectedDetail?.image || selectedContainer.image}>{selectedDetail?.image || selectedContainer.image}</p>
                  </div>
                  <button
                    type="button"
                    className="container-copy-btn"
                    disabled={!selectedDetail}
                    onClick={() => selectedDetail ? void copyToClipboard(buildContainerDiagnostics(selectedDetail), '容器诊断') : undefined}
                  >
                    复制诊断
                  </button>
                </header>

                <div className="container-status-row">
                  <span className={`container-state-tag ${selectedDetail?.state || selectedContainer.state}`}>
                    {getStateLabel(selectedDetail?.state || selectedContainer.state)}
                  </span>
                  <strong title={selectedDetail?.status || selectedContainer.status}>{selectedDetail?.status || selectedContainer.status}</strong>
                  <small title={selectedContainer.ports}>{selectedContainer.ports}</small>
                </div>

                <div className="container-action-bar" aria-label="容器操作">
                  {(['start', 'stop', 'restart', 'remove'] as ContainerAction[]).map(renderContainerActionButton)}
                  <button type="button" className="container-action-btn" onClick={() => { setDetailTab('logs'); void loadContainerDetail(selectedContainer.id); }}>
                    查看日志
                  </button>
                  <button type="button" className="container-action-btn" onClick={() => setDetailTab('exec')}>
                    Exec
                  </button>
                </div>

                <div className="container-detail-tabs" role="tablist" aria-label="容器详情标签">
                  <button type="button" role="tab" className={detailTab === 'summary' ? 'active' : ''} onClick={() => setDetailTab('summary')}>摘要</button>
                  <button type="button" role="tab" className={detailTab === 'logs' ? 'active' : ''} onClick={() => setDetailTab('logs')}>日志</button>
                  <button type="button" role="tab" className={detailTab === 'inspect' ? 'active' : ''} onClick={() => setDetailTab('inspect')}>Inspect</button>
                  <button type="button" role="tab" className={detailTab === 'exec' ? 'active' : ''} onClick={() => setDetailTab('exec')}>Exec</button>
                </div>

                <div className="container-detail-body">
                  {detailLoading && !selectedDetail ? <div className="container-empty">正在读取容器详情...</div> : null}
                  {selectedDetail || !detailLoading ? (
                    <>
                      {detailTab === 'summary' ? renderDetailSummary() : null}
                      {detailTab === 'logs' ? (
                        <pre>{selectedDetail?.logs || '暂无最近日志。'}</pre>
                      ) : null}
                      {detailTab === 'inspect' ? (
                        <pre>{selectedDetail?.inspectText || '暂无 inspect 输出。'}</pre>
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
                              placeholder="sh -lc 中执行的命令"
                              aria-label="容器 exec 命令"
                            />
                            <button type="submit" className="container-action-btn primary" disabled={execRunning || selectedContainer.state !== 'running'}>
                              {execRunning ? '执行中' : '运行'}
                            </button>
                          </form>
                          <pre>{execOutput || (selectedContainer.state !== 'running' ? '容器未运行，无法执行 exec。' : '输入命令后运行。')}</pre>
                        </div>
                      ) : null}
                    </>
                  ) : null}
                </div>
              </>
            ) : (
              <div className="container-detail-empty">
                <strong>{containersLoading ? '正在加载容器' : '未选中容器'}</strong>
                <span>{containersLoading ? '等待远程运行时返回列表。' : '暂无容器详情。'}</span>
              </div>
            )}
          </section>
        </div>
      ) : null}

      {activeTab === 'images' ? (
        <div className="container-images-panel" aria-label="镜像列表">
          <div className="container-image-table-wrap">
            <table className="container-image-table">
              <thead>
                <tr>
                  <th className="container-image-repo">仓库</th>
                  <th className="container-image-tag">标签</th>
                  <th className="container-image-id">ID</th>
                  <th className="container-image-size">大小</th>
                  <th className="container-image-created">创建时间</th>
                  <th className="container-image-actions">操作</th>
                </tr>
              </thead>
              <tbody>
                {visibleImages.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="container-table-empty">
                      {imagesLoading ? '正在加载镜像列表...' : '暂无匹配的镜像。'}
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
                        <button
                          type="button"
                          className="container-table-danger"
                          disabled={Boolean(actingKey)}
                          onClick={() => setPendingAction({ kind: 'image', action: 'remove', image })}
                        >
                          {actingKey === `image-remove:${image.id}` ? '删除中' : '删除'}
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

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
              {pendingAction.kind === 'container' ? '删除容器' : '删除镜像'}
            </div>
            <div className="container-modal-message">
              {pendingAction.kind === 'container' ? (
                <>
                  <p>目标容器：<strong>{pendingAction.container.name}</strong></p>
                  <p>删除后容器文件系统和运行状态会从远程运行时移除。</p>
                  <code>{pendingAction.container.id}</code>
                </>
              ) : (
                <>
                  <p>目标镜像：<strong>{getImageReference(pendingAction.image)}</strong></p>
                  <p>如果仍有容器引用该镜像，远程运行时会拒绝删除。</p>
                  <code>{pendingAction.image.id}</code>
                </>
              )}
            </div>
            <div className="container-modal-actions">
              <button type="button" className="container-modal-btn" onClick={() => setPendingAction(null)}>取消</button>
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
                确认删除
              </button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}

export default RemoteContainerManager;

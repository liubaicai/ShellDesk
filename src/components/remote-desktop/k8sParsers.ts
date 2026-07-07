import { toStringOrEmpty } from './parseUtils';
import type {
  K8sConfigMap,
  K8sContext,
  K8sNamespace,
  K8sNode,
  K8sNodeCondition,
  K8sPod,
  K8sPodCondition,
  K8sPodContainer,
  K8sPodDetail,
  K8sPodEvent,
  K8sSecret,
  K8sService,
  K8sWorkloadDetail,
  K8sWorkloadSummary,
  WorkloadKind,
} from './k8sTypes';

export function parseKubectlList<T>(jsonOutput: string): T[] {
  try {
    const parsed = JSON.parse(jsonOutput || '{}') as unknown;
    const record = toRecord(parsed);
    const items = record?.items;
    return Array.isArray(items) ? items as T[] : [];
  } catch {
    return [];
  }
}

export function parseKubectlItem<T>(jsonOutput: string): T | null {
  try {
    const parsed = JSON.parse(jsonOutput || '{}') as unknown;
    const record = toRecord(parsed);
    return record?.metadata ? parsed as T : null;
  } catch {
    return null;
  }
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function toRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.map(toRecord).filter((record): record is Record<string, unknown> => Boolean(record))
    : [];
}

function toStringRecord(value: unknown): Record<string, string> {
  const record = toRecord(value);
  if (!record) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(record)
      .map(([key, item]) => [key, toStringOrEmpty(item)] as const)
      .filter(([, item]) => Boolean(item)),
  );
}

function get(obj: Record<string, unknown> | undefined, ...path: string[]): unknown {
  let current: unknown = obj;
  for (const key of path) {
    const record = toRecord(current);
    if (!record || !(key in record)) {
      return undefined;
    }
    current = record[key];
  }
  return current;
}

function getStr(obj: Record<string, unknown> | undefined, ...path: string[]): string {
  return toStringOrEmpty(get(obj, ...path));
}

function getNum(obj: Record<string, unknown> | undefined, ...path: string[]): number {
  const value = get(obj, ...path);
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsedValue = Number.parseInt(value, 10);
    return Number.isFinite(parsedValue) ? parsedValue : 0;
  }
  return 0;
}

function formatAge(creationTimestamp: string): string {
  if (!creationTimestamp) return '-';
  const created = new Date(creationTimestamp).getTime();
  if (Number.isNaN(created)) return '-';
  const diffMs = Math.max(0, Date.now() - created);
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function formatSelector(selector: Record<string, string>): string {
  return Object.entries(selector).map(([key, value]) => `${key}=${value}`).join(', ') || '-';
}

export function parseNamespace(raw: Record<string, unknown>): K8sNamespace {
  const metadata = toRecord(get(raw, 'metadata'));
  return {
    name: getStr(metadata, 'name'),
    status: getStr(raw, 'status', 'phase'),
    age: formatAge(getStr(metadata, 'creationTimestamp')),
  };
}

export function parsePod(raw: Record<string, unknown>): K8sPod {
  const metadata = toRecord(get(raw, 'metadata'));
  const status = toRecord(get(raw, 'status'));
  const spec = toRecord(get(raw, 'spec'));
  const containerStatuses = toRecordArray(get(status, 'containerStatuses'));
  const containers = toRecordArray(get(spec, 'containers'));
  const readyContainers = containerStatuses.filter((containerStatus) => containerStatus.ready === true).length;
  const restartCount = containerStatuses.reduce((total, containerStatus) => total + getNum(containerStatus, 'restartCount'), 0);
  const containerImages = containers.map((container) => getStr(container, 'image')).filter(Boolean);

  return {
    name: getStr(metadata, 'name'),
    namespace: getStr(metadata, 'namespace'),
    status: getStr(status, 'phase'),
    nodeName: getStr(spec, 'nodeName'),
    podIP: getStr(status, 'podIP'),
    age: formatAge(getStr(metadata, 'creationTimestamp')),
    creationTimestamp: getStr(metadata, 'creationTimestamp'),
    containers: containers.length,
    readyContainers,
    restartCount,
    containerImages,
  };
}

export function parsePodContainers(raw: Record<string, unknown>): K8sPodContainer[] {
  const spec = toRecord(get(raw, 'spec'));
  const status = toRecord(get(raw, 'status'));
  const specContainers = toRecordArray(get(spec, 'containers'));
  const containerStatuses = toRecordArray(get(status, 'containerStatuses'));

  return specContainers.map((specContainer) => {
    const name = getStr(specContainer, 'name');
    const containerStatus = containerStatuses.find((statusItem) => getStr(statusItem, 'name') === name);
    const stateValue = toRecord(get(containerStatus, 'state'));
    const state = stateValue ? Object.keys(stateValue)[0] || 'unknown' : 'unknown';
    const stateRecord = toRecord(stateValue?.[state]);
    const ports = toRecordArray(get(specContainer, 'ports'));

    return {
      name,
      image: getStr(specContainer, 'image'),
      state,
      stateDetail: stateRecord ? getStr(stateRecord, 'reason') || getStr(stateRecord, 'message') || state : '-',
      ready: containerStatus?.ready === true,
      restartCount: getNum(containerStatus, 'restartCount'),
      ports: ports.map((port) => `${getStr(port, 'containerPort')}/${getStr(port, 'protocol')}`).join(', ') || '-',
    };
  });
}

export function parsePodConditions(raw: Record<string, unknown>): K8sPodCondition[] {
  const status = toRecord(get(raw, 'status'));
  return toRecordArray(get(status, 'conditions')).map((condition) => ({
    type: getStr(condition, 'type'),
    status: getStr(condition, 'status'),
    reason: getStr(condition, 'reason') || undefined,
    message: getStr(condition, 'message') || undefined,
    lastTransitionTime: getStr(condition, 'lastTransitionTime') || undefined,
  }));
}

export function parsePodEvents(rawList: Record<string, unknown>[]): K8sPodEvent[] {
  return rawList
    .filter((event) => getStr(toRecord(get(event, 'involvedObject')), 'kind') === 'Pod')
    .map((event) => ({
      type: getStr(event, 'type'),
      reason: getStr(event, 'reason'),
      message: getStr(event, 'message') || getStr(event, 'note'),
      firstTimestamp: getStr(event, 'firstTimestamp') || getStr(event, 'eventTime') || getStr(event, 'deprecatedFirstTimestamp'),
      lastTimestamp: getStr(event, 'lastTimestamp') || getStr(event, 'eventTime') || getStr(event, 'deprecatedLastTimestamp'),
      count: getNum(event, 'count') || getNum(event, 'deprecatedCount'),
      source: getStr(toRecord(get(event, 'source')), 'component') || getStr(toRecord(get(event, 'source')), 'host') || getStr(event, 'reportingController'),
    }))
    .sort((left, right) => new Date(right.lastTimestamp).getTime() - new Date(left.lastTimestamp).getTime());
}

export function parsePodDetail(raw: Record<string, unknown>, eventsRaw: Record<string, unknown>[]): K8sPodDetail {
  const metadata = toRecord(get(raw, 'metadata'));
  const spec = toRecord(get(raw, 'spec'));
  const status = toRecord(get(raw, 'status'));

  return {
    pod: parsePod(raw),
    containers: parsePodContainers(raw),
    conditions: parsePodConditions(raw),
    events: parsePodEvents(eventsRaw),
    labels: toStringRecord(get(metadata, 'labels')),
    annotations: toStringRecord(get(metadata, 'annotations')),
    serviceAccount: getStr(spec, 'serviceAccountName'),
    qosClass: getStr(status, 'qosClass'),
    nodeName: getStr(spec, 'nodeName'),
    hostIP: getStr(status, 'hostIP'),
    podIP: getStr(status, 'podIP'),
  };
}

export function parseNode(raw: Record<string, unknown>): K8sNode {
  const metadata = toRecord(get(raw, 'metadata'));
  const status = toRecord(get(raw, 'status'));
  const spec = toRecord(get(raw, 'spec'));
  const nodeInfo = toRecord(get(status, 'nodeInfo'));
  const addresses = toRecordArray(get(status, 'addresses'));
  const capacity = toRecord(get(status, 'capacity'));
  const allocatable = toRecord(get(status, 'allocatable'));
  const conditions = toRecordArray(get(status, 'conditions'));
  const labels = toStringRecord(get(metadata, 'labels'));
  const roles: string[] = [];

  if (labels['node-role.kubernetes.io/control-plane'] !== undefined) roles.push('control-plane');
  if (labels['node-role.kubernetes.io/master'] !== undefined) roles.push('master');
  if (labels['node-role.kubernetes.io/worker'] !== undefined) roles.push('worker');
  if (roles.length === 0) {
    roles.push(spec?.unschedulable === true ? 'control-plane' : 'worker');
  }

  const readyCondition = conditions.find((condition) => getStr(condition, 'type') === 'Ready');
  const internalIP = addresses.find((address) => getStr(address, 'type') === 'InternalIP');
  const externalIP = addresses.find((address) => getStr(address, 'type') === 'ExternalIP');
  const nodeConditions: K8sNodeCondition[] = conditions.map((condition) => ({
    type: getStr(condition, 'type'),
    status: getStr(condition, 'status'),
    reason: getStr(condition, 'reason') || undefined,
    message: getStr(condition, 'message') || undefined,
    lastHeartbeatTime: getStr(condition, 'lastHeartbeatTime') || undefined,
  }));

  return {
    name: getStr(metadata, 'name'),
    status: readyCondition ? getStr(readyCondition, 'status') : 'Unknown',
    roles: roles.join(', '),
    internalIP: internalIP ? getStr(internalIP, 'address') : '-',
    externalIP: externalIP ? getStr(externalIP, 'address') : '-',
    osImage: getStr(nodeInfo, 'osImage'),
    kernelVersion: getStr(nodeInfo, 'kernelVersion'),
    containerRuntime: getStr(nodeInfo, 'containerRuntimeVersion'),
    kubeletVersion: getStr(nodeInfo, 'kubeletVersion'),
    age: formatAge(getStr(metadata, 'creationTimestamp')),
    creationTimestamp: getStr(metadata, 'creationTimestamp'),
    cpuCapacity: toStringOrEmpty(capacity?.cpu),
    memoryCapacity: toStringOrEmpty(capacity?.memory),
    podCapacity: toStringOrEmpty(capacity?.pods),
    cpuAllocatable: toStringOrEmpty(allocatable?.cpu),
    memoryAllocatable: toStringOrEmpty(allocatable?.memory),
    podAllocatable: toStringOrEmpty(allocatable?.pods),
    conditions: nodeConditions,
  };
}

export function parseContext(raw: Record<string, unknown>): K8sContext {
  return {
    name: getStr(raw, 'name'),
    cluster: getStr(raw, 'context', 'cluster'),
    user: getStr(raw, 'context', 'user'),
    namespace: getStr(raw, 'context', 'namespace') || 'default',
    isCurrent: false,
  };
}

export function parseWorkload(raw: Record<string, unknown>, kind: WorkloadKind): K8sWorkloadSummary {
  const metadata = toRecord(get(raw, 'metadata'));
  const spec = toRecord(get(raw, 'spec'));
  const status = toRecord(get(raw, 'status'));
  const template = toRecord(get(spec, 'template'));
  const podSpec = toRecord(get(template, 'spec'));
  const containers = toRecordArray(get(podSpec, 'containers'));
  const matchLabels = toStringRecord(get(spec, 'selector', 'matchLabels'));

  return {
    kind,
    name: getStr(metadata, 'name'),
    namespace: getStr(metadata, 'namespace'),
    desired: getNum(spec, 'replicas'),
    current: getNum(status, 'currentReplicas') || getNum(status, 'replicas'),
    ready: getNum(status, 'readyReplicas'),
    upToDate: getNum(status, 'updatedReplicas') || getNum(status, 'currentReplicas'),
    available: getNum(status, 'availableReplicas'),
    age: formatAge(getStr(metadata, 'creationTimestamp')),
    creationTimestamp: getStr(metadata, 'creationTimestamp'),
    images: containers.map((container) => getStr(container, 'image')).filter(Boolean),
    selector: formatSelector(matchLabels),
  };
}

export function parseWorkloadDetail(raw: Record<string, unknown>, kind: WorkloadKind): K8sWorkloadDetail {
  const metadata = toRecord(get(raw, 'metadata'));
  const spec = toRecord(get(raw, 'spec'));
  const strategy = toRecord(get(spec, 'strategy'));
  const updateStrategy = toRecord(get(spec, 'updateStrategy'));
  const status = toRecord(get(raw, 'status'));
  const conditions = toRecordArray(get(status, 'conditions'));
  const template = toRecord(get(spec, 'template'));
  const podSpec = toRecord(get(template, 'spec'));

  return {
    summary: parseWorkload(raw, kind),
    labels: toStringRecord(get(metadata, 'labels')),
    annotations: toStringRecord(get(metadata, 'annotations')),
    strategy: getStr(strategy, 'type') || getStr(updateStrategy, 'type'),
    minReadySeconds: getNum(spec, 'minReadySeconds'),
    revisionHistoryLimit: getNum(spec, 'revisionHistoryLimit'),
    conditions: conditions.map((condition) => [getStr(condition, 'type'), getStr(condition, 'status'), getStr(condition, 'reason')].filter(Boolean).join(': ')),
    containers: parsePodContainers({ spec: podSpec }),
  };
}

export function parseService(raw: Record<string, unknown>): K8sService {
  const metadata = toRecord(get(raw, 'metadata'));
  const spec = toRecord(get(raw, 'spec'));
  const ports = toRecordArray(get(spec, 'ports'));
  const selector = toStringRecord(get(spec, 'selector'));
  const externalIPs = get(spec, 'externalIPs');

  return {
    name: getStr(metadata, 'name'),
    namespace: getStr(metadata, 'namespace'),
    type: getStr(spec, 'type'),
    clusterIP: getStr(spec, 'clusterIP'),
    externalIP: Array.isArray(externalIPs) ? externalIPs.map(toStringOrEmpty).filter(Boolean).join(', ') : undefined,
    ports: ports.map((portRecord) => {
      const port = getNum(portRecord, 'port');
      const targetPort = get(portRecord, 'targetPort');
      const protocol = getStr(portRecord, 'protocol');
      const nodePort = get(portRecord, 'nodePort');
      let result = `${port}/${protocol}`;
      if (targetPort) result += `->${toStringOrEmpty(targetPort)}`;
      if (nodePort) result += `:${toStringOrEmpty(nodePort)}`;
      return result;
    }).join(', ') || '-',
    selector: formatSelector(selector),
    age: formatAge(getStr(metadata, 'creationTimestamp')),
  };
}

export function parseConfigMap(raw: Record<string, unknown>): K8sConfigMap {
  const metadata = toRecord(get(raw, 'metadata'));
  const data = toRecord(get(raw, 'data')) || {};
  return {
    name: getStr(metadata, 'name'),
    namespace: getStr(metadata, 'namespace'),
    dataKeys: Object.keys(data).join(', ') || '-',
    dataCount: Object.keys(data).length,
    age: formatAge(getStr(metadata, 'creationTimestamp')),
  };
}

export function parseSecret(raw: Record<string, unknown>): K8sSecret {
  const metadata = toRecord(get(raw, 'metadata'));
  const data = toRecord(get(raw, 'data')) || {};
  return {
    name: getStr(metadata, 'name'),
    namespace: getStr(metadata, 'namespace'),
    type: getStr(raw, 'type'),
    dataCount: Object.keys(data).length,
    age: formatAge(getStr(metadata, 'creationTimestamp')),
  };
}

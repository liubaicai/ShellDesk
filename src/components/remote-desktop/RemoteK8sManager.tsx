import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { tCurrent, type MessageId, type MessageParams } from '../../i18n';
import DismissibleAlert from './DismissibleAlert';
import { getErrorMessage, formatDateTime } from './desktopUtils';
import {
  getConfigMapListCommand,
  getConfigMapDeleteCommand,
  getConfigMapEditCommand,
  getConfigMapGetYamlCommand,
  getConfigViewCommand,
  getDaemonSetListCommand,
  getDeploymentListCommand,
  getKubectlDetectCommand,
  getKubectlVersionCommand,
  getNamespaceListCommand,
  getNodeDetailCommand,
  getNodeListCommand,
  getNodeTopCommand,
  getPodDeleteCommand,
  getPodDetailCommand,
  getPodEventsCommand,
  getPodListCommand,
  getPodLogsCommand,
  getSecretListCommand,
  getSecretDeleteCommand,
  getSecretEditCommand,
  getSecretGetYamlCommand,
  getServiceDeleteCommand,
  getServiceEditCommand,
  getServiceGetYamlCommand,
  getServiceListCommand,
  getStatefulSetListCommand,
  getWorkloadGetYamlCommand,
  getWorkloadRolloutRestartCommand,
  getWorkloadRolloutStatusCommand,
  getWorkloadScaleCommand,
} from './k8sCommands';
import {
  parseConfigMap,
  parseContext,
  parseKubectlItem,
  parseKubectlList,
  parseNamespace,
  parseNode,
  parsePod,
  parsePodDetail,
  parseSecret,
  parseService,
  parseWorkload,
} from './k8sParsers';
import type {
  K8sConfigMap,
  K8sContext,
  K8sManagerTab,
  K8sNamespace,
  K8sNode,
  K8sNodeUsageSummary,
  K8sPod,
  K8sPodDetail,
  K8sRuntimeStatus,
  K8sSecret,
  K8sService,
  K8sWorkloadSummary,
  PodFilter,
  RemoteK8sManagerProps,
  WorkloadKind,
  WorkloadSubTab,
} from './k8sTypes';
import { useSudoCommand } from './sudoPrompt';

type RawRecord = Record<string, unknown>;
type K8sConfigMapRow = K8sConfigMap & { data: Record<string, string> };
type K8sSecretRow = K8sSecret & { data: Record<string, string> };
type PendingDeletePod = { name: string; namespace: string } | null;
type ResourceKind = 'service' | 'configmap' | 'secret';
type PendingDeleteResource = { kind: ResourceKind; name: string; namespace: string } | null;
type WorkloadActionTarget = K8sWorkloadSummary;
type ScaleDialogState = { workload: WorkloadActionTarget; replicas: number } | null;
type OutputDialogState = { title: string; output: string } | null;
type YamlEditorState = { kind: ResourceKind; name: string; namespace: string; yaml: string } | null;
type PendingRestartWorkload = WorkloadActionTarget | null;
type K8sResourceDetail =
  | { kind: 'service'; title: string; name: string; namespace: string; service: K8sService; manifest: RawRecord }
  | { kind: 'configmap'; title: string; name: string; namespace: string; values: Record<string, string>; manifest: RawRecord }
  | { kind: 'secret'; title: string; name: string; namespace: string; values: Record<string, string>; manifest: RawRecord };

const tabs: Array<{ key: K8sManagerTab; labelId: string }> = [
  { key: 'pods', labelId: 'auto.remoteK8sManager.podsTab' },
  { key: 'workloads', labelId: 'auto.remoteK8sManager.workloadsTab' },
  { key: 'services', labelId: 'auto.remoteK8sManager.servicesTab' },
  { key: 'configmaps', labelId: 'auto.remoteK8sManager.configMapsTab' },
  { key: 'secrets', labelId: 'auto.remoteK8sManager.secretsTab' },
  { key: 'nodes', labelId: 'auto.remoteK8sManager.nodesTab' },
];

const workloadTabs: Array<{ key: WorkloadSubTab; kind: WorkloadKind; labelId: string }> = [
  { key: 'deployments', kind: 'deployment', labelId: 'auto.remoteK8sManager.deploymentsTab' },
  { key: 'statefulsets', kind: 'statefulset', labelId: 'auto.remoteK8sManager.statefulSetsTab' },
  { key: 'daemonsets', kind: 'daemonset', labelId: 'auto.remoteK8sManager.daemonSetsTab' },
];

const podFilters: Array<{ key: PodFilter; labelId: string }> = [
  { key: 'all', labelId: 'auto.remoteK8sManager.filterAll' },
  { key: 'running', labelId: 'auto.remoteK8sManager.filterRunning' },
  { key: 'pending', labelId: 'auto.remoteK8sManager.filterPending' },
  { key: 'failed', labelId: 'auto.remoteK8sManager.filterFailed' },
];

function msg(id: string, params?: MessageParams) {
  return tCurrent(id as MessageId, params);
}

function toRecord(value: unknown): RawRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RawRecord : null;
}

function toStringRecord(value: unknown): Record<string, string> {
  const record = toRecord(value);
  if (!record) return {};
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, String(item ?? '')]));
}

function getRawData(raw: RawRecord) {
  return toStringRecord(toRecord(raw.metadata)?.name ? raw.data : undefined);
}

function getConfigContexts(stdout: string): { currentContext: string; contexts: K8sContext[] } {
  try {
    const config = toRecord(JSON.parse(stdout || '{}'));
    const currentContext = String(config?.['current-context'] ?? '');
    const rawContexts = Array.isArray(config?.contexts) ? config.contexts : [];
    const contexts = rawContexts.map((item) => parseContext(item as RawRecord)).map((context) => ({
      ...context,
      isCurrent: context.name === currentContext,
    }));
    return { currentContext, contexts };
  } catch {
    return { currentContext: '', contexts: [] };
  }
}

function getVersionLabel(stdout: string) {
  try {
    const parsed = toRecord(JSON.parse(stdout || '{}'));
    const clientVersion = toRecord(parsed?.clientVersion);
    return String(clientVersion?.gitVersion ?? clientVersion?.major ?? '').trim();
  } catch {
    return '';
  }
}

function commandError(result: { stdout: string; stderr: string; code: number }) {
  return result.code !== 0 ? (result.stderr || result.stdout || msg('auto.remoteK8sManager.commandFailed')) : '';
}

function formatCommandFailure(result: { stdout: string; stderr: string; code: number }, fallbackId: string, rbac?: { resource: string; verb: string }) {
  const errorText = commandError(result);
  if (!errorText) return '';
  if (rbac && /forbidden|cannot .*because|permission denied/i.test(errorText)) {
    return msg('auto.remoteK8sManager.permissionDenied', { value0: `${rbac.resource}/${rbac.verb}` });
  }
  return `${msg(fallbackId)}: ${errorText}`;
}

function decodeBase64Value(value: string) {
  try {
    return atob(value);
  } catch {
    return value;
  }
}

function decodeBase64Record(values: Record<string, string>) {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, decodeBase64Value(value)]));
}

function encodeBase64Value(value: string) {
  return btoa(unescape(encodeURIComponent(value)));
}

function encodeBase64Record(values: Record<string, string>) {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, encodeBase64Value(value)]));
}

function cloneResourceManifest(raw: RawRecord) {
  const copy = JSON.parse(JSON.stringify(raw || {})) as RawRecord;
  const metadata = toRecord(copy.metadata);
  if (metadata) {
    delete metadata.managedFields;
    delete metadata.resourceVersion;
    delete metadata.uid;
    delete metadata.selfLink;
    delete metadata.creationTimestamp;
    delete metadata.generation;
  }
  delete copy.status;
  return copy;
}

function getEditableManifest(detail: K8sResourceDetail) {
  const manifest = cloneResourceManifest(detail.manifest);
  if (detail.kind === 'secret') {
    const data = toStringRecord(manifest.data);
    manifest.data = decodeBase64Record(data);
  }
  return JSON.stringify(manifest, null, 2);
}

function prepareManifestForApply(kind: ResourceKind, yaml: string) {
  const manifest = JSON.parse(yaml) as RawRecord;
  if (kind === 'secret') {
    manifest.data = encodeBase64Record(toStringRecord(manifest.data));
  }
  return JSON.stringify(manifest, null, 2);
}

function parseCpuQuantity(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return 0;
  if (trimmed.endsWith('n')) return Number.parseFloat(trimmed) / 1_000_000_000;
  if (trimmed.endsWith('u')) return Number.parseFloat(trimmed) / 1_000_000;
  if (trimmed.endsWith('m')) return Number.parseFloat(trimmed) / 1000;
  return Number.parseFloat(trimmed) || 0;
}

function parseMemoryQuantity(value: string) {
  const trimmed = value.trim();
  const match = /^([0-9.]+)([KMGTEP]i?|[kmgtep])?$/u.exec(trimmed);
  if (!match) return Number.parseFloat(trimmed) || 0;
  const amount = Number.parseFloat(match[1] ?? '0') || 0;
  const unit = match[2] ?? '';
  const binary: Record<string, number> = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, Pi: 1024 ** 5 };
  const decimal: Record<string, number> = { K: 1000, M: 1000 ** 2, G: 1000 ** 3, T: 1000 ** 4, P: 1000 ** 5, k: 1000, m: 0.001 };
  return amount * (binary[unit] ?? decimal[unit] ?? 1);
}

function parseNodeTopSummary(stdout: string, nodes: K8sNode[], pods: K8sPod[]): K8sNodeUsageSummary | null {
  try {
    const parsed = toRecord(JSON.parse(stdout || '{}'));
    const items = Array.isArray(parsed?.items) ? parsed.items : [];
    if (!items.length) return null;
    let cpuUsed = 0;
    let memoryUsed = 0;
    for (const item of items) {
      const usage = toRecord(toRecord(item)?.usage);
      cpuUsed += parseCpuQuantity(String(usage?.cpu ?? ''));
      memoryUsed += parseMemoryQuantity(String(usage?.memory ?? ''));
    }
    const cpuCapacity = nodes.reduce((total, node) => total + parseCpuQuantity(node.cpuCapacity), 0);
    const memoryCapacity = nodes.reduce((total, node) => total + parseMemoryQuantity(node.memoryCapacity), 0);
    const podsCapacity = nodes.reduce((total, node) => total + (Number.parseInt(node.podCapacity, 10) || 0), 0);
    return {
      cpuPercent: cpuCapacity > 0 ? Math.round((cpuUsed / cpuCapacity) * 100) : 0,
      memoryPercent: memoryCapacity > 0 ? Math.round((memoryUsed / memoryCapacity) * 100) : 0,
      podsUsed: pods.length,
      podsCapacity,
    };
  } catch {
    return null;
  }
}

function statusClass(status: string) {
  const normalized = status.toLowerCase();
  if (normalized === 'running' || normalized === 'true') return 'is-running';
  if (normalized === 'pending') return 'is-pending';
  if (normalized === 'failed' || normalized === 'error' || normalized === 'false') return 'is-failed';
  if (normalized === 'succeeded') return 'is-succeeded';
  return 'is-unknown';
}

function statusLabel(status: string) {
  return msg(`auto.remoteK8sManager.status.${status || 'unknown'}`);
}

function RemoteK8sManager({ connectionId, systemType }: RemoteK8sManagerProps) {
  const { runCommand, sudoPrompt } = useSudoCommand(connectionId, systemType);
  const [kubectlStatus, setKubectlStatus] = useState<K8sRuntimeStatus>('checking');
  const [kubectlVersion, setKubectlVersion] = useState('');
  const [namespaces, setNamespaces] = useState<K8sNamespace[]>([]);
  const [selectedNamespace, setSelectedNamespace] = useState('');
  const [currentContext, setCurrentContext] = useState('');
  const [contexts, setContexts] = useState<K8sContext[]>([]);
  const [pods, setPods] = useState<K8sPod[]>([]);
  const [activeTab, setActiveTab] = useState<K8sManagerTab>('pods');
  const [workloadSubTab, setWorkloadSubTab] = useState<WorkloadSubTab>('deployments');
  const [podFilter, setPodFilter] = useState<PodFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [detailPod, setDetailPod] = useState<{ name: string; namespace: string } | null>(null);
  const [podDetail, setPodDetail] = useState<K8sPodDetail | null>(null);
  const [podLogs, setPodLogs] = useState('');
  const [workloads, setWorkloads] = useState<K8sWorkloadSummary[]>([]);
  const [services, setServices] = useState<K8sService[]>([]);
  const [configMaps, setConfigMaps] = useState<K8sConfigMapRow[]>([]);
  const [secrets, setSecrets] = useState<K8sSecretRow[]>([]);
  const [nodes, setNodes] = useState<K8sNode[]>([]);
  const [nodeUsageSummary, setNodeUsageSummary] = useState<K8sNodeUsageSummary | null>(null);
  const [detailWorkload, setDetailWorkload] = useState<K8sWorkloadSummary | null>(null);
  const [resourceDetail, setResourceDetail] = useState<K8sResourceDetail | null>(null);
  const [detailNode, setDetailNode] = useState<K8sNode | null>(null);
  const [scaleDialog, setScaleDialog] = useState<ScaleDialogState>(null);
  const [pendingRestartWorkload, setPendingRestartWorkload] = useState<PendingRestartWorkload>(null);
  const [outputDialog, setOutputDialog] = useState<OutputDialogState>(null);
  const [yamlEditor, setYamlEditor] = useState<YamlEditorState>(null);
  const [pendingDeletePod, setPendingDeletePod] = useState<PendingDeletePod>(null);
  const [pendingDeleteResource, setPendingDeleteResource] = useState<PendingDeleteResource>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refreshPods = useCallback(async () => {
    const result = await runCommand(getPodListCommand());
    const failure = commandError(result);
    if (failure) throw new Error(failure);
    setPods(parseKubectlList<RawRecord>(result.stdout).map(parsePod));
  }, [runCommand]);

  const refreshAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNotice(null);
    setKubectlStatus('checking');
    try {
      const detectResult = await runCommand(getKubectlDetectCommand());
      if (detectResult.code !== 0 || (detectResult.stdout || '').includes('KUBECTL_NOT_FOUND')) {
        setKubectlStatus('unavailable');
        setError(`${msg('auto.remoteK8sManager.kubectlNotFound')} https://kubernetes.io/docs/tasks/tools/`);
        return;
      }

      const [versionResult, namespaceResult, podResult, configResult] = await Promise.all([
        runCommand(getKubectlVersionCommand()),
        runCommand(getNamespaceListCommand()),
        runCommand(getPodListCommand()),
        runCommand(getConfigViewCommand()),
      ]);
      const firstFailure = [versionResult, namespaceResult, podResult, configResult].map(commandError).find(Boolean);
      if (firstFailure) throw new Error(firstFailure);

      setKubectlVersion(getVersionLabel(versionResult.stdout));
      setNamespaces(parseKubectlList<RawRecord>(namespaceResult.stdout).map(parseNamespace));
      setPods(parseKubectlList<RawRecord>(podResult.stdout).map(parsePod));
      const configInfo = getConfigContexts(configResult.stdout);
      setCurrentContext(configInfo.currentContext);
      setContexts(configInfo.contexts);
      setKubectlStatus('available');
    } catch (err) {
      setKubectlStatus('unavailable');
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [runCommand]);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  const namespacePods = useMemo(() => (
    selectedNamespace ? pods.filter((pod) => pod.namespace === selectedNamespace) : pods
  ), [pods, selectedNamespace]);

  const namespacePodCounts = useMemo(() => pods.reduce<Record<string, number>>((counts, pod) => {
    counts[pod.namespace] = (counts[pod.namespace] ?? 0) + 1;
    return counts;
  }, {}), [pods]);

  const filteredPods = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return namespacePods.filter((pod) => {
      const matchesFilter = podFilter === 'all' || pod.status.toLowerCase() === podFilter;
      const matchesSearch = !query || pod.name.toLowerCase().includes(query) || pod.namespace.toLowerCase().includes(query);
      return matchesFilter && matchesSearch;
    });
  }, [namespacePods, podFilter, searchQuery]);

  const loadWorkloads = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const tab = workloadTabs.find((item) => item.key === workloadSubTab) ?? workloadTabs[0];
      const command = tab.key === 'deployments'
        ? getDeploymentListCommand(selectedNamespace)
        : tab.key === 'statefulsets'
          ? getStatefulSetListCommand(selectedNamespace)
          : getDaemonSetListCommand(selectedNamespace);
      const result = await runCommand(command);
      const failure = commandError(result);
      if (failure) throw new Error(failure);
      setWorkloads(parseKubectlList<RawRecord>(result.stdout).map((item) => parseWorkload(item, tab.kind)));
    } catch (err) {
      setError(getErrorMessage(err));
      setWorkloads([]);
    } finally {
      setLoading(false);
    }
  }, [runCommand, selectedNamespace, workloadSubTab]);

  const loadServices = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await runCommand(getServiceListCommand(selectedNamespace));
      const failure = commandError(result);
      if (failure) throw new Error(failure);
      setServices(parseKubectlList<RawRecord>(result.stdout).map(parseService));
    } catch (err) {
      setError(getErrorMessage(err));
      setServices([]);
    } finally {
      setLoading(false);
    }
  }, [runCommand, selectedNamespace]);

  const loadConfigMaps = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await runCommand(getConfigMapListCommand(selectedNamespace));
      const failure = commandError(result);
      if (failure) throw new Error(failure);
      setConfigMaps(parseKubectlList<RawRecord>(result.stdout).map((raw) => ({ ...parseConfigMap(raw), data: getRawData(raw) })));
    } catch (err) {
      setError(getErrorMessage(err));
      setConfigMaps([]);
    } finally {
      setLoading(false);
    }
  }, [runCommand, selectedNamespace]);

  const loadSecrets = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await runCommand(getSecretListCommand(selectedNamespace));
      const failure = commandError(result);
      if (failure) throw new Error(failure);
      setSecrets(parseKubectlList<RawRecord>(result.stdout).map((raw) => ({ ...parseSecret(raw), data: getRawData(raw) })));
    } catch (err) {
      setError(getErrorMessage(err));
      setSecrets([]);
    } finally {
      setLoading(false);
    }
  }, [runCommand, selectedNamespace]);

  const loadNodes = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [result, topResult] = await Promise.all([
        runCommand(getNodeListCommand()),
        runCommand(getNodeTopCommand()),
      ]);
      const failure = commandError(result);
      if (failure) throw new Error(failure);
      const nextNodes = parseKubectlList<RawRecord>(result.stdout).map(parseNode);
      setNodes(nextNodes);
      setNodeUsageSummary(parseNodeTopSummary(topResult.stdout, nextNodes, pods));
    } catch (err) {
      setError(getErrorMessage(err));
      setNodes([]);
      setNodeUsageSummary(null);
    } finally {
      setLoading(false);
    }
  }, [pods, runCommand]);

  useEffect(() => {
    if (kubectlStatus !== 'available') return;
    if (activeTab === 'workloads') void loadWorkloads();
    if (activeTab === 'services') void loadServices();
    if (activeTab === 'configmaps') void loadConfigMaps();
    if (activeTab === 'secrets') void loadSecrets();
    if (activeTab === 'nodes') void loadNodes();
  }, [activeTab, kubectlStatus, loadConfigMaps, loadNodes, loadSecrets, loadServices, loadWorkloads]);

  useEffect(() => {
    if (!detailPod) {
      setPodDetail(null);
      setPodLogs('');
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void Promise.all([
      runCommand(getPodDetailCommand(detailPod.name, detailPod.namespace)),
      runCommand(getPodEventsCommand(detailPod.name, detailPod.namespace)),
    ]).then(([podResult, eventResult]) => {
      if (cancelled) return;
      const podItem = parseKubectlItem<RawRecord>(podResult.stdout);
      if (!podItem) throw new Error(podResult.stderr || msg('auto.remoteK8sManager.podDetailFailed'));
      setPodDetail(parsePodDetail(podItem, parseKubectlList<RawRecord>(eventResult.stdout)));
    }).catch((err) => {
      if (!cancelled) setError(getErrorMessage(err));
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [detailPod, runCommand]);

  const showPodLogs = useCallback(async (pod: K8sPodDetail) => {
    setLoading(true);
    setError(null);
    try {
      const result = await runCommand(getPodLogsCommand(pod.pod.name, pod.pod.namespace, undefined, 200));
      const failure = commandError(result);
      if (failure) throw new Error(failure);
      setPodLogs(result.stdout || msg('auto.remoteK8sManager.noLogs'));
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [runCommand]);

  const deletePod = useCallback(async () => {
    if (!pendingDeletePod) return;
    setLoading(true);
    setError(null);
    try {
      const result = await runCommand(getPodDeleteCommand(pendingDeletePod.name, pendingDeletePod.namespace));
      const failure = commandError(result);
      if (failure) throw new Error(failure);
      setNotice(msg('auto.remoteK8sManager.podDeleted'));
      setPendingDeletePod(null);
      setDetailPod(null);
      await refreshPods();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [pendingDeletePod, refreshPods, runCommand]);

  const confirmScaleWorkload = useCallback(async () => {
    if (!scaleDialog) return;
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const { workload, replicas } = scaleDialog;
      const result = await runCommand(getWorkloadScaleCommand(workload.kind, workload.name, workload.namespace, replicas));
      const failure = formatCommandFailure(result, 'auto.remoteK8sManager.scaleFailed', { resource: workload.kind, verb: 'scale' });
      if (failure) throw new Error(failure);
      setNotice(msg('auto.remoteK8sManager.scaleSuccess'));
      setScaleDialog(null);
      await loadWorkloads();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [loadWorkloads, runCommand, scaleDialog]);

  const restartWorkload = useCallback(async () => {
    if (!pendingRestartWorkload) return;
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const result = await runCommand(getWorkloadRolloutRestartCommand(pendingRestartWorkload.kind, pendingRestartWorkload.name, pendingRestartWorkload.namespace));
      const failure = formatCommandFailure(result, 'auto.remoteK8sManager.restartFailed', { resource: pendingRestartWorkload.kind, verb: 'patch' });
      if (failure) throw new Error(failure);
      setNotice(msg('auto.remoteK8sManager.restartSuccess'));
      setPendingRestartWorkload(null);
      await loadWorkloads();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [loadWorkloads, pendingRestartWorkload, runCommand]);

  const showWorkloadRolloutStatus = useCallback(async (workload: WorkloadActionTarget) => {
    setLoading(true);
    setError(null);
    try {
      const result = await runCommand(getWorkloadRolloutStatusCommand(workload.kind, workload.name, workload.namespace));
      const failure = formatCommandFailure(result, 'auto.remoteK8sManager.commandFailed', { resource: workload.kind, verb: 'get' });
      if (failure) throw new Error(failure);
      setOutputDialog({ title: `${msg('auto.remoteK8sManager.rolloutStatus')}: ${workload.namespace}/${workload.name}`, output: result.stdout || result.stderr || '-' });
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [runCommand]);

  const showWorkloadYaml = useCallback(async (workload: WorkloadActionTarget) => {
    setLoading(true);
    setError(null);
    try {
      const result = await runCommand(getWorkloadGetYamlCommand(workload.kind, workload.name, workload.namespace));
      const failure = formatCommandFailure(result, 'auto.remoteK8sManager.commandFailed', { resource: workload.kind, verb: 'get' });
      if (failure) throw new Error(failure);
      setOutputDialog({ title: `${msg('auto.remoteK8sManager.viewYaml')}: ${workload.namespace}/${workload.name}`, output: result.stdout || '-' });
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [runCommand]);

  const loadResourceDetail = useCallback(async (kind: 'service' | 'configmap' | 'secret', item: K8sService | K8sConfigMapRow | K8sSecretRow) => {
    setLoading(true);
    setError(null);
    try {
      const command = kind === 'service'
        ? getServiceGetYamlCommand(item.name, item.namespace)
        : kind === 'configmap'
          ? getConfigMapGetYamlCommand(item.name, item.namespace)
          : getSecretGetYamlCommand(item.name, item.namespace);
      const result = await runCommand(command);
      const resourceName = kind === 'service' ? 'services' : kind === 'configmap' ? 'configmaps' : 'secrets';
      const failure = formatCommandFailure(result, 'auto.remoteK8sManager.commandFailed', { resource: resourceName, verb: 'get' });
      if (failure) throw new Error(failure);
      const raw = parseKubectlItem<RawRecord>(result.stdout);
      if (!raw) throw new Error(msg('auto.remoteK8sManager.commandFailed'));
      const title = `${item.namespace}/${item.name}`;
      if (kind === 'service') {
        setResourceDetail({ kind, title, name: item.name, namespace: item.namespace, service: parseService(raw), manifest: raw });
      } else if (kind === 'configmap') {
        setResourceDetail({ kind, title, name: item.name, namespace: item.namespace, values: getRawData(raw), manifest: raw });
      } else {
        setResourceDetail({ kind, title, name: item.name, namespace: item.namespace, values: decodeBase64Record(getRawData(raw)), manifest: raw });
      }
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [runCommand]);

  const loadNodeDetail = useCallback(async (node: K8sNode) => {
    setLoading(true);
    setError(null);
    try {
      const result = await runCommand(getNodeDetailCommand(node.name));
      const failure = formatCommandFailure(result, 'auto.remoteK8sManager.commandFailed', { resource: 'nodes', verb: 'get' });
      if (failure) throw new Error(failure);
      const raw = parseKubectlItem<RawRecord>(result.stdout);
      if (!raw) throw new Error(msg('auto.remoteK8sManager.commandFailed'));
      setDetailNode(parseNode(raw));
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [runCommand]);

  const refreshResourceTab = useCallback(async (kind: ResourceKind) => {
    if (kind === 'service') await loadServices();
    if (kind === 'configmap') await loadConfigMaps();
    if (kind === 'secret') await loadSecrets();
  }, [loadConfigMaps, loadSecrets, loadServices]);

  const openYamlEditor = useCallback((detail: K8sResourceDetail) => {
    setYamlEditor({
      kind: detail.kind,
      name: detail.name,
      namespace: detail.namespace,
      yaml: getEditableManifest(detail),
    });
  }, []);

  async function applyResourceYaml(kind: ResourceKind, name: string, namespace: string, yaml: string) {
    const command = kind === 'service'
      ? getServiceEditCommand(name, namespace, yaml)
      : kind === 'configmap'
        ? getConfigMapEditCommand(name, namespace, yaml)
        : getSecretEditCommand(name, namespace, yaml);
    return await runCommand(command);
  }

  const saveYamlEditor = useCallback(async () => {
    if (!yamlEditor) return;
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const yaml = prepareManifestForApply(yamlEditor.kind, yamlEditor.yaml);
      const result = await applyResourceYaml(yamlEditor.kind, yamlEditor.name, yamlEditor.namespace, yaml);
      const resourceName = yamlEditor.kind === 'service' ? 'services' : yamlEditor.kind === 'configmap' ? 'configmaps' : 'secrets';
      const failure = formatCommandFailure(result, 'auto.remoteK8sManager.saveFailed', { resource: resourceName, verb: 'patch' });
      if (failure) throw new Error(failure);
      setNotice(msg('auto.remoteK8sManager.saveSuccess'));
      setYamlEditor(null);
      setResourceDetail(null);
      await refreshResourceTab(yamlEditor.kind);
    } catch (err) {
      setError(`${msg('auto.remoteK8sManager.saveFailed')}: ${getErrorMessage(err)}`);
    } finally {
      setLoading(false);
    }
  }, [refreshResourceTab, runCommand, yamlEditor]);

  const deleteResource = useCallback(async () => {
    if (!pendingDeleteResource) return;
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const command = pendingDeleteResource.kind === 'service'
        ? getServiceDeleteCommand(pendingDeleteResource.name, pendingDeleteResource.namespace)
        : pendingDeleteResource.kind === 'configmap'
          ? getConfigMapDeleteCommand(pendingDeleteResource.name, pendingDeleteResource.namespace)
          : getSecretDeleteCommand(pendingDeleteResource.name, pendingDeleteResource.namespace);
      const result = await runCommand(command);
      const resourceName = pendingDeleteResource.kind === 'service' ? 'services' : pendingDeleteResource.kind === 'configmap' ? 'configmaps' : 'secrets';
      const failure = formatCommandFailure(result, 'auto.remoteK8sManager.deleteFailed', { resource: resourceName, verb: 'delete' });
      if (failure) throw new Error(failure);
      setNotice(msg('auto.remoteK8sManager.deleteSuccess'));
      const deletedKind = pendingDeleteResource.kind;
      setPendingDeleteResource(null);
      setResourceDetail(null);
      await refreshResourceTab(deletedKind);
    } catch (err) {
      setError(`${msg('auto.remoteK8sManager.deleteFailed')}: ${getErrorMessage(err)}`);
    } finally {
      setLoading(false);
    }
  }, [pendingDeleteResource, refreshResourceTab, runCommand]);

  const renderPods = () => (
    <table className="k8s-manager-table">
      <thead><tr><th>{msg('auto.remoteK8sManager.podName')}</th><th>{msg('auto.remoteK8sManager.podNamespace')}</th><th>{msg('auto.remoteK8sManager.podStatus')}</th><th>{msg('auto.remoteK8sManager.podNode')}</th><th>{msg('auto.remoteK8sManager.podAge')}</th><th>{msg('auto.remoteK8sManager.podReady')}</th><th>{msg('auto.remoteK8sManager.podRestarts')}</th></tr></thead>
      <tbody>
        {filteredPods.map((pod) => (
          <tr key={`${pod.namespace}/${pod.name}`} onClick={() => setDetailPod({ name: pod.name, namespace: pod.namespace })}>
            <td><strong>{pod.name}</strong></td><td>{pod.namespace}</td><td><span className={`k8s-manager-status-badge ${statusClass(pod.status)}`}>{statusLabel(pod.status)}</span></td><td>{pod.nodeName || '-'}</td><td>{pod.age}</td><td>{pod.readyContainers}/{pod.containers}</td><td>{pod.restartCount}</td>
          </tr>
        ))}
        {!filteredPods.length ? <tr><td colSpan={7} className="k8s-manager-empty">{msg('auto.remoteK8sManager.emptyPods')}</td></tr> : null}
      </tbody>
    </table>
  );

  const renderWorkloads = () => (
    <>
      <div className="k8s-manager-sub-tabs" role="tablist">{workloadTabs.map((tab) => <button key={tab.key} type="button" className={workloadSubTab === tab.key ? 'active' : ''} onClick={() => setWorkloadSubTab(tab.key)}>{msg(tab.labelId)}</button>)}</div>
      <table className="k8s-manager-table"><thead><tr><th>{msg('auto.remoteK8sManager.podName')}</th><th>{msg('auto.remoteK8sManager.podNamespace')}</th><th>{msg('auto.remoteK8sManager.desired')}</th><th>{msg('auto.remoteK8sManager.ready')}</th><th>{msg('auto.remoteK8sManager.upToDate')}</th><th>{msg('auto.remoteK8sManager.available')}</th><th>{msg('auto.remoteK8sManager.podAge')}</th><th>{msg('auto.remoteK8sManager.images')}</th><th>{msg('auto.remoteK8sManager.actions')}</th></tr></thead><tbody>
        {workloads.map((item) => <tr key={`${item.kind}/${item.namespace}/${item.name}`} onClick={() => setDetailWorkload(item)}><td><strong>{item.name}</strong></td><td>{item.namespace}</td><td>{item.desired}</td><td>{item.ready}</td><td>{item.upToDate}</td><td>{item.available ?? '-'}</td><td>{item.age}</td><td title={item.images.join(', ')}>{item.images.join(', ') || '-'}</td><td><div className="k8s-manager-row-actions" onClick={(event) => event.stopPropagation()}><button type="button" onClick={() => setScaleDialog({ workload: item, replicas: item.desired })}>{msg('auto.remoteK8sManager.scaleButton')}</button><button type="button" onClick={() => setPendingRestartWorkload(item)}>{msg('auto.remoteK8sManager.restartButton')}</button><button type="button" onClick={() => void showWorkloadRolloutStatus(item)}>{msg('auto.remoteK8sManager.rolloutStatus')}</button><button type="button" onClick={() => void showWorkloadYaml(item)}>{msg('auto.remoteK8sManager.viewYaml')}</button></div></td></tr>)}
        {!workloads.length ? <tr><td colSpan={9} className="k8s-manager-empty">{msg('auto.remoteK8sManager.emptyWorkloads')}</td></tr> : null}
      </tbody></table>
    </>
  );

  const renderServices = () => (
    <table className="k8s-manager-table"><thead><tr><th>{msg('auto.remoteK8sManager.podName')}</th><th>{msg('auto.remoteK8sManager.podNamespace')}</th><th>{msg('auto.remoteK8sManager.type')}</th><th>{msg('auto.remoteK8sManager.clusterIp')}</th><th>{msg('auto.remoteK8sManager.ports')}</th><th>{msg('auto.remoteK8sManager.podAge')}</th></tr></thead><tbody>
      {services.map((service) => <tr key={`${service.namespace}/${service.name}`} onClick={() => void loadResourceDetail('service', service)}><td><strong>{service.name}</strong></td><td>{service.namespace}</td><td>{service.type}</td><td>{service.clusterIP}</td><td>{service.ports}</td><td>{service.age}</td></tr>)}
      {!services.length ? <tr><td colSpan={6} className="k8s-manager-empty">{msg('auto.remoteK8sManager.emptyServices')}</td></tr> : null}
    </tbody></table>
  );

  const renderConfigMaps = () => (
    <table className="k8s-manager-table"><thead><tr><th>{msg('auto.remoteK8sManager.podName')}</th><th>{msg('auto.remoteK8sManager.podNamespace')}</th><th>{msg('auto.remoteK8sManager.dataKeys')}</th><th>{msg('auto.remoteK8sManager.podAge')}</th></tr></thead><tbody>
      {configMaps.map((item) => <tr key={`${item.namespace}/${item.name}`} onClick={() => void loadResourceDetail('configmap', item)}><td><strong>{item.name}</strong></td><td>{item.namespace}</td><td>{item.dataKeys}</td><td>{item.age}</td></tr>)}
      {!configMaps.length ? <tr><td colSpan={4} className="k8s-manager-empty">{msg('auto.remoteK8sManager.emptyConfigMaps')}</td></tr> : null}
    </tbody></table>
  );

  const renderSecrets = () => (
    <table className="k8s-manager-table"><thead><tr><th>{msg('auto.remoteK8sManager.podName')}</th><th>{msg('auto.remoteK8sManager.podNamespace')}</th><th>{msg('auto.remoteK8sManager.type')}</th><th>{msg('auto.remoteK8sManager.dataItems')}</th><th>{msg('auto.remoteK8sManager.podAge')}</th></tr></thead><tbody>
      {secrets.map((item) => <tr key={`${item.namespace}/${item.name}`} onClick={() => void loadResourceDetail('secret', item)}><td><strong>{item.name}</strong></td><td>{item.namespace}</td><td>{item.type}</td><td>{item.dataCount}</td><td>{item.age}</td></tr>)}
      {!secrets.length ? <tr><td colSpan={5} className="k8s-manager-empty">{msg('auto.remoteK8sManager.emptySecrets')}</td></tr> : null}
    </tbody></table>
  );

  const renderNodes = () => (
    <>
      {nodeUsageSummary ? <div className="k8s-manager-usage-bar"><strong>{msg('auto.remoteK8sManager.resourceUsage')}</strong><span>{msg('auto.remoteK8sManager.cpu')}: {nodeUsageSummary.cpuPercent}% | {msg('auto.remoteK8sManager.memory')}: {nodeUsageSummary.memoryPercent}% | {msg('auto.remoteK8sManager.pods')}: {nodeUsageSummary.podsUsed}/{nodeUsageSummary.podsCapacity || msg('auto.remoteK8sManager.notAvailable')}</span></div> : null}
      <table className="k8s-manager-table"><thead><tr><th>{msg('auto.remoteK8sManager.podName')}</th><th>{msg('auto.remoteK8sManager.podStatus')}</th><th>{msg('auto.remoteK8sManager.roles')}</th><th>{msg('auto.remoteK8sManager.internalIp')}</th><th>{msg('auto.remoteK8sManager.osImage')}</th><th>{msg('auto.remoteK8sManager.kubeletVersion')}</th><th>{msg('auto.remoteK8sManager.podAge')}</th></tr></thead><tbody>
        {nodes.map((node) => <tr key={node.name} onClick={() => void loadNodeDetail(node)}><td><strong>{node.name}</strong></td><td><span className={`k8s-manager-status-badge ${statusClass(node.status)}`}>{statusLabel(node.status)}</span></td><td>{node.roles}</td><td>{node.internalIP}</td><td>{node.osImage}</td><td>{node.kubeletVersion}</td><td>{node.age}</td></tr>)}
        {!nodes.length ? <tr><td colSpan={7} className="k8s-manager-empty">{msg('auto.remoteK8sManager.emptyNodes')}</td></tr> : null}
      </tbody></table>
    </>
  );

  return (
    <div className="k8s-manager-container">
      <header className="k8s-manager-header">
        <strong>{msg('auto.remoteK8sManager.appName')}</strong>
        <div className="k8s-manager-toolbar">
          <select value={selectedNamespace} onChange={(event) => setSelectedNamespace(event.target.value)} aria-label={msg('auto.remoteK8sManager.podNamespace')}>
            <option value="">{msg('auto.remoteK8sManager.allNamespaces')}</option>
            {namespaces.map((namespace) => <option key={namespace.name} value={namespace.name}>{namespace.name} ({namespacePodCounts[namespace.name] ?? 0})</option>)}
          </select>
          <span>{kubectlVersion || msg(`auto.remoteK8sManager.kubectlStatus.${kubectlStatus}`)}</span>
          <button type="button" onClick={() => void refreshAll()} disabled={loading}>{msg('auto.remoteK8sManager.refresh')}</button>
        </div>
      </header>

      {error ? <DismissibleAlert className="k8s-manager-error danger" onDismiss={() => setError(null)} role="alert">{error}</DismissibleAlert> : null}
      {notice ? <DismissibleAlert className="k8s-manager-error info" onDismiss={() => setNotice(null)}>{notice}</DismissibleAlert> : null}

      <section className="k8s-manager-searchbar">
        <input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder={msg('auto.remoteK8sManager.searchPlaceholder')} aria-label={msg('auto.remoteK8sManager.searchPlaceholder')} />
        <div className="k8s-manager-filters" role="group" aria-label={msg('auto.remoteK8sManager.podStatus')}>
          {podFilters.map((filter) => <button key={filter.key} type="button" className={podFilter === filter.key ? 'active' : ''} onClick={() => setPodFilter(filter.key)}>{msg(filter.labelId)}</button>)}
        </div>
      </section>

      <nav className="k8s-manager-tabs" role="tablist">{tabs.map((tab) => <button key={tab.key} type="button" className={activeTab === tab.key ? 'active' : ''} onClick={() => setActiveTab(tab.key)}>{msg(tab.labelId)}</button>)}</nav>

      <main className="k8s-manager-content">
        {kubectlStatus === 'unavailable' ? <div className="k8s-manager-empty">{msg('auto.remoteK8sManager.kubectlNotFound')}</div> : null}
        {kubectlStatus !== 'unavailable' && activeTab === 'pods' ? renderPods() : null}
        {kubectlStatus !== 'unavailable' && activeTab === 'workloads' ? renderWorkloads() : null}
        {kubectlStatus !== 'unavailable' && activeTab === 'services' ? renderServices() : null}
        {kubectlStatus !== 'unavailable' && activeTab === 'configmaps' ? renderConfigMaps() : null}
        {kubectlStatus !== 'unavailable' && activeTab === 'secrets' ? renderSecrets() : null}
        {kubectlStatus !== 'unavailable' && activeTab === 'nodes' ? renderNodes() : null}
      </main>

      {detailWorkload ? <K8sWorkloadDetailPanel workload={detailWorkload} loading={loading} onClose={() => setDetailWorkload(null)} onScale={(workload) => setScaleDialog({ workload, replicas: workload.desired })} onRestart={setPendingRestartWorkload} onRolloutStatus={(workload) => void showWorkloadRolloutStatus(workload)} onViewYaml={(workload) => void showWorkloadYaml(workload)} /> : null}
      {resourceDetail ? <K8sResourceDetailPanel detail={resourceDetail} loading={loading} onClose={() => setResourceDetail(null)} onEdit={openYamlEditor} onDelete={(detail) => setPendingDeleteResource({ kind: detail.kind, name: detail.name, namespace: detail.namespace })} /> : null}
      {detailNode ? <K8sNodeDetailPanel node={detailNode} onClose={() => setDetailNode(null)} /> : null}

      <footer className="k8s-manager-footer">
        <span>{msg('auto.remoteK8sManager.contextLabel', { value0: currentContext || '-' })}</span>
        <span>{msg('auto.remoteK8sManager.namespaceCount', { value0: namespaces.length })}</span>
        <span>{msg('auto.remoteK8sManager.podCount', { value0: namespacePods.length })}</span>
        {contexts.length ? <span>{contexts.find((context) => context.isCurrent)?.cluster ?? ''}</span> : null}
      </footer>

      {detailPod ? <K8sPodDetailPanel detail={podDetail} logs={podLogs} loading={loading} onClose={() => setDetailPod(null)} onViewLogs={showPodLogs} onExecTerminal={() => setNotice(msg('auto.remoteK8sManager.execTerminalNote'))} onDelete={(pod) => setPendingDeletePod({ name: pod.pod.name, namespace: pod.pod.namespace })} /> : null}
      {scaleDialog ? createPortal(<div className="k8s-manager-modal-overlay" role="presentation" onClick={() => setScaleDialog(null)}><div className="k8s-manager-modal" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}><strong>{msg('auto.remoteK8sManager.scaleTitle')}</strong><p>{scaleDialog.workload.namespace}/{scaleDialog.workload.name}</p><label className="k8s-manager-modal-field"><span>{msg('auto.remoteK8sManager.scaleCurrent')}</span><input value={scaleDialog.workload.desired} readOnly /></label><label className="k8s-manager-modal-field"><span>{msg('auto.remoteK8sManager.scaleNew')}</span><input type="number" min={0} step={1} value={scaleDialog.replicas} onChange={(event) => setScaleDialog((current) => current ? { ...current, replicas: Math.max(0, Number.parseInt(event.target.value || '0', 10)) } : current)} /></label><div><button type="button" onClick={() => setScaleDialog(null)} disabled={loading}>{msg('common.cancel')}</button><button type="button" onClick={() => void confirmScaleWorkload()} disabled={loading}>{msg('auto.remoteK8sManager.scaleConfirm')}</button></div></div></div>, document.body) : null}
      {pendingRestartWorkload ? createPortal(<div className="k8s-manager-modal-overlay" role="presentation" onClick={() => setPendingRestartWorkload(null)}><div className="k8s-manager-modal" role="alertdialog" aria-modal="true" onClick={(event) => event.stopPropagation()}><strong>{msg('auto.remoteK8sManager.restartButton')}</strong><p>{msg('auto.remoteK8sManager.restartConfirm', { value0: `${pendingRestartWorkload.namespace}/${pendingRestartWorkload.name}` })}</p><div><button type="button" onClick={() => setPendingRestartWorkload(null)} disabled={loading}>{msg('common.cancel')}</button><button type="button" onClick={() => void restartWorkload()} disabled={loading}>{msg('auto.remoteK8sManager.restartButton')}</button></div></div></div>, document.body) : null}
      {outputDialog ? createPortal(<div className="k8s-manager-modal-overlay" role="presentation" onClick={() => setOutputDialog(null)}><div className="k8s-manager-modal k8s-manager-output-modal" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}><strong>{outputDialog.title}</strong><textarea className="k8s-manager-logs" readOnly value={outputDialog.output} aria-label={outputDialog.title} /><div><button type="button" onClick={() => setOutputDialog(null)}>{msg('auto.remoteK8sManager.close')}</button></div></div></div>, document.body) : null}
      {yamlEditor ? createPortal(<div className="k8s-manager-modal-overlay" role="presentation" onClick={() => setYamlEditor(null)}><div className="k8s-manager-modal k8s-manager-output-modal" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}><strong>{msg('auto.remoteK8sManager.editYaml')} · {yamlEditor.namespace}/{yamlEditor.name}</strong><label className="k8s-manager-editor-label"><span>{msg('auto.remoteK8sManager.yamlEditor')}</span><textarea className="k8s-manager-logs" value={yamlEditor.yaml} onChange={(event) => setYamlEditor((current) => current ? { ...current, yaml: event.target.value } : current)} aria-label={msg('auto.remoteK8sManager.yamlEditor')} /></label><div><button type="button" onClick={() => setYamlEditor(null)} disabled={loading}>{msg('auto.remoteK8sManager.cancelButton')}</button><button type="button" onClick={() => void saveYamlEditor()} disabled={loading}>{msg('auto.remoteK8sManager.saveButton')}</button></div></div></div>, document.body) : null}
      {pendingDeletePod ? createPortal(<div className="k8s-manager-modal-overlay" role="presentation" onClick={() => setPendingDeletePod(null)}><div className="k8s-manager-modal" role="alertdialog" aria-modal="true" onClick={(event) => event.stopPropagation()}><strong>{msg('auto.remoteK8sManager.deletePod')}</strong><p>{msg('auto.remoteK8sManager.confirmDelete', { value0: pendingDeletePod.name })}</p><div><button type="button" onClick={() => setPendingDeletePod(null)}>{msg('auto.remoteK8sManager.close')}</button><button type="button" className="danger" onClick={() => void deletePod()} disabled={loading}>{msg('auto.remoteK8sManager.deletePod')}</button></div></div></div>, document.body) : null}
      {pendingDeleteResource ? createPortal(<div className="k8s-manager-modal-overlay" role="presentation" onClick={() => setPendingDeleteResource(null)}><div className="k8s-manager-modal" role="alertdialog" aria-modal="true" onClick={(event) => event.stopPropagation()}><strong>{msg('auto.remoteK8sManager.deleteButton')}</strong><p>{msg('auto.remoteK8sManager.confirmDelete', { value0: `${pendingDeleteResource.namespace}/${pendingDeleteResource.name}` })}</p><div><button type="button" onClick={() => setPendingDeleteResource(null)}>{msg('auto.remoteK8sManager.cancelButton')}</button><button type="button" className="danger" onClick={() => void deleteResource()} disabled={loading}>{msg('auto.remoteK8sManager.deleteButton')}</button></div></div></div>, document.body) : null}
      {sudoPrompt}
    </div>
  );
}

export function K8sPodDetailPanel({ detail, logs, loading, onClose, onViewLogs, onExecTerminal, onDelete }: {
  detail: K8sPodDetail | null;
  logs: string;
  loading: boolean;
  onClose: () => void;
  onViewLogs: (detail: K8sPodDetail) => void;
  onExecTerminal: () => void;
  onDelete: (detail: K8sPodDetail) => void;
}) {
  return (
    <aside className="k8s-manager-pod-detail" aria-label={msg('auto.remoteK8sManager.basicInfo')}>
      <header><strong>{detail?.pod.name ?? msg('auto.remoteK8sManager.podName')}</strong><button type="button" onClick={onClose} aria-label={msg('auto.remoteK8sManager.close')}>×</button></header>
      {!detail ? <div className="k8s-manager-empty">{loading ? msg('auto.remoteK8sManager.loading') : msg('auto.remoteK8sManager.podDetailFailed')}</div> : (
        <>
          <section><h3>{msg('auto.remoteK8sManager.basicInfo')}</h3><dl className="k8s-manager-info-grid"><div><dt>{msg('auto.remoteK8sManager.podName')}</dt><dd>{detail.pod.name}</dd></div><div><dt>{msg('auto.remoteK8sManager.podNamespace')}</dt><dd>{detail.pod.namespace}</dd></div><div><dt>{msg('auto.remoteK8sManager.podNode')}</dt><dd>{detail.nodeName || '-'}</dd></div><div><dt>{msg('auto.remoteK8sManager.podIp')}</dt><dd>{detail.podIP || '-'}</dd></div><div><dt>{msg('auto.remoteK8sManager.podStatus')}</dt><dd>{statusLabel(detail.pod.status)}</dd></div><div><dt>{msg('auto.remoteK8sManager.qosClass')}</dt><dd>{detail.qosClass || '-'}</dd></div><div><dt>{msg('auto.remoteK8sManager.serviceAccount')}</dt><dd>{detail.serviceAccount || '-'}</dd></div></dl></section>
          <section><h3>{msg('auto.remoteK8sManager.labels')}</h3><KeyValueTable values={detail.labels} /></section>
          <section><h3>{msg('auto.remoteK8sManager.containers')}</h3><table className="k8s-manager-table"><thead><tr><th>{msg('auto.remoteK8sManager.podName')}</th><th>{msg('auto.remoteK8sManager.images')}</th><th>{msg('auto.remoteK8sManager.state')}</th><th>{msg('auto.remoteK8sManager.ready')}</th><th>{msg('auto.remoteK8sManager.podRestarts')}</th></tr></thead><tbody>{detail.containers.map((container) => <tr key={container.name}><td>{container.name}</td><td>{container.image}</td><td>{container.stateDetail || container.state}</td><td>{container.ready ? msg('auto.remoteK8sManager.yes') : msg('auto.remoteK8sManager.no')}</td><td>{container.restartCount}</td></tr>)}</tbody></table></section>
          <section><h3>{msg('auto.remoteK8sManager.conditions')}</h3><table className="k8s-manager-table"><thead><tr><th>{msg('auto.remoteK8sManager.type')}</th><th>{msg('auto.remoteK8sManager.podStatus')}</th><th>{msg('auto.remoteK8sManager.reason')}</th><th>{msg('auto.remoteK8sManager.message')}</th></tr></thead><tbody>{detail.conditions.map((condition) => <tr key={condition.type}><td>{condition.type}</td><td>{statusLabel(condition.status)}</td><td>{condition.reason || '-'}</td><td>{condition.message || '-'}</td></tr>)}</tbody></table></section>
          <section><h3>{msg('auto.remoteK8sManager.events')}</h3><table className="k8s-manager-table"><thead><tr><th>{msg('auto.remoteK8sManager.type')}</th><th>{msg('auto.remoteK8sManager.reason')}</th><th>{msg('auto.remoteK8sManager.message')}</th><th>{msg('auto.remoteK8sManager.count')}</th><th>{msg('auto.remoteK8sManager.lastSeen')}</th></tr></thead><tbody>{detail.events.map((event) => <tr key={`${event.reason}/${event.lastTimestamp}/${event.count}`} className={event.type.toLowerCase() === 'warning' ? 'is-warning' : ''}><td>{event.type}</td><td>{event.reason}</td><td>{event.message}</td><td>{event.count}</td><td>{formatDateTime(event.lastTimestamp)}</td></tr>)}</tbody></table></section>
          {logs ? <textarea className="k8s-manager-logs" readOnly value={logs} aria-label={msg('auto.remoteK8sManager.viewLogs')} /> : null}
          <footer><button type="button" onClick={() => void onViewLogs(detail)} disabled={loading}>{msg('auto.remoteK8sManager.viewLogs')}</button><button type="button" onClick={onExecTerminal}>{msg('auto.remoteK8sManager.execTerminal')}</button><button type="button" className="danger" onClick={() => onDelete(detail)} disabled={loading}>{msg('auto.remoteK8sManager.deletePod')}</button></footer>
        </>
      )}
    </aside>
  );
}

function K8sWorkloadDetailPanel({ workload, loading, onClose, onScale, onRestart, onRolloutStatus, onViewYaml }: {
  workload: K8sWorkloadSummary;
  loading: boolean;
  onClose: () => void;
  onScale: (workload: K8sWorkloadSummary) => void;
  onRestart: (workload: K8sWorkloadSummary) => void;
  onRolloutStatus: (workload: K8sWorkloadSummary) => void;
  onViewYaml: (workload: K8sWorkloadSummary) => void;
}) {
  return (
    <aside className="k8s-manager-pod-detail" aria-label={msg('auto.remoteK8sManager.basicInfo')}>
      <header><strong>{workload.name}</strong><button type="button" onClick={onClose} aria-label={msg('auto.remoteK8sManager.close')}>×</button></header>
      <section><h3>{msg('auto.remoteK8sManager.basicInfo')}</h3><dl className="k8s-manager-info-grid"><div><dt>{msg('auto.remoteK8sManager.podName')}</dt><dd>{workload.name}</dd></div><div><dt>{msg('auto.remoteK8sManager.podNamespace')}</dt><dd>{workload.namespace}</dd></div><div><dt>{msg('auto.remoteK8sManager.type')}</dt><dd>{workload.kind}</dd></div><div><dt>{msg('auto.remoteK8sManager.scaleCurrent')}</dt><dd>{workload.desired}</dd></div><div><dt>{msg('auto.remoteK8sManager.ready')}</dt><dd>{workload.ready}</dd></div><div><dt>{msg('auto.remoteK8sManager.upToDate')}</dt><dd>{workload.upToDate}</dd></div><div><dt>{msg('auto.remoteK8sManager.available')}</dt><dd>{workload.available ?? '-'}</dd></div><div><dt>{msg('auto.remoteK8sManager.selector')}</dt><dd>{workload.selector || '-'}</dd></div></dl></section>
      <section><h3>{msg('auto.remoteK8sManager.images')}</h3><KeyValueTable values={Object.fromEntries(workload.images.map((image, index) => [`${index + 1}`, image]))} emptyId="auto.remoteK8sManager.noData" /></section>
      <footer><button type="button" onClick={() => onScale(workload)} disabled={loading}>{msg('auto.remoteK8sManager.scaleButton')}</button><button type="button" onClick={() => onRestart(workload)} disabled={loading}>{msg('auto.remoteK8sManager.restartButton')}</button><button type="button" onClick={() => onRolloutStatus(workload)} disabled={loading}>{msg('auto.remoteK8sManager.rolloutStatus')}</button><button type="button" onClick={() => onViewYaml(workload)} disabled={loading}>{msg('auto.remoteK8sManager.viewYaml')}</button></footer>
    </aside>
  );
}

function K8sResourceDetailPanel({ detail, loading, onClose, onEdit, onDelete }: {
  detail: K8sResourceDetail;
  loading: boolean;
  onClose: () => void;
  onEdit: (detail: K8sResourceDetail) => void;
  onDelete: (detail: K8sResourceDetail) => void;
}) {
  const titleId = detail.kind === 'service'
    ? 'auto.remoteK8sManager.serviceDetail'
    : detail.kind === 'configmap'
      ? 'auto.remoteK8sManager.configMapDetail'
      : 'auto.remoteK8sManager.secretDetail';

  return (
    <aside className="k8s-manager-pod-detail" aria-label={msg(titleId)}>
      <header><strong>{msg(titleId)} · {detail.title}</strong><button type="button" onClick={onClose} aria-label={msg('auto.remoteK8sManager.close')}>×</button></header>
      {loading ? <div className="k8s-manager-empty">{msg('auto.remoteK8sManager.loading')}</div> : detail.kind === 'service' ? (
        <section><h3>{msg('auto.remoteK8sManager.basicInfo')}</h3><dl className="k8s-manager-info-grid"><div><dt>{msg('auto.remoteK8sManager.podName')}</dt><dd>{detail.service.name}</dd></div><div><dt>{msg('auto.remoteK8sManager.podNamespace')}</dt><dd>{detail.service.namespace}</dd></div><div><dt>{msg('auto.remoteK8sManager.type')}</dt><dd>{detail.service.type || '-'}</dd></div><div><dt>{msg('auto.remoteK8sManager.clusterIP')}</dt><dd>{detail.service.clusterIP || '-'}</dd></div><div><dt>{msg('auto.remoteK8sManager.externalIP')}</dt><dd>{detail.service.externalIP || '-'}</dd></div><div><dt>{msg('auto.remoteK8sManager.ports')}</dt><dd>{detail.service.ports || '-'}</dd></div><div><dt>{msg('auto.remoteK8sManager.selector')}</dt><dd>{detail.service.selector || '-'}</dd></div></dl></section>
      ) : (
        <section><h3>{detail.kind === 'secret' ? msg('auto.remoteK8sManager.secretDetail') : msg('auto.remoteK8sManager.configMapDetail')}</h3><KeyValueTable values={detail.values} emptyId="auto.remoteK8sManager.noData" /></section>
      )}
      <footer><button type="button" onClick={() => onEdit(detail)} disabled={loading}>{msg('auto.remoteK8sManager.editButton')}</button><button type="button" className="danger" onClick={() => onDelete(detail)} disabled={loading}>{msg('auto.remoteK8sManager.deleteButton')}</button></footer>
    </aside>
  );
}

function K8sNodeDetailPanel({ node, onClose }: {
  node: K8sNode;
  onClose: () => void;
}) {
  return (
    <aside className="k8s-manager-pod-detail" aria-label={msg('auto.remoteK8sManager.nodesTab')}>
      <header><strong>{node.name}</strong><button type="button" onClick={onClose} aria-label={msg('auto.remoteK8sManager.close')}>×</button></header>
      <section>
        <h3>{msg('auto.remoteK8sManager.conditions')}</h3>
        <table className="k8s-manager-table"><thead><tr><th>{msg('auto.remoteK8sManager.type')}</th><th>{msg('auto.remoteK8sManager.podStatus')}</th><th>{msg('auto.remoteK8sManager.reason')}</th><th>{msg('auto.remoteK8sManager.message')}</th><th>{msg('auto.remoteK8sManager.lastSeen')}</th></tr></thead><tbody>{node.conditions.map((condition) => <tr key={condition.type}><td>{condition.type}</td><td>{statusLabel(condition.status)}</td><td>{condition.reason || '-'}</td><td>{condition.message || '-'}</td><td>{formatDateTime(condition.lastHeartbeatTime || '')}</td></tr>)}</tbody></table>
      </section>
      <section>
        <h3>{msg('auto.remoteK8sManager.capacity')} / {msg('auto.remoteK8sManager.allocatable')}</h3>
        <dl className="k8s-manager-info-grid"><div><dt>{msg('auto.remoteK8sManager.cpu')}</dt><dd>{node.cpuCapacity || '-'} / {node.cpuAllocatable || '-'}</dd></div><div><dt>{msg('auto.remoteK8sManager.memory')}</dt><dd>{node.memoryCapacity || '-'} / {node.memoryAllocatable || '-'}</dd></div><div><dt>{msg('auto.remoteK8sManager.pods')}</dt><dd>{node.podCapacity || '-'} / {node.podAllocatable || '-'}</dd></div></dl>
      </section>
      <section>
        <h3>{msg('auto.remoteK8sManager.systemInfo')}</h3>
        <dl className="k8s-manager-info-grid"><div><dt>{msg('auto.remoteK8sManager.osImage')}</dt><dd>{node.osImage || '-'}</dd></div><div><dt>{msg('auto.remoteK8sManager.systemInfo')}</dt><dd>{node.kernelVersion || '-'}</dd></div><div><dt>{msg('auto.remoteK8sManager.type')}</dt><dd>{node.containerRuntime || '-'}</dd></div><div><dt>{msg('auto.remoteK8sManager.kubeletVersion')}</dt><dd>{node.kubeletVersion || '-'}</dd></div></dl>
      </section>
      <section><h3>{msg('auto.remoteK8sManager.labels')}</h3><KeyValueTable values={node.labels} /></section>
      <section><h3>{msg('auto.remoteK8sManager.taints')}</h3>{node.taints.length ? <table className="k8s-manager-table"><thead><tr><th>{msg('auto.remoteK8sManager.dataKey')}</th><th>{msg('auto.remoteK8sManager.dataValue')}</th><th>{msg('auto.remoteK8sManager.type')}</th></tr></thead><tbody>{node.taints.map((taint) => <tr key={`${taint.key}/${taint.effect}`}><td>{taint.key}</td><td>{taint.value || '-'}</td><td>{taint.effect || '-'}</td></tr>)}</tbody></table> : <div className="k8s-manager-empty">{msg('auto.remoteK8sManager.noData')}</div>}</section>
    </aside>
  );
}

function KeyValueTable({ values, emptyId = 'auto.remoteK8sManager.emptyLabels' }: { values: Record<string, string>; emptyId?: string }) {
  const entries = Object.entries(values);
  if (!entries.length) return <div className="k8s-manager-empty">{msg(emptyId)}</div>;
  return <table className="k8s-manager-table"><thead><tr><th>{msg('auto.remoteK8sManager.dataKey')}</th><th>{msg('auto.remoteK8sManager.dataValue')}</th></tr></thead><tbody>{entries.map(([key, value]) => <tr key={key}><td>{key}</td><td><code>{value}</code></td></tr>)}</tbody></table>;
}

export default RemoteK8sManager;

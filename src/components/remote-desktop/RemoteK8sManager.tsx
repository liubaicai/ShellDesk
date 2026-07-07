import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { tCurrent, type MessageId, type MessageParams } from '../../i18n';
import DismissibleAlert from './DismissibleAlert';
import { getErrorMessage, formatDateTime } from './desktopUtils';
import {
  getConfigMapListCommand,
  getConfigViewCommand,
  getDaemonSetListCommand,
  getDeploymentListCommand,
  getKubectlDetectCommand,
  getKubectlVersionCommand,
  getNamespaceListCommand,
  getNodeListCommand,
  getPodDeleteCommand,
  getPodDetailCommand,
  getPodEventsCommand,
  getPodListCommand,
  getPodLogsCommand,
  getSecretListCommand,
  getServiceListCommand,
  getStatefulSetListCommand,
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
type KeyValueDetail = { title: string; values: Record<string, string> } | null;
type PendingDeletePod = { name: string; namespace: string } | null;

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
  const [keyValueDetail, setKeyValueDetail] = useState<KeyValueDetail>(null);
  const [pendingDeletePod, setPendingDeletePod] = useState<PendingDeletePod>(null);
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
      const result = await runCommand(getNodeListCommand());
      const failure = commandError(result);
      if (failure) throw new Error(failure);
      setNodes(parseKubectlList<RawRecord>(result.stdout).map(parseNode));
    } catch (err) {
      setError(getErrorMessage(err));
      setNodes([]);
    } finally {
      setLoading(false);
    }
  }, [runCommand]);

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
      <table className="k8s-manager-table"><thead><tr><th>{msg('auto.remoteK8sManager.podName')}</th><th>{msg('auto.remoteK8sManager.podNamespace')}</th><th>{msg('auto.remoteK8sManager.desired')}</th><th>{msg('auto.remoteK8sManager.ready')}</th><th>{msg('auto.remoteK8sManager.upToDate')}</th><th>{msg('auto.remoteK8sManager.available')}</th><th>{msg('auto.remoteK8sManager.podAge')}</th><th>{msg('auto.remoteK8sManager.images')}</th></tr></thead><tbody>
        {workloads.map((item) => <tr key={`${item.kind}/${item.namespace}/${item.name}`} onClick={() => setNotice(`${item.kind}: ${item.namespace}/${item.name}`)}><td><strong>{item.name}</strong></td><td>{item.namespace}</td><td>{item.desired}</td><td>{item.ready}</td><td>{item.upToDate}</td><td>{item.available ?? '-'}</td><td>{item.age}</td><td title={item.images.join(', ')}>{item.images.join(', ') || '-'}</td></tr>)}
        {!workloads.length ? <tr><td colSpan={8} className="k8s-manager-empty">{msg('auto.remoteK8sManager.emptyWorkloads')}</td></tr> : null}
      </tbody></table>
    </>
  );

  const renderServices = () => (
    <table className="k8s-manager-table"><thead><tr><th>{msg('auto.remoteK8sManager.podName')}</th><th>{msg('auto.remoteK8sManager.podNamespace')}</th><th>{msg('auto.remoteK8sManager.type')}</th><th>{msg('auto.remoteK8sManager.clusterIp')}</th><th>{msg('auto.remoteK8sManager.ports')}</th><th>{msg('auto.remoteK8sManager.podAge')}</th></tr></thead><tbody>
      {services.map((service) => <tr key={`${service.namespace}/${service.name}`}><td><strong>{service.name}</strong></td><td>{service.namespace}</td><td>{service.type}</td><td>{service.clusterIP}</td><td>{service.ports}</td><td>{service.age}</td></tr>)}
      {!services.length ? <tr><td colSpan={6} className="k8s-manager-empty">{msg('auto.remoteK8sManager.emptyServices')}</td></tr> : null}
    </tbody></table>
  );

  const renderConfigMaps = () => (
    <table className="k8s-manager-table"><thead><tr><th>{msg('auto.remoteK8sManager.podName')}</th><th>{msg('auto.remoteK8sManager.podNamespace')}</th><th>{msg('auto.remoteK8sManager.dataKeys')}</th><th>{msg('auto.remoteK8sManager.podAge')}</th></tr></thead><tbody>
      {configMaps.map((item) => <tr key={`${item.namespace}/${item.name}`} onClick={() => setKeyValueDetail({ title: `${item.namespace}/${item.name}`, values: item.data })}><td><strong>{item.name}</strong></td><td>{item.namespace}</td><td>{item.dataKeys}</td><td>{item.age}</td></tr>)}
      {!configMaps.length ? <tr><td colSpan={4} className="k8s-manager-empty">{msg('auto.remoteK8sManager.emptyConfigMaps')}</td></tr> : null}
    </tbody></table>
  );

  const renderSecrets = () => (
    <table className="k8s-manager-table"><thead><tr><th>{msg('auto.remoteK8sManager.podName')}</th><th>{msg('auto.remoteK8sManager.podNamespace')}</th><th>{msg('auto.remoteK8sManager.type')}</th><th>{msg('auto.remoteK8sManager.dataItems')}</th><th>{msg('auto.remoteK8sManager.podAge')}</th></tr></thead><tbody>
      {secrets.map((item) => <tr key={`${item.namespace}/${item.name}`} onClick={() => setKeyValueDetail({ title: `${item.namespace}/${item.name}`, values: Object.fromEntries(Object.keys(item.data).map((key) => [key, '••••••'])) })}><td><strong>{item.name}</strong></td><td>{item.namespace}</td><td>{item.type}</td><td>{item.dataCount}</td><td>{item.age}</td></tr>)}
      {!secrets.length ? <tr><td colSpan={5} className="k8s-manager-empty">{msg('auto.remoteK8sManager.emptySecrets')}</td></tr> : null}
    </tbody></table>
  );

  const renderNodes = () => (
    <table className="k8s-manager-table"><thead><tr><th>{msg('auto.remoteK8sManager.podName')}</th><th>{msg('auto.remoteK8sManager.podStatus')}</th><th>{msg('auto.remoteK8sManager.roles')}</th><th>{msg('auto.remoteK8sManager.internalIp')}</th><th>{msg('auto.remoteK8sManager.osImage')}</th><th>{msg('auto.remoteK8sManager.kubeletVersion')}</th><th>{msg('auto.remoteK8sManager.podAge')}</th></tr></thead><tbody>
      {nodes.map((node) => <tr key={node.name}><td><strong>{node.name}</strong></td><td><span className={`k8s-manager-status-badge ${statusClass(node.status)}`}>{statusLabel(node.status)}</span></td><td>{node.roles}</td><td>{node.internalIP}</td><td>{node.osImage}</td><td>{node.kubeletVersion}</td><td>{node.age}</td></tr>)}
      {!nodes.length ? <tr><td colSpan={7} className="k8s-manager-empty">{msg('auto.remoteK8sManager.emptyNodes')}</td></tr> : null}
    </tbody></table>
  );

  return (
    <div className="k8s-manager-container">
      <header className="k8s-manager-header">
        <strong>{msg('auto.remoteK8sManager.appName')}</strong>
        <div className="k8s-manager-toolbar">
          <select value={selectedNamespace} onChange={(event) => setSelectedNamespace(event.target.value)} aria-label={msg('auto.remoteK8sManager.podNamespace')}>
            <option value="">{msg('auto.remoteK8sManager.allNamespaces')}</option>
            {namespaces.map((namespace) => <option key={namespace.name} value={namespace.name}>{namespace.name}</option>)}
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

      {keyValueDetail ? <section className="k8s-manager-key-values"><header><strong>{keyValueDetail.title}</strong><button type="button" onClick={() => setKeyValueDetail(null)}>{msg('auto.remoteK8sManager.close')}</button></header><table className="k8s-manager-table"><tbody>{Object.entries(keyValueDetail.values).map(([key, value]) => <tr key={key}><td>{key}</td><td><code>{value}</code></td></tr>)}</tbody></table></section> : null}

      <footer className="k8s-manager-footer">
        <span>{msg('auto.remoteK8sManager.contextLabel', { value0: currentContext || '-' })}</span>
        <span>{msg('auto.remoteK8sManager.namespaceCount', { value0: namespaces.length })}</span>
        <span>{msg('auto.remoteK8sManager.podCount', { value0: namespacePods.length })}</span>
        {contexts.length ? <span>{contexts.find((context) => context.isCurrent)?.cluster ?? ''}</span> : null}
      </footer>

      {detailPod ? <K8sPodDetailPanel detail={podDetail} logs={podLogs} loading={loading} onClose={() => setDetailPod(null)} onViewLogs={showPodLogs} onExecTerminal={() => setNotice(msg('auto.remoteK8sManager.execTerminalNote'))} onDelete={(pod) => setPendingDeletePod({ name: pod.pod.name, namespace: pod.pod.namespace })} /> : null}
      {pendingDeletePod ? createPortal(<div className="k8s-manager-modal-overlay" role="presentation" onClick={() => setPendingDeletePod(null)}><div className="k8s-manager-modal" role="alertdialog" aria-modal="true" onClick={(event) => event.stopPropagation()}><strong>{msg('auto.remoteK8sManager.deletePod')}</strong><p>{msg('auto.remoteK8sManager.confirmDelete', { value0: pendingDeletePod.name })}</p><div><button type="button" onClick={() => setPendingDeletePod(null)}>{msg('auto.remoteK8sManager.close')}</button><button type="button" className="danger" onClick={() => void deletePod()} disabled={loading}>{msg('auto.remoteK8sManager.deletePod')}</button></div></div></div>, document.body) : null}
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

function KeyValueTable({ values }: { values: Record<string, string> }) {
  const entries = Object.entries(values);
  if (!entries.length) return <div className="k8s-manager-empty">{msg('auto.remoteK8sManager.emptyLabels')}</div>;
  return <table className="k8s-manager-table"><tbody>{entries.map(([key, value]) => <tr key={key}><td>{key}</td><td>{value}</td></tr>)}</tbody></table>;
}

export default RemoteK8sManager;

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Database, Monitor, Network, Pause, Play, Plus, Power, RefreshCw, Search, Server, Settings2, Terminal, Trash2 } from 'lucide-react';
import DismissibleAlert from './DismissibleAlert';
import { t, useCurrentAppLanguage, type MessageId } from '../../i18n';
import { getErrorMessage } from './desktopUtils';
import { isWindowsSystem } from './remoteSystem';
import { useSudoCommand } from './sudoPrompt';
import {
  getSnapshotActionCommand,
  getSnapshotCreateCommand,
  getVirshConsoleCommand,
  getVirshDetectCommand,
  getVirshDomainDetailCommand,
  getVirshNetworkActionCommand,
  getVirshResourcesCommand,
  getVirshStoragePoolActionCommand,
  getVirshStorageVolumeCreateCommand,
  getVirshStorageVolumeDeleteCommand,
  getVirtualMachineAttachDiskCommand,
  getVirtualMachineAttachInterfaceCommand,
  getVirtualMachineActionCommand,
  getVirtualMachineCloneCommand,
  getVirtualMachineCreateCommand,
  getVirtualMachineDefineXmlCommand,
  getVirtualMachineDeleteCommand,
  getVirtualMachineDetachDiskCommand,
  getVirtualMachineDetachInterfaceCommand,
  getVirtualMachineMigrationCommand,
  getVirtualMachineSettingsCommand,
} from './virshCommands';
import { parseVirshDomainDetail, parseVirshOverview, parseVirshResources, parseVncDisplayTarget } from './virshParsers';
import type {
  RemoteVirtualMachineManagerProps,
  VirshHostSummary,
  VirshNetworkAction,
  VirshNetworkSummary,
  VirshStoragePoolAction,
  VirshStoragePoolSummary,
  VirshStorageVolume,
  VirtualMachineAction,
  VirtualMachineDetail,
  VirtualMachineDetailTab,
  VirtualMachineManagerTab,
  VirtualMachineManagementDialog,
  VirtualMachinePendingAction,
  VirtualMachineSnapshot,
  VirtualMachineSnapshotForm,
  VirtualMachineState,
  VirtualMachineSummary,
} from './virshTypes';
import { VirtualMachineActionDialog, VirtualMachineSnapshotDialog } from './VirtualMachineDialogs';
import { VirtualMachineDetailPanel } from './VirtualMachineDetailPanel';
import { VirtualMachineManagementDialog as VirtualMachineManagementModal } from './VirtualMachineManagementDialog';

const managerTabs: Array<{ key: VirtualMachineManagerTab; labelId: MessageId; icon: typeof Monitor }> = [
  { key: 'domains', labelId: 'vm.tab.domains', icon: Monitor },
  { key: 'networks', labelId: 'vm.tab.networks', icon: Network },
  { key: 'storage', labelId: 'vm.tab.storage', icon: Database },
];

const uriSuggestions = ['qemu:///system', 'qemu:///session', 'xen:///', 'lxc:///system'];

function formatMemoryKiB(value: number, language: string) {
  if (!value) return '-';
  return new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(value / 1024 ** 2) + ' GiB';
}

function formatBytes(value: number, language: string) {
  if (!value) return '-';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let amount = value;
  let unitIndex = 0;
  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024;
    unitIndex += 1;
  }
  return `${new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(amount)} ${units[unitIndex]}`;
}

function formatPercent(value: number) {
  return `${Math.round(Math.max(0, Math.min(100, value)))}%`;
}

function getStateTone(state: VirtualMachineState) {
  if (state === 'running' || state === 'idle') return 'running';
  if (state === 'paused' || state === 'pmsuspended') return 'paused';
  if (state === 'crashed') return 'danger';
  return 'stopped';
}

function defaultHost(uri: string): VirshHostSummary {
  return { uri, virshVersion: '', hostname: '', hypervisor: '', cpuModel: '', cpuCount: 0, memoryKiB: 0 };
}

function RemoteVirtualMachineManager({ connectionId, systemType, onOpenTerminal, onOpenVnc }: RemoteVirtualMachineManagerProps) {
  const language = useCurrentAppLanguage();
  const isWindowsHost = isWindowsSystem(systemType);
  const { runCommand, sudoPrompt } = useSudoCommand(connectionId, systemType);
  const detailRequestIdRef = useRef(0);
  const isMountedRef = useRef(true);
  const [uri, setUri] = useState('qemu:///system');
  const [uriDraft, setUriDraft] = useState('qemu:///system');
  const [host, setHost] = useState<VirshHostSummary>(() => defaultHost('qemu:///system'));
  const [domains, setDomains] = useState<VirtualMachineSummary[]>([]);
  const [networks, setNetworks] = useState<VirshNetworkSummary[]>([]);
  const [pools, setPools] = useState<VirshStoragePoolSummary[]>([]);
  const [volumesByPool, setVolumesByPool] = useState<Map<string, VirshStorageVolume[]>>(() => new Map());
  const [activeTab, setActiveTab] = useState<VirtualMachineManagerTab>('domains');
  const [detailTab, setDetailTab] = useState<VirtualMachineDetailTab>('overview');
  const [selectedDomainUuid, setSelectedDomainUuid] = useState('');
  const [selectedPoolName, setSelectedPoolName] = useState('');
  const [detail, setDetail] = useState<VirtualMachineDetail | null>(null);
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query.trim().toLowerCase());
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [resourcesLoaded, setResourcesLoaded] = useState(false);
  const [actingKey, setActingKey] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [usedSudo, setUsedSudo] = useState(false);
  const [pendingAction, setPendingAction] = useState<VirtualMachinePendingAction | null>(null);
  const [confirmationValue, setConfirmationValue] = useState('');
  const [dialogError, setDialogError] = useState('');
  const [snapshotForm, setSnapshotForm] = useState<VirtualMachineSnapshotForm | null>(null);
  const [managementDialog, setManagementDialog] = useState<VirtualMachineManagementDialog | null>(null);

  const selectedDomain = useMemo(() => domains.find((domain) => domain.uuid === selectedDomainUuid) ?? null, [domains, selectedDomainUuid]);
  const visibleDomains = useMemo(() => domains.filter((domain) => {
    return !deferredQuery || `${domain.name} ${domain.uuid} ${domain.stateLabel}`.toLowerCase().includes(deferredQuery);
  }), [deferredQuery, domains]);
  const visibleNetworks = useMemo(() => networks.filter((network) => !deferredQuery || `${network.name} ${network.uuid} ${network.bridge}`.toLowerCase().includes(deferredQuery)), [deferredQuery, networks]);
  const visiblePools = useMemo(() => pools.filter((pool) => !deferredQuery || `${pool.name} ${pool.uuid} ${pool.state}`.toLowerCase().includes(deferredQuery)), [deferredQuery, pools]);
  const domainCounts = useMemo(() => ({
    total: domains.length,
    running: domains.filter((domain) => domain.state === 'running' || domain.state === 'idle').length,
    stopped: domains.filter((domain) => domain.state === 'shutoff' || domain.state === 'crashed').length,
    paused: domains.filter((domain) => domain.state === 'paused' || domain.state === 'pmsuspended').length,
  }), [domains]);
  const allocationSummary = useMemo(() => {
    const assignedVcpus = domains.reduce((total, domain) => total + domain.vcpus, 0);
    const assignedMemoryKiB = domains.reduce((total, domain) => total + domain.maxMemoryKiB, 0);
    const storageCapacityBytes = pools.reduce((total, pool) => total + pool.capacityBytes, 0);
    const storageAllocationBytes = pools.reduce((total, pool) => total + pool.allocationBytes, 0);
    return {
      assignedVcpus,
      assignedMemoryKiB,
      cpuPercent: host.cpuCount ? (assignedVcpus / host.cpuCount) * 100 : 0,
      memoryPercent: host.memoryKiB ? (assignedMemoryKiB / host.memoryKiB) * 100 : 0,
      storageCapacityBytes,
      storageAllocationBytes,
      storagePercent: storageCapacityBytes ? (storageAllocationBytes / storageCapacityBytes) * 100 : 0,
    };
  }, [domains, host.cpuCount, host.memoryKiB, pools]);

  const loadDetail = useCallback(async (domain: VirtualMachineSummary) => {
    const requestId = detailRequestIdRef.current + 1;
    detailRequestIdRef.current = requestId;
    setDetailLoading(true);
    try {
      const result = await runCommand(getVirshDomainDetailCommand(uri, domain.uuid), undefined, { onSudoAttempt: () => setUsedSudo(true) });
      if (result.code !== 0 && !result.stdout) throw new Error(result.stderr || t('vm.error.detail', language));
      const nextDetail = parseVirshDomainDetail(result.stdout, domain);
      if (isMountedRef.current && requestId === detailRequestIdRef.current) setDetail(nextDetail);
    } catch (nextError) {
      if (isMountedRef.current && requestId === detailRequestIdRef.current) setError(getErrorMessage(nextError));
    } finally {
      if (isMountedRef.current && requestId === detailRequestIdRef.current) setDetailLoading(false);
    }
  }, [language, runCommand, uri]);

  const refreshResources = useCallback(async (silent = false, targetUri = uri) => {
    if (!silent) setLoading(true);
    try {
      const result = await runCommand(getVirshResourcesCommand(targetUri), undefined, { onSudoAttempt: () => setUsedSudo(true) });
      if (result.code !== 0 && !result.stdout) throw new Error(result.stderr || t('vm.error.resources', language));
      const parsed = parseVirshResources(result.stdout);
      if (!isMountedRef.current) return;
      setNetworks(parsed.networks);
      setPools(parsed.pools);
      setVolumesByPool(parsed.volumesByPool);
      setResourcesLoaded(true);
      setSelectedPoolName((current) => current && parsed.pools.some((pool) => pool.name === current) ? current : parsed.pools[0]?.name ?? '');
    } catch (nextError) {
      if (isMountedRef.current) setError(getErrorMessage(nextError));
    } finally {
      if (isMountedRef.current && !silent) setLoading(false);
    }
  }, [language, runCommand, uri]);

  const refreshAll = useCallback(async () => {
    if (isWindowsHost) return;
    const targetUri = uriDraft.trim() || 'qemu:///system';
    setLoading(true);
    setError('');
    setNotice('');
    setResourcesLoaded(false);
    setUsedSudo(false);
    try {
      const result = await runCommand(getVirshDetectCommand(targetUri), undefined, { onSudoAttempt: () => setUsedSudo(true) });
      if (result.code !== 0) throw new Error(result.stderr || (result.stdout.includes('VIRSH_NOT_FOUND') ? t('vm.error.notFound', language) : t('vm.error.connect', language)));
      const parsed = parseVirshOverview(result.stdout);
      if (!isMountedRef.current) return;
      setUri(targetUri);
      setUriDraft(targetUri);
      setHost(parsed.host);
      setDomains(parsed.domains);
      setSelectedDomainUuid((current) => current && parsed.domains.some((domain) => domain.uuid === current) ? current : parsed.domains[0]?.uuid ?? '');
      await refreshResources(true, targetUri);
    } catch (nextError) {
      if (isMountedRef.current) {
        setHost(defaultHost(targetUri));
        setDomains([]);
        setNetworks([]);
        setPools([]);
        setVolumesByPool(new Map());
        setError(getErrorMessage(nextError));
      }
    } finally {
      if (isMountedRef.current) setLoading(false);
    }
  }, [isWindowsHost, language, refreshResources, runCommand, uriDraft]);

  const refreshAllRef = useRef(refreshAll);
  refreshAllRef.current = refreshAll;

  useEffect(() => {
    isMountedRef.current = true;
    void refreshAllRef.current();
    return () => { isMountedRef.current = false; };
  }, [connectionId]);

  useEffect(() => {
    if (!selectedDomain) {
      setDetail(null);
      return;
    }
    void loadDetail(selectedDomain);
  }, [loadDetail, selectedDomain]);

  useEffect(() => {
    if (activeTab !== 'domains' && !resourcesLoaded && !loading) void refreshResources();
  }, [activeTab, loading, refreshResources, resourcesLoaded]);

  const openAction = (action: VirtualMachinePendingAction) => {
    setConfirmationValue('');
    setDialogError('');
    setPendingAction(action);
  };

  const executePendingAction = async () => {
    if (!pendingAction) return;
    let command;
    let refreshKind: 'domains' | 'resources' | 'detail' = 'domains';
    if (pendingAction.kind === 'domain') command = getVirtualMachineActionCommand(uri, pendingAction.domain.uuid, pendingAction.action);
    else if (pendingAction.kind === 'disk-detach') {
      command = getVirtualMachineDetachDiskCommand(uri, pendingAction.domain.uuid, pendingAction.disk.target, ['running', 'idle'].includes(pendingAction.domain.state));
      refreshKind = 'detail';
    } else if (pendingAction.kind === 'interface-detach') {
      command = getVirtualMachineDetachInterfaceCommand(uri, pendingAction.domain.uuid, pendingAction.interface.type, pendingAction.interface.mac, ['running', 'idle'].includes(pendingAction.domain.state));
      refreshKind = 'detail';
    }
    else if (pendingAction.kind === 'snapshot-revert') {
      command = getSnapshotActionCommand(uri, pendingAction.domain.uuid, pendingAction.snapshot.name, 'revert');
      refreshKind = 'detail';
    } else if (pendingAction.kind === 'snapshot-delete') {
      command = getSnapshotActionCommand(uri, pendingAction.domain.uuid, pendingAction.snapshot.name, 'delete');
      refreshKind = 'detail';
    } else if (pendingAction.kind === 'network') {
      command = getVirshNetworkActionCommand(uri, pendingAction.network.name, pendingAction.action);
      refreshKind = 'resources';
    } else {
      command = getVirshStoragePoolActionCommand(uri, pendingAction.pool.name, pendingAction.action);
      refreshKind = 'resources';
    }
    setActingKey('pending-action');
    setDialogError('');
    try {
      const result = await runCommand(command, undefined, { onSudoAttempt: () => setUsedSudo(true) });
      if (result.code !== 0) throw new Error(result.stderr || result.stdout || t('vm.error.action', language));
      setPendingAction(null);
      setConfirmationValue('');
      setNotice(t('vm.notice.actionComplete', language));
      if (refreshKind === 'domains') await refreshAll();
      else if (refreshKind === 'resources') await refreshResources(true);
      else if (selectedDomain) await loadDetail(selectedDomain);
    } catch (nextError) {
      setDialogError(getErrorMessage(nextError));
    } finally {
      setActingKey('');
    }
  };

  const createSnapshot = async () => {
    if (!snapshotForm || !selectedDomain) return;
    setActingKey('snapshot-create');
    setDialogError('');
    try {
      const result = await runCommand(getSnapshotCreateCommand(uri, selectedDomain.uuid, snapshotForm), undefined, { onSudoAttempt: () => setUsedSudo(true) });
      if (result.code !== 0) throw new Error(result.stderr || result.stdout || t('vm.error.snapshot', language));
      setSnapshotForm(null);
      setNotice(t('vm.notice.snapshotCreated', language));
      await loadDetail(selectedDomain);
    } catch (nextError) {
      setDialogError(getErrorMessage(nextError));
    } finally {
      setActingKey('');
    }
  };

  const openCreateDialog = () => {
    const pool = pools.find((item) => item.active)?.name ?? '';
    const network = networks.find((item) => item.active)?.name ?? '';
    setDialogError('');
    setManagementDialog({
      kind: 'create',
      form: {
        name: '', description: '', vcpus: 2, memoryMiB: 2048, architecture: 'x86_64',
        storageMode: pool ? 'new-volume' : 'none', storagePool: pool, volumeName: '', diskSizeGiB: 40,
        diskPath: '', diskFormat: 'qcow2', isoPath: '', networkName: network, autostart: false, startAfterCreate: false,
      },
    });
  };

  const openDomainManagement = (kind: 'settings' | 'clone' | 'delete' | 'migrate' | 'xml' | 'attach-disk' | 'attach-interface') => {
    if (!selectedDomain) return;
    const running = ['running', 'idle'].includes(selectedDomain.state);
    setDialogError('');
    if (kind === 'settings') setManagementDialog({ kind, domain: selectedDomain, form: { vcpus: detail?.currentVcpus || selectedDomain.vcpus || 1, memoryMiB: Math.max(128, Math.round((detail?.currentMemoryKiB || selectedDomain.maxMemoryKiB) / 1024)), applyLive: running, autostart: selectedDomain.autostart } });
    else if (kind === 'clone') setManagementDialog({ kind, domain: selectedDomain, form: { name: `${selectedDomain.name}-clone` } });
    else if (kind === 'delete') setManagementDialog({ kind, domain: selectedDomain, form: { confirmation: '', forceStop: false, removeStorage: false, removeNvram: false, removeSnapshotsMetadata: false } });
    else if (kind === 'migrate') setManagementDialog({ kind, domain: selectedDomain, form: { destinationUri: '', live: running, persistent: true, undefineSource: true, copyStorage: 'none', peerToPeer: true, tunnelled: false } });
    else if (kind === 'xml') setManagementDialog({ kind, domain: selectedDomain, form: { xml: detail?.xml ?? '' } });
    else if (kind === 'attach-disk') setManagementDialog({ kind, domain: selectedDomain, form: { source: '', target: 'vdb', bus: 'virtio', format: 'qcow2', readonly: false, live: running } });
    else setManagementDialog({ kind, domain: selectedDomain, form: { type: 'network', source: networks.find((item) => item.active)?.name ?? '', model: 'virtio', mac: '', live: running } });
  };

  const executeManagementDialog = async () => {
    if (!managementDialog) return;
    let command;
    let refresh: 'all' | 'resources' | 'detail' = 'all';
    if (managementDialog.kind === 'create') command = getVirtualMachineCreateCommand(uri, managementDialog.form);
    else if (managementDialog.kind === 'settings') command = getVirtualMachineSettingsCommand(uri, managementDialog.domain.uuid, managementDialog.form);
    else if (managementDialog.kind === 'clone') command = getVirtualMachineCloneCommand(uri, managementDialog.domain.uuid, managementDialog.form.name);
    else if (managementDialog.kind === 'attach-disk') { command = getVirtualMachineAttachDiskCommand(uri, managementDialog.domain.uuid, managementDialog.form); refresh = 'detail'; }
    else if (managementDialog.kind === 'attach-interface') { command = getVirtualMachineAttachInterfaceCommand(uri, managementDialog.domain.uuid, managementDialog.form); refresh = 'detail'; }
    else if (managementDialog.kind === 'delete') command = getVirtualMachineDeleteCommand(uri, managementDialog.domain.uuid, managementDialog.form);
    else if (managementDialog.kind === 'migrate') command = getVirtualMachineMigrationCommand(uri, managementDialog.domain.uuid, managementDialog.form);
    else if (managementDialog.kind === 'xml') { command = getVirtualMachineDefineXmlCommand(uri, managementDialog.form.xml); refresh = 'detail'; }
    else if (managementDialog.kind === 'create-volume') { command = getVirshStorageVolumeCreateCommand(uri, managementDialog.form); refresh = 'resources'; }
    else { command = getVirshStorageVolumeDeleteCommand(uri, managementDialog.pool, managementDialog.volume.name); refresh = 'resources'; }
    setActingKey(`manage-${managementDialog.kind}`);
    setDialogError('');
    try {
      const result = await runCommand(command, undefined, { onSudoAttempt: () => setUsedSudo(true) });
      if (result.code !== 0) throw new Error(result.stderr || result.stdout || t('vm.error.manage', language));
      setManagementDialog(null);
      setNotice(t('vm.notice.manageComplete', language));
      if (refresh === 'resources') await refreshResources(true);
      else if (refresh === 'detail' && selectedDomain) await loadDetail(selectedDomain);
      else await refreshAll();
    } catch (nextError) {
      setDialogError(getErrorMessage(nextError));
    } finally {
      setActingKey('');
    }
  };

  const openConsole = () => {
    if (!selectedDomain || !onOpenTerminal) return;
    onOpenTerminal({
      title: `${t('vm.action.console', language)} · ${selectedDomain.name}`,
      initialCommand: getVirshConsoleCommand(uri, selectedDomain.uuid, usedSudo),
    });
    setNotice(t('vm.notice.consoleShortcut', language));
  };

  const openVnc = () => {
    if (!detail || !onOpenVnc) return;
    const target = parseVncDisplayTarget(detail.displayUri);
    if (!target) {
      setError(t('vm.error.vncUnavailable', language));
      return;
    }
    onOpenVnc(target);
  };

  const domainAction = (action: VirtualMachineAction) => {
    if (selectedDomain) openAction({ kind: 'domain', action, domain: selectedDomain });
  };

  const snapshotAction = (snapshot: VirtualMachineSnapshot, action: 'revert' | 'delete') => {
    if (!selectedDomain) return;
    openAction({ kind: action === 'revert' ? 'snapshot-revert' : 'snapshot-delete', domain: selectedDomain, snapshot });
  };

  const renderDomainFooter = () => {
    const running = selectedDomain?.state === 'running' || selectedDomain?.state === 'idle';
    const paused = selectedDomain?.state === 'paused' || selectedDomain?.state === 'pmsuspended';
    const canStart = selectedDomain?.state === 'shutoff' || selectedDomain?.state === 'crashed';
    return (
      <footer className="vm-manager-table-footer">
        <span>{t('vm.selection.count', language, { selected: selectedDomain ? 1 : 0, total: domains.length })}</span>
        <div className="vm-manager-action-strip">
          <button type="button" onClick={() => domainAction('start')} disabled={!canStart || Boolean(actingKey)}><Play size={14} />{t('vm.action.start', language)}</button>
          <button type="button" onClick={() => domainAction('shutdown')} disabled={!running || Boolean(actingKey)}><Power size={14} />{t('vm.action.shutdown', language)}</button>
          <button type="button" onClick={() => domainAction('reboot')} disabled={!running || Boolean(actingKey)}><RefreshCw size={14} />{t('vm.action.reboot', language)}</button>
          <button type="button" onClick={() => domainAction(paused ? 'resume' : 'suspend')} disabled={(!running && !paused) || Boolean(actingKey)}><Pause size={14} />{t(paused ? 'vm.action.resume' : 'vm.action.suspend', language)}</button>
          <button type="button" onClick={openConsole} disabled={!selectedDomain || Boolean(actingKey)}><Terminal size={14} />{t('vm.action.console', language)}</button>
          <button type="button" onClick={() => openDomainManagement('settings')} disabled={!selectedDomain || Boolean(actingKey)}><Settings2 size={14} />{t('vm.manage.settings', language)}<ChevronDown size={12} /></button>
        </div>
      </footer>
    );
  };

  const renderDomainTable = () => (
    <div className="vm-manager-domain-layout">
      <section className="vm-manager-table-panel">
        <div className="vm-manager-table-scroll">
          <table className="vm-manager-table">
            <thead><tr><th>{t('vm.field.name', language)}</th><th>{t('vm.field.state', language)}</th><th>CPU</th><th>{t('vm.field.memory', language)}</th><th>{t('vm.field.ipAddress', language)}</th><th>{t('vm.field.autostart', language)}</th></tr></thead>
            <tbody>
              {visibleDomains.map((domain) => <tr key={domain.uuid} className={selectedDomainUuid === domain.uuid ? 'selected' : ''} onClick={() => setSelectedDomainUuid(domain.uuid)}><td><div className="vm-manager-name-cell"><Monitor size={17} /><span><strong>{domain.name}</strong></span></div></td><td><span className={`vm-manager-state ${getStateTone(domain.state)}`}>{t(`vm.state.${domain.state}` as MessageId, language)}</span></td><td>{domain.vcpus || '-'}</td><td>{formatMemoryKiB(domain.usedMemoryKiB || domain.maxMemoryKiB, language)}</td><td title={domain.ipAddresses.join(', ')}>{domain.ipAddresses[0] || '-'}</td><td>{domain.autostart ? t('common.yes', language) : t('common.no', language)}</td></tr>)}
              {!visibleDomains.length ? <tr><td colSpan={6}><div className="vm-manager-empty">{t('vm.empty.domains', language)}</div></td></tr> : null}
            </tbody>
          </table>
        </div>
        {renderDomainFooter()}
      </section>
      {selectedDomain ? <VirtualMachineDetailPanel language={language} domain={selectedDomain} detail={detail?.uuid === selectedDomain.uuid ? detail : null} activeTab={detailTab} loading={detailLoading} busy={Boolean(actingKey)} onTabChange={setDetailTab} onAction={domainAction} onOpenConsole={openConsole} onOpenVnc={openVnc} onCreateSnapshot={() => { setDialogError(''); setSnapshotForm({ name: `snapshot-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`, description: '', diskOnly: true, quiesce: false }); }} onSnapshotAction={snapshotAction} onOpenSettings={() => openDomainManagement('settings')} onClone={() => openDomainManagement('clone')} onDelete={() => openDomainManagement('delete')} onMigrate={() => openDomainManagement('migrate')} onEditXml={() => openDomainManagement('xml')} onAttachDisk={() => openDomainManagement('attach-disk')} onDetachDisk={(target) => { const disk = detail?.disks.find((item) => item.target === target); if (disk) openAction({ kind: 'disk-detach', domain: selectedDomain, disk }); }} onAttachInterface={() => openDomainManagement('attach-interface')} onDetachInterface={(_type, mac) => { const item = detail?.interfaces.find((candidate) => candidate.mac === mac); if (item) openAction({ kind: 'interface-detach', domain: selectedDomain, interface: item }); }} /> : null}
    </div>
  );

  const renderNetworks = () => (
    <section className="vm-manager-resource-panel">
      <table className="vm-manager-table"><thead><tr><th>{t('vm.field.name', language)}</th><th>{t('vm.field.state', language)}</th><th>Bridge</th><th>{t('vm.field.persistent', language)}</th><th>{t('vm.field.autostart', language)}</th><th>{t('vm.field.actions', language)}</th></tr></thead><tbody>
        {visibleNetworks.map((network) => <tr key={network.uuid}><td><div className="vm-manager-name-cell"><Network size={17} /><span><strong>{network.name}</strong><small>{network.uuid}</small></span></div></td><td><span className={`vm-manager-state ${network.active ? 'running' : 'stopped'}`}>{network.active ? t('vm.state.active', language) : t('vm.state.inactive', language)}</span></td><td>{network.bridge || '-'}</td><td>{network.persistent ? t('common.yes', language) : t('common.no', language)}</td><td>{network.autostart ? t('common.yes', language) : t('common.no', language)}</td><td><div className="vm-manager-row-actions">{network.active ? <button type="button" onClick={() => openAction({ kind: 'network', action: 'destroy', network })}><Power size={14} />{t('vm.action.destroy', language)}</button> : <button type="button" onClick={() => openAction({ kind: 'network', action: 'start', network })}><Play size={14} />{t('vm.action.start', language)}</button>}<button type="button" onClick={() => openAction({ kind: 'network', action: network.autostart ? 'autostart-disable' : 'autostart-enable', network })}><Settings2 size={14} />{t(network.autostart ? 'vm.action.autostart-disable' : 'vm.action.autostart-enable', language)}</button></div></td></tr>)}
        {!visibleNetworks.length ? <tr><td colSpan={6}><div className="vm-manager-empty">{t('vm.empty.networks', language)}</div></td></tr> : null}
      </tbody></table>
    </section>
  );

  const renderStorage = () => {
    const selectedPool = pools.find((pool) => pool.name === selectedPoolName) ?? null;
    const volumes = selectedPool ? volumesByPool.get(selectedPool.name) ?? [] : [];
    return <div className="vm-manager-storage-layout"><section className="vm-manager-resource-panel"><table className="vm-manager-table"><thead><tr><th>{t('vm.field.name', language)}</th><th>{t('vm.field.state', language)}</th><th>{t('vm.storage.capacity', language)}</th><th>{t('vm.storage.used', language)}</th><th>{t('vm.field.autostart', language)}</th><th>{t('vm.field.actions', language)}</th></tr></thead><tbody>
      {visiblePools.map((pool) => <tr key={pool.uuid} className={selectedPoolName === pool.name ? 'selected' : ''} onClick={() => setSelectedPoolName(pool.name)}><td><div className="vm-manager-name-cell"><Database size={17} /><span><strong>{pool.name}</strong><small>{pool.uuid}</small></span></div></td><td><span className={`vm-manager-state ${pool.active ? 'running' : 'stopped'}`}>{t(pool.active ? 'vm.state.active' : 'vm.state.inactive', language)}</span></td><td>{formatBytes(pool.capacityBytes, language)}</td><td>{formatBytes(pool.allocationBytes, language)}</td><td>{pool.autostart ? t('common.yes', language) : t('common.no', language)}</td><td><div className="vm-manager-row-actions">{pool.active ? <button type="button" onClick={(event) => { event.stopPropagation(); openAction({ kind: 'pool', action: 'destroy', pool }); }}><Power size={14} />{t('vm.action.destroy', language)}</button> : <button type="button" onClick={(event) => { event.stopPropagation(); openAction({ kind: 'pool', action: 'start', pool }); }}><Play size={14} />{t('vm.action.start', language)}</button>}<button type="button" onClick={(event) => { event.stopPropagation(); openAction({ kind: 'pool', action: 'refresh', pool }); }}><RefreshCw size={14} />{t('vm.action.refresh', language)}</button><button type="button" onClick={(event) => { event.stopPropagation(); openAction({ kind: 'pool', action: pool.autostart ? 'autostart-disable' : 'autostart-enable', pool }); }}><Settings2 size={14} />{t(pool.autostart ? 'vm.action.autostart-disable' : 'vm.action.autostart-enable', language)}</button></div></td></tr>)}
      {!visiblePools.length ? <tr><td colSpan={6}><div className="vm-manager-empty">{t('vm.empty.pools', language)}</div></td></tr> : null}
    </tbody></table></section>{selectedPool ? <aside className="vm-manager-volume-panel"><header><div><strong>{selectedPool.name}</strong><small>{t('vm.storage.volumes', language, { count: volumes.length })}</small></div><div className="vm-manager-volume-header-actions"><span>{formatBytes(selectedPool.availableBytes, language)} {t('vm.storage.available', language)}</span><button type="button" onClick={() => { setDialogError(''); setManagementDialog({ kind: 'create-volume', form: { pool: selectedPool.name, name: '', capacityGiB: 20, allocationGiB: 0, format: 'qcow2' } }); }}><Plus size={14} />{t('vm.manage.createVolume', language)}</button></div></header><div>{volumes.length ? volumes.map((volume) => <article key={volume.name}><div><strong>{volume.name}</strong><small title={volume.path}>{volume.path || volume.type}</small></div><div className="vm-manager-volume-actions"><span>{formatBytes(volume.capacityBytes, language)}</span><button type="button" className="danger" onClick={() => { setDialogError(''); setManagementDialog({ kind: 'delete-volume', volume, pool: selectedPool.name, confirmation: '' }); }}><Trash2 size={13} /></button></div></article>) : <div className="vm-manager-empty">{t('vm.empty.volumes', language)}</div>}</div></aside> : null}</div>;
  };

  if (isWindowsHost) return <div className="vm-manager-container vm-manager-unsupported"><Server size={42} /><strong>{t('vm.unsupported.title', language)}</strong><p>{t('vm.unsupported.description', language)}</p></div>;

  return (
    <div className="vm-manager-container">
      <header className="vm-manager-toolbar">
        <nav role="tablist">{managerTabs.map((tab) => { const Icon = tab.icon; return <button key={tab.key} type="button" role="tab" aria-selected={activeTab === tab.key} className={activeTab === tab.key ? 'active' : ''} onClick={() => setActiveTab(tab.key)}><Icon size={16} />{t(tab.labelId, language)}</button>; })}</nav>
        <label className="vm-manager-uri"><span>URI</span><input list="vm-manager-uri-suggestions" value={uriDraft} onChange={(event) => setUriDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void refreshAll(); }} /><datalist id="vm-manager-uri-suggestions">{uriSuggestions.map((value) => <option key={value} value={value} />)}</datalist></label>
        <div className="vm-manager-connection"><span className={error ? 'error' : 'ok'} /> <div><strong>{error ? t('vm.connection.error', language) : t('vm.connection.connected', language)}</strong><small>{[host.virshVersion && `virsh ${host.virshVersion}`, host.hypervisor, usedSudo ? 'sudo' : 'user'].filter(Boolean).join(' · ')}</small></div></div>
        <label className="vm-manager-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('vm.search.placeholder', language)} /></label>
        <button type="button" className="vm-manager-refresh" onClick={() => void refreshAll()} disabled={loading}><RefreshCw size={16} className={loading ? 'spinning' : ''} />{t('vm.action.refresh', language)}</button>
        <button type="button" className="vm-manager-create" onClick={openCreateDialog}><Plus size={16} />{t('vm.action.create', language)}<ChevronDown size={13} /></button>
      </header>
      {activeTab === 'domains' ? <section className="vm-manager-summary"><div><span>{t('vm.summary.total', language)}</span><strong>{domainCounts.total}</strong><small>{t('vm.summary.totalUnit', language)}</small></div><div className="running"><span>{t('vm.summary.running', language)}</span><strong>{domainCounts.running}</strong></div><div><span>{t('vm.summary.stopped', language)}</span><strong>{domainCounts.stopped}</strong></div><div><span>{t('vm.summary.cpuAllocation', language)}</span><strong>{formatPercent(allocationSummary.cpuPercent)}</strong><small>{allocationSummary.assignedVcpus} / {host.cpuCount || '-'} {t('vm.summary.cores', language)}</small></div><div><span>{t('vm.summary.memoryAllocation', language)}</span><strong>{formatPercent(allocationSummary.memoryPercent)}</strong><small>{formatMemoryKiB(allocationSummary.assignedMemoryKiB, language)} / {formatMemoryKiB(host.memoryKiB, language)}</small></div><div><span>{t('vm.summary.storageAllocation', language)}</span><strong>{formatPercent(allocationSummary.storagePercent)}</strong><small>{formatBytes(allocationSummary.storageAllocationBytes, language)} / {formatBytes(allocationSummary.storageCapacityBytes, language)}</small></div></section> : null}
      {error ? <DismissibleAlert className="vm-manager-alert error" onDismiss={() => setError('')}>{error}</DismissibleAlert> : null}
      {notice ? <DismissibleAlert className="vm-manager-alert notice" onDismiss={() => setNotice('')}>{notice}</DismissibleAlert> : null}
      <main className="vm-manager-main" aria-busy={loading}>{activeTab === 'domains' ? renderDomainTable() : activeTab === 'networks' ? renderNetworks() : renderStorage()}</main>
      {sudoPrompt}
      <VirtualMachineActionDialog language={language} pendingAction={pendingAction} confirmationValue={confirmationValue} busy={actingKey === 'pending-action'} error={dialogError} onConfirmationValueChange={setConfirmationValue} onCancel={() => { if (!actingKey) setPendingAction(null); }} onConfirm={() => void executePendingAction()} />
      <VirtualMachineSnapshotDialog language={language} domainName={selectedDomain?.name ?? ''} form={snapshotForm} busy={actingKey === 'snapshot-create'} error={dialogError} onChange={setSnapshotForm} onCancel={() => { if (!actingKey) setSnapshotForm(null); }} onSubmit={() => void createSnapshot()} />
      <VirtualMachineManagementModal language={language} dialog={managementDialog} pools={pools} networks={networks} volumesByPool={volumesByPool} busy={actingKey.startsWith('manage-')} error={dialogError} onChange={setManagementDialog} onCancel={() => { if (!actingKey) setManagementDialog(null); }} onSubmit={() => void executeManagementDialog()} />
    </div>
  );
}

export default RemoteVirtualMachineManager;

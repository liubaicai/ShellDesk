import { Camera, CircleStop, ExternalLink, Monitor, Pause, Play, Power, RefreshCw, RotateCcw, RotateCw, Settings2, Terminal, Trash2 } from 'lucide-react';
import { t, type AppLanguage, type MessageId } from '../../i18n';
import type {
  VirtualMachineAction,
  VirtualMachineDetail,
  VirtualMachineDetailTab,
  VirtualMachineSnapshot,
  VirtualMachineSummary,
} from './virshTypes';

interface VirtualMachineDetailPanelProps {
  language: AppLanguage;
  domain: VirtualMachineSummary;
  detail: VirtualMachineDetail | null;
  activeTab: VirtualMachineDetailTab;
  loading: boolean;
  busy: boolean;
  onTabChange: (tab: VirtualMachineDetailTab) => void;
  onAction: (action: VirtualMachineAction) => void;
  onOpenConsole: () => void;
  onOpenVnc: () => void;
  onCreateSnapshot: () => void;
  onSnapshotAction: (snapshot: VirtualMachineSnapshot, action: 'revert' | 'delete') => void;
}

const detailTabs: Array<{ key: VirtualMachineDetailTab; labelId: MessageId }> = [
  { key: 'overview', labelId: 'vm.detail.overview' },
  { key: 'performance', labelId: 'vm.detail.performance' },
  { key: 'disks', labelId: 'vm.detail.disks' },
  { key: 'network', labelId: 'vm.detail.network' },
  { key: 'snapshots', labelId: 'vm.detail.snapshots' },
  { key: 'xml', labelId: 'vm.detail.xml' },
];

function formatBytes(value: number, language: AppLanguage) {
  if (!value) return '-';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let amount = value;
  let unitIndex = 0;
  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024;
    unitIndex += 1;
  }
  return `${new Intl.NumberFormat(language, { maximumFractionDigits: 2 }).format(amount)} ${units[unitIndex]}`;
}

function formatKiB(value: number, language: AppLanguage) {
  return formatBytes(value * 1024, language);
}

function KeyValueGrid({ values }: { values: Array<[string, string]> }) {
  return <dl className="vm-manager-key-values">{values.map(([label, value]) => <div key={label}><dt>{label}</dt><dd title={value}>{value || '-'}</dd></div>)}</dl>;
}

export function VirtualMachineDetailPanel({
  language,
  domain,
  detail,
  activeTab,
  loading,
  busy,
  onTabChange,
  onAction,
  onOpenConsole,
  onOpenVnc,
  onCreateSnapshot,
  onSnapshotAction,
}: VirtualMachineDetailPanelProps) {
  const running = domain.state === 'running' || domain.state === 'idle';
  const paused = domain.state === 'paused';
  const canStart = domain.state === 'shutoff' || domain.state === 'crashed';
  const displayAvailable = detail?.displayUri.startsWith('vnc://') ?? false;
  const memoryCurrentKiB = detail?.currentMemoryKiB || domain.usedMemoryKiB || domain.maxMemoryKiB;
  const memoryMaximumKiB = detail?.memoryKiB || domain.maxMemoryKiB;
  const memoryPercent = memoryMaximumKiB ? Math.min(100, (memoryCurrentKiB / memoryMaximumKiB) * 100) : 0;
  const primaryInterface = detail?.interfaces.find((item) => item.addresses.length) ?? detail?.interfaces[0];

  return (
    <aside className="vm-manager-detail">
      <header className="vm-manager-detail-header">
        <div className="vm-manager-detail-icon"><Monitor size={23} /></div>
        <div><strong>{domain.name}</strong><span className={`vm-manager-state ${domain.state}`}>{t(`vm.state.${domain.state}` as MessageId, language)}</span><small>{domain.uuid}</small></div>
      </header>
      <nav className="vm-manager-detail-tabs" role="tablist">
        {detailTabs.map((tab) => <button key={tab.key} type="button" role="tab" aria-selected={activeTab === tab.key} className={activeTab === tab.key ? 'active' : ''} onClick={() => onTabChange(tab.key)}>{t(tab.labelId, language)}</button>)}
      </nav>
      <section className="vm-manager-detail-content" aria-busy={loading}>
        {loading ? <div className="vm-manager-detail-loading">{t('vm.loading.detail', language)}</div> : null}
        {!loading && activeTab === 'overview' ? (
          <div className="vm-manager-overview">
            <KeyValueGrid values={[
              [t('vm.field.name', language), detail?.name ?? domain.name],
              ['UUID', domain.uuid],
              [t('vm.field.state', language), t(`vm.state.${domain.state}` as MessageId, language)],
              [t('vm.field.os', language), [detail?.osType, detail?.architecture].filter(Boolean).join(' / ')],
              [t('vm.field.machine', language), detail?.machine ?? ''],
              [t('vm.field.cpu', language), String(detail?.currentVcpus || detail?.vcpus || domain.vcpus || '-')],
              [t('vm.field.memory', language), formatKiB(detail?.currentMemoryKiB || domain.usedMemoryKiB || domain.maxMemoryKiB, language)],
              [t('vm.field.autostart', language), domain.autostart ? t('common.yes', language) : t('common.no', language)],
              [t('vm.field.persistent', language), domain.persistent ? t('common.yes', language) : t('common.no', language)],
              [t('vm.field.boot', language), detail?.bootDevices.join(', ') ?? ''],
              [t('vm.field.emulator', language), detail?.emulator ?? ''],
            ]} />
            <section className="vm-manager-runtime-overview">
              <div className="vm-manager-runtime-row"><span>CPU</span><strong>{detail?.currentVcpus || detail?.vcpus || domain.vcpus || '-'}</strong></div>
              <div className="vm-manager-runtime-row memory"><span>{t('vm.field.memory', language)}</span><div><i><b style={{ width: `${memoryPercent}%` }} /></i><small>{formatKiB(memoryCurrentKiB, language)} / {formatKiB(memoryMaximumKiB, language)}</small></div></div>
              <div className="vm-manager-runtime-row"><span>{t('vm.field.ipAddress', language)}</span><strong>{primaryInterface?.addresses.join(', ') || domain.ipAddresses.join(', ') || '-'}</strong></div>
              <div className="vm-manager-runtime-row"><span>MAC</span><strong>{primaryInterface?.mac || '-'}</strong></div>
              <div className="vm-manager-runtime-row"><span>VNC</span><strong>{detail?.displayUri || '-'}</strong></div>
            </section>
            {detail?.description ? <p className="vm-manager-description">{detail.description}</p> : null}
          </div>
        ) : null}
        {!loading && activeTab === 'performance' ? (
          <div className="vm-manager-performance">
            <div><span>{t('vm.stats.cpuTime', language)}</span><strong>{detail?.stats.cpuTimeNs ? `${(detail.stats.cpuTimeNs / 1e9).toFixed(1)} s` : '-'}</strong></div>
            <div><span>{t('vm.stats.memory', language)}</span><strong>{formatKiB(detail?.stats.balloonCurrentKiB ?? 0, language)}</strong></div>
            <div><span>{t('vm.stats.blockRead', language)}</span><strong>{formatBytes(detail?.stats.blockReadBytes ?? 0, language)}</strong></div>
            <div><span>{t('vm.stats.blockWrite', language)}</span><strong>{formatBytes(detail?.stats.blockWriteBytes ?? 0, language)}</strong></div>
            <div><span>{t('vm.stats.networkRx', language)}</span><strong>{formatBytes(detail?.stats.networkRxBytes ?? 0, language)}</strong></div>
            <div><span>{t('vm.stats.networkTx', language)}</span><strong>{formatBytes(detail?.stats.networkTxBytes ?? 0, language)}</strong></div>
          </div>
        ) : null}
        {!loading && activeTab === 'disks' ? (
          <div className="vm-manager-stack-list">
            {detail?.disks.length ? detail.disks.map((disk, index) => <article key={`${disk.target}-${index}`}><header><strong>{disk.target || disk.device}</strong><span>{disk.format || disk.type}</span></header><dl><div><dt>{t('vm.disk.source', language)}</dt><dd title={disk.source}>{disk.source || '-'}</dd></div><div><dt>{t('vm.disk.bus', language)}</dt><dd>{disk.bus || '-'}</dd></div><div><dt>{t('vm.disk.readonly', language)}</dt><dd>{disk.readonly ? t('common.yes', language) : t('common.no', language)}</dd></div></dl></article>) : <div className="vm-manager-empty">{t('vm.empty.disks', language)}</div>}
          </div>
        ) : null}
        {!loading && activeTab === 'network' ? (
          <div className="vm-manager-stack-list">
            {detail?.interfaces.length ? detail.interfaces.map((item, index) => <article key={`${item.mac}-${index}`}><header><strong>{item.source || item.target || t('vm.network.interface', language)}</strong><span>{item.model || item.type}</span></header><dl><div><dt>MAC</dt><dd>{item.mac || '-'}</dd></div><div><dt>IP</dt><dd>{item.addresses.join(', ') || '-'}</dd></div><div><dt>{t('vm.network.target', language)}</dt><dd>{item.target || '-'}</dd></div></dl></article>) : <div className="vm-manager-empty">{t('vm.empty.interfaces', language)}</div>}
          </div>
        ) : null}
        {!loading && activeTab === 'snapshots' ? (
          <div className="vm-manager-snapshots">
            <button type="button" className="vm-manager-inline-primary" onClick={onCreateSnapshot} disabled={busy}><Camera size={15} />{t('vm.snapshot.create', language)}</button>
            {detail?.snapshots.length ? detail.snapshots.map((snapshot) => <article key={snapshot.name}><div><strong>{snapshot.name}</strong>{snapshot.current ? <span className="current">{t('vm.snapshot.current', language)}</span> : null}<small>{snapshot.createdAt || snapshot.state}</small></div><div><button type="button" onClick={() => onSnapshotAction(snapshot, 'revert')} disabled={busy}><RotateCw size={14} />{t('vm.snapshot.revert', language)}</button><button type="button" className="danger" onClick={() => onSnapshotAction(snapshot, 'delete')} disabled={busy}><Trash2 size={14} />{t('vm.snapshot.delete', language)}</button></div></article>) : <div className="vm-manager-empty">{t('vm.empty.snapshots', language)}</div>}
          </div>
        ) : null}
        {!loading && activeTab === 'xml' ? <textarea className="vm-manager-xml" readOnly value={detail?.xml ?? ''} aria-label={t('vm.detail.xml', language)} /> : null}
      </section>
      <footer className="vm-manager-detail-actions">
        {canStart ? <button type="button" onClick={() => onAction('start')} disabled={busy}><Play size={15} />{t('vm.action.start', language)}</button> : null}
        {running ? <button type="button" onClick={() => onAction('shutdown')} disabled={busy}><Power size={15} />{t('vm.action.shutdown', language)}</button> : null}
        {running ? <button type="button" onClick={() => onAction('reboot')} disabled={busy}><RefreshCw size={15} />{t('vm.action.reboot', language)}</button> : null}
        {running ? <button type="button" onClick={() => onAction('suspend')} disabled={busy}><Pause size={15} />{t('vm.action.suspend', language)}</button> : null}
        {paused ? <button type="button" onClick={() => onAction('resume')} disabled={busy}><Play size={15} />{t('vm.action.resume', language)}</button> : null}
        {running || paused ? <button type="button" className="danger" onClick={() => onAction('reset')} disabled={busy}><RotateCcw size={15} />{t('vm.action.reset', language)}</button> : null}
        {running || paused ? <button type="button" className="danger" onClick={() => onAction('destroy')} disabled={busy}><CircleStop size={15} />{t('vm.action.destroy', language)}</button> : null}
        <button type="button" onClick={() => onAction(domain.autostart ? 'autostart-disable' : 'autostart-enable')} disabled={busy}><Settings2 size={15} />{t(domain.autostart ? 'vm.action.autostart-disable' : 'vm.action.autostart-enable', language)}</button>
        <button type="button" onClick={onOpenConsole} disabled={busy || !onOpenConsole}><Terminal size={15} />{t('vm.action.console', language)}</button>
        <button type="button" onClick={onOpenVnc} disabled={busy || !displayAvailable}><ExternalLink size={15} />VNC</button>
      </footer>
    </aside>
  );
}

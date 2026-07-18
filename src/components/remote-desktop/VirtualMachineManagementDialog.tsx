import { createPortal } from 'react-dom';
import { AlertTriangle, Copy, Database, Network, Save, Server, Settings2, Trash2 } from 'lucide-react';
import { t, type AppLanguage, type MessageId } from '../../i18n';
import type {
  VirshNetworkSummary,
  VirshStoragePoolSummary,
  VirshStorageVolume,
  VirtualMachineManagementDialog,
} from './virshTypes';

interface Props {
  language: AppLanguage;
  dialog: VirtualMachineManagementDialog | null;
  pools: VirshStoragePoolSummary[];
  networks: VirshNetworkSummary[];
  volumesByPool: Map<string, VirshStorageVolume[]>;
  busy: boolean;
  error: string;
  onChange: (dialog: VirtualMachineManagementDialog) => void;
  onCancel: () => void;
  onSubmit: () => void;
}

const titleIds: Record<VirtualMachineManagementDialog['kind'], MessageId> = {
  create: 'vm.manage.create',
  settings: 'vm.manage.settings',
  clone: 'vm.manage.clone',
  'attach-disk': 'vm.manage.attachDisk',
  'attach-interface': 'vm.manage.attachInterface',
  delete: 'vm.manage.delete',
  migrate: 'vm.manage.migrate',
  xml: 'vm.manage.editXml',
  'create-volume': 'vm.manage.createVolume',
  'delete-volume': 'vm.manage.deleteVolume',
};

function numberValue(value: string, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function VirtualMachineManagementDialog({
  language,
  dialog,
  pools,
  networks,
  volumesByPool,
  busy,
  error,
  onChange,
  onCancel,
  onSubmit,
}: Props) {
  if (!dialog) return null;
  const updateForm = (patch: Record<string, unknown>) => {
    if (!('form' in dialog)) return;
    onChange({ ...dialog, form: { ...dialog.form, ...patch } } as VirtualMachineManagementDialog);
  };
  const target = 'domain' in dialog ? dialog.domain.name : dialog.kind === 'delete-volume' ? dialog.volume.name : '';
  const destructive = dialog.kind === 'delete' || dialog.kind === 'delete-volume';
  const Icon = destructive ? AlertTriangle : dialog.kind === 'clone' ? Copy : dialog.kind.includes('volume') ? Database : dialog.kind === 'attach-interface' ? Network : dialog.kind === 'settings' || dialog.kind === 'xml' ? Settings2 : Server;
  let valid = true;
  if (dialog.kind === 'create') {
    valid = Boolean(dialog.form.name.trim() && dialog.form.vcpus > 0 && dialog.form.memoryMiB >= 128);
    if (dialog.form.storageMode === 'new-volume') valid = valid && Boolean(dialog.form.storagePool && dialog.form.volumeName.trim() && dialog.form.diskSizeGiB > 0);
    if (dialog.form.storageMode === 'existing-volume') valid = valid && Boolean(dialog.form.storagePool && dialog.form.volumeName);
    if (dialog.form.storageMode === 'existing-path') valid = valid && Boolean(dialog.form.diskPath.trim());
  } else if (dialog.kind === 'settings') valid = dialog.form.vcpus > 0 && dialog.form.memoryMiB >= 128;
  else if (dialog.kind === 'clone') valid = Boolean(dialog.form.name.trim());
  else if (dialog.kind === 'attach-disk') valid = Boolean(dialog.form.source.trim() && dialog.form.target.trim());
  else if (dialog.kind === 'attach-interface') valid = Boolean(dialog.form.source.trim());
  else if (dialog.kind === 'delete') valid = dialog.form.confirmation === dialog.domain.name && (!['running', 'idle', 'paused'].includes(dialog.domain.state) || dialog.form.forceStop);
  else if (dialog.kind === 'migrate') valid = Boolean(dialog.form.destinationUri.trim());
  else if (dialog.kind === 'xml') valid = Boolean(dialog.form.xml.trim());
  else if (dialog.kind === 'create-volume') valid = Boolean(dialog.form.pool && dialog.form.name.trim() && dialog.form.capacityGiB > 0);
  else valid = dialog.confirmation === dialog.volume.name;

  const renderCreate = () => {
    if (dialog.kind !== 'create') return null;
    const form = dialog.form;
    const poolVolumes = volumesByPool.get(form.storagePool) ?? [];
    return <>
      <div className="vm-manager-form-grid">
        <label><span>{t('vm.field.name', language)}</span><input autoFocus value={form.name} onChange={(event) => updateForm({ name: event.target.value })} /></label>
        <label><span>{t('vm.field.cpu', language)}</span><input type="number" min="1" value={form.vcpus} onChange={(event) => updateForm({ vcpus: numberValue(event.target.value, 1) })} /></label>
        <label><span>{t('vm.field.memoryMiB', language)}</span><input type="number" min="128" step="128" value={form.memoryMiB} onChange={(event) => updateForm({ memoryMiB: numberValue(event.target.value, 128) })} /></label>
        <label><span>{t('vm.field.architecture', language)}</span><select value={form.architecture} onChange={(event) => updateForm({ architecture: event.target.value })}><option value="x86_64">x86_64</option><option value="aarch64">aarch64</option></select></label>
      </div>
      <label className="vm-manager-modal-field"><span>{t('vm.field.description', language)}</span><textarea rows={2} value={form.description} onChange={(event) => updateForm({ description: event.target.value })} /></label>
      <fieldset><legend>{t('vm.manage.storage', language)}</legend>
        <label className="vm-manager-modal-field"><span>{t('vm.manage.storageMode', language)}</span><select value={form.storageMode} onChange={(event) => updateForm({ storageMode: event.target.value, volumeName: '' })}><option value="new-volume">{t('vm.manage.newVolume', language)}</option><option value="existing-volume">{t('vm.manage.existingVolume', language)}</option><option value="existing-path">{t('vm.manage.existingPath', language)}</option><option value="none">{t('vm.manage.noDisk', language)}</option></select></label>
        {form.storageMode === 'new-volume' || form.storageMode === 'existing-volume' ? <div className="vm-manager-form-grid"><label><span>{t('vm.manage.pool', language)}</span><select value={form.storagePool} onChange={(event) => updateForm({ storagePool: event.target.value, volumeName: '' })}>{pools.filter((pool) => pool.active).map((pool) => <option key={pool.name} value={pool.name}>{pool.name}</option>)}</select></label><label><span>{t('vm.manage.volume', language)}</span>{form.storageMode === 'new-volume' ? <input value={form.volumeName} onChange={(event) => updateForm({ volumeName: event.target.value })} /> : <select value={form.volumeName} onChange={(event) => updateForm({ volumeName: event.target.value })}><option value="">-</option>{poolVolumes.map((volume) => <option key={volume.name} value={volume.name}>{volume.name}</option>)}</select>}</label>{form.storageMode === 'new-volume' ? <label><span>{t('vm.manage.diskSizeGiB', language)}</span><input type="number" min="1" value={form.diskSizeGiB} onChange={(event) => updateForm({ diskSizeGiB: numberValue(event.target.value, 1) })} /></label> : null}</div> : null}
        {form.storageMode === 'existing-path' ? <div className="vm-manager-form-grid"><label><span>{t('vm.manage.diskPath', language)}</span><input value={form.diskPath} onChange={(event) => updateForm({ diskPath: event.target.value })} placeholder="/var/lib/libvirt/images/disk.qcow2" /></label><label><span>{t('vm.storage.format', language)}</span><select value={form.diskFormat} onChange={(event) => updateForm({ diskFormat: event.target.value })}><option value="qcow2">qcow2</option><option value="raw">raw</option></select></label></div> : null}
        {form.storageMode === 'existing-volume' ? <label className="vm-manager-modal-field"><span>{t('vm.storage.format', language)}</span><select value={form.diskFormat} onChange={(event) => updateForm({ diskFormat: event.target.value })}><option value="qcow2">qcow2</option><option value="raw">raw</option></select></label> : null}
      </fieldset>
      <div className="vm-manager-form-grid"><label><span>{t('vm.manage.isoPath', language)}</span><input value={form.isoPath} onChange={(event) => updateForm({ isoPath: event.target.value })} placeholder="/var/lib/libvirt/images/os.iso" /></label><label><span>{t('vm.manage.network', language)}</span><select value={form.networkName} onChange={(event) => updateForm({ networkName: event.target.value })}><option value="">{t('vm.manage.noNetwork', language)}</option>{networks.filter((item) => item.active).map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}</select></label></div>
      <div className="vm-manager-checkbox-row"><label className="vm-manager-checkbox"><input type="checkbox" checked={form.autostart} onChange={(event) => updateForm({ autostart: event.target.checked })} /><span>{t('vm.field.autostart', language)}</span></label><label className="vm-manager-checkbox"><input type="checkbox" checked={form.startAfterCreate} onChange={(event) => updateForm({ startAfterCreate: event.target.checked })} /><span>{t('vm.manage.startAfterCreate', language)}</span></label></div>
    </>;
  };

  const renderBody = () => {
    if (dialog.kind === 'create') return renderCreate();
    if (dialog.kind === 'settings') return <><div className="vm-manager-form-grid"><label><span>{t('vm.field.cpu', language)}</span><input autoFocus type="number" min="1" value={dialog.form.vcpus} onChange={(event) => updateForm({ vcpus: numberValue(event.target.value, 1) })} /></label><label><span>{t('vm.field.memoryMiB', language)}</span><input type="number" min="128" step="128" value={dialog.form.memoryMiB} onChange={(event) => updateForm({ memoryMiB: numberValue(event.target.value, 128) })} /></label></div><div className="vm-manager-checkbox-row"><label className="vm-manager-checkbox"><input type="checkbox" checked={dialog.form.applyLive} onChange={(event) => updateForm({ applyLive: event.target.checked })} /><span>{t('vm.manage.applyLive', language)}</span></label><label className="vm-manager-checkbox"><input type="checkbox" checked={dialog.form.autostart} onChange={(event) => updateForm({ autostart: event.target.checked })} /><span>{t('vm.field.autostart', language)}</span></label></div><p className="vm-manager-modal-hint">{t('vm.manage.settingsHint', language)}</p></>;
    if (dialog.kind === 'clone') return <><label className="vm-manager-modal-field"><span>{t('vm.manage.cloneName', language)}</span><input autoFocus value={dialog.form.name} onChange={(event) => updateForm({ name: event.target.value })} /></label><p className="vm-manager-modal-hint">{t('vm.manage.cloneHint', language)}</p></>;
    if (dialog.kind === 'attach-disk') return <><div className="vm-manager-form-grid"><label className="wide"><span>{t('vm.disk.source', language)}</span><input autoFocus value={dialog.form.source} onChange={(event) => updateForm({ source: event.target.value })} placeholder="/var/lib/libvirt/images/data.qcow2" /></label><label><span>{t('vm.network.target', language)}</span><input value={dialog.form.target} onChange={(event) => updateForm({ target: event.target.value })} placeholder="vdb" /></label><label><span>{t('vm.disk.bus', language)}</span><select value={dialog.form.bus} onChange={(event) => updateForm({ bus: event.target.value })}><option value="virtio">virtio</option><option value="sata">sata</option><option value="scsi">scsi</option><option value="ide">ide</option></select></label><label><span>{t('vm.storage.format', language)}</span><select value={dialog.form.format} onChange={(event) => updateForm({ format: event.target.value })}><option value="qcow2">qcow2</option><option value="raw">raw</option></select></label></div><div className="vm-manager-checkbox-row"><label className="vm-manager-checkbox"><input type="checkbox" checked={dialog.form.readonly} onChange={(event) => updateForm({ readonly: event.target.checked })} /><span>{t('vm.disk.readonly', language)}</span></label><label className="vm-manager-checkbox"><input type="checkbox" checked={dialog.form.live} onChange={(event) => updateForm({ live: event.target.checked })} /><span>{t('vm.manage.applyLive', language)}</span></label></div></>;
    if (dialog.kind === 'attach-interface') return <><div className="vm-manager-form-grid"><label><span>{t('vm.manage.interfaceType', language)}</span><select value={dialog.form.type} onChange={(event) => updateForm({ type: event.target.value })}><option value="network">network</option><option value="bridge">bridge</option></select></label><label><span>{t('vm.manage.source', language)}</span>{dialog.form.type === 'network' ? <select value={dialog.form.source} onChange={(event) => updateForm({ source: event.target.value })}><option value="">-</option>{networks.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}</select> : <input value={dialog.form.source} onChange={(event) => updateForm({ source: event.target.value })} placeholder="br0" />}</label><label><span>{t('vm.manage.model', language)}</span><input value={dialog.form.model} onChange={(event) => updateForm({ model: event.target.value })} /></label><label><span>MAC</span><input value={dialog.form.mac} onChange={(event) => updateForm({ mac: event.target.value })} placeholder={t('vm.manage.autoGenerate', language)} /></label></div><label className="vm-manager-checkbox"><input type="checkbox" checked={dialog.form.live} onChange={(event) => updateForm({ live: event.target.checked })} /><span>{t('vm.manage.applyLive', language)}</span></label></>;
    if (dialog.kind === 'delete') return <><div className="vm-manager-danger-box"><strong>{t('vm.manage.deleteWarning', language)}</strong><span>{t('vm.manage.deleteStorageWarning', language)}</span></div><div className="vm-manager-checkbox-row"><label className="vm-manager-checkbox"><input type="checkbox" checked={dialog.form.forceStop} onChange={(event) => updateForm({ forceStop: event.target.checked })} /><span>{t('vm.manage.forceStop', language)}</span></label><label className="vm-manager-checkbox danger"><input type="checkbox" checked={dialog.form.removeStorage} onChange={(event) => updateForm({ removeStorage: event.target.checked })} /><span>{t('vm.manage.removeStorage', language)}</span></label><label className="vm-manager-checkbox"><input type="checkbox" checked={dialog.form.removeNvram} onChange={(event) => updateForm({ removeNvram: event.target.checked })} /><span>{t('vm.manage.removeNvram', language)}</span></label><label className="vm-manager-checkbox"><input type="checkbox" checked={dialog.form.removeSnapshotsMetadata} onChange={(event) => updateForm({ removeSnapshotsMetadata: event.target.checked })} /><span>{t('vm.manage.removeSnapshotMetadata', language)}</span></label></div><label className="vm-manager-modal-field"><span>{t('vm.confirm.typeTarget', language, { name: dialog.domain.name })}</span><input autoFocus value={dialog.form.confirmation} onChange={(event) => updateForm({ confirmation: event.target.value })} /></label></>;
    if (dialog.kind === 'migrate') return <><label className="vm-manager-modal-field"><span>{t('vm.manage.destinationUri', language)}</span><input autoFocus value={dialog.form.destinationUri} onChange={(event) => updateForm({ destinationUri: event.target.value })} placeholder="qemu+ssh://user@host/system" /></label><div className="vm-manager-checkbox-row"><label className="vm-manager-checkbox"><input type="checkbox" checked={dialog.form.live} onChange={(event) => updateForm({ live: event.target.checked })} /><span>{t('vm.manage.liveMigration', language)}</span></label><label className="vm-manager-checkbox"><input type="checkbox" checked={dialog.form.persistent} onChange={(event) => updateForm({ persistent: event.target.checked })} /><span>{t('vm.manage.persistentTarget', language)}</span></label><label className="vm-manager-checkbox"><input type="checkbox" checked={dialog.form.undefineSource} onChange={(event) => updateForm({ undefineSource: event.target.checked })} /><span>{t('vm.manage.undefineSource', language)}</span></label><label className="vm-manager-checkbox"><input type="checkbox" checked={dialog.form.peerToPeer} onChange={(event) => updateForm({ peerToPeer: event.target.checked })} /><span>{t('vm.manage.peerToPeer', language)}</span></label><label className="vm-manager-checkbox"><input type="checkbox" checked={dialog.form.tunnelled} disabled={!dialog.form.peerToPeer} onChange={(event) => updateForm({ tunnelled: event.target.checked })} /><span>{t('vm.manage.tunnelled', language)}</span></label></div><label className="vm-manager-modal-field"><span>{t('vm.manage.copyStorage', language)}</span><select value={dialog.form.copyStorage} onChange={(event) => updateForm({ copyStorage: event.target.value })}><option value="none">{t('vm.manage.sharedStorage', language)}</option><option value="all">{t('vm.manage.copyAllStorage', language)}</option><option value="incremental">{t('vm.manage.copyIncremental', language)}</option></select></label><p className="vm-manager-modal-hint">{t('vm.manage.migrationHint', language)}</p></>;
    if (dialog.kind === 'xml') return <><textarea className="vm-manager-xml-editor" autoFocus value={dialog.form.xml} onChange={(event) => updateForm({ xml: event.target.value })} /><p className="vm-manager-modal-hint">{t('vm.manage.xmlHint', language)}</p></>;
    if (dialog.kind === 'create-volume') return <div className="vm-manager-form-grid"><label><span>{t('vm.manage.pool', language)}</span><select value={dialog.form.pool} onChange={(event) => updateForm({ pool: event.target.value })}>{pools.filter((pool) => pool.active).map((pool) => <option key={pool.name}>{pool.name}</option>)}</select></label><label><span>{t('vm.field.name', language)}</span><input autoFocus value={dialog.form.name} onChange={(event) => updateForm({ name: event.target.value })} /></label><label><span>{t('vm.storage.capacityGiB', language)}</span><input type="number" min="0.1" step="0.1" value={dialog.form.capacityGiB} onChange={(event) => updateForm({ capacityGiB: numberValue(event.target.value, 1) })} /></label><label><span>{t('vm.storage.allocationGiB', language)}</span><input type="number" min="0" step="0.1" value={dialog.form.allocationGiB} onChange={(event) => updateForm({ allocationGiB: numberValue(event.target.value) })} /></label><label><span>{t('vm.storage.format', language)}</span><select value={dialog.form.format} onChange={(event) => updateForm({ format: event.target.value })}><option value="qcow2">qcow2</option><option value="raw">raw</option></select></label></div>;
    return <><div className="vm-manager-danger-box"><strong>{t('vm.manage.deleteVolumeWarning', language)}</strong><span>{dialog.volume.path}</span></div><label className="vm-manager-modal-field"><span>{t('vm.confirm.typeTarget', language, { name: dialog.volume.name })}</span><input autoFocus value={dialog.confirmation} onChange={(event) => onChange({ ...dialog, confirmation: event.target.value })} /></label></>;
  };

  const titleId = `vm-manager-management-title-${dialog.kind}`;
  return createPortal(<div className="vm-manager-modal-overlay" role="presentation" onMouseDown={onCancel}><form className={`vm-manager-modal vm-manager-management-modal ${destructive ? 'destructive' : ''}`} role={destructive ? 'alertdialog' : 'dialog'} aria-modal="true" aria-labelledby={titleId} onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); if (valid && !busy) onSubmit(); }}><header><span className={destructive ? 'danger' : ''}><Icon size={18} /></span><div><strong id={titleId}>{t(titleIds[dialog.kind], language)}</strong>{target ? <small>{target}</small> : null}</div></header><div className="vm-manager-management-body">{renderBody()}</div>{error ? <div className="vm-manager-modal-error">{error}</div> : null}<footer><button type="button" onClick={onCancel} disabled={busy}>{t('common.cancel', language)}</button><button type="submit" className={destructive ? 'danger' : 'primary'} disabled={!valid || busy}>{destructive ? <Trash2 size={15} /> : <Save size={15} />}{busy ? t('vm.action.running', language) : t(titleIds[dialog.kind], language)}</button></footer></form></div>, document.body);
}

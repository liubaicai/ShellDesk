import { createPortal } from 'react-dom';
import { AlertTriangle, Camera, Trash2 } from 'lucide-react';
import { t, type AppLanguage } from '../../i18n';
import type { VirtualMachinePendingAction, VirtualMachineSnapshotForm } from './virshTypes';

interface ActionDialogProps {
  language: AppLanguage;
  pendingAction: VirtualMachinePendingAction | null;
  confirmationValue: string;
  busy: boolean;
  error: string;
  onConfirmationValueChange: (value: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}

function getActionTarget(action: VirtualMachinePendingAction) {
  if (action.kind === 'domain') return action.domain.name;
  if (action.kind === 'disk-detach') return `${action.domain.name} / ${action.disk.target}`;
  if (action.kind === 'interface-detach') return `${action.domain.name} / ${action.interface.mac}`;
  if (action.kind === 'snapshot-delete' || action.kind === 'snapshot-revert') return `${action.domain.name} / ${action.snapshot.name}`;
  if (action.kind === 'network') return action.network.name;
  return action.pool.name;
}

function isDestructiveAction(action: VirtualMachinePendingAction) {
  return (action.kind === 'domain' && (action.action === 'destroy' || action.action === 'reset'))
    || action.kind === 'disk-detach'
    || action.kind === 'interface-detach'
    || action.kind === 'snapshot-delete'
    || action.kind === 'snapshot-revert'
    || (action.kind === 'network' && action.action === 'destroy')
    || (action.kind === 'pool' && action.action === 'destroy');
}

function getActionLabel(action: VirtualMachinePendingAction, language: AppLanguage) {
  if (action.kind === 'snapshot-delete') return t('vm.snapshot.delete', language);
  if (action.kind === 'snapshot-revert') return t('vm.snapshot.revert', language);
  if (action.kind === 'disk-detach' || action.kind === 'interface-detach') return t('vm.manage.detach', language);
  if (action.kind === 'network') return t(`vm.action.${action.action}` as Parameters<typeof t>[0], language);
  if (action.kind === 'pool') return t(`vm.action.${action.action}` as Parameters<typeof t>[0], language);
  return t(`vm.action.${action.action}` as Parameters<typeof t>[0], language);
}

export function VirtualMachineActionDialog({
  language,
  pendingAction,
  confirmationValue,
  busy,
  error,
  onConfirmationValueChange,
  onCancel,
  onConfirm,
}: ActionDialogProps) {
  if (!pendingAction) return null;
  const destructive = isDestructiveAction(pendingAction);
  const target = getActionTarget(pendingAction);
  const requiresTyping = destructive && (pendingAction.kind === 'domain' || pendingAction.kind.startsWith('snapshot'));
  const canConfirm = !busy && (!requiresTyping || confirmationValue === target);

  return createPortal(
    <div className="vm-manager-modal-overlay" role="presentation" onMouseDown={onCancel}>
      <form
        className="vm-manager-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="vm-manager-action-title"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          if (canConfirm) onConfirm();
        }}
      >
        <header>
          <span className={destructive ? 'danger' : ''}>{destructive ? <AlertTriangle size={18} /> : <Camera size={18} />}</span>
          <div>
            <strong id="vm-manager-action-title">{getActionLabel(pendingAction, language)}</strong>
            <small>{target}</small>
          </div>
        </header>
        <p>{destructive ? t('vm.confirm.destructive', language) : t('vm.confirm.standard', language)}</p>
        {requiresTyping ? (
          <label className="vm-manager-modal-field">
            <span>{t('vm.confirm.typeTarget', language, { name: target })}</span>
            <input autoFocus value={confirmationValue} onChange={(event) => onConfirmationValueChange(event.target.value)} />
          </label>
        ) : null}
        {error ? <div className="vm-manager-modal-error">{error}</div> : null}
        <footer>
          <button type="button" onClick={onCancel} disabled={busy}>{t('common.cancel', language)}</button>
          <button type="submit" className={destructive ? 'danger' : 'primary'} disabled={!canConfirm}>
            {destructive ? <Trash2 size={15} /> : null}
            {busy ? t('vm.action.running', language) : getActionLabel(pendingAction, language)}
          </button>
        </footer>
      </form>
    </div>,
    document.body,
  );
}

interface SnapshotDialogProps {
  language: AppLanguage;
  domainName: string;
  form: VirtualMachineSnapshotForm | null;
  busy: boolean;
  error: string;
  onChange: (form: VirtualMachineSnapshotForm) => void;
  onCancel: () => void;
  onSubmit: () => void;
}

export function VirtualMachineSnapshotDialog({ language, domainName, form, busy, error, onChange, onCancel, onSubmit }: SnapshotDialogProps) {
  if (!form) return null;
  return createPortal(
    <div className="vm-manager-modal-overlay" role="presentation" onMouseDown={onCancel}>
      <form
        className="vm-manager-modal vm-manager-snapshot-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="vm-manager-snapshot-title"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          if (form.name.trim() && !busy) onSubmit();
        }}
      >
        <header>
          <span><Camera size={18} /></span>
          <div>
            <strong id="vm-manager-snapshot-title">{t('vm.snapshot.create', language)}</strong>
            <small>{domainName}</small>
          </div>
        </header>
        <label className="vm-manager-modal-field">
          <span>{t('vm.snapshot.name', language)}</span>
          <input autoFocus value={form.name} onChange={(event) => onChange({ ...form, name: event.target.value })} />
        </label>
        <label className="vm-manager-modal-field">
          <span>{t('vm.snapshot.description', language)}</span>
          <textarea rows={3} value={form.description} onChange={(event) => onChange({ ...form, description: event.target.value })} />
        </label>
        <label className="vm-manager-checkbox"><input type="checkbox" checked={form.diskOnly} onChange={(event) => onChange({ ...form, diskOnly: event.target.checked, quiesce: event.target.checked ? form.quiesce : false })} /><span>{t('vm.snapshot.diskOnly', language)}</span></label>
        <label className="vm-manager-checkbox"><input type="checkbox" checked={form.quiesce} disabled={!form.diskOnly} onChange={(event) => onChange({ ...form, quiesce: event.target.checked })} /><span>{t('vm.snapshot.quiesce', language)}</span></label>
        <p className="vm-manager-modal-hint">{t('vm.snapshot.hint', language)}</p>
        {error ? <div className="vm-manager-modal-error">{error}</div> : null}
        <footer>
          <button type="button" onClick={onCancel} disabled={busy}>{t('common.cancel', language)}</button>
          <button type="submit" className="primary" disabled={!form.name.trim() || busy}>{busy ? t('vm.action.running', language) : t('vm.snapshot.create', language)}</button>
        </footer>
      </form>
    </div>,
    document.body,
  );
}

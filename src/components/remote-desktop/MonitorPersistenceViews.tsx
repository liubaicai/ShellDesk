import { createPortal } from 'react-dom';

import { tCurrent } from '../../i18n';

export type MonitorPersistenceDialogMode = 'intro' | 'disable' | 'thresholds' | null;

interface MonitorPersistenceDialogProps {
  mode: MonitorPersistenceDialogMode;
  pending: boolean;
  error: string | null;
  thresholds: ShellDeskMonitorThresholds;
  onThresholdsChange: (thresholds: ShellDeskMonitorThresholds) => void;
  onDeclineIntro: () => void;
  onEnable: () => void;
  onCancel: () => void;
  onDisable: () => void;
  onSaveThresholds: () => void;
}

function ThresholdInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="monitor-threshold-field">
      <span>{label}</span>
      <span className="monitor-threshold-input">
        <input
          type="number"
          min={1}
          max={100}
          step={1}
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
        />
        <b>%</b>
      </span>
    </label>
  );
}

export function MonitorPersistenceDialog({
  mode,
  pending,
  error,
  thresholds,
  onThresholdsChange,
  onDeclineIntro,
  onEnable,
  onCancel,
  onDisable,
  onSaveThresholds,
}: MonitorPersistenceDialogProps) {
  if (!mode) {
    return null;
  }

  const validThresholds = Object.values(thresholds).every((value) => Number.isFinite(value) && value >= 1 && value <= 100);

  return createPortal(
    <div className="monitor-modal-backdrop" role="presentation">
      <div
        className={`monitor-persistence-dialog mode-${mode}`}
        role={mode === 'disable' ? 'alertdialog' : 'dialog'}
        aria-modal="true"
        aria-labelledby="monitor-persistence-dialog-title"
      >
        {mode === 'intro' ? (
          <>
            <div className="monitor-dialog-eyebrow">{tCurrent('monitor.persistence.optional')}</div>
            <h2 id="monitor-persistence-dialog-title">{tCurrent('monitor.persistence.introTitle')}</h2>
            <p>{tCurrent('monitor.persistence.introDescription')}</p>
            <ul className="monitor-dialog-facts">
              <li>{tCurrent('monitor.persistence.factInterval')}</li>
              <li>{tCurrent('monitor.persistence.factStorage')}</li>
              <li>{tCurrent('monitor.persistence.factDependency')}</li>
            </ul>
            {error ? <div className="monitor-dialog-error" role="alert">{error}</div> : null}
            <div className="monitor-dialog-actions">
              <button type="button" onClick={onDeclineIntro} disabled={pending}>{tCurrent('monitor.persistence.keepRealtime')}</button>
              <button type="button" className="primary" onClick={onEnable} disabled={pending}>
                {pending ? tCurrent('monitor.persistence.enabling') : tCurrent('monitor.persistence.enable')}
              </button>
            </div>
          </>
        ) : null}

        {mode === 'disable' ? (
          <>
            <div className="monitor-dialog-eyebrow">{tCurrent('monitor.persistence.scheduledAnalysis')}</div>
            <h2 id="monitor-persistence-dialog-title">{tCurrent('monitor.persistence.disableTitle')}</h2>
            <p>{tCurrent('monitor.persistence.disableDescription')}</p>
            {error ? <div className="monitor-dialog-error" role="alert">{error}</div> : null}
            <div className="monitor-dialog-actions">
              <button type="button" onClick={onCancel} disabled={pending}>{tCurrent('common.cancel')}</button>
              <button type="button" className="danger" onClick={onDisable} disabled={pending}>
                {pending ? tCurrent('monitor.persistence.disabling') : tCurrent('monitor.persistence.confirmDisable')}
              </button>
            </div>
          </>
        ) : null}

        {mode === 'thresholds' ? (
          <>
            <div className="monitor-dialog-eyebrow">{tCurrent('monitor.alert.rules')}</div>
            <h2 id="monitor-persistence-dialog-title">{tCurrent('monitor.alert.configureTitle')}</h2>
            <p>{tCurrent('monitor.alert.configureDescription')}</p>
            <div className="monitor-threshold-grid">
              <ThresholdInput
                label={tCurrent('monitor.alert.metric.cpu')}
                value={thresholds.cpu}
                onChange={(cpu) => onThresholdsChange({ ...thresholds, cpu })}
              />
              <ThresholdInput
                label={tCurrent('monitor.alert.metric.memory')}
                value={thresholds.memory}
                onChange={(memory) => onThresholdsChange({ ...thresholds, memory })}
              />
              <ThresholdInput
                label={tCurrent('monitor.alert.metric.disk')}
                value={thresholds.disk}
                onChange={(disk) => onThresholdsChange({ ...thresholds, disk })}
              />
            </div>
            {error ? <div className="monitor-dialog-error" role="alert">{error}</div> : null}
            <div className="monitor-dialog-actions">
              <button type="button" onClick={onCancel} disabled={pending}>{tCurrent('common.cancel')}</button>
              <button type="button" className="primary" onClick={onSaveThresholds} disabled={pending || !validThresholds}>
                {pending ? tCurrent('monitor.alert.saving') : tCurrent('monitor.alert.save')}
              </button>
            </div>
          </>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

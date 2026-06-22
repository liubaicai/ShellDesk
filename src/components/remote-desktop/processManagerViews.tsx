import { createPortal } from 'react-dom';
import { t, type AppLanguage } from '../../i18n';
import DismissibleAlert from './DismissibleAlert';
import MarkdownReport from './MarkdownReport';
import { formatCpu, formatMemory } from './processManagerParsers';
import type {
  ProcessAiReportPhase,
  PendingSignal,
  ProcessAiInsight,
  ProcessContextMenuState,
  ProcessDetail,
  RemoteProcessEntry,
  SignalDefinition,
} from './processManagerTypes';

function getAiReportPhaseLabel(phase: ProcessAiReportPhase, language: AppLanguage) {
  if (phase === 'preparing') return t('process.ai.phase.preparing', language);
  if (phase === 'requesting') return t('process.ai.phase.requesting', language);
  if (phase === 'streaming') return t('process.ai.phase.streaming', language);
  if (phase === 'done') return t('process.ai.phase.done', language);
  if (phase === 'error') return t('process.ai.phase.error', language);
  return t('process.ai.phase.idle', language);
}

export function getProcessContextMenuPosition(clientX: number, clientY: number) {
  const menuWidth = 184;
  const menuHeight = 172;
  const edgePadding = 8;
  const maxX = Math.max(edgePadding, window.innerWidth - menuWidth - edgePadding);
  const maxY = Math.max(edgePadding, window.innerHeight - menuHeight - edgePadding);

  return {
    x: Math.min(Math.max(edgePadding, clientX), maxX),
    y: Math.min(Math.max(edgePadding, clientY), maxY),
  };
}

export function getStateTone(state?: string) {
  if (!state) {
    return 'idle';
  }

  const normalizedState = state.toUpperCase();

  if (normalizedState.startsWith('R')) {
    return 'running';
  }

  if (normalizedState.startsWith('D') || normalizedState.includes('NOTRESPONDING')) {
    return 'blocked';
  }

  if (normalizedState.startsWith('Z')) {
    return 'zombie';
  }

  return 'idle';
}

interface ProcessDetailPanelProps {
  language: AppLanguage;
  isWindowsHost: boolean;
  selectedPid: number | null;
  selectedProcess: RemoteProcessEntry | null;
  selectedParent: RemoteProcessEntry | null;
  selectedChildren: RemoteProcessEntry[];
  processDetail: ProcessDetail | null;
  detailLoading: boolean;
  processInsight: ProcessAiInsight | null;
  processInsightLoadingPid: number | null;
  selectedSignal: SignalDefinition;
  selectedSignalValue: string;
  signals: SignalDefinition[];
  signalingPid: number | null;
  onSelectPid: (pid: number) => void;
  onCopy: (value: string, label: string) => void;
  onLoadDetails: (pid: number) => void;
  onRequestSignal: (process: RemoteProcessEntry) => void;
  onRequestInsight: () => void;
  onSignalChange: (value: string) => void;
}

export function ProcessDetailPanel({
  language,
  isWindowsHost,
  selectedPid,
  selectedProcess,
  selectedParent,
  selectedChildren,
  processDetail,
  detailLoading,
  processInsight,
  processInsightLoadingPid,
  selectedSignal,
  selectedSignalValue,
  signals,
  signalingPid,
  onSelectPid,
  onCopy,
  onLoadDetails,
  onRequestSignal,
  onRequestInsight,
  onSignalChange,
}: ProcessDetailPanelProps) {
  if (!selectedProcess) {
    return (
      <aside className="proc-detail-panel" aria-label={t('process.ui.detailAria', language)}>
        <div className="proc-detail-empty">
          <strong>{selectedPid === null ? t('process.ui.noSelected', language) : t('process.ui.pidMissingTitle', language, { pid: selectedPid })}</strong>
          <span>{selectedPid === null ? t('process.ui.selectPid', language) : t('process.ui.pidUnavailable', language)}</span>
        </div>
      </aside>
    );
  }

  return (
    <aside className="proc-detail-panel" aria-label={t('process.ui.detailAria', language)}>
      <header className="proc-detail-header">
        <span>PID</span>
        <strong>{selectedProcess.pid}</strong>
        <div className="proc-detail-header-actions">
          <button type="button" onClick={onRequestInsight} disabled={processInsightLoadingPid !== null} title={t('process.ui.aiIntro', language)}>
            {processInsightLoadingPid === selectedProcess.pid ? t('process.ui.analyzing', language) : 'AI'}
          </button>
          <button type="button" onClick={() => onCopy(String(selectedProcess.pid), ' PID')}>
            {t('process.ui.copy', language)}
          </button>
        </div>
      </header>

      <div className="proc-detail-metrics">
        <div>
          <span>{isWindowsHost ? t('process.ui.cpuAccumulated', language) : 'CPU'}</span>
          <strong>{formatCpu(selectedProcess, isWindowsHost)}</strong>
        </div>
        <div>
          <span>{isWindowsHost ? t('process.ui.workingSet', language) : t('process.ui.memory', language)}</span>
          <strong>{formatMemory(selectedProcess, isWindowsHost)}</strong>
        </div>
      </div>

      <dl className="proc-detail-list">
        <div><dt>PPID</dt><dd>{selectedProcess.ppid ?? '-'}</dd></div>
        <div><dt>{t('process.ui.user', language)}</dt><dd title={selectedProcess.user}>{selectedProcess.user || '-'}</dd></div>
        <div><dt>{t('process.ui.status', language)}</dt><dd><span className={`proc-stat-tag ${getStateTone(selectedProcess.state)}`}>{selectedProcess.state || '-'}</span></dd></div>
        <div><dt>{t('process.ui.start', language)}</dt><dd>{selectedProcess.startTime || '-'}</dd></div>
        <div><dt>{isWindowsHost ? t('process.ui.cpuTime', language) : t('process.ui.runtime', language)}</dt><dd>{selectedProcess.runtime || selectedProcess.cpuTime || '-'}</dd></div>
        <div><dt>TTY</dt><dd>{selectedProcess.tty || '-'}</dd></div>
      </dl>

      {processInsight?.pid === selectedProcess.pid ? (
        <section className={`proc-ai-insight ${processInsight.error ? 'danger' : ''}`} aria-label={t('process.ui.aiIntro', language)}>
          <strong>{t('process.ui.aiIntro', language)}</strong>
          {processInsight.error ? <span>{processInsight.error}</span> : <p data-i18n-skip>{processInsight.content}</p>}
        </section>
      ) : null}

      <section className="proc-detail-section">
        <div className="proc-section-title">
          <strong>{t('process.ui.commandLine', language)}</strong>
          <button type="button" onClick={() => onCopy(selectedProcess.command, t('process.ui.commandLine', language))}>{t('process.ui.copy', language)}</button>
        </div>
        <pre className="proc-command-box">{selectedProcess.command}</pre>
        {(processDetail?.cwd || processDetail?.executablePath || selectedProcess.executablePath) ? (
          <div className="proc-path-list">
            {processDetail?.cwd ? <span title={processDetail.cwd}>cwd: {processDetail.cwd}</span> : null}
            {processDetail?.executablePath || selectedProcess.executablePath ? (
              <span title={processDetail?.executablePath || selectedProcess.executablePath}>
                path: {processDetail?.executablePath || selectedProcess.executablePath}
              </span>
            ) : null}
          </div>
        ) : null}
      </section>

      <section className="proc-detail-section">
        <div className="proc-section-title">
          <strong>{t('process.ui.parentChild', language)}</strong>
          <span>{t('process.ui.childCount', language, { count: selectedChildren.length })}</span>
        </div>
        <div className="proc-relation-list">
          {selectedParent ? (
            <button type="button" onClick={() => onSelectPid(selectedParent.pid)}>
              <span>{t('process.ui.parentProcess', language)}</span>
              <strong>{selectedParent.pid}</strong>
              <em>{selectedParent.command}</em>
            </button>
          ) : <div className="proc-relation-empty">{t('process.ui.noParent', language)}</div>}
          {selectedChildren.slice(0, 8).map((child) => (
            <button key={child.pid} type="button" onClick={() => onSelectPid(child.pid)}>
              <span>{t('process.ui.childProcess', language)}</span>
              <strong>{child.pid}</strong>
              <em>{child.command}</em>
            </button>
          ))}
          {selectedChildren.length > 8 ? <div className="proc-relation-empty">{t('process.ui.moreChildren', language, { count: selectedChildren.length - 8 })}</div> : null}
        </div>
      </section>

      <section className="proc-detail-section">
        <div className="proc-section-title">
          <strong>{t('process.ui.portOwnership', language)}</strong>
          <button type="button" onClick={() => onLoadDetails(selectedProcess.pid)} disabled={detailLoading}>
            {detailLoading ? t('process.ui.reading', language) : t('process.ui.reread', language)}
          </button>
        </div>
        {processDetail?.error ? <div className="proc-detail-warning">{processDetail.error}</div> : null}
        {processDetail?.ports.length ? (
          <div className="proc-port-list">
            {processDetail.ports.slice(0, 6).map((port) => <code key={port}>{port}</code>)}
            {processDetail.ports.length > 6 ? <span>{t('process.ui.morePorts', language, { count: processDetail.ports.length - 6 })}</span> : null}
          </div>
        ) : <div className="proc-relation-empty">{detailLoading ? t('process.ui.readingPorts', language) : t('process.ui.noPorts', language)}</div>}
      </section>

      <section className="proc-detail-section danger-zone">
        <div className="proc-section-title">
          <strong>{isWindowsHost ? t('process.ui.endTask', language) : t('process.ui.sendSignal', language)}</strong>
        </div>
        {!isWindowsHost ? (
          <>
            <select className="proc-select" value={selectedSignalValue} onChange={(event) => onSignalChange(event.target.value)}>
              {signals.map((signal) => <option key={signal.value} value={signal.value}>{signal.label}</option>)}
            </select>
            <p>{t(selectedSignal.descriptionId, language)}</p>
          </>
        ) : <p>{t('process.ui.stopProcessHint', language)}</p>}
        <button type="button" className="proc-danger-button" disabled={signalingPid === selectedProcess.pid} onClick={() => onRequestSignal(selectedProcess)}>
          {signalingPid === selectedProcess.pid
            ? t('process.ui.processing', language)
            : isWindowsHost
              ? t('process.ui.endProcess', language)
              : t('process.ui.sendSignalButton', language, { signal: selectedSignal.name })}
        </button>
      </section>
    </aside>
  );
}

interface ProcessContextMenuProps {
  contextMenu: ProcessContextMenuState | null;
  language: AppLanguage;
  isWindowsHost: boolean;
  signalingPid: number | null;
  selectedSignal: SignalDefinition;
  onClose: () => void;
  onCopy: (value: string, label: string) => void;
  onRequestSignal: (process: RemoteProcessEntry) => void;
}

export function ProcessContextMenu({ contextMenu, language, isWindowsHost, signalingPid, selectedSignal, onClose, onCopy, onRequestSignal }: ProcessContextMenuProps) {
  if (!contextMenu) {
    return null;
  }

  return createPortal(
    <>
      <div
        className="proc-context-menu-overlay"
        onClick={onClose}
        onContextMenu={(event) => {
          event.preventDefault();
          onClose();
        }}
      />
      <div className="proc-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} role="menu" onClick={(event) => event.stopPropagation()}>
        <div className="proc-context-menu-title">
          <strong>PID {contextMenu.process.pid}</strong>
          <span title={contextMenu.process.command}>{contextMenu.process.command}</span>
        </div>
        <button
          type="button"
          role="menuitem"
          className="danger-text"
          disabled={signalingPid === contextMenu.process.pid}
          onClick={() => {
            const targetProcess = contextMenu.process;
            onClose();
            onRequestSignal(targetProcess);
          }}
        >
          {signalingPid === contextMenu.process.pid
            ? t('process.ui.processing', language)
            : isWindowsHost
              ? t('process.ui.endProcess', language)
              : t('process.ui.terminateWithSignal', language, { signal: selectedSignal.name })}
        </button>
        <div className="proc-context-menu-sep" />
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            onClose();
            onCopy(String(contextMenu.process.pid), ' PID');
          }}
        >
          {t('process.ui.copyPid', language)}
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            onClose();
            onCopy(contextMenu.process.command, t('process.ui.commandLine', language));
          }}
        >
          {t('process.ui.copyCommandLine', language)}
        </button>
      </div>
    </>,
    document.body,
  );
}

interface SignalConfirmModalProps {
  pendingSignal: PendingSignal | null;
  language: AppLanguage;
  isWindowsHost: boolean;
  onCancel: () => void;
  onConfirm: (pending: PendingSignal) => void;
}

export function SignalConfirmModal({ pendingSignal, language, isWindowsHost, onCancel, onConfirm }: SignalConfirmModalProps) {
  if (!pendingSignal) {
    return null;
  }

  return createPortal(
    <div className="proc-modal-overlay" role="presentation" onClick={onCancel}>
      <div
        className="proc-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="proc-signal-confirm-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div id="proc-signal-confirm-title" className="proc-modal-title">
          {isWindowsHost ? t('process.ui.endProcess', language) : t('process.ui.sendSignalButton', language, { signal: pendingSignal.signal.name })}
        </div>
        <div className="proc-modal-message">
          <p>{t('process.modal.targetPid', language)}<strong>{pendingSignal.pid}</strong></p>
          <p>{t(pendingSignal.signal.descriptionId, language)}</p>
          <code>{pendingSignal.command}</code>
        </div>
        <div className="proc-modal-actions">
          <button type="button" className="proc-modal-btn" onClick={onCancel}>{t('common.cancel', language)}</button>
          <button type="button" className="proc-modal-btn danger" onClick={() => onConfirm(pendingSignal)}>
            {t('process.modal.confirmExecute', language)}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

interface ProcessAiReportModalProps {
  open: boolean;
  language: AppLanguage;
  phase: ProcessAiReportPhase;
  text: string;
  error: string;
  notice: string;
  snapshotNote: string;
  isBusy: boolean;
  onClose: () => void;
  onDismissError: () => void;
  onDismissNotice: () => void;
  onCopy: () => void;
  onExport: () => void;
}

export function ProcessAiReportModal({
  open,
  language,
  phase,
  text,
  error,
  notice,
  snapshotNote,
  isBusy,
  onClose,
  onDismissError,
  onDismissNotice,
  onCopy,
  onExport,
}: ProcessAiReportModalProps) {
  if (!open) {
    return null;
  }

  return createPortal(
    <div className="proc-modal-overlay" role="presentation" onClick={onClose}>
      <div
        className="proc-modal proc-ai-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="proc-ai-report-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="proc-ai-modal-header">
          <div>
            <span>SD-Agent</span>
            <strong id="proc-ai-report-title">{t('process.ai.report.title', language)}</strong>
          </div>
          <button type="button" className="proc-ai-close" onClick={onClose} aria-label={t('process.ai.report.closeAria', language)}>×</button>
        </div>

        <div className={`proc-ai-progress ${phase}`}>
          <div className="proc-ai-progress-bar" aria-hidden="true">
            <span />
          </div>
          <strong>{getAiReportPhaseLabel(phase, language)}</strong>
          <em>{snapshotNote || t('process.ai.report.snapshotIntro', language)}</em>
        </div>

        {error ? <DismissibleAlert className="proc-alert danger" onDismiss={onDismissError} role="alert">{error}</DismissibleAlert> : null}
        {notice ? <DismissibleAlert className="proc-alert success" onDismiss={onDismissNotice}>{notice}</DismissibleAlert> : null}

        <MarkdownReport
          className="proc-ai-report"
          content={text}
          placeholder={isBusy ? t('process.ai.report.placeholderGenerating', language) : t('process.ai.report.placeholderEmpty', language)}
          renderMarkdown={!isBusy}
          stickToBottom={isBusy}
        />

        <div className="proc-modal-actions proc-ai-modal-actions">
          <button type="button" className="proc-modal-btn" onClick={onClose}>{t('common.close', language)}</button>
          <button type="button" className="proc-modal-btn" onClick={onCopy} disabled={!text.trim()}>{t('process.ai.report.copy', language)}</button>
          <button type="button" className="proc-modal-btn primary" onClick={onExport} disabled={!text.trim()}>{t('process.ai.report.export', language)}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

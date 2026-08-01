import { createPortal } from 'react-dom';

import { t } from '../../i18n';

export interface TerminalSelectionAiState {
  selection: string;
  action: 'explain' | 'fix';
  result: string;
  error: string;
  loading: boolean;
}

export function TerminalSelectionAiPortal({
  state,
  language,
  onClose,
  onCopy,
}: {
  state: TerminalSelectionAiState | null;
  language: ShellDeskAppSettings['language'];
  onClose: () => void;
  onCopy: (text: string) => void;
}) {
  if (!state) return null;
  return createPortal(
    <div className="notepad-modal-overlay" role="presentation" onClick={onClose}>
      <div className="notepad-modal terminal-selection-ai-dialog" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <div className="notepad-modal-title">
          {state.action === 'fix'
            ? t('terminal.selectionAi.fixTitle', language)
            : t('terminal.selectionAi.explainTitle', language)}
        </div>
        <pre className="terminal-selection-ai-source">{state.selection}</pre>
        <div className="terminal-selection-ai-result" aria-live="polite">
          {state.loading ? t('terminal.selectionAi.loading', language) : null}
          {state.error ? <span className="terminal-selection-ai-error">{state.error}</span> : null}
          {state.result ? <pre>{state.result}</pre> : null}
        </div>
        <div className="notepad-modal-actions">
          <button type="button" className="notepad-modal-btn" onClick={onClose}>{t('common.close', language)}</button>
          <button type="button" className="notepad-modal-btn primary" disabled={!state.result} onClick={() => onCopy(state.result)}>
            {t('terminal.selectionAi.copy', language)}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

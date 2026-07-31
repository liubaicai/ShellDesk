import { createPortal } from 'react-dom';

import { t, type AppLanguage } from '../../i18n';

interface TerminalCloseConfirmPortalProps {
  language: AppLanguage;
  windowId: string;
  onCancel: () => void;
  onConfirm: (windowId: string) => void;
}

export function TerminalCloseConfirmPortal({
  language,
  windowId,
  onCancel,
  onConfirm,
}: TerminalCloseConfirmPortalProps) {
  return createPortal(
    <div className="notepad-modal-overlay" role="presentation" onClick={onCancel}>
      <div
        className="notepad-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="terminal-close-confirm-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div id="terminal-close-confirm-title" className="notepad-modal-title">
          {t('terminal.closeConfirm.title', language)}
        </div>
        <div className="notepad-modal-message">{t('terminal.closeConfirm.message', language)}</div>
        <div className="notepad-modal-actions">
          <button type="button" className="notepad-modal-btn" onClick={onCancel}>
            {t('common.cancel', language)}
          </button>
          <button type="button" className="notepad-modal-btn danger" onClick={() => onConfirm(windowId)}>
            {t('common.close', language)}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

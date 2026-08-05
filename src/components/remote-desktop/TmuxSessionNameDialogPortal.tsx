import { type FormEvent, useState } from 'react';
import { createPortal } from 'react-dom';

import { handleModalKeyboardNavigation } from '../../features/remote-desktop/desktopKeyboardNavigation';
import { t, type AppLanguage } from '../../i18n';

interface TmuxSessionNameDialogPortalProps {
  language: AppLanguage;
  suggestedName: string;
  onCancel: () => void;
  onConfirm: (sessionName: string) => void;
}

export function TmuxSessionNameDialogPortal({
  language,
  suggestedName,
  onCancel,
  onConfirm,
}: TmuxSessionNameDialogPortalProps) {
  const [sessionName, setSessionName] = useState('');

  const submitSessionName = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onConfirm(sessionName.trim() || suggestedName);
  };

  return createPortal(
    <div className="notepad-modal-overlay" role="presentation" onClick={onCancel}>
      <form
        className="notepad-modal desktop-folder-rename-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="terminal-tmux-name-dialog-title"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => handleModalKeyboardNavigation(event, event.currentTarget, onCancel)}
        onSubmit={submitSessionName}
      >
        <div id="terminal-tmux-name-dialog-title" className="notepad-modal-title">
          {t('terminal.tmux.nameDialogTitle', language)}
        </div>
        <label className="notepad-modal-field">
          <span>{t('terminal.tmux.sessionNameLabel', language)}</span>
          <input
            className="notepad-modal-input"
            value={sessionName}
            maxLength={80}
            autoFocus
            placeholder={t('terminal.tmux.sessionNamePlaceholder', language, { name: suggestedName })}
            onChange={(event) => setSessionName(event.target.value)}
          />
        </label>
        <div className="notepad-modal-message">
          {t('terminal.tmux.sessionNameHint', language, { name: suggestedName })}
        </div>
        <div className="notepad-modal-actions">
          <button type="button" className="notepad-modal-btn" onClick={onCancel}>
            {t('common.cancel', language)}
          </button>
          <button type="submit" className="notepad-modal-btn primary">
            {t('terminal.tmux.createSession', language)}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { t } from '../../i18n';

interface TerminalCommandCenterPortalProps {
  open: boolean;
  language: ShellDeskAppSettings['language'];
  currentScope: string;
  currentCommands: string[];
  allCommands: Array<{ scope: string; command: string }>;
  recordedCommands: string[];
  recording: boolean;
  onClose: () => void;
  onInsert: (command: string) => void;
  onRun: (command: string) => void;
  onSaveSnippet: (command: string) => void;
  onClearHistory: () => void;
  onToggleRecording: () => void;
  onExportScript: () => void;
}

export function TerminalCommandCenterPortal({
  open,
  language,
  currentScope,
  currentCommands,
  allCommands,
  recordedCommands,
  recording,
  onClose,
  onInsert,
  onRun,
  onSaveSnippet,
  onClearHistory,
  onToggleRecording,
  onExportScript,
}: TerminalCommandCenterPortalProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [scope, setScope] = useState<'current' | 'all'>('current');
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (!open) return undefined;
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose, open]);

  const commands = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const source = scope === 'current'
      ? currentCommands.map((command) => ({ scope: currentScope, command }))
      : allCommands;
    return source
      .filter(({ command }) => !normalizedQuery || command.toLocaleLowerCase().includes(normalizedQuery))
      .slice(0, 200);
  }, [allCommands, currentCommands, currentScope, query, scope]);

  if (!open) return null;
  return createPortal(
    <div className="notepad-modal-overlay" role="presentation" onClick={onClose}>
      <section className="notepad-modal terminal-command-center" role="dialog" aria-modal="true" aria-labelledby="terminal-command-center-title" onClick={(event) => event.stopPropagation()}>
        <header>
          <span>
            <strong id="terminal-command-center-title">{t('terminal.commandCenter.title', language)}</strong>
            <small>{t('terminal.commandCenter.summary', language)}</small>
          </span>
          <button type="button" aria-label={t('common.close', language)} onClick={onClose}>×</button>
        </header>
        <div className="terminal-command-center-toolbar">
          <div role="tablist" aria-label={t('terminal.commandCenter.scope', language)}>
            <button type="button" role="tab" aria-selected={scope === 'current'} onClick={() => setScope('current')}>{t('terminal.commandCenter.currentHost', language)}</button>
            <button type="button" role="tab" aria-selected={scope === 'all'} onClick={() => setScope('all')}>{t('terminal.commandCenter.allHosts', language)}</button>
          </div>
          <input ref={inputRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('terminal.commandCenter.search', language)} />
        </div>
        <div className="terminal-command-center-list">
          {commands.length ? commands.map((entry, index) => (
            <article key={`${entry.scope}:${entry.command}:${index}`}>
              <span>
                <code>{entry.command}</code>
                {scope === 'all' ? <small>{entry.scope}</small> : null}
              </span>
              <div>
                <button type="button" onClick={() => onInsert(entry.command)}>{t('terminal.commandCenter.insert', language)}</button>
                <button type="button" onClick={() => onSaveSnippet(entry.command)}>{t('terminal.commandCenter.saveSnippet', language)}</button>
                <button type="button" className="primary" onClick={() => onRun(entry.command)}>{t('terminal.commandCenter.run', language)}</button>
              </div>
            </article>
          )) : <p>{t('terminal.commandCenter.empty', language)}</p>}
        </div>
        <footer>
          <span>
            <button type="button" className={recording ? 'danger' : undefined} onClick={onToggleRecording}>
              {recording ? t('terminal.commandCenter.stopRecording', language) : t('terminal.commandCenter.startRecording', language)}
            </button>
            <small>{t('terminal.commandCenter.recorded', language, { count: recordedCommands.length })}</small>
          </span>
          <span>
            <button type="button" disabled={!recordedCommands.length} onClick={onExportScript}>{t('terminal.commandCenter.exportScript', language)}</button>
            <button type="button" onClick={onClearHistory}>{t('terminal.commandCenter.clearHistory', language)}</button>
          </span>
        </footer>
      </section>
    </div>,
    document.body,
  );
}

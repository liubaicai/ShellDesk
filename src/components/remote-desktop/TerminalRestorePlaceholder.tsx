import { PlugZap, ShieldCheck } from 'lucide-react';

import type { RemoteTerminalLaunchOptions } from './RemoteTerminal';
import { t } from '../../i18n';

interface TerminalRestorePlaceholderProps {
  language: ShellDeskAppSettings['language'];
  launchOptions?: RemoteTerminalLaunchOptions;
  onReconnect: () => void;
}

export function TerminalRestorePlaceholder({
  language,
  launchOptions,
  onReconnect,
}: TerminalRestorePlaceholderProps) {
  const context = launchOptions?.mode === 'tmux'
    ? launchOptions.tmuxSessionName
    : launchOptions?.workingDirectory || launchOptions?.shell;

  return (
    <section className="terminal-restore-placeholder" aria-label={t('terminal.workspace.restoreTitle', language)}>
      <div className="terminal-restore-icon"><ShieldCheck aria-hidden="true" /></div>
      <strong>{launchOptions?.title || t('terminal.workspace.restoreTitle', language)}</strong>
      <p>{t('terminal.workspace.restoreSummary', language)}</p>
      {context ? <code>{context}</code> : null}
      <button type="button" onClick={onReconnect}>
        <PlugZap aria-hidden="true" />
        {t('terminal.workspace.reconnect', language)}
      </button>
    </section>
  );
}

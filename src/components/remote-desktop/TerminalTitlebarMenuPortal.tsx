import { createPortal } from 'react-dom';

import type {
  DesktopWindowState,
  TerminalTitlebarMenuState,
  TmuxMenuState,
} from '../../remoteDesktopWindowModel';
import {
  getTerminalSnippetGroups,
  getTerminalSnippetPreview,
} from '../../remoteDesktopWindowModel';
import type { TerminalWorkspaceSplitDirection } from '../../terminalWorkspace';
import type { RemoteTerminalToolAction } from './RemoteTerminal';
import type { RemoteSystemType } from './types';
import { t } from '../../i18n';

interface TerminalTitlebarMenuPortalProps {
  menu: TerminalTitlebarMenuState;
  desktopWindow: DesktopWindowState;
  language: ShellDeskAppSettings['language'];
  systemType?: RemoteSystemType;
  snippets: ShellDeskTerminalSnippet[];
  tmuxState: TmuxMenuState;
  canOpenSettings: boolean;
  onClose: () => void;
  onReconnect: () => void;
  onNewWindow: () => void;
  onSplit: (direction: TerminalWorkspaceSplitDirection) => void;
  onCloneWorkspace: () => void;
  broadcastEnabled: boolean;
  onToggleBroadcast: () => void;
  onRequestTool: (action: RemoteTerminalToolAction) => void;
  onNewTmux: () => void;
  onRefreshTmux: () => void;
  onOpenTmux: (sessionName: string) => void;
  onRunSnippet: (command: string) => void;
  onKillTmux: () => void;
}

export function TerminalTitlebarMenuPortal({
  menu,
  desktopWindow,
  language,
  systemType,
  snippets,
  tmuxState,
  canOpenSettings,
  onClose,
  onReconnect,
  onNewWindow,
  onSplit,
  onCloneWorkspace,
  broadcastEnabled,
  onToggleBroadcast,
  onRequestTool,
  onNewTmux,
  onRefreshTmux,
  onOpenTmux,
  onRunSnippet,
  onKillTmux,
}: TerminalTitlebarMenuPortalProps) {
  return createPortal(
    <>
      <div
        className="context-menu-overlay"
        onClick={onClose}
        onContextMenu={(event) => {
          event.preventDefault();
          onClose();
        }}
      />
      <div
        className="context-menu terminal-titlebar-menu"
        style={{ left: menu.x, top: menu.y }}
        role="menu"
        aria-label={t('terminal.titlebar.tools', language)}
      >
        {desktopWindow.terminalRestorePending ? (
          <button type="button" role="menuitem" onClick={onReconnect}>
            {t('terminal.workspace.reconnect', language)}
          </button>
        ) : null}
        <button type="button" role="menuitem" onClick={onNewWindow}>
          {t('terminal.titlebar.newWindow', language)}
        </button>
        <button type="button" role="menuitem" onClick={() => onSplit('right')}>
          {t('terminal.workspace.splitRight', language)}
        </button>
        <button type="button" role="menuitem" onClick={() => onSplit('down')}>
          {t('terminal.workspace.splitDown', language)}
        </button>
        <button type="button" role="menuitem" onClick={onCloneWorkspace}>
          {t('terminal.workspace.clone', language)}
        </button>
        <button type="button" role="menuitem" className={broadcastEnabled ? 'terminal-broadcast-menu-active' : undefined} onClick={onToggleBroadcast}>
          {broadcastEnabled ? t('terminal.broadcast.disable', language) : t('terminal.broadcast.enable', language)}
        </button>

        {!desktopWindow.terminalRestorePending ? (
          <>
            <button type="button" role="menuitem" onClick={() => onRequestTool('search')}>
              {t('terminal.titlebar.searchOutput', language)}
            </button>
            <button type="button" role="menuitem" onClick={() => onRequestTool('clear')}>
              {t('terminal.titlebar.clear', language)}
            </button>
            <button type="button" role="menuitem" onClick={() => onRequestTool('compose')}>
              {t('terminal.titlebar.compose', language)}
            </button>
            <button type="button" role="menuitem" onClick={() => onRequestTool('command-center')}>
              {t('terminal.titlebar.commandCenter', language)}
            </button>
            <button type="button" role="menuitem" onClick={() => onRequestTool('open-files-here')}>
              {t('terminal.titlebar.openFilesHere', language)}
            </button>
            <button type="button" role="menuitem" onClick={() => onRequestTool('toggle-log')}>
              {t('terminal.titlebar.toggleSessionLog', language)}
            </button>
            <button type="button" role="menuitem" onClick={() => onRequestTool('paste-image')}>
              {t('terminal.titlebar.pasteClipboardImage', language)}
            </button>
            {systemType !== 'windows' ? (
              <div className="context-menu-item-has-submenu terminal-titlebar-tmux-menu">
                <button type="button" role="menuitem" aria-haspopup="menu">
                  {t('terminal.tmux.menu', language)}
                </button>
                <div className="context-submenu terminal-titlebar-tmux-submenu" role="menu" aria-label={t('terminal.tmux.menu', language)}>
                  <button type="button" role="menuitem" onClick={onNewTmux}>
                    {t('terminal.tmux.newSession', language)}
                  </button>
                  <button type="button" role="menuitem" onClick={(event) => {
                    event.stopPropagation();
                    onRefreshTmux();
                  }}>
                    {t('terminal.tmux.refresh', language)}
                  </button>
                  <div className="context-menu-sep" />
                  {tmuxState.status === 'loading' ? (
                    <button type="button" role="menuitem" disabled>
                      {t('terminal.tmux.loading', language)}
                    </button>
                  ) : null}
                  {tmuxState.status === 'error' ? (
                    <button type="button" role="menuitem" className="terminal-titlebar-tmux-message" disabled title={tmuxState.error}>
                      {tmuxState.error || t('terminal.tmux.notInstalled', language)}
                    </button>
                  ) : null}
                  {tmuxState.status === 'ready' && tmuxState.sessions.length === 0 ? (
                    <button type="button" role="menuitem" disabled>
                      {t('terminal.tmux.empty', language)}
                    </button>
                  ) : null}
                  {tmuxState.sessions.map((session) => (
                    <button
                      key={session.name}
                      type="button"
                      role="menuitem"
                      className="terminal-titlebar-tmux-session-button"
                      title={t('terminal.tmux.attachSession', language, { name: session.name })}
                      onClick={() => onOpenTmux(session.name)}
                    >
                      <span className="terminal-titlebar-tmux-session-text">
                        <strong>{session.name}</strong>
                        <small>
                          {t('terminal.tmux.sessionMeta', language, {
                            windows: String(session.windows),
                            attached: String(session.attached),
                          })}
                        </small>
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            {snippets.length ? (
              <div className="context-menu-item-has-submenu terminal-titlebar-snippets-menu">
                <button type="button" role="menuitem" aria-haspopup="menu">
                  {t('terminal.titlebar.snippets', language)}
                </button>
                <div className="context-submenu terminal-titlebar-snippets-submenu" role="menu" aria-label={t('terminal.titlebar.snippets', language)}>
                  {getTerminalSnippetGroups(snippets, language).map((group) => (
                    <div key={group.label} className="terminal-titlebar-snippet-group" role="presentation">
                      <div className="terminal-titlebar-snippet-group-label">{group.label}</div>
                      {group.snippets.map((snippet) => (
                        <button
                          key={snippet.id}
                          type="button"
                          role="menuitem"
                          className="terminal-titlebar-snippet-button"
                          title={snippet.command}
                          onClick={() => onRunSnippet(snippet.command)}
                        >
                          <span className="terminal-titlebar-snippet-text">
                            <strong>{snippet.label}</strong>
                            <small>{getTerminalSnippetPreview(snippet)}</small>
                          </span>
                          {snippet.shortcut ? <kbd>{snippet.shortcut}</kbd> : null}
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <button type="button" role="menuitem" disabled>
                {t('terminal.titlebar.noSnippets', language)}
              </button>
            )}
            <div className="context-menu-sep" />
            <button type="button" role="menuitem" onClick={() => onRequestTool('toggle-follow')}>
              {t('terminal.titlebar.toggleFollow', language)}
            </button>
            <button type="button" role="menuitem" onClick={() => onRequestTool('scroll-bottom')}>
              {t('terminal.titlebar.scrollBottom', language)}
            </button>
            {desktopWindow.terminalStatus === 'exited' ? (
              <button type="button" role="menuitem" onClick={() => onRequestTool('restart')}>
                {t('terminal.titlebar.restartSession', language)}
              </button>
            ) : null}
            {canOpenSettings ? (
              <>
                <div className="context-menu-sep" />
                <button type="button" role="menuitem" onClick={() => onRequestTool('settings')}>
                  {t('terminal.titlebar.settings', language)}
                </button>
              </>
            ) : null}
            {desktopWindow.terminalLaunchOptions?.mode === 'tmux' ? (
              <>
                <div className="context-menu-sep" />
                <button
                  type="button"
                  role="menuitem"
                  className="danger-text"
                  onClick={onKillTmux}
                >
                  {t('terminal.tmux.killCurrent', language)}
                </button>
              </>
            ) : null}
          </>
        ) : null}
      </div>
    </>,
    document.body,
  );
}

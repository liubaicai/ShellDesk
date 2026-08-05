import { useState } from 'react';
import { createRoot } from 'react-dom/client';

import { TerminalTitlebarMenuPortal } from '../../src/components/remote-desktop/TerminalTitlebarMenuPortal';
import { loadFullMessageCatalog } from '../../src/i18n';
import { createTmuxSessionName } from '../../src/remoteDesktopWindowModel';
import '../../src/styles/critical.scss';
import '../../src/styles/deferred.scss';

await loadFullMessageCatalog();

const existingSessionNames = ['sd', 'shelldesk-1', 'shelldesk-3'];

function TmuxNameDialogHarness() {
  const [open, setOpen] = useState(false);
  const [createdName, setCreatedName] = useState('');

  return (
    <main style={{ padding: 32 }}>
      <button type="button" onClick={() => setOpen(true)}>打开终端菜单</button>
      <output data-testid="created-tmux-name">{createdName}</output>
      {open ? (
        <TerminalTitlebarMenuPortal
          menu={{ windowId: 'terminal-1', x: 32, y: 72 }}
          desktopWindow={{
            id: 'terminal-1',
            appKey: 'terminal',
            frame: { x: 0, y: 0, width: 760, height: 500 },
            isMaximized: false,
            isMinimized: false,
            zIndex: 1,
            terminalStatus: 'running',
          }}
          language="zh-CN"
          systemType="linux"
          snippets={[]}
          tmuxState={{ status: 'ready', sessions: [
            { name: 'sd', windows: 1, attached: 1, createdAt: 1, lastAttachedAt: 1 },
          ] }}
          canOpenSettings={false}
          onClose={() => setOpen(false)}
          onReconnect={() => undefined}
          onNewWindow={() => undefined}
          onSplit={() => undefined}
          onCloneWorkspace={() => undefined}
          broadcastEnabled={false}
          onToggleBroadcast={() => undefined}
          onRequestTool={() => undefined}
          suggestedTmuxSessionName={createTmuxSessionName(existingSessionNames)}
          onNewTmux={(sessionName) => {
            setCreatedName(sessionName);
            setOpen(false);
          }}
          onRefreshTmux={() => undefined}
          onOpenTmux={() => undefined}
          onRunSnippet={() => undefined}
          onKillTmux={() => undefined}
        />
      ) : null}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<TmuxNameDialogHarness />);

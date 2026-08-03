import { useState } from 'react';
import { createRoot } from 'react-dom/client';

import { defaultAppSettings } from '../../src/appDefaultSettings';
import { TerminalSettingsDialogPortal } from '../../src/components/remote-desktop/terminalDialogs';
import { loadFullMessageCatalog } from '../../src/i18n';
import '../../src/styles/critical.scss';
import '../../src/styles/deferred.scss';
import '../../src/styles/remote-desktop/_terminal.scss';

await loadFullMessageCatalog();

function TerminalSettingsHarness() {
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<ShellDeskAppSettings>({
    ...defaultAppSettings,
    language: 'zh-CN',
    terminalKeywordHighlightEnabled: true,
  });
  const updateSetting = <Key extends keyof ShellDeskAppSettings>(
    key: Key,
    value: ShellDeskAppSettings[Key],
  ) => setSettings((current) => ({ ...current, [key]: value }));

  return (
    <main style={{ padding: 32 }}>
      <button type="button" onClick={() => setOpen(true)}>打开终端设置</button>
      <output data-testid="highlight-rule-count">{settings.terminalHighlightRules.length}</output>
      <TerminalSettingsDialogPortal
        isOpen={open}
        settings={settings}
        onClose={() => setOpen(false)}
        onSettingChange={updateSetting}
      />
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<TerminalSettingsHarness />);

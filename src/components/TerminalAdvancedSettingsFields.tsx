import { t } from '../i18n';

interface TerminalAdvancedSettingsFieldsProps {
  settings: ShellDeskAppSettings;
  onChange: (patch: Partial<ShellDeskAppSettings>) => void;
}

interface ToggleRowProps {
  checked: boolean;
  label: string;
  summary: string;
  onChange: (checked: boolean) => void;
}

function ToggleRow({ checked, label, summary, onChange }: ToggleRowProps) {
  return (
    <label className="settings-row">
      <span><strong>{label}</strong><small>{summary}</small></span>
      <input className="settings-toggle" type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    </label>
  );
}

export function TerminalAdvancedSettingsFields({ settings, onChange }: TerminalAdvancedSettingsFieldsProps) {
  const language = settings.language;
  return (
    <section className="settings-section">
      <h2>{t('settings.terminal.advanced.title', language)}</h2>
      <div className="settings-card">
        <label className="settings-row">
          <span><strong>{t('settings.terminal.termType.label', language)}</strong><small>{t('settings.terminal.termType.summary', language)}</small></span>
          <select value={settings.terminalTermType} onChange={(event) => onChange({ terminalTermType: event.target.value as ShellDeskAppSettings['terminalTermType'] })}>
            <option value="xterm-256color">xterm-256color</option>
            <option value="xterm-16color">xterm-16color</option>
            <option value="xterm">xterm</option>
          </select>
        </label>
        <ToggleRow checked={settings.terminalCursorLineHighlight} label={t('settings.terminal.cursorLine.label', language)} summary={t('settings.terminal.cursorLine.summary', language)} onChange={(value) => onChange({ terminalCursorLineHighlight: value })} />
        <ToggleRow checked={settings.terminalDrawBoldInBrightColors} label={t('settings.terminal.boldBright.label', language)} summary={t('settings.terminal.boldBright.summary', language)} onChange={(value) => onChange({ terminalDrawBoldInBrightColors: value })} />
        <ToggleRow checked={settings.terminalSmoothScrolling} label={t('settings.terminal.smoothScroll.label', language)} summary={t('settings.terminal.smoothScroll.summary', language)} onChange={(value) => onChange({ terminalSmoothScrolling: value })} />
        <ToggleRow checked={settings.terminalScrollOnOutput} label={t('settings.terminal.scrollOutput.label', language)} summary={t('settings.terminal.scrollOutput.summary', language)} onChange={(value) => onChange({ terminalScrollOnOutput: value })} />
        <label className="settings-row">
          <span><strong>{t('settings.terminal.wordSeparators.label', language)}</strong><small>{t('settings.terminal.wordSeparators.summary', language)}</small></span>
          <input className="settings-text-input" value={settings.terminalWordSeparators} maxLength={64} onChange={(event) => onChange({ terminalWordSeparators: event.target.value })} />
        </label>
        <label className="settings-row">
          <span><strong>{t('settings.terminal.linkModifier.label', language)}</strong><small>{t('settings.terminal.linkModifier.summary', language)}</small></span>
          <select value={settings.terminalLinkModifier} onChange={(event) => onChange({ terminalLinkModifier: event.target.value as ShellDeskAppSettings['terminalLinkModifier'] })}>
            <option value="ctrl">Ctrl</option><option value="meta">Cmd</option><option value="alt">Alt</option><option value="none">{t('settings.terminal.linkModifier.none', language)}</option>
          </select>
        </label>
        <ToggleRow checked={settings.terminalOptionArrowWordJump} label={t('settings.terminal.optionWordJump.label', language)} summary={t('settings.terminal.optionWordJump.summary', language)} onChange={(value) => onChange({ terminalOptionArrowWordJump: value })} />
        <ToggleRow checked={settings.terminalShiftEnterNewlineEnabled} label={t('settings.terminal.shiftEnter.label', language)} summary={t('settings.terminal.shiftEnter.summary', language)} onChange={(value) => onChange({ terminalShiftEnterNewlineEnabled: value })} />
        <label className="settings-row">
          <span><strong>{t('settings.terminal.shiftEnterText.label', language)}</strong><small>{t('settings.terminal.shiftEnterText.summary', language)}</small></span>
          <input className="settings-text-input" value={settings.terminalShiftEnterNewlineText} maxLength={32} disabled={!settings.terminalShiftEnterNewlineEnabled} onChange={(event) => onChange({ terminalShiftEnterNewlineText: event.target.value })} />
        </label>
        <label className="settings-row">
          <span><strong>{t('settings.terminal.middleClick.label', language)}</strong><small>{t('settings.terminal.middleClick.summary', language)}</small></span>
          <select value={settings.terminalMiddleClickBehavior} onChange={(event) => onChange({ terminalMiddleClickBehavior: event.target.value as ShellDeskAppSettings['terminalMiddleClickBehavior'] })}>
            <option value="paste">{t('settings.terminal.middleClick.paste', language)}</option><option value="context-menu">{t('settings.terminal.middleClick.menu', language)}</option><option value="disabled">{t('settings.terminal.middleClick.disabled', language)}</option>
          </select>
        </label>
        <ToggleRow checked={settings.terminalNormalizeCopiedText} label={t('settings.terminal.normalizeCopy.label', language)} summary={t('settings.terminal.normalizeCopy.summary', language)} onChange={(value) => onChange({ terminalNormalizeCopiedText: value })} />
        <label className="settings-row">
          <span><strong>{t('settings.terminal.dynamicTitle.label', language)}</strong><small>{t('settings.terminal.dynamicTitle.summary', language)}</small></span>
          <select value={settings.terminalDynamicTitle} onChange={(event) => onChange({ terminalDynamicTitle: event.target.value as ShellDeskAppSettings['terminalDynamicTitle'] })}>
            <option value="tmux">tmux</option><option value="all">{t('settings.terminal.dynamicTitle.all', language)}</option><option value="off">{t('settings.terminal.dynamicTitle.off', language)}</option>
          </select>
        </label>
        <label className="settings-row">
          <span><strong>{t('settings.terminal.osc52.label', language)}</strong><small>{t('settings.terminal.osc52.summary', language)}</small></span>
          <select value={settings.terminalOsc52Mode} onChange={(event) => onChange({ terminalOsc52Mode: event.target.value as ShellDeskAppSettings['terminalOsc52Mode'] })}>
            <option value="off">{t('settings.terminal.osc52.off', language)}</option><option value="write-only">{t('settings.terminal.osc52.writeOnly', language)}</option><option value="prompt">{t('settings.terminal.osc52.prompt', language)}</option><option value="read-write">{t('settings.terminal.osc52.readWrite', language)}</option>
          </select>
        </label>
        <ToggleRow checked={settings.terminalClearWipesScrollback} label={t('settings.terminal.clearWipes.label', language)} summary={t('settings.terminal.clearWipes.summary', language)} onChange={(value) => onChange({ terminalClearWipesScrollback: value })} />
      </div>
    </section>
  );
}

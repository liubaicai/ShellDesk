import { memo, useSyncExternalStore, type CSSProperties, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';

import {
  TerminalContextMenuPortal,
  TerminalLaunchDialogPortal,
  TerminalLinkDialogPortal,
  TerminalOsc52ReadDialogPortal,
  TerminalSettingsDialogPortal,
} from './terminalDialogs';
import type { TerminalContextMenuState, TerminalLaunchDraft, TerminalSearchResultState } from './terminalTypes';
import type { TerminalUiStore } from './terminalUiStore';
import { TerminalSelectionAiPortal, type TerminalSelectionAiState } from './TerminalSelectionAiPortal';
import type { RemoteSystemType } from './types';
import { t } from '../../i18n';

interface TerminalPaneViewProps {
  terminalPaneStyle: CSSProperties;
  terminalHostRef: RefObject<HTMLDivElement | null>;
  timestampGutterRef: RefObject<HTMLDivElement | null>;
  settings: ShellDeskAppSettings;
  showSearch: boolean;
  searchInputRef: RefObject<HTMLInputElement | null>;
  searchQuery: string;
  searchResults: TerminalSearchResultState;
  contextMenu: TerminalContextMenuState | null;
  terminalUiStore: TerminalUiStore;
  pendingTerminalLink: string;
  pendingOsc52Read: boolean;
  selectionAiState: TerminalSelectionAiState | null;
  sessionLogRecording: boolean;
  broadcastInputEnabled: boolean;
  showComposer: boolean;
  composeText: string;
  composeCanRun: boolean;
  isLaunchDialogOpen: boolean;
  isSettingsDialogOpen: boolean;
  launchDraft: TerminalLaunchDraft;
  shellChoices: string[];
  systemType?: RemoteSystemType;
  onSearchQueryChange: (query: string) => void;
  onSearchKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  onSearchPrevious: () => void;
  onSearchNext: () => void;
  onSearchClose: () => void;
  onContextMenuClose: () => void;
  onContextMenuCopy: (text: string) => void;
  onContextMenuPaste: () => void;
  onSelectionAi: (selection: string, action: 'explain' | 'fix') => void;
  onSelectionAiClose: () => void;
  onCompletionAccept: (value: string) => void;
  onTerminalLinkCancel: () => void;
  onTerminalLinkOpen: () => void;
  onOsc52ReadCancel: () => void;
  onOsc52ReadAllow: () => void;
  onComposeTextChange: (text: string) => void;
  onComposeClose: () => void;
  onComposeRun: () => void;
  onOpenNote?: (note: { title: string; content: string }) => void;
  onLaunchDialogClose: () => void;
  onLaunchSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onLaunchDraftChange: (draft: TerminalLaunchDraft) => void;
  onSettingsDialogClose: () => void;
  onSettingChange: <Field extends keyof ShellDeskAppSettings>(field: Field, value: ShellDeskAppSettings[Field]) => void;
}

const TerminalHostCanvas = memo(function TerminalHostCanvas({
  terminalHostRef,
  timestampGutterRef,
}: {
  terminalHostRef: RefObject<HTMLDivElement | null>;
  timestampGutterRef: RefObject<HTMLDivElement | null>;
}) {
  return (
    <>
      <div ref={timestampGutterRef} className="terminal-timestamp-gutter" aria-hidden="true" />
      <div ref={terminalHostRef} className="terminal-host" />
    </>
  );
});

const TerminalCompletionOverlay = memo(function TerminalCompletionOverlay({
  store,
  language,
  onCompletionAccept,
}: {
  store: TerminalUiStore;
  language: ShellDeskAppSettings['language'];
  onCompletionAccept: (value: string) => void;
}) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return (
    <>
      {snapshot.commandSuggestion ? (
        <div className="terminal-command-suggestion" aria-live="polite">
          <span>{snapshot.commandSuggestion}</span>
          <kbd>{t('terminal.autocomplete.hint', language)}</kbd>
        </div>
      ) : null}
      {snapshot.completionCandidates.length ? (
        <div className="terminal-completion-menu" role="listbox" aria-label={t('terminal.autocomplete.results', language)}>
          {snapshot.completionCandidates.slice(0, 8).map((candidate, index) => (
            <button
              key={`${candidate.source}:${candidate.value}`}
              type="button"
              role="option"
              aria-selected={index === 0}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onCompletionAccept(candidate.value)}
            >
              <span>{candidate.label}</span>
              <small>{candidate.detail}</small>
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
});

export const TerminalPaneView = memo(function TerminalPaneView({
  terminalPaneStyle,
  terminalHostRef,
  timestampGutterRef,
  settings,
  showSearch,
  searchInputRef,
  searchQuery,
  searchResults,
  contextMenu,
  terminalUiStore,
  pendingTerminalLink,
  pendingOsc52Read,
  selectionAiState,
  sessionLogRecording,
  broadcastInputEnabled,
  showComposer,
  composeText,
  composeCanRun,
  isLaunchDialogOpen,
  isSettingsDialogOpen,
  launchDraft,
  shellChoices,
  systemType,
  onSearchQueryChange,
  onSearchKeyDown,
  onSearchPrevious,
  onSearchNext,
  onSearchClose,
  onContextMenuClose,
  onContextMenuCopy,
  onContextMenuPaste,
  onSelectionAi,
  onSelectionAiClose,
  onCompletionAccept,
  onTerminalLinkCancel,
  onTerminalLinkOpen,
  onOsc52ReadCancel,
  onOsc52ReadAllow,
  onComposeTextChange,
  onComposeClose,
  onComposeRun,
  onOpenNote,
  onLaunchDialogClose,
  onLaunchSubmit,
  onLaunchDraftChange,
  onSettingsDialogClose,
  onSettingChange,
}: TerminalPaneViewProps) {
  return (
    <div className="terminal-pane xterm-terminal-pane" style={terminalPaneStyle}>
      {showSearch ? (
        <div className="terminal-searchbar">
          <input
            ref={searchInputRef}
            value={searchQuery}
            onChange={(event) => onSearchQueryChange(event.target.value)}
            onKeyDown={onSearchKeyDown}
            placeholder={t('terminal.search.placeholder', settings.language)}
            spellCheck={false}
          />
          <span>{searchResults.count ? `${Math.max(searchResults.index + 1, 0)} / ${searchResults.count}` : '0 / 0'}</span>
          <button type="button" onClick={onSearchPrevious} aria-label={t('terminal.search.previous', settings.language)} title={t('terminal.search.previous', settings.language)}>↑</button>
          <button type="button" onClick={onSearchNext} aria-label={t('terminal.search.next', settings.language)} title={t('terminal.search.next', settings.language)}>↓</button>
          <button type="button" onClick={onSearchClose} aria-label={t('terminal.search.close', settings.language)} title={t('terminal.search.close', settings.language)}>×</button>
        </div>
      ) : null}

      <div className={`terminal-host-shell ${settings.terminalLineTimestamps ? 'with-timestamps' : ''}`}>
        <TerminalHostCanvas terminalHostRef={terminalHostRef} timestampGutterRef={timestampGutterRef} />
        {broadcastInputEnabled ? (
          <div className="terminal-broadcast-indicator" role="status" title={t('terminal.broadcast.summary', settings.language)}>
            <span aria-hidden="true" />{t('terminal.broadcast.enabled', settings.language)}
          </div>
        ) : null}
        <TerminalCompletionOverlay store={terminalUiStore} language={settings.language} onCompletionAccept={onCompletionAccept} />
        {sessionLogRecording ? (
          <div className="terminal-session-log-indicator" role="status">
            <span aria-hidden="true" />{t('terminal.sessionLog.recording', settings.language)}
          </div>
        ) : null}
        {showComposer ? (
          <div className="terminal-compose-bar">
            <textarea
              autoFocus
              value={composeText}
              maxLength={32768}
              spellCheck={false}
              placeholder={t('terminal.compose.placeholder', settings.language)}
              onChange={(event) => onComposeTextChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') onComposeClose();
                if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault();
                  onComposeRun();
                }
              }}
            />
            <div>
              <span>{t('terminal.compose.hint', settings.language)}</span>
              <button type="button" onClick={onComposeClose}>{t('common.cancel', settings.language)}</button>
              <button type="button" className="primary" disabled={!composeCanRun || !composeText.trim()} onClick={onComposeRun}>{t('terminal.compose.run', settings.language)}</button>
            </div>
          </div>
        ) : null}
      </div>

      <TerminalContextMenuPortal
        contextMenu={contextMenu}
        language={settings.language}
        onClose={onContextMenuClose}
        onCopy={onContextMenuCopy}
        onPaste={onContextMenuPaste}
        onSelectionAi={onSelectionAi}
        onOpenNote={onOpenNote}
      />

      <TerminalLaunchDialogPortal
        isOpen={isLaunchDialogOpen}
        settings={settings}
        launchDraft={launchDraft}
        shellChoices={shellChoices}
        systemType={systemType}
        onClose={onLaunchDialogClose}
        onSubmit={onLaunchSubmit}
        onDraftChange={onLaunchDraftChange}
      />

      <TerminalSettingsDialogPortal
        isOpen={isSettingsDialogOpen}
        settings={settings}
        onClose={onSettingsDialogClose}
        onSettingChange={onSettingChange}
      />

      <TerminalLinkDialogPortal
        link={pendingTerminalLink}
        language={settings.language}
        onCancel={onTerminalLinkCancel}
        onOpen={onTerminalLinkOpen}
      />

      <TerminalOsc52ReadDialogPortal
        open={pendingOsc52Read}
        language={settings.language}
        onCancel={onOsc52ReadCancel}
        onAllow={onOsc52ReadAllow}
      />

      <TerminalSelectionAiPortal
        state={selectionAiState}
        language={settings.language}
        onClose={onSelectionAiClose}
        onCopy={onContextMenuCopy}
      />
    </div>
  );
});

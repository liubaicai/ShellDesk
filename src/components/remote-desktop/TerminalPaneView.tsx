import { memo, type CSSProperties, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';

import {
  TerminalContextMenuPortal,
  TerminalLaunchDialogPortal,
  TerminalLinkDialogPortal,
  TerminalSettingsDialogPortal,
} from './terminalDialogs';
import type { TerminalContextMenuState, TerminalLaunchDraft, TerminalSearchResultState } from './terminalTypes';
import type { TerminalCompletionCandidate } from './terminalCompletionEngine';
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
  commandSuggestion: string;
  completionCandidates: TerminalCompletionCandidate[];
  pendingTerminalLink: string;
  selectionAiState: TerminalSelectionAiState | null;
  sessionLogRecording: boolean;
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
  onSelectionAi: (selection: string, action: 'explain' | 'fix') => void;
  onSelectionAiClose: () => void;
  onCompletionAccept: (value: string) => void;
  onTerminalLinkCancel: () => void;
  onTerminalLinkOpen: () => void;
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
  commandSuggestion,
  completionCandidates,
  pendingTerminalLink,
  selectionAiState,
  sessionLogRecording,
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
  onSelectionAi,
  onSelectionAiClose,
  onCompletionAccept,
  onTerminalLinkCancel,
  onTerminalLinkOpen,
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
        {commandSuggestion ? (
          <div className="terminal-command-suggestion" aria-live="polite">
            <span>{commandSuggestion}</span>
            <kbd>{t('terminal.autocomplete.hint', settings.language)}</kbd>
          </div>
        ) : null}
        {completionCandidates.length ? (
          <div className="terminal-completion-menu" role="listbox" aria-label={t('terminal.autocomplete.results', settings.language)}>
            {completionCandidates.slice(0, 8).map((candidate, index) => (
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
        {sessionLogRecording ? (
          <div className="terminal-session-log-indicator" role="status">
            <span aria-hidden="true" />{t('terminal.sessionLog.recording', settings.language)}
          </div>
        ) : null}
      </div>

      <TerminalContextMenuPortal
        contextMenu={contextMenu}
        language={settings.language}
        onClose={onContextMenuClose}
        onCopy={onContextMenuCopy}
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

      <TerminalSelectionAiPortal
        state={selectionAiState}
        language={settings.language}
        onClose={onSelectionAiClose}
        onCopy={onContextMenuCopy}
      />
    </div>
  );
});

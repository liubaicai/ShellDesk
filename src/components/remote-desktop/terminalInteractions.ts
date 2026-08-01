import type { SearchAddon } from '@xterm/addon-search';
import type { Terminal as XTerminal } from '@xterm/xterm';
import type { MutableRefObject } from 'react';

import { getErrorMessage } from './desktopUtils';
import { isMacClient, matchesSnippetShortcut } from './terminalSnippetShortcuts';
import type { TerminalContextMenuState, TerminalSearchResultState } from './terminalTypes';
import { t } from '../../i18n';

export function attachTerminalInteractions({
  host,
  terminal,
  searchAddon,
  settings,
  settingsRef,
  isTerminalReadyRef,
  setShowSearch,
  setContextMenu,
  setSearchResults,
  handleKittyKeyEvent,
}: {
  host: HTMLDivElement;
  terminal: XTerminal;
  searchAddon: SearchAddon;
  settings: ShellDeskAppSettings;
  settingsRef: MutableRefObject<ShellDeskAppSettings>;
  isTerminalReadyRef: MutableRefObject<boolean>;
  setShowSearch: (showSearch: boolean) => void;
  setContextMenu: (contextMenu: TerminalContextMenuState | null) => void;
  setSearchResults: (searchResults: TerminalSearchResultState) => void;
  handleKittyKeyEvent?: (event: KeyboardEvent) => boolean;
}) {
  terminal.attachCustomKeyEventHandler((event) => {
    if (event.type === 'keydown' && isTerminalReadyRef.current) {
      const matchingSnippet = (settingsRef.current.terminalSnippets ?? [])
        .find((snippet) => snippet.shortcut && matchesSnippetShortcut(event, snippet.shortcut, isMacClient()));

      if (matchingSnippet) {
        terminal.focus();
        terminal.paste(matchingSnippet.command);
        return false;
      }
    }

    const shouldOpenSearch = event.type === 'keydown' &&
      (event.ctrlKey || event.metaKey) &&
      event.key.toLowerCase() === 'f';

    if (shouldOpenSearch) {
      setShowSearch(true);
      return false;
    }

    if (handleKittyKeyEvent && !handleKittyKeyEvent(event)) {
      return false;
    }

    return true;
  });

  const handleTerminalContextMenu = (event: MouseEvent) => {
    event.preventDefault();
    const selection = terminal.getSelection();

    if (selection) {
      setContextMenu({
        x: event.clientX,
        y: event.clientY,
        selection,
      });
      terminal.focus();
      return;
    }

    if (!isTerminalReadyRef.current || !settingsRef.current.terminalRightClickPaste) {
      terminal.focus();
      return;
    }

    navigator.clipboard
      .readText()
      .then((text) => {
        if (!text) {
          terminal.focus();
          return;
        }

        terminal.focus();
        terminal.paste(text);
      })
      .catch((error: unknown) => {
        terminal.writeln(`\r\n${t('terminal.error.pasteFailed', settings.language, { error: getErrorMessage(error) })}`);
      });
  };

  host.addEventListener('contextmenu', handleTerminalContextMenu);

  const selectionDisposable = terminal.onSelectionChange(() => {
    if (!settingsRef.current.terminalCopyOnSelect || !terminal.hasSelection()) {
      return;
    }

    const selection = terminal.getSelection();

    if (selection) {
      navigator.clipboard.writeText(selection).catch(() => undefined);
    }
  });
  const searchResultDisposable = searchAddon.onDidChangeResults((payload) => {
    setSearchResults({
      index: payload.resultIndex,
      count: payload.resultCount,
    });
  });

  return () => {
    selectionDisposable.dispose();
    searchResultDisposable.dispose();
    host.removeEventListener('contextmenu', handleTerminalContextMenu);
  };
}

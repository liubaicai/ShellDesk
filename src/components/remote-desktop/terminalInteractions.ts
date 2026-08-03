import type { SearchAddon } from '@xterm/addon-search';
import type { Terminal as XTerminal } from '@xterm/xterm';
import type { MutableRefObject } from 'react';

import { getErrorMessage } from './desktopUtils';
import { isMacClient, matchesSnippetShortcut } from './terminalSnippetShortcuts';
import type { TerminalContextMenuState, TerminalSearchResultState } from './terminalTypes';
import { t } from '../../i18n';
import { getTerminalSelectionForClipboard } from './terminalSelection';

export function decodeTerminalTextEscapes(text: string) {
  return text.replace(/\\([nrt\\])/gu, (_match, escaped: string) => ({ n: '\n', r: '\r', t: '\t', '\\': '\\' })[escaped] ?? escaped);
}

export function optionArrowWordJumpSequence(event: KeyboardEvent, enabled: boolean, isMac: boolean) {
  if (!enabled || !isMac || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
  if (event.key === 'ArrowLeft') return '\x1bb';
  if (event.key === 'ArrowRight') return '\x1bf';
  return null;
}

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
  sendInput,
  fitTerminal,
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
  sendInput: (data: string) => void;
  fitTerminal: () => void;
}) {
  terminal.attachCustomKeyEventHandler((event) => {
    if (event.type === 'keydown') {
      const isMac = isMacClient();
      const modifier = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      if (modifier && !event.altKey && (event.key === '+' || event.key === '=' || event.key === '-' || event.key === '0')) {
        const current = terminal.options.fontSize ?? settingsRef.current.terminalFontSize;
        terminal.options.fontSize = event.key === '0' ? settingsRef.current.terminalFontSize : Math.max(8, Math.min(32, current + (event.key === '-' ? -1 : 1)));
        window.requestAnimationFrame(fitTerminal);
        return false;
      }
      const wordJump = optionArrowWordJumpSequence(event, settingsRef.current.terminalOptionArrowWordJump, isMac);
      if (wordJump) {
        sendInput(wordJump);
        return false;
      }
      if (settingsRef.current.terminalShiftEnterNewlineEnabled && event.key === 'Enter' && event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey && !event.isComposing) {
        const text = decodeTerminalTextEscapes(settingsRef.current.terminalShiftEnterNewlineText);
        if (text) {
          sendInput(text);
          return false;
        }
      }
    }
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
    const selection = getTerminalSelectionForClipboard(terminal, settingsRef.current.terminalNormalizeCopiedText);

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

  const handleAlternateScreenContextMenu = (event: MouseEvent) => {
    if (
      !settingsRef.current.terminalContextMenuInAlternateScreen
      || terminal.buffer.active.type !== 'alternate'
    ) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      selection: getTerminalSelectionForClipboard(terminal, settingsRef.current.terminalNormalizeCopiedText),
    });
    terminal.focus();
  };

  host.addEventListener('contextmenu', handleTerminalContextMenu);
  host.addEventListener('contextmenu', handleAlternateScreenContextMenu, true);

  const handleMiddleClick = (event: MouseEvent) => {
    if (event.button !== 1 || settingsRef.current.terminalMiddleClickBehavior === 'disabled') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (settingsRef.current.terminalMiddleClickBehavior === 'context-menu') {
      const selection = getTerminalSelectionForClipboard(terminal, settingsRef.current.terminalNormalizeCopiedText);
      if (selection) setContextMenu({ x: event.clientX, y: event.clientY, selection });
      terminal.focus();
      return;
    }
    if (!isTerminalReadyRef.current) return;
    navigator.clipboard.readText().then((text) => {
      if (text) terminal.paste(text);
      terminal.focus();
    }).catch(() => terminal.focus());
  };
  const preventMiddleAuxClick = (event: MouseEvent) => {
    if (event.button === 1 && settingsRef.current.terminalMiddleClickBehavior !== 'disabled') {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };
  host.addEventListener('mousedown', handleMiddleClick, true);
  host.addEventListener('auxclick', preventMiddleAuxClick, true);

  const handleFontZoomWheel = (event: WheelEvent) => {
    const isMac = isMacClient();
    const modifier = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
    if (!modifier || event.deltaY === 0) return;
    event.preventDefault();
    const current = terminal.options.fontSize ?? settingsRef.current.terminalFontSize;
    terminal.options.fontSize = Math.max(8, Math.min(32, current + (event.deltaY < 0 ? 1 : -1)));
    window.requestAnimationFrame(fitTerminal);
  };
  host.addEventListener('wheel', handleFontZoomWheel, { passive: false, capture: true });

  const selectionDisposable = terminal.onSelectionChange(() => {
    if (!settingsRef.current.terminalCopyOnSelect || !terminal.hasSelection()) {
      return;
    }

    const selection = getTerminalSelectionForClipboard(terminal, settingsRef.current.terminalNormalizeCopiedText);

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
    host.removeEventListener('contextmenu', handleAlternateScreenContextMenu, true);
    host.removeEventListener('mousedown', handleMiddleClick, true);
    host.removeEventListener('auxclick', preventMiddleAuxClick, true);
    host.removeEventListener('wheel', handleFontZoomWheel, true);
  };
}

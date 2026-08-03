import { expect, test } from '@playwright/test';
import type { Terminal as XTerminal } from '@xterm/xterm';

import { decodeTerminalTextEscapes, optionArrowWordJumpSequence } from '../../src/components/remote-desktop/terminalInteractions';
import { TerminalOutputProtocolFilter } from '../../src/components/remote-desktop/terminalOutputProtocol';
import { shouldEnableTerminalWebglRenderer } from '../../src/components/remote-desktop/terminalRendererRuntime';
import { getTerminalSelectionForClipboard } from '../../src/components/remote-desktop/terminalSelection';
import { resolveTerminalOsc52Action } from '../../src/components/remote-desktop/terminalOsc52';

function keyboardEvent(patch: Partial<KeyboardEvent>) {
  return {
    key: '', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false,
    ...patch,
  } as KeyboardEvent;
}

function protocolTerminal(baseY = 20, viewportY = 10) {
  return {
    buffer: { active: { type: 'normal', baseY, viewportY } },
  } as unknown as XTerminal;
}

test('decodes configured Shift+Enter text and maps macOS Option word jumps', () => {
  expect(decodeTerminalTextEscapes('\\n\\t\\\\')).toBe('\n\t\\');
  expect(optionArrowWordJumpSequence(keyboardEvent({ key: 'ArrowLeft', altKey: true }), true, true)).toBe('\x1bb');
  expect(optionArrowWordJumpSequence(keyboardEvent({ key: 'ArrowRight', altKey: true }), true, true)).toBe('\x1bf');
  expect(optionArrowWordJumpSequence(keyboardEvent({ key: 'ArrowLeft', altKey: true }), true, false)).toBeNull();
});

test('keeps automatic terminal rendering on DOM inside Windows Tauri WebView2', () => {
  const windowsTauri = { isTauri: true, isWindows: true };
  expect(shouldEnableTerminalWebglRenderer('auto', windowsTauri)).toBe(false);
  expect(shouldEnableTerminalWebglRenderer('webgl', windowsTauri)).toBe(true);
  expect(shouldEnableTerminalWebglRenderer('dom', windowsTauri)).toBe(false);
  expect(shouldEnableTerminalWebglRenderer('auto', { isTauri: false, isWindows: true })).toBe(true);
  expect(shouldEnableTerminalWebglRenderer('auto', { isTauri: true, isWindows: false })).toBe(true);
});

test('protects a scrolled viewport from synchronized full-screen clears', () => {
  const filter = new TerminalOutputProtocolFilter(protocolTerminal(), () => false);
  const input = '\x1b[?2026h\x1b[H\x1b[2Jframe\x1b[?2026l';
  expect(filter.filter(input)).toBe('\x1b[?2026h\x1b[Hframe\x1b[?2026l');
});

test('keeps synchronized clears at the live bottom and handles split markers', () => {
  const filter = new TerminalOutputProtocolFilter(protocolTerminal(20, 20), () => true);
  expect(filter.filter('\x1b[?2026h\x1b[')).toBe('\x1b[?2026h');
  expect(filter.filter('H\x1b[2')).toBe('\x1b[H');
  expect(filter.filter('Jframe\x1b[?2026l')).toBe('\x1b[2Jframe\x1b[?2026l');
});

test('blocks CSI 3J scrollback deletion unless explicitly enabled', () => {
  expect(new TerminalOutputProtocolFilter(protocolTerminal(), () => false).filter(`before\x1b[3Jafter`)).toBe('beforeafter');
  expect(new TerminalOutputProtocolFilter(protocolTerminal(), () => true).filter(`before\x1b[3Jafter`)).toBe('before\x1b[3Jafter');
});

test('keeps OSC 52 clipboard reads behind an explicit permission mode', () => {
  expect(resolveTerminalOsc52Action('off', 'aGVsbG8=')).toBe('ignore');
  expect(resolveTerminalOsc52Action('write-only', 'aGVsbG8=')).toBe('write');
  expect(resolveTerminalOsc52Action('write-only', '?')).toBe('ignore');
  expect(resolveTerminalOsc52Action('prompt', '?')).toBe('prompt-read');
  expect(resolveTerminalOsc52Action('read-write', '?')).toBe('read');
});

test('normalizes TUI padding while preserving hard and soft wraps', () => {
  const lines = [
    { isWrapped: false, length: 12, translateToString: () => 'hello   ' },
    { isWrapped: true, length: 12, translateToString: () => 'world   ' },
    { isWrapped: false, length: 12, translateToString: () => 'next' },
  ];
  const terminal = {
    getSelection: () => 'hello   world   \nnext',
    getSelectionPosition: () => ({ start: { x: 0, y: 0 }, end: { x: 12, y: 2 } }),
    buffer: { active: { getLine: (index: number) => lines[index] } },
  } as unknown as XTerminal;
  expect(getTerminalSelectionForClipboard(terminal, true)).toBe('hello world\nnext');
});

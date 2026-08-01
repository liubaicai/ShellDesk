import { expect, test } from '@playwright/test';
import type { Terminal as XTerminal } from '@xterm/xterm';

import { createTerminalKittyKeyboardRuntime } from '../../src/components/remote-desktop/terminalKittyKeyboard';

test('negotiates CSI-u flags and reports modified key event types', () => {
  const handlers = new Map<string, (params: (number | number[])[]) => boolean | Promise<boolean>>();
  const terminal = {
    parser: {
      registerCsiHandler: (
        id: { prefix?: string; final: string },
        handler: (params: (number | number[])[]) => boolean | Promise<boolean>,
      ) => {
        const key = `${id.prefix ?? ''}${id.final}`;
        handlers.set(key, handler);
        return { dispose: () => handlers.delete(key) };
      },
    },
  } as unknown as XTerminal;
  const writes: string[] = [];
  const runtime = createTerminalKittyKeyboardRuntime({
    terminal,
    enabled: () => true,
    writeInput: (data) => writes.push(data),
  });

  expect(handlers.get('>u')?.([3])).toBe(true);
  expect(runtime.handleKeyEvent({ type: 'keydown', key: 'Enter', shiftKey: true } as KeyboardEvent)).toBe(false);
  expect(runtime.handleKeyEvent({ type: 'keyup', key: 'Enter', shiftKey: true } as KeyboardEvent)).toBe(false);
  expect(handlers.get('?u')?.([])).toBe(true);
  expect(writes).toEqual(['\x1b[13;2:1u', '\x1b[13;2:3u', '\x1b[?3u']);

  runtime.dispose();
  expect(handlers.size).toBe(0);
});

test('leaves regular text input untouched when all-key reporting is not active', () => {
  const handlers = new Map<string, (params: (number | number[])[]) => boolean | Promise<boolean>>();
  const terminal = {
    parser: {
      registerCsiHandler: (id: { prefix?: string; final: string }, handler: (params: (number | number[])[]) => boolean | Promise<boolean>) => {
        handlers.set(`${id.prefix ?? ''}${id.final}`, handler);
        return { dispose: () => undefined };
      },
    },
  } as unknown as XTerminal;
  const runtime = createTerminalKittyKeyboardRuntime({ terminal, enabled: () => true, writeInput: () => undefined });

  handlers.get('>u')?.([1]);
  expect(runtime.handleKeyEvent({ type: 'keydown', key: 'a' } as KeyboardEvent)).toBe(true);
  runtime.dispose();
});

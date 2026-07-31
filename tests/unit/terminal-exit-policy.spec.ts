import { expect, test } from '@playwright/test';

import { shouldCloseTerminalAfterExit } from '../../src/components/remote-desktop/terminalExitPolicy';

test('keeps terminal windows open under the default exit policy', () => {
  expect(shouldCloseTerminalAfterExit('keep-open', { code: 0, signal: null })).toBe(false);
  expect(shouldCloseTerminalAfterExit('keep-open', { code: 1, signal: null })).toBe(false);
});

test('closes only successful process exits under the success policy', () => {
  expect(shouldCloseTerminalAfterExit('close-success', { code: 0, signal: null })).toBe(true);
  expect(shouldCloseTerminalAfterExit('close-success', { code: 1, signal: null })).toBe(false);
  expect(shouldCloseTerminalAfterExit('close-success', { code: null, signal: 'SIGTERM' })).toBe(false);
});

test('closes every reported process exit under the always policy', () => {
  expect(shouldCloseTerminalAfterExit('close-always', { code: 1, signal: null })).toBe(true);
  expect(shouldCloseTerminalAfterExit('close-always', { code: null, signal: 'SIGTERM' })).toBe(true);
});

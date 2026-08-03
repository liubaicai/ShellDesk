import { expect, test } from '@playwright/test';

import { measureTerminalLongestLine, resolveTerminalOutputPressure } from '../../src/components/remote-desktop/terminalOutputPressure';

test('classifies queued, rate, chunk, and long-line terminal pressure', () => {
  expect(resolveTerminalOutputPressure({ queuedBytes: 0, recentBytes: 10, largestChunkBytes: 10, longestLineCharacters: 10 })).toBe('normal');
  expect(resolveTerminalOutputPressure({ queuedBytes: 300_000, recentBytes: 10, largestChunkBytes: 10, longestLineCharacters: 10 })).toBe('busy');
  expect(resolveTerminalOutputPressure({ queuedBytes: 0, recentBytes: 5_000_000, largestChunkBytes: 10, longestLineCharacters: 10 })).toBe('saturated');
  expect(measureTerminalLongestLine(`short\n${'x'.repeat(20_000)}`)).toBe(20_000);
});

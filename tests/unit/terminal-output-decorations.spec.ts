import { expect, test } from '@playwright/test';

import {
  findTerminalKeywordRanges,
  formatTerminalLineTimestamp,
  parseTerminalHighlightKeywords,
} from '../../src/components/remote-desktop/terminalOutputDecorations';

test('normalizes and de-duplicates comma-separated terminal keywords', () => {
  expect(parseTerminalHighlightKeywords(' Error, warning,ERROR, denied ')).toEqual([
    'warning',
    'denied',
    'error',
  ]);
});

test('finds case-insensitive keyword ranges without overlapping matches', () => {
  expect(findTerminalKeywordRanges('ERROR: request failed with error', 'error,request failed,failed')).toEqual([
    { start: 0, length: 5 },
    { start: 7, length: 14 },
    { start: 27, length: 5 },
  ]);
});

test('formats terminal line timestamps as fixed local wall-clock time', () => {
  expect(formatTerminalLineTimestamp(new Date(2026, 0, 2, 3, 4, 5))).toBe('03:04:05');
});

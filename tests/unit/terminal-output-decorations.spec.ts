import { expect, test } from '@playwright/test';

import {
  compileTerminalHighlightRules,
  findTerminalKeywordRanges,
  formatTerminalLineTimestamp,
  parseTerminalHighlightKeywords,
} from '../../src/components/remote-desktop/terminalOutputDecorations';
import { isSafeTerminalHighlightPattern } from '../../src/terminalHighlightRules';

test('normalizes and de-duplicates comma-separated terminal keywords', () => {
  expect(parseTerminalHighlightKeywords(' Error, warning,ERROR, denied ')).toEqual([
    'warning',
    'denied',
    'error',
  ]);
});

test('compiles structured literal and regex highlight rules while skipping invalid patterns', () => {
  const rules = compileTerminalHighlightRules([
    { id: 'literal', label: 'Literal', pattern: 'a+b', mode: 'literal', foreground: '#fff', background: '#000', enabled: true },
    { id: 'regex', label: 'Regex', pattern: 'warn(?:ing)?', mode: 'regex', foreground: '#fff', background: '#000', enabled: true },
    { id: 'invalid', label: 'Invalid', pattern: '[', mode: 'regex', foreground: '#fff', background: '#000', enabled: true },
  ]);
  expect(rules).toHaveLength(2);
  expect(rules[0].pattern.test('a+b')).toBe(true);
  expect(rules[1].pattern.test('WARNING')).toBe(true);
});

test('rejects highlight expressions that can cause catastrophic backtracking', () => {
  expect(isSafeTerminalHighlightPattern('(a+)+$', 'regex')).toBe(false);
  expect(isSafeTerminalHighlightPattern('(.*)+failure', 'regex')).toBe(false);
  expect(isSafeTerminalHighlightPattern('(error|failed)\\s+at', 'regex')).toBe(true);
  expect(compileTerminalHighlightRules([{
    id: 'unsafe', label: 'Unsafe', pattern: '(a+)+$', mode: 'regex',
    foreground: '#ffffff', background: '#000000', enabled: true,
  }])).toEqual([]);
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

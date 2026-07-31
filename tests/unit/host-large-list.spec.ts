import { expect, test } from '@playwright/test';

import { getNextHostPickerIndex } from '../../src/components/AgentHostPicker';
import { getNextHostListIndex } from '../../src/components/HostListPanel';

test('host inventory navigation crosses page boundaries and clamps at the ends', () => {
  expect(getNextHostListIndex('ArrowDown', -1, 25, 10)).toBe(0);
  expect(getNextHostListIndex('PageDown', 0, 25, 10)).toBe(10);
  expect(getNextHostListIndex('PageDown', 20, 25, 10)).toBe(24);
  expect(getNextHostListIndex('ArrowUp', -1, 25, 10)).toBe(24);
  expect(getNextHostListIndex('Home', 18, 25, 10)).toBe(0);
  expect(getNextHostListIndex('End', 2, 25, 10)).toBe(24);
});

test('virtual host picker navigation uses visible-page jumps and stable bounds', () => {
  expect(getNextHostPickerIndex('ArrowDown', -1, 5_000, 10)).toBe(0);
  expect(getNextHostPickerIndex('PageDown', 0, 5_000, 10)).toBe(10);
  expect(getNextHostPickerIndex('PageUp', 10, 5_000, 10)).toBe(0);
  expect(getNextHostPickerIndex('End', 10, 5_000, 10)).toBe(4_999);
  expect(getNextHostPickerIndex('ArrowDown', 4_999, 5_000, 10)).toBe(4_999);
  expect(getNextHostPickerIndex('Home', 4_999, 5_000, 10)).toBe(0);
});

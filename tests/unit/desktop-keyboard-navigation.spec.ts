import { expect, test } from '@playwright/test';

import { getRovingFocusIndex } from '../../src/features/remote-desktop/desktopKeyboardNavigation';

test('roving focus wraps horizontally and clamps vertically', () => {
  expect(getRovingFocusIndex('ArrowRight', 5, 6, 3)).toBe(0);
  expect(getRovingFocusIndex('ArrowLeft', 0, 6, 3)).toBe(5);
  expect(getRovingFocusIndex('ArrowDown', 1, 6, 3)).toBe(4);
  expect(getRovingFocusIndex('ArrowDown', 4, 6, 3)).toBe(5);
  expect(getRovingFocusIndex('ArrowUp', 2, 6, 3)).toBe(0);
  expect(getRovingFocusIndex('Home', 4, 6, 3)).toBe(0);
  expect(getRovingFocusIndex('End', 1, 6, 3)).toBe(5);
});

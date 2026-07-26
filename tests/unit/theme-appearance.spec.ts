import { expect, test } from '@playwright/test';

import {
  getContrastRatio,
  getLightThemeAccentColor,
  getReadableTextColor,
  readThemePreference,
  resolveThemePreference,
} from '../../src/theme/appearance';

const accentChoices = [
  '#0f6bff',
  '#43c7ff',
  '#77f4c5',
  '#ffb347',
  '#ff7b9c',
  '#9f8cff',
  '#8bd3ff',
  '#ff8c42',
];

test.describe('readThemePreference', () => {
  test('prioritizes a valid query preference over storage', () => {
    expect(readThemePreference('?shelldeskTheme=light', 'dark')).toBe('light');
    expect(readThemePreference('?shelldeskTheme=dark', 'light')).toBe('dark');
    expect(readThemePreference('?shelldeskTheme=system', 'light')).toBe('system');
  });

  test('ignores invalid query values and reads current or legacy storage', () => {
    expect(readThemePreference('?shelldeskTheme=sepia', 'light')).toBe('light');
    expect(readThemePreference('?shelldeskTheme=sepia', '{"theme":"system"}')).toBe('system');
    expect(readThemePreference('', '{"theme":"dark","accentColor":"#0f6bff"}')).toBe('dark');
    expect(readThemePreference('', ' \r\n {"theme":"light"} \t')).toBe('light');
    expect(readThemePreference('', ' \t light \r\n')).toBe('light');
  });

  test('falls back to dark for missing or malformed preferences', () => {
    expect(readThemePreference('', null)).toBe('dark');
    expect(readThemePreference('', '')).toBe('dark');
    expect(readThemePreference('', 'sepia')).toBe('dark');
    expect(readThemePreference('', '{not-json')).toBe('dark');
  });
});

test.describe('resolveThemePreference', () => {
  test('keeps explicit preferences independent of the system preference', () => {
    expect(resolveThemePreference('light', false)).toBe('light');
    expect(resolveThemePreference('light', true)).toBe('light');
    expect(resolveThemePreference('dark', false)).toBe('dark');
    expect(resolveThemePreference('dark', true)).toBe('dark');
  });

  test('resolves system preferences in both directions', () => {
    expect(resolveThemePreference('system', true)).toBe('light');
    expect(resolveThemePreference('system', false)).toBe('dark');
  });
});

test.describe('accent contrast', () => {
  for (const accentColor of accentChoices) {
    test(`${accentColor} keeps readable runtime text in both appearance paths`, () => {
      const readableText = getReadableTextColor(accentColor);
      const lightThemeAccent = getLightThemeAccentColor(accentColor);

      expect(readableText).toMatch(/^#[0-9a-f]{6}$/i);
      expect(lightThemeAccent).toMatch(/^#[0-9a-f]{6}$/i);
      expect(getContrastRatio(accentColor, readableText)).toBeGreaterThanOrEqual(4.5);
      expect(getContrastRatio(lightThemeAccent, '#ffffff')).toBeGreaterThanOrEqual(4.5);
    });
  }

  test('preserves an accent that already has sufficient white contrast', () => {
    expect(getLightThemeAccentColor('#0f6bff')).toBe('#0f6bff');
  });
});

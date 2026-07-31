import { expect, test } from '@playwright/test';

import { normalizeSafeTerminalLink } from '../../src/components/remote-desktop/terminalLinks';

test('accepts only credential-free HTTP and HTTPS terminal links', () => {
  expect(normalizeSafeTerminalLink('https://example.com/path?q=1')).toBe('https://example.com/path?q=1');
  expect(normalizeSafeTerminalLink('http://example.com')).toBe('http://example.com/');
  expect(normalizeSafeTerminalLink('ssh://example.com')).toBeNull();
  expect(normalizeSafeTerminalLink('javascript:alert(1)')).toBeNull();
  expect(normalizeSafeTerminalLink('https://user:secret@example.com')).toBeNull();
});

import { expect, test } from '@playwright/test';

import { shouldResolveDefaultTmuxLaunch } from '../../src/remoteDesktopWindowModel';

test('only the first default terminal resolves the preferred tmux launch', () => {
  expect(shouldResolveDefaultTmuxLaunch([], false)).toBe(true);
  expect(shouldResolveDefaultTmuxLaunch([{ appKey: 'files' }], false)).toBe(true);
  expect(shouldResolveDefaultTmuxLaunch([{ appKey: 'terminal' }], false)).toBe(false);
});

test('a pending first terminal keeps a rapid second open request on the regular shell', () => {
  expect(shouldResolveDefaultTmuxLaunch([], true)).toBe(false);
});

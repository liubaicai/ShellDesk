import { expect, test } from '@playwright/test';

import {
  createTmuxListCommand,
  createTmuxSessionName,
  parseTmuxSessions,
  shouldResolveDefaultTmuxLaunch,
} from '../../src/remoteDesktopWindowModel';

test('only the first default terminal resolves the preferred tmux launch', () => {
  expect(shouldResolveDefaultTmuxLaunch([], false)).toBe(true);
  expect(shouldResolveDefaultTmuxLaunch([{ appKey: 'files' }], false)).toBe(true);
  expect(shouldResolveDefaultTmuxLaunch([{ appKey: 'terminal' }], false)).toBe(false);
});

test('a pending first terminal keeps a rapid second open request on the regular shell', () => {
  expect(shouldResolveDefaultTmuxLaunch([], true)).toBe(false);
});

test('tmux session listing uses a printable separator that tmux preserves', () => {
  const command = createTmuxListCommand();

  expect(command).toContain('#{session_name}:#{session_windows}:#{session_attached}:#{session_created}:#{session_last_attached}');
  expect(command).not.toContain('\t');
});

test('tmux session parsing keeps the real session name separate from its metadata', () => {
  expect(parseTmuxSessions([
    'sd:1:1:1722800000:1722801000',
    'build_agent:3:0:1722802000:1722802000',
  ].join('\n'))).toEqual([
    {
      name: 'build_agent',
      windows: 3,
      attached: 0,
      createdAt: 1722802000,
      lastAttachedAt: 1722802000,
    },
    {
      name: 'sd',
      windows: 1,
      attached: 1,
      createdAt: 1722800000,
      lastAttachedAt: 1722801000,
    },
  ]);
});

test('tmux automatic names use the first available shelldesk sequence', () => {
  expect(createTmuxSessionName([])).toBe('shelldesk-1');
  expect(createTmuxSessionName(['sd', 'shelldesk-1', 'shelldesk-3'])).toBe('shelldesk-2');
  expect(createTmuxSessionName(['shelldesk-01', 'shelldesk-1', 'shelldesk-2'])).toBe('shelldesk-3');
});

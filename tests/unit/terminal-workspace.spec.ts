import { expect, test } from '@playwright/test';

import type { DesktopWindowState } from '../../src/remoteDesktopWindowModel';
import {
  createTerminalWorkspaceSnapshot,
  parseTerminalWorkspaceSnapshot,
  sanitizeTerminalLaunchMetadata,
  splitTerminalWorkspaceFrame,
  terminalWorkspaceStorageKey,
} from '../../src/terminalWorkspace';

test('terminal workspace snapshots never persist commands or output state', () => {
  const terminalWindow = {
    id: 'terminal-1',
    appKey: 'terminal',
    frame: { x: 20, y: 30, width: 780, height: 540 },
    isMaximized: false,
    isMinimized: false,
    zIndex: 1,
    terminalId: 'terminal-1',
    terminalLaunchOptions: {
      title: 'Operations',
      shell: '/bin/bash',
      workingDirectory: '/srv/app',
      initialCommand: 'export SECRET=must-not-persist && deploy',
    },
    terminalStatus: 'running',
    terminalHasForegroundTask: true,
    chromeTitle: 'deploy --token secret',
  } satisfies DesktopWindowState;

  const snapshot = createTerminalWorkspaceSnapshot([terminalWindow]);
  const serialized = JSON.stringify(snapshot);

  expect(snapshot.windows[0]?.launchOptions).toEqual({
    title: 'Operations',
    shell: '/bin/bash',
    workingDirectory: '/srv/app',
  });
  expect(serialized).not.toContain('must-not-persist');
  expect(serialized).not.toContain('deploy --token');
  expect(serialized).not.toContain('terminalHasForegroundTask');
});

test('workspace restore validation rejects malformed frames and caps restored windows', () => {
  const validEntry = {
    frame: { x: 10, y: 20, width: 760, height: 500 },
    isMaximized: false,
    isMinimized: false,
    launchOptions: {
      title: 'tmux',
      mode: 'tmux',
      tmuxSessionName: 'ops',
      initialCommand: 'ignored',
    },
  };
  const parsed = parseTerminalWorkspaceSnapshot({
    version: 1,
    updatedAt: '2026-07-31T00:00:00.000Z',
    windows: [
      { frame: { x: 0, y: 0, width: -1, height: 10 } },
      ...Array.from({ length: 20 }, () => validEntry),
    ],
  });

  expect(parsed?.windows).toHaveLength(12);
  expect(parsed?.windows[0]?.launchOptions).toEqual({
    title: 'tmux',
    mode: 'tmux',
    tmuxSessionName: 'ops',
  });
});

test('workspace splitting creates non-overlapping right and lower terminal frames', () => {
  const workspace = { x: 0, y: 0, width: 1400, height: 900 };
  const frame = { x: 100, y: 60, width: 780, height: 500 };
  const right = splitTerminalWorkspaceFrame(frame, workspace, 'right');
  const down = splitTerminalWorkspaceFrame(frame, workspace, 'down');

  expect(right).not.toBeNull();
  expect(right![0].x + right![0].width).toBeLessThan(right![1].x);
  expect(right![0].height).toBe(right![1].height);
  expect(down).not.toBeNull();
  expect(down![0].y + down![0].height).toBeLessThan(down![1].y);
  expect(down![0].width).toBe(down![1].width);
});

test('workspace identity prefers a stable host id and metadata sanitizer drops initial commands', () => {
  expect(terminalWorkspaceStorageKey({
    id: 'host/production',
    address: '10.0.0.1',
    port: 22,
    username: 'root',
  })).toContain('host%2Fproduction');
  expect(sanitizeTerminalLaunchMetadata({
    initialCommand: 'never persist me',
  })).toBeUndefined();
});

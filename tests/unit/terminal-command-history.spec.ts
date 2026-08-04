import { expect, test } from '@playwright/test';

import {
  clearRuntimeTerminalCommandHistory,
  isSafeRuntimeTerminalCommand,
  listAllRuntimeTerminalCommands,
  listRuntimeTerminalCommands,
  rememberRuntimeTerminalCommand,
} from '../../src/components/remote-desktop/terminalCommandHistory';

test.beforeEach(() => clearRuntimeTerminalCommandHistory());

test('keeps the most recently used commands first for the command center', () => {
  rememberRuntimeTerminalCommand('connection-1', 'git status --short');
  rememberRuntimeTerminalCommand('connection-1', 'git log --oneline');
  rememberRuntimeTerminalCommand('connection-1', 'git status --branch');
  expect(listRuntimeTerminalCommands('connection-1')).toEqual([
    'git status --branch',
    'git log --oneline',
    'git status --short',
  ]);
});

test('lists safe history across scopes for the command center', () => {
  rememberRuntimeTerminalCommand('host-a', 'git status');
  rememberRuntimeTerminalCommand('host-b', 'docker ps');
  expect(listAllRuntimeTerminalCommands()).toEqual([
    { scope: 'host-a', command: 'git status' },
    { scope: 'host-b', command: 'docker ps' },
  ]);
  expect(isSafeRuntimeTerminalCommand('echo ok')).toBe(true);
  expect(isSafeRuntimeTerminalCommand('curl --token=secret example.com')).toBe(false);
});

test('does not retain multiline or credential commands', () => {
  rememberRuntimeTerminalCommand('connection-1', 'echo one\necho two');
  rememberRuntimeTerminalCommand('connection-1', 'curl --token=secret https://example.com');
  expect(listRuntimeTerminalCommands('connection-1')).toEqual([]);
});

test('keeps credential-shaped environment variables and headers out of history', () => {
  const scope = 'credential-shaped-history';
  rememberRuntimeTerminalCommand(scope, 'export AWS_SECRET_ACCESS_KEY=top-secret');
  rememberRuntimeTerminalCommand(scope, "curl -H 'Authorization: Bearer token' https://example.test");
  rememberRuntimeTerminalCommand(scope, 'mysql -uroot -psuper-secret');
  rememberRuntimeTerminalCommand(scope, 'kubectl get pods');

  expect(listRuntimeTerminalCommands(scope)).toEqual(['kubectl get pods']);
});

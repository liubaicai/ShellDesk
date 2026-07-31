import { expect, test } from '@playwright/test';

import {
  clearRuntimeTerminalCommandHistory,
  rememberRuntimeTerminalCommand,
  suggestRuntimeTerminalCommand,
} from '../../src/components/remote-desktop/terminalCommandHistory';

test.beforeEach(() => clearRuntimeTerminalCommandHistory());

test('suggests the most recently used matching command', () => {
  rememberRuntimeTerminalCommand('connection-1', 'git status --short');
  rememberRuntimeTerminalCommand('connection-1', 'git log --oneline');
  rememberRuntimeTerminalCommand('connection-1', 'git status --branch');
  expect(suggestRuntimeTerminalCommand('connection-1', 'git st')).toBe('git status --branch');
  expect(suggestRuntimeTerminalCommand('connection-2', 'git st')).toBe('');
});

test('falls back to snippets without retaining multiline or credential commands', () => {
  rememberRuntimeTerminalCommand('connection-1', 'echo one\necho two');
  rememberRuntimeTerminalCommand('connection-1', 'curl --token=secret https://example.com');
  expect(suggestRuntimeTerminalCommand('connection-1', 'echo')).toBe('');
  expect(suggestRuntimeTerminalCommand('connection-1', 'curl')).toBe('');
  expect(suggestRuntimeTerminalCommand('connection-1', 'kub', [{
    id: '1',
    label: 'Pods',
    command: 'kubectl get pods -A',
    group: 'Kubernetes',
    language: 'bash',
    shortcut: '',
    createdAt: '',
    updatedAt: '',
  }])).toBe('kubectl get pods -A');
});

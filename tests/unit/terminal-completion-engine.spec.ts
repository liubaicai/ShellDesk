import { expect, test } from '@playwright/test';

import {
  clearTerminalCompletionCaches,
  collectRemotePathCompletionCandidates,
  collectTerminalCompletionCandidates,
} from '../../src/components/remote-desktop/terminalCompletionEngine';
import {
  clearRuntimeTerminalCommandHistory,
  rememberRuntimeTerminalCommand,
} from '../../src/components/remote-desktop/terminalCommandHistory';

test.beforeEach(() => {
  clearRuntimeTerminalCommandHistory();
  clearTerminalCompletionCaches();
});

test('ranks prefix matches and includes fuzzy history plus snippets', () => {
  rememberRuntimeTerminalCommand('host-1', 'git status --short');
  rememberRuntimeTerminalCommand('host-1', 'systemctl status nginx');
  const candidates = collectTerminalCompletionCandidates('host-1', 'git', [{
    id: 'snippet-1',
    label: 'Git log',
    command: 'git log --oneline',
    group: 'Git',
    language: 'bash',
    shortcut: '',
    createdAt: '',
    updatedAt: '',
  }]);

  expect(candidates.some((candidate) => candidate.value === 'git status --short' && candidate.source === 'history')).toBeTruthy();
  expect(candidates.some((candidate) => candidate.value === 'git log --oneline')).toBeTruthy();
  expect(collectTerminalCompletionCandidates('host-1', 'sys ng')
    .some((candidate) => candidate.value === 'systemctl status nginx')).toBeTruthy();
});

test('completes remote paths with directory suffixes and deduplicated listings', async () => {
  let listCalls = 0;
  const api = {
    connections: {
      sftpListDirectory: async () => {
        listCalls += 1;
        return {
          path: '/srv/app',
          entries: [
            { name: 'logs', longname: '', type: 'directory', size: 0, modifiedAt: '' },
            { name: 'local.env', longname: '', type: 'file', size: 3, modifiedAt: '' },
          ],
        };
      },
    },
  } as unknown as ShellDeskApi;

  const first = await collectRemotePathCompletionCandidates({
    api,
    connectionId: 'host-1',
    input: 'cd lo',
    workingDirectory: '/srv/app',
    windows: false,
  });
  const second = await collectRemotePathCompletionCandidates({
    api,
    connectionId: 'host-1',
    input: 'cd loc',
    workingDirectory: '/srv/app',
    windows: false,
  });

  expect(first.map((candidate) => candidate.value)).toEqual(['cd logs/', 'cd local.env']);
  expect(second.map((candidate) => candidate.value)).toEqual(['cd local.env']);
  expect(listCalls).toBe(1);
});

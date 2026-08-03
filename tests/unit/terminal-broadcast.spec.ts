import { expect, test } from '@playwright/test';

import {
  canBroadcastTerminalInput,
  completeTerminalBroadcastRequest,
  enqueueTerminalBroadcastRequest,
  isSensitiveTerminalPrompt,
  maximumPendingTerminalBroadcastRequests,
} from '../../src/components/remote-desktop/terminalBroadcast';

test('broadcast input blocks passwords and large multiline pastes', () => {
  expect(isSensitiveTerminalPrompt('\u001b[31mPassword:\u001b[0m ')).toBe(true);
  expect(canBroadcastTerminalInput('secret\r', true)).toEqual({ allowed: false, reason: 'sensitive-prompt' });
  expect(canBroadcastTerminalInput('echo one\necho two\n', false)).toEqual({ allowed: false, reason: 'large-paste' });
  expect(canBroadcastTerminalInput('ls -la\r', false)).toEqual({ allowed: true, reason: null });
});

test('broadcast requests use a bounded FIFO queue without overwriting rapid input', () => {
  const first = { id: '1', sourceTerminalId: 'source', data: 'a' };
  const second = { id: '2', sourceTerminalId: 'source', data: 'b' };
  const queued = enqueueTerminalBroadcastRequest(
    enqueueTerminalBroadcastRequest(undefined, first),
    second,
  );
  expect(queued.map(({ data }) => data)).toEqual(['a', 'b']);
  expect(completeTerminalBroadcastRequest(queued, first.id)).toEqual([second]);

  const full = Array.from({ length: maximumPendingTerminalBroadcastRequests }, (_, index) => ({
    id: String(index), sourceTerminalId: 'source', data: 'x',
  }));
  expect(enqueueTerminalBroadcastRequest(full, second)).toBe(full);
});

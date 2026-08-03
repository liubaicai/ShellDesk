import { expect, test } from '@playwright/test';

import { canBroadcastTerminalInput, isSensitiveTerminalPrompt } from '../../src/components/remote-desktop/terminalBroadcast';

test('broadcast input blocks passwords and large multiline pastes', () => {
  expect(isSensitiveTerminalPrompt('\u001b[31mPassword:\u001b[0m ')).toBe(true);
  expect(canBroadcastTerminalInput('secret\r', true)).toEqual({ allowed: false, reason: 'sensitive-prompt' });
  expect(canBroadcastTerminalInput('echo one\necho two\n', false)).toEqual({ allowed: false, reason: 'large-paste' });
  expect(canBroadcastTerminalInput('ls -la\r', false)).toEqual({ allowed: true, reason: null });
});

import { expect, test } from '@playwright/test';

import { createTerminalSessionLogController } from '../../src/components/remote-desktop/terminalSessionLog';

test('records terminal output as text only after explicit start', async () => {
  let savedContent = '';
  const api = {
    files: {
      saveTextFile: async (payload: { content: string }) => {
        savedContent = payload.content;
        return 'C:/logs/session.txt';
      },
    },
  } as unknown as ShellDeskApi;
  const controller = createTerminalSessionLogController({
    api,
    title: 'prod/server',
    format: () => 'text',
  });

  controller.append('ignored');
  controller.start();
  controller.append('\x1b[31mfailed\x1b[0m\r\n');
  const path = await controller.stopAndSave();

  expect(path).toBe('C:/logs/session.txt');
  expect(savedContent).toContain('ShellDesk terminal session');
  expect(savedContent).toContain('failed');
  expect(savedContent).not.toContain('\x1b[31m');
  expect(savedContent).not.toContain('ignored');
  controller.dispose();
});

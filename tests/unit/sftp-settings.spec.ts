import { expect, test } from '@playwright/test';

import { resolveSftpInitialDirectories } from '../../src/components/sftp-transfer/settings';

test('resolves configured SFTP start directories after trimming whitespace', () => {
  expect(resolveSftpInitialDirectories('  D:\\Transfers  ', '  /srv/releases  ')).toEqual({
    local: 'D:\\Transfers',
    remote: '/srv/releases',
  });
});

test('keeps the legacy SFTP start directories when settings are blank', () => {
  expect(resolveSftpInitialDirectories(' ', '')).toEqual({
    local: '/',
    remote: '.',
  });
});

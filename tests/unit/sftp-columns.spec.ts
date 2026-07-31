import { expect, test } from '@playwright/test';

import {
  normalizeSftpColumns,
  toggleSftpColumn,
} from '../../src/components/sftp-transfer/columns';

test('normalizes SFTP columns in a stable pane-specific order', () => {
  expect(normalizeSftpColumns('local', ['modifiedAt', 'permissions', 'size'])).toEqual([
    'name',
    'size',
    'modifiedAt',
  ]);
  expect(normalizeSftpColumns('remote', ['permissions', 'type', 'name'])).toEqual([
    'name',
    'type',
    'permissions',
  ]);
});

test('keeps the SFTP name column while optional columns can be toggled', () => {
  expect(toggleSftpColumn('remote', ['name', 'size'], 'name', false)).toEqual(['name', 'size']);
  expect(toggleSftpColumn('remote', ['name', 'permissions'], 'modifiedAt', true)).toEqual([
    'name',
    'permissions',
    'modifiedAt',
  ]);
});

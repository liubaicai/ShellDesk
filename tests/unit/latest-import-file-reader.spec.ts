import { expect, test } from '@playwright/test';

import {
  createLatestImportFileReader,
  type DatabaseImportFile,
  type DatabaseImportFileContent,
} from '../../src/components/remote-desktop/database-import/latestImportFileReader';

function deferredText() {
  let resolve!: (value: string) => void;
  const promise = new Promise<string>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function importFile(name: string, text: Promise<string>): DatabaseImportFile {
  return {
    name,
    text: () => text,
  };
}

test('only applies the latest selected import file when reads finish out of order', async () => {
  const first = deferredText();
  const second = deferredText();
  const reader = createLatestImportFileReader();
  const applied: DatabaseImportFileContent[] = [];

  const firstRead = reader.read(importFile('first.csv', first.promise), (content) => {
    applied.push(content);
  });
  const secondRead = reader.read(importFile('second.json', second.promise), (content) => {
    applied.push(content);
  });

  second.resolve('[{"id":2}]');
  expect(await secondRead).toBe(true);
  first.resolve('id\n1');
  expect(await firstRead).toBe(false);
  expect(applied).toEqual([
    { fileName: 'second.json', text: '[{"id":2}]' },
  ]);
});

test('invalidating an import read prevents stale completion after reset or unmount', async () => {
  const pending = deferredText();
  const reader = createLatestImportFileReader();
  const applied: DatabaseImportFileContent[] = [];
  const read = reader.read(importFile('stale.csv', pending.promise), (content) => {
    applied.push(content);
  });

  reader.invalidate();
  pending.resolve('id\n1');

  expect(await read).toBe(false);
  expect(applied).toEqual([]);
});

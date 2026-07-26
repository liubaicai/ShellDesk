import { expect, test } from '@playwright/test';

import {
  createDatabaseImportState,
  getDatabaseImportModeForFileName,
  updateDatabaseImportModeState,
  updateDatabaseImportPreviewState,
  updateDatabaseImportTextState,
} from '../../src/components/remote-desktop/database-import/databaseImportUtils';

test('creates a fresh reset state for each database import draft', () => {
  const first = createDatabaseImportState();
  const second = createDatabaseImportState();

  expect(first).toEqual({
    open: false,
    mode: 'csv',
    targetTable: '',
    csvText: '',
    jsonText: '',
    preview: [],
    columns: [],
    executing: false,
    progress: null,
    error: '',
  });
  expect(first).not.toBe(second);
  expect(first.preview).not.toBe(second.preview);
  expect(first.columns).not.toBe(second.columns);
});

test('updates CSV and JSON drafts independently while resetting transient status', () => {
  const pendingState = {
    ...createDatabaseImportState(),
    progress: { current: 2, total: 5 },
    error: '旧导入错误',
  };
  const csvState = updateDatabaseImportTextState(pendingState, 'csv', 'id,name\n1,Alice');
  const jsonState = updateDatabaseImportTextState(csvState, 'json', '[{"id":2}]');

  expect(csvState).toMatchObject({
    mode: 'csv',
    csvText: 'id,name\n1,Alice',
    jsonText: '',
    progress: null,
    error: '',
  });
  expect(jsonState).toMatchObject({
    mode: 'json',
    csvText: 'id,name\n1,Alice',
    jsonText: '[{"id":2}]',
    progress: null,
    error: '',
  });
});

test('switches import modes without replacing either saved draft', () => {
  const state = {
    ...createDatabaseImportState(),
    mode: 'csv' as const,
    csvText: 'id\n1',
    jsonText: '[{"id":2}]',
    progress: { current: 1, total: 1 },
    error: '旧导入错误',
  };

  expect(updateDatabaseImportModeState(state, 'json')).toMatchObject({
    mode: 'json',
    csvText: 'id\n1',
    jsonText: '[{"id":2}]',
    progress: null,
    error: '',
  });
});

test('selects JSON files case-insensitively and otherwise falls back to CSV', () => {
  expect(getDatabaseImportModeForFileName('rows.json')).toBe('json');
  expect(getDatabaseImportModeForFileName('rows.csv')).toBe('csv');
  expect(getDatabaseImportModeForFileName('rows.JSON')).toBe('json');
  expect(getDatabaseImportModeForFileName('rows.JsOn')).toBe('json');
});

test('keeps existing errors while applying or clearing preview data', () => {
  const state = {
    ...createDatabaseImportState(),
    error: '保留的执行错误',
  };
  const withPreview = updateDatabaseImportPreviewState(state, {
    columns: ['id'],
    rows: [{ id: 1 }],
    preview: [{ id: '1' }],
  });
  const withoutPreview = updateDatabaseImportPreviewState(withPreview, null);

  expect(withPreview).toMatchObject({
    columns: ['id'],
    preview: [{ id: '1' }],
    error: '保留的执行错误',
  });
  expect(withoutPreview).toMatchObject({
    columns: [],
    preview: [],
    error: '保留的执行错误',
  });
});

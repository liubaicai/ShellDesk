import { expect, test } from '@playwright/test';

import {
  parseDatabaseImportCsv,
  parseDatabaseImportJson,
  readDatabaseImportValue,
} from '../../src/components/remote-desktop/database-import/databaseImportUtils';

const jsonErrors = {
  mustBeArray: 'JSON 顶层必须是数组。',
  itemsMustBeObjects: 'JSON 数组项必须是对象。',
};

test.describe('parseDatabaseImportCsv', () => {
  test('parses CRLF rows, quoted commas, escaped quotes, quoted newlines, and blank rows', () => {
    const result = parseDatabaseImportCsv([
      'name,notes,quote',
      'Alice,"one,two","She said ""hi"""',
      'Bob,"line one\r\nline two",plain',
      ',,',
      'Carol,tail,ok',
    ].join('\r\n'), 'CSV 引号未闭合。');

    expect(result.columns).toEqual(['name', 'notes', 'quote']);
    expect(result.rows).toEqual([
      {
        name: 'Alice',
        notes: 'one,two',
        quote: 'She said "hi"',
      },
      {
        name: 'Bob',
        notes: 'line one\r\nline two',
        quote: 'plain',
      },
      {
        name: 'Carol',
        notes: 'tail',
        quote: 'ok',
      },
    ]);
    expect(result.preview).toEqual(result.rows);
  });

  test('fills short rows and ignores values beyond the parsed columns', () => {
    const result = parseDatabaseImportCsv(
      'alpha,beta,gamma\n1,2\n3,4,5,6',
      'CSV 引号未闭合。',
    );

    expect(result.columns).toEqual(['alpha', 'beta', 'gamma']);
    expect(result.rows).toEqual([
      { alpha: '1', beta: '2', gamma: '' },
      { alpha: '3', beta: '4', gamma: '5' },
    ]);
  });

  test('returns columns without rows or preview for a header-only document', () => {
    expect(parseDatabaseImportCsv('alpha,beta,gamma', 'CSV 引号未闭合。')).toEqual({
      columns: ['alpha', 'beta', 'gamma'],
      rows: [],
      preview: [],
    });
  });

  test('forwards the localized unclosed-quote error', () => {
    expect(() => parseDatabaseImportCsv(
      'alpha,beta\n"unterminated,value',
      '本地化：CSV 引号未闭合。',
    )).toThrow('本地化：CSV 引号未闭合。');
  });

  test('keeps original indexes while ignoring empty and later duplicate headers', () => {
    const result = parseDatabaseImportCsv(
      'id,,id,name\n1,ignored,2,Alice',
      'CSV 引号未闭合。',
    );

    expect(result.columns).toEqual(['id', 'name']);
    expect(result.rows).toEqual([
      {
        id: '1',
        name: 'Alice',
      },
    ]);
    expect(result.preview).toEqual([
      {
        id: '1',
        name: 'Alice',
      },
    ]);
  });

  test('preserves prototype-like column names as ordinary owned values', () => {
    const result = parseDatabaseImportCsv(
      '__proto__,constructor,toString,regular\nproto,ctor,string,value',
      'CSV 引号未闭合。',
    );
    const [row] = result.rows;

    expect(Object.getPrototypeOf(row)).toBeNull();
    expect(readDatabaseImportValue(row, '__proto__')).toBe('proto');
    expect(readDatabaseImportValue(row, 'constructor')).toBe('ctor');
    expect(readDatabaseImportValue(row, 'toString')).toBe('string');
    expect(result.preview[0]).toEqual(Object.fromEntries([
      ['__proto__', 'proto'],
      ['constructor', 'ctor'],
      ['toString', 'string'],
      ['regular', 'value'],
    ]));
  });
});

test.describe('parseDatabaseImportJson', () => {
  test('keeps heterogeneous field order and normalizes object, array, null, and missing preview values', () => {
    const result = parseDatabaseImportJson(JSON.stringify([
      {
        beta: 1,
        alpha: { nested: true },
        nullable: null,
      },
      {
        gamma: 'later',
        alpha: [1, 2],
      },
    ]), jsonErrors);

    expect(result.columns).toEqual(['beta', 'alpha', 'nullable', 'gamma']);
    expect(result.rows).toEqual([
      {
        beta: 1,
        alpha: { nested: true },
        nullable: null,
      },
      {
        gamma: 'later',
        alpha: [1, 2],
      },
    ]);
    expect(result.preview).toEqual([
      {
        beta: '1',
        alpha: '{"nested":true}',
        nullable: 'NULL',
        gamma: 'NULL',
      },
      {
        beta: 'NULL',
        alpha: '[1,2]',
        nullable: 'NULL',
        gamma: 'later',
      },
    ]);
  });

  test('limits preview rows to five without truncating imported rows', () => {
    const result = parseDatabaseImportJson(JSON.stringify(
      Array.from({ length: 7 }, (_, index) => ({ id: index + 1 })),
    ), jsonErrors);

    expect(result.rows).toHaveLength(7);
    expect(result.preview).toEqual([
      { id: '1' },
      { id: '2' },
      { id: '3' },
      { id: '4' },
      { id: '5' },
    ]);
  });

  test('treats missing prototype-like JSON columns as NULL instead of inherited values', () => {
    const result = parseDatabaseImportJson(
      '[{"__proto__":"proto","constructor":"ctor","toString":"string"},{"regular":"value"}]',
      jsonErrors,
    );

    expect(result.columns).toEqual(['__proto__', 'constructor', 'toString', 'regular']);
    expect(readDatabaseImportValue(result.rows[1], '__proto__')).toBeUndefined();
    expect(readDatabaseImportValue(result.rows[1], 'constructor')).toBeUndefined();
    expect(readDatabaseImportValue(result.rows[1], 'toString')).toBeUndefined();
    expect(result.preview[1]).toEqual(Object.fromEntries([
      ['__proto__', 'NULL'],
      ['constructor', 'NULL'],
      ['toString', 'NULL'],
      ['regular', 'value'],
    ]));
  });

  test('forwards the localized top-level array error', () => {
    expect(() => parseDatabaseImportJson(
      '{"id":1}',
      {
        ...jsonErrors,
        mustBeArray: '本地化：JSON 顶层必须是数组。',
      },
    )).toThrow('本地化：JSON 顶层必须是数组。');
  });

  test('forwards the localized object-item error', () => {
    expect(() => parseDatabaseImportJson(
      '[{"id":1},null]',
      {
        ...jsonErrors,
        itemsMustBeObjects: '本地化：JSON 数组项必须是对象。',
      },
    )).toThrow('本地化：JSON 数组项必须是对象。');
  });
});

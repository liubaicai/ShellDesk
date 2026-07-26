export interface ParsedDatabaseImport {
  columns: string[];
  rows: Record<string, unknown>[];
  preview: Record<string, string>[];
}

export type DatabaseImportMode = 'csv' | 'json';

export interface DatabaseImportState {
  open: boolean;
  mode: DatabaseImportMode;
  targetTable: string;
  csvText: string;
  jsonText: string;
  preview: Record<string, string>[];
  columns: string[];
  executing: boolean;
  progress: { current: number; total: number } | null;
  error: string;
}

export function createDatabaseImportState(): DatabaseImportState {
  return {
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
  };
}

export function updateDatabaseImportTextState(
  state: DatabaseImportState,
  mode: DatabaseImportMode,
  text: string,
): DatabaseImportState {
  return {
    ...state,
    mode,
    csvText: mode === 'csv' ? text : state.csvText,
    jsonText: mode === 'json' ? text : state.jsonText,
    progress: null,
    error: '',
  };
}

export function updateDatabaseImportModeState(
  state: DatabaseImportState,
  mode: DatabaseImportMode,
): DatabaseImportState {
  return {
    ...state,
    mode,
    progress: null,
    error: '',
  };
}

export function updateDatabaseImportPreviewState(
  state: DatabaseImportState,
  parsed: ParsedDatabaseImport | null,
): DatabaseImportState {
  return {
    ...state,
    preview: parsed?.preview ?? [],
    columns: parsed?.columns ?? [],
  };
}

export function getDatabaseImportModeForFileName(fileName: string): DatabaseImportMode {
  return fileName.toLowerCase().endsWith('.json') ? 'json' : 'csv';
}

interface DatabaseImportJsonErrors {
  mustBeArray: string;
  itemsMustBeObjects: string;
}

function normalizeImportPreviewValue(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function readDatabaseImportValue(
  row: Record<string, unknown>,
  column: string,
): unknown {
  return Object.hasOwn(row, column) ? row[column] : undefined;
}

function createImportPreview(columns: string[], rows: Record<string, unknown>[]) {
  return rows.slice(0, 5).map((row) => {
    const previewRow = Object.create(null) as Record<string, string>;
    for (const column of columns) {
      previewRow[column] = normalizeImportPreviewValue(readDatabaseImportValue(row, column));
    }
    return previewRow;
  });
}

function parseCsvRows(text: string, unclosedQuoteError: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = '';
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          value += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        value += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      continue;
    }
    if (char === ',') {
      row.push(value);
      value = '';
      continue;
    }
    if (char === '\n') {
      row.push(value);
      rows.push(row);
      row = [];
      value = '';
      continue;
    }
    if (char === '\r') {
      continue;
    }
    value += char;
  }

  if (inQuotes) {
    throw new Error(unclosedQuoteError);
  }
  if (value || row.length > 0) {
    row.push(value);
    rows.push(row);
  }

  return rows.filter((item) => item.some((cell) => cell.trim()));
}

export function parseDatabaseImportCsv(text: string, unclosedQuoteError: string): ParsedDatabaseImport {
  const parsedRows = parseCsvRows(text.trim(), unclosedQuoteError);
  const seenColumns = new Set<string>();
  const columnDescriptors = (parsedRows[0] ?? []).flatMap((rawColumn, sourceIndex) => {
    const column = rawColumn.trim();
    if (!column || seenColumns.has(column)) {
      return [];
    }
    seenColumns.add(column);
    return [{ column, sourceIndex }];
  });
  const columns = columnDescriptors.map(({ column }) => column);
  if (columns.length === 0 || parsedRows.length <= 1) {
    return { columns, rows: [], preview: [] };
  }

  const rows = parsedRows.slice(1).map((row) => {
    const entry = Object.create(null) as Record<string, unknown>;
    columnDescriptors.forEach(({ column, sourceIndex }) => {
      entry[column] = row[sourceIndex] ?? '';
    });
    return entry;
  });

  return {
    columns,
    rows,
    preview: createImportPreview(columns, rows),
  };
}

export function parseDatabaseImportJson(text: string, errors: DatabaseImportJsonErrors): ParsedDatabaseImport {
  const parsed = JSON.parse(text) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(errors.mustBeArray);
  }

  const rows = parsed.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(errors.itemsMustBeObjects);
    }
    return item as Record<string, unknown>;
  });
  const columns = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));

  return {
    columns,
    rows,
    preview: createImportPreview(columns, rows),
  };
}

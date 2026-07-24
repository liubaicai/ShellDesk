export interface ParsedDatabaseImport {
  columns: string[];
  rows: Record<string, unknown>[];
  preview: Record<string, string>[];
}

export interface DatabaseImportState {
  open: boolean;
  mode: 'csv' | 'json';
  targetTable: string;
  csvText: string;
  jsonText: string;
  preview: Record<string, string>[];
  columns: string[];
  executing: boolean;
  progress: { current: number; total: number } | null;
  error: string;
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

function createImportPreview(columns: string[], rows: Record<string, unknown>[]) {
  return rows.slice(0, 5).map((row) => (
    Object.fromEntries(columns.map((column) => [column, normalizeImportPreviewValue(row[column])]))
  ));
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
  const columns = parsedRows[0]?.map((column) => column.trim()).filter(Boolean) ?? [];
  if (columns.length === 0 || parsedRows.length <= 1) {
    return { columns, rows: [], preview: [] };
  }

  const rows = parsedRows.slice(1).map((row) => {
    const entry: Record<string, unknown> = {};
    columns.forEach((column, index) => {
      entry[column] = row[index] ?? '';
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

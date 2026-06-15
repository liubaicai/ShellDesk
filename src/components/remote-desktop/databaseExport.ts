import { getErrorMessage } from './desktopUtils';

export type DatabaseExportFormat = 'json' | 'csv';

type DatabaseExportRow = Record<string, unknown>;

interface DatabaseExportOptions {
  sourceName: string;
  format: DatabaseExportFormat;
  columns: string[];
  rows: DatabaseExportRow[];
  fileBaseName?: string;
  metadata?: Record<string, unknown>;
}

const csvUtf8Bom = '\ufeff';
const binaryChunkSize = 0x8000;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';

  for (let index = 0; index < bytes.length; index += binaryChunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + binaryChunkSize));
  }

  return btoa(binary);
}

function safeFilePart(value: string): string {
  return value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '-')
    .replace(/\s+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^-|-$/gu, '')
    .slice(0, 80)
    .toLowerCase();
}

function createExportFileName(sourceName: string, format: DatabaseExportFormat, fileBaseName?: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const source = safeFilePart(sourceName) || 'database';
  const base = fileBaseName ? safeFilePart(fileBaseName) : '';
  return [source, base || 'query-result', timestamp].join('-') + `.${format}`;
}

function normalizeExportValue(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof ArrayBuffer) {
    return {
      type: 'ArrayBuffer',
      base64: bytesToBase64(new Uint8Array(value)),
    };
  }

  if (ArrayBuffer.isView(value)) {
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return {
      type: value.constructor.name,
      base64: bytesToBase64(bytes),
    };
  }

  return value;
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return normalizeExportValue(value);
}

function collectColumns(columns: string[], rows: DatabaseExportRow[]): string[] {
  const orderedColumns: string[] = [];
  const seen = new Set<string>();

  for (const column of columns) {
    if (!seen.has(column)) {
      seen.add(column);
      orderedColumns.push(column);
    }
  }

  for (const row of rows) {
    for (const column of Object.keys(row)) {
      if (!seen.has(column)) {
        seen.add(column);
        orderedColumns.push(column);
      }
    }
  }

  return orderedColumns;
}

function stringifyCsvCell(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }

  const normalized = normalizeExportValue(value);
  let text: string;

  if (typeof normalized === 'object') {
    try {
      text = JSON.stringify(normalized, jsonReplacer) ?? '';
    } catch {
      text = String(normalized);
    }
  } else {
    text = String(normalized);
  }

  if (/^[=+\-@\t\r]/u.test(text)) {
    text = `'${text}`;
  }

  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

function serializeRows(options: DatabaseExportOptions): string {
  const columns = collectColumns(options.columns, options.rows);

  if (options.format === 'json') {
    return JSON.stringify({
      source: options.sourceName,
      exportedAt: new Date().toISOString(),
      rowCount: options.rows.length,
      columns,
      metadata: options.metadata ?? {},
      rows: options.rows,
    }, jsonReplacer, 2);
  }

  const header = columns.map(stringifyCsvCell).join(',');
  const body = options.rows.map((row) => columns.map((column) => stringifyCsvCell(row[column])).join(','));
  return `${csvUtf8Bom}${[header, ...body].join('\r\n')}\r\n`;
}

export async function exportDatabaseRows(options: DatabaseExportOptions): Promise<string> {
  const saveTextFile = window.guiSSH?.files?.saveTextFile;

  if (!saveTextFile) {
    throw new Error('当前运行环境不支持保存文件。');
  }

  try {
    return await saveTextFile({
      title: `导出 ${options.sourceName} 查询结果`,
      defaultFileName: createExportFileName(options.sourceName, options.format, options.fileBaseName),
      content: serializeRows(options),
      filters: [
        {
          name: options.format === 'json' ? 'JSON Files' : 'CSV Files',
          extensions: [options.format],
        },
        {
          name: 'All Files',
          extensions: ['*'],
        },
      ],
    });
  } catch (error) {
    throw new Error(`导出失败：${getErrorMessage(error)}`);
  }
}

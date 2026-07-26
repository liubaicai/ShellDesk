import type {
  BackupEntry,
  BackupPlan,
  BackupSourceType,
  BackupValidationResult,
} from './backupTypes';

const backupNamePattern = /^shelldesk-(files|mysql|postgres|mongo|sqlite)-/i;
const backupItemMarker = '__SHELLDESK_BACKUP_ITEM__\t';
const backupCreatedMarker = '__SHELLDESK_BACKUP_CREATED__\t';
const backupValidationMarker = '__SHELLDESK_BACKUP_VALIDATION__\t';
const backupPlanMarker = '# SHELLDESK_BACKUP:';

function toFiniteNumber(value: unknown) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue >= 0 ? numericValue : 0;
}

function normalizeModifiedAt(value: unknown) {
  const text = String(value ?? '').trim();
  if (!text) return '';

  if (/^\d{9,13}$/.test(text)) {
    const numericValue = Number(text);
    const milliseconds = text.length <= 10 ? numericValue * 1_000 : numericValue;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? text : date.toISOString();
  }

  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? text : date.toISOString();
}

function readObjectString(record: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

export function detectBackupKind(name: string): BackupSourceType {
  const match = name.match(backupNamePattern);
  const value = match?.[1]?.toLowerCase();
  return value === 'mysql' || value === 'postgres' || value === 'mongo' || value === 'sqlite'
    ? value
    : 'files';
}

export function parseBackupEntries(stdout: string, isWindowsHost: boolean): BackupEntry[] {
  const trimmedOutput = stdout.trim();
  if (!trimmedOutput) return [];

  let entries: BackupEntry[];
  if (isWindowsHost && (trimmedOutput.startsWith('[') || trimmedOutput.startsWith('{'))) {
    const payload = JSON.parse(trimmedOutput) as unknown;
    const rows = Array.isArray(payload) ? payload : [payload];
    entries = rows
      .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object' && !Array.isArray(row))
      .map((row) => {
        const name = readObjectString(row, 'Name', 'name');
        return {
          name,
          path: readObjectString(row, 'FullName', 'fullName', 'Path', 'path'),
          size: toFiniteNumber(row.Length ?? row.length ?? row.Size ?? row.size),
          modifiedAt: normalizeModifiedAt(row.LastWriteTimeUtc ?? row.lastWriteTimeUtc ?? row.ModifiedAt ?? row.modifiedAt),
          kind: detectBackupKind(name),
        };
      })
      .filter((entry) => Boolean(entry.name && entry.path));
  } else {
    entries = trimmedOutput
      .split(/\r?\n/)
      .filter((line) => line.startsWith(backupItemMarker))
      .map((line) => {
        const [name = '', path = '', size = '0', modifiedAt = ''] = line.slice(backupItemMarker.length).split('\t');
        return {
          name,
          path,
          size: toFiniteNumber(size),
          modifiedAt: normalizeModifiedAt(modifiedAt),
          kind: detectBackupKind(name),
        };
      })
      .filter((entry) => Boolean(entry.name && entry.path));
  }

  return entries.sort((left, right) => {
    const timeDifference = Date.parse(right.modifiedAt) - Date.parse(left.modifiedAt);
    return Number.isFinite(timeDifference) && timeDifference !== 0
      ? timeDifference
      : right.name.localeCompare(left.name);
  });
}

export function parseCreatedBackupPath(stdout: string) {
  const markerLine = stdout
    .split(/\r?\n/)
    .find((line) => line.startsWith(backupCreatedMarker));
  return markerLine?.slice(backupCreatedMarker.length).trim() ?? '';
}

export function parseBackupValidation(stdout: string): BackupValidationResult {
  const markerLine = stdout
    .split(/\r?\n/)
    .find((line) => line.startsWith(backupValidationMarker));

  if (!markerLine) {
    throw new Error('Backup validation did not return a result marker.');
  }

  const [checksum = '', detail = ''] = markerLine.slice(backupValidationMarker.length).split('\t');
  return { checksum: checksum.trim(), detail: detail.trim() };
}

export function parseDetectedBackupTools(stdout: string) {
  return [...new Set(stdout
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean))]
    .sort();
}

function parseUnixBackupPlans(stdout: string): BackupPlan[] {
  const lines = stdout.split(/\r?\n/);
  const plans: BackupPlan[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const markerLine = lines[index].trim();
    if (!markerLine.startsWith(backupPlanMarker)) continue;

    const [id = '', sourceType = '', label = '', scriptPath = ''] = markerLine
      .slice(backupPlanMarker.length)
      .split('|');
    const scheduleLine = lines[index + 1]?.trim() ?? '';
    const normalizedScheduleLine = scheduleLine.replace(/^#\s*/, '');
    const schedule = normalizedScheduleLine.split(/\s+/).slice(0, 5).join(' ');

    if (!id || !isBackupSourceType(sourceType) || schedule.split(/\s+/).length !== 5) continue;

    plans.push({
      id,
      label: label || id,
      sourceType,
      schedule,
      enabled: !scheduleLine.startsWith('#'),
      scriptPath,
    });
  }

  return plans;
}

function parseWindowsBackupPlans(stdout: string): BackupPlan[] {
  const trimmedOutput = stdout.trim();
  if (!trimmedOutput) return [];

  const payload = JSON.parse(trimmedOutput) as unknown;
  const rows = Array.isArray(payload) ? payload : [payload];

  return rows
    .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object' && !Array.isArray(row))
    .flatMap((row): BackupPlan[] => {
      const description = readObjectString(row, 'Description', 'description');
      const [, id = '', sourceType = '', label = '', schedule = ''] = description.split('|');
      const state = readObjectString(row, 'State', 'state');
      if (!id || !isBackupSourceType(sourceType)) return [];
      return [{
        id,
        label: label || readObjectString(row, 'TaskName', 'taskName'),
        sourceType,
        schedule,
        enabled: !/disabled/i.test(state),
        scriptPath: readObjectString(row, 'ScriptPath', 'scriptPath'),
      }];
    });
}

export function parseBackupPlans(stdout: string, isWindowsHost: boolean) {
  return isWindowsHost ? parseWindowsBackupPlans(stdout) : parseUnixBackupPlans(stdout);
}

function isBackupSourceType(value: string): value is BackupSourceType {
  return value === 'files' || value === 'mysql' || value === 'postgres' || value === 'mongo' || value === 'sqlite';
}

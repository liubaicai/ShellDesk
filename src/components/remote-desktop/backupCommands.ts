import { powershellSingleQuote, powershellStdinCommand, type RemoteCommandInput } from './remoteSystem';
import { shellSingleQuote } from './shellUtils';
import type {
  BackupCommand,
  BackupDraft,
  BackupEntry,
  BackupPlanDraft,
  BackupSourceType,
} from './backupTypes';

export const defaultUnixBackupDirectory = '$HOME/.local/share/shelldesk/backups';
export const defaultWindowsBackupDirectory = '$env:USERPROFILE\\.shelldesk\\backups';

const backupCreatedMarker = '__SHELLDESK_BACKUP_CREATED__';
const backupValidationMarker = '__SHELLDESK_BACKUP_VALIDATION__';
const backupPlanMarker = '# SHELLDESK_BACKUP:';

const databaseDefaultPorts: Record<Exclude<BackupSourceType, 'files' | 'sqlite'>, string> = {
  mysql: '3306',
  postgres: '5432',
  mongo: '27017',
};

function validateText(value: string, label: string, maxLength = 500) {
  const trimmedValue = value.trim();
  if (!trimmedValue) throw new Error(`${label} is required.`);
  if (trimmedValue.length > maxLength || /[\u0000\r\n\t]/.test(trimmedValue)) {
    throw new Error(`${label} contains unsupported characters.`);
  }
  return trimmedValue;
}

function validateLabel(value: string) {
  const label = validateText(value, 'Backup name', 64);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(label)) {
    throw new Error('Backup name may only contain letters, numbers, dots, hyphens, and underscores.');
  }
  return label;
}

function validateDatabaseName(value: string) {
  const database = validateText(value, 'Database', 128);
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(database)) {
    throw new Error('Database name contains unsupported characters.');
  }
  return database;
}

function validateHost(value: string) {
  const host = validateText(value, 'Database host', 255);
  if (!/^[A-Za-z0-9][A-Za-z0-9.:[\]_-]{0,254}$/.test(host)) {
    throw new Error('Database host contains unsupported characters.');
  }
  return host;
}

function validatePort(value: string, sourceType: BackupSourceType) {
  const fallback = sourceType === 'mysql' || sourceType === 'postgres' || sourceType === 'mongo'
    ? databaseDefaultPorts[sourceType]
    : '';
  const numericPort = Number.parseInt(value || fallback, 10);
  if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65_535) {
    throw new Error('Database port must be between 1 and 65535.');
  }
  return String(numericPort);
}

function validateUsername(value: string) {
  const username = validateText(value, 'Database username', 128);
  if (username.startsWith('-')) throw new Error('Database username cannot begin with a hyphen.');
  return username;
}

function validateRemotePath(value: string, label: string) {
  return validateText(value, label, 900);
}

function unixPathExpression(path: string) {
  if (path === '~' || path === '$HOME' || path === '${HOME}') return '"$HOME"';
  const homeRelativeMatch = path.match(/^(?:~|\$HOME|\$\{HOME\})\/(.+)$/);
  return homeRelativeMatch
    ? `"$HOME"/${shellSingleQuote(homeRelativeMatch[1])}`
    : shellSingleQuote(path);
}

function powershellPathExpression(path: string) {
  if (/^(?:~|\$env:USERPROFILE)$/i.test(path)) return '$env:USERPROFILE';
  const homeRelativeMatch = path.match(/^(?:~|\$env:USERPROFILE)[\\/](.+)$/i);
  return homeRelativeMatch
    ? `(Join-Path $env:USERPROFILE ${powershellSingleQuote(homeRelativeMatch[1])})`
    : powershellSingleQuote(path);
}

function validateSqlitePath(value: string, label: string) {
  const path = validateRemotePath(value, label);
  if (path.includes('"')) throw new Error(`${label} cannot contain a double quote for SQLite backup operations.`);
  return path;
}

function getBackupExtension(sourceType: BackupSourceType) {
  if (sourceType === 'postgres') return 'dump';
  if (sourceType === 'mongo') return 'archive.gz';
  if (sourceType === 'sqlite') return 'sqlite3';
  if (sourceType === 'mysql') return 'sql.gz';
  return 'tar.gz';
}

function getDatabaseFields(draft: BackupDraft) {
  const database = validateDatabaseName(draft.database);
  const host = validateHost(draft.databaseHost || '127.0.0.1');
  const port = validatePort(draft.databasePort, draft.sourceType);
  const username = draft.databaseUsername.trim() ? validateUsername(draft.databaseUsername) : '';
  const password = draft.databasePassword;

  if (password.length > 500 || /[\u0000\r\n]/.test(password)) {
    throw new Error('Database password contains unsupported characters.');
  }

  if ((draft.sourceType === 'mysql' || draft.sourceType === 'postgres') && !username) {
    throw new Error('Database username is required.');
  }

  if (draft.sourceType === 'mongo' && password && !username) {
    throw new Error('MongoDB username is required when a password is provided.');
  }

  const authDatabase = draft.sourceType === 'mongo'
    ? validateDatabaseName(draft.mongoAuthDatabase || 'admin')
    : '';

  return { database, host, port, username, password, authDatabase };
}

function assertSupportedDraft(draft: BackupDraft, isWindowsHost: boolean) {
  validateLabel(draft.label);
  validateRemotePath(draft.remoteDirectory, 'Backup directory');
  if (draft.sourceType === 'files') {
    validateRemotePath(draft.sourcePath, 'Source path');
    if (draft.incremental && isWindowsHost) {
      throw new Error('Incremental tar snapshots are currently available on Unix hosts only.');
    }
  } else if (draft.sourceType === 'sqlite') {
    validateSqlitePath(draft.sourcePath, 'SQLite source path');
    validateSqlitePath(draft.remoteDirectory, 'Backup directory');
  } else {
    getDatabaseFields(draft);
  }
}

function unixToolGuard(...tools: string[]) {
  return tools
    .map((tool) => `command -v ${shellSingleQuote(tool)} >/dev/null 2>&1 || { echo ${shellSingleQuote(`${tool} is not installed.`)} >&2; exit 127; }`)
    .join('\n');
}

function powershellToolGuard(...tools: string[]) {
  return tools
    .map((tool) => `if (-not (Get-Command ${powershellSingleQuote(tool)} -ErrorAction SilentlyContinue)) { throw ${powershellSingleQuote(`${tool} is not installed.`)} }`)
    .join('\n');
}

function buildUnixBackupScript(draft: BackupDraft, includePassword: boolean, emitMarker: boolean) {
  assertSupportedDraft(draft, false);
  const label = validateLabel(draft.label);
  const destination = validateRemotePath(draft.remoteDirectory, 'Backup directory');
  const extension = getBackupExtension(draft.sourceType);
  const commonPrelude = `#!/bin/sh
set -eu
destination=${unixPathExpression(destination)}
mkdir -p -- "$destination"
stamp=$(date -u +%Y%m%d-%H%M%S)
output="$destination/shelldesk-${draft.sourceType}-${label}-$stamp.${extension}"`;
  let operation = '';

  if (draft.sourceType === 'files') {
    const sourcePath = validateRemotePath(draft.sourcePath, 'Source path');
    operation = `${unixToolGuard('tar')}
source_path=${unixPathExpression(sourcePath)}
test -e "$source_path" || { echo "Source path does not exist: $source_path" >&2; exit 2; }
source_parent=$(dirname -- "$source_path")
source_name=$(basename -- "$source_path")
${draft.incremental
    ? `snapshot="$destination/.shelldesk-${label}.snar"
tar --listed-incremental="$snapshot" -czf "$output" -C "$source_parent" -- "$source_name"`
    : 'tar -czf "$output" -C "$source_parent" -- "$source_name"'}`;
  } else if (draft.sourceType === 'mysql') {
    const fields = getDatabaseFields(draft);
    operation = `${unixToolGuard('mysqldump', 'gzip')}
database=${shellSingleQuote(fields.database)}
host=${shellSingleQuote(fields.host)}
port=${shellSingleQuote(fields.port)}
username=${shellSingleQuote(fields.username)}
temporary_sql="${'${output}'}.tmp.sql"
trap 'rm -f -- "$temporary_sql"' EXIT
${includePassword && fields.password ? `MYSQL_PWD=${shellSingleQuote(fields.password)}
export MYSQL_PWD` : ''}
mysqldump --single-transaction --routines --events --triggers --host "$host" --port "$port" --user "$username" --result-file "$temporary_sql" --databases "$database"
gzip -c "$temporary_sql" > "$output"`;
  } else if (draft.sourceType === 'postgres') {
    const fields = getDatabaseFields(draft);
    operation = `${unixToolGuard('pg_dump')}
database=${shellSingleQuote(fields.database)}
host=${shellSingleQuote(fields.host)}
port=${shellSingleQuote(fields.port)}
username=${shellSingleQuote(fields.username)}
${includePassword && fields.password ? `PGPASSWORD=${shellSingleQuote(fields.password)}
export PGPASSWORD` : ''}
pg_dump --format=custom --no-owner --host "$host" --port "$port" --username "$username" --file "$output" "$database"`;
  } else if (draft.sourceType === 'mongo') {
    const fields = getDatabaseFields(draft);
    const authArguments = includePassword && fields.username
      ? ` --username "$username" --password "$password" --authenticationDatabase "$auth_database"`
      : '';
    operation = `${unixToolGuard('mongodump')}
database=${shellSingleQuote(fields.database)}
host=${shellSingleQuote(fields.host)}
port=${shellSingleQuote(fields.port)}
username=${shellSingleQuote(fields.username)}
password=${shellSingleQuote(includePassword ? fields.password : '')}
auth_database=${shellSingleQuote(fields.authDatabase)}
mongodump --host "$host" --port "$port" --db "$database"${authArguments} --archive="$output" --gzip`;
  } else {
    const sourcePath = validateSqlitePath(draft.sourcePath, 'SQLite source path');
    operation = `${unixToolGuard('sqlite3')}
source_path=${unixPathExpression(sourcePath)}
test -f "$source_path" || { echo "SQLite database does not exist: $source_path" >&2; exit 2; }
sqlite3 "$source_path" ".backup \\"$output\\""`;
  }

  return `${commonPrelude}
${operation}
test -s "$output" || { echo "Backup output is empty." >&2; exit 3; }
${emitMarker ? `printf '${backupCreatedMarker}\\t%s\\n' "$output"` : ''}`.trim();
}

function buildWindowsBackupScript(draft: BackupDraft, includePassword: boolean, emitMarker: boolean) {
  assertSupportedDraft(draft, true);
  const label = validateLabel(draft.label);
  const destination = validateRemotePath(draft.remoteDirectory, 'Backup directory');
  const extension = getBackupExtension(draft.sourceType);
  const commonPrelude = `$ErrorActionPreference = 'Stop'
$destination = ${powershellPathExpression(destination)}
New-Item -ItemType Directory -Force -Path $destination | Out-Null
$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss')
$output = Join-Path $destination ${powershellSingleQuote(`shelldesk-${draft.sourceType}-${label}-`)}$stamp${powershellSingleQuote(`.${extension}`)}`;
  let operation = '';

  if (draft.sourceType === 'files') {
    const sourcePath = validateRemotePath(draft.sourcePath, 'Source path');
    operation = `${powershellToolGuard('tar')}
$sourcePath = ${powershellPathExpression(sourcePath)}
if (-not (Test-Path -LiteralPath $sourcePath)) { throw "Source path does not exist: $sourcePath" }
& tar -czf $output -- $sourcePath
if ($LASTEXITCODE -ne 0) { throw "tar exited with code $LASTEXITCODE" }`;
  } else if (draft.sourceType === 'mysql') {
    const fields = getDatabaseFields(draft);
    operation = `${powershellToolGuard('mysqldump', 'gzip')}
$database = ${powershellSingleQuote(fields.database)}
$temporarySql = "$output.tmp.sql"
try {
  ${includePassword && fields.password ? `$env:MYSQL_PWD = ${powershellSingleQuote(fields.password)}` : ''}
  & mysqldump --single-transaction --routines --events --triggers --host ${powershellSingleQuote(fields.host)} --port ${fields.port} --user ${powershellSingleQuote(fields.username)} "--result-file=$temporarySql" --databases $database
  if ($LASTEXITCODE -ne 0) { throw "mysqldump exited with code $LASTEXITCODE" }
  & gzip -f $temporarySql
  if ($LASTEXITCODE -ne 0) { throw "gzip exited with code $LASTEXITCODE" }
  Move-Item -LiteralPath "$temporarySql.gz" -Destination $output -Force
} finally {
  Remove-Item -LiteralPath $temporarySql, "$temporarySql.gz" -Force -ErrorAction SilentlyContinue
  Remove-Item Env:MYSQL_PWD -ErrorAction SilentlyContinue
}`;
  } else if (draft.sourceType === 'postgres') {
    const fields = getDatabaseFields(draft);
    operation = `${powershellToolGuard('pg_dump')}
try {
  ${includePassword && fields.password ? `$env:PGPASSWORD = ${powershellSingleQuote(fields.password)}` : ''}
  & pg_dump --format=custom --no-owner --host ${powershellSingleQuote(fields.host)} --port ${fields.port} --username ${powershellSingleQuote(fields.username)} --file $output ${powershellSingleQuote(fields.database)}
  if ($LASTEXITCODE -ne 0) { throw "pg_dump exited with code $LASTEXITCODE" }
} finally {
  Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
}`;
  } else if (draft.sourceType === 'mongo') {
    const fields = getDatabaseFields(draft);
    const authArguments = includePassword && fields.username
      ? `--username ${powershellSingleQuote(fields.username)} --password ${powershellSingleQuote(fields.password)} --authenticationDatabase ${powershellSingleQuote(fields.authDatabase)}`
      : '';
    operation = `${powershellToolGuard('mongodump')}
& mongodump --host ${powershellSingleQuote(fields.host)} --port ${fields.port} --db ${powershellSingleQuote(fields.database)} ${authArguments} "--archive=$output" --gzip
if ($LASTEXITCODE -ne 0) { throw "mongodump exited with code $LASTEXITCODE" }`;
  } else {
    const sourcePath = validateSqlitePath(draft.sourcePath, 'SQLite source path');
    operation = `${powershellToolGuard('sqlite3')}
$sourcePath = ${powershellPathExpression(sourcePath)}
if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) { throw "SQLite database does not exist: $sourcePath" }
& sqlite3 $sourcePath ".backup \`"$output\`""
if ($LASTEXITCODE -ne 0) { throw "sqlite3 exited with code $LASTEXITCODE" }`;
  }

  return `${commonPrelude}
${operation}
if (-not (Test-Path -LiteralPath $output -PathType Leaf) -or (Get-Item -LiteralPath $output).Length -le 0) { throw 'Backup output is empty.' }
${emitMarker ? `Write-Output (${powershellSingleQuote(`${backupCreatedMarker}\t`)} + $output)` : ''}`.trim();
}

function createBackupPreview(draft: BackupDraft) {
  const destination = draft.remoteDirectory.trim() || '<backup-directory>';
  if (draft.sourceType === 'files') {
    return `${draft.incremental ? 'tar --listed-incremental' : 'tar'} -czf ${destination}/shelldesk-files-${draft.label || '<name>'}-<timestamp>.tar.gz ${draft.sourcePath || '<source-path>'}`;
  }

  if (draft.sourceType === 'sqlite') {
    return `sqlite3 ${draft.sourcePath || '<database.sqlite>'} ".backup <output>"`;
  }

  const passwordHint = draft.databasePassword ? ' [password supplied through protected stdin]' : '';
  const tool = draft.sourceType === 'mysql' ? 'mysqldump' : draft.sourceType === 'postgres' ? 'pg_dump' : 'mongodump';
  return `${tool} ${draft.databaseHost || '127.0.0.1'}:${draft.databasePort || databaseDefaultPorts[draft.sourceType]} ${draft.database || '<database>'} → ${destination}${passwordHint}`;
}

export function createBackupCommand(draft: BackupDraft, isWindowsHost: boolean): BackupCommand {
  assertSupportedDraft(draft, isWindowsHost);
  return {
    input: isWindowsHost
      ? powershellStdinCommand(buildWindowsBackupScript(draft, true, true))
      : { command: 'sh -s', stdin: buildUnixBackupScript(draft, true, true) },
    preview: createBackupPreview(draft),
    kind: draft.sourceType,
  };
}

export function createBackupToolDetectionCommand(isWindowsHost: boolean): RemoteCommandInput {
  const tools = ['tar', 'gzip', 'mysqldump', 'mysql', 'pg_dump', 'pg_restore', 'mongodump', 'mongorestore', 'sqlite3', 'aws', 'mc', 'crontab'];
  if (isWindowsHost) {
    return powershellStdinCommand(tools
      .map((tool) => `if (Get-Command ${powershellSingleQuote(tool)} -ErrorAction SilentlyContinue) { ${powershellSingleQuote(tool)} }`)
      .join('\n'));
  }
  return {
    command: 'sh -s',
    stdin: `for tool in ${tools.map(shellSingleQuote).join(' ')}; do command -v "$tool" >/dev/null 2>&1 && printf '%s\\n' "$tool"; done`,
  };
}

export function createListBackupsCommand(remoteDirectory: string, isWindowsHost: boolean): RemoteCommandInput {
  const directory = validateRemotePath(remoteDirectory, 'Backup directory');
  if (isWindowsHost) {
    return powershellStdinCommand(`$directory = ${powershellPathExpression(directory)}
$items = @(
  if (Test-Path -LiteralPath $directory -PathType Container) {
    Get-ChildItem -LiteralPath $directory -File -Filter 'shelldesk-*' -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTimeUtc -Descending |
      Select-Object -First 500 Name, FullName, Length, LastWriteTimeUtc
  }
)
ConvertTo-Json -InputObject $items -Compress`);
  }

  return {
    command: 'sh -s',
    stdin: `directory=${unixPathExpression(directory)}
[ -d "$directory" ] || exit 0
for file in "$directory"/shelldesk-*; do
  [ -f "$file" ] || continue
  name=$(basename -- "$file")
  if stat -c '%s	%Y' "$file" >/dev/null 2>&1; then
    metadata=$(stat -c '%s	%Y' "$file")
  else
    metadata=$(stat -f '%z	%m' "$file")
  fi
  printf '__SHELLDESK_BACKUP_ITEM__\\t%s\\t%s\\t%s\\n' "$name" "$file" "$metadata"
done`,
  };
}

export function createDeleteBackupCommand(entry: BackupEntry, isWindowsHost: boolean): RemoteCommandInput {
  const path = validateRemotePath(entry.path, 'Backup path');
  return isWindowsHost
    ? powershellStdinCommand(`Remove-Item -LiteralPath ${powershellSingleQuote(path)} -Force -ErrorAction Stop`)
    : { command: 'sh -s', stdin: `rm -f -- ${shellSingleQuote(path)}` };
}

export function createValidateBackupCommand(entry: BackupEntry, isWindowsHost: boolean): RemoteCommandInput {
  const path = entry.kind === 'sqlite'
    ? validateSqlitePath(entry.path, 'Backup path')
    : validateRemotePath(entry.path, 'Backup path');

  if (isWindowsHost) {
    const checks: Record<BackupSourceType, string> = {
      files: `${powershellToolGuard('tar')}
$members = @(& tar -tzf $path)
if ($LASTEXITCODE -ne 0) { throw 'Archive validation failed.' }
$unsafeMember = $members | Where-Object {
  [IO.Path]::IsPathRooted($_) -or $_ -match '(^|[\\\\/])\\.\\.([\\\\/]|$)'
} | Select-Object -First 1
if ($unsafeMember) { throw "Archive contains an unsafe path: $unsafeMember" }
$detail = 'tar archive readable and paths safe'`,
      mysql: `${powershellToolGuard('gzip')}\n& gzip -t $path\nif ($LASTEXITCODE -ne 0) { throw 'gzip validation failed.' }\n$detail = 'gzip stream valid'`,
      postgres: `${powershellToolGuard('pg_restore')}\n& pg_restore --list $path *> $null\nif ($LASTEXITCODE -ne 0) { throw 'pg_restore validation failed.' }\n$detail = 'PostgreSQL catalog readable'`,
      mongo: `${powershellToolGuard('mongorestore')}\n& mongorestore --archive=$path --gzip --dryRun *> $null\nif ($LASTEXITCODE -ne 0) { throw 'mongorestore dry-run failed.' }\n$detail = 'MongoDB dry-run passed'`,
      sqlite: `${powershellToolGuard('sqlite3')}\n$result = (& sqlite3 $path 'PRAGMA quick_check;').Trim()\nif ($LASTEXITCODE -ne 0 -or $result -ne 'ok') { throw "SQLite quick_check failed: $result" }\n$detail = 'SQLite quick_check passed'`,
    };
    return powershellStdinCommand(`$ErrorActionPreference = 'Stop'
$path = ${powershellSingleQuote(path)}
if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'Backup file does not exist.' }
$checksum = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
${checks[entry.kind]}
Write-Output (${powershellSingleQuote(`${backupValidationMarker}\t`)} + $checksum + [char]9 + $detail)`);
  }

  const checks: Record<BackupSourceType, string> = {
    files: `${unixToolGuard('tar')}
archive_entries=$(tar -tzf "$path")
printf '%s\\n' "$archive_entries" | while IFS= read -r archive_entry; do
  case "$archive_entry" in
    /*|../*|*/../*|*/..) echo "Archive contains an unsafe path: $archive_entry" >&2; exit 5 ;;
  esac
done
detail='tar archive readable and paths safe'`,
    mysql: `${unixToolGuard('gzip')}\ngzip -t "$path"\ndetail='gzip stream valid'`,
    postgres: `${unixToolGuard('pg_restore')}\npg_restore --list "$path" >/dev/null\ndetail='PostgreSQL catalog readable'`,
    mongo: `${unixToolGuard('mongorestore')}\nmongorestore --archive="$path" --gzip --dryRun >/dev/null\ndetail='MongoDB dry-run passed'`,
    sqlite: `${unixToolGuard('sqlite3')}\nresult=$(sqlite3 "$path" 'PRAGMA quick_check;')\n[ "$result" = 'ok' ] || { echo "SQLite quick_check failed: $result" >&2; exit 4; }\ndetail='SQLite quick_check passed'`,
  };
  return {
    command: 'sh -s',
    stdin: `set -eu
path=${shellSingleQuote(path)}
[ -f "$path" ] || { echo 'Backup file does not exist.' >&2; exit 2; }
if command -v sha256sum >/dev/null 2>&1; then
  checksum=$(sha256sum "$path" | awk '{print $1}')
else
  checksum=$(shasum -a 256 "$path" | awk '{print $1}')
fi
${checks[entry.kind]}
printf '${backupValidationMarker}\\t%s\\t%s\\n' "$checksum" "$detail"`,
  };
}

export function createRestoreBackupCommand(
  entry: BackupEntry,
  draft: BackupDraft,
  restorePath: string,
  isWindowsHost: boolean,
): BackupCommand {
  const backupPath = entry.kind === 'sqlite'
    ? validateSqlitePath(entry.path, 'Backup path')
    : validateRemotePath(entry.path, 'Backup path');
  const targetPath = entry.kind === 'files' || entry.kind === 'sqlite'
    ? validateRemotePath(restorePath, 'Restore destination')
    : '';
  const effectiveDraft = { ...draft, sourceType: entry.kind };
  if (entry.kind !== 'files' && entry.kind !== 'sqlite') getDatabaseFields(effectiveDraft);

  if (isWindowsHost) {
    let operation = '';
    if (entry.kind === 'files') {
      operation = `${powershellToolGuard('tar')}
$targetPath = ${powershellPathExpression(targetPath)}
New-Item -ItemType Directory -Force -Path $targetPath | Out-Null
& tar -xzf $backupPath -C $targetPath
if ($LASTEXITCODE -ne 0) { throw "tar restore exited with code $LASTEXITCODE" }`;
    } else if (entry.kind === 'mysql') {
      const fields = getDatabaseFields(effectiveDraft);
      operation = `${powershellToolGuard('mysql', 'gzip')}
try {
  ${fields.password ? `$env:MYSQL_PWD = ${powershellSingleQuote(fields.password)}` : ''}
  & gzip -dc $backupPath | & mysql --host ${powershellSingleQuote(fields.host)} --port ${fields.port} --user ${powershellSingleQuote(fields.username)}
  if ($LASTEXITCODE -ne 0) { throw "mysql restore exited with code $LASTEXITCODE" }
} finally { Remove-Item Env:MYSQL_PWD -ErrorAction SilentlyContinue }`;
    } else if (entry.kind === 'postgres') {
      const fields = getDatabaseFields(effectiveDraft);
      operation = `${powershellToolGuard('pg_restore')}
try {
  ${fields.password ? `$env:PGPASSWORD = ${powershellSingleQuote(fields.password)}` : ''}
  & pg_restore --clean --if-exists --no-owner --host ${powershellSingleQuote(fields.host)} --port ${fields.port} --username ${powershellSingleQuote(fields.username)} --dbname ${powershellSingleQuote(fields.database)} $backupPath
  if ($LASTEXITCODE -ne 0) { throw "pg_restore exited with code $LASTEXITCODE" }
} finally { Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue }`;
    } else if (entry.kind === 'mongo') {
      const fields = getDatabaseFields(effectiveDraft);
      const authArguments = fields.username
        ? `--username ${powershellSingleQuote(fields.username)} --password ${powershellSingleQuote(fields.password)} --authenticationDatabase ${powershellSingleQuote(fields.authDatabase)}`
        : '';
      operation = `${powershellToolGuard('mongorestore')}
& mongorestore --drop --host ${powershellSingleQuote(fields.host)} --port ${fields.port} ${authArguments} "--archive=$backupPath" --gzip --nsInclude ${powershellSingleQuote(`${fields.database}.*`)}
if ($LASTEXITCODE -ne 0) { throw "mongorestore exited with code $LASTEXITCODE" }`;
    } else {
      const sqliteTarget = validateSqlitePath(targetPath, 'Restore destination');
      operation = `${powershellToolGuard('sqlite3')}
$sqliteTarget = ${powershellPathExpression(sqliteTarget)}
& sqlite3 $backupPath ('.backup "' + $sqliteTarget + '"')
if ($LASTEXITCODE -ne 0) { throw "sqlite3 restore exited with code $LASTEXITCODE" }`;
    }
    return {
      input: powershellStdinCommand(`$ErrorActionPreference = 'Stop'\n$backupPath = ${powershellSingleQuote(backupPath)}\n${operation}`),
      preview: `Restore ${entry.name} → ${targetPath || effectiveDraft.database}`,
      kind: entry.kind,
    };
  }

  let operation = '';
  if (entry.kind === 'files') {
    operation = `${unixToolGuard('tar')}
target_path=${unixPathExpression(targetPath)}
mkdir -p -- "$target_path"
tar -xzf "$backup_path" -C "$target_path"`;
  } else if (entry.kind === 'mysql') {
    const fields = getDatabaseFields(effectiveDraft);
    operation = `${unixToolGuard('mysql', 'gzip')}
${fields.password ? `MYSQL_PWD=${shellSingleQuote(fields.password)}
export MYSQL_PWD` : ''}
gzip -dc "$backup_path" | mysql --host ${shellSingleQuote(fields.host)} --port ${shellSingleQuote(fields.port)} --user ${shellSingleQuote(fields.username)}`;
  } else if (entry.kind === 'postgres') {
    const fields = getDatabaseFields(effectiveDraft);
    operation = `${unixToolGuard('pg_restore')}
${fields.password ? `PGPASSWORD=${shellSingleQuote(fields.password)}
export PGPASSWORD` : ''}
pg_restore --clean --if-exists --no-owner --host ${shellSingleQuote(fields.host)} --port ${shellSingleQuote(fields.port)} --username ${shellSingleQuote(fields.username)} --dbname ${shellSingleQuote(fields.database)} "$backup_path"`;
  } else if (entry.kind === 'mongo') {
    const fields = getDatabaseFields(effectiveDraft);
    const authArguments = fields.username
      ? ` --username ${shellSingleQuote(fields.username)} --password ${shellSingleQuote(fields.password)} --authenticationDatabase ${shellSingleQuote(fields.authDatabase)}`
      : '';
    operation = `${unixToolGuard('mongorestore')}
mongorestore --drop --host ${shellSingleQuote(fields.host)} --port ${shellSingleQuote(fields.port)}${authArguments} --archive="$backup_path" --gzip --nsInclude ${shellSingleQuote(`${fields.database}.*`)}`;
  } else {
    const sqliteTarget = validateSqlitePath(targetPath, 'Restore destination');
    operation = `${unixToolGuard('sqlite3')}
sqlite_target=${unixPathExpression(sqliteTarget)}
sqlite3 "$backup_path" ".backup \\"$sqlite_target\\""`;
  }

  return {
    input: { command: 'sh -s', stdin: `set -eu\nbackup_path=${shellSingleQuote(backupPath)}\n${operation}` },
    preview: `Restore ${entry.name} → ${targetPath || effectiveDraft.database}`,
    kind: entry.kind,
  };
}

function validateCronExpression(value: string) {
  const expression = validateText(value, 'Cron expression', 100).replace(/\s+/g, ' ');
  const fields = expression.split(' ');
  if (fields.length !== 5 || fields.some((field) => !/^[A-Za-z0-9*/?,_-]+$/.test(field))) {
    throw new Error('Cron expression must contain five valid fields.');
  }
  return expression;
}

function validateScheduleTime(value: string) {
  const time = validateText(value, 'Schedule time', 5);
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw new Error('Schedule time must use HH:mm.');
  }
  return time;
}

function createPlanId(draft: BackupDraft) {
  return `${draft.sourceType}-${validateLabel(draft.label)}`.toLowerCase();
}

function validatePlanId(value: string) {
  const planId = validateText(value, 'Backup plan ID', 96);
  if (!/^[a-z0-9][a-z0-9._-]{0,95}$/i.test(planId)) {
    throw new Error('Backup plan ID contains unsupported characters.');
  }
  return planId;
}

export function createSaveBackupPlanCommand(
  draft: BackupDraft,
  planDraft: BackupPlanDraft,
  isWindowsHost: boolean,
): RemoteCommandInput {
  assertSupportedDraft(draft, isWindowsHost);
  const planId = createPlanId(draft);
  const label = validateLabel(draft.label);

  if (isWindowsHost) {
    const time = validateScheduleTime(planDraft.time);
    const weekdayMap: Record<string, string> = {
      Monday: 'Monday',
      Tuesday: 'Tuesday',
      Wednesday: 'Wednesday',
      Thursday: 'Thursday',
      Friday: 'Friday',
      Saturday: 'Saturday',
      Sunday: 'Sunday',
    };
    const weekday = weekdayMap[planDraft.weekday] ?? 'Sunday';
    const schedule = `${planDraft.frequency} ${time}${planDraft.frequency === 'weekly' ? ` ${weekday}` : ''}`;
    const scheduledDraft = { ...draft, databasePassword: '', incremental: draft.incremental };
    const planScriptBody = buildWindowsBackupScript(scheduledDraft, false, false);
    const taskName = `ShellDesk Backup ${planId}`;
    const description = `ShellDesk Backup|${planId}|${draft.sourceType}|${label}|${schedule}`;

    return powershellStdinCommand(`$ErrorActionPreference = 'Stop'
$planDirectory = Join-Path $env:USERPROFILE '.shelldesk\\backup-plans'
$planScript = Join-Path $planDirectory ${powershellSingleQuote(`${planId}.ps1`)}
New-Item -ItemType Directory -Force -Path $planDirectory | Out-Null
@'
${planScriptBody}
'@ | Set-Content -LiteralPath $planScript -Encoding UTF8
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $planScript + '"')
$trigger = ${planDraft.frequency === 'weekly'
    ? `New-ScheduledTaskTrigger -Weekly -DaysOfWeek ${weekday} -At ${powershellSingleQuote(time)}`
    : `New-ScheduledTaskTrigger -Daily -At ${powershellSingleQuote(time)}`}
Register-ScheduledTask -TaskName ${powershellSingleQuote(taskName)} -Action $action -Trigger $trigger -Description ${powershellSingleQuote(description)} -Force | Out-Null`);
  }

  const cronExpression = validateCronExpression(planDraft.cronExpression);
  const scheduledDraft = { ...draft, databasePassword: '' };
  const planScriptBody = buildUnixBackupScript(scheduledDraft, false, false);
  const scriptRelativePath = `.config/shelldesk/backup-plans/${planId}.sh`;
  const marker = `${backupPlanMarker}${planId}|${draft.sourceType}|${label}|~/${scriptRelativePath}`;
  const cronLine = `${cronExpression} "$HOME/${scriptRelativePath}"`;

  return {
    command: 'sh -s',
    stdin: `set -eu
command -v crontab >/dev/null 2>&1 || { echo 'crontab is not installed.' >&2; exit 127; }
plan_directory="$HOME/.config/shelldesk/backup-plans"
plan_script="$HOME/${scriptRelativePath}"
mkdir -p -- "$plan_directory"
cat > "$plan_script" <<'__SHELLDESK_BACKUP_PLAN__'
${planScriptBody}
__SHELLDESK_BACKUP_PLAN__
chmod 700 "$plan_script"
temporary_cron="\${TMPDIR:-/tmp}/shelldesk-backup-cron-$$"
trap 'rm -f -- "$temporary_cron"' EXIT
(crontab -l 2>/dev/null || true) | awk -v prefix=${shellSingleQuote(`${backupPlanMarker}${planId}|`)} '
  skip_next { skip_next = 0; next }
  index($0, prefix) == 1 { skip_next = 1; next }
  { print }
' > "$temporary_cron"
printf '%s\\n%s\\n' ${shellSingleQuote(marker)} ${shellSingleQuote(cronLine)} >> "$temporary_cron"
crontab "$temporary_cron"`,
  };
}

export function createListBackupPlansCommand(isWindowsHost: boolean): RemoteCommandInput {
  if (isWindowsHost) {
    return powershellStdinCommand(`$items = @(
  Get-ScheduledTask -ErrorAction SilentlyContinue |
    Where-Object { $_.TaskName -like 'ShellDesk Backup *' -and $_.Description -like 'ShellDesk Backup|*' } |
    ForEach-Object {
      $scriptPath = ''
      if ($_.Actions -and $_.Actions[0].Arguments -match '-File\\s+"([^"]+)"') { $scriptPath = $Matches[1] }
      [PSCustomObject]@{
        TaskName = $_.TaskName
        State = [string]$_.State
        Description = $_.Description
        ScriptPath = $scriptPath
      }
    }
)
ConvertTo-Json -InputObject $items -Compress`);
  }

  return { command: 'sh -s', stdin: 'crontab -l 2>/dev/null || true' };
}

export function createDeleteBackupPlanCommand(planId: string, isWindowsHost: boolean): RemoteCommandInput {
  const safePlanId = validatePlanId(planId);
  if (isWindowsHost) {
    return powershellStdinCommand(`$taskName = ${powershellSingleQuote(`ShellDesk Backup ${safePlanId}`)}
$planScript = Join-Path $env:USERPROFILE ${powershellSingleQuote(`.shelldesk\\backup-plans\\${safePlanId}.ps1`)}
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $planScript -Force -ErrorAction SilentlyContinue`);
  }

  return {
    command: 'sh -s',
    stdin: `set -eu
temporary_cron="\${TMPDIR:-/tmp}/shelldesk-backup-cron-$$"
trap 'rm -f -- "$temporary_cron"' EXIT
(crontab -l 2>/dev/null || true) | awk -v prefix=${shellSingleQuote(`${backupPlanMarker}${safePlanId}|`)} '
  skip_next { skip_next = 0; next }
  index($0, prefix) == 1 { skip_next = 1; next }
  { print }
' > "$temporary_cron"
crontab "$temporary_cron"
rm -f -- "$HOME/.config/shelldesk/backup-plans/${safePlanId}.sh"`,
  };
}

export function getBackupCommandPreview(draft: BackupDraft) {
  return createBackupPreview(draft);
}

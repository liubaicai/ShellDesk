import { t, type AppLanguage } from '../../i18n';
import { getFileExtension, isTextFile } from './textFileUtils';
import type { RemoteFileEntry, RemoteFileEntryType } from './fileExplorerTypes';

export { getFileExtension } from './textFileUtils';

const FILE_ICON_MAP: Record<string, string> = {
  js: 'FileCode', ts: 'FileCode', tsx: 'FileCode', jsx: 'FileCode',
  py: 'FileCode', rb: 'FileCode', go: 'FileCode', rs: 'FileCode',
  java: 'FileCode', c: 'FileCode', cpp: 'FileCode', h: 'FileCode',
  html: 'FileCode', htm: 'FileCode', css: 'FileCode', scss: 'FileCode', sass: 'FileCode',
  json: 'FileJson', xml: 'FileJson', yaml: 'FileJson', yml: 'FileJson', toml: 'FileJson',
  md: 'FileText', txt: 'FileText', log: 'FileText', doc: 'FileText', docx: 'FileText',
  csv: 'FileSpreadsheet', xlsx: 'FileSpreadsheet', xls: 'FileSpreadsheet',
  sh: 'FileTerminal', bash: 'FileTerminal', zsh: 'FileTerminal',
  png: 'FileImage', jpg: 'FileImage', jpeg: 'FileImage', gif: 'FileImage', svg: 'FileImage', webp: 'FileImage', ico: 'FileImage',
  mp3: 'FileAudio', wav: 'FileAudio', flac: 'FileAudio', aac: 'FileAudio', ogg: 'FileAudio',
  mp4: 'FileVideo', avi: 'FileVideo', mkv: 'FileVideo', mov: 'FileVideo', webm: 'FileVideo',
  zip: 'FileArchive', tar: 'FileArchive', gz: 'FileArchive', '7z': 'FileArchive', rar: 'FileArchive', bz2: 'FileArchive', xz: 'FileArchive',
  pdf: 'File',
  conf: 'FileCog', cfg: 'FileCog', ini: 'FileCog', env: 'FileCog',
  pem: 'FileKey', key: 'FileKey', cert: 'FileKey',
  sql: 'FileDatabase', db: 'FileDatabase', sqlite: 'FileDatabase',
  lock: 'FileLock',
};

const SQLITE_EXTENSIONS = new Set(['db', 'sqlite', 'sqlite3', 's3db', 'sl3', 'sqlitedb']);

export function isArchiveFile(name: string) {
  const lower = name.toLowerCase();
  return lower.endsWith('.zip') || lower.endsWith('.tar') || lower.endsWith('.tar.gz') ||
    lower.endsWith('.tgz') || lower.endsWith('.tar.bz2') || lower.endsWith('.tbz2') ||
    lower.endsWith('.tar.xz') || lower.endsWith('.txz') || lower.endsWith('.7z') ||
    lower.endsWith('.gz') || lower.endsWith('.rar');
}

export function isSqliteFile(name: string): boolean {
  return SQLITE_EXTENSIONS.has(getFileExtension(name));
}

export function getEffectiveEntryType(entry: RemoteFileEntry): RemoteFileEntryType {
  if (entry.type !== 'symlink') {
    return entry.type;
  }

  return entry.targetType === 'directory' || entry.targetType === 'file'
    ? entry.targetType
    : 'symlink';
}

export function isDirectoryEntry(entry: RemoteFileEntry) {
  return getEffectiveEntryType(entry) === 'directory';
}

export function isFileEntry(entry: RemoteFileEntry) {
  return getEffectiveEntryType(entry) === 'file';
}

export function getFileIconClass(entry: RemoteFileEntry) {
  const effectiveType = getEffectiveEntryType(entry);
  return effectiveType === 'directory' ? 'directory' : effectiveType === 'file' ? 'file' : 'symlink';
}

export function getFileIcon(entry: RemoteFileEntry) {
  if (isDirectoryEntry(entry)) {
    return 'Folder';
  }

  if (entry.type === 'symlink') {
    return 'FileSymlink';
  }

  return FILE_ICON_MAP[getFileExtension(entry.name)] ?? 'File';
}

export function getFileTypeLabel(entry: RemoteFileEntry, language: AppLanguage) {
  if (entry.type === 'symlink') {
    if (entry.targetType === 'directory') {
      return t('fileExplorer.type.symlinkDirectory', language);
    }

    if (entry.targetType === 'file') {
      return t('fileExplorer.type.symlinkFile', language);
    }

    return t('fileExplorer.type.symlink', language);
  }

  if (entry.type === 'directory') {
    return t('fileExplorer.type.folder', language);
  }

  const ext = getFileExtension(entry.name);
  return ext ? t('fileExplorer.type.extFile', language, { ext }) : t('fileExplorer.type.file', language);
}

export function getOpenActionLabel(entry: RemoteFileEntry, language: AppLanguage) {
  if (isDirectoryEntry(entry)) {
    return t('fileExplorer.open.directory', language);
  }

  if (isFileEntry(entry) && isSqliteFile(entry.name)) {
    return t('fileExplorer.open.sqlite', language);
  }

  if (isFileEntry(entry) && isTextFile(entry.name)) {
    return t('fileExplorer.open.notepad', language);
  }

  if (entry.type === 'symlink') {
    return t('fileExplorer.open.symlink', language);
  }

  return '';
}

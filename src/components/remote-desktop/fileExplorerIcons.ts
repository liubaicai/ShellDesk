import { t, type AppLanguage } from '../../i18n';
import { isTextFile } from './textFileUtils';
import { getFileExtension } from './fileExplorerPaths';
import type { RemoteFileEntry, RemoteFileEntryType } from './fileExplorerTypes';

const FILE_ICON_MAP: Record<string, string> = {
  js: '\u{1F4DC}', ts: '\u{1F4D8}', tsx: '\u{1F4D8}', jsx: '\u{1F4DC}',
  py: '\u{1F40D}', rb: '\u{1F48E}', go: '\u{1F535}', rs: '\u{1F980}',
  java: '\u2615', c: '\u{1F527}', cpp: '\u{1F527}', h: '\u{1F527}',
  html: '\u{1F310}', htm: '\u{1F310}', css: '\u{1F3A8}', scss: '\u{1F3A8}',
  json: '\u{1F4CB}', xml: '\u{1F4CB}', yaml: '\u{1F4CB}', yml: '\u{1F4CB}', toml: '\u{1F4CB}',
  md: '\u{1F4DD}', txt: '\u{1F4DD}', log: '\u{1F4DD}', csv: '\u{1F4CA}',
  sh: '\u2699\uFE0F', bash: '\u2699\uFE0F', zsh: '\u2699\uFE0F',
  png: '\u{1F5BC}\uFE0F', jpg: '\u{1F5BC}\uFE0F', jpeg: '\u{1F5BC}\uFE0F', gif: '\u{1F5BC}\uFE0F', svg: '\u{1F5BC}\uFE0F', webp: '\u{1F5BC}\uFE0F',
  mp3: '\u{1F3B5}', wav: '\u{1F3B5}', flac: '\u{1F3B5}',
  mp4: '\u{1F3AC}', avi: '\u{1F3AC}', mkv: '\u{1F3AC}', mov: '\u{1F3AC}',
  zip: '\u{1F4E6}', tar: '\u{1F4E6}', gz: '\u{1F4E6}', '7z': '\u{1F4E6}', rar: '\u{1F4E6}',
  pdf: '\u{1F4D5}', doc: '\u{1F4D8}', docx: '\u{1F4D8}',
  conf: '\u2699\uFE0F', cfg: '\u2699\uFE0F', ini: '\u2699\uFE0F', env: '\u2699\uFE0F',
  pem: '\u{1F511}', key: '\u{1F511}',
  sql: '\u{1F5C3}\uFE0F', db: '\u{1F5C3}\uFE0F',
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
    return '\u{1F4C1}';
  }

  if (entry.type === 'symlink') {
    return '\u{1F517}';
  }

  return FILE_ICON_MAP[getFileExtension(entry.name)] ?? '\u{1F4C4}';
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

import { t, type AppLanguage } from '../../i18n';
import { getErrorMessage } from './desktopUtils';
import { formatBytes as formatSharedBytes } from './parseUtils';
import { isDirectoryEntry } from './fileExplorerIcons';
import type { ExplorerTransferTaskStatus, RemoteFileEntry, SortField } from './fileExplorerTypes';

export const formatBytes = (size: number) => formatSharedBytes(size, { invalidText: '-', maxUnit: 'TB', fixedDecimal: true });

export function getDeleteEntryTypeLabel(entry: RemoteFileEntry, language: AppLanguage) {
  if (entry.type === 'directory') {
    return t('fileExplorer.type.directory', language);
  }

  if (entry.type === 'symlink') {
    return t('fileExplorer.type.symlink', language);
  }

  return t('fileExplorer.type.file', language);
}

export function getDeleteEntriesLabel(entries: RemoteFileEntry[], language: AppLanguage) {
  const names = entries.map((entry) => entry.name).join(language === 'zh-CN' ? '\u3001' : ', ');

  return entries.length === 1
    ? t('fileExplorer.delete.single', language, { type: getDeleteEntryTypeLabel(entries[0], language), name: names })
    : t('fileExplorer.delete.multiple', language, { count: entries.length, names });
}

export function isHiddenEntry(entry: RemoteFileEntry) {
  return entry.name.startsWith('.') && entry.name !== '.' && entry.name !== '..';
}

export function isValidFileName(name: string, isWindowsHost = false) {
  if (!name.trim()) return false;
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) return false;
  if (isWindowsHost && /[<>:"|?*]/.test(name)) return false;
  if (name === '.' || name === '..') return false;
  return name.length <= 255;
}

export function isRemotePathMissingError(error: unknown) {
  const message = getErrorMessage(error);
  return /no such file|not found|cannot find|does not exist|不存在|找不到/i.test(message);
}

export function splitFileNameForDuplicate(name: string) {
  const dotIndex = name.lastIndexOf('.');

  if (dotIndex <= 0) {
    return { base: name, ext: '' };
  }

  return {
    base: name.slice(0, dotIndex),
    ext: name.slice(dotIndex),
  };
}

export function getUploadTaskLabel(items: ShellDeskSelectedUploadItem[], language: AppLanguage) {
  if (items.length === 1) {
    return items[0].name;
  }

  return language === 'zh-CN' ? `${items.length} 个上传项目` : `${items.length} upload items`;
}

export function getDownloadTaskLabel(entries: RemoteFileEntry[], language: AppLanguage) {
  if (entries.length === 1) {
    return entries[0].name;
  }

  return language === 'zh-CN' ? `${entries.length} 个下载项目` : `${entries.length} download items`;
}

export function getTransferTaskStatusLabel(status: ExplorerTransferTaskStatus, language: AppLanguage) {
  if (language !== 'zh-CN') {
    return {
      queued: 'Queued',
      running: 'Running',
      success: 'Done',
      error: 'Failed',
      canceled: 'Canceled',
      skipped: 'Skipped',
    }[status];
  }

  return {
    queued: '排队中',
    running: '传输中',
    success: '已完成',
    error: '失败',
    canceled: '已取消',
    skipped: '已跳过',
  }[status];
}

export function getSortValue(entry: RemoteFileEntry, field: SortField): string | number {
  switch (field) {
    case 'name': return entry.name;
    case 'modifiedAt': return entry.modifiedAt || '';
    case 'type': return isDirectoryEntry(entry) ? 0 : entry.type === 'symlink' ? 1 : 2;
    case 'size': return isDirectoryEntry(entry) ? -1 : entry.size;
    default: return '';
  }
}

export function isEditableShortcutTarget(target: EventTarget | null) {
  return target instanceof HTMLElement && Boolean(target.closest(
    'input, textarea, select, button, [contenteditable="true"], [contenteditable=""]',
  ));
}

import {
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileCog,
  FileImage,
  FileJson,
  FileKey,
  FileLock,
  FileSpreadsheet,
  FileSymlink,
  FileTerminal,
  FileText,
  FileVideo,
  Folder,
  FolderOpen,
  Database as FileDatabase,
  type LucideIcon,
} from 'lucide-react';

import type { RemoteFileEntry } from './fileExplorerTypes';
import { getEffectiveEntryType, getFileExtension, getFileIcon } from './fileExplorerIcons';

const FILE_ICON_MAP: Record<string, LucideIcon> = {
  js: FileCode, ts: FileCode, tsx: FileCode, jsx: FileCode,
  py: FileCode, rb: FileCode, go: FileCode, rs: FileCode,
  java: FileCode, c: FileCode, cpp: FileCode, h: FileCode,
  html: FileCode, htm: FileCode, css: FileCode, scss: FileCode, sass: FileCode,
  json: FileJson, xml: FileJson, yaml: FileJson, yml: FileJson, toml: FileJson,
  md: FileText, txt: FileText, log: FileText, doc: FileText, docx: FileText,
  csv: FileSpreadsheet, xlsx: FileSpreadsheet, xls: FileSpreadsheet,
  sh: FileTerminal, bash: FileTerminal, zsh: FileTerminal,
  png: FileImage, jpg: FileImage, jpeg: FileImage, gif: FileImage, svg: FileImage, webp: FileImage, ico: FileImage,
  mp3: FileAudio, wav: FileAudio, flac: FileAudio, aac: FileAudio, ogg: FileAudio,
  mp4: FileVideo, avi: FileVideo, mkv: FileVideo, mov: FileVideo, webm: FileVideo,
  zip: FileArchive, tar: FileArchive, gz: FileArchive, '7z': FileArchive, rar: FileArchive, bz2: FileArchive, xz: FileArchive,
  conf: FileCog, cfg: FileCog, ini: FileCog, env: FileCog,
  pem: FileKey, key: FileKey, cert: FileKey,
  sql: FileDatabase, db: FileDatabase, sqlite: FileDatabase,
  lock: FileLock,
};

const ICON_NAME_MAP: Record<string, LucideIcon> = {
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileCog,
  FileDatabase,
  FileImage,
  FileJson,
  FileKey,
  FileLock,
  FileSpreadsheet,
  FileSymlink,
  FileTerminal,
  FileText,
  FileVideo,
  Folder,
};

function getLucideIcon(entry: RemoteFileEntry, open: boolean): LucideIcon {
  if (getEffectiveEntryType(entry) === 'directory') {
    return open ? FolderOpen : Folder;
  }

  if (entry.type === 'symlink') {
    return FileSymlink;
  }

  return FILE_ICON_MAP[getFileExtension(entry.name)] ?? ICON_NAME_MAP[getFileIcon(entry)] ?? File;
}

interface FileIconProps {
  entry: RemoteFileEntry;
  size?: number;
  className?: string;
  open?: boolean;
}

export function FileIcon({ entry, size = 18, className, open = false }: FileIconProps) {
  const Icon = getLucideIcon(entry, open);
  const iconName = getFileIcon(entry);
  return <Icon size={size} className={`file-icon--${iconName}${className ? ` ${className}` : ''}`} aria-hidden="true" focusable="false" />;
}
